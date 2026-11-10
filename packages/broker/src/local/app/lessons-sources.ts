// What a finished task tells lessons, read from what this install records: the task and its workflow (the request, the approved plan, the reviews' findings, the decisions, the pull requests) and, from the code host,
// the review comments on the task's merged pull requests. Nothing is read from anywhere a person did not already put it on this machine.
//
// The rules a hosted install's source follows, in this one-person form:
// - Only a task of this company with a workflow teaches. A task that was never started by a person teaches nothing.
// - The owner's own words (the request, a send-back's reason, a close reason) are a member's. Words an agent wrote (the plan, the reviews' findings, a check's text) are `system`: advice, never a person's correction.
// - A reviewer's comment on a pull request is a member's only when the code host says its author is a person with write or admin standing in that repository; every other comment keeps the class `outsider`, which the reflector
// removes before any model call. A comment's place is the repository's, and its readers are that repository's readers (a restricted audience with no names, which the project's own repositories turn into "the project").
// - A host that cannot list the comments, or whose standing cannot be read, gives no comment span. Nothing here guesses.
import { OrgIdSchema, type ChangeRequestRef, type CodeHost, type HostAccount, type OrgId, type WorkflowSnapshot } from "@agentx/contracts";
import { isRovareReplyComment } from "@agentx/contracts";
import { providerOf } from "../../plugins/routing.js";
import { loadWorkflowDocument } from "../../developer/plan-document-reader.js";
import { changeRequestRef } from "../../core/merge/host-port.js";
import type { TaskFlowDeps } from "../../core/task-flow/deps.js";
import { readTask } from "../../core/task-flow/reads.js";
import type { TaskRecord } from "../../core/task-flow/records.js";
import { isEvalRunMark } from "../../lessons/eval-run.js";
import { isHumanSendBack } from "../../lessons/human-send-backs.js";
import { cleanForLearning } from "../../lessons/guards.js";
import type { EvidenceSpan } from "../../lessons/reflect-input.js";
import type { RepoChangeRequest } from "../../lessons/repo-reflect.js";
import type { OutcomeRowReader, RevertedTasksReader } from "../../lessons/task-outcome-rows.js";
import type { TaskSubjectBase, TaskSubjectSource } from "../../lessons/task-end.js";
import type { SendBackFact } from "../../lessons/task-subject.js";
import { narrowestAudience, type Audience, type TrustClass } from "../../lessons/types.js";
import type { LessonRepositories, LessonRepository } from "./lessons-repos.js";
import { queryAll } from "@agentx/contracts";

const PLAN_MAX_BYTES = 70_000;
const MAX_FINDINGS = 20;
const MAX_CI_PROBLEMS = 10;
const MAX_SEND_BACK_IDS = 50;
const MAX_PULL_REQUESTS = 5;
const MAX_PULL_REQUEST_COMMENTS = 40;
const COMMENT_PATH_MAX = 200;
/** Words an agent wrote are advice at best: the class below Rovara's own structured signals. */
const AGENT_TEXT_TRUST: TrustClass = "system";
const CI_FAILURE_PREFIX = "A check failed on the change: ";

const present = (value: string | undefined): value is string => value !== undefined && value.trim() !== "";

function outcomeOf(workflow: WorkflowSnapshot | undefined): "merged" | "closed" | undefined {
  switch (workflow?.outcome) {
    case "MERGED": return "merged";
    case "CLOSED": case "REJECTED": return "closed";
    default: return undefined;
  }
}

/** The base commit when the record pins exactly one for the project's repositories; several repositories have several bases and the subject holds one, so none is claimed. */
function baseOf(task: TaskRecord, repositories: readonly string[]): { repository: string; commit: string } | undefined {
  const pinned = task.workflow?.reviewBase ?? task.preparedBase;
  if (pinned === undefined) return undefined;
  const mine = pinned.filter((entry) => repositories.includes(entry.repositoryId));
  return mine.length === 1 ? { repository: mine[0]!.repositoryId, commit: mine[0]!.baseCommitSha } : undefined;
}

/** The ACL source name of a code host: GitHub's own, or `codehost:<kind>` for any other (the lessons' audience schema names both). */
export const aclSourceOf = (provider: string): string => (provider === "github" ? "github" : `codehost:${provider}`);

/** A person on the code host, named the way this install names an account that is not the owner's (`<host>_<account id or login>`). */
const accountPerson = (provider: string, account: { login: string; hostUserId?: string | undefined }): string => `${provider}_${account.hostUserId ?? account.login}`.replace(/[^A-Za-z0-9_.-]/gu, "-").slice(0, 100);

/** The start of every pull request link of a repository (`https://host/owner/name/pull/`), from one link and its number; undefined when the link does not end in that number. */
function linkPrefixOf(url: string, number: number): string | undefined {
  const suffix = String(number);
  return url.endsWith(`/${suffix}`) ? url.slice(0, url.length - suffix.length) : undefined;
}

export interface LocalSubjectSourceOptions {
  flow: Pick<TaskFlowDeps, "store" | "projects">;
  companyId: OrgId;
  /** The owner's id as lessons record it, and the host accounts that are the owner's own (the signed-in host account is a person, the owner). */
  ownerId: string;
  ownerAccounts?: ReadonlySet<string> | undefined;
  repos: LessonRepositories;
  /** The artifact store's text read (the plan document). Absent: no plan span. */
  readObject?: ((objectKey: string, maxBytes: number) => Promise<string | undefined>) | undefined;
  now: () => number;
  log?: ((event: string, fields: Record<string, string | number>) => void) | undefined;
}

export interface LocalLessonSources { source: TaskSubjectSource; rows: OutcomeRowReader; reverts: RevertedTasksReader }

export function createLocalLessonSources(options: LocalSubjectSourceOptions): LocalLessonSources {
  const { flow, ownerId } = options;
  const company = (workspaceId: string): OrgId | undefined => { const parsed = OrgIdSchema.safeParse(workspaceId); return parsed.success && parsed.data === options.companyId ? parsed.data : undefined; };
  const teaches = (task: TaskRecord | undefined, workspaceId: string): task is TaskRecord =>
    task !== undefined && company(workspaceId) !== undefined && task.companyId === workspaceId && task.workflow !== undefined && !isEvalRunMark((task as { evalRun?: unknown }).evalRun);

  /** The comments of one merged pull request, as spans, and the change request they make up. */
  async function reviewComments(task: TaskRecord, pullRequest: NonNullable<WorkflowSnapshot["pullRequests"]>[number], repo: LessonRepository): Promise<{ spans: EvidenceSpan[]; change?: RepoChangeRequest }> {
    const host: CodeHost = repo.codeHost;
    const ref: ChangeRequestRef = changeRequestRef(repo.url, pullRequest.number);
    let feedback;
    try { feedback = await host.feedback(ref, repo.scope); } catch { return { spans: [] }; }
    const provider = providerOf(host);
    const audience: Audience = { kind: "restricted", acl: { source: aclSourceOf(provider), scope: repo.place, capturedAt: new Date(options.now()).toISOString(), liveCheck: "none" } };
    const standing = new Map<string, TrustClass>();
    const trustOf = async (login: string): Promise<TrustClass> => {
      const known = standing.get(login);
      if (known !== undefined) return known;
      let trust: TrustClass = "outsider";
      try {
        const account: HostAccount = { login };
        const found = await host.standing(repo.repository, account, repo.scope);
        if ((found.permission === "write" || found.permission === "admin") && found.accountType === "person") trust = "member";
      } catch { trust = "outsider"; }
      standing.set(login, trust);
      return trust;
    };
    const spans: EvidenceSpan[] = [];
    for (const comment of feedback.comments.slice(0, MAX_PULL_REQUEST_COMMENTS)) {
      if (comment.body.trim() === "" || isRovareReplyComment(comment.body)) continue;
      const trust = await trustOf(comment.author);
      const mine = options.ownerAccounts?.has(comment.author) === true;
      const person = mine ? ownerId : accountPerson(provider, { login: comment.author });
      const place = comment.path === undefined ? undefined : cleanForLearning(comment.path, COMMENT_PATH_MAX);
      spans.push({
        kind: "pr_comment", text: place === undefined || place === "" ? comment.body : `On ${place}: ${comment.body}`, trust, authorId: person,
        eventId: `${repo.place}#pr${String(pullRequest.number)}:${comment.kind}${comment.id}`, audience, scopes: [repo.place], sourceKey: `${provider}:${person}`,
        ...(place === undefined || place === "" ? {} : { paths: [place] }),
      });
    }
    const linkPrefix = linkPrefixOf(pullRequest.url, pullRequest.number);
    if (pullRequest.state !== "MERGED" || linkPrefix === undefined || spans.length === 0) return { spans };
    return {
      spans,
      change: {
        place: repo.place, repository: pullRequest.repositoryId, repositoryUrl: repo.url, link: pullRequest.url, linkPrefix, revision: feedback.changeRequest.headTreeRevision,
        merged: true, audience: narrowestAudience(spans.flatMap((span) => (span.audience === undefined ? [] : [span.audience]))), comments: spans, edits: [],
      },
    };
  }

  const source: TaskSubjectSource = {
    async projectOf(input) {
      const task = await readTask(flow, input.taskId);
      return teaches(task, input.workspaceId) ? task.project : undefined;
    },
    async read(input): Promise<TaskSubjectBase | undefined> {
      const task = await readTask(flow, input.taskId);
      if (!teaches(task, input.workspaceId)) return undefined;
      const workspaceId = input.workspaceId;
      const project = task.project;
      const workflow = task.workflow;
      const allRepositories = (await options.repos.ofProject(project).catch(() => [])).map((repository) => repository.name);
      const base = baseOf(task, allRepositories);
      const repositories = base === undefined ? allRepositories : [base.repository];

      const spans: EvidenceSpan[] = [];
      const requestText = (task as { requestText?: string }).requestText;
      const intentText = present(requestText) ? requestText : task.title;
      if (present(intentText)) spans.push({ kind: "intent", text: intentText, trust: "member", authorId: ownerId });

      if (workflow !== undefined && options.readObject !== undefined) {
        const plan = workflow.artifacts.filter((artifact) => artifact.type === "plan").sort((a, b) => a.version - b.version).at(-1);
        if (plan !== undefined) {
          const loaded = await loadWorkflowDocument((key, max) => options.readObject!(key, max).catch(() => undefined), plan, {}).catch(() => undefined);
          if (present(loaded?.markdown)) spans.push({ kind: "plan", text: loaded.markdown.slice(0, PLAN_MAX_BYTES), trust: AGENT_TEXT_TRUST, sourceKey: "plan" });
        }
      }
      let findings = 0;
      for (const review of workflow?.reviews ?? []) {
        for (const finding of review.findings) {
          if (finding.origin !== "INTRODUCED" || findings >= MAX_FINDINGS) continue;
          findings += 1;
          spans.push({ kind: "review_finding", text: finding.text, trust: AGENT_TEXT_TRUST, sourceKey: `review:${review.role.toLowerCase()}` });
        }
      }
      if (workflow?.fixSource === "ci") for (const problem of (workflow.fixProblems ?? []).slice(0, MAX_CI_PROBLEMS)) spans.push({ kind: "ci_failure", text: `${CI_FAILURE_PREFIX}${problem}`, trust: AGENT_TEXT_TRUST, sourceKey: "ci" });
      const closer = [...(workflow?.decisions ?? [])].reverse().find((decision) => decision.decision === "REJECT" && decision.actorRole === "TASK_OWNER");
      if (closer !== undefined) spans.push({ kind: "close_reason", text: closer.reason, trust: "member", authorId: ownerId });

      const repoChanges: RepoChangeRequest[] = [];
      if (input.context !== "human_edit") {
        let taken = 0;
        for (const pullRequest of (workflow?.pullRequests ?? []).slice(0, MAX_PULL_REQUESTS)) {
          if (taken >= MAX_PULL_REQUEST_COMMENTS) break;
          const repo = await options.repos.ofTask(project, task.startingRevision, pullRequest.repositoryId);
          if (repo === undefined) continue;
          const read = await reviewComments(task, pullRequest, repo);
          taken += read.spans.length;
          spans.push(...read.spans);
          if (read.change !== undefined) repoChanges.push(read.change);
        }
      }

      const outcome = outcomeOf(workflow);
      const links = (workflow?.pullRequests ?? []).map((pullRequest) => pullRequest.url).slice(0, 32);
      const sendBackRequestIds = (workflow?.decisions ?? []).filter(isHumanSendBack).map((decision) => decision.requestId).slice(0, MAX_SEND_BACK_IDS);
      let mergedCommit: string | undefined;
      if (outcome === "merged" && base !== undefined) {
        const merged = (workflow?.pullRequests ?? []).find((pullRequest) => pullRequest.repositoryId === base.repository && pullRequest.state === "MERGED");
        mergedCommit = merged?.headSha;
      }
      return {
        facts: {
          workspaceId, project, taskId: task.taskId, repositories,
          ...(base === undefined ? {} : { baseCommit: base.commit }), ...(mergedCommit === undefined ? {} : { mergedCommit }), ...(outcome === undefined ? {} : { outcome }),
          // The owner started the task. (An automatic run has no start fields, and nobody is named for it.)
          task: { developerId: ownerId, startedBy: { developerId: ownerId } },
          rest: {
            initiatorTrust: "member", steeringTrust: ["member"], intentTrust: "member", ...(links.length === 0 ? {} : { links }),
            // The owner is the one reader of this machine's tasks, and they are open to the whole project.
            audience: { kind: "project" }, sharedTask: true, spans,
          },
        },
        sendBackRequestIds, ...(repoChanges.length === 0 ? {} : { repoChanges }),
      };
    },
  };

  const rows: OutcomeRowReader = {
    async sendBack(input) {
      const task = await readTask(flow, input.taskId);
      if (!teaches(task, input.workspaceId)) return undefined;
      const decision = (task.workflow?.decisions ?? []).find((entry) => entry.requestId === input.requestId);
      if (decision === undefined) return undefined;
      const human = isHumanSendBack(decision);
      const fact: SendBackFact = { id: `task:${input.taskId}:sendback:${input.requestId}`, origin: human ? "human" : "automatic", ...(human ? { actorDeveloperId: ownerId, actorTrust: "member" as const, reasonText: decision.reason } : {}) };
      return fact;
    },
    async revertedBy(input) {
      // The revert detector records a row only for a person with write access to the repository; the row is the task's own.
      const found = await queryAll(flow.store, { pk: `DEVTASK#${input.taskId}`, sk: { op: "beginsWith", prefix: "REVERT#" } });
      const row = found.find((item) => item["entityType"] === "TASK_REVERT" && item["taskId"] === input.taskId && item["project"] === input.project);
      if (row === undefined) return undefined;
      return typeof row["reverter"] === "string" && row["reverter"] !== "" ? { actorDeveloperId: ownerId === row["reverter"] ? ownerId : accountPerson("host", { login: row["reverter"] }) } : {};
    },
  };

  // The revert detector writes one row per reverted task under the task's own partition; there is no project-wide index, so the nightly pass over reverts is the detector's own hook (`noteReverted`), not a scan.
  const reverts: RevertedTasksReader = { async since() { return { taskIds: [], truncated: false }; } };
  return { source, rows, reverts };
}
