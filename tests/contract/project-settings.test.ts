import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { AgentXError, ON_THE_WEBSITE_MESSAGE, POLICY_FIELDS, POLICY_FIELD_SURFACES, policyFieldPageOnly, IMPLICIT_COMPANY_ID, orgProjectCatalogKey, orgSettingsKey, projectRevisionKey } from "@agentx/contracts";
import { routeDeveloperRequest, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { createProjectSettingsPolicySource } from "../../packages/broker/src/aws/project-settings.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { COMPANY, ISSUER, fakeService, makeKey, settingsFor, signerOf } from "../unit/policy-hook-fixture.js";

const B = "org_bbbbbbbbbbbbbbbbbbbb";
const now = 1_800_000_000_000;
const person = "d".repeat(64);
const path = "/v1/dev/projects/web/settings";
const install = makeKey("install"); const hookKey = makeKey("hook");
/** DEC 254zzz80: where a person's grants live for this company. */
const grantPk = (companyId: string) => companyId === IMPLICIT_COMPANY_ID ? `MEMBER#${person}` : `ORG#${companyId}#MEMBER#${person}`;
/** The switch-over layout (staging 2026-11-17): the company's own catalog pointer and selected revision, with NO companyId (the partition key names the company). */
function partitionProject(db: FakeDynamoDb, companyId: string, name = "web", revision = 1, extra: Record<string, unknown> = {}) {
  db.set({ ...projectRevisionKey(companyId, name, revision), entityType: "PROJECT", definition: { name, revision } });
  db.set({ ...orgProjectCatalogKey(companyId, name), entityType: "PROJECT_CATALOG", name, latestRevision: revision, ...extra });
}
function world(options: { webApp?: boolean } = {}) {
  const db = new FakeDynamoDb();
  // Owner DEC 254zzz91: by default the caller is the Rovara website's own client (the operator-marked full-access web app); `webApp: false` is the Rovara CLI's own token.
  const web = options.webApp !== false;
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const webBearer = `Bearer ${part({ alg: "none" })}.${part({ azp: "web-app" })}.sig`;
  let company: string | undefined = COMPANY;
  // Extra claims on the verified access token (DEC 254zzz73: a leftover step-up claim is ignored). None by default.
  let extraClaims: Record<string, unknown> = {};
  const companies = { companyOf: vi.fn(async () => company) };
  const deps: DeveloperRouteDependencies = { documentClient: db, tableName: "state", companies, now: () => now,
    developer: { issuer: ISSUER, env: "test", methods: { slack: true, oidc: false }, signInTableName: "signin", channelMembers: async () => ({ ok: false, error: "slack_unavailable" }),
      verifyAccessToken: async () => ({ iss: ISSUER, aud: "agentx-developer", sub: person, amr: "slack", env: "test", sid: "session", iat: now / 1000, exp: now / 1000 + 3600, companyId: COMPANY, ...(web ? { azp: "web-app" } : {}), ...extraClaims }) } };
  db.set({ pk: "SESSION#session", sk: "META", sessionId: "session", developerId: person, amr: "slack", startedAt: new Date(now).toISOString(), endsAt: now / 1000 + 3600, ...(web ? { clientId: "web-app" } : {}) });
  if (web) db.set({ pk: "SIGNIN_CLIENTS", sk: "CLIENT#web-app", entityType: "SIGN_IN_CLIENT", clientId: "web-app", name: "Web App", audience: "web-app", redirectUris: ["https://cloud.example.com/callback"], loopback: false, installLevel: true, secretHash: "f".repeat(64), fullAccess: true, webApp: true, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), updatedBy: "admin" });
  db.set({ pk: `DEVELOPER#${person}`, sk: "META", displayName: "Test", revoked: false });
  // A project in BOTH layouts: the legacy shared row (read only by the implicit company's unmarked path) and the company partition rows, without companyId as the switch-over left them.
  const project = (cid: string) => {
    db.set({ pk: "PROJECT#web", sk: "REV#000000000001", companyId: cid, entityType: "PROJECT", definition: { name: "web", revision: 1 } });
    partitionProject(db, cid);
  };
  // DEC 254zzz80: a named company's grant lives in its own partition (the implicit company's in the legacy row); `stamp` names a company on the row itself (drift when it differs).
  const role = (value = "administrator", cid = COMPANY, stamp = cid) => db.set({ pk: grantPk(cid), sk: "PROJECT#web", companyId: stamp, projectName: "web", role: value });
  project(COMPANY); role();
  const send = vi.spyOn(db, "send");
  const call = (method = "GET", body?: unknown, query = "", headers: Record<string, string> = {}) => routeDeveloperRequest(deps, { method, path, headers: { authorization: web ? webBearer : "Bearer fixture", "x-company-id": COMPANY, ...headers }, requestId: "test", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, new URL(path + query, ISSUER)).catch((error: unknown) => {
    if (error instanceof AgentXError) throw Object.assign(new Error(error.message.slice(error.code.length + 2)), { code: error.code, statusCode: error.statusCode });
    throw error;
  });
  const hook = (locks: Record<string, unknown> | Error) => {
    const service = fakeService({ key: hookKey, now: () => now, answer: () => locks instanceof Error ? locks : ({ locks }) });
    deps.developer.policyHook = { settings: settingsFor(hookKey), install: { issuer: ISSUER, signer: signerOf(install) }, fetch: service.fetch };
    return service;
  };
  return { db, deps, send, call, role, project, hook, companies, setCompany: (value: string | undefined) => { company = value; },
    setExtraClaims: (value: Record<string, unknown>) => { extraClaims = value; } };
}
it.each([ "unknown"])("PUT requires this company's project administrator (%s)", async (role) => {
  const w = world(); w.role(role);
  await expect(w.call("PUT", { expectedRevision: 0, preset: "careful" })).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403, message: "project administrator required" });
  // A row in the company's own partition that names another company is not its grant.
  w.role("administrator", COMPANY, B);
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

/** Only the switch-over layout: no shared rows at all, no companyId on any project row, and the grant row in the company's own partition without a company field (DEC 254zzz80). */
function stagingWorld(company = COMPANY) {
  const w = world();
  for (const row of w.db.find((r) => r.pk === "PROJECT#web" || String(r.pk).endsWith(`MEMBER#${person}`) || String(r.pk).includes("PROJECT_CATALOG") || String(r.pk).includes("#PROJECT#"))) w.db.delete(String(row.pk), String(row.sk));
  w.setCompany(company);
  partitionProject(w.db, company);
  w.db.set({ pk: grantPk(company), sk: "PROJECT#web", entityType: "MEMBERSHIP", ownerKey: person, projectName: "web", role: "administrator" });
  return w;
}
const reads = (w: ReturnType<typeof world>) => w.send.mock.calls.map(([c]) => JSON.stringify((c as { input: unknown }).input));

it.each([
  ["a catalog row naming another company", (db: FakeDynamoDb) => partitionProject(db, COMPANY, "web", 1, { companyId: B })],
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
  w.db.set({ pk: `MEMBER#${person}`, sk: "PROJECT#web", companyId: COMPANY, projectName: "web", role: "administrator" });
  await expect(w.call("PUT", { expectedRevision: 2, preset: "lightweight" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  // Marked: only the partition counts, so a shared-only project is not found.
  w.db.set({ ...orgSettingsKey(I, "PROJECT_CATALOG_INDEX"), verifiedAt: new Date(now).toISOString(), count: 1, runId: "run-1" });
  await expect(w.call()).rejects.toMatchObject({ code: "NOT_FOUND", message: "project not found" });
  partitionProject(w.db, I);
  expect(await w.call()).toMatchObject({ revision: 2 });
  w.db.set({ ...orgSettingsKey(I, "PROJECT_CATALOG_INDEX"), verifiedAt: "private-canary" });
  await expect(w.call()).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: "settings unavailable" });
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

// ---- M4a slice 2 as changed by DEC 254zzz73: a cost or approval setting needs no step-up; who may change it is the role rule, and the company is the caller's own ----
const CHANGES: Record<string, unknown> = {
  preset_level: "careful", real_check: "rovara_real_run", ci_fix_rounds: 2, round_time_minutes: 45, model_budget_usd: 7, machine_budget_minutes: 90,
  extra_review: true, mutation_spot_check: "on", prompt_side_by_side: "on", after_merge_revert: "report_only",
};
const writes = (w: ReturnType<typeof world>) => w.db.find((row) => row.entityType === "PROJECT_SETTINGS");

it.each(Object.entries(CHANGES))("DEC 254zzz73: the project's administrator changes %s with no step-up claim", async (field, value) => {
  const w = world();
  expect(await w.call("PUT", { expectedRevision: 0, overrides: { [field]: value } })).toMatchObject({ revision: 1, overrides: { [field]: value } });
});
// Owner DEC 254zzz91: a cost or approval field (and the preset) changes only from the Rovara website's own client; the Rovara CLI's token (or an AI tool holding it) is refused, nothing written.
const PAGE_ONLY = Object.entries(CHANGES).filter(([field]) => field !== "after_merge_revert");
it("owner DEC 254zzz91: classifies every settings field, and a field nobody classified is website-only", () => {
  expect(Object.keys(POLICY_FIELD_SURFACES).sort()).toEqual(POLICY_FIELDS.map((field) => field.id).sort());
  expect(policyFieldPageOnly("brand_new_field")).toBe(true);
  expect(policyFieldPageOnly("__proto__")).toBe(true);
  expect(policyFieldPageOnly("constructor")).toBe(true);
  expect(POLICY_FIELDS.filter((field) => !policyFieldPageOnly(field.id)).map((field) => field.id)).toEqual(["after_merge_revert"]);
});
it.each(PAGE_ONLY)("owner DEC 254zzz91: the project's administrator's CLI token cannot change %s (the website words, nothing written)", async (field, value) => {
  const w = world({ webApp: false });
  await expect(w.call("PUT", { expectedRevision: 0, overrides: { [field]: value } })).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403, message: ON_THE_WEBSITE_MESSAGE });
  expect(writes(w)).toEqual([]);
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

// ---- L2-5 (b): company owners and admins may change the project's per-task spending limit (DEC 254n's rule, as #839's lifecycleAccess); everything else stays with the project's admins. ----
const BUDGET_ONLY = "Company owners and admins can change only this project's per-task spending limit here. Other project settings need one of the project's admins.";
function companyAdminWorld(role: string, extra: Record<string, unknown> = {}) {
  const w = stagingWorld();
  w.db.delete(grantPk(COMPANY), "PROJECT#web");
  w.db.set({ pk: `COMPANY_MEMBER#${person}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: person, companyId: COMPANY, role, joinedAt: new Date(now).toISOString(), ...extra });
  return w;
}

it.each(["owner"])("a company %s who is not a project admin changes the per-task limit (no step-up, DEC 254zzz73), and the audit names the basis", async (role) => {
  const w = companyAdminWorld(role);
  expect(await w.call("PUT", { expectedRevision: 0, overrides: { model_budget_usd: 4 } })).toMatchObject({ revision: 1, overrides: { model_budget_usd: 4 } });
  expect(w.db.find((row) => row.entityType === "COMPANY_LOG")).toEqual([expect.objectContaining({ personId: person, basis: `company-${role}`, changes: [expect.objectContaining({ field: "model_budget_usd", after: 4 })] })]);
  // Clearing it is a budget change too.
  expect(await w.call("PUT", { expectedRevision: 1, overrides: {} })).toMatchObject({ revision: 2, overrides: {} });
  expect(await w.call("PUT", { expectedRevision: 2, overrides: { model_budget_usd: 9 } })).toMatchObject({ revision: 3 });
});

it("a company admin may not change any other setting, not even beside the limit; the stored others may be sent back unchanged", async () => {
  const w = stagingWorld();
  await w.call("PUT", { expectedRevision: 0, preset: "balanced", overrides: { extra_review: true } });
  w.db.delete(grantPk(COMPANY), "PROJECT#web");
  w.db.set({ pk: `COMPANY_MEMBER#${person}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: person, companyId: COMPANY, role: "admin", joinedAt: new Date(now).toISOString() });
  for (const body of [{ expectedRevision: 1, preset: "careful" }, { expectedRevision: 1, overrides: { extra_review: false, model_budget_usd: 2 } }, { expectedRevision: 1, overrides: { model_budget_usd: 2 } },
    { expectedRevision: 1, overrides: { extra_review: true, ci_fix_rounds: 1, model_budget_usd: 2 } }]) {
    await expect(w.call("PUT", body)).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403, message: BUDGET_ONLY });
  }
  expect(w.db.find((row) => row.entityType === "COMPANY_LOG")).toHaveLength(1);
  expect(await w.call("PUT", { expectedRevision: 1, preset: "balanced", overrides: { extra_review: true, model_budget_usd: 2 } })).toMatchObject({ revision: 2, preset: "balanced", overrides: { extra_review: true, model_budget_usd: 2 } });
});

it.each([
  ["an unknown role", "auditor", {}],
])("%s with no project grant is refused before the body is read", async (_label, role, extra) => {
  const w = companyAdminWorld(role, extra);
  await expect(w.call("PUT", { expectedRevision: 0, overrides: { model_budget_usd: 4 } })).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403, message: "project administrator required" });
  w.send.mockClear();
  await expect(w.call("PUT", "not json")).rejects.toMatchObject({ code: "FORBIDDEN", message: "project administrator required" });
  expect(reads(w).some((input) => input.includes("PROJECT_SETTINGS"))).toBe(false);
});

