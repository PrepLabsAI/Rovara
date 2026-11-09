// Lane L9-wire: the task as the clients read it (`DeveloperTaskView`, which the MCP tools and the CLI parse), over the task flow's own smaller view (L6a's `TaskView`). Only what the records
// hold is filled; the optional parts (events, summary, proof, evidence, testing, run limits) are left out until their lanes are wired.
import type { ObjectStorage } from "@agentx/contracts";
import type { DeveloperTaskListItem } from "@agentx/contracts";
import { readVerifiedText } from "./documents.js";
import { waitingDocumentDigest } from "../../core/decisions/workflow-subject.js";
import type { TaskView } from "../../core/task-flow/reads.js";
import type { TaskRecord } from "../../core/task-flow/records.js";

/** The plan text a client may read: the waiting document, cut to what the tools carry (the whole document is on the local page). */
const PLAN_CONTENT_MAX_BYTES = 32_768;

export async function developerTaskView(task: TaskRecord, view: TaskView, blobs: ObjectStorage): Promise<Record<string, unknown>> {
  const workflow = task.workflow;
  let planContent: string | undefined;
  if (workflow !== undefined && workflow.stage === "PLAN_REVIEW" && workflow.state === "WAITING") {
    const digest = waitingDocumentDigest(workflow);
    const artifact = workflow.artifacts.filter((candidate) => candidate.sha256 === digest).at(-1);
    // Only bytes that match the digest the approval binds are handed to a client.
    const read = artifact === undefined ? undefined : await readVerifiedText(blobs, artifact, PLAN_CONTENT_MAX_BYTES);
    if (read !== undefined && "text" in read) planContent = read.text;
  }
  return JSON.parse(JSON.stringify({
    taskId: task.taskId, title: task.title, project: task.project, status: view.status, startingRevision: task.startingRevision, client: task.client, shared: false,
    ...(view.closing ? { closing: true } : {}), createdAt: task.createdAt, updatedAt: task.updatedAt, events: [],
    ...(workflow === undefined ? {} : { workflow: { ...workflow, ...(planContent === undefined ? {} : { planContent }) } }),
    ...(view.failure === undefined ? {} : { failure: view.failure }),
    ...(task.sessionId === undefined ? {} : { sessionId: task.sessionId }),
  })) as Record<string, unknown>;
}

export function developerTaskListItem(row: { taskId: string; title: string; project: string; status: string; shared?: boolean; createdAt: string; updatedAt: string; sessionId?: string }): DeveloperTaskListItem {
  return JSON.parse(JSON.stringify({ taskId: row.taskId, title: row.title, project: row.project, status: row.status, shared: row.shared === true, createdAt: row.createdAt, updatedAt: row.updatedAt, ...(row.sessionId === undefined ? {} : { sessionId: row.sessionId }) })) as DeveloperTaskListItem;
}
