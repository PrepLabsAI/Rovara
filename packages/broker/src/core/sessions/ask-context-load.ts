// what an Ask about a Code task is given (the loader half of the hosted product's `agent-sessions/ask-context.ts`, written on the document store). The asker is the install's owner, so the audience is
// `web` and its tier is `ASK_AUDIENCE_POLICY.web`; the pure builder (`ask-context.ts`) renders it and enforces the tier by construction. Everything read here is a Code record (the task, its workflow and documents, the
// session's events and its notes); a reader that fails gives nothing for its section, never an error with text.
import { workflowSelectedChecks, type AgentSessionRecord, type DocumentStore, type WorkflowSnapshot } from "@agentx/contracts";
import { loadWorkflowDocument } from "../../developer/plan-document-reader.js";
import { plainBlockReason } from "../../developer/workflow-messages.js";
import { textReaderOf } from "../build-step/plan-input.js";
import type { ArtifactReader } from "../task-flow/deps.js";
import { readTask } from "../task-flow/reads.js";
import type { TaskRecord } from "../task-flow/records.js";
import { ASK_AUDIENCE_POLICY, buildAskContext, type AskContextData } from "./ask-context.js";
import { personLabel, promptTagId, readTaskNotes } from "./notes.js";
import { readSessionEvents, sessionSnapshot } from "./read.js";

/** What the broker cannot derive from the task row alone: each reader is called only for what the tier needs, and what it returns is filtered by the tier again in `buildAskContext`. */
export interface AskContextReaders {
  timeline?(task: TaskRecord, tier: "events" | "milestones" | "posted"): Promise<AskContextData["timeline"]>;
  diff?(task: TaskRecord, tier: "patches" | "files"): Promise<AskContextData["diff"]>;
  checkTails?(task: TaskRecord): Promise<Readonly<Record<string, string>>>;
  notes?(task: TaskRecord): Promise<AskContextData["notes"]>;
}

export interface AskLoadDeps { store: DocumentStore; artifacts?: ArtifactReader | undefined }

const DOCUMENT_LABELS = { requirements: "Requirements", design: "Design", plan: "Plan" } as const;
const DOCUMENT_ORDER = ["requirements", "design", "plan"] as const;

/** A reader that fails gives nothing for its section: the answer is built without it. */
async function attempt<T>(read: (() => Promise<T>) | undefined): Promise<T | undefined> {
  if (read === undefined) return undefined;
  try { return await read(); } catch { return undefined; }
}

/** The newest of the document kinds (the coding plan carries the whole requirements and design tree, so it is newest once it exists). */
function latestDocument(workflow: WorkflowSnapshot) {
  const order = (type: string): number => DOCUMENT_ORDER.findIndex((item) => item === type);
  return workflow.artifacts.filter((artifact) => order(artifact.type) >= 0)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || order(left.type) - order(right.type) || left.version - right.version).at(-1);
}

/** The owner's and reviewers' decisions as one fixed line each (the decision word, the role, the time); the reason a person typed is not repeated. */
const decisionLines = (workflow: WorkflowSnapshot): string[] => workflow.decisions.slice(-20).map((decision) => `${decision.at} ${decision.decision} (${decision.actorRole})`);

/** Check names with pass/fail from the final verification; a name is the check's label when the policy has one, else its id. A failure's tail comes from the reader, by check id. */
function checkRows(workflow: WorkflowSnapshot, tails: Readonly<Record<string, string>> | undefined): AskContextData["checks"] {
  const results = workflow.verification?.results;
  if (results === undefined) return undefined;
  const labels = new Map(workflowSelectedChecks(workflow.checkPolicy).map((check) => [check.id, check.label]));
  return results.map((result) => ({ name: labels.get(result.checkId) ?? result.checkId, status: result.status, ...(result.status === "FAILED" && tails !== undefined && Object.hasOwn(tails, result.checkId) ? { failureTail: tails[result.checkId] } : {}) }));
}

/**
 * The context for one Ask by the owner of this session's task, or undefined when there is none to give: the task is gone, closed or has no workflow. Undefined is the only refusal and it carries no text.
 * Pure of the asker: a Code install has one owner, who reads everything the web tier gives.
 */
export async function loadAskContext(deps: AskLoadDeps, session: AgentSessionRecord, readers: AskContextReaders = {}): Promise<{ text: string; bytes: number } | undefined> {
  if (session.subject.kind !== "task") return undefined;
  const task = await readTask(deps, session.subject.taskId);
  const workflow = task?.workflow;
  if (task === undefined || workflow === undefined || task.closedAt !== undefined) return undefined;
  const policy = ASK_AUDIENCE_POLICY.web;
  const snapshot = sessionSnapshot(session);
  const latest = latestDocument(workflow);
  const nonce = promptTagId(task, `ask:web:${latest?.sha256 ?? "none"}`);

  let document: AskContextData["document"];
  if (latest !== undefined) {
    const loaded = await loadWorkflowDocument(textReaderOf(deps.artifacts), latest, {}).catch(() => undefined);
    document = loaded === undefined ? "unreadable" : { label: DOCUMENT_LABELS[latest.type as keyof typeof DOCUMENT_LABELS] ?? "Document", version: latest.version, markdown: loaded.markdown };
  }
  const [timeline, diff, tails, notes] = await Promise.all([
    attempt(readers.timeline === undefined ? undefined : () => readers.timeline!(task, policy.timeline)),
    readers.diff === undefined ? undefined : attempt(() => readers.diff!(task, "patches")),
    attempt(readers.checkTails === undefined ? undefined : () => readers.checkTails!(task)),
    attempt(readers.notes === undefined ? undefined : () => readers.notes!(task)),
  ]);
  const data: AskContextData = {
    title: task.title, ...(task.requestText === undefined ? {} : { request: task.requestText }), status: snapshot.statusText, nextStep: snapshot.next ?? "Rovara carries on by itself.", ...(snapshot.step === undefined ? {} : { step: snapshot.step }),
    ...(workflow.state === "BLOCKED" ? { blockReason: plainBlockReason(workflow.blockReason) } : {}), ...(document === undefined ? {} : { document }),
    pullRequests: (workflow.pullRequests ?? []).map((pullRequest) => ({ url: pullRequest.url, state: pullRequest.state })),
    timeline: { ...timeline, decisions: [...(timeline?.decisions ?? []), ...decisionLines(workflow)] },
    ...(diff === undefined ? {} : { diff }), ...(checkRows(workflow, tails) === undefined ? {} : { checks: checkRows(workflow, tails) }), ...(notes === undefined ? {} : { notes }),
  };
  return buildAskContext("web", data, nonce);
}

/** The default readers over a Code store: the session's events for the timeline, and the task's notes with their authority. The diff reader is the install's (a peek at the working copy, else the pull request). */
export function storeAskReaders(deps: { store: DocumentStore }, session: AgentSessionRecord, extra: Pick<AskContextReaders, "diff" | "checkTails"> = {}): AskContextReaders {
  return {
    ...extra,
    async timeline() {
      const events = (await readSessionEvents(deps.store, session.orgId, session.sessionId)).events;
      const lines = (types: readonly string[]): string[] => events.filter((event) => types.includes(event.type)).map((event) => `${event.at} ${event.text}`);
      return { statusLines: lines(["status", "stopped", "retried", "ended", "started"]), milestones: lines(["step"]), agentEvents: [] };
    },
    async notes(task) {
      // A note's text is the owner's (this install has one): an instruction only inside the approved plan, as the worker words a live message.
      return (await readTaskNotes(deps.store, task.taskId, undefined, { includeAnswered: false })).flatMap((note) => ("messageId" in note
        ? [{ authorLabel: personLabel(note.developerId), authority: note.isOwner ? "owner_instruction" as const : "information" as const, text: note.text }] : []));
    },
  };
}
