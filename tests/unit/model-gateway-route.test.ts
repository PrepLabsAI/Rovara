import { IMPLICIT_COMPANY_ID as T1_COMPANY } from "@agentx/contracts";
import { randomUUID } from "node:crypto";
import { expectLinearScalingAsync } from "../support/scaling.js";
import { describe, expect, it, vi } from "vitest";
import { createCallbackHandler, type CallbackDeps } from "../../packages/broker/src/services/callbacks.js";
import { createDocumentObjectStorage } from "../../packages/broker/src/core/proof/evidence-blob-store.js";
import { CallbackCapabilities } from "../../packages/broker/src/callbacks.js";
import { operationKey, workspaceKey, taskPointerKey, taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { createHarness, newRequestId } from "../support/task-flow-harness.js";
import { ROVARA_CODE_AGENT_ID } from "@agentx/contracts";
import { modelAccessSource } from "../../packages/worker/src/model-access.js";
import { createTaskTokenDescriber } from "../../packages/broker/src/core/model-gateway/describer.js";
import { claimVector, signingWorld } from "../support/model-gateway.js";
const v = claimVector();
async function world(enabled = true) {
  const h = createHarness({ audit: "recording" }); const w = signingWorld(); const logs: unknown[] = [];
  h.deps.log = entry => logs.push(entry);
  await h.store.put({ item: { ...operationKey(T1_COMPANY, v.ws, v.op), id: v.op, workspaceId: v.ws, companyId: h.deps.companyId, status: "RUNNING", fence: 1 } });
  await h.store.put({ item: { ...workspaceKey(T1_COMPANY, v.ws), id: v.ws, companyId: h.deps.companyId, projectName: v.pid, activeOperationId: v.op, fence: 1, status: "BUSY" } });
  await h.store.put({ item: { ...taskPointerKey(T1_COMPANY, v.ws), taskId: v.tid } });
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
      // The packet route answers a refused credential with 403 (packet-route.ts); the other three keep the shared mapping's 409.
      expect(await w.call("", path, method)).toEqual({ statusCode: path === "/v1/internal/design-review/packet" ? 403 : 409, headers: { "content-type": "application/json" }, body: '{"error":{"code":"CALLBACK_FORBIDDEN","message":"callback capability is required"}}' });
    }
    expect(await w.call("", `/v1/internal/workspaces/${v.ws}/operations/${v.op}/repository-credentials`, "POST")).toEqual({ statusCode: 403, headers: { "content-type": "application/json" }, body: '{"error":{"code":"FORBIDDEN","message":"a repository grant is required"}}' });
  });
});

describe("model access guards", () => {
  it.each([
["wrong operation", { operationId: randomUUID() }], ["stale fence", { fence: 2 }],
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
  it.each(["SUCCEEDED"])("cannot renew after %s", async status => {
    const w = await world(); expect((await w.call()).statusCode).toBe(200);
    const key = operationKey(T1_COMPANY, v.ws, v.op); const op = (await w.h.store.get(key))!;
    await w.h.store.put({ item: { ...op, status } });
    const answer = await w.call(); expect(answer.statusCode).toBe(409); expect(w.w.signs()).toBe(1);
  });
  it.each([
    ["workspace", { id: randomUUID() }], ["workspace", { status: "STOPPED" }], ["task", { companyId: "org_bbbbbbbbbbbbbbbbbbbb" }], ["task", { workflow: { stage: "unknown" } }],
  ])("refuses mismatched or ended %s records (%j)", async (kind, patch) => {
    const w = await world();
    const key = kind === "workspace" ? workspaceKey(T1_COMPANY, v.ws) : kind === "operation" ? operationKey(T1_COMPANY, v.ws, v.op) : taskKey(v.tid);
    const record = (await w.h.store.get(key))!; await w.h.store.put({ item: { ...record, ...patch } });
    const answer = await w.call(); expect(answer.statusCode).toBe(409); expect(w.w.signs()).toBe(0);
    expect(['{"error":{"code":"CALLBACK_FORBIDDEN","message":"this operation has no model access"}}', '{"error":{"code":"STALE_FENCE","message":"callback no longer owns the workspace"}}']).toContain(answer.body);
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

it.each([{ workspaceId: "bad" }])("refuses malformed capability scope before record reads (%j)", async patch => {
  const w = await world(); let reads = 0;
  w.h.deps.store.get = async () => { reads += 1; return undefined; };
  const token = w.issue(patch); const answer = await w.call(token);
  expect(answer).toMatchObject({ statusCode: 409, body: '{"error":{"code":"CALLBACK_FORBIDDEN","message":"invalid capability"}}' });
  expect(reads).toBe(0); expect(w.w.signs()).toBe(0); expect(answer.body).not.toContain(token);
});
it("bounds the whole capability before decoding or reading records", async () => {
  const w = await world(); let reads = 0;
  w.h.deps.store.get = async () => { reads += 1; return undefined; };
  // A scaling check, not a wall-clock bound: refusing a longer capability must not cost more than linearly more (8 x 16,000 characters stays at or under 256 KiB so it stays in CPU cache; the original 1,000,000 characters runs once, un-timed, below).
  await expectLinearScalingAsync((n) => { const hostile = w.issue({ actions: ["model-access", "a".repeat(n)] }); return () => w.call(hostile); }, { n: 16_000, unitBytes: 2, label: "refusing a huge capability" });
  const token = w.issue({ actions: ["model-access", "a".repeat(1000000)] });
  const answer = await w.call(token);
  expect(answer).toMatchObject({ statusCode: 409, body: '{"error":{"code":"CALLBACK_FORBIDDEN","message":"invalid capability"}}' });
  expect(reads).toBe(0); expect(w.w.signs()).toBe(0);
});
it.each(["pointer"])("refuses a missing %s record", async missing => {
  const w = await world(); const get = w.h.store.get.bind(w.h.store);
  const key = missing === "operation" ? operationKey(T1_COMPANY, v.ws, v.op) : missing === "workspace" ? workspaceKey(T1_COMPANY, v.ws) : missing === "pointer" ? taskPointerKey(T1_COMPANY, v.ws) : taskKey(v.tid);
  w.h.deps.store.get = async query => query.pk === key.pk && query.sk === key.sk ? undefined : get(query);
  expect((await w.call()).statusCode).toBe(409); expect(w.w.signs()).toBe(0);
});
it("refuses a malformed task pointer without reading a guessed task", async () => {
  const w = await world(); await w.h.store.put({ item: { ...taskPointerKey(T1_COMPANY, v.ws), taskId: "malformed task" } });
  const get = w.h.store.get.bind(w.h.store); let reads = 0; w.h.deps.store.get = async key => { reads += 1; return get(key); };
  const answer = await w.call(); expect(answer.statusCode).toBe(409); expect(answer.body).not.toContain("malformed task"); expect(w.w.signs()).toBe(0); expect(reads).toBe(3);
});

it("does not allow a describer to change the checked company, project or task", async () => {
  for (const patch of [{ companyId: "org_bbbbbbbbbbbbbbbbbbbb" }, { project: "other" }, { taskId: "other" }]) {
    const w = await world(); const original = await w.gateway.describer.describe();
    w.gateway.describer.describe = async () => ({ ...original, ...patch });
    expect((await w.call()).statusCode).toBe(401); expect(w.w.signs()).toBe(0);
  }
});

it.each(["records"])("bounds total elapsed time while %s is pending and never publishes a late result", async where => {
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

it.each(["app"])("the default describer reads once and mints only with resolved payer facts (%s)", async origin => {
  const w = await world();
  const ok = operationKey(T1_COMPANY, v.ws, v.op); const tk = taskKey(v.tid);
  await w.h.store.put({ item: { ...(await w.h.store.get(ok))!, kind: "task", requester: { personId: v.per!, provider: "test" } } });
  // Origin nightly marks nightly upkeep AI (lead 4 N1): only a wiki build task is minted it (the case below says what a nightly task of any other kind gets).
  await w.h.store.put({ item: { ...(await w.h.store.get(tk))!, ...(origin === undefined ? {} : { origin }), ...(origin === "nightly" ? { purpose: "wiki_build" } : {}) } });
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


it.each(["current", "old member", "old no identity"] as const)("real task-start callback compatibility (%s)", async shape => {
  const origin = shape === "current" ? "app" : undefined;
  const h = createHarness(); await h.registerProject();
  const member = shape === "old no identity" ? "local-owner-marker" : "a".repeat(64);
  const caller = { ...h.owner, principal: { ...h.owner.principal, personId: member } };
  const started = await h.flow.start(caller, { project: "payments", instructions: "Build it", requestId: newRequestId() });
  const workspace = (await h.store.get(workspaceKey(T1_COMPANY, started.task.workspaceId)))!;
  const scope = { workspaceId: started.task.workspaceId, operationId: workspace["activeOperationId"] as string, fence: 1 };
  const key = operationKey(T1_COMPANY, scope.workspaceId, scope.operationId);
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
