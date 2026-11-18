import { GetCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { IMPLICIT_COMPANY_ID, SLACK_OIDC_ISSUER } from "@agentx/contracts";
import { describe, expect, it, vi } from "vitest";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { createTaskAuthorityAdmission } from "../../packages/broker/src/aws/task-authority-admission.js";
import { createTaskPersonRuntime, taskPersonLatestRevisionQuery, taskPersonNamedLatestRevision, taskPersonRevisionFromResponse, TASK_PERSON_COMPANY_MEMBER_ATTRIBUTES, TASK_PERSON_DEVELOPER_RECORD_ATTRIBUTES, type TaskPersonRuntimePorts } from "../../packages/broker/src/aws/task-person-runtime.js";
import { checkTaskPersonIdentity } from "../../packages/broker/src/developer/task-person-identity.js";
import { evaluateProjectAuthority } from "../../packages/broker/src/developer/task-project-access.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { taskOwnerKey, type DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";

const taskId = "11111111-1111-4111-8111-111111111111";
const slackUserId = "U0123456789";
const slackTeamId = "T0123456789";
const channelId = "C0123456789";
const nativeDeveloperId = developerIdForSlackUser(slackUserId);

function nativeTask(): DeveloperTaskRecord {
  return {
    pk: `DEVTASK#${taskId}`, sk: "META", entityType: "DEVELOPER_TASK", taskId,
    developerId: nativeDeveloperId, provider: "slack", developerName: "Maya", slackUserId,
    project: "payments-api", share: { teamId: slackTeamId, channelId },
  } as DeveloperTaskRecord;
}

function ports(input: { task?: DeveloperTaskRecord; memberOf?: string[]; developerRecord?: unknown; personRecords?: Record<string, unknown>[] } = {}) {
  const task = input.task ?? nativeTask();
  const readTaskRecord = vi.fn(async ({ sortKey }: { taskId: string; sortKey: string }) => sortKey === "META"
    ? task as unknown as Record<string, unknown>
    : input.personRecords?.find((record) => record.sk === sortKey));
  const readDeveloperRecord = vi.fn<TaskPersonRuntimePorts["readDeveloperRecord"]>(async (request) => {
    void request;
    return input.developerRecord as never;
  });
  const projectAuthorityReader = {
    latestRevision: vi.fn(async (_project: string, _admission: unknown, signal: AbortSignal, company?: string) => (void company, {
      revision: { pk: "PROJECT#payments-api", sk: "REV#000000000007", revision: 7, definition: {} }, complete: !signal.aborted,
    })),
    memberships: vi.fn(async (_developerId: string, _admission: unknown, signal: AbortSignal) => ({ items: [], complete: !signal.aborted })),
    bindings: vi.fn(async (_teamId: string, _admission: unknown, signal: AbortSignal) => ({
      items: [{ pk: `SLACK_BINDING#${slackTeamId}`, sk: `CHANNEL#${channelId}`, teamId: slackTeamId, channelId, projectName: "payments-api", updatedAt: "2026-01-01T00:00:00.000Z" }], complete: !signal.aborted,
    })),
  };
  const taskPersonProof = vi.fn<TaskPersonRuntimePorts["taskPersonProof"]>(async (request, admission) => {
    void request;
    void admission;
    return {
    result: { ok: true as const, user: { id: slackUserId, teamId: slackTeamId, name: "Maya" }, memberOf: input.memberOf ?? [channelId] },
    slackCallsUsed: 1,
  };
  });
  return { readTaskRecord, readDeveloperRecord, projectAuthorityReader, taskPersonProof } as unknown as TaskPersonRuntimePorts & {
    readTaskRecord: typeof readTaskRecord;
    readDeveloperRecord: typeof readDeveloperRecord;
    projectAuthorityReader: typeof projectAuthorityReader;
    taskPersonProof: typeof taskPersonProof;
  };
}

const runtime = (admission: ReturnType<typeof createTaskAuthorityAdmission>, testPorts: TaskPersonRuntimePorts) => createTaskPersonRuntime({
  admission, ports: testPorts, stateTableName: "state", slackTeamId, now: () => 1_000,
  uuid: () => "22222222-2222-4222-8222-222222222222",
});

describe("task person runtime factory", () => {
  it("checks a native person with fresh bounded proof and project authority", async () => {
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    const injected = ports();
    const checker = runtime(admission, injected);

    await expect(checker.checkTaskPerson(nativeTask(), nativeDeveloperId)).resolves.toMatchObject({
      eligible: true,
      identity: { developerId: nativeDeveloperId, method: "slack", slackUserId },
    });

    expect(injected.readTaskRecord.mock.calls.map(([request]) => request.sortKey)).toEqual(["META", `PERSON_SUBJECT#${nativeDeveloperId}`]);
    expect(injected.readDeveloperRecord.mock.calls).toHaveLength(0);
    expect(injected.taskPersonProof.mock.calls).toEqual([[
      { kind: "task-person-proof", slackUserId, channelIds: [channelId] }, admission,
    ]]);
    expect(admission.remainingSlackCalls()).toBe(99);
  });

  it("keeps one proof admission binding stable across repeated owner checks", async () => {
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    const injected = ports();
    const checker = runtime(admission, injected);
    await checker.checkTaskPerson(nativeTask(), nativeDeveloperId);
    await checker.checkTaskPerson(nativeTask(), nativeDeveloperId);

    expect(injected.taskPersonProof.mock.calls).toHaveLength(2);
    expect(injected.taskPersonProof.mock.calls[0]?.[1].id).toBe(admission.id);
    expect(injected.taskPersonProof.mock.calls[1]?.[1].id).toBe(admission.id);
    expect(admission.remainingSlackCalls()).toBe(98);
  });

  it("exposes a keyed positive State witness only after a fresh final project revision read", async () => {
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    const injected = ports();
    const checker = runtime(admission, injected);
    await checker.checkTaskPerson(nativeTask(), nativeDeveloperId);

    await expect(checker.stateAuthorityWitnessForOwnerActor(nativeTask(), taskOwnerKey(nativeDeveloperId, taskId))).resolves.toMatchObject({
      taskId, developerId: nativeDeveloperId, project: "payments-api", access: "channel",
      projectRevision: { pk: "PROJECT#payments-api", sk: "REV#000000000007", revision: 7, developerTasksPresent: false },
      binding: { pk: `SLACK_BINDING#${slackTeamId}`, sk: `CHANNEL#${channelId}`, teamId: slackTeamId, channelId, projectName: "payments-api" },
    });
    expect(injected.projectAuthorityReader.latestRevision.mock.calls).toHaveLength(2);

    injected.projectAuthorityReader.latestRevision.mockImplementationOnce(async () => ({
      revision: { pk: "PROJECT#payments-api", sk: "REV#000000000008", revision: 8, definition: {} }, complete: true,
    }));
    await expect(checker.stateAuthorityWitnessForOwnerActor(nativeTask(), taskOwnerKey(nativeDeveloperId, taskId))).resolves.toBeUndefined();

    await checker.checkTaskPerson(nativeTask(), nativeDeveloperId);
    injected.projectAuthorityReader.latestRevision.mockImplementationOnce(async () => ({
      revision: { pk: "PROJECT#payments-api", sk: "REV#000000000007", revision: 7, definition: { developerTasks: { enabled: false } } }, complete: true,
    }));
    await expect(checker.stateAuthorityWitnessForOwnerActor(nativeTask(), taskOwnerKey(nativeDeveloperId, taskId))).resolves.toBeUndefined();
  });

  it("refuses a missing or mismatched current-owner witness", async () => {
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    const checker = runtime(admission, ports());
    await expect(checker.stateAuthorityWitnessForOwnerActor(nativeTask(), taskOwnerKey(nativeDeveloperId, taskId))).resolves.toBeUndefined();
    await checker.checkTaskPerson(nativeTask(), nativeDeveloperId);
    await expect(checker.stateAuthorityWitnessForOwnerActor(nativeTask(), taskOwnerKey("b".repeat(64), taskId))).resolves.toBeUndefined();
  });

  it("keeps target eligibility separate from the in-channel Owner witness", async () => {
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    const injected = ports({ memberOf: [] });
    injected.projectAuthorityReader.memberships.mockResolvedValue({
      items: [{ pk: `MEMBER#${nativeDeveloperId}`, sk: "PROJECT#payments-api", projectName: "payments-api", role: "developer" }] as never,
      complete: true,
    });
    const checker = runtime(admission, injected);
    const eligibility = await checker.checkTaskPerson(nativeTask(), nativeDeveloperId);
    expect(eligibility).toMatchObject({ eligible: true, channelMember: false });
    await expect(checker.stateAuthorityWitnessForOwnerActor(nativeTask(), taskOwnerKey(nativeDeveloperId, taskId))).resolves.toBeUndefined();

    await expect(checker.stateAuthorityWitnessForEligiblePerson(nativeTask(), nativeDeveloperId)).resolves.toMatchObject({
      taskId, developerId: nativeDeveloperId, project: "payments-api", access: "granted",
      membership: { pk: `MEMBER#${nativeDeveloperId}`, sk: "PROJECT#payments-api", projectName: "payments-api", role: "developer" },
      projectRevision: { pk: "PROJECT#payments-api", sk: "REV#000000000007", revision: 7, developerTasksPresent: false },
    });
  });

  it.each(["project revision", "developer grant", "channel binding"] as const)("refuses a positive authority read with missing %s State keys", async (missing) => {
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    const injected = ports();
    if (missing === "project revision") {
      injected.projectAuthorityReader.latestRevision.mockResolvedValueOnce({
        revision: { revision: 7, definition: {} }, complete: true,
      } as never);
    } else if (missing === "developer grant") {
      injected.projectAuthorityReader.memberships.mockResolvedValueOnce({
        items: [{ projectName: "payments-api", role: "developer" }], complete: true,
      } as never);
    } else {
      injected.projectAuthorityReader.bindings.mockResolvedValue({
        items: [{ teamId: slackTeamId, channelId, projectName: "payments-api", updatedAt: "2026-01-01T00:00:00.000Z" }], complete: true,
      } as never);
    }
    await expect(runtime(admission, injected).checkTaskPerson(nativeTask(), nativeDeveloperId)).rejects.toMatchObject({ code: "SLACK_UNAVAILABLE" });
  });

  it.each(["tasks-disabled", "not-found"] as const)("does not qualify %s project authority as definite identity loss", async (mode) => {
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    const injected = ports();
    if (mode === "not-found") {
      injected.projectAuthorityReader.latestRevision.mockResolvedValue({ revision: undefined, complete: true } as never);
    } else {
      injected.projectAuthorityReader.latestRevision.mockResolvedValue({
        revision: { pk: "PROJECT#payments-api", sk: "REV#000000000007", revision: 7, definition: { developerTasks: { enabled: false, channelMembersMayUse: true } } }, complete: true,
      });
    }

    await expect(runtime(admission, injected).checkTaskPerson(nativeTask(), nativeDeveloperId)).rejects.toMatchObject({ code: "SLACK_UNAVAILABLE" });
  });

  it("does not call the injected proof when Slack allowance is exhausted", async () => {
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    admission.recordSlackUsage(100);
    const injected = ports();

    await expect(runtime(admission, injected).checkTaskPerson(nativeTask(), nativeDeveloperId)).rejects.toMatchObject({ code: "SLACK_UNAVAILABLE" });
    expect(injected.taskPersonProof.mock.calls).toHaveLength(0);
  });

  it.each([
    ["eligible", { ok: true, user: { id: slackUserId, teamId: slackTeamId, name: "Maya" }, memberOf: [channelId] }],
    ["definitely ineligible", { ok: false, error: "ineligible" }],
  ] as const)("rejects a %s proof with impossible zero measured Slack calls", async (_name, result) => {
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    const injected = ports();
    injected.taskPersonProof.mockImplementation(async () => ({ result, slackCallsUsed: 0 }) as never);

    await expect(runtime(admission, injected).checkTaskPerson(nativeTask(), nativeDeveloperId)).rejects.toMatchObject({ code: "SLACK_UNAVAILABLE" });
  });

  it("reads a person row only after its reverse subject row links that person", async () => {
    const personId = "22222222-2222-4222-8222-222222222222";
    const createdAt = "2026-01-01T00:00:00.000Z";
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    const injected = ports({ personRecords: [
      {
        pk: `DEVTASK#${taskId}`, sk: `PERSON_SUBJECT#${nativeDeveloperId}`, schemaVersion: 1,
        personId, developerId: nativeDeveloperId, createdAt,
      },
      {
        pk: `DEVTASK#${taskId}`, sk: `PERSON#${personId}`, schemaVersion: 1,
        personId, developerId: nativeDeveloperId, slackUserId, name: "Maya", method: "slack",
        issuer: SLACK_OIDC_ISSUER, subject: slackUserId, createdAt,
      },
    ] });

    await expect(runtime(admission, injected).checkTaskPerson(nativeTask(), nativeDeveloperId)).resolves.toMatchObject({ eligible: true });

    expect(injected.readTaskRecord.mock.calls.map(([request]) => request.sortKey)).toEqual([
      "META", `PERSON_SUBJECT#${nativeDeveloperId}`, `PERSON#${personId}`, `PERSON_SUBJECT#${nativeDeveloperId}`,
    ]);
  });

  it("projects only the approved Developer fields for an external principal", async () => {
    const issuer = "https://identity.example.com";
    const subject = "subject-123";
    const externalDeveloperId = ownerKeyForSubject(issuer, subject);
    const task = { ...nativeTask(), developerId: externalDeveloperId, provider: "oidc" } as DeveloperTaskRecord;
    const record = {
      pk: `DEVELOPER#${externalDeveloperId}`, sk: "META", developerId: externalDeveloperId,
      provider: "oidc", issuer, subject, slackUserId, revoked: false, displayName: "Maya", email: "ignored@example.com",
    };
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    const injected = ports({ task, developerRecord: record });
    const checkIdentity = vi.fn(async (dependencies: Parameters<typeof checkTaskPersonIdentity>[0], checkedTask: DeveloperTaskRecord, checkedDeveloperId: string) => {
      const projected = await dependencies.developerRecord(checkedDeveloperId);
      expect(projected).not.toHaveProperty("email");
      return checkTaskPersonIdentity(dependencies, checkedTask, checkedDeveloperId);
    });
    const checker = createTaskPersonRuntime({
      admission, ports: injected, stateTableName: "state", slackTeamId, now: () => 1_000,
      uuid: () => "22222222-2222-4222-8222-222222222222", checkIdentity,
    });

    await expect(checker.checkTaskPerson(task, externalDeveloperId)).resolves.toMatchObject({
      eligible: true,
      identity: { developerId: externalDeveloperId, method: "oidc", issuer, subject, slackUserId },
    });

    const developerReads = injected.readDeveloperRecord.mock.calls;
    expect(developerReads).toHaveLength(3);
    expect(developerReads[0]?.[0]).toMatchObject({
      developerId: externalDeveloperId,
      consistentRead: true,
      projection: TASK_PERSON_DEVELOPER_RECORD_ATTRIBUTES,
    });
    expect(developerReads[0]?.[0].abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("refuses arbitrary row commands and Scan before any State read", async () => {
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    const injected = ports();
    const checker = createTaskPersonRuntime({
      admission, ports: injected, stateTableName: "state", slackTeamId, now: () => 1_000,
      uuid: () => "22222222-2222-4222-8222-222222222222",
      checkIdentity: async (dependencies) => {
        await dependencies.documentClient.send(new ScanCommand({ TableName: "state" }));
        return undefined as never;
      },
    });

    await expect(checker.checkTaskPerson(nativeTask(), nativeDeveloperId)).rejects.toMatchObject({ code: "SLACK_UNAVAILABLE" });
    expect(injected.readTaskRecord.mock.calls).toHaveLength(0);
  });

  it("refuses an unlinked PERSON row before issuing a State read", async () => {
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    const injected = ports();
    const checker = createTaskPersonRuntime({
      admission, ports: injected, stateTableName: "state", slackTeamId, now: () => 1_000,
      uuid: () => "22222222-2222-4222-8222-222222222222",
      checkIdentity: async (dependencies) => {
        await dependencies.documentClient.send(new GetCommand({
          TableName: "state", Key: { pk: `DEVTASK#${taskId}`, sk: "PERSON#22222222-2222-4222-8222-222222222222" }, ConsistentRead: true,
        }));
        return undefined as never;
      },
    });

    await expect(checker.checkTaskPerson(nativeTask(), nativeDeveloperId)).rejects.toMatchObject({ code: "SLACK_UNAVAILABLE" });
    expect(injected.readTaskRecord.mock.calls).toHaveLength(0);
  });

  it("rejects an invalid developer identity before calling injected State ports", async () => {
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    const injected = ports();

    await expect(runtime(admission, injected).checkTaskPerson(nativeTask(), "invalid")).rejects.toThrow();
    expect(injected.readTaskRecord.mock.calls).toHaveLength(0);
    expect(admission.checkedIdentityCount()).toBe(0);
  });
});

it("derives proof scope from each task's company/team, not the installation team", async () => {
  for (const [companyId, teamId] of [["org_aaaaaaaaaaaaaaaaaaaa", "T0AAAAAAA"], ["org_bbbbbbbbbbbbbbbbbbbb", "T0BBBBBBB"]]) {
    const task = { ...nativeTask(), companyId, share: { ...nativeTask().share!, teamId: teamId! } };
    const testPorts = ports({ task });
    testPorts.projectAuthorityReader.bindings.mockImplementation(async (team, _admission, signal) => ({ items: [{ pk: `SLACK_BINDING#${team}`, sk: `CHANNEL#${channelId}`, teamId: team, channelId, projectName: task.project, updatedAt: "2026-01-01T00:00:00.000Z" }], complete: !signal.aborted }));
    testPorts.taskPersonProof.mockImplementation(async (request) => ({ result: { ok: true, user: { id: slackUserId, teamId: request.workspace?.teamId ?? "T0INSTALL", name: "Maya" }, memberOf: [channelId] }, slackCallsUsed: 1 }));
    const admission = createTaskAuthorityAdmission({ now: () => 1000, lambdaRemainingMs: 20000 });
    const scoped = createTaskPersonRuntime({ admission, ports: testPorts, stateTableName: "state", slackTeamId: "T0INSTALL", now: () => 1000, uuid: () => "22222222-2222-4222-8222-222222222222", workspaces: { requireCompany: async () => companyId! } });
    await scoped.checkTaskPerson(task, nativeDeveloperId);
    expect(testPorts.taskPersonProof.mock.calls[0]?.[0]).toMatchObject({ workspace: { companyId, teamId } });
    expect(testPorts.projectAuthorityReader.bindings.mock.calls[0]?.[0]).toBe(teamId);
  }
});

// Web task channel C2 (plan 4.1, 4.2 "Proof"): the bounded runtime proves a `web` identity with state reads only (its sign-in record,
// COMPANY_MEMBER#<id> and the project grant), zero Slack calls, and is never refused for an empty Slack allowance.
describe("task person runtime: the web proof", () => {
  const ghIssuer = "https://github.com";
  const webDeveloperId = ownerKeyForSubject(ghIssuer, "gh-77");
  const personId = "33333333-3333-4333-8333-333333333333";
  const createdAt = "2026-01-01T00:00:00.000Z";
  const companyA = `org_${"a".repeat(20)}`;
  const companyB = `org_${"b".repeat(20)}`;
  const webTask = () => ({ ...nativeTask(), companyId: companyA }) as DeveloperTaskRecord;
  /** `revisionCompany`: the company the project revision row names (the default is the task's company; `"unstamped"` leaves it out, as a row of the implicit company does). */
  const webPorts = (options: { membership?: Record<string, unknown> | "throw" | undefined; grantRole?: string; channelPolicy?: boolean; revisionCompany?: unknown } = {}) => {
    const injected = ports({
      task: webTask(),
      developerRecord: { pk: `DEVELOPER#${webDeveloperId}`, sk: "META", developerId: webDeveloperId, provider: "github", issuer: ghIssuer, subject: "gh-77", revoked: false, displayName: "Gale" },
      personRecords: [
        { pk: `DEVTASK#${taskId}`, sk: `PERSON_SUBJECT#${webDeveloperId}`, schemaVersion: 1, personId, developerId: webDeveloperId, createdAt },
        { pk: `DEVTASK#${taskId}`, sk: `PERSON#${personId}`, schemaVersion: 1, personId, developerId: webDeveloperId, name: "Gale", method: "github", issuer: ghIssuer, subject: "gh-77", createdAt },
      ],
    });
    const membership = "membership" in options ? options.membership : {
      pk: `COMPANY_MEMBER#${webDeveloperId}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: webDeveloperId, companyId: companyA, role: "member", joinedAt: createdAt,
    };
    const readCompanyMembership = vi.fn<NonNullable<TaskPersonRuntimePorts["readCompanyMembership"]>>(async () => {
      if (membership === "throw") throw new Error("down");
      return membership;
    });
    injected.projectAuthorityReader.memberships.mockImplementation(async (_developerId, _admission, signal) => ({
      items: (options.grantRole === "none" ? [] : [{ pk: `MEMBER#${webDeveloperId}`, sk: "PROJECT#payments-api", projectName: "payments-api", role: options.grantRole ?? "developer" }]) as never[],
      complete: !signal.aborted,
    }));
    const revisionCompany = "revisionCompany" in options ? options.revisionCompany : companyA;
    // DEC 254zzz80: the reader is asked for the task company's partition; a named company's revision key is its own partition's.
    injected.projectAuthorityReader.latestRevision.mockImplementation(async (_project, _admission, signal, company?: string) => ({
      revision: {
        pk: company === undefined ? "PROJECT#payments-api" : `ORG#${company}#PROJECT#payments-api`, sk: "REV#000000000007", revision: 7,
        ...(revisionCompany === "unstamped" ? {} : { companyId: revisionCompany }),
        definition: options.channelPolicy === true ? { developerTasks: { enabled: true, channelMembersMayUse: true } } : {},
      }, complete: !signal.aborted,
    }));
    return Object.assign(injected, { readCompanyMembership });
  };

  it("proves a web person with state reads only, zero Slack calls, even with no Slack allowance left", async () => {
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    admission.recordSlackUsage(100);
    const injected = webPorts();
    const before = admission.remainingStateReads();
    const checker = runtime(admission, injected);
    await expect(checker.checkTaskPerson(webTask(), webDeveloperId)).resolves.toMatchObject({
      subject: { developerId: webDeveloperId }, eligible: true, channelMember: true, identity: { developerId: webDeveloperId, method: "github" },
    });
    expect(injected.taskPersonProof.mock.calls).toHaveLength(0);
    expect(injected.projectAuthorityReader.bindings.mock.calls).toHaveLength(0);
    expect(injected.readCompanyMembership.mock.calls).toHaveLength(1);
    expect(injected.readCompanyMembership.mock.calls[0]?.[0]).toMatchObject({ developerId: webDeveloperId, consistentRead: true, projection: TASK_PERSON_COMPANY_MEMBER_ATTRIBUTES });
    expect(injected.readCompanyMembership.mock.calls[0]?.[0].abortSignal).toBeInstanceOf(AbortSignal);
    // META, PERSON_SUBJECT, PERSON, PERSON_SUBJECT, the sign-in record, the membership, the project revision and the grants (no channel bindings).
    expect(before - admission.remainingStateReads()).toBe(8);
    // The owner witness is the grant's, so a present web owner can authorize a system-started step.
    await expect(checker.stateAuthorityWitnessForOwnerActor(webTask(), taskOwnerKey(webDeveloperId, taskId))).resolves.toMatchObject({
      developerId: webDeveloperId, access: "granted", membership: { pk: `MEMBER#${webDeveloperId}`, sk: "PROJECT#payments-api", role: "developer" },
    });
  });

  it.each([
    ["no membership row", { membership: undefined }],
    ["a revoked membership", { membership: {
      pk: `COMPANY_MEMBER#${webDeveloperId}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: webDeveloperId, companyId: companyA, role: "member", joinedAt: createdAt, revokedAt: createdAt,
    } }],
    ["no grant", { grantRole: "none" }],
    ["channel-only access (no grant, channel members may use the project, and a bound channel)", { grantRole: "none", channelPolicy: true }],
  ])("finds a proven loss with %s", async (_label, options) => {
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    const injected = webPorts(options);
    await expect(runtime(admission, injected).checkTaskPerson(webTask(), webDeveloperId)).resolves.toMatchObject({ eligible: false, channelMember: false });
    expect(injected.taskPersonProof.mock.calls).toHaveLength(0);
  });

  it("never makes a company B member eligible on company A's task", async () => {
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    const injected = webPorts({ membership: {
      pk: `COMPANY_MEMBER#${webDeveloperId}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: webDeveloperId, companyId: companyB, role: "owner", joinedAt: createdAt,
    } });
    await expect(runtime(admission, injected).checkTaskPerson(webTask(), webDeveloperId)).resolves.toMatchObject({ eligible: false, channelMember: false });
  });

  it.each([
    ["the membership read fails", { membership: "throw" as const }],
    ["the membership row is under another key", { membership: { pk: "COMPANY_MEMBER#someone-else", sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: webDeveloperId, companyId: companyA, role: "member", joinedAt: createdAt } }],
    ["the membership row does not parse", { membership: { pk: `COMPANY_MEMBER#${webDeveloperId}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: webDeveloperId, companyId: companyA, role: "member" } }],
    ["the membership row names another person", { membership: { pk: `COMPANY_MEMBER#${webDeveloperId}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: "d".repeat(64), companyId: companyA, role: "member", joinedAt: createdAt } }],
  ])("refuses (unavailable) when %s", async (_label, options) => {
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    const injected = webPorts(options);
    await expect(runtime(admission, injected).checkTaskPerson(webTask(), webDeveloperId)).rejects.toMatchObject({ code: "SLACK_UNAVAILABLE" });
  });

  // Row 3654 #3: the revision's company is a second lock beside the membership (rule 3). A revision that does not name the task's company is never a grant.
  it("refuses (unavailable, no verdict) when the project revision names another company, even for a member with a grant in the task's company", async () => {
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    const injected = webPorts({ revisionCompany: companyB });
    const checker = runtime(admission, injected);
    await expect(checker.checkTaskPerson(webTask(), webDeveloperId)).rejects.toMatchObject({ code: "SLACK_UNAVAILABLE" });
    // It stops before the person's grants are read, and no witness is kept for a later step.
    expect(injected.projectAuthorityReader.memberships.mock.calls).toHaveLength(0);
    expect(injected.taskPersonProof.mock.calls).toHaveLength(0);
    await expect(checker.stateAuthorityWitnessForEligiblePerson(webTask(), webDeveloperId)).resolves.toBeUndefined();
    await expect(checker.stateAuthorityWitnessForOwnerActor(webTask(), taskOwnerKey(webDeveloperId, taskId))).resolves.toBeUndefined();
  });

  it("DEC 254zzz80: a named company's task reads its own partition, where an unstamped row is the company's (the partition names it); a legacy row never is", async () => {
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    const injected = webPorts({ revisionCompany: "unstamped" });
    await expect(runtime(admission, injected).checkTaskPerson(webTask(), webDeveloperId)).resolves.toMatchObject({ eligible: true });
    expect(injected.projectAuthorityReader.latestRevision.mock.calls[0]?.[3]).toBe(companyA);
    // The reader answering the legacy row (an unstamped `PROJECT#<name>`, the implicit company's) for a named company's task: refused, before any grant is read.
    const legacy = webPorts({ revisionCompany: "unstamped" });
    legacy.projectAuthorityReader.latestRevision.mockImplementation(async (_project, _admission, signal) => ({
      revision: { pk: "PROJECT#payments-api", sk: "REV#000000000007", revision: 7, definition: {} }, complete: !signal.aborted,
    }));
    await expect(runtime(createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 }), legacy).checkTaskPerson(webTask(), webDeveloperId)).rejects.toMatchObject({ code: "SLACK_UNAVAILABLE" });
    expect(legacy.projectAuthorityReader.memberships.mock.calls).toHaveLength(0);
  });

  it.each([["a number", 7], ["null", null], ["a string that is not a company id", "acme"]])("refuses a revision whose company is %s", async (_label, revisionCompany) => {
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    const injected = webPorts({ revisionCompany });
    await expect(runtime(admission, injected).checkTaskPerson(webTask(), webDeveloperId)).rejects.toMatchObject({ code: "SLACK_UNAVAILABLE" });
    expect(injected.projectAuthorityReader.memberships.mock.calls).toHaveLength(0);
  });

  it("ignores an `orgId` on a revision row: with no `companyId` it is unstamped, so another company's `orgId` never makes it that company's", async () => {
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    const injected = webPorts({ revisionCompany: "unstamped" });
    injected.projectAuthorityReader.latestRevision.mockImplementation(async (_project, _admission, signal) => ({
      revision: { pk: "PROJECT#payments-api", sk: "REV#000000000007", revision: 7, orgId: companyA, definition: {} } as never, complete: !signal.aborted,
    }));
    await expect(runtime(admission, injected).checkTaskPerson(webTask(), webDeveloperId)).rejects.toMatchObject({ code: "SLACK_UNAVAILABLE" });
  });

  it("passes a revision of the task's own company, and an unstamped revision on a task of the implicit company", async () => {
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    await expect(runtime(admission, webPorts({ revisionCompany: companyA })).checkTaskPerson(webTask(), webDeveloperId)).resolves.toMatchObject({ eligible: true, channelMember: true });
    const implicitTask = { ...webTask(), companyId: IMPLICIT_COMPANY_ID } as DeveloperTaskRecord;
    const implicit = webPorts({ revisionCompany: "unstamped", membership: {
      pk: `COMPANY_MEMBER#${webDeveloperId}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: webDeveloperId, companyId: IMPLICIT_COMPANY_ID, role: "member", joinedAt: createdAt,
    } });
    implicit.readTaskRecord.mockImplementation(async ({ sortKey }: { sortKey: string }) => sortKey === "META"
      ? implicitTask as unknown as Record<string, unknown>
      : [
        { pk: `DEVTASK#${taskId}`, sk: `PERSON_SUBJECT#${webDeveloperId}`, schemaVersion: 1, personId, developerId: webDeveloperId, createdAt },
        { pk: `DEVTASK#${taskId}`, sk: `PERSON#${personId}`, schemaVersion: 1, personId, developerId: webDeveloperId, name: "Gale", method: "github", issuer: ghIssuer, subject: "gh-77", createdAt },
      ].find((record) => record.sk === sortKey));
    await expect(runtime(createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 }), implicit).checkTaskPerson(implicitTask, webDeveloperId))
      .resolves.toMatchObject({ eligible: true, channelMember: true });
  });

  it("does not turn a revision of another company into 'no grant' (a person is never demoted by it)", async () => {
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    const injected = webPorts({ revisionCompany: companyB, grantRole: "none" });
    await expect(runtime(admission, injected).checkTaskPerson(webTask(), webDeveloperId)).rejects.toMatchObject({ code: "SLACK_UNAVAILABLE" });
  });

  it("answers unavailable for a web person when no membership reader is wired (the dispatcher today), with no Slack call", async () => {
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    const injected = webPorts();
    delete (injected as Partial<TaskPersonRuntimePorts>).readCompanyMembership;
    await expect(runtime(admission, injected).checkTaskPerson(webTask(), webDeveloperId)).rejects.toMatchObject({ code: "SLACK_UNAVAILABLE" });
    expect(injected.taskPersonProof.mock.calls).toHaveLength(0);
    expect(injected.readDeveloperRecord.mock.calls).toHaveLength(0);
  });

  it("reads COMPANY_MEMBER only for the checked person", async () => {
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    const injected = webPorts();
    const checker = createTaskPersonRuntime({
      admission, ports: injected, stateTableName: "state", slackTeamId, now: () => 1_000, uuid: () => "22222222-2222-4222-8222-222222222222",
      checkIdentity: async (dependencies) => {
        await dependencies.companyMembership!("c".repeat(64));
        return undefined as never;
      },
    });
    await expect(checker.checkTaskPerson(webTask(), webDeveloperId)).rejects.toMatchObject({ code: "SLACK_UNAVAILABLE" });
    expect(injected.readCompanyMembership.mock.calls).toHaveLength(0);
  });
});

// Row 3654 #3: what the dispatcher's reader asks for and hands the runtime, so the second company lock has the company to compare.
describe("task person runtime: the dispatcher's latest-revision read", () => {
  const stamped = { pk: "PROJECT#payments-api", sk: "REV#000000000007", companyId: `org_${"a".repeat(20)}`, definition: { revision: 7, developerTasks: { enabled: true } } };

  it("asks for the revision's key, its company and the two definition fields, newest first, consistently, one row", () => {
    const query = taskPersonLatestRevisionQuery("state", "payments-api");
    expect(query).toMatchObject({ TableName: "state", ConsistentRead: true, Limit: 1, ScanIndexForward: false, ExpressionAttributeValues: { ":pk": "PROJECT#payments-api", ":prefix": "REV#" } });
    expect(query.ProjectionExpression).toBe("#pk, #sk, #companyId, #definition.#revision, #definition.#developerTasks");
    expect(query.ExpressionAttributeNames).toMatchObject({ "#companyId": "companyId" });
  });

  it("carries the stored company to the runtime, and leaves an unstamped row without one", () => {
    expect(taskPersonRevisionFromResponse({ Items: [stamped] })).toStrictEqual({
      complete: true, revision: { pk: stamped.pk, sk: stamped.sk, companyId: stamped.companyId, revision: 7, definition: { developerTasks: { enabled: true } } },
    });
    const { companyId: _company, ...unstamped } = stamped;
    void _company;
    expect(taskPersonRevisionFromResponse({ Items: [unstamped] }).revision).not.toHaveProperty("companyId");
  });

  it("carries a company that is not a plain value as it is (null stays null), so the company check refuses it, and answers none for no row", () => {
    expect(taskPersonRevisionFromResponse({ Items: [{ ...stamped, companyId: null }] }).revision).toHaveProperty("companyId", null);
    expect(taskPersonRevisionFromResponse({ Items: [] })).toStrictEqual({ complete: true });
  });
});

describe("DEC 254zzz80: the dispatcher's revision read for a named company's project", () => {
  const A = `org_${"a".repeat(20)}`, B = `org_${"b".repeat(20)}`;
  const definition = (revision: number, extra: Record<string, unknown> = {}) => ({ name: "payments-api", revision, orchestratorInstructions: "x", setup: [], readiness: [],
    repositories: [{ name: "r", url: "https://github.com/acme/r", path: "repo/r", defaultBranch: "main", credentialRef: "github" }], ...extra });
  const rev = (n: number) => `REV#${String(n).padStart(12, "0")}`;
  const read = async (db: FakeDynamoDb, company = A) => {
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    const before = admission.remainingStateReads();
    const client = { send: async (command: never) => db.send(command) };
    const answer = await taskPersonNamedLatestRevision(client, "state", company, "payments-api", admission, admission.admitStateRead());
    return { answer, admitted: before - admission.remainingStateReads() };
  };

  it("reads the company's own partition in the core's order, admits every read, and an unstamped own row is the company's", async () => {
    const db = new FakeDynamoDb();
    db.set({ pk: `ORG#${A}#PROJECT#payments-api`, sk: rev(6), entityType: "PROJECT", definition: definition(6) });
    db.set({ pk: `ORG#${A}#PROJECT#payments-api`, sk: rev(7), entityType: "PROJECT", definition: definition(7, { developerTasks: { enabled: true } }) });
    db.set({ pk: `ORG#${A}#PROJECT_CATALOG`, sk: "PROJECT#payments-api", entityType: "PROJECT_CATALOG", latestRevision: 7 });
    // A legacy row of the same name is never read for a named company.
    db.set({ pk: "PROJECT#payments-api", sk: rev(9), companyId: A, definition: definition(9) });
    const { answer, admitted } = await read(db);
    expect(answer).toEqual({ complete: true, revision: { pk: `ORG#${A}#PROJECT#payments-api`, sk: rev(7), revision: 7, definition: { developerTasks: { enabled: true } } } });
    expect(admitted).toBe(2);
    // The proof's evaluation accepts this company's partition key with a team set, and refuses it for the legacy key's company.
    const input = { project: "payments-api", developerId: "d".repeat(64), teamId: "T0AAAAAAA", revision: answer.revision!, memberships: [], bindings: [] };
    expect(evaluateProjectAuthority({ ...input, companyId: A }).kind).not.toBe("unavailable");
    expect(evaluateProjectAuthority(input).kind).toBe("unavailable");
    expect(evaluateProjectAuthority({ ...input, companyId: B }).kind).toBe("unavailable");
  });

  it("another company's partition, and a row in this partition naming another company, give no revision", async () => {
    const db = new FakeDynamoDb();
    db.set({ pk: `ORG#${B}#PROJECT#payments-api`, sk: rev(1), entityType: "PROJECT", definition: definition(1) });
    expect((await read(db)).answer).toEqual({ complete: true });
    db.set({ pk: `ORG#${A}#PROJECT#payments-api`, sk: rev(1), entityType: "PROJECT", companyId: B, definition: definition(1) });
    expect((await read(db)).answer).toEqual({ complete: true });
  });
});
