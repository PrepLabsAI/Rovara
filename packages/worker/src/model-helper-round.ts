// TE-F2 part B (M2, release 0.5.19; DECISIONS 158, 161, 163b D3): one check round with the model helper beside it. `withModelHelperRound(plan, runners)` wraps the round's `CheckRunners` the way `withTestServices` does (the ONE
// hook in run-task.ts, at the three `createCheckRunners` call sites): with no plan it returns the same object (nothing changes); with one, the first command of a round starts the helper (the laptop's loopback child, or F1-b's
// container through the same `ModelHelperLauncher` port), the round's commands run with the helper's variables, and `endRound` reads the summary, turns it into evidence, tells the plan, and tears the helper down (also for a
// round that failed or was stopped: `runChecks` always calls `endRound`). F1-c later extends this same hook with the bridge.
//
// The evidence says what is true: "not sealed; model hosts blocked by name only" (hosted) or exactly "model hosts not blocked on this machine" (the laptop); a client that ignored its redirect makes the round "not run: client
// ignored the redirect (called <host>)", never a pass; a ledger that cannot be read is "not run". A scripted reply that is not `before_task` or `independent`, and the whole failure pack, never count.
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  MODEL_HOSTS_NOT_BLOCKED_SENTENCE,
  NOT_SEALED_BLOCKED_BY_NAME_SENTENCE,
  REPLY_PROVENANCE_LABELS,
  UNMATCHED_SENTENCE,
  findRedirectEscapes,
  type ModelReplySet,
  type ServableRow,
} from "@agentx/contracts";
import { CheckNotRunError, type CheckRunners } from "./verification/checks.js";
import { ModelHelperSummarySchema, MODEL_SUMMARY_MAX_ESCAPE_HOSTS, UNTRUSTED_MODEL_SUMMARY, type ModelHelperSummary } from "./model-helper-ledger.js";
import { buildModelReplyBundle, modelReplyBundleBytes, modelReplyBundleDigest } from "./model-reply-bundle.js";

export type ModelRoundResult = "ran" | "not_run";
export interface ModelHelperEvidence {
  /** `not_run` when the record cannot be trusted or a client ignored its redirect: never a pass. */
  readonly result: ModelRoundResult;
  /** Fixed sentences, and the hosts a client called as plain names that passed the strict host checker (nothing else of customer text). */
  readonly lines: readonly string[];
  /** Scripted calls whose reply counts toward "proven with scripted AI replies" (`replyCountsTowardProof`). */
  readonly countsTowardProof: number;
  readonly escapedHosts: readonly string[];
}

export const MODEL_SUMMARY_UNREADABLE_SENTENCE = "not run: the model helper's record could not be read";
export const MODEL_ESCAPE_UNNAMED_SENTENCE = "not run: client ignored the redirect (host unreadable)";
export const MODEL_ESCAPE_OTHER_SENTENCE = "not run: client ignored the redirect (called a model host port)";

/** What a round's summary says, in fixed words. `blockList` is F0a's `modelHostBlockList(...)` (the finder names a host only when it is on it or a Google AI host name). */
export function modelHelperEvidence(summary: ModelHelperSummary | undefined, blockList: readonly string[], options: { readonly hostSuffixes?: readonly string[] } = {}): ModelHelperEvidence {
  if (summary === undefined || !summary.trusted) {
    return { result: "not_run", lines: [MODEL_SUMMARY_UNREADABLE_SENTENCE, MODEL_HOSTS_NOT_BLOCKED_SENTENCE], countsTowardProof: 0, escapedHosts: [] };
  }
  const lines: string[] = [summary.blockState === "by_name" ? NOT_SEALED_BLOCKED_BY_NAME_SENTENCE : MODEL_HOSTS_NOT_BLOCKED_SENTENCE];
  const escapes = findRedirectEscapes(blockList, summary.escapes.hosts, options);
  for (const escape of escapes) lines.push(escape.sentence);
  if (summary.escapes.unreadable > 0) lines.push(MODEL_ESCAPE_UNNAMED_SENTENCE);
  if (summary.escapes.count > 0 && escapes.length === 0 && summary.escapes.unreadable === 0) lines.push(MODEL_ESCAPE_OTHER_SENTENCE);
  for (const provenance of ["before_task", "independent", "task_made"] as const) {
    const count = summary.scripted[provenance];
    if (count > 0) lines.push(`${String(count)} x ${REPLY_PROVENANCE_LABELS[provenance]}`);
  }
  if (summary.failurePack > 0) lines.push(`${String(summary.failurePack)} x ${REPLY_PROVENANCE_LABELS.failure_pack}`);
  if (summary.unmatched > 0) lines.push(`${String(summary.unmatched)} x ${UNMATCHED_SENTENCE}`);
  if (summary.refused > 0) lines.push(`${String(summary.refused)} calls refused by the model helper`);
  return { result: summary.escapes.count > 0 ? "not_run" : "ran", lines, countsTowardProof: summary.countsTowardProof, escapedHosts: escapes.map((escape) => escape.host) };
}

// ---- the run files

export interface ModelHelperRunFiles {
  readonly dir: string;
  readonly rowsPath: string;
  readonly repliesPath: string;
  /** The digest `--digest` pins. */
  readonly digest: string;
}
/** Writes `rows.json` and `replies.json` into a worker-owned directory (0700; files 0600) that the launch mounts read-only into the helper. The sandbox never sees this directory. */
export async function writeModelHelperRunFiles(input: { readonly parent: string; readonly rows: readonly ServableRow[]; readonly sets: readonly ModelReplySet[] }): Promise<ModelHelperRunFiles> {
  await mkdir(input.parent, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(input.parent, "models-"));
  await chmod(dir, 0o700);
  const bundle = buildModelReplyBundle(input.sets);
  const rowsPath = join(dir, "rows.json");
  const repliesPath = join(dir, "replies.json");
  const rows = input.rows.map((row) => ({ id: row.id, family: row.family, ...(row.pathPrefix === undefined ? {} : { pathPrefix: row.pathPrefix }), ...(row.routesTo === undefined ? {} : { routesTo: row.routesTo }) }));
  await writeFile(rowsPath, JSON.stringify(rows), { mode: 0o600 });
  await writeFile(repliesPath, modelReplyBundleBytes(bundle), { mode: 0o600 });
  return { dir, rowsPath, repliesPath, digest: modelReplyBundleDigest(bundle) };
}
export const removeModelHelperRunFiles = (files: ModelHelperRunFiles): Promise<void> => rm(files.dir, { recursive: true, force: true });

// ---- the port and the hook

/** A helper that is up for a round. The laptop's is a loopback child (model-helper-local.ts); F1-b's launch returns one for the hosted container (its `readSummary` is the `docker exec ... --summarize` read). */
export interface StartedModelHelper {
  /** The digest the worker pinned in `--digest`: a summary whose `replySetDigest` is another one is untrusted (it was not written by a helper serving the files the worker wrote). */
  readonly pinnedDigest: string;
  /** Variables the round's project commands get (the laptop's: the redirect, the dummy keys). Empty for a hosted helper, whose variables reach the sandbox through F1-b's env file. */
  readonly commandEnvironment: Readonly<Record<string, string>>;
  /** Variables REMOVED from the round's project commands (the user's AI and cloud credentials on a laptop). Empty for a hosted helper. */
  readonly unsetEnvironment: readonly string[];
  /** The summary, or undefined when it cannot be read: never "no calls". */
  readSummary(): Promise<ModelHelperSummary | undefined>;
  /** Stops the helper and removes its files (idempotent, never throws). */
  stop(): Promise<void>;
}
export type ScriptedReplyFacts = readonly { readonly checkId: string; readonly taskMade: number; readonly counted: number }[] | "unknown";
export interface ModelHelperRoundResult {
  /** Unknown means every check in this round may have used task-made replies. No helper: no result. */
  readonly scriptedReplies?: ScriptedReplyFacts;
  readonly summary: ModelHelperSummary | undefined;
  readonly evidence: ModelHelperEvidence;
}
export interface ModelHelperRoundPlan {
  /** Starts the helper for one round; undefined when this round has none (the project has no reply set). A rejection makes the round's commands "not run". */
  start(signal: AbortSignal): Promise<StartedModelHelper | undefined>;
  /** F0a's `modelHostBlockList(rows, gateways)`. */
  readonly blockList: readonly string[];
  readonly hostSuffixes?: readonly string[];
  /**
   * REQUIRED, and MUST BE WIRED: the round is over, here are its summary and evidence. An escape (a client that ignored its redirect) and an unreadable record make the round `not_run`; THIS callback is the only place that
   * fact is delivered, so whoever supplies it (TE-B5/TE-A3's evidence and check statuses) must turn `evidence.result === "not_run"` into "not run" check results, never a pass. `withModelHelperRound` refuses a plan without it.
   */
  onResult(result: ModelHelperRoundResult): void;
}

export const MODEL_HELPER_START_FAILED_SENTENCE = "not run: the model helper could not start";
export const MODEL_HELPER_AGENT_COMMAND_SENTENCE = "not run: a replayed agent command cannot be pointed at the model helper on this machine yet";

/** What `RunTaskDependencies.modelHelperRound` holds: a plan, or a function that makes one for this task's workspace (the laptop's wiring knows the repository and the base commit). Absent: nothing changes. */
export type ModelHelperRoundSource = ModelHelperRoundPlan | ((context: { readonly rootPath: string }) => ModelHelperRoundPlan | undefined);
export function modelHelperPlanFor(source: ModelHelperRoundSource | undefined, context: { readonly rootPath: string }): ModelHelperRoundPlan | undefined {
  return typeof source === "function" ? source(context) : source;
}

/** Each invocation owns its collector. Take immediately after the candidate round, before baseline or original-code rounds. */
export function modelHelperReplyCollector(): { wrap(plan: ModelHelperRoundPlan | undefined): ModelHelperRoundPlan | undefined; take(): ScriptedReplyFacts | undefined } {
  let latest: ScriptedReplyFacts | undefined;
  return {
    wrap(plan) {
      // Leave an invalid plan intact so withModelHelperRound's required-consumer guard still refuses it.
      if (plan === undefined || typeof plan.onResult !== "function") return plan;
      return { ...plan, onResult(result) {
        const replies = result.scriptedReplies;
        latest = replies === undefined || replies === "unknown" ? replies : replies.map((entry) => ({ ...entry }));
        plan.onResult(result);
      } };
    },
    take() { const facts = latest; latest = undefined; return facts; },
  };
}

// One total allowance per round, not per command. The summary port reads no project files and late read results are ignored.
const REPLY_FACTS_MAX = 200;
const SUMMARY_READ_MAX_BYTES = 256 * 1024;
const SUMMARY_READ_MAX_MS = 1000;

/** `runners` for a round with the model helper, or the same object for one without. */
export function withModelHelperRound(plan: ModelHelperRoundPlan | undefined, runners: CheckRunners): CheckRunners {
  if (plan === undefined) return runners;
  // An escape reaches only `onResult`: a plan with no consumer would let a round that called a real model host pass in silence.
  if (typeof (plan as { onResult?: unknown }).onResult !== "function") throw new TypeError("a model helper plan needs an onResult consumer that turns an escape into 'not run' checks (TE-B5/TE-A3)");
  let helper: Promise<StartedModelHelper | undefined> | undefined;
  let currentId: string | undefined;
  let unknown = false;
  let previous = { taskMade: 0, counted: 0 };
  let facts = new Map<string, { checkId: string; taskMade: number; counted: number }>();
  let readMs = 0;
  let readBytes = 0;
  let reads = 0;
  const ensure = (signal: AbortSignal): Promise<StartedModelHelper | undefined> => {
    helper ??= plan.start(signal).catch((): never => {
      throw new CheckNotRunError(MODEL_HELPER_START_FAILED_SENTENCE);
    });
    return helper;
  };
  const read = async (started: StartedModelHelper, signal?: AbortSignal): Promise<ModelHelperSummary | undefined> => {
    const began = performance.now();
    const left = SUMMARY_READ_MAX_MS - readMs;
    if (left <= 0 || reads >= REPLY_FACTS_MAX + 1 || readBytes >= SUMMARY_READ_MAX_BYTES || signal?.aborted === true) { unknown = true; return undefined; }
    reads++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => started.readSummary()),
        new Promise<undefined>((resolve) => {
          abort = () => resolve(undefined);
          signal?.addEventListener("abort", abort, { once: true });
          timer = setTimeout(() => { readMs = SUMMARY_READ_MAX_MS; resolve(undefined); }, left);
        }),
      ]);
      // Bound arrays before schema traversal (the port's TS type is not a runtime check).
      if (!Array.isArray(result?.escapes?.hosts) || result.escapes.hosts.length > MODEL_SUMMARY_MAX_ESCAPE_HOSTS) { unknown = true; return undefined; }
      const parsed = ModelHelperSummarySchema.safeParse(result);
      if (!parsed.success) { unknown = true; return undefined; }
      readBytes += Buffer.byteLength(JSON.stringify(parsed.data));
      if (readBytes > SUMMARY_READ_MAX_BYTES) { unknown = true; return undefined; }
      if (!parsed.data.trusted || parsed.data.replySetDigest !== started.pinnedDigest) { unknown = true; return UNTRUSTED_MODEL_SUMMARY; }
      if (parsed.data.scripted.task_made < previous.taskMade || parsed.data.countsTowardProof < previous.counted) unknown = true;
      return parsed.data;
    } catch {
      unknown = true;
      return undefined;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (abort !== undefined) signal?.removeEventListener("abort", abort);
      readMs += performance.now() - began;
    }
  };
  const afterCommand = async (started: StartedModelHelper, signal: AbortSignal) => {
    const id = currentId;
    currentId = undefined;
    // Without an id, attribution is already impossible. Keep the existing final evidence read, but never guess a position.
    if (id === undefined) { unknown = true; return; }
    const summary = await read(started, signal);
    if (summary === undefined || !summary.trusted || unknown) return;
    const next = { taskMade: summary.scripted.task_made, counted: summary.countsTowardProof };
    const old = facts.get(id) ?? { checkId: id, taskMade: 0, counted: 0 };
    if (!facts.has(id) && facts.size >= REPLY_FACTS_MAX) { unknown = true; return; }
    facts.set(id, { checkId: id, taskMade: old.taskMade + next.taskMade - previous.taskMade, counted: old.counted + next.counted - previous.counted });
    previous = next;
  };
  const wrapped: CheckRunners = {
    ...runners,
    // The inner scope's own runners must get the same wrapper; spreading scopeRound alone bypasses the helper entirely.
    ...(runners.scopeRound === undefined ? {} : { scopeRound: (checkPlan, signal, run, remainingMs) => runners.scopeRound!(checkPlan, signal, (scoped) => run(withModelHelperRound(plan, scoped)), remainingMs) }),
    beginCheck(checkId) {
      currentId = typeof checkId === "string" && /^(?:readiness|agent):(0|[1-9]\d{0,5})$/u.test(checkId) ? checkId : undefined;
      if (currentId === undefined) unknown = true;
      runners.beginCheck?.(checkId);
    },
    async runProjectCommand(command, signal) {
      const started = await ensure(signal);
      if (started === undefined) return runners.runProjectCommand(command, signal);
      // The helper's variables win; preserve only a GOOGLE_APPLICATION_CREDENTIALS explicitly set by the project (decision 174).
      const unset = Object.fromEntries(started.unsetEnvironment.filter((name) => name !== "GOOGLE_APPLICATION_CREDENTIALS" || !Object.hasOwn(command.env ?? {}, name)).map((name) => [name, undefined])) as unknown as Record<string, string>;
      try {
        return await runners.runProjectCommand({ ...command, env: { ...(command.env ?? {}), ...started.commandEnvironment, ...unset } }, signal);
      } finally { await afterCommand(started, signal); }
    },
    async runAgentCommand(replay, timeoutMs, signal) {
      const started = await ensure(signal);
      if (started === undefined) return runners.runAgentCommand(replay, timeoutMs, signal);
      try {
        // A laptop replay cannot receive the redirect, so the existing refusal stays intact.
        if (Object.keys(started.commandEnvironment).length > 0 || started.unsetEnvironment.length > 0) throw new CheckNotRunError(MODEL_HELPER_AGENT_COMMAND_SENTENCE);
        return await runners.runAgentCommand(replay, timeoutMs, signal);
      } finally { await afterCommand(started, signal); }
    },
    async endRound() {
      const current = helper;
      try {
        const started = current === undefined ? undefined : await current.catch(() => undefined);
        if (started !== undefined) {
          const summary = await read(started);
          const evidence = modelHelperEvidence(summary, plan.blockList, plan.hostSuffixes === undefined ? {} : { hostSuffixes: plan.hostSuffixes });
          // Any calls after the last command settled have no reliable check attribution.
          if (summary?.scripted.task_made !== previous.taskMade || summary?.countsTowardProof !== previous.counted || evidence.result === "not_run") unknown = true;
          try {
            plan.onResult({ summary, evidence, scriptedReplies: unknown ? "unknown" : [...facts.values()] });
          } catch {
            // A sink that throws must not keep the helper up or the round open.
          }
          await started.stop().catch(() => undefined);
        }
      } finally {
        helper = undefined; currentId = undefined; unknown = false;
        previous = { taskMade: 0, counted: 0 }; facts = new Map(); readMs = 0; readBytes = 0; reads = 0;
        await runners.endRound?.();
      }
    },
  };
  return wrapped;
}
