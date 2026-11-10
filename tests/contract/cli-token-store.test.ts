import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SystemCredentialTokenStore, type StoredTokens } from "../../packages/cli/src/token-store.js";

// Plan 3 follow-up KC: the Keychain token must never be on any process's command line.

const realPlatform = process.platform;
const realPath = process.env.PATH ?? "";
let fakeDir: string;

function setPlatform(value: string): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

// A stand-in for `security` / `secret-tool` that records argv and stdin of every call, one JSON line per call.
// FAKE_EXIT / FAKE_STDERR / FAKE_STDOUT let a test shape the reply.
function installFake(name: string): void {
  // stdin is read until EOF or 1.5 s, so a caller that never closes it cannot hang the test.
  const script = `#!${process.execPath}
const fs = require("node:fs");
const dir = process.env.FAKE_DIR;
let stdin = "";
let done = false;
function finish() {
  if (done) return;
  done = true;
  fs.appendFileSync(dir + "/calls.jsonl", JSON.stringify({ tool: ${JSON.stringify(name)}, argv: process.argv.slice(2), stdin }) + "\\n");
  if (process.env.FAKE_STDERR) process.stderr.write(process.env.FAKE_STDERR);
  if (process.env.FAKE_STDOUT) process.stdout.write(process.env.FAKE_STDOUT);
  process.exit(Number(process.env.FAKE_EXIT ?? "0"));
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", finish);
setTimeout(finish, 1500);
`;
  const path = join(fakeDir, name);
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

// Points the store at the fake `security`; the production default is the absolute /usr/bin/security.
function fakeStore(service = "dev.rovara.kc-test.unit"): SystemCredentialTokenStore {
  return new SystemCredentialTokenStore(service, { securityPath: join(fakeDir, "security") });
}

interface Call {
  tool: string;
  argv: string[];
  stdin: string;
}

function calls(): Call[] {
  try {
    return readFileSync(join(fakeDir, "calls.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Call);
  } catch {
    return [];
  }
}

// Mirrors the `security -i` tokenizer as measured on macOS: a double-quoted word ends at the first unescaped
// quote, and a backslash makes the next character literal. The real Keychain test below checks the model itself.
function parseSecurityLine(line: string): string[] {
  const words: string[] = [];
  let current = "";
  let inWord = false;
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] as string;
    if (ch === "\\") {
      current += line[i + 1] ?? "";
      i += 1;
      inWord = true;
    } else if (ch === '"') {
      quoted = !quoted;
      inWord = true;
    } else if (ch === " " && !quoted) {
      if (inWord) words.push(current);
      current = "";
      inWord = false;
    } else {
      current += ch;
      inWord = true;
    }
  }
  if (inWord) words.push(current);
  return words;
}

const nasty: StoredTokens = {
  accessToken: 'ac"ce\\ss to\nken with \'quotes\', spaces, \\n and \\" é€ \u0001\u007f',
  refreshToken: 'ref\\"resh\r\n token \\\\ "end"',
  expiresAt: 1_900_000_000_000,
};

beforeEach(() => {
  fakeDir = mkdtempSync(join(tmpdir(), "kc-fake-"));
  process.env.PATH = `${fakeDir}:${realPath}`;
  process.env.FAKE_DIR = fakeDir;
  delete process.env.FAKE_EXIT;
  delete process.env.FAKE_STDERR;
  delete process.env.FAKE_STDOUT;
});

afterEach(() => {
  setPlatform(realPlatform);
  process.env.PATH = realPath;
  delete process.env.FAKE_DIR;
  delete process.env.FAKE_EXIT;
  delete process.env.FAKE_STDERR;
  delete process.env.FAKE_STDOUT;
  rmSync(fakeDir, { recursive: true, force: true });
});

describe("SystemCredentialTokenStore.set on macOS", () => {
  beforeEach(() => {
    setPlatform("darwin");
    installFake("security");
  });

  it("keeps both tokens out of every argv and sends the command on stdin", async () => {
    const tokens: StoredTokens = { accessToken: "SECRET-ACCESS-123", refreshToken: "SECRET-REFRESH-456", expiresAt: 42 };
    await fakeStore().set("acct", tokens);

    const recorded = calls();
    expect(recorded.length).toBeGreaterThan(0);
    for (const call of recorded) {
      expect(call.argv.join(" ")).not.toContain("SECRET-ACCESS-123");
      expect(call.argv.join(" ")).not.toContain("SECRET-REFRESH-456");
    }
    const write = recorded.find((call) => call.stdin.includes("add-generic-password"));
    expect(write).toBeDefined();
    expect(write?.argv).toEqual(["-i"]);
    expect(write?.stdin).toContain("SECRET-ACCESS-123");
    expect(write?.stdin).toContain("SECRET-REFRESH-456");
  });

  it("quotes quotes, backslashes, spaces, newlines and non-ASCII so the value reaches security unchanged", async () => {
    await fakeStore().set("acct name", nasty);

    const write = calls().find((call) => call.stdin.includes("add-generic-password"));
    const lines = (write?.stdin ?? "").split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    expect((write?.stdin ?? "").endsWith("\n")).toBe(true);

    const words = parseSecurityLine(lines[0] as string);
    expect(words.slice(0, 7)).toEqual(["add-generic-password", "-U", "-s", "dev.rovara.kc-test.unit", "-a", "acct name", "-w"]);
    expect(words).toHaveLength(8);
    expect(JSON.parse(words[7] as string)).toEqual(nasty);
    // The value is plain printable ASCII, so `security find-generic-password -w` prints it back as text, not hex.
    expect(words[7]).toMatch(/^[\x20-\x7e]+$/);
  });

  it("refuses a value too long for security's input line instead of letting it truncate", async () => {
    const store = fakeStore();
    await expect(store.set("acct", { accessToken: "x".repeat(4100), expiresAt: 1 })).rejects.toThrow(/too long/i);
    expect(calls()).toEqual([]);
  });

  it("accepts a long refresh token that still fits the line", async () => {
    await fakeStore().set("acct", {
      accessToken: "a".repeat(1500),
      refreshToken: "r".repeat(1500),
      expiresAt: 1,
    });
    expect(calls().some((call) => call.stdin.includes("add-generic-password"))).toBe(true);
  });

  it("rejects a service or account that would break out of the quoted command", async () => {
    await expect(fakeStore("svc\nexit").set("acct", { accessToken: "t", expiresAt: 1 })).rejects.toThrow();
    await expect(fakeStore("svc").set("acct\n", { accessToken: "t", expiresAt: 1 })).rejects.toThrow();
    expect(calls()).toEqual([]);
  });

  it("fails when security exits non-zero", async () => {
    process.env.FAKE_EXIT = "1";
    process.env.FAKE_STDERR = "security: SecKeychainItemCreateFromContent failed";
    await expect(fakeStore().set("acct", { accessToken: "t", expiresAt: 1 })).rejects.toThrow();
  });

  it("fails when interactive security reports an error on stderr even if it exits 0", async () => {
    process.env.FAKE_EXIT = "0";
    process.env.FAKE_STDERR = 'security: unknown command "abc"';
    await expect(fakeStore().set("acct", { accessToken: "t", expiresAt: 1 })).rejects.toThrow();
  });

  it("does not echo the token in the failure message, even when security echoes the rejected command", async () => {
    process.env.FAKE_EXIT = "1";
    // Real `security -i` quotes the text of a command it cannot parse, token included.
    process.env.FAKE_STDERR = 'security: unknown command "SECRET-ACCESS-123"';
    const error = await fakeStore()
      .set("acct", { accessToken: "SECRET-ACCESS-123", expiresAt: 1 })
      .catch((caught: unknown) => caught as Error);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toContain("SECRET-ACCESS-123");
  });
});

describe("SystemCredentialTokenStore get and delete on macOS", () => {
  beforeEach(() => {
    setPlatform("darwin");
    installFake("security");
  });

  it("reads the stored tokens back through find-generic-password", async () => {
    process.env.FAKE_STDOUT = `${JSON.stringify({ accessToken: "a", refreshToken: "r", expiresAt: 5 })}\n`;
    await expect(fakeStore().get("acct")).resolves.toEqual({
      accessToken: "a",
      refreshToken: "r",
      expiresAt: 5,
    });
    expect(calls()[0]?.argv).toEqual(["find-generic-password", "-s", "dev.rovara.kc-test.unit", "-a", "acct", "-w"]);
  });

  it.each([44, 1])("treats exit code %s as no token", async (code) => {
    process.env.FAKE_EXIT = String(code);
    await expect(fakeStore().get("acct")).resolves.toBeUndefined();
  });

  it("still rethrows other failures", async () => {
    process.env.FAKE_EXIT = "2";
    await expect(fakeStore().get("acct")).rejects.toThrow();
  });

  it("delete tolerates a missing item", async () => {
    process.env.FAKE_EXIT = "44";
    await expect(fakeStore().delete("acct")).resolves.toBeUndefined();
    expect(calls()[0]?.argv).toEqual(["delete-generic-password", "-s", "dev.rovara.kc-test.unit", "-a", "acct"]);
  });
});

describe("SystemCredentialTokenStore.set on Linux", () => {
  it("keeps the token on stdin and out of secret-tool's argv", async () => {
    setPlatform("linux");
    installFake("secret-tool");
    await fakeStore().set("acct", {
      accessToken: "SECRET-ACCESS-123",
      refreshToken: "SECRET-REFRESH-456",
      expiresAt: 42,
    });
    const [call] = calls();
    expect(call?.argv.join(" ")).not.toContain("SECRET");
    expect(call?.stdin).toContain("SECRET-ACCESS-123");
    expect(call?.stdin).toContain("SECRET-REFRESH-456");
  });
});

// A `security` earlier on PATH (a planted binary) must not be run: the default is the absolute /usr/bin/security.
// This test only reads a service name that does not exist, so it touches no real item.
describe.skipIf(realPlatform !== "darwin")("SystemCredentialTokenStore binary pinning on macOS", () => {
  it("ignores a security placed earlier on PATH when no override is given", async () => {
    setPlatform("darwin");
    installFake("security");
    const store = new SystemCredentialTokenStore(`dev.rovara.kc-test.pin${Math.random().toString(36).slice(2, 12)}`);
    await expect(store.get("no-such-account")).resolves.toBeUndefined();
    await store.delete("no-such-account");
    expect(calls()).toEqual([]);
  });

  it("honours ROVARA_TEST_SECURITY_PATH only when ROVARA_TEST_MODE=1 and the path is absolute", async () => {
    setPlatform("darwin");
    installFake("security");
    process.env.FAKE_EXIT = "44";
    const fake = join(fakeDir, "security");
    try {
      process.env.ROVARA_TEST_MODE = "1";
      process.env.ROVARA_TEST_SECURITY_PATH = fake;
      await new SystemCredentialTokenStore("dev.rovara.kc-test.env").get("acct");
      expect(calls().map((call) => call.argv[0])).toEqual(["find-generic-password"]);
    } finally {
      delete process.env.ROVARA_TEST_MODE;
      delete process.env.ROVARA_TEST_SECURITY_PATH;
    }
  });

  it.each([
    ["no test-mode flag", undefined, "ABS"],
    ["test mode not exactly 1", "true", "ABS"],
    ["a relative path", "1", "./security"],
  ])("ignores ROVARA_TEST_SECURITY_PATH with %s", async (_label, mode, path) => {
    setPlatform("darwin");
    installFake("security");
    try {
      if (mode !== undefined) process.env.ROVARA_TEST_MODE = mode;
      process.env.ROVARA_TEST_SECURITY_PATH = path === "ABS" ? join(fakeDir, "security") : path;
      // Reads a service name that does not exist, through the real /usr/bin/security.
      const store = new SystemCredentialTokenStore(`dev.rovara.kc-test.env${Math.random().toString(36).slice(2, 12)}`);
      await expect(store.get("no-such-account")).resolves.toBeUndefined();
      expect(calls()).toEqual([]);
    } finally {
      delete process.env.ROVARA_TEST_MODE;
      delete process.env.ROVARA_TEST_SECURITY_PATH;
    }
  });

  it("uses the injected path for set, get and delete", async () => {
    setPlatform("darwin");
    installFake("security");
    const store = fakeStore();
    await store.set("acct", { accessToken: "t", expiresAt: 1 });
    process.env.FAKE_EXIT = "44";
    await store.get("acct");
    await store.delete("acct");
    expect(calls().map((call) => call.argv[0])).toEqual(["-i", "find-generic-password", "delete-generic-password"]);
  });
});

// Real Keychain round trip. Opt in with ROVARA_REAL_KEYCHAIN=1 on a Mac. It creates one throwaway item under a random
// dev.rovara.kc-test.* service and deletes it afterwards; it never reads or lists any other item.
const realKeychain = realPlatform === "darwin" && process.env.ROVARA_REAL_KEYCHAIN !== undefined && process.env.ROVARA_REAL_KEYCHAIN !== "";

describe.skipIf(!realKeychain)("SystemCredentialTokenStore on the real macOS Keychain", () => {
  const service = `dev.rovara.kc-test.${process.pid}${Math.random().toString(36).slice(2, 10)}`;
  const account = "kc-test-account";

  afterEach(() => {
    try {
      execFileSync("/usr/bin/security", ["delete-generic-password", "-s", service, "-a", account], { stdio: "ignore" });
    } catch {
      // already gone
    }
  });

  it("round-trips awkward tokens, never shows them in security's argv, and deletes the item", async () => {
    // A wrapper records the argv of the real `security` call, holds the write's stdin back for 3 s so `ps` can be sampled while
    // the real process is alive, then runs the real `security` with the same stdin.
    const wrapper = join(fakeDir, "security");
    writeFileSync(
      wrapper,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${fakeDir}/real-argv.txt"\nif [ "$1" = "-i" ]; then (sleep 3; cat) | /usr/bin/security "$@"; else exec /usr/bin/security "$@"; fi\n`,
    );
    chmodSync(wrapper, 0o755);

    const store = new SystemCredentialTokenStore(service, { securityPath: wrapper });
    const marker = `PSCHECK${Math.random().toString(36).slice(2, 12)}`;
    const pending = store.set(account, { accessToken: marker, expiresAt: 1 });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const processes = execFileSync("ps", ["-axo", "args="], { encoding: "utf8" });
    expect(processes).toContain("/usr/bin/security -i");
    expect(processes).not.toContain(marker);
    await pending;
    expect(readFileSync(join(fakeDir, "real-argv.txt"), "utf8").trim()).toBe("-i");
    await expect(store.get(account)).resolves.toEqual({ accessToken: marker, expiresAt: 1 });

    await store.set(account, nasty);
    await expect(store.get(account)).resolves.toEqual(nasty);

    // Update in place with the longest value that is allowed.
    const big: StoredTokens = { accessToken: "A".repeat(1800), refreshToken: "R".repeat(1800), expiresAt: 7 };
    await store.set(account, big);
    await expect(store.get(account)).resolves.toEqual(big);

    // One byte past the limit must be refused and leave the previous value alone.
    await expect(store.set(account, { accessToken: "B".repeat(4200), expiresAt: 8 })).rejects.toThrow(/too long/i);
    await expect(store.get(account)).resolves.toEqual(big);

    await store.delete(account);
    await expect(store.get(account)).resolves.toBeUndefined();
  });
});
