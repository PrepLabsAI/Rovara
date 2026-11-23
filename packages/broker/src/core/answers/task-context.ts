// Task data for project Answers: a reader supplied by the actual door, never the install owner's authority.
import { agentSessionKey, type DocumentStore, type OrgId } from "@agentx/contracts";
import type { ArtifactReader } from "../task-flow/deps.js";
import type { TaskRecord } from "../task-flow/records.js";
import { buildAskContext } from "../sessions/ask-context.js";
import { readSessionEvents, sessionSnapshot } from "../sessions/read.js";
import { SessionStore } from "../sessions/store.js";
import { loadWorkflowDocument } from "../../developer/plan-document-reader.js";
import { textReaderOf } from "../build-step/plan-input.js";
import { frameUntrusted, storedWords } from "./frame.js";

export interface AnswerTasks {
  /** Uses this asker's task-page authority. Undefined means no context, including a denied/missing task. */
  read(personId: string, taskId: string): Promise<TaskRecord | undefined>;
  artifacts?: ArtifactReader | undefined;
}

function taskStatus(task: TaskRecord, workflow: TaskRecord["workflow"], snapshot: ReturnType<typeof sessionSnapshot> | undefined): string {
  return task.closedAt !== undefined ? "Closed" : workflow === undefined ? snapshot?.statusText ?? "Starting" : `${workflow.stage} / ${workflow.state}`;
}

/** Data is already held to the company/path project by the service. No notes, diff or check output is loaded. */
export async function answerTaskFrame(store: DocumentStore, companyId: OrgId, task: TaskRecord, tasks: AnswerTasks, now: number): Promise<string> {
  const workflow = task.workflow;
  let snapshot: ReturnType<typeof sessionSnapshot> | undefined;
  let events: string[] = [];
  if (task.sessionId !== undefined) {
    const session = await new SessionStore(store).getForTask(companyId, { ...task, orgId: task.companyId });
    if (session !== undefined) {
      snapshot = sessionSnapshot(session);
      // Read the newest bounded page; reuse the task-page reader's expiry, scope and schema checks.
      const newest = await store.query({ pk: agentSessionKey(companyId, task.sessionId, "META").pk, sk: { op: "beginsWith", prefix: "EVENT#" }, descending: true, limit: 41 });
      const page = await readSessionEvents({ query: async () => ({ items: newest.items }) }, companyId, task.sessionId, {}, now);
      events = page.events.sort((left, right) => right.at.localeCompare(left.at) || right.eventId.localeCompare(left.eventId)).slice(0, 20).map((event) => `${event.at} ${event.text}`);
    }
  }
  const latest = workflow?.artifacts.filter((artifact) => ["plan", "design", "requirements"].includes(artifact.type)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.version - b.version).at(-1);
  const loaded = latest === undefined ? undefined : await loadWorkflowDocument(async (key, max) => key.startsWith(`private/${task.ownerKey}/${task.workspaceId}/`) ? textReaderOf(tasks.artifacts)(key, max) : undefined, latest, {}).catch(() => undefined);
  const decisions = (workflow?.decisions ?? []).slice(-20).reverse().map((decision) => `${decision.at} ${decision.decision} (${decision.actorRole})`);
  const rendered = buildAskContext("web", {
    title: task.title, request: storedWords(task.requestText ?? "", 1_500),
    status: taskStatus(task, workflow, snapshot),
    step: task.closedAt === undefined ? workflow?.stage ?? snapshot?.step : undefined,
    nextStep: snapshot?.next ?? "See the task page for the current plan and next step.",
    document: latest === undefined ? undefined : loaded === undefined ? "unreadable" : { label: `${latest.type} summary`, version: latest.version, markdown: storedWords(loaded.markdown, 1_500) },
    // The builder retains ordering; both lists arrive newest first.
    timeline: { statusLines: events, decisions },
  }, "answer-task-state");
  return frameUntrusted({ from: "the task page this person can read", item: "task-state", text: rendered.text, maxBytes: 24_000 });
}
