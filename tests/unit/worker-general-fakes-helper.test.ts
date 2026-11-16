// General fakes slice 2b: the hosted fake-helper's container program (worker general-fakes-helper.ts and the shared server general-fakes-server.ts), run for real on a loopback address with its file seams in memory.
// Every claim has a control: a label that is on every answer, a caller that is the only one served, a set that must be exactly the pinned one.
import { request } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  GENERAL_FAKES_SET_PATH, GENERAL_FAKES_SUMMARY_MAX_COUNT, GENERAL_FAKE_ANSWER_HEADER, GENERAL_FAKE_ANSWER_LABEL, GENERAL_FAKE_CANNOT_ANSWER_BODY, buildGeneralFakesSetBytes, buildOpenApiFake, parseGeneralFakesSummaryText,
  type GeneralFakeServiceFake,
} from "@agentx/contracts";
import {
  GeneralFakesHelperRefused, isGeneralFakesSummarizeRequest, parseGeneralFakesServeArguments, serveGeneralFakes, summarizeGeneralFakes, type RunningGeneralFakesHelper, type SummaryFiles,
} from "../../packages/worker/src/general-fakes-helper.js";

const WORKSPACE = "0b9f6a1e-6c1e-4c53-9d0a-5d3a1d6f2c11";
const OPERATION = "7c1f0d3a-2b8e-4a55-8f3b-9a1c2d3e4f50";
const DOCUMENT = {
  openapi: "3.0.3", info: { title: "pets", version: "1" },
  paths: {
    "/pets/{id}": { get: { responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object", required: ["id"], properties: { id: { type: "integer", minimum: 1, maximum: 9 } } } } } } } } },
    "/gone": { delete: { responses: { "204": { description: "gone" } } } },
    "/odd": { get: { responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "string", enum: ["a"] } } } } } } },
  },
};
const FAKES: GeneralFakeServiceFake[] = [{ status: "built", fake: buildOpenApiFake(DOCUMENT, "openapi.json") }, { status: "not_built", reason: "spec_ambiguous" }];
const SET = buildGeneralFakesSetBytes({ workspaceId: WORKSPACE, operationId: OPERATION, fakes: FAKES })!;
const ARGS = { listen: "127.0.0.1", caller: "127.0.0.1", digest: SET.digest, workspaceId: WORKSPACE, operationId: OPERATION } as const;

function memoryFiles(): SummaryFiles & { files: Map<string, string>; failWrites: boolean } {
  const files = new Map<string, string>();
  const self = { files, failWrites: false, write(path: string, text: string) { if (self.failWrites) throw new Error("full"); files.set(path, text); }, read(path: string) { const text = files.get(path); if (text === undefined) throw new Error("missing"); return text; } };
  return self;
}
const read = (bytes: Uint8Array = SET.bytes) => (path: string): Uint8Array => { if (path !== GENERAL_FAKES_SET_PATH) throw new Error("another file"); return bytes; };
const SUMMARY_PATH = "/rovara/ledger/test-summary.json";

const running: RunningGeneralFakesHelper[] = [];
afterEach(async () => { await Promise.all(running.splice(0).map((helper) => helper.close())); });
async function start(overrides: Partial<Parameters<typeof serveGeneralFakes>[0]> = {}, bytes?: Uint8Array) {
  const files = memoryFiles();
  const helper = await serveGeneralFakes({ ...ARGS, ...overrides }, { readFile: read(bytes), files, port: 0, summaryPath: SUMMARY_PATH });
  running.push(helper);
  return { helper, files };
}

interface Answer { status: number; headers: Record<string, string | string[] | undefined>; body: string }
function call(port: number, method: string, path: string, body?: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, agent: false }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}
const label = (answer: Answer) => answer.headers[GENERAL_FAKE_ANSWER_HEADER];

describe("the program's arguments", () => {
  const good = ["--listen", "172.30.5.16", "--caller", "172.30.5.3", "--digest", "a".repeat(64), "--workspace", WORKSPACE, "--operation", OPERATION];
  it("are parsed strictly", () => {
    expect(parseGeneralFakesServeArguments(good)).toEqual({ listen: "172.30.5.16", caller: "172.30.5.3", digest: "a".repeat(64), workspaceId: WORKSPACE, operationId: OPERATION });
    const refused = (argv: string[]) => expect(() => parseGeneralFakesServeArguments(argv)).toThrow(GeneralFakesHelperRefused);
    refused([...good, "--port", "80"]);
    refused([...good, "--caller", "172.30.5.4"]);
    refused(good.map((token) => (token === "172.30.5.16" ? "0.0.0.0" : token)));
    refused(good.map((token) => (token === "172.30.5.16" ? "127.0.0.1" : token)));
    refused(good.map((token) => (token === "172.30.5.16" ? "pets.example.test" : token)));
    refused(good.map((token) => (token === "172.30.5.3" ? "172.30.5.16" : token)));
    refused(good.map((token) => (token === "172.30.5.3" ? "::1" : token)));
    refused(good.map((token) => (token === "a".repeat(64) ? "abc" : token)));
    refused(good.map((token) => (token === WORKSPACE ? "x" : token)));
    refused(good.slice(0, 8));
    refused(good.map((token) => (token === "--digest" ? "--digets" : token)));
    refused([]);
  });
  it("tell the summary request from a serve request exactly", () => {
    expect(isGeneralFakesSummarizeRequest(["--summarize"])).toBe(true);
    expect(isGeneralFakesSummarizeRequest(["--summarize", "--listen", "1.2.3.4"])).toBe(false);
    expect(isGeneralFakesSummarizeRequest([])).toBe(false);
  });
});

describe("the helper serving a set", () => {
  it("answers from the fake, and EVERY answer carries the madeByRovara label (control: the answers differ)", async () => {
    const { helper } = await start();
    const served = await call(helper.port, "GET", "/s/0/pets/4");
    expect(served.status).toBe(200);
    expect(JSON.parse(served.body)).toEqual({ id: 5 });
    expect(label(served)).toBe(GENERAL_FAKE_ANSWER_LABEL);
    const noContent = await call(helper.port, "DELETE", "/s/0/gone");
    expect(noContent.status).toBe(204);
    expect(label(noContent)).toBe(GENERAL_FAKE_ANSWER_LABEL);
    const unsupported = await call(helper.port, "GET", "/s/0/odd");
    expect(unsupported.status).toBe(501);
    expect(unsupported.body).toBe(GENERAL_FAKE_CANNOT_ANSWER_BODY);
    expect(label(unsupported)).toBe(GENERAL_FAKE_ANSWER_LABEL);
    const unknown = await call(helper.port, "GET", "/s/0/nothing");
    expect([unknown.status, label(unknown)]).toEqual([501, GENERAL_FAKE_ANSWER_LABEL]);
    const notBuilt = await call(helper.port, "GET", "/s/1/anything");
    expect([notBuilt.status, notBuilt.body, label(notBuilt)]).toEqual([501, GENERAL_FAKE_CANNOT_ANSWER_BODY, GENERAL_FAKE_ANSWER_LABEL]);
    for (const path of ["/", "/pets/4", "/s/2/x", "/s/8/x", "/s/0x/pets/4"]) {
      const unrouted = await call(helper.port, "GET", path);
      expect([unrouted.status, unrouted.body, label(unrouted)], path).toEqual([404, GENERAL_FAKE_CANNOT_ANSWER_BODY, GENERAL_FAKE_ANSWER_LABEL]);
    }
  });

  it("counts every call by outcome, and the summary file is written BEFORE the answer is sent", async () => {
    const { helper, files } = await start();
    const seenBeforeAnswer: string[] = [];
    // Written before the answer: by the time the client has the response, the file already holds the call.
    const answer = await call(helper.port, "GET", "/s/0/pets/4");
    seenBeforeAnswer.push(files.files.get(SUMMARY_PATH)!);
    expect(answer.status).toBe(200);
    expect(parseGeneralFakesSummaryText(seenBeforeAnswer[0]!)).toMatchObject({ trusted: true, served: 1 });
    await call(helper.port, "GET", "/s/0/odd");
    await call(helper.port, "GET", "/s/0/nothing");
    await call(helper.port, "GET", "/s/1/x");
    await call(helper.port, "GET", "/elsewhere");
    const summary = parseGeneralFakesSummaryText(files.files.get(SUMMARY_PATH)!);
    expect(summary).toEqual({
      schemaVersion: 1, trusted: true, workspaceId: WORKSPACE, operationId: OPERATION, digest: SET.digest, served: 1,
      cannotAnswer: { no_spec: 0, spec_unreadable: 0, spec_ambiguous: 1, operation_unknown: 1, operation_unsupported: 1 }, foreign: 0, unrouted: 1, refused: 0, saturated: false,
    });
    expect(helper.summary()).toEqual(summary);
  });

  it("writes a first, zero summary before it listens (a helper that cannot write one never serves)", async () => {
    const { files } = await start();
    expect(parseGeneralFakesSummaryText(files.files.get(SUMMARY_PATH)!)).toMatchObject({ trusted: true, served: 0, foreign: 0 });
    const broken = memoryFiles();
    broken.failWrites = true;
    await expect(serveGeneralFakes({ ...ARGS }, { readFile: read(), files: broken, port: 0, summaryPath: SUMMARY_PATH })).rejects.toMatchObject({ reason: "summary" });
  });

  it("serves only the one caller: a connection from another address is closed unread and counted as foreign (control: the real caller is served)", async () => {
    const { helper, files } = await start({ caller: "10.9.9.9" });
    await expect(call(helper.port, "GET", "/s/0/pets/4")).rejects.toThrow();
    expect(parseGeneralFakesSummaryText(files.files.get(SUMMARY_PATH)!)).toMatchObject({ foreign: 1, served: 0 });
    const control = await start();
    expect((await call(control.helper.port, "GET", "/s/0/pets/4")).status).toBe(200);
    expect(parseGeneralFakesSummaryText(control.files.files.get(SUMMARY_PATH)!)).toMatchObject({ foreign: 0, served: 1 });
  });

  it("refuses a request body past the limit with a labelled 413, and counts it", async () => {
    const { helper, files } = await start();
    const answer = await call(helper.port, "POST", "/s/0/pets/4", "x".repeat(70 * 1024)).catch(() => undefined);
    if (answer !== undefined) { expect(answer.status).toBe(413); expect(label(answer)).toBe(GENERAL_FAKE_ANSWER_LABEL); }
    // The summary counted it either way (the client may have been reset first).
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(parseGeneralFakesSummaryText(files.files.get(SUMMARY_PATH)!)).toMatchObject({ refused: 1, served: 0 });
    expect((await call(helper.port, "GET", "/s/0/pets/4")).status).toBe(200);
  });

  it("a request node itself refuses (garbage, a header past the limit) is answered with the label and counted as refused", async () => {
    const { helper, files } = await start();
    const raw = (text: string) => new Promise<string>((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port: helper.port });
      let received = "";
      socket.on("data", (chunk: Buffer) => { received += chunk.toString("utf8"); });
      socket.on("close", () => resolve(received));
      socket.on("error", reject);
      socket.write(text);
    });
    const garbage = await raw("NOT AN HTTP REQUEST\r\n\r\n");
    expect(garbage).toMatch(/^HTTP\/1\.1 400 /u);
    expect(garbage).toContain(`${GENERAL_FAKE_ANSWER_HEADER}: ${GENERAL_FAKE_ANSWER_LABEL}`);
    const big = await raw(`GET /s/0/pets/4 HTTP/1.1\r\nhost: x\r\nx-big: ${"a".repeat(40_000)}\r\n\r\n`);
    expect(big).toMatch(/^HTTP\/1\.1 431 /u);
    expect(big).toContain(`${GENERAL_FAKE_ANSWER_HEADER}: ${GENERAL_FAKE_ANSWER_LABEL}`);
    expect(parseGeneralFakesSummaryText(files.files.get(SUMMARY_PATH)!)).toMatchObject({ refused: 2, served: 0 });
  });

  it("stops answering when its summary cannot be written (an answer it could not count is never sent)", async () => {
    const { helper, files } = await start();
    expect((await call(helper.port, "GET", "/s/0/pets/4")).status).toBe(200);
    files.failWrites = true;
    await expect(call(helper.port, "GET", "/s/0/pets/4")).rejects.toThrow();
    expect(helper.server.listening).toBe(false);
  });

  it("saturates: a counter stops at its limit and the summary says so (control: below the limit it does not)", async () => {
    const files = memoryFiles();
    const helper = await serveGeneralFakes({ ...ARGS }, { readFile: read(), files, port: 0, summaryPath: SUMMARY_PATH, countLimit: 3 });
    running.push(helper);
    for (let index = 0; index < 2; index += 1) await call(helper.port, "GET", "/s/0/pets/1");
    expect(parseGeneralFakesSummaryText(files.files.get(SUMMARY_PATH)!)).toMatchObject({ served: 2, saturated: false });
    for (let index = 0; index < 3; index += 1) await call(helper.port, "GET", "/s/0/pets/1");
    expect(parseGeneralFakesSummaryText(files.files.get(SUMMARY_PATH)!)).toMatchObject({ served: 3, saturated: true });
    expect(GENERAL_FAKES_SUMMARY_MAX_COUNT).toBe(100_000);
  });
});

describe("the helper refuses a set that is not exactly the pinned one (nothing listens, nothing is written)", () => {
  const refused = async (overrides: Partial<Parameters<typeof serveGeneralFakes>[0]>, bytes?: Uint8Array) => {
    const files = memoryFiles();
    await expect(serveGeneralFakes({ ...ARGS, ...overrides }, { readFile: read(bytes), files, port: 0, summaryPath: SUMMARY_PATH })).rejects.toMatchObject({ reason: "set" });
    expect(files.files.size).toBe(0);
  };
  it("another digest", () => refused({ digest: "0".repeat(64) }));
  it("another company", () => refused({ workspaceId: "11111111-1111-4111-8111-111111111111" }));
  it("another task", () => refused({ operationId: "11111111-1111-4111-8111-111111111111" }));
  it("a set of another company, though it hashes to the digest it was pinned with", async () => {
    const other = buildGeneralFakesSetBytes({ workspaceId: "11111111-1111-4111-8111-111111111111", operationId: OPERATION, fakes: FAKES })!;
    await refused({ digest: other.digest }, other.bytes);
  });
  it("bytes that are not a set", () => refused({}, new TextEncoder().encode("{}")));
  it("a file that cannot be read", async () => {
    await expect(serveGeneralFakes({ ...ARGS }, { readFile: () => { throw new Error("EACCES"); }, files: memoryFiles(), port: 0 })).rejects.toMatchObject({ reason: "set" });
  });
  it("the refusal carries no value", async () => {
    const error = await serveGeneralFakes({ ...ARGS, digest: "0".repeat(64) }, { readFile: read(), files: memoryFiles(), port: 0 }).then(() => undefined, (reason: unknown) => reason as Error);
    expect(error?.message).toBe("general fakes helper refused: set");
  });
});

describe("the summary read by `docker exec --summarize`", () => {
  it("prints what the file holds, and the untrusted summary for a file that is missing or is not a summary (never 'no calls')", async () => {
    const { files } = await start();
    const held = summarizeGeneralFakes(files, SUMMARY_PATH);
    expect(held).toMatchObject({ trusted: true, served: 0 });
    expect(summarizeGeneralFakes(memoryFiles(), SUMMARY_PATH)).toEqual({ schemaVersion: 1, trusted: false });
    const broken = memoryFiles();
    broken.files.set(SUMMARY_PATH, "garbage");
    expect(summarizeGeneralFakes(broken, SUMMARY_PATH)).toEqual({ schemaVersion: 1, trusted: false });
    broken.files.set(SUMMARY_PATH, `${JSON.stringify({ ...held, served: -1 })}\n`);
    expect(summarizeGeneralFakes(broken, SUMMARY_PATH)).toEqual({ schemaVersion: 1, trusted: false });
  });
});
