import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { E2EModelChannelResponseSchema, e2eModelRouteRevision } from "../../packages/contracts/src/e2e-model-channel.js";
import { createInMemoryE2EDayBudget } from "../../packages/model-runtime/src/e2e-route.js";
import { scriptedE2ERouteDefinition } from "../../packages/model-runtime/src/e2e-route-derive.js";
import { REFUSING_DEFAULT_PROVIDER_MESSAGE, installRefusingE2EDefaultProvider } from "../../packages/verifier/src/executor/ai-default-provider.js";
import { E2EModelChannelError, createE2EModelChannelClient } from "../../packages/verifier/src/executor/model-channel.js";
import { createE2EModelEvidenceCollector, openE2EModelChannelSession, type E2EModelChannelSession } from "../../packages/worker/src/e2e-model-channel-session.js";
import { cleanRedirectingEnvironment } from "../support/e2e-clean-environment.js";
import { CASE_ID, RUN_ID, TOOLS, call, tapAnswer } from "../support/e2e-model-fixtures.js";

// Task 4.3a, test cases 12 (the guard against the AI SDK's default provider) and the executor client of the model channel.

const execFileAsync = promisify(execFile);
let dir: string;
let socketPath: string;
let sockets = 0;
const closers: Array<() => Promise<unknown>> = [];

beforeEach(async () => { cleanRedirectingEnvironment(); dir = await mkdtemp(join(tmpdir(), "rc-")); socketPath = join(dir, "model.sock"); });
afterEach(async () => { vi.restoreAllMocks(); for (const close of closers.splice(0)) await close().catch(() => undefined); await rm(dir, { recursive: true, force: true }); });

const client = (extra: { timeoutMs?: number } = {}) => createE2EModelChannelClient({ socketPath, runId: RUN_ID, ...extra });
const position = { caseId: CASE_ID, stepIndex: 0 };
const request = (callIndex = 0) => ({ ...position, callIndex, call: call() });

/** A server on the socket that counts what it is sent and answers as told: the "counted fake socket". */
async function fakeSocket(answer: (req: IncomingMessage, res: ServerResponse, body: string) => void) {
  const seen: Array<{ method: string | undefined; url: string | undefined; body: string }> = [];
  // Each server has a socket of its own, so a closing one can never be mistaken for the next.
  socketPath = join(dir, `fake-${++sockets}.sock`);
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => { const body = Buffer.concat(chunks).toString("utf8"); seen.push({ method: req.method, url: req.url, body }); answer(req, res, body); });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  closers.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return seen;
}
const send = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(typeof body === "string" ? body : JSON.stringify(body)); };
const okAnswer = () => ({ schemaVersion: "rovara-e2e-model-channel/v1", receiptId: "r1", result: { status: "ok", content: [{ type: "tool-call", toolCallId: "c1", toolName: "tap", input: "{\"target\":\"n1\"}" }],
  finishReason: { unified: "tool-calls", raw: "scripted" }, usage: { inputTokens: 10, outputTokens: 5 } } });
const errorAnswer = (code: string) => ({ schemaVersion: "rovara-e2e-model-channel/v1", receiptId: "r2", result: { status: "error", code, message: "refused" } });

describe("the executor's model channel client, against the worker's real session", () => {
  let session: E2EModelChannelSession;
  const scripted = { routeId: "rovara-scripted/v1", routeRevision: e2eModelRouteRevision(scriptedE2ERouteDefinition()) };

  it("begins a step, makes a call and ends the step over the socket, and the worker writes the receipt", async () => {
    const evidence = createE2EModelEvidenceCollector();
    session = await openE2EModelChannelSession({ runId: RUN_ID, modelRoute: scripted, policyScope: "standard", socketPath, allowedSteps: [{ caseId: CASE_ID, stepIndex: 0 }],
      credentialSet: { passwords: [], emails: [], cookieValues: [] }, deadlineAt: Date.now() + 60_000, dayBudget: createInMemoryE2EDayBudget(), evidence,
      signal: new AbortController().signal, environment: { ROVARA_E2E_SCRIPTED_MODEL: "1" }, invoke: async () => tapAnswer() });
    closers.push(() => session.close());
    const channel = client();
    await channel.beginStep(position);
    const answer = await channel.generate({ ...request(), call: { ...call(), tools: TOOLS } });
    expect(answer.result).toMatchObject({ status: "ok", content: [{ type: "tool-call", toolName: "tap" }] });
    await channel.endStep(position);
    const summary = await session.close();
    expect(summary.receipts).toHaveLength(1);
    expect(evidence.receipts()[0]).toMatchObject({ runId: RUN_ID, caseId: CASE_ID, stepIndex: 0, callIndex: 0, outcome: "ok", routeId: "rovara-scripted/v1" });
    expect(E2EModelChannelResponseSchema.safeParse(answer).success).toBe(true);
  });

  it("a step the worker does not hold is refused as a plain non-retryable error, and a call without a begun step gets the worker's refusal as an answer", async () => {
    session = await openE2EModelChannelSession({ runId: RUN_ID, modelRoute: scripted, policyScope: "standard", socketPath, allowedSteps: [{ caseId: CASE_ID, stepIndex: 0 }],
      credentialSet: { passwords: [], emails: [], cookieValues: [] }, deadlineAt: Date.now() + 60_000, dayBudget: createInMemoryE2EDayBudget(), evidence: createE2EModelEvidenceCollector(),
      signal: new AbortController().signal, environment: { ROVARA_E2E_SCRIPTED_MODEL: "1" }, invoke: async () => tapAnswer() });
    closers.push(() => session.close());
    const channel = client();
    const refused = await channel.beginStep({ caseId: CASE_ID, stepIndex: 9 }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(E2EModelChannelError);
    expect(refused).toMatchObject({ code: "refused", isRetryable: false });
    const out = await channel.generate(request());
    expect(out.result).toMatchObject({ status: "error", code: "refused-protocol" });
  });
});

describe("the client against a counted fake socket", () => {
  it("sends exactly one HTTP request per generate, even when the answer is an error or garbage: it never re-sends on its own", async () => {
    for (const [index, reply] of [(res: ServerResponse) => send(res, 500, "internal error"), (res: ServerResponse) => send(res, 200, "not json"), (res: ServerResponse) => send(res, 200, { nope: true }),
      (res: ServerResponse) => res.destroy()].entries()) {
      const seen = await fakeSocket((_req, res) => reply(res));
      const failure = await client().generate(request()).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(E2EModelChannelError);
      expect((failure as E2EModelChannelError).isRetryable).toBe(false);
      expect(seen, `reply ${index}`).toHaveLength(1);
      expect(seen[0]).toMatchObject({ method: "POST", url: "/v1/generate" });
      await closers.pop()!();
    }
  });

  it("returns the worker's error answers as the result (a budget refusal is an answer, not a failure of the channel), whatever HTTP status carries it", async () => {
    const seen = await fakeSocket((_req, res) => send(res, 429, errorAnswer("budget")));
    const answer = await client().generate(request());
    expect(answer.result).toMatchObject({ status: "error", code: "budget" });
    expect(seen).toHaveLength(1);
  });

  it("puts nothing the worker said, and nothing from the socket's errors, in an error message", async () => {
    await fakeSocket((_req, res) => send(res, 500, "SECRETTOKEN prompt text /run/rovara/plan.json"));
    const failure = await client().generate(request()).catch((error: Error) => error);
    expect((failure as Error).message).not.toMatch(/SECRETTOKEN|prompt text|plan\.json/);
    const missing = await createE2EModelChannelClient({ socketPath: join(dir, "nobody-listens.sock"), runId: RUN_ID }).generate(request()).catch((error: Error) => error);
    expect(missing).toMatchObject({ name: "E2EModelChannelError", code: "unavailable", isRetryable: false });
    expect((missing as Error).message).not.toMatch(/ENOENT|nobody-listens|connect/);
  });

  it("refuses a request that is not a valid channel request before sending it: a file part, an unknown tool, a prompt over the bound", async () => {
    const seen = await fakeSocket((_req, res) => send(res, 200, okAnswer()));
    const file = { prompt: [{ role: "user", content: [{ type: "file", mediaType: "image/png", data: "AAAA" }] }] };
    const unknownTool = { ...call(), tools: [{ type: "function", name: "delete_everything", inputSchema: { type: "object" } }] };
    const oversized = { prompt: [{ role: "user", content: [{ type: "text", text: "x".repeat(300_000) }] }] };
    for (const bad of [file, unknownTool, oversized]) {
      const failure = await client().generate({ ...request(), call: bad as never }).catch((error: unknown) => error);
      expect(failure).toMatchObject({ name: "E2EModelChannelError", code: "invalid-request", isRetryable: false });
    }
    expect(seen).toHaveLength(0);
    // Positive control: a valid request on the same socket goes through.
    expect((await client().generate(request())).result.status).toBe("ok");
    expect(seen).toHaveLength(1);
  });

  it("sends the begin marker with the run id and the cookie values, and the end marker without", async () => {
    const seen = await fakeSocket((_req, res) => send(res, 200, { schemaVersion: "rovara-e2e-model-channel/v1", status: "ok" }));
    await client().beginStep({ ...position, cookieValues: ["session=abcdef123456"] });
    await client().beginStep(position);
    await client().endStep(position);
    expect(seen.map((item) => [item.method, item.url])).toEqual([["POST", "/v1/step"], ["POST", "/v1/step"], ["POST", "/v1/step"]]);
    expect(seen.map((item) => JSON.parse(item.body) as unknown)).toEqual([
      { schemaVersion: "rovara-e2e-model-channel/v1", runId: RUN_ID, marker: "begin", caseId: CASE_ID, stepIndex: 0, cookieValues: ["session=abcdef123456"] },
      { schemaVersion: "rovara-e2e-model-channel/v1", runId: RUN_ID, marker: "begin", caseId: CASE_ID, stepIndex: 0 },
      { schemaVersion: "rovara-e2e-model-channel/v1", runId: RUN_ID, marker: "end", caseId: CASE_ID, stepIndex: 0 },
    ]);
  });

  it("is bounded: an unanswered request times out, an abort stops it, and an answer over the bound is refused", async () => {
    await fakeSocket(() => undefined);
    const timedOut = await client({ timeoutMs: 40 }).generate(request()).catch((error: unknown) => error);
    expect(timedOut).toMatchObject({ code: "timeout", isRetryable: false });
    const abort = new AbortController();
    const pending = client().generate(request(), abort.signal).catch((error: unknown) => error);
    abort.abort();
    expect(await pending).toMatchObject({ code: "aborted", isRetryable: false });
    expect(await client().generate(request(), AbortSignal.abort()).catch((error: unknown) => error)).toMatchObject({ code: "aborted" });
    await closers.pop()!();
    // An answer that keeps coming is cut off at the bound: the client stops reading and hangs up long before a 20 MB answer is sent.
    let chunks = 0;
    await fakeSocket((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const push = () => { if (res.destroyed || res.writableEnded || chunks >= 320) return; chunks += 1; res.write("x".repeat(65_536), () => setImmediate(push)); };
      push();
    });
    expect(await client().generate(request()).catch((error: unknown) => error)).toMatchObject({ code: "invalid-response" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(chunks).toBeLessThan(100);
  });
});

describe("the refusing default provider (case 12, second half)", () => {
  it("makes every read of AI_SDK_DEFAULT_PROVIDER throw, and cannot be put back", () => {
    const target = {} as typeof globalThis;
    installRefusingE2EDefaultProvider(target);
    expect(() => (target as unknown as Record<string, unknown>)["AI_SDK_DEFAULT_PROVIDER"]).toThrow(REFUSING_DEFAULT_PROVIDER_MESSAGE);
    expect(() => { (target as unknown as Record<string, unknown>)["AI_SDK_DEFAULT_PROVIDER"] = { languageModel: () => ({}) }; }).toThrow(REFUSING_DEFAULT_PROVIDER_MESSAGE);
    expect(() => Object.defineProperty(target, "AI_SDK_DEFAULT_PROVIDER", { value: {} })).toThrow();
    // Idempotent.
    expect(() => installRefusingE2EDefaultProvider(target)).not.toThrow();
    expect(Object.keys(target)).toEqual([]);
  });

  it("in a real process, after the executor entry's install, the global throws and the AI SDK's resolver of a string model id fails without a gateway", async () => {
    const script = `
      import { installRefusingE2EDefaultProvider } from ${JSON.stringify(new URL("../../packages/verifier/dist/executor/ai-default-provider.js", import.meta.url).href)};
      installRefusingE2EDefaultProvider();
      let thrown = false;
      try { void globalThis.AI_SDK_DEFAULT_PROVIDER; } catch { thrown = true; }
      const { generateText } = await import("ai");
      let failure = "none";
      try { await generateText({ model: "anthropic/claude-haiku-5.5", prompt: "hi" }); } catch (error) { failure = error instanceof Error ? error.message : String(error); }
      process.stdout.write(JSON.stringify({ thrown, failure }));
    `;
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], { cwd: new URL("../../", import.meta.url).pathname, timeout: 30_000 });
    const result = JSON.parse(stdout) as { thrown: boolean; failure: string };
    expect(result.thrown).toBe(true);
    expect(result.failure).toContain(REFUSING_DEFAULT_PROVIDER_MESSAGE);
  });

  it("the executor's entry installs it first: before any other import and before the plan is read", () => {
    const entry = readFileSync(new URL("../../packages/verifier/src/executor/entry.ts", import.meta.url), "utf8");
    const code = entry.split("\n").filter((line) => !line.trim().startsWith("//") && line.trim() !== "");
    expect(code[0]).toBe('import { installRefusingE2EDefaultProvider } from "./ai-default-provider.js";');
    expect(code[1]).toBe("installRefusingE2EDefaultProvider();");
    expect(code.filter((line) => line.startsWith("import "))).toHaveLength(1);
  });
});
