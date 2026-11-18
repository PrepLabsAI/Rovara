// Lead 4 L4-LP3Wd: every write of a project's lessons flags row is a conditional read-modify-write. A person's "stop reading this source" (`stoppedKinds`) is kept when the flood guard holds a source, raises the volume
// alert, resumes a held source or erases a person's source at the same moment, and the other way round. When the tries run out the writer fails closed: a stop reads as stopped, an erasure or a hold throws. Both stores run the same tests.
import { lessonSetKey } from "@agentx/contracts";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DocumentLessonStore } from "../../../packages/broker/src/lessons/document-store.js";
import { FLAGS_WRITE_TRIES, FlagsConflictError, updateFlags } from "../../../packages/broker/src/lessons/flags-fence.js";
import { setLearningSourcePause } from "../../../packages/broker/src/lessons/learning-sources.js";
import { pausedKindsFor } from "../../../packages/broker/src/lessons/paused-kinds.js";
import { clearSourcePause, noteCandidateSources } from "../../../packages/broker/src/lessons/sources.js";
import { InMemoryLessonStore, type LessonStore, type ProjectFlags, type ScopeKey } from "../../../packages/broker/src/lessons/store.js";
import { MemoryDocumentStore } from "../../../packages/broker/src/ports/memory-document-store.js";
import { Alerts, Audit, Clock } from "../lessons/lesson-helpers.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa";
const B = "org_bbbbbbbbbbbbbbbbbbbb";
const KEY: ScopeKey = { workspaceId: A, project: "web" };
const KEY_B: ScopeKey = { workspaceId: B, project: "web" };

const factories: Array<[string, () => LessonStore]> = [
  ["in-memory", () => new InMemoryLessonStore()],
  ["document store", () => new DocumentLessonStore(new MemoryDocumentStore())],
];

/** A store whose FIRST flags read is followed by `between` (another writer's whole write) before the read returns: the reader's copy is already stale when it writes. */
function racing(store: LessonStore, between: () => Promise<void>): LessonStore {
  let fired = false;
  return Object.assign(Object.create(store) as LessonStore, {
    flagsRev: async (key: ScopeKey) => { const read = await store.flagsRev(key); if (!fired) { fired = true; await between(); } return read; },
  });
}
/** A store where every conditional flags write loses its race. */
function alwaysLosing(store: LessonStore): { store: LessonStore; writes: () => number } {
  let writes = 0;
  const wrapped = Object.assign(Object.create(store) as LessonStore, { setFlagsIf: async () => { writes += 1; return false; } });
  return { store: wrapped, writes: () => writes };
}

const world = () => { const clock = new Clock(); const audit = new Audit(); return { clock, audit, deps: { now: clock.now, audit }, alerts: new Alerts() }; };
const stopSource = (store: LessonStore, w: ReturnType<typeof world>, key = KEY, paused = true, extra: { log?: (event: string, fields: Record<string, string>) => void } = {}) =>
  setLearningSourcePause({ store, audit: w.audit, now: w.clock.now, ...extra }, key, "owner", "task_decisions", paused);
/** A flood: enough notes for one source in one day to cross the spike line. */
const flood = async (store: LessonStore, w: ReturnType<typeof world>, source: string, key = KEY) => { for (let i = 0; i < 15; i += 1) await noteCandidateSources(w.deps, store, key, [source], w.alerts); };
const STOPPED = ["close_reason", "send_back"];
const stoppedOf = (flags: ProjectFlags): string[] => Object.keys(flags.stoppedKinds ?? {}).sort();

describe.each(factories)("the flags row is a conditional write (%s)", (_name, make) => {
  it("a stop that races a flood-guard hold: both survive", async () => {
    const store = make();
    const w = world();
    // The person's stop reads the row, then the flood guard holds a source, then the stop writes.
    const racedStop = racing(store, async () => { await flood(store, w, "slack:ramp"); });
    await stopSource(racedStop, w);
    expect(Object.keys((await store.flags(KEY)).pausedSources ?? {})).toEqual(["slack:ramp"]);
    expect(stoppedOf(await store.flags(KEY))).toEqual(STOPPED);
  });

  it("a flood-guard hold that races a stop: both survive", async () => {
    const store = make();
    const w = world();
    const racedGuard = racing(store, async () => { await stopSource(store, w); });
    await flood(racedGuard, w, "slack:ramp");
    expect(Object.keys((await store.flags(KEY)).pausedSources ?? {})).toEqual(["slack:ramp"]);
    expect(stoppedOf(await store.flags(KEY))).toEqual(STOPPED);
  });

  it("a stop that races the erasure of a person's source: both survive, and the erased person's hold is gone", async () => {
    const store = make();
    const w = world();
    await store.setFlags(KEY, { pausedSources: { "member:Ann": { at: 1, reason: "spike" }, "slack:C1": { at: 1, reason: "spike" } } });
    const racedStop = racing(store, async () => { await store.forgetSource(KEY, "member:ann"); });
    await stopSource(racedStop, w);
    expect(Object.keys((await store.flags(KEY)).pausedSources ?? {})).toEqual(["slack:C1"]);
    expect(stoppedOf(await store.flags(KEY))).toEqual(STOPPED);
  });

  it("an erasure that races a stop: both survive", async () => {
    const store = make();
    const w = world();
    await store.setFlags(KEY, { pausedSources: { "member:Ann": { at: 1, reason: "spike" } } });
    const racedErasure = racing(store, async () => { await stopSource(store, w); });
    await racedErasure.forgetSource(KEY, "member:ann");
    expect((await store.flags(KEY)).pausedSources).toEqual({});
    expect(stoppedOf(await store.flags(KEY))).toEqual(STOPPED);
  });

  it("a resume of a held source that races a stop: both survive", async () => {
    const store = make();
    const w = world();
    await store.setFlags(KEY, { pausedSources: { "slack:ramp": { at: 1, reason: "spike" } } });
    const racedResume = racing(store, async () => { await stopSource(store, w); });
    expect(await clearSourcePause(w.deps, racedResume, KEY, "slack:ramp", "owner")).toBe(true);
    expect((await store.flags(KEY)).pausedSources).toEqual({});
    expect(stoppedOf(await store.flags(KEY))).toEqual(STOPPED);
  });

  it("a stop that races the volume alert: both survive, and the alert is raised once", async () => {
    const store = make();
    const w = world();
    const racedStop = racing(store, async () => { for (let i = 0; i < 40; i += 1) await noteCandidateSources(w.deps, store, KEY, [`slack:c${i}`], w.alerts); });
    await stopSource(racedStop, w);
    const flags = await store.flags(KEY);
    expect(flags.volumeAlertedAt).toBeDefined();
    expect(stoppedOf(flags)).toEqual(STOPPED);
    expect(w.alerts.sent.filter((code) => code === "project_volume_spike")).toHaveLength(1);
  });

  it("a resume that races a flood-guard hold: the hold survives and the stop is lifted with its window", async () => {
    const store = make();
    const w = world();
    await stopSource(store, w);
    w.clock.advance(1_000);
    const racedResume = racing(store, async () => { await flood(store, w, "slack:ramp"); });
    await stopSource(racedResume, w, KEY, false);
    const flags = await store.flags(KEY);
    expect(Object.keys(flags.pausedSources ?? {})).toEqual(["slack:ramp"]);
    expect(stoppedOf(flags)).toEqual([]);
    expect((flags.stopWindows ?? []).map((window) => window.kind).sort()).toEqual(STOPPED);
  });

  it("a real concurrent stop and flood: both writers finish and both changes are on the row", async () => {
    const store = make();
    const w = world();
    await Promise.all([stopSource(store, w), flood(store, w, "slack:ramp")]);
    expect(Object.keys((await store.flags(KEY)).pausedSources ?? {})).toEqual(["slack:ramp"]);
    expect(stoppedOf(await store.flags(KEY))).toEqual(STOPPED);
  });

  it("a stale write is refused and changes nothing; an unconditional write raises the revision so a reader before it cannot write over it", async () => {
    const store = make();
    expect(await store.flagsRev(KEY)).toEqual({ flags: {}, rev: 0 });
    expect(await store.setFlagsIf(KEY, { volumeAlertedAt: 1 }, 0)).toBe(true);
    expect((await store.flagsRev(KEY)).rev).toBe(1);
    expect(await store.setFlagsIf(KEY, { volumeAlertedAt: 2 }, 0)).toBe(false);
    expect(await store.flags(KEY)).toEqual({ volumeAlertedAt: 1 });
    await store.setFlags(KEY, { stoppedKinds: { send_back: { at: 5 } } });
    expect(await store.setFlagsIf(KEY, { volumeAlertedAt: 3 }, 1)).toBe(false);
    expect(await store.flags(KEY)).toEqual({ stoppedKinds: { send_back: { at: 5 } } });
    expect((await store.flagsRev(KEY)).rev).toBe(2);
  });

  it("two companies: a stop, a failed stop and a revision in one company never reach the other", async () => {
    const store = make();
    const w = world();
    await stopSource(store, w);
    const losing = alwaysLosing(store);
    await expect(stopSource(losing.store, w, KEY_B)).rejects.toBeInstanceOf(FlagsConflictError);
    expect(await store.flagsRev(KEY_B)).toEqual({ flags: {}, rev: 0 });
    expect(stoppedOf(await store.flags(KEY))).toEqual(STOPPED);
    expect([...(await pausedKindsFor(store, KEY_B))].sort()).toEqual(STOPPED);
    expect([...(await pausedKindsFor(store, { workspaceId: B, project: "other" }))]).toEqual([]);
    expect([...(await pausedKindsFor(store, KEY))].sort()).toEqual(STOPPED);
    // The in-process stop of the failed company is lifted by its own resume (the test leaves nothing behind).
    await stopSource(store, w, KEY_B, false);
    expect([...(await pausedKindsFor(store, KEY_B))]).toEqual([]);
  });
});

describe("a flags row from before revisions (document store)", () => {
  it("reads as revision 0 and takes the first conditional write", async () => {
    const documents = new MemoryDocumentStore();
    const store = new DocumentLessonStore(documents);
    // The row as the unconditional writer left it: no `rev`.
    await documents.put({ item: { ...lessonSetKey(A, "web"), sk: "LESSONSET#FLAGS", entityType: "LESSON_FLAGS", flags: { volumeAlertedAt: 9 } } });
    expect(await store.flagsRev(KEY)).toEqual({ flags: { volumeAlertedAt: 9 }, rev: 0 });
    expect(await store.setFlagsIf(KEY, { volumeAlertedAt: 9, stoppedKinds: { send_back: { at: 1 } } }, 0)).toBe(true);
    expect((await store.flagsRev(KEY)).rev).toBe(1);
    expect(await store.setFlagsIf(KEY, {}, 0)).toBe(false);
  });
});

describe.each(factories)("the tries run out (%s)", (_name, make) => {
  it("updateFlags tries the fixed number of times, logs fixed words and throws", async () => {
    const losing = alwaysLosing(make());
    const logged: Array<[string, Record<string, string>]> = [];
    const counted: string[] = [];
    await expect(updateFlags(losing.store, KEY, (flags) => ({ ...flags, volumeAlertedAt: 1 }), { writer: "pause", log: (event, fields) => logged.push([event, fields]), metrics: { count: (name, tags) => counted.push(`${name}:${tags?.writer}`) } })).rejects.toThrow("kept changing");
    expect(losing.writes()).toBe(FLAGS_WRITE_TRIES);
    expect(FLAGS_WRITE_TRIES).toBe(5);
    expect(logged).toEqual([["lessons_flags_write_gave_up", { writer: "pause" }]]);
    expect(counted).toEqual(["lessons_flags_write_gave_up:pause"]);
    expect(JSON.stringify(logged)).not.toContain(A);
  });

  it("a change that needs nothing writes nothing and never counts as a lost race", async () => {
    const losing = alwaysLosing(make());
    expect(await updateFlags(losing.store, KEY, () => undefined, { writer: "pause" })).toEqual({ changed: false, flags: {} });
    expect(losing.writes()).toBe(0);
  });

  it("a stop that cannot be written reads as stopped, throws, logs fixed words; a later stop that lands settles it", async () => {
    const store = make();
    const w = world();
    const losing = alwaysLosing(store);
    const logged: Array<[string, Record<string, string>]> = [];
    await expect(stopSource(losing.store, w, KEY, true, { log: (event, fields) => logged.push([event, fields]) })).rejects.toBeInstanceOf(FlagsConflictError);
    expect(logged).toEqual([["lessons_flags_write_gave_up", { writer: "pause" }]]);
    expect(await store.flags(KEY)).toEqual({});
    // Nothing is recorded, but Rovara reads nothing of these kinds (and an unrelated kind is read as before).
    expect([...(await pausedKindsFor(store, KEY))].sort()).toEqual(STOPPED);
    expect([...(await pausedKindsFor(store, KEY, { from: 1 }))].sort()).toEqual(STOPPED);
    // The person presses again and it lands: the record decides.
    await stopSource(store, w);
    expect(stoppedOf(await store.flags(KEY))).toEqual(STOPPED);
    await stopSource(store, w, KEY, false);
    expect([...(await pausedKindsFor(store, KEY))]).toEqual([]);
  });

  it("a resume that cannot be written leaves the stop in place and throws", async () => {
    const store = make();
    const w = world();
    await stopSource(store, w);
    const losing = alwaysLosing(store);
    await expect(stopSource(losing.store, w, KEY, false)).rejects.toBeInstanceOf(FlagsConflictError);
    expect(stoppedOf(await store.flags(KEY))).toEqual(STOPPED);
    expect([...(await pausedKindsFor(store, KEY))].sort()).toEqual(STOPPED);
  });

  it("a resume after a failed stop that never landed clears the in-process stop", async () => {
    const store = make();
    const w = world();
    await expect(stopSource(alwaysLosing(store).store, w)).rejects.toBeInstanceOf(FlagsConflictError);
    await stopSource(store, w, KEY, false);
    expect([...(await pausedKindsFor(store, KEY))]).toEqual([]);
  });

  it("a flood-guard hold that cannot be written throws (the candidate is not let through)", async () => {
    const store = make();
    const w = world();
    const losing = alwaysLosing(store);
    await expect(flood(losing.store, w, "slack:ramp")).rejects.toBeInstanceOf(FlagsConflictError);
    expect((await store.flags(KEY)).pausedSources).toBeUndefined();
  });

  it("the volume alert still goes out when its marker cannot be written", async () => {
    const store = make();
    const w = world();
    const losing = alwaysLosing(store);
    for (let i = 0; i < 40; i += 1) { try { await noteCandidateSources(w.deps, losing.store, KEY, [`slack:c${i}`], w.alerts); } catch (error) { expect(error).toBeInstanceOf(FlagsConflictError); } }
    expect(w.alerts.sent).toContain("project_volume_spike");
  });

  it("an erasure that cannot write the flags throws (it is retried) and leaves the hold in place", async () => {
    const store = make();
    await store.setFlags(KEY, { pausedSources: { "member:Ann": { at: 1, reason: "spike" } } });
    const losing = alwaysLosing(store);
    if (store instanceof InMemoryLessonStore) {
      // The in-memory store erases in one step: it cannot lose a race (the document store is the durable one).
      await losing.store.forgetSource(KEY, "member:ann");
      expect((await store.flags(KEY)).pausedSources).toEqual({});
    } else {
      await expect(losing.store.forgetSource(KEY, "member:ann")).rejects.toBeInstanceOf(FlagsConflictError);
      expect(Object.keys((await store.flags(KEY)).pausedSources ?? {})).toEqual(["member:Ann"]);
    }
  });
});

describe("no other writer of the flags row", () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : path.endsWith(".ts") ? [path] : []; });
  it("only the stores themselves call setFlags (the unconditional seed); every other writer goes through updateFlags", () => {
    const callers = walk(join(__dirname, "../../../packages")).filter((file) => /\bsetFlags\(/u.test(readFileSync(file, "utf8"))).map((file) => file.slice(file.indexOf("packages/"))).sort();
    expect(callers).toEqual(["packages/broker/src/lessons/document-store.ts", "packages/broker/src/lessons/store.ts"]);
    const writers = walk(join(__dirname, "../../../packages")).filter((file) => /\bsetFlagsIf\(/u.test(readFileSync(file, "utf8"))).map((file) => file.slice(file.indexOf("packages/"))).sort();
    expect(writers).toEqual(["packages/broker/src/lessons/document-store.ts", "packages/broker/src/lessons/flags-fence.ts", "packages/broker/src/lessons/store.ts"]);
  });
});
