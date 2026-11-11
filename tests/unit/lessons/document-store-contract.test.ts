// The lesson store contract, run against BOTH stores (the in-memory one and the document-store one over the in-memory fake), then what only the document-store one has to get right: its keys sit where
// the project erase wipes them, the fence counter stops a commit that read before an erase, a rollback larger than one transaction still lands, a purge leaves nothing that names the lesson, and a
// staged rollback that does not finish is put back.
import { queryAll, teamRecordPk, type DocumentStore, type TransactItem } from "@agentx/contracts";
import { describe, expect, it } from "vitest";
import { DocumentLessonStore, MAX_COMMIT_WRITES } from "../../../packages/broker/src/lessons/document-store.js";
import { InMemoryLessonStore, type LessonStore, type LoadManifest } from "../../../packages/broker/src/lessons/store.js";
import type { Lesson } from "../../../packages/broker/src/lessons/types.js";
import { MemoryDocumentStore } from "../../../packages/broker/src/ports/memory-document-store.js";
import { draft, lessonRecord } from "./lesson-helpers.js";

const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa";
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb";
const KEY = { workspaceId: ORG_A, project: "web" };
const OTHER = { workspaceId: ORG_B, project: "web" };
const DAY = 86_400_000;
const mk = (id: string, over: Partial<Lesson> = {}): Lesson => lessonRecord({ id, workspaceId: ORG_A, project: "web", ...over });
const restricted = (principals: string[]) => ({ kind: "restricted" as const, acl: { source: "slack" as const, scope: "slack:T1/C1", principals, capturedAt: "2026-10-30T09:00:00.000Z", liveCheck: "none" as const } });
const withAuthors = (id: string, authors: string[], over: Partial<Lesson> = {}): Lesson => mk(id, { provenance: { ...draft().provenance, authors, audience: { kind: "project" } }, ...over });
const manifest = (taskId: string, ids: string[], over: Partial<LoadManifest> = {}): LoadManifest => ({
  taskId, workspaceId: ORG_A, project: "web", stage: "PLAN", round: 1, setVersion: 1, memory: "live", at: 5, bytes: 10,
  lessons: ids.map((id) => ({ id, version: 1, score: 1, why: "scope", citation: "valid" })), ...over,
});
const commit = async (store: LessonStore, ...lessons: Lesson[]) => store.commit(KEY, await store.setVersion(KEY), lessons, 10);

/** Commits in groups the store accepts (at most 30 lessons a commit); returns how many commits it took. */
async function commitAll(store: LessonStore, lessons: Lesson[]): Promise<number> {
  let commits = 0;
  for (let i = 0; i < lessons.length; i += 30) { await commit(store, ...lessons.slice(i, i + 30)); commits += 1; }
  return commits;
}

const factories: Array<[string, () => { store: LessonStore }]> = [
  ["in-memory", () => ({ store: new InMemoryLessonStore() })],
  ["document store", () => ({ store: new DocumentLessonStore(new MemoryDocumentStore()) })],
];

describe.each(factories)("the lesson store contract (%s)", (_name, make) => {
  it("commits in one conditional step: a stale set version or a skipped lesson version is a conflict and changes nothing", async () => {
    const { store } = make();
    expect(await commit(store, mk("les_a0000001"))).toEqual({ ok: true, setVersion: 1 });
    expect(await store.commit(KEY, 0, [mk("les_b0000001")], 1)).toEqual({ ok: false, reason: "conflict" });
    expect(await store.commit(KEY, 1, [{ ...mk("les_a0000001"), version: 3 }], 1)).toEqual({ ok: false, reason: "conflict" });
    expect(await store.get(KEY, "les_b0000001")).toBeUndefined();
    expect(await store.setVersion(KEY)).toBe(1);
    expect(await commit(store, { ...mk("les_a0000001", { title: "Second" }), version: 2 })).toEqual({ ok: true, setVersion: 2 });
    expect((await store.versions(KEY, "les_a0000001")).map((v) => v.title)).toEqual(["Retries use withRetry", "Second"]);
    expect((await store.snapshots(KEY)).map((s) => [s.setVersion, s.members.length])).toEqual([[0, 0], [1, 1], [2, 1]]);
  });
  it("fingerprints a text per project and repository with a project secret, and marks gone fingerprints: per project, cleared on request", async () => {
    const { store } = make();
    const other = { ...KEY, project: "other" };
    const hash = "0123456789abcdef";
    const a = (await store.textFingerprints(KEY, "github:repo/1", [hash, "fedcba9876543210"]));
    expect(a.get(hash)).toMatch(/^[0-9a-f]{32}$/u);
    expect(a.get(hash)).not.toBe(a.get("fedcba9876543210"));
    // Stable for the project, different for another repository and another project.
    expect((await store.textFingerprints(KEY, "github:repo/1", [hash])).get(hash)).toBe(a.get(hash));
    expect((await store.textFingerprints(KEY, "github:repo/2", [hash])).get(hash)).not.toBe(a.get(hash));
    expect((await store.textFingerprints(other, "github:repo/1", [hash])).get(hash)).not.toBe(a.get(hash));
    const fp = a.get(hash)!;
    expect([...await store.goneFingerprintsOf(KEY, [fp])]).toEqual([]);
    await store.markGoneFingerprint(KEY, fp);
    await store.markGoneFingerprint(KEY, fp);
    expect([...await store.goneFingerprintsOf(KEY, [fp, "0".repeat(32)])]).toEqual([fp]);
    expect([...await store.goneFingerprintsOf(other, [fp])]).toEqual([]);
    await store.clearGoneFingerprint(KEY, fp);
    await store.clearGoneFingerprint(KEY, fp);
    expect([...await store.goneFingerprintsOf(KEY, [fp])]).toEqual([]);
    expect([...await store.goneFingerprintsOf(KEY, [])]).toEqual([]);
  });
  it("listPage walks the set in id order a page at a time, filtered by status, and says where the next page starts", async () => {
    const { store } = make();
    for (let i = 1; i <= 5; i += 1) await commit(store, mk(`les_a000000${i}`, i === 3 ? { status: "retired" } : {}));
    const seen: string[] = [];
    let after: string | undefined;
    let pages = 0;
    do {
      const page = await store.listPage(KEY, { statuses: ["active"], limit: 2, ...(after === undefined ? {} : { after }) });
      seen.push(...page.lessons.map((l) => l.id));
      after = page.next;
      pages += 1;
    } while (after !== undefined);
    expect(seen).toEqual(["les_a0000001", "les_a0000002", "les_a0000004", "les_a0000005"]);
    expect(pages).toBe(3);
    expect(await store.listPage(OTHER, { limit: 2 })).toEqual({ lessons: [] });
    expect((await store.listPage(KEY, { limit: 10 })).lessons).toHaveLength(5);
    expect((await store.listPage(KEY, { limit: 10 })).next).toBeUndefined();
  });
  it("one commit writes a lesson once, and refuses a lesson of another scope", async () => {
    const { store } = make();
    await expect(commit(store, mk("les_a0000001"), mk("les_a0000001"))).rejects.toThrow();
    await expect(commit(store, mk("les_a0000001", { project: "other" }))).rejects.toThrow();
  });
  it("the workspace and project are part of every key: another scope sees nothing", async () => {
    const { store } = make();
    await commit(store, mk("les_a0000001"));
    expect(await store.list(OTHER)).toEqual([]);
    expect(await store.getHead(OTHER, "les_a0000001")).toBeUndefined();
    expect(await store.list({ workspaceId: ORG_A, project: "api" })).toEqual([]);
  });
  it("list and get see the current set; a head outside the set is only in listAllHeads and getHead", async () => {
    const { store } = make();
    await commit(store, mk("les_a0000001"));
    await commit(store, mk("les_b0000001", { status: "pending", approvals: [] }));
    expect((await store.list(KEY)).map((l) => l.id)).toEqual(["les_a0000001", "les_b0000001"]);
    expect((await store.list(KEY, { statuses: ["pending"] })).map((l) => l.id)).toEqual(["les_b0000001"]);
    await store.rollback(KEY, 1, 2, 11);
    expect(await store.get(KEY, "les_b0000001")).toBeUndefined();
    expect((await store.getHead(KEY, "les_b0000001"))?.id).toBe("les_b0000001");
    expect((await store.listAllHeads(KEY)).map((l) => l.id)).toEqual(["les_a0000001", "les_b0000001"]);
  });
  it("mutate changes the volatile fields in place, with no new version, and a commit never rewinds a counter", async () => {
    const { store } = make();
    await commit(store, mk("les_a0000001"));
    const stale = (await store.get(KEY, "les_a0000001"))!;
    const changed = await store.mutate(KEY, "les_a0000001", (l) => ({ counters: { ...l.counters, loaded: l.counters.loaded + 3 } }));
    expect(changed?.counters.loaded).toBe(3);
    expect(await store.versions(KEY, "les_a0000001")).toHaveLength(1);
    expect(await store.mutate(KEY, "les_zzzzzzz1", () => ({ expiresAt: 1 }))).toBeUndefined();
    await commit(store, { ...stale, version: 2, title: "Edited" });
    expect((await store.get(KEY, "les_a0000001"))).toMatchObject({ title: "Edited", counters: { loaded: 3 } });
  });
  it("a rollback restores the earlier set as a NEW set version, pending and needing a person; a tier only rises; usage is not rewound", async () => {
    const { store } = make();
    await commit(store, mk("les_a0000001", { tier: 0 }));
    await commit(store, { ...mk("les_a0000001", { tier: 1, tierReasons: ["escalated"] }), version: 2 });
    await store.mutate(KEY, "les_a0000001", (l) => ({ counters: { ...l.counters, helpful: 4 } }));
    const result = await store.rollback(KEY, 1, 2, 20);
    expect(result).toEqual({ ok: true, setVersion: 3, restored: ["les_a0000001"] });
    const back = (await store.get(KEY, "les_a0000001"))!;
    expect(back).toMatchObject({ version: 1, status: "pending", reviewRequired: true, tier: 1, counters: { helpful: 4 } });
    expect(back.approvals.filter((a) => a.mode === "auto")).toEqual([]);
    expect(await commit(store, { ...back, version: 3, title: "Next" })).toMatchObject({ ok: true });
    expect(await store.rollback(KEY, 5, await store.setVersion(KEY), 1)).toEqual({ ok: false, reason: "conflict" });
    expect(await store.rollback(KEY, 3, 3, 1)).toEqual({ ok: false, reason: "conflict" });
  });
  it("a rollback keeps retired, rejected and withdrawn lessons as they are and skips a purged one", async () => {
    const { store } = make();
    await commit(store, mk("les_ret00001"), mk("les_rej00001"), mk("les_wit00001"), mk("les_pur00001"), mk("les_act00001"));
    await commit(store, { ...mk("les_ret00001", { status: "retired" }), version: 2 }, { ...mk("les_rej00001", { status: "rejected" }), version: 2 });
    await store.markGone(KEY, "les_wit00001", "withdrawn");
    await store.purge(KEY, "les_pur00001");
    const result = await store.rollback(KEY, 1, 2, 30);
    expect(result).toMatchObject({ ok: true });
    expect((await store.get(KEY, "les_ret00001"))?.status).toBe("retired");
    expect((await store.get(KEY, "les_rej00001"))?.status).toBe("rejected");
    expect((await store.get(KEY, "les_pur00001"))).toBeUndefined();
    expect((await store.get(KEY, "les_act00001"))?.status).toBe("pending");
    expect((result as { restored: string[] }).restored).toEqual(["les_act00001", "les_wit00001"].filter((id) => id !== "les_wit00001"));
  });
  it("the fence: an erased person or a deleted row cannot be written back, a narrowing write is scrubbed instead, and a rollback leaves such content alone", async () => {
    const { store } = make();
    await commit(store, withAuthors("les_a0000001", ["mallory"]));
    await store.fence(KEY, { people: ["Mallory"], ids: ["row-1"] });
    expect(await store.isErased(KEY, "MALLORY")).toBe(true);
    expect(await store.isErased(KEY, "ann")).toBe(false);
    expect(await commit(store, withAuthors("les_b0000001", ["MALLORY"]))).toEqual({ ok: false, reason: "erased" });
    expect(await commit(store, { ...withAuthors("les_a0000001", ["mallory"]), version: 2, status: "retired" })).toMatchObject({ ok: true });
    expect((await store.getHead(KEY, "les_a0000001"))?.provenance.authors).toEqual([]);
    const recorded = withAuthors("les_c0000001", ["ann"], { provenance: { ...draft().provenance, authors: ["ann"], sourceEvents: ["row-1"], audience: { kind: "project" } } });
    expect(await commit(store, recorded)).toEqual({ ok: false, reason: "erased" });
  });
  it("the fence holds an erased person's SOURCE ids: they leave a lesson's audience at commit and at rollback", async () => {
    const { store } = make();
    await commit(store, mk("les_a0000001", { provenance: { ...draft().provenance, audience: restricted(["U1", "UX"]) } }));
    await commit(store, { ...mk("les_a0000001", { provenance: { ...draft().provenance, audience: restricted(["U1", "UX"]) } }), version: 2 });
    await store.fence(KEY, { sourceIds: ["UX"] });
    await commit(store, mk("les_b0000001", { provenance: { ...draft().provenance, audience: restricted(["UX", "U2"]) } }));
    expect(JSON.stringify(await store.getHead(KEY, "les_b0000001"))).not.toContain("UX");
    await store.rollback(KEY, 1, await store.setVersion(KEY), 40);
    expect(JSON.stringify(await store.getHead(KEY, "les_a0000001"))).not.toContain("UX");
  });
  it("a rollback leaves a lesson alone while a deletion of it is open", async () => {
    const { store } = make();
    await commit(store, mk("les_a0000001"));
    await commit(store, { ...mk("les_a0000001", { title: "Second" }), version: 2 });
    await store.putIntent(KEY, { id: "int-1", lessonId: "les_a0000001", kind: "forget", cause: "x", deleted: [], outcome: "scrub", inSet: true, done: [], finished: false, at: 1 });
    await store.rollback(KEY, 1, 2, 50);
    expect((await store.get(KEY, "les_a0000001"))).toMatchObject({ version: 2, title: "Second" });
  });
  it("intents: open and finished, listed oldest first, and a finished one is no longer open", async () => {
    const { store } = make();
    const intent = { id: "int-1", lessonId: "les_a0000001", kind: "withdraw" as const, cause: "c", deleted: ["r"], outcome: "withdraw" as const, inSet: true, done: [], finished: false, at: 5 };
    await store.putIntent(KEY, intent);
    await store.putIntent(KEY, { ...intent, id: "int-0", at: 1 });
    expect((await store.listIntents(KEY, { finished: false })).map((i) => i.id)).toEqual(["int-0", "int-1"]);
    await store.putIntent(KEY, { ...intent, done: ["a"], finished: true });
    expect((await store.listIntents(KEY, { finished: false })).map((i) => i.id)).toEqual(["int-0"]);
    expect((await store.listIntents(KEY, { finished: true })).map((i) => i.id)).toEqual(["int-1"]);
    expect((await store.listIntents(KEY)).map((i) => i.id)).toEqual(["int-0", "int-1"]);
    expect(await store.getIntent(KEY, "int-1")).toMatchObject({ finished: true, done: ["a"] });
    expect(await store.getIntent(KEY, "nope")).toBeUndefined();
  });
  it("noteHarm / takeBackHarm: the lessons a person's corrections marked harmful are handed to `apply` once each and forgotten only after it returned; a failing `apply` keeps the rest; a person with no reference, or another person, has none", async () => {
    const { store } = make();
    const ann = (await store.markRef(KEY, "ann"))!, bob = (await store.markRef(KEY, "bob"))!;
    await store.noteHarm(KEY, ann, "les_a0000001");
    await store.noteHarm(KEY, ann, "les_a0000001");
    await store.noteHarm(KEY, ann, "les_b0000001");
    await store.noteHarm(KEY, bob, "les_a0000001");
    const seen: string[] = [];
    await expect(store.takeBackHarm(KEY, "ann", async (id) => { seen.push(id); if (id === "les_b0000001") throw new Error("crash"); })).rejects.toThrow();
    expect(seen).toEqual(["les_a0000001", "les_b0000001"]);
    // The one that was applied is forgotten; the one whose apply failed is still there for the retry.
    const again: string[] = [];
    expect(await store.takeBackHarm(KEY, "ann", async (id) => { again.push(id); })).toEqual(["les_b0000001"]);
    expect(again).toEqual(["les_b0000001"]);
    expect(await store.takeBackHarm(KEY, "ann", async () => undefined)).toEqual([]);
    expect(await store.takeBackHarm(KEY, "nobody", async () => undefined)).toEqual([]);
    expect(await store.takeBackHarm(OTHER, "bob", async () => undefined)).toEqual([]);
    expect(await store.takeBackHarm(KEY, "bob", async () => undefined)).toEqual(["les_a0000001"]);
  });
  it("scrub rewrites the head AND every stored version; a purged lesson stays gone, with its manifest entries, once-keys and pending outcomes", async () => {
    const { store } = make();
    await commit(store, withAuthors("les_a0000001", ["mallory"]));
    await commit(store, { ...withAuthors("les_a0000001", ["mallory"]), version: 2 });
    await store.scrub(KEY, "les_a0000001", (l) => ({ ...l, provenance: { ...l.provenance, authors: [] } }));
    expect(JSON.stringify([await store.getHead(KEY, "les_a0000001"), await store.versions(KEY, "les_a0000001")])).not.toContain("mallory");
    expect((await store.versions(KEY, "les_a0000001")).map((v) => v.version)).toEqual([1, 2]);
    await commit(store, mk("les_b0000001"));
    await store.putManifest(manifest("task-1", ["les_a0000001", "les_b0000001"]));
    expect(await store.markOnce(KEY, "harmful:task-1:les_a0000001")).toBe(true);
    expect(await store.markOnce(KEY, "harmful:task-1:les_a0000001")).toBe(false);
    expect(await store.markOnce(KEY, "report:task-1:PLAN:1")).toBe(true);
    await store.addPending({ key: "helpful:task-1:les_a0000001", ...KEY, lessonId: "les_a0000001", taskId: "task-1", dueAt: 5 });
    await store.addPending({ key: "helpful:task-1:les_b0000001", ...KEY, lessonId: "les_b0000001", taskId: "task-1", dueAt: 6 });
    await store.purge(KEY, "les_a0000001");
    expect(await store.getHead(KEY, "les_a0000001")).toBeUndefined();
    expect(await store.versions(KEY, "les_a0000001")).toEqual([]);
    expect(await store.get(KEY, "les_a0000001")).toBeUndefined();
    expect((await store.manifests(KEY, "task-1"))[0]!.lessons.map((e) => e.id)).toEqual(["les_b0000001"]);
    expect(await store.markOnce(KEY, "harmful:task-1:les_a0000001")).toBe(true);
    expect(await store.markOnce(KEY, "report:task-1:PLAN:1")).toBe(false);
    expect((await store.duePending(KEY, 100, 10)).map((p) => p.lessonId)).toEqual(["les_b0000001"]);
    expect(await commit(store, { ...mk("les_a0000001"), version: 1 })).toEqual({ ok: false, reason: "erased" });
  });
  it("manifests: written once, listed by task, updated in place", async () => {
    const { store } = make();
    expect(await store.putManifest(manifest("task-1", []))).toBe(true);
    expect(await store.putManifest(manifest("task-1", []))).toBe(false);
    await store.putManifest(manifest("task-1", [], { stage: "REVIEW", at: 9 }));
    await store.putManifest(manifest("task-2", []));
    expect((await store.manifests(KEY, "task-1")).map((m) => m.stage)).toEqual(["PLAN", "REVIEW"]);
    await store.updateManifest(manifest("task-1", [], { bytes: 99 }));
    expect((await store.manifests(KEY, "task-1"))[0]!.bytes).toBe(99);
    await store.updateManifest(manifest("task-9", []));
    expect(await store.manifests(KEY, "task-9")).toEqual([]);
  });
  it("pending outcomes: due ones oldest first up to the limit; the same key again replaces; remove drops it", async () => {
    const { store } = make();
    const entry = (key: string, dueAt: number) => ({ key, ...KEY, lessonId: "les_a0000001", taskId: "t", dueAt });
    await store.addPending(entry("b", 20)); await store.addPending(entry("a", 10)); await store.addPending(entry("c", 30));
    expect((await store.duePending(KEY, 25, 10)).map((p) => p.key)).toEqual(["a", "b"]);
    expect((await store.duePending(KEY, 100, 2)).map((p) => p.key)).toEqual(["a", "b"]);
    await store.addPending(entry("a", 50));
    expect((await store.duePending(KEY, 25, 10)).map((p) => p.key)).toEqual(["b"]);
    await store.removePending(KEY, "b");
    await store.removePending(KEY, "missing");
    expect((await store.duePending(KEY, 100, 10)).map((p) => p.key)).toEqual(["c", "a"]);
  });
  it("hasPending: true for a lesson with a queued outcome, due or not; false for another lesson, after removal and after a purge. seenOnce reads a once-key without taking it", async () => {
    const { store } = make();
    await commit(store, mk("les_a0000001"), mk("les_b0000001"));
    expect(await store.hasPending(KEY, "les_a0000001")).toBe(false);
    await store.addPending({ key: "helpful:t:les_a0000001", ...KEY, lessonId: "les_a0000001", taskId: "t", dueAt: 10 * DAY });
    expect(await store.hasPending(KEY, "les_a0000001")).toBe(true);
    expect(await store.hasPending(KEY, "les_b0000001")).toBe(false);
    expect(await store.hasPending(OTHER, "les_a0000001")).toBe(false);
    await store.removePending(KEY, "helpful:t:les_a0000001");
    expect(await store.hasPending(KEY, "les_a0000001")).toBe(false);
    await store.addPending({ key: "helpful:u:les_a0000001", ...KEY, lessonId: "les_a0000001", taskId: "u", dueAt: 10 * DAY });
    await store.purge(KEY, "les_a0000001");
    expect(await store.hasPending(KEY, "les_a0000001")).toBe(false);
    expect(await store.seenOnce(KEY, "helpful-final:t:les_b0000001")).toBe(false);
    expect(await store.seenOnce(KEY, "helpful-final:t:les_b0000001")).toBe(false);
    expect(await store.markOnce(KEY, "helpful-final:t:les_b0000001")).toBe(true);
    expect(await store.seenOnce(KEY, "helpful-final:t:les_b0000001")).toBe(true);
    expect(await store.seenOnce(OTHER, "helpful-final:t:les_b0000001")).toBe(false);
  });
  it("source events: counted per day back from now, every spelling of a person is one source, and forgetting removes the counts and the pause", async () => {
    const { store } = make();
    const now = 100 * DAY;
    for (const at of [now, now - DAY + 1, now - DAY, now - 3 * DAY, now - 14 * DAY, now + 1]) await store.recordSourceEvent(KEY, { at, source: "member:Mallory" });
    await store.recordSourceEvent(KEY, { at: now, source: " member: mallory " });
    await store.recordSourceEvent(KEY, { at: now, source: "slack:C1" });
    expect(await store.sourceDays(KEY, "member:mallory", 4, now)).toEqual([3, 1, 0, 1]);
    expect((await store.sourceDays(KEY, "member:MALLORY", 15, now)).reduce((a, b) => a + b, 0)).toBe(6);
    await store.setFlags(KEY, { pausedSources: { "member:Mallory": { at: 1, reason: "spike" }, "slack:C1": { at: 1, reason: "spike" } } });
    await store.forgetSource(KEY, "member:mallory");
    expect(await store.sourceDays(KEY, "member:mallory", 15, now)).toEqual(new Array(15).fill(0));
    expect(await store.sourceDays(KEY, "slack:C1", 2, now)).toEqual([1, 0]);
    expect(Object.keys((await store.flags(KEY)).pausedSources ?? {})).toEqual(["slack:C1"]);
    expect(await make().store.flags(KEY)).toEqual({});
  });
  it("goneOf: answers withdrawn and purged for the ids that are gone, nothing for an unknown id, in chunks past 100 ids, and keeps projects apart", async () => {
    const { store } = make();
    const ids = Array.from({ length: 250 }, (_, i) => `les_g${String(i).padStart(7, "0")}`);
    await store.markGone(KEY, ids[3]!, "withdrawn");
    await store.markGone(KEY, ids[199]!, "purged");
    await store.purge(KEY, ids[249]!);
    const found = await store.goneOf(KEY, [...ids, "les_unknown1", ids[3]!]);
    expect([...found.entries()].sort()).toEqual([[ids[3], "withdrawn"], [ids[199], "purged"], [ids[249], "purged"]]);
    expect((await store.goneOf(OTHER, ids)).size).toBe(0);
    expect((await store.goneOf(KEY, [])).size).toBe(0);
  });
});

// ---- what only the document-store implementation has to get right

/** A document store that calls `before` ahead of every call and counts the calls; the hook may do other work (another writer's step) or throw. `fail` makes puts that match answer "condition failed". */
interface Hooks {
  before?: (call: { method: string; items?: readonly TransactItem[]; request?: unknown }) => Promise<void> | void;
  failPut?: (item: { pk: string; sk: string }) => boolean;
}
function hooked(inner: MemoryDocumentStore, hooks: Hooks): DocumentStore & { calls: number; transactions: Array<readonly TransactItem[]>; queries: Array<{ limit?: number | undefined }> } {
  const out = {
    calls: 0,
    transactions: [] as Array<readonly TransactItem[]>,
    queries: [] as Array<{ limit?: number | undefined }>,
    indexes: inner.indexes,
    async get(key: Parameters<DocumentStore["get"]>[0]) { await note("get"); return inner.get(key); },
    async getMany(keys: Parameters<DocumentStore["getMany"]>[0]) { await note("getMany"); return inner.getMany(keys); },
    async put(request: Parameters<DocumentStore["put"]>[0]) {
      await note("put", undefined, request);
      if (hooks.failPut?.(request.item) === true) return { applied: false as const, reason: "condition_failed" as const };
      return inner.put(request);
    },
    async update(request: Parameters<DocumentStore["update"]>[0]) { await note("update", undefined, request); return inner.update(request); },
    async delete(request: Parameters<DocumentStore["delete"]>[0]) { await note("delete", undefined, request); return inner.delete(request); },
    async query(request: Parameters<DocumentStore["query"]>[0]) { out.queries.push({ limit: request.limit }); await note("query", undefined, request); return inner.query(request); },
    async queryIndex(request: Parameters<DocumentStore["queryIndex"]>[0]) { await note("queryIndex"); return inner.queryIndex(request); },
    async transact(items: readonly TransactItem[]) { out.transactions.push(items); await note("transact", items); return inner.transact(items); },
  };
  async function note(method: string, items?: readonly TransactItem[], request?: unknown): Promise<void> {
    out.calls += 1;
    await hooks.before?.({ method, ...(items === undefined ? {} : { items }), ...(request === undefined ? {} : { request }) });
  }
  return out;
}

const PARTITION = teamRecordPk(ORG_A, "web");
const itemsOf = (db: MemoryDocumentStore) => queryAll(db, { pk: PARTITION });
const itemsWith = async (db: MemoryDocumentStore, test: (sk: string) => boolean) => (await itemsOf(db)).filter((item) => test(item.sk));
const touchesSnapshot = (items: readonly TransactItem[]): boolean => items.some((item) => item.kind === "put" && item.item.sk.startsWith("LESSONSET#SNAP#"));

describe("the document-store lesson store only", () => {
  const fresh = () => { const db = new MemoryDocumentStore(); return { db, store: new DocumentLessonStore(db) }; };

  it("the gone-text marks and their secret sit under LESSONSET (the project erase wipes them) and hold no bare text hash", async () => {
    const { db, store } = fresh();
    const hash = "0123456789abcdef";
    const fp = (await store.textFingerprints(KEY, "github:repo/1", [hash])).get(hash)!;
    await store.markGoneFingerprint(KEY, fp);
    const items = await itemsOf(db);
    expect(items.map((item) => item.sk).sort()).toEqual([`LESSONSET#GONETEXT#${fp}`, "LESSONSET#GONETEXTKEY"]);
    for (const item of items) expect(JSON.stringify(item).includes(hash)).toBe(false);
  });

  it("every item sits in the project's partition under a sort key the project erase wipes", async () => {
    const { db, store } = fresh();
    await commit(store, mk("les_a0000001", { provenance: { ...draft().provenance, audience: restricted(["U1"]) } }), mk("les_b0000001"));
    await commit(store, { ...mk("les_a0000001"), version: 2 });
    await store.putManifest(manifest("task-1", ["les_a0000001"]));
    await store.markOnce(KEY, "harmful:task-1:les_a0000001");
    await store.markOnce(KEY, "report:task-1:PLAN:1");
    await store.addPending({ key: "helpful:task-1:les_a0000001", ...KEY, lessonId: "les_a0000001", taskId: "task-1", dueAt: 5 });
    await store.recordSourceEvent(KEY, { at: 5, source: "slack:C1" });
    await store.setFlags(KEY, { volumeAlertedAt: 3 });
    await store.fence(KEY, { people: ["mallory"], ids: ["row-1"], sourceIds: ["UX"] });
    await store.putIntent(KEY, { id: "int-1", lessonId: "les_b0000001", kind: "forget", cause: "x", deleted: [], outcome: "scrub", inSet: true, done: [], finished: false, at: 1 });
    await store.putIntent(KEY, { id: "int-2", lessonId: "les_b0000001", kind: "forget", cause: "x", deleted: [], outcome: "scrub", inSet: true, done: [], finished: true, at: 2 });
    await store.markGone(KEY, "les_b0000001", "withdrawn");
    const items = await itemsOf(db);
    expect(items.length).toBeGreaterThan(15);
    // A project erase deletes the partition by these prefixes: nothing may sit anywhere else.
    expect(items.filter((item) => !/^(LESSON#|LESSONSET|LOAD#)/u.test(item.sk))).toEqual([]);
    // Nothing is written outside this project's partition.
    expect(db.size).toBe(items.length);
    expect(items.find((item) => item.sk.startsWith("LESSONSET#SRC#"))?.["indexExpiresAt"]).toEqual(expect.any(Number));
  });

  it("hasPending asks for one pending reference and stops, never reading them all", async () => {
    const db = new MemoryDocumentStore();
    const spy = hooked(db, {});
    const store = new DocumentLessonStore(spy);
    await commit(store, mk("les_a0000001"));
    for (const t of ["t1", "t2", "t3"]) await store.addPending({ key: `helpful:${t}:les_a0000001`, ...KEY, lessonId: "les_a0000001", taskId: "t", dueAt: 10 * DAY });
    spy.queries.length = 0;
    expect(await store.hasPending(KEY, "les_a0000001")).toBe(true);
    expect(spy.queries).toEqual([{ limit: 1 }]);
    spy.queries.length = 0;
    expect(await store.hasPending(KEY, "les_b0000001")).toBe(false);
    expect(spy.queries).toEqual([{ limit: 1 }]);
  });

  it("a commit that read before an erase fenced fails its transaction and then sees the fence", async () => {
    const db = new MemoryDocumentStore();
    const store = new DocumentLessonStore(db);
    await commit(store, withAuthors("les_a0000001", ["ann"]));
    // The writer reads now; the erase fences between the writer's reads and its transaction.
    let fenced = false;
    const racing = new DocumentLessonStore(hooked(db, { before: async (call) => { if (!fenced && call.method === "transact") { fenced = true; await store.fence(KEY, { people: ["mallory"] }); } } }));
    const result = await racing.commit(KEY, 1, [withAuthors("les_b0000001", ["Mallory"])], 5);
    expect(fenced).toBe(true);
    expect(result).toEqual({ ok: false, reason: "erased" });
    expect(await store.getHead(KEY, "les_b0000001")).toBeUndefined();
  });

  it("a rollback that restores more heads than one transaction holds still lands, every restored lesson pending", async () => {
    const db = new MemoryDocumentStore();
    const spy = hooked(db, {});
    const store = new DocumentLessonStore(spy);
    const ids = Array.from({ length: 130 }, (_, i) => `les_big${String(i).padStart(5, "0")}`);
    const first = await commitAll(store, ids.map((id) => mk(id)));
    const second = await commitAll(store, ids.map((id) => ({ ...mk(id, { title: "Later" }), version: 2 })));
    const before = spy.transactions.length;
    const result = await store.rollback(KEY, first, first + second, 99);
    expect(result).toMatchObject({ ok: true, setVersion: first + second + 1 });
    expect((result as { restored: string[] }).restored).toHaveLength(130);
    expect(spy.transactions.length - before).toBeGreaterThan(1);
    const list = await store.list(KEY);
    expect(list).toHaveLength(130);
    expect(new Set(list.map((l) => l.status))).toEqual(new Set(["pending"]));
    expect(new Set(list.map((l) => l.title))).toEqual(new Set(["Retries use withRetry"]));
  });

  it("is bounded: a commit of too many lessons throws, writing nothing", async () => {
    const { store } = fresh();
    await expect(commit(store, ...Array.from({ length: MAX_COMMIT_WRITES + 1 }, (_, i) => mk(`les_many${String(i).padStart(4, "0")}`)))).rejects.toThrow();
    expect(await store.setVersion(KEY)).toBe(0);
  });

  describe("a purge racing a commit", () => {
    const scenario = async (writesPurged: boolean, purgeBeforeCall: number | undefined) => {
      const db = new MemoryDocumentStore();
      const plain = new DocumentLessonStore(db);
      let armed = purgeBeforeCall;
      let seen = 0;
      const spy = hooked(db, { before: async () => { if (armed !== undefined && seen === armed) { armed = undefined; await plain.purge(KEY, "les_p0000001"); } seen += 1; } });
      const racing = new DocumentLessonStore(spy);
      await commit(plain, mk("les_p0000001"), mk("les_o0000001"));
      seen = 0;
      const next = writesPurged ? [{ ...mk("les_p0000001", { title: "Later" }), version: 2 }, { ...mk("les_o0000001", { title: "Later" }), version: 2 }] : [{ ...mk("les_o0000001", { title: "Later" }), version: 2 }];
      const result = await racing.commit(KEY, 1, next, 20);
      return { db, plain, result, calls: seen };
    };
    for (const writesPurged of [true, false]) {
      it(`${writesPurged ? "the commit writes the purged lesson" : "the commit writes another lesson from a read that still listed the purged one"}: every interleaving ends clean`, async () => {
        const clean = await scenario(writesPurged, undefined);
        expect(clean.result).toMatchObject({ ok: true });
        for (let k = 0; k < clean.calls; k += 1) {
          const run = await scenario(writesPurged, k);
          const ids = (await run.plain.list(KEY)).map((l) => l.id);
          expect(ids, `purge before call ${String(k)}`).not.toContain("les_p0000001");
          expect(await run.plain.getHead(KEY, "les_p0000001"), `head, purge before call ${String(k)}`).toBeUndefined();
          expect(await itemsWith(run.db, (sk) => sk.startsWith("LESSON#les_p0000001#V#")), `orphan versions, purge before call ${String(k)}`).toEqual([]);
          // The set item itself names no purged lesson (list would hide a member whose head is gone, so look at the item).
          const set = (await itemsWith(run.db, (sk) => sk === "LESSONSET"))[0];
          expect(Object.keys((set?.["members"] ?? {}) as Record<string, number>), `set members, purge before call ${String(k)}`).not.toContain("les_p0000001");
          expect((await run.plain.setVersion(KEY)) >= 1).toBe(true);
          expect(ids).toContain("les_o0000001");
        }
      });
    }
  });

  it("a purge that stopped after its GONE mark still stops a commit that read before it", async () => {
    const db = new MemoryDocumentStore();
    const plain = new DocumentLessonStore(db);
    let armed = true;
    const racing = new DocumentLessonStore(hooked(db, { before: async (call) => { if (armed && call.method === "transact") { armed = false; await plain.markGone(KEY, "les_p0000001", "purged"); } } }));
    await commit(plain, mk("les_p0000001"));
    expect(await racing.commit(KEY, 1, [{ ...mk("les_p0000001", { title: "Later" }), version: 2 }], 20)).toEqual({ ok: false, reason: "erased" });
    expect(await itemsWith(db, (sk) => sk.startsWith("LESSON#les_p0000001#V#"))).toHaveLength(1);
  });

  describe("a staged rollback that loses its final transaction", () => {
    const BIG = Array.from({ length: 130 }, (_, i) => `les_big${String(i).padStart(5, "0")}`);
    async function seeded(db: MemoryDocumentStore) {
      const store = new DocumentLessonStore(db);
      await commitAll(store, BIG.map((id) => mk(id)));
      await commitAll(store, BIG.map((id) => ({ ...mk(id, { title: "Later" }), version: 2 })));
      return store;
    }
    const intents = (db: MemoryDocumentStore) => itemsWith(db, (sk) => sk === "LESSONSET#RBINTENT");
    const dying = (db: MemoryDocumentStore) => new DocumentLessonStore(hooked(db, { before: (call) => { if (call.method === "transact" && call.items !== undefined && touchesSnapshot(call.items)) throw new Error("process died"); } }));

    it("the set moved under it: the rollback is a conflict and the lessons it had rewritten are back as they were", async () => {
      const db = new MemoryDocumentStore();
      const store = await seeded(db);
      let lost = false;
      const racing = new DocumentLessonStore(hooked(db, { before: async (call) => { if (!lost && call.method === "transact" && call.items !== undefined && touchesSnapshot(call.items)) { lost = true; await commit(store, mk("les_other001")); } } }));
      expect(await racing.rollback(KEY, 5, 10, 30)).toEqual({ ok: false, reason: "conflict" });
      expect(lost).toBe(true);
      const list = (await store.list(KEY)).filter((l) => l.id.startsWith("les_big"));
      expect(list).toHaveLength(130);
      expect(new Set(list.map((l) => l.status))).toEqual(new Set(["active"]));
      expect(new Set(list.map((l) => l.title))).toEqual(new Set(["Later"]));
      expect(await intents(db)).toEqual([]);
    });

    it("the process dies before the final transaction: the next commit, rollback or heal finds the open intent and puts everything back", async () => {
      for (const next of ["commit", "heal", "rollback"] as const) {
        const db = new MemoryDocumentStore();
        const store = await seeded(db);
        await expect(dying(db).rollback(KEY, 5, 10, 30)).rejects.toThrow("process died");
        expect((await store.list(KEY)).some((l) => l.status === "pending")).toBe(true);
        if (next === "commit") expect(await commit(store, mk("les_other001"))).toMatchObject({ ok: true });
        else if (next === "heal") await store.heal(KEY);
        else expect(await store.rollback(KEY, 5, 10, 40)).toMatchObject({ ok: true });
        if (next === "rollback") { expect((await store.list(KEY)).filter((l) => l.id.startsWith("les_big")).every((l) => l.status === "pending" && l.title !== "Later")).toBe(true); continue; }
        const list = (await store.list(KEY)).filter((l) => l.id.startsWith("les_big"));
        expect(list).toHaveLength(130);
        expect(new Set(list.map((l) => l.status))).toEqual(new Set(["active"]));
        expect(new Set(list.map((l) => l.title))).toEqual(new Set(["Later"]));
        expect(await intents(db)).toEqual([]);
        expect(await store.listAllHeads(KEY)).toHaveLength(next === "commit" ? 131 : 130);
      }
    });

    it("an early head group cannot land once the intent is no longer open (a heal got in first): nothing stays half rolled back", async () => {
      const db = new MemoryDocumentStore();
      const store = await seeded(db);
      let healed = false;
      const racing = new DocumentLessonStore(hooked(db, { before: async (call) => {
        const early = call.method === "transact" && call.items !== undefined && !touchesSnapshot(call.items) && call.items.some((item) => item.kind === "check" && item.key.sk === "LESSONSET#RBINTENT");
        if (!healed && early) { healed = true; await store.heal(KEY); }
      } }));
      const result = await racing.rollback(KEY, 5, 10, 30);
      expect(healed).toBe(true);
      const big = (await store.list(KEY)).filter((l) => l.id.startsWith("les_big"));
      expect(big).toHaveLength(130);
      // Either the retry landed the whole rollback (all pending, set flipped) or it lost and everything is as it was (all active): never a mix.
      const statuses = new Set(big.map((l) => l.status));
      expect(statuses.size).toBe(1);
      expect(result.ok ? [...statuses][0] === "pending" : [...statuses][0] === "active").toBe(true);
      expect(await intents(db)).toEqual([]);
    });

    it("a heal that cannot finish throws and KEEPS the intent: a missing version item, or a lesson that keeps changing under it", async () => {
      const dieAndLeaveIntent = async () => {
        const db = new MemoryDocumentStore();
        const store = await seeded(db);
        await expect(dying(db).rollback(KEY, 5, 10, 30)).rejects.toThrow("process died");
        return { db, store };
      };
      const missing = await dieAndLeaveIntent();
      // The version the set holds for one rewritten lesson is gone.
      const early = ((await intents(missing.db))[0]?.["ids"] as string[])[0]!;
      await missing.db.delete({ key: { pk: PARTITION, sk: `LESSON#${early}#V#000000000002` } });
      await expect(missing.store.heal(KEY)).rejects.toThrow();
      expect(await intents(missing.db)).toHaveLength(1);
      await expect(missing.store.heal(KEY)).rejects.toThrow();
      expect(await intents(missing.db)).toHaveLength(1);

      const busy = await dieAndLeaveIntent();
      const stubborn = new DocumentLessonStore(hooked(busy.db, { failPut: (item) => item.sk.startsWith("LESSON#les_big") }));
      await expect(stubborn.heal(KEY)).rejects.toThrow();
      expect(await intents(busy.db)).toHaveLength(1);
    });

    it("a write that meets a stuck intent is refused as busy, and the fifth refusal is recorded as an alert on the intent", async () => {
      const db = new MemoryDocumentStore();
      const store = await seeded(db);
      await expect(dying(db).rollback(KEY, 5, 10, 30)).rejects.toThrow("process died");
      // The version item the heal needs is gone, so every write that meets the intent is refused.
      const early = ((await intents(db))[0]?.["ids"] as string[])[0]!;
      await db.delete({ key: { pk: PARTITION, sk: `LESSON#${early}#V#000000000002` } });
      const lines: string[] = [];
      const careful = new DocumentLessonStore(db, Date.now, (id) => id, (event) => { lines.push(event); });
      for (let i = 0; i < 5; i += 1) await expect(commit(careful, mk(`les_new${String(i).padStart(5, "0")}`))).rejects.toMatchObject({ code: "LESSON_BUSY" });
      expect(lines).toContain("lessons.intent_stuck_alert");
      expect((await intents(db))[0]?.["stuckAt"]).toEqual(expect.any(Number));
      expect(await store.hasStuckRollback(KEY)).toBe(true);
    });

    it("a rollback still lands when nothing goes wrong, and leaves no intent behind", async () => {
      const db = new MemoryDocumentStore();
      const store = await seeded(db);
      expect(await store.rollback(KEY, 5, 10, 30)).toMatchObject({ ok: true });
      expect(await intents(db)).toEqual([]);
    });
  });

  it("snapshots() is bounded: it reads only the newest ones", async () => {
    const { db, store } = fresh();
    await commit(store, mk("les_a0000001"));
    for (let version = 2; version <= 1_200; version += 1) await db.put({ item: { pk: PARTITION, sk: `LESSONSET#SNAP#${String(version).padStart(12, "0")}`, entityType: "LESSON_SNAPSHOT", setVersion: version, at: version, members: [] } });
    const snaps = await store.snapshots(KEY);
    expect(snaps.length).toBeLessThanOrEqual(501);
    expect(snaps.at(-1)?.setVersion).toBe(1_200);
    expect(snaps.map((s) => s.setVersion)).toEqual([...snaps.map((s) => s.setVersion)].sort((a, b) => a - b));
  });

  it("a counter changed while a writer decides is not overwritten, and a lost head race retries on fresh state", async () => {
    const db = new MemoryDocumentStore();
    const store = new DocumentLessonStore(db);
    await commit(store, mk("les_a0000001"));
    let once = false;
    const racing = new DocumentLessonStore(hooked(db, { before: async (call) => { if (!once && call.method === "transact") { once = true; await store.mutate(KEY, "les_a0000001", (l) => ({ counters: { ...l.counters, loaded: 7 } })); } } }));
    const stale = (await racing.get(KEY, "les_a0000001"))!;
    const result = await racing.commit(KEY, 1, [{ ...stale, version: 2, title: "Edited" }], 5);
    expect(result).toEqual({ ok: true, setVersion: 2 });
    expect(await store.get(KEY, "les_a0000001")).toMatchObject({ title: "Edited", counters: { loaded: 7 } });
  });
});
