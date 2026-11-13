// The author rules compare MERGED ids. A developer who was merged into another reads as that other, so an author recorded under the old
// id (A, merged into B) is B, and B approving is the author approving; two approvers that are one member after the merge are not two people.
import { describe, expect, it } from "vitest";
import { approveLesson, rollbackLessonSet, type ApproveDeps } from "../../../packages/core/src/lessons/approve.js";
import { InMemoryLessonStore } from "../../../packages/core/src/lessons/store.js";
import { loadLessonsForStage, approvedForUse, type LoadDeps } from "../../../packages/core/src/lessons/load.js";
import { DEFAULT_APPROVAL_POLICY } from "../../../packages/core/src/lessons/policy.js";
import { Audit, Clock, KEY, MemoryVectors, PROJECT, WS, directory, embedder, lessonRecord, seed, settings, allowAllAccess } from "./lesson-helpers.js";

/** ann-old and bob-old were merged away: they now read as ann and bob. */
const MERGES: Record<string, string> = { "ann-old": "ann", "bob-old": "bob" };
const authored = (authors: string[], over: Parameters<typeof lessonRecord>[0] = {}) => lessonRecord({
  id: "les_pend0001", status: "pending", tier: 1, tierReasons: ["not_a_fact"], approvals: [], type: "convention", pendingExpiresAt: 9e15, provenance: { ...lessonRecord().provenance, authors }, ...over,
});
const tier2 = (authors: string[], over: Parameters<typeof lessonRecord>[0] = {}) => authored(authors, { tier: 2, tierReasons: ["escalation_words"], ...over });
const input = (approverId: string) => ({ ...KEY, lessonId: "les_pend0001", approverId });

function setup(resolve?: (workspaceId: string, id: string) => Promise<string>) {
  const store = new InMemoryLessonStore();
  const audit = new Audit();
  const clock = new Clock();
  let n = 0;
  const dir = directory();
  if (resolve !== undefined) dir.resolveMember = resolve;
  const deps: ApproveDeps = { access: allowAllAccess, store, directory: dir, settings: settings(), audit, now: clock.now, newId: () => `ap-${++n}` };
  return { deps, store, dir };
}
const follow = async (_workspaceId: string, id: string): Promise<string> => MERGES[id] ?? id;

describe("tier 1: an author recorded under a merged-away id is still the author", () => {
  it("ann-old (merged into ann) wrote it: ann cannot approve alone, bob can", async () => {
    const { deps, store } = setup(follow);
    await seed(store, authored(["ann-old"]));
    expect(await approveLesson(deps, input("ann"))).toEqual({ ok: false, code: "author_cannot_approve_alone" });
    expect(await approveLesson(deps, input("bob"))).toMatchObject({ ok: true, status: "active" });
  });

  it("with no merge record (or no resolver) the raw ids decide, as before", async () => {
    const without = setup();
    await seed(without.store, authored(["ann-old"]));
    expect(await approveLesson(without.deps, input("ann"))).toMatchObject({ ok: true, status: "active" });
    const unmerged = setup(async (_w, id) => id);
    await seed(unmerged.store, authored(["ann-old"]));
    expect(await approveLesson(unmerged.deps, input("ann"))).toMatchObject({ ok: true, status: "active" });
  });

  it("fails closed when the merge record cannot be read", async () => {
    const { deps, store } = setup(async () => { throw new Error("down"); });
    await seed(store, authored(["ann-old"]));
    expect(await approveLesson(deps, input("ann"))).toEqual({ ok: false, code: "eligibility_unavailable" });
    expect((await store.get(KEY, "les_pend0001"))!.status).toBe("pending");
  });
});

describe("tier 2: two approvers who are the lesson's authors after the merge are not enough", () => {
  it("authors ann-old and bob-old: ann and bob together cannot finish it, owner can", async () => {
    const { deps, store } = setup(follow);
    await seed(store, tier2(["ann-old", "bob-old"]));
    expect(await approveLesson(deps, input("ann"))).toMatchObject({ ok: true, status: "pending", needs: "second_person" });
    expect(await approveLesson(deps, input("bob"))).toEqual({ ok: false, code: "second_person_required" });
    expect((await store.get(KEY, "les_pend0001"))!.status).toBe("pending");
    expect(await approveLesson(deps, input("owner"))).toMatchObject({ ok: true, status: "active" });
  });

  it("a restored tier-2 lesson approved by two merged authors waits for a person", async () => {
    const { deps, store } = setup(follow);
    const two = [{ approvalId: "a1", by: "ann", at: 1, mode: "second_person" as const }, { approvalId: "a2", by: "bob", at: 1, mode: "second_person" as const }];
    await seed(store, tier2(["ann-old", "bob-old"], { status: "active", approvals: two, expiresAt: 9e15 }));
    const v1 = (await store.get(KEY, "les_pend0001"))!;
    await store.commit(KEY, await store.setVersion(KEY), [{ ...v1, version: 2, status: "stale" }], 2);
    await rollbackLessonSet(deps, { ...KEY, targetSetVersion: 1, expectedSetVersion: 2, actorId: "owner" });
    expect((await store.get(KEY, "les_pend0001"))!.status).toBe("pending");
  });

  it("a restored tier-1 approval by a merged author does not count while someone else could give it", async () => {
    const { deps, store } = setup(follow);
    const one = [{ approvalId: "a1", by: "ann", at: 1, mode: "one" as const }];
    await seed(store, authored(["ann-old"], { status: "active", approvals: one, expiresAt: 9e15 }));
    const v1 = (await store.get(KEY, "les_pend0001"))!;
    await store.commit(KEY, await store.setVersion(KEY), [{ ...v1, version: 2, status: "stale" }], 2);
    await rollbackLessonSet(deps, { ...KEY, targetSetVersion: 1, expectedSetVersion: 2, actorId: "owner" });
    expect((await store.get(KEY, "les_pend0001"))!.status).toBe("pending");
  });
});

describe("the people a tier needs are counted as members", () => {
  const two = [{ approvalId: "a1", by: "ann-old", at: 1, mode: "second_person" as const }, { approvalId: "a2", by: "ann", at: 1, mode: "second_person" as const }];

  it("a restored tier-2 lesson approved by A and by B, where A was merged into B before the restore, has one approver and waits for a person; the same restore with no merge goes live", async () => {
    for (const [resolve, expected] of [[follow, "pending"], [undefined, "active"]] as const) {
      const { deps, store, dir } = setup(resolve);
      dir.value.eligibleIds = ["owner", "ann", "ann-old", "bob"];
      await seed(store, tier2(["carl"], { status: "active", approvals: two, expiresAt: 9e15 }));
      const v1 = (await store.get(KEY, "les_pend0001"))!;
      await store.commit(KEY, await store.setVersion(KEY), [{ ...v1, version: 2, status: "stale" }], 2);
      await rollbackLessonSet(deps, { ...KEY, targetSetVersion: 1, expectedSetVersion: 2, actorId: "owner" });
      expect((await store.get(KEY, "les_pend0001"))!.status).toBe(expected);
    }
  });

  it("approvedForUse: two approvals by one member are one person for tier 2", () => {
    const lesson = tier2(["carl"], { status: "active", approvals: two });
    expect(approvedForUse(lesson, DEFAULT_APPROVAL_POLICY)).toBe(true);
    expect(approvedForUse(lesson, DEFAULT_APPROVAL_POLICY, (id) => MERGES[id] ?? id)).toBe(false);
  });

  describe("the loader", () => {
    const review = (over: Parameters<typeof lessonRecord>[0] = {}) => tier2(["carl"], { status: "active", type: "review_check", stages: ["REVIEW"], approvals: two, expiresAt: 9e15, scope: {}, ...over });
    function loaderWorld(resolveMember?: LoadDeps["resolveMember"]) {
      const store = new InMemoryLessonStore();
      const deps: LoadDeps = { access: allowAllAccess, store, embedder, vectors: new MemoryVectors(), settings: settings(), audit: new Audit(), now: new Clock().now, ...(resolveMember === undefined ? {} : { resolveMember }) };
      return { store, deps };
    }
    const request = { workspaceId: WS, project: PROJECT, taskId: "t1", stage: "REVIEW" as const, round: 1, intent: "x", repos: ["api"], files: [], languages: [], taskAudience: { kind: "shared" as const } };

    it("a tier-2 review check approved by A and B (A merged into B) is not loaded; with no merge record it is", async () => {
      const merged = loaderWorld(follow);
      await seed(merged.store, review());
      expect((await loadLessonsForStage(merged.deps, request)).context?.lessons ?? []).toEqual([]);
      const plain = loaderWorld();
      await seed(plain.store, review());
      expect((await loadLessonsForStage(plain.deps, request)).context?.lessons.map((l) => l.id)).toEqual(["les_pend0001"]);
    });

    it("a merge record that cannot be read loads nothing (fail closed)", async () => {
      const down = loaderWorld(async () => { throw new Error("down"); });
      await seed(down.store, review());
      const result = await loadLessonsForStage(down.deps, request);
      expect(result).toMatchObject({ skipped: "members_unavailable" });
      expect(result.context).toBeUndefined();
    });
  });
});
