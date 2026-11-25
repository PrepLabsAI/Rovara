// Lead 4 L4-E2 (DEC 254zzn): the per-answer ceiling needs the gateway's own figure for what ONE answers call cost. The answers route returns it in the
// `x-rovara-cost-usd` response header: the amount the same settle wrote to the meter, as a decimal USD string, on a complete non-streaming success whose
// price is exact. Absent (never 0, never a guess) when the amount is not known; never on a refusal; never another company's figure or a total.
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { beforeAll, describe, expect, it } from "vitest";
import { FixedCapsSource } from "../../packages/model-gateway/src/caps.js";
import { InMemoryMeter, type MeterScope } from "../../packages/model-gateway/src/meter.js";
import type { ProviderRequest, ProviderTransport } from "../../packages/model-gateway/src/provider.js";
import { ANSWERS_COST_HEADER, ANSWERS_PATH, ANSWERS_STEP, createAnswersRoutes, type AnswersLimits } from "../../packages/model-gateway/src/answers-route.js";
import { LEARNING_PATH, LEARNING_STEP, createLearningRoutes, type LearningKeySource } from "../../packages/model-gateway/src/learning-route.js";
import { handleGateway, type GatewayDependencies } from "../../packages/model-gateway/src/server.js";
import { caps as agentCaps, claims, MemorySink, mint, now, requestBody, scope as agentScope, setup } from "./model-gateway-fixture.js";

const cidA = claims.cid;
const cidB = `org_${"b".repeat(20)}`;
const scopeOf = (cid = cidA): MeterScope => ({ iss: claims.iss, cid, pid: claims.pid, tid: claims.tid });
const jsonBody = { ...requestBody, stream: false };
/** An Anthropic JSON answer with exactly these token counts (the gateway reads `usage` from it). */
const reply = (usage: Record<string, number> = { input_tokens: 3_000, output_tokens: 1_500 }) => Buffer.from(JSON.stringify({ id: "msg_1", type: "message", model: "claude-sonnet-4-5", content: [{ type: "text", text: "an answer" }], usage }));
const bodyOf = (bytes: Buffer): ProviderTransport extends (r: ProviderRequest) => Promise<infer R> ? R : never => ({ status: 200, body: (async function* () { yield bytes; })() });

class Keys implements LearningKeySource {
  readonly connectedTo = new Set<string>([cidA, cidB]);
  async connected(_iss: string, cid: string): Promise<boolean> { return this.connectedTo.has(cid); }
  async keyFor(_iss: string, cid: string): Promise<string | undefined> { return `customer-key-${cid}`; }
}
const noLimits: AnswersLimits = { limitFor: async () => undefined };

function gateway(options: { transport?: ProviderTransport; overrides?: Partial<GatewayDependencies>; settleFails?: boolean; order?: string[] } = {}) {
  const keys = new Keys();
  const agentMeter = new InMemoryMeter(() => now);
  const answersMeter = new InMemoryMeter(() => now, undefined, undefined, { combineCompanyWith: agentMeter });
  const learningMeter = new InMemoryMeter(() => now, undefined, undefined, { combineCompanyWith: agentMeter });
  const settles = { count: 0 };
  const settle = answersMeter.settle.bind(answersMeter);
  answersMeter.settle = async (reservation, actual, estimated) => {
    settles.count += 1; options.order?.push("settle");
    if (options.settleFails === true) throw new Error("settlement unavailable");
    return settle(reservation, actual, estimated);
  };
  const companyCaps = new FixedCapsSource({ ...agentCaps, companyMonth: 1_000_000_000 });
  const transport: ProviderTransport = options.transport ?? (async () => bodyOf(reply()));
  const answers = createAnswersRoutes({ keys, meter: answersMeter, companyCaps, limits: noLimits, modelLimits: { maxOutputTokens: () => 128_000 }, transport });
  const learning = createLearningRoutes({ keys, meter: learningMeter, companyCaps, lessons: { isOn: async () => true }, modelLimits: { maxOutputTokens: () => 128_000 }, transport });
  const base = setup({ meter: agentMeter, caps: companyCaps, answers, learning, ...options.overrides });
  return { ...base, keys, agentMeter, answersMeter, settles };
}
class OrderedSink extends MemorySink {
  constructor(private readonly order: string[]) { super(); }
  override head(status: number, headers: Readonly<Record<string, string>>) { this.order.push("head"); super.head(status, headers); }
}
async function ask(deps: GatewayDependencies, changes: Record<string, unknown> = {}, body: unknown = jsonBody, sink: MemorySink = new MemorySink(), path = ANSWERS_PATH, step = ANSWERS_STEP) {
  const bytes = Buffer.from(JSON.stringify(body));
  await handleGateway(deps, { method: "POST", url: path, headers: { "content-type": "application/json", "x-api-key": mint({ stp: step, ...changes }) }, body: (async function* () { yield bytes; })() }, sink);
  return sink;
}
const spent = async (meter: InMemoryMeter, cid = cidA) => (await meter.read(scopeOf(cid))).find((r) => r.item === "company")?.spentMicros ?? 0;
/** The exact decimal the header must carry for a whole number of micro-dollars. */
const usd = (micros: number) => `${Math.floor(micros / 1_000_000)}.${String(micros % 1_000_000).padStart(6, "0")}`;

describe("answers cost header: the value is the settled amount of this call", () => {
  it("the header name is the one Code reads", () => { expect(ANSWERS_COST_HEADER).toBe("x-rovara-cost-usd"); });

  it("equals exactly what the meter settled for the call (not the hold, not an estimate), as a plain decimal USD string", async () => {
    const g = gateway();
    const sink = await ask(g.deps);
    expect(sink.status).toBe(200);
    const settled = await spent(g.answersMeter);
    expect(settled).toBeGreaterThan(0);
    // 3,000 input tokens at $1/MTok plus 1,500 output tokens at $2/MTok: 3,000 + 3,000 micro-dollars.
    expect(settled).toBe(6_000);
    expect(sink.headers[ANSWERS_COST_HEADER]).toBe(usd(settled));
    expect(sink.headers[ANSWERS_COST_HEADER]).toBe("0.006000");
    expect(sink.headers[ANSWERS_COST_HEADER]).toMatch(/^\d+\.\d{6}$/u);
    // The same settle also wrote the combined company row (one amount, two rows).
    expect(await spent(g.agentMeter)).toBe(settled);
    expect(g.settles.count).toBe(1);
  });

  it("is the call's own cost, not a running total: a bigger call and a second call each carry their own amount", async () => {
    let next = { input_tokens: 3_000, output_tokens: 1_500 };
    const g = gateway({ transport: async () => bodyOf(reply(next)) });
    const first = await ask(g.deps);
    const afterFirst = await spent(g.answersMeter);
    next = { input_tokens: 40_000, output_tokens: 10_000 };
    const second = await ask(g.deps);
    const afterSecond = await spent(g.answersMeter);
    expect(first.headers[ANSWERS_COST_HEADER]).toBe(usd(afterFirst));
    expect(second.headers[ANSWERS_COST_HEADER]).toBe(usd(afterSecond - afterFirst));
    expect(second.headers[ANSWERS_COST_HEADER]).toBe("0.060000");
    expect(second.headers[ANSWERS_COST_HEADER]).not.toBe(usd(afterSecond));
  });

  it("whole cents of a typical answer read back exactly (no float noise in the string)", async () => {
    const g = gateway({ transport: async () => bodyOf(reply({ input_tokens: 70_000, output_tokens: 0 + 40_000 })) });
    const sink = await ask(g.deps);
    expect(await spent(g.answersMeter)).toBe(150_000);
    expect(sink.headers[ANSWERS_COST_HEADER]).toBe("0.150000");
  });

  it("the settle happens BEFORE the head is sent, once: the figure is the settle's, never a guess made earlier", async () => {
    const order: string[] = [];
    const g = gateway({ order });
    const sink = await ask(g.deps, {}, jsonBody, new OrderedSink(order));
    expect(order).toEqual(["settle", "head"]);
    expect(g.settles.count).toBe(1);
    expect(sink.headers[ANSWERS_COST_HEADER]).toBe("0.006000");
  });

  it("the answer body is forwarded unchanged and the other headers are the same as before", async () => {
    const g = gateway();
    const sink = await ask(g.deps);
    expect(JSON.parse(sink.text())).toMatchObject({ id: "msg_1", content: [{ type: "text", text: "an answer" }] });
    expect(Object.keys(sink.headers).sort()).toEqual([ANSWERS_COST_HEADER, "cache-control", "content-type", "x-content-type-options"].sort());
    expect(sink.ended).toBe(true);
  });
});

describe("answers cost header: absent when the cost is not known (never 0, never a guess)", () => {
  it("an unpriced model (the price is a cautious estimate): the call is served and settled, no header", async () => {
    const g = gateway({ overrides: { prices: { priceFor: () => undefined } } });
    const sink = await ask(g.deps);
    expect(sink.status).toBe(200);
    expect(sink.headers[ANSWERS_COST_HEADER]).toBeUndefined();
    expect(await spent(g.answersMeter)).toBeGreaterThan(0);
    expect(g.settles.count).toBe(1);
  });

  it("the provider reported no usage at all (nothing was measured, so the settle falls back to the hold): no header", async () => {
    const g = gateway({ transport: async () => bodyOf(reply({ input_tokens: 0, output_tokens: 0 })) });
    const sink = await ask(g.deps);
    expect(sink.status).toBe(200);
    expect(await spent(g.answersMeter)).toBeGreaterThan(0);
    expect(sink.headers[ANSWERS_COST_HEADER]).toBeUndefined();
  });

  it("a usage block the gateway cannot read is a failed call (502), no header", async () => {
    const g = gateway({ transport: async () => bodyOf(Buffer.from(JSON.stringify({ content: [], usage: { input_tokens: "many" } }))) });
    const sink = await ask(g.deps);
    expect(sink.status).toBe(502);
    expect(sink.headers[ANSWERS_COST_HEADER]).toBeUndefined();
  });

  it("the meter could not settle (the hold stays): the answer is still delivered, with no header, and no second settle is tried", async () => {
    const g = gateway({ settleFails: true });
    const sink = await ask(g.deps);
    expect(sink.status).toBe(200);
    expect(sink.headers[ANSWERS_COST_HEADER]).toBeUndefined();
    expect(JSON.parse(sink.text())).toMatchObject({ id: "msg_1" });
    expect(g.settles.count).toBe(1);
    expect(g.logs).toContainEqual({ event: "settle_failed" });
    expect(g.logs.filter((e) => (e as { event?: string }).event === "settled")).toHaveLength(0);
  });

  it("a usage block the gateway cannot read still settles at the hold (as before), and sends no header", async () => {
    const g = gateway({ transport: async () => bodyOf(Buffer.from(JSON.stringify({ content: [], usage: { input_tokens: "many" } }))) });
    let estimate = 0;
    const reserve = g.answersMeter.reserve.bind(g.answersMeter);
    g.answersMeter.reserve = async (input) => { estimate = input.estimateMicros; return reserve(input); };
    const sink = await ask(g.deps);
    expect(sink.headers[ANSWERS_COST_HEADER]).toBeUndefined();
    expect(estimate).toBeGreaterThan(0);
    expect(await spent(g.answersMeter)).toBe(estimate);
    expect(g.settles.count).toBe(1);
  });

  it("the client's connection fails after the settle: exactly one settle, at the real usage, and the call is torn down", async () => {
    const g = gateway();
    const sink = new (class extends MemorySink { override async write(): Promise<void> { throw new Error("response unavailable"); } })();
    await ask(g.deps, {}, jsonBody, sink);
    expect(g.settles.count).toBe(1);
    expect(await spent(g.answersMeter)).toBe(6_000);
    expect(sink.destroyed).toBe(true);
  });

  it("a streamed answer (the head is sent before the cost is known): no header, settled as before", async () => {
    const g = gateway({ transport: async () => ({ status: 200, body: setupStream() }) });
    const sink = await ask(g.deps, {}, requestBody);
    expect(sink.status).toBe(200);
    expect(sink.headers[ANSWERS_COST_HEADER]).toBeUndefined();
    expect(await spent(g.answersMeter)).toBeGreaterThan(0);
    expect(g.settles.count).toBe(1);
  });
});

async function* setupStream() {
  const frame = (type: string, value: Record<string, unknown> = {}) => Buffer.from(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  yield frame("message_start", { message: { usage: { input_tokens: 2, output_tokens: 0 } } });
  yield frame("message_delta", { usage: { output_tokens: 5 } });
  yield frame("message_stop");
}

describe("answers cost header: success responses only", () => {
  const none = (sink: MemorySink) => expect(sink.headers[ANSWERS_COST_HEADER]).toBeUndefined();

  it("every refusal before the call carries no cost header: no provider, bad token, wrong step, unknown path, a request the guard refuses, a limit that is used up", async () => {
    const g = gateway();
    g.keys.connectedTo.delete(cidA);
    const noProvider = await ask(g.deps); expect(noProvider.status).toBe(403); none(noProvider);
    expect(g.settles.count).toBe(0);
    const ok = gateway();
    const wrongStep = await ask(ok.deps, { stp: "build" }); expect(wrongStep.status).toBe(401); none(wrongStep);
    const badToken = new MemorySink();
    await handleGateway(ok.deps, { method: "POST", url: ANSWERS_PATH, headers: { "content-type": "application/json", "x-api-key": "nope" }, body: (async function* () { yield Buffer.from("{}"); })() }, badToken);
    expect(badToken.status).toBe(401); none(badToken);
    const unknown = await ask(ok.deps, {}, jsonBody, new MemorySink(), "/v1/answers/nothing"); expect(unknown.status).toBe(404); none(unknown);
    const refused = await ask(ok.deps, {}, { ...jsonBody, model: "not-in-the-token" }); expect(refused.status).toBeGreaterThanOrEqual(400); none(refused);
    const tiny = gateway(); const tinyOverrides = createAnswersRoutes({ keys: tiny.keys, meter: tiny.answersMeter, companyCaps: new FixedCapsSource({ ...agentCaps, companyMonth: 1_000_000_000 }), limits: { limitFor: async () => 1 }, modelLimits: { maxOutputTokens: () => 128_000 }, transport: async () => bodyOf(reply()) });
    const used = await ask({ ...tiny.deps, answers: tinyOverrides }); expect(used.status).toBe(422); none(used);
    expect(ok.settles.count).toBe(0);
  });

  it("every provider failure carries no cost header, whether or not it was charged", async () => {
    for (const status of [401, 403, 429, 500, 529]) {
      const g = gateway({ transport: async () => ({ status, body: (async function* () { /* empty */ })() }) });
      const sink = await ask(g.deps);
      expect(sink.status, String(status)).toBeGreaterThanOrEqual(400);
      none(sink);
    }
  });

  it("a transport that throws carries no cost header", async () => {
    const g = gateway({ transport: async () => { throw new Error("down"); } });
    const sink = await ask(g.deps); expect(sink.status).toBe(502); none(sink);
  });

  it("the agent route and the learning route never carry it (answers only)", async () => {
    const g = gateway({ overrides: { transport: async () => ({ status: 200, body: setupStream() }) } });
    const agentSink = new MemorySink();
    await handleGateway(g.deps, { method: "POST", url: "/v1/messages", headers: { "content-type": "application/json", "x-api-key": mint() }, body: (async function* () { yield Buffer.from(JSON.stringify(requestBody)); })() }, agentSink);
    expect(agentSink.status).toBe(200);
    none(agentSink);
    const learn = await ask(g.deps, {}, jsonBody, new MemorySink(), LEARNING_PATH, LEARNING_STEP);
    expect(learn.status).toBe(200);
    none(learn);
  });
});

describe("answers cost header: a non-streaming answer on the agent route is untouched", () => {
  it("served as before: same headers, no cost header, settled once on the agent meter", async () => {
    const g = gateway({ overrides: { transport: async () => bodyOf(reply()) } });
    const sink = new MemorySink();
    await handleGateway(g.deps, { method: "POST", url: "/v1/messages", headers: { "content-type": "application/json", "x-api-key": mint() }, body: (async function* () { yield Buffer.from(JSON.stringify(jsonBody)); })() }, sink);
    expect(sink.status).toBe(200);
    expect(Object.keys(sink.headers).sort()).toEqual(["cache-control", "content-type", "x-content-type-options"]);
    expect(sink.ended).toBe(true);
    expect(g.logs.filter((e) => (e as { event?: string }).event === "settled")).toHaveLength(1);
    expect((await g.agentMeter.read(agentScope)).find((r) => r.item === "company")?.spentMicros).toBe(6_000);
  });
});

describe("answers cost header: no other company's figure and no totals", () => {
  it("two companies: each call carries only its own call's amount, whatever the other company spent", async () => {
    let usageOf: Record<string, number> = { input_tokens: 3_000, output_tokens: 1_500 };
    const seen: ProviderRequest[] = [];
    const g = gateway({ transport: async (request) => { seen.push(request); return bodyOf(reply(usageOf)); } });
    const a1 = await ask(g.deps, { cid: cidA });
    usageOf = { input_tokens: 90_000, output_tokens: 20_000 };
    const b1 = await ask(g.deps, { cid: cidB });
    usageOf = { input_tokens: 3_000, output_tokens: 1_500 };
    const a2 = await ask(g.deps, { cid: cidA });
    const b2 = await ask(g.deps, { cid: cidB });
    expect(seen.map((r) => r.key)).toEqual([`customer-key-${cidA}`, `customer-key-${cidB}`, `customer-key-${cidA}`, `customer-key-${cidB}`]);
    expect(a1.headers[ANSWERS_COST_HEADER]).toBe("0.006000");
    expect(b1.headers[ANSWERS_COST_HEADER]).toBe("0.130000");
    expect(a2.headers[ANSWERS_COST_HEADER]).toBe("0.006000");
    expect(b2.headers[ANSWERS_COST_HEADER]).toBe("0.006000");
    // Each company's meter holds only its own sum; no header ever equals a running total of either.
    expect(await spent(g.answersMeter, cidA)).toBe(12_000);
    expect(await spent(g.answersMeter, cidB)).toBe(136_000);
    for (const sink of [a1, b1, a2, b2]) {
      expect([usd(12_000), usd(136_000), usd(148_000)]).not.toContain(sink.headers[ANSWERS_COST_HEADER]);
      expect(Object.values(sink.headers).join(" ")).not.toContain("org_");
      expect(sink.text()).not.toContain("org_");
    }
  });

  it("a company with no provider connected learns nothing about the other's spend", async () => {
    const g = gateway();
    await ask(g.deps, { cid: cidA });
    g.keys.connectedTo.delete(cidB);
    const refused = await ask(g.deps, { cid: cidB });
    expect(refused.status).toBe(403);
    expect(refused.headers[ANSWERS_COST_HEADER]).toBeUndefined();
    expect(Object.keys(refused.headers).filter((h) => h.startsWith("x-rovara-")).sort()).toEqual(["x-rovara-answers-pause"]);
  });
});

