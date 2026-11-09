// The setup run, worker side (sh-setup-wire, SH14; design setup-test-health 3.1 to 3.4): puts the parts together. Called by `run-task.ts` in ONE early hunk for `workflowMode: "SETUP_AGENT"`, when the broker
// (switch `su`) sent the run and this worker lists "task.setupAgent.v1". Everything that touches the outside (Docker, the model session, the broker) is a port, so the whole run is tested without any of them.
//
// What this module guarantees (each is a test):
//   - ED-1: the repositories are read at the commit the BROKER resolved for the project's default branch (the preparation manifest), never a ref or SHA from the invocation; a workspace that has a pull request
//     head checked out is refused. `checkTrackedFiles` is given the manifest's directories, never a path from task input.
//   - the sandbox is the setup sandbox (guarded Docker seam, no secret), on the run's own network with the DNS-watch helper (option A); the worker itself is never on that network;
//   - the agent's shell and a person's command share ONE serialized base, so they never run at once, and a person's command goes through the same shell rules (time limit, tail, tracked-file check);
//   - the model session is sequential, output-capped and watched by the governor on every turn, with the next turn's most cost passed in (`nextTurnCents`, required);
//   - the journal, host asks and person commands travel over the broker's one setup callback; the requester of an ask is never sent (the broker knows who started the run);
//   - at the end the sandbox is removed (which kills every process in it) BEFORE the last tracked-files check, and that last verdict is what `finishSetupAgent` / `finishStoppedRun` use;
//   - a repository with a nested repository or LFS files, or a project whose setup rewrites a tracked file, ends the run `changed_repository_files` with no proposal (the person is told, by the broker's fixed words).
//   - hosts_waiting: when the agent has answered and a website it asked for still waits for an administrator, the run parks (no model call, so no spend; sandbox and workspace kept; the wall clock stopped) until an ask
//     is answered, then goes on with one more prompt; 24 hours parked end it `hosts_waiting` with the partial proposal it had; a person's Stop ends the wait at once.
// NOT in this module (listed in the lane report): the in-run fresh Prove (the confirm card's Prove is the broker's own, on a workspace it prepares anew), and the test-environment
// merge of the agent's findings.
import { resolve } from "node:path";
import {
  AgentXError, BUDGET_EXHAUSTED_FAILURE_MESSAGE, SetupRunSummarySchema, agentXError, effectiveSetupAgentLimits, type SetupAgentLimits, type SetupJournalEntry, type SetupProposal, type SetupRunSummary,
} from "@agentx/contracts";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { scanRepositories, type SetupScan } from "./setup-scan.js";
import { trackedPathsOf, type TrackedPaths } from "./setup-citations.js";
import { SETUP_NEXT_TURN_MARGIN_TOKENS, type ModelPrice } from "./setup-agent-price.js";
import { assistantOutcome, failedTurn } from "./session-events.js";
import { budgetExhaustedFromMarker } from "@agentx/model-runtime";
import { checkTrackedFiles, finishSetupAgent, setupAgentShell, setupAgentSessionParts, type SetupAgentRepository, type SetupCommandRecord, type TrackedFilesVerdict } from "./setup-agent.js";
import { SETUP_AGENT_MAX_OUTPUT_TOKENS, SetupAgentGovernor, centsFromDollars, estimateNextTurnCents, finishStoppedRun, governorSessionListener } from "./setup-agent-journal.js";
import { asksForCodeChange, setupAgentInstructions } from "./setup-agent-prompt.js";
import { createPersonCommandRunner } from "./setup-command-runner.js";
import type { PiSessionHandle } from "./pi-session.js";
import type { RunNetwork } from "./setup-network.js";
import { SANDBOX_TARGET, executionFor } from "./execution-target.js";
import type { TaskSandbox } from "./task-sandbox.js";

/** What the preparation manifest says about a repository (the broker's own record of the default branch's head). */
export interface SetupManifestRepository { name: string; path: string; resolvedCommit: string; checkedOut?: unknown }

export interface SetupRunPorts {
  /** The run's own network and helper (setup-network.ts `startRunNetwork` in production). */
  startNetwork(): Promise<RunNetwork>;
  /** The setup sandbox on that network, with the helper as its only DNS server (`createSetupSandbox` in production). */
  createSandbox(network: RunNetwork): TaskSandbox;
  /** Opens the model session with the parts the setup run needs. */
  openSession(parts: ReturnType<typeof setupAgentSessionParts>): Promise<PiSessionHandle>;
  /** The broker's setup callback (`POST .../setup-agent`). Throws on a refusal. */
  callback(body: unknown): Promise<unknown>;
  /** Where the run is visible while it goes (progress lines); fixed words only. */
  progress(message: string): Promise<void>;
  /** Registers the run so a cancel aborts it and a live message reaches the model. Returns the unregister. */
  register(control: { abort(): Promise<void>; steer(text: string): Promise<boolean>; streaming(): boolean }): () => void;
  /** The tracked-files check (`checkTrackedFiles` in production). */
  checkFiles?: (repositories: ReadonlyArray<SetupAgentRepository>) => Promise<TrackedFilesVerdict>;
  /** What the project says before the run starts (the scan) and which files its resolved commit holds. Default: the real ones (`scanRepositories`, `git ls-tree`). */
  beforeStart?: (repositories: ReadonlyArray<SetupAgentRepository>, metaRepo: string | undefined) => Promise<{ scan: SetupScan; tracked: TrackedPaths }>;
  now?: () => number;
  /** How often the run talks to the broker. Default 3 s. */
  tickMs?: number;
  /** How often a parked run (waiting for an administrator) talks to the broker. Default 15 s. */
  parkTickMs?: number;
}

export interface SetupRunInput {
  rootPath: string;
  operationId: string;
  basedOnRevision: number;
  limits: SetupAgentLimits;
  /** The model's price per million tokens (setup-agent-price.ts). REQUIRED: a run for a model with no price is refused before anything starts. */
  price: ModelPrice | undefined;
  repositories: readonly SetupManifestRepository[];
  /** P1: the commits the broker recorded for these repositories (the invocation's `setupAgent.commits`). REQUIRED to be present and equal, or the run is refused before anything starts. */
  commits: SetupCommits;
  /** Test seam: how long a stopped run may take to finish (default `SETUP_STOP_FINISH_MS`). */
  stopFinishMs?: number | undefined;
  metaRepo?: string | undefined;
  ports: SetupRunPorts;
}

export interface SetupRunResult {
  workflowMode: "SETUP_AGENT";
  setupProposal?: SetupProposal;
  setupRunSummary: SetupRunSummary;
}

/** How many polls of the broker in a row may fail before the run ends: with none answered, no stop and no answer can reach it. */
export const SETUP_POLL_FAILURES_MAX = 5;

/** F5: how long a run that a person stopped may take to finish and report what it had (killing the sandbox, the last look at the tracked files, reading the proposal). Past it the stop is reported with no proposal. */
export const SETUP_STOP_FINISH_MS = 15_000;

const pause = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/** What the agent is told when the wait for an administrator is over: fixed words around host names (plain DNS names, checked by the broker's card and by the contract). */
export function hostAnswerNote(allowed: readonly string[], refused: readonly string[]): string {
  return [
    "Rovara note (not from the repository): you waited while an administrator decided the websites you asked for.",
    ...(allowed.length === 0 ? [] : [`Allowed: ${allowed.join(", ")}. Rovara staff may still need to approve a website, so it may not work for a few minutes.`]),
    ...(refused.length === 0 ? [] : [`Not allowed: ${refused.join(", ")}. Do not try to reach them another way.`]),
    "Redo only the steps that needed these websites, then answer again with your whole proposal in the same format.",
  ].join("\n");
}

/** The promise's value, or undefined when it did not settle in `ms` (its late value or failure is then ignored). */
async function withinMs<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work.catch(() => undefined), new Promise<undefined>((resolve) => { timer = setTimeout(() => { resolve(undefined); }, ms); timer.unref?.(); })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** A cache write costs 1.25 times the input price: the extra quarter, on top of the input price already counted for it. */
export const SETUP_CACHE_WRITE_EXTRA = 0.25;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

/**
 * Runs `base` one command at a time: a second `exec` waits for the first to end. The agent's shell and a person's command both run through the same serialized base, so two commands never share the
 * sandbox at once (the tracked-files check after each would otherwise see the other's half-done work).
 */
export function serialize(base: BashOperations, after?: () => Promise<void>): BashOperations {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    exec(command, cwd, options) {
      const run = tail.then(async () => {
        try { return await base.exec(command, cwd, options); } finally { await after?.().catch(() => undefined); }
      });
      tail = run.catch(() => undefined);
      return run;
    },
  };
}

/** The commits the broker recorded for the run's repositories (the payload's `commits`). */
export type SetupCommits = ReadonlyArray<{ repository: string; commit: string }> | undefined;

/**
 * P1: the manifest's commits are the ones the broker recorded when the preparation reported. No list, a repository missing from either side, a repeat or one commit that differs: the run does not start. The list
 * never adds or changes what is read; it only holds the manifest to what the broker was told.
 */
export function assertCommitsMatch(manifest: readonly SetupManifestRepository[], commits: SetupCommits): void {
  if (commits === undefined) throw agentXError("CONFIG_INVALID", "a setup run needs the commits the broker recorded");
  const recorded = new Map(commits.map((entry) => [entry.repository, entry.commit]));
  if (recorded.size !== commits.length || recorded.size !== manifest.length) throw agentXError("CONFIG_INVALID", "the workspace does not hold the repositories the broker recorded");
  for (const repository of manifest) {
    if (recorded.get(repository.name) !== repository.resolvedCommit) throw agentXError("CONFIG_INVALID", "the workspace holds a repository at another commit than the broker recorded");
  }
}

/** The repositories of the run, from the manifest only. A workspace with a pull request head checked out, or a commit that is not a full hash, is refused: the run reads the default branch's head and nothing else (ED-1). */
export function setupRepositoriesOf(rootPath: string, manifest: readonly SetupManifestRepository[]): SetupAgentRepository[] {
  if (manifest.length === 0) throw agentXError("CONFIG_INVALID", "a setup run needs a prepared repository");
  return manifest.map((repository) => {
    if (repository.checkedOut !== undefined) throw agentXError("CONFIG_INVALID", "a setup run reads the default branch only, never a pull request head");
    if (!COMMIT.test(repository.resolvedCommit)) throw agentXError("CONFIG_INVALID", "a setup run needs the commit the broker resolved");
    return { name: repository.name, path: repository.path, resolvedCommit: repository.resolvedCommit, directory: resolve(rootPath, repository.path) };
  });
}

export async function runSetupAgent(input: SetupRunInput): Promise<SetupRunResult> {
  const { ports } = input;
  const now = ports.now ?? Date.now;
  const limits = effectiveSetupAgentLimits(input.limits);
  // P1: the manifest is held to the commits the broker recorded (from the heads it pinned) before anything starts.
  assertCommitsMatch(input.repositories, input.commits);
  const repositories = setupRepositoriesOf(input.rootPath, input.repositories);
  if (input.price === undefined || !Number.isFinite(input.price.inputPerMTok) || !Number.isFinite(input.price.outputPerMTok)) throw agentXError("RUNTIME_UNAVAILABLE", "AgentX does not know this model's price, so it did not start the setup run");
  const price = input.price;
  const checkFiles = ports.checkFiles ?? ((list) => checkTrackedFiles(list));
  // What the project says, taken BEFORE the sandbox starts (the working tree is as the clone left it) and what the commit holds: an install script that writes a project file or a rule later changes neither.
  const before = ports.beforeStart === undefined
    ? { scan: await scanRepositories(input.rootPath, repositories, { metaRepo: input.metaRepo }), tracked: await trackedPathsOf(repositories) }
    : await ports.beforeStart(repositories, input.metaRepo);
  const { scan, tracked } = before;
  const lastFiles = (): Promise<TrackedFilesVerdict> => checkFiles(repositories);

  let session: PiSessionHandle | undefined;
  let finalText = "";
  let lastInputTokens = 20_000;
  let lastOutputTokens = 0;
  let ownSpendUsd = 0;
  let turns = 0;
  const pendingEntries: SetupJournalEntry[] = [];
  const seenHosts = new Set<string>();
  const told = new Set<string>();
  let blocked: string[] = [];
  let delivered: string[] = [];
  let personSeq: number | undefined;
  /** Set when the run was aborted from outside (a person's Stop): the end is then bounded (`SETUP_STOP_FINISH_MS`). */
  let cancelled = false;
  /** The command place of each journal entry a person's command wrote (so a website it hit is asked for with the command's place, from which the broker finds who typed it). */
  const seqOfEntry = new Map<number, number>();

  const network = await ports.startNetwork();
  let sandbox: TaskSandbox | undefined;
  let tick: ReturnType<typeof setInterval> | undefined;
  let unregister: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    sandbox = ports.createSandbox(network);
    const refreshBlocked = async (): Promise<void> => { blocked = await network.readBlocked(); };
    const base = serialize(executionFor(SANDBOX_TARGET, { sandbox }).bashOperations(), refreshBlocked);
    const governor = new SetupAgentGovernor({
      limits, now,
      // The larger of what the session reports and what the run counted itself from each turn's tokens at the catalog price: a proxy-routed model may report a cost of 0, and a turn with no usage and no cost is unreadable (= used up).
      spendCents: () => {
        if (session === undefined) return 0;
        const reported = centsFromDollars(session.getSessionStats().cost);
        const own = centsFromDollars(ownSpendUsd);
        if (turns > 0 && (reported ?? 0) === 0 && (own ?? 0) === 0) return undefined;
        return reported === undefined ? own : own === undefined ? reported : Math.max(reported, own);
      },
      // The next turn at most: the last turn's input and output and 4 KiB more as input (what is new may be written to the cache, at 1.25 times the input price), and the full output cap as output, at the model's own prices.
      nextTurnCents: () => estimateNextTurnCents({ inputTokens: lastInputTokens + lastOutputTokens + SETUP_NEXT_TURN_MARGIN_TOKENS + SETUP_CACHE_WRITE_EXTRA * (lastOutputTokens + SETUP_NEXT_TURN_MARGIN_TOKENS), maxOutputTokens: SETUP_AGENT_MAX_OUTPUT_TOKENS, ...price }),
      // The names the helper saw refused since the last entry: from the helper's file, never from any output.
      takeBlockedHosts: () => { const fresh = blocked.filter((name) => !delivered.includes(name)); delivered = [...delivered, ...fresh]; return fresh; },
      onStop: () => { void session?.abort().catch(() => undefined); },
      onEntry: (entry) => { pendingEntries.push(entry); if (entry.source === "person" && personSeq !== undefined) seqOfEntry.set(entry.n, personSeq); },
    });
    const shell = setupAgentShell({ base, hooks: governor, checkFiles: lastFiles });
    const runner = createPersonCommandRunner({
      base, cwd: resolve(input.rootPath), checkFiles: lastFiles, alive: () => governor.ended() === undefined,
      maxTimeoutSeconds: () => governor.secondsLeft(), onEnded: (word) => governor.onEnded(word),
      record: (record: SetupCommandRecord) => governor.recordPersonCommand(record),
      tellAgent: async (text) => (session?.steer === undefined || session.isStreaming?.() !== true ? false : (await session.steer(text), true)),
      report: async (done) => { await ports.callback({ kind: "command_done", seq: done.seq, ...(done.journalN === undefined ? {} : { journalN: done.journalN }) }); personSeq = undefined; },
    });
    session = await ports.openSession(setupAgentSessionParts({ sandbox, shell }));
    unsubscribe = session.subscribe((event) => {
      const message = (event as { type?: unknown; message?: { role?: unknown; content?: unknown; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } } }).message;
      if ((event as { type?: unknown }).type === "message_end" && message?.role === "assistant") {
        finalText = textOf(message.content) ?? finalText;
        const written = message.usage?.cacheWrite ?? 0;
        const used = (message.usage?.input ?? 0) + (message.usage?.cacheRead ?? 0) + written;
        const produced = message.usage?.output ?? 0;
        turns += 1;
        if (used > 0) lastInputTokens = used;
        lastOutputTokens = produced;
        // Cache writes cost 1.25 times the input price (a read is priced as input here: dearer than it is, never cheaper).
        ownSpendUsd += ((used + written * SETUP_CACHE_WRITE_EXTRA) * price.inputPerMTok + produced * price.outputPerMTok) / 1_000_000;
        // A spent budget on the proxy (the model call itself was refused for it) is the budget limit, in the run's own words.
        const outcome = assistantOutcome(event);
        const failure = failedTurn(outcome);
        if (budgetExhaustedFromMarker(outcome?.errorMessage) !== undefined || failure?.message === BUDGET_EXHAUSTED_FAILURE_MESSAGE) governor.stop("budget_used");
        else if (failure instanceof AgentXError && failure.code === "MODEL_NOT_ALLOWED") governor.stop("infrastructure");
      }
      // The limits are looked at AFTER the turn's tokens were counted, so a turn that crossed the budget is seen at once.
      governorSessionListener(governor)(event);
    });
    unregister = ports.register({
      abort: async () => { cancelled = true; governor.stop("infrastructure"); await session?.abort(); },
      steer: async (text) => (session?.steer === undefined || session.isStreaming?.() !== true ? false : (await session.steer(text), true)),
      streaming: () => session?.isStreaming?.() === true,
    });

    // ---- the run's talk with the broker, every few seconds: journal, host asks, a person's command, answers.
    /** Where each website this run asked for stands, as the broker last said (a name is here only if its ask waited for or got an answer). */
    const askStates = new Map<string, "open" | "approved" | "refused">();
    /** Set while the run waits for an administrator (hosts_waiting): no model call is made, nothing is streaming. */
    let parked = false;
    let talking = false;
    let pollFailures = 0;
    const talk = async (): Promise<void> => {
      if (talking) return;
      talking = true;
      // The journal and the website asks first. If they fail the run still looks at the broker below: a stop (a person's, the company's) must reach it.
      try {
        while (pendingEntries.length > 0) {
          const batch = pendingEntries.slice(0, 20);
          await ports.callback({ kind: "journal", entries: batch });
          pendingEntries.splice(0, batch.length);
          for (const entry of batch) {
            for (const host of entry.blockedHosts) {
              if (seenHosts.has(host)) continue;
              seenHosts.add(host);
              if (governor.requestHost(host) === "new") {
                const asked = await ports.callback({ kind: "host", host, journalN: entry.n, ...(seqOfEntry.get(entry.n) === undefined ? {} : { viaCommandSeq: seqOfEntry.get(entry.n)! }) }) as { outcome?: unknown } | undefined;
                // Only an ask that now waits for an administrator can park the run (a refused name or an already allowed one waits for nobody).
                if (asked?.outcome === "created" || asked?.outcome === "joined") askStates.set(host, "open");
              }
            }
          }
        }
      } catch {
        // The entries stay in the queue and go at the next tick.
      }
      try {
        const polled = await ports.callback({ kind: "poll" }) as { command?: { seq: number; command: string }; hosts?: Array<{ host: string; state: string }>; companyOff?: boolean };
        // L12: a company admin turned setup runs off: the run ends at once, runs nothing more and asks for nothing more, and reports what it had.
        if (polled.companyOff === true) { governor.stop("infrastructure"); return; }
        for (const answer of polled.hosts ?? []) {
          if (answer.state === "open" || answer.state === "approved" || answer.state === "refused") askStates.set(answer.host, answer.state);
          // While the run is parked nothing is streaming; the answer goes into the follow-up prompt instead of a steer message.
          if (answer.state === "approved" && !told.has(answer.host) && !parked) {
            told.add(answer.host);
            await session?.steer?.(`Rovara note: an admin allowed the website ${answer.host} for this project. Rovara staff may still need to approve it, so it may not work for a few minutes.`).catch(() => undefined);
          }
        }
        if (polled.command !== undefined) { personSeq = polled.command.seq; void runner.run(polled.command); }
        pollFailures = 0;
      } catch {
        // A broker that cannot be reached for one tick is tried again at the next; the run goes on. After 5 polls in a row that failed, nothing can reach it (not a stop, not an answer): it ends.
        pollFailures += 1;
        if (pollFailures >= SETUP_POLL_FAILURES_MAX) governor.stop("infrastructure");
      } finally {
        talking = false;
      }
    };
    const armTick = (ms: number): void => {
      if (tick !== undefined) clearInterval(tick);
      tick = setInterval(() => { void talk(); }, ms);
      tick.unref?.();
    };
    armTick(ports.tickMs ?? 3_000);
    /** One full talk now, after any that is going: the run's last entries and host asks reach the broker before the run decides to wait. */
    const talkNow = async (): Promise<void> => { while (talking) await pause(5); await talk(); };

    await ports.progress("The setup run started.");
    let failed = false;
    try {
      await session.prompt(setupAgentInstructions({ repositories, limits, ...(input.metaRepo === undefined ? {} : { metaRepo: input.metaRepo }) }));
    } catch {
      failed = true;
    }
    // ---- hosts_waiting: the agent has nothing else to do, and a website it asked for waits for an administrator. The run parks: no model call is made (so nothing is spent), the sandbox and the workspace are kept,
    // the wall clock stops, and the run asks the broker now and then. When an ask is answered it goes on with one more prompt; 24 hours parked ends it `hosts_waiting` with the partial proposal it has. A person's
    // Stop ends the wait at once. At most one parking per host-ask the limits allow, so a run cannot park for ever.
    let parkings = 0;
    while (!failed && governor.ended() === undefined && !cancelled && parkings <= limits.hostAsks && !asksForCodeChange(finalText)) {
      await talkNow();
      const waitingOn = [...askStates].filter(([, state]) => state === "open").map(([host]) => host);
      if (waitingOn.length === 0 || governor.ended() !== undefined) break;
      parkings += 1;
      governor.parkOnHosts();
      if (governor.ended() !== undefined) break;
      parked = true;
      armTick(ports.parkTickMs ?? 15_000);
      await ports.progress("Rovara is waiting for an administrator to decide a website.");
      while (governor.check() === undefined && !cancelled && waitingOn.every((host) => askStates.get(host) === "open")) await pause(ports.parkTickMs === undefined ? 1_000 : Math.min(ports.parkTickMs, 1_000));
      governor.resumeFromHosts();
      parked = false;
      armTick(ports.tickMs ?? 3_000);
      if (governor.ended() !== undefined || cancelled) break;
      const allowed = waitingOn.filter((host) => askStates.get(host) === "approved");
      const refused = waitingOn.filter((host) => askStates.get(host) === "refused");
      for (const host of allowed) told.add(host);
      try {
        await session.prompt(hostAnswerNote(allowed, refused));
      } catch {
        failed = true;
      }
    }
    if (tick !== undefined) clearInterval(tick);
    tick = undefined;
    await runner.settled();
    if (failed && governor.ended() === undefined) governor.stop("infrastructure");

    // ---- the end. Order matters: every process in the sandbox is killed (the container is removed) BEFORE the last look at the tracked files.
    // F5: after a person's Stop the run still finishes and reports what it had, but only within a few seconds; past that it reports the stop with no proposal (the cancel has already ended the task, and the
    // sandbox is removed below whatever happened here). An unfinished look at the tracked files is never a clean one.
    const finishRun = async (): Promise<{ proposal: SetupProposal | undefined; summary: SetupRunSummary }> => {
      governor.dispose();
      await sandbox!.dispose();
      const verdict = await lastFiles();
      if (governor.ended() === undefined && shell.ended() === undefined) {
        const finished = await finishSetupAgent({
          finalText, verdict, basedOnRevision: input.basedOnRevision, rootPath: input.rootPath, repositories,
          ...(input.metaRepo === undefined ? {} : { metaRepo: input.metaRepo }), scan, tracked,
          records: governor.entries().filter((entry) => entry.source === "agent"),
        });
        if (finished.ok) return { proposal: finished.proposal, summary: SetupRunSummarySchema.parse({ ...governor.summary(), stop: finished.end, partial: false }) };
        if (finished.end === "changed_repository_files") governor.onEnded("changed_repository_files"); else governor.stop("infrastructure");
        return { proposal: undefined, summary: governor.summary() };
      }
      const stopped = await finishStoppedRun({
        governor, trackedFiles: verdict, shell, lastText: finalText, basedOnRevision: input.basedOnRevision, rootPath: input.rootPath, repositories,
        ...(input.metaRepo === undefined ? {} : { metaRepo: input.metaRepo }), scan, tracked,
      });
      return { proposal: stopped.proposal, summary: stopped.summary };
    };
    const ended = cancelled ? await withinMs(finishRun(), input.stopFinishMs ?? SETUP_STOP_FINISH_MS) : await finishRun();
    const proposal = ended?.proposal;
    const summary = ended?.summary ?? governor.summary();
    // What is left unsent goes now, once; the broker keeps the first entry for a position.
    await flushLast(ports, pendingEntries);
    return { workflowMode: "SETUP_AGENT", ...(proposal === undefined ? {} : { setupProposal: proposal }), setupRunSummary: summary };
  } finally {
    if (tick !== undefined) clearInterval(tick);
    unsubscribe?.();
    unregister?.();
    session?.dispose();
    await sandbox?.dispose().catch(() => undefined);
    await network.stop().catch(() => undefined);
  }
}

async function flushLast(ports: SetupRunPorts, entries: SetupJournalEntry[]): Promise<void> {
  while (entries.length > 0) {
    const batch = entries.slice(0, 20);
    try { await ports.callback({ kind: "journal", entries: batch }); } catch { return; }
    entries.splice(0, batch.length);
  }
}

function textOf(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap((part) => (typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string" ? [(part as { text: string }).text] : []));
  return parts.length === 0 ? undefined : parts.join("\n");
}
