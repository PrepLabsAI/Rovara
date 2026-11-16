import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { resolvePolicy, companyScoped, AgentXError, POLICY_FIELDS, POLICY_FIELD_SURFACES, policyFieldPageOnly } from "@agentx/contracts";
import { routeDeveloperRequest, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { createProjectSettingsPolicySource } from "../../packages/broker/src/aws/project-settings.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { COMPANY, ISSUER, fakeService, makeKey, settingsFor, signerOf } from "../unit/policy-hook-fixture.js";

const B = "org_bbbbbbbbbbbbbbbbbbbb";
const now = 1_800_000_000_000;
const person = "d".repeat(64);
const path = "/v1/dev/projects/web/settings";
const install = makeKey("install"); const hookKey = makeKey("hook");
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
  const project = (cid: string) => db.set({ pk: "PROJECT#web", sk: "REV#000000000001", companyId: cid, entityType: "PROJECT", definition: { name: "web", revision: 1 } });
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
  for (const command of ["QueryCommand", "GetCommand"]) {
    const w = world();
    w.db.injectFault({ command, ...(command === "GetCommand" ? { match: (input) => JSON.stringify(input).includes("MEMBER#") } : {}), error: { name: "InternalServerError", message: "private-canary" } });
    await expect(w.call("PUT", { expectedRevision: 0, preset: "balanced" })).rejects.toThrow(/^settings unavailable$/);
  }
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

// ---- M4a slice 2: a cost or approval setting is changed on the page, right after a fresh step-up (DEC 236j; the brief's page-only rule) ----
const PAGE_ONLY_WORDS = "Cost and approval settings are changed on the project's settings page, right after you confirm it's you on the sign-in page: a tool that holds an API token cannot change them. Confirm it's you, then try again within a few minutes.";
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
it("the company's step-up window may only shorten the default, and an unreadable window refuses", async () => {
  const w = world(); w.setStepUp({ step_up_at: now / 1000 - 120, step_up_amr: "email_code" });
  const window = vi.fn(async (_company: string): Promise<unknown> => 60);
  w.deps.developer.stepUpWindowSeconds = window;
  await expect(w.call("PUT", { expectedRevision: 0, overrides: { model_budget_usd: 3 } })).rejects.toMatchObject({ code: "REAUTH_REQUIRED", message: PAGE_ONLY_WORDS });
  expect(window).toHaveBeenCalledWith(COMPANY);
  window.mockResolvedValue(3600);
  await expect(w.call("PUT", { expectedRevision: 0, overrides: { model_budget_usd: 3 } })).resolves.toMatchObject({ revision: 1 });
  for (const answer of ["private-canary", -1, 86_401, 1.5, undefined]) {
    window.mockResolvedValue(answer);
    await expect(w.call("PUT", { expectedRevision: 1, overrides: { model_budget_usd: 4 } })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: expect.not.stringContaining("private-canary") });
  }
  window.mockRejectedValue(new Error("private-canary"));
  await expect(w.call("PUT", { expectedRevision: 1, overrides: { model_budget_usd: 4 } })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: expect.not.stringContaining("private-canary") });
  expect(await w.call()).toMatchObject({ revision: 1 });
});
it("a change that needs no step-up never asks the company's window", async () => {
  const w = world(); w.setStepUp(noStepUp());
  const window = vi.fn(async (_company: string): Promise<unknown> => { throw new Error("must not be asked"); });
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
