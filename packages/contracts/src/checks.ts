// Spec 051: the coding agent proves its work, and AgentX checks it. The pure parts, shared by the
// worker (which runs checks), the broker (which keeps the report and shapes the PR) and Slack.
import { createHash } from "node:crypto";
import { z } from "zod";

export const AGENTX_PREAMBLE_VERSION = "1";

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

export function agentxPreambleSha256(): string {
  return createHash("sha256").update(AGENTX_PREAMBLE).digest("hex");
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
const UNSAFE = /[|;&<>`]|\$\(/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=\S*$/;

/** The command to replay if `command` is a simple test command (P-6), else undefined. */
export function matchTestCommand(command: string): string | undefined {
  const trimmed = command.trim();
  const cd = /^cd\s+(\S+)\s+&&\s+(.+)$/.exec(trimmed);
  const rest = cd === null ? trimmed : cd[2]!;
  if (rest.length === 0 || UNSAFE.test(rest) || (cd !== null && UNSAFE.test(cd[1]!))) return undefined;
  const words = rest.split(/\s+/);
  let index = 0;
  while (index < words.length && ASSIGNMENT.test(words[index]!)) index += 1;
  if (words[index] === "timeout" && /^\d+[smh]?$/.test(words[index + 1] ?? "")) index += 2;
  const tail = words.slice(index);
  const matches = TEST_HEADS.some((head) => head.every((word, position) => tail[position] === word));
  return matches ? (cd === null ? rest : `cd ${cd[1]} && ${rest}`) : undefined;
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

export function reportStatus(checks: readonly CheckEntry[]): "verified" | "regression" {
  return checks.some((check) => check.class === "regression") ? "regression" : "verified";
}
