// tests/contract/admin-actions.test.ts
// Spec 025 E8, E9, E19: the handlers 25e's change tools apply that had no admin command before.
import { describe, expect, it, vi } from "vitest";
import { developerIdForSlackUser, endSessions, grantProjectAccess, projectGrant, resolveDeveloper, revokeProjectAccess, setWorkspaceLimits, type AdminActionDependencies } from "../../packages/broker/src/aws/admin-actions.js";
import { readWorkspaceLimits } from "../../packages/broker/src/developer/limits.js";
import { emailIndexKey } from "../../packages/broker/src/developer/store.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ADMIN = { issuer: "https://identity.example.test", subject: "admin-subject" };
function deps(extra: Partial<AdminActionDependencies> = {}): AdminActionDependencies & { db: FakeDynamoDb } {
  const db = new FakeDynamoDb();
  return { db, documentClient: db, tableName: "state", signInTableName: "signin", slackTeamId: "T0BSHLLUGBD", limitDefaults: { member: 3, organization: 20 }, now: () => Date.parse("2026-10-02T09:00:00.000Z"), ...extra };
}
const NOT_SIGNED_IN = "NOT_FOUND: nobody has signed in to AgentX with that email yet; name them by Slack user ID, or ask them to sign in first";

describe("who a developer is (E8, Q4)", () => {
  it("takes a developer ID, a Slack user and an email that has signed in", async () => {
    const d = deps();
    const slackId = developerIdForSlackUser("U0ADA00001");
    expect(slackId).toMatch(/^[a-f0-9]{64}$/);
    d.db.set({ pk: `DEVELOPER#${slackId}`, sk: "META", developerId: slackId, provider: "slack", displayName: "Ada", email: "ada@example.com", slackUserId: "U0ADA00001", revoked: false });
    d.db.set({ ...emailIndexKey("ada@example.com"), developerId: slackId });
    expect(await resolveDeveloper(d, "U0ADA00001")).toMatchObject({ developerId: slackId, via: "slack", profile: { displayName: "Ada" } });
    expect(await resolveDeveloper(d, "Ada@Example.com")).toMatchObject({ developerId: slackId, via: "email" });
    expect(await resolveDeveloper(d, slackId)).toMatchObject({ developerId: slackId, via: "id" });
  });

  it("lets a Slack user be named before their first sign-in, but not an email", async () => {
    const d = deps();
    expect(await resolveDeveloper(d, "U0NEW00001")).toEqual({ developerId: developerIdForSlackUser("U0NEW00001"), via: "slack", slackUserId: "U0NEW00001" });
    const unknown = await resolveDeveloper(d, "new@example.com").catch((error: unknown) => error);
    expect(unknown).toMatchObject({ code: "NOT_FOUND", message: NOT_SIGNED_IN });
    expect(JSON.stringify(unknown)).not.toContain("new@example.com");
    expect(String((unknown as Error).message)).not.toContain("new@example.com");
    await expect(resolveDeveloper(d, "not a person")).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("does not follow a stale email index entry to someone whose email has since changed", async () => {
    const d = deps();
    const id = developerIdForSlackUser("U0ADA00001");
    // Ada signed in as ada@old.example.com, then her verified email changed; the old entry still points at her.
    d.db.set({ pk: `DEVELOPER#${id}`, sk: "META", provider: "slack", displayName: "Ada", email: " Ada@New.Example.com ", slackUserId: "U0ADA00001", revoked: false });
    d.db.set({ ...emailIndexKey("ada@old.example.com"), developerId: id });
    d.db.set({ ...emailIndexKey("ada@new.example.com"), developerId: id });
    const stale = await resolveDeveloper(d, "ada@old.example.com").catch((error: unknown) => error);
    expect(stale).toMatchObject({ code: "NOT_FOUND", message: NOT_SIGNED_IN });
    expect(String((stale as Error).message)).not.toContain("ada@old.example.com");
    expect(await resolveDeveloper(d, "ADA@new.example.com")).toMatchObject({ developerId: id, via: "email", profile: { displayName: "Ada" } });
    // An index entry whose developer record is gone, or holds no email, names nobody either.
    const ghost = "e".repeat(64);
    d.db.set({ ...emailIndexKey("ghost@example.com"), developerId: ghost });
    await expect(resolveDeveloper(d, "ghost@example.com")).rejects.toMatchObject({ code: "NOT_FOUND", message: NOT_SIGNED_IN });
    d.db.set({ pk: `DEVELOPER#${ghost}`, sk: "META", provider: "oidc", displayName: "Ghost", revoked: false });
    await expect(resolveDeveloper(d, "ghost@example.com")).rejects.toMatchObject({ code: "NOT_FOUND", message: NOT_SIGNED_IN });
  });

  it("names nobody by email where developer sign-in is not set up", async () => {
    const d = deps({ signInTableName: undefined });
    await expect(resolveDeveloper(d, "ada@example.com")).rejects.toMatchObject({ code: "NOT_FOUND", message: NOT_SIGNED_IN });
    expect(await resolveDeveloper(d, "U0ADA00001")).toEqual({ developerId: developerIdForSlackUser("U0ADA00001"), via: "slack", slackUserId: "U0ADA00001" });
  });
});

describe("grants (FR-013.1)", () => {
  it("grants developer access once, keeps an administrator row as it is, and revokes only a developer row", async () => {
    const d = deps();
    const id = developerIdForSlackUser("U0ADA00001");
    expect(await grantProjectAccess(d, ADMIN, "payments", id)).toEqual({ granted: true, already: false });
    expect(d.db.get(`MEMBER#${id}`, "PROJECT#payments")).toMatchObject({ entityType: "MEMBERSHIP", ownerKey: id, projectName: "payments", role: "developer", grantedBy: ADMIN, grantedAt: "2026-10-02T09:00:00.000Z" });
    expect(await grantProjectAccess(d, ADMIN, "payments", id)).toEqual({ granted: true, already: true });
    expect(await projectGrant(d, "payments", id)).toEqual({ role: "developer" });
    expect(await revokeProjectAccess(d, "payments", id)).toEqual({ revoked: true });
    expect(await revokeProjectAccess(d, "payments", id)).toEqual({ revoked: false });
    expect(await projectGrant(d, "payments", id)).toBeUndefined();
    d.db.set({ pk: `MEMBER#${id}`, sk: "PROJECT#ledger", entityType: "MEMBERSHIP", ownerKey: id, projectName: "ledger", role: "administrator" });
    await expect(grantProjectAccess(d, ADMIN, "ledger", id)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await revokeProjectAccess(d, "ledger", id)).toEqual({ revoked: false });
    expect(d.db.get(`MEMBER#${id}`, "PROJECT#ledger")).toMatchObject({ role: "administrator" });
  });
});

describe("the workspace limits setting (E19, FR-053)", () => {
  it("writes the setting the broker already reads, with who and when", async () => {
    const d = deps();
    expect(await setWorkspaceLimits(d, ADMIN, { perPerson: 5, perOrganization: 40 })).toEqual({ perPerson: 5, perOrganization: 40, updatedAt: "2026-10-02T09:00:00.000Z" });
    expect(d.db.get("SETTINGS", "WORKSPACE_LIMITS")).toMatchObject({ perPerson: 5, perOrganization: 40, updatedBy: ADMIN, updatedAt: "2026-10-02T09:00:00.000Z" });
    expect(await readWorkspaceLimits(d.db, "state", d.limitDefaults)).toEqual({ member: 5, organization: 40, source: "setting" });
    await expect(setWorkspaceLimits(d, ADMIN, { perPerson: 30, perOrganization: 20 })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: "CONFIG_INVALID: the per-person limit (30) cannot be more than the organization limit (20)" });
  });

  it("refuses numbers the broker would ignore, and leaves the setting as it was", async () => {
    const d = deps();
    await setWorkspaceLimits(d, ADMIN, { perPerson: 5, perOrganization: 40 });
    for (const limits of [{ perPerson: 0, perOrganization: 20 }, { perPerson: 51, perOrganization: 100 }, { perPerson: 2.5, perOrganization: 20 }, { perPerson: 3, perOrganization: 1_001 }, { perPerson: 3, perOrganization: 0 }]) {
      await expect(setWorkspaceLimits(d, ADMIN, limits)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
    expect(await readWorkspaceLimits(d.db, "state", d.limitDefaults)).toEqual({ member: 5, organization: 40, source: "setting" });
  });
});

describe("ending sessions (E9)", () => {
  it("asks DeveloperIdentity, and says when the developer never signed in or it cannot be reached", async () => {
    const endDeveloperSessions = vi.fn(async () => ({ ok: true as const }));
    expect(await endSessions(deps({ endDeveloperSessions }), "d".repeat(64))).toEqual({ endedAt: "2026-10-02T09:00:00.000Z" });
    expect(endDeveloperSessions).toHaveBeenCalledWith({ kind: "end-developer-sessions", developerId: "d".repeat(64), at: "2026-10-02T09:00:00.000Z" });
    await expect(endSessions(deps({ endDeveloperSessions: async () => ({ ok: false, error: "not_found" }) }), "d".repeat(64))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(endSessions(deps({ endDeveloperSessions: async () => ({ ok: false, error: "unavailable" }) }), "d".repeat(64))).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    await expect(endSessions(deps(), "d".repeat(64))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
