// Lessons phase 1, the newcomer place (research Q3 point 4): one of the step's places is kept for the best-fitting lesson with fewer than 3 uses, when one passes the fit floor. No randomness: a person must be able to see why
// a lesson loaded and a replay must give the same loads.
import { describe, expect, it } from "vitest";
import { NEWCOMER_MAX_USES } from "../../../packages/broker/src/lessons/scoring-settings.js";
import { fitting, ids, unrelated, world } from "./phase12-helpers.js";

const proven = { loaded: 30, helpful: 28, harmful: 0, citationStale: 0 };
/** Six strong, proven lessons that fit, and one well-fitting newcomer with no uses: five places, so the newcomer is outranked on score alone. */
async function crowded(over: { newcomer?: Parameters<typeof fitting>[1]; extra?: number } = {}) {
  const w = await world();
  await w.add(
    ...Array.from({ length: 6 + (over.extra ?? 0) }, (_, i) => fitting(`les_old0000${i}`, { counters: proven })),
    fitting("les_new00001", { title: "Retries use withRetry", body: "Failed HTTP calls in the api service are retried with withRetry", ...(over.newcomer ?? {}) }),
  );
  for (let i = 0; i < 6 + (over.extra ?? 0); i += 1) for (let n = 0; n < 4; n += 1) await w.evidence.note({ workspaceId: "org_aaaaaaaaaaaaaaaaaaaa", project: "proj-1", lessonId: `les_old0000${i}`, kind: "for", weight: 1, at: w.clock.now() - n * 86_400_000, id: `t${n}` });
  return w;
}

describe("the newcomer place", () => {
  it("a well-fitting lesson with fewer than 3 uses gets one of the five places although six proven lessons outrank it", async () => {
    expect(NEWCOMER_MAX_USES).toBe(3);
    const w = await crowded();
    const loaded = ids(await w.load());
    expect(loaded).toHaveLength(5);
    expect(loaded).toContain("les_new00001");
    // The other four places go to the best of the proven ones, in rank order, with the newcomer read in its rank position (not first for having been placed first).
    expect(loaded.filter((id) => id !== "les_new00001")).toEqual(["les_old00000", "les_old00001", "les_old00002", "les_old00003"]);
    expect(loaded[loaded.length - 1]).toBe("les_new00001");
  });

  it("MUTANT: with the newcomer place turned off the same project loads five proven lessons and the newcomer waits for ever", async () => {
    const w = await crowded();
    const loaded = ids(await w.load({}, { ranking: { newcomerSlots: 0 } }));
    expect(loaded).toEqual(["les_old00000", "les_old00001", "les_old00002", "les_old00003", "les_old00004"]);
  });

  it("no randomness: ten loads of the same project give the same lessons in the same order", async () => {
    const w = await crowded();
    const first = ids(await w.load());
    for (let i = 0; i < 10; i += 1) expect(ids(await w.load({ taskId: `task-${i + 2}` }))).toEqual(first);
  });

  it("a newcomer that does not pass the fit floor never takes a place (the place is for a lesson that fits)", async () => {
    const w = await world();
    await w.add(...Array.from({ length: 6 }, (_, i) => fitting(`les_old0000${i}`, { counters: proven })), unrelated("les_new00001"));
    expect(ids(await w.load())).not.toContain("les_new00001");
  });

  it("a lesson with 3 or more uses is not a newcomer, however well it fits", async () => {
    const w = await crowded({ newcomer: { counters: { loaded: NEWCOMER_MAX_USES, helpful: 0, harmful: 0, citationStale: 0 } } });
    const loaded = ids(await w.load());
    expect(loaded).not.toContain("les_new00001");
  });

  it("when a newcomer is already in the natural five nothing changes (no lesson is displaced for it)", async () => {
    const w = await world();
    await w.add(fitting("les_new00001"), fitting("les_old00001", { counters: proven }), fitting("les_old00002", { counters: proven }));
    const withSlot = ids(await w.load());
    const without = ids(await w.load({ taskId: "task-2" }, { ranking: { newcomerSlots: 0 } }));
    expect(withSlot).toEqual(without);
  });

  it("with a budget of one there is no reserved place: the step keeps its single best lesson", async () => {
    const w = await crowded();
    const loaded = ids(await w.load({}, { settings: { read: async () => ({ preset: "regulated", mode: "On", loadBudget: { lessons: 1 } }) as never } }));
    expect(loaded).toEqual(["les_old00000"]);
  });

  it("two projects: the newcomer place is per load, so a newcomer in one project never changes another project's five", async () => {
    const w = await crowded();
    await w.add(fitting("les_oth00001", { project: "proj-2" }));
    const loaded = ids(await w.load());
    expect(loaded).not.toContain("les_oth00001");
  });
});
