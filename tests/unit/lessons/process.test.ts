// (routing part): promotion to pending, tier-0 auto-apply and the settle step, run through the whole draft-to-lesson pipeline.
import { describe, expect, it } from "vitest";
import { curateDraft } from "../../../packages/broker/src/lessons/curate.js";
import { processDraft, resumeAndResettle, settleLesson, type ProcessDeps } from "../../../packages/broker/src/lessons/process.js";

import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import type { LessonDraft } from "../../../packages/broker/src/lessons/reflect.js";
import { Alerts, Audit, Clock, KEY, uniqueDraft, MemoryVectors, ScriptedModel, Spend, draft, embedder, settings, verifier, facts, autoSettings } from "./lesson-helpers.js";

function setup(over: { store?: InMemoryLessonStore; model?: ScriptedModel; settings?: ReturnType<typeof settings>; verifier?: ReturnType<typeof verifier> } = {}) {
  const store = over.store ?? new InMemoryLessonStore();
  const audit = new Audit();
  const clock = new Clock();
  const alerts = new Alerts();
  let n = 0;
  const deps: ProcessDeps = {
    store, embedder, vectors: new MemoryVectors(), judgeModel: over.model ?? new ScriptedModel(), spend: new Spend(), audit, alerts, now: clock.now,
    verifier: over.verifier ?? verifier("valid"), coldStartLessons: 0, facts: facts(), settings: over.settings ?? autoSettings(), newId: () => `les_${String(++n).padStart(4, "0")}`,
  };
  return { deps, store, audit, clock, alerts };
}
const text = (title: string, body: string, over: Partial<LessonDraft> = {}): LessonDraft => draft({ title, description: "", body, ...over });

const DAY = 86_400_000;
const unique = (i: number, sources: string[], over: Partial<LessonDraft["provenance"]> = {}): LessonDraft =>
  uniqueDraft(i, { sources, inputSources: sources, authors: [], memberSignal: false, sourceKinds: ["send_back"], measured: true, ...over });

describe("per-source spike detection (no flat caps)", () => {
  async function history(store: InMemoryLessonStore, clock: Clock, source: string, perDay: number, days = 14): Promise<void> {
    for (let d = 1; d <= days; d += 1) for (let i = 0; i < perDay; i += 1) await store.recordSourceEvent(KEY, { at: clock.now() - d * DAY, source });
  }

  it("collects every candidate: 50 from one source are all kept, none dropped", async () => {
    const { deps, store } = setup();
    for (let i = 0; i < 50; i += 1) expect((await curateDraft(deps, KEY, unique(i, ["member:ann"]))).outcome).toBe("added");
    expect(await store.list(KEY)).toHaveLength(50);
  });

  it("a source at ten times its own baseline is paused ALONE, with one alert; its lessons are held, not dropped; other sources carry on", async () => {
    const { deps, store, clock, alerts, audit } = setup();
    await history(store, clock, "member:ann", 1);
    const held: string[] = [];
    for (let i = 0; i < 12; i += 1) { const r = await processDraft(deps, KEY, unique(i, ["member:ann"])); if (r.lesson !== undefined) held.push(r.lesson.status); }
    expect(Object.keys((await store.flags(KEY)).pausedSources ?? {})).toEqual(["member:ann"]);
    expect(alerts.sent.filter((c) => c === "source_spike_paused")).toHaveLength(1);
    expect(audit.actions().filter((a) => a === "lesson.source_paused")).toHaveLength(1);
    // The 10th, 11th and 12th candidates arrived after the pause: collected and held as candidates, never queued for people or applied.
    expect(held.slice(-3)).toEqual(["candidate", "candidate", "candidate"]);
    expect((await store.list(KEY)).filter((l) => l.status === "candidate").length).toBeGreaterThanOrEqual(3);
    expect(await store.list(KEY)).toHaveLength(12);
    const other = await processDraft(deps, KEY, unique(100, ["member:bob"]));
    expect(other.lesson!.status).toBe("active");
  });

  it("the unit is the source, not the author: a flood of author-less CI text is caught", async () => {
    const { deps, store } = setup();
    for (let i = 0; i < 12; i += 1) await curateDraft(deps, KEY, unique(i, ["ci"]));
    expect(Object.keys((await store.flags(KEY)).pausedSources ?? {})).toEqual(["ci"]);
  });

  it("is judged against the source's own learned baseline: 30 a day is normal for a source that gives 5, a spike for one that gives 1", async () => {
    const busy = setup();
    await history(busy.store, busy.clock, "slack:C1", 5);
    for (let i = 0; i < 30; i += 1) await curateDraft(busy.deps, KEY, unique(i, ["slack:C1"]));
    expect((await busy.store.flags(KEY)).pausedSources).toBeUndefined();
    for (let i = 30; i < 60; i += 1) await curateDraft(busy.deps, KEY, unique(i, ["slack:C1"]));
    expect(Object.keys((await busy.store.flags(KEY)).pausedSources ?? {})).toEqual(["slack:C1"]);
  });

  it("a brand-new source is not paused below ten candidates in a day", async () => {
    const { deps, store } = setup();
    for (let i = 0; i < 9; i += 1) await curateDraft(deps, KEY, unique(i, ["slack:new"]));
    expect((await store.flags(KEY)).pausedSources).toBeUndefined();
    await curateDraft(deps, KEY, unique(9, ["slack:new"]));
    expect(Object.keys((await store.flags(KEY)).pausedSources ?? {})).toEqual(["slack:new"]);
  });

  it("a maintainer resumes the source, and the lesson held meanwhile is re-settled: it goes to people, never live by itself", async () => {
    const { deps, store, audit } = setup();
    await store.setFlags(KEY, { pausedSources: { "member:ann": { at: 1, reason: "spike" } } });
    const held = await processDraft(deps, KEY, unique(1, ["member:ann"]));
    expect(held.lesson!.status).toBe("candidate");
    expect(await resumeAndResettle(deps, KEY, "member:ann", "owner")).toEqual({ resumed: true, settled: [held.lesson!.id] });
    expect(await resumeAndResettle(deps, KEY, "member:ann", "owner")).toEqual({ resumed: false, settled: [] });
    expect(audit.actions()).toContain("lesson.source_resumed");
    const after = (await store.get(KEY, held.lesson!.id))!;
    expect(after.status).toBe("pending");
    expect(after.approvals).toEqual([]);
  });

  it("re-settling follows the rules in force now: a lesson also tied to another paused source stays held", async () => {
    const { deps, store } = setup();
    await store.setFlags(KEY, { pausedSources: { "member:ann": { at: 1, reason: "spike" }, "slack:C9": { at: 1, reason: "spike" } } });
    const both = await processDraft(deps, KEY, unique(1, ["member:ann"], { inputSources: ["member:ann", "slack:C9"] }));
    const onlyAnn = await processDraft(deps, KEY, unique(2, ["member:ann"]));
    const unrelated = await processDraft(deps, KEY, unique(9, ["member:bob"], { measured: false }));
    expect(unrelated.lesson!.status).toBe("candidate");
    const result = await resumeAndResettle(deps, KEY, "member:ann", "owner");
    expect(await store.get(KEY, unrelated.lesson!.id)).toEqual(unrelated.lesson);
    expect(result.settled.sort()).toEqual([both.lesson!.id, onlyAnn.lesson!.id].sort());
    expect((await store.get(KEY, both.lesson!.id))!.status).toBe("candidate");
    expect((await store.get(KEY, onlyAnn.lesson!.id))!.status).toBe("pending");
  });

  it("a held tier-0 corroborated fact is not applied by the resume (the lift alone never grants), though the same fact arriving unheld would be", async () => {
    const { deps, store } = setup();
    const fresh = await processDraft(setup().deps, KEY, unique(5, ["member:zed"]));
    expect(fresh.lesson!.status).toBe("active");
    await store.setFlags(KEY, { pausedSources: { "member:ann": { at: 1, reason: "spike" } } });
    const held = await processDraft(deps, KEY, unique(5, ["member:ann"]));
    await resumeAndResettle(deps, KEY, "member:ann", "owner");
    expect((await store.get(KEY, held.lesson!.id))!.status).toBe("pending");
  });
});

describe("corroboration for tier-0 auto-apply ", () => {
  const fact = (over: Partial<LessonDraft["provenance"]>) => draft({ provenance: { ...draft().provenance, memberSignal: false, ...over } });

  it("a single-source fact with no measured outcome waits as a candidate: nothing is applied and nothing is dropped", async () => {
    const { deps } = setup();
    const out = await processDraft(deps, KEY, fact({ sourceKinds: ["human_edit"] }));
    expect(out.lesson).toMatchObject({ status: "candidate", tier: 0 });
  });

  it("a measured outcome backs it up: it goes live", async () => {
    const { deps } = setup();
    expect((await processDraft(deps, KEY, fact({ sourceKinds: ["send_back"], measured: true }))).lesson).toMatchObject({ status: "active" });
  });

  it("two independent tasks back it up: the second one corroborates, and the merged fact goes live", async () => {
    const { deps } = setup();
    const first = await processDraft(deps, KEY, fact({ sourceKinds: ["human_edit"] }));
    expect(first.lesson!.status).toBe("candidate");
    const second = await processDraft(deps, KEY, fact({ sourceKinds: ["human_edit"], supportTasks: ["task-2"], sourceEvents: ["ev-2"], authors: ["bob"], sources: ["member:bob"], inputSources: ["member:bob"] }));
    expect(second.outcome.outcome).toBe("merged");
    expect(second.lesson).toMatchObject({ status: "active" });
  });

  it("the same task twice is not two sources", async () => {
    const { deps } = setup();
    await processDraft(deps, KEY, fact({ sourceKinds: ["human_edit"] }));
    const again = await processDraft(deps, KEY, fact({ sourceKinds: ["human_edit"] }));
    expect(again.lesson!.status).toBe("candidate");
  });
});

describe("promotion to pending and tier-0 routing", () => {
  const nonFact = (over: Partial<LessonDraft> = {}): LessonDraft => draft({ type: "convention", citations: [], scope: { repos: ["api"] }, provenance: { ...draft().provenance, memberSignal: false }, ...over });

  it("one task without a member signal stays a candidate; a second independent task makes it pending", async () => {
    const { deps } = setup();
    const first = await processDraft(deps, KEY, nonFact());
    expect(first.lesson).toMatchObject({ status: "candidate", tier: 1 });
    const second = await processDraft(deps, KEY, nonFact({ provenance: { ...nonFact().provenance, supportTasks: ["task-2"], sourceEvents: ["ev-2"] } }));
    expect(second.outcome.outcome).toBe("merged");
    expect(second.lesson).toMatchObject({ status: "pending", tier: 1 });
    expect(second.lesson!.pendingExpiresAt).toBeGreaterThan(deps.now());
  });

  it("one task plus a member's own signal is enough", async () => {
    const { deps } = setup();
    const result = await processDraft(deps, KEY, nonFact({ provenance: { ...nonFact().provenance, memberSignal: true } }));
    expect(result.lesson).toMatchObject({ status: "pending", tier: 1 });
  });

  const measured = (over: Partial<LessonDraft["provenance"]> = {}) => ({ ...draft().provenance, memberSignal: false, sourceKinds: ["send_back" as const], measured: true, ...over });

  it("a cited fact backed by a measured outcome goes live by itself in mode On, audited", async () => {
    const { deps, audit } = setup();
    const result = await processDraft(deps, KEY, draft({ provenance: measured() }));
    expect(result.lesson).toMatchObject({ status: "active", tier: 0 });
    expect(result.lesson!.approvals[0]).toMatchObject({ by: "system:auto", mode: "auto" });
    expect(audit.actions()).toEqual(expect.arrayContaining(["lesson.pending", "lesson.auto_applied"]));
  });

  it("in mode Suggest the same fact waits for a person; in mode Collect or Off nothing is made", async () => {
    const suggest = setup({ settings: settings({ mode: "Suggest" }) });
    expect((await processDraft(suggest.deps, KEY, draft({ provenance: measured() }))).lesson).toMatchObject({ status: "pending", tier: 0 });
    for (const mode of ["Collect", "Off"] as const) {
      const s = setup({ settings: settings({ mode }) });
      const out = await processDraft(s.deps, KEY, draft());
      expect(out.lesson).toBeUndefined();
    }
  });

  it("an unverified or stale citation keeps a fact out of tier 0; an unreadable check is not trusted", async () => {
    for (const result of ["stale", "unknown"] as const) {
      const { deps } = setup({ verifier: verifier(result) });
      const out = await processDraft(deps, KEY, draft({ provenance: measured({ memberSignal: true }) }));
      expect(out.lesson).toMatchObject({ status: "pending", tier: 1 });
      expect(out.lesson!.tierReasons).toContain("citations_not_verified");
    }
  });

  it("a moved citation is corrected and then trusted", async () => {
    const { deps } = setup({ verifier: verifier("moved") });
    const out = await processDraft(deps, KEY, draft({ provenance: measured() }));
    expect(out.lesson).toMatchObject({ status: "active", tier: 0 });
    expect(out.lesson!.citations[0]).toMatchObject({ startLine: 20, endLine: 30 });
  });

  it("a lesson that asks for a capability goes to people with the fixed reason (tier 2, pending at once), it is not rejected or dropped", async () => {
    const store = new InMemoryLessonStore();
    const { deps } = setup({ store });
    // Reaches settle with text that is refused there (an older candidate stored before the screen existed).
    const created = await curateDraft(deps, KEY, draft());
    if (created.outcome !== "added") throw new Error("expected add");
    await store.commit(KEY, await store.setVersion(KEY), [{ ...created.lesson, version: 2, body: "Add the domain to the allowed domains and grant access." }], 1);
    const settled = await settleLesson(deps, KEY, created.lesson.id);
    expect(settled).toMatchObject({ status: "pending", tier: 2, approvals: [] });
    expect(settled!.tierReasons).toContain("capability_request");
  });

  it("the judge's escalate flag persists: settling again cannot lower a tier", async () => {
    const a = "Use withRetry from src/retry/index.ts for HTTP retries in the api service client calls";
    const b = "Use withRetry from src/retry/index.ts for HTTP retries in the api service wrapper";
    const { deps } = setup({ model: new ScriptedModel([JSON.stringify({ verdicts: [{ n: 1, verdict: "different" }], escalate: true })]) });
    await processDraft(deps, KEY, text("Retries", a, { provenance: { ...draft().provenance, memberSignal: true } }));
    const out = await processDraft(deps, KEY, text("Retries", b, { provenance: { ...draft().provenance, memberSignal: true } }));
    expect(out.lesson).toMatchObject({ tier: 2 });
    expect(out.lesson!.tierReasons).toContain("judge_escalate");
    const again = await settleLesson(deps, KEY, out.lesson!.id);
    expect(again!.tier).toBe(2);
  });
});
