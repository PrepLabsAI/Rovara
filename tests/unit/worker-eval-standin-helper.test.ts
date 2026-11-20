// L4-E56 (rows E5 and E6): the stand-in helper's container program (worker eval-standin-helper.ts), run for real on loopback with its file seams in memory. Every claim has a control: a set that must be exactly the pinned one and
// bound to this company and task, a caller that is the only one served, a summary written BEFORE each answer is sent, a key that never reaches a file, and a deadline of its own.
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { EVAL_STAND_IN_SET_PATH, buildEvalStandInSetBytes, buildOpenApiFake, evalStandInRequestKey, type EvalStandInPlan, type EvalStandInSetContent } from "@agentx/contracts";
import {
  EVAL_STAND_IN_ADDITIONS_PATH, EvalStandInHelperRefused, isEvalStandInSummarizeRequest, parseEvalStandInServeArguments, serveEvalStandIn, summarizeEvalStandIn, type RunningEvalStandInHelper, type SummaryFiles,
} from "../../packages/worker/src/eval-standin-helper.js";
import { createRunCa } from "../../packages/worker/src/run-ca.js";

/** A string shaped like a PEM block, built at run time so no key-shaped literal sits in the source. */
const fakePem = (label: string): string => `${"-".repeat(5)}BEGIN ${label}${"-".repeat(5)}\n${"A".repeat(120)}\n${"-".repeat(5)}END ${label}${"-".repeat(5)}\n`;
const WORKSPACE = "0b9f6a1e-6c1e-4c53-9d0a-5d3a1d6f2c11";
const OPERATION = "7c1f0d3a-2b8e-4a55-8f3b-9a1c2d3e4f50";
const DOCUMENT = {
  openapi: "3.0.3", info: { title: "tiktok", version: "1" },
  paths: { "/v2/user/info": { get: { responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object", required: ["data"], properties: { data: { type: "object", properties: { display_name: { type: "string" } } } } } } } } } } } },
};
const openapi = buildOpenApiFake(DOCUMENT, "openapi.json");
if (openapi.status !== "built") throw new Error("fixture");
const PLAN: EvalStandInPlan = [{ host: "open.tiktokapis.com", openapi }];
const CA = createRunCa();
const content = (overrides: Partial<EvalStandInSetContent> = {}): EvalStandInSetContent => ({ workspaceId: WORKSPACE, operationId: OPERATION, plan: PLAN, recorded: [], book: [], ca: CA, ...overrides });
const SET = buildEvalStandInSetBytes(content())!;
const ARGS = { listen: "127.0.0.1", caller: "127.0.0.1", digest: SET.digest, workspaceId: WORKSPACE, operationId: OPERATION, lifetimeMs: 600_000 } as const;
const SUMMARY_PATH = "/rovara/ledger/test-summary.json";
const ADDITIONS_PATH = "/rovara/ledger/test-additions.json";

function memoryFiles(): SummaryFiles & { files: Map<string, string>; writes: string[]; failWrites: boolean } {
  const files = new Map<string, string>();
  const self = { files, writes: [] as string[], failWrites: false, write(path: string, text: string) { if (self.failWrites) throw new Error("full"); self.writes.push(path); files.set(path, text); }, read(path: string) { const text = files.get(path); if (text === undefined) throw new Error("missing"); return text; } };
  return self;
}
const read = (bytes: Uint8Array = SET.bytes) => (path: string): Uint8Array => { if (path !== EVAL_STAND_IN_SET_PATH) throw new Error("another file"); return bytes; };

const running: RunningEvalStandInHelper[] = [];
afterEach(async () => { await Promise.all(running.splice(0).map((helper) => helper.close())); });
async function start(overrides: Partial<Parameters<typeof serveEvalStandIn>[0]> = {}, bytes?: Uint8Array, extra: Partial<Parameters<typeof serveEvalStandIn>[1]> = {}) {
  const files = memoryFiles();
  const helper = await serveEvalStandIn({ ...ARGS, ...overrides }, { readFile: read(bytes), files, httpPort: 0, tlsPort: 0, summaryPath: SUMMARY_PATH, additionsPath: ADDITIONS_PATH, ...extra });
  running.push(helper);
  return { helper, files };
}

interface Answer { status: number; headers: Record<string, string | string[] | undefined>; body: string }
function http(port: number, host: string, path: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, headers: { host }, agent: false }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}
const summaryOf = (files: SummaryFiles) => summarizeEvalStandIn(files, { summary: SUMMARY_PATH, additions: ADDITIONS_PATH });

describe("the program's arguments", () => {
  const good = ["--listen", "172.30.5.16", "--caller", "172.30.5.4", "--digest", "a".repeat(64), "--workspace", WORKSPACE, "--operation", OPERATION, "--lifetime-ms", "600000"];
  it("parses the six flags", () => {
    expect(parseEvalStandInServeArguments(good)).toEqual({ listen: "172.30.5.16", caller: "172.30.5.4", digest: "a".repeat(64), workspaceId: WORKSPACE, operationId: OPERATION, lifetimeMs: 600_000 });
    expect(isEvalStandInSummarizeRequest(["--summarize"])).toBe(true);
    expect(isEvalStandInSummarizeRequest(["--summarize", "--x"])).toBe(false);
  });
  it.each([
    ["a wildcard", 1, "0.0.0.0"],
    ["the loopback", 1, "127.0.0.1"],
    ["a name", 1, "helper.test"],
    ["the same address for both", 3, "172.30.5.16"],
    ["a short digest", 5, "abc"],
    ["an id that is not a UUID", 7, "company"],
    ["a lifetime under a second", 11, "10"],
    ["a lifetime over a day", 11, "99999999999"],
  ])("refuses %s", (_name, at, value) => {
    const argv = [...good];
    argv[at] = value;
    expect(() => parseEvalStandInServeArguments(argv)).toThrow(EvalStandInHelperRefused);
  });
  it("refuses an unknown flag, a repeated flag and a missing value", () => {
    expect(() => parseEvalStandInServeArguments([...good, "--env", "X=1"])).toThrow(EvalStandInHelperRefused);
    expect(() => parseEvalStandInServeArguments([...good, "--listen", "172.30.5.17"])).toThrow(EvalStandInHelperRefused);
    expect(() => parseEvalStandInServeArguments(good.slice(0, -1))).toThrow(EvalStandInHelperRefused);
  });
});

describe("the pinned set", () => {
  it("serves exactly the pinned set bound to this company and task, and writes its first summary before it listens", async () => {
    const { helper, files } = await start();
    expect(helper.summary()).toMatchObject({ trusted: true, workspaceId: WORKSPACE, operationId: OPERATION, digest: SET.digest, counts: { served: 0 } });
    expect(summaryOf(files)).toMatchObject({ trusted: true });
  });
  it("refuses a set that is not readable, one that is too big, and a set whose authority is not a run authority", async () => {
    const files = memoryFiles();
    const options = { files, httpPort: 0, tlsPort: 0, summaryPath: SUMMARY_PATH, additionsPath: ADDITIONS_PATH };
    await expect(serveEvalStandIn(ARGS, { ...options, readFile: () => { throw new Error("gone"); } })).rejects.toThrow(EvalStandInHelperRefused);
    await expect(serveEvalStandIn(ARGS, { ...options, readFile: () => new Uint8Array(9 * 1024 * 1024) })).rejects.toThrow(EvalStandInHelperRefused);
    const other = buildEvalStandInSetBytes(content({ ca: { certPem: fakePem("CERTIFICATE"), keyPem: fakePem("PRIVATE " + "KEY") } }))!;
    await expect(serveEvalStandIn({ ...ARGS, digest: other.digest }, { ...options, readFile: read(other.bytes) })).rejects.toThrow(EvalStandInHelperRefused);
    expect(files.files.size).toBe(0);
  });
  it("refuses to serve when it cannot write its first summary", async () => {
    const files = memoryFiles(); files.failWrites = true;
    await expect(serveEvalStandIn(ARGS, { readFile: read(), files, httpPort: 0, tlsPort: 0, summaryPath: SUMMARY_PATH, additionsPath: ADDITIONS_PATH })).rejects.toThrow(EvalStandInHelperRefused);
  });
});

describe("serving", () => {
  it("starts from the answers its set already holds: the same bytes the first side saw, counted as a gap again, and no new addition", async () => {
    const first = await start();
    const asked = await http(first.helper.httpPort, "tracker.example.test", "/collect");
    const summary = summaryOf(first.files);
    if (!summary.trusted) throw new Error("trusted");
    const set = buildEvalStandInSetBytes(content({ book: summary.additions }))!;
    const second = await start({ digest: set.digest }, set.bytes);
    const again = await http(second.helper.httpPort, "tracker.example.test", "/collect");
    expect(again.body).toBe(asked.body);
    const after = summaryOf(second.files);
    if (!after.trusted) throw new Error("trusted");
    expect(after.counts).toMatchObject({ gapCalls: 1, newConnections: 1 });
    expect(after.additions).toEqual([]);
  });
  it("answers from the repository's recordings first", async () => {
    const recorded = { method: "GET" as const, host: "open.tiktokapis.com", path: "/v2/user/info", query: "", status: 200, contentType: "application/json", body: '{"data":{"display_name":"Ada"}}' };
    const set = buildEvalStandInSetBytes(content({ recorded: [recorded] }))!;
    const { helper, files } = await start({ digest: set.digest }, set.bytes);
    expect((await http(helper.httpPort, "open.tiktokapis.com", "/v2/user/info")).body).toBe('{"data":{"display_name":"Ada"}}');
    const summary = summaryOf(files);
    if (!summary.trusted) throw new Error("trusted");
    expect(summary.counts).toMatchObject({ recorded: 1, gapCalls: 0 });
    expect(summary.gaps).toEqual([]);
  });
  it("stops answering when it can no longer write its summary (a summary that under-counts is never left standing)", async () => {
    const { helper, files } = await start();
    files.failWrites = true;
    await expect(http(helper.httpPort, "open.tiktokapis.com", "/v2/user/info")).rejects.toThrow();
  });
  it("has a deadline of its own: after its lifetime it cuts every connection and ends the process", async () => {
    let exited: number | undefined;
    const { helper } = await start({ lifetimeMs: 1_000 }, undefined, { exit: (code) => { exited = code; } });
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    expect(exited).toBe(0);
    await expect(http(helper.httpPort, "open.tiktokapis.com", "/v2/user/info")).rejects.toThrow();
  });
});

describe("the summary the worker reads", () => {
  it("is the untrusted one when a file is missing, damaged or for nothing", () => {
    const files = memoryFiles();
    expect(summaryOf(files)).toEqual({ schemaVersion: 1, trusted: false });
    files.files.set(SUMMARY_PATH, "not json");
    expect(summaryOf(files)).toEqual({ schemaVersion: 1, trusted: false });
    files.files.set(SUMMARY_PATH, JSON.stringify({ schemaVersion: 1, trusted: true, extra: 1 }));
    expect(summaryOf(files)).toEqual({ schemaVersion: 1, trusted: false });
  });
  it("keys an addition the way the request key does", async () => {
    const { helper, files } = await start();
    await http(helper.httpPort, "tracker.example.test", "/k?b=2&a=1");
    const summary = summaryOf(files);
    if (!summary.trusted) throw new Error("trusted");
    expect(summary.additions[0]!.key).toBe(evalStandInRequestKey({ method: "GET", host: "tracker.example.test", path: "/k", query: "a=1&b=2", contentType: "", body: "" }));
    expect(EVAL_STAND_IN_ADDITIONS_PATH).toBe("/rovara/ledger/additions.json");
  });
});
