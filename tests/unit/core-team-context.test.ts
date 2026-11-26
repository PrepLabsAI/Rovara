import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { ContextToolCallResponseSchema, ContextToolCatalogSchema, teamRecordPk, type OrgId, type StoredDocument } from "@agentx/contracts";
import { createBrokerCoreRoot } from "../../packages/broker/src/aws/core-engine-root.js";
import { CallbackCapabilities } from "../../packages/broker/src/callbacks.js";
import { createTeamRecord } from "../../packages/broker/src/team-record/record.js";
import { coreTaskMarkKey } from "../../packages/broker/src/core-host/core-task-mark.js";
import { taskKey, taskPointerKey, workspaceKey, operationKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { createFakeWorld, FAKE_COMPANY } from "../support/core-host-fakes.js";
import type * as TeamRecordModule from "../../packages/broker/src/core-host/team-record.js";

// Substitute only the deployment adapters; the root, registry, runtime, authority and record search are real.
const adapters = vi.hoisted(() => ({ modules: [] as unknown[], searchReply: undefined as unknown[] | undefined, searchFails: false }));
vi.mock("../../packages/broker/src/core-host/code-modules.js", () => ({ codeAdapterModules: () => adapters.modules }));
vi.mock("../../packages/broker/src/core-host/hosted-modules.js", async (original) => ({ ...await original<object>(), hostedSecurityModules: () => [] }));
vi.mock("../../packages/broker/src/core-host/team-record.js", async (original) => {
  const module = await original<typeof TeamRecordModule>();
  return { ...module, attachCoreTeamRecord: (...args: Parameters<typeof module.attachCoreTeamRecord>) => {
    const real = module.attachCoreTeamRecord(...args);
    return { ...real, search: { search: async (...input: Parameters<typeof real.search.search>) => {
      if (adapters.searchFails) throw new Error("private-canary");
      return adapters.searchReply ?? real.search.search(...input);
    } } };
  } };
});
const A = FAKE_COMPANY as OrgId;
const B = "org_corehost00000000000b" as OrgId;
const secret = Buffer.alloc(32, 7);
const caps = new CallbackCapabilities(secret);
const path = "/v1/internal/context-tools";
afterEach(() => { vi.useRealTimers(); adapters.searchReply = undefined; adapters.searchFails = false; vi.restoreAllMocks(); });

async function setup(options: { teamOff?: boolean; teamCompany?: OrgId } = {}) {
  const world = createFakeWorld();
  adapters.modules = world.modules;
  const reads: string[] = [];
  const members = new Map([ ["owner-a", A], ["owner-b", B] ]);
  let projectAllowed = true;
  const client = { async send(command: unknown) {
    if (!(command instanceof GetCommand)) throw new Error("unexpected write");
    const { TableName, Key } = command.input;
    reads.push(`${TableName}:${String(Key?.pk)}`);
    if (TableName === "signin") {
      const personId = String(Key?.pk).replace("COMPANY_MEMBER#", "");
      const companyId = members.get(personId);
      return { Item: companyId === undefined ? undefined : { ...Key, entityType: "COMPANY_MEMBERSHIP", personId, companyId, role: "member", joinedAt: "2026-11-01T00:00:00.000Z" } };
    }
    // DEC 254zzz80: a person's grant sits in their own company's partition (`ORG#<company>#MEMBER#<person>`), as a named company keeps its grants.
    const grant = /^ORG#(org_[0-9a-z]{20})#MEMBER#(.+)$/u.exec(String(Key?.pk));
    if (grant !== null) return { Item: projectAllowed && members.get(grant[2]!) === grant[1] ? { ...Key, projectName: "payments", role: "developer" } : undefined };
    return { Item: await world.store.get(Key as { pk: string; sk: string }) };
  } };
  const root = createBrokerCoreRoot({
    env: { ...(!options.teamOff ? { ROVARA_CORE_LESSONS: options.teamCompany === undefined ? "on" : `on:${options.teamCompany}` } : {}) },
    documentClient: client, stateTableName: "state", signInTableName: "signin", callbackSigningKey: secret.toString(), repositoryGrantKey: secret,
    codeModules: () => ({}) as never, repositoryCredential: async () => { throw new Error("unused"); }, origin: () => "https://api.example", log: () => undefined,
    now: () => new Date(world.clock.now), ciReporting: { honest: true, ciMode: async () => "sandbox_only" as const },
    services: () => Object.fromEntries(["merge-tracking", "session-sweep", "notify-deliver", "admission-hold-sweep"].map((name) => [name, { pass: async () => ({}) }])),
    lessonsPeople: () => ({ approvers: async () => ({ complete: true, membershipVersion: 1, ownerIds: [], eligibleIds: [], lastEligibleLossAtMs: null }), onProjectRoster: async () => true, linkedAccounts: async () => [], displayName: async () => "Member", isErased: async () => false }),
  });
  const runs = [];
  const sameSource = "same-record-source";
  for (const [companyId, developerId, marker] of [[A, "owner-a", "only-alpha"], [B, "owner-b", "only-bravo"]] as const) {
    const workspaceId = randomUUID(), operationId = randomUUID(), taskId = randomUUID();
    const put = async (item: Record<string, unknown>) => world.store.put({ item: JSON.parse(JSON.stringify(item)) as StoredDocument });
    await put({ pk: `WORKSPACE#${workspaceId}`, sk: "META", entityType: "WORKSPACE_COMPANY_POINTER", workspaceId, companyId });
    await put({ ...workspaceKey(companyId, workspaceId), entityType: "WORKSPACE", id: workspaceId, companyId, orgId: companyId, projectName: "payments", activeOperationId: operationId, fence: 1, status: "READY" });
    await put({ ...taskPointerKey(companyId, workspaceId), taskId });
    await put({ ...taskKey(taskId), taskId, companyId, developerId, project: "payments", workspaceId });
    await put({ ...operationKey(companyId, workspaceId, operationId), id: operationId, workspaceId, companyId, fence: 1, status: "RUNNING", workflowMode: "PLAN" });
    await put({ ...coreTaskMarkKey(taskId), coreEngine: { engine: "core", areas: { flow: "core", build: "core", merge: "core" }, flags: "on", stampedAt: new Date(world.clock.now).toISOString() } });
    const record = createTeamRecord({ store: world.store, companyId, now: () => world.clock.now });
    await record.put({ project: "payments", taskId, authorId: developerId, kind: "decision", text: `shared query ${marker}`, sourceRef: sameSource, occurredAt: new Date(world.clock.now).toISOString() });
    // Identical raw record ids across companies, even though the writer normally hashes the company into them.
    const row = (await world.store.query({ pk: teamRecordPk(companyId, "payments"), sk: { op: "beginsWith", prefix: "TREC#" } })).items[0]!;
    await put({ ...row, id: "same-raw-record-id" });
    const token = caps.issue({ workspaceId, operationId, fence: 1, actions: ["context-tools"], expiresInSeconds: 60 });
    const headers = { "x-agentx-callback-capability": token };
    const request = (arguments_: unknown = { query: "shared query" }) => ({ method: "POST", path: `${path}/call`, headers, body: JSON.stringify({ requestId: randomUUID(), tool: "search_team_knowledge", arguments: arguments_ }) });
    runs.push({ companyId, workspaceId, operationId, taskId, headers, request, record, put });
  }
  return { world, root, reads, members, revokeProject: () => { projectAllowed = false; }, a: runs[0]!, b: runs[1]! };
}

describe("core Team context", () => {
  it("routes the catalog and searches only the workspace company despite payload company fields", async () => {
    const { root, a, b } = await setup();
    const catalog = await root.callback({ method: "GET", path, headers: a.headers });
    expect(catalog?.statusCode).toBe(200);
    expect(JSON.parse(catalog!.body)).toEqual({ sources: [], tools: [], searchTeamKnowledge: true, unavailable: [], disabled: [] });
    for (const [own, other, marker, forbidden] of [[a, b, "only-alpha", "only-bravo"], [b, a, "only-bravo", "only-alpha"]] as const) {
      const selected = vi.spyOn(root.app, "runtimeFor");
      const answer = await root.callback(own.request({ query: "shared query", companyId: other.companyId, orgId: other.companyId }));
      expect(selected).toHaveBeenLastCalledWith(own.companyId);
      selected.mockRestore();
      // Unknown arguments fail closed, never route to the supplied company.
      expect(answer?.body).not.toContain(forbidden);
      const good = await root.callback(own.request());
      expect(good?.body).toContain(marker);
      expect(good?.body).toContain("same-raw-record-id");
      expect(good?.body).not.toContain(forbidden);
      expect(good?.body).toContain('untrusted=');
    }
  });

  it("verifies signature, expiry and action before any read", async () => {
    const { root, a, reads } = await setup();
    const token = (actions: ("context-tools" | "events")[], expiresInSeconds: number) => caps.issue({ workspaceId: a.workspaceId, operationId: a.operationId, fence: 1, actions, expiresInSeconds });
    for (const headers of [{}, { ...a.headers, "x-agentx-callback-capability": `${a.headers["x-agentx-callback-capability"].split(".")[0]}.${Buffer.alloc(32, 2).toString("base64url")}` }, { ...a.headers, "x-agentx-callback-capability": "canary.invalid" }, { ...a.headers, "x-agentx-callback-capability": token(["context-tools"], -1) }, { ...a.headers, "x-agentx-callback-capability": token(["events"], 60) }]) {
      reads.length = 0;
      const result = await root.callback({ ...a.request(), headers });
      expect(result?.statusCode).toBe(403);
      expect(result?.body).toBe(JSON.stringify({ status: "REFUSED", text: "this operation cannot use context tools" }));
      expect(reads).toEqual([]);
    }
  });

  it("rechecks live owner membership and project authority on every call", async () => {
    const { root, a, members, revokeProject, world } = await setup();
    expect((await root.callback(a.request()))?.body).toContain("only-alpha");
    const query = vi.spyOn(world.store, "query");
    members.delete("owner-a");
    expect((await root.callback(a.request()))?.statusCode).toBe(403);
    members.set("owner-a", B);
    expect((await root.callback(a.request()))?.statusCode).toBe(403);
    members.set("owner-a", A);
    revokeProject();
    expect((await root.callback(a.request()))?.statusCode).toBe(403);
    expect((await root.callback({ method: "GET", path, headers: a.headers }))?.statusCode).toBe(403);
    expect((await root.callback({ ...a.request(), path: "/v1/internal/mcp", headers: { "x-rovara-workspace": a.workspaceId, authorization: `Bearer ${a.headers["x-agentx-callback-capability"]}` } }))?.body)
      .toBe(JSON.stringify({ status: "REFUSED", text: "this operation cannot use context tools" }));
    expect(query).not.toHaveBeenCalled();
  });

});


it("refuses missing or contradictory workspace company, stale operations and foreign tasks", async () => {
  for (const patch of [{ companyId: undefined }, { companyId: B }, { orgId: B }, { activeOperationId: randomUUID() }, { fence: 2 }]) {
    const { root, world, a } = await setup();
    const item = (await world.store.get(workspaceKey(a.companyId, a.workspaceId)))!;
    await a.put({ ...item, ...patch });
    const selected = vi.spyOn(root.app, "runtimeFor");
    const reply = await root.callback(a.request());
    if ("companyId" in patch && patch.companyId === undefined || "orgId" in patch) expect(selected).not.toHaveBeenCalled();
    selected.mockRestore();
    expect(reply?.statusCode).toBe(403);
    expect(reply?.body).not.toContain("only-");
  }
  for (const patch of [{ companyId: B }, { workspaceId: randomUUID() }, { developerId: undefined }, { project: undefined }]) {
    const { root, world, a } = await setup();
    await a.put({ ...(await world.store.get(taskKey(a.taskId)))!, ...patch });
    expect((await root.callback(a.request()))?.statusCode).toBe(403);
  }
});

it("keeps configured MCP and connection tools refused with fixed words", async () => {
  const { root, a } = await setup();
  for (const tool of ["src_demo_search", "src_canary_read"]) {
    const request = a.request();
    request.body = JSON.stringify({ requestId: randomUUID(), tool, arguments: { query: "private-canary" } });
    expect((await root.callback(request))?.body).toBe(JSON.stringify({ status: "REFUSED", text: "not on the core yet" }));
  }
  const reply = await root.callback({ ...a.request(), path: "/v1/internal/mcp", headers: { authorization: `Bearer ${a.headers["x-agentx-callback-capability"]}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "src_demo_search", arguments: {} } }) });
  expect(reply?.statusCode).toBe(200);
  expect(reply?.body).toContain("not on the core yet");
});

it("does not advertise Team search when the company's record is off", async () => {
  const { root, a } = await setup({ teamOff: true });
  const runtime = await root.app.runtimeFor(A);
  expect(runtime.flow.deps.contextSources).toBeUndefined();
  const answer = await root.callback({ method: "GET", path, headers: a.headers });
  expect(ContextToolCatalogSchema.parse(JSON.parse(answer!.body)).searchTeamKnowledge).toBe(false);
  expect((await root.callback(a.request()))?.body).not.toContain("only-alpha");
});

it("advertises eligible stages only for a company with its Team record", async () => {
  const { root, b } = await setup({ teamCompany: A });
  const runtime = await root.app.runtimeFor(A);
  const source = runtime.flow.deps.contextSources!;
  expect(source).toBeDefined();
  for (const mode of ["UNDERSTAND", "PLAN", "PLAN_CRITIQUE", "REVIEW"] as const) expect(await source.stageHasSources({} as never, mode)).toBe(true);
  for (const mode of ["IMPLEMENT", "CHECKS"] as const) expect(await source.stageHasSources({} as never, mode)).toBe(false);
  expect((await root.app.runtimeFor(B)).flow.deps.contextSources).toBeUndefined();
  expect((await root.callback({ method: "GET", path, headers: b.headers }))?.body)
    .toBe(JSON.stringify({ sources: [], tools: [], searchTeamKnowledge: false, unavailable: [], disabled: [] }));
  expect((await root.callback(b.request()))?.body).toBe(JSON.stringify({ status: "REFUSED", text: "this operation cannot use context tools" }));
});

it("bounds large requests before parsing and returns fixed failures for malformed input", async () => {
  const { root, a } = await setup();
  for (const body of ["{private-canary", JSON.stringify({ unexpected: "private-canary" }), "x".repeat(1_000_000), " ".repeat(1_000_000) + a.request().body]) {
    expect((await root.callback({ ...a.request(), body }))?.body).toBe(JSON.stringify({ status: "REFUSED", text: "this operation cannot use context tools" }));
  }
});

it("bounds a full 2,000-row search window to twenty hits and a total response byte budget", async () => {
  const { root, a, world } = await setup();
  for (let i = 0; i < 2000; i += 1) await a.record.put({ project: "payments", taskId: a.taskId, authorId: "owner-a", kind: "decision", text: `shared query ${"界".repeat(1800)} ${i}`, sourceRef: `record-${i}`, occurredAt: new Date(world.clock.now).toISOString() });
  const result = await root.callback(a.request());
  expect(result?.statusCode).toBe(200);
  const reply = ContextToolCallResponseSchema.parse(JSON.parse(result!.body));
  expect(reply.status).toBe("OK");
  const hits = (reply.text.match(/decision:/gu) ?? []).length;
  expect(hits).toBeGreaterThan(0);
  expect(hits).toBeLessThanOrEqual(20);
  expect(reply.truncated).toBe(true);
  expect(Buffer.byteLength(result!.body)).toBeLessThanOrEqual(16 * 1024);
}, 15_000);

it("ends the whole call at the existing deadline and stops late authorization reads", async () => {
  const { root, a, world, reads } = await setup();
  expect((await root.callback(a.request()))?.statusCode).toBe(200);
  vi.useFakeTimers();
  const original = world.store.get.bind(world.store);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  // Hold the operation read, immediately before authorization, rather than a discovery read inside a multi-read port.
  const spy = vi.spyOn(world.store, "get").mockImplementation(async (key) => {
    if (key.sk.startsWith("OPERATION#")) await held;
    return original(key);
  });
  const request = root.callback(a.request());
  await vi.advanceTimersByTimeAsync(30_001);
  expect((await request)?.statusCode).toBe(403);
  const count = reads.length;
  release();
  await vi.advanceTimersByTimeAsync(1);
  expect(reads).toHaveLength(count);
  spy.mockRestore();
});


it("refuses oversized or malformed search replies and search failures without echoing them", async () => {
  const { root, a } = await setup();
  const hit = { title: "Decision", system: "team-record", itemRef: "same-id", snippet: "private-canary", permissionSnapshot: null, score: 1 };
  for (const bad of [Array.from({ length: 21 }, () => hit), [{ ...hit, system: "other" }], [{ ...hit, snippet: "x".repeat(1_000_000) }]]) {
    adapters.searchReply = bad;
    expect((await root.callback(a.request()))?.body).toBe(JSON.stringify({ status: "REFUSED", text: "this operation cannot use context tools" }));
  }
  adapters.searchReply = Array.from({ length: 20 }, () => hit);
  expect(ContextToolCallResponseSchema.parse(JSON.parse((await root.callback(a.request()))!.body)).status).toBe("OK");
  adapters.searchReply = undefined;
  adapters.searchFails = true;
  expect((await root.callback(a.request()))?.body).toBe(JSON.stringify({ status: "REFUSED", text: "this operation cannot use context tools" }));
});

it("rejects invalid methods, stage, status, fence and operation company with no reflected data", async () => {
  for (const patch of [{ companyId: B }, { workspaceId: randomUUID() }, { id: randomUUID() }, { fence: 2 }, { status: "SUCCEEDED" }, { status: "CANCEL_REQUESTED" }, { status: "private-canary" }, { workflowMode: "IMPLEMENT" }, { workflowMode: "private-canary" }]) {
    const { root, world, a } = await setup();
    await a.put({ ...(await world.store.get(operationKey(a.companyId, a.workspaceId, a.operationId)))!, ...patch });
    const result = await root.callback(a.request());
    expect(result?.body).toBe(JSON.stringify({ status: "REFUSED", text: "this operation cannot use context tools" }));
  }
  const { root, a } = await setup();
  expect((await root.callback({ ...a.request(), method: "GET" }))?.statusCode).toBe(403);
});

 it.each(["missing", "foreign"])("refuses and logs exactly one fixed integrity event for a %s scoped workspace", async (kind) => {
  const { world, root, a } = await setup();
  const key = workspaceKey(a.companyId, a.workspaceId);
  if (kind === "missing") await world.store.delete({ key });
  else await world.store.put({ item: { ...(await world.store.get(key))!, companyId: B } });
  const integrity = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  expect((await root.callback(a.request()))?.statusCode).toBe(403);
  expect(integrity.mock.calls).toEqual([[{ component: "broker", event: "workspace.pointer_integrity" }]]);
 });
