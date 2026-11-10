// Lane L9-wire: what the local review pages read (L8's `LocalPageData`) and the one write the task flow owns that the pages ask for (a comment on a plan), over the task flow's
// records. The pages know nothing of these records; this is the only place that does.
//
// Not wired yet (each answers "nothing there" so the page says so, rather than inventing a view): design reviews (the design review stage is not ported), lessons (the lessons store is
// lane L11's) and the proof report (slice 3: it reads the verification and the pull request the publish step records).
import type { ObjectStorage } from "@agentx/contracts";
import { createHash, randomUUID } from "node:crypto";
import {
  queryAll, when, type OrgId, type Principal, type WorkflowArtifact, type WorkflowSnapshot,
} from "@agentx/contracts";
import { CHANGED_OUTSIDE_NOTE, checkPullRequestHeads } from "../../core/build-step/head-check.js";
import { currentDocumentType, waitingDocumentDigest } from "../../core/decisions/workflow-subject.js";
import type { ApprovalOffer, AttentionView, CommentView, LocalActionResult, LocalPageActions, LocalPageData, PendingItemView, PlanPageView, PlanVersionView, ProofReportView } from "../../core/local-pages/views.js";
import type { TaskFlowDeps } from "../../core/task-flow/deps.js";
import { listTasks, readTask } from "../../core/task-flow/reads.js";
import type { TaskRecord } from "../../core/task-flow/records.js";
import { iso } from "../../core/task-flow/support.js";
import { DOCUMENT_CHANGED, readVerifiedText } from "./documents.js";
import type { LocalComments } from "./comments.js";
import type { LocalEvidence } from "./evidence.js";
import { reportedChangedFiles, verifiedChangedFiles } from "../../core/build-step/changed-files.js";
import { answerUnderstandQuestions } from "./answers.js";
import { attentionOf, retryableBlock } from "./attention.js";
import { createLocalSessionControl } from "./host.js";
import { NOTHING_TO_RETRY_STEP, retryBlockedStep } from "./retry.js";
import { stepOf } from "./facts.js";
import { proofReportOf } from "./proof-report.js";

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
  blobs: ObjectStorage;
  /** The owner of the install: the pages are the owner's. */
  owner: Principal;
  companyId: OrgId;
}

/** The attention view with where the plan is posted: the attached thread and the project's repositories, only while a code host reads comments. */
async function attentionWithThread(deps: PageDataDeps, task: TaskRecord, view: AttentionView): Promise<AttentionView> {
  if (deps.comments === undefined || task.closedAt !== undefined || !deps.comments.available()) return view;
  const project = await deps.flow.projects.revision(task.project, task.startingRevision);
  const attached = await deps.comments.attachedThread(task.taskId);
  return { ...view, thread: { ...(attached === undefined ? {} : { attached }), repositories: (project?.definition.repositories ?? []).map((repository) => repository.name) } };
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
        versions.push({
          version: artifact.version, kind: KIND[artifact.type]!, approved: approvedDigests.has(artifact.sha256), current: artifact.id === latest?.id,
          content: { format: "markdown", markdown: await markdownOf(artifact) }, createdAt: artifact.createdAt,
        });
      }
      const approval = approvalOfferOf(taskId, workflow);
      // A pull request whose head is no longer the one Rovara checked says so here (the stop-gap until merge tracking runs on a timer).
      const outside = new Map((await checkPullRequestHeads(deps.flow, task).catch(() => [])).filter((entry) => entry.changedOutside).map((entry) => [`${entry.repository}#${String(entry.number)}`, true]));
      return {
        taskId, title: task.title, status: stepOf(workflow.stage, workflow.state) ?? (workflow.state === "COMPLETE" ? "Finished" : "In progress"), revision: workflow.revision, versions,
        checks: (workflow.checkPolicy?.proposed ?? []).map((check) => ({ label: check.label, status: "proposed" as const })),
        findings: [],
        pullRequests: (workflow.pullRequests ?? []).map((pullRequest) => ({ url: pullRequest.url, number: pullRequest.number, state: pullRequest.state.toLowerCase(), ...(outside.has(`${pullRequest.repositoryId}#${String(pullRequest.number)}`) ? { note: CHANGED_OUTSIDE_NOTE } : {}) })),
        comments: await commentsOf(taskId), ...(approval === undefined ? {} : { approval }),
        // Rovara's ask, the pull request's state and any questions: fixed words, and the forms that answer them.
        attention: await attentionWithThread(deps, task, (await attentionOf(deps.flow, task)).view),
      };
    },

    async getDesignReview() { return undefined; },
    async readMockup() { return undefined; },
    async listLessons() { return []; },
    async getProofReport(taskId): Promise<ProofReportView | undefined> {
      const task = await taskOf(taskId);
      const workflow = task?.workflow;
      if (task === undefined || workflow === undefined) return undefined;
      const pack = workflow.candidate === undefined ? undefined : await deps.evidence?.packOf(task, workflow.candidate.digest);
      return proofReportOf(task, workflow, pack, { verified: await verifiedChangedFiles(deps.flow, task.workspaceId, workflow.candidate?.digest), reported: await reportedChangedFiles(deps.flow, task.workspaceId) });
    },
  };
}

/** The writes of the pages that the decision gate does not own: a comment on a plan, and the lessons (none here yet). */
export function createPageExtraActions(deps: Pick<PageDataDeps, "flow" | "companyId" | "owner" | "comments">): Pick<LocalPageActions, "addComment" | "lessonAction" | "retry" | "answerQuestions" | "attachThread"> {
  return {
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
      try {
        await answerUnderstandQuestions(deps.flow, { taskId: input.taskId, round: input.round, answers: input.answers, by: { name: deps.owner.displayName }, source: "app", expectedRevision: input.revision });
      } catch (error) {
        const message = error instanceof Error ? error.message.replace(/^[A-Z_]+: /u, "") : "That was not accepted.";
        return { ok: false, reason: /changed|Read it again|no longer/iu.test(message) ? "stale" : "refused", message };
      }
      return { ok: true, message: "Your answers were sent." };
    },
    async lessonAction(): Promise<LocalActionResult> {
      return { ok: false, reason: "refused", message: "Lessons are not on this install yet." };
    },
  };
}

