// What a finished task adds to the Team record, and the Team record as the context sources' `TeamRecordSearch` (the "search team knowledge" tool a planning, review or understanding step can call).
//
// Capture reads the task through the same subject source lessons use (`local/app/lessons-sources.ts`, hosted form), so the same rules apply: only a task of this company with a workflow, words of a person
// who is not erased, each person's standing read now. On top of that, ONLY a member's words are kept: an outsider's comment, an agent's plan or findings, a check's text are never written. A send-back is
// read through the outcome rows (who sent it back and why). No model call is made.
//
// Search answers only for a task of the company and project asked about; every hit is the project's own row, which every project member may read (the rows come from project tasks and project
// repositories). A review comment is restricted to its repository's readers at the source; it is treated as project-wide here exactly as lessons treat words from the project's OWN repositories
// (`lessons/project-repo-audience.ts`): the subject source reads comments only from the repositories of the task's project. The caller frames the hits as data (`context-sources/routes.ts`).
import type { OrgId } from "@agentx/contracts";
import type { TaskSubjectSource } from "../lessons/task-end.js";
import type { OutcomeRowReader } from "../lessons/task-outcome-rows.js";
import type { TeamRecordHit, TeamRecordSearch } from "../context-sources/team-record.js";
import { RECORD_SNIPPET_MAX, TeamRecordCompanyError, type TeamRecord, type TeamRecordDraft } from "./record.js";

const OUTCOME_WORDS = { merged: "merged", closed: "closed without merging" } as const;

/**
 * The ways a task starts where its request is what the task's own person typed (the app, the command line, a local tool). A task from a ticket, an issue, a chat, an event, a schedule or a
 * chain carries someone else's words (the ticket's author, an outside system) as its request, so its request is never recorded as its person's. An unknown way (an older task) is not recorded either.
 */
export const TYPED_REQUEST_ORIGINS: ReadonlySet<string> = new Set(["app", "cli", "mcp"]);

/** The pull request link a comment belongs to: the task's link that ends with the comment's own pull request number (`<place>#pr<n>:...`), or none. */
function linkOfComment(eventId: string, links: readonly string[]): string | undefined {
  const number = /#pr(\d+):/u.exec(eventId)?.[1];
  if (number === undefined) return undefined;
  const matches = links.filter((link) => link.endsWith(`/pull/${number}`) || link.endsWith(`/merge_requests/${number}`));
  // Two repositories of the task may share a pull request number: then no link is claimed.
  return matches.length === 1 ? matches[0] : undefined;
}

export async function recordEndedTask(input: {
  record: TeamRecord; source: TaskSubjectSource; rows: OutcomeRowReader; companyId: OrgId; taskId: string; now: () => number;
  /** How the task started (the task record's `origin`); only a request its own person typed is recorded as theirs (`TYPED_REQUEST_ORIGINS`). */
  origin: string | undefined;
}): Promise<{ written: number }> {
  if (input.record.companyId !== input.companyId) throw new TeamRecordCompanyError();
  // The Team record never keeps a chat reply, so it never asks for the thread (Slack is read once, by the lessons, at the task's end).
  const subject = await input.source.read({ workspaceId: input.companyId, taskId: input.taskId, withoutSlack: true });
  if (subject === undefined) return { written: 0 };
  const { facts } = subject;
  const project = facts.project;
  const occurredAt = new Date(input.now()).toISOString();
  const drafts: TeamRecordDraft[] = [];
  const outcome = facts.outcome === undefined ? undefined : OUTCOME_WORDS[facts.outcome as keyof typeof OUTCOME_WORDS];
  const links = facts.rest.links ?? [];
  for (const span of facts.rest.spans ?? []) {
    if (span.trust !== "member" || span.authorId === undefined || span.text === undefined) continue;
    if (span.kind === "intent") {
      if (input.origin === undefined || !TYPED_REQUEST_ORIGINS.has(input.origin)) continue;
      drafts.push({ project, kind: "task", text: `${outcome === undefined ? "Task" : `Task (${outcome})`}: ${span.text}`, taskId: input.taskId, authorId: span.authorId, sourceRef: `task:${input.taskId}:request`, url: links[0], occurredAt });
    } else if (span.kind === "close_reason") {
      drafts.push({ project, kind: "decision", text: `Closed the task: ${span.text}`, taskId: input.taskId, authorId: span.authorId, sourceRef: `task:${input.taskId}:close`, occurredAt });
    } else if (span.kind === "pr_comment" && span.eventId !== undefined) {
      drafts.push({ project, kind: "review_feedback", text: span.text, taskId: input.taskId, authorId: span.authorId, sourceRef: span.eventId, url: linkOfComment(span.eventId, links), occurredAt });
    }
  }
  for (const requestId of subject.sendBackRequestIds) {
    const fact = await input.rows.sendBack({ workspaceId: input.companyId, project, taskId: input.taskId, requestId });
    if (fact === undefined || fact.origin !== "human" || fact.actorTrust !== "member" || fact.actorDeveloperId === undefined || fact.reasonText === undefined || fact.fixedText === true) continue;
    drafts.push({ project, kind: "decision", text: `Sent the work back: ${fact.reasonText}`, taskId: input.taskId, authorId: fact.actorDeveloperId, sourceRef: fact.id, occurredAt });
  }
  let written = 0;
  for (const draft of drafts) if (await input.record.put(draft)) written += 1;
  return { written };
}

/** The Team record as the context sources' search, for one company. A task that is not of this company and project gets nothing. */
export function teamRecordSearchOver(input: { record: TeamRecord; readTask: (taskId: string) => Promise<{ companyId: string; project: string } | undefined> }): TeamRecordSearch {
  return {
    async search(request): Promise<TeamRecordHit[]> {
      if (request.orgId !== input.record.companyId) return [];
      const task = await input.readTask(request.asAgentForTask);
      if (task === undefined || task.companyId !== input.record.companyId || task.project !== request.projectId) return [];
      // A search narrowed to named sources that does not name the record gets nothing from it.
      if (request.sources !== undefined && !request.sources.includes("team-record")) return [];
      const hits = await input.record.search(request.projectId, request.query, request.limit);
      return hits.map(({ row, score }) => ({
        itemRef: `${row.kind}:${row.id}`, system: "team-record", title: row.kind === "decision" ? "A decision" : row.kind === "review_feedback" ? "Review feedback" : "An earlier task",
        snippet: row.text.slice(0, RECORD_SNIPPET_MAX), permissionSnapshot: { kind: "project" }, score, ...(row.url === undefined ? {} : { url: row.url }),
      }));
    },
  };
}
