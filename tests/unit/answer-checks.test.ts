// Pure pieces of the answer service (lead 4, J1): the numbers rule, the secret-shaped path rule, the model's reply format, and how words are framed and cleaned.
import { describe, expect, it } from "vitest";
import { ANSWER_LIMITS } from "@agentx/contracts";
import { numbersInQuotes, numbersOf, refusingSecrets, sentenceNumbersOf } from "../../packages/broker/src/core/answers/verify.js";
import { holdsPrivateKey, secretShapedPath } from "../../packages/broker/src/core/answers/secret-files.js";
import { parseTurn } from "../../packages/broker/src/core/answers/protocol.js";

describe("the numbers rule", () => {
  it("reads whole numbers, decimals and thousands groups, and not digits inside a name", () => {
    expect(numbersOf("It waits 30 days, retries 3 times, costs 1,000 or 2.5 each.")).toEqual(["30", "3", "1000", "2.5"]);
    expect(numbersOf("Use sha256 and base64 with v2 of the api_v3 and file2.ts")).toEqual([]);
    expect(numbersOf("It stops at 20.")).toEqual(["20"]);
    expect(numbersOf("Version 1.2.3 ships")).toEqual(["1.2.3"]);
    expect(numbersOf("０５ and 07")).toEqual(["5", "7"]);
  });
  it("reads a sentence's numbers leniently: money, units, signs, ranges, comma lists and digits inside names that no quote holds", () => {
    expect(sentenceNumbersOf("It costs $5000 and waits 300ms for 512MB, down -42 or 3-5 times, 1,5 and 1,000.", [])).toEqual(["5000", "300", "512", "42", "3", "5", "1", "1000"]);
    expect(sentenceNumbersOf("It uses sha256 and v2.", [])).toEqual(["256", "2"]);
    // A name a quote holds whole is a name, not a number.
    expect(sentenceNumbersOf("It uses sha256 and v2.", ["const h = sha256(x);"])).toEqual(["2"]);
  });
  it("a number the quote has only as part of something else, or in a form the sentence does not say, does not match", () => {
    expect(numbersInQuotes("It costs $5000.", ["const COST = 500;"])).toBe(false);
    expect(numbersInQuotes("It costs $5000.", ["const COST = 5000;"])).toBe(true);
    expect(numbersInQuotes("It waits 300ms.", ["const WAIT = 30;"])).toBe(false);
    expect(numbersInQuotes("It waits 300ms.", ["const WAIT_MS = 300;"])).toBe(true);
    expect(numbersInQuotes("It reserves 512MB.", ["const MEM = 256;"])).toBe(false);
    expect(numbersInQuotes("It is -42.", ["const X = 24;"])).toBe(false);
    expect(numbersInQuotes("It retries 3-5 times.", ["const MIN = 3;"])).toBe(false);
    expect(numbersInQuotes("It retries 3-5 times.", ["const MIN = 3;", "const MAX = 5;"])).toBe(true);
    expect(numbersInQuotes("It takes 1,5 seconds.", ["const T = 15;"])).toBe(false);
    expect(numbersInQuotes("It takes 1,5 seconds.", ["const T = 1, 5;"])).toBe(true);
    expect(numbersInQuotes("It waits \u0663\u0660 days.", ["const DAYS = 30;"])).toBe(false);
    expect(numbersInQuotes("It uses sha256.", ["const h = sha256(x);"])).toBe(true);
    expect(numbersInQuotes("It uses sha256.", ["const h = hash(x);"])).toBe(false);
  });
});

describe("secret-shaped paths", () => {
  it.each([".env", ".env.local", "web/.env.production", "config/app.env", "keys/server.pem", "deploy/id_rsa", "deploy/id_ed25519.pub", ".npmrc", "a/.netrc", "credentials.json", "aws/credentials", "kubeconfig", ".envrc", "a/.envrc", "terraform.tfstate.backup", "x/prod.tfstate", "svc.keytab", ".vault-token", "service-account-prod.json", "terraform.tfstate", "prod.tfvars", "secrets/db.ts", "config/secrets/x.ts", "src/app/secret.ts", "my-secret-file.txt", "certs/ca.crt", "src/.git/config", ".ssh/known_hosts", "a/../b", "/abs/path", "a\\b", "a//b", ""])("%s is refused", (path) => {
    expect(secretShapedPath(path)).toBe(true);
  });
  it.each(["src/refund.ts", "README.md", "packages/api/secretary.ts", "docs/keyboard.md", "src/environment.ts", "src/envelope.ts", "lib/credentials-form.tsx.md".replace("credentials-form", "form")])("%s is not", (path) => {
    expect(secretShapedPath(path)).toBe(false);
  });
  it("sees a private key block in a file's text", () => {
    // Built at run time: a key-shaped header must not sit in the public source.
    const header = (kind: string): string => ["-----BEGIN", kind].join(" ") + "-----";
    expect(holdsPrivateKey(`x\n${header("RSA PRIVATE KEY")}\nabc`)).toBe(true);
    expect(holdsPrivateKey(header("OPENSSH PRIVATE KEY"))).toBe(true);
    expect(holdsPrivateKey(header("PUBLIC KEY"))).toBe(false);
  });
  it("the checking reader hands back the text redacted line by line, and refuses a file that holds a key block", async () => {
    const key = `${"AK"}${"IA"}${"IOSFODNN7EXAMPLE"}`;
    const files: Record<string, string> = { "a.ts": `const id = "${key}";\nconst ok = 1;`, "b.txt": `a line\n${["-----BEGIN", "RSA PRIVATE KEY-----"].join(" ")}\nabc` };
    const read = refusingSecrets(async (_repo, path) => files[path]);
    const shown = await read("web", "a.ts", "a".repeat(40), { timeoutMs: 1 });
    expect(shown).not.toContain(key);
    expect(shown?.split("\n")).toHaveLength(2);
    expect(shown).toContain("const ok = 1;");
    expect(await read("web", "b.txt", "a".repeat(40), { timeoutMs: 1 })).toBeUndefined();
    expect(await read("web", "missing.ts", "a".repeat(40), { timeoutMs: 1 })).toBeUndefined();
  });
  it("the checking reader refuses a secret-shaped path without asking the host", async () => {
    const asked: string[] = [];
    const read = refusingSecrets(async (_repo, path) => { asked.push(path); return "text"; });
    expect(await read("web", ".env", "a".repeat(40), { timeoutMs: 1 })).toBeUndefined();
    expect(await read("web", "src/a.ts", "a".repeat(40), { timeoutMs: 1 })).toBe("text");
    expect(asked).toEqual(["src/a.ts"]);
  });
});

describe("the model's reply", () => {
  const final = { action: "answer", sentences: [{ text: "A.", cites: [{ repo: "web", path: "a.ts", line: 1, quote: "q".repeat(20) }] }] };
  it("reads one JSON object, bare or in a code fence, and nothing else", () => {
    expect(parseTurn(JSON.stringify(final)).kind).toBe("final");
    expect(parseTurn("```json\n" + JSON.stringify(final) + "\n```").kind).toBe("final");
    expect(parseTurn(`Sure! ${JSON.stringify(final)}`).kind).toBe("bad");
    expect(parseTurn(`${JSON.stringify(final)} ${JSON.stringify(final)}`).kind).toBe("bad");
    expect(parseTurn("[1]").kind).toBe("bad");
    expect(parseTurn("null").kind).toBe("bad");
    expect(parseTurn("").kind).toBe("bad");
  });
  it("the three lookups are the only tools; any other name is `other_tool`, a malformed one is bad", () => {
    expect(parseTurn(JSON.stringify({ action: "tool", tool: "wiki_search", query: "a" })).kind).toBe("tool");
    expect(parseTurn(JSON.stringify({ action: "tool", tool: "wiki_read", page: "p" })).kind).toBe("tool");
    expect(parseTurn(JSON.stringify({ action: "tool", tool: "code_read", repo: "r", path: "p" })).kind).toBe("tool");
    expect(parseTurn(JSON.stringify({ action: "tool", tool: "shell", cmd: "x" })).kind).toBe("other_tool");
    expect(parseTurn(JSON.stringify({ action: "tool", tool: "code_read" })).kind).toBe("bad");
    expect(parseTurn(JSON.stringify({ action: "tool" })).kind).toBe("bad");
    expect(parseTurn(JSON.stringify({ action: "delete" })).kind).toBe("bad");
  });
  it("the answer's size is bounded and a commit or a label in it is dropped", () => {
    const parsed = parseTurn(JSON.stringify({ ...final, label: "x", sentences: [{ text: "A.", cites: [{ repo: "web", path: "a.ts", line: 1, quote: "q".repeat(20), commit: "f".repeat(40) }] }] }));
    expect(parsed.kind).toBe("final");
    if (parsed.kind === "final") {
      expect(JSON.stringify(parsed.final)).not.toContain("ffffffff");
      expect(JSON.stringify(parsed.final)).not.toContain("label");
    }
    expect(parseTurn(JSON.stringify({ ...final, sentences: Array.from({ length: ANSWER_LIMITS.sentences + 1 }, () => final.sentences[0]) })).kind).toBe("bad");
    expect(parseTurn(JSON.stringify({ ...final, sentences: [{ text: "A.", cites: Array.from({ length: 4 }, () => final.sentences[0]!.cites[0]) }] })).kind).toBe("bad");
  });
});
