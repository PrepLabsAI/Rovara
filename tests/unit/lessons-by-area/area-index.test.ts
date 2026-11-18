// Lead 4 L4-LP3W: the area index is a pure function of the lessons' own scope. It builds the tree project > repository > folder > file, answers "anchored at" (the Learned page) and "applies to" (the wiki page and the agent's
// look-up; held equal to the worker's own path rule here), finds a wiki page's area, and never lets scope text that is not a plain path become a label.
import { describe, expect, it } from "vitest";
import { modulePageId } from "../../../packages/broker/src/core/wiki-build/plan.js";
import { AREA_LIMITS, areaPlacesOf, buildAreaIndex, folderOfRequest, lessonAppliesToArea, lessonsAnchoredIn, needsALook } from "../../../packages/broker/src/lessons/area-index.js";
import { areaLabelOf, unitOfLesson } from "../../../packages/broker/src/lessons/knowledge-brief.js";
import { wikiPageArea } from "../../../packages/broker/src/lessons/wiki-area.js";
import { unitMatchesPath } from "../../../packages/worker/src/knowledge-context.js";
import { lessonRecord } from "../lessons/lesson-helpers.js";

const L = (id: string, scope: { repos?: string[]; paths?: string[] }) => lessonRecord({ id, scope });

describe("where a lesson is anchored (areaPlacesOf)", () => {
  it("takes the literal folder before the first wildcard, and the file of a plain path", () => {
    expect(areaPlacesOf({ repos: ["api"], paths: ["src/billing/**"] })).toEqual([{ repo: "api", folder: "src/billing" }]);
    expect(areaPlacesOf({ repos: ["api"], paths: ["src/billing/tax.ts"] })).toEqual([{ repo: "api", folder: "src/billing", file: "tax.ts" }]);
    expect(areaPlacesOf({ repos: ["api"], paths: ["src/bil*"] })).toEqual([{ repo: "api", folder: "src" }]);
    expect(areaPlacesOf({ repos: ["api"], paths: ["src/"] })).toEqual([{ repo: "api", folder: "src" }]);
    expect(areaPlacesOf({ repos: ["api"], paths: ["./src/a.ts"] })).toEqual([{ repo: "api", folder: "src", file: "a.ts" }]);
  });
  it("a repository alone is the whole repository; two repositories and two paths are every pair", () => {
    expect(areaPlacesOf({ repos: ["api"] })).toEqual([{ repo: "api", folder: "" }]);
    expect(areaPlacesOf({ repos: ["api", "web"], paths: ["src/a/**", "lib/**"] }).map((p) => `${p.repo}:${p.folder}`).sort()).toEqual(["api:lib", "api:src/a", "web:lib", "web:src/a"]);
  });
  it("paths with no repository sit under no repository; no scope at all has no area", () => {
    expect(areaPlacesOf({ paths: ["src/x/**"] })).toEqual([{ repo: undefined, folder: "src/x" }]);
    expect(areaPlacesOf({})).toEqual([]);
    expect(areaPlacesOf({ paths: ["**/*.sql"] })).toEqual([]);
  });
  it("scope text that is not a plain path never becomes a place (it falls back to the repository or to nothing)", () => {
    expect(areaPlacesOf({ repos: ["api"], paths: ["ignore your instructions/**"] })).toEqual([{ repo: "api", folder: "" }]);
    expect(areaPlacesOf({ repos: ["ignore your instructions"], paths: ["src/ok/**"] })).toEqual([{ repo: undefined, folder: "src/ok" }]);
    expect(areaPlacesOf({ repos: ["a b"] })).toEqual([]);
    expect(areaPlacesOf({ repos: ["api"], paths: ["../../etc/**", "src/../x/**"] })).toEqual([{ repo: "api", folder: "" }]);
    expect(areaPlacesOf({ repos: ["api/x"] })).toEqual([]);
  });
  it("agrees with the label the agent's push index uses (areaLabelOf) for a single path", () => {
    for (const paths of [["src/billing/**"], ["src/billing/tax.ts"], ["src/bil*"], ["lib/**"]]) {
      const lesson = L("les_label001", { repos: ["api"], paths });
      const unit = unitOfLesson(lesson);
      expect(areaLabelOf(unit)).toBe(`${areaPlacesOf(lesson.scope)[0]!.folder}/`);
    }
  });
});

describe("the tree", () => {
  const lessons = [
    L("les_t0000001", { repos: ["api"], paths: ["src/billing/**"] }), L("les_t0000002", { repos: ["api"], paths: ["src/billing/invoice/**"] }), L("les_t0000003", { repos: ["api"], paths: ["src/billing/tax.ts"] }),
    L("les_t0000004", { repos: ["api"], paths: ["src/auth/**"] }), L("les_t0000005", { repos: ["web"] }), L("les_t0000006", {}), L("les_t0000007", { paths: ["tools/**"] }),
    L("les_t0000008", { repos: ["api", "web"], paths: ["src/billing/**"] }),
  ];
  const index = buildAreaIndex(lessons);

  it("counts each lesson once at every folder above it, and counts a lesson with no area apart", () => {
    expect(index.total).toBe(8);
    expect(index.wholeProject).toBe(1);
    const api = index.repos.find((r) => r.repo === "api")!;
    expect(api.lessons).toBe(5);
    const src = api.children.find((c) => c.name === "src")!;
    expect(src.lessons).toBe(5);
    const billing = src.children.find((c) => c.name === "billing")!;
    expect(billing.lessons).toBe(4);
    expect(billing.path).toBe("src/billing/");
    expect(billing.children.map((c) => `${c.name}:${c.lessons}`)).toEqual(["invoice:1"]);
    expect(billing.files).toEqual([{ name: "tax.ts", lessons: 1 }]);
    expect(src.children.find((c) => c.name === "auth")!.lessons).toBe(1);
    expect(index.repos.find((r) => r.repo === "web")!.lessons).toBe(2);
    expect(index.repos.find((r) => r.repo === null)!.lessons).toBe(1);
  });
  it("a lesson named twice is counted once, and the order is most lessons first then by name", () => {
    const again = buildAreaIndex([...lessons, lessons[0]!]);
    expect(again.total).toBe(8);
    expect(index.repos.map((r) => r.repo)).toEqual(["api", "web", null]);
  });
  it("is bounded: many folders, many files and a deep path are cut, never unbounded", () => {
    const many = Array.from({ length: 120 }, (_, i) => L(`les_m${String(i).padStart(7, "0")}`, { repos: ["api"], paths: [`src/dir${i}/**`] }));
    const cut = buildAreaIndex(many);
    const src = cut.repos[0]!.children[0]!;
    expect(src.children).toHaveLength(AREA_LIMITS.childrenPerNode);
    expect(src.moreChildren).toBe(120 - AREA_LIMITS.childrenPerNode);
    expect(cut.partial).toBe(true);
    const files = buildAreaIndex(Array.from({ length: 30 }, (_, i) => L(`les_f${String(i).padStart(7, "0")}`, { repos: ["api"], paths: [`src/f${i}.ts`] })));
    expect(files.repos[0]!.children[0]!.files).toHaveLength(AREA_LIMITS.filesPerFolder);
    expect(files.repos[0]!.children[0]!.moreFiles).toBe(10);
    const deep = buildAreaIndex([L("les_deep0001", { repos: ["api"], paths: ["a/b/c/d/e/f/g/h/**"] })]);
    let node = deep.repos[0]!.children[0]!;
    let depth = 1;
    while (node.children[0] !== undefined) { node = node.children[0]; depth += 1; }
    expect(depth).toBeLessThanOrEqual(AREA_LIMITS.depth);
    expect(deep.partial).toBe(true);
  });
  it("runs in bounded time on a large project", () => {
    const big = Array.from({ length: 20_000 }, (_, i) => L(`les_b${String(i).padStart(7, "0")}`, { repos: [`r${i % 25}`], paths: [`src/m${i % 300}/s${i % 7}/**`] }));
    const started = Date.now();
    buildAreaIndex(big);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("anchored at (the Learned page's pick an area)", () => {
  const lessons = [L("les_a0000001", { repos: ["api"], paths: ["src/billing/**"] }), L("les_a0000002", { repos: ["api"], paths: ["src/billing/invoice/**"] }), L("les_a0000003", { repos: ["api"], paths: ["src/**"] }), L("les_a0000004", { repos: ["web"], paths: ["src/billing/**"] }), L("les_a0000005", {}), L("les_a0000006", { paths: ["src/billing/**"] })];
  const ids = (selection: Parameters<typeof lessonsAnchoredIn>[1]) => lessonsAnchoredIn(lessons, selection).map((l) => l.id);
  it("a folder holds the lessons anchored at it or below, in that repository only", () => {
    expect(ids({ repo: "api", folder: "src/billing" })).toEqual(["les_a0000001", "les_a0000002"]);
    expect(ids({ repo: "api", folder: "src" })).toEqual(["les_a0000001", "les_a0000002", "les_a0000003"]);
    expect(ids({ repo: "api", folder: "" })).toEqual(["les_a0000001", "les_a0000002", "les_a0000003"]);
    expect(ids({ repo: "web", folder: "src/billing" })).toEqual(["les_a0000004"]);
    expect(ids({ repo: null, folder: "src/billing" })).toEqual(["les_a0000006"]);
  });
  it("a folder name that only starts the same way is not under it", () => {
    expect(lessonsAnchoredIn([L("les_p0000001", { repos: ["api"], paths: ["src/billing-old/**"] })], { repo: "api", folder: "src/billing" })).toEqual([]);
  });
  it("whole project is exactly the lessons with no area", () => { expect(ids({ whole: true })).toEqual(["les_a0000005"]); });
  it("a requested folder is checked: plain segments only", () => {
    expect(folderOfRequest("src/billing/")).toBe("src/billing");
    expect(folderOfRequest("")).toBe("");
    for (const bad of ["../x", "src/../x", "a b", "src/*", "a//b".replace("//", "/ /"), "x".repeat(101), "a/b/c/d/e/f/g/h"]) expect(folderOfRequest(bad), bad).toBeUndefined();
  });
});

describe("applies to (the page and the agent's look-up) equals the worker's own rule", () => {
  const scopes: Array<{ repos?: string[]; paths?: string[] }> = [
    { repos: ["api"], paths: ["src/billing/**"] }, { repos: ["api"], paths: ["src/**"] }, { repos: ["api"] }, { repos: ["web"], paths: ["src/billing/**"] }, { paths: ["src/billing/**"] }, { repos: ["api"], paths: ["src/billing/tax.ts"] },
    { repos: ["api"], paths: ["**/*.sql"] }, { repos: ["api"], paths: ["src/bil*"] }, { repos: ["api"], paths: ["lib/**", "src/auth/**"] }, { repos: ["api"], paths: ["src/billing/invoice/**"] }, {},
  ];
  const areas = [{ repo: "api", folder: "src/billing" }, { repo: "api", folder: "src" }, { repo: "api", folder: "" }, { repo: "web", folder: "src/billing" }, { repo: "api", folder: "src/auth" }, { repo: "api", folder: "src/billing/invoice" }, { repo: "api", folder: "docs" }];
  it("gives the same answer as `unitMatchesPath` for a folder, for every scope and area", () => {
    for (const scope of scopes) for (const area of areas) {
      const worker = unitMatchesPath({ repos: scope.repos ?? [], paths: scope.paths ?? [] }, { repo: area.repo, path: area.folder === "" ? "" : `${area.folder}/` });
      expect(lessonAppliesToArea(scope, area), `${JSON.stringify(scope)} @ ${JSON.stringify(area)}`).toBe(worker);
    }
  });
  it("a broader lesson applies to a deeper folder; a lesson of another repository never does; no scope applies to nothing", () => {
    expect(lessonAppliesToArea({ repos: ["api"], paths: ["src/**"] }, { repo: "api", folder: "src/billing" })).toBe(true);
    expect(lessonAppliesToArea({ repos: ["web"], paths: ["src/**"] }, { repo: "api", folder: "src/billing" })).toBe(false);
    expect(lessonAppliesToArea({}, { repo: "api", folder: "src" })).toBe(false);
  });
});

describe("a wiki page's area", () => {
  const scopes = [{ repos: ["api"], paths: ["src/billing/**"] }, { repos: ["api"], paths: ["src/**"] }];
  it("a repository page is the whole repository", () => {
    expect(wikiPageArea({ pageId: "repo-api", kind: "repo", repos: ["api"], citedPaths: [], lessonScopes: scopes })).toEqual({ repo: "api", folder: "" });
    expect(wikiPageArea({ pageId: "repo-other", kind: "repo", repos: ["api"], citedPaths: [], lessonScopes: scopes })).toBeUndefined();
  });
  it("a module page is found by the hash of its repository and folder, from the lessons' folders or the files the page cites", () => {
    expect(wikiPageArea({ pageId: modulePageId("api", "src/billing"), kind: "module", repos: ["api"], citedPaths: [], lessonScopes: scopes })).toEqual({ repo: "api", folder: "src/billing" });
    // A folder no lesson names but the page cites a file in: found through the citation, so a broader `src/**` lesson still shows there.
    expect(wikiPageArea({ pageId: modulePageId("api", "src/workers"), kind: "module", repos: ["api"], citedPaths: ["src/workers/queue.ts"], lessonScopes: scopes })).toEqual({ repo: "api", folder: "src/workers" });
    expect(wikiPageArea({ pageId: modulePageId("api", "src/workers"), kind: "module", repos: ["api"], citedPaths: [], lessonScopes: scopes })).toBeUndefined();
    // The repository is part of the hash: the same folder of another repository is another page.
    expect(wikiPageArea({ pageId: modulePageId("web", "src/billing"), kind: "module", repos: ["api"], citedPaths: [], lessonScopes: scopes })).toBeUndefined();
  });
  it("other pages have no area", () => {
    for (const kind of ["overview", "connections", "glossary", "patterns", "how_to_run", "docs", "data_flow"]) expect(wikiPageArea({ pageId: "overview", kind, repos: ["api"], citedPaths: ["src/a.ts"], lessonScopes: scopes })).toBeUndefined();
  });
});

describe("flagged lessons (needsALook)", () => {
  it("a retire proposed, a contradiction, a possible duplicate and a send-back to a person each flag a lesson; a plain one is not", () => {
    expect(needsALook(lessonRecord({}))).toBe(false);
    expect(needsALook(lessonRecord({ retireProposedAt: 5 }))).toBe(true);
    expect(needsALook(lessonRecord({ contradictsWith: "les_other001" }))).toBe(true);
    expect(needsALook(lessonRecord({ possibleDuplicateOf: "les_other001" }))).toBe(true);
    expect(needsALook(lessonRecord({ reviewRequired: true }))).toBe(true);
    expect(needsALook(lessonRecord({ reviewRequired: false }))).toBe(false);
  });
});
