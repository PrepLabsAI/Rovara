import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkPrivateKeyPem, checkSlackBotToken, checkSlackSigningSecret, cleanSecret, readHidden, secretFromSource,
  terminalPrompter, unattendedPrompter,
} from "../../packages/cli/src/init/prompts.js";
import { scriptedPrompter } from "../support/init-fakes.js";

class FakeTty extends EventEmitter {
  isTTY = true;
  rawModes: boolean[] = [];
  setRawMode(mode: boolean) { this.rawModes.push(mode); return this; }
  resume() { return this; }
  pause() { return this; }
}

class FakePipe extends EventEmitter {
  isTTY = false;
  resume() { return this; }
  pause() { return this; }
}

function sink() {
  const written: string[] = [];
  return { written, write: (text: string) => { written.push(text); } };
}

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("hidden input", () => {
  it("reads a long secret whole in raw mode, echoes nothing of it, and restores the terminal (Review Focus 3)", async () => {
    const input = new FakeTty();
    const output = sink();
    const secret = `xoxb-${"a1".repeat(150)}`; // 305 characters, past macOS security's 128-character cut
    const pending = readHidden(input, output, "Bot token: ");
    for (const character of secret) input.emit("data", character);
    input.emit("data", "\r");
    await expect(pending).resolves.toBe(secret);
    expect(output.written.join("")).toBe("Bot token: \n");
    expect(input.rawModes).toEqual([true, false]);
  });

  it("strips bracketed-paste markers and honours backspace (Review Focus 3)", async () => {
    const input = new FakeTty();
    const pending = readHidden(input, sink(), "Secret: ");
    input.emit("data", "\u001b[200~abcX\u001b[201~");
    input.emit("data", "\u007f");
    input.emit("data", "d\r");
    await expect(pending).resolves.toBe("abcd");
  });

  it("cancels on Ctrl-C and still restores the terminal", async () => {
    const input = new FakeTty();
    const pending = readHidden(input, sink(), "Secret: ");
    input.emit("data", "abc\u0003");
    await expect(pending).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("cancelled") as unknown });
    expect(input.rawModes).toEqual([true, false]);
  });

  it("reads one line from piped input, dropping a trailing CR", async () => {
    const input = new FakePipe();
    const pending = readHidden(input, sink(), "Secret: ");
    input.emit("data", Buffer.from("piped-value\r\nnext line\n"));
    await expect(pending).resolves.toBe("piped-value");
  });
});

describe("cleaning secrets", () => {
  it("trims surrounding spaces and line breaks and paste markers (Review Focus 3)", () => {
    expect(cleanSecret("  \u001b[200~value-123\u001b[201~\r\n", "Slack bot token")).toBe("value-123");
  });

  it("refuses whitespace inside a single-line secret without echoing it", () => {
    let message = "";
    try { cleanSecret("abc def-secret", "Slack bot token"); } catch (error) { message = (error as Error).message; }
    expect(message).toBe("CONFIG_INVALID: the Slack bot token contains spaces or line breaks; copy it again and paste only the value");
    expect(message).not.toContain("def-secret");
  });

  it("allows line breaks inside a multiline secret such as a PEM key", () => {
    expect(cleanSecret("\n-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n\n", "GitHub App private key", { multiline: true }))
      .toBe("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----");
  });

  it("refuses an empty secret", () => {
    expect(() => cleanSecret(" \r\n", "Slack signing secret")).toThrow("the Slack signing secret is empty");
  });
});

describe("secret sources", () => {
  it("prefers the file, then the environment variable, then the hidden prompt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentx-secret-"));
    dirs.push(dir);
    await writeFile(join(dir, "token"), "from-file\n");
    const base = { what: "Slack bot token", flag: "--slack-bot-token", processEnv: { TOKEN: "from-env" } };
    await expect(secretFromSource({ ...base, source: { file: join(dir, "token"), envName: "TOKEN" }, prompter: scriptedPrompter([]) })).resolves.toBe("from-file");
    await expect(secretFromSource({ ...base, source: { envName: "TOKEN" }, prompter: scriptedPrompter([]) })).resolves.toBe("from-env");
    await expect(secretFromSource({ ...base, source: {}, prompter: scriptedPrompter(["from-prompt "]) })).resolves.toBe("from-prompt");
  });

  it("names a missing environment variable without guessing", async () => {
    await expect(secretFromSource({ what: "Slack bot token", flag: "--slack-bot-token", source: { envName: "NOPE" }, processEnv: {}, prompter: scriptedPrompter([]) }))
      .rejects.toThrow("environment variable NOPE (--slack-bot-token-env) is not set");
  });

  it("with --yes and no source, names both flags that could supply the secret", async () => {
    await expect(secretFromSource({ what: "Slack bot token", flag: "--slack-bot-token", source: {}, processEnv: {}, prompter: unattendedPrompter() }))
      .rejects.toThrow("Slack bot token needs an answer; with --yes, pass --slack-bot-token-file <path> or --slack-bot-token-env <NAME>");
  });
});

describe("secret shapes", () => {
  it("accepts a bot token and refuses a user or app token, never echoing it", () => {
    expect(checkSlackBotToken("xoxb-123-456-abcDEF")).toBe("xoxb-123-456-abcDEF");
    expect(() => checkSlackBotToken("xoxp-111-secretvalue")).toThrow("that is a user token (xoxp-); paste the Bot User OAuth Token from OAuth & Permissions, which starts with xoxb-");
    expect(() => checkSlackBotToken("xapp-1-secretvalue")).toThrow("that is an app-level token (xapp-); paste the Bot User OAuth Token, which starts with xoxb-");
    let message = "";
    try { checkSlackBotToken("nonsense-secretvalue"); } catch (error) { message = (error as Error).message; }
    expect(message).not.toContain("secretvalue");
  });

  it("accepts a 32-character hexadecimal signing secret only", () => {
    expect(checkSlackSigningSecret("0123456789abcdef0123456789abcdef")).toBe("0123456789abcdef0123456789abcdef");
    expect(() => checkSlackSigningSecret("0123456789abcdef")).toThrow("a Slack signing secret is 32 lowercase hexadecimal characters (Basic Information, App Credentials, Signing Secret)");
  });

  it("accepts a PEM private key only", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----";
    expect(checkPrivateKeyPem(pem)).toBe(pem);
    expect(() => checkPrivateKeyPem("not a key")).toThrow("the GitHub App private key must be the .pem file GitHub gave you (it starts with -----BEGIN)");
  });
});

describe("terminal prompter", () => {
  function scriptedIo(lines: string[]) {
    const out: string[] = [];
    return { out, io: { readLine: async () => lines.shift() ?? "", readSecret: async () => lines.shift() ?? "", write: (text: string) => { out.push(text); } } };
  }

  it("returns the default on an empty line and asks again until the answer is valid", async () => {
    const { io, out } = scriptedIo(["", "BAD", "good"]);
    const prompter = terminalPrompter(io);
    await expect(prompter.ask("Region", { flag: "--region", defaultValue: "us-east-1" })).resolves.toBe("us-east-1");
    await expect(prompter.ask("Name", { flag: "--name", validate: (value) => (value === "good" ? undefined : "must be good") })).resolves.toBe("good");
    expect(out.join("")).toContain("must be good");
  });

  it("returns an empty answer only for an optional question (an empty default)", async () => {
    const { io, out } = scriptedIo(["", "", "x"]);
    const prompter = terminalPrompter(io);
    await expect(prompter.ask("Boundary (Enter for none)", { flag: "--permission-boundary", defaultValue: "" })).resolves.toBe("");
    await expect(prompter.ask("Required", { flag: "--required" })).resolves.toBe("x");
    expect(out.join("")).toContain("an answer is required");
  });

  it("chooses by number or value, and confirms with the default on an empty line", async () => {
    const { io } = scriptedIo(["2", "", "n"]);
    const prompter = terminalPrompter(io);
    const choices = [{ value: "templates", label: "templates" }, { value: "cdk", label: "cdk" }] as const;
    await expect(prompter.choose("Engine", choices, { flag: "--engine", defaultValue: "templates" })).resolves.toBe("cdk");
    await expect(prompter.confirm("Continue?", { defaultValue: true })).resolves.toBe(true);
    await expect(prompter.confirm("Continue?", { defaultValue: true })).resolves.toBe(false);
  });
});
