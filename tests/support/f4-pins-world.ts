// F4-0 pinning tests: a REVIEW step on the task-flow harness, with a REAL hosted Admission (real holds on the company's day row) and a REAL second review service over it, so a test can say
// "this hold was released, or was not" from the money rows, not from a fake's own bookkeeping. The world is one hosted-shaped company (never the implicit laptop company: the hosted Admission refuses it).
import { randomUUID } from "node:crypto";
import {
  change, WorkflowSnapshotSchema, createCandidateManifest, createWorkflowSnapshot, secondReviewModelKey,
  type AuditEvent, type MeterEntry, type OrgId, type WorkflowSnapshot,
} from "@agentx/contracts";
import { createLocalOwnerApprovers, localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createHostedAdmission, createHostedHoldSweep, createHostedLedger } from "../../packages/broker/src/core-host/hosted-modules.js";
import { companyDayKey, utcDayOf } from "../../packages/broker/src/core/cost/ledger.js";
import { holdStateOf } from "../../packages/broker/src/core/cost/holds.js";
import { recordReviewed } from "../../packages/broker/src/core/build-step/results.js";
import { startReview } from "../../packages/broker/src/core/build-step/start.js";
import { developerCharge, taskKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { readTask, workspaceOperations } from "../../packages/broker/src/core/task-flow/reads.js";
import type { OperationRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { createSecondReview, secondReviewReplayKey, secondReviewVerdictKey, type SecondReview } from "../../packages/broker/src/core/second-review/index.js";
import { COMPANY_A_ID } from "../../packages/testing/src/isolation/two-company.js";
import { closeRecoveryHarness } from "./close-recovery-harness.js";
import { createHarness, type Harness } from "./task-flow-harness.js";
import { recordingAudit } from "./second-review-world.js";
import { GPT, SONNET, plain, replayRun, verdictFor } from "./second-review-world.js";

export const COMPANY = COMPANY_A_ID as OrgId;
export const TASK_ID = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
export const WORKSPACE_ID = "0f1d2c3b-4a59-4687-8695-a4b3c2d1e0f9";
const NOW = "2026-11-09T10:00:00.000Z";
export const CODE = createCandidateManifest([{ repositoryId: "demo", commitSha: "1".repeat(40), treeSha: "1".repeat(40), baseCommitSha: "e".repeat(40) }]);
export const SECOND_ALIAS = `${GPT.provider}/${GPT.modelId}`;

export const workflowAt = (extra: Record<string, unknown> = {}): WorkflowSnapshot => WorkflowSnapshotSchema.parse({
  ...createWorkflowSnapshot({ taskId: TASK_ID, ownerId: "a".repeat(64), now: NOW, definitionVersion: "1.1.0" }),
  stage: "REVIEW", state: "WAITING", candidate: CODE,
  checkPolicy: { required: [{ id: "unit", label: "Unit", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } }], optional: [], selectedOptionalIds: [], proposed: [] },
  verification: { candidateDigest: CODE.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: NOW, results: [{ checkId: "unit", status: "PASS" }] },
  ...extra,
});

/** A hosted Admission over the harness store, and what a test reads of its holds: the state of one reservation, the day's net reserved dollars, and one pass of the admission's own hold sweep. */
export function hostedHolds(h: Pick<Harness, "store" | "clock">, companyId: OrgId = COMPANY) {
  const now = () => new Date(h.clock.now);
  const metering = { async price() { return null; }, async record(e: MeterEntry) { return { cost: { micros: e.usage.tokens.input, currency: "USD" }, source: "price-table" as const }; } };
  const ledger = createHostedLedger({ store: h.store, metering, now });
  const admission = createHostedAdmission({ store: h.store, ledger, now, settings: { taskCapMicros: 5_000_000, companyDayCapMicros: 25_000_000 }, runStopWired: true });
  const sweep = createHostedHoldSweep({ store: h.store, companyId, now });
  return {
    admission, ledger,
    stateOf: async (reservationId: string | undefined) => (await holdStateOf(h.store, reservationId))?.state,
    /** What the company's day has reserved right now, in micros (0 when every hold is closed). */
    reserved: async (): Promise<number> => Number((await h.store.get(companyDayKey(companyId, utcDayOf(now()))))?.["reservedMicros"] ?? 0),
    /** The day row as stored: a repeated release or a second sweep pass must leave it byte for byte the same. */
    dayRow: async () => JSON.stringify((await h.store.get(companyDayKey(companyId, utcDayOf(now())))) ?? null),
    sweepOnce: async () => await sweep.pass({ budgetMs: 5_000 }),
    /** A hold as a second review (or anything else of model.call kind) takes it. */
    async take(taskId: string = TASK_ID): Promise<string> {
      const decision = await admission.admit({ companyId, idempotencyKey: `f4-pins:${randomUUID()}`, action: "model.call", projectName: "payments", subject: { type: "task", id: taskId }, estimate: { cost: { micros: 400_000, currency: "USD" } } });
      if (!decision.allowed || decision.reservationId === undefined) throw new Error("the test hold was not taken");
      return decision.reservationId;
    },
  };
}

/** The second review's own services over this store: the same seams as `second-review-world`, for the hosted-shaped company. */
export function secondReviewFor(h: Pick<Harness, "store" | "clock">, admission: Parameters<typeof createSecondReview>[0]["admission"], logs: Array<Record<string, unknown>> = [], audit: AuditEvent[] = []): SecondReview {
  const sources = [SONNET, GPT];
  return createSecondReview({
    store: h.store, companyId: COMPANY, audit: recordingAudit(audit, true), approvers: createLocalOwnerApprovers(), admission,
    seams: {
      sources: async () => sources,
      route: async (model) => ({ workerRoute: { alias: `${model.provider}/${model.modelId}`, api: "openai-responses", catalog: model.modelId }, alias: `${model.provider}/${model.modelId}` }),
      taskModels: async () => ({ builds: [SONNET], firstReviewer: SONNET }),
      price: () => ({ inputUsdPerMTok: 3, outputUsdPerMTok: 15 }),
      projectExists: async (project) => project === "payments",
    },
    now: () => h.clock.now, log: (entry) => logs.push(entry),
  });
}

export const OWNER = localOwnerPrincipal({ companyId: COMPANY });

export interface ReviewWorld { h: Harness; money: ReturnType<typeof hostedHolds>; review: SecondReview; logs: Array<Record<string, unknown>> }

/** A task waiting for its reviews (workspace ready), the flow's Admission and the second review's both the hosted one, and the second review in `on` mode choosing a model of another company. */
export async function reviewWorld(options: { mode?: "on" | "off" } = {}): Promise<ReviewWorld> {
  const h = createHarness({ audit: "recording", companyId: COMPANY });
  await h.registerProject();
  const money = hostedHolds(h);
  h.deps.admission = money.admission;
  const logs: Array<Record<string, unknown>> = [];
  const review = secondReviewFor(h, money.admission, logs);
  h.deps.secondReview = review;
  await h.store.put({ item: {
    ...taskKey(TASK_ID), entityType: "DEVELOPER_TASK", taskId: TASK_ID, companyId: COMPANY, developerId: "local-owner", provider: "local-owner", developerName: "Local owner", client: "test", project: "payments", title: "Add a retry flag",
    workspaceId: WORKSPACE_ID, ownerKey: "local-owner", conversationId: randomUUID(), startingRevision: 1, charge: plain(developerCharge({ companyId: COMPANY, developerId: "local-owner" })), shared: false, createdAt: NOW, updatedAt: NOW, workflow: plain(workflowAt()),
  } });
  await h.store.put({ item: { ...workspaceKey(COMPANY, WORKSPACE_ID), entityType: "WORKSPACE", id: WORKSPACE_ID, companyId: COMPANY, orgId: COMPANY, ownerKey: "local-owner", projectName: "payments", projectRevision: 1, status: "READY", activeOperationId: null, fence: 1,
    workspaceProject: "payments", workspaceCreatedAt: NOW, createdAt: NOW, updatedAt: NOW } });
  if (options.mode !== "off") {
    await review.apply(OWNER, { action: "choose", primary: GPT });
    await h.store.put({ item: { ...secondReviewReplayKey(COMPANY, "run-1"), entityType: "SECOND_REVIEW_REPLAY", run: plain(replayRun(GPT)) } });
    await h.store.put({ item: { ...secondReviewVerdictKey(COMPANY, secondReviewModelKey(GPT)), entityType: "SECOND_REVIEW_VERDICT", verdict: plain(verdictFor(GPT)) } });
    await review.apply(OWNER, { action: "mode", scope: "company", mode: "on" });
  }
  return { h, money, review, logs };
}

/** The REVIEW step starts, as the dispatch row would start it; returns the result and the operation it made. */
export async function startReviewStep(h: Harness): Promise<{ result: Awaited<ReturnType<typeof startReview>>; operation: OperationRecord | undefined }> {
  const row = { taskId: TASK_ID, workflowRevision: (await readTask(h.deps, TASK_ID))!.workflow!.revision };
  const result = await startReview(h.deps, row);
  const [operation] = (await workspaceOperations(h.deps, WORKSPACE_ID)).filter((entry) => entry.workflowMode === "REVIEW");
  return { result, operation };
}

const review = (role: "CRITIC" | "SECURITY", operationId: string) => ({ operationId, candidateDigest: CODE.digest, role, provider: "first-co", version: "first-v1", status: "PASS", findings: [], readOnly: true, recordedAt: NOW });

/** The REVIEW operation ends with two passing first reviews (and any extra result keys), through the review step's own result handler. */
export async function endReview(h: Harness, operation: OperationRecord, result: Record<string, unknown> = {}) {
  const task = (await readTask(h.deps, TASK_ID))!;
  const body = { workflowCandidateRepositories: CODE.repositories, workflowReviews: [review("CRITIC", operation.id), review("SECURITY", operation.id)], ...result };
  await recordReviewed(h.deps, task, operation, { status: "SUCCEEDED", outcome: { kind: "reviewed", result: body } as never });
  return (await readTask(h.deps, TASK_ID))!;
}

/**
 * The close-recovery harness (a task with a retained run) where the run carries a second review's plan with a REAL reservation on the hosted Admission. The accepted close is held back (`resumeAcceptedClose` does nothing)
 * so the test decides when close recovery runs (`w.restart(); await w.pump()`).
 */
export async function closeWithRunHold() {
  const w = await closeRecoveryHarness({ money: true });
  const money = hostedHolds(w.h);
  const reservationId = await money.take(w.task.taskId);
  await w.h.store.update({ key: w.runKey, ops: [change.set("secondReviewPlan", { candidateDigest: "c".repeat(64), reservationId })] });
  w.h.deps.resumeAcceptedClose = async () => {};
  return { w, money, reservationId };
}

/** The store fails the transaction that accepts the step (the one that puts the OPERATION row) and no other: the hold taken before it is the admission's own write, which goes through. Returns what puts it back. */
export function failAcceptingTheStep(h: Pick<Harness, "store">, error: Error = new Error("store down")): () => void {
  const transact = h.store.transact.bind(h.store);
  h.store.transact = async (items) => {
    if (items.some((item) => item.kind === "put" && item.item["entityType"] === "OPERATION")) throw error;
    return transact(items);
  };
  return () => { h.store.transact = transact; };
}
