// Lane L9-wire: the task as the clients read it (`DeveloperTaskView`, which the MCP tools and the CLI parse), over the task flow's own smaller view (L6a's `TaskView`). Only what the records
// hold is filled; the optional parts (events, summary, proof, evidence, testing, run limits) are left out until their lanes are wired.
import type { ObjectStorage } from "@agentx/contracts";
import type { DeveloperTaskListItem } from "@agentx/contracts";
import { loadWorkflowDocument } from "../../developer/plan-document-reader.js";
import { textReaderOf } from "../../core/build-step/plan-input.js";
import { waitingDocumentDigest } from "../../core/decisions/workflow-subject.js";
import type { TaskView } from "../../core/task-flow/reads.js";
import type { TaskRecord } from "../../core/task-flow/records.js";

/** The plan text a client may read: the waiting document, cut to what the tools carry (the whole document is on the local page). */
const PLAN_CONTENT_MAX_BYTES = 32_768;

/** What the task view says of the second review: the lines, and whether the owner must acknowledge on the task page. The acknowledgement is the owner's act on the local page, never a token's. */
export interface SecondReviewViewPart { lines: string[]; needsAcknowledgement: boolean; acknowledged: boolean }

export async function developerTaskView(task: TaskRecord, view: TaskView, blobs: ObjectStorage, secondReview?: SecondReviewViewPart): Promise<Record<string, unknown>> {
  const workflow = task.workflow;
  let planContent: string | undefined;
  if (workflow !== undefined && workflow.stage === "PLAN_REVIEW" && workflow.state === "WAITING") {
    const digest = waitingDocumentDigest(workflow);
    const artifact = workflow.artifacts.filter((candidate) => candidate.sha256 === digest).at(-1);
    // Only bytes that match the digest the approval binds are handed to a client.
    // A structured plan is given as its Markdown copy (derived from the checked document, never stored); a Markdown plan as it was saved.
    const loaded = artifact === undefined ? undefined : await loadWorkflowDocument(textReaderOf(blobs), artifact, { answers: "recommended" }).catch(() => undefined);
    if (loaded !== undefined) planContent = loaded.markdown.slice(0, PLAN_CONTENT_MAX_BYTES);
  }
  return JSON.parse(JSON.stringify({
    taskId: task.taskId, title: task.title, project: task.project, status: view.status, startingRevision: task.startingRevision, client: task.client, shared: false,
    ...(view.closing ? { closing: true } : {}), createdAt: task.createdAt, updatedAt: task.updatedAt, events: [],
    ...(workflow === undefined ? {} : { workflow: { ...workflow, ...(planContent === undefined ? {} : { planContent }) } }),
    ...(view.failure === undefined ? {} : { failure: view.failure }),
    ...(task.sessionId === undefined ? {} : { sessionId: task.sessionId }),
    // What the run is expected to cost (kept with the plan), for the tools and the CLI.
    ...(task.runEstimate === undefined ? {} : { runEstimate: task.runEstimate }),
    ...(secondReview === undefined || secondReview.lines.length === 0 ? {} : { secondReview: { ...secondReview, ...(secondReview.needsAcknowledgement && !secondReview.acknowledged ? { canAcknowledge: true } : {}) } }),
  })) as Record<string, unknown>;
}

export function developerTaskListItem(row: { taskId: string; title: string; project: string; status: string; shared?: boolean; createdAt: string; updatedAt: string; sessionId?: string }): DeveloperTaskListItem {
  return JSON.parse(JSON.stringify({ taskId: row.taskId, title: row.title, project: row.project, status: row.status, shared: row.shared === true, createdAt: row.createdAt, updatedAt: row.updatedAt, ...(row.sessionId === undefined ? {} : { sessionId: row.sessionId }) })) as DeveloperTaskListItem;
}
