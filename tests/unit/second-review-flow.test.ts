// The second review inside the task flow (the key rules), on the W0 fakes: the REVIEW start asks the service and records a plan on the operation and a `workflowSecondReviewer` field
// on the job; the REVIEW end stores the opinion beside the workflow, never in it.
//   1. A second review's result never clears or fails a first review.
//   2. Shadow never blocks, never delays and never reaches the pull request.
//   3. `on` blocks like findings do, in the SAME write as the workflow's own transition.
//   4. Unavailable is flagged and never blocks; `on` asks the owner to acknowledge before merge.
//   5. With the feature off, today's flow exactly.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SECOND_REVIEW_RESULT_KEY, WorkflowSnapshotSchema, workflowRequestId, createCandidateManifest, createWorkflowSnapshot, secondReviewModelKey, workflowFindingFingerprint,
  type SecondOpinion, type WorkflowReviewReport, type WorkflowSnapshot,
} from "@agentx/contracts";
import { ROUTE_PROVIDER } from "@agentx/model-runtime/catalog";
import { recordReviewed } from "../../packages/broker/src/core/build-step/results.js";
import { startReview } from "../../packages/broker/src/core/build-step/start.js";
import { workflowPullRequestBody } from "../../packages/broker/src/core/proof/workflow-pull-request-body.js";
import { closeTask } from "../../packages/broker/src/core/task-flow/close.js";
import { recordOperationResult } from "../../packages/broker/src/core/task-flow/results.js";
import { developerCharge, operationKey, operationRequestKey, taskKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { readTask, workspaceOperations } from "../../packages/broker/src/core/task-flow/reads.js";
import type { OperationRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { createHarness, COMPANY, type Harness } from "../support/task-flow-harness.js";
import { GPT, OWNER, SONNET, createWorld, type SecondReviewWorld, plain } from "../support/second-review-world.js";

const NOW = "2026-11-10T10:00:00.000Z";
const taskId = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const workspaceId = "0f1d2c3b-4a59-4687-8695-a4b3c2d1e0f9";
const code = createCandidateManifest([{ repositoryId: "demo", commitSha: "1".repeat(40), treeSha: "1".repeat(40), baseCommitSha: "e".repeat(40) }]);
const ALIAS = `${GPT.provider}/${GPT.modelId}`;

function workflowAt(extra: Record<string, unknown> = {}): WorkflowSnapshot {
  return WorkflowSnapshotSchema.parse({
    ...createWorkflowSnapshot({ taskId, ownerId: "a".repeat(64), now: NOW, definitionVersion: "1.1.0" }),
    stage: "REVIEW", state: "WAITING", candidate: code,
    checkPolicy: { required: [{ id: "unit", label: "Unit", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } }], optional: [], selectedOptionalIds: [], proposed: [] },
    verification: { candidateDigest: code.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: NOW, results: [{ checkId: "unit", status: "PASS" }] },
    ...extra,
  });
}

/** A task waiting for its reviews, its workspace ready, and a world whose second review is `mode`. */
async function seeded(mode: "off" | "shadow" | "on", options: { world?: Parameters<typeof createWorld>[0]; secondReviewOn?: boolean } = {}): Promise<{ h: Harness; world: SecondReviewWorld }> {
  const h = createHarness({ audit: "recording" });
  await h.registerProject();
  const world = createWorld({ ...options.world, store: h.store as never });
  if (options.secondReviewOn !== false) h.deps.secondReview = world.review;
  const workflow = workflowAt();
  await h.store.put({ item: {
    ...taskKey(taskId), entityType: "DEVELOPER_TASK", taskId, companyId: COMPANY, developerId: "local-owner", provider: "local-owner", developerName: "Local owner", client: "test", project: "payments", title: "Add a retry flag",
    workspaceId, ownerKey: "local-owner", conversationId: randomUUID(), startingRevision: 1, charge: plain(developerCharge({ companyId: COMPANY, developerId: "local-owner" })), shared: false, createdAt: NOW, updatedAt: NOW, workflow: plain(workflow),
  } });
  await h.store.put({ item: { ...workspaceKey(workspaceId), entityType: "WORKSPACE", id: workspaceId, companyId: COMPANY, orgId: COMPANY, ownerKey: "local-owner", projectName: "payments", projectRevision: 1, status: "READY", activeOperationId: null, fence: 1,
    workspaceProject: "payments", workspaceCreatedAt: NOW, createdAt: NOW, updatedAt: NOW } });
  if (mode !== "off") {
    await world.review.apply(OWNER, { action: "choose", primary: GPT });
    if (mode === "on") await world.seedHoldingEvidence(GPT);
    await world.review.apply(OWNER, { action: "mode", scope: "company", mode });
  }
  return { h, world };
}

/** The REVIEW step starts, as the dispatch row would start it; returns the operation it made. */
async function started(h: Harness): Promise<OperationRecord> {
  const row = { taskId, workflowRevision: (await readTask(h.deps, taskId))!.workflow!.revision };
  expect(await startReview(h.deps, row)).toBe("STARTED");
  const [operation] = (await workspaceOperations(h.deps, workspaceId)).filter((entry) => entry.workflowMode === "REVIEW");
  return operation!;
}

const review = (role: "CRITIC" | "SECURITY", operationId: string, more: Record<string, unknown> = {}) => ({
  operationId, candidateDigest: code.digest, role, provider: "first-co", version: "first-v1", status: "PASS", findings: [], readOnly: true, recordedAt: NOW, ...more,
});
const BLOCKING = { text: "off by one in the loop bound", origin: "INTRODUCED" as const };
const secondReport = (operationId: string, status: WorkflowReviewReport["status"], findings: WorkflowReviewReport["findings"] = [], over: Partial<WorkflowReviewReport> = {}): WorkflowReviewReport => ({
  operationId, candidateDigest: code.digest, role: "CRITIC", provider: ROUTE_PROVIDER, version: ALIAS, status, findings, readOnly: true, recordedAt: NOW, ...over,
});

/** The REVIEW operation ends with these reviews (and, optionally, the second reviewer's result). */
async function ends(h: Harness, operation: OperationRecord, input: { first?: [string, string]; second?: unknown; ended?: "SUCCEEDED" | "FAILED" } = {}) {
  const [critic, security] = input.first ?? ["PASS", "PASS"];
  const result: Record<string, unknown> = {
    workflowCandidateRepositories: code.repositories,
    workflowReviews: [
      review("CRITIC", operation.id, { status: critic, findings: critic === "FINDINGS" ? [{ text: "first reviewer: missing null check", origin: "INTRODUCED" }] : [] }),
      review("SECURITY", operation.id, { status: security }),
    ],
  };
  if (input.second !== undefined) result[SECOND_REVIEW_RESULT_KEY] = typeof input.second === "function" ? (input.second as (id: string) => unknown)(operation.id) : input.second;
  const task = (await readTask(h.deps, taskId))!;
  await recordReviewed(h.deps, task, operation, { status: input.ended ?? "SUCCEEDED", outcome: { kind: "reviewed", result } as never });
  return (await readTask(h.deps, taskId))! as unknown as { workflow: WorkflowSnapshot; secondOpinion?: { candidateDigest: string; opinion: SecondOpinion }; secondReviewAcknowledged?: string[] };
}
const answer = (status: WorkflowReviewReport["status"], findings: WorkflowReviewReport["findings"] = []) => (id: string) => ({ tries: 1, report: secondReport(id, status, findings) });

describe("the REVIEW start", () => {
  it("with the mode off, the job and the operation are exactly today's", async () => {
    const { h } = await seeded("off");
    const operation = await started(h);
    expect(operation).not.toHaveProperty("secondReviewPlan");
    expect(operation.dispatch.payload).not.toHaveProperty("workflowSecondReviewer");
  });

  it("with shadow on, the job carries the second reviewer (a model of another company, through its own route) and the operation records the plan", async () => {
    const { h } = await seeded("shadow");
    const operation = await started(h);
    expect(operation.dispatch.payload["workflowSecondReviewer"]).toEqual({ candidates: [{ model: GPT, modelRoute: { alias: ALIAS, api: "openai-responses", catalog: GPT.modelId } }] });
    expect(operation.secondReviewPlan).toMatchObject({
      candidateDigest: code.digest, plan: { mode: "shadow", company: "openai", model: GPT, choice: "company", against: [SONNET] }, aliases: [ALIAS], routeAliases: { [secondReviewModelKey(GPT)]: ALIAS },
    });
    // The first review is what it was: both roles, no extra operation or row.
    expect(operation.dispatch.payload["workflowMode"]).toBe("REVIEW");
    expect((await workspaceOperations(h.deps, workspaceId)).filter((entry) => entry.workflowMode === "REVIEW")).toHaveLength(1);
  });

  it("with no model of another company the review starts and, in shadow, says nothing; `on` flags it", async () => {
    const shadow = await seeded("shadow", { world: { sources: [SONNET, GPT] } });
    shadow.world.seams.sources = async () => [SONNET];
    const quiet = await started(shadow.h);
    // The reason is recorded (shadow never shows it): the choice no longer qualifies, so nothing runs.
    expect(quiet.dispatch.payload).not.toHaveProperty("workflowSecondReviewer");
    expect(quiet.secondReviewPlan).toMatchObject({ notRun: { mode: "shadow", reason: "choice-not-qualifying" } });
    const on = await seeded("on", { world: { routable: (model) => model.provider === "anthropic" || model.provider === "openai" } });
    on.world.seams.route = async () => undefined;
    const flagged = await started(on.h);
    expect(flagged.dispatch.payload).not.toHaveProperty("workflowSecondReviewer");
    expect(flagged.secondReviewPlan).toMatchObject({ notRun: { mode: "on", reason: "no-candidate" } });
  });

  it("a refused admission is `budget`; an error while planning never fails the dispatch", async () => {
    const refused = await seeded("on", { world: { admission: { async admit() { return { allowed: false, code: "budget_exhausted", message: "spent" }; }, async stage() { return { decision: { allowed: false, code: "x", message: "y" }, items: [] }; }, async settle() {}, async release() {} } } });
    expect((await started(refused.h)).secondReviewPlan).toMatchObject({ notRun: { mode: "on", reason: "budget" } });
    const broken = await seeded("on");
    broken.world.seams.taskModels = async () => { throw Object.assign(new Error("secret detail"), { name: "SourcesDown" }); };
    const operation = await started(broken.h);
    expect(operation.secondReviewPlan).toMatchObject({ notRun: { mode: "on", reason: "no-candidate" } });
    expect(JSON.stringify(broken.world.logs)).toContain("SourcesDown");
    expect(JSON.stringify(broken.world.logs)).not.toContain("secret detail");
    const shadowBroken = await seeded("shadow");
    shadowBroken.world.seams.taskModels = async () => { throw new Error("down"); };
    expect(await started(shadowBroken.h)).not.toHaveProperty("secondReviewPlan");
  });

  it("by default the payload has no context (the second reviewer sees only the change); same_as_first says so on the wire", async () => {
    const { h, world } = await seeded("shadow");
    await world.review.apply(OWNER, { action: "context", context: "same_as_first" });
    expect((await started(h)).dispatch.payload["workflowSecondReviewer"]).toMatchObject({ context: "same_as_first" });
  });

  it("an unplanned flow with no service wired is untouched", async () => {
    const { h } = await seeded("off", { secondReviewOn: false });
    expect((await started(h)).dispatch.payload).not.toHaveProperty("workflowSecondReviewer");
  });
});

describe("key rule 1: a second review never clears or fails a first review", () => {
  it("a second-review PASS never clears a first-review FINDINGS; the second report is not among the workflow's reviews", async () => {
    const { h } = await seeded("on");
    const operation = await started(h);
    const task = await ends(h, operation, { first: ["FINDINGS", "PASS"], second: answer("PASS") });
    // The first review's findings send the code back to coding (Rovara's own fix); a second-review PASS did not clear them.
    expect(task.workflow).toMatchObject({ stage: "IMPLEMENT" });
    expect(task.workflow.stage).not.toBe("PULL_REQUEST");
    expect(task.workflow.reviews?.map((entry) => entry.role).sort() ?? ["CRITIC", "SECURITY"]).toEqual(["CRITIC", "SECURITY"]);
    expect(JSON.stringify(task.workflow)).not.toContain(ALIAS);
    expect(task.secondOpinion?.opinion).toMatchObject({ mode: "on", blocked: false, unavailable: false });
  });
});

describe("key rule 2: shadow never blocks, never delays and never reaches the pull request", () => {
  it("a shadow opinion with blocking findings leaves the passing reviews passing, with the pull request due, and the opinion is stored beside the workflow", async () => {
    const { h, world: w } = await seeded("shadow");
    const operation = await started(h);
    const task = await ends(h, operation, { second: answer("FINDINGS", [BLOCKING]) });
    expect(task.workflow).toMatchObject({ stage: "PULL_REQUEST", state: "READY" });
    expect(task.workflow).not.toHaveProperty("secondReviewBlock");
    expect(task.secondOpinion).toMatchObject({ candidateDigest: code.digest, opinion: { mode: "shadow", blocked: false, wouldHaveBlocked: true, blockingCount: 1, choice: "company" } });
    // The row of the step that follows is the publication, as for any passing review.
    const rows = await h.store.query({ pk: `ORG#${COMPANY}#WORKFLOW_DISPATCH`, sk: { op: "beginsWith", prefix: `${taskId}#` } });
    expect(rows.items.map((row) => row["kind"])).toContain("PUBLISH");
    // Never on the pull request, with or without the service.
    expect(w.review.prLines(task, code.digest, [])).toEqual([]);
  });

  it("a shadow review that could not run is silent and changes nothing", async () => {
    const { h, world: w } = await seeded("shadow");
    const operation = await started(h);
    const task = await ends(h, operation, { second: { tries: 3 } });
    expect(task.workflow).toMatchObject({ stage: "PULL_REQUEST", state: "READY" });
    expect(task.secondOpinion?.opinion).toMatchObject({ unavailable: true, unavailableReason: "no-answer" });
    expect(h.deps.secondReview!.mergeWait(task as never)).toBeUndefined();
    expect(w.review.taskView(task as never, code.digest)).toBeUndefined();
  });
});

describe("key rule 3: `on` blocks, in the same write as the workflow's transition", () => {
  it("blocks the passing reviews with the second review's findings kept IN the workflow, and starts no publication", async () => {
    const { h, world: w } = await seeded("on");
    const operation = await started(h);
    const task = await ends(h, operation, { second: answer("FINDINGS", [BLOCKING]) });
    // The first reviews passed, so the second review's blocking findings move the task as findings do (Rovara's own send back to coding), and the block is kept IN the workflow.
    expect(task.workflow).toMatchObject({ stage: "IMPLEMENT", secondReviewBlock: { candidateDigest: code.digest, findings: [{ text: BLOCKING.text }] } });
    expect(task.secondOpinion?.opinion).toMatchObject({ mode: "on", blocked: true });
    const rows = await h.store.query({ pk: `ORG#${COMPANY}#WORKFLOW_DISPATCH`, sk: { op: "beginsWith", prefix: `${taskId}#` } });
    expect(rows.items.map((row) => row["kind"])).not.toContain("PUBLISH");
    // The pull request description says so (the blocking finding, made inert), and the page shows it.
    expect(w.review.prLines(task, code.digest, [])[0]).toContain("Second review (");
    expect(w.review.taskView(task as never, code.digest)).toMatchObject({ lines: [expect.stringContaining("Second review"), expect.stringContaining(BLOCKING.text), expect.stringContaining("Reviewed by")], needsAcknowledgement: false });
  });

  it("a finding the owner accepted as a risk for this code does not block, and the opinion says it would not have", async () => {
    const { h } = await seeded("on");
    const accepted = { candidateDigest: code.digest, role: "CRITIC", fingerprint: workflowFindingFingerprint("CRITIC", BLOCKING), text: BLOCKING.text, reason: "known, tracked elsewhere", actorId: "a".repeat(64), at: NOW };
    expect((await h.store.update({ key: taskKey(taskId), ops: [{ op: "set", path: ["workflow", "acceptedFindings"], value: [accepted] }] })).applied).toBe(true);
    const task = await ends(h, await started(h), { second: answer("FINDINGS", [BLOCKING]) });
    expect(task.workflow).toMatchObject({ stage: "PULL_REQUEST", state: "READY" });
    expect(task.secondOpinion?.opinion).toMatchObject({ blocked: false, wouldHaveBlocked: false });
  });

  it("a new review of the same code starts without the earlier block, and the opinion of earlier code is dropped when none is planned", async () => {
    const { h, world: w } = await seeded("on");
    const first = await ends(h, await started(h), { second: answer("FINDINGS", [BLOCKING]) });
    expect(first.workflow).toMatchObject({ secondReviewBlock: { candidateDigest: code.digest } });
    expect(first.secondOpinion).toBeDefined();
    // The owner turns the mode off, and the review of this code runs again (the step is waiting for it once more, still holding the earlier block and opinion).
    await w.review.apply(OWNER, { action: "mode", scope: "company", mode: "off" });
    const waiting = workflowAt({ secondReviewBlock: first.workflow.secondReviewBlock, revision: first.workflow.revision + 1 });
    expect((await h.store.update({ key: taskKey(taskId), ops: [{ op: "set", path: ["workflow"], value: plain(waiting) }] })).applied).toBe(true);
    expect((await h.store.update({ key: workspaceKey(workspaceId), ops: [{ op: "set", path: ["status"], value: "READY" }, { op: "set", path: ["activeOperationId"], value: null }] })).applied).toBe(true);
    expect(await startReview(h.deps, { taskId, workflowRevision: waiting.revision })).toBe("STARTED");
    const retry = (await workspaceOperations(h.deps, workspaceId)).filter((entry) => entry.workflowMode === "REVIEW").at(-1)!;
    expect(retry.secondReviewPlan).toBeUndefined();
    const task = await ends(h, retry);
    expect(task.workflow).toMatchObject({ stage: "PULL_REQUEST", state: "READY" });
    expect(task.workflow).not.toHaveProperty("secondReviewBlock");
    expect(task.secondOpinion).toBeUndefined();
  });
});

describe("key rule 4: unavailable is flagged and never blocks", () => {
  it("`on` with no answer: the reviews pass, the opinion says it did not run, and the merge waits for the owner's acknowledgement, once per code", async () => {
    const { h, world: w } = await seeded("on");
    const operation = await started(h);
    const task = await ends(h, operation, { second: { tries: 3 } });
    expect(task.workflow).toMatchObject({ stage: "PULL_REQUEST", state: "READY" });
    expect(task.secondOpinion?.opinion).toMatchObject({ mode: "on", unavailable: true, unavailableReason: "no-answer", blocked: false });
    const wait = h.deps.secondReview!.mergeWait(task);
    expect(wait).toContain("Second review did not run");
    expect(w.review.prLines(task, code.digest, [])).toEqual([expect.stringContaining("Second review did not run")]);
    const ask = w.review.acknowledgement(task)!;
    expect(ask.text).toContain("Acknowledge before merging");
    // The owner acknowledges: audited with the task's change, and the merge no longer waits.
    const result = await w.review.acknowledge(OWNER, task as never);
    expect(result).toMatchObject({ ok: true, already: false, key: ask.key });
    const after = (await readTask(h.deps, taskId))! as unknown as { secondReviewAcknowledged?: string[] };
    expect(after.secondReviewAcknowledged).toEqual([ask.key]);
    expect(h.deps.secondReview!.mergeWait(after as never)).toBeUndefined();
    expect(w.audit.map((event) => event.action)).toContain("task.second_review_acknowledged");
    expect(await w.review.acknowledge(OWNER, (await readTask(h.deps, taskId))! as never)).toMatchObject({ ok: true, already: true });
  });

  it("two acknowledgements at once: one is recorded, the other is told it is out of date, and the key is stored once", async () => {
    const { h, world: w } = await seeded("on");
    const task = await ends(h, await started(h), { second: { tries: 3 } });
    const [first, second] = await Promise.all([w.review.acknowledge(OWNER, task as never), w.review.acknowledge(OWNER, task as never)]);
    expect([first.ok, second.ok].sort()).toEqual([false, true]);
    expect([first, second].find((entry) => !entry.ok)).toEqual({ ok: false, reason: "stale" });
    const after = (await readTask(h.deps, taskId))! as unknown as { secondReviewAcknowledged?: string[] };
    expect(after.secondReviewAcknowledged).toHaveLength(1);
    // Only the committed one is in the ledger (the loser's event was staged in a transaction that did not commit).
    expect((await h.store.query({ pk: `AUDIT#${COMPANY}`, sk: { op: "beginsWith", prefix: "EVENT#task.second_review_acknowledged" } })).items).toHaveLength(1);
  });

  it("an acknowledgement is for the code it was asked about: if the candidate moved between the read and the write, nothing is recorded", async () => {
    const { h, world: w } = await seeded("on");
    const task = await ends(h, await started(h), { second: { tries: 3 } });
    // The task holds other code by the time the write is made (the read above is the old one).
    const moved = createCandidateManifest([{ repositoryId: "demo", commitSha: "2".repeat(40), treeSha: "2".repeat(40), baseCommitSha: "e".repeat(40) }]);
    expect((await h.store.update({ key: taskKey(taskId), ops: [{ op: "set", path: ["workflow", "candidate"], value: plain(moved) }] })).applied).toBe(true);
    expect(await w.review.acknowledge(OWNER, task as never)).toEqual({ ok: false, reason: "stale" });
    expect(((await readTask(h.deps, taskId))! as unknown as { secondReviewAcknowledged?: string[] }).secondReviewAcknowledged).toBeUndefined();
    // And the opinion moved off the digest asked about: the same refusal.
    expect((await h.store.update({ key: taskKey(taskId), ops: [{ op: "set", path: ["workflow", "candidate"], value: plain(task.workflow.candidate) }, { op: "set", path: ["secondOpinion", "candidateDigest"], value: "f".repeat(64) }] })).applied).toBe(true);
    expect(await w.review.acknowledge(OWNER, task as never)).toEqual({ ok: false, reason: "stale" });
  });

  it("an acknowledgement is refused when nothing records it: it is never written without its record", async () => {
    const { h, world: w } = await seeded("on", { world: { auditStages: false } });
    const task = await ends(h, await started(h), { second: { tries: 3 } });
    expect(await w.review.acknowledge(OWNER, task as never)).toEqual({ ok: false, reason: "audit_unavailable" });
    expect(((await readTask(h.deps, taskId))! as unknown as { secondReviewAcknowledged?: string[] }).secondReviewAcknowledged).toBeUndefined();
  });

  it("an older worker (a succeeded review with no second-review key) is flagged, never blocks, and is silent in shadow", async () => {
    const on = await seeded("on");
    const task = await ends(on.h, await started(on.h));
    expect(task.workflow).toMatchObject({ stage: "PULL_REQUEST", state: "READY" });
    expect(task.secondOpinion?.opinion).toMatchObject({ unavailable: true, unavailableReason: "older-worker" });
    const shadow = await seeded("shadow");
    const quiet = await ends(shadow.h, await started(shadow.h));
    expect(quiet.secondOpinion?.opinion).toMatchObject({ unavailable: true, mode: "shadow" });
    expect(shadow.h.deps.secondReview!.mergeWait(quiet as never)).toBeUndefined();
  });

  it("a report from another model, another candidate, another role or the builder's company is not accepted, and nothing blocks", async () => {
    for (const over of [{ version: "someone-else" }, { candidateDigest: "f".repeat(64) }, { role: "SECURITY" as const }]) {
      const { h } = await seeded("on");
      const task = await ends(h, await started(h), { second: (id: string) => ({ tries: 1, report: secondReport(id, "FINDINGS", [BLOCKING], over) }) });
      expect(task.workflow).toMatchObject({ stage: "PULL_REQUEST", state: "READY" });
      expect(task.secondOpinion?.opinion.blocked).toBe(false);
      expect(task.secondOpinion?.opinion.unavailable).toBe(true);
    }
  });

  it("acknowledging is refused for other code, for nothing to acknowledge, and for a feature that is off", async () => {
    const { h, world: w } = await seeded("on");
    const task = await ends(h, await started(h), { second: answer("PASS") });
    expect(await w.review.acknowledge(OWNER, task as never)).toEqual({ ok: false, reason: "not_required" });
    const off = createWorld({ enabled: () => false });
    expect(await off.review.acknowledge(OWNER, task as never)).toEqual({ ok: false, reason: "not_required" });
  });
});

describe("key rule 5: stop, crash and close need no new path", () => {
  it("a failed or stopped review ends as it always did: the same single transition, and no opinion is written", async () => {
    const { h } = await seeded("on");
    const operation = await started(h);
    const task = await ends(h, operation, { ended: "FAILED" });
    expect(task.workflow).toMatchObject({ stage: "REVIEW", state: "BLOCKED" });
    expect(task).not.toHaveProperty("secondOpinion");
  });
});

describe("key rule 6: with the feature off, today's flow exactly", () => {
  it("an install that has the service switched off plans nothing, records nothing and shows nothing", async () => {
    const { h } = await seeded("off", { world: { enabled: () => false } });
    const operation = await started(h);
    expect(operation).not.toHaveProperty("secondReviewPlan");
    const task = await ends(h, operation);
    expect(task).not.toHaveProperty("secondOpinion");
    expect(task.workflow).toMatchObject({ stage: "PULL_REQUEST", state: "READY" });
  });
});

describe("the pull request description", () => {
  const baseTask = { title: "Add a retry flag" } as never;
  const body = (lines: string[]) => workflowPullRequestBody(baseTask, workflowAt({ stage: "PULL_REQUEST", state: "READY", reviews: [review("CRITIC", randomUUID()), review("SECURITY", randomUUID())] }), "# Plan\n\n1. Add the flag.\n", "https://rovara.example/task", { secondReviewLines: lines });

  it("carries only the lines the service gives; with none it is byte for byte the same", () => {
    expect(body([])).toBe(workflowPullRequestBody(baseTask, workflowAt({ stage: "PULL_REQUEST", state: "READY", reviews: [review("CRITIC", randomUUID()), review("SECURITY", randomUUID())] }), "# Plan\n\n1. Add the flag.\n", "https://rovara.example/task", undefined).replace(/\n$/u, "\n"));
    expect(body(["Second review (openai/gpt-5.5): 1 blocking finding"])).toContain("Second review (openai/gpt-5.5): 1 blocking finding");
  });
});

// ---- the allowance an Admission adapter holds for a second review is given back on every path

/** An Admission that really holds: one reservation per key, a set of what is still held, and a note of every key asked for. */
function holdingAdmission(): { admission: NonNullable<Parameters<typeof createWorld>[0]>["admission"]; held: Set<string>; keys: string[] } {
  const byKey = new Map<string, string>();
  const held = new Set<string>();
  const keys: string[] = [];
  let count = 0;
  const admission = {
    async admit(request: { idempotencyKey: string }) {
      keys.push(request.idempotencyKey);
      let id = byKey.get(request.idempotencyKey);
      if (id === undefined) { id = `reservation-${String(++count)}`; byKey.set(request.idempotencyKey, id); held.add(id); }
      return { allowed: true as const, reservationId: id };
    },
    async stage() { return { decision: { allowed: true as const }, items: [] }; },
    async settle(id: string) { held.delete(id); },
    async release(id: string) { held.delete(id); },
  };
  return { admission: admission, held, keys };
}

describe("the allowance held for a second review", () => {
  const settle = (h: Harness, operation: OperationRecord, status: "SUCCEEDED" | "FAILED" | "INTERRUPTED" | "CANCELLED") =>
    recordOperationResult(h.deps, { workspaceId, operationId: operation.id, fence: operation.fence, status, ...(status === "SUCCEEDED" ? {} : { error: "stopped" }) });

  it("is held from the start to the operation's end, whatever the end: a result, a failure, a cancel, and the sweep that gives up on a worker", async () => {
    for (const status of ["SUCCEEDED", "FAILED", "INTERRUPTED", "CANCELLED"] as const) {
      const t = holdingAdmission();
      const { h } = await seeded("on", { world: { admission: t.admission } });
      const operation = await started(h);
      expect(t.held.size, `${status}: held while it runs`).toBe(1);
      if (status === "CANCELLED") await h.store.update({ key: operationKey(workspaceId, operation.id), ops: [{ op: "set", path: ["status"], value: "CANCEL_REQUESTED" }] });
      await settle(h, operation, status);
      expect(t.held.size, `${status}: given back at the end`).toBe(0);
    }
  });

  it("is given back when the task is closed while the review runs (the close ends the operation itself)", async () => {
    const t = holdingAdmission();
    const { h } = await seeded("on", { world: { admission: t.admission } });
    await started(h);
    expect(t.held.size).toBe(1);
    await closeTask(h.deps, h.owner, taskId);
    expect(t.held.size).toBe(0);
  });

  it("is given back when the models cannot be reached after it was asked for, and when no model has a route", async () => {
    const lookup = holdingAdmission();
    const down = await seeded("on", { world: { admission: lookup.admission } });
    down.world.seams.route = async () => { throw new Error("route lookup down"); };
    expect((await started(down.h)).secondReviewPlan).toMatchObject({ notRun: { mode: "on", reason: "no-candidate" } });
    expect(lookup.held.size).toBe(0);
    const none = holdingAdmission();
    const unrouted = await seeded("on", { world: { admission: none.admission } });
    unrouted.world.seams.route = async () => undefined;
    await started(unrouted.h);
    expect(none.held.size).toBe(0);
  });

  it("is given back when the step cannot be accepted: the start throws, or the task moved on", async () => {
    const thrown = holdingAdmission();
    const a = await seeded("on", { world: { admission: thrown.admission } });
    const accept = a.h.store.transact.bind(a.h.store);
    a.h.store.transact = async () => { throw new Error("store down"); };
    await expect(startReview(a.h.deps, { taskId, workflowRevision: (await readTask(a.h.deps, taskId))!.workflow!.revision })).rejects.toThrow("store down");
    a.h.store.transact = accept;
    expect(thrown.held.size).toBe(0);
    const stale = holdingAdmission();
    const b = await seeded("on", { world: { admission: stale.admission } });
    expect(await startReview(b.h.deps, { taskId, workflowRevision: 999 })).toBe("STALE");
    expect(stale.held.size).toBe(0);
  });

  it("is given back when the workspace is busy and the step waits (the start did not happen, the row will try again)", async () => {
    const t = holdingAdmission();
    const { h } = await seeded("on", { world: { admission: t.admission } });
    await h.store.update({ key: workspaceKey(workspaceId), ops: [{ op: "set", path: ["activeOperationId"], value: "someone-else" }] });
    expect(await startReview(h.deps, { taskId, workflowRevision: (await readTask(h.deps, taskId))!.workflow!.revision })).toBe("WAITING");
    expect(t.keys).toHaveLength(1);
    expect(t.held.size).toBe(0);
  });

  it("is given back when the step is refused as STALE (the person it runs for may no longer have it started) and when it is a DUPLICATE of a step already accepted", async () => {
    const refused = holdingAdmission();
    const a = await seeded("on", { world: { admission: refused.admission } });
    a.h.deps.access = { ...a.h.deps.access, async checkStep() { return { allowed: false, message: "no longer allowed" }; } };
    expect(await startReview(a.h.deps, { taskId, workflowRevision: (await readTask(a.h.deps, taskId))!.workflow!.revision })).toBe("STALE");
    expect(refused.keys).toHaveLength(1);
    expect(refused.held.size).toBe(0);
    const repeated = holdingAdmission();
    const b = await seeded("on", { world: { admission: repeated.admission } });
    const task = (await readTask(b.h.deps, taskId))!;
    // The request of this very step is already recorded: the start is the first one's duplicate.
    await b.h.store.put({ item: { ...operationRequestKey("local-owner", workspaceId, workflowRequestId("agentx-auto-review", taskId, task.workflow!.revision, code.digest)), entityType: "IDEMPOTENCY", operationId: "earlier", payloadHash: "x" } });
    expect(await startReview(b.h.deps, { taskId, workflowRevision: task.workflow!.revision })).toBe("DUPLICATE");
    expect(repeated.keys).toHaveLength(1);
    expect(repeated.held.size).toBe(0);
  });

  it("is asked for once per start, under a key of its own: two reviews of the same code never share a reservation", async () => {
    const t = holdingAdmission();
    const { h } = await seeded("on", { world: { admission: t.admission } });
    const first = await started(h);
    await settle(h, first, "FAILED");
    expect(t.held.size).toBe(0);
    // The same code reviewed again (the owner's Retry): a new reservation, held until that operation ends.
    const task = (await readTask(h.deps, taskId))!;
    const waiting = workflowAt({ revision: task.workflow!.revision + 1 });
    await h.store.update({ key: taskKey(taskId), ops: [{ op: "set", path: ["workflow"], value: plain(waiting) }] });
    const second = await started(h).then(async () => (await workspaceOperations(h.deps, workspaceId)).filter((entry) => entry.workflowMode === "REVIEW").at(-1)!);
    expect(t.keys).toHaveLength(2);
    expect(new Set(t.keys).size).toBe(2);
    expect(t.held.size).toBe(1);
    await settle(h, second, "SUCCEEDED");
    expect(t.held.size).toBe(0);
  });
});

describe("the proxy-seen answer, however the report names the model", () => {
  it("a report that names the planned model by its plain name, with no call seen on its route, is no answer and never blocks; with the call seen it counts", async () => {
    const { h } = await seeded("on");
    h.deps.modelCalls = () => new Set<string>();
    const plain_ = (id: string) => ({ tries: 1, report: secondReport(id, "FINDINGS", [BLOCKING], { provider: GPT.provider, version: GPT.modelId }) });
    const unseen = await ends(h, await started(h), { second: plain_ });
    expect(unseen.secondOpinion?.opinion).toMatchObject({ unavailable: true, unavailableReason: "no-answer", blocked: false });
    expect(unseen.workflow).toMatchObject({ stage: "PULL_REQUEST", state: "READY" });
    const seen = await seeded("on");
    seen.h.deps.modelCalls = () => new Set([ALIAS]);
    const counted = await ends(seen.h, await started(seen.h), { second: plain_ });
    expect(counted.secondOpinion?.opinion).toMatchObject({ unavailable: false, blocked: true });
  });

  it("a model with no route alias (called by its own name) is held to the same rule, by its provider/model alias", async () => {
    const plainReport = (id: string) => ({ tries: 1, report: secondReport(id, "FINDINGS", [BLOCKING], { provider: GPT.provider, version: GPT.modelId }) });
    const counted = await seeded("on");
    counted.world.seams.route = async () => ({});
    counted.h.deps.modelCalls = () => new Set([ALIAS]);
    const op = await started(counted.h);
    expect(op.secondReviewPlan?.routeAliases).toBeUndefined();
    expect((await ends(counted.h, op, { second: plainReport })).secondOpinion?.opinion).toMatchObject({ unavailable: false, blocked: true });
    const unseen = await seeded("on");
    unseen.world.seams.route = async () => ({});
    unseen.h.deps.modelCalls = () => new Set(["somewhere/else"]);
    expect((await ends(unseen.h, await started(unseen.h), { second: plainReport })).secondOpinion?.opinion).toMatchObject({ unavailable: true, unavailableReason: "no-answer" });
  });

  it("the route-alias report is held to the same rule, and a call on some other alias does not stand in for the planned one", async () => {
    const { h } = await seeded("on");
    h.deps.modelCalls = () => new Set(["anthropic/claude-sonnet-4-6"]);
    const task = await ends(h, await started(h), { second: answer("FINDINGS", [BLOCKING]) });
    expect(task.secondOpinion?.opinion).toMatchObject({ unavailable: true, unavailableReason: "no-answer" });
  });
});
