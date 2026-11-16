import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { resolvePolicy, companyScoped, AgentXError } from "@agentx/contracts";
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
  const companies = { companyOf: vi.fn(async () => company) };
  const deps: DeveloperRouteDependencies = { documentClient: db, tableName: "state", companies, now: () => now,
    developer: { issuer: ISSUER, env: "test", methods: { slack: true, oidc: false }, signInTableName: "signin", channelMembers: async () => ({ ok: false, error: "slack_unavailable" }),
      verifyAccessToken: async () => ({ iss: ISSUER, aud: "agentx-developer", sub: person, amr: "slack", env: "test", sid: "session", iat: now / 1000, exp: now / 1000 + 3600, companyId: COMPANY }) } };
  db.set({ pk: "SESSION#session", sk: "META", sessionId: "session", developerId: person, amr: "slack", startedAt: new Date(now).toISOString(), endsAt: now / 1000 + 3600 });
  db.set({ pk: `DEVELOPER#${person}`, sk: "META", displayName: "Test", revoked: false });
  const project = (cid: string) => db.set({ pk: "PROJECT#web", sk: "REV#000000000001", companyId: cid, entityType: "PROJECT", definition: { name: "web", revision: 1 } });
  const role = (value = "administrator", cid = COMPANY) => db.set({ pk: `MEMBER#${person}`, sk: "PROJECT#web", companyId: cid, projectName: "web", role: value });
  project(COMPANY); role();
  const send = vi.spyOn(db, "send");
  const call = (method = "GET", body?: unknown, query = "") => routeDeveloperRequest(deps, { method, path, headers: { authorization: "Bearer fixture", "x-company-id": COMPANY }, requestId: "test", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, new URL(path + query, ISSUER)).catch((error: unknown) => {
    if (error instanceof AgentXError) throw Object.assign(new Error(error.message.slice(error.code.length + 2)), { code: error.code, statusCode: error.statusCode });
    throw error;
  });
  const hook = (locks: Record<string, unknown> | Error) => {
    const service = fakeService({ key: hookKey, now: () => now, answer: () => locks instanceof Error ? locks : ({ locks }) });
    deps.developer.policyHook = { settings: settingsFor(hookKey), install: { issuer: ISSUER, signer: signerOf(install) }, fetch: service.fetch };
    return service;
  };
  return { db, deps, send, call, role, project, hook, companies, setCompany: (value: string | undefined) => { company = value; } };
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

it("uses the hosted JWKS path for the developer API's hook settings and refuses a failed JWKS", async () => {
  const { policyHookKeyThumbprint } = await import("@agentx/contracts");
  const w = world();
  const service = fakeService({ key: hookKey, now: () => now, answer: () => ({ locks: { ci_fix_rounds: 1 } }) });
  const settings = { address: settingsFor(hookKey).address, jwks: "https://rules.example/keys", thumbprints: [policyHookKeyThumbprint(hookKey.jwk)] };
  const fetched: string[] = [];
  w.deps.developer.policyHook = { settings, install: { issuer: ISSUER, signer: signerOf(install) }, fetch: async (url, init) => {
    fetched.push(String(url));
    return String(url) === settings.jwks ? Response.json({ keys: [hookKey.jwk] }) : service.fetch(url, init);
  } };
  expect(await w.call()).toMatchObject({ values: { ci_fix_rounds: { value: 1 } } });
  expect(fetched).toEqual([settings.jwks, settings.address]);
  w.deps.developer.policyHook.fetch = async () => new Response("", { status: 503 });
  await expect(w.call()).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
});
