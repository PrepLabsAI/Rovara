// Spec 051: the coding agent proves its work, and AgentX checks it. The pure parts, shared by the
// worker (which runs checks), the broker (which keeps the report and shapes the PR) and Slack.
import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Covers AGENTX_WORKER_PROMPT and AGENTX_PREAMBLE: changing either means a new version. 1 had only the preamble; 3 added
 * the rule for tests that check the old behaviour a task changes (D-17, #290); 4 forbids editing tests to make them
 * pass unless the task asks for test changes (D-18).
 */
export const AGENTX_PREAMBLE_VERSION = "4";

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
  "3. A test that passed before your change and fails after it is your own regression. Fix your change, not the test; never call it unrelated.",
  "4. The one exception is a test that checks the old behaviour the task asks you to change. Leave it as it is and name it in your final message, with the behaviour it checks. Never edit or delete a test to make it pass, unless the task explicitly asks you to change tests.",
  "5. Report the commands you ran and their results.",
  "6. You must never claim a test passed unless you saw it pass.",
  "End your final message with exactly one line: \"AgentX result: done\" if the work is complete and every test you ran passes, apart from tests you named under rule 4, otherwise \"AgentX result: not done\".",
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
  // D-15 (#290): runners agents use directly; mocha since #292.
  ["python3", "-m", "pytest"], ["jest"], ["npx", "jest"], ["yarn", "jest"], ["pnpm", "jest"],
  ["vitest"], ["npx", "vitest"], ["yarn", "vitest"], ["pnpm", "vitest"],
  ["mocha"], ["npx", "mocha"], ["yarn", "mocha"], ["pnpm", "mocha"],
];
/** Only a plain space and these characters may appear: no quoting, expansion, globbing, redirection or control characters. */
const ALLOWED = /^[A-Za-z0-9_@%+=:,./ -]*$/;
/** One unquoted character of a word. */
const UNQUOTED = /^[A-Za-z0-9_@%+=:,./-]$/;
/**
 * D-15: what a quoted argument may hold (a test name pattern such as "RoomView|RoomViewStore"): printable characters
 * other than those a shell still reads inside quotes ($, `, \) and the quotes themselves, so the text stays literal.
 */
const QUOTED = /^[\x20-\x7e]*$/;
const QUOTED_SPECIAL = /[$`\\"']/;
/** Arguments that change files or never end when replayed: snapshot updates and watch modes. */
const REFUSED_ARGUMENTS = new Set(["-u", "--updateSnapshot", "--update-snapshots", "--update", "--snapshot-update", "--ci=false"]);

/** A word as written (`raw`, quotes included), as the shell reads it (`value`), and where it sits in the command. */
interface ShellWord { raw: string; value: string; start: number; end: number }
type ShellToken = { word: ShellWord } | { operator: "&&" | "||" | ";" | "|" } | { merge: true };

/**
 * #299: the command as words, the operators `&&`, `||`, `;` and `|`, and `2>&1`, or undefined when any character is
 * outside UNQUOTED and those, a quote is unclosed or holds a character outside QUOTED, or `>` is anything but `2>&1`.
 * A quoted operator stays inside its word.
 */
function shellTokens(text: string): ShellToken[] | undefined {
  const tokens: ShellToken[] = [];
  let raw = "";
  let value = "";
  let quoted = false;
  let start = 0;
  const flush = (end: number) => {
    if (quoted || raw !== "") tokens.push({ word: { raw, value, start, end } });
    raw = "";
    value = "";
    quoted = false;
  };
  const begin = (index: number) => {
    if (!quoted && raw === "") start = index;
  };
  for (let index = 0; index < text.length;) {
    const character = text[index]!;
    if (character === " ") {
      flush(index);
      index += 1;
    } else if (character === "\"" || character === "'") {
      const end = text.indexOf(character, index + 1);
      if (end === -1) return undefined;
      const inner = text.slice(index + 1, end);
      if (!QUOTED.test(inner) || QUOTED_SPECIAL.test(inner)) return undefined;
      begin(index);
      raw += text.slice(index, end + 1);
      value += inner;
      quoted = true;
      index = end + 1;
    } else if (character === "&" || character === "|") {
      const doubled = text[index + 1] === character;
      if (character === "&" ? !doubled : text[index + 1] === "&") return undefined;
      flush(index);
      tokens.push({ operator: doubled ? (character === "&" ? "&&" : "||") : "|" });
      index += doubled ? 2 : 1;
    } else if (character === ";") {
      flush(index);
      tokens.push({ operator: ";" });
      index += 1;
    } else if (character === ">") {
      // Only `2>&1`, where `2` is a word of its own, and ends there.
      if (quoted || raw !== "2" || !text.startsWith(">&1", index) || !/^(?:[ |;&]|$)/.test(text.slice(index + 3, index + 4))) return undefined;
      raw = "";
      value = "";
      tokens.push({ merge: true });
      index += 3;
    } else {
      if (!UNQUOTED.test(character)) return undefined;
      begin(index);
      raw += character;
      value += character;
      index += 1;
    }
  }
  flush(text.length);
  return tokens;
}

/** The command's words, or undefined when it holds anything else (an operator, `2>&1`) or does not tokenise. */
function shellWords(text: string): ShellWord[] | undefined {
  const tokens = shellTokens(text);
  if (tokens === undefined || tokens.some((token) => !("word" in token))) return undefined;
  return tokens.map((token) => (token as { word: ShellWord }).word);
}
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
 * True when the words are a simple test command (P-6, D-15): `NAME=value` assignments, an optional `timeout <n>`, then
 * a listed runner with arguments that stay in the workspace and neither write snapshots nor watch.
 */
function simpleTest(parsed: readonly ShellWord[]): boolean {
  if (parsed.length === 0) return false;
  if (parsed.some(({ value }) => escapesWorkspace(value) || REFUSED_ARGUMENTS.has(value) || value.startsWith("--watch"))) return false;
  // Assignments, `timeout` and the runner itself are matched as written: quoting is allowed in arguments only.
  const words = parsed.map(({ raw }) => raw);
  let index = 0;
  while (index < words.length && ASSIGNMENT.test(words[index]!)) index += 1;
  if (words[index] === "timeout" && /^\d+[smh]?$/.test(words[index + 1] ?? "")) index += 2;
  const tail = words.slice(index);
  return TEST_HEADS.some((head) => head.every((word, position) => tail[position] === word));
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
 * `| tail -N` are allowed and left out of the replay, which AgentX runs for its exit code alone. This is also the
 * replay validator: AgentX runs only a replay this maps to itself.
 */
export function matchTestCommand(command: string): string | undefined {
  const bare = withoutOutputTail(command).command;
  const cd = /^ *cd +(\S+) +&& +(.+)$/s.exec(bare);
  const rest = (cd === null ? bare : cd[2]!).replace(/^ +| +$/g, "");
  if (rest.length === 0) return undefined;
  if (cd !== null && (!ALLOWED.test(cd[1]!) || !safeCdPath(cd[1]!))) return undefined;
  const parsed = shellWords(rest);
  if (parsed === undefined || !simpleTest(parsed)) return undefined;
  return cd === null ? rest : `cd ${cd[1]} && ${rest}`;
}

export interface FoundTestCommand {
  /** `cd <dir> && <test>`, or `<test>` from the workspace root: always a string matchTestCommand maps to itself. */
  replay: string;
  /**
   * True only for a simple test command (P-6, D-14) and `cd <dir>; <test>`: the agent's run reports the test's own exit
   * code. Any other run's exit code is not the test's, and D-16 measures the before instead.
   */
  ownRunIsBefore: boolean;
}

export interface TestCommandScan {
  tests: FoundTestCommand[];
  /** True when any part or pipeline command is neither a test, a `cd`, nor an allowed filter: it may change files. */
  othersMayChange: boolean;
}

export interface ScanOptions {
  /**
   * Maps an absolute `cd` target the agent's shell knows (a container or host folder) to a workspace-relative path, ""
   * for the root; undefined leaves the target as written (Ruling X, D-15, #299).
   */
  cdTarget?: (target: string) => string | undefined;
}

/** Commands that change the shell's environment, so that a test after them is not the bare test AgentX would replay. */
const ENVIRONMENT_CHANGERS = new Set([
  "export", "source", ".", "set", "unset", "alias", "pushd", "popd", "shopt", "ulimit", "umask", "eval", "exec", "declare",
  "typeset", "readonly",
]);
/** Commands that only read the output piped into them; their arguments are never replayed. */
const OUTPUT_FILTERS = new Set(["tail", "head", "grep", "egrep", "sed", "cut", "sort", "uniq", "wc", "cat"]);

interface ShellCommand { words: ShellWord[]; merge: boolean }

function outputFilter(command: ShellCommand): boolean {
  const [head, ...args] = command.words;
  if (head === undefined || !OUTPUT_FILTERS.has(head.raw)) return false;
  // sed writes files in place with -i, --in-place or a short-option cluster holding i (-ni).
  return head.raw !== "sed" || !args.some(({ value }) => value === "--in-place" || value.startsWith("--in-place=") || /^-[^-]*i/.test(value));
}

/** `| tail -N`, `| tail -n N` or `| tail -nN` (D-14). */
function tailFilter(command: ShellCommand): boolean {
  const words = command.words.map(({ raw, value }) => (raw === value ? raw : ""));
  if (command.merge || words[0] !== "tail") return false;
  return words.length === 2 ? /^-n?\d+$/.test(words[1]!) : words.length === 3 && words[1] === "-n" && /^\d+$/.test(words[2]!);
}

/**
 * The command's pipelines and the operators between them, or undefined when it does not tokenise or has an empty part.
 * A trailing `;` is allowed and reported.
 */
function shellPipelines(command: string): { pipelines: ShellCommand[][]; joins: string[]; trailingSemicolon: boolean } | undefined {
  const tokens = shellTokens(command);
  if (tokens === undefined) return undefined;
  const pipelines: ShellCommand[][] = [[{ words: [], merge: false }]];
  const joins: string[] = [];
  for (const token of tokens) {
    const pipeline = pipelines.at(-1)!;
    const current = pipeline.at(-1)!;
    if ("word" in token) {
      if (current.merge) return undefined;
      current.words.push(token.word);
    } else if ("merge" in token) {
      if (current.words.length === 0 || current.merge) return undefined;
      current.merge = true;
    } else {
      if (current.words.length === 0) return undefined;
      if (token.operator === "|") pipeline.push({ words: [], merge: false });
      else {
        joins.push(token.operator);
        pipelines.push([{ words: [], merge: false }]);
      }
    }
  }
  const last = pipelines.at(-1)!;
  const trailingSemicolon = last.length === 1 && last[0]!.words.length === 0 && joins.at(-1) === ";";
  if (trailingSemicolon) {
    pipelines.pop();
    joins.pop();
  }
  if (pipelines.some((pipeline) => pipeline.some((part) => part.words.length === 0))) return undefined;
  return { pipelines, joins, trailingSemicolon };
}

const REFUSED_SCAN: TestCommandScan = { tests: [], othersMayChange: true };

/**
 * #299: every test command inside `command`, as AgentX would replay it. The command is split at `&&`, `||`, `;` and
 * `|` outside quotes; each `cd` moves the replay's directory; a test may be followed by output filters, which the
 * replay leaves out. Anything the split does not understand, `git stash`, a `cd` that leaves the workspace or is joined
 * by `||`, an environment changer before a test, or a filter outside OUTPUT_FILTERS yields no test at all.
 */
export function scanTestCommands(command: string, options: ScanOptions = {}): TestCommandScan {
  return scan(command, options)?.result ?? REFUSED_SCAN;
}

function scan(command: string, options: ScanOptions): { result: TestCommandScan; pipedIntoTail: boolean } | undefined {
  const split = shellPipelines(command);
  if (split === undefined) return undefined;
  const { pipelines, joins } = split;
  const replays: string[] = [];
  let dir = "";
  let environmentChanged = false;
  let othersMayChange = false;
  let cds = 0;
  let lastTest = -1;
  for (const [index, pipeline] of pipelines.entries()) {
    if (pipeline.some(({ words }) => words[0]!.raw === "git" && words.slice(1).some(({ value }) => value === "stash"))) return undefined;
    const [first, ...filters] = pipeline as [ShellCommand, ...ShellCommand[]];
    const head = first.words[0]!.raw;
    if (head === "cd") {
      const target = first.words[1];
      if (pipeline.length !== 1 || first.merge || first.words.length !== 2 || target === undefined || target.raw !== target.value) return undefined;
      if (joins[index - 1] === "||" || joins[index] === "||") return undefined;
      const mapped = options.cdTarget?.(target.raw);
      if (mapped === undefined && !safeCdPath(target.raw)) return undefined;
      dir = mapped ?? (dir === "" ? target.raw : `${dir.replace(/\/+$/, "")}/${target.raw}`);
      if (dir !== "" && !safeCdPath(dir)) return undefined;
      cds += 1;
    } else if (ENVIRONMENT_CHANGERS.has(head) || first.words.every(({ raw }) => ASSIGNMENT.test(raw))) {
      environmentChanged = true;
      othersMayChange = true;
    } else if (simpleTest(first.words)) {
      if (environmentChanged || !filters.every(outputFilter)) return undefined;
      const test = command.slice(first.words[0]!.start, first.words.at(-1)!.end);
      const replay = dir === "" ? test : `cd ${dir} && ${test}`;
      if (!replays.includes(replay)) replays.push(replay);
      lastTest = index;
    } else {
      othersMayChange = true;
    }
  }
  // The agent's own run reports the test's exit code only as `[cd <dir> (&& or ;)] <test> [2>&1] [| tail -N]`.
  const last = pipelines.at(-1)!;
  const simple = replays.length === 1 && !othersMayChange && !split.trailingSemicolon && lastTest === pipelines.length - 1
    && pipelines.length === cds + 1 && cds <= 1 && joins.every((join) => join === "&&" || join === ";")
    && (last.length === 1 || (last.length === 2 && tailFilter(last[1]!)));
  return {
    result: { tests: replays.map((replay) => ({ replay, ownRunIsBefore: simple })), othersMayChange },
    pipedIntoTail: simple && last.length === 2,
  };
}

/**
 * True for a test command whose run counts as a before (scanTestCommands' `ownRunIsBefore`) and is piped into `tail`.
 * The agent's shell runs it with `pipefail`, so its exit code is the test's rather than tail's, which is always 0. The
 * cd target is not checked: pipefail changes nothing else, and an eval's container paths only become workspace paths
 * for the matcher.
 */
export function isPipedTestCommand(command: string): boolean {
  return scan(command, { cdTarget: () => "" })?.pipedIntoTail === true;
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
