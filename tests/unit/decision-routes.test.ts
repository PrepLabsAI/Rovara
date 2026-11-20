// Decisions D2: the card routes enforce the friction on the server. A medium card cannot be approved without its evidence opened as it is shown now (409), a high card has no approve route,
// nothing is bulk, and the routes decide nothing themselves: they call the existing endpoint through the performer and report what it really answered.
/* eslint-disable @typescript-eslint/no-unsafe-assignment -- vitest's expect.* matchers are typed any */
import { describe, expect, it, vi } from "vitest";
import { DecisionCardsViewSchema, DecisionNeedsConfirmationSchema } from "@agentx/contracts";
import { routeDecisionCards, type DecisionCaller, type DecisionPerformer, type DecisionRequest, type DecisionSources, type PerformOutcome } from "../../packages/broker/src/core/decisions/routes.js";
import { decisionCardPath, type DecisionItem, type ItemBase } from "../../packages/broker/src/core/decisions/project.js";
import { inMemoryDecisionStore } from "../../packages/broker/src/core/decisions/store.js";
import { summarizeDecisionMeasures, type DecisionMeasure } from "../../packages/broker/src/core/decisions/measures.js";

const TASK = "11111111-1111-4111-8111-111111111111";
const ME: DecisionCaller = { orgId: "org1", developerId: "dev1" };
const OTHER: DecisionCaller = { orgId: "org1", developerId: "dev2" };
const REQ = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const base = (id: string, extra: Partial<ItemBase> = {}): ItemBase => ({ subjectId: id, taskId: TASK, project: "payments", title: "Retry failed payments", createdAt: "2026-10-30T10:00:00.000Z", contentVersion: "v1", openPath: `/app/sessions/ses_${"a".repeat(20)}`, ...extra });
const low = (): DecisionItem => ({ ...base("plan1"), kind: "approve_plan", path: "quick", files: ["src/retry.ts"], claims: 2, untestedClaims: 0 });
const medium = (): DecisionItem => ({ ...base("dep1"), kind: "approve_dependency", packages: 2, newInstallScripts: false });
const high = (): DecisionItem => ({ ...base("set1"), kind: "approve_setting", settingLabel: "Allow video", secondPerson: false });
const requirements = (): DecisionItem => ({ ...base("req1"), kind: "approve_requirements", claims: 3 });
const design = (): DecisionItem => ({ ...base("des1"), kind: "approve_design", files: ["src/a.ts"] });
const DONE: PerformOutcome = { kind: "done" };

function setup(items: DecisionItem[] = [low(), medium(), high()], now = { ms: Date.parse("2026-10-30T10:05:00.000Z") }) {
  const state = { items };
  const sources: DecisionSources = { list: vi.fn(async (caller: DecisionCaller) => (caller.developerId === "dev1" ? state.items : [])), locks: async () => ({}) };
  const performer = { approve: vi.fn(async (): Promise<PerformOutcome> => DONE), reject: vi.fn(async (): Promise<PerformOutcome> => DONE) } satisfies DecisionPerformer;
  const store = inMemoryDecisionStore(() => now.ms);
  const measures: DecisionMeasure[] = [];
  const deps = { sources, performer, store, now: () => now.ms, log: (measure: DecisionMeasure) => { measures.push(measure); } };
  const call = (caller: DecisionCaller, method: string, pathname: string, body: unknown = undefined, query = ""): Promise<Awaited<ReturnType<typeof routeDecisionCards>>> =>
    routeDecisionCards(deps, caller, { method, pathname, searchParams: new URLSearchParams(query), body } satisfies DecisionRequest);
  const path = (cardId: string, action: string) => `${decisionCardPath(cardId)}/${action}`;
  /** The digest the caller is shown now, as a client reads it. */
  const shown = async (cardId: string, caller: DecisionCaller = ME) => DecisionCardsViewSchema.parse((await call(caller, "GET", "/v1/app/decisions"))?.body).digests[cardId]!;
  const open = async (cardId: string, query = "", digest?: string) => call(ME, "POST", path(cardId, "evidence-opened"), { requestId: REQ(900), shownDigest: digest ?? await shown(cardId) }, query);
  const approve = async (cardId: string, n: number, extra: Record<string, unknown> = {}, digest?: string) => call(ME, "POST", path(cardId, "approve"), { requestId: REQ(n), shownDigest: digest ?? await shown(cardId), ...extra });
  return { state, sources, performer, store, measures, deps, call, path, now, shown, open, approve };
}

describe("GET /v1/app/decisions", () => {
  it("answers undefined for a path or method it does not own", async () => {
    const t = setup();
    expect(await t.call(ME, "GET", "/v1/app/home")).toBeUndefined();
    expect(await t.call(ME, "POST", "/v1/app/decisions", { ids: ["a"] })).toBeUndefined();
    expect(await t.call(ME, "POST", "/v1/app/decisions/approve-all", {})).toBeUndefined();
    expect(await t.call(ME, "GET", "/v1/app/decisions/approve_plan/plan1/approve")).toBeUndefined();
  });
});

describe("a low-risk card is one request", () => {
  it("still refuses an approve without the digest it was shown", async () => {
    const t = setup();
    await expect(t.call(ME, "POST", t.path("approve_plan:plan1", "approve"), { requestId: REQ(2) })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(t.approve("approve_plan:plan1", 3, {}, "0".repeat(64))).rejects.toMatchObject({ code: "CHANGE_STALE" });
    expect(t.performer.approve).not.toHaveBeenCalled();
  });
});

describe("a medium card cannot be approved until the evidence it was shown was opened", () => {
  it("I1: a stale view cannot create a fresh record: evidence-opened with the digest of an older version is 409 and records nothing", async () => {
    const t = setup();
    const oldDigest = await t.shown("approve_dependency:dep1");
    t.state.items = [{ ...medium(), packages: 9 } as DecisionItem, low(), high()];
    await expect(t.open("approve_dependency:dep1", "", oldDigest)).rejects.toMatchObject({ code: "CHANGE_STALE" });
    // The current digest was never recorded either, so even approving with it is refused.
    await expect(t.approve("approve_dependency:dep1", 6)).rejects.toMatchObject({ code: "CHANGE_STALE" });
    expect(t.performer.approve).not.toHaveBeenCalled();
  });
});

describe("a high card has no approve route", () => {
  it("answers 404 to approve, evidence-opened and reject, and never calls the performer", async () => {
    const t = setup();
    await expect(t.approve("approve_setting:set1", 12)).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    await expect(t.open("approve_setting:set1")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(t.call(ME, "POST", t.path("approve_setting:set1", "reject"), { requestId: REQ(13), reason: "not_now" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(t.performer.approve).not.toHaveBeenCalled();
    expect(t.performer.reject).not.toHaveBeenCalled();
  });
});

describe("nothing is bulk and only the caller's own cards exist", () => {
  it("refuses a body that names several cards", async () => {
    const t = setup();
    const digest = await t.shown("approve_plan:plan1");
    await expect(t.call(ME, "POST", t.path("approve_plan:plan1", "approve"), { requestId: REQ(15), shownDigest: digest, ids: ["approve_plan:plan1", "approve_dependency:dep1"] })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(t.call(ME, "POST", t.path("approve_plan:plan1", "approve"), { requestId: REQ(15), shownDigest: digest, cardIds: [] })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(t.performer.approve).not.toHaveBeenCalled();
  });
  it("answers 404 for a card that is not in the caller's list (another person's, gone, or malformed)", async () => {
    const t = setup();
    const digest = await t.shown("approve_plan:plan1");
    await expect(t.call(OTHER, "POST", t.path("approve_plan:plan1", "approve"), { requestId: REQ(16), shownDigest: digest })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(t.call(ME, "POST", t.path("approve_plan:nope", "approve"), { requestId: REQ(17), shownDigest: digest })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(t.call(ME, "POST", "/v1/app/decisions/not_a_kind/x1/approve", { requestId: REQ(18), shownDigest: digest })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await t.call(ME, "POST", "/v1/app/decisions/%E0%A4%A/approve", { requestId: REQ(18) })).toBeUndefined();
    expect(await t.call(ME, "POST", "/v1/app/decisions/not-a-card/approve", { requestId: REQ(18) })).toBeUndefined();
    expect(t.performer.approve).not.toHaveBeenCalled();
  });
  it("a failure to write history or a measure never turns a made decision into an error", async () => {
    const t = setup();
    t.deps.store.recordDecision = async () => { throw new Error("table down"); };
    t.deps.log = () => { throw new Error("log down"); };
    expect((await t.approve("approve_plan:plan1", 21))?.statusCode).toBe(200);
  });
});

describe("I7: the card reports what the existing endpoint really answered", () => {
  it("a performer that needs the confirmation page gives 202 needs_confirmation, records no decision and emits no measure", async () => {
    const t = setup();
    t.performer.approve.mockResolvedValueOnce({ kind: "needs_confirmation", confirmUrl: "https://cell.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa" });
    const reply = await t.approve("approve_plan:plan1", 22);
    expect(reply?.statusCode).toBe(202);
    expect(DecisionNeedsConfirmationSchema.parse(reply?.body)).toMatchObject({ outcome: "needs_confirmation" });
    expect(t.store.decisions).toHaveLength(0);
    expect(t.measures).toHaveLength(0);
  });
  it("M4: a retry of a finished approve gets the earlier answer, not 'no longer waiting'; the same request id for another change is refused", async () => {
    const t = setup();
    await t.approve("approve_plan:plan1", 24);
    t.state.items = [high()];
    const again = await t.call(ME, "POST", t.path("approve_plan:plan1", "approve"), { requestId: REQ(24), shownDigest: "0".repeat(64) });
    expect(again?.body).toEqual({ cardId: "approve_plan:plan1", outcome: "approved", remainingTabs: [] });
    expect(t.performer.approve).toHaveBeenCalledTimes(1);
    await expect(t.call(ME, "POST", t.path("approve_plan:plan1", "reject"), { requestId: REQ(24), reason: "not_now" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("reject", () => {
  it("refuses an unknown reason", async () => {
    const t = setup();
    await expect(t.call(ME, "POST", t.path("approve_plan:plan1", "reject"), { requestId: REQ(23), reason: "because" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("Full path: one card, two tabs, two recorded approvals (I6)", () => {
  const pair = () => [requirements(), design()];
  const id = "approve_requirements:req1";
  it("needs the tab named; the design cannot be approved before the requirements", async () => {
    const t = setup(pair());
    await expect(t.approve(id, 30)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(t.approve(id, 31, { tab: "design" })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("requirements first") });
    expect(t.performer.approve).not.toHaveBeenCalled();
  });
  it("a medium pair needs each tab's evidence opened, tab by tab", async () => {
    const t = setup([requirements(), { ...design(), files: ["src/auth/login.ts"] } as DecisionItem]);
    await expect(t.approve(id, 35, { tab: "requirements" })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    await t.open(id, "tab=requirements");
    expect((await t.approve(id, 36, { tab: "requirements" }))?.statusCode).toBe(200);
  });
  it("refuses a tab on an ordinary card", async () => {
    const t = setup();
    await expect(t.approve("approve_plan:plan1", 37, { tab: "design" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("measures", () => {
  it("count decisions per person per day and the median time to decide", async () => {
    const t = setup();
    await t.approve("approve_plan:plan1", 40);
    t.now.ms += 100_000;
    await t.call(ME, "POST", t.path("approve_dependency:dep1", "reject"), { requestId: REQ(41), reason: "not_now" });
    const summary = summarizeDecisionMeasures(t.measures);
    expect(Object.values(summary.perPersonPerDay)).toEqual([2]);
    expect(summary.medianSeconds).toBe(350);
    expect(JSON.stringify(t.measures)).not.toContain("dev1");
  });
});

describe("money fix round 2: a reason is taken only on a design card (N11)", () => {
  it("refuses a reason on every other kind before the performer is called, and hands it to the performer on a design card", async () => {
    const t = setup([low(), medium(), design()]);
    for (const [cardId, n] of [["approve_plan:plan1", 1], ["approve_dependency:dep1", 2]] as const) {
      await expect(t.approve(cardId, n, { reason: "because" })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("this card takes no reason") });
    }
    expect(t.performer.approve).not.toHaveBeenCalled();
    expect(t.store.decisions).toHaveLength(0);
    // control: the same cards without a reason are approved as before, and a design card passes its reason on
    expect((await t.approve("approve_plan:plan1", 3))?.statusCode).toBe(200);
    await t.open("approve_design:des1");
    expect((await t.approve("approve_design:des1", 4, { reason: "Tracked in the follow-up." }))?.statusCode).toBe(200);
    const calls = t.performer.approve.mock.calls as unknown as Array<[DecisionCaller, { item: { kind: string }; reason?: string }]>;
    expect(calls.map(([, input]) => [input.item.kind, input.reason])).toEqual([["approve_plan", undefined], ["approve_design", "Tracked in the follow-up."]]);
  });
});
