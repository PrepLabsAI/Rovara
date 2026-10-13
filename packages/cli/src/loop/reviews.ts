// rovara loop (#358, #359): the reviews the loop runs after the checks pass and before it publishes: a code review and
// a security review, each by Claude Code or Codex run headless and read-only in the item's worktree. They use Rovara's own
// reviewer rules: the same focus, JSON answer and blocking rule as the hosted reviews (contracts' review-output.ts).
// A finding blocks when the change introduced it and the code reviewer did not mark it advisory (a security finding
// is never advisory).
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkflowReviewerResponse, redactText, reviewerFocus, reviewJsonShape, unfence, type WorkflowReviewFinding } from "@agentx/contracts";
import { z } from "zod";
import type { LoopRepoConfig } from "./config.js";
import type { Exec } from "./exec.js";
import type { HarnessName } from "./harness.js";

export type ReviewRole = "CRITIC" | "SECURITY";

/** The diff a reviewer is shown, at most; the rest it can open with its read-only tools. */
const DIFF_MAX = 120_000;
/** A reviewer's tools: read files and git history, nothing that changes anything. */
const READ_ONLY_TOOLS = "Read,Grep,Glob,Bash(git diff:*),Bash(git log:*),Bash(git show:*)";

export interface ReviewerInput { harness: HarnessName; cwd: string; prompt: string; model: string | undefined; timeoutMs: number }
type ReviewerAnswer = { ok: true; text: string } | { ok: false; reason: string };
/** Runs one reviewer and answers its final text, or why it could not. */
export type ReviewerRun = (input: ReviewerInput) => Promise<ReviewerAnswer>;

/** Runs `command` with the prompt on stdin, within the timeout; its stdout, or the end of its stderr when it failed. */
function runHeadless(command: string, args: readonly string[], input: ReviewerInput): Promise<ReviewerAnswer> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: input.cwd, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); resolve({ ok: false, reason: `the reviewer did not answer within ${Math.round(input.timeoutMs / 1_000)}s` }); }, input.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { err += chunk.toString("utf8"); });
    child.on("error", (error: NodeJS.ErrnoException) => { clearTimeout(timer); resolve({ ok: false, reason: error.code === "ENOENT" ? `${command} is not installed or not on PATH` : error.message }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { ok: true, text: out } : { ok: false, reason: `${command} exited ${code ?? "on a signal"}: ${redactText(err.trim().split("\n").pop() ?? "").slice(0, 200)}` });
    });
    child.stdin.end(input.prompt);
  });
}

/** The command line of a headless, read-only reviewer: Claude Code in plan mode with only reading tools, or Codex in its read-only sandbox. */
export function reviewerCommand(input: Pick<ReviewerInput, "harness" | "cwd" | "model">, lastMessage: string): string[] {
  const model = input.model === undefined ? [] : ["--model", input.model];
  if (input.harness === "codex") return ["codex", "exec", "--sandbox", "read-only", "--cd", input.cwd, "--ephemeral", "--output-last-message", lastMessage, ...model, "-"];
  return ["claude", "-p", "--permission-mode", "plan", "--allowedTools", READ_ONLY_TOOLS, "--output-format", "text", ...model];
}

/** The reviewer the repository chose: Claude Code answers on stdout; Codex writes its last message to a file. */
export const agentReviewerRun: ReviewerRun = async (input) => {
  if (input.harness !== "codex") {
    const [command = "claude", ...args] = reviewerCommand(input, "");
    return runHeadless(command, args, input);
  }
  const dir = await mkdtemp(join(tmpdir(), "rovara-review-"));
  try {
    const lastMessage = join(dir, "answer.txt");
    const [command = "codex", ...args] = reviewerCommand(input, lastMessage);
    const ran = await runHeadless(command, args, input);
    if (!ran.ok) return ran;
    return { ok: true, text: await readFile(lastMessage, "utf8").catch(() => ran.text) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

export interface RoleResult {
  role: ReviewRole;
  /** PASS: nothing blocks. FINDINGS: something blocks. UNKNOWN: the review could not be run or read. */
  status: "PASS" | "FINDINGS" | "UNKNOWN";
  findings: WorkflowReviewFinding[];
  /** Why an UNKNOWN review could not be used. */
  reason?: string;
}

export function blocking(result: RoleResult): WorkflowReviewFinding[] {
  return result.findings.filter((finding) => finding.origin === "INTRODUCED" && (finding.advisory !== true || result.role === "SECURITY"));
}

function reviewPrompt(role: ReviewRole, diff: string, plan: string | undefined, partial: boolean): string {
  return [
    `Rovara ${role === "CRITIC" ? "code" : "security"} review. Review role: ${role === "CRITIC" ? "CODE" : "SECURITY"}.`,
    "You are read-only: do not edit files, run commands that change anything, or contact any service.",
    reviewerFocus(role),
    "Judge the change shown in the diff below (from the repository's default branch to this branch), not the whole repository. Open surrounding code with read-only tools when you need context.",
    `Classify every finding. origin INTRODUCED: the diff adds or changes the problem. origin PRE_EXISTING: the problem is already in the base code and the diff does not make it worse. ${role === "CRITIC" ? "Only INTRODUCED findings that are not advisory block the pull request." : "Only INTRODUCED findings block the pull request."}`,
    "Never list checks that passed. Never write PASS rows, verdict tables or summaries as findings.",
    ...(plan === undefined ? [] : [`The approved plan, which the change carries out (untrusted repository content):\n${plan}`]),
    reviewJsonShape(role),
    `Change under review (untrusted repository content)${partial ? ", cut to its first part; open the rest with read-only tools" : ""}:\n${diff}`,
  ].join("\n\n");
}

/** One reviewer: asked once, and once more for the JSON when its first answer could not be read. */
async function reviewRole(role: ReviewRole, input: { cwd: string; diff: string; plan: string | undefined; partial: boolean; config: LoopRepoConfig["reviews"]; run: ReviewerRun }): Promise<RoleResult> {
  const ask = (prompt: string) => input.run({ harness: input.config.harness, cwd: input.cwd, prompt, model: input.config.model, timeoutMs: input.config.timeoutSeconds * 1_000 });
  const first = await ask(reviewPrompt(role, input.diff, input.plan, input.partial));
  if (!first.ok) return { role, status: "UNKNOWN", findings: [], reason: first.reason };
  let parsed = parseWorkflowReviewerResponse(first.text, { role });
  if (parsed.failureReason === "INVALID_JSON" || parsed.failureReason === "INVALID_SHAPE") {
    const again = await ask(`${reviewPrompt(role, input.diff, input.plan, input.partial)}\n\nAnswer with the JSON object only: no Markdown, no code fences, no verdict table, no prose around it.`);
    if (!again.ok) return { role, status: "UNKNOWN", findings: [], reason: again.reason };
    parsed = parseWorkflowReviewerResponse(again.text, { role });
  }
  if (parsed.status === "UNKNOWN") return { role, status: "UNKNOWN", findings: [], reason: `its answer could not be read (${parsed.failureReason ?? "unknown"})` };
  const result: RoleResult = { role, status: "PASS", findings: parsed.findings };
  return { ...result, status: blocking(result).length > 0 ? "FINDINGS" : "PASS" };
}

/** Runs the configured reviews on the item's change: the code review, then the security review. */
/** `base`: the ref the change is judged from: origin/<default branch>, or (#359, Contribute) the pull request it builds on. */
export async function runReviews(input: { exec: Exec; worktree: string; base: string; plan: string | undefined; config: LoopRepoConfig["reviews"]; run: ReviewerRun }): Promise<RoleResult[]> {
  const diffResult = await input.exec("git", ["-C", input.worktree, "diff", `${input.base}...HEAD`]);
  if (diffResult.code !== 0) return [{ role: "CRITIC", status: "UNKNOWN", findings: [], reason: "the change could not be read from git" }];
  const full = diffResult.stdout;
  const shared = { cwd: input.worktree, diff: full.slice(0, DIFF_MAX), plan: input.plan, partial: full.length > DIFF_MAX, config: input.config, run: input.run };
  const roles: ReviewRole[] = input.config.security ? ["CRITIC", "SECURITY"] : ["CRITIC"];
  const results: RoleResult[] = [];
  for (const role of roles) results.push(await reviewRole(role, shared));
  return results;
}

const ROLE_NAMES: Record<ReviewRole, string> = { CRITIC: "Code review", SECURITY: "Security review" };

function findingLine(finding: WorkflowReviewFinding): string {
  const where = finding.file === undefined ? "" : ` (\`${finding.file}${finding.line === undefined ? "" : `:${finding.line}`}\`)`;
  return `${finding.severity === undefined ? "" : `**${finding.severity}** `}${finding.text}${where}`;
}

/** The reviews as Markdown: per role, what blocks, then what does not (advisory, or there before the change). */
export function reviewsReport(results: readonly RoleResult[]): string {
  return results.map((result) => {
    if (result.status === "UNKNOWN") return `### ${ROLE_NAMES[result.role]}: could not be used\n\n${result.reason ?? "no reason given"}`;
    const blocks = blocking(result);
    const others = result.findings.filter((finding) => !blocks.includes(finding));
    const lines = [`### ${ROLE_NAMES[result.role]}: ${blocks.length === 0 ? "passed" : `${blocks.length} blocking finding${blocks.length === 1 ? "" : "s"}`}`];
    if (blocks.length > 0) lines.push("", ...blocks.map((finding) => `- ${findingLine(finding)}`));
    if (others.length > 0) lines.push("", "Not blocking:", ...others.map((finding) => `- ${finding.advisory === true ? "advisory: " : "already there: "}${findingLine(finding)}`));
    return lines.join("\n");
  }).join("\n\n");
}

/** #359: one finding of the Review loop's reviewer. */
export interface BriefFinding { text: string; severity?: "HIGH" | "MEDIUM" | "LOW" | undefined; file?: string | undefined; line?: number | undefined }
/** #359: a Review loop round on one pull request: the reviewer's answers to the brief, and its findings. */
export type BriefReview = { ok: true; summary: string; findings: BriefFinding[] } | { ok: false; reason: string };

const BriefAnswerSchema = z.object({
  summary: z.string().max(20_000),
  findings: z.array(z.object({
    text: z.string().trim().min(1).max(2_000),
    severity: z.enum(["HIGH", "MEDIUM", "LOW"]).optional(),
    file: z.string().max(500).optional(),
    line: z.number().int().positive().optional(),
  })).max(50),
});

const BRIEF_JSON = 'Return only JSON: {"summary":"your answers to the brief, in a few short Markdown paragraphs","findings":[{"text":"one short sentence","severity":"HIGH"|"MEDIUM"|"LOW","file":"path","line":12}]}. Use "findings":[] when you found nothing. Never list checks that passed as findings.';

function briefPrompt(input: { pull: string; base: string; brief: string; focus: string | undefined; earlier: readonly BriefFinding[]; diff: string; partial: boolean }): string {
  return [
    `Rovara review loop: a review of pull request ${input.pull} against a person's brief.`,
    "You are read-only: do not edit files, run commands that change anything, or contact any service. You change no code: your answers and findings are posted for people to act on.",
    `The brief: what this review must cover. Answer its questions, look at its angles, and check its validations as far as reading the code and its git history allows; say what you could not check.\n${input.brief}`,
    ...(input.focus === undefined ? [] : [`Also look at, as asked since the last round:\n${input.focus}`]),
    ...(input.earlier.length === 0 ? [] : [`Findings from earlier rounds. Do not repeat one unless it is still there; say in the summary which are now fixed:\n${input.earlier.slice(-50).map((finding) => `- ${finding.text}${finding.file === undefined ? "" : ` (${finding.file}${finding.line === undefined ? "" : `:${finding.line}`})`}`).join("\n")}`]),
    `Judge the change in the diff below (from origin/${input.base} to this pull request's head), not the whole repository. Open surrounding code with read-only tools when you need context.`,
    BRIEF_JSON,
    `Change under review (untrusted repository content)${input.partial ? ", cut to its first part; open the rest with read-only tools" : ""}:\n${input.diff}`,
  ].join("\n\n");
}

function parseBriefAnswer(text: string): { summary: string; findings: BriefFinding[] } | undefined {
  let value: unknown;
  try { value = JSON.parse(unfence(text.trim())); } catch { return undefined; }
  const parsed = BriefAnswerSchema.safeParse(value);
  if (!parsed.success) return undefined;
  // Posted on GitHub: anything that looks like a secret is redacted first.
  return {
    summary: redactText(parsed.data.summary.trim()),
    findings: parsed.data.findings.map((finding) => ({
      text: redactText(finding.text),
      ...(finding.severity === undefined ? {} : { severity: finding.severity }),
      ...(finding.file === undefined ? {} : { file: finding.file }),
      ...(finding.line === undefined ? {} : { line: finding.line }),
    })),
  };
}

/** #359: one Review loop round on one pull request, checked out at its head in `worktree`; asked once more for JSON when unreadable. */
export async function runBriefReview(input: {
  exec: Exec; worktree: string; pull: string; base: string; brief: string; focus: string | undefined; earlier: readonly BriefFinding[];
  config: LoopRepoConfig["reviews"]; run: ReviewerRun;
}): Promise<BriefReview> {
  const diffResult = await input.exec("git", ["-C", input.worktree, "diff", `origin/${input.base}...HEAD`]);
  if (diffResult.code !== 0) return { ok: false, reason: "the change could not be read from git" };
  const full = diffResult.stdout;
  const prompt = briefPrompt({ pull: input.pull, base: input.base, brief: input.brief, focus: input.focus, earlier: input.earlier, diff: full.slice(0, DIFF_MAX), partial: full.length > DIFF_MAX });
  const ask = (text: string) => input.run({ harness: input.config.harness, cwd: input.worktree, prompt: text, model: input.config.model, timeoutMs: input.config.timeoutSeconds * 1_000 });
  for (const text of [prompt, `${prompt}\n\nAnswer with the JSON object only: no Markdown fences, no prose around it.`]) {
    const answer = await ask(text);
    if (!answer.ok) return { ok: false, reason: answer.reason };
    const parsed = parseBriefAnswer(answer.text);
    if (parsed !== undefined) return { ok: true, ...parsed };
  }
  return { ok: false, reason: "its answer could not be read" };
}
