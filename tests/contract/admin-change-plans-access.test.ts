// tests/contract/admin-change-plans-access.test.ts
// Spec 025 E7 to E10, E19: stopping work, granting and revoking access, ending a sign-in, and the limits.
import { randomUUID } from "node:crypto";
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

describe("stopping a workspace's work (E10, Q2)", () => {
  it("names the running task it cancels, and refuses a workspace with nothing running", async () => {
    const { deps, identity, db, dev } = await harness();
    const started = await dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code" });
    const task = db.get(`DEVTASK#${(started.body.task as { taskId: string }).taskId}`, "META") as { workspaceId: string };
    // A prepare is running, which the admin cancel does not stop midway.
    await expect(planChange(deps, identity, { kind: "stop_workspace", workspaceId: task.workspaceId })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: "CONFIG_INVALID: the running operation is a prepare, which AgentX does not cancel midway; wait for it to end" });
    const workspace = db.get(`WORKSPACE#${task.workspaceId}`, "META")!;
    db.set({ ...workspace, status: "READY", activeOperationId: null });
    await expect(planChange(deps, identity, { kind: "stop_workspace", workspaceId: task.workspaceId })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: `CONFIG_INVALID: nothing is running in workspace ${task.workspaceId}; its compute stops on its own when idle` });
  });

  it("plans the cancel of a running task, hashes the workspace state, and refuses an unknown workspace or a non-administrator", async () => {
    const { deps, identity, db, dev, membership } = await harness();
    const started = await dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code" });
    const task = db.get(`DEVTASK#${(started.body.task as { taskId: string }).taskId}`, "META") as { workspaceId: string };
    const workspace = db.get(`WORKSPACE#${task.workspaceId}`, "META")!;
    const operationId = randomUUID();
    db.set({ pk: `WORKSPACE#${task.workspaceId}`, sk: `OPERATION#${operationId}`, entityType: "OPERATION", id: operationId, workspaceId: task.workspaceId, kind: "task", status: "RUNNING" });
    db.set({ ...workspace, status: "BUSY", activeOperationId: operationId });
    const plan = await planChange(deps, identity, { kind: "stop_workspace", workspaceId: task.workspaceId });
    expect(plan.effect).toBe(`Cancel the task running in workspace ${task.workspaceId} (project payments, Maya Chen's task, BUSY). Its conversation keeps what finished before; its compute stops on its own when idle.`);
    expect(plan.details).toMatchObject({ workspaceId: task.workspaceId, project: "payments", operationId });
    const before = stateHash(plan.snapshot);
    expect(before).toMatch(/^[a-f0-9]{64}$/);
    db.set({ ...db.get(`WORKSPACE#${task.workspaceId}`, "META")!, fence: Number(workspace.fence ?? 0) + 1 });
    expect(stateHash((await planChange(deps, identity, { kind: "stop_workspace", workspaceId: task.workspaceId })).snapshot)).not.toBe(before);
    await expect(planChange(deps, identity, { kind: "stop_workspace", workspaceId: randomUUID() })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // E6, FR-015: the applier must still administer the project when the change applies.
    db.delete(String(membership.pk), String(membership.sk));
    await expect(plan.apply(identity)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.get(`WORKSPACE#${task.workspaceId}`, "META")).toMatchObject({ activeOperationId: operationId });
  });
});

describe("project access (E7, E8, FR-013.1)", () => {
  it("grants a developer named by Slack user before their first sign-in, saying so", async () => {
    const { deps, identity } = await harness();
    const plan = await planChange(deps, identity, { kind: "grant_project_access", project: "payments", developer: "U0NEW00001" });
    expect(plan.effect).toBe("Grant Slack user U0NEW00001 (not signed in to AgentX yet; the grant applies when they sign in with Slack) access to project payments. They have no grant today. They can then hand tasks to payments from their AI tool.");
    expect(plan.details).toMatchObject({ developerId: developerIdForSlackUser("U0NEW00001"), project: "payments" });
  });

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

  it("names a signed-in developer, and revokes only a grant, saying channel access may remain", async () => {
    const { deps, identity, db } = await harness();
    db.set({ pk: `MEMBER#${MAYA.developerId}`, sk: "PROJECT#payments", entityType: "MEMBERSHIP", ownerKey: MAYA.developerId, projectName: "payments", role: "developer" });
    const plan = await planChange(deps, identity, { kind: "revoke_project_access", project: "payments", developer: MAYA.developerId });
    expect(plan.effect).toBe("Revoke the granted access of Maya Chen (signs in with Slack) to project payments. Their running tasks keep running. If they are a member of one of payments's Slack channels, they keep access through it.");
    const before = stateHash(plan.snapshot);
    db.delete(`MEMBER#${MAYA.developerId}`, "PROJECT#payments");
    await expect(planChange(deps, identity, { kind: "revoke_project_access", project: "payments", developer: MAYA.developerId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(before).toMatch(/^[a-f0-9]{64}$/);
    // The same developer granted again (a new grant) is a different state.
    db.set({ pk: `MEMBER#${MAYA.developerId}`, sk: "PROJECT#payments", entityType: "MEMBERSHIP", ownerKey: MAYA.developerId, projectName: "payments", role: "developer", grantedAt: "2026-10-02T09:00:00.000Z" });
    const again = await planChange(deps, identity, { kind: "revoke_project_access", project: "payments", developer: MAYA.developerId });
    expect(stateHash(again.snapshot)).not.toBe(before);
    await again.apply(identity);
    expect(db.get(`MEMBER#${MAYA.developerId}`, "PROJECT#payments")).toBeUndefined();
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

  it("refuses a grant on a project the admin does not administer (FR-015)", async () => {
    const { deps } = await harness();
    await expect(planChange(deps, { ...admin, ownerKey: "f".repeat(64) }, { kind: "grant_project_access", project: "payments", developer: "U0NEW00001" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a project that is not registered, or whose name is not a project name", async () => {
    const { deps, identity } = await harness();
    await expect(planChange(deps, identity, { kind: "grant_project_access", project: "ledger", developer: "U0NEW00001" })).rejects.toMatchObject({ code: "NOT_FOUND", message: "NOT_FOUND: project ledger is not registered; check the project's name, or register it with agentx admin project register" });
    await expect(planChange(deps, identity, { kind: "revoke_project_access", project: "pay#ments", developer: MAYA.developerId })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("refuses a caller without the admin claim before saying whether a project or workspace exists", async () => {
    const { deps, identity } = await harness();
    const member = { ...identity, isAdministrator: false };
    for (const project of ["payments", "ledger"]) {
      await expect(planChange(deps, member, { kind: "grant_project_access", project, developer: "U0NEW00001" })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(planChange(deps, member, { kind: "revoke_project_access", project, developer: MAYA.developerId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    await expect(planChange(deps, member, { kind: "stop_workspace", workspaceId: randomUUID() })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("ending a sign-in (E9, Q3)", () => {
  it("says every session ends at once and that they may sign in again", async () => {
    const { deps, identity } = await harness();
    expect((await planChange(deps, identity, { kind: "revoke_signin", developer: MAYA.developerId })).effect).toBe("End every AgentX sign-in session of Maya Chen (signs in with Slack). Their AI tools stop reaching AgentX at once; they may sign in again with agentx login. Their running tasks keep running.");
    await expect(planChange(deps, identity, { kind: "revoke_signin", developer: "U0NEW00001" })).rejects.toMatchObject({ code: "NOT_FOUND" });
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

  it("hashes the setting, so a change by someone else makes the plan stale", async () => {
    const { deps, identity, db } = await harness();
    const before = stateHash((await planChange(deps, identity, { kind: "set_workspace_limits", perPerson: 5 })).snapshot);
    db.set({ pk: "SETTINGS", sk: "WORKSPACE_LIMITS", perPerson: 4, perOrganization: 20, updatedAt: "2026-10-02T09:00:00.000Z" });
    expect(stateHash((await planChange(deps, identity, { kind: "set_workspace_limits", perPerson: 5 })).snapshot)).not.toBe(before);
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
