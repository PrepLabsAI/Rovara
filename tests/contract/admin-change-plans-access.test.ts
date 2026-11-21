import { describe, expect, it, vi } from "vitest";
import { planChange, stateHash, type PlanDependencies } from "../../packages/broker/src/aws/admin-change-plans.js";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { createAdminReadBroker } from "../support/admin-read-broker.js";
import { MAYA } from "../support/developer-task-broker.js";

const admin = { issuer: "https://identity.example.test", subject: "admin-subject", ownerKey: "", isAdministrator: true, claims: {} };
async function harness() {
  const endDeveloperSessions = vi.fn(async () => ({ ok: true as const }));
  const broker = await createAdminReadBroker({ developerExtra: { endDeveloperSessions } });
  const module = await import("../../packages/broker/src/aws/broker.js") as unknown as { createPlanDependencies(input: never): PlanDependencies };
  const deps = module.createPlanDependencies(broker.brokerInput as never);
  const membership = broker.db.find((item) => item.entityType === "MEMBERSHIP" && item.role === "administrator")[0]!;
  return { ...broker, deps, endDeveloperSessions, membership, identity: { ...admin, ownerKey: String(membership.ownerKey) } };
}


describe("project access (E7, E8, FR-013.1)", () => {

  it("applies the grant once, rechecking administration at apply, and moves the hash when the developer signs in", async () => {
    const { deps, identity, db, membership } = await harness();
    const developerId = developerIdForSlackUser("U0NEW00001");
    const plan = await planChange(deps, identity, { kind: "grant_project_access", project: "payments", developer: "U0NEW00001" });
    expect(db.get(`MEMBER#${developerId}`, "PROJECT#payments")).toBeUndefined();
    db.set({ pk: `DEVELOPER#${developerId}`, sk: "META", developerId, provider: "slack", displayName: "Nia Park", slackUserId: "U0NEW00001" });
    const signedIn = await planChange(deps, identity, { kind: "grant_project_access", project: "payments", developer: "U0NEW00001" });
    expect(signedIn.effect).toBe("Grant Nia Park (signs in with Slack) access to project payments. They have no grant today. They can then hand tasks to payments from their AI tool.");
    expect(stateHash(signedIn.snapshot)).not.toBe(stateHash(plan.snapshot));
    await signedIn.apply(identity);
    expect(db.get(`MEMBER#${developerId}`, "PROJECT#payments")).toMatchObject({ role: "developer", ownerKey: developerId, projectName: "payments", grantedBy: { issuer: admin.issuer, subject: admin.subject } });
    await expect(planChange(deps, identity, { kind: "grant_project_access", project: "payments", developer: "U0NEW00001" })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: "CONFIG_INVALID: Nia Park (signs in with Slack) already has a grant for payments; there is nothing to change" });
    // An applier who no longer administers the project changes nothing.
    const other = await planChange(deps, identity, { kind: "grant_project_access", project: "payments", developer: MAYA.developerId });
    db.delete(String(membership.pk), String(membership.sk));
    await expect(other.apply(identity)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.get(`MEMBER#${MAYA.developerId}`, "PROJECT#payments")).toBeUndefined();
  });

  it("DEC 254zzz98 (review M2): an administrator whose live company is a named company grants and revokes the legacy project's legacy grant, never one in their company", async () => {
    const h = await harness();
    const named = `org_${"m".repeat(20)}`;
    const deps = { ...h.deps, actions: { ...h.deps.actions, companies: { companyOf: async () => named } } } as PlanDependencies;
    const developerId = developerIdForSlackUser("U0NEW00002");
    h.db.set({ pk: `DEVELOPER#${developerId}`, sk: "META", developerId, provider: "slack", displayName: "Ola Ruiz", slackUserId: "U0NEW00002" });
    await (await planChange(deps, h.identity, { kind: "grant_project_access", project: "payments", developer: "U0NEW00002" })).apply(h.identity);
    // The grant is where the project's (legacy) revision is, so it is read with it; nothing is written under the administrator's company.
    expect(h.db.get(`MEMBER#${developerId}`, "PROJECT#payments")).toMatchObject({ role: "developer", projectName: "payments" });
    expect(h.db.find((item) => String(item.pk).startsWith(`ORG#${named}#`))).toEqual([]);
    // And the revoke finds that legacy grant and removes it.
    await (await planChange(deps, h.identity, { kind: "revoke_project_access", project: "payments", developer: developerId })).apply(h.identity);
    expect(h.db.get(`MEMBER#${developerId}`, "PROJECT#payments")).toBeUndefined();
  });

  it("never revokes an administrator, and rechecks administration at apply", async () => {
    const { deps, identity, db, membership } = await harness();
    await expect(planChange(deps, identity, { kind: "revoke_project_access", project: "payments", developer: identity.ownerKey })).rejects.toMatchObject({ code: "NOT_FOUND" });
    db.set({ pk: `MEMBER#${MAYA.developerId}`, sk: "PROJECT#payments", entityType: "MEMBERSHIP", ownerKey: MAYA.developerId, projectName: "payments", role: "developer" });
    const plan = await planChange(deps, identity, { kind: "revoke_project_access", project: "payments", developer: MAYA.developerId });
    db.delete(String(membership.pk), String(membership.sk));
    await expect(plan.apply(identity)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.get(`MEMBER#${MAYA.developerId}`, "PROJECT#payments")).toMatchObject({ role: "developer" });
  });

  it("refuses a project that is not registered, or whose name is not a project name", async () => {
    const { deps, identity } = await harness();
    await expect(planChange(deps, identity, { kind: "grant_project_access", project: "ledger", developer: "U0NEW00001" })).rejects.toMatchObject({ code: "NOT_FOUND", message: "NOT_FOUND: project ledger is not registered; check the project's name, or register it with agentx admin project register" });
    await expect(planChange(deps, identity, { kind: "revoke_project_access", project: "pay#ments", developer: MAYA.developerId })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

});

describe("ending a sign-in (E9, Q3)", () => {
  it("says every session ends at once and that they may sign in again", async () => {
    const { deps, identity } = await harness();
    expect((await planChange(deps, identity, { kind: "revoke_signin", developer: MAYA.developerId })).effect).toBe("End every AgentX sign-in session of Maya Chen (signs in with Slack). Their AI tools stop reaching AgentX at once; they may sign in again with agentx login. Their running tasks keep running.");
    await expect(planChange(deps, identity, { kind: "revoke_signin", developer: "U0NEW00001" })).rejects.toMatchObject({ code: "NOT_FOUND", message: "NOT_FOUND: Slack user U0NEW00001 has never signed in to AgentX, so there is no sign-in to end" });
    await expect(planChange(deps, identity, { kind: "revoke_project_access", project: "payments", developer: "U0NEW00001" })).rejects.toMatchObject({ code: "NOT_FOUND", message: "NOT_FOUND: Slack user U0NEW00001 has no grant for payments, so there is nothing to revoke" });
  });

  it("needs the admin claim, moves the hash when sessions were ended since, and applies through the sign-in service", async () => {
    const { deps, identity, db, endDeveloperSessions } = await harness();
    await expect(planChange(deps, { ...identity, isAdministrator: false }, { kind: "revoke_signin", developer: MAYA.developerId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const plan = await planChange(deps, identity, { kind: "revoke_signin", developer: MAYA.developerId });
    db.set({ ...db.get(`DEVELOPER#${MAYA.developerId}`, "META")!, sessionsEndedAt: "2026-10-02T09:00:00.000Z" });
    expect(stateHash((await planChange(deps, identity, { kind: "revoke_signin", developer: MAYA.developerId })).snapshot)).not.toBe(stateHash(plan.snapshot));
    expect(endDeveloperSessions).not.toHaveBeenCalled();
    await plan.apply(identity);
    expect(endDeveloperSessions).toHaveBeenCalledWith(expect.objectContaining({ kind: "end-developer-sessions", developerId: MAYA.developerId }));
  });
});

describe("a GitHub person in a change plan (DEC 254p (a))", () => {
  it("is named by their GitHub name and sign-in method, with hostile text made plain, and a Slack person's text is untouched", async () => {
    const { deps, identity, db } = await harness();
    const developerId = "b".repeat(64);
    db.set({ pk: `DEVELOPER#${developerId}`, sk: "META", developerId, provider: "github", issuer: "https://github.com", subject: "2001", displayName: "Octo Named" });
    const grant = await planChange(deps, identity, { kind: "grant_project_access", project: "payments", developer: developerId });
    expect(grant.effect).toBe("Grant Octo Named (signs in with GitHub) access to project payments. They have no grant today. They can then hand tasks to payments from their AI tool.");
    expect(JSON.stringify(grant.snapshot)).toContain("Octo Named");
    db.set({ pk: `DEVELOPER#${developerId}`, sk: "META", developerId, provider: "github", issuer: "https://github.com", subject: "2001", displayName: `<img src=x onerror=alert(1)>[a](https://evil.example)${"q".repeat(400)}` });
    const hostile = await planChange(deps, identity, { kind: "grant_project_access", project: "payments", developer: developerId });
    expect(hostile.effect).not.toMatch(/[<>[\]`]/u);
    expect(hostile.effect.length).toBeLessThan(400);
    const signin = await planChange(deps, identity, { kind: "revoke_signin", developer: developerId });
    expect(signin.effect).toContain("(signs in with GitHub)");
  });
});

describe("the workspace limits (E19, FR-053)", () => {
  it("shows the current and new limits, the counts, and who is at or over the new limit", async () => {
    const { deps, identity, db } = await harness();
    db.set({ pk: "SLACK_LIMIT#T0BSHLLUGBD", sk: "MEMBER#U0PRIYA001", count: 3 });
    db.set({ pk: "SLACK_LIMIT#T0BSHLLUGBD", sk: "MEMBER#U0OMAR0001", count: 1 });
    db.set({ pk: "SLACK_LIMIT#T0BSHLLUGBD", sk: "ORGANIZATION", count: 4 });
    const plan = await planChange(deps, identity, { kind: "set_workspace_limits", perPerson: 2 });
    expect(plan.effect).toBe("Set the workspace limits to 2 per person (now 3) and 20 for the organization (unchanged). Open workspaces: 4 of 20. At or over 2 per person: Slack member U0PRIYA001 (3 open). Existing workspaces keep running; a new one is refused while its person or the organization is at the limit.");
    await expect(planChange(deps, identity, { kind: "set_workspace_limits" })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: "CONFIG_INVALID: give per_person, per_organization or both" });
    await expect(planChange(deps, identity, { kind: "set_workspace_limits", perPerson: 30, perOrganization: 20 })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("needs the admin claim, refuses out-of-bounds limits, and applies the setting", async () => {
    const { deps, identity, db } = await harness();
    await expect(planChange(deps, { ...identity, isAdministrator: false }, { kind: "set_workspace_limits", perPerson: 5 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(planChange(deps, identity, { kind: "set_workspace_limits", perPerson: 0 })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(planChange(deps, identity, { kind: "set_workspace_limits", perOrganization: 1_001 })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    const plan = await planChange(deps, identity, { kind: "set_workspace_limits", perOrganization: 40 });
    expect(plan.effect).toContain("Set the workspace limits to 3 per person (unchanged) and 40 for the organization (now 20).");
    expect(db.get("SETTINGS", "WORKSPACE_LIMITS")).toBeUndefined();
    await plan.apply(identity);
    expect(db.get("SETTINGS", "WORKSPACE_LIMITS")).toMatchObject({ perPerson: 3, perOrganization: 40 });
  });

  it("says that people who use only an AI tool count in the total but are not named, when there are some (final review T6)", async () => {
    const { deps, identity, db } = await harness();
    db.set({ pk: "SLACK_LIMIT#T0BSHLLUGBD", sk: "ORGANIZATION", count: 2 });
    const without = await planChange(deps, identity, { kind: "set_workspace_limits", perPerson: 5 });
    expect(without.effect).not.toContain("only an AI tool");
    db.set({ pk: "DEVELOPER_LIMIT#ORGANIZATION", sk: "ORGANIZATION", count: 3 });
    const plan = await planChange(deps, identity, { kind: "set_workspace_limits", perPerson: 5 });
    expect(plan.effect).toContain("Open workspaces: 5 of 20. People who use only an AI tool count in the total but are not named. Existing workspaces keep running;");
  });

  it("says when the organization is already at or over its new limit, and caps the named people", async () => {
    const { deps, identity, db } = await harness();
    for (let index = 0; index < 14; index += 1) db.set({ pk: "SLACK_LIMIT#T0BSHLLUGBD", sk: `MEMBER#U0PERSON${String(index).padStart(2, "0")}`, count: 2 });
    db.set({ pk: "SLACK_LIMIT#T0BSHLLUGBD", sk: "ORGANIZATION", count: 28 });
    const plan = await planChange(deps, identity, { kind: "set_workspace_limits", perPerson: 2, perOrganization: 25 });
    expect(plan.effect).toContain("Open workspaces: 28 of 25.");
    expect(plan.effect).toContain("Slack member U0PERSON09 (2 open), and 4 more.");
    expect(plan.effect).toContain("The organization is at or over its new limit.");
    expect(plan.details).toMatchObject({ organizationCount: 28, over: 14 });
  });
});
