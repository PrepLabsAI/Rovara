// Setup agent: the broker's start and stop of a `setup_agent` run, and what the run says now.
// A setup run is a task with `purpose: "setup_agent"`: the agent has a shell in a setup sandbox and runs the project's setup and test commands, reads the errors and tries again, inside fixed limits, and ends with a
// proposal. This module is the broker's side only; the start itself is the task flow's (`startTask` with a setup request), so the person's access, the admission seam and the open-workspace limits apply as for any task.
//
// What this module decides, and what it leaves to the shared task start:
//   - WHO may start or stop a run: the owner of this install (the identity port's owner), as `deps.access` says for the project.
//   - THE LIMITS: `effectiveSetupAgentLimits(project setting)`. They are fixed when the run starts and kept on the pointer, so the run ends against the limits it began with even when a setting changes meanwhile.
//     They never come from the client's request (the body is a request id and nothing else).
//   - ONE RUN PER PROJECT: the pointer item (`setupAgentPointerItem`) is written in the task's start transaction and holds only while the pointer is the one the route read. Two starts at once: one is refused.
//   - WHAT A RUN ENDS WITH: `setupAgentEndItems` reads the worker's answer again (the proposal by `sanitizeSetupProposal`, the summary by its schema); the stop word is the broker's own where it knows one (a person's stop,
//     the budget, a fault) and the worker's only where it finished and said a word a worker may say. No error text, no log line and no command output is ever stored: only fixed sentences.
//
// What is stored where:
//   `SETUP_DRAFT#<project>` / AGENT   the project's pointer: which task is the current run, who asked, when, and the limits it started with. One item, replaced by a new run once the last ended.
//   the task (`DEVTASK#<id>`)         `setupAgentResult` and `agentRunEnd`, written when the run's operation ends.
// The status is never stored: `setupAgentState` derives it from the pointer and the task on every read.
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  BUDGET_EXHAUSTED_FAILURE_MESSAGE, SETUP_HOST_WAIT_MAX_HOURS, SETUP_RUN_LIMIT_STOPS, SetupRunSummarySchema, agentXError, change, effectiveSetupAgentLimits, isSetupRunLimitStop, oneLineText, sanitizeSetupProposal, when,
  type DocumentStore, type JsonValue, type OrgId, type SetupAgentLimits, type SetupAgentWire, type SetupProposal, type SetupRunEndWord, type SetupRunSummary, type SetupVerification, type StoredDocument, type TransactItem,
} from "@agentx/contracts";
import { taskKey, taskPointerKey, workspaceKey } from "../task-flow/keys.js";
import type { TaskRecord } from "../task-flow/records.js";
import { verifyProposalDetailed, type CitationFileReader } from "./proposal-verify.js";
import { setupAgentKey } from "./keys.js";

/** The operation mode of a setup run's own step. */
export const SETUP_AGENT_WORKFLOW_MODE = "SETUP_AGENT" as const;

// ---- the words a person is told (fixed: never a model's, a worker's or a repository's)

export const SETUP_AGENT_BUSY = "Rovara is already setting up this project.";
export const SETUP_AGENT_FAILURES = {
  attempts_used: "Rovara used up its tries before the setup worked. It kept what it learned.",
  time_used: "Rovara ran out of time before the setup worked. It kept what it learned.",
  budget_used: "The setup run reached its spending limit before it finished. It kept what it learned.",
  hosts_waiting: "The setup needs websites that nobody has allowed yet. Allow them, then run the setup again.",
  stopped_by_person: "The setup run was stopped.",
  needs_code_change: "The setup needs a change in the code. Ask Rovara to make it as a normal task.",
  changed_repository_files: "The setup changed files that are tracked in the repository. Rovara did not keep that change.",
  infrastructure: "The setup run could not go on. Try again.",
  machine: "Rovara couldn't set up a machine to run the setup. Try again.",
  unreadable: "Rovara ran the setup but couldn't read its answer. Try again.",
  stale: "The setup run didn't finish. Try again.",
} as const;

/** The sentence the run is asked: the project's own name and nothing from a repository, the same for every run of a project. */
export function setupAgentRequestText(project: string): string {
  return `Set up the dev environment for the project ${project} by running its setup and test commands.`;
}

/** A stop only the worker can report when it finished: the limit words, "proposed", and the two ways a run can find that setup cannot be proposed. The broker alone says a person stopped it, or a fault. */
const WORKER_STOPS: ReadonlySet<SetupRunEndWord> = new Set<SetupRunEndWord>([...SETUP_RUN_LIMIT_STOPS, "proposed", "needs_code_change", "changed_repository_files"]);

// ---- request bodies (a request id and nothing else: limits, payer and goal never come from the client)

export const SetupAgentStartBodySchema = z.object({ requestId: z.string().uuid() }).strict();
export const SetupAgentStopBodySchema = z.object({ requestId: z.string().uuid() }).strict();

// ---- the pointer item

export interface SetupAgentPointer {
  orgId: OrgId;
  project: string;
  taskId: string;
  requestId: string;
  /** The run's owner: the person who started it. */
  requestedBy: string;
  basedOnRevision: number;
  startedAt: string;
  /** The limits the run started with. */
  limits: SetupAgentLimits;
}

/**
 * The pointer's write, for the setup run's start transaction (the shared task start includes it). It holds only while the pointer is the one the route read (`seenTaskId`; none: no pointer yet), so two runs that
 * start together cannot both win. A refusal cancels the whole start; the route then tells the person a run is already going.
 */
export function setupAgentPointerItem(
  input: { orgId: OrgId; project: string; taskId: string; requestId: string; requestedBy: string; basedOnRevision: number; startedAt: string; limits: SetupAgentLimits; seenTaskId: string | undefined },
): TransactItem {
  return {
    kind: "put",
    item: {
      ...setupAgentKey(input.orgId, input.project), entityType: "SETUP_AGENT", orgId: input.orgId, project: input.project, taskId: input.taskId, requestId: input.requestId,
      requestedBy: input.requestedBy, basedOnRevision: input.basedOnRevision, startedAt: input.startedAt, limits: { ...input.limits },
    },
    condition: input.seenTaskId === undefined ? when.absent() : when.eq("taskId", input.seenTaskId),
  };
}

// ---- the view

export const SETUP_AGENT_STATUSES = ["none", "running", "ready", "failed"] as const;
export type SetupAgentStatus = (typeof SETUP_AGENT_STATUSES)[number];

/** What the routes answer. No owner, no raw worker answer. */
export interface SetupAgentView {
  status: SetupAgentStatus;
  basedOnRevision: number;
  /** The limits of the run (the ones it started with), or those a run would start with now when there is none. */
  limits: SetupAgentLimits;
  taskId?: string;
  startedAt?: string;
  /** The run's session, when it has one. */
  sessionId?: string;
  /** How the run ended. `proposed`, or a limit's word (a partial proposal), when `ready`. */
  stop?: SetupRunEndWord;
  summary?: SetupRunSummary;
  proposal?: SetupProposal;
  failure?: string;
  /** What re-reading the proposal's citations from the code host at the commits the run read found, per item (`holds`, `fails`, `unchecked`): the proposal is shown with these and never without them (`verifiedView`). `verified` says every verdict is final. */
  verification?: Record<string, SetupVerification>;
  verified?: boolean;
  /** Who pressed Stop and when, on a run a person stopped. The proposal such a run keeps is partial, unproven and never applied. */
  stoppedBy?: { name: string; at: string };
}

/** What a run may take at the longest: its wall clock, the longest wait on the owner, and an hour of grace for the end to be reported. Past it with no result the run reads as failed. */
function staleAfterMs(limits: SetupAgentLimits): number {
  return (limits.wallClockMin + SETUP_HOST_WAIT_MAX_HOURS * 60 + 60) * 60_000;
}

export interface SetupAgentReadDeps {
  store: Pick<DocumentStore, "get">;
  companyId: OrgId;
  now: () => number;
  /** The project's own setup-run limit setting, as stored (any shape: `effectiveSetupAgentLimits` reads it and never throws). */
  limitSetting?: ((project: string) => Promise<unknown>) | undefined;
  /** A person's name, for "stopped by <person>". Absent or throwing: "Unknown". */
  stopperName?: ((developerId: string) => Promise<string | undefined>) | undefined;
}

/** Where the project's run stands, read now. See the file header: the pointer, then the task. */
export async function setupAgentState(deps: SetupAgentReadDeps, project: string, latestRevision: number): Promise<SetupAgentView> {
  return (await readState(deps, project, latestRevision)).view;
}

export async function readState(deps: SetupAgentReadDeps, project: string, latestRevision: number): Promise<{ view: SetupAgentView; pointer?: SetupAgentPointer }> {
  const orgId = deps.companyId;
  const item = await deps.store.get(setupAgentKey(orgId, project));
  if (item === undefined || item["entityType"] !== "SETUP_AGENT" || item["orgId"] !== orgId) {
    return { view: { status: "none", basedOnRevision: latestRevision, limits: effectiveSetupAgentLimits(await deps.limitSetting?.(project)) } };
  }
  const pointer = item as unknown as SetupAgentPointer;
  // The limits the run started with. A pointer whose limits do not read is held to the defaults (never looser).
  const limits = effectiveSetupAgentLimits(pointer.limits);
  const base: Pick<SetupAgentView, "basedOnRevision" | "limits" | "taskId" | "startedAt" | "sessionId"> = { basedOnRevision: pointer.basedOnRevision, limits, taskId: pointer.taskId, startedAt: pointer.startedAt };
  const task = (await deps.store.get(taskKey(pointer.taskId))) as (StoredDocument & Partial<TaskRecord>) | undefined;
  // A run a person stopped says who and when; the name is read now, the person's stop is the task's own record.
  const failed = async (stop: SetupRunEndWord, failure: string, extra: Partial<SetupAgentView> = {}): Promise<{ view: SetupAgentView; pointer: SetupAgentPointer }> => {
    const stopper = stop === "stopped_by_person" ? task?.setupAgentStop : undefined;
    const stoppedBy = stopper === undefined ? {} : { stoppedBy: { name: oneLineText(await deps.stopperName?.(stopper.by).catch(() => undefined), 100) || "Unknown", at: stopper.at } };
    return { view: { status: "failed", ...base, stop, failure, ...extra, ...stoppedBy }, pointer };
  };
  if (task === undefined || (task.orgId ?? task.companyId) !== orgId || task.purpose !== "setup_agent") return failed("infrastructure", SETUP_AGENT_FAILURES.stale);
  if (typeof task.sessionId === "string") base.sessionId = task.sessionId;
  const result = task.setupAgentResult;
  if (result?.status === "ready") return { view: { status: "ready", ...base, stop: result.stop, summary: result.summary, proposal: result.proposal }, pointer };
  if (result?.status === "failed") return failed(result.stop, result.failure, { ...(result.summary === undefined ? {} : { summary: result.summary }), ...(result.proposal === undefined ? {} : { proposal: result.proposal }) });
  // A person's stop only when one was recorded; a task closed or cancelled any other way is a run that could not go on.
  const cancelledWord = task.setupAgentStop === undefined ? ({ stop: "infrastructure", failure: SETUP_AGENT_FAILURES.infrastructure } as const) : ({ stop: "stopped_by_person", failure: SETUP_AGENT_FAILURES.stopped_by_person } as const);
  if (task.closedAt !== undefined) return failed(cancelledWord.stop, cancelledWord.failure);
  const workspace = await deps.store.get(workspaceKey(task.workspaceId as string));
  if (workspace?.["status"] === "PREPARATION_FAILED") return failed("infrastructure", SETUP_AGENT_FAILURES.machine);
  if (workspace?.["status"] === "CLOSED") return failed(cancelledWord.stop, cancelledWord.failure);
  const taskPointer = await deps.store.get(taskPointerKey(task.workspaceId as string));
  if (taskPointer?.["cancelledAt"] !== undefined) return failed(cancelledWord.stop, cancelledWord.failure);
  const started = Date.parse(pointer.startedAt);
  if (Number.isFinite(started) && deps.now() - started > staleAfterMs(limits)) return failed("infrastructure", SETUP_AGENT_FAILURES.stale);
  return { view: { status: "running", ...base }, pointer };
}

// ---- the task's end

/** The repositories a setup run's proposal is read against: the project's own names (and the meta repository's, when it has one) and their addresses. */
export interface SetupRepositories { names: string[]; urls: Record<string, string>; meta?: string | undefined }

/** What the run's operation ended with. */
export interface SetupAgentEndOutcome { status: string; result: unknown; error: string | undefined; repositories: SetupRepositories }

type StoredResult = NonNullable<TaskRecord["setupAgentResult"]>;

/**
 * Every citation is read at the commit the broker recorded for its repository, never at one the worker or the model names: `sanitizeSetupProposal` replaces a citation's commit with the repository's. A repository
 * with no recorded commit leaves no proposal at all (there would be nothing to re-read it against).
 */
function recordedCommits(task: Pick<TaskRecord, "preparedBase">, repositories: SetupRepositories): Map<string, string> | undefined {
  const recorded = new Map((task.preparedBase ?? []).map((entry) => [entry.repositoryId, entry.baseCommitSha]));
  return repositories.names.length > 0 && repositories.names.every((name) => recorded.has(name)) ? recorded : undefined;
}

function readProposal(reported: unknown, task: Pick<TaskRecord, "startingRevision" | "preparedBase">, repositories: SetupRepositories): SetupProposal | undefined {
  const commits = recordedCommits(task, repositories);
  if (commits === undefined) return undefined;
  const reportedMeta = typeof reported === "object" && reported !== null ? (reported as { metaRepo?: { name?: unknown; commit?: unknown } }).metaRepo : undefined;
  const metaRepo = repositories.meta !== undefined && reportedMeta?.name === repositories.meta && typeof reportedMeta.commit === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(reportedMeta.commit)
    ? { name: repositories.meta, commit: reportedMeta.commit } : undefined;
  const read = sanitizeSetupProposal(reported, {
    basedOnRevision: task.startingRevision,
    repositories: repositories.names.map((name) => ({ name, commit: commits.get(name), ...(repositories.urls[name] === undefined ? {} : { url: repositories.urls[name] }) })),
    ...(metaRepo === undefined ? {} : { metaRepo }),
  });
  return read.ok ? read.proposal : undefined;
}

/** What the worker said, read again: `{ setupProposal, setupRunSummary }`. Either part may be missing or unreadable. */
function readWorkerAnswer(result: unknown, task: Pick<TaskRecord, "startingRevision" | "preparedBase">, repositories: SetupRepositories): { proposal?: SetupProposal; summary?: SetupRunSummary } {
  const answer = typeof result === "object" && result !== null ? (result as { setupProposal?: unknown; setupRunSummary?: unknown }) : {};
  const proposal = answer.setupProposal === undefined ? undefined : readProposal(answer.setupProposal, task, repositories);
  const summary = answer.setupRunSummary === undefined ? undefined : SetupRunSummarySchema.safeParse(answer.setupRunSummary);
  return { ...(proposal === undefined ? {} : { proposal }), ...(summary?.success === true ? { summary: summary.data } : {}) };
}

/** A person's stop: the fixed sentence, the proposal the run had (re-read by the caller) and its summary, marked stopped and partial. Nothing here proves or applies anything. */
function personStopped(
  failed: (stop: SetupRunEndWord, failure: string, learned?: { proposal?: SetupProposal; summary?: SetupRunSummary }) => StoredResult,
  learned: { proposal?: SetupProposal; summary?: SetupRunSummary },
): StoredResult {
  const summary = learned.summary === undefined ? undefined : SetupRunSummarySchema.parse({ ...learned.summary, stop: "stopped_by_person", partial: true });
  return failed("stopped_by_person", SETUP_AGENT_FAILURES.stopped_by_person, { ...(learned.proposal === undefined ? {} : { proposal: learned.proposal }), ...(summary === undefined ? {} : { summary }) });
}

/** The result for an outcome: which stop word, which fixed sentence, and what the run learned. Pure. */
export function resultOf(task: Pick<TaskRecord, "startingRevision" | "preparedBase" | "setupAgentStop">, operation: { kind: string }, outcome: SetupAgentEndOutcome): StoredResult {
  const failed = (stop: SetupRunEndWord, failure: string, learned: { proposal?: SetupProposal; summary?: SetupRunSummary } = {}): StoredResult => ({
    status: "failed", stop, failure, ...(learned.proposal === undefined ? {} : { proposal: learned.proposal }), ...(learned.summary === undefined ? {} : { summary: learned.summary }),
  });
  if (operation.kind === "prepare") return failed("infrastructure", SETUP_AGENT_FAILURES.machine);
  const learned = readWorkerAnswer(outcome.result, task, outcome.repositories);
  // What the run learned before it was cut short is kept: the proposal and its summary.
  const kept = { ...(learned.proposal === undefined ? {} : { proposal: learned.proposal }), ...(learned.summary === undefined ? {} : { summary: learned.summary }) };
  // A cancel is a person's stop only when Stop was pressed (recorded on the task before the cancel). Any other cancel (a sweep, a closed workspace) is a run that could not go on.
  if (outcome.status === "CANCELLED" && task.setupAgentStop !== undefined) return personStopped(failed, learned);
  // The worker may finish and report its partial proposal when it is stopped, so its answer can arrive as a normal end. With a stop recorded, an answer that says the run was cut short (the worker's own word for an abort
  // is `infrastructure`) or says nothing readable is the person's stop; an answer that finished by itself (a proposal, a limit, a code change needed, changed files) stands as the worker said it.
  if (task.setupAgentStop !== undefined && outcome.status === "SUCCEEDED" && (learned.summary === undefined || learned.summary.stop === "infrastructure")) return personStopped(failed, learned);
  if (outcome.status !== "SUCCEEDED") {
    const stop = outcome.status !== "CANCELLED" && outcome.error === BUDGET_EXHAUSTED_FAILURE_MESSAGE ? "budget_used" : "infrastructure";
    return failed(stop, SETUP_AGENT_FAILURES[stop], kept);
  }
  const { proposal, summary } = learned;
  // The worker ended the run itself without a person's stop (a fault): what it learned is kept, with the fixed sentence for a run that could not go on.
  if (summary?.stop === "infrastructure") return failed("infrastructure", SETUP_AGENT_FAILURES.infrastructure, kept);
  if (summary === undefined || !WORKER_STOPS.has(summary.stop)) return failed("infrastructure", SETUP_AGENT_FAILURES.unreadable);
  // Two stops mean there is nothing to confirm: setup needs a code change, or it changed tracked files (which are never kept).
  if (summary.stop === "needs_code_change") return failed("needs_code_change", SETUP_AGENT_FAILURES.needs_code_change, { summary });
  if (summary.stop === "changed_repository_files") return failed("changed_repository_files", SETUP_AGENT_FAILURES.changed_repository_files, { summary });
  if (proposal === undefined) {
    // A limit stop with nothing a person could use still says which limit it was; any other answer without a proposal is unreadable.
    return isSetupRunLimitStop(summary.stop) ? failed(summary.stop, SETUP_AGENT_FAILURES[summary.stop], { summary }) : failed("infrastructure", SETUP_AGENT_FAILURES.unreadable);
  }
  return { status: "ready", proposal, summary, stop: summary.stop };
}

/**
 * The write that ends a setup-agent task, made when its operation has ended (the task flow's end hook): its `agentRunEnd` and `setupAgentResult`. Each attribute keeps the first value (`setIfAbsent`), so a result is
 * never refused because the project's pointer moved and a late or repeated end changes nothing. A task that is not a setup run, or an operation that is not the run's own (or its preparation failing), writes nothing.
 */
export async function recordSetupAgentEnd(
  deps: { store: Pick<DocumentStore, "update"> }, task: TaskRecord, operation: { kind: string; workflowMode?: string | undefined },
  outcome: SetupAgentEndOutcome, now: string,
): Promise<boolean> {
  if (task.purpose !== "setup_agent") return false;
  const own = operation.kind === "task" && operation.workflowMode === SETUP_AGENT_WORKFLOW_MODE;
  const prepareFailed = operation.kind === "prepare" && outcome.status !== "SUCCEEDED";
  if (!own && !prepareFailed) return false;
  const result = resultOf(task, operation, outcome);
  const state = result.status === "ready" ? "COMPLETE" : outcome.status === "CANCELLED" ? "CANCELLED" : "FAILED";
  const written = await deps.store.update({
    key: taskKey(task.taskId),
    ops: [change.setIfAbsent("agentRunEnd", { state, at: now }), change.setIfAbsent("setupAgentResult", JSON.parse(JSON.stringify(result)) as JsonValue), change.set("updatedAt", now)],
    condition: when.present(),
  });
  return written.applied;
}

/**
 * What a setup run's invocation carries: the limits it started with, read again through the contract, and the commits the broker recorded when the preparation reported. Without a record there are no commits and the
 * worker refuses the run.
 */
export function setupAgentWireOf(task: Pick<TaskRecord, "setupAgentLimits" | "preparedBase"> | undefined): SetupAgentWire {
  const commits = task?.preparedBase?.map((entry) => ({ repository: entry.repositoryId, commit: entry.baseCommitSha }));
  return { limits: effectiveSetupAgentLimits(task?.setupAgentLimits), ...(commits === undefined || commits.length === 0 ? {} : { commits }) };
}

// ---- routes' logic

/** The task flow's start and cancel, as a setup run uses them. */
export interface SetupAgentStarter {
  /** Starts the run as the owner. A repeat of `request.requestId` answers the first run's task and starts nothing. A pointer that moved (another run began) is `WORKSPACE_BUSY`. */
  start(request: { requestId: string; project: string; text: string; limits: SetupAgentLimits; seenTaskId: string | undefined }): Promise<{ taskId: string; duplicate: boolean }>;
  /** Cancels the run's task (the task flow's own cancel). A task that is already over is left as it is. */
  cancel(request: { taskId: string; requestId: string }): Promise<void>;
}

/** What the setup flow reads of a project's revision: its repositories as the registered records say (the address, and the code host that serves it). */
export interface SetupDefinition { repositories: ReadonlyArray<{ name: string; url: string; host?: { kind: string } | undefined }> }

export interface SetupAgentDeps extends SetupAgentReadDeps {
  store: DocumentStore;
  /** Undefined where tasks are not set up. */
  starter: SetupAgentStarter | undefined;
  /** The project's latest revision, or undefined for no such project. */
  latest(project: string): Promise<{ revision: number; definition: SetupDefinition } | undefined>;
  /** An archived project takes no new work. */
  requireNewWork?(project: string): Promise<void>;
  /** The code host's file read at a commit, for re-reading the proposal's citations. Absent: every item is `unchecked`. */
  readFile?: ((repository: SetupDefinition["repositories"][number], path: string, commit: string, options: { untilLine?: number; timeoutMs: number }) => Promise<string | undefined>) | undefined;
  /** The install has a model proxy, which meters and prices a setup run. Without it a run is refused. */
  modelAccessConfigured?: boolean | undefined;
}

const bodyError = (error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }) => {
  const issue = error.issues[0];
  // Field names only: the values are the person's.
  return agentXError("CONFIG_INVALID", `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
};

/** A request id for a request this one makes in turn (the stop), the same every time this one is repeated. */
function derivedRequestId(requestId: string, purpose: string): string {
  const hex = createHash("sha256").update(`rovara-setup-agent\0${purpose}\0${requestId}`, "utf8").digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The view with its proposal re-read: every citation of the run's proposal is read again from the code host at the commit the run read (the agent worked in a tree it could write, so what it cites is checked against
 * the repository, not against its workspace). The verdicts are kept on the task once final. A view with no proposal is returned as it is; with no reader, every item is `unchecked`.
 */
export async function verifiedView(deps: SetupAgentDeps, definition: SetupDefinition, view: SetupAgentView): Promise<SetupAgentView> {
  if (view.proposal === undefined || view.taskId === undefined) return view;
  const task = await deps.store.get(taskKey(view.taskId));
  const kept = task?.["setupAgentVerification"] as { items?: Record<string, SetupVerification> } | undefined;
  if (kept?.items !== undefined) return { ...view, verification: kept.items, verified: true };
  const recordOf = new Map(definition.repositories.map((repository) => [repository.name, repository]));
  const reader: CitationFileReader | undefined = deps.readFile === undefined ? undefined : async (repository, path, commit, options) => {
    const record = recordOf.get(repository);
    if (record === undefined) throw new Error("unknown repository");
    return deps.readFile!(record, path, commit, options);
  };
  const { items, final } = await verifyProposalDetailed(reader, view.proposal, { now: deps.now });
  if (final) {
    await deps.store.update({
      key: taskKey(view.taskId), ops: [change.set("setupAgentVerification", { at: new Date(deps.now()).toISOString(), items: JSON.parse(JSON.stringify(items)) as JsonValue })],
      condition: when.and(when.present(), when.notExists("setupAgentVerification")),
    });
  }
  return { ...view, verification: items, verified: final };
}

/**
 * `POST /v1/app/projects/{name}/setup-agent`: asks Rovara to set the project up by running its commands. A repeat of the request id answers the first request and starts nothing; one run goes at a time
 * (`WORKSPACE_BUSY`); the run is a task like any other and limited by the run's own limits.
 */
export async function startSetupAgent(deps: SetupAgentDeps, project: string, rawBody: unknown): Promise<{ status: 200 | 202; view: SetupAgentView }> {
  const parsed = SetupAgentStartBodySchema.safeParse(rawBody);
  if (!parsed.success) throw bodyError(parsed.error);
  const { requestId } = parsed.data;
  if (deps.starter === undefined) throw agentXError("NOT_FOUND", "setting up a project with Rovara is not set up in this deployment");
  // A setup run spends model money by the minute: it needs the model proxy that meters it (and the price table the worker stops it by).
  if (deps.modelAccessConfigured !== true) throw agentXError("NOT_FOUND", "setting up a project with Rovara needs this installation's model proxy");
  const latest = await deps.latest(project);
  if (latest === undefined) throw agentXError("PROJECT_NOT_FOUND", `project \`${project}\` doesn't exist`);
  const limits = effectiveSetupAgentLimits(await deps.limitSetting?.(project));
  const starter = deps.starter;
  const text = setupAgentRequestText(project);
  const before = await readState(deps, project, latest.revision);
  // A repeat of a request already made is answered from the run's own record.
  const previous = before.pointer?.requestId === requestId ? before.pointer : undefined;
  if (previous !== undefined) {
    await starter.start({ requestId, project, text, limits, seenTaskId: undefined });
    return { status: 200, view: await verifiedView(deps, latest.definition, await setupAgentState(deps, project, latest.revision)) };
  }
  await deps.requireNewWork?.(project);
  if (before.view.status === "running") throw agentXError("WORKSPACE_BUSY", SETUP_AGENT_BUSY);
  try {
    await starter.start({ requestId, project, text, limits, seenTaskId: before.pointer?.taskId });
  } catch (error) {
    // The pointer moved between the read and the write: another run started first.
    if (error instanceof Error && "code" in error && (error as { code?: unknown }).code === "WORKSPACE_BUSY" && (await setupAgentState(deps, project, latest.revision)).status === "running") throw agentXError("WORKSPACE_BUSY", SETUP_AGENT_BUSY);
    throw error;
  }
  return { status: 202, view: await verifiedView(deps, latest.definition, await setupAgentState(deps, project, latest.revision)) };
}

/** `GET /v1/app/projects/{name}/setup-agent`: where the project's run stands. */
export async function getSetupAgent(deps: SetupAgentDeps, project: string): Promise<SetupAgentView> {
  const latest = await deps.latest(project);
  if (latest === undefined) throw agentXError("PROJECT_NOT_FOUND", `project \`${project}\` doesn't exist`);
  return verifiedView(deps, latest.definition, await setupAgentState(deps, project, latest.revision));
}

/**
 * `POST /v1/app/projects/{name}/setup-agent/stop`: stops the project's running setup run. What the run learned so far is kept when the worker reports it. Nothing is cancelled when no run is going: the state is answered as it is.
 * A repeat of the request id cancels the same way.
 */
export async function stopSetupAgent(deps: SetupAgentDeps, project: string, rawBody: unknown, stoppedBy: string): Promise<{ status: 200 | 202; view: SetupAgentView }> {
  const parsed = SetupAgentStopBodySchema.safeParse(rawBody);
  if (!parsed.success) throw bodyError(parsed.error);
  const latest = await deps.latest(project);
  if (latest === undefined) throw agentXError("PROJECT_NOT_FOUND", `project \`${project}\` doesn't exist`);
  const state = await readState(deps, project, latest.revision);
  // A run that reads as stale ("failed", never reported an end) may still have a live task: Stop reaches it too, so the owner is never left with a run they cannot end.
  const staleButLive = state.view.status === "failed" && state.view.failure === SETUP_AGENT_FAILURES.stale && state.view.summary === undefined;
  if ((state.view.status !== "running" && !staleButLive) || state.pointer === undefined) return { status: 200, view: await verifiedView(deps, latest.definition, state.view) };
  if (deps.starter === undefined) throw agentXError("NOT_FOUND", "setting up a project with Rovara is not set up in this deployment");
  // Who pressed Stop is written BEFORE the cancel (the first stop stands), so the end can tell a person's stop from a cancel the system made; a write that fails cancels nothing.
  await deps.store.update({
    key: taskKey(state.pointer.taskId), ops: [change.setIfAbsent("setupAgentStop", { by: stoppedBy, at: new Date(deps.now()).toISOString() })], condition: when.present(),
  });
  await deps.starter.cancel({ taskId: state.pointer.taskId, requestId: derivedRequestId(`${state.pointer.taskId}|${parsed.data.requestId}`, "stop") });
  return { status: 202, view: await verifiedView(deps, latest.definition, await setupAgentState(deps, project, latest.revision)) };
}

