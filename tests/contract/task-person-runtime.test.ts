import { GetCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { SLACK_OIDC_ISSUER } from "@agentx/contracts";
import { describe, expect, it, vi } from "vitest";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { createTaskAuthorityAdmission } from "../../packages/broker/src/aws/task-authority-admission.js";
import { createTaskPersonRuntime, TASK_PERSON_DEVELOPER_RECORD_ATTRIBUTES, type TaskPersonRuntimePorts } from "../../packages/broker/src/aws/task-person-runtime.js";
import { checkTaskPersonIdentity } from "../../packages/broker/src/developer/task-person-identity.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";

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
    latestRevision: vi.fn(async (_project: string, _admission: unknown, signal: AbortSignal) => ({
      revision: { revision: 7, definition: {} }, complete: !signal.aborted,
    })),
    memberships: vi.fn(async (_developerId: string, _admission: unknown, signal: AbortSignal) => ({ items: [], complete: !signal.aborted })),
    bindings: vi.fn(async (_teamId: string, _admission: unknown, signal: AbortSignal) => ({
      items: [{ teamId: slackTeamId, channelId, projectName: "payments-api", updatedAt: "2026-01-01T00:00:00.000Z" }], complete: !signal.aborted,
    })),
  };
  const taskPersonProof = vi.fn(async () => ({
    result: { ok: true as const, user: { id: slackUserId, teamId: slackTeamId, name: "Maya" }, memberOf: input.memberOf ?? [channelId] },
    slackCallsUsed: 1,
  }));
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

  it.each(["tasks-disabled", "not-found"] as const)("does not qualify %s project authority as definite identity loss", async (mode) => {
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    const injected = ports();
    if (mode === "not-found") {
      injected.projectAuthorityReader.latestRevision.mockResolvedValue({ revision: undefined, complete: true } as never);
    } else {
      injected.projectAuthorityReader.latestRevision.mockResolvedValue({
        revision: { revision: 7, definition: { developerTasks: { enabled: false, channelMembersMayUse: true } } }, complete: true,
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
