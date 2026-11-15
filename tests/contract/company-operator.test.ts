import { afterEach, expect, it, vi } from "vitest";
import { IMPLICIT_COMPANY_ID, companyScoped } from "@agentx/contracts";
import { CompanySignInStore } from "../../packages/broker/src/developer/company-membership.js";
import { companyOperator } from "../../packages/broker/src/developer/company-operator.js";
import { companyMembershipFromDynamo, resolveCompany } from "../../packages/broker/src/aws/company-check.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { loadCompanySources } from "../support/company-inventory-scan.js";
import { companyPreapprovalsThroughLambda } from "../../packages/broker/src/aws/developer-routes.js";
import { resolve } from "node:path";
import type * as DynamoModule from "@aws-sdk/lib-dynamodb";
import type * as SecretsModule from "@aws-sdk/client-secrets-manager";

const wiring = vi.hoisted<{ db: unknown; secrets: unknown[] }>(() => ({ db: undefined, secrets: [] }));
vi.mock("@aws-sdk/lib-dynamodb", async (original) => ({ ...await original<typeof DynamoModule>(), DynamoDBDocumentClient: { from: () => wiring.db } }));
vi.mock("@aws-sdk/client-secrets-manager", async (original) => ({
  ...await original<typeof SecretsModule>(),
  SecretsManagerClient: class { async send(command: unknown) { wiring.secrets.push(command); return { SecretString: JSON.stringify({ clientSecret: ["fake", "secret"].join("-") }) }; } },
}));
afterEach(() => vi.unstubAllEnvs());

const at = Date.parse("2026-11-15T00:00:00Z");
const companyId = "org_" + "a".repeat(20);
const personId = "1".repeat(64);
function world() {
  const db = new FakeDynamoDb();
  let time = at;
  const store = new CompanySignInStore({ documentClient: db, tableName: "signin", now: () => time });
  const logs: Record<string, unknown>[] = [];
  const invoke = (event: unknown) => companyOperator({ store, now: () => time, log: (entry) => logs.push(entry), newCompanyId: () => companyId }, event);
  return { db, store, logs, invoke, tick: (ms: number) => { time += ms; } };
}
const create = { kind: "company-create", name: "Company", firstAdminEmail: "First@Example.test", expiresInHours: 24 };

it("creates once, records only the email hash, and refuses a generated-id collision atomically", async () => {
  const h = world();
  expect(await h.invoke(create)).toEqual({ ok: true, companyId });
  const before = [...h.db.items.values()];
  expect(await h.invoke({ ...create, name: "Replacement", firstAdminEmail: "other@example.test" })).toEqual({ ok: false, error: "unavailable" });
  expect([...h.db.items.values()]).toEqual(before);
  expect(JSON.stringify(before)).not.toContain(create.firstAdminEmail);
  expect(h.db.find((row) => row.entityType === "COMPANY_PREAPPROVAL")).toEqual([expect.objectContaining({ role: "admin", status: "live" })]);
  expect(h.db.refusals).toEqual([]);
});

it("preapproves, lists and withdraws; expires on read, not merely on DynamoDB TTL", async () => {
  const h = world(); await h.invoke(create);
  expect(await h.invoke({ kind: "company-preapprove", companyId, email: " Member@Example.test ", role: "member", expiresInHours: 1 })).toEqual({ ok: true });
  expect(await h.invoke({ kind: "company-preapprovals-list", companyId })).toMatchObject({ ok: true, more: false, preapprovals: expect.any(Array) as unknown });
  expect(await h.invoke({ kind: "company-preapproval-withdraw", companyId, email: "member@example.test" })).toEqual({ ok: true });
  expect(await h.store.join({ personId, companyId, email: "member@example.test" })).toEqual({ ok: false, reason: "not_invited" });
  h.tick(24 * 3600_000);
  expect(await h.store.join({ personId, companyId, email: create.firstAdminEmail })).toEqual({ ok: false, reason: "not_invited" });
  expect(h.db.refusals).toEqual([]);
});

it.each([undefined, 0, 721, -1, 1.5, "24", Infinity])("refuses invalid required expiry %s with fixed words and no log", async (expiresInHours) => {
  const h = world();
  expect(await h.invoke({ ...create, expiresInHours })).toEqual({ ok: false, error: "invalid_request" });
  expect(h.db.items.size).toBe(0); expect(h.logs).toEqual([]);
});

it("repreapproval refuses a malformed prior row instead of classifying it as replaceable", async () => {
  const h = world(); await h.invoke(create);
  const row = h.db.find((item) => item.entityType === "COMPANY_PREAPPROVAL")[0]!;
  h.db.set({ ...row, status: "secret-canary" });
  const before = [...h.db.items.values()];
  expect(await h.invoke({ kind: "company-preapprove", companyId, email: create.firstAdminEmail, role: "member", expiresInHours: 1 })).toEqual({ ok: false, error: "unavailable" });
  expect([...h.db.items.values()]).toEqual(before);
  expect(JSON.stringify(h.logs)).not.toContain("secret-canary");
});

it.each(["used", "withdrawn", "expired"])("repreapproval replaces a valid %s row but never a live approval", async (status) => {
  const h = world(); await h.invoke(create);
  const request = { kind: "company-preapprove", companyId, email: create.firstAdminEmail, role: "member", expiresInHours: 1 };
  expect(await h.invoke(request)).toEqual({ ok: false, error: "unavailable" });
  const row = h.db.find((item) => item.entityType === "COMPANY_PREAPPROVAL")[0]!;
  h.db.set({ ...row, ...(status === "expired" ? { expiresAt: at / 1000 } : { status }) });
  expect(await h.invoke(request)).toEqual({ ok: true });
  expect(await h.store.join({ personId, companyId, email: create.firstAdminEmail })).toMatchObject({ ok: true, membership: { role: "member" } });
});

it("revokes and restores through the one R4 reader; revocation blocks joining anywhere", async () => {
  const h = world(); await h.invoke(create);
  expect(await h.store.join({ personId, companyId, email: create.firstAdminEmail })).toMatchObject({ ok: true, membership: { role: "admin", joinedVia: "preapproval" } });
  const reader = companyMembershipFromDynamo(h.db, "signin");
  expect(await reader.companyOf(personId)).toBe(companyId);
  expect(await h.invoke({ kind: "company-member-revoke", companyId, personId })).toEqual({ ok: true });
  expect(await reader.companyOf(personId)).toBeUndefined();
  await expect(resolveCompany(reader, personId)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  expect(await h.store.join({ personId, companyId: IMPLICIT_COMPANY_ID, email: create.firstAdminEmail })).toEqual({ ok: false, reason: "member_revoked" });
  expect(await h.invoke({ kind: "company-member-restore", companyId, personId })).toEqual({ ok: true });
  expect(await reader.companyOf(personId)).toBe(companyId);
});

it.each([{ entityType: "OTHER" }, { personId: "2".repeat(64) }, { companyId: "wrong" }, { revokedAt: 1 }])("malformed membership is unreadable, never legacy: %s", async (damage) => {
  const h = world();
  h.db.set({ pk: `COMPANY_MEMBER#${personId}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId, companyId, role: "member", joinedAt: new Date(at).toISOString(), ...damage });
  expect(await companyMembershipFromDynamo(h.db, "signin").companyOf(personId)).toBeUndefined();
  expect(await h.store.join({ personId, companyId: IMPLICIT_COMPANY_ID })).toEqual({ ok: false, reason: "not_invited" });
});

const operatorKinds = ["company-create", "company-preapprove", "company-preapproval-withdraw", "company-preapprovals-list", "company-member-revoke", "company-member-restore", "company-member-role-set", "company-member-list", "company-issuer-set", "company-signin-client-set"];
const operatorOwners = new Set([
  "packages/broker/src/developer/server.ts", "packages/broker/src/developer/company-operator.ts",
  "packages/broker/src/developer/company-membership.ts", "packages/broker/src/developer/company-issuer.ts",
  "packages/broker/src/aws/developer-identity.ts",
]);
// ANSWER-2: company-member-boundary.test.ts adds the all-source AST/provenance ratchet,
// including these identity owners; this original operator-only check remains in force.
it("only the strict member helper constructs member kinds; broker sources never import operator dispatch", () => {
  const sources = loadCompanySources(resolve("."));
  const schema = sources.find((source) => source.path === "packages/broker/src/developer/company-operator.ts")!.text;
  expect([...schema.matchAll(/kind: z\.literal\("(company-[a-z-]+)"\)/g)].map((match) => match[1]).sort()).toEqual([...operatorKinds].sort());
  // All broker directories, with exact owner exceptions (no company-*.ts wildcard).
  for (const source of sources.filter((entry) => entry.path.startsWith("packages/broker/src/") && !operatorOwners.has(entry.path))) {
    expect(source.text, source.path).not.toContain("company-operator");
    const allowed = source.path === "packages/broker/src/aws/developer-routes.ts" ? ["company-preapprove", "company-preapproval-withdraw"] : source.path === "packages/broker/src/aws/company-member-forwarding.ts" ? ["company-member-revoke", "company-member-role-set", "company-member-list"] : [];
    for (const kind of operatorKinds.filter((kind) => !allowed.includes(kind))) {
      expect(source.text, source.path).not.toMatch(new RegExp(`["'\x60]${kind}["'\x60]`));
    }
  }
});

it("broker forwarding refuses every operator kind and admin preapprovals", async () => {
  const invoke = vi.fn(async () => ({ Payload: Buffer.from(JSON.stringify({ ok: true })) }));
  const forward = companyPreapprovalsThroughLambda(invoke);
  const member = { kind: "company-preapprove" as const, companyId, email: "person@example.test", role: "member" as const, expiresInHours: 24, createdBy: personId };
  expect(await forward(member)).toBe(true); expect(invoke).toHaveBeenCalledTimes(1); invoke.mockClear();
  for (const kind of operatorKinds) {
    expect(await forward({ ...member, kind, role: "admin" } as never)).toBe(false);
  }
  expect(invoke).not.toHaveBeenCalled();
});

it("a new company has no issuer until an operator enables one; settings contain no secret", async () => {
  const h = world(); await h.invoke(create);
  expect(h.db.get(companyScoped(companyId, "SIGNIN_ISSUER"), "OIDC")).toBeUndefined();
  const event = { kind: "company-issuer-set", companyId, issuer: "https://identity.example.test", clientId: "company-client", displayName: "Company", requiredValues: [], enabled: true };
  expect(await h.invoke({ ...event, secretName: "another-company-secret" })).toEqual({ ok: false, error: "invalid_request" });
  expect(await h.invoke(event)).toEqual({ ok: true });
  expect(h.db.get(companyScoped(companyId, "SIGNIN_ISSUER"), "OIDC")).toMatchObject({ enabled: true, enabledSince: at / 1000 });
  expect(JSON.stringify(h.logs)).not.toMatch(/another-company-secret|identity.example.test/);
});

it.each([{ entityType: "secret-canary" }, { status: "secret-canary" }, { companyId: IMPLICIT_COMPANY_ID }, { name: 1 }])("malformed company metadata cannot admit a preapproval or join: %s", async (damage) => {
  const h = world(); await h.invoke(create);
  const pk = companyScoped(companyId, "COMPANY");
  h.db.set({ ...h.db.get(pk, "META")!, ...damage });
  const before = [...h.db.items.values()];
  expect(await h.invoke({ kind: "company-preapprove", companyId, email: "next@example.test", role: "member", expiresInHours: 1 })).toEqual({ ok: false, error: "unavailable" });
  expect(await h.store.join({ personId, companyId, email: create.firstAdminEmail })).toEqual({ ok: false, reason: "not_invited" });
  expect([...h.db.items.values()]).toEqual(before);
  expect(JSON.stringify(h.logs)).not.toContain("secret-canary");
});

it("refuses an oversized individual item before parsing or writing", async () => {
  const h = world(); await h.invoke(create);
  const pk = companyScoped(companyId, "COMPANY");
  h.db.set({ ...h.db.get(pk, "META")!, extra: "secret-canary".repeat(40_000) });
  expect(await h.invoke({ kind: "company-preapprove", companyId, email: "next@example.test", role: "member", expiresInHours: 1 })).toEqual({ ok: false, error: "unavailable" });
  expect(JSON.stringify(h.logs)).not.toContain("secret-canary");
});

it("issuer required values need a claim; a refused replacement preserves the prior settings", async () => {
  const h = world(); await h.invoke(create);
  const event = { kind: "company-issuer-set", companyId, issuer: "https://identity.example.test", clientId: "company-client", displayName: "Company", requiredValues: ["staff"], enabled: true };
  expect(await h.invoke({ ...event, requiredClaim: "groups" })).toEqual({ ok: true });
  const before = [...h.db.items.values()];
  expect(await h.invoke(event)).toEqual({ ok: false, error: "unavailable" });
  expect([...h.db.items.values()]).toEqual(before);
});

it.each([undefined, "disabled", "unknown", "enabled"])("Lambda switch is strictly opt-in: %s", async (flag) => {
  vi.resetModules(); wiring.db = new FakeDynamoDb(); wiring.secrets.length = 0;
  for (const [key, value] of Object.entries({ AGENTX_ENV: "test", AWS_REGION: "us-east-1", DEVELOPER_TOKEN_ISSUER: "https://signin.example.test/v1/auth", DEVELOPER_SIGNIN_TABLE_NAME: "signin", DEVELOPER_TOKEN_KEY_ARN: "test-key", SLACK_SECRET_ARN: "test-slack", TASK_TOKEN_KEY_ARN: "", DEVELOPER_OIDC_ISSUER: "" })) vi.stubEnv(key, value);
  vi.stubEnv("COMPANY_SIGNIN", flag);
  const { handler } = await import("../../packages/broker/src/aws/developer-identity.js");
  const answer = await handler(create as never);
  expect(answer).toMatchObject(flag === "enabled" ? { ok: true, companyId: expect.stringMatching(/^org_[a-z0-9]{20}$/) as unknown } : { ok: false, error: "invalid_request" });
  expect(wiring.secrets).toEqual([]);
});

it("the Lambda's company secret cache admits fifty companies and evicts the oldest", async () => {
  wiring.secrets.length = 0;
  const { companySecretReader } = await import("../../packages/broker/src/aws/developer-identity.js");
  const { SecretsManagerClient } = await import("@aws-sdk/client-secrets-manager");
  const read = companySecretReader(new SecretsManagerClient({ region: "us-east-1" }));
  const first = `agentx/test/org-signin/${companyId}/oidc`;
  await read(first); await read(first);
  expect(wiring.secrets).toHaveLength(1);
  for (let i = 0; i < 50; i++) await read(`agentx/test/org-signin/org_${i.toString(36).padStart(20, "0")}/oidc`);
  expect(wiring.secrets).toHaveLength(51);
  await read(first); expect(wiring.secrets).toHaveLength(52);
});

it("refuses list access denial without leaking its cause", async () => {
  const h = world(); await h.invoke(create);
  h.db.injectFault({ command: "QueryCommand", error: { name: "AccessDeniedException", message: "email secret hash canary" } });
  expect(await h.invoke({ kind: "company-preapprovals-list", companyId })).toEqual({ ok: false, error: "unavailable" });
  expect(JSON.stringify(h.logs)).not.toContain("canary");
});

it("bounds a list to 100 items and explicitly reports continuation", async () => {
  const h = world(); await h.invoke(create);
  for (let i = 0; i < 101; i++) h.db.set({ pk: companyScoped(companyId, "PREAPPROVAL"), sk: `EMAIL#${i.toString(16).padStart(64, "0")}`, entityType: "COMPANY_PREAPPROVAL", role: "member", status: "live", expiresAt: at / 1000 + 3600, createdAt: new Date(at).toISOString(), createdBy: "operator" });
  const answer = await h.invoke({ kind: "company-preapprovals-list", companyId });
  expect(answer).toMatchObject({ ok: true, more: true, preapprovals: expect.any(Array) as unknown });
  expect((answer as { preapprovals: unknown[] }).preapprovals).toHaveLength(100);
});

it("refuses an entire list containing an unreadable row, with no partial rows or echoed fields", async () => {
  const h = world(); await h.invoke(create);
  const row = h.db.find((item) => item.entityType === "COMPANY_PREAPPROVAL")[0]!;
  h.db.set({ ...row, sk: `EMAIL#${"f".repeat(64)}`, role: "secret-canary" });
  expect(await h.invoke({ kind: "company-preapprovals-list", companyId })).toEqual({ ok: false, error: "unavailable" });
  expect(JSON.stringify(h.logs)).not.toContain("secret-canary");
});

it("a megabyte input is refused under the existing test timeout, before any storage call", async () => {
  const h = world();
  expect(await h.invoke({ ...create, firstAdminEmail: "a".repeat(1_000_000) + "@example.test" })).toEqual({ ok: false, error: "invalid_request" });
  expect(h.db.commandNames()).toEqual([]); expect(h.logs).toEqual([]);
});

it("the total list time budget refuses the whole result", async () => {
  const h = world(); await h.invoke(create);
  const send = h.db.send;
  h.db.send = async (command) => { const result = await send(command); h.tick(10_001); return result; };
  expect(await h.invoke({ kind: "company-preapprovals-list", companyId })).toEqual({ ok: false, error: "unavailable" });
});

it("the total list byte budget refuses all rows, even when every row individually fits", async () => {
  const h = world(); await h.invoke(create);
  const row = h.db.find((item) => item.entityType === "COMPANY_PREAPPROVAL")[0]!;
  const send = h.db.send;
  h.db.send = async (command) => {
    if ((command as { constructor: { name: string } }).constructor.name === "QueryCommand") {
      return { Items: Array.from({ length: 4 }, (_, i) => ({ ...row, sk: `EMAIL#${String(i).repeat(64)}`, extra: "x".repeat(300_000) })) };
    }
    return send(command);
  };
  expect(await h.invoke({ kind: "company-preapprovals-list", companyId })).toEqual({ ok: false, error: "unavailable" });
});
