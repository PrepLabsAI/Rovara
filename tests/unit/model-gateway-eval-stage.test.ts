// The product route's whole-stage eval hold (Code #683 EvalModelAccess.hold; DEC 165, 203, 228c). One atomic hold of the whole
// stage, calls admitted under it (count and spend, at most one call over), outcome classes as events (one head, chunks, one
// settle), one release that gives back only known unspent spend, expiry and the open-hold sweep, and two-company isolation.
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { beforeAll, describe, expect, it } from "vitest";
import { FixedCapsSource } from "../../packages/model-gateway/src/caps.js";
import type { MediaPriceSource } from "../../packages/model-gateway/src/media-price.js";
import { InMemoryMeter, type EstimatedSettlement, type Meter, type MeterScope, type Reservation, type ReserveInput } from "../../packages/model-gateway/src/meter.js";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { DynamoMeter, HOLD_SWEEP_AGE_MS } from "../../packages/model-gateway/src/dynamo-meter.js";
import { EVAL_HOLD_PATH, EVAL_RELEASE_PATH, EVAL_SCOPE_HEADER, EVAL_STAGE_MS, ProductEvalStages, evalClassOf, readGrant, type EvalApproval, type EvalRole } from "../../packages/model-gateway/src/product-eval.js";
import { PRODUCT_OVER_BY_ONE_CALL } from "../../packages/model-gateway/src/product-route.js";
import { LEARNING_STEP } from "../../packages/model-gateway/src/learning-route.js";
import type { ProviderResponse, ProviderTransport } from "../../packages/model-gateway/src/provider.js";
import { handleGateway, type GatewayDependencies } from "../../packages/model-gateway/src/server.js";
import { call, MemorySink, mint, now, scope as agentScope } from "./model-gateway-fixture.js";
import { change, cid, geminiAnswer, geminiBody, geminiKey, geminiSse, maintainer, pid, productCall, productGateway, productScope, storeKit, streamPath, wholePath } from "./model-gateway-product-fixture.js";
import { WireDynamo } from "./model-gateway-wire-dynamo.js";

const DIGEST = "d".repeat(64);
const OTHER = `org_${"b".repeat(20)}`;
const grant = (over: Record<string, unknown> = {}) => ({ company: cid, project: pid, selection: "all-questions", role: "maintainer", inputsDigest: DIGEST, provider: "customer", connected: true, maxCalls: 400, maxCostMicros: 4_000_000, ...over });
const approvalOf = (over: Partial<EvalApproval> = {}): EvalApproval => ({ selection: "all-questions", inputsDigest: DIGEST, maxCalls: 400, maxCostMicros: 4_000_000, approver: { personId: "p1", provider: "github" }, ...over });

interface Kit { g: Awaited<ReturnType<typeof productGateway>>; stages: ProductEvalStages; state: { approval: Record<string, EvalApproval | undefined>; role: EvalRole | undefined | "viewer"; fail: boolean; reads: number; hang: boolean }; clock: { at: number } }
async function evalKit(options: { media?: MediaPriceSource; unknownPrice?: boolean; transport?: ProviderTransport; companyMonth?: number; budget?: { calls: number; costMicros: number }; connect?: boolean; model?: string; waitMs?: number; kit?: ReturnType<typeof storeKit> } = {}): Promise<Kit> {
  const state: Kit["state"] = { approval: { [cid]: approvalOf(options.model === undefined ? {} : { model: options.model }) }, role: "maintainer", fail: false, reads: 0, hang: false };
  const clock = { at: now };
  const stages = new ProductEvalStages({
    approvals: {
      current: async (_iss, company) => { state.reads++; if (state.hang) await new Promise(() => undefined); if (state.fail) throw new Error("approval store down"); return state.approval[company]; },
      roleOf: async () => state.role as EvalRole | undefined,
    },
    ...(options.budget === undefined ? {} : { budget: async () => options.budget! }),
    now: () => clock.at, ...(options.waitMs === undefined ? {} : { waitMs: options.waitMs }),
  });
  const g = await productGateway({ evalStages: stages, ...(options.transport === undefined ? {} : { transport: options.transport }), ...(options.connect === false ? { connect: false } : {}), ...(options.kit === undefined ? {} : { kit: options.kit }), ...(options.unknownPrice === true ? { overrides: { prices: { priceFor: () => undefined } } } : {}), ...(options.media === undefined ? {} : { media: options.media }),
    companyCaps: new FixedCapsSource({ task: 1_000_000_000, projectMonth: 1_000_000_000, companyMonth: options.companyMonth ?? 1_000_000_000 }) });
  return { g, stages, state, clock };
}
async function control(deps: GatewayDependencies, path: string, body: unknown, token = mint(), contentType = "application/json") {
  const sink = new MemorySink();
  const bytes = Buffer.from(JSON.stringify(body));
  await handleGateway(deps, { method: "POST", url: path, headers: { "content-type": contentType, "x-api-key": token }, body: (async function* () { yield bytes; })() }, sink);
  return { sink, json: (() => { try { return JSON.parse(sink.text()) as Record<string, unknown>; } catch { return {}; } })() };
}
const hold = (deps: GatewayDependencies, body: unknown = { grant: grant(), calls: 10, costMicros: 100_000 }, token = mint()) => control(deps, EVAL_HOLD_PATH, body, token);
const release = (deps: GatewayDependencies, scope: unknown, spent: { calls: number; costMicros: number; unknown: boolean }, token = mint()) => control(deps, EVAL_RELEASE_PATH, { scope, ...spent }, token);
type Event = { kind: "head"; status: number; headers: Array<[string, string]> } | { kind: "chunk"; b64: string } | { kind: "settle"; status: number; class: string; refusal?: string; costMicros: number; estimated: boolean; overrun?: boolean };
async function stageCall(deps: GatewayDependencies, scope: string, path = streamPath, body: unknown = geminiBody, token = mint()) {
  const sink = await productCall(deps, path, body, token, { [EVAL_SCOPE_HEADER]: scope });
  const events = sink.text().split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as Event);
  const settle = events.at(-1) as Extract<Event, { kind: "settle" }>;
  const text = Buffer.concat(events.filter((e): e is Extract<Event, { kind: "chunk" }> => e.kind === "chunk").map((e) => Buffer.from(e.b64, "base64"))).toString();
  return { sink, events, settle, text };
}
/** Exactly one head (first), chunks, exactly one settle (last), and the stream ended, never destroyed. */
function wellFormed(events: Event[]): void {
  expect(events[0]!.kind).toBe("head");
  expect(events.filter((e) => e.kind === "head")).toHaveLength(1);
  expect(events.filter((e) => e.kind === "settle")).toHaveLength(1);
  expect(events.at(-1)!.kind).toBe("settle");
  expect(events.slice(1, -1).every((e) => e.kind === "chunk")).toBe(true);
}
const projectRow = async (k: Kit) => (await k.g.productMeter.read(productScope)).find((r) => r.item === "project")!;
const combinedRow = async (k: Kit) => (await k.g.meter.read(agentScope)).find((r) => r.item === "company")!;
const scopeOf = (r: { json: Record<string, unknown> }) => r.json.scope as string;

describe("eval stage hold: one atomic hold of the whole stage", () => {
  it("holds the whole cost on the project month row and the combined company row, returns an opaque scope, sends nothing", async () => {
    const k = await evalKit();
    const r = await hold(k.g.deps);
    expect(r.sink.status).toBe(200);
    expect(r.json).toEqual({ scope: expect.stringMatching(/^[0-9a-f-]{36}$/u) as unknown, calls: 10, costMicros: 100_000, expiresAt: now + EVAL_STAGE_MS });
    expect(await projectRow(k)).toMatchObject({ reservedMicros: 100_000, spentMicros: 0 });
    expect(await combinedRow(k)).toMatchObject({ reservedMicros: 100_000, spentMicros: 0 });
    expect(k.g.productCalls).toHaveLength(0);
    // The scope names nothing of the company, project or task.
    expect(scopeOf(r)).not.toContain(cid); expect(scopeOf(r)).not.toContain(pid);
  });

  const refusals: Array<[string, (k: Kit) => void, unknown, number]> = [
    ["another company's grant", () => undefined, { grant: grant({ company: OTHER }), calls: 10, costMicros: 1000 }, 422],
    ["another project's grant", () => undefined, { grant: grant({ project: "api" }), calls: 10, costMicros: 1000 }, 422],
    ["a selection the approval does not name", () => undefined, { grant: grant({ selection: "other" }), calls: 10, costMicros: 1000 }, 422],
    ["changed eval inputs", () => undefined, { grant: grant({ inputsDigest: "e".repeat(64) }), calls: 10, costMicros: 1000 }, 422],
    ["a ceiling the approval did not confirm", () => undefined, { grant: grant({ maxCalls: 399 }), calls: 10, costMicros: 1000 }, 422],
    ["a laptop provider", () => undefined, { grant: grant({ provider: "laptop" }), calls: 10, costMicros: 1000 }, 422],
    ["a disconnected grant", () => undefined, { grant: grant({ connected: false }), calls: 10, costMicros: 1000 }, 422],
    ["an extra grant field", () => undefined, { grant: { ...grant(), payer: "rovara" }, calls: 10, costMicros: 1000 }, 422],
    ["an unknown role word", () => undefined, { grant: grant({ role: "viewer" }), calls: 10, costMicros: 1000 }, 422],
    ["more calls than the grant", () => undefined, { grant: grant({ maxCalls: 400 }), calls: 401, costMicros: 1000 }, 422],
    ["more cost than the grant", () => undefined, { grant: grant(), calls: 10, costMicros: 4_000_001 }, 422],
    ["zero calls", () => undefined, { grant: grant(), calls: 0, costMicros: 1000 }, 422],
    ["a fractional cost", () => undefined, { grant: grant(), calls: 1, costMicros: 1.5 }, 422],
    ["an extra body field", () => undefined, { grant: grant(), calls: 1, costMicros: 1, scope: "x" }, 422],
    ["no approval on record", (k) => { k.state.approval[cid] = undefined; }, undefined, 422],
    ["an approver no longer a member", (k) => { k.state.role = undefined; }, undefined, 422],
    ["an approver whose role is no longer allowed", (k) => { k.state.role = "viewer"; }, undefined, 422],
    ["an unreadable approval", (k) => { k.state.fail = true; }, undefined, 503],
  ];
  for (const [name, arrange, body, status] of refusals) {
    it(`refuses ${name}, holding nothing`, async () => {
      const k = await evalKit(); arrange(k);
      const r = await hold(k.g.deps, body ?? { grant: grant(), calls: 10, costMicros: 1000 });
      expect(r.sink.status).toBe(status);
      expect(r.json.scope).toBeUndefined();
      expect(await projectRow(k)).toMatchObject({ reservedMicros: 0, committed: 0 });
      expect(await combinedRow(k)).toMatchObject({ reservedMicros: 0, committed: 0 });
      expect(JSON.stringify(r.json)).not.toMatch(/all-questions|p1|github|org_b/u);
    });
  }
  it("refuses beyond the approved project eval budget (DEC 203, configurable)", async () => {
    const k = await evalKit({ budget: { calls: 50, costMicros: 500_000 } });
    expect((await hold(k.g.deps, { grant: grant(), calls: 51, costMicros: 1000 })).sink.status).toBe(422);
    expect((await hold(k.g.deps, { grant: grant(), calls: 50, costMicros: 500_001 })).sink.status).toBe(422);
    expect((await hold(k.g.deps, { grant: grant(), calls: 50, costMicros: 500_000 })).sink.status).toBe(200);
  });
  it("refuses beyond the grant even when the project budget is larger", async () => {
    const k = await evalKit({ budget: { calls: 1000, costMicros: 10_000_000 } });
    expect((await hold(k.g.deps, { grant: grant(), calls: 401, costMicros: 1000 })).sink.status).toBe(422);
    expect((await hold(k.g.deps, { grant: grant(), calls: 10, costMicros: 4_000_001 })).sink.status).toBe(422);
    expect(await combinedRow(k)).toMatchObject({ reservedMicros: 0 });
  });
  it("a hold whose reads outlast the request holds nothing (503)", async () => {
    const k = await evalKit(); k.state.hang = true;
    const controller = new AbortController(); const sink = new MemorySink();
    const bytes = Buffer.from(JSON.stringify({ grant: grant(), calls: 10, costMicros: 1000 }));
    const running = handleGateway(k.g.deps, { method: "POST", url: EVAL_HOLD_PATH, headers: { "content-type": "application/json", "x-api-key": mint() }, body: (async function* () { yield bytes; })(), signal: controller.signal }, sink);
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 2));
    controller.abort(); await running;
    expect(sink.status).toBe(503);
    expect(await combinedRow(k)).toMatchObject({ reservedMicros: 0 });
  });
  it("the default budget is 400 calls and $4", async () => {
    const k = await evalKit();
    k.state.approval[cid] = approvalOf({ maxCalls: 401, maxCostMicros: 4_000_001 });
    expect((await hold(k.g.deps, { grant: grant({ maxCalls: 401, maxCostMicros: 4_000_001 }), calls: 401, costMicros: 1000 })).sink.status).toBe(422);
    expect((await hold(k.g.deps, { grant: grant({ maxCalls: 401, maxCostMicros: 4_000_001 }), calls: 400, costMicros: 4_000_001 })).sink.status).toBe(422);
  });
  it("refuses when the product key is not connected (re-read at hold time)", async () => {
    const k = await evalKit({ connect: false });
    expect((await hold(k.g.deps)).sink.status).toBe(422);
    expect(await combinedRow(k)).toMatchObject({ reservedMicros: 0 });
  });
  it("refuses a task already blocked by an overrun (DEC 165)", async () => {
    const k = await evalKit();
    await k.g.overrun.block(productScope.iss, productScope.cid, productScope.tid);
    expect((await hold(k.g.deps)).sink.status).toBe(422);
    expect(await combinedRow(k)).toMatchObject({ reservedMicros: 0 });
  });
  it("refuses when the combined company room is short, holding nothing", async () => {
    const k = await evalKit({ companyMonth: 50_000 });
    const r = await hold(k.g.deps, { grant: grant(), calls: 10, costMicros: 50_001 });
    expect(r.sink.status).toBe(422); expect(r.json.error).toMatchObject({ type: "budget_exceeded" });
    expect(await projectRow(k)).toMatchObject({ reservedMicros: 0 });
  });
  it("needs a task token and a JSON body; eval paths are 404 without stages", async () => {
    const k = await evalKit();
    expect((await hold(k.g.deps, undefined, "not-a-token")).sink.status).toBe(401);
    expect((await control(k.g.deps, EVAL_HOLD_PATH, { grant: grant(), calls: 1, costMicros: 1 }, mint(), "text/plain")).sink.status).toBe(400);
    const plain = await productGateway();
    expect((await hold(plain.deps)).sink.status).toBe(404);
    expect((await productCall(plain.deps, streamPath, geminiBody, mint(), { [EVAL_SCOPE_HEADER]: "00000000-0000-4000-8000-000000000000" })).status).toBe(404);
    expect(plain.productCalls).toHaveLength(0);
  });
  it("reads the grant at runtime: unknown words and wrong types are refused", () => {
    expect(readGrant(grant())).toBeDefined();
    for (const bad of [null, [], grant({ maxCalls: "400" }), grant({ inputsDigest: "D".repeat(64) }), grant({ selection: "" }), grant({ selection: "x".repeat(513) }), grant({ role: "owner ", connected: "true" })]) expect(readGrant(bad)).toBeUndefined();
  });
});

describe("eval stage: calls under the scope", () => {
  it("an ok call: one head, its bytes as chunks, one settle with the call's cost; nothing new held on the meter", async () => {
    const k = await evalKit();
    const scope = scopeOf(await hold(k.g.deps));
    const c = await stageCall(k.g.deps, scope);
    expect(c.sink.status).toBe(200); expect(c.sink.headers["content-type"]).toBe("application/x-ndjson"); expect(c.sink.ended).toBe(true);
    wellFormed(c.events);
    expect(c.events[0]).toEqual({ kind: "head", status: 200, headers: [["content-type", "text/event-stream; charset=utf-8"]] });
    expect(c.text).toContain("finishReason");
    expect(c.settle).toEqual({ kind: "settle", status: 200, class: "ok", costMicros: 20, estimated: false });
    expect(await projectRow(k)).toMatchObject({ reservedMicros: 100_000, spentMicros: 0 });
    expect(k.g.productCalls).toHaveLength(1);
    expect(k.g.productCalls[0]!.key).toBe(k.g.key);
  });
  it("refuses a call beyond the held call count before it is sent", async () => {
    const k = await evalKit();
    const scope = scopeOf(await hold(k.g.deps, { grant: grant(), calls: 2, costMicros: 100_000 }));
    expect((await stageCall(k.g.deps, scope)).settle.class).toBe("ok");
    expect((await stageCall(k.g.deps, scope)).settle.class).toBe("ok");
    const third = await stageCall(k.g.deps, scope);
    wellFormed(third.events);
    expect(third.events[0]).toMatchObject({ kind: "head", status: 422 });
    expect(third.settle).toMatchObject({ class: "cap", refusal: "cap", costMicros: 0 });
    expect(k.g.productCalls).toHaveLength(2);
  });
  it("refuses once spend reaches the held cost; the call that passed it is flagged overrun and stops the task (DEC 165)", async () => {
    const k = await evalKit();
    const scope = scopeOf(await hold(k.g.deps, { grant: grant(), calls: 10, costMicros: 30 }));
    const first = await stageCall(k.g.deps, scope);
    expect(first.settle).toEqual({ kind: "settle", status: 200, class: "ok", costMicros: 20, estimated: false });
    const second = await stageCall(k.g.deps, scope);
    expect(second.settle).toEqual({ kind: "settle", status: 200, class: "ok", costMicros: 20, estimated: false, overrun: true });
    const third = await stageCall(k.g.deps, scope);
    expect(third.settle).toMatchObject({ class: "cap", costMicros: 0 });
    expect(k.g.productCalls).toHaveLength(2);
    const plain = await productCall(k.g.deps);
    expect(plain.status).toBe(422); expect(plain.text()).toContain(PRODUCT_OVER_BY_ONE_CALL);
  });
  it("refuses once spend exactly reaches the held cost, with no overrun", async () => {
    const k = await evalKit();
    const scope = scopeOf(await hold(k.g.deps, { grant: grant(), calls: 10, costMicros: 40 }));
    expect((await stageCall(k.g.deps, scope)).settle).toMatchObject({ class: "ok", costMicros: 20 });
    const second = await stageCall(k.g.deps, scope);
    expect(second.settle).toEqual({ kind: "settle", status: 200, class: "ok", costMicros: 20, estimated: false });
    expect((await stageCall(k.g.deps, scope)).settle).toMatchObject({ class: "cap", costMicros: 0 });
    expect(k.g.productCalls).toHaveLength(2);
    expect((await productCall(k.g.deps)).status).toBe(200); // the task is not blocked: nothing passed the hold
  });
  it("a call that may pass the hold takes the company's one in-flight marker: the agent route and other product calls wait (DEC 228c)", async () => {
    let releaseFirst!: () => void; const paused = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let sent = 0;
    const k = await evalKit({ unknownPrice: true, transport: async () => { sent++; if (sent === 1) await paused; return { status: 200, body: geminiAnswer() }; } });
    const scope = scopeOf(await hold(k.g.deps, { grant: grant(), calls: 10, costMicros: 4_000_000 }));
    const running = stageCall(k.g.deps, scope);
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(sent).toBe(1);
    const agent = await call(k.g.deps);
    expect(agent.status).toBe(429); expect(agent.text()).toContain("busy");
    const plain = await productCall(k.g.deps);
    expect(plain.status).toBe(429); expect(plain.text()).toContain("busy");
    releaseFirst(); expect((await running).settle.class).toBe("ok");
    expect((await call(k.g.deps)).status).toBe(200);
  });
  it("a stage call that may pass the hold waits behind another company call that may pass a cap, then answers cap", async () => {
    let releaseFirst!: () => void; const paused = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let sent = 0;
    const k = await evalKit({ unknownPrice: true, waitMs: 30, transport: async () => { sent++; if (sent === 1) await paused; return { status: 200, body: geminiAnswer() }; } });
    const scope = scopeOf(await hold(k.g.deps, { grant: grant(), calls: 10, costMicros: 4_000_000 }));
    const plain = productCall(k.g.deps);
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 2));
    const c = await stageCall(k.g.deps, scope);
    wellFormed(c.events); expect(c.settle).toMatchObject({ class: "cap", costMicros: 0 });
    expect(sent).toBe(1);
    releaseFirst(); expect((await plain).status).toBe(200);
    expect((await stageCall(k.g.deps, scope)).settle.class).toBe("ok");
  });
  it("a call that may pass the held cost runs alone: parallel calls pass the hold by at most one call", async () => {
    let releaseFirst!: () => void; const paused = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let sent = 0;
    const k = await evalKit({ transport: async () => { sent++; if (sent === 1) await paused; return { status: 200, body: geminiAnswer() }; } });
    const scope = scopeOf(await hold(k.g.deps, { grant: grant(), calls: 10, costMicros: 30 }));
    const calls = [stageCall(k.g.deps, scope), stageCall(k.g.deps, scope), stageCall(k.g.deps, scope), stageCall(k.g.deps, scope)];
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(sent).toBe(1);
    releaseFirst();
    const done = await Promise.all(calls);
    done.forEach((c) => wellFormed(c.events));
    const spent = done.reduce((total, c) => total + c.settle.costMicros, 0);
    expect(done.filter((c) => c.settle.class === "ok")).toHaveLength(2);
    expect(done.filter((c) => c.settle.overrun === true)).toHaveLength(1);
    expect(spent).toBe(40); // 30 held + less than one call over.
    expect(sent).toBe(2);
  });
  it("an overrun-capable call (unknown price) runs alone even when the hold has room", async () => {
    let releaseFirst!: () => void; const paused = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let sent = 0;
    const k = await evalKit({ unknownPrice: true, transport: async () => { sent++; if (sent === 1) await paused; return { status: 200, body: geminiAnswer() }; } });
    const scope = scopeOf(await hold(k.g.deps, { grant: grant(), calls: 10, costMicros: 4_000_000 }));
    const calls = [stageCall(k.g.deps, scope), stageCall(k.g.deps, scope)];
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(sent).toBe(1);
    releaseFirst();
    const done = await Promise.all(calls);
    expect(done.every((c) => c.settle.class === "ok" && c.settle.estimated)).toBe(true);
    expect(sent).toBe(2);
  });
  it("calls that fit the hold run in parallel", async () => {
    let open!: () => void; const gate = new Promise<void>((resolve) => { open = resolve; });
    let inFlight = 0; let peak = 0;
    const k = await evalKit({ transport: async () => { inFlight++; peak = Math.max(peak, inFlight); await gate; inFlight--; return { status: 200, body: geminiAnswer() }; } });
    const scope = scopeOf(await hold(k.g.deps, { grant: grant(), calls: 10, costMicros: 1_000_000 }));
    const calls = [1, 2, 3, 4].map(() => stageCall(k.g.deps, scope));
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 2));
    open();
    expect((await Promise.all(calls)).every((c) => c.settle.class === "ok")).toBe(true);
    expect(peak).toBe(4);
  });
  it("calls the approved model only, when the approval names one", async () => {
    const k = await evalKit({ model: "gemini-2.5-pro" });
    const scope = scopeOf(await hold(k.g.deps));
    const c = await stageCall(k.g.deps, scope);
    wellFormed(c.events); expect(c.settle).toMatchObject({ class: "refused", costMicros: 0 });
    expect(k.g.productCalls).toHaveLength(0);
  });
});

describe("eval stage: outcome classes", () => {
  const body = (text: string): ProviderResponse => ({ status: 0, body: (async function* () { yield Buffer.from(text); })() });
  const cases: Array<[string, () => ProviderResponse, string, boolean]> = [
    ["a per-minute 429 is rate_limit", () => ({ ...body(JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for metric generate_content requests per minute" } })), status: 429 }), "rate_limit", false],
    ["a daily-quota 429 is quota", () => ({ ...body(JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for quota metric requests per day" } })), status: 429 }), "quota", false],
    ["an overloaded 429 is overloaded", () => ({ ...body(JSON.stringify({ error: { message: "The model is overloaded." } })), status: 429 }), "overloaded", false],
    ["a 503 is overloaded", () => ({ ...body("{}"), status: 503 }), "overloaded", true],
    ["a 401 is key_refused", () => ({ ...body("{}"), status: 401 }), "key_refused", false],
    ["a 500 is provider_error", () => ({ ...body("{}"), status: 500 }), "provider_error", true],
  ];
  for (const [name, answer, cls, charged] of cases) {
    it(name, async () => {
      const k = await evalKit({ transport: async () => answer() });
      const c = await stageCall(k.g.deps, scopeOf(await hold(k.g.deps)));
      wellFormed(c.events);
      expect(c.settle.class).toBe(cls);
      expect(c.settle.costMicros > 0).toBe(charged);
      // Provider words never reach the answer.
      expect(c.text).not.toMatch(/RESOURCE_EXHAUSTED|overloaded\./u);
    });
  }
  it("a cut-off stream is never ok: head, chunks, then a provider_error settle at the call's hold", async () => {
    const k = await evalKit({ transport: async () => ({ status: 200, body: geminiSse([{ candidates: [{ content: { parts: [{ text: "half" }] } }] }]) }) });
    const c = await stageCall(k.g.deps, scopeOf(await hold(k.g.deps)));
    wellFormed(c.events);
    expect(c.events[0]).toMatchObject({ kind: "head", status: 200 });
    // Settled at the call's full hold (no usage was read), never as a clean success.
    expect(c.settle).toMatchObject({ class: "provider_error" });
    expect(c.settle.costMicros).toBeGreaterThan(20);
  });
  it("a malformed whole answer is never ok", async () => {
    const k = await evalKit({ transport: async () => ({ status: 200, body: (async function* () { yield Buffer.from("{not json"); })() }) });
    const c = await stageCall(k.g.deps, scopeOf(await hold(k.g.deps)), wholePath);
    wellFormed(c.events); expect(c.settle.class).toBe("provider_error");
  });
  it("a body the guard refuses is refused, nothing sent", async () => {
    const k = await evalKit();
    const c = await stageCall(k.g.deps, scopeOf(await hold(k.g.deps)), streamPath, { contents: [], tools: [{ googleSearch: {} }] });
    wellFormed(c.events); expect(c.events[0]).toMatchObject({ status: 400 }); expect(c.settle).toMatchObject({ class: "refused", costMicros: 0 });
    expect(k.g.productCalls).toHaveLength(0);
  });
  it("maps every core word to one class", () => {
    expect(evalClassOf({ completed: true })).toBe("ok");
    expect(evalClassOf({ completed: false })).toBe("provider_error");
    expect(evalClassOf({ completed: false, code: "budget_held" })).toBe("cap");
    expect(evalClassOf({ completed: false, code: "busy" })).toBe("cap");
    expect(evalClassOf({ completed: false, code: "provider_refused" })).toBe("provider_error");
    expect(evalClassOf({ completed: false, code: "task_ended" })).toBe("refused");
    expect(evalClassOf({ completed: false, code: "unavailable" })).toBe("refused");
  });
});

describe("eval stage: release", () => {
  it("gives back only known unspent spend, once", async () => {
    const k = await evalKit();
    const scope = scopeOf(await hold(k.g.deps));
    await stageCall(k.g.deps, scope);
    const r = await release(k.g.deps, scope, { calls: 1, costMicros: 20, unknown: false });
    expect(r.sink.status).toBe(200); expect(r.json).toEqual({ released: 99_980 });
    expect(await projectRow(k)).toMatchObject({ reservedMicros: 0, spentMicros: 20, committed: 20 });
    expect(await combinedRow(k)).toMatchObject({ reservedMicros: 0, spentMicros: 20 });
    const again = await release(k.g.deps, scope, { calls: 0, costMicros: 0, unknown: false });
    expect(again.sink.status).toBe(409);
    expect(await projectRow(k)).toMatchObject({ reservedMicros: 0, spentMicros: 20 });
    // No call after the release.
    expect((await stageCall(k.g.deps, scope)).settle.class).toBe("cap");
    expect(k.g.productCalls).toHaveLength(1);
  });
  it("unknown keeps the whole hold spent", async () => {
    const k = await evalKit();
    const scope = scopeOf(await hold(k.g.deps));
    await stageCall(k.g.deps, scope);
    expect((await release(k.g.deps, scope, { calls: 1, costMicros: 20, unknown: true })).json).toEqual({ released: 0 });
    expect(await projectRow(k)).toMatchObject({ reservedMicros: 0, spentMicros: 100_000 });
  });
  it("a caller's lower report never gives back spend the gateway counted; a higher one is charged up to the hold only", async () => {
    const k = await evalKit();
    const a = scopeOf(await hold(k.g.deps, { grant: grant(), calls: 10, costMicros: 1000 }));
    await stageCall(k.g.deps, a);
    expect((await release(k.g.deps, a, { calls: 0, costMicros: 0, unknown: false })).json).toEqual({ released: 980 });
    const b = scopeOf(await hold(k.g.deps, { grant: grant(), calls: 10, costMicros: 1000 }));
    expect((await release(k.g.deps, b, { calls: 0, costMicros: 5000, unknown: false })).json).toEqual({ released: 0 });
    expect(await projectRow(k)).toMatchObject({ spentMicros: 1020, reservedMicros: 0 });
  });
  it("a release while a call is still open keeps the whole hold spent", async () => {
    let open!: () => void; const gate = new Promise<void>((resolve) => { open = resolve; });
    const k = await evalKit({ transport: async () => { await gate; return { status: 200, body: geminiAnswer() }; } });
    const scope = scopeOf(await hold(k.g.deps));
    const running = stageCall(k.g.deps, scope);
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 2));
    expect((await release(k.g.deps, scope, { calls: 1, costMicros: 0, unknown: false })).json).toEqual({ released: 0 });
    open(); await running;
    expect(await projectRow(k)).toMatchObject({ reservedMicros: 0, spentMicros: 100_000 });
  });
  it("refuses a malformed release, changing nothing", async () => {
    const k = await evalKit();
    const scope = scopeOf(await hold(k.g.deps));
    for (const bad of [{ scope, calls: 1, costMicros: 1 }, { scope, calls: -1, costMicros: 1, unknown: false }, { scope, calls: 1, costMicros: 1, unknown: "no" }, { scope: "nope", calls: 1, costMicros: 1, unknown: false }]) {
      const r = await control(k.g.deps, EVAL_RELEASE_PATH, bad);
      expect([400, 404]).toContain(r.sink.status);
    }
    expect(await projectRow(k)).toMatchObject({ reservedMicros: 100_000 });
  });
});

describe("eval stage: expiry and the open-hold sweep", () => {
  it("an expired stage refuses calls and is released at its known spend", async () => {
    const k = await evalKit();
    const scope = scopeOf(await hold(k.g.deps));
    await stageCall(k.g.deps, scope);
    // Not yet expired: the sweep releases nothing.
    k.clock.at = now + EVAL_STAGE_MS - 1;
    expect(await k.stages.sweep()).toEqual({ released: 0, failed: 0 });
    expect(await projectRow(k)).toMatchObject({ reservedMicros: 100_000 });
    k.clock.at = now + EVAL_STAGE_MS;
    expect((await stageCall(k.g.deps, scope)).settle.class).toBe("cap");
    expect(await k.stages.sweep()).toEqual({ released: 1, failed: 0 });
    expect(await projectRow(k)).toMatchObject({ reservedMicros: 0, spentMicros: 20 });
    // The caller's one release after expiry answers what was given back, and changes nothing.
    expect((await release(k.g.deps, scope, { calls: 1, costMicros: 20, unknown: true })).json).toEqual({ released: 99_980 });
    expect((await release(k.g.deps, scope, { calls: 1, costMicros: 20, unknown: false })).sink.status).toBe(409);
    expect(await projectRow(k)).toMatchObject({ reservedMicros: 0, spentMicros: 20 });
    expect(await k.stages.sweep(now + EVAL_STAGE_MS + 1)).toEqual({ released: 0, failed: 0 });
  });
  it("an expired stage with a call still open keeps its whole hold spent", async () => {
    let open!: () => void; const gate = new Promise<void>((resolve) => { open = resolve; });
    const k = await evalKit({ transport: async () => { await gate; return { status: 200, body: geminiAnswer() }; } });
    const scope = scopeOf(await hold(k.g.deps));
    const running = stageCall(k.g.deps, scope);
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 2));
    await k.stages.sweep(now + EVAL_STAGE_MS);
    open(); await running;
    expect(await projectRow(k)).toMatchObject({ reservedMicros: 0, spentMicros: 100_000 });
  });
  it("DynamoMeter: a stage hold is swept only after the stage's own end, at its whole estimate", async () => {
    const wire = new WireDynamo(["gw-meter", "gw-ledger", "gw-markers"]);
    const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), transport: wire.transport });
    let clock = now;
    const meter = new DynamoMeter({ db, tables: { meter: "gw-meter", ledger: "gw-ledger", markers: "gw-markers" }, now: () => clock });
    const caps = { task: 500, projectMonth: 1000, companyMonth: 1000 };
    const stageScope = { ...productScope, tid: "eval.00000000-0000-4000-8000-000000000000" };
    expect(await meter.reserve({ scope: stageScope, caps, estimateMicros: 500, sweepAfter: now + 25 * 60 * 60_000 })).toEqual({ ok: false, reason: "busy" });
    expect((await meter.reserve({ scope: stageScope, caps, estimateMicros: 500, sweepAfter: now + EVAL_STAGE_MS })).ok).toBe(true);
    const plain = await meter.reserve({ scope: { ...productScope, tid: "task_9" }, caps, estimateMicros: 100 }); expect(plain.ok).toBe(true);
    clock = now + HOLD_SWEEP_AGE_MS + 1;
    expect(await meter.sweepOpenHolds(clock, 10)).toEqual({ swept: 1, already: 0, failed: 0, more: false }); // the ordinary hold only; the stage hold is not even listed
    expect((await meter.read(stageScope)).find((r) => r.item === "task")).toMatchObject({ reservedMicros: 500, spentMicros: 0 });
    clock = now + EVAL_STAGE_MS + HOLD_SWEEP_AGE_MS + 1;
    expect(await meter.sweepOpenHolds(clock, 10)).toEqual({ swept: 1, already: 0, failed: 0, more: false });
    expect((await meter.read(stageScope)).find((r) => r.item === "task")).toMatchObject({ reservedMicros: 0, spentMicros: 500, estimatedMicros: 500 });
  });
});

describe("eval stage: two companies (conformance)", () => {
  it("isolates holds, scopes, keys and ledgers between companies, projects and tasks", async () => {
    const kit = storeKit();
    const keyA = geminiKey(); const keyB = geminiKey();
    await kit.store.connect({ ...change(pid, 0, maintainer), sourceId: "src_gem", provider: "gemini", key: keyA });
    await kit.store.connect({ ...change(pid, 0, maintainer), cid: OTHER, sourceId: "src_gem", provider: "gemini", key: keyB });
    const k = await evalKit({ kit, connect: false });
    k.state.approval[OTHER] = approvalOf();
    const tokenB = mint({ cid: OTHER });
    const a = scopeOf(await hold(k.g.deps));
    // B with A's scope: the same "not found" as a missing one, nothing sent, A untouched.
    const stolen = await stageCall(k.g.deps, a, streamPath, geminiBody, tokenB);
    wellFormed(stolen.events); expect(stolen.events[0]).toMatchObject({ status: 404 }); expect(stolen.settle).toMatchObject({ class: "refused", costMicros: 0 });
    const missing = await stageCall(k.g.deps, "00000000-0000-4000-8000-000000000000", streamPath, geminiBody, tokenB);
    expect(missing.sink.text()).toBe(stolen.sink.text());
    expect((await release(k.g.deps, a, { calls: 0, costMicros: 0, unknown: false }, tokenB)).sink.status).toBe(404);
    // Another task or project of company A: not found either.
    expect((await stageCall(k.g.deps, a, streamPath, geminiBody, mint({ tid: "task_2" }))).events[0]).toMatchObject({ status: 404 });
    expect((await stageCall(k.g.deps, a, streamPath, geminiBody, mint({ pid: "api" }))).settle.class).not.toBe("ok");
    expect(k.g.productCalls).toHaveLength(0);
    // B's own stage holds on B's rows only and calls with B's key.
    const b = scopeOf(await hold(k.g.deps, { grant: grant({ company: OTHER }), calls: 10, costMicros: 7_000 }, tokenB));
    expect((await stageCall(k.g.deps, b, streamPath, geminiBody, tokenB)).settle.class).toBe("ok");
    expect(k.g.productCalls.at(-1)!.key).toBe(keyB);
    expect((await stageCall(k.g.deps, a)).settle.class).toBe("ok");
    expect(k.g.productCalls.at(-1)!.key).toBe(keyA);
    const projectOf = async (company: string) => (await k.g.productMeter.read({ ...productScope, cid: company })).find((r) => r.item === "project")!;
    expect(await projectOf(cid)).toMatchObject({ reservedMicros: 100_000, company: cid });
    expect(await projectOf(OTHER)).toMatchObject({ reservedMicros: 7_000, company: OTHER });
    expect((await k.g.meter.read({ ...agentScope, cid: OTHER })).find((r) => r.item === "company")).toMatchObject({ reservedMicros: 7_000 });
    // A's approval does not serve B: B's grant naming company A is refused.
    expect((await hold(k.g.deps, { grant: grant(), calls: 1, costMicros: 1 }, tokenB)).sink.status).toBe(422);
  });
});

describe("product route: the provider's limit words (both routes)", () => {
  const limited = (message: string): ProviderTransport => async () => ({ status: 429, body: (async function* () { yield Buffer.from(JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message } })); })() });
  it("an ordinary product call answers quota, rate limit and overloaded apart, at no cost", async () => {
    for (const [message, code] of [["Quota exceeded for quota metric requests per day", "provider_quota"], ["Quota exceeded for metric requests per minute", "provider_limited"], ["The model is overloaded.", "provider_overloaded"], ["", "provider_limited"]] as const) {
      const g = await productGateway({ transport: limited(message) });
      const sink = await productCall(g.deps);
      expect(sink.status).toBe(429); expect((JSON.parse(sink.text()) as { error: { type: string } }).error.type).toBe(code);
      expect(sink.text()).not.toContain("RESOURCE_EXHAUSTED");
      expect((await g.productMeter.read(productScope)).every((r) => r.spentMicros === 0 && r.reservedMicros === 0)).toBe(true);
    }
  });
});

describe("eval stage: review fixes (spend after close, marker until settled, retries)", () => {
  const media = { contents: [{ role: "user", parts: [{ text: "x" }, { inlineData: { mimeType: "image/png", data: "aGk=" } }] }], generationConfig: { maxOutputTokens: 100 } };
  const pause = () => { let open!: () => void; const gate = new Promise<void>((resolve) => { open = resolve; }); return { open, gate }; };
  it("a release while a call is open settles the parent after that call, counting its real cost past the hold", async () => {
    const p = pause();
    const k = await evalKit({ transport: async () => { await p.gate; return { status: 200, body: geminiAnswer({ promptTokenCount: 5_000_000, candidatesTokenCount: 5 }) }; } });
    const scope = scopeOf(await hold(k.g.deps, { grant: grant(), calls: 10, costMicros: 1_000_000 }));
    const running = stageCall(k.g.deps, scope, streamPath, media);
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 2));
    expect((await release(k.g.deps, scope, { calls: 1, costMicros: 0, unknown: true })).json).toEqual({ released: 0 });
    expect(await projectRow(k)).toMatchObject({ reservedMicros: 1_000_000, spentMicros: 0 }); // still held: a call is open
    p.open();
    const c = await running;
    expect(c.settle).toMatchObject({ class: "ok", costMicros: 5_000_010, overrun: true });
    expect(await projectRow(k)).toMatchObject({ reservedMicros: 0, spentMicros: 5_000_010 });
    expect(await combinedRow(k)).toMatchObject({ reservedMicros: 0, spentMicros: 5_000_010 });
  });
  it("a call that may pass the hold runs truly alone: a fitting call neither joins it nor jumps ahead of it (recheck M1)", async () => {
    const mediaGate = pause();
    const sent: string[] = [];
    const k = await evalKit({ transport: async (request) => {
      const isMedia = Buffer.from(request.body).toString().includes("inlineData");
      sent.push(isMedia ? "media" : "text");
      if (isMedia && sent.filter((x) => x === "media").length === 1) await mediaGate.gate;
      return { status: 200, body: isMedia ? geminiAnswer({ promptTokenCount: 500, candidatesTokenCount: 5 }) : geminiAnswer() };
    } });
    const scope = scopeOf(await hold(k.g.deps, { grant: grant(), calls: 10, costMicros: 1_000_000 }));
    const exclusive = stageCall(k.g.deps, scope, streamPath, media); // overrun-capable: alone, with the company marker
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 2));
    const fitting = stageCall(k.g.deps, scope); // would fit the hold, but must wait for the media call
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(sent).toEqual(["media"]);
    mediaGate.open();
    expect((await exclusive).settle.class).toBe("ok");
    expect((await fitting).settle.class).toBe("ok");
    expect(sent).toEqual(["media", "text"]);
  });
  it("a fitting call does not jump ahead of a call waiting to run alone", async () => {
    const gates = [pause(), pause()];
    const sent: string[] = [];
    const k = await evalKit({ transport: async (request) => {
      const isMedia = Buffer.from(request.body).toString().includes("inlineData");
      const n = sent.push(isMedia ? "media" : "text");
      if (n <= 2) await gates[n - 1]!.gate;
      return { status: 200, body: geminiAnswer() };
    } });
    const scope = scopeOf(await hold(k.g.deps, { grant: grant(), calls: 10, costMicros: 1_000_000 }));
    const a = stageCall(k.g.deps, scope); // fits: runs
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 2));
    const b = stageCall(k.g.deps, scope, streamPath, media); // must run alone: waits for A
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 2));
    const c = stageCall(k.g.deps, scope); // would fit, but B is waiting for its turn
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(sent).toEqual(["text"]);
    gates[0]!.open(); await a;
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(sent).toEqual(["text", "media"]);
    gates[1]!.open();
    expect((await b).settle.class).toBe("ok"); expect((await c).settle.class).toBe("ok");
    expect(sent).toEqual(["text", "media", "text"]);
  });
  it("an overshoot is on the meter before the company marker is given back", async () => {
    let counting = false; let settles = 0; let hang: (() => void) | undefined; let second!: () => void; const atSecond = new Promise<void>((resolve) => { second = resolve; });
    const agentMeter = new InMemoryMeter(() => now);
    const productMeter = new InMemoryMeter(() => now, undefined, async (operation) => {
      if (!counting || operation !== "settle") return;
      settles++;
      if (settles === 2) await new Promise<void>((resolve) => { hang = resolve; second(); });
    }, { combineCompanyWith: agentMeter });
    const stages = new ProductEvalStages({ approvals: { current: async () => approvalOf(), roleOf: async () => "maintainer" }, now: () => now });
    const gate = pause();
    const g = await productGateway({ evalStages: stages, productMeter, overrides: { meter: agentMeter }, transport: async (request) => {
      if (Buffer.from(request.body).toString().includes("overshoot")) await gate.gate;
      return { status: 200, body: geminiAnswer({ promptTokenCount: 2_000_000, candidatesTokenCount: 5 }) };
    } });
    const scope = scopeOf(await hold(g.deps, { grant: grant(), calls: 10, costMicros: 1_000_000 }));
    const running = stageCall(g.deps, scope, streamPath, { ...media, contents: [{ role: "user", parts: [{ text: "overshoot" }, media.contents[0]!.parts[1]!] }] });
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 2));
    counting = true; gate.open();
    await atSecond; // the first real-meter settle (the parent, with the overshoot) is done; the second (the marker) is paused
    expect((await productMeter.read(productScope)).find((r) => r.item === "project")).toMatchObject({ reservedMicros: 0, spentMicros: 2_000_010 });
    const other = await productCall(g.deps, streamPath, media, mint({ tid: "task_2" }));
    expect(other.status).toBe(429); // the marker is still held until the overshoot is settled
    hang!(); await running;
  });
  it("the call that passes the hold puts its overshoot on the meter at once and keeps the company marker until then", async () => {
    const k = await evalKit({ transport: async () => ({ status: 200, body: geminiAnswer({ promptTokenCount: 2_000_000, candidatesTokenCount: 5 }) }) });
    const scope = scopeOf(await hold(k.g.deps, { grant: grant(), calls: 10, costMicros: 1_000_000 }));
    expect((await stageCall(k.g.deps, scope, streamPath, media)).settle).toMatchObject({ overrun: true, costMicros: 2_000_010 });
    // Settled with no release: the overshoot is on the project and the combined company rows.
    expect(await projectRow(k)).toMatchObject({ reservedMicros: 0, spentMicros: 2_000_010 });
    expect(await combinedRow(k)).toMatchObject({ reservedMicros: 0, spentMicros: 2_000_010 });
    // The marker is free again: another task's overrun-capable call goes ahead; the stage takes no more calls.
    expect((await productCall(k.g.deps, streamPath, media, mint({ tid: "task_2" }))).status).toBe(200);
    expect((await stageCall(k.g.deps, scope)).settle.class).toBe("cap");
    expect((await release(k.g.deps, scope, { calls: 1, costMicros: 0, unknown: false })).json).toEqual({ released: 0 });
  });
  it("a call that won the marker after its stage was released is not sent, and the marker is given back", async () => {
    const markerGate = pause(); let markerAsked!: () => void; const asked = new Promise<void>((resolve) => { markerAsked = resolve; });
    const agentMeter = new InMemoryMeter(() => now);
    const inner = new InMemoryMeter(() => now, undefined, undefined, { combineCompanyWith: agentMeter });
    const slow: Meter = {
      combinedCompany: true,
      reserve: async (input: ReserveInput) => { if (input.estimateMicros === 0) { markerAsked(); await markerGate.gate; } return inner.reserve(input); },
      settle: (r: Reservation, a: number, e?: EstimatedSettlement) => inner.settle(r, a, e),
      read: (scope: MeterScope) => inner.read(scope),
      pendingKeys: (l, c) => inner.pendingKeys(l, c), pendingFor: (k, l, c) => inner.pendingFor(k, l, c), pendingExpired: (n, l, c) => inner.pendingExpired(n, l, c),
      expire: (i) => inner.expire(i), correct: (i) => inner.correct(i),
    };
    const stages = new ProductEvalStages({ approvals: { current: async () => approvalOf(), roleOf: async () => "maintainer" }, now: () => now });
    const g = await productGateway({ evalStages: stages, productMeter: slow, overrides: { meter: agentMeter } });
    const scope = scopeOf(await hold(g.deps, { grant: grant(), calls: 10, costMicros: 1_000_000 }));
    const running = stageCall(g.deps, scope, streamPath, media);
    await asked;
    // Answered before the waiting call is decided: nothing given back yet, settled when it is.
    expect((await release(g.deps, scope, { calls: 0, costMicros: 0, unknown: false })).json).toEqual({ released: 0 });
    markerGate.open();
    const c = await running;
    expect(c.settle).toMatchObject({ class: "cap", costMicros: 0 });
    expect(g.productCalls).toHaveLength(0);
    // Nothing was sent, so nothing is spent: the whole hold went back.
    expect((await inner.read(productScope)).find((r) => r.item === "project")).toMatchObject({ reservedMicros: 0, spentMicros: 0 });
    // The marker was given back: another overrun-capable call of the company goes ahead.
    expect((await productCall(g.deps, streamPath, media, mint({ tid: "task_2" }))).status).toBe(200);
  });
  it("a failed parent settle answers 503 and the release can be retried", async () => {
    let failNext = false;
    const agentMeter = new InMemoryMeter(() => now);
    const productMeter = new InMemoryMeter(() => now, undefined, (operation) => { if (operation === "settle" && failNext) { failNext = false; throw new Error("conflict"); } }, { combineCompanyWith: agentMeter });
    const stages = new ProductEvalStages({ approvals: { current: async () => approvalOf(), roleOf: async () => "maintainer" }, now: () => now });
    const g = await productGateway({ evalStages: stages, productMeter, overrides: { meter: agentMeter } });
    const scope = scopeOf(await hold(g.deps, { grant: grant(), calls: 10, costMicros: 1000 }));
    failNext = true;
    expect((await release(g.deps, scope, { calls: 0, costMicros: 0, unknown: false })).sink.status).toBe(503);
    expect((await release(g.deps, scope, { calls: 0, costMicros: 0, unknown: false })).json).toEqual({ released: 1000 });
    expect((await productMeter.read(productScope)).find((r) => r.item === "project")).toMatchObject({ reservedMicros: 0, spentMicros: 0 });
  });
  it("a failed settle at expiry is retried by the next maintenance pass", async () => {
    let failNext = false;
    const agentMeter = new InMemoryMeter(() => now);
    const productMeter = new InMemoryMeter(() => now, undefined, (operation) => { if (operation === "settle" && failNext) { failNext = false; throw new Error("conflict"); } }, { combineCompanyWith: agentMeter });
    const stages = new ProductEvalStages({ approvals: { current: async () => approvalOf(), roleOf: async () => "maintainer" }, now: () => now });
    const g = await productGateway({ evalStages: stages, productMeter, overrides: { meter: agentMeter } });
    await hold(g.deps, { grant: grant(), calls: 10, costMicros: 1000 });
    failNext = true;
    expect(await stages.sweep(now + EVAL_STAGE_MS)).toEqual({ released: 0, failed: 1 });
    expect(await stages.sweep(now + EVAL_STAGE_MS)).toEqual({ released: 1, failed: 0 });
    expect((await productMeter.read(productScope)).find((r) => r.item === "project")).toMatchObject({ reservedMicros: 0 });
  });
  it("a release while the parent is being settled answers 503 and can be retried (recheck L1)", async () => {
    let hang: (() => void) | undefined; let entered!: () => void; const inSettle = new Promise<void>((resolve) => { entered = resolve; });
    const agentMeter = new InMemoryMeter(() => now);
    const productMeter = new InMemoryMeter(() => now, undefined, async (operation) => { if (operation === "settle" && hang === undefined) { await new Promise<void>((resolve) => { hang = resolve; entered(); }); } }, { combineCompanyWith: agentMeter });
    const stages = new ProductEvalStages({ approvals: { current: async () => approvalOf(), roleOf: async () => "maintainer" }, now: () => now });
    const g = await productGateway({ evalStages: stages, productMeter, overrides: { meter: agentMeter } });
    const scope = scopeOf(await hold(g.deps, { grant: grant(), calls: 10, costMicros: 1000 }));
    const sweeping = stages.sweep(now + EVAL_STAGE_MS);
    await inSettle;
    expect((await release(g.deps, scope, { calls: 0, costMicros: 900, unknown: true })).sink.status).toBe(503);
    hang!(); expect(await sweeping).toEqual({ released: 1, failed: 0 });
    expect((await release(g.deps, scope, { calls: 0, costMicros: 0, unknown: false })).json).toEqual({ released: 1000 });
  });
  it("a release is taken after the task ended (it only gives budget back); a hold is not", async () => {
    const k = await evalKit();
    const scope = scopeOf(await hold(k.g.deps));
    k.g.ended.end(productScope.iss, productScope.cid, productScope.tid);
    expect((await hold(k.g.deps)).sink.status).toBe(403);
    expect((await release(k.g.deps, scope, { calls: 0, costMicros: 0, unknown: false })).json).toEqual({ released: 100_000 });
    expect(await projectRow(k)).toMatchObject({ reservedMicros: 0 });
  });
  it("concurrent holds never pass the open-stage limit per company", async () => {
    const k = await evalKit();
    const results = await Promise.all(Array.from({ length: 12 }, () => hold(k.g.deps, { grant: grant(), calls: 1, costMicros: 10 })));
    expect(results.filter((r) => r.sink.status === 200)).toHaveLength(8);
    expect(results.filter((r) => r.sink.status === 429)).toHaveLength(4);
    expect(await projectRow(k)).toMatchObject({ reservedMicros: 80 });
  });
});

describe("eval stage: audio and video calls (#55, DEC 228e)", () => {
  const audioRates: MediaPriceSource = { mediaFor: (provider, model) => (provider === "gemini" && model === "gemini-2.5-flash" ? { audioInput: 3_000_000, videoInput: "input", audioCacheRead: 500_000 } : undefined) };
  const audio = { contents: [{ role: "user", parts: [{ text: "transcribe" }, { inlineData: { mimeType: "audio/mp3", data: "A".repeat(4000) } }] }], generationConfig: { maxOutputTokens: 100 } };
  it("an audio call under a stage runs alone with the company marker, and its audio tokens are charged at the audio rate", async () => {
    let open!: () => void; const gate = new Promise<void>((resolve) => { open = resolve; });
    let sent = 0;
    const k = await evalKit({ media: audioRates, transport: async () => { sent++; if (sent === 1) await gate; return { status: 200, body: geminiAnswer({ promptTokenCount: 200, candidatesTokenCount: 10, promptTokensDetails: [{ modality: "TEXT", tokenCount: 72 }, { modality: "AUDIO", tokenCount: 128 }] }) }; } });
    const scope = scopeOf(await hold(k.g.deps, { grant: grant(), calls: 10, costMicros: 4_000_000 }));
    const first = stageCall(k.g.deps, scope, streamPath, audio);
    const second = stageCall(k.g.deps, scope, streamPath, audio);
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(sent).toBe(1); // overrun-capable: one at a time within the stage
    // ...and one at a time across the company: another task's audio product call waits behind the marker.
    const other = await productCall(k.g.deps, streamPath, audio, mint({ tid: "task_2" }));
    expect(other.status).toBe(429); expect(other.text()).toContain("busy");
    open();
    const [a, b] = await Promise.all([first, second]);
    // 72 text x $1/M + 128 audio x $3/M + 10 out x $2/M = 72 + 384 + 20 = 476.
    expect(a.settle).toMatchObject({ class: "ok", costMicros: 476 });
    expect(b.settle).toMatchObject({ class: "ok", costMicros: 476 });
    expect((await release(k.g.deps, scope, { calls: 2, costMicros: 952, unknown: false })).json).toEqual({ released: 4_000_000 - 952 });
    expect(await combinedRow(k)).toMatchObject({ reservedMicros: 0, spentMicros: 952 });
  });
  it("an audio product call counts on the one combined company row and holds the company marker against the agent route", async () => {
    let open!: () => void; const gate = new Promise<void>((resolve) => { open = resolve; });
    const g = await productGateway({ media: audioRates, overrides: { prices: { priceFor: () => undefined } }, transport: async () => { await gate; return { status: 200, body: geminiAnswer({ promptTokenCount: 200, candidatesTokenCount: 10, promptTokensDetails: [{ modality: "AUDIO", tokenCount: 128 }] }) }; } });
    const running = productCall(g.deps, streamPath, audio);
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 2));
    const held = (await g.meter.read(agentScope)).find((r) => r.item === "company")!;
    expect(held.reservedMicros).toBeGreaterThan(0);
    // An overrun-capable agent call (unknown price) waits: one such call per company across both routes.
    const agent = await call(g.deps);
    expect(agent.status).toBe(429); expect(agent.text()).toContain("busy");
    open(); expect((await running).status).toBe(200);
    const after = (await g.meter.read(agentScope)).find((r) => r.item === "company")!;
    expect(after.reservedMicros).toBe(0); expect(after.spentMicros).toBeGreaterThan(0);
    expect((await call(g.deps)).status).toBe(200);
  });
});

describe("eval stage controls refuse a learning token (DEC 226)", () => {
  it("hold and release answer the fixed 401 to a learning token, before any approval read, stage or hold", async () => {
    const k = await evalKit();
    const learningToken = mint({ stp: LEARNING_STEP });
    const refused = await hold(k.g.deps, undefined, learningToken);
    expect(refused.sink.status).toBe(401);
    expect(refused.json).toEqual({ error: { type: "authentication_error", message: "invalid or expired model access" } });
    expect(k.state.reads).toBe(0);
    expect((await projectRow(k)).committed).toBe(0);
    expect((await combinedRow(k)).committed).toBe(0);
    // A real stage, then a release attempt with a learning token: refused, the stage keeps its hold.
    const held = await hold(k.g.deps);
    expect(held.sink.status).toBe(200);
    const before = (await combinedRow(k)).committed;
    const r = await release(k.g.deps, scopeOf(held), { calls: 0, costMicros: 0, unknown: false }, learningToken);
    expect(r.sink.status).toBe(401);
    expect((await combinedRow(k)).committed).toBe(before);
  });
});
