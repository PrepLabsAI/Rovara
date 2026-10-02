// Spec 051 Ruling J: the "before" of a project check is the last known outcome of that exact command in this workspace.
// The final round of each task records its project-check outcomes in .agentx/last-checks.json; before any task has,
// a command that preparation ran (and so passed, since the workspace is READY) counts as passed, and any other as
// unknown, so a check added in a later revision that already fails is never blamed on the agent.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CheckEntry, CheckOutcome, ProjectCommand } from "@agentx/contracts";

const HISTORY_PATH = ".agentx/last-checks.json";
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

/**
 * The workspace's history. A missing or malformed file is no history (the safe side: checks fall back to the
 * preparation keys, then unknown). A manifest written before the keys were recorded has no prepared keys.
 */
export async function readCheckHistory(rootPath: string, manifest: { readinessCommandKeys?: readonly string[] }): Promise<CheckHistory> {
  let lastOutcomes: Record<string, CheckOutcome> = {};
  try {
    lastOutcomes = parseHistory(JSON.parse(await readFile(resolve(rootPath, HISTORY_PATH), "utf8"))) ?? {};
  } catch {
    // Missing or not JSON: no history.
  }
  return { lastOutcomes, preparedKeys: [...(manifest.readinessCommandKeys ?? [])] };
}

/**
 * Records a final round's project-check outcomes, merged over the earlier ones. A check that was not run (or not
 * rerun) keeps its last known outcome. Written to a temporary file and renamed, so a crash never leaves half a file.
 * Task 4 calls this after the final round only.
 */
export async function recordProjectOutcomes(
  rootPath: string,
  plan: { source: string; readiness?: readonly ProjectCommand[] },
  entries: readonly CheckEntry[],
): Promise<void> {
  if (plan.source !== "project" || plan.readiness === undefined) return;
  const current = await readCheckHistory(rootPath, {});
  const outcomes: Record<string, KnownOutcome> = {};
  for (const [key, outcome] of Object.entries(current.lastOutcomes)) if (isKnown(outcome)) outcomes[key] = outcome;
  let changed = false;
  for (const entry of entries) {
    const match = /^readiness:(\d+)$/.exec(entry.id);
    const command = match === null ? undefined : plan.readiness[Number(match[1])];
    if (command === undefined || entry.source !== "project" || !isKnown(entry.after)) continue;
    outcomes[projectCheckKey(command)] = entry.after;
    changed = true;
  }
  if (!changed) return;
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
