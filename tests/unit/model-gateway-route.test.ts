import { createHmac, randomUUID } from "node:crypto";
import { expectLinearScalingAsync } from "../support/scaling.js";
import { describe, expect, it, vi } from "vitest";
import { createCallbackHandler, type CallbackDeps } from "../../packages/broker/src/services/callbacks.js";
import { createDocumentObjectStorage } from "../../packages/broker/src/core/proof/evidence-blob-store.js";
import { CallbackCapabilities } from "../../packages/broker/src/callbacks.js";
import { operationKey, workspaceKey, taskPointerKey, taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { createHarness, newRequestId } from "../support/task-flow-harness.js";
import { agentXError, ROVARA_CODE_AGENT_ID } from "@agentx/contracts";
import { modelAccessSource } from "../../packages/worker/src/model-access.js";
import { createTaskTokenDescriber } from "../../packages/broker/src/core/model-gateway/describer.js";
import { claimVector, signingWorld } from "../support/model-gateway.js";
const v = claimVector();
async function world(enabled = true) {
  const h = createHarness({ audit: "recording" }); const w = signingWorld(); const logs: unknown[] = [];
  h.deps.log = entry => logs.push(entry);
  await h.store.put({ item: { ...operationKey(v.ws, v.op), id: v.op, workspaceId: v.ws, companyId: h.deps.companyId, status: "RUNNING", fence: 1 } });
  await h.store.put({ item: { ...workspaceKey(v.ws), id: v.ws, companyId: h.deps.companyId, projectName: v.pid, activeOperationId: v.op, fence: 1, status: "BUSY" } });
  await h.store.put({ item: { ...taskPointerKey(v.ws), taskId: v.tid } });
  await h.store.put({ item: { ...taskKey(v.tid), taskId: v.tid, workspaceId: v.ws, project: v.pid, companyId: h.deps.companyId } });
  const capability = new CallbackCapabilities(Buffer.from(h.deps.callbackSigningKey));
  const issue = (patch = {}) => capability.issue({ workspaceId: v.ws, operationId: v.op, fence: 1, actions: ["model-access"], expiresInSeconds: 900, ...patch });
  const gateway = { gatewayUrl: "https://gateway.example", signer: w.signer, issuer: v.iss, describer: { describe: async () => ({ companyId: h.deps.companyId, project: v.pid, person: v.per!, payer: v.pay, taskId: v.tid, step: v.stp, origin: "app" as const, models: v.mdl }) } };
  const deps: CallbackDeps = { flow: h.deps, blobs: createDocumentObjectStorage(h.store, { companyId: h.deps.companyId }), grants: { exchange: async () => ({ token: "unused" }) }, ...(enabled ? { modelGateway: gateway } : {}) };
  const handler = createCallbackHandler(deps);
  const call = (token: string | undefined = issue(), path = "/v1/internal/model-access", method = "GET", body?: string) => handler({ method, path, headers: token === undefined ? {} : { "x-agentx-callback-capability": token }, ...(body === undefined ? {} : { body }) });
  return { h, w, logs, issue, call, deps, gateway };
}
describe("model access route", () => {
  it("golden: feature off retains the exact response bytes", async () => {
    const w = await world(false);
    expect(await w.call()).toEqual({ statusCode: 404, headers: { "content-type": "application/json" }, body: '{"error":{"code":"NOT_FOUND","message":"route not found"}}' });
    for (const action of ["events", "artifacts", "heartbeat", "result", "candidate-export", "candidate-build-source", "baseline-source", "e2e-admission", "e2e-evidence", "pull-request", "pull-request-update", "setup-agent", "model-access"]) {
      expect(await w.call("", `/v1/internal/workspaces/${v.ws}/operations/${v.op}/${action}`, "POST"), action).toEqual(action.startsWith("e2e-") ? { statusCode: 404, headers: { "content-type": "application/json" }, body: '{"error":{"code":"NOT_FOUND","message":"route not found"}}' } : { statusCode: 409, headers: { "content-type": "application/json" }, body: '{"error":{"code":"CALLBACK_FORBIDDEN","message":"callback capability is required"}}' });
    }
    for (const [path, method] of [["/v1/internal/design-review/packet", "GET"], ["/v1/internal/context-tools", "GET"], ["/v1/internal/context-tools/call", "POST"], ["/v1/internal/mcp", "POST"]] as const) {
      expect(await w.call("", path, method)).toEqual({ statusCode: 409, headers: { "content-type": "application/json" }, body: '{"error":{"code":"CALLBACK_FORBIDDEN","message":"callback capability is required"}}' });
    }
    expect(await w.call("", `/v1/internal/workspaces/${v.ws}/operations/${v.op}/repository-credentials`, "POST")).toEqual({ statusCode: 403, headers: { "content-type": "application/json" }, body: '{"error":{"code":"FORBIDDEN","message":"a repository grant is required"}}' });
  });
  it("serves valid model access without caching and ignores request claim overrides", async () => {
    const w = await world();
    const response = await w.call(undefined, "/v1/internal/model-access?per=forged&mdl=forged", "GET", JSON.stringify({ per: "b".repeat(64), mdl: ["forged"] }));
    expect(response.statusCode).toBe(200); expect(response.headers["cache-control"]).toBe("no-store");
    const body = JSON.parse(response.body) as { apiKey: string; baseUrl: string; expiresAt: number };
    expect(Object.keys(body).sort()).toEqual(["apiKey", "baseUrl", "expiresAt"]);
    expect(body.baseUrl).toBe("https://gateway.example");
    expect(w.w.reference(body.apiKey, Math.floor(w.h.clock.now / 1000))).toMatchObject({ per: v.per, mdl: v.mdl });
    expect(JSON.stringify(w.logs)).not.toContain(body.apiKey);
    expect(w.logs).toEqual([{ operationId: v.op, iat: body.expiresAt / 1000 - 900, exp: body.expiresAt / 1000 }]);
    expect(JSON.stringify(w.h.audit)).not.toContain(body.apiKey);
  });
});

describe("model access guards", () => {
  it.each([
    ["wrong action", { actions: ["events"] }], ["expired", { expiresInSeconds: -1 }],
    ["wrong workspace", { workspaceId: randomUUID() }], ["wrong operation", { operationId: randomUUID() }], ["stale fence", { fence: 2 }],
  ])("refuses %s without minting or leaking", async (_label, patch) => {
    const w = await world(); const token = w.issue(patch); const answer = await w.call(token);
    expect(answer.statusCode).not.toBe(200); expect(answer.body).not.toContain(token); expect(w.w.signs()).toBe(0);
  });
  it("refuses a bad signature and missing capability", async () => {
    const w = await world();
    for (const token of ["", `${w.issue()}corrupt`]) {
      const answer = await w.call(token); expect(answer.statusCode).toBe(409); expect(w.w.signs()).toBe(0);
    }
    const missing = await createCallbackHandler(w.deps)({ method: "GET", path: "/v1/internal/model-access", headers: {} });
    expect(missing).toEqual({ statusCode: 409, headers: { "content-type": "application/json" }, body: '{"error":{"code":"CALLBACK_FORBIDDEN","message":"callback capability is required"}}' });
  });
  it.each(["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED", "CANCEL_REQUESTED", "unknown"])("cannot renew after %s", async status => {
    const w = await world(); expect((await w.call()).statusCode).toBe(200);
    const key = operationKey(v.ws, v.op); const op = (await w.h.store.get(key))!;
    await w.h.store.put({ item: { ...op, status } });
    const answer = await w.call(); expect(answer.statusCode).toBe(409); expect(w.w.signs()).toBe(1);
  });
  it.each([
    ["workspace", { activeOperationId: randomUUID() }], ["workspace", { fence: 2 }], ["workspace", { companyId: "org_bbbbbbbbbbbbbbbbbbbb" }],
    ["workspace", { id: randomUUID() }], ["workspace", { status: "STOPPED" }], ["workspace", { status: "CLOSING" }], ["workspace", { status: "CLOSED" }], ["workspace", { status: "unknown" }], ["workspace", { closedAt: "2026-01-01" }],
    ["operation", { id: randomUUID() }], ["operation", { workspaceId: randomUUID() }], ["operation", { companyId: "org_bbbbbbbbbbbbbbbbbbbb" }],
    ["operation", { fence: 2 }],
    ["task", { companyId: "org_bbbbbbbbbbbbbbbbbbbb" }], ["task", { workspaceId: randomUUID() }], ["task", { project: "other" }],
    ["task", { taskId: "other" }],
    ["task", { stopRequest: { userId: "owner" } }], ["task", { releasedAt: "2026-01-01" }],
    ["task", { closedAt: "2026-01-01" }], ["task", { workflow: { stage: "CLOSED" } }], ["task", { workflow: { stage: "MERGED" } }],
    ["task", { workflow: { stage: "unknown" } }], ["task", { workflow: {} }], ["task", { workflow: null }], ["task", { workflow: "unknown" }],
  ])("refuses mismatched or ended %s records (%j)", async (kind, patch) => {
    const w = await world();
    const key = kind === "workspace" ? workspaceKey(v.ws) : kind === "operation" ? operationKey(v.ws, v.op) : taskKey(v.tid);
    const record = (await w.h.store.get(key))!; await w.h.store.put({ item: { ...record, ...patch } });
    const answer = await w.call(); expect(answer.statusCode).toBe(409); expect(w.w.signs()).toBe(0);
    expect(['{"error":{"code":"CALLBACK_FORBIDDEN","message":"this operation has no model access"}}', '{"error":{"code":"STALE_FENCE","message":"callback no longer owns the workspace"}}']).toContain(answer.body);
  });
  it("keeps POST model-access unavailable", async () => {
    const w = await world();
    expect(await w.call(w.issue(), `/v1/internal/workspaces/${v.ws}/operations/${v.op}/model-access`, "POST")).toMatchObject({ statusCode: 404, body: '{"error":{"code":"NOT_FOUND","message":"this callback is not available on this install"}}' });
  });
  it("returns the fixed no-access refusal for undefined descriptions", async () => {
    const w = await world(); w.deps.modelGateway!.describer = { describe: async () => undefined };
    expect(await w.call()).toMatchObject({ statusCode: 409, body: '{"error":{"code":"CALLBACK_FORBIDDEN","message":"this operation has no model access"}}' });
  });
  it("requires a gateway address even when the other ports exist", async () => {
    const w = await world(); w.gateway.gatewayUrl = "";
    expect(await w.call()).toMatchObject({ statusCode: 404, body: '{"error":{"code":"NOT_FOUND","message":"route not found"}}' }); expect(w.w.signs()).toBe(0);
  });
  it("supports concurrent mint and the unchanged worker's early renewal", async () => {
    const w = await world(); const answers = await Promise.all([w.call(), w.call()]);
    const tokens = answers.map(answer => (JSON.parse(answer.body) as { apiKey: string }).apiKey);
    expect(tokens[0]).not.toBe(tokens[1]);
    for (const token of tokens) expect(w.w.reference(token, Math.floor(w.h.clock.now / 1000))).toBeDefined();
    const fetcher: typeof fetch = async (url, init) => {
      expect(url).toBe("https://install-a.example/v1/internal/model-access"); expect(init?.method).toBe("GET");
      const answer = await w.call(new Headers(init?.headers).get("x-agentx-callback-capability") ?? "");
      return new Response(answer.body, { status: answer.statusCode, headers: answer.headers });
    };
    const access = modelAccessSource({ controlPlaneUrl: "https://install-a.example", capability: w.issue({ expiresInSeconds: 7200 }), fetch: fetcher, now: () => w.h.clock.now });
    let current = await access();
    for (let renewal = 0; renewal < 3; renewal++) {
      w.h.clock.advance(841); const next = await access();
      expect(next.apiKey).not.toBe(current.apiKey); expect(w.w.reference(next.apiKey, Math.floor(w.h.clock.now / 1000))).toBeDefined(); current = next;
    }
    const key = taskKey(v.tid); const task = (await w.h.store.get(key))!;
    await w.h.store.put({ item: { ...task, stopRequest: { userId: "owner" } } });
    const signed = w.w.signs(); w.h.clock.advance(841);
    await expect(access()).rejects.toThrow("HTTP 409 (CALLBACK_FORBIDDEN)"); expect(w.w.signs()).toBe(signed);
  });
});

it.each([{ workspaceId: "bad" }, { operationId: "bad" }, { fence: 0 }, { fence: 1.5 }, { fence: "1" }])("refuses malformed capability scope before record reads (%j)", async patch => {
  const w = await world(); let reads = 0;
  w.h.deps.store.get = async () => { reads += 1; return undefined; };
  const token = w.issue(patch); const answer = await w.call(token);
  expect(answer).toMatchObject({ statusCode: 409, body: '{"error":{"code":"CALLBACK_FORBIDDEN","message":"invalid capability"}}' });
  expect(reads).toBe(0); expect(w.w.signs()).toBe(0); expect(answer.body).not.toContain(token);
});
it.each([{ expiresAt: undefined }, { expiresAt: "9999999999" }, { expiresAt: 9999999999.5 }, { actions: "model-access" }, { actions: ["model-access", 3] }])("refuses malformed signed capability metadata before record reads (%j)", async patch => {
  const w = await world(); let reads = 0;
  const get = w.h.store.get.bind(w.h.store); w.h.deps.store.get = async key => { reads += 1; return get(key); };
  const claims = JSON.parse(Buffer.from(w.issue().split(".")[0]!, "base64url").toString()) as Record<string, unknown>;
  const body = Buffer.from(JSON.stringify({ ...claims, ...patch })).toString("base64url");
  const token = `${body}.${createHmac("sha256", w.h.deps.callbackSigningKey).update(body).digest("base64url")}`;
  const answer = await w.call(token);
  expect(answer).toMatchObject({ statusCode: 409, body: '{"error":{"code":"CALLBACK_FORBIDDEN","message":"invalid capability"}}' });
  expect(reads).toBe(0); expect(w.w.signs()).toBe(0); expect(answer.body).not.toContain(token);
});
it("bounds the whole capability before decoding or reading records", async () => {
  const w = await world(); let reads = 0;
  w.h.deps.store.get = async () => { reads += 1; return undefined; };
  // A scaling check, not a wall-clock bound: refusing a longer capability must not cost more than linearly more (8 x 125,000 = the original 1,000,000 characters).
  await expectLinearScalingAsync((n) => { const hostile = w.issue({ actions: ["model-access", "a".repeat(n)] }); return () => w.call(hostile); }, { n: 125_000, label: "refusing a huge capability" });
  const token = w.issue({ actions: ["model-access", "a".repeat(1000000)] });
  const answer = await w.call(token);
  expect(answer).toMatchObject({ statusCode: 409, body: '{"error":{"code":"CALLBACK_FORBIDDEN","message":"invalid capability"}}' });
  expect(reads).toBe(0); expect(w.w.signs()).toBe(0);
});
it.each(["operation", "workspace", "pointer", "task"])("refuses a missing %s record", async missing => {
  const w = await world(); const get = w.h.store.get.bind(w.h.store);
  const key = missing === "operation" ? operationKey(v.ws, v.op) : missing === "workspace" ? workspaceKey(v.ws) : missing === "pointer" ? taskPointerKey(v.ws) : taskKey(v.tid);
  w.h.deps.store.get = async query => query.pk === key.pk && query.sk === key.sk ? undefined : get(query);
  expect((await w.call()).statusCode).toBe(409); expect(w.w.signs()).toBe(0);
});
it("refuses a malformed task pointer without reading a guessed task", async () => {
  const w = await world(); await w.h.store.put({ item: { ...taskPointerKey(v.ws), taskId: "malformed task" } });
  const get = w.h.store.get.bind(w.h.store); let reads = 0; w.h.deps.store.get = async key => { reads += 1; return get(key); };
  const answer = await w.call(); expect(answer.statusCode).toBe(409); expect(answer.body).not.toContain("malformed task"); expect(w.w.signs()).toBe(0); expect(reads).toBe(3);
});

it("keeps dependency errors and their names out of every response and log", async () => {
  for (const where of ["describer", "key", "sign"]) for (const typed of [true, false]) {
    const w = await world(); const secret = `credential-${randomUUID()}`;
    const fail = async (): Promise<never> => { const error = typed ? agentXError("CONFIG_INVALID", secret) : new Error(secret); error.name = secret; throw error; };
    if (where === "describer") w.deps.modelGateway!.describer = { describe: fail };
    if (where === "key") w.gateway.signer.publicJwk = fail;
    if (where === "sign") w.gateway.signer.sign = fail;
    const answer = await w.call();
    expect(answer).toMatchObject({ statusCode: 401, body: '{"error":{"type":"authentication_error","message":"invalid or expired model access"}}' });
    expect(JSON.stringify([answer, w.logs, w.h.audit])).not.toContain(secret);
  }
});
it("uses only four point reads and never persists the signed token", async () => {
  const w = await world(); const get = w.h.store.get.bind(w.h.store); const reads: unknown[] = [];
  w.h.deps.store.get = async key => { reads.push(key); return get(key); };
  const writes: unknown[] = []; const put = w.h.store.put.bind(w.h.store);
  w.h.deps.store.put = async value => { writes.push(value); return put(value); };
  const answer = await w.call(); expect(answer.statusCode).toBe(200); expect(reads).toHaveLength(4); expect(writes).toEqual([]);
});
it("does not allow a describer to change the checked company, project or task", async () => {
  for (const patch of [{ companyId: "org_bbbbbbbbbbbbbbbbbbbb" }, { project: "other" }, { taskId: "other" }]) {
    const w = await world(); const original = await w.gateway.describer.describe();
    w.gateway.describer.describe = async () => ({ ...original, ...patch });
    expect((await w.call()).statusCode).toBe(401); expect(w.w.signs()).toBe(0);
  }
});

it.each(["records", "describer", "key", "sign"])("bounds total elapsed time while %s is pending and never publishes a late result", async where => {
  vi.useFakeTimers();
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  const w = await world(); let reads = 0;
  if (where === "records") { const get = w.h.store.get.bind(w.h.store); w.h.deps.store.get = async key => { reads += 1; await wait; return get(key); }; }
  if (where === "describer") { const describe = w.gateway.describer.describe; w.gateway.describer.describe = async () => { await wait; return describe(); }; }
  if (where === "key") { const key = w.gateway.signer.publicJwk.bind(w.gateway.signer); w.gateway.signer.publicJwk = async () => { await wait; return key(); }; }
  if (where === "sign") { const sign = w.gateway.signer.sign.bind(w.gateway.signer); w.gateway.signer.sign = async input => { await wait; return sign(input); }; }
  let answer: Awaited<ReturnType<typeof w.call>> | undefined;
  const pending = w.call().then(value => { answer = value; });
  try {
    await vi.advanceTimersByTimeAsync(30001);
    expect(answer).toMatchObject({ statusCode: 401, body: '{"error":{"type":"authentication_error","message":"invalid or expired model access"}}' });
  } finally {
    release(); await pending; await vi.advanceTimersByTimeAsync(0); vi.useRealTimers();
  }
  expect(w.logs).toEqual([]);
  if (where !== "sign") expect(w.w.signs()).toBe(0);
  if (where === "records") expect(reads).toBe(1);
});

it("uses one deadline across all reads and description", async () => {
  vi.useFakeTimers();
  const w = await world(); const get = w.h.store.get.bind(w.h.store); const describe = w.gateway.describer.describe;
  w.h.deps.store.get = async key => { await new Promise(resolve => setTimeout(resolve, 6000)); return get(key); };
  w.gateway.describer.describe = async () => { await new Promise(resolve => setTimeout(resolve, 8000)); return describe(); };
  let status: number | undefined; const pending = w.call().then(answer => { status = answer.statusCode; });
  try { await vi.advanceTimersByTimeAsync(30001); expect(status).toBe(401); }
  finally { await vi.advanceTimersByTimeAsync(10000); await pending; vi.useRealTimers(); }
  expect(w.w.signs()).toBe(0); expect(w.logs).toEqual([]);
});

it("checks elapsed time before signing even when the timer has not run", async () => {
  const w = await world(); let elapsed = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  const key = w.gateway.signer.publicJwk.bind(w.gateway.signer);
  w.gateway.signer.publicJwk = async () => { elapsed = 30001; return key(); };
  try {
    const answer = await w.call();
    expect(answer.statusCode).toBe(401);
    expect(answer).toMatchObject({ statusCode: 401, body: '{"error":{"type":"authentication_error","message":"invalid or expired model access"}}' });
    expect(w.w.signs()).toBe(0); expect(w.logs).toEqual([]);
  } finally { clock.mockRestore(); }
});

it.each(["nightly", "app", "cli", "mcp", "slack", "tracker", "jira", "github_issue", "event", "schedule", "test_run", "automatic", "chain", "linear", "offer", undefined])("the default describer reads once and mints only with resolved payer facts (%s)", async origin => {
  const w = await world();
  const ok = operationKey(v.ws, v.op); const tk = taskKey(v.tid);
  await w.h.store.put({ item: { ...(await w.h.store.get(ok))!, kind: "task", requester: { personId: v.per!, provider: "test" } } });
  await w.h.store.put({ item: { ...(await w.h.store.get(tk))!, ...(origin === undefined ? {} : { origin }) } });
  w.h.deps.modelAccess = { route: async () => ({ alias: "claude-sonnet-4-5", api: "anthropic-messages", catalog: "claude-sonnet-4-5" }) };
  w.deps.modelGateway!.describer = createTaskTokenDescriber(w.h.deps);
  const get = w.h.store.get.bind(w.h.store); let reads = 0;
  w.h.deps.store.get = async key => { reads += 1; return get(key); };
  const answer = await w.call(); expect(reads).toBe(4);
  if (origin === undefined || !["chain", "linear", "offer"].includes(origin)) {
    expect(answer.statusCode).toBe(200);
    const body = JSON.parse(answer.body) as { apiKey: string };
    const payer = ["nightly", "automatic", "test_run"].includes(origin ?? "") ? { kind: "project", project: v.pid }
      : ["event", "schedule"].includes(origin ?? "") ? { kind: "agent", agentId: ROVARA_CODE_AGENT_ID }
      : { kind: "member", developerId: v.per };
    const claims = w.w.reference(body.apiKey, Math.floor(w.h.clock.now / 1000));
    expect(claims).toMatchObject({ pay: payer });
    if (origin === undefined) expect(claims).not.toHaveProperty("src");
    else expect(claims).toMatchObject({ src: origin });
  }
  else { expect(answer).toMatchObject({ statusCode: 409, body: '{"error":{"code":"CALLBACK_FORBIDDEN","message":"could not work out who pays for this task"}}' }); expect(w.w.signs()).toBe(0); }
});

it("refuses a developer-purpose signer with the fixed HTTP error and no leaked metadata", async () => {
  const w = await world();
  w.gateway.signer.publicJwk = async () => ({ ...w.w.published, rovara_purpose: "developer" });
  const answer = await w.call();
  expect(answer).toMatchObject({ statusCode: 401, body: '{"error":{"type":"authentication_error","message":"invalid or expired model access"}}' });
  expect(w.w.signs()).toBe(0); expect(w.logs).toEqual([]);
  expect(JSON.stringify([answer, w.logs, w.h.audit])).not.toContain(w.w.published.n);
});

it.each(["current", "old member", "old no identity"] as const)("real task-start callback compatibility (%s)", async shape => {
  const origin = shape === "current" ? "app" : undefined;
  const h = createHarness(); await h.registerProject();
  const member = shape === "old no identity" ? "local-owner-marker" : "a".repeat(64);
  const caller = { ...h.owner, principal: { ...h.owner.principal, personId: member } };
  const started = await h.flow.start(caller, { project: "payments", instructions: "Build it", requestId: newRequestId() });
  const workspace = (await h.store.get(workspaceKey(started.task.workspaceId)))!;
  const scope = { workspaceId: started.task.workspaceId, operationId: workspace["activeOperationId"] as string, fence: 1 };
  const key = operationKey(scope.workspaceId, scope.operationId);
  const op = (await h.store.get(key))!;
  await h.store.put({ item: { ...op, kind: "task", status: "RUNNING", programStepId: "build", dispatch: { kind: "task", payload: {} } } });
  const tk = taskKey(started.task.taskId); const task = { ...(await h.store.get(tk))! };
  expect(task["developerId"]).toBe(member);
  expect(op["requester"]).toMatchObject({ personId: member });
  expect(task["origin"]).toBe("app");
  if (origin === undefined) delete task["origin"];
  await h.store.put({ item: task });
  h.deps.modelAccess = { route: async () => ({ alias: "claude-sonnet-4-5", api: "anthropic-messages", catalog: "claude-sonnet-4-5" }) };
  const signer = signingWorld(); const logs: unknown[] = [];
  h.deps.log = entry => logs.push(entry);
  const capability = new CallbackCapabilities(Buffer.from(h.deps.callbackSigningKey));
  const token = capability.issue({ ...scope, actions: ["model-access"], expiresInSeconds: 900 });
  const handler = createCallbackHandler({ flow: h.deps, blobs: createDocumentObjectStorage(h.store, { companyId: h.deps.companyId }), grants: { exchange: async () => ({ token: "unused" }) }, modelGateway: { gatewayUrl: "https://gateway.example", issuer: "https://install-a.example/v1/auth", signer: signer.signer, describer: createTaskTokenDescriber(h.deps) } });
  const response = await handler({ method: "GET", path: "/v1/internal/model-access", headers: { "x-agentx-callback-capability": token } });
  expect(await h.store.get(tk)).toEqual(task);
  if (shape === "old no identity") {
    expect(response).toMatchObject({ statusCode: 409, body: '{"error":{"code":"CALLBACK_FORBIDDEN","message":"could not work out who pays for this task"}}' });
    expect(signer.signs()).toBe(0); expect(logs).toEqual([]);
    expect(JSON.stringify([response, logs])).not.toContain(member);
    expect(JSON.stringify([response, logs])).not.toContain(token);
    return;
  }
  expect(response.statusCode, response.body).toBe(200);
  const body = JSON.parse(response.body) as { apiKey: string };
  const claims = signer.reference(body.apiKey, Math.floor(h.clock.now / 1000));
  expect(claims).toMatchObject({ pay: { kind: "member", developerId: member } });
  if (origin === undefined) expect(claims).not.toHaveProperty("src");
  else expect(claims).toMatchObject({ src: origin });
});
