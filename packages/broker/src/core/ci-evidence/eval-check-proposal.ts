// L4-EVCI: which check of the customer's CI is their eval? Setup reads the workflow files of the default branch (as data, never run; the same reader and the same limits as the draft-skip reading) and PROPOSES the
// jobs that look like an eval, by name (the check a job reports is its `name`, else its id). A maintainer confirms one (or none) at setup, and only the confirmed name is stored (`CiEvidenceSettings.evalCheck`):
// no model decides anything, and nothing here runs at task time. It never guesses: a file it cannot read or parse, too many files, or no pull request workflow is "can't tell"; a job whose check name is not
// fixed (a matrix, a reusable workflow, a name built from an expression) is never proposed, because its check would not be found by name.
import { parse } from "yaml";
import { GITHUB_ACTIONS_APP_ID, type EvalCheck } from "@agentx/contracts";
import { WORKFLOW_FOLDER, type CiDefinitionReader } from "../../rovara-code/ci-checks.js";
import { DRAFT_SCAN_FILES_MAX, DRAFT_SCAN_FILE_BYTES_MAX, DRAFT_SCAN_TOTAL_BYTES_MAX } from "./draft-skip.js";

/** The most proposals offered (a repository with more eval-looking jobs than this gets the first, in file order, and the person is told the list was cut). */
export const EVAL_PROPOSALS_MAX = 5;

export interface EvalCheckProposal {
  /** The check as it would be stored if the person confirms it: the job's check name and the reporting app (GitHub Actions). */
  check: EvalCheck;
  /** The workflow file it is in, for the person to look at. */
  workflow: string;
  /** Why it looks like an eval: its name says so, or its commands do. */
  basis: "name" | "commands";
}

export type EvalCheckProposals =
  | { verdict: "proposals"; proposals: EvalCheckProposal[]; cut: boolean }
  | { verdict: "none_found" }
  | { verdict: "unknown" };

/** A job id, job name or workflow name that says it is an eval. */
const EVAL_WORD = /(?:^|[^a-z0-9])(?:evals?|evaluations?|deepeval|promptfoo|ragas)(?:$|[^a-z0-9])/iu;
/** A command that runs an eval: a tool that exists for it, or a path or module that is plainly one (`evals/`, `-m evals`). A bare `eval` is the shell's own and counts for nothing. */
const EVAL_COMMAND = /(?:^|[\s/='"])(?:evals?|evaluations?)\/|(?:^|\s)-m\s+(?:evals?|evaluations?)\b|(?:^|[^a-z0-9])(?:promptfoo|deepeval|ragas|braintrust|langsmith)(?:$|[^a-z0-9])/iu;
/** A check name that can be matched exactly: no expression, no control character, and a sensible length. */
const FIXED_NAME = /^[^\p{Cc}${}]{1,200}$/u;

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function runsOnPullRequest(on: unknown): boolean {
  if (typeof on === "string") return on === "pull_request" || on === "pull_request_target";
  if (Array.isArray(on)) return on.some((event) => event === "pull_request" || event === "pull_request_target");
  return isRecord(on) && (Object.hasOwn(on, "pull_request") || Object.hasOwn(on, "pull_request_target"));
}

/** One workflow file's proposals; undefined when the file cannot be read as a workflow (the whole answer is then "can't tell"). */
export function evalProposalsOf(path: string, text: string): EvalCheckProposal[] | undefined {
  let workflow: unknown;
  try {
    workflow = parse(text, { maxAliasCount: 50, logLevel: "error" });
  } catch {
    return undefined;
  }
  if (!isRecord(workflow)) return undefined;
  if (!runsOnPullRequest(workflow["on"] ?? workflow["true"])) return [];
  const jobs = workflow["jobs"];
  if (!isRecord(jobs)) return undefined;
  const workflowSays = typeof workflow["name"] === "string" && EVAL_WORD.test(workflow["name"]);
  const found: EvalCheckProposal[] = [];
  for (const [id, job] of Object.entries(jobs)) {
    if (!isRecord(job)) return undefined;
    // A matrix and a reusable workflow report checks whose names are built from more than the job's own: not found by name, so not proposed.
    if (job["strategy"] !== undefined && isRecord(job["strategy"]) && job["strategy"]["matrix"] !== undefined) continue;
    if (job["uses"] !== undefined) continue;
    const name = job["name"] === undefined ? id : job["name"];
    if (typeof name !== "string" || !FIXED_NAME.test(name)) continue;
    const steps = Array.isArray(job["steps"]) ? job["steps"] : [];
    const commandsSay = steps.some((step) => isRecord(step) && typeof step["run"] === "string" && EVAL_COMMAND.test(step["run"]));
    const nameSays = EVAL_WORD.test(id) || EVAL_WORD.test(name);
    // The workflow's own name counts only when it has no other job to be told apart from.
    if (nameSays || commandsSay || (workflowSays && Object.keys(jobs).length === 1)) {
      found.push({ check: { name, source: String(GITHUB_ACTIONS_APP_ID) }, workflow: path, basis: nameSays || workflowSays ? "name" : "commands" });
    }
  }
  return found;
}

/**
 * The proposals for a repository, from its default branch's workflow files read through a read-only reader. Anything that cannot be read whole is "unknown" for the whole repository, never a partial list.
 * A name proposed twice (two files) is offered once.
 */
export async function proposeEvalChecks(reader: CiDefinitionReader): Promise<EvalCheckProposals> {
  try {
    const listing = await reader.list(WORKFLOW_FOLDER);
    if (listing === undefined || listing.truncated) return { verdict: "unknown" };
    const paths = listing.entries.filter((entry) => entry.type === "file" && /\.ya?ml$/iu.test(entry.name)).map((entry) => entry.path).sort();
    if (paths.length === 0 || paths.length > DRAFT_SCAN_FILES_MAX) return { verdict: "unknown" };
    let total = 0;
    const all: EvalCheckProposal[] = [];
    for (const path of paths) {
      const file = await reader.read(path, DRAFT_SCAN_FILE_BYTES_MAX);
      if (file === undefined || file.tooLarge === true) return { verdict: "unknown" };
      total += Buffer.byteLength(file.text, "utf8");
      if (total > DRAFT_SCAN_TOTAL_BYTES_MAX) return { verdict: "unknown" };
      const found = evalProposalsOf(path, file.text);
      if (found === undefined) return { verdict: "unknown" };
      all.push(...found);
    }
    const seen = new Set<string>();
    const unique = all.filter((proposal) => (seen.has(proposal.check.name) ? false : (seen.add(proposal.check.name), true)));
    if (unique.length === 0) return { verdict: "none_found" };
    return { verdict: "proposals", proposals: unique.slice(0, EVAL_PROPOSALS_MAX), cut: unique.length > EVAL_PROPOSALS_MAX };
  } catch {
    return { verdict: "unknown" };
  }
}
