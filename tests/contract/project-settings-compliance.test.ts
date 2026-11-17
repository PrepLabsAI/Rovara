// M4a slice 3 (TE-D8): the company admin's view of every project against the company's bounds. Read-only, company administrator or owner only.
import { expect, it, vi } from "vitest";
import { AgentXError, companyScoped, canonicalJson, orgProjectCatalogKey, orgSettingsKey } from "@agentx/contracts";
import { devRouteOf } from "../../packages/broker/src/aws/dev-route-scopes.js";
import { routeDeveloperRequest, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { COMPANY, ISSUER, fakeService, makeKey, settingsFor, signerOf } from "../unit/policy-hook-fixture.js";

const B = "org_bbbbbbbbbbbbbbbbbbbb";
const now = 1_800_000_000_000;
const person = "d".repeat(64);
const COMPLIANCE = "/v1/dev/company/settings-compliance";
const install = makeKey("install"); const hookKey = makeKey("hook");
const catalogRow = (name: string) => ({ pk: "PROJECT_CATALOG", sk: `PROJECT#${name}`, entityType: "PROJECT_CATALOG", name, latestRevision: 1 });

function world() {
  const db = new FakeDynamoDb();
  let clock = now;
  let company: string | undefined = COMPANY;
  const companies = { companyOf: vi.fn(async () => company) };
  const deps: DeveloperRouteDependencies = { documentClient: db, tableName: "state", companies, now: () => clock,
    developer: { issuer: ISSUER, env: "test", methods: { slack: true, oidc: false }, signInTableName: "signin", channelMembers: async () => ({ ok: false, error: "slack_unavailable" }),
      verifyAccessToken: async () => ({ iss: ISSUER, aud: "agentx-developer", sub: person, amr: "slack", env: "test", sid: "session", iat: now / 1000, exp: now / 1000 + 3600, companyId: COMPANY }) } };
  db.set({ pk: "SESSION#session", sk: "META", sessionId: "session", developerId: person, amr: "slack", startedAt: new Date(now).toISOString(), endsAt: now / 1000 + 3600 });
  db.set({ pk: `DEVELOPER#${person}`, sk: "META", displayName: "Test", revoked: false });
  const member = (role: string, extra: Record<string, unknown> = {}, companyId = COMPANY) => db.set({ pk: `COMPANY_MEMBER#${person}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: person, companyId, role, joinedAt: new Date(now).toISOString(), ...extra });
  member("admin");
  const project = (name: string, companyId = COMPANY) => {
    db.set({ pk: `PROJECT#${name}`, sk: "REV#000000000001", companyId, entityType: "PROJECT", definition: { name, revision: 1 } });
    db.set(catalogRow(name));
  };
  const admin = (name: string) => db.set({ pk: `MEMBER#${person}`, sk: `PROJECT#${name}`, companyId: COMPANY, projectName: name, role: "administrator" });
  const send = vi.spyOn(db, "send");
  const call = (path: string, query = "", method = "GET") => routeDeveloperRequest(deps, { method, path, headers: { authorization: "Bearer fixture" }, requestId: "r1" },
    new URL(`https://x.test${path}${query}`)).catch((error: unknown) => {
    if (error instanceof AgentXError) throw Object.assign(new Error(error.message.slice(error.code.length + 2)), { code: error.code, statusCode: error.statusCode });
    throw error;
  });
  const get = (query = "") => call(COMPLIANCE, query) as Promise<Page>;
  const hook = (locksOf: (projectName: string | undefined) => Record<string, unknown> | Error) => {
    const service = fakeService({ key: hookKey, now: () => clock, answer: (asked) => { const locks = locksOf(asked.q["pid"] as string | undefined); return locks instanceof Error ? locks : { locks }; } });
    deps.developer.policyHook = { settings: settingsFor(hookKey), install: { issuer: ISSUER, signer: signerOf(install) }, fetch: service.fetch };
    return service;
  };
  const settings = (name: string, fields: Record<string, unknown>, companyId = COMPANY) => db.set({ pk: `ORG#${companyId}#PROJECT_SETTINGS#${name}`, sk: "META", entityType: "PROJECT_SETTINGS", companyId, projectName: name,
    overrides: {}, revision: 1, updatedAt: new Date(now).toISOString(), updatedBy: person, ...fields });
  return { db, deps, send, get, call, hook, advance: (ms: number) => { clock += ms; }, member, project, admin, settings, setCompany: (value: string | undefined) => { company = value; } };
}
interface Row { project: string; status: string; values: Record<string, { value: unknown; origin: string }>; clamped: Array<{ field: string }>; [key: string]: unknown }
interface Page { projects: Row[]; nextCursor: string | null }
const settingsKeyOf = (company: string, name: string) => companyScoped(company, `PROJECT_SETTINGS#${name}`);

it("lists every project of the company with its settings, and 'no settings yet' for a project with no row", async () => {
  const w = world();
  w.project("alpha"); w.project("beta"); w.project("gamma");
  w.settings("beta", { preset: "careful", overrides: { extra_review: true, model_budget_usd: 4 }, revision: 3 });
  const got = await w.get();
  expect(got.nextCursor).toBeNull();
  expect(got.projects.map((row) => row.project)).toEqual(["alpha", "beta", "gamma"]);
  expect(got.projects[0]).toMatchObject({ project: "alpha", status: "resolved", hasSettings: false, preset: null, revision: 0, changedHere: [], clamped: [], belowCompanyBound: false });
  expect(got.projects[1]).toMatchObject({ project: "beta", status: "resolved", hasSettings: true, preset: "careful", revision: 3, changedHere: ["model_budget_usd", "extra_review"], belowCompanyBound: false,
    values: { extra_review: { value: true, origin: "changed here" }, model_budget_usd: { value: 4, origin: "changed here" } } });
});

it("each row is the project page's own answer (one function): the page's GET and the admin row agree field by field", async () => {
  const w = world();
  w.project("web"); w.project("api"); w.project("bare");
  w.settings("web", { preset: "balanced", overrides: { real_check: "rovara_real_run", ci_fix_rounds: 2 }, revision: 2 });
  w.hook((pid) => pid === "web" ? { extra_review: true, model_budget_usd: 5 } : { extra_review: true });
  const rows = (await w.get()).projects;
  expect(rows.map((row) => row.project)).toEqual(["api", "bare", "web"]);
  // The page's own `clamped` list is checked directly: a project with no row sits below the company's extra_review minimum.
  const apiPage = await w.call("/v1/dev/projects/api/settings") as { clamped: unknown[] };
  expect(apiPage.clamped).toEqual([{ field: "extra_review", bound: "minimum", chosen: false, applied: true, notice: "raised to your company's minimum" }]);
  for (const row of rows) {
    const page = await w.call(`/v1/dev/projects/${row.project}/settings`) as Record<string, unknown>;
    expect(row.values).toEqual(page["values"]);
    expect(row["preset"]).toEqual(page["preset"]);
    expect(row["revision"]).toEqual(page["revision"]);
    expect(row["clamped"]).toEqual(page["clamped"]);
  }
});

it("shows a stored choice the company minimum or limit now clamps, before and after clamping, and filters to those", async () => {
  const w = world();
  w.project("alpha"); w.project("beta"); w.project("gamma");
  w.settings("alpha", { overrides: { extra_review: false, model_budget_usd: 9 } });
  w.settings("beta", { preset: "lightweight" });
  w.settings("gamma", { overrides: { extra_review: true, model_budget_usd: 2 } });
  const service = w.hook(() => ({ extra_review: true, model_budget_usd: 5, real_check: "their_ci_fix" }));
  const all = await w.get();
  const byName = Object.fromEntries(all.projects.map((row) => [row.project, row]));
  expect(byName["alpha"]).toMatchObject({ belowCompanyBound: true, values: { extra_review: { value: true, origin: "company minimum" }, model_budget_usd: { value: 5, origin: "company limit" } } });
  expect(byName["alpha"]!.clamped).toEqual(expect.arrayContaining([
    { field: "extra_review", bound: "minimum", chosen: false, applied: true, notice: "raised to your company's minimum" },
    { field: "model_budget_usd", bound: "limit", chosen: 9, applied: 5, notice: "lowered to your company's limit" },
  ]));
  expect(byName["beta"]!["belowCompanyBound"]).toBe(true);
  expect(byName["beta"]!.clamped).toEqual([{ field: "real_check", bound: "minimum", chosen: "their_ci_watch", applied: "their_ci_fix", notice: "raised to your company's minimum" }]);
  expect(byName["gamma"]).toMatchObject({ belowCompanyBound: false, clamped: [] });
  const filtered = await w.get("?filter=below_company_bound");
  expect(filtered.projects.map((row) => row.project)).toEqual(["alpha", "beta"]);
  // Every question went to the company rules service for THIS company and one named project.
  expect(service.asked.every((q) => q.q["cid"] === COMPANY && typeof q.q["pid"] === "string")).toBe(true);
});

it("a budget nobody set is not 'below the limit' just because the company has one; an explicit null is", async () => {
  const w = world(); w.project("bare"); w.project("asked"); w.project("capped");
  w.settings("asked", { overrides: { model_budget_usd: null } }); w.settings("capped", { overrides: { model_budget_usd: 2 } });
  w.hook(() => ({ model_budget_usd: 5 }));
  const byName = Object.fromEntries((await w.get()).projects.map((row) => [row.project, row]));
  expect(byName["bare"]).toMatchObject({ belowCompanyBound: false, clamped: [], values: { model_budget_usd: { value: 5, origin: "company limit" } } });
  expect(byName["capped"]).toMatchObject({ belowCompanyBound: false, clamped: [] });
  expect(byName["asked"]).toMatchObject({ belowCompanyBound: true, clamped: [{ field: "model_budget_usd", bound: "limit", chosen: null, applied: 5, notice: "lowered to your company's limit" }] });
});

it("only a company administrator or owner may read it; nobody else learns anything", async () => {
  const w = world(); w.project("alpha"); w.settings("alpha", { overrides: { extra_review: true } });
  for (const role of ["member", "developer", "auditor", "ADMIN"]) {
    w.member(role); w.send.mockClear();
    await expect(w.get()).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403, message: "company administrator required" });
    // Refused before any project or settings read.
    expect(w.send.mock.calls.some(([c]) => /PROJECT_CATALOG|PROJECT_SETTINGS|PROJECT#/.test(JSON.stringify(c.input)))).toBe(false);
  }
  // A project administrator who is not a company administrator is still refused.
  w.member("member"); w.admin("alpha");
  await expect(w.get()).rejects.toMatchObject({ code: "FORBIDDEN" });
  for (const role of ["admin", "owner"]) { w.member(role); expect((await w.get()).projects).toHaveLength(1); }
});

it("a revoked, foreign or missing membership is refused with sign-in words, never the view", async () => {
  const w = world(); w.project("alpha");
  w.member("admin", { revokedAt: new Date(now).toISOString(), revokedBy: "x" });
  await expect(w.get()).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  w.member("admin", {}, B);
  await expect(w.get()).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  w.member("admin", { personId: "e".repeat(64) });
  await expect(w.get()).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  w.member("admin"); w.setCompany(undefined);
  await expect(w.get()).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
});

it("two companies: B's administrator sees only B's projects, A's only A's, and nothing of the other leaks", async () => {
  const w = world();
  w.project("a-one"); w.project("a-two"); w.project("b-one", B); w.project("b-two", B);
  w.settings("a-one", { overrides: { model_budget_usd: 3 }, updatedBy: "private-canary-a" });
  w.settings("b-one", { overrides: { model_budget_usd: 8 } }, B);
  // A settings row planted under the wrong company's key for the same name is never read as A's.
  w.settings("a-two", { overrides: { model_budget_usd: 1 } }, B);
  w.hook(() => ({}));
  const a = await w.get();
  expect(a.projects.map((row) => row.project)).toEqual(["a-one", "a-two"]);
  expect(a.projects[0]!.values["model_budget_usd"]!.value).toBe(3);
  expect(a.projects[1]).toMatchObject({ hasSettings: false });
  expect(JSON.stringify(a)).not.toMatch(/b-one|b-two|private-canary-a/);
  w.setCompany(B); w.member("admin", {}, B);
  const b = await w.get();
  expect(b.projects.map((row) => row.project)).toEqual(["b-one", "b-two"]);
  expect(JSON.stringify(b)).not.toMatch(/a-one|a-two/);
  expect(b.projects[0]!.values["model_budget_usd"]!.value).toBe(8);
});

it("pages 250 projects in order, each exactly once, with bounded reads per page and foreign projects interleaved", async () => {
  const w = world();
  const names = Array.from({ length: 250 }, (_, index) => `p${String(index).padStart(3, "0")}`);
  for (const name of names) { w.project(name); w.project(`${name}x`, B); }
  w.settings("p007", { overrides: { extra_review: true } });
  const seen: string[] = []; let cursor: string | null = null; let pages = 0;
  do {
    w.send.mockClear();
    const page: Page = await w.get(`?limit=50${cursor === null ? "" : `&cursor=${cursor}`}`);
    expect(page.projects.length).toBeLessThanOrEqual(50);
    expect(w.send.mock.calls.length).toBeLessThan(512);
    seen.push(...page.projects.map((row) => row.project));
    // The cursor names only this company's last project (or counts entries): never another company's name.
    if (page.nextCursor !== null) expect(page.nextCursor).toMatch(/^p\d{3}~\d+$/);
    cursor = page.nextCursor; pages++;
  } while (cursor !== null && pages < 50);
  expect(seen).toEqual(names);
  expect(pages).toBeGreaterThanOrEqual(5);
}, 20_000);

it("a long run of other companies' projects ends a page early with a cursor that names none of them", async () => {
  const w = world();
  for (let index = 0; index < 450; index++) w.project(`a${String(index).padStart(3, "0")}`, B);
  w.project("z-mine");
  const seen: string[] = []; const cursors: string[] = []; let cursor: string | null = null; let pages = 0;
  do {
    const page: Page = await w.get(cursor === null ? "" : `?cursor=${cursor}`);
    seen.push(...page.projects.map((row) => row.project));
    if (page.nextCursor !== null) cursors.push(page.nextCursor);
    cursor = page.nextCursor; pages++;
  } while (cursor !== null && pages < 20);
  expect(seen).toEqual(["z-mine"]);
  expect(pages).toBeGreaterThan(1);
  // The only thing a cursor carries about other companies is a count.
  expect(cursors).toEqual(["~200", "~400"]);
}, 20_000);

it("a run of other companies' names longer than the cursor can count is refused with fixed words, never cut or looped", async () => {
  const w = world();
  for (let index = 0; index < 1300; index++) w.project(`a${String(index).padStart(4, "0")}`, B);
  w.project("z-mine");
  let cursor: string | null = null; let pages = 0; let failure: unknown;
  while (failure === undefined && pages < 10) {
    try { cursor = (await w.get(cursor === null ? "" : `?cursor=${cursor}`)).nextCursor; } catch (error) { failure = error; }
    pages++;
  }
  expect(failure).toMatchObject({ code: "CONFIG_INVALID", message: "company read limit exceeded" });
  expect(pages).toBe(6);
}, 30_000);

it("a cursor can only start at one of the caller's own projects: a foreign or unknown name is refused alike, so no name can be probed", async () => {
  const w = world();
  for (let index = 0; index < 250; index++) w.project(`k${String(index).padStart(3, "0")}-secret`, B);
  w.project("m-mine"); w.project("n-mine");
  for (let index = 0; index < 250; index++) w.project(`q${String(index).padStart(3, "0")}-filler`, B);
  const refused = [];
  // A real foreign name, a one-letter-off name, an unknown name and a name of nobody: the same refusal, with nothing that differs.
  for (const cursor of ["k010-secret~0", "k010-secres~0", "zzz~0", "k249-secret~5"]) refused.push(await w.get(`?cursor=${cursor}`).then(() => "ok", (error: Error & { code?: string }) => `${error.code}:${error.message}`));
  expect(new Set(refused)).toEqual(new Set(["CONFIG_INVALID:invalid settings compliance request"]));
  // Own names work, and nothing in any response carries another company's name.
  const own = await w.get("?cursor=m-mine~0");
  expect(own.projects.map((row) => row.project)).toEqual(["n-mine"]);
  const first = await w.get("");
  for (const page of [own, first]) expect(JSON.stringify(page)).not.toMatch(/secret|filler/);
  expect(first.nextCursor).toBe("~200");
  // A forged count past the bound is refused too.
  await expect(w.get("?cursor=m-mine~1001")).rejects.toMatchObject({ code: "CONFIG_INVALID" });
});

it("a slow company rules service ends the page early with a cursor at the last row done, never a failure", async () => {
  const w = world();
  for (let index = 0; index < 10; index++) w.project(`p${index}`);
  const service = w.hook(() => { w.advance(2000); return {}; });
  const seen: string[] = []; let cursor: string | null = null; let pages = 0; const sizes: number[] = [];
  do {
    const page: Page = await w.get(`?limit=10${cursor === null ? "" : `&cursor=${cursor}`}`);
    sizes.push(page.projects.length);
    expect(page.projects.every((row) => row.status === "resolved")).toBe(true);
    seen.push(...page.projects.map((row) => row.project));
    cursor = page.nextCursor; pages++;
  } while (cursor !== null && pages < 10);
  expect(seen).toEqual(Array.from({ length: 10 }, (_, index) => `p${index}`));
  expect(Math.max(...sizes)).toBeLessThan(10);
  expect(service.asked.length).toBe(10);
});

it("an unreadable stored row or an unanswered rules service marks that project unavailable with fixed words, never defaults", async () => {
  const w = world(); w.project("alpha"); w.project("beta");
  w.settings("alpha", { overrides: { extra_review: "private-canary" } });
  const bad = await w.get();
  expect(bad.projects[0]).toEqual({ project: "alpha", status: "unavailable", reason: "policy_unavailable" });
  expect(bad.projects[1]).toMatchObject({ project: "beta", status: "resolved" });
  expect(JSON.stringify(bad)).not.toContain("private-canary");
  w.db.delete(settingsKeyOf(COMPANY, "alpha"), "META");
  w.hook((pid) => pid === "alpha" ? new Error("private-canary") : {});
  const down = await w.get();
  expect(down.projects[0]).toEqual({ project: "alpha", status: "unavailable", reason: "policy_unavailable" });
  expect(down.projects[1]).toMatchObject({ project: "beta", status: "resolved", belowCompanyBound: false });
  expect(JSON.stringify(down)).not.toContain("private-canary");
  // The filter never hides a project nobody could judge.
  expect((await w.get("?filter=below_company_bound")).projects.map((row) => row.project)).toEqual(["alpha"]);
});

it("refuses bad limits, cursors and filters with fixed words that echo nothing", async () => {
  const w = world(); w.project("alpha");
  for (const query of ["?limit=0", "?limit=51", "?limit=x", "?limit=1.5", "?limit=-1", "?cursor=PROJECT_CATALOG", "?cursor=../x", `?cursor=${"a".repeat(64)}~0`, "?cursor=", "?cursor=alpha", "?cursor=alpha~", "?cursor=alpha~1001", "?cursor=alpha~-1", "?cursor=alpha~0~0", "?cursor=Alpha~0", "?filter=private-canary", "?other=private-canary", "?limit=1&limit=2"]) {
    await expect(w.get(query)).rejects.toMatchObject({ code: "CONFIG_INVALID", message: "invalid settings compliance request" });
  }
  expect((await w.get("?limit=50&filter=below_company_bound")).projects).toEqual([]);
});

it("is read-only: only reads reach the table, and only POST/PUT/DELETE-free routes exist", async () => {
  const w = world(); w.project("alpha"); w.settings("alpha", { overrides: { extra_review: true } });
  w.send.mockClear();
  await w.get();
  expect(w.send.mock.calls.length).toBeGreaterThan(0);
  expect(w.send.mock.calls.every(([c]) => ["GetCommand", "QueryCommand"].includes(c.constructor.name))).toBe(true);
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) await expect(w.call(COMPLIANCE, "", method)).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(devRouteOf("GET", COMPLIANCE)?.requires).toBe("full");
  expect(devRouteOf("POST", COMPLIANCE)).toBeUndefined();
});

it("a catalog name with no revision is never listed, and a corrupt catalog name stops the read with fixed words instead of cutting the list", async () => {
  const w = world(); w.project("mine");
  w.db.set(catalogRow("orphan"));
  expect((await w.get()).projects.map((row) => row.project)).toEqual(["mine"]);
  w.db.set({ pk: "PROJECT_CATALOG", sk: "PROJECT#NOT A NAME", name: "x" });
  await expect(w.get()).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: "settings unavailable" });
});

it("a stored-row failure reads fail closed: the store's own error never reaches the caller", async () => {
  const w = world(); w.project("alpha");
  w.db.injectFault({ command: "QueryCommand", match: (input) => JSON.stringify(input).includes("PROJECT_CATALOG"), error: { name: "InternalServerError", message: "private-canary" } });
  const error = await w.get().then(() => undefined, (caught: Error & { code?: string }) => caught);
  expect(error).toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: "settings unavailable" });
  expect(error?.message).not.toContain("private-canary");
});

const c2 = (companyId: string, after: string, extra = {}) => "c2." + Buffer.from(canonicalJson({ v: 2, companyId, after, ...extra })).toString("base64url");
function indexed(w: ReturnType<typeof world>, name: string, companyId = COMPANY) {
  w.project(name, companyId);
  w.db.set({ ...orgProjectCatalogKey(companyId, name), entityType: "PROJECT_CATALOG", companyId, name, latestRevision: 1 });
}
function flag(w: ReturnType<typeof world>, companyId = COMPANY) {
  w.db.set({ pk: companyScoped(companyId, "SETTINGS"), sk: "PROJECT_CATALOG_INDEX", verifiedAt: new Date(now).toISOString(), count: 1, runId: "catalog-test" });
}
it("flagged paging is byte-identical including read count with zero or 500 foreign projects", async () => {
  for (const companyId of [COMPANY, B]) {
    const other = companyId === COMPANY ? B : COMPANY;
    const pages = [];
    for (const foreign of [0, 500]) {
      const w = world(); w.setCompany(companyId); w.member("admin", {}, companyId); flag(w, companyId);
      for (let i = 0; i < 250; i++) indexed(w, `p${String(i).padStart(4, "0")}b`, companyId);
      for (let i = 0; i < foreign; i++) indexed(w, `p${String(i).padStart(4, "0")}a`, other);
      const got = []; let cursor: string | null = null;
      do {
        w.send.mockClear();
        const page = await w.get("?limit=50" + (cursor === null ? "" : `&cursor=${cursor}`));
        expect(w.send.mock.calls.some(([c]) => JSON.stringify(c.input).includes('"PROJECT_CATALOG"'))).toBe(false);
        got.push({ page, reads: w.send.mock.calls.length }); cursor = page.nextCursor;
      } while (cursor !== null);
      expect(got.flatMap(p => p.page.projects)).toHaveLength(250); pages.push(got);
    }
    expect(pages[0]).toEqual(pages[1]);
  }
});
it("flagged cursors reject replay, forgery and v1 with identical fixed words", async () => {
  const w = world(); indexed(w, "alpha"); indexed(w, "beta"); flag(w);
  const first = await w.get("?limit=1"); expect(first.nextCursor).toBe(c2(COMPANY, "alpha"));
  const malformed = [c2(B, "alpha"), c2(COMPANY, "missing"), c2(COMPANY, "alpha", { extra: true }), c2(COMPANY, "alpha", { v: 1 }), "~200", "alpha~0", "garbage", first.nextCursor + "=",
    "c2." + Buffer.from(JSON.stringify({ v: 2, companyId: COMPANY, after: "alpha" })).toString("base64url")];
  for (const cursor of malformed) await expect(w.get(`?cursor=${encodeURIComponent(cursor)}`)).rejects.toMatchObject({ code: "CONFIG_INVALID", message: "invalid settings compliance request" });
  w.setCompany(B); w.member("admin", {}, B); flag(w, B);
  await expect(w.get(`?cursor=${first.nextCursor}`)).rejects.toMatchObject({ code: "CONFIG_INVALID", message: "invalid settings compliance request" });
});
it("unflagged behavior stays v1; unmark restores it; flagged deadline resumes in v2", async () => {
  const w = world(); for (let i = 0; i < 12; i++) indexed(w, `p${String(i).padStart(2, "0")}`);
  expect((await w.get("?limit=1")).nextCursor).toBe("p00~0");
  flag(w); w.hook(() => { w.advance(1100); return {}; });
  const first = await w.get("?limit=12"); expect(first.projects).toHaveLength(4); expect(first.nextCursor).toBe(c2(COMPANY, "p03"));
  expect((await w.get(`?cursor=${first.nextCursor}`)).projects[0]?.project).toBe("p04");
  const key = orgSettingsKey(COMPANY, "PROJECT_CATALOG_INDEX"); w.db.delete(key.pk, key.sk);
  expect((await w.get("?limit=1")).nextCursor).toBe("p00~0");
});
it("index drift fails closed and logs only the caller company once", async () => {
  const w = world(); indexed(w, "foreign", B); flag(w);
  w.db.set({ ...orgProjectCatalogKey(COMPANY, "foreign"), entityType: "PROJECT_CATALOG", companyId: COMPANY, name: "foreign", latestRevision: 1 });
  const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    await expect(w.get()).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: "settings unavailable" });
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({ companyId: COMPANY, event: "project_catalog.index_drift" });
    expect(JSON.stringify(log.mock.calls)).not.toContain(B);
  } finally { log.mockRestore(); }
});

it("a v2 cursor existence read failure has the same fixed refusal as garbage", async () => {
  const w = world(); indexed(w, "alpha"); flag(w);
  w.db.injectFault({ command: "GetCommand", match: input => JSON.stringify(input).includes("PROJECT#alpha"), error: { name: "InternalServerError", message: "private-canary" } });
  await expect(w.get(`?cursor=${c2(COMPANY, "alpha")}`)).rejects.toMatchObject({ code: "CONFIG_INVALID", message: "invalid settings compliance request" });
});
