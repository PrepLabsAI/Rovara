// The project wiki's read routes (lead 4, W2): any project role reads; anyone else, a missing project, another company's and a malformed name get the same 404; two companies and two
// projects never meet; people never see a stored quote, a flag's author or reason; refusals are fixed words with no echo.
import { describe, expect, it } from "vitest";
import { WIKI_PAGE_NOT_FOUND, WIKI_PROJECT_NOT_FOUND, WIKI_TRUST_LINE, WIKI_UNAVAILABLE, wikiAgentSwitchKey, type OrgId, type WikiPageWrite } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createWikiStore } from "../../packages/broker/src/core/wiki/store.js";
import { setWikiAgentSwitch } from "../../packages/broker/src/core/wiki/agent-context.js";
import { WIKI_FORMER_MEMBER_NAME, hostedEraseWiki, isWikiPath, routeHostedWiki, type HostedWikiWiring } from "../../packages/broker/src/core-host/wiki-routes.js";
import type { SetupRunStanding } from "../../packages/broker/src/core-host/setup-run-routes.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const SHA = "a".repeat(40);
const T0 = Date.parse("2026-11-17T10:00:00.000Z");
const QUOTE_MARK = "QUOTE-CANARY-";

function page(tag: string): WikiPageWrite {
  return {
    pageId: "overview", kind: "overview", title: `Overview ${tag}`, summary: `Summary ${tag}`, order: 0, repos: [{ repo: "web", commit: SHA }],
    blocks: [{ kind: "paragraph", blockId: "p0001", text: `Text ${tag}`, claimIds: ["c0001", "c0002"] }],
    claims: [
      { claimId: "c0001", text: `Claim ${tag}`, citations: [{ repo: "web", path: "src/a.ts", commit: SHA, line: 3, lineEnd: 5, quote: `${QUOTE_MARK}${tag} export const a = 1;` }], source: "found", checkedAt: "2026-11-17T09:00:00.000Z" },
      { claimId: "c0002", text: `Other ${tag}`, citations: [{ repo: "web", path: "src/a.ts", commit: SHA, line: 3, lineEnd: 5, quote: `${QUOTE_MARK}${tag} export const b = 2;` }, { repo: "web", path: "src/b.ts", commit: SHA, line: 9, quote: `${QUOTE_MARK}${tag} export const c = 3;` }], source: "found", checkedAt: "2026-11-17T09:00:00.000Z" },
    ],
    buildId: "build-0001",
  };
}

/** Who stands where: `company/project/person` -> standing; anything else is none. Projects each company has. */
/** Each company's projects and their repositories now. */
function world(standings: Record<string, SetupRunStanding["access"]> = {}, projects: Record<string, Record<string, string[]>> = { [A]: { alpha: ["web"], beta: ["web"] }, [B]: { alpha: ["web"] } }) {
  const store = new MemoryDocumentStore();
  const calls: string[] = [];
  const wiring: HostedWikiWiring = {
    standing: async (personId, companyId, project) => {
      calls.push(`standing:${companyId}/${project}/${personId}`);
      const access = standings[`${companyId}/${project}/${personId}`] ?? "none";
      return access === "manage" ? { access, basis: "company-admin" } : { access };
    },
    projectRepositories: async (companyId, project) => projects[companyId]?.[project],
    displayName: async (personId) => (personId === "ada" ? "Ada" : undefined),
  };
  const get = async (companyId: OrgId, personId: string, path: string, overrides: Partial<HostedWikiWiring> = {}) => {
    const routePath = new URL(path, "https://agentx.invalid").pathname;
    const answer = await routeHostedWiki({ request: { method: "GET", path, headers: {} }, path: routePath, personId, companyId, store, wiring: { ...wiring, ...overrides }, now: () => T0 });
    return { status: answer.statusCode, body: JSON.parse(answer.body ?? "{}") as Record<string, unknown>, raw: answer.body ?? "" };
  };
  return { store, get, calls, a: createWikiStore({ store, companyId: A, now: () => T0 }), b: createWikiStore({ store, companyId: B, now: () => T0 }) };
}

async function seeded() {
  const w = world({ [`${A}/alpha/ada`]: "view", [`${A}/alpha/owner`]: "manage", [`${A}/beta/bob`]: "view", [`${B}/alpha/ada`]: "view" });
  await w.a.writePage("alpha", page("A-alpha"));
  await w.a.writePage("beta", { ...page("A-beta"), pageId: "beta-overview" });
  await w.b.writePage("alpha", { ...page("B-alpha"), pageId: "b-overview" });
  return w;
}

describe("wiki read routes: paths", () => {
  it("serves only GET on the four route shapes", () => {
    expect(isWikiPath("/v1/app/projects/alpha/wiki", "GET")).toBe(true);
    expect(isWikiPath("/v1/app/projects/alpha/wiki/search", "GET")).toBe(true);
    expect(isWikiPath("/v1/app/projects/alpha/wiki/pages/overview", "GET")).toBe(true);
    expect(isWikiPath("/v1/app/projects/alpha/wiki/pages/overview/sources", "GET")).toBe(true);
    for (const [method, path] of [["POST", "/v1/app/projects/alpha/wiki"], ["PUT", "/v1/app/projects/alpha/wiki/pages/overview"], ["GET", "/v1/app/projects/alpha/wiki/pages"], ["GET", "/v1/app/projects/alpha/wiki/notes"], ["GET", "/v1/app/projects//wiki"], ["GET", "/v1/app/projects/alpha/wiki/pages/overview/sources/x"]] as const) {
      expect(isWikiPath(path, method), `${method} ${path}`).toBe(false);
    }
  });
});

describe("wiki read routes: who reads", () => {
  it.each([["a project grant (view)", "ada"], ["a company owner or admin (manage)", "owner"]])("%s reads the index, a page and its sources", async (_name, person) => {
    const w = await seeded();
    const index = await w.get(A, person, "/v1/app/projects/alpha/wiki");
    expect(index.status).toBe(200);
    expect(index.body).toMatchObject({ project: "alpha", state: "ready", pages: [expect.objectContaining({ pageId: "overview", title: "Overview A-alpha" })] });
    const shown = await w.get(A, person, "/v1/app/projects/alpha/wiki/pages/overview");
    expect(shown.status).toBe(200);
    expect(shown.body).toMatchObject({ trustLine: WIKI_TRUST_LINE, openFlags: 0 });
    const sources = await w.get(A, person, "/v1/app/projects/alpha/wiki/pages/overview/sources");
    expect(sources.status).toBe(200);
    expect(sources.body["files"]).toEqual([
      { repo: "web", path: "src/a.ts", commit: SHA, ranges: [{ line: 3, lineEnd: 5 }], claimIds: ["c0001", "c0002"] },
      { repo: "web", path: "src/b.ts", commit: SHA, ranges: [{ line: 9 }], claimIds: ["c0002"] },
    ]);
  });

  it("a person with no role, a role on another project, or a role only in another company gets the same 404 as a missing project", async () => {
    const w = await seeded();
    const expected = { status: 404, body: { error: { code: "NOT_FOUND", message: WIKI_PROJECT_NOT_FOUND } } };
    for (const [company, person, path] of [
      [A, "mallory", "/v1/app/projects/alpha/wiki"],
      [A, "bob", "/v1/app/projects/alpha/wiki"], // a role on beta, not alpha
      [A, "bob", "/v1/app/projects/alpha/wiki/pages/overview"],
      [A, "bob", "/v1/app/projects/alpha/wiki/pages/overview/sources"],
      [B, "owner", "/v1/app/projects/alpha/wiki"], // a manager in company A only
      [A, "ada", "/v1/app/projects/gamma/wiki"], // no such project
      [A, "ada", "/v1/app/projects/Alpha/wiki"], // malformed
      [A, "ada", "/v1/app/projects/%E0%A4%A/wiki"], // undecodable
    ] as const) {
      const answer = await w.get(company, person, path);
      expect({ status: answer.status, body: answer.body }, `${company} ${person} ${path}`).toEqual(expected);
    }
  });

  it("a manager of a project the company does not have gets 404, not an empty wiki", async () => {
    const w = world({ [`${A}/gamma/owner`]: "manage" }, { [A]: { alpha: ["web"] } });
    expect((await w.get(A, "owner", "/v1/app/projects/gamma/wiki")).status).toBe(404);
  });

  it("a malformed project name is refused before anyone's standing is read", async () => {
    const w = await seeded();
    const asked: string[] = [];
    for (const path of ["/v1/app/projects/Alpha/wiki", "/v1/app/projects/alpha%23x/wiki", "/v1/app/projects/%E0%A4%A/wiki"]) {
      expect((await w.get(A, "ada", path, { standing: async (personId, companyId, project) => { asked.push(`${companyId}/${project}/${personId}`); return { access: "view" }; } })).status).toBe(404);
    }
    expect(asked).toEqual([]);
  });

  it("a project whose repository list is not a list reads as missing", async () => {
    const w = await seeded();
    for (const weird of [{ length: 1 }, "web", null]) expect((await w.get(A, "ada", "/v1/app/projects/alpha/wiki", { projectRepositories: async () => weird as never })).status).toBe(404);
  });

  it("any other fault is a fixed 503 that echoes nothing", async () => {
    const w = await seeded();
    await w.a.addNote("alpha", { pageId: "overview", text: "n", authorId: "ada" });
    const answer = await w.get(A, "ada", "/v1/app/projects/alpha/wiki/pages/overview", { displayName: async () => ({ leak: "SECRET-CAUSE" }) as never });
    expect(answer).toMatchObject({ status: 503, body: { error: { message: WIKI_UNAVAILABLE } } });
    expect(answer.raw).not.toContain("SECRET-CAUSE");
  });

  it("an unknown or malformed standing is no standing", async () => {
    const w = await seeded();
    for (const weird of [{ access: "admin" }, { access: "MANAGE" }, null, undefined, "view"]) {
      const answer = await w.get(A, "ada", "/v1/app/projects/alpha/wiki", { standing: async () => weird as never });
      expect(answer.status).toBe(404);
    }
  });

  it("a standing or catalog that cannot be read is a fixed 503, and never a read", async () => {
    const w = await seeded();
    for (const overrides of [{ standing: async () => { throw new Error("db down for alpha"); } }, { projectRepositories: async () => { throw new Error("db down for alpha"); } }]) {
      const answer = await w.get(A, "ada", "/v1/app/projects/alpha/wiki", overrides);
      expect(answer).toMatchObject({ status: 503, body: { error: { message: WIKI_UNAVAILABLE } } });
      expect(answer.raw).not.toContain("db down");
    }
  });
});

describe("wiki read routes: isolation", () => {
  it("the same project name in two companies, and two projects in one company, each show only their own wiki", async () => {
    const w = await seeded();
    const aAlpha = (await w.get(A, "ada", "/v1/app/projects/alpha/wiki")).raw + (await w.get(A, "ada", "/v1/app/projects/alpha/wiki/pages/overview")).raw;
    expect(aAlpha).toContain("A-alpha");
    expect(aAlpha).not.toMatch(/A-beta|B-alpha/u);
    const aBeta = (await w.get(A, "bob", "/v1/app/projects/beta/wiki")).raw + (await w.get(A, "bob", "/v1/app/projects/beta/wiki/pages/overview")).raw;
    expect(aBeta).toContain("A-beta");
    expect(aBeta).not.toMatch(/A-alpha|B-alpha/u);
    const bAlpha = (await w.get(B, "ada", "/v1/app/projects/alpha/wiki")).raw + (await w.get(B, "ada", "/v1/app/projects/alpha/wiki/pages/overview")).raw;
    expect(bAlpha).toContain("B-alpha");
    expect(bAlpha).not.toMatch(/A-alpha|A-beta/u);
  });

  it("search reads title, summary and page text only within the authorized company and project", async () => {
    const w = await seeded();
    for (const [company, person, project, q, expected, forbidden] of [
      [A, "ada", "alpha", "Text A-alpha", "A-alpha", /A-beta|B-alpha/u],
      [A, "bob", "beta", "Text A-beta", "A-beta", /A-alpha|B-alpha/u],
      [B, "ada", "alpha", "Text B-alpha", "B-alpha", /A-alpha|A-beta/u],
    ] as const) {
      const found = await w.get(company, person, `/v1/app/projects/${project}/wiki/search?q=${encodeURIComponent(q)}`);
      expect(found.status).toBe(200);
      expect(found.raw).toContain(expected);
      expect(found.raw).not.toMatch(forbidden);
    }
    const denied = await w.get(A, "bob", "/v1/app/projects/alpha/wiki/search?q=Text");
    expect(denied).toMatchObject({ status: 404, body: { error: { message: WIKI_PROJECT_NOT_FOUND } } });
    for (const [company, person, project, q, ids] of [
      [A, "ada", "alpha", "Text A-beta", []],
      [A, "bob", "beta", "Text A-alpha", []],
      [A, "ada", "alpha", "Text", ["overview"]],
      [A, "bob", "beta", "Text", ["beta-overview"]],
      [B, "ada", "alpha", "A-alpha", []],
    ] as const) {
      const answer = await w.get(company, person, `/v1/app/projects/${project}/wiki/search?q=${encodeURIComponent(q)}`);
      expect((answer.body["results"] as Array<{ pageId: string }>).map((entry) => entry.pageId)).toEqual(ids);
    }
  });

  it("search reads page and body rows only, without querying notes or flags", async () => {
    const w = await seeded();
    const queried: string[] = [];
    const query = w.store.query.bind(w.store);
    w.store.query = async (request) => { queried.push(request.sk?.op === "beginsWith" ? request.sk.prefix : ""); return await query(request); };
    const answer = await w.get(A, "ada", "/v1/app/projects/alpha/wiki/search?q=Text");
    expect(answer.status).toBe(200);
    expect(queried).not.toContain("WIKI#NOTE#");
    expect(queried).not.toContain("WIKI#FLAG#");
  });

  it("redacts key-shaped text in search snippets and frames snippets as untrusted", async () => {
    const w = world({ [`${A}/alpha/ada`]: "view" });
    const keyText = "sk-proj-" + "A".repeat(48);
    await w.a.writePage("alpha", { ...page("A-alpha"), blocks: [{ kind: "paragraph", blockId: "p0001", text: `Credential ${keyText} remains private`, claimIds: ["c0001", "c0002"] }] });
    const answer = await w.get(A, "ada", "/v1/app/projects/alpha/wiki/search?q=Credential");
    expect(answer.body).toMatchObject({ trustLine: WIKI_TRUST_LINE });
    expect(answer.raw).not.toContain(keyText);
    expect(answer.raw).toContain("[REDACTED]");
  });

  it("returns the existing agent switch for this company and project, and defaults off", async () => {
    const w = await seeded();
    expect((await w.get(A, "ada", "/v1/app/projects/alpha/wiki")).body["agentsEnabled"]).toBe(false);
    await setWikiAgentSwitch({ store: w.store, companyId: A, now: () => T0 }, "alpha", true);
    expect((await w.get(A, "ada", "/v1/app/projects/alpha/wiki")).body["agentsEnabled"]).toBe(true);
    await w.store.put({ item: { ...wikiAgentSwitchKey(A, "beta"), entityType: "WIKI_AGENT_SWITCH", companyId: A, project: "alpha", on: true, changedAt: new Date(T0).toISOString() } });
    expect((await w.get(A, "bob", "/v1/app/projects/beta/wiki")).body["agentsEnabled"]).toBe(false);
    expect((await w.get(B, "ada", "/v1/app/projects/alpha/wiki")).body["agentsEnabled"]).toBe(false);
  });

  it("asks for the standing in the member company and the project of the path, never another", async () => {
    const w = await seeded();
    await w.get(B, "ada", "/v1/app/projects/alpha/wiki");
    expect(w.calls).toEqual([`standing:${B}/alpha/ada`]);
  });

  it("a repository no longer in the project leaves nothing behind: its pages and cross-repo pages are deleted before the read", async () => {
    const repos: Record<string, Record<string, string[]>> = { [A]: { alpha: ["web", "api"] } };
    const w = world({ [`${A}/alpha/ada`]: "view" }, repos);
    await w.a.writePage("alpha", { ...page("web-page"), pageId: "repo-web", kind: "repo" });
    await w.a.writePage("alpha", { ...page("links"), pageId: "connections", kind: "connections", repos: [{ repo: "web", commit: SHA }, { repo: "api", commit: SHA }] });
    await w.a.writePage("alpha", { ...page("api-page"), pageId: "repo-api", kind: "repo", repos: [{ repo: "api", commit: SHA }], claims: page("api-page").claims.map((claim) => ({ ...claim, citations: claim.citations.map((citation) => ({ ...citation, repo: "api" })) })) });
    expect(((await w.get(A, "ada", "/v1/app/projects/alpha/wiki")).body["pages"] as unknown[]).length).toBe(3);
    repos[A]!["alpha"] = ["api"];
    const after = await w.get(A, "ada", "/v1/app/projects/alpha/wiki");
    expect((after.body["pages"] as Array<{ pageId: string }>).map((entry) => entry.pageId)).toEqual(["repo-api"]);
    expect((await w.get(A, "ada", "/v1/app/projects/alpha/wiki/pages/repo-web")).status).toBe(404);
    expect(await w.a.readPage("alpha", "connections", "person")).toBeUndefined();
  });

  it("a project with no wiki yet reads as empty", async () => {
    const w = world({ [`${A}/beta/bob`]: "view" }, { [A]: { beta: ["web"] } });
    await w.b.writePage("alpha", page("B-alpha"));
    expect((await w.get(A, "bob", "/v1/app/projects/beta/wiki")).body).toEqual({ project: "beta", state: "empty", agentsEnabled: false, pages: [] });
  });
});

describe("wiki read routes: what people see", () => {
  it("never a stored quote, a flag's author or its reason; notes name their author now, pending ones marked", async () => {
    const w = await seeded();
    await w.a.addNote("alpha", { pageId: "overview", text: "Note by Ada", authorId: "ada" });
    await w.a.addNote("alpha", { pageId: "overview", text: "Note by someone gone", authorId: "gone-person" });
    await w.a.addFlag("alpha", { pageId: "overview", claimId: "c0001", by: { kind: "person", personId: "mallory-secret-id" }, reason: "REASON-CANARY" });
    const answer = await w.get(A, "ada", "/v1/app/projects/alpha/wiki/pages/overview");
    expect(answer.raw).not.toContain(QUOTE_MARK);
    expect(answer.raw).not.toContain("REASON-CANARY");
    expect(answer.raw).not.toContain("mallory-secret-id");
    expect(answer.raw).not.toContain("\"quote\"");
    const sources = await w.get(A, "ada", "/v1/app/projects/alpha/wiki/pages/overview/sources");
    expect(sources.raw).not.toContain(QUOTE_MARK);
    expect(answer.body["openFlags"]).toBe(1);
    expect((answer.body["page"] as { claims: Array<{ claimId: string; flagged: boolean }> }).claims.map((claim) => [claim.claimId, claim.flagged])).toEqual([["c0001", true], ["c0002", false]]);
    expect((answer.body["notes"] as Array<{ text: string; author: string; approval: string }>).map((note) => [note.text, note.author, note.approval]).sort()).toEqual([["Note by Ada", "Ada", "pending"], ["Note by someone gone", WIKI_FORMER_MEMBER_NAME, "pending"]]);
  });

  it("a missing or malformed page is its own fixed 404, with nothing echoed", async () => {
    const w = await seeded();
    for (const path of ["/v1/app/projects/alpha/wiki/pages/nope", "/v1/app/projects/alpha/wiki/pages/BAD%3Cscript%3E", "/v1/app/projects/alpha/wiki/pages/nope/sources"]) {
      const answer = await w.get(A, "ada", path);
      expect(answer).toMatchObject({ status: 404, body: { error: { message: WIKI_PAGE_NOT_FOUND } } });
      expect(answer.raw).not.toMatch(/nope|script/u);
    }
  });

  it("a stored row that cannot be read is a fixed 503", async () => {
    const w = await seeded();
    const row = await w.store.get({ pk: `ORG#${A}#WIKI#alpha`, sk: "PAGE#overview" });
    await w.store.put({ item: { ...row!, companyId: B } });
    const answer = await w.get(A, "ada", "/v1/app/projects/alpha/wiki");
    expect(answer).toMatchObject({ status: 503, body: { error: { message: WIKI_UNAVAILABLE } } });
    expect(answer.raw).not.toContain(B);
  });

  it("refuses any method but GET with no read", async () => {
    const w = await seeded();
    const answer = await routeHostedWiki({ request: { method: "POST", path: "/v1/app/projects/alpha/wiki", headers: {} }, path: "/v1/app/projects/alpha/wiki", personId: "ada", companyId: A, store: w.store, wiring: { standing: async () => { throw new Error("must not be read"); }, projectRepositories: async () => ["web"] }, now: () => T0 });
    expect(answer.statusCode).toBe(404);
  });
});

describe("the hosted wiki erase step", () => {
  it("erases the person's notes in every project of the company's catalog, and only this company's", async () => {
    const w = await seeded();
    for (const [company, project] of [[A, "alpha"], [A, "beta"], [B, "alpha"]] as const) {
      await w.store.put({ item: { pk: `ORG#${company}#PROJECT_CATALOG`, sk: `PROJECT#${project}` } });
    }
    await w.a.addNote("alpha", { pageId: "overview", text: "A alpha words", authorId: "ada" });
    await w.a.addNote("beta", { pageId: "beta-overview", text: "A beta words", authorId: "ada" });
    await w.b.addNote("alpha", { pageId: "b-overview", text: "B alpha words", authorId: "ada" });
    expect(await hostedEraseWiki({ store: w.store, now: () => T0 })(A, "ada")).toEqual({ notes: 2, reasons: 0, answers: 0 });
    expect((await w.a.readPage("alpha", "overview", "person"))?.notes).toEqual([]);
    expect((await w.a.readPage("beta", "beta-overview", "person"))?.notes).toEqual([]);
    expect((await w.b.readPage("alpha", "b-overview", "person"))?.notes.map((note) => note.text)).toEqual(["B alpha words"]);
  });
});
