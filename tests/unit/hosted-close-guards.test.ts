import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { CLOSE_RETENTION_FEATURE, change, workspaceSessionKey, type WorkspaceSession } from "@agentx/contracts";
import { createBrokerCloseInspection, createDispatcherCloseInspection, withCloseVerification } from "../../packages/broker/src/aws/worker-machines/close-retention.js";
import { workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { createHarness } from "../support/task-flow-harness.js";
import type { CodeModuleDeps } from "../../packages/broker/src/core-host/code-modules.js";

async function fixture() {
  const h = createHarness(); await h.registerProject();
  const { task } = await h.flow.start(h.owner, { requestId: randomUUID(), project: "payments", instructions: "retention guards" });
  const generation = { sessionGeneration: 1, instanceId: "i-0123456789abcdef0", volumeId: "vol-0123456789abcdef0", dataGeneration: randomUUID() };
  const retention = { inspectionOperationId: randomUUID(), inspectionFence: 2, retentionId: randomUUID(), contentDigest: "a".repeat(64), generation };
  const input = { workspaceId: task.workspaceId, operationId: retention.inspectionOperationId, fence: 2, retentionId: retention.retentionId, contentDigest: retention.contentDigest, retentionProof: { schemaVersion: 1 as const, generation } };
  const session: WorkspaceSession = { workspaceId: task.workspaceId, state: "READY", generation: 1, instanceId: generation.instanceId, volumeId: generation.volumeId, privateIp: "10.0.0.1", subnetId: "subnet-0123456789abcdef0", availabilityZone: "us-east-1a", launchedAt: new Date().toISOString(), readyAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(), workspaceDataIdentity: generation, closeRetention: { schemaVersion: 1, operationId: retention.inspectionOperationId, fence: 2, generation, retained: retention } };
  const sessionKey = workspaceSessionKey(task.workspaceId);
  await h.store.put({ item: { ...sessionKey, ...session } as never });
  const sessions = { get: vi.fn(async () => session) };
  const deliver = vi.spyOn(h.machines, "deliver").mockImplementation(async (_machine, command) => {
    const payload = command.payload as { queryId: string };
    return { duplicate: false, answer: { schemaVersion: 1, action: "verify", status: "verified", workspaceId: command.workspaceId, operationId: command.operationId, fence: command.fence, retention, queryId: payload.queryId, verified: true } };
  });
  const provider = createDispatcherCloseInspection({ companyId: h.deps.companyId, store: h.store, machines: h.machines, sessions });
  return { h, task, retention, input, session, sessionKey, sessions, deliver, provider };
}

it("valid retained proof uses the live session and exact worker reply without writes", async () => {
  const w = await fixture(), writes = vi.spyOn(w.h.store, "transact");
  expect(await w.provider.retained(w.input)).toBe(true);
  expect(w.deliver).toHaveBeenCalledOnce(); expect(writes).not.toHaveBeenCalled();
});
it.each(["company", "state", "sessionGeneration", "instanceId", "volumeId", "retained"] as const)("rejects changed %s before worker access", async field => {
  const w = await fixture();
  if (field === "company") await w.h.store.update({ key: workspaceKey(w.h.deps.companyId, w.task.workspaceId), ops: [change.set("companyId", "org_bbbbbbbbbbbbbbbbbbbb")] });
  if (field === "state") w.session.state = "STOPPED";
  if (field === "sessionGeneration") w.session.generation++;
  if (field === "instanceId") w.session.instanceId = "i-11111111111111111";
  if (field === "volumeId") w.session.volumeId = "vol-11111111111111111";
  if (field === "retained") w.session.closeRetention!.retained = { ...w.retention, contentDigest: "b".repeat(64) };
  expect(await w.provider.retained(w.input).catch(() => false)).toBe(false);
  expect(w.deliver).not.toHaveBeenCalled();
  if (field === "company") expect(w.sessions.get).not.toHaveBeenCalled();
});
it.each(["workspaceId", "operationId", "fence", "action", "queryId", "retention", "verified"] as const)("rejects a worker reply with changed %s", async field => {
  const w = await fixture(), original = w.deliver.getMockImplementation()!;
  w.deliver.mockImplementation(async (...args) => {
    const result = await original(...args), answer = { ...result.answer };
    answer[field] = field === "fence" ? 99 : field === "verified" ? false : field === "action" ? "retain" : field === "retention" ? { ...w.retention, contentDigest: "b".repeat(64) } : randomUUID();
    return { ...result, answer };
  });
  expect(await w.provider.retained(w.input).catch(() => false)).toBe(false);
});
it.each(["state", "workspaceDataIdentity", "retained", "acceptedOperationId", "closeDestroy"] as const)("acceptance atomically refuses changed %s without recording its claim", async field => {
  const w = await fixture(), items = w.provider.acceptanceItems!(w.input, randomUUID());
  const path = field === "retained" ? "closeRetention.retained" : field === "acceptedOperationId" ? "closeRetention.acceptedOperationId" : field;
  const value = field === "state" ? "STOPPED" : field === "workspaceDataIdentity" ? { ...w.retention.generation, dataGeneration: randomUUID() } : field === "retained" ? { ...w.retention, contentDigest: "b".repeat(64) } : randomUUID();
  await w.h.store.update({ key: w.sessionKey, ops: [change.set(path, value)] });
  const before = await w.h.store.get(w.sessionKey);
  expect((await w.h.store.transact(items)).applied).toBe(false);
  expect(await w.h.store.get(w.sessionKey)).toEqual(before);
});
it("acceptance records its exact operation when all session predicates still match", async () => {
  const w = await fixture(), id = randomUUID();
  expect((await w.h.store.transact(w.provider.acceptanceItems!(w.input, id))).applied).toBe(true);
  expect((await w.h.store.get(w.sessionKey))?.closeRetention).toMatchObject({ acceptedOperationId: id });
});

it("the production broker relay accepts only an exact successful Lambda reply and never mutates storage", async () => {
  const { LambdaClient } = await import("@aws-sdk/client-lambda");
  const codeModules = await import("../../packages/broker/src/core-host/code-modules.js");
  const { createBrokerCoreRoot } = await import("../../packages/broker/src/aws/core-engine-root.js");
  const { createFakeWorld } = await import("../support/core-host-fakes.js");
  const w = await fixture();
  const modules = vi.spyOn(codeModules, "codeAdapterModules").mockImplementation(() => createFakeWorld().modules.filter(m => !["metering", "admission", "identity", "approvers", "audit-sink"].includes(m.point)));
  let variant = "valid";
  const send = vi.spyOn(LambdaClient.prototype, "send").mockImplementation((async (command: { input: { FunctionName?: string; InvocationType?: string; Payload?: Uint8Array } }) => {
    expect(command.input.FunctionName).toBe("arn:aws:lambda:us-east-1:111122223333:function:dispatcher");
    expect(command.input.InvocationType).toBe("RequestResponse");
    const event = JSON.parse(Buffer.from(command.input.Payload!).toString("utf8")) as { queryId: string; companyId: string };
    expect(event.companyId).toBe(w.h.deps.companyId);
    const reply = { schemaVersion: 1, queryId: event.queryId, verified: true };
    if (variant === "function error") return { FunctionError: "Unhandled", Payload: Buffer.from(JSON.stringify(reply)) };
    if (variant === "missing payload") return {};
    if (variant === "malformed") return { Payload: Buffer.from("{") };
    const bad = variant === "extra" ? { ...reply, Records: [] } : variant === "version" ? { ...reply, schemaVersion: 2 }
      : variant === "query" ? { ...reply, queryId: randomUUID() } : variant === "false" ? { ...reply, verified: false }
        : variant === "truthy" ? { ...reply, verified: "true" } : reply;
    return { Payload: Buffer.from(JSON.stringify(bad)) };
  }) as never);
  const build = (configured: boolean) => createBrokerCoreRoot({
    env: configured ? { CLOSE_RETENTION_DISPATCHER_ARN: "arn:aws:lambda:us-east-1:111122223333:function:dispatcher" } : {},
    stateTableName: "State", signInTableName: undefined, documentClient: { send: async () => ({ Item: { companyId: w.h.deps.companyId, orgId: w.h.deps.companyId } }) },
    callbackSigningKey: "k".repeat(32), repositoryGrantKey: Buffer.alloc(32), repositoryCredential: async () => { throw new Error("unused"); }, origin: () => "https://example.test", wrapStorage: () => w.h.store,
    codeModules: () => ({} as CodeModuleDeps),
    services: () => Object.fromEntries(["merge-tracking", "session-sweep", "notify-deliver"].map(name => [name, { pass: async () => ({}) }])),
    ciReporting: { honest: true, ciMode: () => "their_ci_watch" }, log: () => {},
  });
  try {
    const provider = (await build(true).app.runtimeFor(w.h.deps.companyId)).flow.deps.closeInspection!;
    const writes = [vi.spyOn(w.h.store, "transact"), vi.spyOn(w.h.store, "update"), vi.spyOn(w.h.store, "put"), vi.spyOn(w.h.store, "delete")];
    expect(await provider.retained(w.input)).toBe(true);
    for (variant of ["function error", "missing payload", "malformed", "extra", "version", "query", "false", "truthy"]) {
      expect(await provider.retained(w.input).catch(() => false), variant).toBe(false);
    }
    send.mockClear();
    const absent = (await build(false).app.runtimeFor(w.h.deps.companyId)).flow.deps.closeInspection!;
    expect(await absent.retained(w.input)).toBe(false); expect(send).not.toHaveBeenCalled();
    for (const write of writes) { expect(write).not.toHaveBeenCalled(); write.mockRestore(); }
  } finally { send.mockRestore(); modules.mockRestore(); }
});


it("broker readiness requires a current READY SESSION with advertised capability and never writes", async () => {
  const w = await fixture(), verify = vi.fn(async () => true);
  const broker = createBrokerCloseInspection(verify, w.h.deps.companyId, w.h.store);
  await w.h.store.update({ key: w.sessionKey, ops: [change.set("workerFeatures", [CLOSE_RETENTION_FEATURE])] });
  expect(await broker.ready!(w.task.workspaceId)).toBe(true);
  for (const [path, value] of [["state", "STOPPED"], ["workerFeatures", []], ["workerFeatures", CLOSE_RETENTION_FEATURE]] as const) {
    await w.h.store.update({ key: w.sessionKey, ops: [change.set("state", "READY"), change.set("workerFeatures", [CLOSE_RETENTION_FEATURE])] });
    await w.h.store.update({ key: w.sessionKey, ops: [change.set(path, typeof value === "string" ? value : [...value])] });
    const writes = vi.spyOn(w.h.store, "transact");
    expect(await broker.ready!(w.task.workspaceId)).toBe(false); expect(writes).not.toHaveBeenCalled(); writes.mockRestore();
  }
  expect(await broker.retained({ ...w.input, retentionId: "invalid" })).toBe(false); expect(verify).not.toHaveBeenCalled();
  await expect(broker.raiseFence(w.task.workspaceId, 99)).rejects.toThrow();
  await expect(broker.inspectWorkspaceForClose(w.input)).rejects.toThrow();
});
it("ordinary queue events still use the documented queue branch without a proof call", async () => {
  const queue = vi.fn(async () => ({ batchItemFailures: [] })), verify = vi.fn(async () => true), route = withCloseVerification(queue, verify);
  const event = { Records: [] };
  expect(await route(event)).toEqual({ batchItemFailures: [] });
  expect(queue).toHaveBeenCalledWith(event, undefined); expect(verify).not.toHaveBeenCalled();
});
