// T2b: every SYSTEM closer, before the retention lane (no provider, a machine-backed workspace). Each one either closes BY TYPE with proof, or is SKIPPED, logged and its slot accounted for. A refusal that is swallowed and
// leaves the task open without a word FAILS these. Fake ports, not machine proof.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { IMPLICIT_COMPANY_ID, change, workspaceSessionKey, type JsonValue, type TransactItem } from "@agentx/contracts";
import { sweepDesignWaits, settleDesignWait } from "../../packages/broker/src/core/design-review/wait.js";
import { endSetupAgentTask } from "../../packages/broker/src/core/setup-agent/end.js";
import { closeSetupCheck } from "../../packages/broker/src/core/setup-agent/check.js";
import { answerScopeQuestion, scopeApprovalRequest, scopeQuestionKey, type ScopeQuestionRecord } from "../../packages/broker/src/core/build-step/scope-question.js";
import { endWikiBuildTask } from "../../packages/broker/src/core/wiki-build/end.js";
import { readWikiBuildPointer, wikiBuildPointerItem } from "../../packages/broker/src/core/wiki-build/run.js";
import { prepareCloseInspection } from "../../packages/broker/src/core/task-flow/close-inspection.js";
import { CLOSE_CANNOT_CHECK_WORDS, CLOSE_CHECKING_WORDS } from "../../packages/broker/src/core/task-flow/close-words.js";
import { chargeMarkerKey, operationKey, taskKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { readTask, workspaceOperations } from "../../packages/broker/src/core/task-flow/reads.js";
import { workspaceKeys } from "../../packages/broker/src/core/task-flow/workspace-location.js";
import type { OperationRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { guardWorld, type GuardWorld } from "../support/close-guard-world.js";
import { toRound, world as designWorld, type World as DesignWorld } from "../support/design-review-flow-world.js";

const DAY = 86_400;
const wikiPointer = (w: GuardWorld) => wikiBuildPointerItem({
  orgId: w.h.deps.companyId, project: w.task.project, taskId: w.task.taskId, requestId: randomUUID(), requestedBy: w.h.owner.principal.personId, startedAt: w.task.createdAt,
  limits: { pages: 1, budgetCents: 100, wallClockMin: 10, pageReserveCents: 10 }, pins: [{ repo: "demo", commit: "a".repeat(40) }], plan: [], keptFromEarlier: [], doneIds: [],
  pagesWritten: 0, claimsKept: 0, claimsDropped: 0, spentCents: 0, spentEarlierCents: 0, payer: { kind: "project", project: w.task.project }, buildKind: "first",
}, undefined);
const setupRun = { id: randomUUID(), kind: "task", workflowMode: "SETUP_AGENT" } as unknown as OperationRecord;
const notTheRun = { id: randomUUID(), kind: "task", workflowMode: "IMPLEMENT" } as unknown as OperationRecord;
const fresh = async (w: GuardWorld) => (await readTask(w.h.deps, w.task.taskId))!;
const skippedLogs = (w: GuardWorld, event: string) => w.logs.filter((entry) => entry["event"] === event);

describe("setup run end (a closer, exempt BY TYPE and only with the run's product recorded)", () => {
  it("closes: the run's end was written before the close, and its machine and slot go back", async () => {
    const w = await guardWorld({ machine: "backed" });
    await w.h.store.update({ key: taskKey(w.task.taskId), ops: [change.set("purpose", "setup_agent")] });
    const marker = chargeMarkerKey((await fresh(w)).charge, w.task.taskId);
    await endSetupAgentTask(w.h.deps, await fresh(w), setupRun, { status: "SUCCEEDED" });
    const task = await fresh(w);
    expect(task.agentRunEnd).toBeDefined();
    expect(task.closedAt).toBeDefined();
    expect(w.terminate).toHaveBeenCalledWith(w.machineId);
    expect(await w.h.store.get(marker)).toBeUndefined();
  });
  it("WITHOUT the proof it is skipped, said so in the log, and nothing is terminated: never closed, never silent", async () => {
    const w = await guardWorld({ machine: "backed", check: { request: vi.fn(async () => "queued" as const) } });
    await w.h.store.update({ key: taskKey(w.task.taskId), ops: [change.set("purpose", "setup_agent")] });
    // An operation that is not the run's own records no end (recordSetupAgentEnd), so the type proof is missing.
    await endSetupAgentTask(w.h.deps, await fresh(w), notTheRun, { status: "SUCCEEDED" });
    expect((await fresh(w)).closedAt).toBeUndefined();
    expect(w.terminate).not.toHaveBeenCalled();
    expect(skippedLogs(w, "setup_agent.close_skipped")).toEqual([expect.objectContaining({ taskId: w.task.taskId, reason: "checking" })]);
    expect(skippedLogs(w, "task_flow.close_skipped")).toHaveLength(1);
  });
  it("the exemption is the TASK'S type: an ordinary task with the same machine and no setup record is not exempt", async () => {
    const w = await guardWorld({ machine: "backed" });
    await w.h.store.update({ key: taskKey(w.task.taskId), ops: [change.set("agentRunEnd", { state: "COMPLETE", at: "2026-11-09T10:00:00.000Z" })] });
    await expect(w.close()).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
    expect((await fresh(w)).closedAt).toBeUndefined();
  });
});

describe("wiki build end (a closer, exempt BY TYPE and only with this run's end word written)", () => {
  it("closes: the end word is written before the close", async () => {
    const w = await guardWorld({ machine: "backed" });
    await w.h.store.update({ key: taskKey(w.task.taskId), ops: [change.set("purpose", "wiki_build")] });
    expect((await w.h.store.transact([wikiPointer(w)])).applied).toBe(true);
    await endWikiBuildTask(w.h.deps, await fresh(w));
    expect((await readWikiBuildPointer(w.h.store, w.h.deps.companyId, w.task.project))?.end).toBeDefined();
    expect((await fresh(w)).closedAt).toBeDefined();
    expect(w.terminate).toHaveBeenCalledWith(w.machineId);
  });
  it("without this task's pointer there is no proof: skipped, logged, nothing terminated (the refusal is NOT swallowed unseen)", async () => {
    const w = await guardWorld({ machine: "backed" });
    await w.h.store.update({ key: taskKey(w.task.taskId), ops: [change.set("purpose", "wiki_build")] });
    await endWikiBuildTask(w.h.deps, await fresh(w));
    expect((await fresh(w)).closedAt).toBeUndefined();
    expect(w.terminate).not.toHaveBeenCalled();
    expect(skippedLogs(w, "wiki_build.close_skipped")).toEqual([expect.objectContaining({ taskId: w.task.taskId, reason: "cannot_check" })]);
  });
  it("this task's pointer WITHOUT its end word is no proof: a close while the build still runs is refused, nothing closed, nothing terminated (review test)", async () => {
    const w = await guardWorld({ machine: "backed" });
    await w.h.store.update({ key: taskKey(w.task.taskId), ops: [change.set("purpose", "wiki_build")] });
    expect((await w.h.store.transact([wikiPointer(w)])).applied).toBe(true);
    expect((await readWikiBuildPointer(w.h.store, w.h.deps.companyId, w.task.project))?.end).toBeUndefined();
    await expect(w.close()).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
    expect((await fresh(w)).closedAt).toBeUndefined();
    expect(w.terminate).not.toHaveBeenCalled();
  });
  it("another task's pointer is not this task's proof", async () => {
    const w = await guardWorld({ machine: "backed" });
    await w.h.store.update({ key: taskKey(w.task.taskId), ops: [change.set("purpose", "wiki_build")] });
    const other = wikiPointer(w);
    if (other.kind !== "put") throw new Error("a pointer is a put");
    await w.h.store.put({ item: { ...other.item, taskId: randomUUID(), end: { word: "built", at: "2026-11-09T10:00:00.000Z" } } });
    await endWikiBuildTask(w.h.deps, await fresh(w));
    expect((await fresh(w)).closedAt).toBeUndefined();
  });
});

describe("a setup CHECK's scratch workspace (no task: the guard is not involved)", () => {
  it("still closes and terminates, with a live session item the guard would have refused", async () => {
    const w = await guardWorld({ machine: "backed", session: { state: "READY" } });
    const location = await workspaceKeys(w.h.deps, w.task.workspaceId);
    await w.h.store.put({ item: { ...location.row("SETUP_CHECK"), entityType: "SETUP_CHECK", companyId: w.h.deps.companyId, project: w.task.project, revision: 1, candidate: true } });
    const sessionReads = vi.spyOn(w.h.store, "get");
    expect(await closeSetupCheck(w.h.deps, w.task.workspaceId)).toBe(true);
    expect(w.terminate).toHaveBeenCalledWith(w.machineId);
    expect(sessionReads.mock.calls.some(([key]) => (key as { sk: string }).sk === "SESSION")).toBe(false);
  });
});

describe("the owner's Stop on a scope question (a person's close, gated)", () => {
  async function stopped(options: { check?: boolean } = {}) {
    const w = await guardWorld({ machine: "backed", ...(options.check === false ? {} : { check: { request: vi.fn(async () => "unsupported" as const) } }) });
    const sessionId = randomUUID();
    await w.h.store.update({ key: taskKey(w.task.taskId), ops: [change.set("sessionId", sessionId)] });
    const task = await fresh(w);
    const question: ScopeQuestionRecord = { taskId: w.task.taskId, kind: "scope", state: "open", version: 1, headSha: "a".repeat(40), request: "x", area: "auth", files: [], contentDigest: "c".repeat(64), askedAt: "2026-11-09T10:00:00.000Z" };
    await w.h.store.put({ item: { ...scopeQuestionKey(w.task.taskId), entityType: "SCOPE_QUESTION", question: JSON.parse(JSON.stringify(question)) as JsonValue, version: 1 } });
    const request = scopeApprovalRequest({ companyId: w.h.deps.companyId, task, question, choice: "stop" });
    const approvers = {
      requirement: async () => ({ methods: ["local-session"], minApprovers: 1, selfApprovalAllowed: true }),
      verify: async () => ({ approved: true as const, approver: { companyId: IMPLICIT_COMPANY_ID, personId: task.developerId, displayName: "Dana", roles: ["owner"], provider: "test" }, method: "local-session", proofId: "proof-1" }),
    };
    const proof = { token: "ok", method: "local-session", proofId: "proof-1", requestId: request.requestId, artifactDigest: request.artifactDigest, revision: request.revision };
    const answer = () => answerScopeQuestion({ ...w.h.deps, approvers }, { taskId: w.task.taskId, choice: "stop", proof });
    return { w, answer, sessionId };
  }
  it("a refused close is no longer swallowed: the answer carries the exact words, the task stays open and keeps its slot", async () => {
    const { w, answer } = await stopped();
    const result = await answer();
    expect(result).toMatchObject({ status: "recorded", question: { state: "stopped" }, closeRefused: CLOSE_CANNOT_CHECK_WORDS });
    expect((await fresh(w)).closedAt).toBeUndefined();
    expect(w.terminate).not.toHaveBeenCalled();
    expect(skippedLogs(w, "scope_question.stop_failed")).toHaveLength(1);
  });
  it("a check that was requested says so, in the exact 'checking' words", async () => {
    const queued = await stopped();
    queued.w.h.deps.closeCheck = { request: vi.fn(async () => "queued" as const) };
    expect(await queued.answer()).toMatchObject({ closeRefused: CLOSE_CHECKING_WORDS });
  });
  it("is also written on the task's session timeline", async () => {
    const { w, answer, sessionId } = await stopped();
    const put = vi.spyOn(w.h.store, "transact");
    await answer();
    const written = put.mock.calls.flatMap(([items]) => items as TransactItem[]).filter((item) => item.kind === "put" && String(item.item.sk).startsWith("EVENT#"));
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ kind: "put", item: { sessionId, text: CLOSE_CANNOT_CHECK_WORDS, actor: { kind: "system" } } });
  });
  it("a close that is allowed (no machine ever) still closes, and the answer says only 'recorded'", async () => {
    const w = await guardWorld({ machine: "none" });
    const task = await fresh(w);
    const question: ScopeQuestionRecord = { taskId: w.task.taskId, kind: "scope", state: "open", version: 1, headSha: "a".repeat(40), request: "x", area: "auth", files: [], contentDigest: "c".repeat(64), askedAt: "2026-11-09T10:00:00.000Z" };
    await w.h.store.put({ item: { ...scopeQuestionKey(w.task.taskId), entityType: "SCOPE_QUESTION", question: JSON.parse(JSON.stringify(question)) as JsonValue, version: 1 } });
    const request = scopeApprovalRequest({ companyId: w.h.deps.companyId, task, question, choice: "stop" });
    const approvers = { requirement: async () => ({ methods: ["local-session"], minApprovers: 1, selfApprovalAllowed: true }), verify: async () => ({ approved: true as const, approver: { companyId: IMPLICIT_COMPANY_ID, personId: task.developerId, displayName: "Dana", roles: ["owner"], provider: "test" }, method: "local-session", proofId: "p" }) };
    const result = await answerScopeQuestion({ ...w.h.deps, approvers }, { taskId: w.task.taskId, choice: "stop", proof: { token: "ok", method: "local-session", proofId: "p", requestId: request.requestId, artifactDigest: request.artifactDigest, revision: request.revision } });
    expect(result).not.toHaveProperty("closeRefused");
    expect((await fresh(w)).closedAt).toBeDefined();
  });
});

describe("design-review 30-day close of an abandoned, parked review (Q4: a system close never deletes)", () => {
  const timelineLines: string[] = [];
  const timeline = { statusLine: (_session: unknown, event: { text: string; eventId: string }): TransactItem => { timelineLines.push(event.text); return { kind: "put", item: { pk: `T#${event.eventId}`, sk: "LINE" }, condition: { op: "notExists", path: ["pk"] } }; } };
  const sweep = (w: DesignWorld) => sweepDesignWaits({ flow: w.h.deps, reader: w.runtime.reader, env: w.runtime.env, releaseKeys: async () => undefined, timeline });
  async function parked(options: { session?: boolean } = {}) {
    const w = await designWorld({ price: false, holdAnswerable: true });
    await toRound(w);
    w.h.clock.advance(8 * DAY);
    expect(await sweep(w)).toMatchObject({ parked: 1 });
    const workspace = (await w.h.store.get(workspaceKey(IMPLICIT_COMPANY_ID, w.workspaceId)))!;
    expect(workspace["machine"]).toBeDefined();
    if (options.session !== false) await w.h.store.put({ item: { ...workspaceSessionKey(w.workspaceId), entityType: "WORKSPACE_SESSION", workspaceId: w.workspaceId, state: "STOPPED", generation: 1, volumeId: "vol-0123456789abcdef0", availabilityZone: "us-west-2a" } });
    await w.h.store.update({ key: taskKey(w.taskId), ops: [change.set("sessionId", randomUUID())] });
    const logs: Array<Record<string, unknown>> = [];
    w.h.deps.log = (entry) => { logs.push(entry); };
    const terminate = vi.spyOn(w.h.machines, "terminate");
    const request = vi.fn(async () => "queued" as const);
    w.h.deps.closeGuard = { enforce: true };
    w.h.deps.closeCheck = { request };
    return { w, logs, terminate, request };
  }

  it("without proof it is SKIPPED: the review stays parked, nothing is terminated, the slot stays held, a line and a log say so, one check is requested, and the row is looked at again in a week", async () => {
    const { w, logs, terminate, request } = await parked();
    const before = await readTask(w.h.deps, w.taskId);
    w.h.clock.advance(31 * DAY);
    expect(await sweep(w)).toMatchObject({ attempted: 1, closed: 0 });
    const after = (await readTask(w.h.deps, w.taskId))!;
    expect(after.closedAt).toBeUndefined();
    expect(after.workflow).toEqual(before!.workflow);
    expect(after.releasedAt).toBeUndefined();
    expect(await w.h.store.get(chargeMarkerKey(after.charge, w.taskId))).toBeDefined();
    expect(terminate).not.toHaveBeenCalled();
    expect(logs).toContainEqual(expect.objectContaining({ event: "design_review.close_skipped", taskId: w.taskId, reason: "checking" }));
    expect(timelineLines.some((line) => line.includes(CLOSE_CHECKING_WORDS))).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    // Looked at again in a week, not on the next sweep.
    expect(await sweep(w)).toMatchObject({ attempted: 0 });
    w.h.clock.advance(7 * DAY + 60);
    expect(await sweep(w)).toMatchObject({ attempted: 1, closed: 0 });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("with proof (its session is gone) it closes as it always did, terminating the machine", async () => {
    const { w, terminate } = await parked({ session: false });
    w.h.clock.advance(31 * DAY);
    expect(await sweep(w)).toMatchObject({ closed: 1 });
    expect((await readTask(w.h.deps, w.taskId))!.closedAt).toBeDefined();
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it("a clean retained preview closes through the BOUND path (accepted first, no discard, nothing terminated here); a repeated sweep starts no second acceptance", async () => {
    const { w, terminate } = await parked();
    // (No agent session record in this world: the acceptance writes its receipt on a session only when the task has one.)
    await w.h.store.update({ key: taskKey(w.taskId), ops: [change.remove("sessionId")] });
    const workspace = (await w.h.store.get(workspaceKey(IMPLICIT_COMPANY_ID, w.workspaceId)))!;
    const operations = await workspaceOperations(w.h.deps, w.workspaceId);
    const holder = randomUUID();
    const template = (await w.h.store.get(operationKey(IMPLICIT_COMPANY_ID, w.workspaceId, operations[0]!.id)))!;
    await w.h.store.put({ item: { ...template, ...operationKey(IMPLICIT_COMPANY_ID, w.workspaceId, holder), id: holder, kind: "close", status: "RUNNING", fence: workspace["fence"] as number } });
    await w.h.store.update({ key: workspaceKey(IMPLICIT_COMPANY_ID, w.workspaceId), ops: [change.set("activeOperationId", holder), change.set("status", "READY")] });
    w.h.deps.closeInspection = { async raiseFence() {}, async retained() { return true; }, async inspectWorkspaceForClose() { return { inspection: { safeToClose: true, repositories: [], contentDigest: "a".repeat(64) }, retentionId: "kept" }; } };
    expect(await prepareCloseInspection(w.h.deps, w.workspaceId, holder)).toBe(true);
    const resumed = vi.fn(async () => {});
    w.h.deps.resumeAcceptedClose = resumed;
    w.h.clock.advance(31 * DAY);
    expect(await sweep(w)).toMatchObject({ closed: 1 });
    const task = (await readTask(w.h.deps, w.taskId))!;
    expect(task.closeOperationId).toBeDefined();
    const accepted = (await w.h.store.get(operationKey(IMPLICIT_COMPANY_ID, w.workspaceId, task.closeOperationId!)))!;
    expect(accepted).toMatchObject({ kind: "close", closeAcceptance: { discardUnpublished: false, actorId: "system:design-review" } });
    expect(resumed).toHaveBeenCalledTimes(1);
    expect(terminate).not.toHaveBeenCalled();
    // A crash after the acceptance: the row is looked at again and finds the accepted close; no second one.
    expect(await settleDesignWait({ flow: w.h.deps, reader: w.runtime.reader, env: w.runtime.env, releaseKeys: async () => undefined }, w.taskId, 0, w.h.clock.now)).toBe("gone");
    expect(resumed).toHaveBeenCalledTimes(1);
    expect((await workspaceOperations(w.h.deps, w.workspaceId)).filter((operation) => operation.closeAcceptance !== undefined)).toHaveLength(1);
  });
});
