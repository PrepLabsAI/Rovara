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
import type { ModelHelperSummary } from "./model-helper-ledger.js";
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
  /** Variables the round's project commands get (the laptop's: the redirect, the dummy keys). Empty for a hosted helper, whose variables reach the sandbox through F1-b's env file. */
  readonly commandEnvironment: Readonly<Record<string, string>>;
  /** The summary, or undefined when it cannot be read: never "no calls". */
  readSummary(): Promise<ModelHelperSummary | undefined>;
  /** Stops the helper and removes its files (idempotent, never throws). */
  stop(): Promise<void>;
}
export interface ModelHelperRoundResult {
  readonly summary: ModelHelperSummary | undefined;
  readonly evidence: ModelHelperEvidence;
}
export interface ModelHelperRoundPlan {
  /** Starts the helper for one round; undefined when this round has none (the project has no reply set). A rejection makes the round's commands "not run". */
  start(signal: AbortSignal): Promise<StartedModelHelper | undefined>;
  /** F0a's `modelHostBlockList(rows, gateways)`. */
  readonly blockList: readonly string[];
  readonly hostSuffixes?: readonly string[];
  /** The round is over: its summary and evidence. */
  onResult?(result: ModelHelperRoundResult): void;
}

export const MODEL_HELPER_START_FAILED_SENTENCE = "not run: the model helper could not start";
export const MODEL_HELPER_AGENT_COMMAND_SENTENCE = "not run: a replayed agent command cannot be pointed at the model helper on this machine yet";

/** What `RunTaskDependencies.modelHelperRound` holds: a plan, or a function that makes one for this task's workspace (the laptop's wiring knows the repository and the base commit). Absent: nothing changes. */
export type ModelHelperRoundSource = ModelHelperRoundPlan | ((context: { readonly rootPath: string }) => ModelHelperRoundPlan | undefined);
export function modelHelperPlanFor(source: ModelHelperRoundSource | undefined, context: { readonly rootPath: string }): ModelHelperRoundPlan | undefined {
  return typeof source === "function" ? source(context) : source;
}

/** `runners` for a round with the model helper, or the same object for one without. */
export function withModelHelperRound(plan: ModelHelperRoundPlan | undefined, runners: CheckRunners): CheckRunners {
  if (plan === undefined) return runners;
  let helper: Promise<StartedModelHelper | undefined> | undefined;
  const ensure = (signal: AbortSignal): Promise<StartedModelHelper | undefined> => {
    helper ??= plan.start(signal).catch((): never => {
      throw new CheckNotRunError(MODEL_HELPER_START_FAILED_SENTENCE);
    });
    return helper;
  };
  const wrapped: CheckRunners = {
    async runProjectCommand(command, signal) {
      const started = await ensure(signal);
      if (started === undefined) return runners.runProjectCommand(command, signal);
      // The helper's variables go LAST: they win over the command's own and over the worker's (a real key in the user's shell is overridden with the dummy).
      return runners.runProjectCommand({ ...command, env: { ...(command.env ?? {}), ...started.commandEnvironment } }, signal);
    },
    async runAgentCommand(replay, timeoutMs, signal) {
      const started = await ensure(signal);
      // A replayed agent command runs with the worker's own environment, which on a laptop holds the user's real keys and no redirect: fail closed rather than let it call a real model.
      if (started !== undefined && Object.keys(started.commandEnvironment).length > 0) throw new CheckNotRunError(MODEL_HELPER_AGENT_COMMAND_SENTENCE);
      return runners.runAgentCommand(replay, timeoutMs, signal);
    },
    async endRound() {
      const current = helper;
      helper = undefined;
      try {
        const started = current === undefined ? undefined : await current.catch(() => undefined);
        if (started !== undefined) {
          const summary = await started.readSummary().catch(() => undefined);
          try {
            plan.onResult?.({ summary, evidence: modelHelperEvidence(summary, plan.blockList, plan.hostSuffixes === undefined ? {} : { hostSuffixes: plan.hostSuffixes }) });
          } catch {
            // a sink that throws must not keep the helper up or the round open
          }
          await started.stop().catch(() => undefined);
        }
      } finally {
        await runners.endRound?.();
      }
    },
  };
  if (runners.freshServices !== undefined) wrapped.freshServices = (signal) => runners.freshServices!(signal);
  if (runners.resetBetweenChecks !== undefined) wrapped.resetBetweenChecks = (signal) => runners.resetBetweenChecks!(signal);
  return wrapped;
}
