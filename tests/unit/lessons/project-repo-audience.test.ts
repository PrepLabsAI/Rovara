// A lesson restricted ONLY because its evidence came from a repository that belongs to the lesson's project counts as visible to the whole project for lessons;
// the live task rules then apply as for any project-wide lesson. Any other restriction (a Slack channel, another project's repository, an explicit list, mixed places) stays restricted. The access check
// is a stand-in that restricts every place it is asked about with a restriction and has no record to say otherwise.
import { describe, expect, it } from "vitest";
import type { AccessCheckPort, TaskVisibilityPort } from "../../../packages/broker/src/lessons/access-port.js";
import { learnedContextFromRefs } from "../../../packages/broker/src/lessons/deliver.js";
import { loadLessonsForStage, type LoadDeps, type LoadRequest } from "../../../packages/broker/src/lessons/load.js";
import { mentionsRepoPlace, repoOnlyScopes, viewedForLessons, withProjectRepoScopes } from "../../../packages/broker/src/lessons/project-repo-audience.js";
import { promoteToRule } from "../../../packages/broker/src/lessons/promote.js";
import { readVisible } from "../../../packages/broker/src/lessons/read-visible.js";
import { InMemoryLessonStore, type LoadManifest } from "../../../packages/broker/src/lessons/store.js";
import { withLessonAudiences, type LessonTaskAudience } from "../../../packages/broker/src/lessons/task-audience.js";
import { lessonsUsedReaderOver } from "../../../packages/broker/src/lessons/used-in-pr.js";
import type { Audience, Lesson } from "../../../packages/broker/src/lessons/types.js";
import { Audit, Clock, KEY, MemoryVectors, PROJECT, WS, draft, embedder, lessonRecord, seed, settings, wideAudience } from "./lesson-helpers.js";

const T1 = "2026-10-30T09:00:00.000Z";
const REPO = "github:repo/9";
const OTHER_REPO = "github:repo/77";
const SLACK = "slack:T1/C9";
const repoAudience = (scope = REPO, over: Record<string, unknown> = {}): Audience => ({ kind: "restricted", acl: { source: "github", scope, capturedAt: T1, liveCheck: "on_read", ...over } });
const slackAudience = (scope = SLACK): Audience => ({ kind: "restricted", acl: { source: "slack", scope, principals: ["U1"], capturedAt: T1, liveCheck: "none" } });
const lessonWith = (id: string, audience: Audience, sourceScopes: string[], tasks: string[] = ["task-src"]): Lesson =>
  lessonRecord({ id, type: "convention", tier: 1, approvals: [{ approvalId: "ap", by: "ann", at: 1, mode: "one" }], provenance: { ...draft().provenance, audience, sourceScopes, supportTasks: tasks } });

type RepoRead = () => Promise<ReadonlySet<string>>;
const projectHas = (...scopes: string[]): RepoRead => async () => new Set(scopes);

/** An access check over a record that restricts every place named as restricted (readers of the repository only, no list): it answers no for them, whoever asks. */
const createAccessCheckPort = (taskVisibility: TaskVisibilityPort): AccessCheckPort => ({ taskVisibility, async mayRead(_org, _viewer, places) { return places.map((place) => place.restrictedScopes.length === 0); } });

/** The starting revisions `placeOf` was asked about (review: the pull request's repository is read in the revision the task started on). */
const asked: Array<number | undefined> = [];
async function setup(repos: RepoRead, tasks: Record<string, LessonTaskAudience | undefined> = {}) {
  const team: TaskVisibilityPort = { read: async () => new Map() };
  const taskVisibility = withProjectRepoScopes(withLessonAudiences(team, { read: async (_org, ids) => new Map(ids.map((id) => [id, id in tasks ? tasks[id] : wideAudience()])) }), { read: () => repos(), placeOf: async (_org, _project, name, startingRevision) => { asked.push(startingRevision); return ({ api: REPO, web: OTHER_REPO } as Record<string, string>)[name]; } });
  const access = createAccessCheckPort(taskVisibility);
  const store = new InMemoryLessonStore();
  const vectors = new MemoryVectors();
  const clock = new Clock();
  const deps: LoadDeps = { store, embedder, vectors, settings: settings(), access, audit: new Audit(), now: clock.now };
  const put = async (...lessons: Lesson[]) => {
    await seed(store, ...lessons);
    for (const l of lessons) await vectors.upsert(l.workspaceId, l.project, l.id, await embedder.embed(`${l.title}\n${l.description}\n${l.body}`), { status: l.status });
  };
  const request: LoadRequest = { workspaceId: WS, project: PROJECT, taskId: "task-run", stage: "IMPLEMENT", round: 1, intent: "Retry failed HTTP calls", repos: ["api"], files: [], languages: [], taskAudience: { kind: "shared" } };
  const loaded = async () => (await loadLessonsForStage(deps, request)).context?.lessons.map((l) => l.id);
  return { access, taskVisibility, store, deps, put, loaded, request };
}

describe("the shape that counts as 'readers of the project's own repositories'", () => {
  it("exactly: a restricted audience with no list, whose places are all repositories", () => {
    expect(repoOnlyScopes(lessonWith("les_shape0001", repoAudience(), [REPO]))).toEqual([REPO]);
    expect(repoOnlyScopes(lessonWith("les_shape0002", repoAudience(`${REPO}+${OTHER_REPO}`), [REPO]))).toEqual([REPO, OTHER_REPO]);
    // Not that shape: project-wide, a Slack channel, a list, a group, an empty list, a repository joined with any other place.
    expect(repoOnlyScopes(lessonWith("les_shape0003", { kind: "project" }, []))).toBeUndefined();
    expect(repoOnlyScopes(lessonWith("les_shape0004", slackAudience(), [SLACK]))).toBeUndefined();
    expect(repoOnlyScopes(lessonWith("les_shape0005", repoAudience(REPO, { principals: ["123"] }), [REPO]))).toBeUndefined();
    expect(repoOnlyScopes(lessonWith("les_shape0006", repoAudience(REPO, { groups: ["g"] }), [REPO]))).toBeUndefined();
    expect(repoOnlyScopes(lessonWith("les_shape0007", repoAudience(REPO, { principals: [] }), [REPO]))).toBeUndefined();
    expect(repoOnlyScopes(lessonWith("les_shape0008", repoAudience(`${REPO}+${SLACK}`), [REPO, SLACK]))).toBeUndefined();
  });

  it("viewedForLessons converts only when EVERY place is a repository the project has now; the original lesson is never changed", () => {
    const lesson = lessonWith("les_view00001", repoAudience(), [REPO, "rovara:task/task-src"]);
    const frozen = JSON.stringify(lesson);
    const seen = viewedForLessons(lesson, new Set([REPO]));
    expect(seen.provenance.audience).toEqual({ kind: "project" });
    expect(seen.provenance.sourceScopes).toEqual(["rovara:task/task-src"]);
    expect(JSON.stringify(lesson)).toBe(frozen);
    expect(viewedForLessons(lesson, new Set([OTHER_REPO]))).toBe(lesson);
    expect(viewedForLessons(lesson, new Set())).toBe(lesson);
    expect(viewedForLessons(lesson, undefined)).toBe(lesson);
    const two = lessonWith("les_view00002", repoAudience(`${REPO}+${OTHER_REPO}`), [REPO, OTHER_REPO]);
    expect(viewedForLessons(two, new Set([REPO]))).toBe(two);
    expect(viewedForLessons(two, new Set([REPO, OTHER_REPO])).provenance.audience).toEqual({ kind: "project" });
    // A project-wide lesson that names a project repository among its sources stops being asked about that place.
    const wide = lessonWith("les_view00003", { kind: "project" }, [REPO, SLACK]);
    expect(mentionsRepoPlace(wide)).toBe(true);
    expect(viewedForLessons(wide, new Set([REPO])).provenance.sourceScopes).toEqual([SLACK]);
    expect(mentionsRepoPlace(lessonWith("les_view00004", slackAudience(), [SLACK]))).toBe(false);
  });
});

describe("a lesson from a PR comment in a private project repository", () => {
  const prLesson = lessonWith("les_prcomment1", repoAudience(), [REPO]);

  it("positive: it loads into a project task; the live task rules still apply to it", async () => {
    const t = await setup(projectHas(REPO));
    await t.put(prLesson);
    expect(await t.loaded()).toEqual(["les_prcomment1"]);
    // Still applies: the source task denies someone the running task shows it to, so the lesson is withheld.
    const narrowed = await setup(projectHas(REPO), { "task-src": wideAudience({ denied: new Set(["z"]) }) });
    await narrowed.put(prLesson);
    expect(await narrowed.loaded()).toBeUndefined();
  });

  it("negative control: the same lesson, with the repository NOT the project's, does not load (the rule is the repository, not the lesson)", async () => {
    const t = await setup(projectHas(OTHER_REPO));
    await t.put(prLesson);
    expect(await t.loaded()).toBeUndefined();
  });

  it("the repository is removed from the project: withheld, the next time it is read", async () => {
    let current = new Set([REPO]);
    const t = await setup(async () => current);
    await t.put(prLesson);
    expect(await t.loaded()).toEqual(["les_prcomment1"]);
    current = new Set();
    expect(await t.loaded()).toBeUndefined();
  });

  it("a lesson from ANOTHER project's repository is withheld", async () => {
    const t = await setup(projectHas(REPO));
    await t.put(lessonWith("les_otherrepo1", repoAudience(OTHER_REPO), [OTHER_REPO]));
    expect(await t.loaded()).toBeUndefined();
    // Learned from BOTH this project's repository and another's: only people who read both may see it, so it stays restricted.
    const both = await setup(projectHas(REPO));
    await both.put(lessonWith("les_bothrepos1", repoAudience(`${REPO}+${OTHER_REPO}`), [REPO, OTHER_REPO]));
    expect(await both.loaded()).toBeUndefined();
  });

  it("a mixed restriction (the repository and a Slack channel) is withheld, with or without a list", async () => {
    const t = await setup(projectHas(REPO));
    await t.put(lessonWith("les_mixednolst", repoAudience(`${REPO}+${SLACK}`), [REPO, SLACK]), lessonWith("les_mixedlist01", { kind: "restricted", acl: { source: "github", scope: `${REPO}+${SLACK}`, principals: [], capturedAt: T1, liveCheck: "none" } }, [REPO, SLACK]));
    expect(await t.loaded()).toBeUndefined();
  });

  it("an explicit list on the repository's place stays restricted; a Slack-only lesson stays restricted", async () => {
    const t = await setup(projectHas(REPO));
    await t.put(lessonWith("les_listed0001", repoAudience(REPO, { principals: ["123"] }), [REPO]), lessonWith("les_slackonly01", slackAudience(), [SLACK]));
    expect(await t.loaded()).toBeUndefined();
  });

  it("an unreadable project definition withholds (fail closed): a throwing read, a hung read, and a port that is not wired", async () => {
    const lines: Array<[string, Record<string, unknown>]> = [];
    const throwing = await setup(async () => { throw new Error("down"); });
    await throwing.put(prLesson);
    expect(await throwing.loaded()).toBeUndefined();
    expect(await readVisible({ access: throwing.access, key: KEY, viewer: undefined, lessons: [prLesson], where: "t", running: { taskId: "task-run" }, log: (event, fields) => { lines.push([event, fields]); } })).toEqual([]);
    expect(lines.some(([event, fields]) => event.endsWith("_audience_unreadable") && fields.reason === "project_repos_error")).toBe(true);
    // Not wired at all (an older wiring, a test stub).
    const bare = createAccessCheckPort(withLessonAudiences({ read: async () => new Map() }, { read: async (_o, ids) => new Map(ids.map((id) => [id, wideAudience()])) }));
    expect(await readVisible({ access: bare, key: KEY, viewer: undefined, lessons: [prLesson], where: "t", running: { taskId: "task-run" } })).toEqual([]);
  });

  it("a person: the lessons tab and the digest read it through the same path, for a project member who can open the source task", async () => {
    const t = await setup(projectHas(REPO), { "task-src": wideAudience({ denied: new Set(["z"]) }) });
    const viewer = (developerId: string) => ({ principals: [], groups: [], developerId });
    expect((await readVisible({ access: t.access, key: KEY, viewer: viewer("ann"), lessons: [prLesson], where: "t" })).map((l) => l.id)).toEqual(["les_prcomment1"]);
    expect(await readVisible({ access: t.access, key: KEY, viewer: viewer("z"), lessons: [prLesson], where: "t" })).toEqual([]);
  });

  it("delivery: the dispatcher's read delivers it, and stops when the repository leaves the project", async () => {
    let current = new Set([REPO]);
    const t = await setup(async () => current);
    await t.put(prLesson);
    const deps = { store: t.store, settings: settings(), access: t.access, identity: async () => ({ principals: [], groups: [] }), now: t.deps.now };
    const refs = { v: 1 as const, orgId: WS, project: PROJECT, setVersion: 5, stage: "IMPLEMENT" as const, audience: { kind: "shared" as const }, taskId: "task-run", lessons: [{ id: "les_prcomment1", version: 1 }] };
    expect((await learnedContextFromRefs(deps, refs))?.lessons.map((l) => l.id)).toEqual(["les_prcomment1"]);
    current = new Set();
    expect(await learnedContextFromRefs(deps, refs)).toBeUndefined();
  });

  it("the pull request list counts it everywhere, and names it only in repository A itself, for a private repository with every source task open to the project", async () => {
    const t = await setup(projectHas(REPO, OTHER_REPO));
    await t.put(prLesson);
    const manifest: LoadManifest = { taskId: "task-run", workspaceId: WS, project: PROJECT, stage: "IMPLEMENT", round: 1, setVersion: 1, memory: "live", at: 1, lessons: [{ id: "les_prcomment1", version: 1, score: 0.5, why: "scope", citation: "valid" }], bytes: 10 };
    await t.store.putManifest(manifest);
    const names = { memberName: async () => undefined, isErased: async () => false } as never;
    const input = { orgId: WS, project: PROJECT, taskId: "task-run", pageUrl: "https://app.example.test/review/x/task", startingRevision: 4 };
    const read = lessonsUsedReaderOver({ store: t.store, settings: settings(), access: t.access, names, visibility: async () => "private" });
    asked.length = 0;
    // The lesson is restricted only to REPO (repository "api"): named in a pull request of "api", counted only in "web" (another project repository), in an unknown repository and when no repository is given.
    expect(await read({ ...input, repo: "api" })).toMatchObject({ count: 1, items: [{ id: "les_prcomment1" }] });
    expect(asked).toEqual([4]);
    expect(await read({ ...input, repo: "web" })).toMatchObject({ count: 1, items: [] });
    expect(await read({ ...input, repo: "not-a-project-repo" })).toMatchObject({ count: 1, items: [] });
    expect(await read(input)).toMatchObject({ count: 1, items: [] });
    // A project-wide lesson that merely cites the repository among its sources is named in every repository (the rule is about a lesson RESTRICTED to one repository).
    const wide = lessonWith("les_widewithrepo", { kind: "project" }, [REPO]);
    await t.put(wide);
    await t.store.putManifest({ ...manifest, taskId: "task-wide", lessons: [{ id: "les_widewithrepo", version: 1, score: 0.5, why: "scope", citation: "valid" }] });
    expect(await read({ ...input, taskId: "task-wide", repo: "web" })).toMatchObject({ count: 1, items: [{ id: "les_widewithrepo" }] });
    // A repository that left the project: the lesson is not counted at all.
    const removed = lessonsUsedReaderOver({ store: t.store, settings: settings(), access: (await setup(projectHas())).access, names, visibility: async () => "private" });
    expect(await removed({ ...input, repo: "api" })).toBeUndefined();
  });

  it("a placeOf that fails, or a port without it, never names a repository-only lesson", async () => {
    const names = { memberName: async () => undefined, isErased: async () => false } as never;
    const input = { orgId: WS, project: PROJECT, taskId: "task-run", pageUrl: "https://app.example.test/review/x/task", repo: "api" };
    const manifest: LoadManifest = { taskId: "task-run", workspaceId: WS, project: PROJECT, stage: "IMPLEMENT", round: 1, setVersion: 1, memory: "live", at: 1, lessons: [{ id: "les_prcomment1", version: 1, score: 0.5, why: "scope", citation: "valid" }], bytes: 10 };
    for (const port of [{ read: async () => new Set([REPO]), placeOf: async (): Promise<string | undefined> => { throw new Error("unreadable"); } }, { read: async () => new Set([REPO]) }]) {
      const t = await setup(projectHas(REPO));
      const access = createAccessCheckPort(withProjectRepoScopes(withLessonAudiences({ read: async () => new Map() }, { read: async (_o, ids) => new Map(ids.map((id) => [id, wideAudience()])) }), port));
      await t.put(prLesson);
      await t.store.putManifest(manifest);
      expect(await lessonsUsedReaderOver({ store: t.store, settings: settings(), access, names, visibility: async () => "private" })(input)).toMatchObject({ count: 1, items: [] });
    }
  });

  it("promote: a project rule is read in every repository, so a repository-restricted lesson is refused; a project-wide one is not", async () => {
    const a = { ...(await setup(projectHas(REPO))) };
    const b = { ...(await setup(projectHas())) };
    await a.put(prLesson, lessonWith("les_promotewide1", { kind: "project" }, []));
    await b.put(prLesson);
    const base = { directory: { eligibility: async () => ({ complete: true, eligibleIds: ["owner"], ownerIds: ["owner"] }) }, settings: settings(), now: () => 1, audit: new Audit() };
    const attempt = async (t: typeof a, lessonId = "les_prcomment1") => promoteToRule({ ...base, store: t.store, taskVisibility: t.taskVisibility } as never, { workspaceId: WS, project: PROJECT, lessonId, approverId: "owner" });
    expect(await attempt(b)).toEqual({ ok: false, code: "restricted" });
    expect(await attempt(a)).toEqual({ ok: false, code: "restricted" });
    expect(await attempt(a, "les_promotewide1")).not.toEqual({ ok: false, code: "restricted" });
  });
});
