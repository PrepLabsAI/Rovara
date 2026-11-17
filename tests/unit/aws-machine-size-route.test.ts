import { afterEach, describe, expect, it, vi } from "vitest";
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { GetItemCommand, PutItemCommand, QueryCommand as RawQueryCommand } from "@aws-sdk/client-dynamodb";
import { fromWire, fromWireItem, toWireItem } from "@rovara/aws-adapters";
import { signInClientKey, projectPk, TestEnvironmentBodySchema, testEnvDigest, type ClientScope, type StoredDocument } from "@agentx/contracts";
import { companyMembershipFromDynamo } from "../../packages/broker/src/aws/company-check.js";
import { testEnvMachineChoiceKey, testEnvMachineKey } from "../../packages/broker/src/core/test-env/machine-size.js";
import { companyRouteHarness, PERSON, TIME } from "../support/company-route-harness.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb";
const NOW = Date.parse(TIME);
const PAGE = "Changing the machine size needs the Rovara web page with a fresh sign-in";
const ROLE = "Only a company owner or admin, or this project's administrator, may choose a machine size";
const body = TestEnvironmentBodySchema.parse({ tier: "sandbox", repos: [{ repositoryId: "demo", setupCommands: [], checks: [{ id: "unit", label: "Unit", kind: "test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 600 } }] }], roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" }, services: [], data: { seeds: [], generator: "faker_seeded", seed: 7 }, accounts: [], prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false } });
const digest = testEnvDigest(body);
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function world() {
  vi.stubEnv("ROVARA_MACHINE_SIZE", "1");
  vi.stubEnv("ROVARA_TEST_ENVIRONMENT", "1");
  const h = companyRouteHarness();
  // The production port uses native Dynamo commands; translate their wire attributes into the document SDK double.
  h.deps.documentClient = { send: async (command: unknown) => {
    if (command instanceof GetItemCommand) {
      const r = await h.db.send(new GetCommand({ ...command.input, Key: fromWireItem(command.input.Key!) })) as { Item?: StoredDocument };
      return { ...(r.Item === undefined ? {} : { Item: toWireItem(r.Item) }) };
    }
    if (command instanceof PutItemCommand) return h.db.send(new PutCommand({ ...command.input, Item: fromWireItem(command.input.Item!) }));
    if (command instanceof RawQueryCommand) {
      const values = command.input.ExpressionAttributeValues!;
      const r = await h.db.send(new QueryCommand({ TableName: command.input.TableName, ConsistentRead: command.input.ConsistentRead, ScanIndexForward: command.input.ScanIndexForward, Limit: command.input.Limit,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": fromWire(values[":v0"]!), ":prefix": fromWire(values[":v1"]!) } })) as { Items?: StoredDocument[] };
      return { ...r, Items: r.Items?.map(toWireItem) };
    }
    return h.db.send(command as GetCommand);
  } };
  h.deps.companies = companyMembershipFromDynamo(h.db, "SignIn");
  const membership = (companyId = A, role = "admin", revoked = false) => h.db.set({ pk: `COMPANY_MEMBER#${PERSON}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: PERSON, companyId, role, joinedAt: TIME, ...(revoked ? { revokedAt: TIME } : {}) });
  const grant = (role = "developer", companyId: string | undefined = A, project = "pa") => h.db.set({ pk: `MEMBER#${PERSON}`, sk: `PROJECT#${project}`, projectName: project, role, ...(companyId === undefined ? {} : { companyId }) });
  h.project(A, "none", "pa"); h.project(B, "none", "pb"); grant(); grant("developer", B, "pb"); membership();
  const client = (kind: "page" | "tool" | "cli" | "scoped" = "page", scopes: ClientScope[] = ["tasks:read"]) => {
    const id = kind === "cli" ? "agentx-cli" : "cloud-page";
    h.claims["azp"] = id; h.claims["scope"] = scopes.join(" ");
    h.db.set({ pk: "SESSION#session", sk: "META", developerId: PERSON, amr: "slack", ...(kind === "cli" ? {} : { clientId: id }), startedAt: TIME, endsAt: NOW / 1000 + 3600 });
    if (kind !== "cli") h.db.set({ ...signInClientKey(id), entityType: "SIGN_IN_CLIENT", clientId: id, installLevel: true, name: "Cloud", audience: "cloud-app", redirectUris: [], loopback: false, secretHash: "a".repeat(64), createdAt: "2026-01-01T00:00:00.000Z", updatedAt: TIME, updatedBy: "operator", ...(kind === "scoped" ? { scopes } : { fullAccess: true }), ...(kind === "page" ? { webApp: true } : {}) });
    return `Bearer e30.${Buffer.from(JSON.stringify({ azp: id })).toString("base64url")}.sig`;
  };
  let authorization = client();
  h.claims["step_up_at"] = NOW / 1000 - 30; h.claims["step_up_amr"] = "passkey";
  const call = (method = "POST", rowId: unknown = "arm64-4-16", project = "pa") => h.read(`/v1/dev/projects/${project}/machine-size`, { method, headers: { authorization }, body: JSON.stringify(rowId === undefined ? {} : { rowId }) });
  const stored = () => JSON.stringify(h.db.find(() => true));
  const refused = async (code: string, message: string, rowId: unknown = "arm64-4-16", project = "pa", statusCode = 403) => {
    const before = stored(); const r = await call("POST", rowId, project);
    expect(r.statusCode).toBe(statusCode); expect(JSON.parse(r.body)).toMatchObject({ error: { code, message } }); expect(stored()).toBe(before);
  };
  const choice = (orgId: string, rowId: string) => h.db.set({ ...testEnvMachineChoiceKey(orgId, "pa"), orgId, project: "pa", entityType: "TEST_ENV_MACHINE_CHOICE", rowId });
  const measurement = (orgId: string, peak: number, d = digest) => h.db.set({ ...testEnvMachineKey(orgId, "pa", d), entityType: "TEST_ENV_MACHINE_MEASURE", orgId, project: "pa", digest: d, facts: { schemaVersion: 1, proposalDigest: d, chip: "arm64", armVerdict: "arm_ok", peakMemoryMiB: peak, suiteMs: 120000 }, recordedAt: TIME });
  return { ...h, membership, grant, call, refused, choice, measurement, stored, client: (...args: Parameters<typeof client>) => { authorization = client(...args); } };
}

describe("hosted machine-size dispatcher", () => {
  it("reads only A's current proposal facts and choice; B cannot read A's project", async () => {
    const w = world(); w.membership(A, "member");
    w.db.set({ pk: projectPk(A, "pa"), sk: `TESTENV#PROPOSAL#${digest}`, orgId: A, project: "pa", digest, environment: body, proposedAt: TIME });
    w.choice(A, "arm64-2-8"); w.choice(B, "x86_64-8-32"); w.measurement(A, 6144); w.measurement(B, 30000); w.measurement(A, 29000, "f".repeat(64));
    expect(JSON.parse((await w.call("GET")).body)).toMatchObject({ measuredPeakMemoryMiB: 6144, testTimeMs: 120000, currentSize: "arm64-2-8", suggestedSize: "arm64-4-16" });
    w.membership(B, "member"); expect(await w.call("GET")).toMatchObject({ statusCode: 404 });
  });
  it("writes only A's choice and leaves B byte equal", async () => {
    const w = world(); w.choice(B, "x86_64-8-32"); const key = testEnvMachineChoiceKey(B, "pa"); const before = JSON.stringify(w.db.get(key.pk, key.sk));
    const writes: unknown[] = []; w.db.onWrite((change) => writes.push(change.after));
    expect(JSON.parse((await w.call()).body)).toMatchObject({ currentSize: "arm64-4-16" });
    expect(writes).toHaveLength(1); expect(writes[0]).toMatchObject({ ...testEnvMachineChoiceKey(A, "pa"), orgId: A }); expect(JSON.stringify(w.db.get(key.pk, key.sk))).toBe(before);
  });
  it.each(["pb", "missing"])("refuses a foreign or unknown project %s", async (project) => { const w = world(); await w.refused("NOT_FOUND", "project not found", "arm64-4-16", project, 404); });
  it.each([B, "legacy"])("refuses a foreign or legacy administrator grant %s", async (company) => {
    const w = world(); w.membership(A, "member"); w.grant("administrator", company);
    if (company === "legacy") w.db.set({ pk: `MEMBER#${PERSON}`, sk: "PROJECT#pa", projectName: "pa", role: "administrator" });
    await w.refused("FORBIDDEN", ROLE);
  });
  it("refuses a revoked membership", async () => { const w = world(); w.membership(A, "owner", true); const before = w.stored(); expect(await w.call()).toMatchObject({ statusCode: 401 }); expect(w.stored()).toBe(before); });
  it.each(["x86-16-64", "arm64-64-256", "arm64-12-48", "x86_64-64-256", 12, null, "x".repeat(10240)])("refuses invalid size %# with fixed words", async (rowId) => { const w = world(); await w.refused("CONFIG_INVALID", "Choose one of the listed machine sizes", rowId, "pa", 400); });
  it.each(["arm64-16-64", "arm64-32-128", "x86_64-16-64", "x86_64-32-128"])("accepts the big size %s and lists all ten sizes with their cost words", async (rowId) => {
    const w = world(); const r = await w.call("POST", rowId); expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body) as { currentSize: string; choices: Array<{ id: string; costNote?: string }> };
    expect(body.currentSize).toBe(rowId); expect(body.choices).toHaveLength(10); for (const choice of body.choices) expect(typeof choice.costNote).toBe("string");
  });
  it("refuses a missing size", async () => { const w = world(); const before = w.stored(); const r = await w.read("/v1/dev/projects/pa/machine-size", { method: "POST", headers: { authorization: "Bearer e30.eyJhenAiOiJjbG91ZC1wYWdlIn0.sig" }, body: "{}" }); expect(r.statusCode).toBe(400); expect(r.body).toContain("Choose one of the listed machine sizes"); expect(w.stored()).toBe(before); });
  it.each(["tasks:read", "profile:name"] as const)("refuses scoped client %s", async (scope) => { const w = world(); w.client("scoped", [scope]); await w.refused("FORBIDDEN", PAGE); });
  it.each(["tool", "cli"] as const)("refuses non-page client %s", async (kind) => { const w = world(); w.client(kind); await w.refused("FORBIDDEN", PAGE); });
  it.each(["absent", "old", "slack", "google"])("requires a fresh Code factor: %s", async (kind) => { const w = world(); if (kind === "absent") delete w.claims["step_up_at"]; else if (kind === "old") w.claims["step_up_at"] = NOW / 1000 - 660; else w.claims["step_up_amr"] = kind; await w.refused("REAUTH_REQUIRED", PAGE); });
  it("honours a shorter company window", async () => { const w = world(); w.claims["step_up_at"] = NOW / 1000 - 120; w.deps.developer.stepUpWindowSeconds = vi.fn(async (company) => { expect(company).toBe(A); return 60; }); await w.refused("REAUTH_REQUIRED", PAGE); });
  it("preserves a window service failure as 503", async () => { const w = world(); w.deps.developer.stepUpWindowSeconds = async () => { throw new Error("CANARY"); }; await w.refused("RUNTIME_UNAVAILABLE", "The company rules service did not answer, so nothing was done. Try again in a moment.", "arm64-4-16", "pa", 503); });
  it("refuses an ordinary member with developer grant", async () => { const w = world(); w.membership(A, "member"); await w.refused("FORBIDDEN", ROLE); });
  it.each(["owner", "admin", "project"])("allows %s", async (role) => { const w = world(); w.membership(A, role === "project" ? "member" : role); if (role === "project") w.grant("administrator"); const r = await w.call(); expect(r.statusCode).toBe(200); expect(JSON.parse(r.body)).toMatchObject({ currentSize: "arm64-4-16" }); });
  it("rejects a changed live role from another company", async () => { const w = world(); w.deps.companies!.membershipOf = async () => ({ companyId: B, role: "admin" }); await w.refused("FORBIDDEN", ROLE); });
  it.each(["GET", "POST"])("switch off: %s touches no feature state", async (method) => { const w = world(); vi.stubEnv("ROVARA_MACHINE_SIZE", "0"); const before = w.stored(); const send = vi.spyOn(w.deps.documentClient, "send"); const r = await w.call(method); expect(r.statusCode).toBe(404); expect(r.body).toContain("NOT_AVAILABLE_HERE"); expect(send.mock.calls.some(([c]) => /TESTENV|PROJECT#/.test(JSON.stringify(c)))).toBe(false); expect(w.stored()).toBe(before); });
  it("wraps an unexpected storage error in fixed words", async () => { const w = world(); const original = w.deps.documentClient.send.bind(w.deps.documentClient); w.deps.documentClient = { send: async (command) => { if (command instanceof PutItemCommand) throw new Error("CANARY"); return original(command); } }; const r = await w.call(); expect(r.statusCode).toBe(503); expect(r.body).not.toContain("CANARY"); });
  it("requires tasks:read for GET", async () => { const w = world(); w.client("scoped", ["profile:name"]); expect(await w.call("GET")).toMatchObject({ statusCode: 403 }); });
});
