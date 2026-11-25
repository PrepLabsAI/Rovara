// Lead 4 L4-E (DEC 254z-amend2, option A): the gateway's "answers" call class. Answers to people's questions (hosted Ask, smart Just answer) run on the
// company's OWN connected provider account, held to an answers month row of their own ($20 default, set by the company's `answers_month` spend limit,
// under the company's monthly cap and counted in the one combined company total, DEC 228c). An answers token (stp = ANSWERS_STEP) is accepted only on the
// answers route, and nothing else is accepted there. These tests mirror model-gateway-learning.test.ts: same machinery, a different purpose.
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { beforeAll, describe, expect, it } from "vitest";
import { FixedCapsSource, type Caps } from "../../packages/model-gateway/src/caps.js";
import { CompanyAnswersLimits } from "../../packages/model-gateway/src/company-caps.js";
import type { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { InMemoryMeter, type MeterScope } from "../../packages/model-gateway/src/meter.js";
import type { ProviderRequest, ProviderTransport } from "../../packages/model-gateway/src/provider.js";
import { ANSWERS_DEFAULT_MONTH_MICROS, ANSWERS_PAUSE_HEADER, ANSWERS_PAUSE_MESSAGES, ANSWERS_CLIENT_PATH, ANSWERS_PATH, ANSWERS_STEP, createAnswersRoutes, type AnswersLimits } from "../../packages/model-gateway/src/answers-route.js";
import { LEARNING_PATH, LEARNING_STEP, createLearningRoutes, type LearningKeySource } from "../../packages/model-gateway/src/learning-route.js";
import { handleGateway, type GatewayDependencies } from "../../packages/model-gateway/src/server.js";
import { answer, call, caps as agentCaps, claims, MemorySink, mint, now, requestBody, scope as agentScope, setup } from "./model-gateway-fixture.js";

const cidA = claims.cid;
const cidB = `org_${"b".repeat(20)}`;
const answersClaims = { stp: ANSWERS_STEP };
const answersScope = (cid = cidA): MeterScope => ({ iss: claims.iss, cid, pid: claims.pid, tid: claims.tid });
const keyOf = (cid: string) => `customer-key-${cid}`;

class CustomerKeys implements LearningKeySource {
  readonly connectedTo = new Set<string>([cidA, cidB]);
  used: string[] = [];
  lose = false;
  async connected(_iss: string, cid: string): Promise<boolean> { return this.connectedTo.has(cid); }
  async keyFor(_iss: string, cid: string): Promise<string | undefined> { this.used.push(cid); return this.lose ? undefined : keyOf(cid); }
}
/** Each company's own answers limit, as the table would read it: a number, undefined (none), null (does not read), or a throw. */
class Limits implements AnswersLimits {
  readonly byCompany = new Map<string, number | null | undefined>();
  fail = false;
  reads: string[] = [];
  async limitFor(cid: string): Promise<number | null | undefined> { this.reads.push(cid); if (this.fail) throw new Error("down"); return this.byCompany.get(cid); }
}

function answersGateway(options: { companyMonth?: number; transport?: ProviderTransport; overrides?: Partial<GatewayDependencies>; withLearning?: boolean } = {}) {
  const customer = new CustomerKeys();
  const limits = new Limits();
  const agentKeyReads: string[] = [];
  const answerCalls: ProviderRequest[] = [];
  const agentMeter = new InMemoryMeter(() => now);
  const answersMeter = new InMemoryMeter(() => now, undefined, undefined, { combineCompanyWith: agentMeter });
  const learningMeter = new InMemoryMeter(() => now, undefined, undefined, { combineCompanyWith: agentMeter });
  const companyCaps = new FixedCapsSource({ ...agentCaps, companyMonth: options.companyMonth ?? 1_000_000_000 });
  const transport: ProviderTransport = options.transport ?? (async (request) => { answerCalls.push(request); return { status: 200, body: answer() }; });
  const answers = createAnswersRoutes({ keys: customer, meter: answersMeter, companyCaps, limits, modelLimits: { maxOutputTokens: () => 128_000 }, transport: async (r) => { if (options.transport !== undefined) answerCalls.push(r); return transport(r); } });
  const learning = options.withLearning === true ? createLearningRoutes({ keys: customer, meter: learningMeter, companyCaps, lessons: { isOn: async () => true }, modelLimits: { maxOutputTokens: () => 128_000 }, transport }) : undefined;
  const base = setup({ meter: agentMeter, caps: companyCaps, keys: { keyFor: async (c) => { agentKeyReads.push(c.cid); return "rovara-install-key"; } }, answers, ...(learning === undefined ? {} : { learning }), ...options.overrides });
  return { ...base, agentMeter, answersMeter, learningMeter, customer, limits, agentKeyReads, answerCalls, answers };
}
async function ask(deps: GatewayDependencies, changes: Record<string, unknown> = {}, body: unknown = requestBody, path = ANSWERS_PATH) {
  const sink = new MemorySink();
  const bytes = Buffer.from(JSON.stringify(body));
  await handleGateway(deps, { method: "POST", url: path, headers: { "content-type": "application/json", "x-api-key": mint({ ...answersClaims, ...changes }) }, body: (async function* () { yield bytes; })() }, sink);
  return sink;
}
const row = async (meter: InMemoryMeter, item: string, s: MeterScope) => (await meter.read(s)).find((r) => r.item === item);
const error = (sink: MemorySink) => (JSON.parse(sink.text()) as { error: { type: string; message: string } }).error;
const expectPaused = (sink: MemorySink, reason: keyof typeof ANSWERS_PAUSE_MESSAGES) => {
  expect(error(sink)).toEqual({ type: "answers_paused", message: ANSWERS_PAUSE_MESSAGES[reason] });
  expect(sink.headers[ANSWERS_PAUSE_HEADER]).toBe(reason);
};
const nothingMoved = async (g: ReturnType<typeof answersGateway>, cid = cidA) => {
  expect(g.answerCalls).toHaveLength(0);
  expect(g.calls).toHaveLength(0);
  for (const r of await g.answersMeter.read(answersScope(cid))) expect(r.committed).toBe(0);
  for (const r of await g.agentMeter.read({ ...agentScope, cid })) expect(r.committed).toBe(0);
};

describe("answers class: the purpose on the token", () => {
  it("an answers token on the answers route runs on the company's own key, never Rovara's", async () => {
    const g = answersGateway();
    const sink = await ask(g.deps);
    expect(sink.status).toBe(200);
    expect(g.answerCalls).toHaveLength(1);
    expect(g.answerCalls[0]!.key).toBe(keyOf(cidA));
    expect(g.agentKeyReads).toEqual([]);
    expect(g.logs).toContainEqual(expect.objectContaining({ event: "settled", route: "answers" }));
  });

  it("an answers token is refused on the agent route with the fixed 401, nothing held or sent (wrong purpose)", async () => {
    const g = answersGateway();
    const sink = await call(g.deps, requestBody, mint(answersClaims));
    expect(sink.status).toBe(401);
    expect(error(sink)).toEqual({ type: "authentication_error", message: "invalid or expired model access" });
    expect(g.agentKeyReads).toEqual([]);
    await nothingMoved(g);
  });

  it("an answers token is refused on the learning route, and a learning token on the answers route (each purpose only on its own path)", async () => {
    const g = answersGateway({ withLearning: true });
    const learnSink = new MemorySink();
    const bytes = Buffer.from(JSON.stringify(requestBody));
    await handleGateway(g.deps, { method: "POST", url: LEARNING_PATH, headers: { "content-type": "application/json", "x-api-key": mint(answersClaims) }, body: (async function* () { yield bytes; })() }, learnSink);
    expect(learnSink.status).toBe(401);
    const sink = await ask(g.deps, { stp: LEARNING_STEP });
    expect(sink.status).toBe(401);
    expect(error(sink)).toEqual({ type: "authentication_error", message: "invalid or expired model access" });
    expect(g.customer.used).toEqual([]);
    await nothingMoved(g);
  });

  it("an answers token is refused on the product route too", async () => {
    const g = answersGateway({ overrides: { product: { route: () => ({ provider: "gemini", product: true }) as never } } });
    const sink = new MemorySink();
    const bytes = Buffer.from(JSON.stringify(requestBody));
    await handleGateway(g.deps, { method: "POST", url: "/v1/product/gemini/v1beta/models/gemini-2.5-flash:generateContent", headers: { "content-type": "application/json", "x-api-key": mint(answersClaims) }, body: (async function* () { yield bytes; })() }, sink);
    expect(sink.status).toBe(401);
    await nothingMoved(g);
  });

  it("a task token (any other step, even a near miss) is refused on the answers route: the reserved step is accepted on its own path only", async () => {
    const g = answersGateway();
    for (const stp of ["build", "answers", "rovara-answers-cal", "rovara-ask-call", "rovara-answers-call-"]) {
      const sink = await ask(g.deps, { stp });
      expect(sink.status, stp).toBe(401);
    }
    expect(g.customer.used).toEqual([]);
    expect(g.limits.reads).toEqual([]);
    await nothingMoved(g);
  });

  it("the reserved step cannot be a program step or workflow mode (it has a hyphen, which no program step id has), and passes the token's step format", () => {
    expect(/^[a-z][a-z0-9_]{0,23}$/u.test(ANSWERS_STEP)).toBe(false);
    expect(ANSWERS_STEP).toContain("-");
    expect(/^[a-z][a-z0-9_-]{0,63}$/u.test(ANSWERS_STEP)).toBe(true);
    expect(ANSWERS_STEP).not.toBe(LEARNING_STEP);
  });

  it("no answers route configured: the answers path is 404, as before", async () => {
    const g = answersGateway();
    const deps = { ...g.deps }; delete deps.answers;
    expect((await ask(deps)).status).toBe(404);
    expect((await ask(g.deps, {}, requestBody, `${ANSWERS_PATH}?x=1`)).status).toBe(404);
  });

  it("golden: the agent route still serves task tokens on the install key, and still stops an ended task", async () => {
    const g = answersGateway();
    expect((await call(g.deps)).status).toBe(200);
    expect(g.agentKeyReads).toEqual([cidA]);
    expect(g.customer.used).toEqual([]);
    g.ended.end(claims.iss, claims.cid, claims.tid);
    expect((await call(g.deps)).status).toBe(403);
  });

  it("a question about a task that has ended is still answered: the task-ended record does not stop an answers call", async () => {
    const g = answersGateway();
    g.ended.end(claims.iss, claims.cid, claims.tid);
    expect((await ask(g.deps)).status).toBe(200);
  });
});

describe("answers class: the company's own key", () => {
  it("no connected provider account: refused with no_provider before any hold; Rovara's key is never a fallback", async () => {
    const g = answersGateway();
    g.customer.connectedTo.delete(cidA);
    const sink = await ask(g.deps);
    expect(sink.status).toBe(403);
    expectPaused(sink, "no_provider");
    expect(g.agentKeyReads).toEqual([]);
    await nothingMoved(g);
  });

  it("a key gone between admission and send: not sent, the hold is released at $0", async () => {
    const g = answersGateway();
    g.customer.lose = true;
    const sink = await ask(g.deps);
    expectPaused(sink, "no_provider");
    expect(g.agentKeyReads).toEqual([]);
    expect(g.answerCalls).toHaveLength(0);
    expect(await row(g.answersMeter, "company", answersScope())).toMatchObject({ committed: 0, spentMicros: 0, reservedMicros: 0 });
    expect(await row(g.agentMeter, "company", agentScope)).toMatchObject({ committed: 0, spentMicros: 0, reservedMicros: 0 });
  });

  it("the provider refuses the company's key (401/403): costs nothing, tells the caller no_provider", async () => {
    for (const status of [401, 403]) {
      const g = answersGateway({ transport: async () => ({ status, body: (async function* () { /* empty */ })() }) });
      expectPaused(await ask(g.deps), "no_provider");
      expect(await row(g.answersMeter, "company", answersScope())).toMatchObject({ committed: 0, spentMicros: 0 });
    }
  });
});

/** What one answer holds (its worst-case estimate) and finally costs, from a probe run. */
async function oneAnswer() {
  const g = answersGateway();
  let estimate = 0;
  const reserve = g.answersMeter.reserve.bind(g.answersMeter);
  g.answersMeter.reserve = async (input) => { estimate = input.estimateMicros; return reserve(input); };
  await ask(g.deps);
  return { estimate, spent: (await row(g.answersMeter, "company", answersScope()))!.spentMicros };
}

describe("answers class: money", () => {
  const seenCaps = async (g: ReturnType<typeof answersGateway>) => {
    let seen: Caps | undefined;
    const reserve = g.answersMeter.reserve.bind(g.answersMeter);
    g.answersMeter.reserve = async (input) => { seen = input.caps; return reserve(input); };
    await ask(g.deps);
    return seen;
  };

  it("holds on the answers month row ($20 default, under the company cap) AND on the combined company row", async () => {
    expect(ANSWERS_DEFAULT_MONTH_MICROS).toBe(20_000_000);
    const g = answersGateway();
    expect(await seenCaps(g)).toEqual({ task: Number.MAX_SAFE_INTEGER, projectMonth: Number.MAX_SAFE_INTEGER, companyMonth: 20_000_000, combinedCompanyMonth: 1_000_000_000 });
    const spent = (await row(g.answersMeter, "company", answersScope()))!.spentMicros;
    expect(spent).toBeGreaterThan(0);
    // Answers spend counts inside the one combined company total (the agent meter's company row), and no person pays.
    expect((await row(g.agentMeter, "company", agentScope))!.spentMicros).toBe(spent);
    expect((await row(g.answersMeter, "person", { ...answersScope(), per: claims.per }))?.committed ?? 0).toBe(0);
    expect((await row(g.agentMeter, "person", agentScope))?.committed ?? 0).toBe(0);
  });

  it("the company's own answers limit replaces the default, below it or above it, and never passes the company's monthly cap", async () => {
    const low = answersGateway(); low.limits.byCompany.set(cidA, 3_000_000);
    expect(await seenCaps(low)).toMatchObject({ companyMonth: 3_000_000, combinedCompanyMonth: 1_000_000_000 });
    const high = answersGateway(); high.limits.byCompany.set(cidA, 50_000_000);
    expect(await seenCaps(high)).toMatchObject({ companyMonth: 50_000_000 });
    const capped = answersGateway({ companyMonth: 40_000_000 }); capped.limits.byCompany.set(cidA, 900_000_000);
    expect(await seenCaps(capped)).toMatchObject({ companyMonth: 40_000_000, combinedCompanyMonth: 40_000_000 });
  });

  it("a limit of $0 pauses answers with no_budget, nothing sent", async () => {
    const g = answersGateway(); g.limits.byCompany.set(cidA, 0);
    const sink = await ask(g.deps);
    expect(sink.status).toBe(422);
    expectPaused(sink, "no_budget");
    await nothingMoved(g);
  });

  it("an answers limit that does not read is a fault, not a pause (nothing sent, nothing held); a failed read answers an error too, never a call", async () => {
    const g = answersGateway(); g.limits.byCompany.set(cidA, null);
    const sink = await ask(g.deps);
    expect(sink.status).toBeGreaterThanOrEqual(500);
    expect(sink.headers[ANSWERS_PAUSE_HEADER]).toBeUndefined();
    await nothingMoved(g);
    const broken = answersGateway(); broken.limits.fail = true;
    const failed = await ask(broken.deps);
    expect(failed.status).toBeGreaterThanOrEqual(500);
    await nothingMoved(broken);
  });

  it("the month fills up: the next answer is refused as monthly_limit, and one too large is cost_too_high", async () => {
    const { estimate, spent } = await oneAnswer();
    expect(estimate).toBeGreaterThan(spent);
    // Room for the hold of the second answer once the first has settled, and not for a third.
    const g = answersGateway(); g.limits.byCompany.set(cidA, spent * 2 + estimate - spent);
    expect((await ask(g.deps)).status).toBe(200);
    expect((await ask(g.deps)).status).toBe(200);
    const third = await ask(g.deps);
    expect(third.status).toBe(422);
    expectPaused(third, "monthly_limit");
    expect(g.answerCalls).toHaveLength(2);
    const tiny = answersGateway(); tiny.limits.byCompany.set(cidA, 1);
    expectPaused(await ask(tiny.deps), "cost_too_high");
    await nothingMoved(tiny);
  });

  it("two companies: each has its own limit and its own month row; one company's answers never pause the other's", async () => {
    const { estimate, spent: one } = await oneAnswer();
    const g = answersGateway(); g.limits.byCompany.set(cidA, estimate); g.limits.byCompany.set(cidB, estimate * 5);
    const other = { cid: cidB };
    expect((await ask(g.deps)).status).toBe(200);
    expectPaused(await ask(g.deps), "monthly_limit");
    for (let i = 0; i < 3; i++) expect((await ask(g.deps, other)).status).toBe(200);
    expect(g.answerCalls.map((r) => r.key)).toEqual([keyOf(cidA), keyOf(cidB), keyOf(cidB), keyOf(cidB)]);
    expect((await row(g.answersMeter, "company", answersScope(cidA)))!.spentMicros).toBe(one);
    expect((await row(g.answersMeter, "company", answersScope(cidB)))!.spentMicros).toBe(one * 3);
    // Each company's limit was read for its own id only.
    expect(new Set(g.limits.reads)).toEqual(new Set([cidA, cidB]));
  });

  it("two projects of one company share the company's answers limit (it is per company)", async () => {
    const { estimate } = await oneAnswer();
    const g = answersGateway(); g.limits.byCompany.set(cidA, estimate);
    expect((await ask(g.deps, { pid: "web" })).status).toBe(200);
    expectPaused(await ask(g.deps, { pid: "api" }), "monthly_limit");
  });

  it("folded into the combined company cap: agent spend that used the company's month leaves answers no room, and answers spend takes room from agents", async () => {
    const g = answersGateway({ companyMonth: 2_000_000 });
    // The agent meter alone fills the company's month.
    const held = await g.agentMeter.reserve({ scope: agentScope, caps: { ...agentCaps, companyMonth: 2_000_000 }, estimateMicros: 1_999_999 });
    expect(held.ok).toBe(true);
    if (held.ok) await g.agentMeter.settle(held.reservation, 1_999_999);
    const sink = await ask(g.deps);
    expect(sink.status).toBe(422);
    expect(g.answerCalls).toHaveLength(0);
    // And the other way: answers spend counts in the agent meter's company row.
    const g2 = answersGateway();
    await ask(g2.deps);
    expect((await row(g2.agentMeter, "company", agentScope))!.spentMicros).toBeGreaterThan(0);
  });

  it("the answers month row is its own: it is not the learning row, and answers spend does not use up learning's month", async () => {
    const g = answersGateway({ withLearning: true });
    await ask(g.deps);
    expect((await row(g.answersMeter, "company", answersScope()))!.spentMicros).toBeGreaterThan(0);
    expect((await row(g.learningMeter, "company", answersScope()))!.spentMicros).toBe(0);
  });

  it("refuses to run on a meter that does not combine with the agent meter (503, nothing held)", async () => {
    const g = answersGateway();
    const answers = createAnswersRoutes({ keys: g.customer, meter: new InMemoryMeter(() => now), companyCaps: new FixedCapsSource(agentCaps), limits: g.limits, modelLimits: { maxOutputTokens: () => 128_000 }, transport: async () => ({ status: 200, body: answer() }) });
    const sink = await ask({ ...g.deps, answers });
    expect(sink.status).toBe(503);
    expect(g.customer.used).toEqual([]);
  });
});

describe("CompanyAnswersLimits reads the company's own answers_month item, strongly consistent and fail closed", () => {
  const item = (more: Record<string, unknown> = {}) => ({ pk: `COMPANY#${cidA}`, sk: `SPEND_LIMIT#ANSWERS#${cidA}`, companyId: cidA, kind: "answers_month", id: cidA, monthlyUsdMicros: 7_000_000, version: 1, updatedAt: "2026-11-17T12:00:00.000Z", updatedBy: "d".repeat(64), ...more });
  const fakeDb = (stored: Record<string, unknown> | undefined, seen: unknown[] = []) => ({ get: async (table: string, key: unknown, options: unknown) => { seen.push({ table, key, options }); return stored; } }) as unknown as Dynamo;
  it("reads exactly this company's item by key, and is none when there is no item", async () => {
    const seen: unknown[] = [];
    expect(await new CompanyAnswersLimits(fakeDb(item(), seen), "companies").limitFor(cidA)).toBe(7_000_000);
    expect(seen).toEqual([{ table: "companies", key: { pk: `COMPANY#${cidA}`, sk: `SPEND_LIMIT#ANSWERS#${cidA}` }, options: { consistent: true } }]);
    expect(await new CompanyAnswersLimits(fakeDb(undefined), "companies").limitFor(cidA)).toBeUndefined();
  });
  it.each([["another company's item", { companyId: cidB }], ["another kind", { kind: "upkeep_month" }], ["another id", { id: cidB }], ["a negative amount", { monthlyUsdMicros: -1 }], ["no version", { version: 0 }]])("null (the call is refused) for %s", async (_name, change) => {
    expect(await new CompanyAnswersLimits(fakeDb(item(change)), "companies").limitFor(cidA)).toBeNull();
  });
  it("null for a malformed company id without a read; a failed read throws", async () => {
    const seen: unknown[] = [];
    expect(await new CompanyAnswersLimits(fakeDb(item(), seen), "companies").limitFor("org_X")).toBeNull();
    expect(seen).toEqual([]);
    await expect(new CompanyAnswersLimits({ get: async () => { throw new Error("down"); } } as unknown as Dynamo, "companies").limitFor(cidA)).rejects.toThrow();
  });
});

// DEC 254zzz79 (3): Rovara's Slack chat and message router speak to the answers route through an Anthropic client whose base URL is `<gateway>/v1/answers`,
// so the request path is /v1/answers/v1/messages. It is the SAME route: the answers purpose, the company's own key, the answers month and the combined cap.
describe("answers class: the Anthropic client's own path (Slack chat and routing)", () => {
  it("serves /v1/answers/v1/messages exactly like /v1/answers/messages: the company's own key, the answers meter, the cost header", async () => {
    const g = answersGateway();
    const sink = await ask(g.deps, {}, requestBody, ANSWERS_CLIENT_PATH);
    expect(sink.status).toBe(200);
    expect(g.answerCalls).toHaveLength(1);
    expect(g.answerCalls[0]!.key).toBe(keyOf(cidA));
    expect(g.agentKeyReads).toEqual([]);
    expect((await row(g.answersMeter, "company", answersScope()))!.committed).toBeGreaterThan(0);
    expect(g.logs).toContainEqual(expect.objectContaining({ event: "settled", route: "answers" }));
  });

  it("a company with no connected account is paused with the same fixed words and header, and nothing is held or sent (no Rovara-paid fallback)", async () => {
    const g = answersGateway();
    g.customer.connectedTo.delete(cidA);
    const sink = await ask(g.deps, {}, requestBody, ANSWERS_CLIENT_PATH);
    expect(sink.status).toBe(403);
    expectPaused(sink, "no_provider");
    await nothingMoved(g);
    expect(g.agentKeyReads).toEqual([]);
  });

  it("a company over its answers month is paused the same way", async () => {
    const g = answersGateway();
    g.limits.byCompany.set(cidA, 0);
    const sink = await ask(g.deps, {}, requestBody, ANSWERS_CLIENT_PATH);
    expect(sink.status).toBe(422);
    expect(sink.headers[ANSWERS_PAUSE_HEADER]).toMatch(/^(no_budget|monthly_limit|cost_too_high)$/u);
    await nothingMoved(g);
  });

  it("only the answers token: an agent token on this path, and an answers token on the agent path, get the fixed 401", async () => {
    const g = answersGateway();
    const agent = await ask(g.deps, { stp: "plan" }, requestBody, ANSWERS_CLIENT_PATH);
    expect(agent.status).toBe(401);
    const onAgent = await call(g.deps, requestBody, mint(answersClaims));
    expect(onAgent.status).toBe(401);
    await nothingMoved(g);
  });

  it("the learning route does not grow the same path, and an unknown sibling path is still not found", async () => {
    const g = answersGateway({ withLearning: true });
    const learning = await ask(g.deps, { stp: LEARNING_STEP }, requestBody, "/v1/learning/v1/messages");
    expect(learning.status).toBe(404);
    const other = await ask(g.deps, {}, requestBody, "/v1/answers/v1/other");
    expect(other.status).toBe(404);
    await nothingMoved(g);
  });

  it("two companies: each call is held to ITS company's connection and meter", async () => {
    const g = answersGateway();
    g.customer.connectedTo.delete(cidB);
    const sink = await ask(g.deps, { cid: cidB }, requestBody, ANSWERS_CLIENT_PATH);
    expect(sink.status).toBe(403);
    expectPaused(sink, "no_provider");
    expect((await ask(g.deps, {}, requestBody, ANSWERS_CLIENT_PATH)).status).toBe(200);
    expect(g.customer.used).toEqual([cidA]);
  });
});
