// The pull request description's Lessons used section: what the reader behind it may name. For a repository KNOWN to be private it lists the lessons, with a link per lesson to mark it not helpful
// (the link opens the task page, a page that asks); for a public repository or one of unknown visibility it carries only the count and one link. A restricted lesson is never named, and no title that names a person.
import { describe, expect, it } from "vitest";
import { lessonsUsedForTask, lessonsUsedReaderOver, lessonsUsedSection, notHelpfulUrl, setLessonsUsedReader, visibilityOfRepositories } from "../../../packages/lessons/src/used-in-pr.js";
import { InMemoryLessonStore, type LoadManifest } from "../../../packages/lessons/src/store.js";
import { withLessonAudiences, type LessonAudiencePort, type LessonTaskAudience } from "../../../packages/lessons/src/task-audience.js";
import { PROJECT, WS, allowAllAccess, draft, lessonRecord, seed, settings, wideAudience } from "./lesson-helpers.js";

const PAGE = "https://app.example.test/review/8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6/task";

describe("the reader behind it", () => {
  const manifest = (ids: Array<[string, LoadManifest["lessons"][number]["citation"]]>): LoadManifest => ({
    taskId: "task-1", workspaceId: WS, project: PROJECT, stage: "IMPLEMENT", round: 1, setVersion: 1, memory: "live", at: 1,
    lessons: ids.map(([id, citation]) => ({ id, version: 1, score: 0.5, why: "scope" as const, citation })), bytes: 10,
  });
  const input = { orgId: WS, project: PROJECT, taskId: "task-1", pageUrl: PAGE };
  const names = { memberName: async (_org: unknown, id: string) => ({ ann: "Ann Archer" })[id as "ann"], isErased: async () => false } as never;
  async function seeded(extra: Parameters<typeof lessonRecord>[0][] = []) {
    const store = new InMemoryLessonStore();
    const restricted = { ...draft().provenance, audience: { kind: "restricted" as const, acl: { source: "slack" as const, scope: "slack:C1", principals: ["U1"], capturedAt: "x", liveCheck: "none" as const } } };
    await seed(store, lessonRecord({ id: "les_open0001", title: "Open lesson", tier: 1 }), lessonRecord({ id: "les_secret01", title: "Secret lesson", provenance: restricted }), lessonRecord({ id: "les_dropped1", title: "Dropped lesson" }), ...extra.map((e) => lessonRecord(e)));
    await store.putManifest(manifest([["les_open0001", "valid"], ["les_secret01", "valid"], ["les_dropped1", "stale_dropped"], ["les_open0001", "moved"], ["les_gone0001", "valid"]]));
    return store;
  }
  it("a PRIVATE repository: names only lessons that reached the prompt and are open to the project; never a restricted one; none when learning is off", async () => {
    const store = await seeded();
    const read = lessonsUsedReaderOver({ store, settings: settings(), access: allowAllAccess, names, visibility: async () => "private" });
    expect(await read(input)).toEqual({ count: 1, taskUrl: PAGE, items: [{ id: "les_open0001", title: "Open lesson", notHelpfulUrl: `${PAGE}?notHelpful=les_open0001` }] });
    expect(await lessonsUsedReaderOver({ store, settings: settings({ mode: "Off" }), access: allowAllAccess, names, visibility: async () => "private" })(input)).toBeUndefined();
    expect(await read({ ...input, pageUrl: undefined })).toBeUndefined();
    expect(await read({ ...input, project: "other" })).toBeUndefined();
    expect(lessonsUsedSection(await read(input))).toEqual({ count: 1, taskUrl: PAGE, entries: [{ title: "Open lesson", notHelpfulUrl: `${PAGE}?notHelpful=les_open0001` }] });
  });

  it("a PUBLIC repository, an unknown one, a visibility that cannot be read, or no reader at all: the count and the link, never a title", async () => {
    const store = await seeded();
    for (const visibility of [async () => "public" as const, async () => "unknown" as const, async (): Promise<"private"> => { throw new Error("down"); }, undefined]) {
      const read = lessonsUsedReaderOver({ store, settings: settings(), access: allowAllAccess, names, ...(visibility === undefined ? {} : { visibility }) });
      const out = await read(input);
      expect(out).toEqual({ count: 1, taskUrl: PAGE, items: [] });
      expect(JSON.stringify(out)).not.toContain("Open lesson");
    }
  });

  it("a private repository still lists no tier-2 or review-check lesson, and no title or body that names a person (or whose authors cannot be named)", async () => {
    const store = await seeded([
      { id: "les_tier2001", title: "Tier two lesson", tier: 2 }, { id: "les_check001", title: "Review check lesson", type: "review_check", tier: 1 },
      { id: "les_named001", title: "Ask @ann first", tier: 1 }, { id: "les_body0001", title: "Plain title", body: "Ann Archer prefers withRetry here.", tier: 1, provenance: { ...draft().provenance, authors: ["ann"] } },
    ]);
    await store.putManifest({ ...manifest([["les_tier2001", "valid"], ["les_check001", "valid"], ["les_named001", "valid"], ["les_body0001", "valid"]]), round: 2 });
    const listed = (await lessonsUsedReaderOver({ store, settings: settings(), access: allowAllAccess, names, visibility: async () => "private" })(input))!;
    expect(listed.items.map((i) => i.id)).toEqual(["les_open0001"]);
    expect(listed.count).toBe(5);
    // Without a names reader nothing can be shown as harmless.
    const blind = (await lessonsUsedReaderOver({ store, settings: settings(), access: allowAllAccess, visibility: async () => "private" })(input))!;
    expect(blind.items).toEqual([]);
  });

  it("a lesson from a task that hides someone the pull request's task shows it to is neither counted nor named; one the task may still be given is counted, and NAMED only if every source task is open to the whole project", async () => {
    const store = await seeded([{ id: "les_narrow001", title: "Narrowed lesson", tier: 1, provenance: { ...draft().provenance, supportTasks: ["t-narrow"] } }, { id: "les_wide00001", title: "Wide lesson", tier: 1, provenance: { ...draft().provenance, supportTasks: ["t-wide"] } }]);
    await store.putManifest({ ...manifest([["les_narrow001", "valid"], ["les_wide00001", "valid"]]), round: 2 });
    const reads: string[][] = [];
    const table: Record<string, LessonTaskAudience> = { "task-1": wideAudience(), "t-narrow": wideAudience({ denied: new Set(["bob"]) }), "t-wide": wideAudience() };
    const gone = new Set<string>();
    // Every other task (the open lesson's) is open to the whole project.
    const audiences: LessonAudiencePort = { read: async (_o, ids) => { reads.push([...ids]); return new Map(ids.map((id) => [id, gone.has(id) ? undefined : table[id] ?? wideAudience()])); } };
    const access = { ...allowAllAccess, taskVisibility: withLessonAudiences({ read: async () => new Map() }, audiences) };
    const read = () => lessonsUsedReaderOver({ store, settings: settings(), access, names, visibility: async () => "private" })(input);
    // bob can open the pull request's task but not t-narrow: the lesson may not be given to this task, so it is not counted, and not named.
    const out = (await read())!;
    expect(out.items.map((i) => i.id).sort()).toEqual(["les_open0001", "les_wide00001"]);
    expect(out.count).toBe(2);
    expect(JSON.stringify(out)).not.toContain("Narrowed lesson");
    // Positive control: the narrowed task WAS asked about, so the exclusion came from its live audience; the count reader and the naming reader share their reads, so every source task is read ONCE for the whole description.
    expect(reads.flat()).toEqual(expect.arrayContaining(["t-narrow", "t-wide"]));
    for (const id of ["task-1", "t-narrow", "t-wide"]) expect(reads.flat().filter((read) => read === id), id).toHaveLength(1);
    // The task itself also hides bob: the lesson may be given to it, so it IS counted, but it is still not NAMED (a source task with a People denial is not open to the whole project): count and link only.
    table["task-1"] = wideAudience({ denied: new Set(["bob"]) });
    const counted = (await read())!;
    expect(counted.count).toBe(3);
    // (The open lesson was learned from this very task, which now has a People denial, so it is counted and not named either.)
    expect(counted.items.map((i) => i.id)).toEqual(["les_wide00001"]);
    expect(JSON.stringify(counted)).not.toContain("Narrowed lesson");
    // Once no source task denies anyone, all three are named.
    table["task-1"] = wideAudience();
    table["t-narrow"] = wideAudience();
    expect((await read())!.items.map((i) => i.id).sort()).toEqual(["les_narrow001", "les_open0001", "les_wide00001"]);
    // Is checked LIVE: nothing is named when the audiences cannot be read (the lessons are not even counted).
    gone.add("t-wide");
    expect((await read())!.items.map((i) => i.id)).not.toContain("les_wide00001");
    // And a pull request's task whose own audience cannot be read counts nothing at all.
    gone.add("task-1");
    expect(await read()).toBeUndefined();
  });

  it("the broker call never throws and is empty without a reader", async () => {
    setLessonsUsedReader(undefined);
    expect(await lessonsUsedForTask({ orgId: WS, project: PROJECT, taskId: "t", pageUrl: PAGE })).toBeUndefined();
    setLessonsUsedReader(async () => { throw new Error("down"); });
    expect(await lessonsUsedForTask({ orgId: WS, project: PROJECT, taskId: "t", pageUrl: PAGE })).toBeUndefined();
    setLessonsUsedReader(undefined);
  });

  it("the link is the task page with the lesson named, https only", () => {
    expect(notHelpfulUrl(`${PAGE}?x=1#top`, "les_a1")).toBe(`${PAGE}?notHelpful=les_a1`);
    expect(notHelpfulUrl("http://app.example.test/review/x/task", "les_a1")).toBeUndefined();
    expect(notHelpfulUrl("not a url", "les_a1")).toBeUndefined();
  });
});

describe("which repositories count as private", () => {
  it("private only when the host said so for every repository; one public one makes it public; anything it could not say is unknown", () => {
    expect(visibilityOfRepositories([{ private: true }, { private: true }])).toBe("private");
    expect(visibilityOfRepositories([{ private: true }, { private: false }])).toBe("public");
    expect(visibilityOfRepositories([{ private: true }, {}])).toBe("unknown");
    expect(visibilityOfRepositories([{ private: true }, undefined])).toBe("unknown");
    expect(visibilityOfRepositories([])).toBe("unknown");
  });
});
