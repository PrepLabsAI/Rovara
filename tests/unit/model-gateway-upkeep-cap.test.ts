// Lead 4 L4-E (DEC 254z(2)): nightly upkeep's per-project monthly cap. AI the agent route is asked for with a token whose origin (`src`) is "nightly" is held
// to the project's upkeep limit BEFORE the call (reserve first), as one more meter row on top of the task, person, project and company rows, so it can only
// tighten. $0 or no limit source means no upkeep spend. Calls of any other origin never meet the upkeep row.
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { beforeAll, describe, expect, it } from "vitest";
import { FixedCapsSource, type Caps } from "../../packages/model-gateway/src/caps.js";
import { CompanyUpkeepLimits } from "../../packages/model-gateway/src/company-caps.js";
import type { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import type { MeterScope } from "../../packages/model-gateway/src/meter.js";
import { UPKEEP_DEFAULT_MONTH_MICROS, UPKEEP_PAUSE_HEADER, UPKEEP_PAUSE_MESSAGES, type UpkeepLimits } from "../../packages/model-gateway/src/upkeep-cap.js";
import type { MemorySink} from "./model-gateway-fixture.js";
import { call, caps as baseCaps, claims, mint, scope as agentScope, setup } from "./model-gateway-fixture.js";

const cidA = claims.cid;
const cidB = `org_${"b".repeat(20)}`;
const nightly = { src: "nightly" } as const;

/** Each project's own upkeep limit as the table would read it: a number, undefined (none), null (does not read), or a throw. */
class Limits implements UpkeepLimits {
  readonly byProject = new Map<string, number | null | undefined>();
  fail = false;
  reads: string[] = [];
  async limitFor(cid: string, pid: string): Promise<number | null | undefined> { this.reads.push(`${cid}/${pid}`); if (this.fail) throw new Error("down"); return this.byProject.get(`${cid}/${pid}`); }
}
function gateway(options: { caps?: Partial<Caps>; noLimits?: boolean } = {}) {
  const limits = new Limits();
  const keyReads: string[] = [];
  const base = setup({
    caps: new FixedCapsSource({ ...baseCaps, ...options.caps }),
    keys: { keyFor: async (c) => { keyReads.push(`${c.cid}/${c.pid}`); return "rovara-install-key"; } },
    ...(options.noLimits === true ? {} : { upkeep: limits }),
  });
  return { ...base, limits, keyReads };
}
const sc = (cid = cidA, pid = "web"): MeterScope => ({ ...agentScope, cid, pid });
const row = async (g: ReturnType<typeof gateway>, item: string, s: MeterScope, upkeep = false) => (await g.meter.read(s, upkeep ? { upkeep: true } : undefined)).find((r) => r.item === item);
const error = (sink: MemorySink) => (JSON.parse(sink.text()) as { error: { type: string; message: string } }).error;
const expectPaused = (sink: MemorySink, reason: keyof typeof UPKEEP_PAUSE_MESSAGES) => {
  expect(sink.status).toBe(reason === "no_budget" || reason === "cost_too_high" || reason === "monthly_limit" ? 422 : 0);
  expect(error(sink)).toEqual({ type: "upkeep_paused", message: UPKEEP_PAUSE_MESSAGES[reason] });
  expect(sink.headers[UPKEEP_PAUSE_HEADER]).toBe(reason);
};
/** What one call holds and finally costs (a probe run on a fresh gateway). */
async function oneCall() {
  const g = gateway();
  let estimate = 0;
  const reserve = g.meter.reserve.bind(g.meter);
  g.meter.reserve = async (input) => { estimate = input.estimateMicros; return reserve(input); };
  await call(g.deps);
  return { estimate, spent: (await row(g, "project", sc()))!.spentMicros };
}

describe("upkeep cap: which calls it applies to", () => {
  it("a call of nightly origin holds the project's upkeep row in addition to its other rows, and its spend counts in all of them", async () => {
    const g = gateway(); g.limits.byProject.set(`${cidA}/web`, 9_000_000);
    let seen: Caps | undefined;
    const reserve = g.meter.reserve.bind(g.meter);
    g.meter.reserve = async (input) => { seen = input.caps; return reserve(input); };
    expect((await call(g.deps, undefined, mint(nightly))).status).toBe(200);
    expect(seen).toMatchObject({ upkeepMonth: 9_000_000 });
    const spent = (await row(g, "upkeep", sc(), true))!.spentMicros;
    expect(spent).toBeGreaterThan(0);
    // The same call counts in the project, person and company rows too: the upkeep cap folds in, never replaces them.
    for (const item of ["project", "person", "company", "task"]) expect((await row(g, item, sc()))!.spentMicros, item).toBe(spent);
  });

  it("any other origin (none, or app, schedule, automatic ...) never meets the upkeep row, never reads the limit, and is not limited by it", async () => {
    const g = gateway(); g.limits.byProject.set(`${cidA}/web`, 0);
    for (const src of [undefined, "app", "schedule", "automatic", "chain", "event"]) {
      const sink = await call(g.deps, undefined, mint(src === undefined ? {} : { src }));
      expect(sink.status, String(src)).toBe(200);
    }
    expect(g.limits.reads).toEqual([]);
    expect((await row(g, "upkeep", sc(), true))!.spentMicros).toBe(0);
  });

  it("only the agent route: the upkeep cap is not added to a call that is not a task-token agent call (golden: the route still works with no upkeep wired for other origins)", async () => {
    const g = gateway({ noLimits: true });
    expect((await call(g.deps)).status).toBe(200);
  });
});

describe("upkeep cap: refused BEFORE the call", () => {
  it("a limit of $0 means no upkeep spend: paused no_budget, no key read, nothing sent, nothing held", async () => {
    const g = gateway(); g.limits.byProject.set(`${cidA}/web`, 0);
    const sink = await call(g.deps, undefined, mint(nightly));
    expectPaused(sink, "no_budget");
    expect(g.keyReads).toEqual([]);
    expect(g.calls).toHaveLength(0);
    for (const r of await g.meter.read(sc(), { upkeep: true })) expect(r.committed, r.item).toBe(0);
  });

  it("no limit source wired: an upkeep call is paused with no_budget (nothing spends unattended without an enforced cap)", async () => {
    const g = gateway({ noLimits: true });
    const sink = await call(g.deps, undefined, mint(nightly));
    expectPaused(sink, "no_budget");
    expect(g.keyReads).toEqual([]);
    expect(g.calls).toHaveLength(0);
  });

  it("with no limit of its own the project gets the default ($25), not no limit", async () => {
    expect(UPKEEP_DEFAULT_MONTH_MICROS).toBe(25_000_000);
    const g = gateway();
    let seen: Caps | undefined;
    const reserve = g.meter.reserve.bind(g.meter);
    g.meter.reserve = async (input) => { seen = input.caps; return reserve(input); };
    expect((await call(g.deps, undefined, mint(nightly))).status).toBe(200);
    expect(seen?.upkeepMonth).toBe(25_000_000);
  });

  it("the limit is reserved before every call: the month fills, the next call is paused monthly_limit and its key is never read", async () => {
    const { estimate, spent } = await oneCall();
    const g = gateway(); g.limits.byProject.set(`${cidA}/web`, spent * 2 + (estimate - spent));
    expect((await call(g.deps, undefined, mint(nightly))).status).toBe(200);
    expect((await call(g.deps, undefined, mint(nightly))).status).toBe(200);
    const keyReadsBefore = g.keyReads.length, callsBefore = g.calls.length;
    const third = await call(g.deps, undefined, mint(nightly));
    expectPaused(third, "monthly_limit");
    expect(g.keyReads).toHaveLength(keyReadsBefore);
    expect(g.calls).toHaveLength(callsBefore);
    expect((await row(g, "upkeep", sc(), true))!.spentMicros).toBe(spent * 2);
    // Attended work in the same project is untouched by the upkeep pause.
    expect((await call(g.deps)).status).toBe(200);
  });

  it("one call too large for the whole limit is cost_too_high", async () => {
    const g = gateway(); g.limits.byProject.set(`${cidA}/web`, 1);
    expectPaused(await call(g.deps, undefined, mint(nightly)), "cost_too_high");
    expect(g.calls).toHaveLength(0);
  });

  it("an upkeep limit that does not read refuses (503), nothing sent; a failed read answers an error and sends nothing", async () => {
    const g = gateway(); g.limits.byProject.set(`${cidA}/web`, null);
    const sink = await call(g.deps, undefined, mint(nightly));
    expect(sink.status).toBe(503);
    expect(error(sink)).toEqual({ type: "unavailable", message: "model access unavailable" });
    expect(g.keyReads).toEqual([]);
    const broken = gateway(); broken.limits.fail = true;
    const failed = await call(broken.deps, undefined, mint(nightly));
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(broken.keyReads).toEqual([]);
    expect(broken.calls).toHaveLength(0);
  });
});

describe("upkeep cap: it can only tighten", () => {
  it("a limit above the project's own monthly cap changes nothing: the project cap still refuses (upkeep spend counts in the project row)", async () => {
    const { estimate, spent } = await oneCall();
    const g = gateway({ caps: { projectMonth: spent + (estimate - spent) } });
    g.limits.byProject.set(`${cidA}/web`, 900_000_000);
    expect((await call(g.deps, undefined, mint(nightly))).status).toBe(200);
    const second = await call(g.deps, undefined, mint(nightly));
    expect(second.status).toBe(422);
    expect(error(second).type).toBe("budget_exceeded");
    expect(g.calls).toHaveLength(1);
  });

  it("a limit above the company's monthly cap changes nothing: the company cap still refuses", async () => {
    const { estimate, spent } = await oneCall();
    const g = gateway({ caps: { companyMonth: spent + (estimate - spent) } });
    g.limits.byProject.set(`${cidA}/web`, 900_000_000);
    expect((await call(g.deps, undefined, mint(nightly))).status).toBe(200);
    expect((await call(g.deps, undefined, mint(nightly))).status).toBe(422);
    expect(g.calls).toHaveLength(1);
  });

  it("upkeep spend uses up the project's and company's month for attended work too (the rows are shared)", async () => {
    const { estimate, spent } = await oneCall();
    const g = gateway({ caps: { projectMonth: spent + (estimate - spent) } });
    g.limits.byProject.set(`${cidA}/web`, 900_000_000);
    expect((await call(g.deps, undefined, mint(nightly))).status).toBe(200);
    expect((await call(g.deps)).status).toBe(422);
  });

  it("a high upkeep limit never raises what a call is held to: the caps the meter sees keep every other cap as the source gave it", async () => {
    const g = gateway(); g.limits.byProject.set(`${cidA}/web`, 900_000_000);
    let seen: Caps | undefined;
    const reserve = g.meter.reserve.bind(g.meter);
    g.meter.reserve = async (input) => { seen = input.caps; return reserve(input); };
    await call(g.deps, undefined, mint(nightly));
    expect(seen).toMatchObject({ task: baseCaps.task, projectMonth: baseCaps.projectMonth, personMonth: baseCaps.personMonth, companyMonth: baseCaps.companyMonth });
  });
});

describe("upkeep cap: two projects, two companies", () => {
  it("each project has its own upkeep row and limit: one project's pause never pauses another's", async () => {
    const { estimate, spent } = await oneCall();
    const g = gateway();
    g.limits.byProject.set(`${cidA}/web`, estimate); g.limits.byProject.set(`${cidA}/api`, estimate * 5);
    expect((await call(g.deps, undefined, mint(nightly))).status).toBe(200);
    expectPaused(await call(g.deps, undefined, mint(nightly)), "monthly_limit");
    for (let i = 0; i < 3; i++) expect((await call(g.deps, undefined, mint({ ...nightly, pid: "api" }))).status).toBe(200);
    expect((await row(g, "upkeep", sc(cidA, "web"), true))!.spentMicros).toBe(spent);
    expect((await row(g, "upkeep", sc(cidA, "api"), true))!.spentMicros).toBe(spent * 3);
    expect(g.limits.reads.filter((r) => r === `${cidA}/api`)).toHaveLength(3);
  });

  it("each company has its own upkeep row: the same project name in two companies never shares a limit or a row", async () => {
    const { estimate, spent } = await oneCall();
    const g = gateway();
    g.limits.byProject.set(`${cidA}/web`, estimate); g.limits.byProject.set(`${cidB}/web`, estimate * 5);
    expect((await call(g.deps, undefined, mint(nightly))).status).toBe(200);
    expectPaused(await call(g.deps, undefined, mint(nightly)), "monthly_limit");
    for (let i = 0; i < 3; i++) expect((await call(g.deps, undefined, mint({ ...nightly, cid: cidB }))).status).toBe(200);
    expect((await row(g, "upkeep", sc(cidA), true))!.spentMicros).toBe(spent);
    expect((await row(g, "upkeep", sc(cidB), true))!.spentMicros).toBe(spent * 3);
  });
});

describe("CompanyUpkeepLimits reads the project's own upkeep_month item, strongly consistent and fail closed", () => {
  const item = (more: Record<string, unknown> = {}) => ({ pk: `COMPANY#${cidA}`, sk: "SPEND_LIMIT#UPKEEP#web", companyId: cidA, kind: "upkeep_month", id: "web", monthlyUsdMicros: 7_000_000, version: 1, updatedAt: "2026-11-17T12:00:00.000Z", updatedBy: "d".repeat(64), ...more });
  const fakeDb = (stored: Record<string, unknown> | undefined, seen: unknown[] = []) => ({ get: async (table: string, key: unknown, options: unknown) => { seen.push({ table, key, options }); return stored; } }) as unknown as Dynamo;
  it("reads exactly this company's item for this project by key; none when there is no item", async () => {
    const seen: unknown[] = [];
    expect(await new CompanyUpkeepLimits(fakeDb(item(), seen), "companies").limitFor(cidA, "web")).toBe(7_000_000);
    expect(seen).toEqual([{ table: "companies", key: { pk: `COMPANY#${cidA}`, sk: "SPEND_LIMIT#UPKEEP#web" }, options: { consistent: true } }]);
    expect(await new CompanyUpkeepLimits(fakeDb(undefined), "companies").limitFor(cidA, "web")).toBeUndefined();
  });
  it.each([["another company's item", { companyId: cidB }], ["another kind", { kind: "project_month" }], ["another project", { id: "api" }], ["a fraction", { monthlyUsdMicros: 1.5 }], ["no version", { version: 0 }]])("null (the call is refused) for %s", async (_name, change) => {
    expect(await new CompanyUpkeepLimits(fakeDb(item(change)), "companies").limitFor(cidA, "web")).toBeNull();
  });
  it("null for a malformed project or company id without a read; a failed read throws", async () => {
    const seen: unknown[] = [];
    const limits = new CompanyUpkeepLimits(fakeDb(item(), seen), "companies");
    expect(await limits.limitFor(cidA, "Web!")).toBeNull();
    expect(await limits.limitFor("org_X", "web")).toBeNull();
    expect(seen).toEqual([]);
    await expect(new CompanyUpkeepLimits({ get: async () => { throw new Error("down"); } } as unknown as Dynamo, "companies").limitFor(cidA, "web")).rejects.toThrow();
  });
});
