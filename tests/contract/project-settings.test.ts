import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { resolvePolicy, companyScoped, AgentXError, IMPLICIT_COMPANY_ID, POLICY_FIELDS, POLICY_FIELD_SURFACES, orgProjectCatalogKey, orgSettingsKey, policyFieldPageOnly, projectRevisionKey } from "@agentx/contracts";
import { routeDeveloperRequest, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { createProjectSettingsPolicySource } from "../../packages/broker/src/aws/project-settings.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { COMPANY, ISSUER, fakeService, makeKey, settingsFor, signerOf } from "../unit/policy-hook-fixture.js";

const B = "org_bbbbbbbbbbbbbbbbbbbb";
const now = 1_800_000_000_000;
const person = "d".repeat(64);
const path = "/v1/dev/projects/web/settings";
const install = makeKey("install"); const hookKey = makeKey("hook");
/** The switch-over layout (staging 2026-11-17): the company's own catalog pointer and selected revision, with NO companyId (the partition key names the company). */
function partitionProject(db: FakeDynamoDb, companyId: string, name = "web", revision = 1, extra: Record<string, unknown> = {}) {
  db.set({ ...projectRevisionKey(companyId, name, revision), entityType: "PROJECT", definition: { name, revision } });
  db.set({ ...orgProjectCatalogKey(companyId, name), entityType: "PROJECT_CATALOG", name, latestRevision: revision, ...extra });
}
function world() {
  const db = new FakeDynamoDb();
  let company: string | undefined = COMPANY;
  // The verified access token's step-up claims (set by the sign-in server, never by a request). Fresh by default so the M4a slice 1 cases keep their meaning.
  let stepUp: { step_up_at?: unknown; step_up_amr?: unknown } = { step_up_at: now / 1000 - 60, step_up_amr: "email_code" };
  const companies = { companyOf: vi.fn(async () => company) };
  const deps: DeveloperRouteDependencies = { documentClient: db, tableName: "state", companies, now: () => now,
    developer: { issuer: ISSUER, env: "test", methods: { slack: true, oidc: false }, signInTableName: "signin", channelMembers: async () => ({ ok: false, error: "slack_unavailable" }),
      verifyAccessToken: async () => ({ iss: ISSUER, aud: "agentx-developer", sub: person, amr: "slack", env: "test", sid: "session", iat: now / 1000, exp: now / 1000 + 3600, companyId: COMPANY, ...stepUp }) } };
  db.set({ pk: "SESSION#session", sk: "META", sessionId: "session", developerId: person, amr: "slack", startedAt: new Date(now).toISOString(), endsAt: now / 1000 + 3600 });
  db.set({ pk: `DEVELOPER#${person}`, sk: "META", displayName: "Test", revoked: false });
  // A project in BOTH layouts: the legacy shared row (read only by the implicit company's unmarked path) and the company partition rows, without companyId as the switch-over left them.
  const project = (cid: string) => {
    db.set({ pk: "PROJECT#web", sk: "REV#000000000001", companyId: cid, entityType: "PROJECT", definition: { name: "web", revision: 1 } });
    partitionProject(db, cid);
  };
  const role = (value = "administrator", cid = COMPANY) => db.set({ pk: `MEMBER#${person}`, sk: "PROJECT#web", companyId: cid, projectName: "web", role: value });
  project(COMPANY); role();
  const send = vi.spyOn(db, "send");
  const call = (method = "GET", body?: unknown, query = "", headers: Record<string, string> = {}) => routeDeveloperRequest(deps, { method, path, headers: { authorization: "Bearer fixture", "x-company-id": COMPANY, ...headers }, requestId: "test", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, new URL(path + query, ISSUER)).catch((error: unknown) => {
    if (error instanceof AgentXError) throw Object.assign(new Error(error.message.slice(error.code.length + 2)), { code: error.code, statusCode: error.statusCode });
    throw error;
  });
  const hook = (locks: Record<string, unknown> | Error) => {
    const service = fakeService({ key: hookKey, now: () => now, answer: () => locks instanceof Error ? locks : ({ locks }) });
    deps.developer.policyHook = { settings: settingsFor(hookKey), install: { issuer: ISSUER, signer: signerOf(install) }, fetch: service.fetch };
    return service;
  };
  return { db, deps, send, call, role, project, hook, companies, setCompany: (value: string | undefined) => { company = value; },
    setStepUp: (value: { step_up_at?: unknown; step_up_amr?: unknown }) => { stepUp = value; } };
}
it("absent row and absent hook preserve today's resolution byte for byte", async () => {
  const w = world();
  const got = await w.call() as { revision: number; resolved: unknown };
  expect(got.revision).toBe(0);
  const golden = readFileSync("tests/fixtures/project-settings-today.json", "utf8").trim();
  expect(JSON.stringify(got.resolved)).toBe(golden);
  expect(JSON.stringify(resolvePolicy({}))).toBe(golden);
});
it("sets preset and overrides with origins and one atomic company audit", async () => {
  const w = world();
  const result = await w.call("PUT", { expectedRevision: 0, preset: "balanced", overrides: { extra_review: true } });
  expect(result).toMatchObject({ revision: 1, preset: "balanced", overrides: { extra_review: true }, values: { extra_review: { value: true, origin: "changed here" } } });
  const audit = w.db.find((row) => row.entityType === "COMPANY_LOG");
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ pk: companyScoped(COMPANY, "COMPANY_LOG"), companyId: COMPANY, personId: person, projectName: "web", revision: 1, event: "project_settings_changed" });
  expect(audit[0]?.changes).toEqual(expect.arrayContaining([{ field: "extra_review", before: false, after: true }]));
  expect(await w.call()).toEqual(result);
});
it("uses live membership, never request or token company; B cannot read or write A", async () => {
  const w = world();
  await w.call("PUT", { expectedRevision: 0, overrides: { extra_review: true } });
  w.setCompany(B); w.send.mockClear();
  for (const method of ["GET", "PUT"]) await expect(w.call(method, { expectedRevision: 1, overrides: { extra_review: false } }, `?companyId=${COMPANY}`)).rejects.toMatchObject({ code: "NOT_FOUND", message: "project not found" });
  expect(w.send.mock.calls.some(([c]) => JSON.stringify(c.input).includes("PROJECT_SETTINGS"))).toBe(false);
  w.project(B); w.role("administrator", B);
  expect(await w.call()).toMatchObject({ revision: 0 });
  await w.call("PUT", { expectedRevision: 0, overrides: { extra_review: false } });
  w.setCompany(COMPANY); w.project(COMPANY); w.role();
  expect(await w.call()).toMatchObject({ revision: 1, overrides: { extra_review: true } });
});
it("missing or unreadable live membership fails closed without settings access", async () => {
  const w = world(); w.setCompany(undefined);
  await expect(w.call()).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  w.companies.companyOf.mockRejectedValueOnce(new Error("private-canary"));
  await expect(w.call()).rejects.not.toThrow("private-canary");
  expect(w.send.mock.calls.some(([c]) => JSON.stringify(c.input).includes("PROJECT_SETTINGS"))).toBe(false);
});
it.each(["developer", "unknown"])("PUT requires this company's project administrator (%s)", async (role) => {
  const w = world(); w.role(role);
  await expect(w.call("PUT", { expectedRevision: 0, preset: "careful" })).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403, message: "project administrator required" });
  w.role("administrator", B);
  await expect(w.call("PUT", { expectedRevision: 0, preset: "careful" })).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403, message: "project administrator required" });
});
it("concurrent writes with the same revision have one winner and one audit", async () => {
  const w = world();
  const results = await Promise.allSettled([w.call("PUT", { expectedRevision: 0, preset: "careful" }), w.call("PUT", { expectedRevision: 0, preset: "balanced" })]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { message: "settings revision conflict" } });
  expect(w.db.find((r) => r.entityType === "COMPANY_LOG")).toHaveLength(1);
  await expect(w.call("PUT", { expectedRevision: 0, preset: "lightweight" })).rejects.toThrow("settings revision conflict");
});
it("refuses crossings of minimums and limits with fixed field-only words", async () => {
  const w = world(); const service = w.hook({ extra_review: true, model_budget_usd: 5, preset_level: "balanced" });
  expect(await w.call()).toMatchObject({ values: { extra_review: { origin: "company minimum" }, model_budget_usd: { origin: "company limit" } } });
  await expect(w.call("PUT", { expectedRevision: 0, overrides: { extra_review: false } })).rejects.toThrow(/^extra_review: company minimum cannot be crossed$/);
  await expect(w.call("PUT", { expectedRevision: 0, overrides: { model_budget_usd: 987654 } })).rejects.toThrow(/^model_budget_usd: company limit cannot be crossed$/);
  expect(await w.call("PUT", { expectedRevision: 0, overrides: { model_budget_usd: 2 } })).toMatchObject({ revision: 1 });
  expect(service.asked.every((q) => q.q.cid === COMPANY && q.q.pid === "web")).toBe(true);
});
it.each([new Error("private-canary"), { model_budget_usd: "private-canary" }])("hook failures are policy_unavailable", async (locks) => {
  const w = world(); w.hook(locks);
  for (const method of ["GET", "PUT"]) await expect(w.call(method, { expectedRevision: 0, preset: "balanced" })).rejects.toThrow(/^policy_unavailable$/);
  expect(w.db.find((r) => r.entityType === "PROJECT_SETTINGS")).toHaveLength(0);
});
it.each([{ expectedRevision: 0, overrides: { extra_review: "private-canary" } }, { expectedRevision: -1, preset: "balanced" }, { expectedRevision: 0, preset: "private-canary" }, { expectedRevision: 0, overrides: { unknown: true } }, { expectedRevision: 0, companyId: B }, { preset: "careful" }, { expectedRevision: 0 }])("runtime validation refuses malformed inputs without echoing", async (body) => {
  const w = world();
  await expect(w.call("PUT", body)).rejects.toThrow(/^invalid settings request$/);
});
it("audit failure refuses the transaction without saving settings", async () => {
  const w = world();
  w.db.injectFault({ command: "TransactWriteCommand", error: { name: "InternalServerError", message: "private-canary" } });
  await expect(w.call("PUT", { expectedRevision: 0, preset: "balanced" })).rejects.toThrow(/^settings unavailable$/);
  expect(await w.call()).toMatchObject({ revision: 0 });
});
it("large or polluted bodies refuse as a whole, within the existing timeout", async () => {
  const w = world();
  await expect(w.call("PUT", { expectedRevision: 0, overrides: { unknown: "x".repeat(1_000_000) } })).rejects.toThrow(/^invalid settings request$/);
  await expect(w.call("PUT", JSON.parse('{"expectedRevision":0,"overrides":{"__proto__":{"extra_review":true}}}'))).rejects.toThrow(/^invalid settings request$/);
  expect(w.db.find((row) => row.entityType === "PROJECT_SETTINGS")).toEqual([]);
}, 2000);
it("the maximum settings request round-trips without dropping fields", async () => {
  const w = world();
  const overrides = { preset_level: "careful", real_check: "rovara_real_run", ci_fix_rounds: 3, round_time_minutes: 120, model_budget_usd: 100, machine_budget_minutes: 100, extra_review: true, after_merge_revert: "offer_revert", mutation_spot_check: "on", prompt_side_by_side: "on" };
  expect(await w.call("PUT", { expectedRevision: 0, preset: "careful", overrides })).toMatchObject({ revision: 1, overrides });
  expect(await w.call("PUT", { expectedRevision: 1, overrides: {} })).toMatchObject({ revision: 2, preset: "careful", overrides: {} });
});
it("unreadable and foreign stored settings refuse, never fall back to defaults or echo data", async () => {
  const w = world();
  for (const fields of [{ companyId: B }, { overrides: { extra_review: "private-canary" } }, { revision: "private-canary" }]) {
    w.db.set({ pk: companyScoped(COMPANY, "PROJECT_SETTINGS#web"), sk: "META", companyId: COMPANY, projectName: "web", overrides: {}, revision: 1, updatedAt: new Date(now).toISOString(), updatedBy: person, ...fields });
    await expect(w.call()).rejects.toThrow(/^policy_unavailable$/);
  }
});
it("failed project and administrator reads never echo their cause", async () => {
  // A named company: its catalog pointer, its selected revision and the grant are each a point read.
  for (const marker of ["PROJECT_CATALOG", "REV#", "MEMBER#"]) {
    const w = world();
    w.db.injectFault({ command: "GetCommand", match: (input) => JSON.stringify(input).includes(marker), error: { name: "InternalServerError", message: "private-canary" } });
    await expect(w.call("PUT", { expectedRevision: 0, preset: "balanced" })).rejects.toThrow(/^settings unavailable$/);
  }
  // The implicit company's legacy path: the shared project query and its grant read.
  for (const command of ["QueryCommand", "GetCommand"]) {
    const w = world(); w.setCompany(IMPLICIT_COMPANY_ID); w.project(IMPLICIT_COMPANY_ID); w.role("administrator", IMPLICIT_COMPANY_ID);
    w.db.injectFault({ command, ...(command === "GetCommand" ? { match: (input) => JSON.stringify(input).includes("MEMBER#") } : {}), error: { name: "InternalServerError", message: "private-canary" } });
    await expect(w.call("PUT", { expectedRevision: 0, preset: "balanced" })).rejects.toThrow(/^settings unavailable$/);
  }
});

// ---- L2-5 (a): the page reads the company's own partition, like the S3 compliance list (#843). ----
const STAGING = "/v1/dev/projects/web/settings";
/** Only the switch-over layout: no shared rows at all, no companyId on any project row, and the broker's grant row without a company (as registration writes it). */
function stagingWorld(company = COMPANY) {
  const w = world();
  for (const row of w.db.find((r) => r.pk === "PROJECT#web" || r.pk === `MEMBER#${person}` || String(r.pk).includes("PROJECT_CATALOG") || String(r.pk).includes("#PROJECT#"))) w.db.delete(String(row.pk), String(row.sk));
  w.setCompany(company);
  partitionProject(w.db, company);
  w.db.set({ pk: `MEMBER#${person}`, sk: "PROJECT#web", entityType: "MEMBERSHIP", ownerKey: person, projectName: "web", role: "administrator" });
  return w;
}
const drop = (db: FakeDynamoDb, key: { pk: string; sk: string }) => db.delete(key.pk, key.sk);
const reads = (w: ReturnType<typeof world>) => w.send.mock.calls.map(([c]) => JSON.stringify((c as { input: unknown }).input));

it("a named company with only partition rows (the staging layout) reads and saves its page", async () => {
  const w = stagingWorld();
  expect(STAGING).toBe(path);
  expect(await w.call()).toMatchObject({ revision: 0 });
  expect(await w.call("PUT", { expectedRevision: 0, overrides: { model_budget_usd: 3 } })).toMatchObject({ revision: 1, overrides: { model_budget_usd: 3 } });
  expect(await w.call()).toMatchObject({ revision: 1, values: { model_budget_usd: { value: 3, origin: "changed here" } } });
  // Never the shared project rows, the shared catalog or the implicit company's flag.
  expect(reads(w).some((input) => /"(:)?pk":"PROJECT#web"/.test(input) || input.includes('"PROJECT_CATALOG"') || input.includes("PROJECT_CATALOG_INDEX"))).toBe(false);
});

it("a named company never falls back to a shared row: shared-only is the same 'project not found' as unknown", async () => {
  const w = world();
  for (const row of w.db.find((r) => String(r.pk).startsWith("ORG#") && (String(r.pk).includes("#PROJECT_CATALOG") || String(r.pk).includes("#PROJECT#")))) w.db.delete(String(row.pk), String(row.sk));
  w.send.mockClear();
  for (const method of ["GET", "PUT"]) await expect(w.call(method, { expectedRevision: 0, preset: "careful" })).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404, message: "project not found" });
  expect(reads(w).some((input) => input.includes("PROJECT_SETTINGS") || /"(:)?pk":"PROJECT#web"/.test(input))).toBe(false);
});

it("two companies: A never reads or writes B's partition project, and the refusal is the unknown project's", async () => {
  const w = stagingWorld(B);
  expect(await w.call()).toMatchObject({ revision: 0 });
  w.setCompany(COMPANY); w.send.mockClear();
  const unknown = await w.call("GET").catch((error: unknown) => error);
  drop(w.db, orgProjectCatalogKey(B, "web"));
  const missing = await w.call("GET").catch((error: unknown) => error);
  expect(unknown).toMatchObject({ code: "NOT_FOUND", message: "project not found" });
  expect(JSON.stringify(unknown)).toBe(JSON.stringify(missing));
  partitionProject(w.db, B);
  await expect(w.call("PUT", { expectedRevision: 0, preset: "careful" })).rejects.toMatchObject({ code: "NOT_FOUND", message: "project not found" });
  expect(reads(w).some((input) => input.includes(B))).toBe(false);
  expect(w.db.find((row) => row.entityType === "PROJECT_SETTINGS" || row.entityType === "COMPANY_LOG")).toEqual([]);
});

it.each([
  ["a catalog row naming another company", (db: FakeDynamoDb) => partitionProject(db, COMPANY, "web", 1, { companyId: B })],
  ["a catalog row naming another org", (db: FakeDynamoDb) => partitionProject(db, COMPANY, "web", 1, { orgId: B })],
  ["a catalog row for another name", (db: FakeDynamoDb) => partitionProject(db, COMPANY, "web", 1, { name: "api" })],
  ["a catalog row of another kind", (db: FakeDynamoDb) => partitionProject(db, COMPANY, "web", 1, { entityType: "PROJECT" })],
  ["a catalog row with no selected revision", (db: FakeDynamoDb) => partitionProject(db, COMPANY, "web", 1, { latestRevision: "1" })],
  ["a selected revision that is missing", (db: FakeDynamoDb) => { partitionProject(db, COMPANY); drop(db, projectRevisionKey(COMPANY, "web", 1)); }],
  ["a selected revision naming another company", (db: FakeDynamoDb) => { partitionProject(db, COMPANY); db.set({ ...projectRevisionKey(COMPANY, "web", 1), entityType: "PROJECT", companyId: B, definition: { name: "web", revision: 1 } }); }],
  ["a selected revision of another project", (db: FakeDynamoDb) => { partitionProject(db, COMPANY); db.set({ ...projectRevisionKey(COMPANY, "web", 1), entityType: "PROJECT", definition: { name: "api", revision: 1 } }); }],
  ["a selected revision at another revision", (db: FakeDynamoDb) => { partitionProject(db, COMPANY); db.set({ ...projectRevisionKey(COMPANY, "web", 1), entityType: "PROJECT", definition: { name: "web", revision: 2 } }); }],
  ["a selected revision of another kind", (db: FakeDynamoDb) => { partitionProject(db, COMPANY); db.set({ ...projectRevisionKey(COMPANY, "web", 1), entityType: "PROJECT_CATALOG", definition: { name: "web", revision: 1 } }); }],
])("%s is drift: fixed 503, one drift event under only the caller's company, nothing read or written past it", async (_label, corrupt) => {
  const w = stagingWorld();
  corrupt(w.db);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    for (const method of ["GET", "PUT"]) await expect(w.call(method, { expectedRevision: 0, preset: "careful" })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", statusCode: 503, message: "settings unavailable" });
    expect(warn.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown)).toEqual([{ companyId: COMPANY, event: "project_catalog.index_drift" }, { companyId: COMPANY, event: "project_catalog.index_drift" }]);
  } finally { warn.mockRestore(); }
  expect(reads(w).some((input) => input.includes("PROJECT_SETTINGS") || input.includes("MEMBER#"))).toBe(false);
});

it("an approved setup's selected revision (it keeps candidate: true) is the project, as the engine reads it", async () => {
  const w = stagingWorld();
  w.db.set({ ...projectRevisionKey(COMPANY, "web", 2), entityType: "PROJECT", candidate: true, definition: { name: "web", revision: 2 } });
  w.db.set({ ...orgProjectCatalogKey(COMPANY, "web"), entityType: "PROJECT_CATALOG", name: "web", latestRevision: 2 });
  expect(await w.call("PUT", { expectedRevision: 0, preset: "careful" })).toMatchObject({ revision: 1 });
});

it("PUT on a partition project: the grant row may leave the company out, but one naming another company, another project or a lesser role is refused", async () => {
  const w = stagingWorld();
  const grant = (fields: Record<string, unknown>) => w.db.set({ pk: `MEMBER#${person}`, sk: "PROJECT#web", entityType: "MEMBERSHIP", ownerKey: person, projectName: "web", role: "administrator", ...fields });
  for (const fields of [{ companyId: B }, { orgId: B }, { companyId: "not-an-org" }, { projectName: "api" }, { role: "developer" }, { role: "owner" }]) {
    grant(fields);
    await expect(w.call("PUT", { expectedRevision: 0, preset: "careful" })).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403, message: "project administrator required" });
  }
  w.db.delete(`MEMBER#${person}`, "PROJECT#web");
  await expect(w.call("PUT", { expectedRevision: 0, preset: "careful" })).rejects.toMatchObject({ code: "FORBIDDEN", message: "project administrator required" });
  expect(w.db.find((row) => row.entityType === "PROJECT_SETTINGS")).toEqual([]);
  grant({ companyId: COMPANY });
  expect(await w.call("PUT", { expectedRevision: 0, preset: "careful" })).toMatchObject({ revision: 1 });
  grant({});
  expect(await w.call("PUT", { expectedRevision: 1, preset: "balanced" })).toMatchObject({ revision: 2 });
});

it("the implicit company keeps today's shared path until it is marked, then reads its partition; a malformed mark refuses", async () => {
  const I = IMPLICIT_COMPANY_ID;
  const w = world(); w.setCompany(I);
  // Unmarked: the legacy shared row (no companyId reads as the implicit company's) and the legacy grant rule, exactly as before.
  w.db.set({ pk: "PROJECT#web", sk: "REV#000000000001", entityType: "PROJECT", definition: { name: "web", revision: 1 } });
  w.db.set({ pk: `MEMBER#${person}`, sk: "PROJECT#web", projectName: "web", role: "administrator" });
  expect(await w.call("PUT", { expectedRevision: 0, preset: "careful" })).toMatchObject({ revision: 1 });
  expect(reads(w).some((input) => input.includes(`ORG#${I}#PROJECT_CATALOG`))).toBe(false);
  // The legacy grant rule is projectGrant's, unchanged: only the stored companyId counts (an orgId or projectName on the row is not read there, as before).
  w.db.set({ pk: `MEMBER#${person}`, sk: "PROJECT#web", projectName: "other", orgId: B, role: "administrator" });
  expect(await w.call("PUT", { expectedRevision: 1, preset: "balanced" })).toMatchObject({ revision: 2 });
  // A grant naming a named company is refused on the legacy path (projectGrant's stored-company rule).
  w.role("administrator", COMPANY);
  await expect(w.call("PUT", { expectedRevision: 2, preset: "lightweight" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  // Marked: only the partition counts, so a shared-only project is not found.
  w.db.set({ ...orgSettingsKey(I, "PROJECT_CATALOG_INDEX"), verifiedAt: new Date(now).toISOString(), count: 1, runId: "run-1" });
  await expect(w.call()).rejects.toMatchObject({ code: "NOT_FOUND", message: "project not found" });
  partitionProject(w.db, I);
  expect(await w.call()).toMatchObject({ revision: 2 });
  w.db.set({ ...orgSettingsKey(I, "PROJECT_CATALOG_INDEX"), verifiedAt: "private-canary" });
  await expect(w.call()).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: "settings unavailable" });
});

it("a named company ignores a mark row left on it (as the S3 list does)", async () => {
  const w = stagingWorld();
  w.db.set({ ...orgSettingsKey(COMPANY, "PROJECT_CATALOG_INDEX"), verifiedAt: "private-canary" });
  expect(await w.call()).toMatchObject({ revision: 0 });
});
it("the largest valid revision is readable after its final conditional write", async () => {
  const w = world();
  w.db.set({ pk: companyScoped(COMPANY, "PROJECT_SETTINGS#web"), sk: "META", companyId: COMPANY, projectName: "web", overrides: {}, revision: Number.MAX_SAFE_INTEGER - 1, updatedAt: new Date(now).toISOString(), updatedBy: person });
  expect(await w.call("PUT", { expectedRevision: Number.MAX_SAFE_INTEGER - 1, preset: "balanced" })).toMatchObject({ revision: Number.MAX_SAFE_INTEGER });
  expect(await w.call()).toMatchObject({ revision: Number.MAX_SAFE_INTEGER });
});

it("the engine seam rereads settings and rejects a foreign opaque scope before reading", async () => {
  const w = world();
  const adapter = createProjectSettingsPolicySource(w.deps, { companyId: COMPANY, projectName: "web" });
  expect(JSON.stringify(await adapter.source.resolve(adapter.scope, {}))).toBe(readFileSync("tests/fixtures/project-settings-today.json", "utf8").trim());
  await w.call("PUT", { expectedRevision: 0, overrides: { extra_review: true } });
  expect((await adapter.source.resolve(adapter.scope, {})).values["extra_review"]).toEqual({ value: true, origin: "changed_here" });
  w.send.mockClear();
  await expect(adapter.source.resolve({ key: `${B}/web` }, {})).rejects.toThrow(/^policy_unavailable$/);
  expect(w.send).not.toHaveBeenCalled();
});

it("uses the hosted JWKS path for the developer API's hook settings and refuses a failed JWKS", async () => {
  const { policyHookKeyThumbprint } = await import("@agentx/contracts");
  const w = world();
  const service = fakeService({ key: hookKey, now: () => now, answer: () => ({ locks: { ci_fix_rounds: 1 } }) });
  const settings = { address: settingsFor(hookKey).address, jwks: "https://rules.example/keys", thumbprints: [policyHookKeyThumbprint(hookKey.jwk)] };
  const fetched: string[] = [];
  w.deps.developer.policyHook = { settings, install: { issuer: ISSUER, signer: signerOf(install) }, fetch: async (url, init) => {
    const address = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    fetched.push(address);
    return address === settings.jwks ? Response.json({ keys: [hookKey.jwk] }) : service.fetch(url, init);
  } };
  expect(await w.call()).toMatchObject({ values: { ci_fix_rounds: { value: 1 } } });
  expect(fetched).toEqual([settings.jwks, settings.address]);
  w.deps.developer.policyHook.fetch = async () => new Response("", { status: 503 });
  await expect(w.call()).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
});

// ---- M4a slice 2: a cost or approval setting is changed on the page, right after a fresh step-up (DEC 236j; the brief's page-only rule) ----
const PAGE_ONLY_WORDS = "Cost and approval settings are changed on the project's settings page, right after you confirm it's you on the sign-in page: a tool that only holds an API token cannot change them. Confirm it's you, then try again within a few minutes.";
const CHANGES: Record<string, unknown> = {
  preset_level: "careful", real_check: "rovara_real_run", ci_fix_rounds: 2, round_time_minutes: 45, model_budget_usd: 7, machine_budget_minutes: 90,
  extra_review: true, mutation_spot_check: "on", prompt_side_by_side: "on",
};
const noStepUp = () => ({ step_up_at: undefined, step_up_amr: undefined });
const writes = (w: ReturnType<typeof world>) => w.db.find((row) => row.entityType === "PROJECT_SETTINGS");

it("classifies every settings field, and a field nobody classified is page-only", () => {
  expect(Object.keys(POLICY_FIELD_SURFACES).sort()).toEqual(POLICY_FIELDS.map((field) => field.id).sort());
  expect(policyFieldPageOnly("brand_new_field")).toBe(true);
  expect(policyFieldPageOnly("__proto__")).toBe(true);
  expect(policyFieldPageOnly("constructor")).toBe(true);
  expect(POLICY_FIELDS.filter((field) => !policyFieldPageOnly(field.id)).map((field) => field.id)).toEqual(["after_merge_revert"]);
});
it.each(Object.entries(CHANGES))("changing %s without a step-up is refused with fixed words and writes nothing", async (field, value) => {
  const w = world(); w.setStepUp(noStepUp());
  await expect(w.call("PUT", { expectedRevision: 0, overrides: { [field]: value } })).rejects.toMatchObject({ code: "REAUTH_REQUIRED", statusCode: 403, message: PAGE_ONLY_WORDS });
  expect(writes(w)).toEqual([]);
  expect(w.db.find((row) => row.entityType === "COMPANY_LOG")).toEqual([]);
  w.setStepUp({ step_up_at: now / 1000 - 60, step_up_amr: "email_code" });
  expect(await w.call("PUT", { expectedRevision: 0, overrides: { [field]: value } })).toMatchObject({ revision: 1, overrides: { [field]: value } });
});
it("after_merge_revert only offers a revert a person presses, so it needs no step-up", async () => {
  const w = world(); w.setStepUp(noStepUp());
  expect(await w.call("PUT", { expectedRevision: 0, overrides: { after_merge_revert: "report_only" } })).toMatchObject({ revision: 1 });
});
it("choosing a preset that changes a cost field needs a step-up; choosing the same preset again does not", async () => {
  const w = world();
  await w.call("PUT", { expectedRevision: 0, preset: "balanced" });
  w.setStepUp(noStepUp());
  await expect(w.call("PUT", { expectedRevision: 1, preset: "careful" })).rejects.toMatchObject({ code: "REAUTH_REQUIRED", message: PAGE_ONLY_WORDS });
  expect(await w.call("PUT", { expectedRevision: 1, preset: "balanced" })).toMatchObject({ revision: 2, preset: "balanced" });
  expect(await w.call()).toMatchObject({ revision: 2 });
});
it("clearing an override needs a step-up even when a company minimum hides the effect", async () => {
  const w = world(); w.hook({ extra_review: true });
  await w.call("PUT", { expectedRevision: 0, overrides: { extra_review: true } });
  w.setStepUp(noStepUp());
  // The effective value is true either way (the company minimum), but the stored choice would show again when the minimum is lifted.
  await expect(w.call("PUT", { expectedRevision: 1, overrides: {} })).rejects.toMatchObject({ code: "REAUTH_REQUIRED", message: PAGE_ONLY_WORDS });
  expect(await w.call()).toMatchObject({ revision: 1, overrides: { extra_review: true } });
});
it("dropping an override that equals the preset still changes the page's 'changed here' choice, so it needs a step-up", async () => {
  const w = world();
  await w.call("PUT", { expectedRevision: 0, preset: "balanced", overrides: { extra_review: true } });
  w.setStepUp(noStepUp());
  await expect(w.call("PUT", { expectedRevision: 1, overrides: {} })).rejects.toMatchObject({ code: "REAUTH_REQUIRED", message: PAGE_ONLY_WORDS });
  expect(await w.call()).toMatchObject({ revision: 1, overrides: { extra_review: true } });
});
it("a repeat of what is stored changes nothing, so it needs no step-up", async () => {
  const w = world();
  await w.call("PUT", { expectedRevision: 0, overrides: { extra_review: true } });
  w.setStepUp(noStepUp());
  expect(await w.call("PUT", { expectedRevision: 1, overrides: { extra_review: true } })).toMatchObject({ revision: 2 });
});
it("reading settings never needs a step-up", async () => {
  const w = world(); w.setStepUp(noStepUp());
  expect(await w.call()).toMatchObject({ revision: 0 });
});
it.each([
  ["a step-up older than the window", { step_up_at: now / 1000 - 601, step_up_amr: "email_code" }],
  ["a step-up from the future", { step_up_at: now / 1000 + 3600, step_up_amr: "email_code" }],
  ["a method that is not Code's own", { step_up_at: now / 1000 - 60, step_up_amr: "slack" }],
  ["a time written as text", { step_up_at: String(now / 1000 - 60), step_up_amr: "email_code" }],
  ["a time without a method", { step_up_at: now / 1000 - 60 }],
  ["a method without a time", { step_up_amr: "passkey" }],
])("%s is no step-up", async (_name, claims) => {
  const w = world(); w.setStepUp(claims);
  await expect(w.call("PUT", { expectedRevision: 0, overrides: { model_budget_usd: 3 } })).rejects.toMatchObject({ code: "REAUTH_REQUIRED", message: PAGE_ONLY_WORDS });
  expect(writes(w)).toEqual([]);
});
it.each(["email_code", "passkey", "company_reauth"])("a fresh %s step-up passes, and the age is read from the token on every request", async (method) => {
  const w = world(); w.setStepUp({ step_up_at: now / 1000 - 599, step_up_amr: method });
  expect(await w.call("PUT", { expectedRevision: 0, overrides: { model_budget_usd: 3 } })).toMatchObject({ revision: 1 });
  w.setStepUp({ step_up_at: now / 1000 - 601, step_up_amr: method });
  await expect(w.call("PUT", { expectedRevision: 1, overrides: { model_budget_usd: 4 } })).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
});
it("a step-up in a header, the query or the body is never believed", async () => {
  const w = world(); w.setStepUp(noStepUp());
  const claimed = { "x-step-up-at": new Date(now - 1000).toISOString(), "x-step-up-method": "passkey", "x-amzn-step-up": "1" };
  await expect(w.call("PUT", { expectedRevision: 0, overrides: { model_budget_usd: 3 } }, `?step_up_at=${now / 1000}&step_up_amr=passkey`, claimed)).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
  await expect(w.call("PUT", { expectedRevision: 0, overrides: { model_budget_usd: 3 }, stepUp: { at: new Date(now).toISOString(), method: "passkey" } })).rejects.toThrow(/^invalid settings request$/);
  expect(writes(w)).toEqual([]);
});
async function unavailableWithoutCanary(call: Promise<unknown>): Promise<void> {
  const error = await call.then(() => undefined, (caught: unknown) => caught as Error & { code?: string });
  expect(error).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  expect(error?.message).not.toContain("private-canary");
}
it("the company's step-up window may only shorten the default, and an unreadable window refuses", async () => {
  const w = world(); w.setStepUp({ step_up_at: now / 1000 - 120, step_up_amr: "email_code" });
  const window = vi.fn<(company: string) => Promise<unknown>>(async () => 60);
  w.deps.developer.stepUpWindowSeconds = window;
  await expect(w.call("PUT", { expectedRevision: 0, overrides: { model_budget_usd: 3 } })).rejects.toMatchObject({ code: "REAUTH_REQUIRED", message: PAGE_ONLY_WORDS });
  expect(window).toHaveBeenCalledWith(COMPANY);
  window.mockResolvedValue(3600);
  await expect(w.call("PUT", { expectedRevision: 0, overrides: { model_budget_usd: 3 } })).resolves.toMatchObject({ revision: 1 });
  for (const answer of ["private-canary", -1, 86_401, 1.5, undefined]) {
    window.mockResolvedValue(answer);
    await unavailableWithoutCanary(w.call("PUT", { expectedRevision: 1, overrides: { model_budget_usd: 4 } }));
  }
  window.mockRejectedValue(new Error("private-canary"));
  await unavailableWithoutCanary(w.call("PUT", { expectedRevision: 1, overrides: { model_budget_usd: 4 } }));
  expect(await w.call()).toMatchObject({ revision: 1 });
});
it("a change that needs no step-up never asks the company's window", async () => {
  const w = world(); w.setStepUp(noStepUp());
  const window = vi.fn<(company: string) => Promise<unknown>>(async () => { throw new Error("must not be asked"); });
  w.deps.developer.stepUpWindowSeconds = window;
  expect(await w.call("PUT", { expectedRevision: 0, overrides: { after_merge_revert: "off" } })).toMatchObject({ revision: 1 });
  expect(window).not.toHaveBeenCalled();
});
it("a person who may not write, or who is in another company, learns nothing from the step-up check", async () => {
  const w = world(); w.setStepUp(noStepUp());
  w.role("developer");
  await expect(w.call("PUT", { expectedRevision: 0, overrides: { model_budget_usd: 3 } })).rejects.toMatchObject({ code: "FORBIDDEN", message: "project administrator required" });
  w.role("administrator");
  w.setCompany(B); w.send.mockClear();
  await expect(w.call("PUT", { expectedRevision: 0, overrides: { model_budget_usd: 3 } })).rejects.toMatchObject({ code: "NOT_FOUND", message: "project not found" });
  expect(w.send.mock.calls.some(([c]) => JSON.stringify(c.input).includes("PROJECT_SETTINGS"))).toBe(false);
  w.setCompany(undefined);
  await expect(w.call("PUT", { expectedRevision: 0, overrides: { model_budget_usd: 3 } })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
});
it("a fresh step-up in company B never lets B change company A's settings", async () => {
  const w = world();
  await w.call("PUT", { expectedRevision: 0, overrides: { model_budget_usd: 3 } });
  w.setCompany(B); w.project(B); w.role("administrator", B);
  expect(await w.call("PUT", { expectedRevision: 0, overrides: { model_budget_usd: 9 } })).toMatchObject({ revision: 1, overrides: { model_budget_usd: 9 } });
  w.setCompany(COMPANY); w.project(COMPANY); w.role();
  expect(await w.call()).toMatchObject({ overrides: { model_budget_usd: 3 } });
});
it("a registered full-access client's token carries its own step-up claims the same way", async () => {
  const w = world();
  const claims = (extra: Record<string, unknown>) => ({ iss: ISSUER, aud: "web-app", azp: "web-app", sub: person, amr: "slack", env: "test", sid: "client-session", iat: now / 1000, exp: now / 1000 + 3600, ...extra });
  w.db.set({ pk: "SIGNIN_CLIENTS", sk: "CLIENT#web-app", entityType: "SIGN_IN_CLIENT", clientId: "web-app", name: "Web App", audience: "web-app", redirectUris: ["https://cloud.example.test/callback"], loopback: false, secretHash: "f".repeat(64), fullAccess: true, installLevel: true, createdAt: new Date(now - 60_000).toISOString(), updatedAt: new Date(now - 60_000).toISOString(), updatedBy: "admin" });
  w.db.set({ pk: "SESSION#client-session", sk: "META", sessionId: "client-session", developerId: person, amr: "slack", clientId: "web-app", startedAt: new Date(now).toISOString(), endsAt: now / 1000 + 3600 });
  w.deps.developer.methods = { slack: true, oidc: false };
  const token = (extra: Record<string, unknown>) => { w.deps.developer.verifyAccessToken = async () => claims(extra); return w.call("PUT", { expectedRevision: 0, overrides: { model_budget_usd: 3 } }, "", { authorization: `Bearer ${["h", Buffer.from(JSON.stringify({ azp: "web-app" })).toString("base64url"), "s"].join(".")}` }); };
  await expect(token({})).rejects.toMatchObject({ code: "REAUTH_REQUIRED", message: PAGE_ONLY_WORDS });
  await expect(token({ step_up_at: now / 1000 - 700, step_up_amr: "passkey" })).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
  expect(await token({ step_up_at: now / 1000 - 30, step_up_amr: "passkey" })).toMatchObject({ revision: 1 });
});
it("a preset change is refused without a step-up even when an override pins preset_level over it", async () => {
  const w = world();
  await w.call("PUT", { expectedRevision: 0, preset: "careful", overrides: { preset_level: "balanced" } });
  w.setStepUp(noStepUp());
  await expect(w.call("PUT", { expectedRevision: 1, preset: "lightweight" })).rejects.toMatchObject({ code: "REAUTH_REQUIRED", message: PAGE_ONLY_WORDS });
  expect(await w.call()).toMatchObject({ revision: 1, preset: "careful" });
});
it("a zero company window refuses every step-up", async () => {
  const w = world(); w.deps.developer.stepUpWindowSeconds = async () => 0;
  await expect(w.call("PUT", { expectedRevision: 0, overrides: { model_budget_usd: 3 } })).rejects.toMatchObject({ code: "REAUTH_REQUIRED", message: PAGE_ONLY_WORDS });
  expect(writes(w)).toEqual([]);
});
it("an api_ok change next to unchanged page-only overrides needs no step-up", async () => {
  const w = world();
  await w.call("PUT", { expectedRevision: 0, overrides: { model_budget_usd: 3, extra_review: true } });
  w.setStepUp(noStepUp());
  expect(await w.call("PUT", { expectedRevision: 1, overrides: { model_budget_usd: 3, extra_review: true, after_merge_revert: "off" } })).toMatchObject({ revision: 2 });
});

// ---- M4a slice 4 (DEC 249a.3): a preset under a company bound is clamped silently; only an explicit override that breaks a bound is refused ----
it("choosing a preset the company minimum or limit does not allow is clamped, not refused, and the response says so", async () => {
  const w = world(); w.hook({ real_check: "their_ci_fix", ci_fix_rounds: 2, preset_level: "balanced" });
  // Before slice 4 every one of these presets was refused ("... cannot be crossed") because the preset's own value crossed a bound.
  for (const [revision, preset] of [[0, "lightweight"], [1, "balanced"], [2, "careful"]] as const) {
    const got = await w.call("PUT", { expectedRevision: revision, preset }) as { revision: number; preset: string; overrides: unknown; values: Record<string, { value: unknown; origin: string }>; clamped: Array<Record<string, unknown>> };
    expect(got).toMatchObject({ revision: revision + 1, preset, overrides: {} });
    expect(got.values["ci_fix_rounds"]).toMatchObject({ value: 2, origin: "company limit" });
    expect(got.clamped).toContainEqual({ field: "ci_fix_rounds", bound: "limit", chosen: 3, applied: 2, notice: "lowered to your company's limit" });
  }
  const lightweight = await w.call("PUT", { expectedRevision: 3, preset: "lightweight" }) as { values: Record<string, { value: unknown; origin: string }>; clamped: Array<Record<string, unknown>> };
  expect(lightweight.values["real_check"]).toMatchObject({ value: "their_ci_fix", origin: "company minimum" });
  expect(lightweight.clamped).toContainEqual({ field: "real_check", bound: "minimum", chosen: "their_ci_watch", applied: "their_ci_fix", notice: "raised to your company's minimum" });
  // The stored choice is the preset the person picked; the bound only changes what applies. GET agrees.
  expect(await w.call()).toMatchObject({ revision: 4, preset: "lightweight", values: { real_check: { value: "their_ci_fix", origin: "company minimum" } } });
  expect(writes(w)).toHaveLength(1);
});
it("a preset below the company's preset_level minimum applies the minimum", async () => {
  const w = world(); w.hook({ preset_level: "balanced" });
  expect(await w.call("PUT", { expectedRevision: 0, preset: "lightweight" })).toMatchObject({ preset: "lightweight", values: { preset_level: { value: "balanced", origin: "company minimum" } } });
});
it("an explicit override that breaks a bound is still refused with fixed words, and nothing is written", async () => {
  const w = world(); w.hook({ ci_fix_rounds: 2, extra_review: true, preset_level: "balanced" });
  // Next to a preset that is itself clamped, the override is what is refused.
  await expect(w.call("PUT", { expectedRevision: 0, preset: "balanced", overrides: { ci_fix_rounds: 3 } })).rejects.toThrow(/^ci_fix_rounds: company limit cannot be crossed$/);
  await expect(w.call("PUT", { expectedRevision: 0, preset: "careful", overrides: { extra_review: false } })).rejects.toThrow(/^extra_review: company minimum cannot be crossed$/);
  // An override of preset_level is explicit too; what that preset expands to for other fields is not.
  await expect(w.call("PUT", { expectedRevision: 0, overrides: { preset_level: "lightweight" } })).rejects.toThrow(/^preset_level: company minimum cannot be crossed$/);
  expect(writes(w)).toEqual([]);
  expect(w.db.find((row) => row.entityType === "COMPANY_LOG")).toEqual([]);
  expect(await w.call("PUT", { expectedRevision: 0, preset: "balanced", overrides: { ci_fix_rounds: 2 } })).toMatchObject({ revision: 1, values: { ci_fix_rounds: { value: 2, origin: "changed here" } } });
});
it("a value that a preset_level override hands to other fields is clamped, not refused", async () => {
  const w = world(); w.hook({ ci_fix_rounds: 2 });
  const got = await w.call("PUT", { expectedRevision: 0, overrides: { preset_level: "balanced" } }) as { values: Record<string, { value: unknown; origin: string }>; clamped: Array<{ field: string }> };
  expect(got.values["ci_fix_rounds"]).toMatchObject({ value: 2, origin: "company limit" });
  expect(got.clamped.map((entry) => entry.field)).toContain("ci_fix_rounds");
});
it("a budget a preset leaves unset is handed to the company limit; an explicit null cannot remove the limit", async () => {
  const w = world(); w.hook({ model_budget_usd: 5 });
  const got = await w.call("PUT", { expectedRevision: 0, preset: "careful" }) as { values: Record<string, { value: unknown; origin: string }>; clamped: Array<{ field: string }> };
  expect(got.values["model_budget_usd"]).toMatchObject({ value: 5, origin: "company limit" });
  expect(got.clamped.map((entry) => entry.field)).not.toContain("model_budget_usd");
  await expect(w.call("PUT", { expectedRevision: 1, overrides: { model_budget_usd: null } })).rejects.toThrow(/^model_budget_usd: company limit cannot be crossed$/);
});
it("an override stored before a bound existed does not block an unrelated change, but a new or changed one that crosses is refused", async () => {
  const w = world();
  await w.call("PUT", { expectedRevision: 0, overrides: { model_budget_usd: 9, extra_review: false } });
  w.hook({ model_budget_usd: 5, extra_review: true, real_check: "their_ci_fix" });
  // The stored override is clamped on the page; choosing a preset (overrides carried over) or re-sending the same map works.
  expect(await w.call("PUT", { expectedRevision: 1, preset: "balanced" })).toMatchObject({ revision: 2, values: { model_budget_usd: { value: 5, origin: "company limit" }, extra_review: { value: true, origin: "company minimum" } } });
  expect(await w.call("PUT", { expectedRevision: 2, overrides: { model_budget_usd: 9, extra_review: false } })).toMatchObject({ revision: 3 });
  // A new override, or a changed value, that crosses is refused.
  await expect(w.call("PUT", { expectedRevision: 3, overrides: { model_budget_usd: 8, extra_review: false } })).rejects.toThrow(/^model_budget_usd: company limit cannot be crossed$/);
  await expect(w.call("PUT", { expectedRevision: 3, overrides: { model_budget_usd: 9, extra_review: false, real_check: "sandbox_only" } })).rejects.toThrow(/^real_check: company minimum cannot be crossed$/);
});
it("the audit row keeps the old chosen value when only the old side was hidden by a bound", async () => {
  const w = world();
  await w.call("PUT", { expectedRevision: 0, overrides: { model_budget_usd: 9 } });
  w.hook({ model_budget_usd: 5 });
  await w.call("PUT", { expectedRevision: 1, overrides: { model_budget_usd: 4 } });
  const audit = w.db.find((row) => row.entityType === "COMPANY_LOG").map((row) => row.changes as unknown[]);
  expect(audit[1]).toContainEqual({ field: "model_budget_usd", before: 5, after: 4, chosenBefore: 9, chosenAfter: 4 });
});
it("a preset change a pinned preset_level override hides is named in the audit event; an ordinary one is not", async () => {
  const w = world();
  await w.call("PUT", { expectedRevision: 0, preset: "careful", overrides: { preset_level: "balanced" } });
  await w.call("PUT", { expectedRevision: 1, preset: "lightweight" });
  await w.call("PUT", { expectedRevision: 2, overrides: {} });
  const events = w.db.find((row) => row.entityType === "COMPANY_LOG").sort((a, b) => Number(a.revision) - Number(b.revision));
  expect(events[0]).not.toHaveProperty("presetBefore");
  expect(events[1]).toMatchObject({ presetBefore: "careful", presetAfter: "lightweight" });
  // Dropping the pin shows the preset in the values themselves, so no extra names.
  expect(events[2]).not.toHaveProperty("presetBefore");
});
it("a clamped preset still needs the fresh step-up first", async () => {
  const w = world(); w.hook({ ci_fix_rounds: 2 }); w.setStepUp(noStepUp());
  await expect(w.call("PUT", { expectedRevision: 0, preset: "careful" })).rejects.toMatchObject({ code: "REAUTH_REQUIRED", message: PAGE_ONLY_WORDS });
  expect(writes(w)).toEqual([]);
});
it("the audit row for a clamped preset records what applies and the person's choice the bound hides", async () => {
  const w = world(); w.hook({ real_check: "their_ci_fix" });
  await w.call("PUT", { expectedRevision: 0, preset: "lightweight" });
  const audit = w.db.find((row) => row.entityType === "COMPANY_LOG");
  expect(audit).toHaveLength(1);
  // real_check still applies as before (their_ci_fix), but the chosen value moved to their_ci_watch: that is on the record.
  expect(audit[0]?.changes).toContainEqual({ field: "real_check", before: "their_ci_fix", after: "their_ci_fix", chosenBefore: "their_ci_fix", chosenAfter: "their_ci_watch" });
  // Where nothing is hidden the row is as before (no chosen values).
  expect(audit[0]?.changes).toContainEqual({ field: "preset_level", before: null, after: "lightweight" });
});
it("a change of preset that a company preset_level minimum fully hides still leaves an audit row naming the new choice", async () => {
  const w = world(); w.hook({ preset_level: "careful" });
  await w.call("PUT", { expectedRevision: 0, preset: "careful" });
  await w.call("PUT", { expectedRevision: 1, preset: "lightweight" });
  const audit = w.db.find((row) => row.entityType === "COMPANY_LOG").map((row) => row.changes);
  expect(audit).toHaveLength(2);
  expect(audit[1]).toContainEqual({ field: "preset_level", before: "careful", after: "careful", chosenBefore: "careful", chosenAfter: "lightweight" });
});

// ---- L2-5 (b): company owners and admins may change the project's per-task spending limit (DEC 254n's rule, as #839's lifecycleAccess); everything else stays with the project's admins. ----
const BUDGET_ONLY = "Company owners and admins can change only this project's per-task spending limit here. Other project settings need one of the project's admins.";
function companyAdminWorld(role: string, extra: Record<string, unknown> = {}) {
  const w = stagingWorld();
  w.db.delete(`MEMBER#${person}`, "PROJECT#web");
  w.db.set({ pk: `COMPANY_MEMBER#${person}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: person, companyId: COMPANY, role, joinedAt: new Date(now).toISOString(), ...extra });
  return w;
}

it.each(["owner", "admin"])("a company %s who is not a project admin changes the per-task limit, with a fresh step-up, and the audit names the basis", async (role) => {
  const w = companyAdminWorld(role);
  expect(await w.call("PUT", { expectedRevision: 0, overrides: { model_budget_usd: 4 } })).toMatchObject({ revision: 1, overrides: { model_budget_usd: 4 } });
  expect(w.db.find((row) => row.entityType === "COMPANY_LOG")).toEqual([expect.objectContaining({ personId: person, basis: `company-${role}`, changes: [expect.objectContaining({ field: "model_budget_usd", after: 4 })] })]);
  // Clearing it is a budget change too.
  expect(await w.call("PUT", { expectedRevision: 1, overrides: {} })).toMatchObject({ revision: 2, overrides: {} });
  w.setStepUp(noStepUp());
  await expect(w.call("PUT", { expectedRevision: 2, overrides: { model_budget_usd: 9 } })).rejects.toMatchObject({ code: "REAUTH_REQUIRED", message: PAGE_ONLY_WORDS });
});

it("a company admin may not change any other setting, not even beside the limit; the stored others may be sent back unchanged", async () => {
  const w = stagingWorld();
  await w.call("PUT", { expectedRevision: 0, preset: "balanced", overrides: { extra_review: true } });
  w.db.delete(`MEMBER#${person}`, "PROJECT#web");
  w.db.set({ pk: `COMPANY_MEMBER#${person}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: person, companyId: COMPANY, role: "admin", joinedAt: new Date(now).toISOString() });
  for (const body of [{ expectedRevision: 1, preset: "careful" }, { expectedRevision: 1, overrides: { extra_review: false, model_budget_usd: 2 } }, { expectedRevision: 1, overrides: { model_budget_usd: 2 } },
    { expectedRevision: 1, overrides: { extra_review: true, ci_fix_rounds: 1, model_budget_usd: 2 } }]) {
    await expect(w.call("PUT", body)).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403, message: BUDGET_ONLY });
  }
  expect(w.db.find((row) => row.entityType === "COMPANY_LOG")).toHaveLength(1);
  expect(await w.call("PUT", { expectedRevision: 1, preset: "balanced", overrides: { extra_review: true, model_budget_usd: 2 } })).toMatchObject({ revision: 2, preset: "balanced", overrides: { extra_review: true, model_budget_usd: 2 } });
});

it.each([
  ["a plain member", "member", {}],
  ["a revoked admin", "admin", { revokedAt: new Date(now).toISOString() }],
  ["an admin of another company", "admin", { companyId: B }],
  ["an unknown role", "auditor", {}],
  ["a membership row naming another person", "admin", { personId: "e".repeat(64) }],
])("%s with no project grant is refused before the body is read", async (_label, role, extra) => {
  const w = companyAdminWorld(role, extra);
  await expect(w.call("PUT", { expectedRevision: 0, overrides: { model_budget_usd: 4 } })).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403, message: "project administrator required" });
  w.send.mockClear();
  await expect(w.call("PUT", "not json")).rejects.toMatchObject({ code: "FORBIDDEN", message: "project administrator required" });
  expect(reads(w).some((input) => input.includes("PROJECT_SETTINGS"))).toBe(false);
});

it("a company admin of B never changes A's project limit (the same not found)", async () => {
  const w = companyAdminWorld("admin");
  w.setCompany(B);
  w.db.set({ pk: `COMPANY_MEMBER#${person}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: person, companyId: B, role: "admin", joinedAt: new Date(now).toISOString() });
  await expect(w.call("PUT", { expectedRevision: 0, overrides: { model_budget_usd: 4 } })).rejects.toMatchObject({ code: "NOT_FOUND", message: "project not found" });
  expect(w.db.find((row) => row.entityType === "PROJECT_SETTINGS")).toEqual([]);
});

it("a project admin's change is unchanged: any setting, and no basis on the audit row", async () => {
  const w = stagingWorld();
  await w.call("PUT", { expectedRevision: 0, preset: "careful", overrides: { extra_review: true } });
  expect(w.db.find((row) => row.entityType === "COMPANY_LOG")[0]).not.toHaveProperty("basis");
});
