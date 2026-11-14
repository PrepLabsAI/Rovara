// What a coding run found when it ended with no code change. The worker builds this block from the run's own record (the commands the agent ran, what they printed, and the
// agent's final answer) and the broker keeps it on the blocked workflow, so a read-only request ("run X and tell me", "check if we use Z") is answered instead of dead-ending.
// Everything in it is untrusted: a command's output and a model's words. Every string is redacted and bounded here, by the worker before it leaves and by the broker before it is stored or shown.
import { z } from "zod";
import { redactText } from "./redaction.js";

/** At most this many commands are kept (the last ones the agent ran); `omitted` counts the earlier ones. */
export const NO_CHANGE_FINDINGS_COMMANDS_MAX = 10;
/** Each command is one line of at most this many characters. */
export const NO_CHANGE_FINDINGS_COMMAND_MAX = 160;
/** Each command's output is cut to this many characters (its beginning and its end are kept). */
export const NO_CHANGE_FINDINGS_OUTPUT_MAX = 400;
/** The agent's own conclusion is cut to this many characters. */
export const NO_CHANGE_FINDINGS_CONCLUSION_MAX = 1500;
/** The commands, their outputs and the conclusion together never exceed this many characters. */
export const NO_CHANGE_FINDINGS_TOTAL_MAX = 5000;

/** The block reason of a coding run that finished with the code as it was (the worker's WORKFLOW_NO_CODE_CHANGE_MESSAGE). */
export const NO_CODE_CHANGED_REASON = "No code changes were needed, so no tests were run and no pull request was opened. Close the task, or ask for a change.";
/** What that block reason said before its wording changed; a task stored blocked with it still reads as this stop. */
export const NO_CODE_CHANGED_LEGACY_REASONS: readonly string[] = ["Coding finished, but no code changed, so there is nothing to check or open as a pull request. Retry coding, or close the task."];

/** Whether a stored block reason is the no-code-change stop, in its present or earlier words. */
export function isNoCodeChangedReason(reason: string | undefined): boolean {
  return reason !== undefined && (reason === NO_CODE_CHANGED_REASON || NO_CODE_CHANGED_LEGACY_REASONS.includes(reason));
}

/** What the session reads as its step while the task waits on this stop. */
export const NO_CODE_CHANGED_STEP = "No code changes were needed";
/** The first line when no findings came with the result (an older worker sent none): what is known is that no change was needed. */
export const NO_CHANGE_NEEDED_LINE = "No code changes were needed.";
/** The first line of the message and of the task page's section. */
export const NO_CHANGE_FOUND_HEADER = "No code changes were needed. Here's what I found:";
/** Said before the list of commands. */
export const NO_CHANGE_COMMANDS_HEADER = "Commands I ran:";
/** Said between the commands and the link to the full output, in Slack. */
export const NO_CHANGE_FULL_OUTPUT_LABEL = "Full output on the task page:";
/** The start of the line said when the agent wrote no conclusion; Slack goes on "see what it ran on the task page: <link>", a page "see what it ran below.". */
export const NO_CHANGE_NO_CONCLUSION_LEAD = "No code changes were needed. The agent didn't write a conclusion;";
/** The last line, in the Slack thread and on the task page of a task that has a thread: what was not done, and the two ways on. */
export const NO_CHANGE_CHOICES_LINE = "No tests were run and no pull request was opened. To change something, reply here and choose Retry coding; otherwise close the task.";
/** The same last line on the task page and in the app. */
export const NO_CHANGE_CHOICES_PAGE = NO_CHANGE_CHOICES_LINE;
/** The last line for a task with no Slack thread: a change is asked for in a new request. */
export const NO_CHANGE_CHOICES_NO_THREAD = "No tests were run and no pull request was opened. To change something, start a new request describing it; otherwise close the task.";
/** Said in place of the output of a command that reads environment or secret material. */
export const NO_CHANGE_OUTPUT_HIDDEN = "(output not shown)";
/** Said before the link to the task page when a Slack message has no list of commands. */
export const NO_CHANGE_DETAILS_LABEL = "Details on the task page:";
/** Whether a task has a Slack thread, from the share the task view and the task page both carry (`threadUrl` in the view, `threadTs` on the record): the app and the page choose the last line by this. */
export function noChangeHasThread(share: { threadUrl?: string | undefined; threadTs?: string | undefined } | undefined): boolean {
  return share !== undefined && (share.threadUrl !== undefined || share.threadTs !== undefined);
}
/** The word that takes the place of a secret-looking value. */
export const NO_CHANGE_VALUE_HIDDEN = "[hidden]";
/** The most commands an `omitted` count can name: the schema's own maximum. */
export const NO_CHANGE_FINDINGS_OMITTED_MAX = 100_000;

const CommandSchema = z.object({
  command: z.string().min(1).max(NO_CHANGE_FINDINGS_COMMAND_MAX),
  output: z.string().max(NO_CHANGE_FINDINGS_OUTPUT_MAX).optional(),
  failed: z.boolean().optional(),
});

export const NoChangeFindingsSchema = z.object({
  commands: z.array(CommandSchema).max(NO_CHANGE_FINDINGS_COMMANDS_MAX),
  /** How many earlier commands are not listed. */
  omitted: z.number().int().min(1).max(NO_CHANGE_FINDINGS_OMITTED_MAX).optional(),
  conclusion: z.string().min(1).max(NO_CHANGE_FINDINGS_CONCLUSION_MAX).optional(),
}).refine((findings) => noChangeFindingsSize(findings) <= NO_CHANGE_FINDINGS_TOTAL_MAX, { message: "the findings are larger than they may be" });

export type NoChangeFindings = z.infer<typeof NoChangeFindingsSchema>;

/** How many characters the findings hold in all. */
export function noChangeFindingsSize(findings: { commands: ReadonlyArray<{ command: string; output?: string | undefined }>; conclusion?: string | undefined }): number {
  return findings.commands.reduce((sum, item) => sum + item.command.length + (item.output?.length ?? 0), 0) + (findings.conclusion?.length ?? 0);
}

const SECRET_PARTS: ReadonlySet<string> = new Set(["token", "secret", "key", "password", "passwd", "passphrase", "pass", "salt", "hmac", "private", "credential", "auth", "session", "cookie"]);

/**
 * Whether a name looks like a secret's: one of its parts is TOKEN, SECRET, KEY, PASSWORD, PASS, SALT, HMAC, PRIVATE, CREDENTIAL, AUTH, SESSION or COOKIE (or its plural). The name is split into parts at `_`, `-`, `.`
 * and camelCase, and a part must be the whole word, so `API_KEY`, `apiKey` and `db.password` are, and `author`, `monkey` and `bypass` are not.
 */
export function isSecretName(name: string): boolean {
  const parts = name.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2").split(/[\s_.-]+/u);
  return parts.some((part) => {
    const word = part.toLowerCase();
    return SECRET_PARTS.has(word) || (word.endsWith("s") && SECRET_PARTS.has(word.slice(0, -1)));
  });
}

// A name is cut at its start (a lookbehind), so each name is read once; every repetition is bounded.
const ASSIGNMENT_SOURCE = String.raw`(?<![A-Za-z0-9_.\-])([A-Za-z_][A-Za-z0-9_.\-]{0,127})([ \t]{0,3}=[ \t]{0,3})("[^"\n]{0,2000}"|'[^'\n]{0,2000}'|[^\s"']{1,2000})`;
const LINE_VALUE_SOURCE = String.raw`^([ \t]*(?:[-*>][ \t]+)?["']?)([A-Za-z_][A-Za-z0-9_.\-]{0,127})(["']?[ \t]*:[ \t]*)(.{1,2000})$`;
/** A name that reads as a variable (it holds `_`, `.` or a digit, is in capitals, or is camelCase) and not as a plain word: "Note:" and "Summary:" in prose are not names. */
const looksLikeVariable = (name: string): boolean => /[_.0-9]/u.test(name) || /^[A-Z][A-Z]+$/u.test(name) || /[a-z][A-Z]/u.test(name);

/**
 * The value of every `NAME=value` and `NAME: value` line whose name looks like a secret's (`isSecretName`) is hidden and the name stays. With `"any-name"` (for Slack) every `NAME=value`
 * is hidden whatever the name (this includes `export X=…` and an inline `X=… cmd`), and so is every `NAME: value` whose name reads as a variable. Text inside a value that is not hidden is read as well.
 */
export function maskSecretValues(text: string, mode: "secret-names" | "any-name" = "secret-names"): string {
  const hide = (name: string, colon: boolean): boolean => (mode === "any-name" ? !colon || looksLikeVariable(name) || isSecretName(name) : isSecretName(name));
  const assignment = new RegExp(ASSIGNMENT_SOURCE, "gu");
  let masked = "";
  let from = 0;
  for (let found = assignment.exec(text); found !== null; found = assignment.exec(text)) {
    const [whole, name = "", equals = ""] = found;
    if (!hide(name, false)) { assignment.lastIndex = found.index + name.length + equals.length; continue; }
    masked += `${text.slice(from, found.index)}${name}${equals}${NO_CHANGE_VALUE_HIDDEN}`;
    from = found.index + whole.length;
  }
  masked += text.slice(from);
  return masked.replace(new RegExp(LINE_VALUE_SOURCE, "gmu"), (whole: string, head: string, name: string, colon: string) => (hide(name, true) ? `${head}${name}${colon}${NO_CHANGE_VALUE_HIDDEN}` : whole));
}

/** A path or file name that holds environment or secret material. */
const SECRET_PATHS: readonly RegExp[] = [
  /(^|\/)\.env[^/]*$/u, /\.env$/u, /\.(pem|key|p12|pfx)$/u, /(^|\/)id_[^/]*$/u, /credentials/u, /secret/u, /(^|\/)\.(npmrc|netrc|pypirc|git-credentials)$/u,
  /kubeconfig/u, /(^|\/)\.aws(\/|$)/u, /(^|\/)\.ssh(\/|$)/u, /\.docker\/config\.json$/u, /(^|\/)environ$/u,
];
const SKIPPED_HEADS: ReadonlySet<string> = new Set(["sudo", "command", "builtin", "time", "nohup", "exec"]);

/**
 * Whether a command reads environment or secret material, so that none of its output is kept: `env`, `printenv`, `set`, `export -p` and the like, and any command that names a secret file
 * (`.env*`, `*.pem`, `*.key`, `id_*`, `*credentials*`, `*secret*`, `.npmrc`, `.netrc`, `.pypirc`, `.git-credentials`, `kubeconfig`, `.aws/*`, `.docker/config.json`). It judges the command's words only, so it errs on the side of hiding.
 */
export function commandReadsSecrets(command: string): boolean {
  for (const segment of command.split(/[|;&\n`()]+/u)) {
    const words = segment.trim().split(/\s+/u).filter((word) => word !== "");
    let at = 0;
    while (at < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[at]!) || SKIPPED_HEADS.has(words[at]!))) at += 1;
    const head = (words[at] ?? "").split("/").at(-1)!.toLowerCase();
    const rest = words.slice(at + 1);
    if (head === "printenv" || head === "set" || head === "declare" || head === "typeset" || head === "compgen") return true;
    if (head === "env" && rest.every((word) => word.startsWith("-") && !word.includes("="))) return true;
    if (head === "export" && (rest.length === 0 || rest.includes("-p"))) return true;
  }
  // A reference to a variable with a secret's name (`echo $GITHUB_TOKEN`, `echo "${DB_PASSWORD}"`) prints the secret.
  for (const reference of command.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/gu)) if (isSecretName(reference[1] ?? "")) return true;
  for (const word of command.split(/[\s|;&`()<>$]+/u)) {
    for (const piece of [word, word.slice(word.indexOf("=") + 1)]) {
      const path = piece.replace(/^["']+|["']+$/gu, "").toLowerCase();
      if (path !== "" && SECRET_PATHS.some((pattern) => pattern.test(path))) return true;
    }
  }
  return false;
}

/** The most raw text read from one string before it is redacted: a tool's own output is already cut by its tool; this keeps a hostile value from costing more than it should. */
const RAW_MAX = 100_000;

/** Redacted, control characters made spaces (a line break stays), blank runs squeezed, and cut to `max` characters counted in code points: the beginning only, or the beginning and the end. */
function cleaned(value: unknown, max: number, keep: "start" | "both"): string {
  if (typeof value !== "string" || max <= 0) return "";
  const bounded = value.length <= RAW_MAX ? value : `${value.slice(0, RAW_MAX / 2)}\n${value.slice(-RAW_MAX / 2)}`;
  const text = maskSecretValues(redactText(bounded)).replace(/\r\n?/gu, "\n").replace(/[\p{Cc}\p{Cf}]/gu, (character) => (character === "\n" ? "\n" : " ")).replace(/[ \t]+\n/gu, "\n").replace(/\n{3,}/gu, "\n\n").trim();
  const points = Array.from(text);
  if (points.length <= max) return text;
  if (keep === "start" || max < 8) return `${points.slice(0, max - 1).join("")}…`;
  const room = max - 3, head = Math.ceil(room / 2);
  return `${points.slice(0, head).join("")} … ${points.slice(points.length - (room - head)).join("")}`;
}

function cutLine(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : `${points.slice(0, max - 1).join("")}…`;
}

const oneLine = (value: unknown, max: number): string => cutLine(cleaned(value, RAW_MAX, "start").replace(/\s+/gu, " ").trim(), max);

export interface NoChangeFindingsInput {
  commands: ReadonlyArray<{ command?: unknown; output?: unknown; failed?: unknown }>;
  conclusion?: unknown;
}

/**
 * The findings block for a run's record: the last commands (at most ten, one line each), each with its output cut to its limit, and the agent's conclusion, all redacted, and the whole never over
 * NO_CHANGE_FINDINGS_TOTAL_MAX characters (the conclusion keeps its room first, then the later commands' outputs). The input is untrusted: anything that is not text is left out.
 */
export function buildNoChangeFindings(input: NoChangeFindingsInput): NoChangeFindings {
  // The input is untrusted at run time whatever its type says.
  const items: unknown[] = Array.isArray(input.commands) ? (input.commands as unknown[]) : [];
  const listed = items.flatMap((item) => {
    if (item === null || typeof item !== "object") return [];
    const entry = item as { command?: unknown; output?: unknown; failed?: unknown };
    const command = oneLine(entry.command, NO_CHANGE_FINDINGS_COMMAND_MAX);
    // The output of a command that reads environment or secret material is never kept, and a file read's text is not a finding.
    const hidden = commandReadsSecrets(command);
    const raw = hidden ? NO_CHANGE_OUTPUT_HIDDEN : /^read(\s|$)/u.test(command) ? undefined : entry.output;
    return command === "" ? [] : [{ command, raw, failed: entry.failed === true }];
  });
  const kept = listed.slice(-NO_CHANGE_FINDINGS_COMMANDS_MAX);
  const conclusion = cleaned(input.conclusion, NO_CHANGE_FINDINGS_CONCLUSION_MAX, "start");
  let room = NO_CHANGE_FINDINGS_TOTAL_MAX - conclusion.length - kept.reduce((sum, item) => sum + item.command.length, 0);
  // The last commands are the ones the conclusion rests on, so they are given room first.
  const outputs = new Array<string>(kept.length).fill("");
  for (let index = kept.length - 1; index >= 0; index -= 1) {
    const output = cleaned(kept[index]!.raw, Math.min(NO_CHANGE_FINDINGS_OUTPUT_MAX, Math.max(0, room)), "both");
    outputs[index] = output;
    room -= output.length;
  }
  const omitted = Math.min(listed.length - kept.length, NO_CHANGE_FINDINGS_OMITTED_MAX);
  return {
    commands: kept.map((item, index) => ({ command: item.command, ...(outputs[index] === "" ? {} : { output: outputs[index]! }), ...(item.failed ? { failed: true } : {}) })),
    ...(omitted > 0 ? { omitted } : {}),
    ...(conclusion === "" ? {} : { conclusion }),
  };
}

/**
 * What a result or a stored workflow holds as findings, made safe again: read leniently (a malformed block is no findings, never an error), then rebuilt through `buildNoChangeFindings`, so
 * whatever a worker sent (an older build, a newer one, a hostile one) is redacted and bounded on this side too. Undefined only when there is no block at all (an older worker sent none); a block with no commands and no conclusion is kept, and says the agent wrote no conclusion.
 */
export function noChangeFindingsFrom(raw: unknown): NoChangeFindings | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as { commands?: unknown; omitted?: unknown; conclusion?: unknown };
  const commands = Array.isArray(value.commands) ? value.commands.slice(-NO_CHANGE_FINDINGS_COMMANDS_MAX) : [];
  const built = buildNoChangeFindings({ commands: commands as NoChangeFindingsInput["commands"], conclusion: value.conclusion });
  const earlier = typeof value.omitted === "number" && Number.isInteger(value.omitted) && value.omitted > 0 ? Math.min(value.omitted, NO_CHANGE_FINDINGS_OMITTED_MAX) : 0;
  const omitted = Math.min(earlier + (Array.isArray(value.commands) ? Math.max(0, value.commands.length - commands.length) : 0) + (built.omitted ?? 0), NO_CHANGE_FINDINGS_OMITTED_MAX);
  return { ...built, ...(omitted > 0 ? { omitted } : {}) };
}
