// Everything `agentx init` asks a person, and every way a secret reaches it: a hidden prompt, a
// file, or an environment variable, never a flag's value (FR-020). Secrets are read whole: no
// 128-character cut like macOS `security add-generic-password -w`.
import { readFile as readFileFromDisk } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { AgentXError, agentXError } from "@agentx/contracts";

export interface TextWriter { write(text: string): unknown }
export interface PromptFlag { flag: string }

/** Spec 048 FR-010 and FR-011: how the install page shows a question. The terminal ignores it. */
export interface QuestionHelp {
  /** The page's question, in plain words; the terminal keeps its own text. */
  label?: string;
  /** One line on why the question is asked. */
  why?: string;
  example?: string;
  learnMoreUrl?: string;
  /** The default in words, when the raw default is not readable (a model id). */
  defaultText?: string;
  /** Replaces the computed "Leave empty to use ..." hint. */
  hint?: string;
  /** confirm: verb labels for the two buttons. Yes is always the forward, primary one. */
  yesLabel?: string;
  noLabel?: string;
  /** choose: one button per choice instead of a list, the first one primary. */
  buttons?: boolean;
  /** choose: the page's label for a choice value. */
  choiceLabels?: Readonly<Record<string, string>>;
}

export interface Prompter {
  ask(question: string, options: PromptFlag & { defaultValue?: string; validate?: (value: string) => string | undefined; help?: QuestionHelp }): Promise<string>;
  /** `unattendedRefusal`: with no one to ask (--yes, or no terminal) and more than one choice, refuse
   * with this message instead of taking the default. */
  choose<T extends string>(question: string, choices: ReadonlyArray<{ value: T; label: string }>, options: PromptFlag & { defaultValue: T; unattendedRefusal?: string; help?: QuestionHelp }): Promise<T>;
  confirm(question: string, options: { defaultValue: boolean; help?: QuestionHelp }): Promise<boolean>;
  /** Hidden answer: nothing typed is echoed. A multiline request is refused up front on an
   * interactive prompt. `validate` is checked on the field by the install page (spec 040 FR-040);
   * the terminal's hidden prompt ignores it, and the caller's own check still runs after. */
  secret(question: string, options: PromptFlag & { multiline?: boolean; validate?: (value: string) => string | undefined; help?: QuestionHelp }): Promise<string>;
  /** Optional: several related values on one screen (the install page). */
  form?(title: string, fields: readonly FormField[], options: { help?: QuestionHelp }): Promise<Record<string, string>>;
}

/** Spec 048 FR-012: one value of a form. `question` and `flag` are what the terminal asks. */
export interface FormField {
  name: string;
  question: string;
  flag: string;
  defaultValue?: string;
  secret?: boolean;
  validate?: (value: string) => string | undefined;
  help?: QuestionHelp;
}

/** The page's one form, or, with no form on this prompter (the terminal), the same questions in order. */
export async function askForm(prompter: Prompter, title: string, fields: readonly FormField[], options: { help?: QuestionHelp } = {}): Promise<Record<string, string>> {
  if (prompter.form !== undefined) return prompter.form(title, fields, options);
  const values: Record<string, string> = {};
  for (const field of fields) {
    const validate = field.validate === undefined ? {} : { validate: field.validate };
    values[field.name] = field.secret === true
      ? await prompter.secret(field.question, { flag: field.flag, ...validate })
      : await prompter.ask(field.question, { flag: field.flag, ...(field.defaultValue === undefined ? {} : { defaultValue: field.defaultValue }), ...validate });
  }
  return values;
}

const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

export function stripPasteMarkers(text: string): string {
  return text.replaceAll(PASTE_START, "").replaceAll(PASTE_END, "");
}

/** An error's own words for a person: an AgentXError without its own "CODE: " prefix. Any other
 * error keeps its message whole, so a Node code such as "ENOENT: " stays part of it. */
export function messageWithoutCode(error: Error): string {
  const prefix = error instanceof AgentXError ? `${error.code}: ` : undefined;
  return prefix !== undefined && error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
}

/** A check that throws (checkSlackBotToken and the like) as a field validator: the refusal's own
 * words, without the error code. The checks never quote the value, so neither does this. */
export function fieldCheck(check: (value: string) => unknown): (value: string) => string | undefined {
  return (value) => {
    try {
      check(value);
      return undefined;
    } catch (error) {
      return error instanceof Error ? messageWithoutCode(error) : "that value is not valid";
    }
  };
}

export function unattendedPrompter(): Prompter {
  return {
    async ask(question, options) {
      if (options.defaultValue !== undefined) return options.defaultValue;
      throw agentXError("CONFIG_INVALID", `${question} needs an answer; with --yes, pass ${options.flag}`);
    },
    async choose(_question, choices, options) {
      if (options.unattendedRefusal !== undefined && choices.length > 1) throw agentXError("CONFIG_INVALID", options.unattendedRefusal);
      return options.defaultValue;
    },
    async confirm() {
      return true;
    },
    async secret(question, options) {
      throw agentXError("CONFIG_INVALID", `${question} needs an answer; with --yes, pass ${options.flag}-file <path> or ${options.flag}-env <NAME>`);
    },
  };
}

export interface HiddenInput {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  once(event: "end", listener: () => void): unknown;
  removeListener(event: string, listener: (...args: never[]) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

export function readHidden(input: HiddenInput, output: TextWriter, question: string): Promise<string> {
  output.write(question);
  const raw = input.isTTY === true && typeof input.setRawMode === "function";
  return new Promise((resolvePromise, reject) => {
    let buffer = "";
    // Bracketed-paste state: while inside a paste, CR and LF are pasted content (a multiline
    // secret such as a PEM key), not the Enter that ends the read. `pendingMarker` carries a
    // marker sequence that has started but not yet been confirmed one way or the other, which
    // may span more than one "data" event (e.g. a terminal that delivers one byte at a time).
    let insidePaste = false;
    let pendingMarker = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return true;
      settled = true;
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      if (raw) input.setRawMode?.(false);
      input.pause();
      output.write("\n");
      if (error === undefined) resolvePromise(buffer);
      else reject(error);
      return true;
    };
    // Applies one character that is definitely not part of a paste marker. Returns true once the
    // read has settled (finish was called), so the caller should stop processing more characters.
    const consumeChar = (character: string): boolean => {
      if (character === "\r" || character === "\n") {
        if (insidePaste) { buffer += character; return false; }
        return finish();
      }
      if (raw && character === "\u0003") return finish(agentXError("CONFIG_INVALID", "cancelled"));
      if (raw && (character === "\u007f" || character === "\b")) {
        buffer = [...buffer].slice(0, -1).join("");
        return false;
      }
      buffer += character;
      return false;
    };
    // Feeds one character through the paste-marker matcher, which may itself span past events.
    // Loops (rather than recursing) so that flushing a broken-off partial marker and retrying the
    // current character against a clean slate cannot grow the call stack.
    const feed = (character: string): boolean => {
      for (;;) {
        const candidate = pendingMarker + character;
        if (candidate === PASTE_START) { insidePaste = true; pendingMarker = ""; return false; }
        if (candidate === PASTE_END) { insidePaste = false; pendingMarker = ""; return false; }
        if (PASTE_START.startsWith(candidate) || PASTE_END.startsWith(candidate)) { pendingMarker = candidate; return false; }
        if (pendingMarker === "") return consumeChar(character);
        // `pendingMarker` turned out not to be a marker after all: flush it as ordinary
        // characters, then retry `character` from a clean slate.
        const stale = pendingMarker;
        pendingMarker = "";
        for (const flushed of stale) { if (consumeChar(flushed)) return true; }
      }
    };
    const onEnd = () => {
      if (pendingMarker !== "") {
        const stale = pendingMarker;
        pendingMarker = "";
        for (const flushed of stale) { if (consumeChar(flushed)) return; }
      }
      finish(buffer === "" ? agentXError("CONFIG_INVALID", "no input was given") : undefined);
    };
    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const character of text) {
        if (feed(character)) return;
      }
    };
    if (raw) input.setRawMode?.(true);
    input.on("data", onData);
    input.once("end", onEnd);
    input.resume();
  });
}

export function terminalPrompter(io: { readLine(question: string): Promise<string>; readSecret(question: string): Promise<string>; write(text: string): void }): Prompter {
  return {
    async ask(question, options) {
      const suffix = options.defaultValue === undefined ? "" : ` [${options.defaultValue}]`;
      for (;;) {
        const line = (await io.readLine(`${question}${suffix}: `)).trim();
        const value = line === "" && options.defaultValue !== undefined ? options.defaultValue : line;
        // An empty answer is allowed only when the question offers an empty default (an optional value).
        const problem = value === "" && options.defaultValue === undefined ? "an answer is required" : options.validate?.(value);
        if (problem === undefined) return value;
        io.write(`  ${problem}\n`);
      }
    },
    async choose(question, choices, options) {
      io.write(`${question}\n`);
      choices.forEach((choice, index) => io.write(`  ${index + 1}. ${choice.label}${choice.value === options.defaultValue ? " (default)" : ""}\n`));
      for (;;) {
        const line = (await io.readLine(`Choose 1-${choices.length}: `)).trim();
        if (line === "") return options.defaultValue;
        const byNumber = choices[Number.parseInt(line, 10) - 1];
        const match = /^\d+$/.test(line) ? byNumber : choices.find((choice) => choice.value === line);
        if (match !== undefined) return match.value;
        io.write(`  choose a number from 1 to ${choices.length}\n`);
      }
    },
    async confirm(question, options) {
      for (;;) {
        const line = (await io.readLine(`${question} ${options.defaultValue ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
        if (line === "") return options.defaultValue;
        if (line === "y" || line === "yes") return true;
        if (line === "n" || line === "no") return false;
        io.write("  answer y or n\n");
      }
    },
    async secret(question, options) {
      if (options.multiline === true) {
        throw agentXError("CONFIG_INVALID", `a multi-line ${question} cannot be pasted into a hidden prompt; pass ${options.flag}-file <path> or ${options.flag}-env <NAME>`);
      }
      return io.readSecret(`${question} (hidden): `);
    },
  };
}

export function processPrompter(stderr: TextWriter): Prompter {
  return terminalPrompter({
    async readLine(question) {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    readSecret: (question) => readHidden(process.stdin, stderr, question),
    write: (text) => { stderr.write(text); },
  });
}

export function cleanSecret(raw: string, what: string, options: { multiline?: boolean } = {}): string {
  const value = stripPasteMarkers(raw).trim();
  if (value === "") throw agentXError("CONFIG_INVALID", `the ${what} is empty`);
  if (!options.multiline && /\s/.test(value)) {
    throw agentXError("CONFIG_INVALID", `the ${what} contains spaces or line breaks; copy it again and paste only the value`);
  }
  return value;
}

export interface SecretSource { file?: string; envName?: string }

export async function secretFromSource(input: {
  what: string; flag: string; source: SecretSource; processEnv: NodeJS.ProcessEnv; prompter: Prompter; multiline?: boolean;
  /** Checked on the install page's field only; a file or an environment variable has no field. */
  validate?: (value: string) => string | undefined;
  help?: QuestionHelp;
  readFile?: (path: string) => Promise<string>;
}): Promise<string> {
  const read = input.readFile ?? ((path: string) => readFileFromDisk(path, "utf8"));
  const clean = (raw: string) => cleanSecret(raw, input.what, input.multiline === true ? { multiline: true } : {});
  if (input.source.file !== undefined) {
    let raw: string;
    try {
      raw = await read(input.source.file);
    } catch (error) {
      throw agentXError("CONFIG_INVALID", `could not read ${input.flag}-file ${input.source.file}: ${(error as NodeJS.ErrnoException).code ?? "unreadable"}`);
    }
    return clean(raw);
  }
  if (input.source.envName !== undefined) {
    const raw = input.processEnv[input.source.envName];
    if (raw === undefined) throw agentXError("CONFIG_INVALID", `environment variable ${input.source.envName} (${input.flag}-env) is not set`);
    return clean(raw);
  }
  const secretOptions = {
    flag: input.flag,
    ...(input.multiline === true ? { multiline: true } : {}),
    ...(input.validate === undefined ? {} : { validate: input.validate }),
    ...(input.help === undefined ? {} : { help: input.help }),
  };
  return clean(await input.prompter.secret(input.what, secretOptions));
}

export function checkSlackBotToken(value: string): string {
  if (value.startsWith("xoxp-")) throw agentXError("CONFIG_INVALID", "that is a user token (xoxp-); paste the Bot User OAuth Token from OAuth & Permissions, which starts with xoxb-");
  if (value.startsWith("xapp-")) throw agentXError("CONFIG_INVALID", "that is an app-level token (xapp-); paste the Bot User OAuth Token, which starts with xoxb-");
  if (!/^xoxb-[A-Za-z0-9-]+$/.test(value)) throw agentXError("CONFIG_INVALID", "a Slack bot token starts with xoxb- (OAuth & Permissions, Bot User OAuth Token)");
  return value;
}

export function checkSlackSigningSecret(value: string): string {
  if (!/^[a-f0-9]{32}$/.test(value)) {
    throw agentXError("CONFIG_INVALID", "a Slack signing secret is 32 lowercase hexadecimal characters (Basic Information, App Credentials, Signing Secret)");
  }
  return value;
}

/** Returns the key with plain line endings: a .pem saved on Windows has CRLF ones. */
export function checkPrivateKeyPem(value: string): string {
  const pem = value.replaceAll("\r\n", "\n");
  if (!/^-----BEGIN [A-Z ]*PRIVATE KEY-----\n[\s\S]+\n-----END [A-Z ]*PRIVATE KEY-----$/.test(pem)) {
    throw agentXError("CONFIG_INVALID", "the GitHub App private key must be the .pem file GitHub gave you (it starts with -----BEGIN)");
  }
  return pem;
}
