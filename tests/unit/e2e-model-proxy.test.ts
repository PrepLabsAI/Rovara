import { request } from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  E2EModelChannelResponseSchema,
  E2EModelReceiptSchema,
  checkE2EGroupModelBudget,
  checkE2EStepModelAccounting,
  e2eModelRouteRevision,
  type E2EModelReceipt,
} from "../../packages/contracts/src/e2e-model-channel.js";
import { createGovernedE2EModelRoute, createInMemoryE2EDayBudget, type E2EInvoke } from "../../packages/model-runtime/src/e2e-route.js";
import { startE2EModelProxy, type E2EModelEvidenceSink, type E2EModelProxy, type E2EModelTranscript } from "../../packages/worker/src/e2e-model-proxy.js";
import { CASE_ID, MODEL_ID, RUN_ID, bedrockRoute, call, channelRequest, installationEnvironment, keyedRoute, loweredBudgets, tapAnswer } from "../support/e2e-model-fixtures.js";
import { cleanRedirectingEnvironment } from "../support/e2e-clean-environment.js";

interface Reply { schemaVersion: string; receiptId: string; result: { status: string; code?: string; message?: string } }

const PASSWORD = "Sup3r-Secret-Pa$$w0rd!";
const EMAIL = "qa.tester.orders@example.test";
const LOCAL_PART = "qa.tester.orders";
const COOKIE = "sessionid=9f8e7d6c5b4a39281706f5e4d3c2b1a0";
const COOKIE_VALUE = "9f8e7d6c5b4a39281706f5e4d3c2b1a0";
const AWS_KEY = "AKIAABCDEFGHIJKLMNOP";
const SECRETS = [PASSWORD, EMAIL, LOCAL_PART, COOKIE_VALUE, AWS_KEY];
const CREDENTIALS = { passwords: [PASSWORD], emails: [EMAIL], cookieValues: [COOKIE_VALUE] };

class Sink implements E2EModelEvidenceSink {
  receipts: E2EModelReceipt[] = [];
  transcripts: E2EModelTranscript[] = [];
  writeReceipt(receipt: E2EModelReceipt) { this.receipts.push(receipt); }
  writeTranscript(transcript: E2EModelTranscript) { this.transcripts.push(transcript); }
}

let dir: string;
let socketPath: string;
let proxies: E2EModelProxy[] = [];

beforeEach(async () => {
  cleanRedirectingEnvironment();
  dir = await mkdtemp(join(tmpdir(), "rm-"));
  socketPath = join(dir, "m.sock");
  proxies = [];
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const proxy of proxies) await proxy.close().catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

function post(body: unknown, options: { method?: string; path?: string; raw?: boolean; path2?: string } = {}): Promise<{ status: number; text: string; body: Reply }> {
  const payload = options.raw ? String(body) : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: options.path ?? "/v1/generate", method: options.method ?? "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed = null as unknown as Reply;
        try { parsed = JSON.parse(text) as Reply; } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, text, body: parsed });
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}

async function start(invoke: E2EInvoke, extra: Record<string, unknown> = {}, definition = bedrockRoute()) {
  let clock = Date.parse("2026-10-21T10:00:00.000Z");
  const now = () => (clock += 3);
  const route = createGovernedE2EModelRoute(definition, { invoke, now, dayBudget: createInMemoryE2EDayBudget() });
  const evidence = new Sink();
  const rest = Object.fromEntries(Object.entries(extra).filter(([key]) => key !== "begin"));
  const proxy = await startE2EModelProxy({
    socketPath, runId: RUN_ID, route, credentialSet: CREDENTIALS, evidence, deadlineAt: Date.parse("2026-10-21T11:00:00.000Z"), now, environment: {},
    ...rest,
  });
  proxies.push(proxy);
  if (extra["begin"] !== false) proxy.beginStep({ caseId: CASE_ID, stepIndex: 0 });
  return { proxy, evidence, route, tick: (ms: number) => { clock += ms; } };
}

const okInvoke = (calls: unknown[] = []): E2EInvoke => async (input) => { calls.push(input.call); return tapAnswer(); };

describe("e2e model proxy: socket", () => {
  it("listens on a socket with mode 0600 and unlinks it on close", async () => {
    const { proxy } = await start(okInvoke());
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
    expect((await stat(socketPath)).isSocket()).toBe(true);
    await proxy.close();
    await expect(stat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("unlinks the socket on close even when the run is aborted with a call in flight", async () => {
    const abort = new AbortController();
    let entered!: () => void;
    const inFlight = new Promise<void>((resolve) => { entered = resolve; });
    const { proxy } = await start(() => { entered(); return new Promise(() => undefined); }, { signal: abort.signal });
    const pending = post(channelRequest()).catch((error: unknown) => ({ failed: String(error) }));
    await inFlight;
    abort.abort();
    const summary = await proxy.close();
    await pending;
    await expect(stat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(summary.receipts).toHaveLength(1);
    expect(summary.receipts[0]).toMatchObject({ outcome: "provider-error" });
    expect((await proxy.close()).receipts).toHaveLength(1);
  });

  it("accepts only POST /v1/generate", async () => {
    const invoke = vi.fn(okInvoke());
    const { proxy } = await start(invoke);
    expect((await post({}, { method: "GET" })).status).toBe(405);
    expect((await post({}, { path: "/v1/other" })).status).toBe(404);
    expect((await post({}, { path: "/v1/generate?x=1" })).status).toBe(404);
    expect(invoke).not.toHaveBeenCalled();
    expect((await proxy.close()).receipts).toHaveLength(0);
  });

  it("refuses a socket that exists as a regular file", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(socketPath, "not a socket");
    const route = createGovernedE2EModelRoute(bedrockRoute(), { invoke: okInvoke(), now: Date.now, dayBudget: createInMemoryE2EDayBudget() });
    await expect(startE2EModelProxy({ socketPath, runId: RUN_ID, route, credentialSet: CREDENTIALS, evidence: new Sink(), deadlineAt: Date.now() + 60_000, environment: {} })).rejects.toThrow(/not a socket/);
  });
});

describe("e2e model proxy: a call", () => {
  it("serves a valid call and writes the worker's receipt", async () => {
    const { proxy, evidence, route } = await start(okInvoke());
    const reply = await post(channelRequest());
    expect(reply.status).toBe(200);
    const parsed = E2EModelChannelResponseSchema.parse(reply.body);
    expect(parsed.result.status).toBe("ok");
    const summary = await proxy.close();
    expect(summary.receipts).toHaveLength(1);
    const receipt = E2EModelReceiptSchema.parse(summary.receipts[0]);
    expect(receipt).toMatchObject({ receiptId: parsed.receiptId, runId: RUN_ID, caseId: CASE_ID, stepIndex: 0, callIndex: 0, outcome: "ok", routeRevision: e2eModelRouteRevision(route.definition) });
    expect(evidence.receipts).toEqual(summary.receipts);
    expect(evidence.transcripts).toHaveLength(1);
    expect(evidence.transcripts[0]).toMatchObject({ receiptId: parsed.receiptId, caseId: CASE_ID, stepIndex: 0 });
  });

  it("assigns callIndex itself and refuses a request whose index, case, step or run differs", async () => {
    const invoke = vi.fn(okInvoke());
    const { proxy } = await start(invoke);
    expect((await post(channelRequest({ callIndex: 5 }))).body.result).toMatchObject({ status: "error", code: "refused-protocol" });
    expect((await post(channelRequest({ callIndex: 1, caseId: "another-case" }))).body.result).toMatchObject({ code: "refused-protocol" });
    expect((await post(channelRequest({ callIndex: 2, stepIndex: 3 }))).body.result).toMatchObject({ code: "refused-protocol" });
    expect((await post(channelRequest({ callIndex: 3, runId: "11111111-2222-4333-8444-555555555555" }))).body.result).toMatchObject({ code: "refused-protocol" });
    expect(invoke).not.toHaveBeenCalled();
    const { receipts } = await proxy.close();
    expect(receipts.map((item) => [item.callIndex, item.outcome, item.runId, item.caseId, item.stepIndex])).toEqual([
      [0, "refused-protocol", RUN_ID, CASE_ID, 0], [1, "refused-protocol", RUN_ID, CASE_ID, 0],
      [2, "refused-protocol", RUN_ID, CASE_ID, 0], [3, "refused-protocol", RUN_ID, CASE_ID, 0],
    ]);
  });

  it("gives a receipt to a malformed body, an unknown key and an oversized body", async () => {
    const invoke = vi.fn(okInvoke());
    const { proxy } = await start(invoke);
        expect((await post("{not json", { raw: true })).body.result).toMatchObject({ code: "refused-protocol" });
    expect((await post({ ...channelRequest({ callIndex: 1 }), extra: 1 })).body.result).toMatchObject({ code: "refused-protocol" });
    const huge = await post(channelRequest({ callIndex: 2, callOverride: call("x".repeat(300_000)) }));
    expect(huge.status).toBe(413);
    expect(huge.body.result).toMatchObject({ code: "refused-protocol" });
    expect(invoke).not.toHaveBeenCalled();
    expect((await proxy.close()).receipts.map((item) => item.callIndex)).toEqual([0, 1, 2]);
  });

  it("serves one call at a time: a second concurrent request is refused-busy", async () => {
    let release!: () => void;
    let entered!: () => void;
    const first = new Promise<void>((resolve) => { entered = resolve; });
    const invoke: E2EInvoke = async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); return tapAnswer(); };
    const { proxy } = await start(invoke);
    const one = post(channelRequest());
    await first;
    const two = await post(channelRequest({ callIndex: 1 }));
    expect(two.body.result).toMatchObject({ status: "error", code: "refused-busy" });
    release();
    expect((await one).body.result.status).toBe("ok");
    const { receipts } = await proxy.close();
    expect(receipts.map((item) => item.outcome)).toEqual(["ok", "refused-busy"]);
    expect(receipts.map((item) => item.callIndex)).toEqual([0, 1]);
    expect(new Date(receipts[1]!.startedAt).getTime()).toBeGreaterThanOrEqual(new Date(receipts[0]!.startedAt).getTime());
  });

  it("refuses a call outside a step, and records it against the last step", async () => {
    const invoke = vi.fn(okInvoke());
    const { proxy } = await start(invoke);
    proxy.endStep();
    const reply = await post(channelRequest());
    expect(reply.body.result).toMatchObject({ code: "refused-protocol" });
    expect(invoke).not.toHaveBeenCalled();
    const { receipts } = await proxy.close();
    expect(receipts[0]).toMatchObject({ caseId: CASE_ID, stepIndex: 0, outcome: "refused-protocol" });
  });
});

describe("e2e model proxy: budgets", () => {
  it("refuses the 13th call of a step, and every call of a fourth agent step, with budget", async () => {
    const invoke = vi.fn(okInvoke());
    const { proxy } = await start(invoke);
    for (let step = 0; step < 3; step += 1) {
      proxy.beginStep({ caseId: CASE_ID, stepIndex: step });
      for (let index = 0; index < 12; index += 1) {
        const reply = await post(channelRequest({ stepIndex: step, callIndex: index }));
        expect(reply.body.result.status, `step ${step} call ${index}`).toBe("ok");
      }
      const refused = await post(channelRequest({ stepIndex: step, callIndex: 12 }));
      expect(refused.body.result).toMatchObject({ status: "error", code: "budget" });
    }
    proxy.beginStep({ caseId: CASE_ID, stepIndex: 3 });
    const fourth = await post(channelRequest({ stepIndex: 3, callIndex: 0 }));
    expect(fourth.body.result).toMatchObject({ status: "error", code: "budget" });
    expect(invoke).toHaveBeenCalledTimes(36);
    const { receipts } = await proxy.close();
    expect(receipts).toHaveLength(40);
    expect(receipts.filter((item) => item.outcome === "budget")).toHaveLength(4);
    expect(checkE2EGroupModelBudget({ receipts, budgets: bedrockRoute().budgets })).toMatchObject({ ok: false, code: "budget-refused" });
  });

  it("refuses the call that would pass the group's call cap with budget (the 41st at the owner's cap, the 6th at a lowered one)", async () => {
    const invoke = vi.fn(okInvoke());
    const { proxy } = await start(invoke, { budgets: loweredBudgets({ maxModelCallsPerGroup: 5 }) });
    for (let index = 0; index < 5; index += 1) expect((await post(channelRequest({ callIndex: index }))).body.result.status).toBe("ok");
    const sixth = await post(channelRequest({ callIndex: 5 }));
    expect(sixth.body.result).toMatchObject({ status: "error", code: "budget" });
    expect(invoke).toHaveBeenCalledTimes(5);
    expect((await proxy.close()).receipts[5]).toMatchObject({ outcome: "budget", inputTokens: 0, responseSha256: null });
  });

  it("refuses a call that could pass the group's input token cap", async () => {
    const heavy: E2EInvoke = async () => tapAnswer({ usage: { inputTokens: 1_200, outputTokens: 20 } });
    const budgets = loweredBudgets({ maxInputTokensPerGroup: 3_000 });
    const { proxy } = await start(heavy, { budgets });
    expect((await post(channelRequest())).body.result.status).toBe("ok");
    expect((await post(channelRequest({ callIndex: 1 }))).body.result).toMatchObject({ status: "error", code: "budget" });
    const { receipts } = await proxy.close();
    expect(checkE2EGroupModelBudget({ receipts, budgets })).toMatchObject({ ok: false, code: "budget-refused" });
    expect(receipts.filter((item) => item.outcome !== "budget").reduce((total, item) => total + item.inputTokens, 0)).toBeLessThanOrEqual(3_000);
  });

  it("uses the route's own lowered per-step budget", async () => {
    const { proxy } = await start(okInvoke(), {}, bedrockRoute({ budgets: loweredBudgets({ maxActionsPerStep: 2, extraModelCallsPerStep: 1 }) }));
    for (let index = 0; index < 3; index += 1) expect((await post(channelRequest({ callIndex: index }))).body.result.status).toBe("ok");
    expect((await post(channelRequest({ callIndex: 3 }))).body.result).toMatchObject({ code: "budget" });
    await proxy.close();
  });

  it("does not let a supplied budget raise the route's", async () => {
    const { proxy } = await start(okInvoke(), { budgets: loweredBudgets({ maxModelCallsPerGroup: 40 }) }, bedrockRoute({ budgets: loweredBudgets({ maxModelCallsPerGroup: 2 }) }));
    await post(channelRequest({ callIndex: 0 }));
    await post(channelRequest({ callIndex: 1 }));
    expect((await post(channelRequest({ callIndex: 2 }))).body.result).toMatchObject({ code: "budget" });
    await proxy.close();
  });

  it("answers timeout without calling the provider once the step's 90 s deadline has passed", async () => {
    const invoke = vi.fn(okInvoke());
    const { proxy, tick } = await start(invoke);
    expect((await post(channelRequest({ callIndex: 0 }))).body.result.status).toBe("ok");
    tick(91_000);
    const late = await post(channelRequest({ callIndex: 1 }));
    expect(late.body.result).toMatchObject({ status: "error", code: "timeout" });
    expect(invoke).toHaveBeenCalledTimes(1);
    await proxy.close();
  });

  it("agrees with the broker's own accounting of the receipts it wrote", async () => {
    let count = 0;
    const invoke: E2EInvoke = async () => { count += 1; if (count === 2) throw Object.assign(new Error("slow down"), { $metadata: { httpStatusCode: 429 } }); return tapAnswer(); };
    const { proxy, route } = await start(invoke);
    for (let index = 0; index < 3; index += 1) await post(channelRequest({ callIndex: index }));
    const { receipts } = await proxy.close();
    expect(receipts.map((item) => item.outcome)).toEqual(["ok", "provider-error", "ok"]);
    expect(checkE2EStepModelAccounting({
      roundScope: "standard", reportModelCalls: 2, receipts, maxModelCallsPerStep: 12,
      identity: { runId: RUN_ID, caseId: CASE_ID, stepIndex: 0, routeId: route.definition.routeId, routeRevision: route.routeRevision, provider: "amazon-bedrock", modelId: MODEL_ID },
    })).toEqual({ ok: true, okCalls: 2, totalCalls: 3 });
  });
});

describe("e2e model proxy: no credentials to the model", () => {
  const refusedWith = async (observation: string, options: Parameters<typeof call>[1] = {}) => {
    const seen: unknown[] = [];
    const { proxy, evidence } = await start(okInvoke(seen));
    const reply = await post(channelRequest({ callOverride: call(observation, options) }));
    return { reply, seen, proxy, evidence };
  };

  it("refuses a prompt that carries the seeded password, before invoke", async () => {
    const { reply, seen, proxy } = await refusedWith(`#n1 textbox "Password" value="${PASSWORD}"`);
    expect(reply.body.result).toMatchObject({ status: "error", code: "refused-credential-match" });
    expect(reply.body.result.message).toMatch(/model-prompt-credential-match/);
    expect(seen).toHaveLength(0);
    expect((await proxy.close()).receipts[0]).toMatchObject({ outcome: "refused-credential-match", inputTokens: 0, outputTokens: 0, responseSha256: null });
  });

  it("refuses a prompt that carries a planted AKIA key, a private key header, an sk- key or a Slack token", async () => {
    for (const planted of [`key ${AWS_KEY}`, "-----BEGIN RSA PRIVATE KEY-----", "token sk-proj-abcdefghijklmnopqrstuvwx", "xoxb-1234567890-abcdef"]) {
      const { reply, seen, proxy } = await refusedWith(planted);
      expect(reply.body.result, planted).toMatchObject({ code: "refused-credential-match" });
      expect(seen).toHaveLength(0);
      await proxy.close();
      proxies = [];
      socketPath = join(dir, `m${Math.random().toString(36).slice(2, 6)}.sock`);
    }
  });

  it("does not refuse ordinary text that merely contains 'sk-'", async () => {
    const { reply, seen } = await refusedWith('#n1 link "task-list" and "disk-usage" and "risk-free"');
    expect(reply.body.result.status).toBe("ok");
    expect(seen).toHaveLength(1);
  });

  it("refuses a seeded cookie value and an encoded copy of the password", async () => {
    expect((await refusedWith(`Set-Cookie ${COOKIE}`)).reply.body.result).toMatchObject({ code: "refused-credential-match" });
    proxies = []; socketPath = join(dir, "n2.sock");
    expect((await refusedWith(`q=${encodeURIComponent(PASSWORD)}`)).reply.body.result).toMatchObject({ code: "refused-credential-match" });
  });

  it("refuses the email local part, and the address, when the agent typed it", async () => {
    const { reply, seen } = await refusedWith('#n2 textbox "File name"', { typed: LOCAL_PART });
    expect(reply.body.result).toMatchObject({ status: "error", code: "refused-credential-match" });
    expect(seen).toHaveLength(0);
    proxies = []; socketPath = join(dir, "n3.sock");
    expect((await refusedWith('#n2 textbox "File name"', { typed: EMAIL })).reply.body.result).toMatchObject({ code: "refused-credential-match" });
  });

  it("redacts the account email from page text the agent did not type instead of refusing the call", async () => {
    const seen: unknown[] = [];
    const { proxy, evidence } = await start(okInvoke(seen));
    const header = `#n9 text "Signed in as ${EMAIL}"\n#n10 link "${LOCAL_PART}'s orders"\n#n1 button "Export orders"`;
    const reply = await post(channelRequest({ callOverride: call(header, { typed: "orders.csv", toolResult: `Typed. Header now reads ${EMAIL}` }) }));
    expect(reply.body.result.status).toBe("ok");
    expect(seen).toHaveLength(1);
    const sent = JSON.stringify(seen[0]);
    expect(sent).not.toContain(EMAIL);
    expect(sent).not.toContain(LOCAL_PART);
    expect(sent).toContain("Export orders");
    const { receipts } = await proxy.close();
    expect(receipts[0]!.outcome).toBe("ok");
    expect(JSON.stringify(evidence.transcripts)).not.toContain(LOCAL_PART);
  });

  it("stores no seeded credential in any transcript, receipt, summary or reply, refused calls included", async () => {
    const seen: unknown[] = [];
    const { proxy, evidence } = await start(okInvoke(seen));
    // One refused call per step: a credential hit latches its step, so each shape needs a step of its own.
    const replies = [await post(channelRequest({ callIndex: 0, callOverride: call(`#n1 textbox "Password" value="${PASSWORD}"`) }))];
    proxy.beginStep({ caseId: CASE_ID, stepIndex: 1 });
    replies.push(await post(channelRequest({ stepIndex: 1, callIndex: 0, callOverride: call(`Signed in as ${EMAIL}; cookie ${COOKIE}; key ${AWS_KEY}`) })));
    proxy.beginStep({ caseId: CASE_ID, stepIndex: 2 });
    replies.push(await post(channelRequest({ stepIndex: 2, callIndex: 0, callOverride: call('#n2 textbox "File name"', { typed: LOCAL_PART }) })));
    const summary = await proxy.close();
    expect(summary.receipts.map((item) => item.outcome)).toEqual(["refused-credential-match", "refused-credential-match", "refused-credential-match"]);
    const stored = JSON.stringify({ transcripts: evidence.transcripts, receipts: evidence.receipts, summary, replies: replies.map((item) => item.text), invoked: seen });
    const bytes = Buffer.from(stored, "utf8");
    for (const secret of SECRETS) {
      expect(bytes.includes(Buffer.from(secret, "utf8")), `${secret} leaked`).toBe(false);
      expect(bytes.includes(Buffer.from(JSON.stringify(secret).slice(1, -1), "utf8")), `${secret} leaked escaped`).toBe(false);
    }
    expect(evidence.transcripts).toHaveLength(3);
    expect(evidence.transcripts.every((item) => item.prompt !== null)).toBe(true);
  });

  it("omits transcript bodies over the group's 1 MiB evidence budget, and the receipts still verify", async () => {
    const { proxy, evidence } = await start(okInvoke(), { transcriptBudgetBytes: 4_000 });
    await post(channelRequest({ callIndex: 0, callOverride: call("z".repeat(1_500)) }));
    await post(channelRequest({ callIndex: 1, callOverride: call("z".repeat(1_500)) }));
    const { receipts } = await proxy.close();
    expect(receipts.map((item) => item.outcome)).toEqual(["ok", "ok"]);
    expect(evidence.transcripts[1]).toMatchObject({ prompt: null, response: null, omitted: "budget" });
    expect(evidence.transcripts[0]!.prompt).not.toBeNull();
  });

  it("rejects a credential set it cannot scan safely", async () => {
    const route = createGovernedE2EModelRoute(bedrockRoute(), { invoke: okInvoke(), now: Date.now, dayBudget: createInMemoryE2EDayBudget() });
    await expect(startE2EModelProxy({ socketPath, runId: RUN_ID, route, credentialSet: { passwords: ["abc"], emails: [], cookieValues: [] }, evidence: new Sink(), deadlineAt: Date.now() + 60_000 })).rejects.toThrow(/too short/);
  });
});

describe("e2e model proxy: fix round 1", () => {
  it("F1: refuses a 200 KB prompt before invoke, and receipts never pass the group's token cap", async () => {
    const invoke = vi.fn(okInvoke());
    const { proxy } = await start(invoke);
    const big = await post(channelRequest({ callOverride: call("y".repeat(200_000)) }));
    expect(big.body.result).toMatchObject({ status: "error", code: "refused-protocol" });
    expect(invoke).not.toHaveBeenCalled();
    const { receipts } = await proxy.close();
    expect(receipts[0]).toMatchObject({ outcome: "refused-protocol", inputTokens: 0 });
    expect(checkE2EGroupModelBudget({ receipts, budgets: bedrockRoute().budgets })).toMatchObject({ ok: true });
  });

  it("F1: a provider count over the bound is charged to the group in full and shown in the summary", async () => {
    const { proxy } = await start(async () => tapAnswer({ usage: { inputTokens: 70_000, outputTokens: 5 } }));
    expect((await post(channelRequest())).body.result).toMatchObject({ code: "invalid-output" });
    const summary = await proxy.close();
    expect(summary.chargedInputTokens).toBe(70_000);
    expect(summary.overrun).toBe(true);
    expect(summary.receipts[0]!.inputTokens).toBe(64_000);
  });

  it("F3: applies the group's lowered per-call limits", async () => {
    const seen: Array<{ max: number }> = [];
    const budgets = loweredBudgets({ maxPromptBytes: 4_096, maxOutputTokens: 100 });
    const { proxy } = await start(async (input) => { seen.push({ max: input.maxOutputTokens }); return tapAnswer(); }, { budgets });
    expect((await post(channelRequest({ callOverride: call("x".repeat(6_000)) }))).body.result).toMatchObject({ code: "refused-protocol" });
    expect((await post(channelRequest({ callIndex: 1 }))).body.result.status).toBe("ok");
    expect(seen).toEqual([{ max: 100 }]);
    await proxy.close();
  });

  it("F4: scans a cookie reported after the start, and latches refusal on a value it cannot scan instead of throwing", async () => {
    const seen: unknown[] = [];
    const { proxy } = await start(okInvoke(seen));
    const late = "late-session-9a8b7c6d5e4f";
    expect((await post(channelRequest({ callIndex: 0, callOverride: call(`cookie ${late}`) }))).body.result.status).toBe("ok");
    proxy.addCredentialValues({ cookieValues: [`sid=${late}`] });
    expect((await post(channelRequest({ callIndex: 1, callOverride: call(`cookie ${late}`) }))).body.result).toMatchObject({ code: "refused-credential-match" });
    proxy.beginStep({ caseId: CASE_ID, stepIndex: 1 });
    expect((await post(channelRequest({ stepIndex: 1, callIndex: 0 }))).body.result.status).toBe("ok");
    expect(() => proxy.addCredentialValues({ cookieValues: ["abc"] })).not.toThrow();
    expect((await post(channelRequest({ stepIndex: 1, callIndex: 1 }))).body.result).toMatchObject({ code: "refused-credential-match" });
    expect((await post(channelRequest({ stepIndex: 1, callIndex: 2 }))).body.result).toMatchObject({ code: "refused-credential-match" });
    expect(seen).toHaveLength(2);
    await proxy.close();
  });

  it("F5: redacts object keys in stored transcripts", async () => {
    const { proxy, evidence } = await start(okInvoke());
    const callWithKey = call("#n2 textbox", { typed: "x" });
    (callWithKey.prompt[2] as { content: Array<{ input: unknown }> }).content[0]!.input = { [PASSWORD]: "v", target: "n2" };
    const reply = await post(channelRequest({ callOverride: callWithKey }));
    expect(reply.body.result).toMatchObject({ code: "refused-credential-match" });
    const summary = await proxy.close();
    const stored = JSON.stringify({ transcripts: evidence.transcripts, summary });
    expect(stored).not.toContain(PASSWORD);
    expect(stored).not.toContain(JSON.stringify(PASSWORD).slice(1, -1));
  });

  it("F7: a route that fails inside gives a receipt, so there is no call index gap", async () => {
    let first = true;
    const dayBudget = { reserve: () => { if (first) { first = false; throw new Error("table unreachable"); } return { settle: () => undefined }; } };
    const route = createGovernedE2EModelRoute(bedrockRoute(), { invoke: okInvoke(), now: Date.now, dayBudget });
    const evidence = new Sink();
    const proxy = await startE2EModelProxy({ socketPath, runId: RUN_ID, route, credentialSet: CREDENTIALS, evidence, deadlineAt: Date.now() + 60_000, environment: {} });
    proxies.push(proxy);
    proxy.beginStep({ caseId: CASE_ID, stepIndex: 0 });
    expect((await post(channelRequest({ callIndex: 0 }))).body.result).toMatchObject({ code: "budget" });
    expect((await post(channelRequest({ callIndex: 1 }))).body.result.status).toBe("ok");
    expect((await proxy.close()).receipts.map((item) => [item.callIndex, item.outcome])).toEqual([[0, "budget"], [1, "ok"]]);
  });

  it("F8: needs a socket directory that only its owner can use, makes a missing one with mode 0700, and does not touch the process umask", async () => {
    const { chmod, mkdir } = await import("node:fs/promises");
    const open = join(dir, "open");
    await mkdir(open);
    await chmod(open, 0o755);
    const route = createGovernedE2EModelRoute(bedrockRoute(), { invoke: okInvoke(), now: Date.now, dayBudget: createInMemoryE2EDayBudget() });
    const base = { runId: RUN_ID, route, credentialSet: CREDENTIALS, evidence: new Sink(), deadlineAt: Date.now() + 60_000, environment: {} };
    await expect(startE2EModelProxy({ ...base, socketPath: join(open, "m.sock") })).rejects.toThrow(/mode 0700/);
    const umask = vi.spyOn(process, "umask");
    const fresh = join(dir, "fresh", "model");
    const proxy = await startE2EModelProxy({ ...base, socketPath: join(fresh, "model.sock") });
    proxies.push(proxy);
    expect((await stat(fresh)).mode & 0o777).toBe(0o700);
    expect((await stat(join(fresh, "model.sock"))).mode & 0o777).toBe(0o600);
    expect(umask).not.toHaveBeenCalled();
    umask.mockRestore();
  });

  it("F13: after a credential match the step refuses every later call without reaching the provider; another step is not latched", async () => {
    const seen: unknown[] = [];
    const { proxy } = await start(okInvoke(seen));
    expect((await post(channelRequest({ callIndex: 0, callOverride: call(`pw ${PASSWORD}`) }))).body.result).toMatchObject({ code: "refused-credential-match" });
    const later = await post(channelRequest({ callIndex: 1 }));
    expect(later.body.result).toMatchObject({ code: "refused-credential-match" });
    expect(seen).toHaveLength(0);
    proxy.beginStep({ caseId: CASE_ID, stepIndex: 1 });
    expect((await post(channelRequest({ stepIndex: 1, callIndex: 0 }))).body.result.status).toBe("ok");
    const { receipts } = await proxy.close();
    expect(receipts.map((item) => item.outcome)).toEqual(["refused-credential-match", "refused-credential-match", "ok"]);
  });

  it("F14: a call before any step is refused with no receipt and no phantom step", async () => {
    const invoke = vi.fn(okInvoke());
    const { proxy } = await start(invoke, { begin: false });
    const reply = await post(channelRequest());
    expect(reply.body.result).toMatchObject({ status: "error", code: "refused-protocol" });
    expect(invoke).not.toHaveBeenCalled();
    for (let step = 0; step < 3; step += 1) {
      proxy.beginStep({ caseId: CASE_ID, stepIndex: step });
      expect((await post(channelRequest({ stepIndex: step, callIndex: 0 }))).body.result.status).toBe("ok");
    }
    const summary = await proxy.close();
    expect(summary.unscopedRequests).toBe(1);
    expect(summary.receipts).toHaveLength(3);
    expect(checkE2EGroupModelBudget({ receipts: summary.receipts, budgets: bedrockRoute().budgets })).toMatchObject({ ok: true, agentSteps: 3 });
  });
});

describe("e2e model proxy: the provider layer (amendment A1)", () => {
  it("refuses to start when the worker environment can redirect a model call, naming the variable and not its value", async () => {
    const route = createGovernedE2EModelRoute(bedrockRoute(), { invoke: okInvoke(), now: Date.now, dayBudget: createInMemoryE2EDayBudget() });
    const base = { socketPath, runId: RUN_ID, route, credentialSet: CREDENTIALS, evidence: new Sink(), deadlineAt: Date.now() + 60_000 };
    const failure = await startE2EModelProxy({ ...base, environment: { HTTPS_PROXY: "http://proxy.example.test:3128", AWS_BEARER_TOKEN_BEDROCK: "bearer-secret-value" } }).then(() => undefined, (error: unknown) => error as Error);
    expect(failure?.message).toMatch(/environment can redirect model calls/);
    expect(failure?.message).toContain("HTTPS_PROXY");
    expect(failure?.message).toContain("AWS_BEARER_TOKEN_BEDROCK");
    expect(failure?.message).not.toContain("bearer-secret-value");
    await expect(stat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    const proxy = await startE2EModelProxy({ ...base, environment: { PATH: "/usr/bin" } });
    proxies.push(proxy);
  });

  it("R3: refuses to start on a redirecting process environment whatever environment it is given", async () => {
    const route = createGovernedE2EModelRoute(bedrockRoute(), { invoke: okInvoke(), now: Date.now, dayBudget: createInMemoryE2EDayBudget() });
    vi.stubEnv("HTTPS_PROXY", "http://proxy.example.test:3128");
    await expect(startE2EModelProxy({ socketPath, runId: RUN_ID, route, credentialSet: CREDENTIALS, evidence: new Sink(), deadlineAt: Date.now() + 60_000, environment: {} })).rejects.toThrow(/HTTPS_PROXY/);
    await expect(stat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("R2: refuses to start a route whose provider or secret differs from the worker's own settings", async () => {
    const definition = keyedRoute("anthropic");
    const route = createGovernedE2EModelRoute(definition, { invoke: okInvoke(), now: Date.now, dayBudget: createInMemoryE2EDayBudget() });
    const base = { socketPath, runId: RUN_ID, route, credentialSet: CREDENTIALS, evidence: new Sink(), deadlineAt: Date.now() + 60_000 };
    for (const environment of [{}, { ...installationEnvironment(definition), AGENTX_MODEL_PROVIDER: "openai" }, { AGENTX_MODEL_PROVIDER: "anthropic", AGENTX_ANTHROPIC_SECRET_ARN: definition.secretArn!.replace("AbCdEf", "ZzZzZz") }]) {
      await expect(startE2EModelProxy({ ...base, environment })).rejects.toThrow(/model-route-changed-reapprove/);
    }
    await expect(stat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    const proxy = await startE2EModelProxy({ ...base, environment: installationEnvironment(definition) });
    proxies.push(proxy);
    // A Bedrock route on a worker configured for a keyed provider is refused too; an unset provider setting is Bedrock.
    const bedrock = createGovernedE2EModelRoute(bedrockRoute(), { invoke: okInvoke(), now: Date.now, dayBudget: createInMemoryE2EDayBudget() });
    await expect(startE2EModelProxy({ ...base, socketPath: join(dir, "b.sock"), route: bedrock, environment: { AGENTX_MODEL_PROVIDER: "anthropic" } })).rejects.toThrow(/model-route-changed-reapprove/);
    proxies.push(await startE2EModelProxy({ ...base, socketPath: join(dir, "b.sock"), route: bedrock, environment: {} }));
  });

  it("does not apply the guard to a scripted route, which calls no provider", async () => {
    const scripted = bedrockRoute({ routeId: "rovara-scripted/v1", scope: "qualification", provider: "rovara-scripted", region: null, modelId: "rovara-scripted-v1", effort: null });
    const route = createGovernedE2EModelRoute(scripted, { invoke: async () => tapAnswer({ servedModelId: "rovara-scripted-v1" }), now: Date.now, dayBudget: createInMemoryE2EDayBudget() });
    const proxy = await startE2EModelProxy({ socketPath, runId: RUN_ID, route, credentialSet: CREDENTIALS, evidence: new Sink(), deadlineAt: Date.now() + 60_000, policyScope: "qualification", environment: { HTTPS_PROXY: "http://proxy.example.test:3128" } });
    proxies.push(proxy);
  });

  it("scans for the provider key the route's invoke holds, so a prompt can never carry it", async () => {
    const key = "held-by-the-invoke-0123456789-abcdef";
    const seen: unknown[] = [];
    const invoke = Object.assign(okInvoke(seen), { secrets: [key] });
    const { proxy } = await start(invoke);
    const reply = await post(channelRequest({ callOverride: call(`The page says ${key}`) }));
    expect(reply.body.result).toMatchObject({ status: "error", code: "refused-credential-match" });
    expect(seen).toHaveLength(0);
    const summary = await proxy.close();
    expect(JSON.stringify(summary)).not.toContain(key);
  });

  it("gives the final provider payload to the credential scan, and records the call as refused when it carries a credential", async () => {
    const seen: unknown[] = [];
    const invoke: E2EInvoke = async (input) => {
      seen.push(input.call);
      input.inspectPayload?.({ messages: [{ content: "clean" }] });
      input.inspectPayload?.({ messages: [{ content: `leaked ${PASSWORD}` }], [`key-${AWS_KEY}`]: 1 });
      return tapAnswer();
    };
    const { proxy, evidence } = await start(invoke);
    const reply = await post(channelRequest());
    expect(reply.body.result).toMatchObject({ status: "error", code: "refused-credential-match" });
    const summary = await proxy.close();
    expect(summary.receipts[0]).toMatchObject({ outcome: "refused-credential-match", inputTokens: 0 });
    expect(JSON.stringify({ evidence: evidence.transcripts, summary, reply: reply.text })).not.toContain(PASSWORD);
  });

  it("stores the digest of the provider payload and the served model with the transcript and receipt", async () => {
    const digest = "b".repeat(64);
    const { proxy, evidence } = await start(async () => tapAnswer({ providerPayloadSha256: digest }));
    expect((await post(channelRequest())).body.result.status).toBe("ok");
    await proxy.close();
    expect(evidence.transcripts[0]).toMatchObject({ providerPayloadSha256: digest });
    expect(evidence.receipts[0]).toMatchObject({ servedModelId: null, servedUpstream: null });
  });
});

describe("e2e model proxy: the scripted route", () => {
  const scriptedDefinition = () => bedrockRoute({
    routeId: "rovara-scripted/v1", scope: "qualification", provider: "rovara-scripted", region: null, modelId: "rovara-scripted-v1", effort: null,
  });

  it("is refused outside a qualification policy unless the CI harness sets ROVARA_E2E_SCRIPTED_MODEL=1", async () => {
    const route = createGovernedE2EModelRoute(scriptedDefinition(), { invoke: async () => tapAnswer({ servedModelId: "rovara-scripted-v1" }), now: Date.now, dayBudget: createInMemoryE2EDayBudget() });
    const base = { socketPath, runId: RUN_ID, route, credentialSet: CREDENTIALS, evidence: new Sink(), deadlineAt: Date.now() + 60_000 };
    await expect(startE2EModelProxy({ ...base, policyScope: "standard", environment: {} })).rejects.toThrow(/scripted/);
    await expect(startE2EModelProxy({ ...base, policyScope: "standard", environment: { ROVARA_E2E_SCRIPTED_MODEL: "0" } })).rejects.toThrow(/scripted/);
    for (const options of [{ policyScope: "qualification" as const, environment: {} }, { policyScope: "standard" as const, environment: { ROVARA_E2E_SCRIPTED_MODEL: "1" } }]) {
      const proxy = await startE2EModelProxy({ ...base, ...options });
      proxies.push(proxy);
      await proxy.close();
    }
  });
});
