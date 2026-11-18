// Lessons phase 2, fade by chances, not calendar (research Q5): a lesson nobody had a chance to use is renewed once without asking, then a person is asked (and it stays in use meanwhile); a lesson that had chances and never
// helped fades as before; chances not known: left alone tonight.
import { describe, expect, it } from "vitest";
import { settleHelpful } from "../../../packages/broker/src/lessons/counters.js";
import { FADE_ASK_GRACE_DAYS, FADE_QUIET_RENEWALS } from "../../../packages/broker/src/lessons/scoring-settings.js";
import { expiryWindowMs, keepQuietLesson, sweepExpired, type FadePorts } from "../../../packages/broker/src/lessons/expiry.js";
import { readEvidenceTotals } from "../../../packages/broker/src/lessons/evidence.js";
import { orderWeekly } from "../../../packages/broker/src/lessons/weekly-order.js";
import { readProjectSignals } from "../../../packages/broker/src/lessons/signals.js";
import { KEY, PROJECT, WS, lessonRecord } from "./lesson-helpers.js";
import { A, B, DAY, world } from "./phase12-helpers.js";

const WINDOW = expiryWindowMs("fact", undefined);

async function due(options: { chances?: number | undefined; type?: "fact" | "convention"; over?: Partial<ReturnType<typeof lessonRecord>> } = {}) {
  const w = await world();
  const lesson = lessonRecord({ id: "les_aaaa1111", type: options.type ?? "convention", expiresAt: w.clock.now() - 1, ...(options.over ?? {}) });
  await w.add(lesson);
  const asked: Array<{ lessonId: string; since: number }> = [];
  let chances = options.chances;
  const fade: FadePorts = { evidence: w.evidence, chances: async (_key, lessonId, since) => { asked.push({ lessonId, since }); return chances; } };
  const sweep = async () => sweepExpired({ ...w.counters, vectors: undefined } as never, w.store, KEY, { fade });
  return { w, fade, sweep, asked, setChances: (n: number | undefined) => { chances = n; } };
}
const fadeRow = async (w: Awaited<ReturnType<typeof world>>) => w.evidence.readFade(KEY, "les_aaaa1111");

describe("fade by chances", () => {
  it("a due lesson no task had a chance to use is renewed once without asking, and it stays in use (golden)", async () => {
    expect(FADE_QUIET_RENEWALS).toBe(1);
    const { w, sweep, asked } = await due({ chances: 0 });
    expect((await sweep()).expired).toEqual([]);
    const lesson = (await w.store.get(KEY, "les_aaaa1111"))!;
    expect(lesson.status).toBe("active");
    expect(lesson.expiresAt).toBe(w.clock.now() + WINDOW);
    expect(await fadeRow(w)).toMatchObject({ renewals: 1 });
    // The chances are looked for over the lesson's own window.
    expect(asked).toEqual([{ lessonId: "les_aaaa1111", since: w.clock.now() - WINDOW }]);
  });

  it("the second quiet window: it stays in use and a person is asked, once, for a month; nobody answers and it then fades", async () => {
    const { w, sweep } = await due({ chances: 0 });
    await sweep();
    w.clock.advance(WINDOW + DAY);
    expect((await sweep()).expired).toEqual([]);
    const asked = await fadeRow(w);
    expect(asked).toMatchObject({ renewals: 1, askedAt: w.clock.now() });
    const stays = (await w.store.get(KEY, "les_aaaa1111"))!;
    expect(stays.status).toBe("active");
    expect(stays.expiresAt).toBe(w.clock.now() + FADE_ASK_GRACE_DAYS * DAY);
    // The question shows in the signals and in the weekly list as a need-a-look card, "Keep it?".
    const signals = await readProjectSignals(w.documents, { companyId: A, project: PROJECT, now: w.clock.now() });
    expect([...signals.askedToKeep.keys()]).toEqual(["les_aaaa1111"]);
    expect(orderWeekly({ lessons: [stays], now: w.clock.now(), extras: { askedToKeep: signals.askedToKeep } }).needLook.map((r) => r.cause)).toEqual(["asked_to_keep"]);
    // A month later the question is still unanswered: it fades.
    w.clock.advance(FADE_ASK_GRACE_DAYS * DAY + 1);
    expect((await sweep()).expired).toEqual(["les_aaaa1111"]);
  });

  it("a person answers Keep: the lesson is renewed for a whole window and the fade state starts again", async () => {
    const { w, sweep } = await due({ chances: 0 });
    await sweep();
    w.clock.advance(WINDOW + DAY);
    await sweep();
    expect(await keepQuietLesson({ ...w.counters }, w.store, w.evidence, KEY, "les_aaaa1111")).toBe(true);
    expect((await w.store.get(KEY, "les_aaaa1111"))!.expiresAt).toBe(w.clock.now() + WINDOW);
    expect(await fadeRow(w)).toMatchObject({ renewals: 0 });
    expect((await fadeRow(w))!.askedAt).toBeUndefined();
    expect(await keepQuietLesson({ ...w.counters }, w.store, w.evidence, KEY, "les_missing1")).toBe(false);
  });

  it("a due lesson that HAD chances and never helped fades (MUTANT: treating every due lesson as quiet would renew it)", async () => {
    const { w, sweep } = await due({ chances: 3 });
    expect((await sweep()).expired).toEqual(["les_aaaa1111"]);
    expect((await w.store.get(KEY, "les_aaaa1111"))!.status).toBe("expired");
    expect(await fadeRow(w)).toBeUndefined();
  });

  it("chances that are not known leave the lesson alone tonight (it is never expired on a guess), and a fault in the count is 'not known'", async () => {
    const { w, sweep, fade, setChances } = await due({ chances: undefined });
    expect((await sweep()).expired).toEqual([]);
    expect((await w.store.get(KEY, "les_aaaa1111"))!.status).toBe("active");
    const failing: FadePorts = { ...fade, chances: async () => { throw new Error("store down"); } };
    expect((await sweepExpired({ ...w.counters, vectors: undefined } as never, w.store, KEY, { fade: failing })).expired).toEqual([]);
    setChances(2);
    expect((await sweep()).expired).toEqual(["les_aaaa1111"]);
  });

  it("a lesson whose anchors no longer hold is not renewed for being quiet", async () => {
    const { w, sweep } = await due({ chances: 0, over: { citationChecks: [{ index: 0, result: "stale", at: 1 }] } });
    expect((await sweep()).expired).toEqual(["les_aaaa1111"]);
    expect(await fadeRow(w)).toBeUndefined();
  });

  it("without the fade ports the sweep is what it was (calendar): a due lesson expires", async () => {
    const w = await world();
    await w.add(lessonRecord({ id: "les_aaaa1111", expiresAt: w.clock.now() - 1 }));
    expect((await sweepExpired({ ...w.counters, vectors: undefined } as never, w.store, KEY, {})).expired).toEqual(["les_aaaa1111"]);
  });

  it("a lesson that is not due is never looked at", async () => {
    const { w, sweep, asked } = await due({ chances: 0, over: { expiresAt: 1_800_000_000_000 + 10 * DAY } });
    expect((await sweep()).expired).toEqual([]);
    expect(asked).toEqual([]);
    expect(await fadeRow(w)).toBeUndefined();
  });

  it("a lesson that helped is not quiet any more: a helpful mark clears its fade state", async () => {
    const { w, sweep } = await due({ chances: 0, over: { expiresAt: 1_800_000_000_000 - 1 } });
    await sweep();
    expect(await fadeRow(w)).toMatchObject({ renewals: 1 });
    await w.store.addPending({ key: "helpful:t1:les_aaaa1111", workspaceId: WS, project: PROJECT, lessonId: "les_aaaa1111", taskId: "t1", dueAt: w.clock.now() - 1 });
    await settleHelpful(w.counters, KEY);
    expect(await fadeRow(w)).toMatchObject({ renewals: 0 });
  });

  it("a pending suggestion that nobody decided still lapses on its own (the fade rule is for lessons in use)", async () => {
    const w = await world();
    await w.add(lessonRecord({ id: "les_pend0001", status: "pending", approvals: [], pendingExpiresAt: w.clock.now() - 1 }));
    const fade: FadePorts = { evidence: w.evidence, chances: async () => 0 };
    expect((await sweepExpired({ ...w.counters, vectors: undefined } as never, w.store, KEY, { fade })).expired).toEqual(["les_pend0001"]);
  });
});

describe("a fade state that cannot be read or written decides nothing", () => {
  it("an unreadable state is not 'none': the lesson is not renewed again and again; it is left for tomorrow", async () => {
    const { w, fade, sweep } = await due({ chances: 0 });
    const unreadable: FadePorts = { ...fade, evidence: { readFade: async () => "unreadable", writeFade: (k, id, state, at) => w.evidence.writeFade(k, id, state, at) } };
    const before = (await w.store.get(KEY, "les_aaaa1111"))!.expiresAt;
    for (let i = 0; i < 3; i += 1) expect((await sweepExpired({ ...w.counters, vectors: undefined } as never, w.store, KEY, { fade: unreadable })).expired).toEqual([]);
    expect((await w.store.get(KEY, "les_aaaa1111"))!.expiresAt).toBe(before);
    expect(await fadeRow(w)).toBeUndefined();
    void sweep;
  });

  it("a state that cannot be written is not renewed on (a renewal that is not recorded would be made again at every window)", async () => {
    const { w, fade } = await due({ chances: 0 });
    const noWrite: FadePorts = { ...fade, evidence: { readFade: (k, id) => w.evidence.readFade(k, id), writeFade: async () => false } };
    const before = (await w.store.get(KEY, "les_aaaa1111"))!.expiresAt;
    expect((await sweepExpired({ ...w.counters, vectors: undefined } as never, w.store, KEY, { fade: noWrite })).expired).toEqual([]);
    expect((await w.store.get(KEY, "les_aaaa1111"))!.expiresAt).toBe(before);
    // The same for the question: not asked, so the lesson is not held open on an unrecorded question.
    await w.evidence.writeFade(KEY, "les_aaaa1111", { renewals: 1 }, w.clock.now());
    expect((await sweepExpired({ ...w.counters, vectors: undefined } as never, w.store, KEY, { fade: noWrite })).expired).toEqual([]);
    expect((await w.store.get(KEY, "les_aaaa1111"))!.expiresAt).toBe(before);
  });
});

describe("isolation of the fade state", () => {
  it("the fade row of one project or company is never read for another", async () => {
    const w = await world();
    await w.evidence.writeFade(KEY, "les_aaaa1111", { renewals: 1, askedAt: 5 }, w.clock.now());
    expect(await w.evidence.readFade({ workspaceId: WS, project: "proj-2" }, "les_aaaa1111")).toBeUndefined();
    expect(await w.evidence.readFade({ workspaceId: "org_bbbbbbbbbbbbbbbbbbbb", project: PROJECT }, "les_aaaa1111")).toBeUndefined();
    expect((await readEvidenceTotals(w.documents, { companyId: B, project: PROJECT, now: w.clock.now(), windowMs: 180 * DAY })).asked.size).toBe(0);
  });
});
