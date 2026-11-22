import { randomUUID } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { agentXError } from "../../packages/contracts/src/index.js";
import type { Ec2OutboxRecord } from "../../packages/broker/src/aws/lambda.js";
import { guardTaskDispatch, isTaskDispatchGuardRetryError, resumeTaskDispatch } from "../../packages/broker/src/aws/task-dispatch-access.js";
import { createTaskAuthorityAdmission } from "../../packages/broker/src/aws/task-authority-admission.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { taskOwnerKey } from "../../packages/broker/src/developer/task-records.js";
import type { ProjectAuthorityWitness } from "../../packages/broker/src/developer/task-project-access.js";
import { resolveTaskDispatchPeople } from "../../packages/broker/src/developer/task-people.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const OWNER = "a".repeat(64);
const OWNER_SLACK = "U0OWNER001";

function task(): DeveloperTaskRecord {
  return {
    pk: `DEVTASK#${TASK_ID}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: TASK_ID,
    developerId: OWNER, provider: "slack", developerName: "Avery", slackUserId: OWNER_SLACK,
    client: "slack", project: "payments", title: "Payments", workspaceId: WORKSPACE_ID,
    ownerKey: "f".repeat(64), conversationId: randomUUID(), startingRevision: 1,
    charge: { member: { pk: "member", sk: "counter" }, organization: { pk: "organization", sk: "counter" } },
    shared: true, share: { teamId: "T0PEOPLE1", channelId: "C0PEOPLE1", mode: "view", sharedReason: "requested", sharedAt: "2026-10-11T10:00:00.000Z" },
    createdAt: "2026-10-11T10:00:00.000Z", updatedAt: "2026-10-11T10:00:00.000Z",
    workflow: { revision: 7, stage: "IMPLEMENT", state: "RUNNING" } as never,
  };
}

function record(): Ec2OutboxRecord {
  const operationId = randomUUID();
  return {
    id: randomUUID(), entityType: "OUTBOX", status: "QUEUED", operationId, workspaceId: WORKSPACE_ID, deploymentMode: "ec2-ebs",
    invocation: { protocolVersion: 1, kind: "task", operationId, workspaceId: WORKSPACE_ID, fence: 4, projectRevision: 1,
      callbackCapability: "c".repeat(64), payload: { conversationId: randomUUID(), prompt: "continue", conversationStarted: true } },
  };
}

function harness(withPeople = true) {
  const db = new FakeDynamoDb();
  const current = task();
  const outbox = record();
  db.set(current as unknown as Record<string, unknown>);
  db.set({ pk: `WORKSPACE#${WORKSPACE_ID}`, sk: "DEVELOPER_TASK", entityType: "DEVELOPER_TASK_POINTER", taskId: TASK_ID, developerId: OWNER });
  db.set({ pk: `OUTBOX#${outbox.id}`, sk: "OUTBOX", ...outbox });
  db.set({ pk: `WORKSPACE#${WORKSPACE_ID}`, sk: `OPERATION#${outbox.operationId}`, status: "DISPATCHING", fence: 4 });
  db.set({ pk: `WORKSPACE#${WORKSPACE_ID}`, sk: "META", status: "BUSY", activeOperationId: outbox.operationId, fence: 4 });
  if (withPeople) db.set({ pk: `DEVTASK#${TASK_ID}`, sk: "PEOPLE", schemaVersion: 1, revision: 3, orphaned: false,
    people: [{ developerId: OWNER, slackUserId: OWNER_SLACK, name: "Avery", role: "owner" }] });
  const checkTaskPerson = vi.fn(async () => ({
    subject: { developerId: OWNER, slackUserId: OWNER_SLACK },
    identity: { developerId: OWNER, slackUserId: OWNER_SLACK, name: "Avery", method: "slack" as const, issuer: "https://slack.com", subject: OWNER_SLACK },
    eligible: true, channelMember: true,
  }));
  return { db, current, outbox, checkTaskPerson };
}

describe("task dispatch access", () => {
  it("binds a checker-free hosted creator-only allowance to the People revision and owner actor", async () => {
    const h = harness();
    Object.assign(h.current, { provider: "rovara-sign-in" });
    h.db.set(h.current as unknown as Record<string, unknown>);
    const deps = { documentClient: h.db, tableName: "state" };
    await expect(resolveTaskDispatchPeople(deps, h.current)).resolves.toEqual({ status: "ALLOWED", peopleRevision: 3, ownerActorIds: [taskOwnerKey(OWNER, TASK_ID)] });
    await expect(guardTaskDispatch(deps, h.outbox)).resolves.toBe("ALLOWED");
    expect(h.db.find(row => String(row.sk).includes("TASK_ACCESS"))).toEqual([]);
    h.db.delete(h.current.pk, "PEOPLE");
    await expect(resolveTaskDispatchPeople(deps, h.current)).resolves.toBeUndefined();
    await expect(guardTaskDispatch(deps, h.outbox)).resolves.toBe("ALLOWED");
  });

  it.each(["reader", "denied extra", "second owner", "foreign owner", "viewer", "commenter", "denied owner", "empty", "orphaned", "slack", "unknown adapter"])("parks checker-free People with %s instead of using the creator allowance", async reason => {
    const h = harness();
    Object.assign(h.current, { provider: reason === "slack" ? "slack" : reason === "unknown adapter" ? "other-adapter" : "rovara-sign-in" });
    h.db.set(h.current as unknown as Record<string, unknown>);
    const owner = { developerId: OWNER, slackUserId: OWNER_SLACK, name: "Avery", role: "owner" };
    const extra = { developerId: "b".repeat(64), slackUserId: "U0READER01", name: "Reader", role: reason === "second owner" ? "owner" : reason === "denied extra" ? "denied" : "viewer" };
    const entries = ["reader", "denied extra", "second owner"].includes(reason) ? [owner, extra]
      : reason === "foreign owner" ? [{ ...owner, developerId: extra.developerId }]
      : reason === "empty" ? []
      : ["viewer", "commenter", "denied owner"].includes(reason) ? [{ ...owner, role: reason === "denied owner" ? "denied" : reason }]
      : [owner];
    h.db.set({ pk: h.current.pk, sk: "PEOPLE", schemaVersion: 1, revision: 3, orphaned: reason === "orphaned", people: entries });
    await expect(guardTaskDispatch({ documentClient: h.db, tableName: "state" }, h.outbox)).resolves.toBe("PARKED");
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "OUTBOX")?.status).toBe("WAITING_FOR_TASK_ACCESS");
  });

  it("keeps fresh proof authoritative when a hosted creator checker is configured", async () => {
    const h = harness();
    Object.assign(h.current, { provider: "rovara-sign-in" });
    h.db.set(h.current as unknown as Record<string, unknown>);
    h.checkTaskPerson.mockRejectedValue(new Error("proof unavailable"));
    await expect(guardTaskDispatch({ documentClient: h.db, tableName: "state", checkTaskPerson: h.checkTaskPerson }, h.outbox)).resolves.toBe("PARKED");
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "TASK_ACCESS_PAUSE")?.reason).toBe("PROOF_UNAVAILABLE");
  });

  it.each([false, true])("re-evaluates a checker-free allowance when People changes before the fence (reader added=%s)", async readerAdded => {
    const h = harness();
    Object.assign(h.current, { provider: "rovara-sign-in" });
    h.db.set(h.current as unknown as Record<string, unknown>);
    const revisions: unknown[] = [];
    const documentClient = { async send(command: unknown): Promise<unknown> {
      if (command instanceof TransactWriteCommand) {
        const fence = command.input.TransactItems?.find(item => item.ConditionCheck?.Key?.sk === "PEOPLE")?.ConditionCheck;
        if (fence !== undefined) {
          revisions.push(fence.ExpressionAttributeValues?.[":revision"]);
          if (revisions.length === 1) {
            const prior = h.db.get(h.current.pk, "PEOPLE")!;
            h.db.set({ ...prior, revision: 4, people: [...prior.people as object[], ...(readerAdded ? [{ developerId: "b".repeat(64), slackUserId: "U0READER01", name: "Reader", role: "viewer" }] : [])] });
          }
        }
      }
      return h.db.send(command as never);
    } };
    await expect(guardTaskDispatch({ documentClient, tableName: "state" }, h.outbox)).resolves.toBe(readerAdded ? "PARKED" : "ALLOWED");
    expect(revisions).toEqual([3, 4]);
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "OUTBOX")?.status).toBe(readerAdded ? "WAITING_FOR_TASK_ACCESS" : "QUEUED");
  });

  it("classifies only rejected core guard decisions as retryable and preserves the original failure", async () => {
    const original = agentXError("RUNTIME_UNAVAILABLE", "task access pause reserve is unavailable");
    const guard = guardTaskDispatch({ documentClient: { async send() { throw original; } }, tableName: "state" }, record());
    let caught: unknown;
    try { await guard; } catch (error) { caught = error; }
    expect(isTaskDispatchGuardRetryError(caught)).toBe(true);
    expect(caught).toMatchObject({ name: "TaskDispatchGuardRetryError", message: original.message, code: original.code, cause: original });
    expect(isTaskDispatchGuardRetryError(agentXError("RUNTIME_UNAVAILABLE", original.message))).toBe(false);
  });

  it.each(["deleted", "downgraded"] as const)("requalifies after the sole developer grant is %s before the final State fence", async (change) => {
    const h = harness();
    const revision = {
      pk: "PROJECT#payments", sk: "REV#000000000007",
      definition: { revision: 7, developerTasks: { enabled: true, channelMembersMayUse: false } },
    };
    const membership = { pk: `MEMBER#${OWNER}`, sk: "PROJECT#payments", projectName: "payments", role: "developer" };
    h.db.set(revision);
    h.db.set(membership);
    h.checkTaskPerson.mockImplementationOnce(async () => ({
      subject: { developerId: OWNER, slackUserId: OWNER_SLACK },
      identity: { developerId: OWNER, slackUserId: OWNER_SLACK, name: "Avery", method: "slack" as const, issuer: "https://slack.com", subject: OWNER_SLACK },
      eligible: true, channelMember: true,
    })).mockImplementation(async () => ({
      subject: { developerId: OWNER, slackUserId: OWNER_SLACK },
      identity: { developerId: OWNER, slackUserId: OWNER_SLACK, name: "Avery", method: "slack" as const, issuer: "https://slack.com", subject: OWNER_SLACK },
      eligible: false, channelMember: true,
    }));
    let changed = false;
    const documentClient = {
      async send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown> {
        void options;
        if (!changed && command instanceof TransactWriteCommand) {
          const input = command.input as { TransactItems?: Array<{ ConditionCheck?: { Key?: { pk?: string; sk?: string } } }> };
          if (input.TransactItems?.some((item) => item.ConditionCheck?.Key?.pk === membership.pk && item.ConditionCheck.Key.sk === membership.sk)) {
            changed = true;
            if (change === "deleted") h.db.delete(membership.pk, membership.sk);
            else h.db.set({ ...membership, role: "administrator" });
          }
        }
        return h.db.send(command as never);
      },
    };
    const witness: ProjectAuthorityWitness & { taskId: string; developerId: string; project: string } = {
      taskId: TASK_ID, developerId: OWNER, project: "payments", access: "granted",
      projectRevision: { pk: revision.pk, sk: revision.sk, revision: 7, developerTasksPresent: true, developerTasks: revision.definition.developerTasks },
      membership: { pk: membership.pk, sk: membership.sk, projectName: "payments", role: "developer" },
    };
    await expect(guardTaskDispatch({
      documentClient, tableName: "state", checkTaskPerson: h.checkTaskPerson,
      stateAuthorityWitnessForOwnerActor: async (_task, actorId) => actorId === taskOwnerKey(OWNER, TASK_ID) ? witness : undefined,
    }, h.outbox)).resolves.toBe("PARKED");
    expect(changed).toBe(true);
    expect(h.checkTaskPerson).toHaveBeenCalledTimes(2);
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "OUTBOX")?.status).toBe("WAITING_FOR_TASK_ACCESS");
  });

  it("allows dispatch on an unchanged administrator membership, fencing the role it saw (#630)", async () => {
    const h = harness();
    const revision = {
      pk: "PROJECT#payments", sk: "REV#000000000007",
      definition: { revision: 7, developerTasks: { enabled: true, channelMembersMayUse: false } },
    };
    const membership = { pk: `MEMBER#${OWNER}`, sk: "PROJECT#payments", projectName: "payments", role: "administrator" as const };
    h.db.set(revision);
    h.db.set(membership);
    const fenced: unknown[] = [];
    const documentClient = {
      async send(command: unknown): Promise<unknown> {
        if (command instanceof TransactWriteCommand) {
          const items = (command.input as { TransactItems?: Array<{ ConditionCheck?: { Key?: { pk?: string }; ExpressionAttributeValues?: Record<string, unknown> } }> }).TransactItems ?? [];
          fenced.push(...items.filter((item) => item.ConditionCheck?.Key?.pk === membership.pk).map((item) => item.ConditionCheck?.ExpressionAttributeValues));
        }
        return h.db.send(command as never);
      },
    };
    const witness: ProjectAuthorityWitness & { taskId: string; developerId: string; project: string } = {
      taskId: TASK_ID, developerId: OWNER, project: "payments", access: "granted",
      projectRevision: { pk: revision.pk, sk: revision.sk, revision: 7, developerTasksPresent: true, developerTasks: revision.definition.developerTasks },
      membership,
    };
    await expect(guardTaskDispatch({
      documentClient, tableName: "state", checkTaskPerson: h.checkTaskPerson,
      stateAuthorityWitnessForOwnerActor: async (_task, actorId) => actorId === taskOwnerKey(OWNER, TASK_ID) ? witness : undefined,
    }, h.outbox)).resolves.toBe("ALLOWED");
    expect(fenced).toEqual([{ ":project": "payments", ":role": "administrator" }]);
  });

  it("R2-F1 review round 3: a NAMED company's witness (its own revision, grant and binding keys) dispatches; a legacy grant paired with its revision never does", async () => {
    const B = `org_${"b".repeat(20)}`, A = `org_${"a".repeat(20)}`;
    const revisionOf = (company: string) => ({ pk: `ORG#${company}#PROJECT#payments`, sk: "REV#000000000007", definition: { revision: 7, developerTasks: { enabled: true, channelMembersMayUse: true } } });
    type Witness = ProjectAuthorityWitness & { taskId: string; developerId: string; project: string };
    const grantWitness = (company: string, membershipPk: string): Witness => {
      const revision = revisionOf(company);
      return { taskId: TASK_ID, developerId: OWNER, project: "payments", access: "granted",
        projectRevision: { pk: revision.pk, sk: revision.sk, revision: 7, developerTasksPresent: true, developerTasks: revision.definition.developerTasks },
        membership: { pk: membershipPk, sk: "PROJECT#payments", projectName: "payments", role: "developer" } };
    };
    const channelWitness = (company: string, bindingPk: string): Witness => {
      const revision = revisionOf(company);
      return { taskId: TASK_ID, developerId: OWNER, project: "payments", access: "channel",
        projectRevision: { pk: revision.pk, sk: revision.sk, revision: 7, developerTasksPresent: true, developerTasks: revision.definition.developerTasks },
        binding: { pk: bindingPk, sk: "CHANNEL#C0PEOPLE1", teamId: "T0PEOPLE1", channelId: "C0PEOPLE1", projectName: "payments", updatedAt: "2026-10-11T10:00:00.000Z" } };
    };
    /** The task belongs to company B (as a named company's task names it); every row the witness names exists, so only the key rules decide. */
    const run = async (witness: Witness) => {
      const h = harness();
      h.db.set({ ...(h.current as unknown as Record<string, unknown>), companyId: B });
      h.db.set(revisionOf(B)); h.db.set(revisionOf(A));
      if (witness.membership !== undefined) h.db.set({ ...witness.membership });
      if (witness.binding !== undefined) h.db.set({ ...witness.binding });
      // A witness the guard cannot fence is never allowed: it requalifies (here the person stays eligible, so the guard gives up with its retry error).
      return guardTaskDispatch({ documentClient: h.db, tableName: "state", checkTaskPerson: h.checkTaskPerson,
        stateAuthorityWitnessForOwnerActor: async (_task, actorId) => actorId === taskOwnerKey(OWNER, TASK_ID) ? witness : undefined }, h.outbox).catch((error: unknown) => error);
    };
    expect(await run(grantWitness(B, `ORG#${B}#MEMBER#${OWNER}`))).toBe("ALLOWED");
    expect(await run(channelWitness(B, `ORG#${B}#SLACK_BINDING#T0PEOPLE1`))).toBe("ALLOWED");
    // A grant at the legacy key or at A's key, beside B's revision: refused.
    for (const stale of [`MEMBER#${OWNER}`, `ORG#${A}#MEMBER#${OWNER}`]) expect(await run(grantWitness(B, stale)), stale).not.toBe("ALLOWED");
    // A binding at the legacy key or at A's key, beside B's revision: refused (review round 4, L4).
    for (const stale of ["SLACK_BINDING#T0PEOPLE1", `ORG#${A}#SLACK_BINDING#T0PEOPLE1`]) expect(await run(channelWitness(B, stale)), stale).not.toBe("ALLOWED");
    // A whole witness of company A (A's revision, grant and binding), on B's task: refused (review round 4, L1).
    expect(await run(grantWitness(A, `ORG#${A}#MEMBER#${OWNER}`))).not.toBe("ALLOWED");
    expect(await run(channelWitness(A, `ORG#${A}#SLACK_BINDING#T0PEOPLE1`))).not.toBe("ALLOWED");
  });

  it("R2-F1 review round 4: a task naming a malformed company never dispatches on a witness", async () => {
    const h = harness();
    h.db.set({ ...(h.current as unknown as Record<string, unknown>), companyId: "not-a-company" });
    const revision = { pk: "PROJECT#payments", sk: "REV#000000000007", definition: { revision: 7, developerTasks: { enabled: true, channelMembersMayUse: false } } };
    const membership = { pk: `MEMBER#${OWNER}`, sk: "PROJECT#payments", projectName: "payments", role: "developer" as const };
    h.db.set(revision); h.db.set(membership);
    const witness: ProjectAuthorityWitness & { taskId: string; developerId: string; project: string } = { taskId: TASK_ID, developerId: OWNER, project: "payments", access: "granted",
      projectRevision: { pk: revision.pk, sk: revision.sk, revision: 7, developerTasksPresent: true, developerTasks: revision.definition.developerTasks }, membership };
    expect(await guardTaskDispatch({ documentClient: h.db, tableName: "state", checkTaskPerson: h.checkTaskPerson,
      stateAuthorityWitnessForOwnerActor: async (_task, actorId) => actorId === taskOwnerKey(OWNER, TASK_ID) ? witness : undefined }, h.outbox).catch((error: unknown) => error)).not.toBe("ALLOWED");
  });

  it.each(["binding", "policy"] as const)("requalifies after the qualifying channel %s changes before the final State fence", async (changedWitness) => {
    const h = harness();
    const revision = {
      pk: "PROJECT#payments", sk: "REV#000000000007",
      definition: { revision: 7, developerTasks: { enabled: true, channelMembersMayUse: true } },
    };
    const binding = { pk: "SLACK_BINDING#T0PEOPLE1", sk: "CHANNEL#C0PEOPLE1", teamId: "T0PEOPLE1", channelId: "C0PEOPLE1", projectName: "payments", updatedAt: "2026-10-11T10:00:00.000Z" };
    h.db.set(revision);
    h.db.set(binding);
    h.checkTaskPerson.mockImplementationOnce(async () => ({
      subject: { developerId: OWNER, slackUserId: OWNER_SLACK },
      identity: { developerId: OWNER, slackUserId: OWNER_SLACK, name: "Avery", method: "slack" as const, issuer: "https://slack.com", subject: OWNER_SLACK },
      eligible: true, channelMember: true,
    })).mockImplementation(async () => ({
      subject: { developerId: OWNER, slackUserId: OWNER_SLACK },
      identity: { developerId: OWNER, slackUserId: OWNER_SLACK, name: "Avery", method: "slack" as const, issuer: "https://slack.com", subject: OWNER_SLACK },
      eligible: false, channelMember: true,
    }));
    let changed = false;
    const documentClient = {
      async send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown> {
        void options;
        if (!changed && command instanceof TransactWriteCommand) {
          const input = command.input as { TransactItems?: Array<{ ConditionCheck?: { Key?: { pk?: string; sk?: string } } }> };
          const pk = changedWitness === "binding" ? binding.pk : revision.pk;
          const sk = changedWitness === "binding" ? binding.sk : revision.sk;
          if (input.TransactItems?.some((item) => item.ConditionCheck?.Key?.pk === pk && item.ConditionCheck.Key.sk === sk)) {
            changed = true;
            if (changedWitness === "binding") h.db.set({ ...binding, updatedAt: "2026-10-12T10:00:00.000Z" });
            else h.db.set({ ...revision, definition: { ...revision.definition, developerTasks: { enabled: true, channelMembersMayUse: false } } });
          }
        }
        return h.db.send(command as never);
      },
    };
    const witness: ProjectAuthorityWitness & { taskId: string; developerId: string; project: string } = {
      taskId: TASK_ID, developerId: OWNER, project: "payments", access: "channel",
      projectRevision: { pk: revision.pk, sk: revision.sk, revision: 7, developerTasksPresent: true, developerTasks: revision.definition.developerTasks },
      binding,
    };
    await expect(guardTaskDispatch({
      documentClient, tableName: "state", checkTaskPerson: h.checkTaskPerson,
      stateAuthorityWitnessForOwnerActor: async (_task, actorId) => actorId === taskOwnerKey(OWNER, TASK_ID) ? witness : undefined,
    }, h.outbox)).resolves.toBe("PARKED");
    expect(changed).toBe(true);
    expect(h.checkTaskPerson).toHaveBeenCalledTimes(2);
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "OUTBOX")?.status).toBe("WAITING_FOR_TASK_ACCESS");
  });

  it("parks without demoting the owner when the final authority query is unavailable", async () => {
    const h = harness();
    await expect(guardTaskDispatch({
      documentClient: h.db, tableName: "state", checkTaskPerson: h.checkTaskPerson,
      stateAuthorityWitnessForOwnerActor: async () => { throw new Error("project query unavailable"); },
    }, h.outbox)).resolves.toBe("PARKED");
    expect(h.db.get(`DEVTASK#${TASK_ID}`, "PEOPLE")?.people).toEqual([
      { developerId: OWNER, slackUserId: OWNER_SLACK, name: "Avery", role: "owner" },
    ]);
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "OUTBOX")?.status).toBe("WAITING_FOR_TASK_ACCESS");
  });

  it("requalifies through current channel policy after a direct developer grant is removed", async () => {
    const h = harness();
    const revision = {
      pk: "PROJECT#payments", sk: "REV#000000000007",
      definition: { revision: 7, developerTasks: { enabled: true, channelMembersMayUse: true } },
    };
    const membership = { pk: `MEMBER#${OWNER}`, sk: "PROJECT#payments", projectName: "payments", role: "developer" };
    const binding = { pk: "SLACK_BINDING#T0PEOPLE1", sk: "CHANNEL#C0PEOPLE1", teamId: "T0PEOPLE1", channelId: "C0PEOPLE1", projectName: "payments", updatedAt: "2026-10-11T10:00:00.000Z" };
    h.db.set(revision);
    h.db.set(membership);
    h.db.set(binding);
    let grantRemoved = false;
    const documentClient = {
      async send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown> {
        void options;
        if (!grantRemoved && command instanceof TransactWriteCommand) {
          const input = command.input as { TransactItems?: Array<{ ConditionCheck?: { Key?: { pk?: string; sk?: string } } }> };
          if (input.TransactItems?.some((item) => item.ConditionCheck?.Key?.pk === membership.pk && item.ConditionCheck.Key.sk === membership.sk)) {
            grantRemoved = true;
            h.db.delete(membership.pk, membership.sk);
          }
        }
        return h.db.send(command as never);
      },
    };
    const projectRevision = { pk: revision.pk, sk: revision.sk, revision: 7, developerTasksPresent: true, developerTasks: revision.definition.developerTasks };
    const directWitness: ProjectAuthorityWitness & { taskId: string; developerId: string; project: string } = {
      taskId: TASK_ID, developerId: OWNER, project: "payments", access: "granted", projectRevision,
      membership: { pk: membership.pk, sk: membership.sk, projectName: "payments", role: "developer" },
    };
    const channelWitness: ProjectAuthorityWitness & { taskId: string; developerId: string; project: string } = {
      taskId: TASK_ID, developerId: OWNER, project: "payments", access: "channel", projectRevision, binding,
    };
    let witnessReads = 0;
    await expect(guardTaskDispatch({
      documentClient, tableName: "state", checkTaskPerson: h.checkTaskPerson,
      stateAuthorityWitnessForOwnerActor: async (_task, actorId) => actorId !== taskOwnerKey(OWNER, TASK_ID)
        ? undefined : (witnessReads++ === 0 ? directWitness : channelWitness),
    }, h.outbox)).resolves.toBe("ALLOWED");
    expect(grantRemoved).toBe(true);
    expect(witnessReads).toBe(2);
  });

  it("leaves legacy work without a PEOPLE sidecar unchanged", async () => {
    const h = harness(false);
    await expect(guardTaskDispatch({ documentClient: h.db, tableName: "state" }, h.outbox)).resolves.toBe("ALLOWED");
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "OUTBOX")?.status).toBe("QUEUED");
  });

  it("keeps terminal cleanup independent when a PEOPLE task is ownerless", async () => {
    const h = harness();
    const cleanup = { ...h.outbox, invocation: { ...h.outbox.invocation, kind: "close", payload: {} } } as Ec2OutboxRecord;
    await expect(guardTaskDispatch({ documentClient: h.db, tableName: "state" }, cleanup)).resolves.toBe("ALLOWED");
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "OUTBOX")?.status).toBe("QUEUED");
  });

  it("retries instead of acknowledging when a task pointer cannot be verified", async () => {
    const h = harness();
    h.db.delete(`DEVTASK#${TASK_ID}`, "META");
    await expect(guardTaskDispatch({ documentClient: h.db, tableName: "state" }, h.outbox)).rejects.toThrow(/could not be verified/);
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "OUTBOX")?.status).toBe("QUEUED");
  });

  it("allows a freshly qualified effective owner without storing an allow receipt", async () => {
    const h = harness();
    await expect(guardTaskDispatch({ documentClient: h.db, tableName: "state", checkTaskPerson: h.checkTaskPerson }, h.outbox)).resolves.toBe("ALLOWED");
    expect(h.checkTaskPerson).toHaveBeenCalledWith(h.current, OWNER, undefined);
    expect(h.db.find((item) => String(item.sk).includes("TASK_ACCESS"))).toEqual([]);
  });

  it("counts every guard GetItem against the single shared authority admission", async () => {
    const h = harness();
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    await expect(guardTaskDispatch({ documentClient: h.db, tableName: "state", checkTaskPerson: h.checkTaskPerson, admission }, h.outbox)).resolves.toBe("ALLOWED");
    expect(admission.remainingStateReads()).toBe(124);
  });

  it("refuses a positive proof whose PEOPLE revision changes before acceptance", async () => {
    const h = harness();
    h.checkTaskPerson.mockImplementation(async () => {
      h.db.set({ pk: `DEVTASK#${TASK_ID}`, sk: "PEOPLE", schemaVersion: 1, revision: 4, orphaned: true,
        people: [{ developerId: OWNER, slackUserId: OWNER_SLACK, name: "Avery", role: "denied" }] });
      return {
        subject: { developerId: OWNER, slackUserId: OWNER_SLACK },
        identity: { developerId: OWNER, slackUserId: OWNER_SLACK, name: "Avery", method: "slack" as const, issuer: "https://slack.com", subject: OWNER_SLACK },
        eligible: true, channelMember: true,
      };
    });

    await expect(guardTaskDispatch({ documentClient: h.db, tableName: "state", checkTaskPerson: h.checkTaskPerson }, h.outbox)).resolves.toBe("PARKED");
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "OUTBOX")?.status).toBe("WAITING_FOR_TASK_ACCESS");
  });

  it("refuses ALLOWED when the shared admission expires during proof before the final State fence", async () => {
    const h = harness();
    let now = 1_000;
    const admission = createTaskAuthorityAdmission({ now: () => now, lambdaRemainingMs: 20_000 });
    h.checkTaskPerson.mockImplementation(async () => {
      now = admission.deadlineAt;
      return {
        subject: { developerId: OWNER, slackUserId: OWNER_SLACK },
        identity: { developerId: OWNER, slackUserId: OWNER_SLACK, name: "Avery", method: "slack" as const, issuer: "https://slack.com", subject: OWNER_SLACK },
        eligible: true, channelMember: true,
      };
    });

    await expect(guardTaskDispatch({ documentClient: h.db, tableName: "state", checkTaskPerson: h.checkTaskPerson, admission }, h.outbox))
      .rejects.toMatchObject({ code: "SLACK_UNAVAILABLE" });
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "OUTBOX")?.status).toBe("QUEUED");
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "TASK_ACCESS_PAUSE")).toBeUndefined();
  });

  it("retries rather than acknowledging if the pause reserve is exhausted", async () => {
    const h = harness();
    h.checkTaskPerson.mockResolvedValue({ ...(await h.checkTaskPerson()), eligible: false, channelMember: false });

    await expect(guardTaskDispatch({
      documentClient: h.db, tableName: "state", checkTaskPerson: h.checkTaskPerson, remainingTimeMs: () => 2_000,
    }, h.outbox)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "OUTBOX")?.status).toBe("QUEUED");
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "TASK_ACCESS_PAUSE")).toBeUndefined();
  });

  it("refuses normal delivery while a terminal workflow awaits its closedAt write", async () => {
    const h = harness();
    h.db.set({ ...h.current, workflow: { revision: 8, stage: "CLOSED", state: "COMPLETE", outcome: "REJECTED" } });

    await expect(guardTaskDispatch({ documentClient: h.db, tableName: "state", checkTaskPerson: h.checkTaskPerson }, h.outbox))
      .rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "OUTBOX")?.status).toBe("QUEUED");
  });

  it("durably parks PEOPLE work when proof is unconfigured and preserves operation identity", async () => {
    const h = harness();
    await expect(guardTaskDispatch({ documentClient: h.db, tableName: "state" }, h.outbox)).resolves.toBe("PARKED");
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "OUTBOX")).toMatchObject({ status: "WAITING_FOR_TASK_ACCESS", operationId: h.outbox.operationId, invocation: h.outbox.invocation });
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "TASK_ACCESS_PAUSE")).toMatchObject({ taskId: TASK_ID, peopleRevision: 3, reason: "PROOF_UNAVAILABLE" });
    expect(h.db.get(`DEVTASK#${TASK_ID}`, `TASK_ACCESS_PAUSE#${h.outbox.id}`)).toMatchObject({ operationId: h.outbox.operationId, workspaceId: WORKSPACE_ID });
  });

  it("parks ownerless work and a duplicate remains parked without another proof attempt", async () => {
    const h = harness();
    h.checkTaskPerson.mockResolvedValue({ ...(await h.checkTaskPerson()), eligible: false, channelMember: false });
    expect(await guardTaskDispatch({ documentClient: h.db, tableName: "state", checkTaskPerson: h.checkTaskPerson }, h.outbox)).toBe("PARKED");
    h.checkTaskPerson.mockClear();
    expect(await guardTaskDispatch({ documentClient: h.db, tableName: "state", checkTaskPerson: h.checkTaskPerson }, h.outbox)).toBe("PARKED");
    expect(h.checkTaskPerson).not.toHaveBeenCalled();
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "TASK_ACCESS_PAUSE")?.reason).toBe("OWNERLESS");
  });

  it("parks unknown proof without treating it as a departed owner", async () => {
    const h = harness();
    h.checkTaskPerson.mockRejectedValue(new Error("proof unavailable"));
    expect(await guardTaskDispatch({ documentClient: h.db, tableName: "state", checkTaskPerson: h.checkTaskPerson }, h.outbox)).toBe("PARKED");
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "TASK_ACCESS_PAUSE")?.reason).toBe("PROOF_UNAVAILABLE");
    expect(h.db.get(`DEVTASK#${TASK_ID}`, "PEOPLE")?.orphaned).toBe(false);
  });

  it("uses stable effective owner actor IDs", async () => {
    const h = harness();
    await guardTaskDispatch({ documentClient: h.db, tableName: "state", checkTaskPerson: h.checkTaskPerson }, h.outbox);
    expect(taskOwnerKey(OWNER, TASK_ID)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("redrives the exact parked invocation only after an explicit current-owner request", async () => {
    const h = harness();
    await guardTaskDispatch({ documentClient: h.db, tableName: "state" }, h.outbox);
    const original = structuredClone(h.db.get(`OUTBOX#${h.outbox.id}`, "OUTBOX"));
    const newOwner = "b".repeat(64);
    h.db.set({ pk: `DEVTASK#${TASK_ID}`, sk: "PEOPLE", schemaVersion: 1, revision: 4, orphaned: false,
      people: [{ developerId: newOwner, slackUserId: "U0NEWOWNER1", name: "Bailey", role: "owner" }] });
    const requestId = randomUUID();
    const payloadHash = "d".repeat(64);

    await expect(resumeTaskDispatch({ documentClient: h.db, tableName: "state", now: () => Date.parse("2026-10-11T10:05:00.000Z") }, {
      task: h.current, peopleRevision: 4, actorId: taskOwnerKey(newOwner, TASK_ID), requestId, payloadHash,
    })).resolves.toBe(true);

    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "OUTBOX")).toMatchObject({
      status: "PENDING", operationId: original?.operationId, invocation: original?.invocation,
    });
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "TASK_ACCESS_PAUSE")).toBeUndefined();
    expect(h.db.get(`DEVTASK#${TASK_ID}`, `TASK_ACCESS_RETRY#${requestId}`)).toMatchObject({
      actorId: taskOwnerKey(newOwner, TASK_ID), operationId: h.outbox.operationId, payloadHash,
    });
    await expect(resumeTaskDispatch({ documentClient: h.db, tableName: "state", now: () => Date.parse("2026-10-11T10:05:00.000Z") }, {
      task: h.current, peopleRevision: 4, actorId: taskOwnerKey(newOwner, TASK_ID), requestId, payloadHash,
    })).resolves.toBe(true);
    await expect(resumeTaskDispatch({ documentClient: h.db, tableName: "state", now: () => Date.parse("2026-10-11T10:05:00.000Z") }, {
      task: h.current, peopleRevision: 4, actorId: taskOwnerKey(newOwner, TASK_ID), requestId, payloadHash: "e".repeat(64),
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("reauthorizes the caller before a conditional historical redrive answer", async () => {
    const h = harness();
    await guardTaskDispatch({ documentClient: h.db, tableName: "state" }, h.outbox);
    const requestId = randomUUID();
    const send = h.db.send.bind(h.db);
    let current = true;
    h.db.send = async (command) => {
      if (command.constructor.name === "TransactWriteCommand" && JSON.stringify(command.input).includes("TASK_ACCESS_RETRY")) {
        await send(command);
        current = false;
        throw Object.assign(new Error("concurrent retry won"), { name: "TransactionCanceledException" });
      }
      return send(command);
    };

    await expect(resumeTaskDispatch({ documentClient: h.db, tableName: "state", now: () => Date.parse("2026-10-11T10:05:00.000Z") }, {
      task: h.current, peopleRevision: 3, actorId: taskOwnerKey(OWNER, TASK_ID), requestId, payloadHash: "d".repeat(64),
      reauthorize: async () => { if (!current) throw new Error("caller revoked"); },
    })).rejects.toThrow("caller revoked");
  });

  it("reauthorizes the caller before returning a prior redrive audit", async () => {
    const h = harness();
    await guardTaskDispatch({ documentClient: h.db, tableName: "state" }, h.outbox);
    const requestId = randomUUID();
    let current = true;
    const input = {
      task: h.current, peopleRevision: 3, actorId: taskOwnerKey(OWNER, TASK_ID), requestId, payloadHash: "d".repeat(64),
      reauthorize: async () => { if (!current) throw new Error("caller revoked"); },
    };
    await expect(resumeTaskDispatch({ documentClient: h.db, tableName: "state", now: () => Date.parse("2026-10-11T10:05:00.000Z") }, input as never)).resolves.toBe(true);
    current = false;
    await expect(resumeTaskDispatch({ documentClient: h.db, tableName: "state", now: () => Date.parse("2026-10-11T10:05:00.000Z") }, input as never)).rejects.toThrow("caller revoked");
  });
});

// Core keeps the same proof policy and pause records, with scoped workspace/outbox keys and a queue message body.
describe("core delivery access layout", () => {
  function coreHarness(ttlAttribute = "indexExpiresAt") {
    const h = harness();
    const companyId = `org_${"a".repeat(20)}`;
    const workspacePk = `ORG#${companyId}#WORKSPACE#${WORKSPACE_ID}`;
    h.current.companyId = companyId;
    h.db.set(h.current as unknown as Record<string, unknown>);
    for (const sk of ["META", "DEVELOPER_TASK", `OPERATION#${h.outbox.operationId}`]) h.db.set({ ...h.db.get(`WORKSPACE#${WORKSPACE_ID}`, sk), pk: workspacePk, sk, companyId });
    const outboxPk = `ORG#${companyId}#OUTBOX#${h.outbox.id}`;
    h.db.set({ pk: outboxPk, sk: "OUTBOX", entityType: "OUTBOX", companyId, id: h.outbox.id, status: "QUEUED", expiresAt: 100, [ttlAttribute]: 100, body: { v: 1, companyId, workspaceId: WORKSPACE_ID, operationId: h.outbox.operationId } });
    return { ...h, outboxPk, deps: { documentClient: h.db, tableName: "state", core: { companyId, workspacePk, ttlAttribute }, checkTaskPerson: h.checkTaskPerson } };
  }

  it("parks durably without expiring the outbox, and restoration alone never resumes", async () => {
    const h = coreHarness();
    h.checkTaskPerson.mockRejectedValue(new Error("proof unavailable"));
    expect(await guardTaskDispatch(h.deps, h.outbox)).toBe("PARKED");
    expect(h.db.get(h.outboxPk, "OUTBOX")).toMatchObject({ status: "WAITING_FOR_TASK_ACCESS" });
    expect(h.db.get(h.outboxPk, "OUTBOX")).not.toHaveProperty("expiresAt");
    expect(h.db.get(h.outboxPk, "OUTBOX")).not.toHaveProperty("indexExpiresAt");
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "TASK_ACCESS_PAUSE")).toMatchObject({ operationId: h.outbox.operationId, peopleRevision: 3 });
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "OUTBOX")?.status).toBe("QUEUED");
    h.checkTaskPerson.mockReset();
    expect(await guardTaskDispatch(h.deps, h.outbox)).toBe("PARKED");
  });

  it.each(["expiresAt", "queuedUntil"])("removes the store's %s expiry when access is paused", async (ttlAttribute) => {
    const h = coreHarness(ttlAttribute);
    h.checkTaskPerson.mockRejectedValue(new Error("proof unavailable"));
    expect(await guardTaskDispatch(h.deps, h.outbox)).toBe("PARKED");
    const parked = h.db.get(h.outboxPk, "OUTBOX");
    expect(parked).toMatchObject({ status: "WAITING_FOR_TASK_ACCESS" });
    expect(parked).not.toHaveProperty(ttlAttribute);
    expect(parked).not.toHaveProperty("expiresAt");
  });

  it("refuses a foreign company's task even when its workspace pointer is locally scoped", async () => {
    const h = coreHarness();
    h.db.set({ ...h.current, companyId: `org_${"b".repeat(20)}` });
    await expect(guardTaskDispatch(h.deps, h.outbox)).rejects.toMatchObject({ name: "TaskDispatchGuardRetryError" });
    expect(h.db.get(h.outboxPk, "OUTBOX")?.status).toBe("QUEUED");
  });

  it("does not acknowledge a pause that lost its People revision fence", async () => {
    const h = coreHarness();
    h.checkTaskPerson.mockImplementation(async () => { h.db.set({ ...h.db.get(`DEVTASK#${TASK_ID}`, "PEOPLE"), pk: `DEVTASK#${TASK_ID}`, sk: "PEOPLE", revision: 9 }); throw new Error("proof unavailable"); });
    await expect(guardTaskDispatch(h.deps, h.outbox)).rejects.toMatchObject({ name: "TaskDispatchGuardRetryError" });
    expect(h.db.get(h.outboxPk, "OUTBOX")?.status).toBe("QUEUED");
  });
});
