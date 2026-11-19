// Setup agent (design setup-test-health 3.2, task SH8): the journal and the governor. The journal records every command the run ran (the live view and the evidence on the confirm card); the governor
// holds the run to its limits and is where the money, time and attempt bounds are enforced IN CODE, whatever the model does:
//   - commands in all: the next command after the limit is not run, and the run ends `attempts_used`;
//   - tries of the same failing step: a further try of a step that already failed that many times, with nothing changed in between, ends the run `attempts_used`;
//   - wall clock (not counting the time spent parked on a host nobody has answered yet): a deadline timer ends the run `time_used` even while the model is only thinking, and no command is given more
//     time than is left;
//   - model spend: read from the session at every check, and a spend that cannot be read is treated as used up (fail closed); the run ends `budget_used`;
//   - new host asks: one more than the limit ends the run `hosts_waiting`, and so does a host ask that nobody answered in 24 hours;
//   - the first reason wins and is final; when two limits are met at once the order is money, time, attempts, hosts, so the same facts always give the same word.
// A limit stop keeps everything learned: `finishStoppedRun` reads whatever proposal block the model had given (and what the folders show), and the journal lists the commands that worked.
// Nothing here reads a command's output for meaning: the exit code, the time and the command's own words are all it looks at.
import {
  SETUP_AGENT_LIMITS_DEFAULT, SETUP_BLOCKED_HOSTS_MAX, SETUP_JOURNAL_MAX_ENTRIES, SETUP_JOURNAL_TAIL_BYTES, SETUP_HOST_WAIT_MAX_HOURS, SetupAgentLimitsSchema, SetupHostSchema, SetupJournalEntrySchema, SetupRunSummarySchema,
  oneLineText, type SetupAgentLimits, type SetupJournalEntry, type SetupProposal, type SetupRunEndWord, type SetupRunSummary,
} from "@agentx/contracts";
import type { SetupAgentHooks, SetupCommandDecision, SetupCommandRecord, TrackedFilesVerdict } from "./setup-agent.js";
import { readSetupProposalAnswer, type SetupDraftRepository } from "./setup-draft.js";
import type { SetupScan } from "./setup-scan.js";
import type { TrackedPaths } from "./setup-citations.js";

const MINUTE_MS = 60_000;
const COMMAND_CHARS = 2_000;

/** Whole cents from the dollars a session reports; undefined when the figure cannot be trusted (not a finite, non-negative number). Rounds up, so a part of a cent is a cent. */
export function centsFromDollars(dollars: unknown): number | undefined {
  if (typeof dollars !== "number" || !Number.isFinite(dollars) || dollars < 0 || dollars > 1_000_000) return undefined;
  return Math.max(0, Math.ceil(dollars * 100 - 1e-9));
}

// ---- what counts as "the same step"

/** Commands that only look: running one is not progress, so it does not clear a step's failed tries. */
const PROBES = new Set(["ls", "cat", "echo", "pwd", "which", "type", "env", "printenv", "head", "tail", "grep", "rg", "find", "wc", "file", "stat", "uname", "id", "whoami", "date", "sleep", "true", "false", "test", "[", "diff", "tree", "du", "df", "ps"]);
const GIT_READS = new Set(["status", "log", "diff", "show", "branch", "rev-parse", "ls-files", "remote", "describe"]);

/** Programs whose first words after the name (leaving out flags) say what step it is: `npm ci`, `uv sync`, `python -m pytest`. */
const SUBCOMMAND_PROGRAMS = new Set(["npm", "pnpm", "yarn", "uv", "pip", "pip3", "poetry", "pipenv", "cargo", "go", "mvn", "gradle", "gradlew", "./gradlew", "./mvnw", "mvnw", "make", "git", "docker", "apt", "apt-get", "bundle", "gem", "dotnet", "bun", "npx", "python", "python3"]);

/** Port lane P6 (item B1): programs a `build-system` profile adds to the list above. Set once at worker boot (`build-systems.ts`). */
let extraSubcommandPrograms: ReadonlySet<string> = new Set();
export function setExtraSubcommandPrograms(programs: readonly string[]): void {
  extraSubcommandPrograms = new Set(programs);
}
const takesSubcommand = (program: string): boolean => SUBCOMMAND_PROGRAMS.has(program) || extraSubcommandPrograms.has(program);

function tokensOf(command: string): string[] {
  return command.trim().replace(/\s+/gu, " ").split(" ").filter((token) => token !== "");
}

/**
 * The step a command belongs to: the first command of the line (after a leading `cd <dir> &&` and variable assignments), reduced to its program and, for a program that takes a subcommand, the
 * subcommand and the first thing after it; a trailing `2>&1` and a pipe into `tail`/`head`/`tee` are not part of it. `uv sync --frozen` and `uv sync` are one step; `pytest tests/a` and
 * `pytest tests/b` are two. Lower-case; at most 120 characters.
 */
export function stepKeyOf(command: string): string {
  let text = command.replace(/\s2>&1/gu, " ").replace(/\|\s*(?:tail|head|tee)\b.*$/u, " ");
  text = text.replace(/^[\s(]*cd\s+\S+\s*&&\s*/u, "").replace(/^[\s({]+/u, "");
  // Wrappers that run the next word do not make a different step: `env npm ci`, `command npm ci`, `time npm ci`, `/usr/bin/npm ci`.
  for (let wrapper = 0; wrapper < 4 && /^(?:env|command|exec|time|nohup|nice|sudo|builtin)\s+/u.test(text); wrapper += 1) text = text.replace(/^(?:env|command|exec|time|nohup|nice|sudo|builtin)\s+(?:-\S+\s+)*/u, "");
  text = text.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/u, "").replace(/^python3?\s+-m\s+/u, "").replace(/^(?:\/[\w.-]+)*\/([\w.+-]+)(?=\s|$)/u, "$1");
  const first = text.split(/&&|\|\||;|\||\)/u)[0] ?? text;
  const tokens = tokensOf(first).filter((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(token));
  const program = tokens[0] ?? "";
  const rest = tokens.slice(1);
  const parts = takesSubcommand(program) ? [program, ...rest.filter((token) => !token.startsWith("-")).slice(0, 2)] : [program, ...rest.filter((token) => !token.startsWith("-")).slice(0, 1)];
  return parts.join(" ").toLowerCase().slice(0, 120);
}

/** True for a command that only looks at things. */
export function isProbeCommand(command: string): boolean {
  const key = stepKeyOf(command);
  const [program, sub] = key.split(" ");
  if (program === undefined) return true;
  if (program === "git") return GIT_READS.has(sub ?? "");
  if (/(^|\s)(--version|-v|-V|--help|-h)(\s|$)/u.test(command) && command.length < 80) return true;
  return PROBES.has(program);
}

// ---- bounding what one model turn can cost

/** The most output tokens one model turn may produce in a setup session (the session's model is capped to this). */
export const SETUP_AGENT_MAX_OUTPUT_TOKENS = 8_192;

/**
 * The most the next model turn can cost, in whole cents, rounded up: the whole transcript sent as input at the model's input price, plus the output cap at its output price. Prices are dollars per
 * million tokens. A figure that is not a finite non-negative number gives NaN, which the governor reads as the whole budget.
 */
export function estimateNextTurnCents(input: { inputTokens: number; maxOutputTokens: number; inputPerMTok: number; outputPerMTok: number }): number {
  const values = [input.inputTokens, input.maxOutputTokens, input.inputPerMTok, input.outputPerMTok];
  if (values.some((value) => !Number.isFinite(value) || value < 0)) return Number.NaN;
  return Math.max(0, Math.ceil(((input.inputTokens * input.inputPerMTok + input.maxOutputTokens * input.outputPerMTok) / 1_000_000) * 100 - 1e-9));
}

/**
 * The session listener that keeps the governor looking: every `turn_end` (and every tool event) checks the limits, so a run with a model that only thinks, or one that ends its turns without a
 * command, still stops at the budget and the clock. `subscribe` returns the listener the session's `subscribe` takes.
 */
export function governorSessionListener(governor: { check(): unknown }): (event: unknown) => void {
  return (event) => {
    const type = typeof event === "object" && event !== null ? (event as { type?: unknown }).type : undefined;
    if (type === "turn_end" || type === "turn_start" || type === "tool_execution_start" || type === "tool_execution_end" || type === "message_end") governor.check();
  };
}

// ---- the governor and the journal

export interface SetupGovernorInput {
  limits: SetupAgentLimits;
  /** A millisecond clock. Default: `Date.now`. */
  now?: () => number;
  /** The model spend so far, in whole cents (`centsFromDollars` of the session's cost); undefined when it cannot be read. Read at every check. */
  spendCents: () => number | undefined;
  /**
   * What the next model turn may cost at most, in whole cents (`estimateNextTurnCents`). REQUIRED, with no default: the run stops when the spend so far plus this would reach the budget, so a turn
   * cannot carry it past the limit, and a caller that cannot say what a turn costs does not get a governor that assumes it is free. A value that is not a non-negative number counts as the whole budget.
   */
  nextTurnCents: () => number;
  /** The hosts the DNS watch (SH9) saw blocked since the last call, cleared by the call. Default: none. */
  takeBlockedHosts?: () => readonly string[];
  /** Called once, when the run must end: the caller aborts the model session. */
  onStop?: (word: SetupRunEndWord) => void;
  /** Called for each journal entry as it is written: the live view. */
  onEntry?: (entry: SetupJournalEntry) => void;
  /** Test seam for the deadline timer. Default: `setTimeout`, unref'd. */
  setTimer?: (callback: () => void, ms: number) => { cancel(): void };
}

/** What a run learned, for a partial proposal and the confirm card: the commands that worked, by journal position. Download-and-run commands are never listed. */
export interface LearnedCommand { n: number; command: string }

export class SetupAgentGovernor implements SetupAgentHooks {
  private readonly limits: SetupAgentLimits;
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly journal: SetupJournalEntry[] = [];
  /** The position of the latest person's command so far: every agent command after it says so (`afterPersonCommandN`). */
  private lastPersonN: number | undefined;
  private readonly failures = new Map<string, number>();
  /** Agent commands that were allowed and have not reported yet, in total and by step: counted against the limits at the moment they are allowed, so parallel tool calls cannot all pass. */
  private inflight = 0;
  private readonly inflightByStep = new Map<string, number>();
  /** Agent commands that finished, whether or not their journal entry could be written. */
  private agentFinished = 0;
  private readonly hosts = new Set<string>();
  private parkedAt: number | undefined;
  private parkedTotalMs = 0;
  private stopped: SetupRunEndWord | undefined;
  private timer: { cancel(): void } | undefined;

  constructor(private readonly input: SetupGovernorInput) {
    // The limits are read through the contract's own bounds: a number that is not a whole number from 1 up to the maximum (a NaN would never be reached) does not start a run.
    this.limits = SetupAgentLimitsSchema.parse(input.limits);
    this.now = input.now ?? Date.now;
    this.startedAt = this.now();
    this.armDeadline();
  }

  // ---- state

  /** Why the run ended, once it has; undefined while it can go on. */
  ended(): SetupRunEndWord | undefined {
    return this.stopped;
  }

  entries(): readonly SetupJournalEntry[] {
    return this.journal.map((entry) => ({ ...entry, blockedHosts: [...entry.blockedHosts] }));
  }

  /** The milliseconds of the run so far, without the time spent parked on host asks. */
  elapsedMs(): number {
    const parked = this.parkedTotalMs + (this.parkedAt === undefined ? 0 : this.now() - this.parkedAt);
    return Math.max(0, this.now() - this.startedAt - parked);
  }

  /** The seconds of wall clock left (at least 0). */
  secondsLeft(): number {
    return Math.max(0, Math.floor((this.limits.wallClockMin * MINUTE_MS - this.elapsedMs()) / 1_000));
  }

  /** Cuts the timer. Safe to call again. */
  dispose(): void {
    this.timer?.cancel();
    this.timer = undefined;
  }

  // ---- stopping

  /** Ends the run with `word`, once: the first reason is final. Cuts the deadline timer and tells the caller. */
  stop(word: SetupRunEndWord): void {
    if (this.stopped !== undefined) return;
    this.stopped = word;
    this.dispose();
    this.input.onStop?.(word);
  }

  /**
   * Looks at every limit that does not need a command, and stops the run with the first one that is used up (money, time, commands, in that order). Called before each command, when the model's
   * usage changes, and by the deadline timer. Returns the word when the run has ended.
   */
  check(): SetupRunEndWord | undefined {
    if (this.stopped !== undefined) return this.stopped;
    const spend = this.input.spendCents();
    const next = this.input.nextTurnCents();
    if (spend === undefined || !Number.isFinite(next) || next < 0 || spend + next >= this.limits.budgetCents) this.stop("budget_used");
    else if (this.elapsedMs() >= this.limits.wallClockMin * MINUTE_MS) this.stop("time_used");
    else if (this.waitedOnHostsTooLong()) this.stop("hosts_waiting");
    return this.stopped;
  }

  // ---- the shell's hooks (setup-agent.ts)

  beforeCommand(command: string): SetupCommandDecision {
    if (this.check() !== undefined) return { allow: false };
    // Everything from the check to the reservation is synchronous: two calls cannot both see the same free slot.
    if (this.agentFinished + this.inflight >= this.limits.commands || this.journal.length + this.inflight >= SETUP_JOURNAL_MAX_ENTRIES) { this.stop("attempts_used"); return { allow: false }; }
    // A further try of a step that already failed this many times with nothing changed in between. A command of the step that is still running counts as a try: it may yet fail.
    const key = stepKeyOf(command);
    if ((this.failures.get(key) ?? 0) + (this.inflightByStep.get(key) ?? 0) >= this.limits.sameStepTries) { this.stop("attempts_used"); return { allow: false }; }
    this.inflight += 1;
    this.inflightByStep.set(key, (this.inflightByStep.get(key) ?? 0) + 1);
    return { allow: true, ticket: key };
  }

  maxTimeoutSeconds(): number {
    return this.secondsLeft();
  }

  afterCommand(record: SetupCommandRecord): void {
    const key = typeof record.ticket === "string" ? record.ticket : stepKeyOf(record.command);
    // The reservation made when the command was allowed is given back here, on every path, before the entry is written.
    if (this.inflight > 0) this.inflight -= 1;
    const left = (this.inflightByStep.get(key) ?? 0) - 1;
    if (left > 0) this.inflightByStep.set(key, left); else this.inflightByStep.delete(key);
    this.agentFinished += 1;
    this.append("agent", record);
    if (record.exitCode === 0 && !record.timedOut) {
      this.failures.delete(key);
      // A command that changed something is progress: the other steps get their tries back. A command that only looked is not.
      if (!isProbeCommand(record.command)) this.failures.clear();
    } else {
      this.failures.set(key, (this.failures.get(key) ?? 0) + 1);
    }
    this.check();
  }

  /** The shell found the repositories changed (setup-agent.ts). */
  onEnded(word: "changed_repository_files"): void {
    // A changed repository outranks every other reason, even one that was already final: the run has no proposal whatever stopped it first (a command that was still running when a limit
    // stopped the run may be the one that edited the files). The caller was already told to stop; it is not told twice.
    if (this.stopped === undefined) { this.stop(word); return; }
    this.stopped = word;
  }

  // ---- a person's command (SH13), recorded with the same bounds

  /** Records a command a person typed (it ran in the setup sandbox; it is shown to the agent as a result, not an instruction). It does not use the agent's command limit, and it cannot overflow the journal. */
  recordPersonCommand(record: SetupCommandRecord): SetupJournalEntry | undefined {
    return this.append("person", record);
  }

  // ---- host asks

  /**
   * A host the run needs. A name that is not a plain DNS name is `invalid` (and is not counted; the host-ask card refuses it). The same host again is `duplicate`. A new host over the limit ends the
   * run `hosts_waiting`.
   */
  requestHost(host: string): "new" | "duplicate" | "invalid" | "stopped" {
    if (this.stopped !== undefined) return "stopped";
    if (!SetupHostSchema.safeParse(host).success) return "invalid";
    if (this.hosts.has(host)) return "duplicate";
    if (this.hosts.size >= this.limits.hostAsks) { this.stop("hosts_waiting"); return "stopped"; }
    this.hosts.add(host);
    return "new";
  }

  /** Nothing else is left to do and a host ask is open: the run parks. The wall clock stops while it is parked; 24 hours parked ends the run `hosts_waiting`. */
  parkOnHosts(): void {
    if (this.stopped !== undefined || this.parkedAt !== undefined) return;
    // The 24 hours are the run's TOTAL wait, not one wait's: once they are used up the run does not park again, it ends.
    if (this.parkedTotalMs >= SETUP_HOST_WAIT_MAX_HOURS * 3_600_000) { this.stop("hosts_waiting"); return; }
    this.parkedAt = this.now();
    this.armDeadline();
  }

  /** An admin answered (or the run has other work): the wall clock runs again. */
  resumeFromHosts(): void {
    if (this.parkedAt === undefined) return;
    this.parkedTotalMs += this.now() - this.parkedAt;
    this.parkedAt = undefined;
    this.armDeadline();
  }

  /** The time spent parked so far, in all the waits of the run. */
  private parkedSoFarMs(): number {
    return this.parkedTotalMs + (this.parkedAt === undefined ? 0 : this.now() - this.parkedAt);
  }

  private waitedOnHostsTooLong(): boolean {
    return this.parkedAt !== undefined && this.parkedSoFarMs() >= SETUP_HOST_WAIT_MAX_HOURS * 3_600_000;
  }

  // ---- the deadline

  private armDeadline(): void {
    this.timer?.cancel();
    this.timer = undefined;
    if (this.stopped !== undefined) return;
    const ms = this.parkedAt === undefined
      ? this.limits.wallClockMin * MINUTE_MS - this.elapsedMs()
      : SETUP_HOST_WAIT_MAX_HOURS * 3_600_000 - this.parkedSoFarMs();
    const set = this.input.setTimer ?? ((callback, wait) => { const handle = setTimeout(callback, wait); handle.unref(); return { cancel: () => { clearTimeout(handle); } }; });
    this.timer = set(() => {
      // A timer that fires early (the clock moved) checks again rather than ending the run on its word.
      if (this.parkedAt !== undefined) { if (this.waitedOnHostsTooLong()) this.stop("hosts_waiting"); }
      else if (this.elapsedMs() >= this.limits.wallClockMin * MINUTE_MS) this.stop("time_used");
      else this.armDeadline();
    }, Math.max(1, Math.min(ms, 2_147_000_000)));
  }

  // ---- the journal

  private append(source: "agent" | "person", record: SetupCommandRecord): SetupJournalEntry | undefined {
    if (this.journal.length >= SETUP_JOURNAL_MAX_ENTRIES) return undefined;
    const hosts = [...new Set(this.input.takeBlockedHosts?.() ?? [])].filter((host) => SetupHostSchema.safeParse(host).success).slice(0, SETUP_BLOCKED_HOSTS_MAX);
    const parsed = SetupJournalEntrySchema.safeParse({
      n: this.journal.length + 1,
      source,
      command: oneLineText(record.command, COMMAND_CHARS) || "(empty command)",
      exitCode: record.exitCode === null ? null : Math.max(-1, Math.min(255, Math.trunc(record.exitCode))),
      durationMs: Math.max(0, Math.min(7_200_000, Math.round(record.durationMs))),
      timedOut: record.timedOut,
      flagged: record.flagged,
      blockedHosts: hosts,
      ...(source === "agent" && this.lastPersonN !== undefined ? { afterPersonCommandN: this.lastPersonN } : {}),
      tail: record.tail.slice(0, SETUP_JOURNAL_TAIL_BYTES),
      startedAt: isoOf(record.startedAt, this.now()),
    });
    if (!parsed.success) return undefined;
    this.journal.push(parsed.data);
    if (source === "person") this.lastPersonN = parsed.data.n;
    this.input.onEntry?.(parsed.data);
    return parsed.data;
  }

  /** The commands that exited 0 and do not download code, in order: what the partial proposal and the confirm card cite as "worked when run". */
  learned(): LearnedCommand[] {
    return this.journal.filter((entry) => entry.source === "agent" && entry.exitCode === 0 && !entry.timedOut && !entry.flagged && !isProbeCommand(entry.command)).map((entry) => ({ n: entry.n, command: entry.command }));
  }

  /** The run's report. A limit stop, a person's stop, a changed repository and an infrastructure fault are partial; `proposed` and `needs_code_change` are not. */
  summary(): SetupRunSummary {
    const stop: SetupRunEndWord = this.stopped ?? "proposed";
    const spend = this.input.spendCents();
    return SetupRunSummarySchema.parse({
      stop,
      commandsRun: this.journal.length,
      spendCents: Math.min(1_000_000, spend ?? this.limits.budgetCents),
      elapsedMs: Math.min(24 * 3_600_000, Math.round(this.elapsedMs())),
      hostAsks: this.hosts.size,
      partial: stop !== "proposed" && stop !== "needs_code_change",
    });
  }
}

/** An ISO time for a millisecond clock value; the fallback when the value is not a time `Date` can hold (it would throw). */
function isoOf(value: number, fallback: number): string {
  const date = new Date(Number.isFinite(value) ? value : fallback);
  return Number.isNaN(date.getTime()) ? new Date(fallback).toISOString() : date.toISOString();
}

/** The limits a caller uses when it has none to pass (the contract's defaults). */
export const SETUP_GOVERNOR_DEFAULT_LIMITS: SetupAgentLimits = SETUP_AGENT_LIMITS_DEFAULT;

// ---- a run that stopped early keeps what it learned

export interface StoppedRunResult {
  end: SetupRunEndWord;
  summary: SetupRunSummary;
  /** The proposal read from the last block the model gave, with what the folders show; undefined when there is neither. */
  proposal: SetupProposal | undefined;
  learned: LearnedCommand[];
}

/**
 * A run that ended before the model's final answer (a limit, a person's stop, a fault): reads whatever the model last said as a proposal block (and the folders' own findings), and adds the commands
 * that worked. It is never an error to have little: a run with nothing readable returns no proposal, a summary that says `partial`, and the journal. The proposal is the same bounded, cited, redacted
 * object a finished run gives; its commands are only what the model cited.
 */
export async function finishStoppedRun(input: {
  governor: SetupAgentGovernor;
  /**
   * The verdict of `checkTrackedFiles` taken AFTER the agent's container and its processes were stopped, never an earlier one: a repository that is not clean (changed, moved, flagged or unreadable)
   * ends the run `changed_repository_files` with no proposal, whatever stopped it first. Required, so a caller cannot forget the last look.
   */
  trackedFiles: TrackedFilesVerdict;
  /** The agent's shell: when it found the repositories changed, there is no proposal either. */
  shell?: { ended(): string | undefined };
  lastText: string;
  basedOnRevision: number;
  rootPath: string;
  repositories: ReadonlyArray<SetupDraftRepository>;
  metaRepo?: string | undefined;
  /** See `finishSetupAgent`: the scan taken before the run and the files of the resolved commit. */
  scan?: SetupScan | undefined;
  tracked?: TrackedPaths | undefined;
}): Promise<StoppedRunResult> {
  if (!input.trackedFiles.ok || input.shell?.ended() === "changed_repository_files") input.governor.onEnded("changed_repository_files");
  const summary = input.governor.summary();
  if (summary.stop === "changed_repository_files") return { end: summary.stop, summary, proposal: undefined, learned: [] };
  const read = await readSetupProposalAnswer(input.lastText, {
    basedOnRevision: input.basedOnRevision, rootPath: input.rootPath, repositories: input.repositories, ...(input.metaRepo === undefined ? {} : { metaRepo: input.metaRepo }),
    ...(input.scan === undefined ? {} : { scan: input.scan }), ...(input.tracked === undefined ? {} : { tracked: input.tracked }),
  }).catch(() => ({ ok: false as const, errors: ["unreadable"] }));
  return { end: summary.stop, summary, proposal: read.ok ? read.proposal : undefined, learned: input.governor.learned() };
}
