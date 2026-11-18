// Lead 4 L4-LP3W: GET /v1/app/projects/{project}/wiki/pages/{pageId}/lessons, "Team lessons for this area", on the deployed wiki read routes. Any project role reads; a missing page, project or role is the wiki's own fixed
// refusal; two companies and two projects never meet; an unwired company says "route not found"; nothing a caller sent is echoed; the section is the same units an agent is told.
import { describe, expect, it } from "vitest";
import { TEAM_LESSONS_NOTE, TeamLessonsAnswerSchema, WIKI_PAGE_NOT_FOUND, WIKI_PROJECT_NOT_FOUND, type OrgId, type WikiPageWrite } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../../packages/broker/src/ports/memory-document-store.js";
import { createWikiStore } from "../../../packages/broker/src/core/wiki/store.js";
import { modulePageId } from "../../../packages/broker/src/core/wiki-build/plan.js";
import { isWikiPath, routeHostedWiki, type HostedWikiWiring } from "../../../packages/broker/src/core-host/wiki-routes.js";
import type { SetupRunStanding } from "../../../packages/broker/src/core-host/setup-run-routes.js";
import type { LoadDeps } from "../../../packages/broker/src/lessons/load.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import type { Lesson } from "../../../packages/broker/src/lessons/types.js";
import { Audit, Clock, MemoryVectors, embedder, lessonRecord, seed, settings, allowAllAccess } from "../lessons/lesson-helpers.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const SHA = "a".repeat(40);
const T0 = Date.parse("2026-11-17T10:00:00.000Z");
const person = { approvalId: "ap-ann", by: "ann", at: 1, mode: "one" as const };
const conv = (workspaceId: string, project: string, id: string, over: Partial<Lesson> = {}): Lesson => lessonRecord({ id, workspaceId, project, type: "convention", tier: 1, approvals: [person], scope: { repos: ["web"], paths: ["src/billing/**"] }, title: `Title ${id}`, provenance: { ...lessonRecord().provenance, supportTasks: [] }, ...over });

const modulePage = (repo: string, folder: string): WikiPageWrite => ({
  pageId: modulePageId(repo, folder), kind: "module", title: `Module ${folder}`, summary: "A module", order: 1, repos: [{ repo, commit: SHA }],
  blocks: [{ kind: "paragraph", blockId: "p0001", text: "Text", claimIds: ["c0001"] }],
  claims: [{ claimId: "c0001", text: "Claim", citations: [{ repo, path: `${folder}/a.ts`, commit: SHA, line: 1, quote: "export const a = 1;" }], source: "found", checkedAt: "2026-11-17T09:00:00.000Z" }],
  buildId: "build-0001",
});
const overview: WikiPageWrite = { ...modulePage("web", "src/billing"), pageId: "overview", kind: "overview", title: "Overview", repos: [{ repo: "web", commit: SHA }] };

async function setup(standings: Record<string, SetupRunStanding["access"]> = { [`${A}/alpha/ada`]: "view", [`${A}/beta/ada`]: "view", [`${B}/alpha/bob`]: "view" }) {
  const store = new MemoryDocumentStore();
  const clock = new Clock();
  const lessonStores = new Map<OrgId, InMemoryLessonStore>([[A, new InMemoryLessonStore()], [B, new InMemoryLessonStore()]]);
  const depsOf = (company: OrgId): LoadDeps => ({ access: allowAllAccess, store: lessonStores.get(company)!, embedder, vectors: new MemoryVectors(), settings: settings(), audit: new Audit(), now: clock.now });
  const wiring: HostedWikiWiring = {
    standing: async (personId, companyId, project) => { const access = standings[`${companyId}/${project}/${personId}`] ?? "none"; return access === "manage" ? { access, basis: "company-admin" } : { access }; },
    projectRepositories: async () => ["web"],
    lessonsOf: (companyId) => (lessonStores.has(companyId) ? depsOf(companyId) : undefined),
  };
  const get = async (companyId: OrgId, personId: string, project: string, pageId: string, overrides: Partial<HostedWikiWiring> = {}) => {
    const path = `/v1/app/projects/${project}/wiki/pages/${pageId}/lessons`;
    const answer = await routeHostedWiki({ request: { method: "GET", path, headers: {} }, path, personId, companyId, store, wiring: { ...wiring, ...overrides }, now: () => T0 });
    return { status: answer.statusCode, body: JSON.parse(answer.body ?? "{}") as Record<string, unknown>, raw: answer.body ?? "" };
  };
  const wiki = (companyId: OrgId) => createWikiStore({ store, companyId, now: () => T0 });
  const lessons = async (...rows: Lesson[]) => { for (const row of rows) await seed(lessonStores.get(row.workspaceId)!, row); };
  return { get, wiki, lessons };
}

describe("the path", () => {
  it("is a wiki read path, GET only", () => {
    expect(isWikiPath("/v1/app/projects/alpha/wiki/pages/overview/lessons", "GET")).toBe(true);
    for (const [path, method] of [["/v1/app/projects/alpha/wiki/pages/overview/lessons", "POST"], ["/v1/app/projects/alpha/wiki/pages/overview/lessons/x", "GET"], ["/v1/app/projects/alpha/wiki/lessons", "GET"], ["/v1/app/projects/alpha/wiki/pages/overview/less", "GET"]] as const) expect(isWikiPath(path, method), `${method} ${path}`).toBe(false);
  });
});

describe("what a person reads on a module page", () => {
  it("lists the approved lessons of the page's area, in the answer's strict shape", async () => {
    const w = await setup();
    await w.wiki(A).writePage("alpha", modulePage("web", "src/billing"));
    await w.lessons(conv(A, "alpha", "les_ok000001"), conv(A, "alpha", "les_other001", { scope: { repos: ["web"], paths: ["src/auth/**"] } }), conv(A, "alpha", "les_retprop1", { retireProposedAt: 5 }), conv(A, "alpha", "les_pend0001", { status: "pending" }));
    const answer = await w.get(A, "ada", "alpha", modulePageId("web", "src/billing"));
    expect(answer.status).toBe(200);
    const parsed = TeamLessonsAnswerSchema.parse(answer.body);
    expect(parsed.area).toEqual({ repo: "web", folder: "src/billing" });
    expect(parsed.lessons.map((l) => l.id)).toEqual(["L-les_ok000001"]);
    expect(parsed.moreLessons).toBe(0);
    expect(parsed.note).toBe(TEAM_LESSONS_NOTE);
    // No stored scope text, citations, approvals, people or counters leave: only the row's own fields.
    expect(Object.keys(parsed.lessons[0]!).sort()).toEqual(["detail", "id", "lessonId", "scopeLabel", "statement", "trust", "type", "version", "why"]);
  });

  it("a page about no single area answers an empty list and no area", async () => {
    const w = await setup();
    await w.wiki(A).writePage("alpha", overview);
    await w.lessons(conv(A, "alpha", "les_ok000001"));
    const answer = await w.get(A, "ada", "alpha", "overview");
    expect(answer.status).toBe(200);
    expect(answer.body["lessons"]).toEqual([]);
    expect(answer.body["area"]).toBeUndefined();
  });
});

describe("who may read, and what stays apart", () => {
  it("a person with no role, a missing project, a missing page and a malformed name get the wiki's own fixed words", async () => {
    const w = await setup();
    await w.wiki(A).writePage("alpha", modulePage("web", "src/billing"));
    const page = modulePageId("web", "src/billing");
    const none = await w.get(A, "stranger", "alpha", page);
    expect(none.status).toBe(404);
    expect((none.body["error"] as { message: string }).message).toBe(WIKI_PROJECT_NOT_FOUND);
    expect((await w.get(A, "ada", "missing", page)).status).toBe(404);
    const noPage = await w.get(A, "ada", "alpha", "no-such-page");
    expect(noPage.status).toBe(404);
    expect((noPage.body["error"] as { message: string }).message).toBe(WIKI_PAGE_NOT_FOUND);
    expect((await w.get(A, "ada", "-bad", page)).status).toBe(404);
    expect(JSON.stringify([none.body, noPage.body])).not.toContain("stranger");
  });

  it("two companies and two projects: the same page id in each reads only its own lessons", async () => {
    const w = await setup();
    const page = modulePageId("web", "src/billing");
    await w.wiki(A).writePage("alpha", modulePage("web", "src/billing"));
    await w.wiki(A).writePage("beta", modulePage("web", "src/billing"));
    await w.wiki(B).writePage("alpha", modulePage("web", "src/billing"));
    await w.lessons(conv(A, "alpha", "les_a_alpha1"), conv(A, "beta", "les_a_beta001"), conv(B, "alpha", "les_b_alpha1"));
    const ids = async (company: OrgId, person: string, project: string): Promise<string[]> => ((await w.get(company, person, project, page)).body["lessons"] as Array<{ lessonId: string }>).map((l) => l.lessonId);
    expect(await ids(A, "ada", "alpha")).toEqual(["les_a_alpha1"]);
    expect(await ids(A, "ada", "beta")).toEqual(["les_a_beta001"]);
    expect(await ids(B, "bob", "alpha")).toEqual(["les_b_alpha1"]);
    // A person of company A has no standing in company B's project: the same 404, nothing read.
    expect((await w.get(B, "ada", "alpha", page)).status).toBe(404);
  });

  it("the lessons library is asked for the member company only", async () => {
    const asked: string[] = [];
    const w = await setup();
    await w.wiki(A).writePage("alpha", modulePage("web", "src/billing"));
    await w.get(A, "ada", "alpha", modulePageId("web", "src/billing"), { lessonsOf: (companyId) => { asked.push(companyId); return undefined; } });
    expect(asked).toEqual([A]);
  });

  it("a company with no lessons wired says the route is not found (the page then shows no section)", async () => {
    const w = await setup();
    await w.wiki(A).writePage("alpha", modulePage("web", "src/billing"));
    const answer = await w.get(A, "ada", "alpha", modulePageId("web", "src/billing"), { lessonsOf: undefined });
    expect(answer.status).toBe(404);
    expect((answer.body["error"] as { message: string }).message).toBe("route not found");
  });

  it("a lessons library that fails answers a fixed 503 with no cause", async () => {
    const w = await setup();
    await w.wiki(A).writePage("alpha", modulePage("web", "src/billing"));
    const answer = await w.get(A, "ada", "alpha", modulePageId("web", "src/billing"), { lessonsOf: () => ({ settings: settings(), store: { list: async () => { throw new Error("secret detail"); } } } as never) });
    expect(answer.status).toBe(503);
    expect(answer.raw).not.toContain("secret detail");
  });
});
