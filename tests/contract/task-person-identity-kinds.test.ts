// Web task channel C1 (plan 3 items 1 and 3, plan 4.2 "Identity and records"; decisions D1, D2, D4): task people of two identity
// kinds. A `slack` row (every row written before C1) parses and behaves exactly as before. A `web` row parses; this file's harness
// wires no web proof readers (C2's `companyMembership` / `projectGrant`), so here a web identity is always unavailable: never eligible,
// never an owner, never counted for dispatch and never takes ownership. The web proof itself is tested in task-person-web-proof.test.ts.
// A malformed row is a fixed refusal, never read as the other kind.
import { describe, expect, it, vi } from "vitest";
import {
  SLACK_OIDC_ISSUER,
  TASK_PERSON_METHOD_LABELS,
  taskPeopleEntryKind,
  taskPersonIdentityKind,
  type TaskPersonProofRequest,
  type TaskPersonProofResponse,
} from "@agentx/contracts";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import {
  checkTaskPersonIdentity,
  resolveTaskPersonId,
  resolveTaskPickerPerson,
  type ProjectAccessSubject,
  type TaskPersonIdentity,
  type TaskPersonIdentityDependencies,
} from "../../packages/broker/src/developer/task-person-identity.js";
import {
  TASK_PERSON_UNNAMED,
  parseTaskPeopleEntry,
  parseTaskPersonIdentity,
  taskPeopleEntryOf,
  taskPersonIdentitySuffix,
} from "../../packages/broker/src/developer/task-person-rows.js";
import {
  changeTaskPeople,
  getTaskPeople,
  getTaskPeopleCapabilities,
  getTaskPeoplePresentation,
  resolveTaskDispatchPeople,
  resolveTaskPeopleAccess,
  takeTaskOwnership,
  type TaskPeopleDependencies,
  type TaskPersonCheck,
} from "../../packages/broker/src/developer/task-people.js";
import type { TaskPeopleDisplayAdmission } from "../../packages/broker/src/developer/task-people-display-budget.js";
import { taskOwnerKey, type DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import type { DeveloperRecord } from "../../packages/broker/src/developer/store.js";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { T0, TEAM } from "../support/developer-fakes.js";

const TASK_A = "44444444-4444-4444-8444-444444444444";
const TASK_B = "77777777-7777-4777-8777-777777777777";
const CHANNEL = "C0WEBTASK1";
const SAM = "U0SAMSLACK";
const SAM_ID = developerIdForSlackUser(SAM);
const BAY = "U0BAYSLACK";
const BAY_ID = developerIdForSlackUser(BAY);
const GH_ISSUER = "https://github.com";
const GALE_ID = ownerKeyForSubject(GH_ISSUER, "gh-1234");
const OIDC_ISSUER = "https://id.example.test";
const OLA_ID = ownerKeyForSubject(OIDC_ISSUER, "ola-employee");
const P_SAM = "55555555-5555-4555-8555-555555555555";
const P_GALE = "66666666-6666-4666-8666-666666666666";
const P_BAY = "88888888-8888-4888-8888-888888888888";
const CREATED = new Date(T0 - 60_000).toISOString();

const task = (taskId = TASK_A, overrides: Partial<DeveloperTaskRecord> = {}): DeveloperTaskRecord => ({
  pk: `DEVTASK#${taskId}`, sk: "META", entityType: "DEVELOPER_TASK", taskId,
  developerId: SAM_ID, provider: "slack", developerName: "Sam Slack", slackUserId: SAM,
  client: "slack", project: "payments", title: "Payments", workspaceId: `workspace-${taskId}`,
  ownerKey: "f".repeat(64), conversationId: "conversation", startingRevision: 1,
  charge: { member: { pk: "member", sk: "counter" }, organization: { pk: "organization", sk: "counter" } },
  shared: true, share: { teamId: TEAM, channelId: CHANNEL, threadTs: "1695500000.000081", mode: "view", sharedReason: "requested", sharedAt: CREATED },
  createdAt: CREATED, updatedAt: CREATED,
  workflow: { revision: 7, stage: "PLAN_REVIEW", state: "WAITING" } as never,
  ...overrides,
});

const slackRow = (taskId: string, personId: string, slackUserId: string, name: string) => ({
  pk: `DEVTASK#${taskId}`, sk: `PERSON#${personId}`, schemaVersion: 1, personId, developerId: developerIdForSlackUser(slackUserId),
  slackUserId, name, method: "slack", issuer: SLACK_OIDC_ISSUER, subject: slackUserId, createdAt: CREATED,
});
const webRow = (taskId = TASK_A, overrides: Record<string, unknown> = {}) => ({
  pk: `DEVTASK#${taskId}`, sk: `PERSON#${P_GALE}`, schemaVersion: 1, personId: P_GALE, developerId: GALE_ID,
  name: "Gale GitHub", method: "github", issuer: GH_ISSUER, subject: "gh-1234", createdAt: CREATED, ...overrides,
});
const subjectRow = (taskId: string, personId: string, developerId: string) => ({
  pk: `DEVTASK#${taskId}`, sk: `PERSON_SUBJECT#${developerId}`, schemaVersion: 1, personId, developerId, createdAt: CREATED,
});
const peopleRow = (taskId: string, people: unknown[], revision = 3, orphaned = false) => ({
  pk: `DEVTASK#${taskId}`, sk: "PEOPLE", schemaVersion: 1, revision, orphaned, people,
});
const SAM_ENTRY = { developerId: SAM_ID, slackUserId: SAM, name: "Sam Slack", role: "owner" };
const BAY_ENTRY = { developerId: BAY_ID, slackUserId: BAY, name: "Bay Slack", role: "viewer" };
const GALE_ENTRY = (role: string) => ({ developerId: GALE_ID, name: "Gale GitHub", role, method: "github" });

const caller = (developerId: string, name: string, slackUserId?: string): DeveloperCaller => ({
  developerId, name, sessionId: `session-${name}`, amr: slackUserId === undefined ? "github" : "slack",
  ...(slackUserId === undefined ? {} : { slackUserId }),
});
const SAM_CALLER = caller(SAM_ID, "Sam Slack", SAM);
const GALE_CALLER = caller(GALE_ID, "Gale GitHub");

const sortKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(sortKeys)
  : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sortKeys(v)])) : value;
const canonical = (value: unknown) => JSON.stringify(sortKeys(value));

const errorOf = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return error as Error & { code?: string }; }
  throw new Error("expected refusal");
};

function harness(options: { developer?: DeveloperRecord; tasks?: DeveloperTaskRecord[] } = {}) {
  const db = new FakeDynamoDb();
  for (const record of options.tasks ?? [task()]) db.set(record as unknown as Record<string, unknown>);
  const reads: string[] = [];
  const send = db.send.bind(db);
  const documentClient = {
    send: async (command: unknown) => {
      const input = (command as { input?: { Key?: { pk?: string; sk?: string }; ExpressionAttributeValues?: Record<string, unknown> } }).input;
      if (input?.Key !== undefined) reads.push(`${input.Key.pk}/${input.Key.sk}`);
      else if (typeof input?.ExpressionAttributeValues?.[":pk"] === "string") reads.push(`${input.ExpressionAttributeValues[":pk"]}/*`);
      return send(command as never);
    },
  };
  const proof = vi.fn(async (request: TaskPersonProofRequest): Promise<TaskPersonProofResponse> => ({
    ok: true, user: { id: request.slackUserId, teamId: TEAM, name: request.slackUserId === SAM ? "Sam Slack" : "Bay Slack" }, memberOf: [CHANNEL],
  }));
  const developerRecord = vi.fn(async (developerId: string) => developerId === options.developer?.developerId ? options.developer : undefined);
  const projectChannelIds = vi.fn(async () => [CHANNEL]);
  const targetProjectAccess = vi.fn(async (subject: ProjectAccessSubject, project: string, memberOf: readonly string[]) => { void [subject, project, memberOf]; });
  const uuids = [P_SAM, P_BAY];
  const identityDeps: TaskPersonIdentityDependencies = {
    documentClient, tableName: "state", slackTeamId: TEAM, now: () => T0, uuid: () => uuids.shift() ?? P_BAY,
    taskPersonProof: proof, developerRecord, projectChannelIds, targetProjectAccess,
  };
  const peopleDeps: TaskPeopleDependencies = {
    documentClient, tableName: "state", now: () => T0,
    taskPeopleConfiguration: { peopleChangesEnabled: true },
    checkTaskPerson: (record, developerId) => checkTaskPersonIdentity(identityDeps, record, developerId),
  };
  const seed = (...rows: Array<Record<string, unknown>>) => { for (const row of rows) db.set(row); };
  const proofPorts = () => proof.mock.calls.length + developerRecord.mock.calls.length + projectChannelIds.mock.calls.length + targetProjectAccess.mock.calls.length;
  return { db, reads, identityDeps, peopleDeps, proof, developerRecord, projectChannelIds, targetProjectAccess, seed, proofPorts };
}

/** The usual task: Slack owner Sam (pre-C1 rows), Slack viewer Bay, and a GitHub person Gale with a `web` row. */
function mixedTask(galeRole = "commenter", options: { orphaned?: boolean; samRole?: string } = {}) {
  const h = harness();
  h.seed(
    slackRow(TASK_A, P_SAM, SAM, "Sam Slack"), subjectRow(TASK_A, P_SAM, SAM_ID),
    slackRow(TASK_A, P_BAY, BAY, "Bay Slack"), subjectRow(TASK_A, P_BAY, BAY_ID),
    webRow(), subjectRow(TASK_A, P_GALE, GALE_ID),
    peopleRow(TASK_A, [{ ...SAM_ENTRY, role: options.samRole ?? "owner" }, BAY_ENTRY, GALE_ENTRY(galeRole)], 3, options.orphaned ?? false),
  );
  return h;
}

const ID_FIELDS = { developerId: GALE_ID, name: "Gale GitHub", issuer: GH_ISSUER, subject: "gh-1234" };

describe("identity kind rule (contracts)", () => {
  it.each([
    ["slack sign-in", { method: "slack", slackUserId: SAM }, "slack"],
    ["oidc linked to Slack", { method: "oidc", slackUserId: SAM }, "slack"],
    ["oidc without a Slack link", { method: "oidc" }, "web"],
    ["github", { method: "github" }, "web"],
    ["cloud", { method: "cloud" }, "web"],
    ["saml", { method: "saml" }, "web"],
  ] as const)("classifies %s", (_label, fields, kind) => {
    expect(taskPersonIdentityKind(fields)).toBe(kind);
  });

  it.each([
    ["slack method without a Slack id", { method: "slack" }],
    ["slack method with an invalid Slack id", { method: "slack", slackUserId: "u-not-slack" }],
    ["oidc with a Slack id of the wrong type", { method: "oidc", slackUserId: 42 }],
    ["oidc with a null Slack id", { method: "oidc", slackUserId: null }],
    ["oidc with an undefined Slack id key", { method: "oidc", slackUserId: undefined }],
    ["github carrying a valid Slack id", { method: "github", slackUserId: SAM }],
    ["saml carrying an invalid Slack id", { method: "saml", slackUserId: "nope" }],
    ["an unknown method", { method: "google" }],
    ["an upper-case method", { method: "GITHUB" }],
    ["a method of the wrong type", { method: 7 }],
    ["no method", { slackUserId: SAM }],
    ["no method and no Slack id", {}],
  ])("refuses %s (never the other kind)", (_label, fields) => {
    expect(taskPersonIdentityKind(fields as Record<string, unknown>)).toBeUndefined();
  });

  it.each([
    ["a pre-C1 entry (Slack id, no method)", { slackUserId: SAM }, "slack"],
    ["a web entry (method, no Slack id)", { method: "github" }, "web"],
    ["a web oidc entry", { method: "oidc" }, "web"],
    ["a slack-method entry without a Slack id", { method: "slack" }, undefined],
    ["an entry with both", { slackUserId: SAM, method: "slack" }, undefined],
    ["an entry with neither", {}, undefined],
    ["an entry with an invalid Slack id", { slackUserId: "bad" }, undefined],
    ["an entry with an unknown method", { method: "google" }, undefined],
  ] as const)("classifies PEOPLE entry: %s", (_label, fields, kind) => {
    expect(taskPeopleEntryKind(fields as Record<string, unknown>)).toBe(kind);
  });

  it("labels every built-in method, keeping the pre-C1 Slack and OIDC words", () => {
    expect(taskPersonIdentitySuffix("slack")).toBe(" (Slack identity)");
    expect(taskPersonIdentitySuffix("oidc")).toBe(" (OIDC identity)");
    expect(taskPersonIdentitySuffix("github")).toBe(" (GitHub identity)");
    expect(Object.keys(TASK_PERSON_METHOD_LABELS).sort()).toEqual(["cloud", "github", "oidc", "saml", "slack"]);
  });
});

describe("PERSON and PEOPLE row parsers", () => {
  it("parses a pre-C1 PERSON row exactly as before (golden)", () => {
    const parsed = parseTaskPersonIdentity(slackRow(TASK_A, P_SAM, SAM, "Sam Slack"));
    expect(JSON.stringify(parsed)).toBe(JSON.stringify({ developerId: SAM_ID, slackUserId: SAM, name: "Sam Slack", method: "slack", issuer: SLACK_OIDC_ISSUER, subject: SAM }));
  });

  it("parses a web PERSON row with no Slack id", () => {
    expect(parseTaskPersonIdentity(webRow())).toStrictEqual({ ...ID_FIELDS, method: "github" });
    expect(parseTaskPersonIdentity(webRow(TASK_A, { method: "oidc", issuer: OIDC_ISSUER }))).toStrictEqual({ ...ID_FIELDS, method: "oidc", issuer: OIDC_ISSUER });
  });

  it.each([
    ["an unknown method", { method: "google" }],
    ["a slack method without a Slack id", { method: "slack" }],
    ["a web method with an invalid Slack id", { slackUserId: "nope" }],
    ["a web method with a valid Slack id", { slackUserId: SAM }],
    ["a developer id of the wrong type", { developerId: 5 }],
    ["a name of the wrong type", { name: ["Gale"] }],
    ["an unsafe name", { name: "  Gale  " }],
    ["an empty issuer", { issuer: "" }],
    ["a subject of the wrong type", { subject: 9 }],
  ])("refuses a PERSON row with %s", (_label, overrides) => {
    expect(parseTaskPersonIdentity(webRow(TASK_A, overrides))).toBeUndefined();
  });

  it("returns a pre-C1 PEOPLE entry as the very stored object, and a web entry", () => {
    const old = { ...SAM_ENTRY };
    expect(parseTaskPeopleEntry(old)).toBe(old);
    const web = GALE_ENTRY("commenter");
    expect(parseTaskPeopleEntry(web)).toBe(web);
  });

  it.each([
    ["no Slack id and no method", { developerId: GALE_ID, name: "Gale", role: "viewer" }],
    ["both a Slack id and a method", { ...SAM_ENTRY, method: "slack" }],
    ["slack method without a Slack id", { developerId: GALE_ID, name: "Gale", role: "viewer", method: "slack" }],
    ["an unknown method", { developerId: GALE_ID, name: "Gale", role: "viewer", method: "google" }],
    ["an invalid Slack id", { ...SAM_ENTRY, slackUserId: "bad" }],
    ["an unknown role", GALE_ENTRY("admin")],
    ["an extra key", { ...GALE_ENTRY("viewer"), slackTeamId: TEAM }],
    ["a bad developer id", { ...GALE_ENTRY("viewer"), developerId: "x" }],
    ["an unsafe name", { ...GALE_ENTRY("viewer"), name: " Gale" }],
  ])("refuses a PEOPLE entry with %s", (_label, entry) => {
    expect(parseTaskPeopleEntry(entry)).toBeUndefined();
  });

  it("writes the pre-C1 four keys for a Slack identity and the web four keys otherwise", () => {
    expect(JSON.stringify(taskPeopleEntryOf({ developerId: SAM_ID, slackUserId: SAM, name: "Sam Slack", method: "slack", issuer: SLACK_OIDC_ISSUER, subject: SAM }, "owner")))
      .toBe(JSON.stringify(SAM_ENTRY));
    expect(JSON.stringify(taskPeopleEntryOf({ ...ID_FIELDS, method: "github" }, "viewer"))).toBe(JSON.stringify(GALE_ENTRY("viewer")));
    expect(taskPeopleEntryOf({ ...ID_FIELDS, name: "​", method: "github" }, "viewer").name).toBe(TASK_PERSON_UNNAMED);
    const malformed: TaskPersonIdentity = { ...ID_FIELDS, method: "slack" };
    expect(() => taskPeopleEntryOf(malformed, "viewer")).toThrow();
  });
});

describe("the proof: a web identity is unavailable without the web proof readers", () => {
  it("keeps a pre-C1 Slack registry row eligible exactly as before", async () => {
    const h = mixedTask();
    await expect(checkTaskPersonIdentity(h.identityDeps, task(), BAY_ID)).resolves.toStrictEqual({
      subject: { developerId: BAY_ID, slackUserId: BAY },
      identity: { developerId: BAY_ID, slackUserId: BAY, name: "Bay Slack", method: "slack", issuer: SLACK_OIDC_ISSUER, subject: BAY },
      eligible: true, channelMember: true,
    });
    expect(h.proof).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["github", {}],
    ["oidc without a Slack link", { method: "oidc", issuer: OIDC_ISSUER }],
    ["cloud", { method: "cloud" }],
    ["saml", { method: "saml" }],
  ])("answers unavailable for a %s registry row, with no proof read and no Slack call", async (_label, overrides) => {
    const h = mixedTask();
    h.seed(webRow(TASK_A, overrides));
    const error = await errorOf(checkTaskPersonIdentity(h.identityDeps, task(), GALE_ID));
    expect(error.code).toBe("SLACK_UNAVAILABLE");
    expect(error.message).toContain("task person identity proof is unavailable");
    expect(h.proofPorts()).toBe(0);
  });

  it("builds a web identity for an OIDC creator with no Slack link from the sign-in record, then answers unavailable", async () => {
    const meta = task(TASK_A, { developerId: OLA_ID, provider: "oidc", developerName: "Ola Oidc" });
    delete (meta as { slackUserId?: string }).slackUserId;
    const h = harness({
      tasks: [meta],
      developer: { developerId: OLA_ID, provider: "oidc", issuer: OIDC_ISSUER, subject: "ola-employee", displayName: "Ola Oidc",
        firstSignInAt: CREATED, lastSignInAt: CREATED, revoked: false },
    });
    const error = await errorOf(checkTaskPersonIdentity(h.identityDeps, meta, OLA_ID));
    expect(error.code).toBe("SLACK_UNAVAILABLE");
    expect(h.developerRecord).toHaveBeenCalledTimes(1);
    expect(h.proof).not.toHaveBeenCalled();
    expect(h.projectChannelIds).not.toHaveBeenCalled();
    expect(h.targetProjectAccess).not.toHaveBeenCalled();
  });

  it("refuses an OIDC creator when the task stored a Slack id but the sign-in record has none (never a silent switch of kind)", async () => {
    const meta = task(TASK_A, { developerId: OLA_ID, provider: "oidc", developerName: "Ola Oidc", slackUserId: SAM });
    const h = harness({
      tasks: [meta],
      developer: { developerId: OLA_ID, provider: "oidc", issuer: OIDC_ISSUER, subject: "ola-employee", displayName: "Ola Oidc",
        firstSignInAt: CREATED, lastSignInAt: CREATED, revoked: false },
    });
    const error = await errorOf(checkTaskPersonIdentity(h.identityDeps, meta, OLA_ID));
    expect(error.code).toBe("PROJECT_ACCESS_DENIED");
    expect(h.proof).not.toHaveBeenCalled();
  });

  it("keeps an OIDC creator whose task stored no Slack id a web identity when the sign-in record later linked one (C2: no Slack-id equality)", async () => {
    const meta = task(TASK_A, { developerId: OLA_ID, provider: "oidc", developerName: "Ola Oidc" });
    delete (meta as { slackUserId?: string }).slackUserId;
    const h = harness({
      tasks: [meta],
      developer: { developerId: OLA_ID, provider: "oidc", issuer: OIDC_ISSUER, subject: "ola-employee", displayName: "Ola Oidc",
        firstSignInAt: CREATED, lastSignInAt: CREATED, revoked: false, slackUserId: SAM },
    });
    // A web identity, so the web proof applies; this harness has no web readers, so it is unavailable, and Slack is never asked.
    const error = await errorOf(checkTaskPersonIdentity(h.identityDeps, meta, OLA_ID));
    expect(error.code).toBe("SLACK_UNAVAILABLE");
    expect(h.proof).not.toHaveBeenCalled();
  });

  it("refuses an OIDC creator whose stored Slack id is malformed, even with a linked sign-in record", async () => {
    const meta = task(TASK_A, { developerId: OLA_ID, provider: "oidc", developerName: "Ola Oidc", slackUserId: "not-slack" });
    const h = harness({
      tasks: [meta],
      developer: { developerId: OLA_ID, provider: "oidc", issuer: OIDC_ISSUER, subject: "ola-employee", displayName: "Ola Oidc",
        slackUserId: SAM, firstSignInAt: CREATED, lastSignInAt: CREATED, revoked: false },
    });
    expect((await errorOf(checkTaskPersonIdentity(h.identityDeps, meta, OLA_ID))).code).toBe("PROJECT_ACCESS_DENIED");
    expect(h.proof).not.toHaveBeenCalled();
  });

  it("keeps the linked OIDC creator on the Slack proof, exactly as before", async () => {
    const meta = task(TASK_A, { developerId: OLA_ID, provider: "oidc", developerName: "Ola Oidc", slackUserId: SAM });
    const h = harness({
      tasks: [meta],
      developer: { developerId: OLA_ID, provider: "oidc", issuer: OIDC_ISSUER, subject: "ola-employee", displayName: "Ola Oidc",
        slackUserId: SAM, firstSignInAt: CREATED, lastSignInAt: CREATED, revoked: false },
    });
    await expect(checkTaskPersonIdentity(h.identityDeps, meta, OLA_ID)).resolves.toMatchObject({
      identity: { developerId: OLA_ID, slackUserId: SAM, method: "oidc" }, eligible: true, channelMember: true,
    });
    expect(h.proof).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an unknown method", { method: "google" }],
    ["a slack method without a Slack id", { method: "slack" }],
    ["a web method with an invalid Slack id", { slackUserId: "nope" }],
    ["a web method with a valid Slack id", { slackUserId: BAY }],
    ["a method of the wrong type", { method: 1 }],
    ["an issuer of the wrong type", { issuer: 2 }],
  ])("refuses a registry row with %s as malformed, never as a web identity", async (_label, overrides) => {
    const h = mixedTask();
    h.seed(webRow(TASK_A, overrides));
    const error = await errorOf(checkTaskPersonIdentity(h.identityDeps, task(), GALE_ID));
    expect(error.code).toBe("PROJECT_ACCESS_DENIED");
    expect(h.proofPorts()).toBe(0);
  });

  it("refuses to resolve a web person id, with no proof read and no Slack call", async () => {
    for (const overrides of [{}, { method: "oidc", issuer: OIDC_ISSUER }]) {
      const h = mixedTask();
      h.seed(webRow(TASK_A, overrides));
      const error = await errorOf(resolveTaskPersonId(h.identityDeps, TASK_A, P_GALE));
      expect(error.code).toBe("PROJECT_ACCESS_DENIED");
      expect(h.proofPorts()).toBe(0);
    }
  });

  it("still resolves a Slack person id", async () => {
    const h = mixedTask();
    await expect(resolveTaskPersonId(h.identityDeps, TASK_A, P_BAY)).resolves.toMatchObject({ developerId: BAY_ID, slackUserId: BAY });
  });

  it("writes a Slack picker person's PERSON and PERSON_SUBJECT rows byte-identically to before (golden)", async () => {
    const h = harness();
    await resolveTaskPickerPerson(h.identityDeps, task(), SAM);
    expect(JSON.stringify(h.db.get(`DEVTASK#${TASK_A}`, `PERSON#${P_SAM}`))).toBe(JSON.stringify({
      pk: `DEVTASK#${TASK_A}`, sk: `PERSON#${P_SAM}`, schemaVersion: 1, personId: P_SAM,
      developerId: SAM_ID, slackUserId: SAM, name: "Sam Slack", method: "slack", issuer: SLACK_OIDC_ISSUER, subject: SAM,
      createdAt: new Date(T0).toISOString(),
    }));
    expect(JSON.stringify(h.db.get(`DEVTASK#${TASK_A}`, `PERSON_SUBJECT#${SAM_ID}`))).toBe(JSON.stringify({
      pk: `DEVTASK#${TASK_A}`, sk: `PERSON_SUBJECT#${SAM_ID}`, schemaVersion: 1, personId: P_SAM, developerId: SAM_ID, createdAt: new Date(T0).toISOString(),
    }));
  });
});

describe("every caller refuses a web person (real proof wired in)", () => {
  it("never counts a web owner for dispatch, while the Slack owner still counts", async () => {
    const h = mixedTask("owner");
    await expect(resolveTaskDispatchPeople(h.peopleDeps, task())).resolves.toStrictEqual({
      peopleRevision: 3, ownerActorIds: [taskOwnerKey(SAM_ID, TASK_A)], status: "ALLOWED",
    });
  });

  it("parks a task whose only owner is a web identity (UNKNOWN, never ALLOWED)", async () => {
    const h = mixedTask("owner", { samRole: "commenter" });
    await expect(resolveTaskDispatchPeople(h.peopleDeps, task())).resolves.toStrictEqual({ peopleRevision: 3, ownerActorIds: [], status: "UNKNOWN" });
  });

  it.each(["owner", "commenter", "viewer"])("gives a web %s no task access", async (role) => {
    const h = mixedTask(role);
    expect((await errorOf(resolveTaskPeopleAccess(h.peopleDeps, task(), GALE_ID))).code).toBe("TASK_ACCESS_DENIED");
    expect((await errorOf(getTaskPeopleCapabilities(h.peopleDeps, GALE_CALLER, TASK_A))).code).toBe("TASK_ACCESS_DENIED");
  });

  it("keeps the Slack owner's access unchanged beside a web commenter", async () => {
    const h = mixedTask("commenter");
    await expect(resolveTaskPeopleAccess(h.peopleDeps, task(), SAM_ID)).resolves.toMatchObject({ role: "owner", peopleRevision: 3, orphaned: false });
  });

  it("refuses to make a web person an owner, and writes nothing", async () => {
    const h = mixedTask("commenter");
    const before = JSON.stringify(h.db.get(`DEVTASK#${TASK_A}`, "PEOPLE"));
    for (const role of ["owner", "commenter", "viewer", "denied"] as const) {
      const error = await errorOf(changeTaskPeople(h.peopleDeps, SAM_CALLER, TASK_A, {
        requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", expectedPeopleRevision: 3, targetDeveloperId: GALE_ID, role,
      }));
      expect(error.code).toBe("TASK_ACCESS_DENIED");
    }
    expect(JSON.stringify(h.db.get(`DEVTASK#${TASK_A}`, "PEOPLE"))).toBe(before);
    expect(h.db.find((item) => String(item.sk).startsWith("PEOPLE_"))).toEqual([]);
  });

  it("never lets a web person take ownership of an orphaned task", async () => {
    const h = mixedTask("commenter", { orphaned: true, samRole: "commenter" });
    const before = JSON.stringify(h.db.get(`DEVTASK#${TASK_A}`, "PEOPLE"));
    const error = await errorOf(takeTaskOwnership(h.peopleDeps, GALE_CALLER, TASK_A, { requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", expectedPeopleRevision: 3 }));
    expect(error.code).toBe("TASK_ACCESS_DENIED");
    expect(JSON.stringify(h.db.get(`DEVTASK#${TASK_A}`, "PEOPLE"))).toBe(before);
  });

  it("accepts a web identity's proof result (C2) but still refuses a malformed one", async () => {
    const h = mixedTask("owner");
    const webCheck: TaskPersonCheck = { subject: { developerId: GALE_ID }, identity: { ...ID_FIELDS, method: "github" }, eligible: true, channelMember: true };
    const deps: TaskPeopleDependencies = {
      ...h.peopleDeps,
      checkTaskPerson: async (record, developerId) => developerId === GALE_ID ? structuredClone(webCheck) : checkTaskPersonIdentity(h.identityDeps, record, developerId),
    };
    await expect(resolveTaskDispatchPeople(deps, task())).resolves.toMatchObject({ ownerActorIds: [taskOwnerKey(SAM_ID, TASK_A), taskOwnerKey(GALE_ID, TASK_A)] });
    for (const malformed of [
      { ...webCheck, identity: { ...ID_FIELDS, method: "slack" } },
      { ...webCheck, subject: { developerId: GALE_ID, slackUserId: BAY } },
      { ...webCheck, identity: { ...ID_FIELDS, name: "  Gale", method: "github" } },
    ] as TaskPersonCheck[]) {
      const bad: TaskPeopleDependencies = {
        ...h.peopleDeps,
        checkTaskPerson: async (record, developerId) => developerId === GALE_ID ? structuredClone(malformed) : checkTaskPersonIdentity(h.identityDeps, record, developerId),
      };
      await expect(resolveTaskDispatchPeople(bad, task())).resolves.toMatchObject({ ownerActorIds: [taskOwnerKey(SAM_ID, TASK_A)], status: "ALLOWED" });
    }
  });
});

describe("pre-C1 rows round-trip byte-identically", () => {
  it("leaves an unchanged PEOPLE row exactly as stored", async () => {
    const h = harness();
    const fixture = peopleRow(TASK_A, [{ ...SAM_ENTRY }, { ...BAY_ENTRY }]);
    h.seed(slackRow(TASK_A, P_SAM, SAM, "Sam Slack"), subjectRow(TASK_A, P_SAM, SAM_ID), slackRow(TASK_A, P_BAY, BAY, "Bay Slack"), subjectRow(TASK_A, P_BAY, BAY_ID), fixture);
    await resolveTaskPeopleAccess(h.peopleDeps, task(), SAM_ID);
    await resolveTaskDispatchPeople(h.peopleDeps, task());
    expect(JSON.stringify(h.db.get(`DEVTASK#${TASK_A}`, "PEOPLE"))).toBe(JSON.stringify(fixture));
  });

  it("writes a role change with the pre-C1 entry shape", async () => {
    const h = harness();
    h.seed(slackRow(TASK_A, P_SAM, SAM, "Sam Slack"), subjectRow(TASK_A, P_SAM, SAM_ID), slackRow(TASK_A, P_BAY, BAY, "Bay Slack"), subjectRow(TASK_A, P_BAY, BAY_ID),
      peopleRow(TASK_A, [{ ...SAM_ENTRY }, { ...BAY_ENTRY }]));
    await changeTaskPeople(h.peopleDeps, SAM_CALLER, TASK_A, {
      requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", expectedPeopleRevision: 3, targetDeveloperId: BAY_ID, role: "commenter",
    });
    // DynamoDB maps keep no key order, so the written list is compared key-sorted: same keys, same values, nothing added.
    expect(canonical((h.db.get(`DEVTASK#${TASK_A}`, "PEOPLE") as { people: unknown }).people)).toBe(canonical([
      SAM_ENTRY, { developerId: BAY_ID, slackUserId: BAY, name: "Bay Slack", role: "commenter" },
    ]));
  });

  it("initializes a Slack-shared task's PEOPLE row with the pre-C1 owner entry", async () => {
    const h = harness();
    h.seed(slackRow(TASK_A, P_BAY, BAY, "Bay Slack"), subjectRow(TASK_A, P_BAY, BAY_ID));
    await changeTaskPeople(h.peopleDeps, SAM_CALLER, TASK_A, {
      requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", expectedPeopleRevision: 1, targetDeveloperId: BAY_ID, role: "viewer",
    });
    expect(JSON.stringify((h.db.get(`DEVTASK#${TASK_A}`, "PEOPLE") as { people: unknown }).people)).toBe(JSON.stringify([
      SAM_ENTRY, BAY_ENTRY,
    ]));
    const owner = h.db.get(`DEVTASK#${TASK_A}`, `PERSON_SUBJECT#${SAM_ID}`)!;
    expect(Object.keys(h.db.get(`DEVTASK#${TASK_A}`, `PERSON#${String(owner.personId)}`)!)).toEqual(
      ["pk", "sk", "schemaVersion", "personId", "developerId", "slackUserId", "name", "method", "issuer", "subject", "createdAt"]);
  });

  it.each([
    ["no Slack id and no method", { developerId: GALE_ID, name: "Gale", role: "viewer" }],
    ["a slack method without a Slack id", { developerId: GALE_ID, name: "Gale", role: "viewer", method: "slack" }],
    ["an unknown method", { developerId: GALE_ID, name: "Gale", role: "viewer", method: "google" }],
    ["both a Slack id and a method", { ...BAY_ENTRY, method: "slack" }],
  ])("refuses a PEOPLE row whose entry has %s (fixed refusal for every reader)", async (_label, entry) => {
    const h = harness();
    h.seed(peopleRow(TASK_A, [{ ...SAM_ENTRY }, entry]));
    expect((await errorOf(resolveTaskDispatchPeople(h.peopleDeps, task()))).code).toBe("TASK_ACCESS_DENIED");
    expect((await errorOf(resolveTaskPeopleAccess(h.peopleDeps, task(), SAM_ID))).code).toBe("TASK_ACCESS_DENIED");
  });
});

describe("D4 labels: one person's two identities are told apart by method", () => {
  const admission = (): TaskPeopleDisplayAdmission => ({
    assertOpen() {}, admitIdentity() {}, noteNativeIdentity() {}, close() {},
    async proof() { throw new Error("not routed"); }, async directory() { throw new Error("not routed"); },
  });
  const slackCheck = (developerId: string, slackUserId: string, name: string): TaskPersonCheck => ({
    subject: { developerId, slackUserId }, identity: { developerId, slackUserId, name, method: "slack", issuer: SLACK_OIDC_ISSUER, subject: slackUserId }, eligible: true, channelMember: true,
  });

  function view(rows: Array<Record<string, unknown>>, display: TaskPersonCheck[]) {
    const h = harness();
    h.seed(...rows);
    const deps: TaskPeopleDependencies = {
      ...h.peopleDeps,
      checkTaskPerson: async (_record, developerId) => {
        const found = display.find((check) => check.identity.developerId === developerId && check.identity.slackUserId !== undefined);
        if (found === undefined) throw new Error("unavailable");
        return structuredClone(found);
      },
      createTaskPeopleDisplayAdmission: admission,
      listTaskPeople: async () => display.map((check) => structuredClone(check)),
    };
    return getTaskPeople(deps, SAM_CALLER, TASK_A);
  }

  it("labels a Slack and a GitHub identity of one name by method", async () => {
    const result = await view([
      slackRow(TASK_A, P_SAM, SAM, "Maya Chen"), subjectRow(TASK_A, P_SAM, SAM_ID),
      webRow(TASK_A, { name: "Maya Chen" }), subjectRow(TASK_A, P_GALE, GALE_ID),
      peopleRow(TASK_A, [{ ...SAM_ENTRY, name: "Maya Chen" }]),
    ], [
      slackCheck(SAM_ID, SAM, "Maya Chen"),
      { subject: { developerId: GALE_ID }, identity: { ...ID_FIELDS, name: "Maya Chen", method: "github" }, eligible: true, channelMember: true },
    ]);
    expect(result.people.map((person) => person.name).sort()).toEqual(["Maya Chen (GitHub identity)", "Maya Chen (Slack identity)"]);
  });

  it("labels only a same-name group that holds a web identity", async () => {
    const result = await view([
      slackRow(TASK_A, P_SAM, SAM, "Maya Chen"), subjectRow(TASK_A, P_SAM, SAM_ID),
      slackRow(TASK_A, P_BAY, BAY, "Maya Chen"), subjectRow(TASK_A, P_BAY, BAY_ID),
      webRow(TASK_A, { name: "Gale GitHub" }), subjectRow(TASK_A, P_GALE, GALE_ID),
      peopleRow(TASK_A, [{ ...SAM_ENTRY, name: "Maya Chen" }, { ...BAY_ENTRY, name: "Maya Chen" }]),
    ], [
      slackCheck(SAM_ID, SAM, "Maya Chen"), slackCheck(BAY_ID, BAY, "Maya Chen"),
      { subject: { developerId: GALE_ID }, identity: { ...ID_FIELDS, method: "github" }, eligible: true, channelMember: true },
    ]);
    expect(result.people.map((person) => person.name)).toEqual(["Gale GitHub", "Maya Chen", "Maya Chen"]);
  });

  it("keeps two different Slack people of one name unlabelled, as before (golden)", async () => {
    const result = await view([
      slackRow(TASK_A, P_SAM, SAM, "Maya Chen"), subjectRow(TASK_A, P_SAM, SAM_ID),
      slackRow(TASK_A, P_BAY, BAY, "Maya Chen"), subjectRow(TASK_A, P_BAY, BAY_ID),
      peopleRow(TASK_A, [{ ...SAM_ENTRY, name: "Maya Chen" }, { ...BAY_ENTRY, name: "Maya Chen" }]),
    ], [slackCheck(SAM_ID, SAM, "Maya Chen"), slackCheck(BAY_ID, BAY, "Maya Chen")]);
    expect(result.people.map((person) => person.name)).toEqual(["Maya Chen", "Maya Chen"]);
  });
});

describe("company boundary: rows are read only from the task's own partition", () => {
  it("never reads or honours another company's task people", async () => {
    const companyA = task(TASK_A, { workspaceId: "workspace-company-a" });
    const companyB = task(TASK_B, { workspaceId: "workspace-company-b" });
    const h = harness({ tasks: [companyA, companyB] });
    h.seed(
      slackRow(TASK_A, P_SAM, SAM, "Sam Slack"), subjectRow(TASK_A, P_SAM, SAM_ID), peopleRow(TASK_A, [{ ...SAM_ENTRY }]),
      slackRow(TASK_B, P_SAM, SAM, "Sam Slack"), subjectRow(TASK_B, P_SAM, SAM_ID),
      webRow(TASK_B), subjectRow(TASK_B, P_GALE, GALE_ID),
      peopleRow(TASK_B, [{ ...SAM_ENTRY }, GALE_ENTRY("owner"), { developerId: BAY_ID, name: "Bad", role: "viewer", method: "slack" }]),
    );
    h.reads.length = 0;
    expect((await errorOf(checkTaskPersonIdentity(h.identityDeps, companyA, GALE_ID))).code).toBe("PROJECT_ACCESS_DENIED");
    await expect(resolveTaskDispatchPeople(h.peopleDeps, companyA)).resolves.toMatchObject({ status: "ALLOWED", ownerActorIds: [taskOwnerKey(SAM_ID, TASK_A)] });
    await expect(getTaskPeoplePresentation(h.peopleDeps, TASK_A)).resolves.toEqual([{ personId: P_SAM, developerId: SAM_ID, name: "Sam Slack" }]);
    expect(h.reads.length).toBeGreaterThan(0);
    expect(h.reads.every((key) => key.startsWith(`DEVTASK#${TASK_A}/`))).toBe(true);
    // Company B's malformed PEOPLE row is refused for B, and A is unaffected.
    expect((await errorOf(resolveTaskDispatchPeople(h.peopleDeps, companyB))).code).toBe("TASK_ACCESS_DENIED");
  });
});
