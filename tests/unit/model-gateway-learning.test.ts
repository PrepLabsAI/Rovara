// DEC 226: the gateway's "learning" call class. Lessons' learning calls (reflection, judging) run on the company's OWN connected
// provider account, held to a learning month row of their own ($20 default, under the company's monthly cap and counted in the
// one combined company total, DEC 228c), and make no call at all while the company's lessons switch is off. A learning token
// (stp = LEARNING_STEP) is accepted only on the learning route, and a task token never is.
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { beforeAll, describe, expect, it } from "vitest";
import { FixedCapsSource, type Caps, type CapsSource } from "../../packages/model-gateway/src/caps.js";
import { CompanyLessonsSwitch } from "../../packages/model-gateway/src/company-caps.js";
import { GATEWAY_COMPANY_LESSONS_GATE } from "../../packages/model-gateway/src/deploy.js";
import type { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { InMemoryMeter, type MeterScope } from "../../packages/model-gateway/src/meter.js";
import type { ProviderRequest, ProviderTransport } from "../../packages/model-gateway/src/provider.js";
import { createLearningRoutes, LEARNING_DEFAULT_MONTH_MICROS, LEARNING_PATH, LEARNING_PAUSE_HEADER, LEARNING_PAUSE_MESSAGES, LEARNING_STEP, type LearningKeySource, type LessonsSwitch } from "../../packages/model-gateway/src/learning-route.js";
import { handleGateway, type GatewayDependencies } from "../../packages/model-gateway/src/server.js";
import { answer, call, caps as agentCaps, claims, MemorySink, mint, now, requestBody, scope as agentScope, setup } from "./model-gateway-fixture.js";

const cidA = claims.cid;
const cidB = `org_${"b".repeat(20)}`;
const learningClaims = { stp: LEARNING_STEP };
const learningScope = (cid = cidA): MeterScope => ({ iss: claims.iss, cid, pid: claims.pid, tid: claims.tid });
const keyOf = (cid: string) => `customer-key-${cid}`;

class Switches implements LessonsSwitch {
  readonly on = new Set<string>([cidA, cidB]);
  reads: string[] = [];
  fail = false;
  /** Called after each read: lets a test flip the switch between admission and send. */
  afterRead: (() => void) | undefined;
  async isOn(cid: string): Promise<boolean> { this.reads.push(cid); if (this.fail) throw new Error("down"); const on = this.on.has(cid); this.afterRead?.(); return on; }
}
class CustomerKeys implements LearningKeySource {
  readonly connectedTo = new Set<string>([cidA, cidB]);
  used: string[] = [];
  lose = false;
  async connected(_iss: string, cid: string): Promise<boolean> { return this.connectedTo.has(cid); }
  async keyFor(_iss: string, cid: string): Promise<string | undefined> { this.used.push(cid); return this.lose ? undefined : keyOf(cid); }
}

function learningGateway(options: { companyMonth?: number; companyCaps?: CapsSource; ceiling?: number; transport?: ProviderTransport; combined?: boolean; overrides?: Partial<GatewayDependencies> } = {}) {
  const switches = new Switches();
  const customer = new CustomerKeys();
  const agentKeyReads: string[] = [];
  const learningCalls: ProviderRequest[] = [];
  const agentMeter = new InMemoryMeter(() => now);
  const learningMeter = options.combined === false ? new InMemoryMeter(() => now) : new InMemoryMeter(() => now, undefined, undefined, { combineCompanyWith: agentMeter });
  const companyCaps = options.companyCaps ?? new FixedCapsSource({ ...agentCaps, companyMonth: options.companyMonth ?? 1_000_000_000 });
  const transport: ProviderTransport = options.transport ?? (async (request) => { learningCalls.push(request); return { status: 200, body: answer() }; });
  const learning = createLearningRoutes({
    keys: customer, meter: learningMeter, companyCaps, lessons: switches, modelLimits: { maxOutputTokens: () => 128_000 },
    transport: async (r) => { if (options.transport !== undefined) learningCalls.push(r); return transport(r); },
    ...(options.ceiling === undefined ? {} : { monthCeilingMicros: options.ceiling }),
  });
  const base = setup({ meter: agentMeter, caps: companyCaps, keys: { keyFor: async (c) => { agentKeyReads.push(c.cid); return "rovara-install-key"; } }, learning, ...options.overrides });
  return { ...base, agentMeter, learningMeter, switches, customer, agentKeyReads, learningCalls, learning };
}
async function learn(deps: GatewayDependencies, changes: Record<string, unknown> = {}, body: unknown = requestBody, path = LEARNING_PATH) {
  const sink = new MemorySink();
  const bytes = Buffer.from(JSON.stringify(body));
  await handleGateway(deps, { method: "POST", url: path, headers: { "content-type": "application/json", "x-api-key": mint({ ...learningClaims, ...changes }) }, body: (async function* () { yield bytes; })() }, sink);
  return sink;
}
const row = async (meter: InMemoryMeter, item: string, s: MeterScope) => (await meter.read(s)).find((r) => r.item === item);
const error = (sink: MemorySink) => (JSON.parse(sink.text()) as { error: { type: string; message: string } }).error;
const expectPaused = (sink: MemorySink, reason: keyof typeof LEARNING_PAUSE_MESSAGES) => {
  expect(error(sink)).toEqual({ type: "lessons_paused", message: LEARNING_PAUSE_MESSAGES[reason] });
  expect(sink.headers[LEARNING_PAUSE_HEADER]).toBe(reason);
};
const nothingMoved = async (g: ReturnType<typeof learningGateway>, cid = cidA) => {
  expect(g.learningCalls).toHaveLength(0);
  expect(g.calls).toHaveLength(0);
  for (const r of await g.learningMeter.read(learningScope(cid))) expect(r.committed).toBe(0);
  for (const r of await g.agentMeter.read({ ...agentScope, cid })) expect(r.committed).toBe(0);
};

describe("learning class: the purpose on the token", () => {
  it("a learning token on the learning route runs on the company's own key, never Rovara's", async () => {
    const g = learningGateway();
    const sink = await learn(g.deps);
    expect(sink.status).toBe(200);
    expect(g.learningCalls).toHaveLength(1);
    expect(g.learningCalls[0]!.key).toBe(keyOf(cidA));
    expect(g.agentKeyReads).toEqual([]);
    expect(g.logs).toContainEqual(expect.objectContaining({ event: "settled", route: "learning" }));
  });

  it("a learning token is refused on the agent route with the fixed 401, nothing held or sent", async () => {
    const g = learningGateway();
    const sink = await call(g.deps, requestBody, mint(learningClaims));
    expect(sink.status).toBe(401);
    expect(error(sink)).toEqual({ type: "authentication_error", message: "invalid or expired model access" });
    expect(g.agentKeyReads).toEqual([]);
    await nothingMoved(g);
  });

  it("a learning token is refused on the product route too", async () => {
    const g = learningGateway({ overrides: { product: { route: () => ({ provider: "gemini", product: true }) as never } } });
    const sink = await learn(g.deps, {}, requestBody, "/v1/product/gemini/v1beta/models/gemini-2.5-flash:generateContent");
    expect(sink.status).toBe(401);
    await nothingMoved(g);
  });

  it("a task token (any other step) is refused on the learning route", async () => {
    const g = learningGateway();
    for (const stp of ["build", "learning", "rovara-lessons-learning-cal"]) {
      const sink = await learn(g.deps, { stp });
      expect(sink.status).toBe(401);
    }
    expect(g.switches.reads).toEqual([]);
    expect(g.customer.used).toEqual([]);
    await nothingMoved(g);
  });

  it("the reserved step cannot be a program step or workflow mode (longer than Code's 24-character step ids)", () => {
    expect(LEARNING_STEP.length).toBeGreaterThan(24);
    // Code's StepIdSchema (agent-recipe.ts) and the hyphen it never allows.
    expect(/^[a-z][a-z0-9_]{0,23}$/u.test(LEARNING_STEP)).toBe(false);
    expect(LEARNING_STEP).toContain("-");
    expect(/^[a-z][a-z0-9_-]{0,63}$/u.test(LEARNING_STEP)).toBe(true);
  });

  it("no learning route configured: the learning path is 404, as before", async () => {
    const g = learningGateway();
    const deps = { ...g.deps }; delete deps.learning;
    expect((await learn(deps)).status).toBe(404);
    expect((await learn(g.deps, {}, requestBody, `${LEARNING_PATH}?x=1`)).status).toBe(404);
  });

  it("golden: the agent route still serves task tokens on the install key, and still stops an ended task", async () => {
    const g = learningGateway();
    expect((await call(g.deps)).status).toBe(200);
    expect(g.agentKeyReads).toEqual([cidA]);
    expect(g.customer.used).toEqual([]);
    g.ended.end(claims.iss, claims.cid, claims.tid);
    expect((await call(g.deps)).status).toBe(403);
  });

  it("learning calls run after their task ended (reflection on merge): the task-ended record does not stop them", async () => {
    const g = learningGateway();
    g.ended.end(claims.iss, claims.cid, claims.tid);
    expect((await learn(g.deps)).status).toBe(200);
  });
});

describe("learning class: the company's lessons switch", () => {
  it("switch off: every call refused with lessons_off, before the key, the hold or the provider", async () => {
    const g = learningGateway();
    g.switches.on.delete(cidA);
    const sink = await learn(g.deps);
    expect(sink.status).toBe(403);
    expectPaused(sink, "lessons_off");
    expect(g.customer.used).toEqual([]);
    await nothingMoved(g);
  });

  it("switched off after admission (during the upload or the hold): re-read before sending, not sent, $0, lessons_off", async () => {
    const g = learningGateway();
    g.switches.afterRead = () => { g.switches.on.delete(cidA); };
    const sink = await learn(g.deps);
    expect(g.switches.reads).toEqual([cidA, cidA]);
    expectPaused(sink, "lessons_off");
    expect(g.customer.used).toEqual([]);
    expect(g.learningCalls).toHaveLength(0);
    expect(await row(g.learningMeter, "company", learningScope())).toMatchObject({ committed: 0, spentMicros: 0, reservedMicros: 0 });
    expect(await row(g.agentMeter, "company", agentScope)).toMatchObject({ committed: 0, spentMicros: 0, reservedMicros: 0 });
  });

  it("the switch unreadable just before sending: not sent, $0, 503", async () => {
    const g = learningGateway();
    g.switches.afterRead = () => { g.switches.fail = true; };
    const sink = await learn(g.deps);
    expect(sink.status).toBe(503);
    expect(g.learningCalls).toHaveLength(0);
    expect(await row(g.agentMeter, "company", agentScope)).toMatchObject({ committed: 0, spentMicros: 0 });
  });

  it("a switch that cannot be read refuses (503), nothing held or sent", async () => {
    const g = learningGateway();
    g.switches.fail = true;
    let reserves = 0;
    const reserve = g.learningMeter.reserve.bind(g.learningMeter);
    g.learningMeter.reserve = async (input) => { reserves++; return reserve(input); };
    const sink = await learn(g.deps);
    expect(sink.status).toBe(503);
    expect(error(sink)).toEqual({ type: "unavailable", message: "model access unavailable" });
    // Refused at admission: no hold was even tried.
    expect(reserves).toBe(0);
    await nothingMoved(g);
  });

  describe("CompanyLessonsSwitch reads the company backend's settings row, fail closed", () => {
    const fakeDb = (item: Record<string, unknown> | undefined, seen: unknown[] = []) => ({ get: async (table: string, key: unknown, options: unknown) => { seen.push({ table, key, options }); return item; } }) as unknown as Dynamo;
    const settingsRow = (gates: unknown, companyId = cidA) => ({ pk: `COMPANY#${cidA}`, sk: "SETTINGS", companyId, settings: { featureGates: gates, budgets: {} } });
    it("on only when featureGates.lessons is exactly true; read strongly consistent", async () => {
      const seen: unknown[] = [];
      expect(await new CompanyLessonsSwitch(fakeDb(settingsRow({ [GATEWAY_COMPANY_LESSONS_GATE]: true }), seen), "companies").isOn(cidA)).toBe(true);
      expect(seen).toEqual([{ table: "companies", key: { pk: `COMPANY#${cidA}`, sk: "SETTINGS" }, options: { consistent: true } }]);
      expect(GATEWAY_COMPANY_LESSONS_GATE).toBe("lessons");
    });
    it.each([
      ["no row", undefined],
      ["gate off", settingsRow({ lessons: false })],
      ["gate absent", settingsRow({ slack: true })],
      ["gate a string", settingsRow({ lessons: "true" })],
      ["gates not an object", settingsRow(["lessons"])],
      ["another company's row", settingsRow({ lessons: true }, cidB)],
      ["no settings", { pk: `COMPANY#${cidA}`, sk: "SETTINGS", companyId: cidA }],
    ])("off: %s", async (_name, item) => {
      expect(await new CompanyLessonsSwitch(fakeDb(item as Record<string, unknown> | undefined), "companies").isOn(cidA)).toBe(false);
    });
    it("off for a malformed company id, without a read", async () => {
      const seen: unknown[] = [];
      expect(await new CompanyLessonsSwitch(fakeDb(settingsRow({ lessons: true }), seen), "companies").isOn("org_X")).toBe(false);
      expect(seen).toEqual([]);
    });
    it("a failed read throws (the route answers 503)", async () => {
      const db = { get: async () => { throw new Error("down"); } } as unknown as Dynamo;
      await expect(new CompanyLessonsSwitch(db, "companies").isOn(cidA)).rejects.toThrow();
    });
  });
});

describe("learning class: the customer's own key", () => {
  it("no connected provider account: refused with no_provider before any hold; Rovara's key is never a fallback", async () => {
    const g = learningGateway();
    g.customer.connectedTo.delete(cidA);
    const sink = await learn(g.deps);
    expect(sink.status).toBe(403);
    expectPaused(sink, "no_provider");
    expect(g.agentKeyReads).toEqual([]);
    await nothingMoved(g);
  });

  it("a key gone between admission and send: not sent, the hold is released at $0, Code is told no_provider", async () => {
    const g = learningGateway();
    g.customer.lose = true;
    const sink = await learn(g.deps);
    expect(sink.status).toBe(403);
    expectPaused(sink, "no_provider");
    expect(g.agentKeyReads).toEqual([]);
    expect(g.learningCalls).toHaveLength(0);
    expect(await row(g.learningMeter, "company", learningScope())).toMatchObject({ committed: 0, spentMicros: 0, reservedMicros: 0 });
    expect(await row(g.agentMeter, "company", agentScope)).toMatchObject({ committed: 0, spentMicros: 0, reservedMicros: 0 });
  });

  it("the provider refuses the customer's key (401/403): costs nothing, tells Code no_provider", async () => {
    for (const status of [401, 403]) {
      const g = learningGateway({ transport: async () => ({ status, body: (async function* () { /* empty */ })() }) });
      const sink = await learn(g.deps);
      expectPaused(sink, "no_provider");
      expect(await row(g.learningMeter, "company", learningScope())).toMatchObject({ committed: 0, spentMicros: 0 });
    }
  });

  it("other provider failures keep the agent route's rule (429/529 free, the rest charged)", async () => {
    const g429 = learningGateway({ transport: async () => ({ status: 529, body: (async function* () { /* empty */ })() }) });
    expect(error(await learn(g429.deps)).type).toBe("provider_error");
    expect((await row(g429.learningMeter, "company", learningScope()))!.spentMicros).toBe(0);
    const g500 = learningGateway({ transport: async () => ({ status: 500, body: (async function* () { /* empty */ })() }) });
    await learn(g500.deps);
    expect((await row(g500.learningMeter, "company", learningScope()))!.spentMicros).toBeGreaterThan(0);
  });
});

describe("learning class: money", () => {
  it("holds on the learning month row ($20 default, under the company cap) AND on the combined company row", async () => {
    expect(LEARNING_DEFAULT_MONTH_MICROS).toBe(20_000_000);
    const g = learningGateway();
    let seen: Caps | undefined;
    const reserve = g.learningMeter.reserve.bind(g.learningMeter);
    g.learningMeter.reserve = async (input) => { seen = input.caps; return reserve(input); };
    await learn(g.deps);
    expect(seen).toEqual({ task: Number.MAX_SAFE_INTEGER, projectMonth: Number.MAX_SAFE_INTEGER, companyMonth: 20_000_000, combinedCompanyMonth: 1_000_000_000 });
    const learned = (await row(g.learningMeter, "company", learningScope()))!.spentMicros;
    expect(learned).toBeGreaterThan(0);
    // Learning spend counts inside the one combined company total (the agent meter's company row).
    expect((await row(g.agentMeter, "company", agentScope))!.spentMicros).toBe(learned);
    // No person pays for learning: the learning meter has no person row.
    expect((await row(g.learningMeter, "person", { ...learningScope(), per: claims.per }))?.committed ?? 0).toBe(0);
    expect((await row(g.agentMeter, "person", agentScope))?.committed ?? 0).toBe(0);
  });

  it("a company cap below $20 bounds the learning month row", async () => {
    const g = learningGateway({ companyMonth: 5_000_000 });
    let seen: Caps | undefined;
    const reserve = g.learningMeter.reserve.bind(g.learningMeter);
    g.learningMeter.reserve = async (input) => { seen = input.caps; return reserve(input); };
    await learn(g.deps);
    expect(seen).toMatchObject({ companyMonth: 5_000_000, combinedCompanyMonth: 5_000_000 });
  });

  describe("the company's own learning cap (settings.budgets.learningMonthlyUsdMicros, DEC 226)", () => {
    const seenCaps = async (g: ReturnType<typeof learningGateway>) => {
      let seen: Caps | undefined;
      const reserve = g.learningMeter.reserve.bind(g.learningMeter);
      g.learningMeter.reserve = async (input) => { seen = input.caps; return reserve(input); };
      await learn(g.deps);
      return seen;
    };
    const withLearning = (learningMonth: number | undefined, companyMonth = 1_000_000_000) => new FixedCapsSource({ ...agentCaps, companyMonth, ...(learningMonth === undefined ? {} : { learningMonth }) });
    it("bounds the learning month row, below the $20 default", async () => {
      const g = learningGateway({ companyCaps: withLearning(3_000_000) });
      expect(await seenCaps(g)).toEqual({ task: Number.MAX_SAFE_INTEGER, projectMonth: Number.MAX_SAFE_INTEGER, companyMonth: 3_000_000, combinedCompanyMonth: 1_000_000_000 });
    });
    it("may be raised above the $20 default, still under the company's monthly cap", async () => {
      const g = learningGateway({ companyCaps: withLearning(50_000_000) });
      expect(await seenCaps(g)).toMatchObject({ companyMonth: 50_000_000, combinedCompanyMonth: 1_000_000_000 });
    });
    it("never passes the company's monthly cap, whatever a row says", async () => {
      const g = learningGateway({ companyCaps: withLearning(900_000_000, 40_000_000) });
      expect(await seenCaps(g)).toMatchObject({ companyMonth: 40_000_000, combinedCompanyMonth: 40_000_000 });
    });
    it("an older row (no learning cap) gets the default ceiling the route was built with", async () => {
      const g = learningGateway({ companyCaps: withLearning(undefined), ceiling: 4_000_000 });
      expect(await seenCaps(g)).toMatchObject({ companyMonth: 4_000_000 });
    });
    it("a company's cap wins over the route's default ceiling in both directions", async () => {
      const g = learningGateway({ companyCaps: withLearning(30_000_000), ceiling: 4_000_000 });
      expect(await seenCaps(g)).toMatchObject({ companyMonth: 30_000_000 });
    });
    it("a cap of zero pauses learning with no_budget, nothing sent (not a cost_too_high that implies a smaller call would fit)", async () => {
      const g = learningGateway({ companyCaps: withLearning(0) });
      const sink = await learn(g.deps);
      expect(sink.status).toBe(422);
      expectPaused(sink, "no_budget");
      await nothingMoved(g);
    });
    it("the caps source the corrections use answers the same learning month", async () => {
      const g = learningGateway({ companyCaps: withLearning(6_000_000, 100_000_000) });
      expect(await g.learning.caps.capsFor(learningScope())).toEqual({ task: Number.MAX_SAFE_INTEGER, projectMonth: Number.MAX_SAFE_INTEGER, companyMonth: 6_000_000, combinedCompanyMonth: 100_000_000 });
    });
  });

  it("the learning month full: refused with monthly_limit, nothing sent", async () => {
    // Each call holds 10 input bytes-ish plus 10 output tokens; a ceiling just above one call's hold fits exactly one call.
    const g = learningGateway({ ceiling: 1_000 });
    expect((await learn(g.deps)).status).toBe(200);
    const spent = (await row(g.learningMeter, "company", learningScope()))!.spentMicros;
    const g2 = learningGateway({ ceiling: 1_000 });
    // Fill the learning month to the ceiling directly, then ask again.
    const r = await g2.learningMeter.reserve({ scope: learningScope(), caps: { task: Number.MAX_SAFE_INTEGER, projectMonth: Number.MAX_SAFE_INTEGER, companyMonth: 1_000, combinedCompanyMonth: 1_000_000_000 }, estimateMicros: 1_000 - spent + 1 });
    if (!r.ok) throw new Error("reserve"); await g2.learningMeter.settle(r.reservation, 1_000 - spent + 1);
    const sink = await learn(g2.deps);
    expect(sink.status).toBe(422);
    expectPaused(sink, "monthly_limit");
    expect(g2.learningCalls).toHaveLength(0);
  });

  it("the combined company cap full (agent spend): learning refused with no_budget although its own month has room", async () => {
    const g = learningGateway({ companyMonth: 100_000 });
    const a = await g.agentMeter.reserve({ scope: agentScope, caps: { ...agentCaps, companyMonth: 100_000 }, estimateMicros: 99_990 });
    if (!a.ok) throw new Error("reserve"); await g.agentMeter.settle(a.reservation, 99_990);
    const sink = await learn(g.deps);
    expect(sink.status).toBe(422);
    expectPaused(sink, "no_budget");
    expect(g.learningCalls).toHaveLength(0);
  });

  it("the combined cap full while the learning month only has other calls' holds: no_budget, not monthly_limit", async () => {
    const g = learningGateway({ companyMonth: 100_000, ceiling: 50_000 });
    const lcaps = { task: Number.MAX_SAFE_INTEGER, projectMonth: Number.MAX_SAFE_INTEGER, companyMonth: 50_000, combinedCompanyMonth: 100_000 };
    // An open learning hold fills the learning month by commitment (spent stays 0).
    const held = await g.learningMeter.reserve({ scope: { ...learningScope(), tid: "other" }, caps: lcaps, estimateMicros: 49_999 }); expect(held.ok).toBe(true);
    // Agent spend fills the combined company cap for good (a call settling above its hold, DEC 165).
    const a = await g.agentMeter.reserve({ scope: agentScope, caps: { ...agentCaps, companyMonth: 100_000 }, estimateMicros: 50_000 });
    if (!a.ok) throw new Error("reserve"); await g.agentMeter.settle(a.reservation, 99_995);
    const sink = await learn(g.deps);
    expectPaused(sink, "no_budget");
    expect(g.learningCalls).toHaveLength(0);
  });

  it("learning spend takes room the agent route then lacks (one combined total)", async () => {
    const g = learningGateway({ companyMonth: 100_000 });
    expect((await learn(g.deps)).status).toBe(200);
    const learned = (await row(g.agentMeter, "company", agentScope))!.spentMicros;
    expect(await g.agentMeter.reserve({ scope: agentScope, caps: { ...agentCaps, companyMonth: 100_000 }, estimateMicros: 100_000 - learned + 1 })).toEqual({ ok: false, reason: "cap", item: "company", held: false });
    expect((await g.agentMeter.reserve({ scope: agentScope, caps: { ...agentCaps, companyMonth: 100_000 }, estimateMicros: 100_000 - learned })).ok).toBe(true);
  });

  it("one call larger than the whole learning month: cost_too_high", async () => {
    const g = learningGateway({ ceiling: 10 });
    const sink = await learn(g.deps);
    expect(sink.status).toBe(422);
    expectPaused(sink, "cost_too_high");
    await nothingMoved(g);
  });

  it("a company with no monthly cap (company backend default): no_budget, nothing held", async () => {
    const g = learningGateway({ companyCaps: { capsFor: async () => ({}) as Caps } });
    const sink = await learn(g.deps);
    expectPaused(sink, "no_budget");
    await nothingMoved(g);
  });

  it("fail closed: a learning meter that does not combine with the agent meter holds nothing (503)", async () => {
    const g = learningGateway({ combined: false });
    const sink = await learn(g.deps);
    expect(sink.status).toBe(503);
    await nothingMoved(g);
  });

  it("refuses a ceiling that is not a positive whole number of micro-dollars", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => createLearningRoutes({ keys: new CustomerKeys(), meter: new InMemoryMeter(), companyCaps: new FixedCapsSource(agentCaps), lessons: new Switches(), modelLimits: { maxOutputTokens: () => 1 }, transport: async () => { throw new Error(); }, monthCeilingMicros: bad })).toThrow();
    }
  });

  it("the caps source for corrections answers the same learning caps, and refuses (invalid caps) without a company cap", async () => {
    const g = learningGateway({ companyMonth: 7_000_000 });
    expect(await g.learning.caps.capsFor(learningScope())).toEqual({ task: Number.MAX_SAFE_INTEGER, projectMonth: Number.MAX_SAFE_INTEGER, companyMonth: 7_000_000, combinedCompanyMonth: 7_000_000 });
    const none = learningGateway({ companyCaps: { capsFor: async () => ({}) as Caps } });
    expect(Object.keys(await none.learning.caps.capsFor(learningScope()))).toEqual([]);
    // Budgets with no company monthly cap (valid caps otherwise): still no learning caps, never a NaN or uncapped month.
    const uncapped = learningGateway({ companyCaps: new FixedCapsSource({ task: 1_000, projectMonth: 1_000 }) });
    expect(Object.keys(await uncapped.learning.caps.capsFor(learningScope()))).toEqual([]);
    expectPaused(await learn(uncapped.deps), "no_budget");
    await nothingMoved(uncapped);
  });
});

describe("learning class: the one company overrun marker (DEC 228c)", () => {
  const marker = { deadlineSeconds: now / 1000 + 60, tokenExpiresSeconds: now / 1000 + 900 };
  const unknownPrices = { priceFor: () => undefined };
  it("an overrun-capable learning call waits behind an agent call holding the company marker, and takes it from the agent route when free", async () => {
    const g = learningGateway({ overrides: { prices: unknownPrices } });
    const a = await g.agentMeter.reserve({ scope: agentScope, caps: agentCaps, estimateMicros: 10, overrun: marker }); if (!a.ok) throw new Error("reserve");
    const busy = await learn(g.deps);
    expect(busy.status).toBe(429);
    expect(error(busy).type).toBe("busy");
    expect(g.learningCalls).toHaveLength(0);
    await g.agentMeter.settle(a.reservation, 10);
    // While a learning call holds the marker, the agent route's overrun-capable call is busy.
    const held = await g.learningMeter.reserve({ scope: learningScope(), caps: { task: Number.MAX_SAFE_INTEGER, projectMonth: Number.MAX_SAFE_INTEGER, companyMonth: 20_000_000, combinedCompanyMonth: 1_000_000_000 }, estimateMicros: 10, overrun: marker });
    if (!held.ok) throw new Error("reserve");
    expect(await g.agentMeter.reserve({ scope: agentScope, caps: agentCaps, estimateMicros: 10, overrun: marker })).toEqual({ ok: false, reason: "busy", overrunInFlight: true });
    await g.learningMeter.settle(held.reservation, 10);
    expect((await learn(g.deps)).status).toBe(200);
  });

  it("the product meter, the learning meter and the agent meter share one company row and one marker", async () => {
    const agent = new InMemoryMeter(() => now);
    const product = new InMemoryMeter(() => now, undefined, undefined, { combineCompanyWith: agent });
    const learning = new InMemoryMeter(() => now, undefined, undefined, { combineCompanyWith: agent });
    const c = (combined: number) => ({ task: 1_000_000, projectMonth: 1_000_000, companyMonth: 1_000_000, combinedCompanyMonth: combined });
    const p = await product.reserve({ scope: learningScope(), caps: c(100), estimateMicros: 60 }); expect(p.ok).toBe(true);
    expect(await learning.reserve({ scope: learningScope(), caps: c(100), estimateMicros: 41 })).toEqual({ ok: false, reason: "cap", item: "company", held: true });
    expect((await learning.reserve({ scope: learningScope(), caps: c(100), estimateMicros: 40 })).ok).toBe(true);
    expect((await agent.read(agentScope)).find((r) => r.item === "company")).toMatchObject({ committed: 100 });
    const lp = await product.reserve({ scope: { ...learningScope(), tid: "t2" }, caps: c(1_000), estimateMicros: 1, overrun: marker }); expect(lp.ok).toBe(true);
    expect(await learning.reserve({ scope: learningScope(), caps: c(1_000), estimateMicros: 1, overrun: marker })).toEqual({ ok: false, reason: "busy", overrunInFlight: true });
  });
});

describe("learning class: two companies stay apart", () => {
  it("each company uses only its own key, its own learning month and its own switch", async () => {
    const g = learningGateway({ ceiling: 1_000 });
    // Company A's learning month is used up; company B has room.
    const r = await g.learningMeter.reserve({ scope: learningScope(cidA), caps: { task: Number.MAX_SAFE_INTEGER, projectMonth: Number.MAX_SAFE_INTEGER, companyMonth: 1_000, combinedCompanyMonth: 1_000_000_000 }, estimateMicros: 1_000 });
    if (!r.ok) throw new Error("reserve"); await g.learningMeter.settle(r.reservation, 1_000);
    expectPaused(await learn(g.deps, { cid: cidA }), "monthly_limit");
    const b = await learn(g.deps, { cid: cidB });
    expect(b.status).toBe(200);
    expect(g.learningCalls.map((c) => c.key)).toEqual([keyOf(cidB)]);
    expect(g.customer.used).toEqual([cidB]);
    // B's spend lands on B's rows only.
    expect((await row(g.learningMeter, "company", learningScope(cidA)))!.spentMicros).toBe(1_000);
    expect((await row(g.learningMeter, "company", learningScope(cidB)))!.spentMicros).toBeGreaterThan(0);
    // A's combined company row holds A's learning spend only.
    expect((await row(g.agentMeter, "company", { ...agentScope, cid: cidA }))!.committed).toBe(1_000);
    expect((await row(g.agentMeter, "company", { ...agentScope, cid: cidB }))!.spentMicros).toBeGreaterThan(0);
    // B switched off: B is refused, A's refusal stays its own reason.
    g.switches.on.delete(cidB);
    expectPaused(await learn(g.deps, { cid: cidB }), "lessons_off");
    expectPaused(await learn(g.deps, { cid: cidA }), "monthly_limit");
    // A has no key connected: A is refused for that; B's key is never offered to A.
    g.customer.connectedTo.delete(cidA);
    expectPaused(await learn(g.deps, { cid: cidA }), "no_provider");
    expect(g.learningCalls.map((c) => c.key)).toEqual([keyOf(cidB)]);
  });
});
