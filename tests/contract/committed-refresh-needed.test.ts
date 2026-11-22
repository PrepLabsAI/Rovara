import { describe, expect, it } from "vitest";
import { AgentXErrorCodeSchema, agentXError, reportTaskFeatureKey, type JsonValue } from "@agentx/contracts";
import { createTaskActions } from "../../packages/broker/src/core/task-flow/task-actions.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { REQUEST_A, TASK_ID, code, parserId, plain, seed, stateOf, taskOf } from "../support/task-actions-world.js";

describe("confirmed owner move response failures", () => {
  it("accepts the additive wire code as an ordinary 409 for old clients", () => {
    expect(agentXError(AgentXErrorCodeSchema.parse("COMMITTED_REFRESH_NEEDED"), "refresh").statusCode).toBe(409);
  });

  it.each(["send-back", "findings"])("keeps concurrent request-key reuse separate from a stale %s", async (action) => {
    const { h, caller } = await seed();
    const actions = createTaskActions(h.deps);
    const send = () => actions.sendBack(caller, TASK_ID, { requestId: REQUEST_A, expectedRevision: 6, instructions: "0 accepted, 1 to fix" });
    const findings = () => actions.resolveFindings(caller, TASK_ID, { requestId: REQUEST_A, expectedRevision: 6, candidateDigest: code.digest, resolutions: [{ findingId: parserId, action: "FIX", note: "Fix the footer." }] });
    const transact = h.deps.store.transact.bind(h.deps.store);
    let winner: Awaited<ReturnType<typeof stateOf>> | undefined;
    h.deps.store.transact = async () => {
      h.deps.store.transact = transact;
      await (action === "send-back" ? findings() : send());
      winner = await stateOf(h);
      return { applied: false, reason: "condition_failed", failed: [0] };
    };
    await expect(action === "send-back" ? send() : findings()).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", statusCode: 409 });
    expect((await taskOf(h)).workflow?.decisions).toEqual([expect.objectContaining({ requestId: REQUEST_A, source: action === "send-back" ? "FINDINGS" : "SEND_BACK", workflowRevision: 6, reason: "0 accepted, 1 to fix" })]);
    expect(await stateOf(h)).toEqual(winner);
  });

  it.each(["send-back", "findings"])("refuses prior cross-kind request-key reuse as %s even when the decision words collide", async (action) => {
    const { h, caller } = await seed();
    const actions = createTaskActions(h.deps);
    const send = () => actions.sendBack(caller, TASK_ID, { requestId: REQUEST_A, expectedRevision: 6, instructions: "0 accepted, 1 to fix" });
    const findings = () => actions.resolveFindings(caller, TASK_ID, { requestId: REQUEST_A, expectedRevision: 6, candidateDigest: code.digest, resolutions: [{ findingId: parserId, action: "FIX", note: "Fix the footer." }] });
    await (action === "send-back" ? findings() : send());
    const before = await stateOf(h);
    expect(before.workflow?.decisions).toEqual([expect.objectContaining({ requestId: REQUEST_A, source: action === "send-back" ? "FINDINGS" : "SEND_BACK", workflowRevision: 6, reason: "0 accepted, 1 to fix" })]);
    await expect(action === "send-back" ? send() : findings()).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", statusCode: 409 });
    expect(await stateOf(h)).toEqual(before);
  });

  it.each(["prior", "lost-race"])("refuses a %s findings replay at a different revision with the same request id and answers", async (replay) => {
    const { h, caller } = await seed();
    const actions = createTaskActions(h.deps);
    const findings = (expectedRevision: number) => actions.resolveFindings(caller, TASK_ID, { requestId: REQUEST_A, expectedRevision, candidateDigest: code.digest, resolutions: [{ findingId: parserId, action: "FIX", note: "Fix the footer." }] });
    let winner: Awaited<ReturnType<typeof stateOf>>;
    if (replay === "prior") {
      await findings(6);
      winner = await stateOf(h);
    } else {
      const transact = h.deps.store.transact.bind(h.deps.store);
      h.deps.store.transact = async () => {
        h.deps.store.transact = transact;
        // Another revision wins while the request at revision 6 is in flight.
        const record = await h.store.get(taskKey(TASK_ID));
        const task = await taskOf(h);
        await h.store.put({ item: { ...record!, workflow: plain({ ...task.workflow!, revision: 7 }) as unknown as JsonValue } });
        await findings(7);
        winner = await stateOf(h);
        return { applied: false, reason: "condition_failed", failed: [0] };
      };
    }
    await expect(findings(replay === "prior" ? 7 : 6)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", statusCode: 409 });
    expect((await taskOf(h)).workflow?.decisions).toEqual([expect.objectContaining({ requestId: REQUEST_A, source: "FINDINGS", workflowRevision: replay === "prior" ? 6 : 7, reason: "0 accepted, 1 to fix" })]);
    expect(await stateOf(h)).toEqual(winner!);
  });

  it("does not claim applied when the transaction outcome is unproven", async () => {
    const { h, caller } = await seed();
    const before = await taskOf(h);
    h.deps.store.transact = async () => { throw new Error("transaction response lost"); };
    await expect(createTaskActions(h.deps).sendBack(caller, TASK_ID, { requestId: REQUEST_A, expectedRevision: 6, instructions: "Fix the footer." })).rejects.toThrow("transaction response lost");
    expect(await taskOf(h)).toEqual(before);
  });

  it.each(["send-back", "findings"])("reports applied when %s committed but its first task projection failed", async (action) => {
    const { h, caller } = await seed();
    let committed = false;
    h.deps.lessonsSentBack = async () => { committed = true; };
    const get = h.deps.store.get.bind(h.deps.store);
    h.deps.store.get = async (key) => {
      if (committed) throw agentXError("CONFIG_INVALID", "unreadable internal projection");
      return get(key);
    };
    const actions = createTaskActions(h.deps);
    const call = () => action === "send-back"
      ? actions.sendBack(caller, TASK_ID, { requestId: REQUEST_A, expectedRevision: 6, instructions: "Fix the footer." })
      : actions.resolveFindings(caller, TASK_ID, { requestId: REQUEST_A, expectedRevision: 6, candidateDigest: code.digest, resolutions: [{ findingId: parserId, action: "FIX", note: "Fix the footer." }] });
    await expect(call()).rejects.toMatchObject({ code: "COMMITTED_REFRESH_NEEDED", statusCode: 409, message: "COMMITTED_REFRESH_NEEDED: The change was applied. Refresh to read the current task before acting again." });
    h.deps.store.get = get;
    expect((await taskOf(h)).workflow?.decisions).toEqual([expect.objectContaining({ requestId: REQUEST_A })]);
    const before = await stateOf(h);
    const featureKey = reportTaskFeatureKey(h.deps.companyId, TASK_ID);
    h.deps.store.get = async (key) => {
      if (key.pk === featureKey.pk && key.sk === featureKey.sk) throw agentXError("FORBIDDEN", "internal projection denied");
      return get(key);
    };
    await expect(call()).rejects.toMatchObject({ code: "COMMITTED_REFRESH_NEEDED", statusCode: 409 });
    h.deps.store.get = get;
    expect(await stateOf(h)).toEqual(before);
    await call();
    expect(await stateOf(h)).toEqual(before);
  });
});
