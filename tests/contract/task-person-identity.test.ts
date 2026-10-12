import { describe, expect, it, vi } from "vitest";
import { SLACK_OIDC_ISSUER, type TaskPersonProofRequest, type TaskPersonProofResponse } from "@agentx/contracts";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import * as taskPersonIdentity from "../../packages/broker/src/developer/task-person-identity.js";
import {
  resolveTaskPersonId,
  resolveTaskPickerPerson,
  type ProjectAccessSubject,
  type TaskPersonIdentityDependencies,
} from "../../packages/broker/src/developer/task-person-identity.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import type { DeveloperRecord } from "../../packages/broker/src/developer/store.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { T0, TEAM } from "../support/developer-fakes.js";

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const PERSON_1 = "22222222-2222-4222-8222-222222222222";
const PERSON_2 = "33333333-3333-4333-8333-333333333333";
const MAYA_SLACK = "U0MAYA001";
const MAYA_NATIVE = developerIdForSlackUser(MAYA_SLACK);
const EXTERNAL_ISSUER = "https://id.example.test";
const MAYA_EXTERNAL = ownerKeyForSubject(EXTERNAL_ISSUER, "maya-employee");
const checkTaskPersonIdentity = Reflect.get(taskPersonIdentity, "checkTaskPersonIdentity") as (
  deps: TaskPersonIdentityDependencies,
  task: DeveloperTaskRecord,
  developerId: string,
) => Promise<Record<string, unknown>>;

const task = {
  pk: `DEVTASK#${TASK_ID}`,
  sk: "META",
  entityType: "DEVELOPER_TASK",
  taskId: TASK_ID,
  developerId: MAYA_EXTERNAL,
  provider: "oidc",
  developerName: "Original creator",
  slackUserId: MAYA_SLACK,
  project: "payments-api",
  share: { teamId: TEAM, channelId: "C0PAY0001" },
} as DeveloperTaskRecord;

function harness(options: {
  proof?: (request: TaskPersonProofRequest) => Promise<TaskPersonProofResponse>;
  developer?: DeveloperRecord;
  uuid?: () => string;
} = {}) {
  const db = new FakeDynamoDb();
  db.set(task as unknown as Record<string, unknown>);
  const access = vi.fn(async (subject: ProjectAccessSubject, project: string, memberOf: readonly string[]) => {
    void [subject, project, memberOf];
  });
  const projectChannelIds = vi.fn(async () => ["C0PAY0001"]);
  const defaultProof = async (request: TaskPersonProofRequest): Promise<TaskPersonProofResponse> => ({
    ok: true as const,
    user: { id: request.slackUserId, teamId: TEAM, name: "Maya Chen" },
    memberOf: ["C0PAY0001"],
  });
  const proof = vi.fn(options.proof ?? defaultProof);
  const developerRecord = vi.fn(async (developerId: string) => developerId === options.developer?.developerId ? options.developer : undefined);
  const uuids = [PERSON_1, PERSON_2];
  const deps: TaskPersonIdentityDependencies = {
    documentClient: db,
    tableName: "state",
    slackTeamId: TEAM,
    now: () => T0,
    uuid: options.uuid ?? (() => uuids.shift() ?? PERSON_2),
    taskPersonProof: proof,
    developerRecord,
    projectChannelIds,
    targetProjectAccess: access,
  };
  return { db, deps, access, proof, developerRecord, projectChannelIds };
}

const externalDeveloper = (overrides: Partial<DeveloperRecord> = {}): DeveloperRecord => ({
  developerId: MAYA_EXTERNAL,
  provider: "oidc",
  issuer: EXTERNAL_ISSUER,
  subject: "maya-employee",
  displayName: "Maya Company",
  slackUserId: MAYA_SLACK,
  firstSignInAt: new Date(T0 - 1_000).toISOString(),
  lastSignInAt: new Date(T0).toISOString(),
  revoked: false,
  ...overrides,
});

describe("task person identity registry", () => {
  it("maps_picker_identity_without_creator_or_alias_substitution", async () => {
    const { db, deps, access, proof } = harness();

    const identity = await resolveTaskPickerPerson(deps, task, MAYA_SLACK);

    expect(identity).toEqual({
      developerId: MAYA_NATIVE,
      slackUserId: MAYA_SLACK,
      name: "Maya Chen",
      method: "slack",
      issuer: SLACK_OIDC_ISSUER,
      subject: MAYA_SLACK,
    });
    expect(identity.developerId).not.toBe(task.developerId);
    expect(proof).toHaveBeenCalledWith({ kind: "task-person-proof", slackUserId: MAYA_SLACK, channelIds: ["C0PAY0001"] });
    expect(access).toHaveBeenCalledWith({ developerId: MAYA_NATIVE, slackUserId: MAYA_SLACK }, task.project, ["C0PAY0001"]);
    expect(db.get(`DEVTASK#${TASK_ID}`, `PERSON#${PERSON_1}`)).toMatchObject({ schemaVersion: 1, personId: PERSON_1, developerId: MAYA_NATIVE });
    expect(db.get(`DEVTASK#${TASK_ID}`, `PERSON_SUBJECT#${MAYA_NATIVE}`)).toMatchObject({ schemaVersion: 1, personId: PERSON_1, developerId: MAYA_NATIVE });
    expect(db.find((item) => String(item.pk).startsWith("SESSION#") || String(item.pk).startsWith("DEVELOPER#"))).toEqual([]);
  });

  it("refuses_unresolvable_target_identity", async () => {
    const { db, deps, access } = harness({ proof: async () => ({ ok: false, error: "ineligible" }) });

    await expect(resolveTaskPickerPerson(deps, task, MAYA_SLACK)).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });

    expect(access).not.toHaveBeenCalled();
    expect(db.find((item) => String(item.sk).startsWith("PERSON"))).toEqual([]);
  });

  it("native_slack_and_slack_signin_page_mcp_share_owner_principal", async () => {
    const { db, deps, access } = harness();

    const [slack, signedIn] = await Promise.all([
      resolveTaskPickerPerson(deps, task, MAYA_SLACK),
      resolveTaskPickerPerson(deps, task, MAYA_SLACK),
    ]);

    expect(slack.developerId).toBe(MAYA_NATIVE);
    expect(signedIn.developerId).toBe(MAYA_NATIVE);
    expect(slack).toEqual(signedIn);
    expect(access.mock.calls.every(([subject]) => subject.developerId === MAYA_NATIVE)).toBe(true);
    expect(db.find((item) => String(item.sk).startsWith("PERSON#"))).toHaveLength(1);
    expect(db.find((item) => String(item.sk).startsWith("PERSON_SUBJECT#"))).toHaveLength(1);
  });

  it("external_linked_oidc_has_no_implicit_grant_union", async () => {
    const { db, deps, access } = harness({ developer: externalDeveloper(), uuid: () => PERSON_2 });
    db.set({
      pk: `DEVTASK#${TASK_ID}`, sk: `PERSON#${PERSON_1}`, schemaVersion: 1, personId: PERSON_1,
      developerId: MAYA_EXTERNAL, slackUserId: MAYA_SLACK, name: "Maya Company", method: "oidc",
      issuer: EXTERNAL_ISSUER, subject: "maya-employee", createdAt: new Date(T0).toISOString(),
    });
    db.set({ pk: `DEVTASK#${TASK_ID}`, sk: `PERSON_SUBJECT#${MAYA_EXTERNAL}`, schemaVersion: 1, personId: PERSON_1, developerId: MAYA_EXTERNAL, createdAt: new Date(T0).toISOString() });

    const external = await resolveTaskPersonId(deps, TASK_ID, PERSON_1);
    const native = await resolveTaskPickerPerson(deps, task, MAYA_SLACK);

    expect(external.developerId).toBe(MAYA_EXTERNAL);
    expect(native.developerId).toBe(MAYA_NATIVE);
    expect(external.developerId).not.toBe(native.developerId);
    expect(access.mock.calls.map(([subject]) => subject.developerId)).toEqual([MAYA_EXTERNAL, MAYA_NATIVE]);
    expect(db.find((item) => String(item.sk).startsWith("PERSON#"))).toHaveLength(2);
  });

  it("strongly validates task, person, reverse mapping, and external developer linkage", async () => {
    const corruptions: Array<(db: FakeDynamoDb) => void> = [
      (db) => db.set({ pk: `DEVTASK#${TASK_ID}`, sk: `PERSON#${PERSON_1}`, schemaVersion: 1, personId: PERSON_1, developerId: MAYA_EXTERNAL, slackUserId: MAYA_SLACK, name: "Maya Company", method: "oidc", issuer: EXTERNAL_ISSUER, subject: "maya-employee", createdAt: new Date(T0).toISOString() }),
      (db) => {
        db.set({ pk: `DEVTASK#${TASK_ID}`, sk: `PERSON#${PERSON_1}`, schemaVersion: 1, personId: PERSON_1, developerId: MAYA_EXTERNAL, slackUserId: MAYA_SLACK, name: "Maya Company", method: "oidc", issuer: EXTERNAL_ISSUER, subject: "maya-employee", createdAt: new Date(T0).toISOString() });
        db.set({ pk: `DEVTASK#${TASK_ID}`, sk: `PERSON_SUBJECT#${MAYA_EXTERNAL}`, schemaVersion: 1, personId: PERSON_2, developerId: MAYA_EXTERNAL, createdAt: new Date(T0).toISOString() });
      },
      (db) => {
        db.set({ pk: `DEVTASK#${TASK_ID}`, sk: `PERSON#${PERSON_1}`, schemaVersion: 1, personId: PERSON_1, developerId: MAYA_EXTERNAL, slackUserId: MAYA_SLACK, name: "Maya Company", method: "oidc", issuer: EXTERNAL_ISSUER, subject: "different", createdAt: new Date(T0).toISOString() });
        db.set({ pk: `DEVTASK#${TASK_ID}`, sk: `PERSON_SUBJECT#${MAYA_EXTERNAL}`, schemaVersion: 1, personId: PERSON_1, developerId: MAYA_EXTERNAL, createdAt: new Date(T0).toISOString() });
      },
    ];
    for (const corrupt of corruptions) {
      const { db, deps } = harness({ developer: externalDeveloper() });
      corrupt(db);
      await expect(resolveTaskPersonId(deps, TASK_ID, PERSON_1)).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
    }

    const revoked = harness({ developer: externalDeveloper({ revoked: true }) });
    revoked.db.set({ pk: `DEVTASK#${TASK_ID}`, sk: `PERSON#${PERSON_1}`, schemaVersion: 1, personId: PERSON_1, developerId: MAYA_EXTERNAL, slackUserId: MAYA_SLACK, name: "Maya Company", method: "oidc", issuer: EXTERNAL_ISSUER, subject: "maya-employee", createdAt: new Date(T0).toISOString() });
    revoked.db.set({ pk: `DEVTASK#${TASK_ID}`, sk: `PERSON_SUBJECT#${MAYA_EXTERNAL}`, schemaVersion: 1, personId: PERSON_1, developerId: MAYA_EXTERNAL, createdAt: new Date(T0).toISOString() });
    await expect(resolveTaskPersonId(revoked.deps, TASK_ID, PERSON_1)).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });

    const malformed = harness({ developer: externalDeveloper({ revoked: undefined as unknown as boolean }) });
    malformed.db.set({ pk: `DEVTASK#${TASK_ID}`, sk: `PERSON#${PERSON_1}`, schemaVersion: 1, personId: PERSON_1, developerId: MAYA_EXTERNAL, slackUserId: MAYA_SLACK, name: "Maya Company", method: "oidc", issuer: EXTERNAL_ISSUER, subject: "maya-employee", createdAt: new Date(T0).toISOString() });
    malformed.db.set({ pk: `DEVTASK#${TASK_ID}`, sk: `PERSON_SUBJECT#${MAYA_EXTERNAL}`, schemaVersion: 1, personId: PERSON_1, developerId: MAYA_EXTERNAL, createdAt: new Date(T0).toISOString() });
    await expect(resolveTaskPersonId(malformed.deps, TASK_ID, PERSON_1)).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
  });

  it("fails closed on missing capability, mismatched team, or out-of-scope membership", async () => {
    const missing = harness();
    (missing.deps as { taskPersonProof?: unknown }).taskPersonProof = undefined;
    await expect(resolveTaskPickerPerson(missing.deps, task, MAYA_SLACK)).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });

    for (const proof of [
      async () => ({ ok: true as const, user: { id: MAYA_SLACK, teamId: "T0OTHER1", name: "Maya" }, memberOf: ["C0PAY0001"] }),
      async () => ({ ok: true as const, user: { id: MAYA_SLACK, teamId: TEAM, name: "Maya" }, memberOf: ["C0OTHER01"] }),
    ]) {
      const h = harness({ proof });
      await expect(resolveTaskPickerPerson(h.deps, task, MAYA_SLACK)).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
      expect(h.access).not.toHaveBeenCalled();
    }
  });

  it("qualifies a native creator by developer ID without creating registry or sign-in rows", async () => {
    const nativeTask = { ...task, developerId: MAYA_NATIVE, provider: "slack" as const };
    const h = harness();
    h.db.set(nativeTask);

    await expect(checkTaskPersonIdentity(h.deps, nativeTask, MAYA_NATIVE)).resolves.toMatchObject({
      subject: { developerId: MAYA_NATIVE, slackUserId: MAYA_SLACK },
      identity: { developerId: MAYA_NATIVE, method: "slack", issuer: SLACK_OIDC_ISSUER, subject: MAYA_SLACK },
      eligible: true,
      channelMember: true,
    });

    expect(h.db.find((item) => String(item.sk).startsWith("PERSON"))).toEqual([]);
    expect(h.db.find((item) => String(item.pk).startsWith("SESSION#") || String(item.pk).startsWith("DEVELOPER#"))).toEqual([]);
  });

  it("qualifies the exact trusted native current actor without persisting an identity", async () => {
    const actorSlack = "U0ACTOR001";
    const actorDeveloperId = developerIdForSlackUser(actorSlack);
    const h = harness({ proof: async (request) => ({
      ok: true, user: { id: request.slackUserId, teamId: TEAM, name: "Current Actor" }, memberOf: ["C0PAY0001"],
    }) });
    Reflect.set(h.deps, "trustedCaller", { developerId: actorDeveloperId, sessionId: "s-current", amr: "slack", name: "Current Actor", slackUserId: actorSlack });

    await expect(checkTaskPersonIdentity(h.deps, task, actorDeveloperId)).resolves.toMatchObject({
      subject: { developerId: actorDeveloperId, slackUserId: actorSlack },
      identity: { developerId: actorDeveloperId, method: "slack", issuer: SLACK_OIDC_ISSUER, subject: actorSlack },
      eligible: true,
    });
    expect(h.db.find((item) => String(item.sk).startsWith("PERSON") || String(item.pk).startsWith("SESSION#"))).toEqual([]);
  });

  it("uses the immutable external identity and separates definite loss from unavailable proof", async () => {
    const lost = harness({ developer: externalDeveloper(), proof: async () => ({ ok: false, error: "ineligible" }) });
    await expect(checkTaskPersonIdentity(lost.deps, task, MAYA_EXTERNAL)).resolves.toMatchObject({
      subject: { developerId: MAYA_EXTERNAL, slackUserId: MAYA_SLACK },
      identity: { developerId: MAYA_EXTERNAL, method: "oidc", issuer: EXTERNAL_ISSUER, subject: "maya-employee" },
      eligible: false,
      channelMember: false,
    });
    expect(lost.db.find((item) => String(item.sk).startsWith("PERSON"))).toEqual([]);

    const unavailable = harness({ developer: externalDeveloper(), proof: async () => ({ ok: false, error: "slack_unavailable" }) });
    await expect(checkTaskPersonIdentity(unavailable.deps, task, MAYA_EXTERNAL)).rejects.toMatchObject({ code: "SLACK_UNAVAILABLE" });
    expect(unavailable.db.find((item) => String(item.sk).startsWith("PERSON"))).toEqual([]);
  });

  it("requests fresh proof for project bindings and the task share channel", async () => {
    const shareChannel = "C0SHARE01";
    const sharedTask = { ...task, share: { ...task.share!, channelId: shareChannel } };
    const h = harness({ developer: externalDeveloper(), proof: async (request) => ({
      ok: true,
      user: { id: request.slackUserId, teamId: TEAM, name: "Maya Chen" },
      memberOf: ["C0PAY0001", shareChannel],
    }) });
    h.db.set(sharedTask);

    await expect(checkTaskPersonIdentity(h.deps, sharedTask, MAYA_EXTERNAL)).resolves.toMatchObject({ eligible: true, channelMember: true });
    expect(h.proof).toHaveBeenCalledWith({ kind: "task-person-proof", slackUserId: MAYA_SLACK, channelIds: ["C0PAY0001", shareChannel].sort() });
    expect(h.access).toHaveBeenCalledWith({ developerId: MAYA_EXTERNAL, slackUserId: MAYA_SLACK }, task.project, ["C0PAY0001", shareChannel]);
  });
});
