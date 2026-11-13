// ( review): a lesson learned from a task that was project-wide must stop reaching the project once that task is narrowed. Every lesson read goes through `readVisible`, which asks the
// LIVE visibility of every task the lesson was learned from (`supportTasks`, task citations, the Rovara events it cites), in one batched read, and fails closed.
import { describe, expect, it } from "vitest";
import { LEARNED_CONTEXT_FEATURE, OrgIdSchema, learnedRefsOf, type LearnedRefs } from "../../../packages/contracts/src/index.js";
import { buildWeeklyDigest } from "../../../packages/core/src/lessons/digest.js";
import { learnedContextFromRefs, type DeliveryDeps } from "../../../packages/core/src/lessons/deliver.js";
import { createLessonLiveReader, liveVisible, lessonTaskRefs } from "../../../packages/core/src/lessons/live-visibility.js";
import { learnedContextForDispatch, loadLessonsForStage, type LoadDeps, type LoadRequest } from "../../../packages/core/src/lessons/load.js";
import { readVisible, readVisibleRanked } from "../../../packages/core/src/lessons/read-visible.js";
import { InMemoryLessonStore } from "../../../packages/core/src/lessons/store.js";
import { withLessonAudiences, type LessonAudiencePort, type LessonTaskAudience } from "../../../packages/core/src/lessons/task-audience.js";
import { buildLessonsView, type LessonViewDeps } from "../../../packages/core/src/lessons/view.js";
import type { AccessCheckPort } from "../../../packages/core/src/lessons/access-port.js";
import type { TaskVisibilityPort } from "../../../packages/core/src/lessons/access-port.js";
import type { Lesson } from "../../../packages/core/src/lessons/types.js";
import { Audit, Clock, KEY, MemoryVectors, PROJECT, WS, directory, embedder, lessonRecord, seed, settings, wideAudience, NO_VECTORS } from "./lesson-helpers.js";

/** A lesson-audience port over a table (a task missing from the table, or mapped to undefined, is unknown; "throw" throws). Counts its batched reads. */
function audiencePort(table: Record<string, LessonTaskAudience | undefined | "throw">) {
  const reads: string[][] = [];
  const value: LessonAudiencePort = {
    async read(_org, ids) {
      reads.push([...ids]);
      const out = new Map<string, LessonTaskAudience | undefined>();
      for (const id of ids) {
        const v = table[id];
        if (v === "throw") throw new Error("down");
        out.set(id, v);
      }
      return out;
    },
  };
  return { value, reads };
}
const ROSTER = new Set(["x", "y", "z", "ann", "bob", "owner"]);
/** A project task's audience: the project's roster (x, y, z, ann, bob, owner) minus the denied, plus its owner x and the people named. */
const aud = (over: Partial<LessonTaskAudience> = {}): LessonTaskAudience => wideAudience({ extras: new Set(["x"]), onRoster: async (person) => ROSTER.has(person), ...over });
/** The lessons' ports: the audiences (the table) riding on a task-visibility port that is the TEAM RECORD's and must never be read for a lesson (its reads are counted: `teamReads`). */
function lessonPorts(table: Record<string, LessonTaskAudience | undefined | "throw">) {
  const audiences = audiencePort(table);
  const teamReads: string[][] = [];
  const team: TaskVisibilityPort = { async read(_org, ids) { teamReads.push([...ids]); return new Map(ids.map((id) => [id, { kind: "private" as const, ownerDeveloperId: "nobody" }])); } };
  return { value: withLessonAudiences(team, audiences.value), reads: audiences.reads, teamReads };
}
const accessOf = (tasks: TaskVisibilityPort): AccessCheckPort => ({ mayRead: async (_o, _v, places) => places.map(() => true), taskVisibility: tasks });
const fromTasks = (id: string, tasks: string[], over: Partial<Lesson> = {}): Lesson =>
  lessonRecord({ id, type: "convention", tier: 1, approvals: [{ approvalId: "ap", by: "ann", at: 1, mode: "one" }], provenance: { ...lessonRecord().provenance, supportTasks: tasks }, ...over });
const asReader = (developerId: string | undefined) => (developerId === undefined ? undefined : { principals: [], groups: [], developerId });
const idsOf = (lessons: readonly Lesson[]): string[] => lessons.map((l) => l.id);

describe("which tasks a lesson was learned from", () => {
  it("collects supportTasks, task citations, Rovara source events (both id forms), record citations and task places", () => {
    const l = fromTasks("les_aaaaaaa1", ["t1"], {
      citations: [{ kind: "task", taskId: "t2" }, { kind: "record", eventId: "task:t3:sendback:s1" }],
      provenance: { ...lessonRecord().provenance, supportTasks: ["t1"], sourceEvents: ["rovara:task:t4:note:n1", "task:t5", "ev-1", "slack:C1:123"], sourceScopes: ["rovara:project/p", "rovara:task/t6"] },
    });
    expect(lessonTaskRefs(l)).toEqual({ taskIds: ["t1", "t2", "t4", "t5", "t3", "t6"], unreadable: false });
  });
  it("a lesson with no task names none, and a malformed task id is unreadable", () => {
    expect(lessonTaskRefs(fromTasks("les_aaaaaaa1", [], { provenance: { ...lessonRecord().provenance, supportTasks: [], sourceEvents: ["ev-1"] } }))).toEqual({ taskIds: [], unreadable: false });
    expect(lessonTaskRefs(fromTasks("les_aaaaaaa1", ["bad id!"])).unreadable).toBe(true);
  });
});

describe("liveVisible (one module, fail closed)", () => {
  const key = KEY;
  it("nobody in particular: a source task with a People denial hides the lesson; lessons whose tasks are all open to the whole project are unchanged", async () => {
    const p = lessonPorts({ ok: aud(), narrowed: aud({ denied: new Set(["z"]) }) });
    const kept = await liveVisible({ port: p.value, key, viewer: undefined, where: "t", lessons: [fromTasks("les_okokokok", ["ok"]), fromTasks("les_narrowed", ["narrowed"])] });
    expect(idsOf(kept)).toEqual(["les_okokokok"]);
    // The Team record's resolver is never asked for a lesson.
    expect(p.teamReads).toEqual([]);
  });

  it("a task in another project is not open to THIS project, whatever it denies", async () => {
    const p = lessonPorts({ other: aud({ project: "other" }), same: aud() });
    expect(idsOf(await liveVisible({ port: p.value, key, viewer: undefined, where: "t", lessons: [fromTasks("les_otherproj", ["other"]), fromTasks("les_sameproj1", ["same"])] }))).toEqual(["les_sameproj1"]);
  });

  it("a lesson with several source tasks is withheld if any one of them has a denial", async () => {
    const p = lessonPorts({ a: aud(), b: aud(), c: aud({ denied: new Set(["bob"]) }) });
    const lessons = [fromTasks("les_all_shrd", ["a", "b"]), fromTasks("les_one_narr", ["a", "b", "c"])];
    expect(idsOf(await liveVisible({ port: p.value, key, viewer: undefined, where: "t", lessons }))).toEqual(["les_all_shrd"]);
    // A person without a developer id is nobody in particular too.
    expect(idsOf(await liveVisible({ port: p.value, key, viewer: { principals: [], groups: [] } as never, where: "t", lessons }))).toEqual(["les_all_shrd"]);
  });

  it("a person sees a lesson when they can open every source task's session, and not otherwise", async () => {
    // mine hides bob and eve; list hides eve; an unshared task (owner ann) hides nobody. eve is not on the roster.
    const p = lessonPorts({ mine: aud({ denied: new Set(["bob", "eve"]), extras: new Set(["ann"]) }), list: aud({ denied: new Set(["eve"]) }), plain: aud({ extras: new Set(["ann"]) }) });
    const lessons = [fromTasks("les_from_mine", ["mine"]), fromTasks("les_from_list", ["list"]), fromTasks("les_from_both", ["mine", "list"]), fromTasks("les_from_plain", ["plain"])];
    expect(idsOf(await liveVisible({ port: p.value, key, viewer: asReader("ann"), where: "t", lessons }))).toEqual(["les_from_mine", "les_from_list", "les_from_both", "les_from_plain"]);
    expect(idsOf(await liveVisible({ port: p.value, key, viewer: asReader("bob"), where: "t", lessons }))).toEqual(["les_from_list", "les_from_plain"]);
    // eve is denied on two and is not on the roster: she can open the plain task only if it names her or the company; here it does not.
    expect(idsOf(await liveVisible({ port: p.value, key, viewer: asReader("eve"), where: "t", lessons }))).toEqual([]);
    // A person NAMED on a task (a People entry or share) can open it though they are not on the roster.
    const named = lessonPorts({ plain: aud({ extras: new Set(["eve"]) }), wide: aud({ orgWide: true }) });
    expect(idsOf(await liveVisible({ port: named.value, key, viewer: asReader("eve"), where: "t", lessons: [fromTasks("les_from_plain", ["plain"]), fromTasks("les_from_wide1", ["wide"])] }))).toEqual(["les_from_plain", "les_from_wide1"]);
    // The decider is NOT special-cased: the task owner is just a person who is in (or out of) the audience.
    expect(p.teamReads).toEqual([]);
  });

  it("a read that throws, a missing task or an unreadable audience withholds the lesson (and logs counts and codes only)", async () => {
    const lines: Array<[string, Record<string, unknown>]> = [];
    const log = (event: string, fields: Record<string, unknown>): void => { lines.push([event, fields]); };
    const lesson = fromTasks("les_secretone", ["task-secret-id"]);
    for (const viewer of [undefined, asReader("ann")]) {
      expect(await liveVisible({ port: lessonPorts({ "task-secret-id": "throw" }).value, key, viewer, where: "t", lessons: [lesson], log })).toEqual([]);
      expect(await liveVisible({ port: lessonPorts({ "task-secret-id": undefined }).value, key, viewer, where: "t", lessons: [lesson], log })).toEqual([]);
      expect(await liveVisible({ port: lessonPorts({}).value, key, viewer, where: "t", lessons: [lesson], log })).toEqual([]);
      expect(await liveVisible({ port: undefined, key, viewer, where: "t", lessons: [lesson], log })).toEqual([]);
      // A port that carries no lesson audiences (a Team-record-only port) reads nothing: there is no other rule.
      expect(await liveVisible({ port: { read: async (_o, ids) => new Map(ids.map((id) => [id, { kind: "shared" as const }])) }, key, viewer, where: "t", lessons: [lesson], log })).toEqual([]);
      expect(await liveVisible({ port: lessonPorts({ x: aud() }).value, key, viewer, where: "t", lessons: [fromTasks("les_badid0001", ["bad id!"])], log })).toEqual([]);
      expect(await liveVisible({ port: lessonPorts({ x: aud() }).value, key: { ...key, workspaceId: "not-an-org" }, viewer, where: "t", lessons: [lesson], log })).toEqual([]);
    }
    expect(lines.length).toBeGreaterThan(0);
    expect(JSON.stringify(lines)).not.toContain("task-secret-id");
    expect(lines.some(([event]) => event === "learning.t_live_withheld")).toBe(true);
  });

  it("a timeout withholds every lesson that names a task", async () => {
    const slow: LessonAudiencePort = { read: () => new Promise(() => undefined) };
    expect(await liveVisible({ port: withLessonAudiences({ read: async () => new Map() }, slow), key, viewer: undefined, where: "t", timeoutMs: 20, lessons: [fromTasks("les_slowslow1", ["a"])] })).toEqual([]);
  });

  it("batches: one read for all the lessons, none when no lesson names a task, each task asked once", async () => {
    const p = lessonPorts({ a: aud(), b: aud() });
    await liveVisible({ port: p.value, key, viewer: undefined, where: "t", lessons: [fromTasks("les_00000001", ["a", "b"]), fromTasks("les_00000002", ["a"]), fromTasks("les_00000003", ["b"])] });
    expect(p.reads).toEqual([["a", "b"]]);
    const none = lessonPorts({});
    const free = fromTasks("les_00000004", [], { provenance: { ...lessonRecord().provenance, supportTasks: [], sourceEvents: ["ev-1"] } });
    expect(idsOf(await liveVisible({ port: none.value, key, viewer: undefined, where: "t", lessons: [free] }))).toEqual(["les_00000004"]);
    expect(none.reads).toEqual([]);
  });

  it("past the per-call bound a lesson is withheld, never shown", async () => {
    const table: Record<string, LessonTaskAudience> = {};
    const lessons = Array.from({ length: 7 }, (_, n) => fromTasks(`les_bound000${String(n)}`, Array.from({ length: 50 }, (_x, i) => { const id = `t${String(n * 50 + i)}`; table[id] = aud(); return id; })));
    const kept = await liveVisible({ port: lessonPorts(table).value, key, viewer: undefined, where: "t", lessons });
    expect(idsOf(kept)).toEqual(idsOf(lessons.slice(0, 6)));
  });
});

describe("readVisible applies it (so the delivery, the tab, Home, the digest, the panel and the queues all do)", () => {
  it("hides a lesson from nobody-in-particular once its task denies someone, and shows it to a person who can still open the task", async () => {
    const tasks: Record<string, LessonTaskAudience> = { t1: aud() };
    const access = accessOf(lessonPorts(tasks).value);
    const lesson = fromTasks("les_fromtask01", ["t1"]);
    expect(idsOf(await readVisible({ access, key: KEY, viewer: undefined, lessons: [lesson], where: "t" }))).toEqual(["les_fromtask01"]);
    tasks["t1"] = aud({ denied: new Set(["bob"]) });
    expect(await readVisible({ access, key: KEY, viewer: undefined, lessons: [lesson], where: "t" })).toEqual([]);
    expect(idsOf(await readVisible({ access, key: KEY, viewer: asReader("ann"), lessons: [lesson], where: "t" }))).toEqual(["les_fromtask01"]);
    expect(await readVisible({ access, key: KEY, viewer: asReader("bob"), lessons: [lesson], where: "t" })).toEqual([]);
  });

  it("an access port without the task reader withholds lessons that name a task (fail closed)", async () => {
    const access = { mayRead: async (_o: unknown, _v: unknown, places: readonly unknown[]) => places.map(() => true) } as unknown as AccessCheckPort;
    expect(await readVisible({ access, key: KEY, viewer: undefined, lessons: [fromTasks("les_fromtask01", ["t1"])], where: "t" })).toEqual([]);
  });
});

describe("every read path", () => {
  const T = OrgIdSchema.parse(WS);
  const world = (tasks: Record<string, LessonTaskAudience | undefined | "throw">) => {
    const p = lessonPorts(tasks);
    return { p, access: accessOf(p.value), store: new InMemoryLessonStore(), clock: new Clock() };
  };
  const narrowed = fromTasks("les_narrowed1", ["tn"]);
  const open = fromTasks("les_stayopen1", ["to"]);
  // tn denies z (and bob); to denies nobody.
  const tasks = { tn: aud({ denied: new Set(["z", "bob"]), extras: new Set(["ann"]) }), to: aud(), "task-9": aud() };

  it("dispatch loader: the lesson of a task that hides someone who can see the running task is not loaded, and the loader reads the tasks once (never the Team record's)", async () => {
    const w = world(tasks);
    const vectors = new MemoryVectors();
    await seed(w.store, narrowed, open);
    for (const l of [narrowed, open]) await vectors.upsert(l.workspaceId, l.project, l.id, await embedder.embed(`${l.title}\n${l.description}\n${l.body}`), { status: l.status });
    const deps: LoadDeps = { access: w.access, store: w.store, embedder, vectors, settings: settings(), audit: new Audit(), now: w.clock.now };
    const request: LoadRequest = { workspaceId: WS, project: PROJECT, taskId: "task-9", stage: "IMPLEMENT", round: 1, intent: "x", repos: ["api"], files: [], languages: [], taskAudience: { kind: "shared" } };
    const result = await loadLessonsForStage(deps, request);
    expect(result.context?.lessons.map((l) => l.id)).toEqual(["les_stayopen1"]);
    expect(w.p.reads.length).toBe(1);
    expect(w.p.teamReads).toEqual([]);
  });

  it("delivery: the reader is the running task's LIVE audience; a lesson whose source task hides someone who can see the running task is not delivered", async () => {
    // tn hides z; to hides nobody. Running tasks: run-wide (nobody hidden), run-hides-z (z hidden too), run-gone (unknown).
    const audiences = audiencePort({ tn: aud({ denied: new Set(["z"]), extras: new Set(["ann"]) }), to: aud(), "run-wide": aud(), "run-hides-z": aud({ denied: new Set(["z"]) }), "run-gone": undefined });
    const access = accessOf(withLessonAudiences({ read: async () => new Map() }, audiences.value));
    const w = { ...world(tasks), access };
    await seed(w.store, narrowed, open);
    const deps: DeliveryDeps = { store: w.store, settings: settings(), access: w.access, identity: async () => ({ principals: [], groups: [] }), now: w.clock.now };
    const refs = (taskId: string | undefined, audience: { kind: "shared" } | { kind: "private"; developerId: string } = { kind: "shared" }) => ({ v: 1 as const, orgId: WS, project: PROJECT, setVersion: 5, stage: "IMPLEMENT" as const, audience, ...(taskId === undefined ? {} : { taskId }), lessons: [{ id: "les_narrowed1", version: 1 }, { id: "les_stayopen1", version: 1 }] });
    // Positive control: a running task that hides z as well as tn does can only be seen by people who may see tn, so it gets both lessons.
    expect((await learnedContextFromRefs(deps, refs("run-hides-z")))?.lessons.map((l) => l.id)).toEqual(["les_narrowed1", "les_stayopen1"]);
    // z can see run-wide but not tn: the lesson of tn is not delivered.
    expect((await learnedContextFromRefs(deps, refs("run-wide")))?.lessons.map((l) => l.id)).toEqual(["les_stayopen1"]);
    // An unknown running task, and a stage queued before the task id was carried, get NO lesson that names a task (no fallback to the project-wide rule).
    expect(await learnedContextFromRefs(deps, refs("run-gone"))).toBeUndefined();
    expect(await learnedContextFromRefs(deps, refs(undefined))).toBeUndefined();
    // The stored audience is NOT trusted: a stage whose load saw an owner reads as the running task's audience now.
    expect((await learnedContextFromRefs(deps, refs("run-wide", { kind: "private", developerId: "ann" })))?.lessons.map((l) => l.id)).toEqual(["les_stayopen1"]);
    expect(await learnedContextFromRefs(deps, refs(undefined, { kind: "private", developerId: "ann" }))).toBeUndefined();
    // A task whose audience cannot be read delivers nothing from it.
    const down = world({ tn: undefined, to: undefined });
    await seed(down.store, narrowed, open);
    expect(await learnedContextFromRefs({ ...deps, store: down.store, access: accessOf(withLessonAudiences({ read: async () => new Map() }, audiencePort({}).value)) }, refs("run-hides-z"))).toBeUndefined();
  });

  it("digest, the Lessons tab and the Home count: the lesson of a task that denies the reader is not listed or counted", async () => {
    const w = world(tasks);
    const pending = (id: string, t: string): Lesson => fromTasks(id, [t], { status: "pending", approvals: [], pendingExpiresAt: 1_900_000_000_000 });
    await seed(w.store, narrowed, open, pending("les_pendnarr01", "tn"), pending("les_pendopen01", "to"));
    // The digest's reader here has no developer id: nobody in particular, so a task with a denial is out.
    const digest = await buildWeeklyDigest(w.store, KEY, w.clock.now(), { principals: [], groups: [] }, w.access);
    expect(digest.top.map((i) => i.id).sort()).toEqual(["les_pendopen01", "les_stayopen1"]);
    expect(digest.waiting.map((i) => i.id)).toEqual(["les_pendopen01"]);
    const dir = directory({ eligibleIds: ["owner", "bob"], ownerIds: ["owner"] });
    dir.identity = async (_ws, developerId) => ({ principals: [], groups: [], developerId });
    const deps: LessonViewDeps = { store: w.store, directory: dir, settings: settings(), access: w.access, now: w.clock.now, names: { isErased: async () => false, memberName: async (_o: string, id: string) => id } };
    // bob is denied on tn (and can't open that task), so he sees only the other lessons.
    const tab = await buildLessonsView(deps, { orgId: T, developerId: "bob" }, PROJECT);
    expect(tab.active.map((l) => l.id)).toEqual(["les_stayopen1"]);
    expect(tab.waiting.map((l) => l.id)).toEqual(["les_pendopen01"]); // the Home card counts `waiting` of this very view
    // A decider who is NOT the task owner but can open the task (not denied) sees the lessons of that unshared task: the owner shortcut is not needed.
    const ownerTab = await buildLessonsView(deps, { orgId: T, developerId: "owner" }, PROJECT);
    expect(ownerTab.active.map((l) => l.id).sort()).toEqual(["les_narrowed1", "les_stayopen1"]);
    expect(w.p.teamReads).toEqual([]);
  });
});


// ---- the reader of an agent's lessons

describe("the reader of an agent's lessons is the audience of the RUNNING task, compared as sets with every source task's", () => {
  const P = "task-p";
  const lessonL = fromTasks("les_fromtaskp", [P]);
  const noTask = fromTasks("les_notaskatall", [], { provenance: { ...lessonRecord().provenance, supportTasks: [], sourceEvents: ["ev-1"] } });
  const stage = (audiences: Record<string, LessonTaskAudience | undefined | "throw">, options: { bare?: boolean } = {}) => {
    const a = audiencePort(audiences);
    const teamReads: string[][] = [];
    const team: TaskVisibilityPort = { async read(_o, ids) { teamReads.push([...ids]); return new Map(ids.map((id) => [id, { kind: "shared" as const }])); } };
    const store = new InMemoryLessonStore();
    const clock = new Clock();
    const access = accessOf(options.bare === true ? team : withLessonAudiences(team, a.value));
    const identityCalls: string[] = [];
    const load: LoadDeps = { store, vectors: NO_VECTORS, settings: settings(), access, audit: new Audit(), now: clock.now };


    // What the dispatcher does at a coding stage: load the lessons for the running task and keep only their ids and versions.
    const ask = async (): Promise<{ learnedRefs?: LearnedRefs }> => {
      const loaded = await learnedContextForDispatch(load, { workspaceId: WS, project: PROJECT, taskId: "task-run", stage: "IMPLEMENT", round: 1, intent: "Retry failed HTTP calls", repos: ["api"], files: [], languages: [], taskAudience: { kind: "shared" } }, [LEARNED_CONTEXT_FEATURE]);
      return loaded.learnedContext === undefined ? {} : { learnedRefs: learnedRefsOf(loaded.learnedContext, { orgId: WS, project: PROJECT, audience: { kind: "shared" }, taskId: "task-run" }) };
    };
    return { store, ask, identityCalls, reads: a.reads, teamReads };
  };
  const idsLoaded = async (w: ReturnType<typeof stage>) => (await w.ask()).learnedRefs?.lessons.map((l) => l.id);

  it("the reviewer's scenario: P's People list denies Z, X runs an unshared task T. Z can see T but not P, so P's lesson does NOT load; a lesson from a task that hides nobody does (positive control)", async () => {
    const w = stage({ [P]: aud({ denied: new Set(["z"]) }), "task-ok": aud(), "task-run": aud() });
    await seed(w.store, lessonL, fromTasks("les_stayopen1", ["task-ok"]));
    const result = await w.ask();
    expect(result.learnedRefs?.lessons.map((l) => l.id)).toEqual(["les_stayopen1"]);
    expect(result.learnedRefs?.taskId).toBe("task-run");
    expect(result.learnedRefs?.audience).toEqual({ kind: "shared" });
    // No single person is the reader any more: the owner shortcut is gone, and the Team record's resolver is never asked.
    expect(w.identityCalls).toEqual([]);
    expect(w.teamReads).toEqual([]);
  });

  it("T narrowed to a subset of P's audience (T also denies Z) loads P's lesson", async () => {
    const w = stage({ [P]: aud({ denied: new Set(["z"]) }), "task-run": aud({ denied: new Set(["z"]) }) });
    await seed(w.store, lessonL);
    expect(await idsLoaded(w)).toEqual(["les_fromtaskp"]);
  });

  it("T that hides MORE than P (P denies z, T denies z and y) loads; T that hides a different person (denies y only) does not", async () => {
    const more = stage({ [P]: aud({ denied: new Set(["z"]) }), "task-run": aud({ denied: new Set(["z", "y"]) }) });
    await seed(more.store, lessonL);
    expect(await idsLoaded(more)).toEqual(["les_fromtaskp"]);
    const other = stage({ [P]: aud({ denied: new Set(["z"]) }), "task-run": aud({ denied: new Set(["y"]) }) });
    await seed(other.store, lessonL);
    expect(await idsLoaded(other)).toBeUndefined();
  });

  it("P denies someone who is NOT on the roster (a Slack-channel member, an Auditor with a grant, a merged id) and T does not deny them: P's lesson does not load", async () => {
    // "slack-member" opens project tasks through the project's channel, so no roster row names them: only the denial comparison can keep P's lesson from them.
    const offRoster = (over: Partial<LessonTaskAudience>) => aud({ onRoster: async (person) => ROSTER.has(person), ...over });
    const w = stage({ [P]: offRoster({ denied: new Set(["slack-member"]) }), "task-run": offRoster({}) });
    await seed(w.store, lessonL);
    expect(await idsLoaded(w)).toBeUndefined();
    // Positive control: when T denies them too, the lesson loads.
    const both = stage({ [P]: offRoster({ denied: new Set(["slack-member"]) }), "task-run": offRoster({ denied: new Set(["slack-member"]) }) });
    await seed(both.store, lessonL);
    expect(await idsLoaded(both)).toEqual(["les_fromtaskp"]);
  });

  it("a project-wide T with a project-wide P loads; a denial on T but not on P loads", async () => {
    const wide = stage({ [P]: aud(), "task-run": aud() });
    await seed(wide.store, lessonL);
    expect(await idsLoaded(wide)).toEqual(["les_fromtaskp"]);
    const onT = stage({ [P]: aud(), "task-run": aud({ denied: new Set(["z"]) }) });
    await seed(onT.store, lessonL);
    expect(await idsLoaded(onT)).toEqual(["les_fromtaskp"]);
  });

  it("a person who reaches T by name but cannot reach P, a wider share on T, and a different project all withhold", async () => {
    const outsider = stage({ [P]: aud(), "task-run": aud({ extras: new Set(["x", "w"]) }) });
    await seed(outsider.store, lessonL);
    expect(await idsLoaded(outsider)).toBeUndefined();
    const shared = stage({ [P]: aud(), "task-run": aud({ orgWide: true }) });
    await seed(shared.store, lessonL);
    expect(await idsLoaded(shared)).toBeUndefined();
    const project = stage({ [P]: aud({ project: "other" }), "task-run": aud() });
    await seed(project.store, lessonL);
    expect(await idsLoaded(project)).toBeUndefined();
    // P shared with the same extras and the company: T may name w then.
    const named = stage({ [P]: aud({ extras: new Set(["x", "w"]) }), "task-run": aud({ extras: new Set(["x", "w"]) }) });
    await seed(named.store, lessonL);
    expect(await idsLoaded(named)).toEqual(["les_fromtaskp"]);
  });

  it("a read failure loads nothing: P's audience unreadable, every read throwing", async () => {
    const pUnknown = stage({ [P]: undefined, "task-run": aud() });
    await seed(pUnknown.store, lessonL);
    expect(await idsLoaded(pUnknown)).toBeUndefined();
    const pThrows = stage({ [P]: "throw", "task-run": "throw" });
    await seed(pThrows.store, lessonL);
    expect(await idsLoaded(pThrows)).toBeUndefined();
  });

  it("when the running task's audience cannot be read, EVERY lesson that names a task is withheld (no fallback to the project-wide rule); a lesson that names no task still loads", async () => {
    // Each of these would have loaded `les_stayopen1` (a project-wide source task) under the old fallback.
    const cases: Array<[string, ReturnType<typeof stage>]> = [
      ["unknown (gone or another company's)", stage({ [P]: aud(), "task-ok": aud(), "task-run": undefined })],
      ["throws", stage({ [P]: aud(), "task-ok": aud(), "task-run": "throw" })],
      ["no audience port wired", stage({}, { bare: true })],
    ];
    for (const [label, w] of cases) {
      await seed(w.store, lessonL, fromTasks("les_stayopen1", ["task-ok"]), noTask);
      expect(await idsLoaded(w), label).toEqual(["les_notaskatall"]);
    }
  });

  it("past the bound the running task is not read, and nothing that names a task loads", async () => {
    const lines: Array<[string, Record<string, unknown>]> = [];
    const reader = createLessonLiveReader({ port: lessonPorts({ "task-run": aud(), t1: aud() }).value, key: KEY, where: "t", running: { taskId: "task-run" }, maxTasks: 0, log: (event, fields) => { lines.push([event, fields]); } });
    expect(await reader.keep(undefined, [fromTasks("les_00000001", ["t1"]), noTask])).toEqual([noTask]);
    expect(lines.some(([event, fields]) => event.endsWith("_audience_unreadable") && fields.reason === "bound")).toBe(true);
  });

  it("a running reader without a task id keeps only the lessons that name no task", async () => {
    const reader = createLessonLiveReader({ port: lessonPorts({ t1: aud() }).value, key: KEY, where: "t", running: { taskId: undefined } });
    expect(idsOf(await reader.keep(undefined, [fromTasks("les_00000001", ["t1"]), noTask]))).toEqual(["les_notaskatall"]);
  });

  it("a timeout aborts the audience read and withholds the lessons that name a task", async () => {
    let aborted = false;
    const slow: LessonAudiencePort = { read: (_o, _i, options) => new Promise(() => { options?.signal?.addEventListener("abort", () => { aborted = true; }); }) };
    const reader = createLessonLiveReader({ port: withLessonAudiences({ read: async () => new Map() }, slow), key: KEY, where: "t", running: { taskId: "task-run" }, timeoutMs: 20 });
    expect(await reader.keep(undefined, [fromTasks("les_slowslow1", ["a"])])).toEqual([]);
    expect(aborted).toBe(true);
  });

  it("a person's roster entry that is slow to read is cut at the deadline too, and withholds (the comparison is bounded as well as the read)", async () => {
    let aborted = false;
    const hang = (over: Partial<LessonTaskAudience>) => aud({ onRoster: (_person, signal) => new Promise(() => { signal?.addEventListener("abort", () => { aborted = true; }); }), ...over });
    const reader = createLessonLiveReader({ port: lessonPorts({ "task-run": hang({ extras: new Set(["x", "w"]) }), t1: hang({ extras: new Set(["x"]) }) }).value, key: KEY, where: "t", running: { taskId: "task-run" }, timeoutMs: 30 });
    expect(await reader.keep(undefined, [fromTasks("les_00000001", ["t1"])])).toEqual([]);
    expect(aborted).toBe(true);
  });

  it("a running task's audience and every source task's are read once per request (one batch, remembered across calls)", async () => {
    const a = audiencePort({ "task-run": aud(), t1: aud(), t2: aud() });
    const reader = createLessonLiveReader({ port: withLessonAudiences({ read: async () => new Map() }, a.value), key: KEY, where: "t", running: { taskId: "task-run" } });
    expect(idsOf(await reader.keep(undefined, [fromTasks("les_00000001", ["t1"]), fromTasks("les_00000002", ["t2"])]))).toEqual(["les_00000001", "les_00000002"]);
    expect(idsOf(await reader.keep(undefined, [fromTasks("les_00000003", ["t1", "t2"])]))).toEqual(["les_00000003"]);
    expect(a.reads).toEqual([["task-run", "t1", "t2"]]);
  });
});

describe("a timed-out batch read is aborted", () => {
  it("the reader tells the port to stop when it stops waiting", async () => {
    let aborted = false;
    const slow: LessonAudiencePort = { read: (_o, _i, options) => new Promise(() => { options?.signal?.addEventListener("abort", () => { aborted = true; }); }) };
    expect(await liveVisible({ port: withLessonAudiences({ read: async () => new Map() }, slow), key: KEY, viewer: undefined, where: "t", timeoutMs: 20, lessons: [fromTasks("les_slowslow1", ["a"])] })).toEqual([]);
    expect(aborted).toBe(true);
  });
});

describe("rank and filter first, check in pages, one reader per request", () => {
  const manyOpen = (count: number, narrowedFirst: number) => {
    const table: Record<string, LessonTaskAudience> = { "task-9": aud() };
    const lessons = Array.from({ length: count }, (_, n) => {
      const task = `tm${String(n)}`;
      table[task] = n < narrowedFirst ? aud({ denied: new Set(["z"]) }) : aud();
      // Newer validation ranks higher (recency), so the narrowed ones rank FIRST.
      return fromTasks(`les_many${String(n).padStart(5, "0")}`, [task], { type: "convention", stages: ["IMPLEMENT"], updatedAt: 1_800_000_000_000 - n * 86_400_000, lastValidatedAt: 1_800_000_000_000 - n * 86_400_000 });
    });
    return { table, lessons };
  };
  const request: LoadRequest = { workspaceId: WS, project: PROJECT, taskId: "task-9", stage: "IMPLEMENT", round: 1, intent: "x", repos: ["api"], files: [], languages: [], taskAudience: { kind: "shared" } };

  it("load: a project with many lessons loads the best ones the running task may be given (not 'always the same first N'), reads only the tasks of the checked candidates, and stays inside the budget", async () => {
    const { table, lessons } = manyOpen(500, 100);
    const p = lessonPorts(table);
    const store = new InMemoryLessonStore();
    const clock = new Clock();
    await seed(store, ...lessons);
    const started = Date.now();
    // (The project's budget is raised to the caps: the default is 5 lessons and 2 KB per stage, and this test is about which twelve are chosen.)
    const result = await loadLessonsForStage({ access: accessOf(p.value), store, vectors: NO_VECTORS, settings: settings({ loadBudget: { lessons: 12, bytes: 6 * 1024 } }), audit: new Audit(), now: clock.now }, request);
    expect(Date.now() - started).toBeLessThan(2_500);
    // The 100 narrowed lessons rank first and are withheld; the twelve best open ones follow.
    expect(result.context?.lessons.map((l) => l.id)).toEqual(lessons.slice(100, 112).map((l) => l.id));
    // Paged: the tasks asked are those of the first pages only (100 narrowed + 12 + one page of slack), far fewer than the 500 of the project and never past the bound.
    const asked = p.reads.flat();
    expect(asked.length).toBeLessThan(300);
    expect(asked.length).toBeGreaterThanOrEqual(112);
    expect(new Set(asked).size).toBe(asked.length);
  });

  it("load: a slow State table is cut at the load budget and the lessons not yet checked are not offered", async () => {
    const { table, lessons } = manyOpen(400, 400);
    const slow: LessonAudiencePort = { read: async (_o, ids, options) => { await new Promise((r) => setTimeout(r, 400)); return new Map(ids.map((id) => [id, options?.signal?.aborted === true ? undefined : table[id]])); } };
    const store = new InMemoryLessonStore();
    await seed(store, ...lessons);
    const started = Date.now();
    const result = await loadLessonsForStage({ access: accessOf(withLessonAudiences({ read: async () => new Map() }, slow)), store, vectors: NO_VECTORS, settings: settings(), audit: new Audit(), now: new Clock().now }, request);
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(result.context).toBeUndefined();
  });

  it("load: lessons that are not active (retired, rejected, pending) cost no task read", async () => {
    const { table, lessons } = manyOpen(20, 0);
    const old = fromTasks("les_retiredone", ["t-retired"], { status: "retired" });
    const p = lessonPorts({ ...table, "t-retired": aud() });
    const store = new InMemoryLessonStore();
    await seed(store, ...lessons, old);
    await loadLessonsForStage({ access: accessOf(p.value), store, vectors: NO_VECTORS, settings: settings(), audit: new Audit(), now: new Clock().now }, request);
    expect(p.reads.flat()).not.toContain("t-retired");
  });

  it("the bound counts the tasks of the lessons actually checked, is logged as its own reason, and a lesson past it is withheld", async () => {
    const lines: Array<[string, Record<string, unknown>]> = [];
    const table: Record<string, LessonTaskAudience> = {};
    const lessons = Array.from({ length: 4 }, (_, n) => fromTasks(`les_bound000${String(n)}`, Array.from({ length: 50 }, (_x, i) => { const id = `b${String(n * 50 + i)}`; table[id] = aud(); return id; })));
    const reader = createLessonLiveReader({ port: lessonPorts(table).value, key: KEY, where: "t", maxTasks: 120, log: (event, fields) => { lines.push([event, fields]); } });
    expect(idsOf(await reader.keep(undefined, lessons))).toEqual(idsOf(lessons.slice(0, 2)));
    expect(lines.some(([event, fields]) => event.endsWith("_audience_unreadable") && fields.reason === "bound")).toBe(true);
  });

  it("readVisibleRanked stops once enough survive and one reader reads each task once across pages", async () => {
    const { table, lessons } = manyOpen(40, 5);
    const p = lessonPorts(table);
    const result = await readVisibleRanked({ access: accessOf(p.value), key: KEY, viewer: undefined, where: "t", ranked: lessons, pageSize: 6, enough: (kept) => kept.length >= 4 });
    expect(idsOf(result.kept)).toEqual(idsOf(lessons.slice(5, 12)));
    expect(result.checked).toBe(12);
    expect(p.reads.flat()).toEqual(lessons.slice(0, 12).map((l, n) => `tm${String(n)}`));
  });

  it("the Lessons tab for a reader who does not decide reads no retired, rejected or pending lesson's tasks; Home reads only the pending ones", async () => {
    const t = (id: string, status: Lesson["status"], task: string): Lesson => fromTasks(id, [task], { status, ...(status === "pending" ? { approvals: [] } : {}) });
    const table = { "ta": aud(), "tr": aud(), "tj": aud(), "tp": aud() };
    const tab = async (developerId: string, surface?: "home") => {
      const p = lessonPorts(table);
      const store = new InMemoryLessonStore();
      const clock = new Clock();
      await seed(store, t("les_active0001", "active", "ta"), t("les_retired001", "retired", "tr"), t("les_rejected01", "rejected", "tj"), t("les_pending001", "pending", "tp"));
      const dir = directory({ eligibleIds: ["owner"], ownerIds: ["owner"] });
      dir.identity = async (_ws, id) => ({ principals: [], groups: [], developerId: id });
      const deps: LessonViewDeps = { store, directory: dir, settings: settings(), access: accessOf(p.value), now: clock.now, names: { isErased: async () => false, memberName: async (_o: string, id: string) => id } };
      const view = await buildLessonsView(deps, { orgId: T, developerId }, PROJECT, surface === undefined ? {} : { surface });
      return { view, asked: p.reads.flat().sort() };
    };
    const T = OrgIdSchema.parse(WS);
    const reader = await tab("bob");
    expect(reader.view.active.map((l) => l.id)).toEqual(["les_active0001"]);
    expect(reader.asked).toEqual(["ta"]);
    const home = await tab("owner", "home");
    expect(home.view.waiting.map((l) => l.id)).toEqual(["les_pending001"]);
    expect(home.asked).toEqual(["tp"]);
    const full = await tab("owner");
    expect(full.asked).toEqual(["ta", "tj", "tp", "tr"]);
    expect(full.asked.length).toBe(new Set(full.asked).size);
  });
});

describe("re-learning cannot launder a narrowed task", () => {
  it("lessonTaskRefs reads the inherited tasks, so a lesson gated on them is hidden when one is narrowed", async () => {
    const relearned = fromTasks("les_relearned1", ["task-new"], { provenance: { ...lessonRecord().provenance, supportTasks: ["task-new"], inheritedTasks: ["task-p"] } });
    expect(lessonTaskRefs(relearned).taskIds).toEqual(["task-new", "task-p"]);
    const p = lessonPorts({ "task-new": aud(), "task-p": aud({ denied: new Set(["z"]) }) });
    expect(await liveVisible({ port: p.value, key: KEY, viewer: undefined, where: "t", lessons: [relearned] })).toEqual([]);
  });
});
