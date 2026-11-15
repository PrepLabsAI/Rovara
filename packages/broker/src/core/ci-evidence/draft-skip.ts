// TE-E0 option A: does the customer's CI skip draft pull requests? Rovara opens its pull requests as drafts first, so a pipeline that ignores drafts would never report, and Rovara would wait out every
// marked check. Setup reads the workflow files of the default branch (as data, never run) and says one of three things: skips drafts (and in which files), runs on drafts, or "can't tell". It never
// guesses: a file it cannot read or parse, a trigger shape it does not know, too many files, or no pull request workflow at all is "can't tell", for the whole repository.
import { parse } from "yaml";
import { WORKFLOW_FOLDER, type CiDefinitionReader } from "../../rovara-code/ci-checks.js";

/** At most this many workflow files are read (more: "can't tell"), each at most this many bytes, and this many bytes in all. */
export const DRAFT_SCAN_FILES_MAX = 20;
export const DRAFT_SCAN_FILE_BYTES_MAX = 64 * 1024;
export const DRAFT_SCAN_TOTAL_BYTES_MAX = 512 * 1024;

export type DraftSkip =
  | { verdict: "skips_drafts"; workflows: string[] }
  | { verdict: "runs_on_drafts" }
  | { verdict: "unknown" };

const PR_EVENTS = ["pull_request", "pull_request_target"] as const;
/** The pull request activity types a draft's push or opening raises. A `types` list with none of them runs only when something else happens (marked ready, labelled). */
const DRAFT_TYPES: ReadonlySet<string> = new Set(["opened", "synchronize", "reopened"]);
/** A condition that reads the draft flag (`github.event.pull_request.draft`, in any spacing or quoting). */
const DRAFT_CONDITION = /pull_request\s*\.\s*draft|pull_request\s*\[\s*['"]draft['"]\s*\]/u;

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

type FileVerdict = "skips" | "runs" | "not_pull_request" | "unknown";

/** One workflow file's answer. */
export function draftVerdictOf(text: string): FileVerdict {
  let workflow: unknown;
  try {
    workflow = parse(text, { maxAliasCount: 50 });
  } catch {
    return "unknown";
  }
  if (!isRecord(workflow)) return "unknown";
  const on = workflow["on"] ?? workflow["true"];
  let triggers: Record<string, unknown>;
  if (typeof on === "string") triggers = Object.fromEntries([[on, null]]);
  else if (Array.isArray(on)) {
    if (!on.every((event) => typeof event === "string")) return "unknown";
    triggers = Object.fromEntries(on.map((event: string) => [event, null]));
  } else if (isRecord(on)) triggers = on;
  else return "unknown";
  const events = PR_EVENTS.filter((event) => Object.hasOwn(triggers, event));
  if (events.length === 0) return "not_pull_request";
  // Every pull request trigger must raise draft events, or it runs only when the draft is marked ready.
  let anyDraftTrigger = false;
  for (const event of events) {
    const config = triggers[event];
    if (config === null || config === undefined) { anyDraftTrigger = true; continue; }
    if (!isRecord(config)) return "unknown";
    const types = config["types"];
    if (types === undefined) { anyDraftTrigger = true; continue; }
    const list = typeof types === "string" ? [types] : types;
    if (!Array.isArray(list) || !list.every((type) => typeof type === "string")) return "unknown";
    if (list.some((type) => DRAFT_TYPES.has(type))) anyDraftTrigger = true;
  }
  if (!anyDraftTrigger) return "skips";
  // A condition anywhere in the file that reads the draft flag (on a job, a step, or the workflow's concurrency) is taken as "skips drafts": it is there to tell drafts apart.
  if (!isRecord(workflow["jobs"])) return "unknown";
  return DRAFT_CONDITION.test(text) ? "skips" : "runs";
}

/** The repository's answer, from the default branch's workflow files read through a read-only reader. */
export async function detectDraftSkip(reader: CiDefinitionReader): Promise<DraftSkip> {
  try {
    const listing = await reader.list(WORKFLOW_FOLDER);
    if (listing === undefined || listing.truncated) return { verdict: "unknown" };
    const paths = listing.entries.filter((entry) => entry.type === "file" && /\.ya?ml$/iu.test(entry.name)).map((entry) => entry.path).sort();
    if (paths.length === 0 || paths.length > DRAFT_SCAN_FILES_MAX) return { verdict: "unknown" };
    let total = 0;
    const skipping: string[] = [];
    let anyRuns = false;
    for (const path of paths) {
      const file = await reader.read(path, DRAFT_SCAN_FILE_BYTES_MAX);
      if (file === undefined || file.tooLarge === true) return { verdict: "unknown" };
      total += file.text.length;
      if (total > DRAFT_SCAN_TOTAL_BYTES_MAX) return { verdict: "unknown" };
      const verdict = draftVerdictOf(file.text);
      if (verdict === "unknown") return { verdict: "unknown" };
      if (verdict === "skips") skipping.push(path);
      if (verdict === "runs") anyRuns = true;
    }
    if (skipping.length > 0) return { verdict: "skips_drafts", workflows: skipping };
    return anyRuns ? { verdict: "runs_on_drafts" } : { verdict: "unknown" };
  } catch {
    return { verdict: "unknown" };
  }
}
