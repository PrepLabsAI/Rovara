// Lessons phase 2, the nightly area checks (research Q2, decision 7): "area gone" puts a lesson under question; "area rewritten" asks a person; an answer that cannot be given marks nothing. No model, ids and fixed words only.
import { describe, expect, it } from "vitest";
import { AREA_CHECK_KEEP_MS, areaIsGone, areaWasRewritten, approvedAtOf, readAreaMarks, runAreaChecks, type AreaCheckPorts } from "../../../packages/broker/src/lessons/area-check.js";
import { codeHostAreaPorts } from "../../../packages/broker/src/lessons/area-check-hosts.js";
import { questionPk } from "../../../packages/broker/src/lessons/revert-question.js";
import { AREA_CHECK_KEEP_DAYS, AREA_REWRITTEN_SHARE } from "../../../packages/broker/src/lessons/scoring-settings.js";
import { readProjectSignals, cachedSignalsReader } from "../../../packages/broker/src/lessons/signals.js";
import { orderWeekly } from "../../../packages/broker/src/lessons/weekly-order.js";
import { KEY, PROJECT, WS, lessonRecord } from "./lesson-helpers.js";
import { A, B, DAY, world } from "./phase12-helpers.js";

const ports = (files: Record<string, readonly string[] | undefined>, changed?: AreaCheckPorts["changed"]): AreaCheckPorts => ({
  repositories: async () => Object.keys(files),
  files: async (_key, repository) => files[repository],
  ...(changed === undefined ? {} : { changed }),
});
const scoped = (id: string, paths: string[], repos: string[] = ["api"]) => lessonRecord({ id, scope: { repos, paths } });
async function run(w: Awaited<ReturnType<typeof world>>, p: AreaCheckPorts) {
  return runAreaChecks({ lessons: w.store, docs: w.documents, companyId: A, now: w.clock.now, ports: p }, KEY);
}

describe("area gone", () => {
  it("no file of the lesson's repository matches any of its patterns: it goes under question, once, and the weekly list shows it (golden)", async () => {
    const w = await world();
    await w.add(scoped("les_gone0001", ["src/legacy/**"]), scoped("les_here0001", ["src/billing/**"]));
    const result = await run(w, ports({ api: ["src/billing/money.ts", "README.md"] }));
    expect(result).toMatchObject({ checked: 2, gone: ["les_gone0001"], rewritten: [] });
    const marks = await readAreaMarks(w.documents, A, PROJECT, w.clock.now());
    expect([...marks]).toEqual([["les_gone0001", new Set(["area_gone"])]]);
    const signals = await readProjectSignals(w.documents, { companyId: A, project: PROJECT, now: w.clock.now() });
    expect(signals.questions.get("les_gone0001")).toEqual({ revertTasks: 0, areaGone: true, areaRewritten: false });
    const lesson = (await w.store.get(KEY, "les_gone0001"))!;
    expect(orderWeekly({ lessons: [lesson], now: w.clock.now(), extras: { underQuestion: signals.questions } }).needLook.map((r) => r.cause)).toEqual(["area_gone"]);
    // The lesson itself is untouched: no counter, no status, no expiry.
    expect(lesson.status).toBe("active");
    expect(lesson.counters).toEqual({ loaded: 0, helpful: 0, harmful: 0, citationStale: 0 });
  });

  it("and the loader ranks a lesson under question lower than an equal one (it still loads)", async () => {
    const w = await world();
    const same = { title: "Retries", body: "Retry failed HTTP calls in the api service with withRetry" };
    // (Equal words are ranked in id order by the similarity step: the questioned lesson is named to come first on that tie.)
    await w.add({ ...scoped("les_aaaa0001", ["src/**"]), ...same }, { ...scoped("les_bbbb0001", ["src/**"]), ...same });
    await w.documents.put({ item: { pk: questionPk(WS, PROJECT), sk: "A#les_aaaa0001#area_gone", entityType: "LESSON_QUESTION", kind: "area_gone", project: PROJECT, lessonId: "les_aaaa0001", at: w.clock.now(), keepUntil: w.clock.now() + DAY } });
    const loaded = await w.load({}, { ranking: { fitFloorWords: 0, fitFloorCosine: 0, newcomerSlots: 0 } });
    expect(loaded.manifest.lessons.map((l) => l.id)).toEqual(["les_bbbb0001", "les_aaaa0001"]);
  });

  it("MUTANT guards: a repository that cannot be listed whole, an unknown project, an unreadable listing, a lesson with no code area or with cited-lines only: nothing is marked", async () => {
    const w = await world();
    await w.add(scoped("les_unkn0001", ["src/legacy/**"]), lessonRecord({ id: "les_wide0001", scope: { repos: ["api"] } }));
    expect((await run(w, ports({ api: undefined }))).gone).toEqual([]);
    // A lesson that names no repository is checked against the project's repositories: when those are not known, nothing is marked.
    await w.store.scrub(KEY, "les_unkn0001", (l) => ({ ...l, scope: { paths: ["src/legacy/**"] } }));
    expect((await run(w, { repositories: async () => undefined, files: async () => ["x"] })).gone).toEqual([]);
    expect((await run(w, { repositories: async () => ["api"], files: async () => { throw new Error("host down"); } })).gone).toEqual([]);
    // Two repositories, one unlistable: the answer is unknown, not "gone".
    expect((await run(w, ports({ api: ["a.ts"], web: undefined }))).gone).toEqual([]);
    expect(await readAreaMarks(w.documents, A, PROJECT, w.clock.now())).toEqual(new Map());
  });

  it("a lesson whose area exists again is not marked, and the old mark lapses on its own after the keep time", async () => {
    const w = await world();
    await w.add(scoped("les_gone0001", ["src/legacy/**"]));
    await run(w, ports({ api: ["src/other.ts"] }));
    expect((await readAreaMarks(w.documents, A, PROJECT, w.clock.now())).size).toBe(1);
    w.clock.advance(AREA_CHECK_KEEP_MS + 1000);
    expect((await readAreaMarks(w.documents, A, PROJECT, w.clock.now())).size).toBe(0);
    expect(AREA_CHECK_KEEP_MS).toBe(AREA_CHECK_KEEP_DAYS * DAY);
    expect((await run(w, ports({ api: ["src/legacy/a.ts"] }))).gone).toEqual([]);
  });

  it("the pure tests", () => {
    expect(areaIsGone(["src/legacy/**"], ["src/billing/a.ts"])).toBe(true);
    expect(areaIsGone(["src/legacy/**"], ["./src/legacy/a.ts"])).toBe(false);
    expect(areaIsGone(["src/legacy/**"], [])).toBe(true);
  });
});

describe("area rewritten", () => {
  it("more than half of the lines of the area changed since a person approved it: a person is asked; not more than half, or not known: nothing (golden)", async () => {
    const w = await world();
    await w.add(scoped("les_rewr0001", ["src/billing/**"]), scoped("les_calm0001", ["src/search/**"]), scoped("les_unkn0001", ["src/auth/**"]));
    const seen: Array<{ since: number }> = [];
    const changed: AreaCheckPorts["changed"] = async (_key, input) => {
      seen.push({ since: input.since });
      if (input.globs[0] === "src/billing/**") return { changedLines: 600, totalLines: 1000 };
      if (input.globs[0] === "src/search/**") return { changedLines: 500, totalLines: 1000 };
      return undefined;
    };
    const result = await run(w, ports({ api: ["src/billing/a.ts", "src/search/a.ts", "src/auth/a.ts"] }, changed));
    expect(result.rewritten).toEqual(["les_rewr0001"]);
    expect(seen.every((s) => s.since === approvedAtOf((lessonRecord({ approvals: [{ approvalId: "ap-ann", by: "ann", at: 1, mode: "one" }], createdAt: 1 }))))).toBe(true);
    expect([...(await readAreaMarks(w.documents, A, PROJECT, w.clock.now()))]).toEqual([["les_rewr0001", new Set(["area_rewritten"])]]);
    expect(AREA_REWRITTEN_SHARE).toBe(0.5);
    expect(areaWasRewritten({ changedLines: 501, totalLines: 1000 })).toBe(true);
    expect(areaWasRewritten({ changedLines: 500, totalLines: 1000 })).toBe(false);
    expect(areaWasRewritten({ changedLines: 5, totalLines: 0 })).toBe(false);
    expect(areaWasRewritten(undefined)).toBe(false);
  });
});

describe("isolation, bounds and the code-host ports", () => {
  it("another company's or project's marks are never read, and a check for another company writes nothing", async () => {
    const w = await world();
    await w.add(scoped("les_gone0001", ["src/legacy/**"]));
    await run(w, ports({ api: ["a.ts"] }));
    expect((await readAreaMarks(w.documents, B, PROJECT, w.clock.now())).size).toBe(0);
    expect((await readAreaMarks(w.documents, A, "proj-2", w.clock.now())).size).toBe(0);
    expect(await runAreaChecks({ lessons: w.store, docs: w.documents, companyId: B, now: w.clock.now, ports: ports({ api: ["a.ts"] }) }, KEY)).toEqual({ checked: 0, gone: [], rewritten: [] });
    // The signals reader of the other company sees none either.
    expect(await cachedSignalsReader(w.documents, B, w.clock.now, { ttlMs: 0 }).read({ workspaceId: WS, project: PROJECT })).toBeUndefined();
  });

  it("a mark holds an id and fixed words only: no path, no file name, no person", async () => {
    const w = await world();
    await w.add(scoped("les_gone0001", ["src/secret-billing/**"]));
    await run(w, ports({ api: ["a.ts"] }));
    const all = JSON.stringify((await w.documents.query({ pk: questionPk(WS, PROJECT) })).items);
    expect(all).toContain("area_gone");
    expect(all).not.toMatch(/secret-billing|ann/u);
  });

  it("the code-host ports read the whole tree at one head or nothing, by repository name", async () => {
    const calls: string[] = [];
    const head = "a".repeat(40);
    const host = {
      baseBranchHead: async () => { calls.push("head"); return head; },
      repositoryTree: async (_r: unknown, commit: string) => { calls.push(`tree:${commit === head}`); return { complete: true, entries: [{ kind: "file", path: "src/a.ts" }, { kind: "dir", path: "src" }] }; },
    };
    const projects = { latest: async () => ({ definition: { repositories: [{ name: "api", url: "https://x/api", defaultBranch: "main" }] } }) } as never;
    const p = codeHostAreaPorts({ projects, companyId: A, hostOf: () => host as never });
    expect(await p.repositories(KEY)).toEqual(["api"]);
    expect(await p.files(KEY, "api")).toEqual(["src/a.ts"]);
    expect(calls).toEqual(["head", "tree:true"]);
    expect(await p.files(KEY, "web")).toBeUndefined();
    const cut = codeHostAreaPorts({ projects, companyId: A, hostOf: () => ({ ...host, repositoryTree: async () => ({ complete: false, entries: [] }) }) as never });
    expect(await cut.files(KEY, "api")).toBeUndefined();
    const none = codeHostAreaPorts({ projects, companyId: A, hostOf: () => undefined });
    expect(await none.files(KEY, "api")).toBeUndefined();
    const bad = codeHostAreaPorts({ projects, companyId: A, hostOf: () => ({ baseBranchHead: async () => "not a commit", repositoryTree: async () => ({ complete: true, entries: [] }) }) as never });
    expect(await bad.files(KEY, "api")).toBeUndefined();
  });
});
