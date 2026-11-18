// Lessons phase 1, the weekly list in bands (research Q4): need-a-look first and not counted; then a person's direct correction, a measured result, a weak source seen twice; inside a band independent people, "would have applied to
// N tasks", severity, about to lapse; at most 2 per area and per source; a noisy source one band lower; a reason line per row. Golden cases, one per band and per rule.
import { describe, expect, it } from "vitest";
import { buildWeeklyDigest } from "../../../packages/broker/src/lessons/digest.js";
import { areaLabelOf, bandOf, orderWeekly, sourceKeptRates, sourceOf, wouldHaveApplied } from "../../../packages/broker/src/lessons/weekly-order.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import type { Lesson } from "../../../packages/broker/src/lessons/types.js";
import { LessonsDigestSchema } from "@agentx/contracts";
import { buildLessonsDigest } from "../../../packages/broker/src/lessons/view.js";
import { Clock, KEY, allowAllAccess, directory, draft, lessonRecord, seed, settings } from "./lesson-helpers.js";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const prov = (over: Partial<Lesson["provenance"]>): Lesson["provenance"] => ({ ...draft().provenance, ...over });
/** A suggestion waiting for a person. Defaults: a direct correction by one person, seen in two tasks. */
const pending = (id: string, over: Partial<Lesson> & { p?: Partial<Lesson["provenance"]> } = {}): Lesson => {
  const { p, ...rest } = over;
  return lessonRecord({
    id, status: "pending", approvals: [], tier: 1, type: "convention", scope: { repos: ["api"], paths: [`src/${id}/**`] }, createdAt: NOW - 3 * DAY, updatedAt: NOW - DAY, pendingExpiresAt: NOW + 6 * DAY,
    provenance: prov({ memberSignal: true, measured: false, authors: ["ann"], supportTasks: ["t1", "t2"], sources: [`member:${id}`], sourceKinds: ["remembered"], ...p }), ...rest,
  });
};
const weak = (id: string, over: Partial<Lesson> & { p?: Partial<Lesson["provenance"]> } = {}) => pending(id, { ...over, p: { memberSignal: false, memberCorrection: false, measured: false, sourceKinds: ["pr_comment"], ...over.p } });
const measured = (id: string, over: Partial<Lesson> & { p?: Partial<Lesson["provenance"]> } = {}) => pending(id, { ...over, p: { memberSignal: false, measured: true, sourceKinds: ["ci_failure"], ...over.p } });
const picks = (lessons: Lesson[], extras = {}) => orderWeekly({ lessons, now: NOW, extras }).picks.map((r) => r.id);

describe("the bands", () => {
  it("band 1: a person's direct correction ranks above a measured result, which ranks above a weak source seen twice (golden)", () => {
    const list = [weak("les_weak0001"), measured("les_meas0001"), pending("les_dire0001")];
    expect(picks(list)).toEqual(["les_dire0001", "les_meas0001", "les_weak0001"]);
    expect(bandOf(list[2]!)).toBe("direct_correction");
    expect(bandOf(list[1]!)).toBe("measured");
    expect(bandOf(list[0]!)).toBe("weak_twice");
  });

  it("the measured-first order of the old weekly list is replaced: a measured result no longer outranks a person's correction", () => {
    const strongMeasured = measured("les_meas0001", { p: { supportTasks: ["a", "b", "c", "d"] } });
    expect(picks([strongMeasured, pending("les_dire0001")])).toEqual(["les_dire0001", "les_meas0001"]);
  });

  it("inside a band the first difference decides: independent people, then tasks, then 'would have applied', then severity, then about to lapse, then newest, oldest, id (golden)", () => {
    const two = pending("les_ppl20001", { p: { authors: ["ann", "bob"], sources: ["member:a", "member:b"] } });
    const one = pending("les_ppl10001");
    expect(picks([one, two])).toEqual(["les_ppl20001", "les_ppl10001"]);
    const manyTasks = pending("les_tsk30001", { p: { supportTasks: ["a", "b", "c"] } });
    expect(picks([one, manyTasks])).toEqual(["les_tsk30001", "les_ppl10001"]);
    // "Would have applied to N tasks last month": the lesson that would have applied to more of last month's tasks first.
    const tasks = [{ repos: ["api"], files: ["src/les_wide0001/a.ts"], languages: [] }, { repos: ["api"], files: ["src/les_wide0001/b.ts"], languages: [] }, { repos: ["api"], files: ["src/les_narr0001/a.ts"], languages: [] }];
    expect(picks([pending("les_narr0001"), pending("les_wide0001")], { recentTasks: tasks })).toEqual(["les_wide0001", "les_narr0001"]);
    expect(picks([pending("les_narr0001"), pending("les_wide0001")])).toEqual(["les_narr0001", "les_wide0001"]);
    // Severity: a pitfall before a preference (two people each, so the people tie).
    expect(picks([pending("les_pref0001", { type: "preference", p: { authors: ["a", "b"] } }), pending("les_pitf0001", { type: "pitfall", p: { authors: ["a", "b"] } })])).toEqual(["les_pitf0001", "les_pref0001"]);
    // About to lapse: the one with less than two days left first.
    expect(picks([pending("les_late0001", { pendingExpiresAt: NOW + 6 * DAY }), pending("les_soon0001", { pendingExpiresAt: NOW + DAY })])).toEqual(["les_soon0001", "les_late0001"]);
    // Newest sighting first, then the oldest suggestion, then the id.
    expect(picks([pending("les_old00001", { updatedAt: NOW - 5 * DAY }), pending("les_new00001", { updatedAt: NOW - DAY })])).toEqual(["les_new00001", "les_old00001"]);
    expect(picks([pending("les_b0000001", { createdAt: NOW - DAY }), pending("les_a0000001", { createdAt: NOW - 2 * DAY })])).toEqual(["les_a0000001", "les_b0000001"]);
    expect(picks([pending("les_bbbb0001"), pending("les_aaaa0001")])).toEqual(["les_aaaa0001", "les_bbbb0001"]);
  });

  it("a single person's preference goes last in its band", () => {
    const pref = pending("les_pref0001", { type: "preference" });
    const plain = pending("les_plan0001", { type: "procedure" });
    expect(picks([pref, plain])).toEqual(["les_plan0001", "les_pref0001"]);
  });

  it("the same input gives the same list every time (no clock but now, no randomness)", () => {
    const list = ["a", "b", "c", "d", "e", "f", "g"].map((s) => pending(`les_${s}0000001`));
    const first = JSON.stringify(orderWeekly({ lessons: list, now: NOW }));
    for (let i = 0; i < 5; i += 1) expect(JSON.stringify(orderWeekly({ lessons: [...list].reverse(), now: NOW }))).toBe(first);
  });
});

describe("need a look: first, and not counted in the five", () => {
  const active = (id: string, over: Partial<Lesson> = {}) => lessonRecord({ id, status: "active", scope: { paths: [`src/${id}/**`] }, ...over });

  it("lessons in use under question, a lesson a person was asked to keep, one sent back, one proposed for retirement and a conflict with a lesson in use are listed first; the five suggestions still hold five (golden)", () => {
    const lessons = [
      ...Array.from({ length: 6 }, (_, i) => pending(`les_sug0000${i}`)),
      active("les_rev00001"), active("les_gone0001"), active("les_rewr0001"), active("les_keep0001"), active("les_back0001", { reviewRequired: true }), active("les_retr0001", { retireProposedAt: NOW }),
      pending("les_conf0001", { contradictsWith: "les_inus0001" }), active("les_inus0001"),
    ];
    const list = orderWeekly({
      lessons, now: NOW,
      extras: {
        underQuestion: new Map([["les_rev00001", { revertTasks: 2, areaGone: false, areaRewritten: false }], ["les_gone0001", { revertTasks: 0, areaGone: true, areaRewritten: false }], ["les_rewr0001", { revertTasks: 0, areaGone: false, areaRewritten: true }]]),
        askedToKeep: new Map([["les_keep0001", NOW]]),
        repeats: new Map([["les_rev00001", { matched: 9, back: 0 }]]),
      },
    });
    // At most three need-a-look cards, in the order of their cause: a conflict, a retire proposal, then a revert in the area.
    expect(list.needLook.map((r) => [r.id, r.cause])).toEqual([["les_conf0001", "conflict"], ["les_retr0001", "retire_proposed"], ["les_rev00001", "revert_overlap"]]);
    expect(list.needLook[2]!.reason).toContain("2 changes in its area were reverted");
    // The per-lesson repeat count: "the correction stopped coming back".
    expect(list.needLook[2]!.repeat).toEqual({ matched: 9, back: 0 });
    // The need-a-look cards are not counted: the suggestions are still the five best, and the conflicting suggestion is not also among them twice.
    expect(list.picks).toHaveLength(5);
    expect(new Set(list.picks.map((r) => r.id)).size).toBe(5);
  });

  it("each cause says it in plain words, with no score and no number a person would have to interpret", () => {
    const lessons = [active("les_gone0001"), active("les_rewr0001"), active("les_keep0001")];
    const list = orderWeekly({ lessons, now: NOW, extras: { underQuestion: new Map([["les_gone0001", { revertTasks: 0, areaGone: true, areaRewritten: false }], ["les_rewr0001", { revertTasks: 0, areaGone: false, areaRewritten: true }]]), askedToKeep: new Map([["les_keep0001", NOW]]) } });
    expect(list.needLook.map((r) => r.reason)).toEqual([
      "The code area it is about is gone. Check it still applies.", "The code area it is about was rewritten. Check this is still true.", "No task has needed it for a long time. Keep it?",
    ]);
    for (const row of list.needLook) expect(row.reason).not.toMatch(/\d\.\d/u);
  });

  it("a lesson that is not in use (retired, expired) never appears as a need-a-look card", () => {
    const list = orderWeekly({ lessons: [active("les_ret00001", { status: "retired", retireProposedAt: NOW }), active("les_exp00001", { status: "expired", reviewRequired: true })], now: NOW });
    expect(list.needLook).toEqual([]);
  });

  it("a lesson under question only because of a revert with NO overlap is not in the list (the revert watch writes no row for it)", () => {
    expect(orderWeekly({ lessons: [active("les_aaaa0001")], now: NOW, extras: { underQuestion: new Map() } }).needLook).toEqual([]);
  });
});

describe("spread, noisy sources and the reason line", () => {
  it("at most 2 per code area: three suggestions about src/billing leave one out and the next best area takes the place (golden)", () => {
    const billing = (n: number) => pending(`les_bil0000${n}`, { scope: { repos: ["api"], paths: ["src/billing/**"] }, p: { authors: ["a", "b", "c"].slice(0, 3 - n), sources: [`member:b${n}`] } });
    const other = pending("les_oth00001", { scope: { repos: ["api"], paths: ["src/search/**"] } });
    const out = picks([billing(0), billing(1), billing(2), other]);
    expect(out).toEqual(["les_bil00000", "les_bil00001", "les_oth00001"]);
    expect(areaLabelOf({ repos: ["api"], paths: ["src/billing/**"] })).toBe("api:src/billing");
    expect(areaLabelOf({ paths: ["**/*.test.ts"] })).toBe("whole project");
    expect(areaLabelOf({})).toBe("whole project");
  });

  it("at most 2 per source: three suggestions from one person leave one out", () => {
    const same = (n: number) => pending(`les_src0000${n}`, { p: { sources: ["member:ann"], authors: ["ann"], supportTasks: Array.from({ length: 5 - n }, (_, i) => `t${i}`) } });
    const out = picks([same(0), same(1), same(2), pending("les_free0001", { p: { sources: ["member:bob"], authors: ["bob"] } })]);
    expect(out).toEqual(["les_src00000", "les_src00001", "les_free0001"]);
  });

  it("at most five in all, and fewer when fewer wait", () => {
    expect(picks(Array.from({ length: 9 }, (_, i) => pending(`les_all0000${i}`)))).toHaveLength(5);
    expect(picks([pending("les_one00001")])).toEqual(["les_one00001"]);
    expect(picks([])).toEqual([]);
  });

  it("a noisy source (under 30% kept with at least 10 decided) ranks one band lower; below the thresholds it does not (golden)", () => {
    const decided = (kept: number, dropped: number): Lesson[] => [
      ...Array.from({ length: kept }, (_, i) => lessonRecord({ id: `les_kept000${i}`, status: "active", approvals: [{ approvalId: "a", by: "ann", at: NOW - DAY, mode: "one" }], provenance: prov({ sources: ["member:noisy"] }) })),
      ...Array.from({ length: dropped }, (_, i) => lessonRecord({ id: `les_drop000${i}`, status: "rejected", updatedAt: NOW - DAY, approvals: [], provenance: prov({ sources: ["member:noisy"] }) })),
    ];
    const fromNoisy = pending("les_nois0001", { p: { sources: ["member:noisy"], authors: ["ann"] } });
    const fromOther = measured("les_othe0001");
    // Noisy: 2 kept of 12 decided (17%). Its direct correction (band 1) drops to band 2, so a measured result from a quiet source (band 2, more tasks) now ranks above it.
    const noisyWorld = [...decided(2, 10), fromNoisy, measured("les_othe0001", { p: { supportTasks: ["a", "b", "c"] } })];
    const rank = orderWeekly({ lessons: noisyWorld, now: NOW });
    expect(rank.picks.map((r) => r.id)).toEqual(["les_othe0001", "les_nois0001"]);
    expect(rank.picks[1]!.band).toBe("direct_correction");
    expect(rank.picks[1]!.rank).toBe(2);
    expect(rank.picks[1]!.reason).toContain("often dropped");
    // 2 kept of 9 decided is too few decisions to call a source noisy; 5 of 12 (42%) is kept often enough.
    for (const quiet of [decided(2, 7), decided(5, 7)]) expect(orderWeekly({ lessons: [...quiet, fromNoisy, fromOther], now: NOW }).picks.map((r) => r.id)).toEqual(["les_nois0001", "les_othe0001"]);
    const rates = sourceKeptRates(decided(2, 10), NOW);
    expect(rates.get("member:noisy")).toEqual({ kept: 2, decided: 12 });
  });

  it("a decision older than the month does not count toward a source's kept rate", () => {
    const old = Array.from({ length: 12 }, (_, i) => lessonRecord({ id: `les_old0000${i}`, status: "rejected", updatedAt: NOW - 60 * DAY, approvals: [], provenance: prov({ sources: ["member:noisy"] }) }));
    expect(sourceKeptRates(old, NOW).size).toBe(0);
  });

  it("the reason line says who and why in a sentence: an edit, a remembered note, a failing check; how often it was seen; and what it would have covered (golden)", () => {
    const edit = pending("les_edit0001", { p: { sourceKinds: ["human_edit"], authors: ["priya"], supportTasks: ["a", "b", "c"] } });
    const out = orderWeekly({ lessons: [edit], now: NOW, extras: { people: new Map([["priya", "Priya"]]), recentTasks: [{ repos: ["api"], files: ["src/les_edit0001/x.ts"], languages: [] }] } }).picks[0]!;
    expect(out.reason).toBe("Priya edited Rovara's pull request. Seen in 3 tasks. Would have applied to 1 task last month.");
    expect(orderWeekly({ lessons: [pending("les_note0001")], now: NOW }).picks[0]!.reason).toBe("A teammate asked Rovara to remember this. Seen in 2 tasks.");
    expect(orderWeekly({ lessons: [measured("les_ci000001")], now: NOW }).picks[0]!.reason).toBe("A failing check led to this. Seen in 2 tasks.");
    expect(orderWeekly({ lessons: [weak("les_weak0001")], now: NOW }).picks[0]!.reason).toBe("A weaker source, seen more than once. Seen in 2 tasks.");
    expect(orderWeekly({ lessons: [pending("les_laps0001", { pendingExpiresAt: NOW + DAY })], now: NOW }).picks[0]!.reason).toContain("It lapses soon.");
  });

  it("a row names no source and no person key: only words and counts", () => {
    const row = orderWeekly({ lessons: [pending("les_priv0001", { p: { sources: ["slack:C0PRIVATE9"], authors: ["dev-secret-id"] } })], now: NOW }).picks[0]!;
    expect(JSON.stringify(row)).not.toMatch(/slack:C0PRIVATE9|dev-secret-id/u);
    expect(sourceOf(pending("les_priv0001", { p: { sources: ["slack:C0PRIVATE9"] } }))).toBe("slack:C0PRIVATE9");
  });

  it("'would have applied to N tasks' counts the tasks the lesson's own scope matches", () => {
    const l = pending("les_scop0001", { scope: { repos: ["api"], paths: ["src/billing/**"], languages: [] } });
    expect(wouldHaveApplied(l, [{ repos: ["api"], files: ["src/billing/a.ts"], languages: [] }, { repos: ["web"], files: ["src/billing/a.ts"], languages: [] }, { repos: ["api"], files: ["docs/a.md"], languages: [] }])).toBe(1);
  });
});

describe("the digest carries the weekly list, only for lessons the viewer may read", () => {
  it("builds the list from the lessons the access check lets the viewer see, with the kept rates counted over the project", async () => {
    const store = new InMemoryLessonStore();
    const clock = new Clock(NOW);
    await seed(store, pending("les_vis00001"), pending("les_hid00001", { provenance: prov({ audience: { kind: "restricted", acl: { source: "slack", scope: "slack:T/C9", principals: ["U-member"], capturedAt: "x", liveCheck: "none" } }, memberSignal: true }) }));
    const digest = await buildWeeklyDigest(store, KEY, clock.now(), { principals: ["U-stranger"], groups: [] }, { ...allowAllAccess, mayRead: async (_org, viewer, places) => places.map((place) => viewer.principals.includes("U-member") || !place.includes("C9")) } as never);
    expect(digest.weekly.picks.map((r) => r.id)).toEqual(["les_vis00001"]);
    expect(digest.top.length).toBeGreaterThan(0);
  });
});

describe("the weekly list on the API", () => {
  it("the digest route answers the weekly list in the contract's shape (additive: older readers ignore it), with the extras the host reads from its signals", async () => {
    const store = new InMemoryLessonStore();
    const clock = new Clock(NOW);
    await seed(store, pending("les_sug00001"), lessonRecord({ id: "les_rev00001", status: "active", scope: { paths: ["src/a/**"] } }));
    const dir = directory({ eligibleIds: ["owner"], ownerIds: ["owner"] });
    dir.identity = async (_ws: string, developerId: string) => ({ principals: [], groups: [], developerId });
    const deps = {
      store, directory: dir, settings: settings(), access: allowAllAccess, now: clock.now, names: { isErased: async () => false, memberName: async (_o: string, id: string) => id },
      weeklyExtras: async () => ({ underQuestion: new Map([["les_rev00001", { revertTasks: 1, areaGone: false, areaRewritten: false }]]), repeats: new Map([["les_rev00001", { matched: 4, back: 0 }]]) }),
    };
    const answer = await buildLessonsDigest(deps as never, { orgId: KEY.workspaceId as never, developerId: "owner" }, KEY.project);
    expect(LessonsDigestSchema.safeParse(answer).success).toBe(true);
    expect(answer.weekly.needLook.map((r) => [r.id, r.cause, r.repeat])).toEqual([["les_rev00001", "revert_overlap", { matched: 4, back: 0 }]]);
    expect(answer.weekly.picks.map((r) => r.id)).toEqual(["les_sug00001"]);
    expect(Object.keys(answer.weekly.picks[0]!).sort()).toEqual(["area", "band", "id", "reason", "title", "type"]);
    // A failing extras reader is no extras: the list is still built.
    const broken = await buildLessonsDigest({ ...deps, weeklyExtras: async () => { throw new Error("x"); } } as never, { orgId: KEY.workspaceId as never, developerId: "owner" }, KEY.project);
    expect(broken.weekly.needLook).toEqual([]);
    expect(broken.weekly.picks).toHaveLength(1);
  });
});
