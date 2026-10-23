import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { workflowApplicationEvidenceCodes, workflowSendBackOffered, type WorkflowSnapshot } from "@agentx/contracts";
import { workflowMessage } from "../../packages/broker/src/developer/workflow-messages.js";
import { E2E_OWNER_SENTENCES } from "../../packages/broker/src/e2e/owner-sentences.js";
import { disposeRealCandidates } from "../support/e2e-application-candidate.js";
import type { ApplicationGroupEvidence } from "../support/e2e-application-evidence-fixture.js";
import { MAYA, OMAR } from "../support/developer-task-broker.js";
import { startApplicationRound, type ApplicationRound } from "../support/e2e-application-round-harness.js";

// M1.4 RUN-2 item 2, on the real broker: an application round whose group the app host ended with a code is blocked with that code in its reason; for the four codes the candidate causes
// the owner's Send back goes through the workflow's existing send-back route, and the coder is told the fixed code and its sentence, nothing the app or the build printed.

afterEach(async () => { vi.useRealTimers(); await disposeRealCandidates(); });

const PASS = { kind: "http-status", status: 200 } as const;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const BUILD_LOG = "npm ERR! hunter2-build-log /home/runner/work/app/node_modules/.bin/vite";
const APP_LOG = "Error: connect ECONNREFUSED ops@tenant-a.example password=hunter2-app-log";

/** A round in which the app host ended every group with `code` (the worker's report for a group that never got to run: no readback, the logs in its diagnostics). */
async function blockedWithCode(code: string): Promise<ApplicationRound> {
  const round = await startApplicationRound();
  const groups: ApplicationGroupEvidence[] = [];
  for (const groupId of round.groupIds) groups.push(await round.collectGroup(groupId, PASS));
  round.markRunning();
  const runs: Record<string, unknown>[] = [];
  for (const group of groups) {
    const groupRun = clone(group.groupRun);
    groupRun.collection = { status: "UNKNOWN", reason: code };
    groupRun.unavailableReason = code;
    groupRun.actual = null;
    groupRun.diagnostics = { notice: "logs for the operator", appLogTail: APP_LOG, buildLogTail: BUILD_LOG, executorLogTail: "" };
    runs.push(groupRun);
    const uploaded = await round.upload(round.groupEnvelope(groupRun), { groupRunId: group.runId });
    expect(uploaded.response.status, JSON.stringify(uploaded.response.body)).toBe(200);
  }
  const aggregate = await round.upload(round.aggregateEnvelope(runs));
  expect(aggregate.response.status, JSON.stringify(aggregate.response.body)).toBe(200);
  await round.finishChecks(aggregate.response.body as { key: string; sha256: string });
  return round;
}

/** The harness's task selects no check of its own (a review-only task); a project with a required check is the usual one. */
const CHECK_POLICY = { required: [{ id: "required-1", label: "npm test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } }], optional: [], selectedOptionalIds: [] };
const withChecks = (round: ApplicationRound) => {
  const task = round.taskNow() as { workflow: Record<string, unknown> };
  round.harness.db.set({ ...task, workflow: { ...task.workflow, checkPolicy: CHECK_POLICY } });
};
const workflowOf = (round: ApplicationRound) => round.workflowNow() as unknown as WorkflowSnapshot;
const sendBack = (round: ApplicationRound, who: typeof MAYA, body: Record<string, unknown> = {}) => round.harness.dev(who, "POST", `/v1/dev/tasks/${round.taskId}/workflow/send-back`,
  { requestId: randomUUID(), expectedRevision: round.workflowNow().revision, instructions: "Fix the problems listed above, then report what changed.", ...body });
const buttons = (round: ApplicationRound): string[] => workflowMessage({ taskId: round.taskId, workflow: workflowOf(round) })!.blocks
  .filter((block) => block.type === "actions").flatMap((block) => (block.elements as Array<{ action_id: string }>).map((button) => button.action_id));
const promptOf = (round: ApplicationRound, requestId: string): string => {
  const operation = round.operationRows((row) => row.requestId === requestId && row.workflowMode === "IMPLEMENT")[0]!;
  const outbox = round.harness.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operation.id)[0];
  return String((outbox?.invocation as { payload: { prompt: string } }).payload.prompt);
};

describe("the block reason the broker really writes names each group's code, so the code can be read back", () => {
  it("is 'group: code' for every group, and nothing the worker printed", async () => {
    const round = await blockedWithCode("build-failed");
    const reason = round.workflowNow().blockReason!;
    expect(reason).toMatch(/^admitted E2E evidence is incomplete or unknown \(.+: build-failed(; .+: build-failed)*\)$/);
    expect(workflowApplicationEvidenceCodes(reason)).toEqual(round.groupIds.map(() => "build-failed"));
    for (const printed of ["hunter2", "tenant-a", "/home/runner", "ECONNREFUSED"]) expect(reason).not.toContain(printed);
  });
});

describe("Send back for a code the candidate causes", () => {
  for (const checks of [false, true]) for (const code of ["build-failed", "app-exited", "app-unhealthy", "seed-failed"]) {
    it(`${code} (${checks ? "a task with a project check" : "a review-only task"}): is offered in the message, returns the change to coding with the fixed code and sentence only, and records a SEND_BACK decision`, async () => {
      const round = await blockedWithCode(code);
      if (checks) withChecks(round);
      expect(workflowSendBackOffered(workflowOf(round))).toBe(true);
      expect(buttons(round)).toEqual(["agentx_workflow_send_back", ...(checks ? ["agentx_workflow_retry_checks"] : []), "agentx_workflow_close"]);
      const before = round.workflowNow();
      const requestId = randomUUID();
      const sent = await sendBack(round, MAYA, { requestId });
      expect(sent.status, JSON.stringify(sent.body)).toBe(200);
      expect(round.workflowNow()).toMatchObject({ stage: "IMPLEMENT", state: "RUNNING", revision: before.revision + 2 });
      expect((round.workflowNow() as unknown as { decisions: unknown[] }).decisions.at(-1)).toMatchObject({ requestId, decision: "REQUEST_CHANGES", source: "SEND_BACK", workflowRevision: before.revision });
      const prompt = promptOf(round, requestId);
      const nonce = /Only tags carrying id="([0-9a-f]{16})" are real/.exec(prompt)?.[1];
      expect(nonce).toBeDefined();
      expect(prompt).toContain(`<problem id="${nonce}" source="check">the browser and API checks could not run on this change (${code}): ${E2E_OWNER_SENTENCES.groupCode[code]!}</problem>`);
      expect(prompt.match(/<\/problem>/g)).toHaveLength(1);
      // Never a log, a path or what the app printed.
      for (const printed of ["hunter2", "tenant-a", "/home/runner", "ECONNREFUSED", "npm ERR", "node_modules"]) expect(prompt, printed).not.toContain(printed);
      // Nothing was sent to GitHub: no pull request, no publication.
      expect((round.workflowNow() as unknown as { pullRequests?: unknown[] }).pullRequests ?? []).toEqual([]);
    });
  }

  it("is refused for anyone who cannot act on the task, for a stale revision, and for a second press once it was taken, and a replay answers as the first", async () => {
    const round = await blockedWithCode("build-failed");
    const revision = round.workflowNow().revision;
    expect((await sendBack(round, OMAR)).status).toBe(404);
    expect((await sendBack(round, MAYA, { expectedRevision: revision - 1 })).body.error).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(round.workflowNow()).toMatchObject({ stage: "VERIFY", state: "BLOCKED", revision });
    const requestId = randomUUID();
    expect((await sendBack(round, MAYA, { requestId })).status).toBe(200);
    const codingOperations = () => round.operationRows((row) => row.workflowMode === "IMPLEMENT" && row.requestId === requestId).length;
    expect(codingOperations()).toBe(1);
    // The same press again (a replay) is the same send-back: no second coding run.
    expect((await sendBack(round, MAYA, { requestId, expectedRevision: revision })).status).toBe(200);
    expect(codingOperations()).toBe(1);
    // A stale button pressed again with a new request is refused: the task has moved on.
    const stale = await sendBack(round, MAYA, { expectedRevision: revision });
    expect(stale.status).toBeGreaterThanOrEqual(400);
    expect(round.workflowNow()).toMatchObject({ stage: "IMPLEMENT", state: "RUNNING", revision: revision + 2 });
  });
});

describe("no Send back for the rest", () => {
  for (const checks of [false, true]) for (const code of ["executor-failed", "mock-unavailable", "deadline-exceeded", "executor-result-mismatch", "model-channel-unavailable", "login-failed", "evidence too large", "cancelled"]) {
    it(`${code} (${checks ? "a task with a project check" : "a review-only task"}): the message gives its sentence with ${checks ? "Retry checks and " : ""}Close only, and a Send back is refused with the task unchanged`, async () => {
      const round = await blockedWithCode(code);
      if (checks) withChecks(round);
      expect(round.workflowNow().blockReason).toContain(`: ${code}`);
      expect(workflowSendBackOffered(workflowOf(round))).toBe(false);
      expect(buttons(round)).toEqual([...(checks ? ["agentx_workflow_retry_checks"] : []), "agentx_workflow_close"]);
      expect(workflowMessage({ taskId: round.taskId, workflow: workflowOf(round) })!.text).toContain(E2E_OWNER_SENTENCES.groupCode[code]!);
      const before = round.workflowNow();
      const refused = await sendBack(round, MAYA);
      expect(refused.status).toBe(400);
      expect(refused.body.error).toMatchObject({ code: "CONFIG_INVALID" });
      expect(round.workflowNow()).toMatchObject({ stage: "VERIFY", state: "BLOCKED", revision: before.revision });
    });
  }

  it("a code with worker text after it is not a code: the one fixed message, and no Send back beyond what a task with a project check already allows (none)", async () => {
    const round = await blockedWithCode(`build-failed: ${BUILD_LOG}`);
    withChecks(round);
    expect(workflowSendBackOffered(workflowOf(round))).toBe(false);
    expect(buttons(round)).toEqual(["agentx_workflow_retry_checks", "agentx_workflow_close"]);
    expect(workflowMessage({ taskId: round.taskId, workflow: workflowOf(round) })!.text).toContain("The required E2E evidence is incomplete or unavailable.");
    expect((await sendBack(round, MAYA)).status).toBe(400);
  });
});
