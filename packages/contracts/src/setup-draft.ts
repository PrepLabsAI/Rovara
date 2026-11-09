// Rovara Code (Plan 6 Task 10): the pieces a proposed dev setup is read with. (Meta repo lane B: the whole answer is now a `SetupProposal`, read by setup-proposal-read.ts,
// which uses the helpers here; the version 1 reader of a whole draft is gone.)
//
// The answer is MODEL OUTPUT read from files an outsider may have written (a README, a Makefile, a CI file), so it is a proposal and nothing more. These helpers guarantee:
//   - a command with a control or format character (a newline, an escape, a bidirectional override, a zero-width character) is left out, because a person could not see what it
//     would run;
//   - a command that can run is written as the executor will run it (`formatCommandLine` of `parseCommandLine`): same program, same arguments, one line. One that can't be
//     read as a single program (`curl x | sh`) is kept as written, so the person sees what the repository asks for;
//   - a command that fetches code from the internet and runs it is recognised by `remoteCodeReason`, whatever the model said;
//   - a secret is a NAME (letters, digits, `_`, `.`, `-`); a value that came with it is cut off, and a name that looks like a token is left out.
import { formatCommandLine, parseCommandLine, SETUP_TIMEOUT } from "./project-commands.js";
import { redactText } from "./redaction.js";

/** What a person is told about a command that fetches code and runs it (the plan's exact words). */
export const REMOTE_CODE_REASON = "Runs a script downloaded from the internet.";

/** The project settings take at most this many commands of each kind, each at most this long (`ProjectSettingsBodySchema`). */
export const SETUP_DRAFT_COMMANDS_MAX = 16;
export const SETUP_DRAFT_COMMAND_MAX_CHARS = 500;

const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u;
const HIDDEN = /[\p{Cc}\p{Cf}]/u;

// ---- commands that fetch code and run it
//
// The rule is conservative on purpose: a person reads the flag, so a command flagged by mistake costs a glance, and one missed is a download that runs with the project's
// setup. A command is flagged when it
//   - pipes into an interpreter, by any path or wrapper (`| sh`, `| /bin/sh`, `| /usr/bin/env bash`, `| sudo -u root bash`, `| command sh`, `| python3 -`), whatever came before the pipe;
//   - sources or substitutes a download (`bash <(curl ..)`, `sh -c "$(curl ..)"`, backticks);
//   - runs a `-c`/`-e` script that downloads, substitutes a command, decodes base64 or evaluates (`bash -c '.. | sh'`, `python -c "..urlopen.."`, `node -e "fetch(..)"`);
//   - downloads and then runs what it fetched (`curl -o f && sh f`, `wget x; chmod +x x`);
//   - hands a shell a URL (`sh https://..`).

const FETCH_TOOL = String.raw`(?:curl|wget|fetch|aria2c|iwr|irm|invoke-webrequest|invoke-restmethod)`;
/** Programs that run what they are given; the path in front of any of them is allowed (`/usr/bin/env`, `/bin/sh`). */
const WRAPPERS = String.raw`(?:(?:\S*\/)?(?:sudo|doas|env|command|exec|nohup|nice|ionice|time|timeout|busybox|xargs|stdbuf|setsid|chroot|unshare|flock))`;
const INTERPRETER_NAME = String.raw`(?:(?:ba|z|da|k|c|fi|a|tc)?sh|python[0-9.]*|nodejs|node|deno|bun|perl|ruby|php|lua|pwsh|powershell|iex|invoke-expression|source|eval|osascript|tclsh|rscript)`;
const INTERPRETER = String.raw`(?:${WRAPPERS}(?![\w./-])(?:\s+\S+){0,3}?\s+){0,2}(?:\S*\/)?${INTERPRETER_NAME}(?![\w./-])`;
/** What a `-c`/`-e` script does that fetches or builds code to run. */
const BUILDS_CODE = String.raw`(?:${FETCH_TOOL}(?![\w-])|urllib|urlopen|requests\.|http\.get|https\.get|fetch\s*\(|socket|Net::HTTP|open-uri|LWP|\$\(|\x60|base64|eval|exec)`;
const REMOTE_CODE_PATTERNS: readonly RegExp[] = [
  // anything | sh, | /bin/sh, | /usr/bin/env bash, | sudo -E bash -s, | python3 - (a single `|`, not `||`)
  new RegExp(String.raw`(?<!\|)\|&?\s*${INTERPRETER}`, "iu"),
  // bash <(curl ...), source <(wget ...), . <(curl ...)
  new RegExp(String.raw`<\(\s*${FETCH_TOOL}(?![\w-])`, "iu"),
  // sh -c "$(curl ...)", eval "$(wget ...)", bash `curl ...`
  new RegExp(String.raw`(?:\$\(|\x60)\s*${FETCH_TOOL}(?![\w-])`, "iu"),
  // bash -c '...', python -c "...", node -e "...", perl -e '...': a script that downloads, substitutes a command, decodes or evaluates
  new RegExp(String.raw`(?<![\w./-])${INTERPRETER_NAME}(?![\w./-])(?:\s+-\S+)*?\s+-(?:[A-Za-z]*[cerCE]|Command|EncodedCommand)(?![\w-])[^\n]*${BUILDS_CODE}`, "iu"),
  // curl ... -o file && sh file, wget ...; chmod +x ..., curl ...; ./file
  new RegExp(String.raw`(?<![\w-])${FETCH_TOOL}(?![\w-])[^\n]*(?:&&|;|\|\|)\s*(?:${INTERPRETER}\s|chmod\s+\+x\b|\.\/)`, "iu"),
  // sh https://...
  new RegExp(String.raw`(?<![\w-])(?:\S*\/)?(?:ba|z|da|k|c|fi|a)?sh\s+(?:-\S+\s+)*https?:\/\/`, "iu"),
];

/** `REMOTE_CODE_REASON` when the command fetches code from the internet and runs it (by the rule above), else undefined. */
export function remoteCodeReason(command: string): string | undefined {
  return REMOTE_CODE_PATTERNS.some((pattern) => pattern.test(command)) ? REMOTE_CODE_REASON : undefined;
}

// ---- helpers

export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);
/** Redacted, on one line (every run of whitespace, control and format characters is one space), and cut to `max` characters. */
export function oneLineText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return [...redactText(value).replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim()].slice(0, max).join("").trimEnd();
}
export const utf8Bytes = (text: string): number => new TextEncoder().encode(text).byteLength;

/** What a command is, as it is shown, and whether it was left out (and why). */
export type CommandReading = { kind: "kept"; text: string } | { kind: "left_out"; reason: "hidden" | "too_long" | "empty" };

export function readCommand(raw: string): CommandReading {
  if (HIDDEN.test(raw)) return { kind: "left_out", reason: "hidden" };
  const redacted = redactText(raw).trim();
  if (redacted === "") return { kind: "left_out", reason: "empty" };
  if ([...redacted].length > SETUP_DRAFT_COMMAND_MAX_CHARS) return { kind: "left_out", reason: "too_long" };
  try {
    // As the executor will run it: the same program and arguments, quoted once.
    const text = formatCommandLine(parseCommandLine(redacted, ".", SETUP_TIMEOUT));
    return [...text].length > SETUP_DRAFT_COMMAND_MAX_CHARS ? { kind: "left_out", reason: "too_long" } : { kind: "kept", text };
  } catch {
    // Not one program (a pipe, `&&`, an unclosed quote): shown as written, with whitespace made single so a person reads one line.
    return { kind: "kept", text: redacted.replace(/\s+/gu, " ") };
  }
}

export interface CommandResult { commands: string[]; leftOut: { hidden: number; tooLong: number; extra: number } }

export function readCommands(value: unknown): CommandResult {
  const commands: string[] = [];
  const leftOut = { hidden: 0, tooLong: 0, extra: 0 };
  for (const raw of strings(value)) {
    const reading = readCommand(raw);
    if (reading.kind === "left_out") {
      if (reading.reason === "hidden") leftOut.hidden += 1;
      else if (reading.reason === "too_long") leftOut.tooLong += 1;
      continue;
    }
    if (commands.includes(reading.text)) continue;
    if (commands.length >= SETUP_DRAFT_COMMANDS_MAX) { leftOut.extra += 1; continue; }
    commands.push(reading.text);
  }
  return { commands, leftOut };
}

/**
 * What a secret name must not look like: a token. A name is shown to the person and stored, so a token the model copied into the name field (or that a README asked it to
 * "name exactly") would be stored and shown whole. A name that `redactText` would change, one that starts like a known token, and a long one with no separator that mixes
 * cases and digits are all treated as tokens and left out.
 */
const TOKEN_LIKE_NAME = new RegExp(
  String.raw`(?:^|[^A-Za-z0-9])(?:gh[pousr]_|github_pat_|AKIA[0-9A-Z]{8}|ASIA[0-9A-Z]{8}|AIza|sk-|sk_(?:live|test)_|rk_(?:live|test)_|pk_(?:live|test)_|xox[abprs]-|glpat-|npm_|pypi-|shpat_|hf_|dop_v1_|dckr_pat_|ya29\.|eyJ)[A-Za-z0-9_\-.]{4,}`,
);
export function looksLikeToken(name: string): boolean {
  if (redactText(name) !== name || TOKEN_LIKE_NAME.test(name)) return true;
  return name.length >= 20 && !/[_.-]/u.test(name) && /[a-z]/u.test(name) && /[A-Z]/u.test(name) && /\d/u.test(name);
}

/** A secret's name from what the model wrote: the part before any `=` (a value that came with it is dropped), if that is a name; `"token"` for a name that looks like a token. */
export function secretNameOf(raw: unknown): { name: string } | "token" | undefined {
  if (typeof raw !== "string") return undefined;
  const name = raw.split("=", 1)[0]!.trim();
  if (!SECRET_NAME.test(name)) return name.length > 0 && name.length <= 200 && !HIDDEN.test(name) && /^[\w.-]+$/u.test(name) ? "token" : undefined;
  return looksLikeToken(name) ? "token" : { name };
}
