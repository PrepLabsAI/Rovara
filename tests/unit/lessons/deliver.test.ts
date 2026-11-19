// A stage's lessons are built from the lesson store AT DELIVERY from ids and versions, so a lesson erased, retired, withdrawn, expired, edited or hidden after the stage was queued is not delivered,
// and nothing but ids and versions needs to sit in an outbox row, a queue message or a dead-letter copy.
import { describe, expect, it } from "vitest";
import { learnedRefsOf, type LearnedRefs } from "../../../packages/contracts/src/index.js";
import { learnedContextFromRefs, type DeliveryDeps } from "../../../packages/broker/src/lessons/deliver.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import type { Lesson } from "../../../packages/broker/src/lessons/types.js";
import { lessonDeletionPort } from "../../../packages/broker/src/lessons/deletion.js";
import { Audit, Clock, KEY, WS, PROJECT, allSharedTasks, allowAllAccess, lessonRecord, seed, settings, NO_VECTORS } from "./lesson-helpers.js";

const ann = { approvalId: "ap-ann", by: "ann", at: 1, mode: "one" as const };
const SECRET = "Call the internal retry endpoint at the secret path before every request.";
const conv = (id: string, over: Partial<Lesson> = {}): Lesson => lessonRecord({ id, type: "convention", tier: 1, stages: ["UNDERSTAND", "PLAN", "IMPLEMENT"], approvals: [ann], scope: {}, ...over });
const restrictedTo = (principals: string[]) => ({ kind: "restricted" as const, acl: { source: "slack" as const, scope: "slack:T/C9", principals, capturedAt: "x", liveCheck: "none" as const } });
/** A lesson whose source place the access records must be asked about. */
const placed = (id: string, over: Partial<Lesson> = {}): Lesson => conv(id, { provenance: { ...lessonRecord().provenance, sourceScopes: ["slack:T/C9"] }, ...over });
const refs = (ids: Array<[string, number?]>, over: Partial<LearnedRefs> = {}): LearnedRefs => ({
  v: 1, orgId: WS, project: PROJECT, setVersion: 5, stage: "IMPLEMENT", audience: { kind: "shared" }, taskId: "task-run", lessons: ids.map(([id, version]) => ({ id, version: version ?? 1 })), ...over,
});

/** The running task is `task-run`, and every task is project-wide (`allSharedTasks`); delivery reads the running task's LIVE audience. */
const OWNER = "d".repeat(64);

function world(over: Partial<DeliveryDeps> = {}) {
  const store = new InMemoryLessonStore();
  const clock = new Clock();
  const deps: DeliveryDeps = { store, settings: settings(), access: allowAllAccess, identity: async () => ({ principals: [], groups: [] }), now: clock.now, ...over };
  return { store, clock, deps };
}

describe("learnedContextFromRefs", () => {
  it("builds the worker's context from the lessons as they are, in the order the refs name them", async () => {
    const { store, deps } = world();
    await seed(store, conv("les_aaaaaaa1", { title: "First", body: SECRET }), conv("les_aaaaaaa2", { title: "Second" }));
    const context = await learnedContextFromRefs(deps, refs([["les_aaaaaaa2"], ["les_aaaaaaa1"]]));
    expect(context).toMatchObject({ v: 1, setVersion: 5, stage: "IMPLEMENT" });
    expect(context?.lessons.map((l) => [l.id, l.title])).toEqual([["les_aaaaaaa2", "Second"], ["les_aaaaaaa1", "First"]]);
    expect(context?.lessons[1]?.body).toBe(SECRET);
  });

  it("the refs it is given hold no text (the round trip from a loaded context keeps ids and versions only)", () => {
    const context = { v: 1 as const, setVersion: 2, stage: "REVIEW" as const, lessons: [{ id: "les_aaaaaaa1", version: 3, type: "review_check" as const, title: "T", description: "D", body: SECRET, scopeLabel: "repo api", citations: [] }], priorLoaded: [{ id: "les_aaaaaaa2", type: "convention" as const, title: "Prior title" }] };
    const stored = learnedRefsOf(context, { orgId: WS, project: PROJECT, audience: { kind: "shared" } });
    expect(JSON.stringify(stored)).not.toMatch(/internal retry|Prior title|repo api/u);
    expect(stored.lessons).toEqual([{ id: "les_aaaaaaa1", version: 3 }]);
    expect(stored.priorLoaded).toEqual([{ id: "les_aaaaaaa2" }]);
  });

  describe("a lesson that changed since the stage was queued is not delivered", () => {
    it("erased: the person's lessons are hard-deleted, and an erased author is refused even before the purge", async () => {
      const { store, deps, clock } = world();
      const mallory = conv("les_mallory01", { title: "Mallory's rule", body: SECRET, provenance: { ...lessonRecord().provenance, authors: ["mallory"], sources: ["member:mallory"], inputSources: ["member:mallory"] } });
      await seed(store, mallory, conv("les_aaaaaaa1"));
      expect((await learnedContextFromRefs(deps, refs([["les_mallory01"], ["les_aaaaaaa1"]])))?.lessons.map((l) => l.id)).toEqual(["les_mallory01", "les_aaaaaaa1"]);
      // The fence is written BEFORE anything is removed: in that window the lesson still exists, and is not delivered.
      await store.fence(KEY, { people: ["mallory"] });
      expect((await learnedContextFromRefs(deps, refs([["les_mallory01"], ["les_aaaaaaa1"]])))?.lessons.map((l) => l.id)).toEqual(["les_aaaaaaa1"]);
      // After the erasure removed it, the same.
      await lessonDeletionPort({ store, vectors: NO_VECTORS, audit: new Audit(), now: clock.now }).erasePerson(WS, PROJECT, { developerId: "mallory" }, new Set());
      const after = await learnedContextFromRefs(deps, refs([["les_mallory01"], ["les_aaaaaaa1"]]));
      expect(after?.lessons.map((l) => l.id)).toEqual(["les_aaaaaaa1"]);
      expect(JSON.stringify(after)).not.toContain("secret path");
    });

    it("a person who is only in `readFrom` (their words were read to make the lesson, they are not an author) fences it too, and so for the reviewer's list of prior titles", async () => {
      const { store, deps } = world();
      const readMallory = (id: string, title: string): Lesson => conv(id, { title, provenance: { ...lessonRecord().provenance, authors: ["alice"], sources: ["member:alice"], inputSources: ["member:alice"], readFrom: ["mallory"] } });
      await seed(store, readMallory("les_readfrom01", "Read from Mallory"), conv("les_aaaaaaa1"));
      const asked = refs([["les_readfrom01"], ["les_aaaaaaa1"]], { priorLoaded: [{ id: "les_readfrom01" }, { id: "les_aaaaaaa1" }] });
      const before = await learnedContextFromRefs(deps, asked);
      expect(before?.lessons.map((l) => l.id)).toEqual(["les_readfrom01", "les_aaaaaaa1"]);
      expect(before?.priorLoaded?.map((l) => l.id)).toEqual(["les_readfrom01", "les_aaaaaaa1"]);
      await store.fence(KEY, { people: ["mallory"] });
      const after = await learnedContextFromRefs(deps, asked);
      expect(after?.lessons.map((l) => l.id)).toEqual(["les_aaaaaaa1"]);
      expect(after?.priorLoaded?.map((l) => l.id)).toEqual(["les_aaaaaaa1"]);
    });

    for (const [name, over] of [
      ["retired", { status: "retired" as const }], ["withdrawn", { status: "withdrawn" as const }], ["stale", { status: "stale" as const }], ["rejected", { status: "rejected" as const }],
      ["expired", { expiresAt: 1 }], ["a stale citation", { citationChecks: [{ index: 0, result: "stale" as const, at: 1 }] }], ["approvals no longer enough", { approvals: [] }],
    ] as const) {
      it(`${name}`, async () => {
        const { store, deps } = world();
        await seed(store, conv("les_gone0001", over as Partial<Lesson>), conv("les_aaaaaaa1"));
        expect((await learnedContextFromRefs(deps, refs([["les_gone0001"], ["les_aaaaaaa1"]])))?.lessons.map((l) => l.id)).toEqual(["les_aaaaaaa1"]);
      });
    }

    it("edited (a new version): the version the stage was queued with is not the lesson that is there now", async () => {
      const { store, deps } = world();
      await seed(store, conv("les_aaaaaaa1"));
      const v1 = (await store.get(KEY, "les_aaaaaaa1"))!;
      await store.commit(KEY, await store.setVersion(KEY), [{ ...v1, version: 2, title: "Edited" }], 2);
      expect(await learnedContextFromRefs(deps, refs([["les_aaaaaaa1", 1]]))).toBeUndefined();
      expect((await learnedContextFromRefs(deps, refs([["les_aaaaaaa1", 2]])))?.lessons.map((l) => l.title)).toEqual(["Edited"]);
    });

    it("no longer allowed for the stage", async () => {
      const { store, deps } = world();
      await seed(store, conv("les_aaaaaaa1", { stages: ["PLAN"] }));
      expect(await learnedContextFromRefs(deps, refs([["les_aaaaaaa1"]]))).toBeUndefined();
    });

    it("a missing lesson (purged, or never there) is simply left out", async () => {
      const { deps } = world();
      expect(await learnedContextFromRefs(deps, refs([["les_missing01"]]))).toBeUndefined();
    });
  });

  describe("learning turned Off, or the reader lost access, since", () => {
    it("project mode Off or Collect: nothing is delivered", async () => {
      for (const mode of ["Off", "Collect"] as const) {
        const { store, deps } = world({ settings: settings({ mode }) });
        await seed(store, conv("les_aaaaaaa1"));
        expect(await learnedContextFromRefs(deps, refs([["les_aaaaaaa1"]])), mode).toBeUndefined();
      }
    });

    it("a restricted lesson is never delivered to an agent (the reader is everyone who can open the task, not one owner), and nobody's identity is looked up", async () => {
      const restricted = conv("les_restrict1", { provenance: { ...lessonRecord().provenance, audience: restrictedTo(["gh-1"]) } });
      const access = (allowed: boolean) => ({ mayRead: async (_org: unknown, _viewer: unknown, places: readonly unknown[]) => places.map(() => allowed), taskVisibility: allSharedTasks });
      const privateRefs = refs([["les_restrict1"]], { audience: { kind: "private", developerId: OWNER }, taskId: "task-run" });
      const calls: string[] = [];
      for (const allowed of [true, false]) {
        const w = world({ access: access(allowed), identity: async (_w, id) => { calls.push(id); return { principals: ["gh-1"], groups: [] }; } });
        await seed(w.store, restricted);
        expect(await learnedContextFromRefs(w.deps, privateRefs)).toBeUndefined();
        expect(await learnedContextFromRefs(w.deps, refs([["les_restrict1"]]))).toBeUndefined();
      }
      expect(calls).toEqual([]);
    });

    it("an access record that cannot be read delivers nothing (fail closed)", async () => {
      const store = new InMemoryLessonStore();
      await seed(store, placed("les_aaaaaaa1"));
      const down = world({ store, access: { mayRead: async () => { throw new Error("down"); }, taskVisibility: allSharedTasks } });
      expect(await learnedContextFromRefs(down.deps, refs([["les_aaaaaaa1"]]))).toBeUndefined();
    });

    it("the store being down delivers nothing and throws nothing", async () => {
      const deps: DeliveryDeps = { ...world().deps, store: new Proxy({}, { get: () => async () => { throw new Error("db down"); } }) as never };
      expect(await learnedContextFromRefs(deps, refs([["les_aaaaaaa1"]]))).toBeUndefined();
    });
  });

  describe("the reviewer's list of earlier lessons", () => {
    it("is rebuilt from the store too: an erased or withdrawn or restricted lesson's title is not listed", async () => {
      const { store, deps } = world();
      await seed(store, conv("les_prior0001", { title: "Prior kept" }), conv("les_prior0002", { title: "Prior withdrawn", status: "withdrawn" }),
        conv("les_prior0003", { title: "Prior restricted", provenance: { ...lessonRecord().provenance, audience: restrictedTo(["gh-1"]) } }));
      const context = await learnedContextFromRefs(deps, refs([], { stage: "REVIEW", priorLoaded: [{ id: "les_prior0001" }, { id: "les_prior0002" }, { id: "les_prior0003" }, { id: "les_prior0004" }] }));
      expect(context?.priorLoaded).toEqual([{ id: "les_prior0001", type: "convention", title: "Prior kept" }]);
      expect(await learnedContextFromRefs(deps, refs([], { stage: "REVIEW", priorLoaded: [{ id: "les_prior0002" }] }))).toBeUndefined();
    });
  });
});
