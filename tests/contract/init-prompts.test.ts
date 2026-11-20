import { EventEmitter } from "node:events";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { askForm, checkPrivateKeyPem, checkSlackBotToken, checkSlackSigningSecret, cleanSecret, readHidden, secretFromSource, terminalPrompter, type FormField } from "../../packages/cli/src/init/prompts.js";
import { scriptedPrompter } from "../support/init-fakes.js";

class FakeTty extends EventEmitter {
  isTTY = true;
  rawModes: boolean[] = [];
  override removeListener(event: string, listener: (...args: never[]) => void): this {
    return super.removeListener(event, listener as never);
  }
  setRawMode(mode: boolean) { this.rawModes.push(mode); return this; }
  resume() { return this; }
  pause() { return this; }
}

class FakePipe extends EventEmitter {
  isTTY = false;
  override removeListener(event: string, listener: (...args: never[]) => void): this {
    return super.removeListener(event, listener as never);
  }
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

  it("keeps newlines pasted inside bracketed-paste markers, ending only on Enter after the paste (Important finding)", async () => {
    const input = new FakeTty();
    const pending = readHidden(input, sink(), "Secret: ");
    input.emit("data", "\u001b[200~-----BEGIN KEY-----\nabc\n-----END KEY-----\u001b[201~");
    input.emit("data", "\r");
    await expect(pending).resolves.toBe("-----BEGIN KEY-----\nabc\n-----END KEY-----");
  });

});

describe("cleaning secrets", () => {

  it("refuses whitespace inside a single-line secret without echoing it", () => {
    let message = "";
    try { cleanSecret("abc def-secret", "Slack bot token"); } catch (error) { message = (error as Error).message; }
    expect(message).toBe("CONFIG_INVALID: the Slack bot token contains spaces or line breaks; copy it again and paste only the value");
    expect(message).not.toContain("def-secret");
  });

  it("refuses an empty secret", () => {
    expect(() => cleanSecret(" \r\n", "Slack signing secret")).toThrow("the Slack signing secret is empty");
  });
});

describe("secret sources", () => {

  it("names a missing environment variable without guessing", async () => {
    await expect(secretFromSource({ what: "Slack bot token", flag: "--slack-bot-token", source: { envName: "NOPE" }, processEnv: {}, prompter: scriptedPrompter([]) }))
      .rejects.toThrow("environment variable NOPE (--slack-bot-token-env) is not set");
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

describe("fieldCheck and the terminal's secret prompt (spec 040 FR-040)", () => {

  it("the terminal's hidden prompt ignores validate, so a bad value still fails where it always did", async () => {
    const prompter = terminalPrompter({ readLine: async () => "", readSecret: async () => "not-a-token", write: () => undefined });
    await expect(prompter.secret("Slack bot token", { flag: "--slack-bot-token", validate: () => "refused" })).resolves.toBe("not-a-token");
  });
});

describe("spec 048 FR-072: a form in the terminal", () => {

  it("stops on a cross-field refusal, as a refused value does", async () => {
    const same: FormField[] = [{ name: "a", question: "A", flag: "--a" }, { name: "b", question: "B", flag: "--b" }];
    await expect(askForm(scriptedPrompter(["x", "x"]), "Pair", same, { crossCheck: () => ({ b: "B must differ from A" }) })).rejects.toThrow("B must differ from A");
  });
});
