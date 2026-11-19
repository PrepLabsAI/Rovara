// The chain runner. A run is the owner's (or an event's, or a schedule's) start of a published chain version. Each agent step is a run of its own pinned agent, started through the one unattended door
// (`startUnattendedRun`: the switch, `Admission`, the host's starter) with only that step's instructions and the earlier reports as information (`handoff.ts`); each step's end comes back through `onStepEnded`,
// and `advanceChainRun` is the one place the run moves.
//
// The rules that keep it correct:
//   - Every state change is ONE transaction with its event and the run's `eventSeq` and `version`, conditional on the version that was read; a lost race re-reads.
//   - Nothing is written before the start's transaction, and the chain's open-run count, both indexes and the open row go in it. A chain holds at most `CHAIN_MAX_CONCURRENT_RUNS` runs at once, a run at most
//     `CHAIN_MAX_STEP_RUNS` step starts, and an edge back is taken at most its `maxTraversals`.
//   - A step's attempt is written `starting` BEFORE the start is called, with a request id derived from the run and the attempt, so a crash leaves an attempt that `advanceChainRun` drives again to the SAME task,
//     never a second one.
//   - A gate waits for the owner and nobody else: a run, a step's report and a model never decide it. A gate that is not decided in time takes its reject edge.
//   - Text a person is shown from a task (a failure reason) is neutralised; text that goes to another agent is redacted (`handoff.ts`).
import { createHash } from "node:crypto";
import {
  AgentXError, CHAIN_MAX_CONCURRENT_RUNS, CHAIN_MAX_STEP_RUNS, CHAIN_RUN_MAX_HOURS, CHAIN_START_INPUT_MAX, ChainRunStartedBySchema, GATE_DEFAULT_TIMEOUT_HOURS, STEP_DEFAULT_TIMEOUT_MINUTES, StepResultSchema, agentXError, canonicalJson,
  change, chainKey, chainRunKey, recipeDigest, chainRunsByChainKey, chainRunsByProjectKey, newPrefixedId, openChainRunKey, orgScoped, queryAll, shortenToBytes, stepSk, when,
  type AgentId, type ChainId, type ChainRunId, type ChainRunStartedBy, type ChainRunStatus, type OrgId, type PinnedChainDefinition, type StepAttemptStatus, type StepResult, type TransactItem,
} from "@agentx/contracts";
import { coded, errorName, iso, putRow, strip, text, updateRow, type Item, type Table } from "../automation/kit.js";
import { startUnattendedRun, type AutomatedOrigin, type UnattendedStartDeps } from "../automation/run-seam.js";
import { resolveAgentForAutonomousRun, type RosterDependencies } from "../agents/roster.js";
import { chooseEdge, takeEdge } from "./branches.js";
import { buildHandoff, HandoffTriggerSchema, redactSecrets, type EarlierReport, type HandoffTrigger } from "./handoff.js";
import { neutralText, runEventItems, type RunEventInput } from "./run-events.js";
import type { ChainStore } from "./store.js";

// ---- records

const TERMINAL: ReadonlySet<string> = new Set<ChainRunStatus>(["succeeded", "failed", "cancelled", "timed_out"]);
export const isTerminalStatus = (status: string): boolean => TERMINAL.has(status);
export type EndStatus = "succeeded" | "failed" | "cancelled" | "timed_out";
export interface ChainRunFailure { seq?: number; reason: string; message: string }

/** META of a chain run, at `chainRunKey(orgId, runId, "META")`. */
export interface ChainRunRecord {
  orgId: OrgId;
  runId: ChainRunId;
  chainId: ChainId;
  chainName: string;
  chainVersion: number;
  project: string;
  /** Who owns this run: the owner. */
  owner: { developerId: string };
  startedBy: ChainRunStartedBy;
  origin: AutomatedOrigin | "app" | "cli" | "mcp";
  status: ChainRunStatus;
  currentSeq: number;
  eventSeq: number;
  stepRuns: number;
  traversals: Record<string, number>;
  /** The most one run may spend (US dollars), from the design's limits; absent when the design sets none. */
  runLimitUsd?: number;
  /** What the run's steps are counted to have spent (US dollars): each ended step adds what the install says it cost, or, with no figure, the whole share it was granted. */
  spentUsd?: number;
  input?: string;
  trigger?: HandoffTrigger;
  version: number;
  createdAt: string;
  updatedAt: string;
  /** When the sweep next looks at the run; the open row's key holds the same instant. */
  dueAt: string;
  endedAt?: string;
  failure?: ChainRunFailure;
  cancelledBy?: string;
}

export interface StepAttemptRecord {
  seq: number;
  stepId: string;
  stepName: string;
  kind: "agent" | "gate";
  attempt: number;
  status: StepAttemptStatus;
  agent?: { agentId: AgentId; name: string; version: number };
  taskId?: string;
  /** The share of the run's dollar limit this step was started with. */
  grantedUsd?: number;
  /** When the sweep last saw the step's task waiting for the owner: its minutes are counted from here, since the owner's approval is not the step's time. */
  timeoutBase?: string;
  inputDigest: string;
  startedAt: string;
  endedAt?: string;
  result?: StepResult;
  failure?: { reason: string; message: string };
  branch?: { id: string; fellBack: boolean };
  decision?: "approved" | "declined";
  retriesUsed?: number;
}

/** What the runner needs. */
export interface ChainRunnerDeps extends Table {
  companyId: OrgId;
  chains: ChainStore;
  roster: RosterDependencies;
  unattended: UnattendedStartDeps;
  /** Asks the host to stop a task (best effort). */
  cancelTask?: ((taskId: string) => Promise<void>) | undefined;
  /** Whether a step's task is still open. Absent: it is not known, and a step whose task cannot be shown closed is never run again. */
  taskOpen?: ((taskId: string) => Promise<boolean>) | undefined;
  /** Whether a step's task waits for the owner (their approval is not the step's time). */
  taskWaiting?: ((taskId: string) => Promise<boolean>) | undefined;
  /** What a step's task actually cost, when the install can tell (US dollars). */
  stepSpendUsd?: ((taskId: string) => Promise<number | undefined>) | undefined;
  log?: ((event: string, fields: Record<string, unknown>) => void) | undefined;
}

const FIRST_LOOK_MS = 60_000;
const RUN_ATTEMPTS = 4;
const STALE_START_MS = 120_000;
const logOf = (deps: Pick<ChainRunnerDeps, "log">) => deps.log ?? ((event: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ component: "broker", event, ...fields })));

export const runKey = (run: Pick<ChainRunRecord, "orgId" | "runId">) => chainRunKey(run.orgId, run.runId, "META");
const attemptKey = (run: Pick<ChainRunRecord, "orgId" | "runId">, seq: number) => chainRunKey(run.orgId, run.runId, stepSk(seq));
/** The pointer from a step's task back to its run (a Code-only row: the hosted product finds the run from its task record). */
const stepTaskKey = (orgId: OrgId, taskId: string) => ({ pk: orgScoped(orgId, `CHAIN_STEP_TASK#${taskId}`), sk: "META" });

export async function readChainRun(table: Table, orgId: OrgId, runId: ChainRunId): Promise<ChainRunRecord | undefined> {
  const item = await table.store.get(chainRunKey(orgId, runId, "META"));
  return item === undefined || item["orgId"] !== orgId ? undefined : (strip(item as Item) as unknown as ChainRunRecord);
}
export async function readStepAttempts(table: Table, orgId: OrgId, runId: ChainRunId): Promise<StepAttemptRecord[]> {
  const rows = await queryAll(table.store, { pk: chainRunKey(orgId, runId, "META").pk, sk: { op: "beginsWith", prefix: "STEP#" } });
  return rows.map((row) => strip(row as Item) as unknown as StepAttemptRecord).sort((a, b) => a.seq - b.seq);
}

/** The request id a step's start carries: a UUID shaped from the run and the sequence number, so a repeat of the start is the first one's run. */
export function stepRequestId(runId: string, seq: number): string {
  const hash = createHash("sha1").update(Buffer.from("c3a1f0d2b4e54a6f9d8e7c6b5a493827", "hex")).update(`${runId}\0${String(seq)}`).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type PinnedStep = PinnedChainDefinition["steps"][number];
type PinnedAgentStep = Extract<PinnedStep, { kind: "agent" }>;
const stepOf = (definition: PinnedChainDefinition, stepId: string): PinnedStep | undefined => definition.steps.find((step) => step.id === stepId);

// ---- one move of a run

/** The items that move a run: its META (conditional on the version read) and its events. */
function moveRun(table: Table, run: ChainRunRecord, fields: Record<string, unknown>, events: readonly RunEventInput[]): TransactItem[] {
  const at = iso(table);
  const written = runEventItems(run, events, at);
  return [updateRow(runKey(run), { set: { ...fields, eventSeq: written.eventSeq, version: run.version + 1, updatedAt: at }, condition: when.eq("version", run.version) }), ...written.items];
}

/** The items that end a run: its status, the chain's open-run count back, the open row gone and the end event. */
function endRunItems(table: Table, run: ChainRunRecord, ended: { status: EndStatus; failure?: ChainRunFailure; events: RunEventInput[]; fields?: Record<string, unknown> }): TransactItem[] {
  const at = iso(table);
  return [
    ...moveRun(table, run, { status: ended.status, endedAt: at, ...(ended.failure === undefined ? {} : { failure: ended.failure }), ...(ended.fields ?? {}) }, [...ended.events, { type: "ended", text: ended.status }]),
    { kind: "update", key: chainKey(run.orgId, run.chainId, "META"), ops: [change.add(["openRuns"], -1)], condition: when.gt("openRuns", 0) },
    { kind: "delete", key: openChainRunKey(run.dueAt, run.orgId, run.runId) },
  ];
}

async function transactRun(table: Table, items: readonly TransactItem[]): Promise<boolean> {
  const result = await table.store.transact(items);
  return result.applied;
}

async function designOf(deps: ChainRunnerDeps, run: ChainRunRecord): Promise<PinnedChainDefinition> {
  const version = await deps.chains.getVersion(run.orgId, run.chainId, run.chainVersion);
  if (version === undefined) throw coded("CHAIN_UNAVAILABLE", `${run.chainName} version ${String(run.chainVersion)} can't be read`);
  return version.definition;
}

// ---- the start

export interface StartChainRunInput {
  orgId: OrgId;
  chainId: ChainId;
  project: string;
  origin: ChainRunRecord["origin"];
  startedBy: ChainRunStartedBy;
  /** The run's own id; absent for a run a person starts (a new one is made). An event or schedule start gives a derived id so the same event is the same run. */
  runId?: ChainRunId;
  input?: string;
  trigger?: HandoffTrigger;
  /** The owner the run is for. */
  owner: { developerId: string };
}

/**
 * Starts a run of a chain's current published version: the chain is active and published, every agent step resolves at its pinned version for the project (guardrails and the project's rules), the chain has room
 * for another run, then one transaction writes the run, its indexes, its open row, the chain's open-run count and its first event, and the run moves to its first step. The same run id is the same run: a repeat answers the stored run
 * and writes nothing.
 */
export async function startChainRun(deps: ChainRunnerDeps, input: StartChainRunInput): Promise<ChainRunRecord> {
  if ((input.input !== undefined) && [...input.input].length > CHAIN_START_INPUT_MAX) throw agentXError("CONFIG_INVALID", `input: must be at most ${String(CHAIN_START_INPUT_MAX)} characters`);
  const started = ChainRunStartedBySchema.safeParse(input.startedBy);
  if (!started.success) throw agentXError("CONFIG_INVALID", `startedBy: ${started.error.issues[0]?.message ?? "is not valid"}`);
  if ((input.origin === "event" || input.origin === "schedule") && input.startedBy.kind !== input.origin) throw agentXError("CONFIG_INVALID", `origin: a run started by ${input.origin === "event" ? "an event" : "a schedule"} says so`);
  const trigger = input.trigger === undefined ? undefined : HandoffTriggerSchema.parse(input.trigger);
  const runId = input.runId ?? (newPrefixedId("crn"));
  const stored = await readChainRun(deps, input.orgId, runId);
  if (stored !== undefined) return stored;
  const chain = await deps.chains.get(input.orgId, input.chainId);
  if (chain === undefined) throw agentXError("NOT_FOUND", "no chain has that ID");
  if (chain.status !== "active") throw agentXError("CHAIN_UNAVAILABLE", `${chain.name} is archived, so it can't start new runs.`);
  if (chain.currentVersion === undefined) throw agentXError("CHAIN_UNAVAILABLE", `${chain.name} has no published version yet, so it can't start new runs.`);
  const version = await deps.chains.getVersion(input.orgId, chain.chainId, chain.currentVersion);
  if (version === undefined) throw agentXError("CHAIN_UNAVAILABLE", `${chain.name} has no published version yet, so it can't start new runs.`);
  // Every agent step resolves at its pinned version on this project before anything is written.
  for (const step of version.definition.steps) {
    if (step.kind !== "agent") continue;
    try {
      await resolveAgentForAutonomousRun(deps.roster, { orgId: input.orgId, project: input.project, agentId: step.agent.agentId, version: step.agent.version });
    } catch (error) {
      throw coded("CHAIN_UNAVAILABLE", `${chain.name}'s step "${step.name}" can't run now: ${error instanceof Error ? error.message.replace(/^[A-Z_]+: /u, "").replace(/\.+$/u, "") : "it can't run"}.`);
    }
  }
  const createdAt = iso(deps);
  const runLimitUsd = version.definition.limits?.maxRunUsd;
  const run: ChainRunRecord = {
    orgId: input.orgId, runId, chainId: chain.chainId, chainName: chain.name, chainVersion: version.version, project: input.project, owner: input.owner, startedBy: input.startedBy, origin: input.origin,
    status: "running", currentSeq: 0, eventSeq: 0, stepRuns: 0, traversals: {}, ...(runLimitUsd === undefined ? {} : { runLimitUsd }),
    ...(input.input === undefined ? {} : { input: input.input }), ...(trigger === undefined ? {} : { trigger }), version: 1, createdAt, updatedAt: createdAt, dueAt: new Date(deps.now() + FIRST_LOOK_MS).toISOString(),
  };
  const events = runEventItems(run, [{ type: "started", text: `${chain.name} version ${String(version.version)} started` }], createdAt);
  const items: TransactItem[] = [
    putRow(runKey(run), "CHAIN_RUN", { ...run, eventSeq: events.eventSeq }),
    { kind: "update", key: chainKey(input.orgId, chain.chainId, "META"), ops: [change.add(["openRuns"], 1)], condition: when.and(when.eq("status", "active"), when.eq("currentVersion", chain.currentVersion), when.or(when.notExists("openRuns"), when.lt("openRuns", CHAIN_MAX_CONCURRENT_RUNS))) },
    putRow(chainRunsByChainKey(input.orgId, chain.chainId, createdAt, runId), "CHAIN_RUN_BY_CHAIN", { orgId: input.orgId, runId }),
    putRow(chainRunsByProjectKey(input.orgId, input.project, createdAt, runId), "CHAIN_RUN_BY_PROJECT", { orgId: input.orgId, runId }),
    putRow(openChainRunKey(run.dueAt, input.orgId, runId), "OPEN_CHAIN_RUN", { orgId: input.orgId, runId }),
    ...events.items,
  ];
  const result = await deps.store.transact(items);
  if (!result.applied) {
    // A lost race on a run id the caller gave: the run that won is the answer.
    const winner = await readChainRun(deps, input.orgId, runId);
    if (winner !== undefined) return winner;
    const now = await deps.chains.get(input.orgId, chain.chainId);
    if (now === undefined) throw agentXError("NOT_FOUND", "no chain has that ID");
    if (now.status !== "active") throw agentXError("CHAIN_UNAVAILABLE", `${chain.name} is archived, so it can't start new runs.`);
    if (now.openRuns >= CHAIN_MAX_CONCURRENT_RUNS) throw agentXError("FORBIDDEN", `${chain.name} already has ${String(now.openRuns)} runs going. Wait for one to finish.`);
    throw coded("CHAIN_REVISION_CONFLICT", `${chain.name} changed while the run was starting; try again`);
  }
  // The first step. A start that could not be made now is left for the sweep; the run already exists.
  try {
    await advanceChainRun(deps, input.orgId, runId);
  } catch (error) {
    if (error instanceof AgentXError && error.statusCode < 500) throw error;
    logOf(deps)("chain_run.start_deferred", { runId, error: errorName(error) });
  }
  return (await readChainRun(deps, input.orgId, runId)) ?? run;
}

// ---- advancing

type Progress = "moved" | "waiting" | "done";

/** Moves the run as far as it can go without an outside event: into its first step, past an ended step, or into the drive of a step that was written but not started. Repeatable and safe to run twice. */
export async function advanceChainRun(deps: ChainRunnerDeps, orgId: OrgId, runId: ChainRunId): Promise<void> {
  for (let round = 0; round < 50; round += 1) {
    const progress = await advanceOnce(deps, orgId, runId);
    if (progress !== "moved") return;
  }
}

async function advanceOnce(deps: ChainRunnerDeps, orgId: OrgId, runId: ChainRunId): Promise<Progress> {
  for (let attempt = 0; attempt < RUN_ATTEMPTS; attempt += 1) {
    const run = await readChainRun(deps, orgId, runId);
    if (run === undefined) throw agentXError("NOT_FOUND", "no chain run has that ID");
    if (isTerminalStatus(run.status)) return "done";
    const definition = await designOf(deps, run);
    const attempts = await readStepAttempts(deps, orgId, runId);
    const last = attempts.find((candidate) => candidate.seq === run.currentSeq);
    try {
      if (last === undefined) return await enterStep(deps, run, attempts, definition, definition.start, undefined);
      if (last.status === "starting") return await driveStart(deps, run, last, attempts, definition);
      if (last.status === "succeeded" || last.status === "failed" || last.status === "cancelled" || last.status === "timed_out") return await afterAttempt(deps, run, last, attempts, definition);
      return "waiting";
    } catch (error) {
      if ((error as { raceMarker?: unknown } | null)?.raceMarker === true && attempt < RUN_ATTEMPTS - 1) continue;
      throw error;
    }
  }
  return "waiting";
}

const race = () => Object.assign(coded("CHANGE_STALE", "the run moved while it was being written"), { raceMarker: true });

async function commitMove(deps: ChainRunnerDeps, items: readonly TransactItem[]): Promise<void> {
  if (!(await transactRun(deps, items))) throw race();
}

/** Ends the run (failed, cancelled, timed out or succeeded) with its events. */
async function endRun(deps: ChainRunnerDeps, run: ChainRunRecord, ended: { status: EndStatus; failure?: ChainRunFailure; events?: RunEventInput[]; extra?: TransactItem[]; fields?: Record<string, unknown> }): Promise<Progress> {
  await commitMove(deps, [...endRunItems(deps, run, { status: ended.status, ...(ended.failure === undefined ? {} : { failure: ended.failure }), events: ended.events ?? [], ...(ended.fields === undefined ? {} : { fields: ended.fields }) }), ...(ended.extra ?? [])]);
  return "done";
}

/** What follows a step that ended: its edge (a result's branch or the design's default), or a retry, or the end of the run. */
async function afterAttempt(deps: ChainRunnerDeps, run: ChainRunRecord, ended: StepAttemptRecord, attempts: StepAttemptRecord[], definition: PinnedChainDefinition): Promise<Progress> {
  const step = stepOf(definition, ended.stepId);
  if (step === undefined) return endRun(deps, run, { status: "failed", failure: { seq: ended.seq, reason: "design_changed", message: `Step ${ended.stepId} is not in this chain's design` } });
  if (step.kind === "gate") {
    const edge = ended.decision === "approved" ? step.onApprove : step.onReject;
    return takeEdgeFrom(deps, run, attempts, definition, step.id, edge, ended.seq, ended.decision === "approved" ? "approved" : "declined");
  }
  if (ended.status === "succeeded" && ended.result !== undefined) {
    const chosen = chooseEdge(step.next, ended.result);
    if ("error" in chosen) return endRun(deps, run, { status: "failed", failure: { seq: ended.seq, reason: "branch_invalid", message: `Step "${step.name}" chose no branch this chain knows and has no default` } });
    return takeEdgeFrom(deps, run, attempts, definition, step.id, chosen.edge, ended.seq, chosen.branch === undefined ? "succeeded" : `chose ${chosen.branch}`);
  }
  const retriesAllowed = step.retries ?? 0;
  if (ended.status !== "cancelled" && (ended.retriesUsed ?? 0) < retriesAllowed) {
    // A retry never starts a second task beside one that may still be running: the earlier task is stopped and shown closed first, or the run ends.
    if (ended.taskId !== undefined && !(await taskClosed(deps, ended.taskId))) {
      return endRun(deps, run, { status: "failed", failure: { seq: ended.seq, reason: "step_task_open", message: `Step "${step.name}" was not started again: its earlier task could not be shown stopped` }, events: [{ type: "step_ended", stepSeq: ended.seq, text: `${step.name} ${ended.status}` }] });
    }
    return enterStep(deps, run, attempts, definition, step.id, { retryOf: ended });
  }
  return endRun(deps, run, { status: ended.status === "timed_out" ? "timed_out" : ended.status === "cancelled" ? "cancelled" : "failed", failure: { seq: ended.seq, reason: ended.failure?.reason ?? ended.status, message: neutralText(ended.failure?.message ?? `Step "${step.name}" ${ended.status}`) }, events: [{ type: "step_ended", stepSeq: ended.seq, text: `${step.name} ${ended.status}` }] });
}

/** Whether a step's task can be shown closed: stopped if it was open, and then asked again. A host that cannot say never shows it. */
async function taskClosed(deps: ChainRunnerDeps, taskId: string): Promise<boolean> {
  if (deps.taskOpen === undefined) return false;
  try {
    if (await deps.taskOpen(taskId)) {
      await deps.cancelTask?.(taskId);
      return !(await deps.taskOpen(taskId));
    }
    return true;
  } catch (error) {
    logOf(deps)("chain_run.task_check_failed", { taskId, error: errorName(error) });
    return false;
  }
}

/** The task of a step's attempt, even one that was written `starting` and whose task was made before the record of it was: the request id of the attempt finds it. */
async function taskOfAttempt(deps: ChainRunnerDeps, run: Pick<ChainRunRecord, "runId">, attempt: StepAttemptRecord): Promise<string | undefined> {
  return attempt.taskId ?? (await deps.unattended.starter.read(stepRequestId(run.runId, attempt.seq)).catch(() => undefined))?.taskId;
}

async function takeEdgeFrom(deps: ChainRunnerDeps, run: ChainRunRecord, attempts: StepAttemptRecord[], definition: PinnedChainDefinition, from: string, edge: { to: string; maxTraversals?: number | undefined }, seq: number, said: string): Promise<Progress> {
  const taken = takeEdge(run, from, edge);
  if (!taken.ok) return endRun(deps, run, { status: "failed", failure: { seq, reason: "too_many_traversals", message: taken.message } });
  const events: RunEventInput[] = [{ type: "branch", stepSeq: seq, text: `${said}; next: ${edge.to}` }];
  if (edge.to === "$end") return endRun(deps, run, { status: "succeeded", events, fields: { traversals: taken.traversals } });
  return enterStep(deps, { ...run, traversals: taken.traversals }, attempts, definition, edge.to, { events });
}

type Entry = { retryOf: StepAttemptRecord } | { events: RunEventInput[] } | undefined;

function stepInput(run: ChainRunRecord, step: PinnedAgentStep, attempts: readonly StepAttemptRecord[], seq: number): { text: string; context: ReturnType<typeof buildHandoff> } {
  const earlier: EarlierReport[] = attempts.filter((candidate) => candidate.seq < seq && candidate.kind === "agent" && candidate.status === "succeeded" && candidate.result !== undefined)
    .map((candidate) => ({ stepName: candidate.stepName, ...(candidate.agent === undefined ? {} : { agentName: candidate.agent.name }), result: candidate.result! }) as unknown as EarlierReport);
  const text = [step.instructions ?? "Do your job for this run.", run.input === undefined ? undefined : `The run's request: ${run.input}`].filter((part): part is string => part !== undefined).join("\n\n");
  return { text, context: buildHandoff({ runId: run.runId, ...(run.trigger === undefined ? {} : { trigger: run.trigger }), ...(run.input === undefined ? {} : { input: run.input }), earlier, mode: step.handoff ?? "previous" }) };
}

/** Writes the next attempt (`starting` for an agent step, `waiting` for a gate) together with the run's move, then drives the start. */
async function enterStep(deps: ChainRunnerDeps, run: ChainRunRecord, attempts: StepAttemptRecord[], definition: PinnedChainDefinition, stepId: string, via: Entry): Promise<Progress> {
  const step = stepOf(definition, stepId);
  if (step === undefined) return endRun(deps, run, { status: "failed", failure: { reason: "design_changed", message: `Step ${stepId} is not in this chain's design` } });
  if (run.stepRuns + 1 > CHAIN_MAX_STEP_RUNS) return endRun(deps, run, { status: "failed", failure: { reason: "too_many_steps", message: `This run has started ${String(CHAIN_MAX_STEP_RUNS)} steps, the most a run may` } });
  // The run has a limit on how long it may take.
  const maxHours = Math.min(definition.limits?.maxRunHours ?? CHAIN_RUN_MAX_HOURS, CHAIN_RUN_MAX_HOURS);
  if (deps.now() - Date.parse(run.createdAt) > maxHours * 3_600_000) return endRun(deps, run, { status: "timed_out", failure: { reason: "run_timeout", message: `This run took longer than ${String(maxHours)} hours` } });
  const seq = run.currentSeq + 1;
  const at = iso(deps);
  const visits = attempts.filter((candidate) => candidate.stepId === stepId).length + 1;
  const retry = via !== undefined && "retryOf" in via ? via.retryOf : undefined;
  let agent: StepAttemptRecord["agent"];
  let inputDigest: string;
  if (step.kind === "agent") {
    inputDigest = createHash("sha256").update(canonicalJson({ stepId, input: stepInput(run, step, attempts, seq).text })).digest("hex");
    agent = { agentId: step.agent.agentId, name: step.agent.agentId, version: step.agent.version };
  } else inputDigest = createHash("sha256").update(canonicalJson({ stepId, prompt: step.prompt })).digest("hex");
  const attempt: StepAttemptRecord = {
    seq, stepId, stepName: step.name, kind: step.kind, attempt: visits, status: step.kind === "gate" ? "waiting" : "starting", ...(agent === undefined ? {} : { agent }), inputDigest, startedAt: at,
    ...(retry === undefined ? {} : { retriesUsed: (retry.retriesUsed ?? 0) + 1 }),
  };
  const events: RunEventInput[] = [
    ...(via !== undefined && "events" in via ? via.events : []),
    ...(retry === undefined ? [] : [{ type: "retrying" as const, stepSeq: seq, text: `${step.name} again (${String(attempt.retriesUsed)} of ${String(step.kind === "agent" ? step.retries ?? 0 : 0)})` }]),
    { type: step.kind === "gate" ? "gate_waiting" : "step_started", stepSeq: seq, text: step.name },
  ];
  await commitMove(deps, [
    ...moveRun(deps, run, { currentSeq: seq, stepRuns: run.stepRuns + 1, traversals: run.traversals, status: step.kind === "gate" ? "waiting" : "running" }, events),
    putRow(attemptKey(run, seq), "CHAIN_RUN_STEP", { orgId: run.orgId, runId: run.runId, ...attempt }),
  ]);
  return step.kind === "gate" ? "waiting" : "moved";
}

/** Starts the task of a `starting` attempt, with the request id derived from the run and the sequence number: a drive that is repeated finds the same task. */
async function driveStart(deps: ChainRunnerDeps, run: ChainRunRecord, attempt: StepAttemptRecord, attempts: StepAttemptRecord[], definition: PinnedChainDefinition): Promise<Progress> {
  const step = stepOf(definition, attempt.stepId);
  if (step === undefined || step.kind !== "agent") return endRun(deps, run, { status: "failed", failure: { seq: attempt.seq, reason: "design_changed", message: `Step ${attempt.stepId} is not in this chain's design` } });
  const input = stepInput(run, step, attempts, attempt.seq);
  let taskId: string;
  // A step reserves ITS share of the run's dollar limit, never the whole of it, and never more than the run has left.
  const granted = stepShareUsd(definition, run);
  if (granted !== undefined && granted <= 0) return failAttempt(deps, run, attempt, { reason: "run_limit_used_up", message: "This run has used up its dollar limit, so no more steps start." }, "failed", false);
  try {
    const resolved = await resolveAgentForAutonomousRun(deps.roster, { orgId: run.orgId, project: run.project, agentId: step.agent.agentId, version: step.agent.version });
    const started = await startUnattendedRun(deps.unattended, {
      recipeDigest: recipeDigest(resolved.recipe),
      requestId: stepRequestId(run.runId, attempt.seq), project: run.project, agent: { agentId: resolved.ref.agentId, version: resolved.ref.version }, input: { text: input.text, ...(input.context.length === 0 ? {} : { context: input.context }) },
      origin: "chain", chain: { chainRunId: run.runId, stepId: step.id },
      limits: { ...(granted === undefined ? {} : { maxRunUsd: granted }), maxMinutes: step.timeoutMinutes ?? STEP_DEFAULT_TIMEOUT_MINUTES },
    });
    taskId = started.taskId;
  } catch (error) {
    const code = (error as { code?: unknown; statusCode?: number } | null);
    // A fault that may pass (a service away) is left for the sweep to drive again; a refusal ends the attempt as failed, with its words.
    if (code?.code === undefined || (code.statusCode ?? 500) >= 500) throw error;
    return failAttempt(deps, run, attempt, { reason: typeof code.code === "string" ? code.code : "refused", message: neutralText(error instanceof Error ? error.message.replace(/^[A-Z_]+: /u, "") : "the step could not start") });
  }
  const at = iso(deps);
  await commitMove(deps, [
    ...moveRun(deps, run, {}, []),
    updateRow(attemptKey(run, attempt.seq), { set: { status: "running", taskId, ...(granted === undefined ? {} : { grantedUsd: granted }) }, condition: when.eq("status", "starting") }),
    putRow(stepTaskKey(run.orgId, taskId), "CHAIN_STEP_TASK", { orgId: run.orgId, runId: run.runId, seq: attempt.seq, at }, null),
  ]);
  return "waiting";
}

/** The share of the run's dollar limit the next step starts with: an equal share per agent step of the design, never more than what the run has left. Undefined when the design sets no dollar limit. */
export function stepShareUsd(definition: PinnedChainDefinition, run: Pick<ChainRunRecord, "runLimitUsd" | "spentUsd">): number | undefined {
  if (run.runLimitUsd === undefined) return undefined;
  const agentSteps = Math.max(1, definition.steps.filter((step) => step.kind === "agent").length);
  const cents = (usd: number): number => Math.floor(usd * 100 + 1e-9) / 100;
  return Math.max(0, Math.min(cents(run.runLimitUsd / agentSteps), cents(run.runLimitUsd - (run.spentUsd ?? 0))));
}

const addSpend = (run: Pick<ChainRunRecord, "spentUsd">, attempt: Pick<StepAttemptRecord, "grantedUsd">, actual?: number): number => Math.round(((run.spentUsd ?? 0) + (actual ?? attempt.grantedUsd ?? 0)) * 100) / 100;

async function failAttempt(deps: ChainRunnerDeps, run: ChainRunRecord, attempt: StepAttemptRecord, failure: { reason: string; message: string }, status: "failed" | "timed_out" | "cancelled" = "failed", spent = true): Promise<Progress> {
  const actual = spent && attempt.taskId !== undefined ? await deps.stepSpendUsd?.(attempt.taskId).catch(() => undefined) : undefined;
  await commitMove(deps, [
    ...moveRun(deps, run, spent && attempt.grantedUsd !== undefined ? { spentUsd: addSpend(run, attempt, actual) } : {}, [{ type: "step_ended", stepSeq: attempt.seq, text: `${attempt.stepName} ${status}` }]),
    updateRow(attemptKey(run, attempt.seq), { set: { status, failure, endedAt: iso(deps) }, condition: when.or(when.eq("status", "starting"), when.eq("status", "running")) }),
  ]);
  return "moved";
}

// ---- what comes back

/** What the host tells the runner when a step's task ends. Only these fields; the result is built from them, never parsed from model text. */
export interface StepTaskEnd {
  taskId: string;
  status: "succeeded" | "failed" | "cancelled";
  report?: string | undefined;
  /** The branch the step chose with `choose_branch`, when it had a result contract. */
  branch?: string | undefined;
  reason?: string | undefined;
}

/** A step's task ended. Handled once however often it is told: an attempt that is no longer running ignores it. Then the run moves on. */
export async function onStepEnded(deps: ChainRunnerDeps, orgId: OrgId, end: StepTaskEnd): Promise<void> {
  const pointer = await deps.store.get(stepTaskKey(orgId, end.taskId));
  if (pointer === undefined) return;
  const runId = text(pointer["runId"]);
  const seq = Number(pointer["seq"]);
  for (let attemptNumber = 0; attemptNumber < RUN_ATTEMPTS; attemptNumber += 1) {
    const run = await readChainRun(deps, orgId, runId);
    const attempt = run === undefined ? undefined : (await readStepAttempts(deps, orgId, runId)).find((candidate) => candidate.seq === seq);
    if (run === undefined || attempt === undefined || attempt.status !== "running" || attempt.taskId !== end.taskId) return;
    const parsed = end.status === "succeeded" ? StepResultSchema.safeParse({ report: shortenToBytes(redactSecrets(end.report ?? ""), 30_000), ...(end.branch === undefined ? {} : { branch: end.branch }) }) : undefined;
    const set = end.status === "succeeded" && parsed?.success === true
      ? { status: "succeeded", result: parsed.data, endedAt: iso(deps), ...(parsed.data.branch === undefined ? {} : {}) }
      : { status: end.status === "cancelled" ? "cancelled" : "failed", failure: { reason: end.reason ?? "step_failed", message: neutralText(end.reason ?? `The step's task ${end.status}`) }, endedAt: iso(deps) };
    const actual = await deps.stepSpendUsd?.(end.taskId).catch(() => undefined);
    const ok = await transactRun(deps, [
      ...moveRun(deps, run, attempt.grantedUsd === undefined && actual === undefined ? {} : { spentUsd: addSpend(run, attempt, actual) }, [{ type: "step_ended", stepSeq: seq, text: `${attempt.stepName} ${String(set.status)}` }]),
      updateRow(attemptKey(run, seq), { set, condition: when.eq("status", "running") }),
    ]);
    if (ok) break;
    if (attemptNumber === RUN_ATTEMPTS - 1) throw coded("CHANGE_STALE", "the run moved while its step's end was being written");
  }
  await advanceChainRun(deps, orgId, runId);
}

// ---- gates

/**
 * The owner's decision on a waiting gate. The caller (a local page act, proved by the page's own session) has established that the owner is deciding; nothing a run, a step's report or a model says reaches here.
 * Decided once: a gate that is no longer waiting answers as it was.
 */
export async function decideGate(deps: ChainRunnerDeps, orgId: OrgId, runId: ChainRunId, seq: number, decision: "approved" | "declined", by: string, extra: readonly TransactItem[] = []): Promise<void> {
  for (let attemptNumber = 0; attemptNumber < RUN_ATTEMPTS; attemptNumber += 1) {
    const run = await readChainRun(deps, orgId, runId);
    if (run === undefined) throw agentXError("NOT_FOUND", "no chain run has that ID");
    const attempt = (await readStepAttempts(deps, orgId, runId)).find((candidate) => candidate.seq === seq);
    if (attempt === undefined || attempt.kind !== "gate") throw agentXError("NOT_FOUND", "no gate has that number");
    if (attempt.status !== "waiting" || run.status !== "waiting" || run.currentSeq !== seq) return;
    const ok = await transactRun(deps, [
      ...moveRun(deps, run, { status: "running" }, [{ type: "gate_decided", stepSeq: seq, text: `${attempt.stepName} ${decision} by ${neutralText(by, 80)}` }]),
      updateRow(attemptKey(run, seq), { set: { status: "succeeded", decision, endedAt: iso(deps) }, condition: when.eq("status", "waiting") }),
      ...extra,
    ]);
    if (ok) break;
    if (attemptNumber === RUN_ATTEMPTS - 1) throw coded("CHANGE_STALE", "the run moved while the decision was being written");
  }
  await advanceChainRun(deps, orgId, runId);
}

/** Cancels a run the owner stops: the run ends `cancelled`, its running step's task is asked to stop, and a step's late end is ignored. */
export async function cancelChainRun(deps: ChainRunnerDeps, orgId: OrgId, runId: ChainRunId, by: string): Promise<ChainRunRecord> {
  for (let attemptNumber = 0; attemptNumber < RUN_ATTEMPTS; attemptNumber += 1) {
    const run = await readChainRun(deps, orgId, runId);
    if (run === undefined) throw agentXError("NOT_FOUND", "no chain run has that ID");
    if (isTerminalStatus(run.status)) return run;
    const attempt = (await readStepAttempts(deps, orgId, runId)).find((candidate) => candidate.seq === run.currentSeq);
    const open = attempt !== undefined && (attempt.status === "running" || attempt.status === "starting" || attempt.status === "waiting");
    const ok = await transactRun(deps, [
      ...endRunItems(deps, run, { status: "cancelled", events: [{ type: "ended", text: `cancelled by ${neutralText(by, 80)}` }], fields: { cancelledBy: by } }),
      ...(open ? [updateRow(attemptKey(run, attempt.seq), { set: { status: "cancelled", endedAt: iso(deps) } })] : []),
    ]);
    if (ok) {
      // The step's task is stopped with the run, whether its record was written or only its start was (a `starting` attempt may already hold a task).
      const taskId = attempt !== undefined && (attempt.status === "running" || attempt.status === "starting") ? await taskOfAttempt(deps, run, attempt) : undefined;
      if (taskId !== undefined) await deps.cancelTask?.(taskId).catch((error: unknown) => logOf(deps)("chain_run.cancel_failed", { runId, error: errorName(error) }));
      break;
    }
    if (attemptNumber === RUN_ATTEMPTS - 1) throw coded("CHANGE_STALE", "the run moved while it was being cancelled");
  }
  return (await readChainRun(deps, orgId, runId))!;
}

// ---- the sweep

export const OPEN_CHAIN_RUNS_PK = "OPEN_CHAIN_RUNS";

/**
 * Looks at the open runs, oldest first: a run past its time ends `timed_out`, a step that was written but not started is driven again (to the same task), a step past its own time is stopped, and a gate that was not
 * decided in time takes its reject edge. Each run is touched at most once per pass. Returns how many it moved.
 */
export async function sweepChainRuns(deps: ChainRunnerDeps, options: { limit?: number } = {}): Promise<number> {
  const rows = (await queryAll(deps.store, { pk: OPEN_CHAIN_RUNS_PK, limit: options.limit ?? 50 })).slice(0, options.limit ?? 50);
  let moved = 0;
  for (const row of rows) {
    const orgId = text(row["orgId"]);
    const runId = text(row["runId"]);
    try {
      const run = await readChainRun(deps, orgId, runId);
      if (run === undefined) { await deps.store.delete({ key: { pk: row["pk"], sk: row["sk"] } }); continue; }
      if (isTerminalStatus(run.status)) { await deps.store.delete({ key: { pk: row["pk"], sk: row["sk"] } }); continue; }
      const definition = await designOf(deps, run);
      const attempts = await readStepAttempts(deps, orgId, runId);
      const last = attempts.find((candidate) => candidate.seq === run.currentSeq);
      const maxHours = Math.min(definition.limits?.maxRunHours ?? CHAIN_RUN_MAX_HOURS, CHAIN_RUN_MAX_HOURS);
      if (deps.now() - Date.parse(run.createdAt) > maxHours * 3_600_000) {
        await endRun(deps, run, { status: "timed_out", failure: { reason: "run_timeout", message: `This run took longer than ${String(maxHours)} hours` }, ...(last !== undefined && (last.status === "running" || last.status === "starting" || last.status === "waiting") ? { extra: [updateRow(attemptKey(run, last.seq), { set: { status: "timed_out", endedAt: iso(deps) } })] } : {}) });
        const stopping = last !== undefined && (last.status === "running" || last.status === "starting") ? await taskOfAttempt(deps, run, last) : undefined;
        if (stopping !== undefined) await deps.cancelTask?.(stopping).catch((error: unknown) => logOf(deps)("chain_run.cancel_failed", { runId, error: errorName(error) }));
        moved += 1;
        continue;
      }
      const step = last === undefined ? undefined : stepOf(definition, last.stepId);
      if (last !== undefined && step !== undefined) {
        if (last.status === "starting" && deps.now() - Date.parse(last.startedAt) > STALE_START_MS) { await advanceChainRun(deps, orgId, runId); moved += 1; continue; }
        if (last.status === "running" && step.kind === "agent" && last.taskId !== undefined && await deps.taskWaiting?.(last.taskId).catch(() => false) === true) {
          // Waiting for the owner's approval is not the step's time: its minutes restart from here (the run's own hours still end it).
          await deps.store.update({ key: attemptKey(run, last.seq), ops: [change.set(["timeoutBase"], iso(deps))], condition: when.eq("status", "running") });
          continue;
        }
        if (last.status === "running" && step.kind === "agent" && deps.now() - Math.max(Date.parse(last.startedAt), last.timeoutBase === undefined ? 0 : Date.parse(last.timeoutBase)) > (step.timeoutMinutes ?? STEP_DEFAULT_TIMEOUT_MINUTES) * 60_000) {
          // The task is stopped FIRST. A task that could not be stopped is left running and the step is looked at again on the next pass: it is never marked timed out beside a live task (a retry would start a second).
          if (last.taskId !== undefined) {
            if (deps.cancelTask === undefined) continue;
            try { await deps.cancelTask(last.taskId); } catch (error) { logOf(deps)("chain_run.cancel_failed", { runId, error: errorName(error) }); continue; }
          }
          await failAttempt(deps, run, last, { reason: "timed_out", message: `Step "${step.name}" ran longer than its limit` }, "timed_out");
          await advanceChainRun(deps, orgId, runId);
          moved += 1;
          continue;
        }
        if (last.status === "waiting" && step.kind === "gate" && deps.now() - Date.parse(last.startedAt) > (step.timeoutHours ?? GATE_DEFAULT_TIMEOUT_HOURS) * 3_600_000) {
          // A gate nobody decided in time takes its reject edge. That edge may lead into more steps, so more unattended work can follow with no owner at the gate: the design chose that edge, and every step still passes the door.
          await decideGate(deps, orgId, runId, last.seq, "declined", "the gate's time ran out");
          moved += 1;
          continue;
        }
      }
      if (last === undefined || last.status === "succeeded" || last.status === "failed") { await advanceChainRun(deps, orgId, runId); moved += 1; }
    } catch (error) {
      logOf(deps)("chain_run.sweep_item_failed", { runId, error: errorName(error) });
    }
  }
  return moved;
}
