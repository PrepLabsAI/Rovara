// Spec 051 Ruling J: the "before" of a project check is the last known outcome of that exact command in this workspace.
// The final round of each task records its project-check outcomes in .agentx/last-checks.json; before any task has,
// a command that preparation ran (and so passed, since the workspace is READY) counts as passed, and any other as
// unknown, so a check added in a later revision that already fails is never blamed on the agent.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CheckEntry, CheckOutcome, ProjectCommand } from "@agentx/contracts";

export const CHECK_HISTORY_PATH = ".agentx/last-checks.json";
const HISTORY_PATH = CHECK_HISTORY_PATH;
/** The outcomes worth keeping: a real result, not `unknown` or `not_run`. */
type KnownOutcome = "passed" | "failed" | "timed_out";
const KNOWN: readonly string[] = ["passed", "failed", "timed_out"];
const KEY = /^[0-9a-f]{64}$/;

function isKnown(value: unknown): value is KnownOutcome {
  return typeof value === "string" && KNOWN.includes(value);
}

/** The file's outcomes, or undefined when it is not a version-1 history. Entries that are not well formed are dropped. */
function parseHistory(value: unknown): Record<string, KnownOutcome> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const file = value as { schemaVersion?: unknown; outcomes?: unknown };
  if (file.schemaVersion !== 1 || typeof file.outcomes !== "object" || file.outcomes === null) return undefined;
  const outcomes: Record<string, KnownOutcome> = {};
  for (const [key, outcome] of Object.entries(file.outcomes)) if (KEY.test(key) && isKnown(outcome)) outcomes[key] = outcome;
  return outcomes;
}

export interface CheckHistory {
  /** The last known outcome per projectCheckKey, from earlier tasks' final rounds. */
  lastOutcomes: Record<string, CheckOutcome>;
  /** The keys of the readiness commands preparation ran, all of which passed. */
  preparedKeys: readonly string[];
}

/** A stable key for a command: its cwd, executable, args and env (in name order). Not its timeout. */
export function projectCheckKey(command: ProjectCommand): string {
  const env = Object.entries(command.env ?? {}).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return createHash("sha256").update(JSON.stringify([command.cwd, command.executable, command.args, env])).digest("hex");
}

/** The before of each readiness command: last known outcome, else passed if preparation ran it, else unknown. */
export function projectBefore(readiness: readonly ProjectCommand[], history: CheckHistory | undefined): CheckOutcome[] {
  return readiness.map((command) => {
    const key = projectCheckKey(command);
    return history?.lastOutcomes[key] ?? (history?.preparedKeys.includes(key) === true ? "passed" : "unknown");
  });
}

/** A history file larger than this is not read: it is far beyond 64 checks' worth (M-10). */
const MAX_HISTORY_BYTES = 1_048_576;

/**
 * The workspace's history. Read it before the agent's session starts, and keep that snapshot for the task's rounds:
 * the agent can write to `.agentx`, so a read after the agent has run may see a file the agent wrote (Ruling L).
 *
 * A missing file is no history: checks fall back to the preparation keys (passed), then unknown. A file that exists but
 * cannot be used (a symlink or other non-regular file, larger than 1 MiB, not JSON, or not a version-1 history) makes
 * every before unknown, preparation keys included: an earlier task may have left a check failing, and passed would then
 * blame this task for it (M-11). A manifest written before the keys were recorded has no prepared keys.
 */
export async function readCheckHistory(rootPath: string, manifest: { readinessCommandKeys?: readonly string[] }): Promise<CheckHistory> {
  const preparedKeys = [...(manifest.readinessCommandKeys ?? [])];
  const path = resolve(rootPath, HISTORY_PATH);
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { lastOutcomes: {}, preparedKeys };
    return { lastOutcomes: {}, preparedKeys: [] };
  }
  if (!metadata.isFile() || metadata.size > MAX_HISTORY_BYTES) return { lastOutcomes: {}, preparedKeys: [] };
  let outcomes: Record<string, KnownOutcome> | undefined;
  try {
    // O_NOFOLLOW: a symlink swapped in after the lstat is not followed either.
    const text = await readFile(path, { encoding: "utf8", flag: constants.O_RDONLY | constants.O_NOFOLLOW });
    outcomes = text.length > MAX_HISTORY_BYTES ? undefined : parseHistory(JSON.parse(text));
  } catch {
    outcomes = undefined;
  }
  return outcomes === undefined ? { lastOutcomes: {}, preparedKeys: [] } : { lastOutcomes: outcomes, preparedKeys };
}

/**
 * Records a final round's project-check outcomes, merged over the earlier ones. A check that was not run (or not
 * rerun) keeps its last known outcome. Written to a temporary file and renamed, so a crash never leaves half a file.
 * Task 4 calls this after the final round only, with `base` the snapshot read before the session started: the agent
 * may have rewritten the file since, and a merge over the file would keep what it wrote (Ruling L).
 */
export async function recordProjectOutcomes(
  rootPath: string,
  plan: { source: string; readiness?: readonly ProjectCommand[] },
  entries: readonly CheckEntry[],
  base?: Pick<CheckHistory, "lastOutcomes">,
): Promise<void> {
  if (plan.source !== "project" || plan.readiness === undefined) return;
  const updates: Record<string, KnownOutcome> = {};
  for (const entry of entries) {
    const match = /^readiness:(\d+)$/.exec(entry.id);
    const command = match === null ? undefined : plan.readiness[Number(match[1])];
    if (command === undefined || entry.source !== "project" || !isKnown(entry.after)) continue;
    updates[projectCheckKey(command)] = entry.after;
  }
  if (Object.keys(updates).length === 0) return;
  await writeOutcomes(rootPath, base ?? await readCheckHistory(rootPath, {}), updates);
}

/**
 * Spec 051 Ruling M: a preparation whose readiness passed records each command as passed, so an outcome a task left
 * failing before the workspace was prepared again cannot class a later regression as already failing.
 */
export async function recordPreparedOutcomes(rootPath: string, readiness: readonly ProjectCommand[]): Promise<void> {
  if (readiness.length === 0) return;
  const updates: Record<string, KnownOutcome> = {};
  for (const command of readiness) updates[projectCheckKey(command)] = "passed";
  await writeOutcomes(rootPath, await readCheckHistory(rootPath, {}), updates);
}

async function writeOutcomes(
  rootPath: string,
  base: Pick<CheckHistory, "lastOutcomes">,
  updates: Record<string, KnownOutcome>,
): Promise<void> {
  const outcomes: Record<string, KnownOutcome> = {};
  for (const [key, outcome] of Object.entries(base.lastOutcomes)) if (isKnown(outcome)) outcomes[key] = outcome;
  Object.assign(outcomes, updates);
  const directory = resolve(rootPath, ".agentx");
  await mkdir(directory, { recursive: true });
  const temporary = resolve(directory, `.last-checks.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, outcomes }, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, resolve(rootPath, HISTORY_PATH));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
