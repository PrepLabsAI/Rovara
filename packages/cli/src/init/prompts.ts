// Everything `agentx init` asks a person, and every way a secret reaches it: a hidden prompt, a
// file, or an environment variable, never a flag's value (FR-020). Secrets are read whole: no
// 128-character cut like macOS `security add-generic-password -w`.
import { readFile as readFileFromDisk } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { agentXError } from "@agentx/contracts";

export interface TextWriter { write(text: string): unknown }
export interface PromptFlag { flag: string }
export interface Prompter {
  ask(question: string, options: PromptFlag & { defaultValue?: string; validate?: (value: string) => string | undefined }): Promise<string>;
  choose<T extends string>(question: string, choices: ReadonlyArray<{ value: T; label: string }>, options: PromptFlag & { defaultValue: T }): Promise<T>;
  confirm(question: string, options: { defaultValue: boolean }): Promise<boolean>;
  secret(question: string, options: PromptFlag): Promise<string>;
}

const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

export function stripPasteMarkers(text: string): string {
  return text.replaceAll(PASTE_START, "").replaceAll(PASTE_END, "");
}

export function unattendedPrompter(): Prompter {
  return {
    async ask(question, options) {
      if (options.defaultValue !== undefined) return options.defaultValue;
      throw agentXError("CONFIG_INVALID", `${question} needs an answer; with --yes, pass ${options.flag}`);
    },
    async choose(_question, _choices, options) {
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
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      if (raw) input.setRawMode?.(false);
      input.pause();
      output.write("\n");
      if (error === undefined) resolvePromise(buffer);
      else reject(error);
    };
    const onEnd = () => finish(buffer === "" ? agentXError("CONFIG_INVALID", "no input was given") : undefined);
    const onData = (chunk: Buffer | string) => {
      const text = stripPasteMarkers(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      for (const character of text) {
        if (character === "\r" || character === "\n") return finish();
        if (raw && character === "\u0003") return finish(agentXError("CONFIG_INVALID", "cancelled"));
        if (raw && (character === "\u007f" || character === "\b")) {
          buffer = [...buffer].slice(0, -1).join("");
          continue;
        }
        buffer += character;
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
    async secret(question) {
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
  return clean(await input.prompter.secret(input.what, { flag: input.flag }));
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

export function checkPrivateKeyPem(value: string): string {
  if (!/^-----BEGIN [A-Z ]*PRIVATE KEY-----\n[\s\S]+\n-----END [A-Z ]*PRIVATE KEY-----$/.test(value)) {
    throw agentXError("CONFIG_INVALID", "the GitHub App private key must be the .pem file GitHub gave you (it starts with -----BEGIN)");
  }
  return value;
}
