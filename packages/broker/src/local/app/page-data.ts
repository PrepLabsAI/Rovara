// Lane L9-wire: what the local review pages read (L8's `LocalPageData`) and the one write the task flow owns that the pages ask for (a comment on a plan), over the task flow's
// records. The pages know nothing of these records; this is the only place that does.
//
// Not wired yet (each answers "nothing there" so the page says so, rather than inventing a view): design reviews (the design review stage is not ported), lessons (the lessons store is
// lane L11's) and the proof report (slice 3: it reads the verification and the pull request the publish step records).
import { formatRunLimitUsd, type ObjectStorage } from "@agentx/contracts";
import { createHash, randomUUID } from "node:crypto";
import {
  queryAll, taskGraphDigest, when, type OrgId, type Principal, type WorkflowArtifact, type WorkflowSnapshot,
} from "@agentx/contracts";
import { CHANGED_OUTSIDE_NOTE, checkPullRequestHeads } from "../../core/build-step/head-check.js";
import { currentDocumentType, waitingDocumentDigest } from "../../core/decisions/workflow-subject.js";
import type { ApprovalOffer, AttentionView, CommentView, LocalActionResult, LocalPageActions, LocalPageData, PendingItemView, PlanPageView, PlanVersionView, ProofReportView } from "../../core/local-pages/views.js";
import type { TaskFlowDeps } from "../../core/task-flow/deps.js";
import { listTasks, readTask, workspaceOperations } from "../../core/task-flow/reads.js";
import { costLine, type CostLedger } from "../../core/cost/ledger.js";
import { fromDocument, type OperationRecord, type TaskRecord } from "../../core/task-flow/records.js";
import { iso } from "../../core/task-flow/support.js";
import { DOCUMENT_CHANGED, readVerifiedText } from "./documents.js";
import { textReaderOf } from "../../core/build-step/plan-input.js";
import { planEvidencePointer } from "../../core/plan/store.js";
import { loadPlanEvidence, loadWorkflowDocument } from "../../developer/plan-document-reader.js";
import { planOneScreen, planOneScreenText } from "../../developer/plan-one-screen.js";
import { loadPlanSelfCheck } from "../../developer/plan-self-check.js";
import { critiqueLines } from "../../rovara-code/critique-lines.js";
import type { LocalComments } from "./comments.js";
import type { LocalLessons } from "./lessons.js";
import type { LocalEvidence } from "./evidence.js";
import { reportedChangedFiles, verifiedChangedFiles } from "../../core/build-step/changed-files.js";
import { answerUnderstandQuestions } from "./answers.js";
import { attentionOf, retryableBlock } from "./attention.js";
import { createLocalSessionControl } from "./host.js";
import { NOTHING_TO_RETRY_STEP, retryBlockedStep } from "./retry.js";
import { stepOf } from "./facts.js";
import { loadDesignProof } from "../../core/design-review/design-proof.js";
import { designProofLine } from "../../core/design-review/proof-line.js";
import { designChoiceDigest } from "../../core/design-review/choice-subject.js";
import { designPanelOf, designQuestionsOf } from "../../core/design-review/panel.js";
import { proofReportOf } from "./proof-report.js";
import { planGraphOf } from "../../core/work-breakdown/plan-graph.js";
import { workBreakdownView, type WorkBreakdownView } from "../../core/work-breakdown/view.js";
import { operationKey } from "../../core/task-flow/keys.js";
import type { SecondReview } from "../../core/second-review/index.js";
import type { ModelSelectionService } from "../../core/model-selection/service.js";
import { designNotRunLine } from "../../core/design-review/not-run.js";
import type { LocalDiagnosis } from "./diagnosis.js";

const PLAN_READ_MAX_BYTES = 200_000;
const COMMENTS_MAX = 200;
const COMMENT_TEXT_MAX = 4_000;

/** A request id the approvals can carry: a UUID made from the task, the revision and the digest, so the same plan always asks the same question and a revised plan asks a new one. */
export function approvalRequestId(taskId: string, revision: number, digest: string): string {
  const hex = createHash("sha256").update(`approval\0${taskId}\0${String(revision)}\0${digest}`).digest("hex");
  // Version 5 and variant 10xx, so a strict UUID check accepts it.
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The offer a page shows while the plan waits for the owner: undefined at any other time. */
export function approvalOfferOf(taskId: string, workflow: WorkflowSnapshot): ApprovalOffer | undefined {
  if (workflow.stage !== "PLAN_REVIEW" || workflow.state !== "WAITING") return undefined;
  const digest = waitingDocumentDigest(workflow);
  return digest === undefined ? undefined : { requestId: approvalRequestId(taskId, workflow.revision, digest), revision: workflow.revision, artifactDigest: digest, kind: "plan" };
}

const commentKey = (taskId: string, at: string, id: string) => ({ pk: `DEVTASK#${taskId}`, sk: `PAGE_COMMENT#${at}#${id}` });

const KIND: Record<WorkflowArtifact["type"], PlanVersionView["kind"] | undefined> = { requirements: "requirements", design: "design", plan: "coding plan", test_plan: undefined, review_report: undefined, answer: undefined };

export interface PageDataDeps {
  flow: TaskFlowDeps;
  /** Lane L12: the evidence kept for a task's checked code (the proof report reads it). Absent: the report shows the recorded checks and reviews only. */
  evidence?: Pick<LocalEvidence, "packOf">;
  /** Lane L12: comment commands, so the page can show and attach the thread a plan is posted on. */
  comments?: Pick<LocalComments, "attachThread" | "attachedThread" | "available">;
  /** The design review: whether the project allows skipping, for the cost hold's choices. */
  designReview?: { allowSkip(project: string): Promise<boolean>; unpricedNote(): string };
  blobs: ObjectStorage;
  /** The owner of the install: the pages are the owner's. */
  owner: Principal;
  companyId: OrgId;
  /** The second review. Absent: no second review page or lines. */
  secondReview?: SecondReview;
  /** Fix with agent. Absent: the task page has no such part. */
  diagnosis?: Pick<LocalDiagnosis, "pageView" | "diagnose">;
  /** The lessons page: what Rovara has learned, and the owner's decisions on it. Absent: the page says there is nothing. */
  lessons?: Pick<LocalLessons, "list" | "act" | "repoSwitches" | "repoSwitch">;
  /** The model each step uses. Absent: no models page. */
  modelSelection?: ModelSelectionService;
  /** The cost ledger: what the task has cost so far. Absent: the page says nothing of it. */
  cost?: Pick<CostLedger, "taskCost">;
}

/** The attention view with where the plan is posted: the attached thread and the project's repositories, only while a code host reads comments. */
/** The parts of the plan's work breakdown and where each stands, from the acknowledged checkpoints. Undefined for a plan that has none (or a Markdown plan). */
async function breakdownOf(flow: TaskFlowDeps, task: TaskRecord, workflow: WorkflowSnapshot): Promise<WorkBreakdownView | undefined> {
  const artifact = workflow.artifacts.filter((entry) => entry.type === "plan").at(-1);
  if (artifact === undefined || artifact.format !== "structured") return undefined;
  const graph = await planGraphOf(flow.artifacts, artifact).catch(() => undefined);
  if (graph === undefined) return undefined;
  const approval = workflow.workflowDependenciesApproval;
  const approved = approval !== undefined && approval.artifactDigest === artifact.sha256 && approval.graphDigest === taskGraphDigest(graph);
  const bound = approved && workflow.workflowDependenciesOperationId !== undefined ? fromDocument<OperationRecord>(await flow.store.get(operationKey(task.workspaceId, workflow.workflowDependenciesOperationId))) : undefined;
  return workBreakdownView(graph, approved ? workflow.workflowDependenciesProgress ?? [] : [], approved, bound?.workflowDependencies?.parallel?.max);
}

async function attentionWithThread(deps: PageDataDeps, task: TaskRecord, view: AttentionView): Promise<AttentionView> {
  if (deps.comments === undefined || task.closedAt !== undefined || !deps.comments.available()) return view;
  const project = await deps.flow.projects.revision(task.project, task.startingRevision);
  const attached = await deps.comments.attachedThread(task.taskId);
  return { ...view, thread: { ...(attached === undefined ? {} : { attached }), repositories: (project?.definition.repositories ?? []).map((repository) => repository.name) } };
}

const STAGE_LINE: Readonly<Record<string, string>> = { understand: "Understand", plan: "Plan", plan_check: "Plan check", build: "Build", code_review: "Review", pull_request: "Feedback" };

/** What the task is expected to cost, what it has cost so far and the model each step ran on (the newest of each step), as lines for the plan page. */
async function costAndModelsOfPlanPage(deps: PageDataDeps, task: TaskRecord): Promise<Pick<PlanPageView, "costAndModels">> {
  const lines: string[] = [];
  const estimate = task.runEstimate;
  if (estimate !== undefined) {
    lines.push(`Expected cost: about ${formatRunLimitUsd(estimate.lowUsd)} to ${formatRunLimitUsd(estimate.highUsd)} (${estimate.basis === "history" ? `from ${String(estimate.samples)} earlier runs of this kind` : "the default for this kind of task, until there are enough earlier runs"}). Run limit: ${formatRunLimitUsd(estimate.runLimitUsd)}.`);
  }
  if (deps.cost !== undefined) {
    const spent = await deps.cost.taskCost(deps.companyId, task.taskId).catch(() => undefined);
    if (spent !== undefined && spent.entries > 0) lines.push(`Spent so far: ${costLine(spent)}.`);
  }
  const newest = new Map<string, string>();
  for (const operation of await workspaceOperations(deps.flow, task.workspaceId).catch(() => [])) {
    const choice = operation.modelChoice;
    if (choice === undefined) continue;
    newest.set(choice.stage, `${STAGE_LINE[choice.stage] ?? choice.stage}: ${choice.model.provider}:${choice.model.modelId}${choice.sameModelAsChecked === true ? " (the same model as the step it checks)" : ""}`);
  }
  if (newest.size > 0) lines.push(`Models used: ${[...newest.values()].join("; ")}.`);
  return lines.length === 0 ? {} : { costAndModels: lines };
}

/** The second review's lines for the plan page, and the acknowledgement the owner owes before a merge (Cloud's task view `secondReview`). */
function secondReviewOfPlanPage(deps: PageDataDeps, task: TaskRecord): Pick<PlanPageView, "secondReview" | "secondReviewAck"> {
  const second = deps.secondReview;
  if (second === undefined || task.workflow === undefined) return {};
  const view = second.taskView(task, task.workflow.candidate?.digest);
  if (view === undefined) return {};
  const ack = view.needsAcknowledgement && !view.acknowledged ? second.acknowledgement(task) : undefined;
  return { secondReview: view, ...(ack === undefined ? {} : { secondReviewAck: ack.key }) };
}

/** Fix with agent's part of the task page (absent when the task shows no error, or the feature is off here). */
async function diagnosisOfPlanPage(deps: PageDataDeps, taskId: string): Promise<Pick<PlanPageView, "diagnosis">> {
  const view = await deps.diagnosis?.pageView(taskId).catch(() => undefined);
  return view === undefined ? {} : { diagnosis: view };
}

export function createLocalPageData(deps: PageDataDeps): LocalPageData {
  const taskOf = async (taskId: string): Promise<TaskRecord | undefined> => {
    const task = await readTask(deps.flow, taskId);
    return task !== undefined && task.companyId === deps.companyId ? task : undefined;
  };
  const markdownOf = async (artifact: WorkflowArtifact): Promise<string> => {
    const read = await readVerifiedText(deps.blobs, artifact, PLAN_READ_MAX_BYTES);
    return "text" in read ? read.text : "changed" in read ? DOCUMENT_CHANGED : "This document is no longer kept.";
  };
  /**
   * What the page shows of one stored document. A structured plan is read back and checked against its digest and shown as claims, decisions and checks; the code it cites is shown for the current version only,
   * from the evidence the plan's pointer names (read only from this task's own storage, and only when its bytes match the digest recorded). A document that fails its check is not shown.
   */
  const contentOf = async (task: TaskRecord, artifact: WorkflowArtifact, current: boolean): Promise<PlanVersionView["content"]> => {
    if (artifact.format !== "structured") return { format: "markdown", markdown: await markdownOf(artifact) };
    const read = textReaderOf(deps.blobs);
    const privatePrefix = `private/${task.ownerKey}/${task.workspaceId}/`;
    if (!artifact.objectKey.startsWith(privatePrefix)) return { format: "markdown", markdown: DOCUMENT_CHANGED };
    const loaded = await loadWorkflowDocument(read, artifact, {}).catch(() => undefined);
    if (loaded?.format !== "structured") return { format: "markdown", markdown: DOCUMENT_CHANGED };
    let recorded = artifact.evidence;
    if (current && recorded === undefined) {
      const pointer = await planEvidencePointer(deps.flow.store, task.taskId, artifact.id).catch(() => undefined);
      if (pointer?.artifactSha256 === artifact.sha256 && typeof pointer.objectKey === "string" && typeof pointer.sha256 === "string") recorded = { objectKey: pointer.objectKey, sha256: pointer.sha256 };
    }
    const evidence = current && recorded?.objectKey.startsWith(privatePrefix) === true ? await loadPlanEvidence(read, { ...artifact, evidence: recorded }).catch(() => undefined) : undefined;
    return { format: "structured", plan: loaded.plan, ...(evidence === undefined ? {} : { evidence }) };
  };
  /** Rovara's check of the current coding plan, read from the record beside the document (no usable record reads as "not checked", never as "no problems"). */
  const checkOf = async (artifact: WorkflowArtifact, content: PlanVersionView["content"], current: boolean): Promise<PlanVersionView["check"] | undefined> => {
    if (!current || artifact.type !== "plan" || content.format !== "structured") return undefined;
    const read = textReaderOf(deps.blobs);
    const selfCheck = await loadPlanSelfCheck(async (key) => read(key, 70_000), artifact);
    return { selfCheck, oneScreen: planOneScreenText(planOneScreen(content.plan)) };
  };
  const commentsOf = async (taskId: string): Promise<CommentView[]> => {
    const items = await queryAll(deps.flow.store, { pk: `DEVTASK#${taskId}`, sk: { op: "beginsWith", prefix: "PAGE_COMMENT#" }, limit: COMMENTS_MAX });
    return items.flatMap((item) => (typeof item["id"] === "string" && typeof item["text"] === "string" && typeof item["createdAt"] === "string"
      ? [{ id: item["id"], author: typeof item["author"] === "string" ? item["author"] : "You", at: item["createdAt"], target: typeof item["target"] === "string" ? item["target"] : "", text: item["text"] }]
      : []));
  };
  return {
    async listPending() {
      const pending: PendingItemView[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page += 1) {
        const listed = await listTasks(deps.flow, { principal: deps.owner }, { limit: 100, ...(cursor === undefined ? {} : { cursor }) });
        for (const row of listed.tasks) {
          const task = await readTask(deps.flow, row.taskId);
          const workflow = task?.workflow;
          if (task === undefined || task.closedAt !== undefined || workflow === undefined || approvalOfferOf(task.taskId, workflow) === undefined) continue;
          pending.push({ kind: "plan", taskId: task.taskId, title: task.title, since: workflow.updatedAt });
        }
        cursor = listed.cursor;
        if (cursor === undefined) break;
      }
      return pending;
    },

    async getPlanPage(taskId): Promise<PlanPageView | undefined> {
      const task = await taskOf(taskId);
      const workflow = task?.workflow;
      if (task === undefined || workflow === undefined) return undefined;
      const approvedDigests = new Set(workflow.decisions.filter((decision) => decision.decision === "APPROVE" && decision.artifactDigest !== undefined).map((decision) => decision.artifactDigest));
      const shown = workflow.artifacts.filter((artifact) => KIND[artifact.type] !== undefined);
      const waitingType = currentDocumentType(workflow);
      const latest = shown.filter((artifact) => artifact.type === waitingType).at(-1);
      const versions: PlanVersionView[] = [];
      for (const artifact of shown) {
        const current = artifact.id === latest?.id;
        const content = await contentOf(task, artifact, current);
        const check = await checkOf(artifact, content, current);
        versions.push({
          version: artifact.version, kind: KIND[artifact.type]!, approved: approvedDigests.has(artifact.sha256), current,
          content, createdAt: artifact.createdAt, ...(check === undefined ? {} : { check }),
        });
      }
      // A structured plan whose stored bytes cannot be read back is not offered for approval: the owner could not see what they would approve (the decision refuses it as well).
      const unreadable = latest?.format === "structured" && versions.find((version) => version.current)?.content.format === "markdown";
      const approval = unreadable ? undefined : approvalOfferOf(taskId, workflow);
      const breakdown = await breakdownOf(deps.flow, task, workflow);
      // A pull request whose head is no longer the one Rovara checked says so here (the stop-gap until merge tracking runs on a timer).
      const outside = new Map((await checkPullRequestHeads(deps.flow, task).catch(() => [])).filter((entry) => entry.changedOutside).map((entry) => [`${entry.repository}#${String(entry.number)}`, true]));
      return {
        taskId, title: task.title, status: stepOf(workflow.stage, workflow.state) ?? (workflow.state === "COMPLETE" ? "Finished" : "In progress"), revision: workflow.revision, versions,
        checks: (workflow.checkPolicy?.proposed ?? []).map((check) => ({ label: check.label, status: "proposed" as const })),
        findings: [],
        pullRequests: (workflow.pullRequests ?? []).map((pullRequest) => ({ url: pullRequest.url, number: pullRequest.number, state: pullRequest.state.toLowerCase(), ...(outside.has(`${pullRequest.repositoryId}#${String(pullRequest.number)}`) ? { note: CHANGED_OUTSIDE_NOTE } : {}) })),
        comments: await commentsOf(taskId), ...(approval === undefined ? {} : { approval }), ...(breakdown === undefined ? {} : { breakdown }),
        ...(workflow.critique === undefined ? {} : { critique: critiqueLines(workflow.critique, task.project) }),
        // A design that went through no review says so beside the design itself, so nobody takes it for a reviewed one.
        ...(designNotRunLine(workflow.designReview) === undefined ? {} : { designNote: designNotRunLine(workflow.designReview)! }),
        // Rovara's ask, the pull request's state and any questions: fixed words, and the forms that answer them.
        attention: designQuestionsOf(workflow) === undefined ? await attentionWithThread(deps, task, (await attentionOf(deps.flow, task)).view) : { ...await attentionWithThread(deps, task, (await attentionOf(deps.flow, task)).view), questions: designQuestionsOf(workflow)! },
        // The design review's panel: how it went, what is open, and what waits for the owner.
        ...(workflow.designReview === undefined ? {} : { designReview: designPanelOf(workflow, { allowSkip: await (deps.designReview?.allowSkip(task.project) ?? Promise.resolve(false)), ...(deps.designReview === undefined ? {} : { unpricedNote: deps.designReview.unpricedNote() }), ...(designChoiceDigest(workflow) === undefined ? {} : { holdOffer: { requestId: approvalRequestId(taskId, workflow.revision, designChoiceDigest(workflow)!), revision: workflow.revision, artifactDigest: designChoiceDigest(workflow)! } }) })! }),
        ...secondReviewOfPlanPage(deps, task),
        // Fix with agent: the button for the error the task shows, or the diagnosis already asked for.
        ...(await diagnosisOfPlanPage(deps, taskId)),
        ...await costAndModelsOfPlanPage(deps, task),
      };
    },

    async getSecondReview() { return deps.secondReview?.enabled() === true ? deps.secondReview.state() : undefined; },
    async getModelSelection() { return deps.modelSelection?.state(); },
    async getDesignReview() { return undefined; },
    async readMockup() { return undefined; },
    async listLessons() { return deps.lessons === undefined ? [] : deps.lessons.list(); },
    async listLessonRepos() { return deps.lessons === undefined ? [] : deps.lessons.repoSwitches(); },
    async getProofReport(taskId): Promise<ProofReportView | undefined> {
      const task = await taskOf(taskId);
      const workflow = task?.workflow;
      if (task === undefined || workflow === undefined) return undefined;
      const pack = workflow.candidate === undefined ? undefined : await deps.evidence?.packOf(task, workflow.candidate.digest);
      const report = proofReportOf(task, workflow, pack, { verified: await verifiedChangedFiles(deps.flow, task.workspaceId, workflow.candidate?.digest), reported: await reportedChangedFiles(deps.flow, task.workspaceId) });
      // The design's part (when it went through design review and was approved): one line of counts, the approver and the reason, and a row for it.
      const design = workflow.designReview === undefined ? undefined : await loadDesignProof({ store: deps.flow.store, artifacts: deps.flow.artifacts }, taskId, workflow);
      return design === undefined ? report : { ...report, summary: `${designProofLine(design)} ${report.summary}`, rows: [{ claim: "Design review", check: "fresh-context reviewers", status: design.approval.openBlockers === 0 ? "passed" : "not_run", detail: `approved by ${design.approval.approverLabel}` }, ...report.rows] };
    },
  };
}

/** The writes of the pages that the decision gate does not own: a comment on a plan, and the lessons (none here yet). */
export function createPageExtraActions(deps: Pick<PageDataDeps, "flow" | "companyId" | "owner" | "comments" | "secondReview" | "modelSelection" | "diagnosis" | "lessons"> & { designAnswers?: (input: { taskId: string; revision: number; answers: Array<{ questionId: string; optionId?: string; text?: string }> }) => Promise<LocalActionResult> }): Pick<LocalPageActions, "addComment" | "lessonAction" | "lessonRepoAction" | "retry" | "answerQuestions" | "attachThread" | "secondReview" | "diagnose" | "modelSelection" | "acknowledgeSecondReview"> {
  return {
    async diagnose(input): Promise<LocalActionResult> {
      return deps.diagnosis === undefined ? { ok: false, reason: "not_found", message: "That is no longer there." } : deps.diagnosis.diagnose(input);
    },
    async modelSelection(input, context): Promise<LocalActionResult> {
      if (deps.modelSelection === undefined) return { ok: false, reason: "not_found", message: "That is no longer there." };
      const result = await deps.modelSelection.apply(deps.owner, input, { fresh: context.fresh });
      if (result.ok) return { ok: true, message: "Saved." };
      return { ok: false, reason: result.code === "reauth_required" ? "reauth" : result.code === "stale" ? "stale" : result.code === "invalid" ? "invalid" : "refused", message: result.words };
    },
    async secondReview(input, context): Promise<LocalActionResult> {
      if (deps.secondReview === undefined) return { ok: false, reason: "not_found", message: "That is no longer there." };
      try {
        await deps.secondReview.apply(deps.owner, input.action === "mode" && input.scope === "company" ? { action: "mode", scope: "company", mode: input.mode } : input, { fresh: context.fresh });
        return { ok: true, message: "Saved." };
      } catch (error) {
        return refusalOf(error);
      }
    },
    async acknowledgeSecondReview(input): Promise<LocalActionResult> {
      const task = await readTask(deps.flow, input.taskId);
      const workflow = task?.workflow;
      if (deps.secondReview === undefined || task === undefined || task.companyId !== deps.companyId || workflow === undefined) return { ok: false, reason: "not_found", message: "That is no longer there." };
      if (workflow.revision !== input.revision) return { ok: false, reason: "stale", message: "This changed since you read it. Read the latest and try again." };
      const needed = deps.secondReview.acknowledgement(task);
      if (needed === undefined || needed.key !== input.key) return { ok: false, reason: "stale", message: "This is out of date; read the task again." };
      const result = await deps.secondReview.acknowledge(deps.owner, task);
      if (result.ok) return { ok: true, message: "Acknowledged." };
      if (result.reason === "audit_unavailable") return { ok: false, reason: "refused", message: "This needs the audit record, which is not available here." };
      return result.reason === "not_required" ? { ok: false, reason: "invalid", message: "There is nothing to acknowledge for this code." } : { ok: false, reason: "stale", message: "This is out of date; read the task again." };
    },
    async addComment(input): Promise<LocalActionResult> {
      const task = await readTask(deps.flow, input.taskId);
      const workflow = task?.workflow;
      if (task === undefined || task.companyId !== deps.companyId || workflow === undefined) return { ok: false, reason: "not_found", message: "That is no longer there." };
      if (workflow.revision !== input.revision) return { ok: false, reason: "stale", message: "This changed since you read it. Read the latest and comment again." };
      const text = input.text.trim();
      if (text === "" || [...text].length > COMMENT_TEXT_MAX) return { ok: false, reason: "invalid", message: "That comment was not understood." };
      const at = iso(deps.flow);
      const id = randomUUID();
      // The comment lives only while the task is open at the revision it was written against.
      const written = await deps.flow.store.put({
        item: { ...commentKey(input.taskId, at, id), entityType: "PAGE_COMMENT", id, taskId: input.taskId, workflowRevision: input.revision, target: input.target, text, author: deps.owner.displayName, createdAt: at },
        condition: when.absent(),
      });
      return written.applied ? { ok: true, message: "Comment added." } : { ok: false, reason: "refused", message: "That was not accepted." };
    },
    async retry(input): Promise<LocalActionResult> {
      const task = await readTask(deps.flow, input.taskId);
      const workflow = task?.workflow;
      if (task === undefined || task.companyId !== deps.companyId || workflow === undefined || task.closedAt !== undefined) return { ok: false, reason: "not_found", message: "That is no longer there." };
      if (workflow.revision !== input.revision) return { ok: false, reason: "stale", message: "This changed since you read it. Read the latest and try again." };
      if (!retryableBlock(workflow)) return { ok: false, reason: "refused", message: NOTHING_TO_RETRY_STEP };
      try {
        // Through the session's control when it has one, so a Retry from the page is audited, written on the timeline and counted like any other.
        if (task.sessionId === undefined) await retryBlockedStep(deps.flow, input.taskId, input.revision);
        else {
          const result = await createLocalSessionControl(deps.flow, { expectedRevision: input.revision }).retry(deps.owner, deps.companyId, task.sessionId, { requestId: randomUUID() });
          if (result.status === "refused") return { ok: false, reason: "refused", message: result.message };
        }
      } catch (error) {
        return { ok: false, reason: "refused", message: error instanceof Error ? error.message.replace(/^[A-Z_]+: /u, "") : "That could not be run again." };
      }
      return { ok: true, message: "Rovara is running that step again." };
    },
    async attachThread(input): Promise<LocalActionResult> {
      const task = await readTask(deps.flow, input.taskId);
      if (task === undefined || task.companyId !== deps.companyId || task.workflow === undefined || task.closedAt !== undefined || deps.comments === undefined) return { ok: false, reason: "not_found", message: "That is no longer there." };
      if (task.workflow.revision !== input.revision) return { ok: false, reason: "stale", message: "This changed since you read it. Read the latest and try again." };
      try {
        await deps.comments.attachThread(input.taskId, { repository: input.repository, number: input.number });
      } catch (error) {
        return { ok: false, reason: "refused", message: error instanceof Error ? error.message.replace(/^[A-Z_]+: /u, "") : "That could not be attached." };
      }
      return { ok: true, message: "That thread is attached." };
    },
    async answerQuestions(input): Promise<LocalActionResult> {
      // While a design review waits for answers, the owner's answers are to ITS question card (the same form), not Understand's.
      const waiting = (await readTask(deps.flow, input.taskId))?.workflow;
      if (waiting?.designReview?.status === "waiting_answers" && deps.designAnswers !== undefined) return deps.designAnswers({ taskId: input.taskId, revision: input.revision, answers: input.answers });
      try {
        await answerUnderstandQuestions(deps.flow, { taskId: input.taskId, round: input.round, answers: input.answers, by: { name: deps.owner.displayName }, source: "app", expectedRevision: input.revision });
      } catch (error) {
        const message = error instanceof Error ? error.message.replace(/^[A-Z_]+: /u, "") : "That was not accepted.";
        return { ok: false, reason: /changed|Read it again|no longer/iu.test(message) ? "stale" : "refused", message };
      }
      return { ok: true, message: "Your answers were sent." };
    },
    async lessonAction(input): Promise<LocalActionResult> {
      return deps.lessons === undefined ? { ok: false, reason: "refused", message: "Lessons are not on this install." } : deps.lessons.act(input);
    },
    async lessonRepoAction(input): Promise<LocalActionResult> {
      return deps.lessons === undefined ? { ok: false, reason: "refused", message: "Lessons are not on this install." } : deps.lessons.repoSwitch(input);
    },
  };
}


/** What a refused second-review change says: the fixed words of the refusal, and whether the page was out of date. */
function refusalOf(error: unknown): LocalActionResult {
  if (error instanceof Error && "code" in error) {
    const code = String((error as { code: unknown }).code);
    const message = error.message.replace(/^[A-Z_]+: /u, "");
    return { ok: false, reason: code === "REAUTH_REQUIRED" ? "reauth" : code === "CHANGE_STALE" ? "stale" : code === "NOT_FOUND" ? "not_found" : code === "CONFIG_INVALID" ? "invalid" : "refused", message };
  }
  return { ok: false, reason: "refused", message: "That was not accepted." };
}
