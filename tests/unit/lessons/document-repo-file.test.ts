// The per-repository state of the lessons file in the document store: the in-memory store and the document-store one answer the same. Every write is conditional on the revision that was read; the items sit under
// the LESSONSET prefix the project and company erase wipe.
import { queryAll, teamRecordPk } from "@agentx/contracts";
import { describe, expect, it } from "vitest";
import { documentRepoFileStore } from "../../../packages/broker/src/lessons/document-repo-file.js";
import { InMemoryRepoFileStore, StateUnreadable, newRepoFileState } from "../../../packages/broker/src/lessons/repo-file-state.js";
import { MemoryDocumentStore } from "../../../packages/broker/src/ports/memory-document-store.js";
import { KEY, PLACE, OTHER_PLACE } from "./repo-file-helpers.js";

const stores = (): Array<[string, () => InMemoryRepoFileStore | ReturnType<typeof documentRepoFileStore>]> => [
  ["in memory", () => new InMemoryRepoFileStore()],
  ["document store", () => documentRepoFileStore(new MemoryDocumentStore())],
];

describe.each(stores())("the repo file state store: %s", (_name, make) => {
  it("creates once, then only under the revision that was read; a stale write is refused and changes nothing", async () => {
    const store = make();
    const first = await store.put(KEY, { ...newRepoFileState(PLACE, "api"), enabled: true }, 0);
    expect(first!.revision).toBe(1);
    expect(await store.put(KEY, newRepoFileState(PLACE, "other"), 0)).toBeUndefined();
    const second = await store.put(KEY, { ...first!, unmerged: 2 }, 1);
    expect(second).toMatchObject({ revision: 2, unmerged: 2 });
    expect(await store.put(KEY, { ...first!, unmerged: 9 }, 1)).toBeUndefined();
    expect(await store.get(KEY, PLACE)).toMatchObject({ revision: 2, unmerged: 2, name: "api" });
  });

  it("lists a project's repositories only, in place order, and keeps companies and projects apart", async () => {
    const store = make();
    await store.put(KEY, newRepoFileState(OTHER_PLACE, "web"), 0);
    await store.put(KEY, newRepoFileState(PLACE, "api"), 0);
    await store.put({ ...KEY, project: "proj-2" }, newRepoFileState(PLACE, "api"), 0);
    expect((await store.list(KEY)).map((s) => s.place)).toEqual([PLACE, OTHER_PLACE]);
    expect(await store.get({ ...KEY, project: "proj-3" }, PLACE)).toBeUndefined();
  });

  it("claims a row only if there is none (a lease), says since when another holds it, never lists it, and lets it go", async () => {
    const store = make();
    const lease = { place: PLACE, kind: "lease" as const, number: "lease-removal", ids: [], at: 100 };
    expect(await store.claimPr(KEY, lease)).toEqual({ claimed: true });
    expect(await store.claimPr(KEY, { ...lease, at: 900 })).toEqual({ claimed: false, heldSince: 100 });
    await store.putPr(KEY, { place: PLACE, kind: "watch", number: "0", ids: [], at: 1, repoUrl: "https://github.com/o/r", repoName: "api", unreachableAt: 5, unreachableLessons: 2, triedAt: 6 });
    expect((await store.listPrs(KEY)).rows).toEqual([expect.objectContaining({ kind: "watch", repoUrl: "https://github.com/o/r", repoName: "api", unreachableAt: 5, unreachableLessons: 2, triedAt: 6 })]);
    await store.delPr(KEY, PLACE, "lease-removal");
    expect(await store.claimPr(KEY, { ...lease, at: 1_000 })).toEqual({ claimed: true });
  });

  it("drops fields that are undefined (a cleared problem) instead of failing the write", async () => {
    const store = make();
    const saved = await store.put(KEY, { ...newRepoFileState(PLACE, "api"), problem: "file_too_big" }, 0);
    const cleared = await store.put(KEY, { ...saved!, problem: undefined }, 1);
    expect((await store.get(KEY, PLACE))!.problem).toBeUndefined();
    expect(cleared!.revision).toBe(2);
  });
});

describe("the document-store repo file state only", () => {
  it("keeps its items under the lessons prefix of the project's partition", async () => {
    const db = new MemoryDocumentStore();
    const store = documentRepoFileStore(db);
    await store.put(KEY, newRepoFileState(PLACE, "api"), 0);
    await store.putPr(KEY, { place: PLACE, kind: "watch", number: "0", ids: [], at: 1 });
    const items = await queryAll(db, { pk: teamRecordPk(KEY.workspaceId, KEY.project) });
    expect(items.map((item) => item.sk.replace(/#[0-9a-f]{16}.*$/u, "")).sort()).toEqual(["LESSONSET#REPOFILE", "LESSONSET#REPOFILEPR"]);
    expect(items.map((item) => item["entityType"]).sort()).toEqual(["LESSON_REPOFILE", "LESSON_REPOFILE_PR"]);
  });

  it("a stored state that does not parse throws when read and is skipped (and reported) when listed", async () => {
    const db = new MemoryDocumentStore();
    const seen: string[] = [];
    const store = documentRepoFileStore(db, { onUnreadable: (what) => seen.push(what) });
    await store.put(KEY, newRepoFileState(PLACE, "api"), 0);
    await store.put(KEY, newRepoFileState(OTHER_PLACE, "web"), 0);
    const [stored] = await queryAll(db, { pk: teamRecordPk(KEY.workspaceId, KEY.project), sk: { op: "beginsWith", prefix: "LESSONSET#REPOFILE#" } });
    await db.put({ item: { ...stored!, state: { nonsense: true } } });
    expect((await store.list(KEY)).length).toBe(1);
    expect(seen).toEqual(["state"]);
    const unreadable = (await Promise.allSettled([store.get(KEY, PLACE), store.get(KEY, OTHER_PLACE)])).filter((r) => r.status === "rejected");
    expect(unreadable).toHaveLength(1);
    expect((unreadable[0] as PromiseRejectedResult).reason).toBeInstanceOf(StateUnreadable);
  });
});
