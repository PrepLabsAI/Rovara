// Test services, slice 3 (s3-fakes-run): the fake server's container program (worker/src/fake-helper.ts), run for real on a loopback address. It serves only the pinned set, answers the one caller it was given, writes its ledger
// before it answers, and its ledger summary counts what the caller asked; a tampered, overflowing or unreadable ledger is untrusted and counts nothing.
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FixtureSetSchema, fixtureEntry, fixtureSetDigest, type FixtureSet } from "@agentx/contracts";
import { FakeHelperRefused, parseFakeLedgerSummary, parseServeArguments, parseSummarizeArguments, serveFake, summarizeFakeLedger } from "../../packages/worker/src/fake-helper.js";

const dependency = { id: "payments", family: "http:api.example-pay.com", protocol: "http_json", target: "api.example-pay.com" } as const;
const match = { ignorePaths: [] as string[] };
const entry = (path: string, body: string) => fixtureEntry({ dependency, match }, { method: "GET", path, contentType: "", body: "" }, { status: 200, headers: [], contentType: "application/json", body, latencyMs: 0 });
const SET: FixtureSet = FixtureSetSchema.parse({
  schemaVersion: 2, dependency, origin: "written", writtenBy: "Priya", revision: 1, syntheticOnly: true, match, entries: [entry("/v1/ping", '{"ok":true}'), entry("/v1/charge", '{"id":"ch_1"}')], faults: [{ name: "busy", kind: "throttle", status: 429, delayMs: 0 }],
});
const DIGEST = fixtureSetDigest(SET);

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "rsfh-"));
  dirs.push(dir);
  const fixture = join(dir, "fixture.json");
  const ledger = join(dir, "ledger.jsonl");
  writeFileSync(fixture, JSON.stringify(SET));
  return { dir, fixture, ledger };
}
const argsFor = (w: ReturnType<typeof workspace>, over: Partial<Record<"listen" | "port" | "caller" | "digest" | "unmatched", string>> = {}) => [
  "--listen", over.listen ?? "127.0.0.1", "--port", over.port ?? "0", "--caller", over.caller ?? "127.0.0.1", "--digest", over.digest ?? DIGEST, "--unmatched", over.unmatched ?? "fail", "--fixture", w.fixture, "--ledger", w.ledger,
];
// Port 0 is not a launcher value (the launcher always gives the entry's port); the tests let the system choose.
async function serve(w: ReturnType<typeof workspace>, over: Parameters<typeof argsFor>[1] = {}) {
  const args = parseServeArguments(argsFor(w, { ...over, port: "1" }));
  return serveFake({ ...args, port: 0 });
}
const get = (url: string, path: string) => fetch(`${url}${path}`);
const summaryOf = (w: ReturnType<typeof workspace>, caller = "127.0.0.1") => summarizeFakeLedger(parseSummarizeArguments(["--summarize", "--ledger", w.ledger, "--fixture", w.fixture, "--digest", DIGEST, "--caller", caller]));

describe("serving", () => {
  it("answers a request in the set, fails one that is not and counts it, and its summary counts both for the caller", async () => {
    const w = workspace();
    const server = await serve(w);
    try {
      const ok = await get(server.url, "/v1/ping");
      expect(ok.status).toBe(200);
      expect(await ok.text()).toBe('{"ok":true}');
      const unknown = await get(server.url, "/v1/refund");
      expect(unknown.status).toBe(500);
      expect(unknown.headers.get("x-rovara-mock")).toBe("no-recording");
      await get(server.url, "/v1/charge");
    } finally { await server.close(); }
    expect(summaryOf(w)).toEqual({ schemaVersion: 1, trusted: true, matched: 2, unmatched: 1, synthesized: 0, faults: 0, foreign: 0 });
  });
  it("answers the one caller it was given: a call from another address gets the fixed 599, is counted apart, and is no match", async () => {
    const w = workspace();
    const server = await serve(w, { caller: "10.9.9.9" });
    try {
      const refused = await get(server.url, "/v1/ping");
      expect(refused.status).toBe(599);
      expect(await refused.text()).toBe('{"error":"rovara-unmocked"}');
    } finally { await server.close(); }
    // the summary is for the address the worker names; the calls above came from loopback, so for 10.9.9.9 they are foreign too
    expect(summaryOf(w, "10.9.9.9")).toMatchObject({ trusted: true, matched: 0, foreign: 1 });
  });
  it("listens on the run address and nowhere else, and refuses a wildcard, a name, two callers and a policy that makes up answers", () => {
    const w = workspace();
    for (const over of [{ listen: "0.0.0.0" }, { listen: "localhost" }, { listen: "::" }, { unmatched: "schema_synth" }, { digest: "abc" }, { caller: "fake-payments" }, { port: "0" }, { port: "70000" }]) {
      expect(() => parseServeArguments(argsFor(w, over)), JSON.stringify(over)).toThrow(FakeHelperRefused);
    }
    expect(() => parseServeArguments([...argsFor(w), "--caller", "10.0.0.2"])).toThrow(FakeHelperRefused);
    expect(() => parseServeArguments([...argsFor(w), "--control-token", "x"])).toThrow(FakeHelperRefused);
    expect(() => parseServeArguments(argsFor(w).filter((arg) => arg !== "--ledger" && arg !== w.ledger))).toThrow(FakeHelperRefused);
    expect(() => parseServeArguments(["--listen", "127.0.0.1", "--port", "8080", "--caller", "127.0.0.1", "--digest", DIGEST, "--unmatched", "fail", "--fixture", "../etc/passwd", "--ledger", "/tmp/l"])).toThrow(FakeHelperRefused);
  });
  it("serves only the set the plan pinned: a set that is another one, a file that is not a set and a missing file are refused, and nothing listens", async () => {
    const w = workspace();
    const other = FixtureSetSchema.parse({ ...SET, revision: 2 });
    writeFileSync(w.fixture, JSON.stringify(other));
    await expect(serve(w)).rejects.toMatchObject({ reason: "fixture" });
    writeFileSync(w.fixture, '{"nonsense":true}');
    await expect(serve(w)).rejects.toMatchObject({ reason: "fixture" });
    writeFileSync(w.fixture, `${JSON.stringify(SET)}\n{`);
    await expect(serve(w)).rejects.toMatchObject({ reason: "fixture" });
    rmSync(w.fixture);
    await expect(serve(w)).rejects.toMatchObject({ reason: "fixture" });
  });
  it("makes no outbound connection: its source and the server core import nothing that could forward a request", () => {
    const own = readFileSync(new URL("../../packages/worker/src/fake-helper.ts", import.meta.url), "utf8");
    expect(own).not.toMatch(/\bfetch\(|http\.request|https\.request|net\.connect|node:(?:https?|dgram|tls|child_process)/u);
    expect(own.match(/from "node:[a-z/]+"/gu)).toEqual(['from "node:fs"', 'from "node:net"']);
  });
});

describe("the summary", () => {
  it("is untrusted, with nothing counted, for a ledger with a line that does not parse, a repeated request, or a lie about the set", async () => {
    const w = workspace();
    const server = await serve(w);
    try { await get(server.url, "/v1/ping"); } finally { await server.close(); }
    expect(summaryOf(w).trusted).toBe(true);
    const good = readFileSync(w.ledger, "utf8");
    appendFileSync(w.ledger, "this is not json\n");
    expect(summaryOf(w)).toEqual({ schemaVersion: 1, trusted: false, matched: 0, unmatched: 0, synthesized: 0, faults: 0, foreign: 0 });
    writeFileSync(w.ledger, good + good);
    expect(summaryOf(w).trusted).toBe(false);
    // a line that says it answered an entry the set does not hold, or with another body
    const line = JSON.parse(good.trim()) as Record<string, unknown>;
    writeFileSync(w.ledger, `${JSON.stringify({ ...line, responseSha256: "f".repeat(64) })}\n`);
    expect(summaryOf(w).trusted).toBe(false);
  });
  it("is untrusted for a ledger past its bound, a missing ledger and a set that is not the pinned one", async () => {
    const w = workspace();
    writeFileSync(w.ledger, "x".repeat(5 * 1024 * 1024));
    expect(summaryOf(w).trusted).toBe(false);
    rmSync(w.ledger);
    expect(summaryOf(w).trusted).toBe(false);
    writeFileSync(w.ledger, "");
    expect(summaryOf(w)).toMatchObject({ trusted: true, matched: 0 });
    writeFileSync(w.fixture, JSON.stringify(FixtureSetSchema.parse({ ...SET, revision: 9 })));
    expect(summaryOf(w).trusted).toBe(false);
  });
  it("is one line of JSON that the worker reads with a strict schema: anything else is unreadable", () => {
    const good = { schemaVersion: 1, trusted: true, matched: 1, unmatched: 0, synthesized: 0, faults: 0, foreign: 0 };
    expect(parseFakeLedgerSummary(`${JSON.stringify(good)}\n`)).toEqual(good);
    for (const bad of ["", "\n", "{}", `${JSON.stringify(good)}\n${JSON.stringify(good)}`, JSON.stringify({ ...good, paths: ["/x"] }), JSON.stringify({ ...good, matched: -1 }), JSON.stringify({ ...good, matched: 10_001 }), JSON.stringify({ ...good, trusted: false }), `warning\n${JSON.stringify(good)}`]) {
      expect(parseFakeLedgerSummary(bad), bad).toBeUndefined();
    }
  });
  it("counts nothing the program sent into the summary: only five numbers and two words", async () => {
    const w = workspace();
    const server = await serve(w);
    try { await get(server.url, "/v1/refund?token=hunter2-secret-value"); } finally { await server.close(); }
    const printed = JSON.stringify(summaryOf(w));
    expect(printed).not.toContain("hunter2");
    expect(Object.keys(JSON.parse(printed) as object).sort()).toEqual(["faults", "foreign", "matched", "schemaVersion", "synthesized", "trusted", "unmatched"]);
  });
});
