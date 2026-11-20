// M4a slice 3 (TE-D8): the company admin's view of every project against the company's bounds. Read-only, company administrator or owner only.
import { expect, it, vi } from "vitest";
import { AgentXError, IMPLICIT_COMPANY_ID, companyScoped, canonicalJson, orgProjectCatalogKey, orgSettingsKey, projectRevisionKey } from "@agentx/contracts";
import { routeDeveloperRequest, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { COMPANY, ISSUER, fakeService, makeKey, settingsFor, signerOf } from "../unit/policy-hook-fixture.js";

const B = "org_bbbbbbbbbbbbbbbbbbbb";
const now = 1_800_000_000_000;
const person = "d".repeat(64);
const COMPLIANCE = "/v1/dev/company/settings-compliance";
const install = makeKey("install"); const hookKey = makeKey("hook");
const I = IMPLICIT_COMPANY_ID;
const catalogRow = (name: string) => ({ pk: "PROJECT_CATALOG", sk: `PROJECT#${name}`, entityType: "PROJECT_CATALOG", name, latestRevision: 1 });
/** The switch-over layout (staging 2026-11-17): the company's own catalog and revision rows, with NO companyId attribute (the partition key names the company). */
function partitionRows(db: FakeDynamoDb, name: string, companyId: string, revisions = 1) {
  for (let revision = 1; revision <= revisions; revision++) db.set({ ...projectRevisionKey(companyId, name, revision), entityType: "PROJECT", registeredAt: new Date(now).toISOString(), registeredBy: person, definition: { name, revision } });
  db.set({ ...orgProjectCatalogKey(companyId, name), entityType: "PROJECT_CATALOG", firstRegisteredAt: new Date(now).toISOString(), name, latestRevision: revisions });
}

/** `initial` is the caller's company. A named company reads its own partition; the implicit company (unflagged) still reads the legacy shared catalog. */
function world(initial = COMPANY) {
  const db = new FakeDynamoDb();
  let clock = now;
  let company: string | undefined = initial;
  const companies = { companyOf: vi.fn(async () => company) };
  const deps: DeveloperRouteDependencies = { documentClient: db, tableName: "state", companies, now: () => clock,
    developer: { issuer: ISSUER, env: "test", methods: { slack: true, oidc: false }, signInTableName: "signin", channelMembers: async () => ({ ok: false, error: "slack_unavailable" }),
      verifyAccessToken: async () => ({ iss: ISSUER, aud: "agentx-developer", sub: person, amr: "slack", env: "test", sid: "session", iat: now / 1000, exp: now / 1000 + 3600, companyId: COMPANY }) } };
  db.set({ pk: "SESSION#session", sk: "META", sessionId: "session", developerId: person, amr: "slack", startedAt: new Date(now).toISOString(), endsAt: now / 1000 + 3600 });
  db.set({ pk: `DEVELOPER#${person}`, sk: "META", displayName: "Test", revoked: false });
  const member = (role: string, extra: Record<string, unknown> = {}, companyId = initial) => db.set({ pk: `COMPANY_MEMBER#${person}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: person, companyId, role, joinedAt: new Date(now).toISOString(), ...extra });
  member("admin");
  // A project in BOTH layouts: the legacy shared rows (still read by the project page and by the implicit company's unflagged list) and the company partition rows without companyId.
  const project = (name: string, companyId = initial) => {
    db.set({ pk: `PROJECT#${name}`, sk: "REV#000000000001", companyId, entityType: "PROJECT", definition: { name, revision: 1 } });
    db.set(catalogRow(name));
    partitionRows(db, name, companyId);
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
  const settings = (name: string, fields: Record<string, unknown>, companyId = initial) => db.set({ pk: `ORG#${companyId}#PROJECT_SETTINGS#${name}`, sk: "META", entityType: "PROJECT_SETTINGS", companyId, projectName: name,
    overrides: {}, revision: 1, updatedAt: new Date(now).toISOString(), updatedBy: person, ...fields });
  return { db, deps, send, get, call, hook, advance: (ms: number) => { clock += ms; }, member, project, admin, settings, setCompany: (value: string | undefined) => { company = value; } };
}
interface Row { project: string; status: string; values: Record<string, { value: unknown; origin: string }>; clamped: Array<{ field: string }>; [key: string]: unknown }
interface Page { projects: Row[]; nextCursor: string | null }
const settingsKeyOf = (company: string, name: string) => companyScoped(company, `PROJECT_SETTINGS#${name}`);

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

it("legacy shared catalog (implicit company, unflagged): pages 250 projects in order, each exactly once, with bounded reads per page and foreign projects interleaved", async () => {
  const w = world(I);
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

it("legacy shared catalog (implicit company, unflagged): a run of other companies' names longer than the cursor can count is refused with fixed words, never cut or looped", async () => {
  const w = world(I);
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

it("legacy shared catalog (implicit company, unflagged): a cursor can only start at one of the caller's own projects: a foreign or unknown name is refused alike, so no name can be probed", async () => {
  const w = world(I);
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

it("legacy shared catalog (implicit company, unflagged): a catalog name with no revision is never listed, and a corrupt catalog name stops the read with fixed words instead of cutting the list", async () => {
  const w = world(I); w.project("mine");
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
/** A project in the company partition ONLY (the switch-over layout: no shared catalog or shared revisions, no companyId attribute). */
const own = (w: ReturnType<typeof world>, name: string, companyId = COMPANY, revisions = 1) => partitionRows(w.db, name, companyId, revisions);
function flag(w: ReturnType<typeof world>, companyId = COMPANY) {
  w.db.set({ pk: companyScoped(companyId, "SETTINGS"), sk: "PROJECT_CATALOG_INDEX", verifiedAt: new Date(now).toISOString(), count: 1, runId: "catalog-test" });
}

it("cursors: cross-company replay, forgery and v1 are refused with identical fixed words, even when the other company has the same name", async () => {
  const w = world(); own(w, "alpha"); own(w, "beta"); own(w, "alpha", B); own(w, "gamma", B);
  const first = await w.get("?limit=1"); expect(first.nextCursor).toBe(c2(COMPANY, "alpha"));
  expect((await w.get(`?cursor=${first.nextCursor}`)).projects.map((row) => row.project)).toEqual(["beta"]);
  const malformed = [c2(B, "alpha"), c2(COMPANY, "missing"), c2(COMPANY, "gamma"), c2(COMPANY, "alpha", { extra: true }), c2(COMPANY, "alpha", { v: 1 }), "~200", "alpha~0", "garbage", first.nextCursor + "=",
    "c2." + Buffer.from(JSON.stringify({ v: 2, companyId: COMPANY, after: "alpha" })).toString("base64url")];
  for (const cursor of malformed) await expect(w.get(`?cursor=${encodeURIComponent(cursor)}`)).rejects.toMatchObject({ code: "CONFIG_INVALID", message: "invalid settings compliance request" });
  // A's own cursor replayed by B's administrator (B holds a project of the same name): refused, B learns nothing.
  w.setCompany(B); w.member("admin", {}, B);
  await expect(w.get(`?cursor=${first.nextCursor}`)).rejects.toMatchObject({ code: "CONFIG_INVALID", message: "invalid settings compliance request" });
  expect((await w.get(`?cursor=${encodeURIComponent(c2(B, "alpha"))}`)).projects.map((row) => row.project)).toEqual(["gamma"]);
});
it("a row in the company's partition that names another company, or selects no project of its name, fails closed and logs only the caller company once", async () => {
  const revision = projectRevisionKey(COMPANY, "web", 1);
  const cases: Array<[string, (w: ReturnType<typeof world>) => void]> = [
    ["catalog companyId", (w) => w.db.set({ ...w.db.get(orgProjectCatalogKey(COMPANY, "web").pk, "PROJECT#web")!, companyId: B })],
    ["catalog companyId null", (w) => w.db.set({ ...w.db.get(orgProjectCatalogKey(COMPANY, "web").pk, "PROJECT#web")!, companyId: null })],
    ["catalog orgId", (w) => w.db.set({ ...w.db.get(orgProjectCatalogKey(COMPANY, "web").pk, "PROJECT#web")!, orgId: B })],
    ["catalog name", (w) => w.db.set({ ...w.db.get(orgProjectCatalogKey(COMPANY, "web").pk, "PROJECT#web")!, name: "other" })],
    ["catalog entityType", (w) => w.db.set({ ...w.db.get(orgProjectCatalogKey(COMPANY, "web").pk, "PROJECT#web")!, entityType: "PROJECT" })],
    ["catalog revision", (w) => w.db.set({ ...w.db.get(orgProjectCatalogKey(COMPANY, "web").pk, "PROJECT#web")!, latestRevision: 0 })],
    ["revision companyId", (w) => w.db.set({ ...w.db.get(revision.pk, revision.sk)!, companyId: B })],
    ["revision orgId", (w) => w.db.set({ ...w.db.get(revision.pk, revision.sk)!, orgId: B })],
    ["revision missing", (w) => w.db.delete(revision.pk, revision.sk)],
    ["revision entityType", (w) => w.db.set({ ...w.db.get(revision.pk, revision.sk)!, entityType: "PROJECT_META" })],
    ["definition name", (w) => w.db.set({ ...w.db.get(revision.pk, revision.sk)!, definition: { name: "other", revision: 1 } })],
    ["definition revision", (w) => w.db.set({ ...w.db.get(revision.pk, revision.sk)!, definition: { name: "web", revision: 2 } })],
    ["no definition", (w) => w.db.set({ ...w.db.get(revision.pk, revision.sk)!, definition: null })],
  ];
  for (const [label, plant] of cases) {
    const w = world(); own(w, "alpha"); own(w, "web"); own(w, "web", B); plant(w);
    const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(w.get(), label).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: "settings unavailable" });
      expect(log, label).toHaveBeenCalledTimes(1);
      expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({ companyId: COMPANY, event: "project_catalog.index_drift" });
      expect(JSON.stringify(log.mock.calls)).not.toContain(B);
    } finally { log.mockRestore(); }
  }
  // The same rows with the caller's own companyId present are fine, and so is an approved setup's revision (the catalog selects it; it keeps `candidate: true`).
  const w = world(); own(w, "web");
  w.db.set({ ...w.db.get(orgProjectCatalogKey(COMPANY, "web").pk, "PROJECT#web")!, companyId: COMPANY, orgId: COMPANY });
  w.db.set({ ...w.db.get(revision.pk, revision.sk)!, companyId: COMPANY });
  own(w, "approved"); w.db.set({ ...w.db.get(projectRevisionKey(COMPANY, "approved", 1).pk, "REV#000000000001")!, candidate: true });
  expect((await w.get()).projects.map((row) => row.project)).toEqual(["approved", "web"]);
});
it("implicit company: unflagged behavior stays v1; unmark restores it; flagged deadline resumes in v2; a malformed flag fails closed", async () => {
  const w = world(I); for (let i = 0; i < 12; i++) w.project(`p${String(i).padStart(2, "0")}`);
  expect((await w.get("?limit=1")).nextCursor).toBe("p00~0");
  flag(w, I); w.hook(() => { w.advance(1100); return {}; });
  const first = await w.get("?limit=12"); expect(first.projects).toHaveLength(4); expect(first.nextCursor).toBe(c2(I, "p03"));
  expect((await w.get(`?cursor=${first.nextCursor}`)).projects[0]?.project).toBe("p04");
  const key = orgSettingsKey(I, "PROJECT_CATALOG_INDEX"); w.db.delete(key.pk, key.sk);
  expect((await w.get("?limit=1")).nextCursor).toBe("p00~0");
  w.db.set({ ...key, garbage: true });
  await expect(w.get()).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: "settings unavailable" });
});

