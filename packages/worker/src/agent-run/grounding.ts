// Does an agent step's report stand on anything? The worker records every tool call of a step, and when the step ends compares the report with what happened: tool
// failures, text that imitates tool calls, and the things the report cites (pull requests, issues, commits, files, tool names) that neither a successful call returned nor
// the step's own request, instructions and skills held. The answer is "grounded" or "unverified"; the broker never lets an unverified step count as a success.
//
// Deterministic and bounded: no model call, the report is read to GROUNDING_REPORT_SCAN_CHARS, every pattern bounds its whitespace and lengths (no backtracking blow-up),
// at most MAX_CITATIONS things are checked and at most MAX_REASONS reasons are kept. What a call returned is kept as a small index of the tokens a citation can be looked
// up in (built from the WHOLE answer, before its text is cut), so one big read cannot switch the checks off; only when an index overflows its bound is that one kind of
// check (pull requests, commits, files) skipped, rather than blaming the agent for evidence the recorder could not keep.
import { redactText, type AgentStepGrounding } from "@agentx/contracts";

/** The most of a report that is read; the worker cuts a report to 32 KiB before it is checked, so this is a backstop. */
export const GROUNDING_REPORT_SCAN_CHARS = 262_144;
/** The most of one call's answer the recorder keeps as text (the failure message is read from it), and the most it keeps in all. */
export const GROUNDING_CALL_TEXT_CHARS = 65_536;
export const GROUNDING_TOTAL_TEXT_CHARS = 2_000_000;
/** The most of one answer (or of what the step was given) that is read into an index; an answer past it overflows every kind. */
const INDEX_SCAN_CHARS = 4_194_304;
/** The most distinct tokens of one kind one index keeps, and all the indexes of a step together keep. */
const INDEX_KIND_MAX = 40_000;
const INDEX_STEP_MAX = 400_000;
const MAX_TOKEN_CHARS = 300;
const MAX_CITATIONS = 50;
const MAX_REASONS = 10;
const MAX_FAILURES = 10;
const MESSAGE_CHARS = 300;
/** The step's own tools: a choice of branch and a skill's text are not reads of the world, so their calls are not recorded (a skill's text is part of what the step was given). */
const OWN_TOOLS: ReadonlySet<string> = new Set(["choose_branch", "read_skill"]);

/** How a call ended: it answered (`ok`), failed (a thrown error, or a connector answer that says FAILED or UNKNOWN), is held for a person's approval, or never ended. */
export type RecordedCallOutcome = "ok" | "failed" | "held" | "pending";

type IndexKind = "numbers" | "commits" | "names";

/**
 * What a text holds that a citation can be looked up in: `numbers` are the pull request and issue numbers it names (any number at all, for text the step was given),
 * `digits` every whole number in it (for a bare #N), `commits` the hex words of 6 to 40 characters, `names` file names and the tails of paths, lower case.
 */
export interface EvidenceIndex {
  numbers: Set<string>;
  digits: Set<string>;
  commits: Set<string>;
  names: Set<string>;
  /** A kind whose tokens did not all fit: a citation of that kind that is not found cannot be blamed. */
  overflow: Record<IndexKind, boolean>;
}

export interface RecordedToolCall {
  tool: string;
  /** A tool of the broker's connectors (as against the read-only file tools and the step's own tools). */
  connector: boolean;
  args: unknown;
  outcome: RecordedCallOutcome;
  /** The answer's text, cut to GROUNDING_CALL_TEXT_CHARS. */
  text: string;
  /** What the whole answer (and the call's arguments) hold, for an answer that came through; the recorder builds it, and without one it is built from `text`. */
  index?: EvidenceIndex;
}

export interface GroundingInput {
  /** The step's report as it will be kept. */
  report: string;
  /** What the step was given: the request, its context and the earlier reports, its instructions and its skills, as the model read them. */
  provided: string;
  calls: readonly RecordedToolCall[];
  /** The connector tools the step was offered: the name the model calls and the connector's own name for it. */
  connectorTools: ReadonlyArray<{ name: string; upstream: string }>;
}

/** A step's allowance of index tokens, shared by all its calls. */
class IndexBudget {
  left = INDEX_STEP_MAX;
}

const emptyIndex = (): EvidenceIndex => ({ numbers: new Set(), digits: new Set(), commits: new Set(), names: new Set(), overflow: { numbers: false, commits: false, names: false } });

const NUMBER_CONTEXT = /(?:#|\/(?:pulls?|issues)\/|number|\b(?:pr|pull(?:[ -]requests?)?|issues?)s?)[^\w]{0,5}(\d{1,9})(?!\d)/giu;
const WHOLE_NUMBER = /(?<![\w.])\d{1,9}(?![\w])/gu;
const WORD = /[A-Za-z0-9_.\-/]+/gu;
const COMMIT_WORD = /^[0-9a-f]{6,40}$/u;

/** Reads a text into an index. `loose` (what the step was given): every number counts as a pull request or issue number. */
function indexText(text: string, loose: boolean, budget: IndexBudget = new IndexBudget()): EvidenceIndex {
  const index = emptyIndex();
  const add = (kind: IndexKind, set: Set<string>, value: string): void => {
    if (set.has(value)) return;
    if (set.size >= INDEX_KIND_MAX || budget.left <= 0) {
      index.overflow[kind] = true;
      return;
    }
    set.add(value);
    budget.left -= 1;
  };
  if (text.length > INDEX_SCAN_CHARS) index.overflow = { numbers: true, commits: true, names: true };
  const body = text.slice(0, INDEX_SCAN_CHARS).toLowerCase();
  for (const match of body.matchAll(WHOLE_NUMBER)) add("numbers", index.digits, match[0]);
  if (loose) index.numbers = index.digits;
  else for (const match of body.matchAll(NUMBER_CONTEXT)) add("numbers", index.numbers, match[1]!);
  for (const match of body.matchAll(WORD)) {
    if (match[0].length > MAX_TOKEN_CHARS) continue;
    const token = match[0].replace(/^[./-]+/u, "").replace(/[.\-/]+$/u, "");
    if (token === "") continue;
    const segments = token.split("/").filter((segment) => segment !== "");
    // Every tail of a path, so a path the report gives from a deeper folder is found in a listing from a higher one.
    for (let from = Math.max(0, segments.length - 10); from < segments.length; from += 1) add("names", index.names, segments.slice(from).join("/"));
    for (const segment of segments) if (COMMIT_WORD.test(segment)) add("commits", index.commits, segment);
  }
  return index;
}

/** Collects a step's tool calls from the session's events (`tool_execution_start` and `tool_execution_end`). */
export class ToolCallRecorder {
  private readonly recorded: RecordedToolCall[] = [];
  private readonly open = new Map<string, RecordedToolCall>();
  private readonly budget = new IndexBudget();
  private kept = 0;

  constructor(private readonly connectorNames: ReadonlySet<string>) {}

  calls(): RecordedToolCall[] {
    return this.recorded;
  }

  observe(event: unknown): void {
    if (event === null || typeof event !== "object") return;
    const value = event as { type?: unknown; toolCallId?: unknown; toolName?: unknown; args?: unknown; isError?: unknown; result?: unknown };
    const id = typeof value.toolCallId === "string" ? value.toolCallId : undefined;
    const tool = typeof value.toolName === "string" ? value.toolName : undefined;
    if (tool !== undefined && OWN_TOOLS.has(tool)) return;
    if (value.type === "tool_execution_start" && tool !== undefined) {
      const call: RecordedToolCall = { tool, connector: this.connectorNames.has(tool), args: value.args, outcome: "pending", text: "" };
      this.recorded.push(call);
      if (id !== undefined) this.open.set(id, call);
      return;
    }
    if (value.type !== "tool_execution_end" || id === undefined) return;
    const call = this.open.get(id);
    if (call === undefined) return;
    this.open.delete(id);
    const text = answerText(value.result);
    const room = Math.max(0, Math.min(GROUNDING_CALL_TEXT_CHARS, GROUNDING_TOTAL_TEXT_CHARS - this.kept));
    call.text = text.slice(0, room);
    this.kept += call.text.length;
    // The status is read from the whole answer, not the kept part: a connector's answer is a small JSON object whose text may be long.
    call.outcome = value.isError === true ? "failed" : call.connector ? connectorOutcome(text) : "ok";
    // What the report may cite is read from the whole answer, so a long one cannot hide what sits past the kept part.
    if (call.outcome === "ok" || call.outcome === "held") call.index = indexText(`${safeJson(call.args)}\n${evidenceOf(call.connector, text)}`, false, this.budget);
  }
}

function answerText(result: unknown): string {
  const content = (result as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part !== null && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join("\n");
}

/** What a connector's answer (the broker's ConnectorResult as JSON) says. An answer that is not that JSON is taken as an answer. */
function connectorOutcome(text: string): RecordedCallOutcome {
  const parsed = parseObject(text);
  const status = parsed?.["status"];
  if (status === "FAILED" || status === "UNKNOWN") return "failed";
  if (status === "IN_PROGRESS") return "held";
  return "ok";
}

function parseObject(text: string): Record<string, unknown> | undefined {
  if (!text.startsWith("{")) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** What the call's answer says for a citation to be looked up in: a connector's vendor words (its `text`), else the answer itself. */
function evidenceOf(connector: boolean, answer: string): string {
  const parsed = connector ? parseObject(answer) : undefined;
  return typeof parsed?.["text"] === "string" ? parsed["text"] : answer;
}

const oneLine = (text: string, max: number): string => {
  const flat = redactText(text).replace(/\s+/gu, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

function failureMessage(call: RecordedToolCall): string {
  const parsed = call.connector ? parseObject(call.text) : undefined;
  const said = typeof parsed?.["text"] === "string" && parsed["text"] !== "" ? parsed["text"] : typeof parsed?.["reason"] === "string" ? parsed["reason"] : call.text;
  return oneLine(said === "" ? "it gave no reason" : said, MESSAGE_CHARS);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** The tools summary a verdict carries. */
function toolsOf(calls: readonly RecordedToolCall[]): AgentStepGrounding["tools"] {
  const failed = calls.filter((call) => call.outcome === "failed");
  return { calls: calls.length, failed: failed.length, failures: failed.slice(0, MAX_FAILURES).map((call) => ({ tool: call.tool.slice(0, 100), message: failureMessage(call) })) };
}

/**
 * The verdict for a step whose report stands: "grounded", with the tools summary. A worker that checks always sends a verdict, so a broker can tell a step that was
 * checked and is clean from one that a worker without the check ran.
 */
export function cleanGrounding(calls: readonly RecordedToolCall[]): AgentStepGrounding {
  return { verdict: "grounded", reasons: [], tools: toolsOf(calls) };
}

// --- The report's text -------------------------------------------------------------------------------------------------------------------------

/**
 * The report without its code: closed fenced blocks (``` or ~~~) and inline code spans. A report that quotes `<tool_call>` markup, or says what an example does, is not
 * imitating a call. A fence that is never closed hides nothing (the rest is read), so a fence cannot be used to hide a transcript.
 */
function withoutCode(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at]!;
    const fence = /^[ \t]{0,3}(```|~~~)/u.exec(line)?.[1];
    if (fence !== undefined) {
      let close = at + 1;
      while (close < lines.length && !lines[close]!.trimStart().startsWith(fence)) close += 1;
      if (close < lines.length) {
        at = close;
        continue;
      }
    }
    kept.push(line);
  }
  return kept.join("\n").replace(/`[^`\n]{0,300}`/gu, " ");
}

const TOOL_CALL_TEXT = /<\/?(?:tool_calls?|tool_responses?|tool_results?|tool_use|function_calls?|invoke|antml:[a-z_]+)\b|<parameter[ \t\r\n]{1,5}name=/iu;

/** A claim to have written something (a comment, a review, a pull request), in the first person or as "comment posted"; a denial just before it is no claim. */
const WRITE_CLAIMS = [
  /\b(?:I|we)(?:['’]ve|[ \t]{1,3}have)?[ \t]{1,3}(?:(?:just|now|also)[ \t]{1,3})?(?:posted|commented|opened|merged|pushed|submitted|left)\b[^.\n]{0,60}?\b(?:comment|review|pull request|PR|issue|reply|feedback|findings)\b/giu,
  /\b(?:comment|review|reply|findings)(?:[ \t]{1,3}(?:was|has[ \t]{1,3}been|have[ \t]{1,3}been))?[ \t]{1,3}(?:posted|commented)\b/giu,
];
const DENIAL = /\b(?:no|not|never|nor|without)\b|n['’]t\b/iu;

function claimsAWrite(prose: string): boolean {
  for (const pattern of WRITE_CLAIMS) {
    for (const match of prose.matchAll(pattern)) {
      if (!DENIAL.test(prose.slice(Math.max(0, match.index - 24), match.index))) return true;
    }
  }
  return false;
}

// --- Citations ---------------------------------------------------------------------------------------------------------------------------------

/** Forms that name a pull request or issue outright; a bare #N is looser (it may be a step or a finding), so it is looked up more leniently. */
const PULL_REQUEST_FORMS = /(?<![\w/])(?:PRs?[ \t]{0,2}[#-][ \t]{0,2}|pull[ -]requests?[ \t]{0,2}#[ \t]{0,2})(\d{1,7})\b|\/(?:pulls?|issues)\/(\d{1,7})\b/giu;
const BARE_NUMBER = /(?<![\w&/#])#(\d{1,7})\b/gu;
/** A commit: 6 to 40 hex characters, with digits and letters; see `citations` for when a short or hex-like one counts. */
const COMMIT = /(?<![\w#-])[0-9a-f]{6,40}(?![\w-])/giu;
const COMMIT_LEAD = /(?:\b(?:commit|sha|rev|ref|head|merge|merged|at)[ \t:`'"(]{0,3}|[@`])$/iu;
const FILE_PATH = /(?<![\w./:@-])((?:[\w.-]{1,100}\/){1,12}[\w.-]{1,100}\.(?:tsx?|jsx?|mjs|cjs|json|ya?ml|md|py|go|rs|java|kt|rb|sh|sql|css|scss|html|toml|tf|swift|cpp|hpp|c|h))(?![\w/-])/gu;

/** A path that starts like a version (22.23.2/bin/node.js) or a host (app.example.io/v1/health.json) is not a file of the repository. */
const VERSION_OR_HOST = /^(?:\d+\.\d+|[\w-]+(?:\.[\w-]+)*\.(?:com|io|org|net|dev|app|co|ai|cloud)\/)/iu;
/** A line that proposes a file (add, create, rename, suggest, "should", "consider"...) names one that does not exist yet. */
const PROPOSAL = /\b(?:add|adds|adding|create|creates|creating|new|propose|proposed|proposes|suggest|suggested|suggests|should|could|would|rename|renaming|introduce|consider|write|writing)\b|\bmove(?:s)? (?:it )?to\b/iu;

/** The line of the report a match sits in, cut to 400 characters around it. */
function lineAround(text: string, at: number): string {
  const start = Math.max(text.lastIndexOf("\n", at) + 1, at - 200);
  const end = text.indexOf("\n", at);
  return text.slice(start, Math.min(end === -1 ? text.length : end, at + 200));
}

interface Citations {
  /** Number to whether the report named it as a pull request (else just "#N"). */
  numbers: Map<string, boolean>;
  commits: string[];
  files: string[];
}

function citations(report: string, prose: string): Citations {
  const found: Citations = { numbers: new Map(), commits: [], files: [] };
  const commits = new Set<string>();
  const files = new Set<string>();
  const room = () => found.numbers.size + commits.size + files.size < MAX_CITATIONS;
  for (const match of report.matchAll(PULL_REQUEST_FORMS)) {
    if (!room()) break;
    found.numbers.set(match[1] ?? match[2]!, true);
  }
  // A bare #N is read from the prose only: in code it is a colour or an anchor.
  for (const match of prose.matchAll(BARE_NUMBER)) {
    if (!room()) break;
    if (!found.numbers.has(match[1]!)) found.numbers.set(match[1]!, false);
  }
  for (const match of report.matchAll(COMMIT)) {
    if (!room()) break;
    const token = match[0].toLowerCase();
    // A commit has both digits and letters; a word or a plain number (a run id, a count) is not one.
    if (!/\d/u.test(token) || !/[a-f]/u.test(token) || /^\d+e\d+$/u.test(token)) continue;
    // Said to be a commit (a word before it, or backticks): any length. Bare: 9 or more characters, or 7 to 8 with at least two digits (a hex-like word has one at most); never 6.
    const said = COMMIT_LEAD.test(report.slice(Math.max(0, match.index - 16), match.index));
    const digits = token.replace(/\D/gu, "").length;
    if (!said && (token.length < 7 || (token.length < 9 && digits < 2))) continue;
    commits.add(token);
  }
  for (const match of report.matchAll(FILE_PATH)) {
    if (!room()) break;
    const path = match[1]!;
    // Not a read of the world: a path that starts like a version or a host, or one the line proposes (add, create, rename, "should", "consider"...).
    if (VERSION_OR_HOST.test(path) || PROPOSAL.test(lineAround(report, match.index))) continue;
    files.add(path);
  }
  found.commits = [...commits];
  found.files = [...files];
  return found;
}

// --- Failures a report may own up to -----------------------------------------------------------------------------------------------------------

/** Words that say the agent could not do or read something: the report owns up to a failure. */
const OWNS_UP = /\b(?:could\s?n[o']t|can\s?n[o']t|cannot|unable to|not able to|no access|(?:40[13]|429)|forbidden|unauthori[sz]ed|permission denied|access denied|rate[ -]?limit\w*)\b|n['’]t (?:read|reach|access|call|use|post)/iu;
/** A failure that means the agent had no access or the answer is unknown, as against one that says the thing asked about is not there (404, 422). */
const ACCESS_FAILURE = /\b(?:401|403|429|unauthori[sz]ed|forbidden|permission|denied|not connected|rate[ -]?limit\w*|expired|credentials?)\b/iu;

/** Whether a failed connector call is the benign kind: the connector answered FAILED, and what it said is not about access (a 404 probe, a search that errored once). */
function isBenignFailure(call: RecordedToolCall): boolean {
  if (!call.connector) return false;
  const parsed = parseObject(call.text);
  if (parsed?.["status"] !== "FAILED") return false;
  const reason = parsed["reason"];
  if (reason === "not_connected" || reason === "policy_denied" || reason === "schema_changed") return false;
  return !ACCESS_FAILURE.test(`${typeof reason === "string" ? reason : ""} ${typeof parsed["text"] === "string" ? parsed["text"] : ""}`);
}

// --- Tool names the report says it used --------------------------------------------------------------------------------------------------------

/** A sentence that says the agent could not, did not, would or may: a mention in it is not a claim to have used the tool. */
const NOT_A_CLAIM = /\b(?:not|no|never|none|unable|without|failed|denied|lack|lacks|lacking|missing|unavailable|available|offered|would|will|need|needs|should|could|can|may|might|if|unless|instead|rather|cannot)\b|n['’]t\b/iu;
const USED = /\b(?:used|using|use|called|calling|call|ran|run|invoked|invoking|executed|via|through|posted|created|opened|merged|pushed|fetched|queried|requested)\b/iu;
const isWordChar = (char: string | undefined): boolean => char !== undefined && /\w/u.test(char);

/** Whether the report says the agent used the tool: the name stands as a whole word (a plain word only inside backticks) in a sentence that says "used" and does not deny or hedge. */
function claimsToHaveUsed(report: string, name: string): boolean {
  const plain = !/[_-]/u.test(name);
  let from = 0;
  for (let seen = 0; seen < 20; seen += 1) {
    const at = report.indexOf(name, from);
    if (at === -1) return false;
    from = at + name.length;
    const before = report[at - 1];
    const after = report[at + name.length];
    if (isWordChar(before) || isWordChar(after)) continue;
    if (plain && !(before === "`" && after === "`")) continue;
    const left = report.slice(Math.max(0, at - 200), at);
    const right = report.slice(at + name.length, at + name.length + 200);
    const sentence = `${left.slice(Math.max(left.lastIndexOf("\n"), left.lastIndexOf("."), left.lastIndexOf("!"), left.lastIndexOf("?"), left.lastIndexOf(";")) + 1)} ${right.slice(0, nextBreak(right))}`;
    if (USED.test(sentence) && !NOT_A_CLAIM.test(sentence)) return true;
  }
  return false;
}

/** Whether the report names the tool and does not say it used it (so it speaks of the tool as one that did not work). */
const mentionsWithoutClaim = (report: string, name: string): boolean => name.length >= 4 && report.includes(name) && !claimsToHaveUsed(report, name);

function nextBreak(text: string): number {
  const breaks = [text.indexOf("\n"), text.indexOf(". "), text.indexOf("!"), text.indexOf("?"), text.indexOf(";")].filter((position) => position !== -1);
  return breaks.length === 0 ? text.length : Math.min(...breaks);
}

// --- The check ---------------------------------------------------------------------------------------------------------------------------------

/**
 * Compares the report with what the step did. Undefined when the report stands and no tool failed (the result then carries nothing extra); otherwise the verdict, why, and
 * a summary of the tools, which the broker records on the run and shows with its result.
 */
export function checkGrounding(input: GroundingInput): AgentStepGrounding | undefined {
  const report = input.report.slice(0, GROUNDING_REPORT_SCAN_CHARS);
  const prose = withoutCode(report);
  const reasons: string[] = [];
  const note = (reason: string): void => { reasons.push(oneLine(reason, MESSAGE_CHARS)); };
  const failed = input.calls.filter((call) => call.outcome === "failed");
  const succeeded = input.calls.filter((call) => call.outcome === "ok");
  const answeredConnector = input.calls.some((call) => call.connector && (call.outcome === "ok" || call.outcome === "held"));
  const names = new Map(input.connectorTools.map(({ name, upstream }) => [name, upstream]));

  if (TOOL_CALL_TEXT.test(prose)) {
    note("The report contains tool calls or tool answers written as text. A tool call exists only when the agent calls the tool, so none of it happened.");
  }

  // A connector tool whose latest call failed: what the agent read from it, if anything, is not the whole of what it needed. A failure that only says the thing asked about is
  // not there (a 404 probe) does not condemn a step other calls back; one about access does, unless the report owns up to it.
  const latest = new Map<string, RecordedToolCall>();
  for (const call of input.calls) if (call.connector && call.outcome !== "pending") latest.set(call.tool, call);
  for (const [tool, call] of latest) {
    if (call.outcome !== "failed") continue;
    if (succeeded.length > 0 && isBenignFailure(call)) continue;
    if (OWNS_UP.test(prose) || [tool, names.get(tool)].some((candidate) => candidate !== undefined && mentionsWithoutClaim(report, candidate))) continue;
    note(`The tool ${tool} failed: ${failureMessage(call)}`);
  }
  if (failed.length > 0 && succeeded.length === 0) note(`The agent made no successful tool call: all ${String(failed.length)} of its calls failed, so it read nothing.`);

  for (const { name, upstream } of input.connectorTools) {
    const claimed = [...new Set([name, upstream])].filter((candidate) => candidate.length >= 4 && claimsToHaveUsed(report, candidate));
    if (claimed.length === 0) continue;
    if (!input.calls.some((call) => call.tool === name && (call.outcome === "ok" || call.outcome === "held"))) {
      note(`The report names the tool ${claimed[0]!}, but the agent did not call it.`);
    }
  }

  // Something said to have been posted, with no connector call that answered: nothing was.
  if (!answeredConnector && claimsAWrite(prose)) {
    note("The report says a comment, review or pull request was posted or opened, but the agent made no successful connector call, so nothing was written.");
  }

  // What the step was given and what its successful calls returned.
  const given = indexText(input.provided, true);
  const sources = [given, ...input.calls.filter((call) => call.outcome === "ok" || call.outcome === "held").map((call) => call.index ?? indexText(`${safeJson(call.args)}\n${evidenceOf(call.connector, call.text)}`, false))];
  const unknown = (kind: IndexKind): boolean => sources.some((source) => source.overflow[kind]);
  const cited = citations(report, prose);
  for (const [number, asPullRequest] of cited.numbers) {
    if (unknown("numbers") || sources.some((source) => (asPullRequest ? source.numbers : source.digits).has(number))) continue;
    note(`The report cites ${asPullRequest ? "pull request " : ""}#${number}, which no tool returned and the request did not contain.`);
  }
  for (const commit of cited.commits) {
    if (unknown("commits") || sources.some((source) => [...source.commits].some((known) => known.startsWith(commit) || commit.startsWith(known)))) continue;
    note(`The report cites commit ${commit}, which no tool returned and the request did not contain.`);
  }
  for (const file of cited.files) {
    const lower = file.toLowerCase();
    if (unknown("names") || sources.some((source) => source.names.has(lower) || source.names.has(lower.slice(lower.lastIndexOf("/") + 1)))) continue;
    note(`The report cites the file ${file}, which no tool read or listed and the request did not contain.`);
  }

  if (reasons.length === 0 && failed.length === 0) return undefined;
  const shown = reasons.slice(0, MAX_REASONS);
  if (reasons.length > MAX_REASONS) shown[MAX_REASONS - 1] = `${String(reasons.length - MAX_REASONS + 1)} more things in the report are not backed by a tool call.`;
  return { verdict: reasons.length === 0 ? "grounded" : "unverified", reasons: shown, tools: toolsOf(input.calls) };
}
