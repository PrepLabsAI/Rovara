import { describe, expect, it } from "vitest";
import { EVAL_GATEWAY_FEATURE, EvalGatewayOriginSchema, WORKER_INVOCATION_FEATURES, WorkerInvocationSchema, captureEvalRoundEvidence, type JsonValue, type WorkflowSnapshot } from "@agentx/contracts";
import { startChecksRerun } from "../../packages/broker/src/core/build-step/start.js";
import { readTask, workspaceOperations } from "../../packages/broker/src/core/task-flow/reads.js";
import { readWorkspace } from "../../packages/broker/src/core/task-flow/stage-machine.js";
import { operationKey, taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { createHarness, newRequestId } from "../support/task-flow-harness.js";
import { evalRequestForChecks } from "../../packages/broker/src/core/proof/eval-round-reader.js";

async function world(feature: boolean, hint = true, without: readonly string[] = []) {
  const h = createHarness({ understandFirst: false, machines: { startingChecks: 0, features: WORKER_INVOCATION_FEATURES.filter(f => (feature || f !== "task.evalRound.v1") && !without.includes(f)) } });
  await h.registerProject();
  const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Eval change", workflow: true, workflowPath: "QUICK" });
  const answered = new Set<string>();
  for (let round = 0; round < 8; round++) {
    const current = (await readWorkspace(h.deps, started.task.workspaceId))!;
    if (current.status === "READY" && current.activeOperationId === null) break;
    await h.flow.dispatchOnce({ maxMessages: 10 }); h.clock.advance(70);
    const after = (await readWorkspace(h.deps, started.task.workspaceId))!;
    const job = after.machine === undefined ? undefined : h.machines.delivered(after.machine.machineId).find(entry => !answered.has(entry.operationId));
    if (job === undefined) continue; answered.add(job.operationId);
    await h.flow.recordResult({ workspaceId: after.id, operationId: job.operationId, fence: job.fence ?? after.fence, status: "SUCCEEDED" });
  }
  const task = (await readTask(h.deps, started.task.taskId))!;
  const workflow = { ...task.workflow!, revision: task.workflow!.revision + 1, stage: "VERIFY", state: "BLOCKED", blockReason: "candidate checks failed or have unknown results",
    flow: { ...task.workflow?.flow, tier: { kind: "small", reasons: hint ? [{ code: "eval_hint" }] : [] } },
    checkPolicy: { required: [{ id: "unit", label: "Unit", kind: "test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 60 } }], optional: [], selectedOptionalIds: [], proposed: [] },
  } as unknown as WorkflowSnapshot;
  await h.store.update({ key: taskKey(task.taskId), ops: [{ op: "set", path: ["workflow"], value: JSON.parse(JSON.stringify(workflow)) as JsonValue }] });
  h.deps.artifacts = { get: async () => undefined };
  const logs: unknown[] = []; h.deps.log = entry => { logs.push(entry); };
  return { h, task, workflow, logs };
}
describe("eval CHECKS dispatch", () => {
  it("bounds paginated metadata including empty pages with a cursor", async () => {
    const w = await world(true); let queries = 0;
    w.h.deps.store.query = async () => { if (++queries > 102) throw new Error("private-cursor"); return { items: [], cursor: "private-cursor" }; };
    expect(await evalRequestForChecks(w.h.deps, w.task, w.workflow)).toBeUndefined(); expect(queries).toBeLessThanOrEqual(100);
  });
  it("does not reset spend when an earlier requested attempt has no saved artifact", async () => {
    const w = await world(true);
    w.h.deps.store.query = async () => ({ items: [{ pk: "workspace", sk: "operation", id: "op-1", kind: "task", status: "SUCCEEDED", createdAt: "2026-11-14T00:00:00Z", dispatch: { payload: { evalRequest: { aiChange: true } } } }] });
    expect(await evalRequestForChecks(w.h.deps, w.task, w.workflow)).toBeUndefined();
  });
  it.each([0, 1, 2])("finds prior evals in a long task with %s completed passes", async passes => {
    const w = await world(true); let queries = 0; let gets = 0; let metaGets = 0; let reads = 0;
    const operations = Array.from({ length: 120 }, (_, i) => ({ pk: "workspace", sk: `OPERATION#op-${i}`, id: `op-${i}`, kind: "task", status: "SUCCEEDED", createdAt: new Date(Date.UTC(2026, 10, 14, 0, 0, i)).toISOString(),
      ...(i < passes ? { dispatch: { payload: { evalRequest: { aiChange: true } } } } : {}) }));
    w.h.deps.store.query = async () => { const start = queries++ * 100; return { items: operations.slice(start, start + 100), ...(start === 0 ? { cursor: "next" } : {}) }; };
    w.h.deps.store.get = async key => { gets++; if (key.sk === "META") { metaGets++; return { ...key, id: w.task.workspaceId, companyId: w.h.deps.companyId }; } const id = key.sk.split("#")[1]!; return { ...key, objectKey: `private/${w.task.ownerKey}/${w.task.workspaceId}/${id}/eval-round.json` }; };
    w.h.deps.artifacts = { get: async objectKey => {
      reads++; const pass = objectKey.includes("/op-0/") ? 1 : 2;
      return Buffer.from(JSON.stringify({ schemaVersion: 1, candidateDigest: "a".repeat(64), roundKind: "check_unsealed", evalPass: pass, outcome: "done", usage: { calls: 4, costMicros: 40 }, cache: "hit", evalConfigured: true,
        ...captureEvalRoundEvidence({ context: { aiChange: true, discovery: "configured", previousPasses: (pass - 1) as 0 | 1 }, comparison: { questions: [{ id: "q", category: "ordinary", old: Array.from({ length: 3 }, () => ({ pass: true, answer: "yes" })), first: { pass: false, answer: "no" } }], changedPromptCalls: 1 } }) }));
    } };
    const request = await evalRequestForChecks(w.h.deps, w.task, w.workflow);
    if (passes === 2) expect(request).toBeUndefined();
    else expect(request).toEqual({ aiChange: true, reason: "eval_hint", evalPass: passes + 1, callsAlreadyUsed: passes * 4, costAlreadyUsedMicros: passes * 40 });
    expect(queries).toBe(2); expect(gets).toBe(passes + 1); expect(metaGets).toBe(1); expect(reads).toBe(passes);
  });
  it.each([true, false])("runs the real checks dispatcher with eval feature %s", async feature => {
    const w = await world(feature);
    expect(await startChecksRerun(w.h.deps, { taskId: w.task.taskId, workflowRevision: w.workflow.revision }, { requestId: newRequestId(), actorId: "owner" })).toBe("STARTED");
    const operation = (await workspaceOperations(w.h.deps, w.task.workspaceId)).find(op => op.workflowMode === "CHECKS")!;
    expect(operation.dispatch.payload).toHaveProperty("evalRequest");
    await w.h.flow.dispatchOnce({ maxMessages: 10 });
    const workspace = (await readWorkspace(w.h.deps, w.task.workspaceId))!;
    const job = w.h.machines.delivered(workspace.machine!.machineId).find(entry => entry.operationId === operation.id);
    expect(job).toBeDefined();
    if (feature) expect(job).toMatchObject({ payload: { evalRequest: { aiChange: true, reason: "eval_hint", evalPass: 1, callsAlreadyUsed: 0, costAlreadyUsedMicros: 0 } } });
    else { expect(job).not.toHaveProperty("payload.evalRequest"); expect(JSON.stringify(w.logs)).toContain("eval_request_dropped_unsupported_worker"); }
    // DEC 253c: the run asked for an eval may fetch its eval plan (`eval-plan`); a worker that is not sent the request is not given the action either.
    const actions = (JSON.parse(Buffer.from(String((job as { callbackCapability?: string }).callbackCapability).split(".")[0]!, "base64url").toString("utf8")) as { actions: string[] }).actions;
    expect(actions.includes("eval-plan")).toBe(feature);
  });
  it("leaves ordinary checks payloads untouched when the tier has no eval hint", async () => {
    const w = await world(true, false);
    expect(await startChecksRerun(w.h.deps, { taskId: w.task.taskId, workflowRevision: w.workflow.revision }, { requestId: newRequestId(), actorId: "owner" })).toBe("STARTED");
    const operation = (await workspaceOperations(w.h.deps, w.task.workspaceId)).find(op => op.workflowMode === "CHECKS")!;
    expect(operation.dispatch.payload).not.toHaveProperty("evalRequest");
    expect(operation.dispatch.extraActions ?? []).not.toContain("eval-plan");
  });
});

// Lead 4 L4-EVW: the model gateway's origin goes to a hosted worker with the eval request (the worker has no setting of its own).
describe("eval gateway delivery to the worker", () => {
  const GATEWAY = "https://gateway.example.test";
  const delivered = async (w: Awaited<ReturnType<typeof world>>) => {
    expect(await startChecksRerun(w.h.deps, { taskId: w.task.taskId, workflowRevision: w.workflow.revision }, { requestId: newRequestId(), actorId: "owner" })).toBe("STARTED");
    const operation = (await workspaceOperations(w.h.deps, w.task.workspaceId)).find(op => op.workflowMode === "CHECKS")!;
    await w.h.flow.dispatchOnce({ maxMessages: 10 });
    const workspace = (await readWorkspace(w.h.deps, w.task.workspaceId))!;
    const job = w.h.machines.delivered(workspace.machine!.machineId).find(entry => entry.operationId === operation.id);
    expect(job).toBeDefined();
    return { job: job as { payload: Record<string, unknown> }, operation };
  };

  it("the feature is listed and the field needs an eval request and an https origin", () => {
    expect(WORKER_INVOCATION_FEATURES).toContain(EVAL_GATEWAY_FEATURE);
    expect(EVAL_GATEWAY_FEATURE).toBe("task.evalGateway.v1");
    expect(EvalGatewayOriginSchema.safeParse(GATEWAY).success).toBe(true);
    expect(EvalGatewayOriginSchema.safeParse("https://gateway.example.test:8443").success).toBe(true);
    for (const bad of ["", "http://gateway.example.test", `${GATEWAY}/`, `${GATEWAY}/v1`, "https://u:p@gateway.example.test", `${GATEWAY}?a=b`, `${GATEWAY}#x`, "not a url", `https://${"a".repeat(600)}.example.test`, " https://gateway.example.test", "ftp://gateway.example.test"]) {
      expect(EvalGatewayOriginSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("sends the origin with an eval request to a worker that lists the feature, and the invocation still parses", async () => {
    const w = await world(true); w.h.deps.evalGatewayUrl = GATEWAY;
    const { job } = await delivered(w);
    expect(job.payload).toMatchObject({ evalRequest: { aiChange: true, reason: "eval_hint", evalPass: 1 }, evalGatewayUrl: GATEWAY });
    expect(() => WorkerInvocationSchema.parse(job)).not.toThrow();
  });

  it("sends nothing when the install has no gateway: the payload is exactly what it was", async () => {
    const w = await world(true); expect(w.h.deps.evalGatewayUrl).toBeUndefined();
    const { job } = await delivered(w);
    expect(job.payload).toHaveProperty("evalRequest");
    expect(job.payload).not.toHaveProperty("evalGatewayUrl");
    expect(JSON.stringify(job.payload)).not.toContain("gateway");
  });

  it("an older worker (eval round, no gateway feature) is sent the request but not the field, so its strict parse never refuses the step", async () => {
    const w = await world(true, true, [EVAL_GATEWAY_FEATURE]); w.h.deps.evalGatewayUrl = GATEWAY;
    const { job } = await delivered(w);
    expect(job.payload).toHaveProperty("evalRequest");
    expect(job.payload).not.toHaveProperty("evalGatewayUrl");
  });

  it("a worker that lists the gateway feature but not the eval round gets neither the request nor the field (the order of the two checks)", async () => {
    const w = await world(false); w.h.deps.evalGatewayUrl = GATEWAY;
    const { job } = await delivered(w);
    expect(job.payload).not.toHaveProperty("evalRequest");
    expect(job.payload).not.toHaveProperty("evalGatewayUrl");
    expect(() => WorkerInvocationSchema.parse(job)).not.toThrow();
  });

  it.each(["http://gateway.example.test", `${GATEWAY}/v1`, "https://u:p@gateway.example.test", `${GATEWAY}?a=b`, "gateway.example.test", ""])("refuses to send an address that is not an https origin (%s) and still delivers the step", async bad => {
    const w = await world(true); w.h.deps.evalGatewayUrl = bad;
    const { job } = await delivered(w);
    expect(job.payload).toHaveProperty("evalRequest");
    expect(job.payload).not.toHaveProperty("evalGatewayUrl");
  });

  it("never sends it without an eval request, even where the gateway is configured (ordinary checks and every other step)", async () => {
    const w = await world(true, false); w.h.deps.evalGatewayUrl = GATEWAY;
    const { job } = await delivered(w);
    expect(job.payload).not.toHaveProperty("evalRequest");
    expect(job.payload).not.toHaveProperty("evalGatewayUrl");
    const workspace = (await readWorkspace(w.h.deps, w.task.workspaceId))!;
    for (const entry of w.h.machines.delivered(workspace.machine!.machineId)) expect(entry.payload).not.toHaveProperty("evalGatewayUrl");
  });

  it("an address in the stored payload is never trusted: it is dropped and only the dispatcher's own setting is sent", async () => {
    const w = await world(true);
    expect(await startChecksRerun(w.h.deps, { taskId: w.task.taskId, workflowRevision: w.workflow.revision }, { requestId: newRequestId(), actorId: "owner" })).toBe("STARTED");
    const operation = (await workspaceOperations(w.h.deps, w.task.workspaceId)).find(op => op.workflowMode === "CHECKS")!;
    await w.h.store.update({ key: operationKey(w.h.deps.companyId, w.task.workspaceId, operation.id), ops: [{ op: "set", path: ["dispatch", "payload", "evalGatewayUrl"], value: "https://attacker.example.test" }] });
    await w.h.flow.dispatchOnce({ maxMessages: 10 });
    const workspace = (await readWorkspace(w.h.deps, w.task.workspaceId))!;
    const job = w.h.machines.delivered(workspace.machine!.machineId).find(entry => entry.operationId === operation.id) as { payload: Record<string, unknown> };
    expect(job).toBeDefined();
    expect(JSON.stringify(job.payload)).not.toContain("attacker");
    expect(job.payload).not.toHaveProperty("evalGatewayUrl");
  });

  it("the stored operation never carries the address (it is added at delivery only)", async () => {
    const w = await world(true); w.h.deps.evalGatewayUrl = GATEWAY;
    const { operation } = await delivered(w);
    expect(JSON.stringify(operation.dispatch)).not.toContain(GATEWAY);
    expect(operation.dispatch.payload).not.toHaveProperty("evalGatewayUrl");
  });

  it("the worker contract refuses the field without an eval request (and with a bad origin) and accepts it with one", async () => {
    const w = await world(true); w.h.deps.evalGatewayUrl = GATEWAY;
    const { job } = await delivered(w);
    const invocation = job;
    expect(WorkerInvocationSchema.safeParse(invocation).success).toBe(true);
    const { evalRequest: _evalRequest, ...withoutRequest } = invocation.payload; void _evalRequest;
    expect(WorkerInvocationSchema.safeParse({ ...invocation, payload: withoutRequest }).success).toBe(false);
    expect(WorkerInvocationSchema.safeParse({ ...invocation, payload: { ...invocation.payload, evalGatewayUrl: "http://gateway.example.test" } }).success).toBe(false);
    expect(WorkerInvocationSchema.safeParse({ ...invocation, payload: { ...invocation.payload, evalGatewayUrl: `${GATEWAY}/v1` } }).success).toBe(false);
  });
});
