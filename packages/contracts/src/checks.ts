// Spec 051: the coding agent proves its work, and AgentX checks it. The pure parts, shared by the
// worker (which runs checks), the broker (which keeps the report and shapes the PR) and Slack.
import { createHash } from "node:crypto";
import { z } from "zod";

/** Covers AGENTX_WORKER_PROMPT and AGENTX_PREAMBLE: changing either means a new version. 1 had only the preamble. */
export const AGENTX_PREAMBLE_VERSION = "2";

/**
 * Replaces Pi's own system prompt preamble for every coding task and eval run. Pi's is written for a person at a
 * terminal and points at Pi's documentation; the worker runs alone and its changes may become a pull request.
 * Pi's tool list and tool rules go with it: the tool definitions still reach the model, and the two rules worth
 * keeping are here. Eval runs see it too, so it does not say where the task came from.
 */
export const AGENTX_WORKER_PROMPT = [
  "You are the AgentX coding worker. AgentX gave you a software task to carry out in a prepared workspace. You work alone: nobody can answer questions while you work, and your changes may become a pull request that people review.",
  "",
  "How to work:",
  "- Find the relevant code before changing it, and read a file before you edit it.",
  "- Make the smallest change that fully does what was asked, in the style of the code around it. Don't refactor, rename or reformat code the task doesn't need changed, and keep existing comments and logging.",
  "- When something is unclear, take the most reasonable reading, carry on, and say what you assumed in your final message.",
  "- If the same error comes back after two attempts at a fix, stop repeating it. Re-read the error, note what you have tried, and test a different explanation.",
  "",
  "Tools:",
  "- Use read to look at files rather than cat or sed. Use edit to change existing files, and write only for new files or complete rewrites.",
  "",
  "Final message:",
  "Keep it short. Say what you changed and why, name the files, give the commands you ran with their results, and list any assumptions or anything left undone.",
].join("\n");

/** Appended to Pi's system prompt for every coding task and eval run (FR-001). Changing it means a new version. */
export const AGENTX_PREAMBLE = [
  "AgentX checks your work after you finish. Work this way:",
  "1. Reproduce the problem before changing code, and say how you reproduced it.",
  "2. Run the relevant tests before and after your change.",
  "3. A test that passed before your change and fails after it is your own regression. Fix it; never call it unrelated.",
  "4. Report the commands you ran and their results.",
  "5. You must never claim a test passed unless you saw it pass.",
  "End your final message with exactly one line: \"AgentX result: done\" if the work is complete and every test you ran passes, otherwise \"AgentX result: not done\".",
].join("\n");

/** Recorded as `preambleSha256` with each result. From version 2 it hashes the worker prompt and the preamble together. */
export function agentxPreambleSha256(): string {
  return createHash("sha256").update(`${AGENTX_WORKER_PROMPT}\n\n${AGENTX_PREAMBLE}`).digest("hex");
}

export const CheckOutcomeSchema = z.enum(["passed", "failed", "timed_out", "unknown", "not_run"]);
export type CheckOutcome = z.infer<typeof CheckOutcomeSchema>;

export const CheckClassSchema = z.enum(["passing", "regression", "already_failing", "fixed", "failing_no_before", "not_rerun"]);
export type CheckClass = z.infer<typeof CheckClassSchema>;

export const CheckEntrySchema = z.object({
  /** `readiness:<index>` for a project check, `agent:<n>` for the agent's own command. */
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(8_192),
  source: z.enum(["project", "agent_commands"]),
  before: CheckOutcomeSchema,
  after: CheckOutcomeSchema,
  class: CheckClassSchema,
  /** Trimmed, redacted tail of the after run. */
  output: z.string().max(65_536),
  durationMs: z.number().int().nonnegative(),
}).strict();
export type CheckEntry = z.infer<typeof CheckEntrySchema>;

export const CheckReportSchema = z.object({
  status: z.enum(["verified", "regression", "not_verified"]),
  notVerifiedReason: z.enum(["no_checks", "stopped", "error"]).optional(),
  source: z.enum(["project", "agent_commands", "none"]),
  preambleVersion: z.string().min(1).max(16),
  preambleSha256: z.string().regex(/^[0-9a-f]{64}$/),
  checks: z.array(CheckEntrySchema).max(64),
  /** `given` when the first rerun found a regression and the agent had its one extra turn (FR-006). */
  extraTry: z.enum(["not_needed", "given"]),
  agentClaim: z.enum(["success", "failure", "none"]),
}).strict();
export type CheckReport = z.infer<typeof CheckReportSchema>;

const TEST_HEADS: readonly (readonly string[])[] = [
  ["npm", "test"], ["npm", "run", "test"], ["pnpm", "test"], ["yarn", "test"], ["pytest"],
  ["python", "-m", "pytest"], ["go", "test"], ["cargo", "test"], ["make", "test"], ["mvn", "test"],
  ["gradle", "test"], ["./gradlew", "test"], ["bundle", "exec", "rspec"], ["phpunit"], ["tox"],
];
/** Only a plain space and these characters may appear: no quoting, expansion, globbing, redirection or control characters. */
const ALLOWED = /^[A-Za-z0-9_@%+=:,./ -]*$/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=\S*$/;

/** A cd target must stay inside the workspace: relative, not an option, no `..` segment. */
function safeCdPath(path: string): boolean {
  return path.length > 0 && !path.startsWith("-") && !path.startsWith("/") && !path.split("/").includes("..");
}

/** A word, or the value after `=` in it, must not point outside the workspace: absolute, home-relative or `..`. */
function escapesWorkspace(word: string): boolean {
  const eq = word.indexOf("=");
  return [word, ...(eq === -1 ? [] : [word.slice(eq + 1)])].some(
    (part) => part.startsWith("/") || part.startsWith("~") || part.split("/").includes(".."),
  );
}

/**
 * A trailing `| tail -N` (or `-n N`, `-nN`), and a `2>&1` before it or on its own: they only shape what the agent
 * reads. `tail` reads all of its input, so the test still runs to its end; `head` stops early and is not accepted.
 */
const OUTPUT_TAIL = /^(.*?) *\| *tail +-(?:n *)?\d+ *$/s;
const MERGED_STDERR = /^(.*?) +2>&1 *$/s;

/** `command` without its output tail (OUTPUT_TAIL), and whether it was piped into `tail`. */
export function withoutOutputTail(command: string): { command: string; piped: boolean } {
  const piped = OUTPUT_TAIL.exec(command);
  const rest = piped === null ? command : piped[1]!;
  const merged = MERGED_STDERR.exec(rest);
  return { command: merged === null ? rest : merged[1]!, piped: piped !== null };
}

/**
 * The command to replay if `command` is a simple test command (P-6), else undefined. A trailing `2>&1` and
 * `| tail -N` are allowed and left out of the replay, which AgentX runs for its exit code alone.
 */
export function matchTestCommand(command: string): string | undefined {
  const bare = withoutOutputTail(command).command;
  const cd = /^ *cd +(\S+) +&& +(.+)$/s.exec(bare);
  const rest = (cd === null ? bare : cd[2]!).replace(/^ +| +$/g, "");
  if (rest.length === 0 || !ALLOWED.test(rest)) return undefined;
  if (cd !== null && (!ALLOWED.test(cd[1]!) || !safeCdPath(cd[1]!))) return undefined;
  const words = rest.split(/ +/);
  if (words.some(escapesWorkspace)) return undefined;
  let index = 0;
  while (index < words.length && ASSIGNMENT.test(words[index]!)) index += 1;
  if (words[index] === "timeout" && /^\d+[smh]?$/.test(words[index + 1] ?? "")) index += 2;
  const tail = words.slice(index);
  const matches = TEST_HEADS.some((head) => head.every((word, position) => tail[position] === word));
  return matches ? (cd === null ? rest : `cd ${cd[1]} && ${rest}`) : undefined;
}

/**
 * True for a test command piped into `tail`. The agent's shell runs it with `pipefail`, so its exit code is the
 * test's rather than tail's, which is always 0, and the recorder can take that run as a before result. The cd
 * target is not checked: pipefail changes nothing else, and an eval's container paths only become workspace paths
 * for the matcher.
 */
export function isPipedTestCommand(command: string): boolean {
  const { command: bare, piped } = withoutOutputTail(command);
  if (!piped) return false;
  const cd = /^ *cd +\S+ +&& +(.+)$/s.exec(bare);
  const rest = cd === null ? bare : cd[1]!;
  return !/^ *cd /.test(rest) && matchTestCommand(rest) !== undefined;
}

export function classifyCheck(before: CheckOutcome, after: CheckOutcome): CheckClass {
  if (after === "not_run" || after === "unknown") return "not_rerun";
  const afterPassed = after === "passed";
  if (before === "passed") return afterPassed ? "passing" : "regression";
  if (before === "failed" || before === "timed_out") return afterPassed ? "fixed" : "already_failing";
  return afterPassed ? "passing" : "failing_no_before";
}

export function parseAgentClaim(text: string | undefined): "success" | "failure" | "none" {
  const last = (text ?? "").trimEnd().split("\n").at(-1)?.trim();
  if (last === "AgentX result: done") return "success";
  if (last === "AgentX result: not done") return "failure";
  return "none";
}

/** `not_verified` when nothing was rerun (no entries, or every entry is `not_rerun`). */
export function reportStatus(checks: readonly CheckEntry[]): "verified" | "regression" | "not_verified" {
  if (checks.some((check) => check.class === "regression")) return "regression";
  if (checks.every((check) => check.class === "not_rerun")) return "not_verified";
  return "verified";
}

/**
 * The check report in a task operation's result (FR-007), or undefined. An older worker's result has none, and a
 * report that does not parse is treated the same way, so readers behave exactly as before (Review Focus 5).
 */
export function taskResultChecks(result: unknown): CheckReport | undefined {
  if (typeof result !== "object" || result === null || !("checks" in result)) return undefined;
  const parsed = CheckReportSchema.safeParse(result.checks);
  return parsed.success ? parsed.data : undefined;
}
