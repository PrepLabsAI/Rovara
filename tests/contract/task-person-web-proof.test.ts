// Web task channel C2 (plan 3 items 2 and 4, plan 4.1 rule, plan 4.2 "Proof"; decisions D1, D2, D3): the web proof path.
// A `web` task person is eligible only while all four rules hold, each read live on every check, with no Slack call:
//   1. the developer id is the verified caller's or the task's own stored row's, and it is its sign-in subject's own id;
//   2. DEVELOPER#<id>/META exists, is not revoked, and its method, issuer and subject match the registered row;
//   3. live COMPANY_MEMBER# membership in the TASK'S company;
//   4. a live developer or administrator grant on the task's project (never channel-only access).
// "present" (carried in `channelMember`) is rules 3 and 4. A proven loss is `eligible: false` and reconciles like a Slack departure;
// anything unreadable is a refusal. A `slack` identity keeps its proof byte for byte (D2).
import { describe, expect, it, vi } from "vitest";
import {
  IMPLICIT_COMPANY_ID,
  SLACK_OIDC_ISSUER,
  type TaskPersonProofRequest,
  type TaskPersonProofResponse,
} from "@agentx/contracts";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { companyMembershipFromDynamo } from "../../packages/broker/src/aws/company-check.js";
import { developerTaskRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import {
  checkTaskPersonIdentity,
  resolveTaskPersonId,
  type ProjectAccessSubject,
  type TaskPersonIdentityDependencies,
} from "../../packages/broker/src/developer/task-person-identity.js";
import {
  changeTaskPeople,
  getTaskPeopleCapabilities,
  resolveTaskDispatchPeople,
  resolveTaskPeopleAccess,
  resolveTaskPeopleTarget,
  takeTaskOwnership,
  taskPersonPresent,
  type TaskPeopleDependencies,
} from "../../packages/broker/src/developer/task-people.js";
import { taskOwnerKey, type DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import type { DeveloperRecord } from "../../packages/broker/src/developer/store.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { companyProjectRow } from "../support/company-layout-projects.js";
import { T0, TEAM } from "../support/developer-fakes.js";

const TASK_A = "44444444-4444-4444-8444-444444444444";
const CHANNEL = "C0WEBTASK1";
const SAM = "U0SAMSLACK";
const SAM_ID = developerIdForSlackUser(SAM);
const GH_ISSUER = "https://github.com";
const GALE_ID = ownerKeyForSubject(GH_ISSUER, "gh-1234");
const OIDC_ISSUER = "https://id.example.test";
const OLA_ID = ownerKeyForSubject(OIDC_ISSUER, "ola-employee");
const P_SAM = "55555555-5555-4555-8555-555555555555";
const P_GALE = "66666666-6666-4666-8666-666666666666";
const CREATED = new Date(T0 - 60_000).toISOString();
// Company ids are built at runtime from a fixed shape (no key-shaped literals in a public repo).
const companyId = (letter: string) => `org_${letter.repeat(20)}`;
const COMPANY_A = companyId("a");
const COMPANY_B = companyId("b");

// Persisted company data may be malformed; keep those refusal fixtures explicit.
const task = (overrides: Partial<Omit<DeveloperTaskRecord, "companyId">> & { companyId?: unknown } & Record<string, unknown> = {}): DeveloperTaskRecord => ({
  pk: `DEVTASK#${TASK_A}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: TASK_A,
  developerId: SAM_ID, provider: "slack", developerName: "Sam Slack", slackUserId: SAM,
  client: "slack", project: "payments", title: "Payments", workspaceId: `workspace-${TASK_A}`,
  ownerKey: "f".repeat(64), conversationId: "conversation", startingRevision: 1,
  charge: { member: { pk: "member", sk: "counter" }, organization: { pk: "organization", sk: "counter" } },
  shared: true, share: { teamId: TEAM, channelId: CHANNEL, threadTs: "1695500000.000081", mode: "view", sharedReason: "requested", sharedAt: CREATED },
  createdAt: CREATED, updatedAt: CREATED, companyId: COMPANY_A,
  workflow: { revision: 7, stage: "PLAN_REVIEW", state: "WAITING" } as never,
  ...overrides,
} as DeveloperTaskRecord);

const slackRow = (personId: string, slackUserId: string, name: string) => ({
  pk: `DEVTASK#${TASK_A}`, sk: `PERSON#${personId}`, schemaVersion: 1, personId, developerId: developerIdForSlackUser(slackUserId),
  slackUserId, name, method: "slack", issuer: SLACK_OIDC_ISSUER, subject: slackUserId, createdAt: CREATED,
});
const webRow = (overrides: Record<string, unknown> = {}) => ({
  pk: `DEVTASK#${TASK_A}`, sk: `PERSON#${P_GALE}`, schemaVersion: 1, personId: P_GALE, developerId: GALE_ID,
  name: "Gale GitHub", method: "github", issuer: GH_ISSUER, subject: "gh-1234", createdAt: CREATED, ...overrides,
});
const subjectRow = (personId: string, developerId: string) => ({
  pk: `DEVTASK#${TASK_A}`, sk: `PERSON_SUBJECT#${developerId}`, schemaVersion: 1, personId, developerId, createdAt: CREATED,
});
const peopleRow = (people: unknown[], revision = 3, orphaned = false) => ({ pk: `DEVTASK#${TASK_A}`, sk: "PEOPLE", schemaVersion: 1, revision, orphaned, people });
const SAM_ENTRY = (role = "owner") => ({ developerId: SAM_ID, slackUserId: SAM, name: "Sam Slack", role });
const GALE_ENTRY = (role: string) => ({ developerId: GALE_ID, name: "Gale GitHub", role, method: "github" });

const galeRecord = (overrides: Partial<DeveloperRecord> = {}): DeveloperRecord => ({
  developerId: GALE_ID, provider: "github", issuer: GH_ISSUER, subject: "gh-1234", displayName: "Gale GitHub",
  firstSignInAt: CREATED, lastSignInAt: CREATED, revoked: false, ...overrides,
});

const caller = (developerId: string, name: string, slackUserId?: string): DeveloperCaller => ({
  developerId, name, sessionId: `session-${name}`, amr: slackUserId === undefined ? "github" : "slack",
  ...(slackUserId === undefined ? {} : { slackUserId }),
});
const SAM_CALLER = caller(SAM_ID, "Sam Slack", SAM);
const GALE_CALLER = caller(GALE_ID, "Gale GitHub");

const errorOf = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return error as Error & { code?: string }; }
  throw new Error("expected refusal");
};

interface WebWorld {
  records?: Record<string, DeveloperRecord>;
  memberships?: Record<string, { companyId: string } | "throw">;
  grants?: Record<string, boolean | "throw">;
  tasks?: DeveloperTaskRecord[];
}

function harness(world: WebWorld = {}) {
  const db = new FakeDynamoDb();
  for (const record of world.tasks ?? [task()]) db.set(record as unknown as Record<string, unknown>);
  const records = { [GALE_ID]: galeRecord(), ...(world.records ?? {}) };
  const memberships: Record<string, { companyId: string } | "throw"> = { [GALE_ID]: { companyId: COMPANY_A }, ...(world.memberships ?? {}) };
  const grants: Record<string, boolean | "throw"> = { [GALE_ID]: true, ...(world.grants ?? {}) };
  const proof = vi.fn(async (request: TaskPersonProofRequest): Promise<TaskPersonProofResponse> => ({
    ok: true, user: { id: request.slackUserId, teamId: TEAM, name: "Sam Slack" }, memberOf: [CHANNEL],
  }));
  const developerRecord = vi.fn(async (developerId: string) => records[developerId]);
  const projectChannelIds = vi.fn(async () => [CHANNEL]);
  const targetProjectAccess = vi.fn(async (subject: ProjectAccessSubject, project: string, memberOf: readonly string[]) => { void [subject, project, memberOf]; });
  const companyMembership = vi.fn(async (developerId: string) => {
    const found = memberships[developerId];
    if (found === "throw") throw new Error("membership read failed");
    return found;
  });
  const projectGrant = vi.fn(async (developerId: string, project: string, company: string) => {
    void [project, company];
    const found = grants[developerId] ?? false;
    if (found === "throw") throw new Error("grant read failed");
    return found;
  });
  const identityDeps: TaskPersonIdentityDependencies = {
    documentClient: db, tableName: "state", slackTeamId: TEAM, now: () => T0, uuid: () => P_SAM,
    taskPersonProof: proof, developerRecord, projectChannelIds, targetProjectAccess, companyMembership, projectGrant,
  };
  const peopleDeps: TaskPeopleDependencies = {
    documentClient: db, tableName: "state", now: () => T0, taskPeopleConfiguration: { peopleChangesEnabled: true },
    checkTaskPerson: (record, developerId) => checkTaskPersonIdentity(identityDeps, record, developerId),
  };
  const seed = (...rows: Array<Record<string, unknown>>) => { for (const row of rows) db.set(row); };
  const slackCalls = () => proof.mock.calls.length + projectChannelIds.mock.calls.length + targetProjectAccess.mock.calls.length;
  const slackCallsFor = (slackUserId: string) => proof.mock.calls.filter(([request]) => request.slackUserId === slackUserId).length;
  return { db, identityDeps, peopleDeps, proof, developerRecord, companyMembership, projectGrant, projectChannelIds, targetProjectAccess, seed, slackCalls, slackCallsFor };
}

/** Slack owner Sam (pre-C1 rows) and GitHub person Gale (a `web` row) on company A's Slack-shared task. */
function mixed(galeRole = "commenter", world: WebWorld = {}, options: { samRole?: string; orphaned?: boolean } = {}) {
  const h = harness(world);
  h.seed(
    slackRow(P_SAM, SAM, "Sam Slack"), subjectRow(P_SAM, SAM_ID),
    webRow(), subjectRow(P_GALE, GALE_ID),
    peopleRow([SAM_ENTRY(options.samRole ?? "owner"), GALE_ENTRY(galeRole)], 3, options.orphaned ?? false),
  );
  return h;
}

const ELIGIBLE = { subject: { developerId: GALE_ID }, identity: { developerId: GALE_ID, name: "Gale GitHub", method: "github", issuer: GH_ISSUER, subject: "gh-1234" }, eligible: true, channelMember: true };

describe("the web proof: all four rules, read live, no Slack call", () => {
  it.each([
    ["github", {}, {}],
    ["oidc without a Slack link", { method: "oidc", issuer: OIDC_ISSUER, subject: "ola-employee", developerId: OLA_ID }, { developerId: OLA_ID, provider: "oidc", issuer: OIDC_ISSUER, subject: "ola-employee" }],
    ["cloud", { method: "cloud" }, { provider: "cloud" }],
    ["saml", { method: "saml" }, { provider: "saml" }],
  ] as const)("makes a %s person eligible and present with live reads only", async (_label, row, record) => {
    const developerId = (row as { developerId?: string }).developerId ?? GALE_ID;
    const h = harness({
      records: { [developerId]: galeRecord(record) },
      memberships: { [developerId]: { companyId: COMPANY_A } }, grants: { [developerId]: true },
    });
    h.seed(webRow(row), subjectRow(P_GALE, developerId));
    const result = await checkTaskPersonIdentity(h.identityDeps, task(), developerId);
    expect(result).toMatchObject({ subject: { developerId }, eligible: true, channelMember: true, identity: { developerId, method: (row as { method?: string }).method ?? "github" } });
    expect(result.identity.slackUserId).toBeUndefined();
    expect(taskPersonPresent(result)).toBe(true);
    expect(h.developerRecord).toHaveBeenCalledWith(developerId);
    expect(h.companyMembership).toHaveBeenCalledWith(developerId);
    expect(h.projectGrant).toHaveBeenCalledWith(developerId, "payments", COMPANY_A);
    expect(h.slackCalls()).toBe(0);
  });

  it("answers exactly the golden result shape for an eligible web person", async () => {
    const h = mixed();
    expect(await checkTaskPersonIdentity(h.identityDeps, task(), GALE_ID)).toStrictEqual(ELIGIBLE);
  });

  // Mutation proof: each rule removed lets one of these through.
  it("rule 1: refuses a row whose developer id is not its own sign-in subject's, before reading the sign-in record", async () => {
    const h = harness({ records: { [GALE_ID]: galeRecord({ subject: "gh-other" }) } });
    h.seed(webRow({ subject: "gh-other" }), subjectRow(P_GALE, GALE_ID));
    expect((await errorOf(checkTaskPersonIdentity(h.identityDeps, task(), GALE_ID))).code).toBe("PROJECT_ACCESS_DENIED");
    expect(h.developerRecord).not.toHaveBeenCalled();
    expect(h.companyMembership).not.toHaveBeenCalled();
  });

  it("rule 2: a revoked sign-in record is a proven loss (eligible false, not present), with no further read", async () => {
    const h = mixed("commenter", { records: { [GALE_ID]: galeRecord({ revoked: true }) } });
    expect(await checkTaskPersonIdentity(h.identityDeps, task(), GALE_ID)).toMatchObject({ eligible: false, channelMember: false });
    expect(h.companyMembership).not.toHaveBeenCalled();
    expect(h.projectGrant).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["of another method", galeRecord({ provider: "oidc" })],
    ["of another issuer", galeRecord({ issuer: "https://other.example.test" })],
    ["of another subject", galeRecord({ subject: "gh-9999" })],
    ["with an unreadable revoked flag", galeRecord({ revoked: "no" as never })],
    ["of another developer", galeRecord({ developerId: OLA_ID })],
  ])("rule 2: refuses when the sign-in record is %s", async (_label, record) => {
    const h = mixed("commenter", { records: { [GALE_ID]: record as DeveloperRecord } });
    expect((await errorOf(checkTaskPersonIdentity(h.identityDeps, task(), GALE_ID))).code).toBe("PROJECT_ACCESS_DENIED");
    expect(h.companyMembership).not.toHaveBeenCalled();
  });

  it("rule 2: accepts a sign-in record that later linked a Slack account (no Slack-id equality; the identity stays web)", async () => {
    const h = mixed("commenter", { records: { [GALE_ID]: galeRecord({ slackUserId: SAM }) } });
    expect(await checkTaskPersonIdentity(h.identityDeps, task(), GALE_ID)).toStrictEqual(ELIGIBLE);
    expect(h.slackCalls()).toBe(0);
  });

  it("rule 3: no membership, or a revoked one, is a proven loss", async () => {
    const h = mixed("commenter");
    h.companyMembership.mockResolvedValueOnce(undefined);
    expect(await checkTaskPersonIdentity(h.identityDeps, task(), GALE_ID)).toMatchObject({ eligible: false, channelMember: false });
    expect(h.projectGrant).not.toHaveBeenCalled();
  });

  it("rule 3 (company boundary): a member of company B is never eligible on company A's task, even with a grant on a same-named project", async () => {
    const h = mixed("commenter", { memberships: { [GALE_ID]: { companyId: COMPANY_B } }, grants: { [GALE_ID]: true } });
    expect(await checkTaskPersonIdentity(h.identityDeps, task(), GALE_ID)).toMatchObject({ eligible: false, channelMember: false });
    expect(h.projectGrant).not.toHaveBeenCalled();
    expect((await errorOf(resolveTaskPeopleAccess(h.peopleDeps, task(), GALE_ID))).code).toBe("TASK_ACCESS_DENIED");
  });

  it("rule 3: the task's company is the stored task's (absent = the implicit company)", async () => {
    const legacy = task();
    delete legacy.companyId;
    const h = harness({ tasks: [legacy], memberships: { [GALE_ID]: { companyId: IMPLICIT_COMPANY_ID } } });
    h.seed(webRow(), subjectRow(P_GALE, GALE_ID));
    expect(await checkTaskPersonIdentity(h.identityDeps, legacy, GALE_ID)).toMatchObject({ eligible: true, channelMember: true });
    expect(h.projectGrant).toHaveBeenCalledWith(GALE_ID, "payments", IMPLICIT_COMPANY_ID);
  });

  it.each([
    ["a malformed company id on the stored task", { companyId: "acme" }, {}],
    ["a null company id on the stored task", { companyId: null }, {}],
    ["a caller's copy naming another company", {}, { companyId: COMPANY_B }],
  ])("rule 3: refuses %s", async (_label, storedOverride, givenOverride) => {
    const stored = task(storedOverride);
    const h = harness({ tasks: [stored] });
    h.seed(webRow(), subjectRow(P_GALE, GALE_ID));
    expect((await errorOf(checkTaskPersonIdentity(h.identityDeps, { ...stored, ...givenOverride }, GALE_ID))).code).toBe("PROJECT_ACCESS_DENIED");
    expect(h.slackCalls()).toBe(0);
  });

  it("rule 4: no developer or administrator grant is a proven loss", async () => {
    const h = mixed("commenter", { grants: { [GALE_ID]: false } });
    expect(await checkTaskPersonIdentity(h.identityDeps, task(), GALE_ID)).toMatchObject({ eligible: false, channelMember: false });
    expect(h.slackCalls()).toBe(0);
  });

  it.each([
    ["the sign-in record", (h: ReturnType<typeof harness>) => { h.developerRecord.mockRejectedValueOnce(new Error("down")); }],
    ["the membership", (h: ReturnType<typeof harness>) => { h.companyMembership.mockRejectedValueOnce(new Error("down")); }],
    ["the grant", (h: ReturnType<typeof harness>) => { h.projectGrant.mockRejectedValueOnce(new Error("down")); }],
    ["a malformed membership answer", (h: ReturnType<typeof harness>) => { h.companyMembership.mockResolvedValueOnce({ companyId: 7 } as never); }],
    ["a malformed grant answer", (h: ReturnType<typeof harness>) => { h.projectGrant.mockResolvedValueOnce("yes" as never); }],
  ])("answers unavailable (a refusal, never a departure) when %s cannot be read", async (_label, breakIt) => {
    const h = mixed();
    breakIt(h);
    const error = await errorOf(checkTaskPersonIdentity(h.identityDeps, task(), GALE_ID));
    expect(error.code).toBe("SLACK_UNAVAILABLE");
    expect(error.message).toContain("task person identity proof is unavailable");
    expect(h.slackCalls()).toBe(0);
  });

  it("is unavailable, before any read, when the membership or grant reader is not wired", async () => {
    for (const missing of ["companyMembership", "projectGrant"] as const) {
      const h = mixed();
      delete h.identityDeps[missing];
      expect((await errorOf(checkTaskPersonIdentity(h.identityDeps, task(), GALE_ID))).code).toBe("SLACK_UNAVAILABLE");
      expect(h.developerRecord).not.toHaveBeenCalled();
      expect(h.slackCalls()).toBe(0);
    }
  });

  it("proves a GitHub task creator (a task started with GitHub sign-in) as a web identity", async () => {
    const meta = task({ developerId: GALE_ID, provider: "github", developerName: "Gale GitHub" });
    delete (meta as { slackUserId?: string }).slackUserId;
    const h = harness({ tasks: [meta] });
    expect(await checkTaskPersonIdentity(h.identityDeps, meta, GALE_ID)).toStrictEqual(ELIGIBLE);
    expect(h.slackCalls()).toBe(0);
  });

  it("proves a GitHub task creator with no Slack link as web, with no Slack call", async () => {
    const meta = task({ developerId: GALE_ID, provider: "github", developerName: "Gale GitHub" });
    delete (meta as { slackUserId?: string }).slackUserId;
    const h = harness({ tasks: [meta] });
    expect(await checkTaskPersonIdentity(h.identityDeps, meta, GALE_ID)).toStrictEqual(ELIGIBLE);
    expect(h.slackCalls()).toBe(0);
  });

  it("DEC 254n (2): a GitHub task creator that stored a Slack id is Slack-linked like an OIDC one, so a sign-in record with no Slack link is refused (never proven as web)", async () => {
    const meta = task({ developerId: GALE_ID, provider: "github", developerName: "Gale GitHub", slackUserId: SAM });
    const h = harness({ tasks: [meta] });
    expect((await errorOf(checkTaskPersonIdentity(h.identityDeps, meta, GALE_ID))).code).toBe("PROJECT_ACCESS_DENIED");
    expect(h.slackCalls()).toBe(0);
  });

  it("refuses a creator whose sign-in record is of another method than the task's", async () => {
    const meta = task({ developerId: GALE_ID, provider: "cloud", developerName: "Gale GitHub" });
    delete (meta as { slackUserId?: string }).slackUserId;
    const h = harness({ tasks: [meta] });
    expect((await errorOf(checkTaskPersonIdentity(h.identityDeps, meta, GALE_ID))).code).toBe("PROJECT_ACCESS_DENIED");
  });

  it("refuses a task whose stored sign-in method is unknown", async () => {
    const meta = task({ provider: "google" as never });
    const h = harness({ tasks: [meta] });
    h.seed(webRow(), subjectRow(P_GALE, GALE_ID));
    expect((await errorOf(checkTaskPersonIdentity(h.identityDeps, meta, GALE_ID))).code).toBe("PROJECT_ACCESS_DENIED");
  });

  it("never treats a trusted web caller's own claims as a task person (only stored rows or the task creator)", async () => {
    const h = harness();
    h.identityDeps.trustedCaller = { developerId: GALE_ID, amr: "github", name: "Gale GitHub" };
    expect((await errorOf(checkTaskPersonIdentity(h.identityDeps, task(), GALE_ID))).code).toBe("PROJECT_ACCESS_DENIED");
    expect(h.companyMembership).not.toHaveBeenCalled();
  });
});

describe("Slack identities keep their proof (D2)", () => {
  it("never asks the web readers about a Slack person", async () => {
    const h = mixed();
    await expect(checkTaskPersonIdentity(h.identityDeps, task(), SAM_ID)).resolves.toStrictEqual({
      subject: { developerId: SAM_ID, slackUserId: SAM },
      identity: { developerId: SAM_ID, slackUserId: SAM, name: "Sam Slack", method: "slack", issuer: SLACK_OIDC_ISSUER, subject: SAM },
      eligible: true, channelMember: true,
    });
    expect(h.proof).toHaveBeenCalledTimes(1);
    expect(h.companyMembership).not.toHaveBeenCalled();
    expect(h.projectGrant).not.toHaveBeenCalled();
  });
});

describe("resolveTaskPersonId for a web person", () => {
  it("resolves an eligible web person, with no Slack call", async () => {
    const h = mixed();
    await expect(resolveTaskPersonId(h.identityDeps, TASK_A, P_GALE)).resolves.toMatchObject({ developerId: GALE_ID, method: "github" });
    expect(h.slackCalls()).toBe(0);
  });

  it.each([
    ["lost membership", { memberships: { [GALE_ID]: { companyId: COMPANY_B } } }],
    ["no grant", { grants: { [GALE_ID]: false } }],
    ["a revoked sign-in", { records: { [GALE_ID]: galeRecord({ revoked: true }) } }],
    ["an unreadable membership", { memberships: { [GALE_ID]: "throw" as const } }],
  ])("refuses a web person with %s", async (_label, world) => {
    const h = mixed("commenter", world);
    expect((await errorOf(resolveTaskPersonId(h.identityDeps, TASK_A, P_GALE))).code).toBe("PROJECT_ACCESS_DENIED");
    expect(h.slackCalls()).toBe(0);
  });
});

describe("People lifecycle with web identities (real proof wired in)", () => {
  it("mixed task: a Slack owner and a web commenter each keep their role; only Sam's proof calls Slack", async () => {
    const h = mixed("commenter");
    await expect(resolveTaskPeopleAccess(h.peopleDeps, task(), GALE_ID)).resolves.toMatchObject({ role: "commenter", peopleRevision: 3, orphaned: false });
    await expect(resolveTaskPeopleAccess(h.peopleDeps, task(), SAM_ID)).resolves.toMatchObject({ role: "owner", peopleRevision: 3 });
    await expect(getTaskPeopleCapabilities(h.peopleDeps, GALE_CALLER, TASK_A)).resolves.toEqual({ peopleRevision: 3, canManagePeople: false, canTakeOwnership: false });
    expect(h.proof.mock.calls.every(([request]) => request.slackUserId === SAM)).toBe(true);
    expect(h.db.get(`DEVTASK#${TASK_A}`, "PEOPLE")).toMatchObject({ revision: 3 });
  });

  it("counts a present web owner for dispatch beside the Slack owner", async () => {
    const h = mixed("owner");
    await expect(resolveTaskDispatchPeople(h.peopleDeps, task())).resolves.toStrictEqual({
      peopleRevision: 3, ownerActorIds: [taskOwnerKey(SAM_ID, TASK_A), taskOwnerKey(GALE_ID, TASK_A)], status: "ALLOWED",
    });
  });

  it.each([
    ["loses company membership", { memberships: { [GALE_ID]: { companyId: COMPANY_B } } }],
    ["loses the project grant", { grants: { [GALE_ID]: false } }],
    ["has the sign-in revoked", { records: { [GALE_ID]: galeRecord({ revoked: true }) } }],
  ])("a sole web owner who %s leaves the task ownerless, and reconcile denies them", async (_label, world) => {
    const h = mixed("owner", world, { samRole: "commenter" });
    await expect(resolveTaskDispatchPeople(h.peopleDeps, task())).resolves.toStrictEqual({ peopleRevision: 3, ownerActorIds: [], status: "OWNERLESS" });
    // Sam reads the task: reconcile writes the departure exactly like a Slack departure.
    await expect(resolveTaskPeopleAccess(h.peopleDeps, task(), SAM_ID)).resolves.toMatchObject({ role: "commenter", orphaned: true, peopleRevision: 4 });
    expect(h.db.get(`DEVTASK#${TASK_A}`, "PEOPLE")).toMatchObject({ revision: 4, orphaned: true, people: [SAM_ENTRY("commenter"), GALE_ENTRY("denied")] });
  });

  it("keeps the PEOPLE row untouched and parks dispatch (UNKNOWN) when a web owner's membership cannot be read", async () => {
    const h = mixed("owner", { memberships: { [GALE_ID]: "throw" } }, { samRole: "commenter" });
    const before = JSON.stringify(h.db.get(`DEVTASK#${TASK_A}`, "PEOPLE"));
    await expect(resolveTaskDispatchPeople(h.peopleDeps, task())).resolves.toStrictEqual({ peopleRevision: 3, ownerActorIds: [], status: "UNKNOWN" });
    expect((await errorOf(resolveTaskPeopleAccess(h.peopleDeps, task(), SAM_ID))).code).toBe("TASK_ACCESS_DENIED");
    expect(JSON.stringify(h.db.get(`DEVTASK#${TASK_A}`, "PEOPLE"))).toBe(before);
  });

  it("lets the Slack owner make a present web person an owner, writing the web entry shape and no Slack invite", async () => {
    const h = mixed("commenter");
    await changeTaskPeople(h.peopleDeps, SAM_CALLER, TASK_A, {
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", expectedPeopleRevision: 3, targetDeveloperId: GALE_ID, role: "owner",
    });
    expect(h.db.get(`DEVTASK#${TASK_A}`, "PEOPLE")).toMatchObject({ revision: 4, people: [SAM_ENTRY("owner"), GALE_ENTRY("owner")] });
    expect(h.db.find((item) => String(item.sk).startsWith("PEOPLE_NOTIFY#"))).toEqual([]);
    await expect(resolveTaskPeopleTarget(h.peopleDeps, TASK_A, P_GALE)).resolves.toEqual({ developerId: GALE_ID });
  });

  it("refuses to make a web person without a grant an owner, and writes nothing", async () => {
    const h = mixed("commenter", { grants: { [GALE_ID]: false } });
    const before = JSON.stringify(h.db.get(`DEVTASK#${TASK_A}`, "PEOPLE"));
    expect((await errorOf(changeTaskPeople(h.peopleDeps, SAM_CALLER, TASK_A, {
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", expectedPeopleRevision: 3, targetDeveloperId: GALE_ID, role: "owner",
    }))).code).toBe("TASK_ACCESS_DENIED");
    expect(JSON.stringify(h.db.get(`DEVTASK#${TASK_A}`, "PEOPLE"))).toBe(before);
  });

  it("lets a present web commenter take ownership of an orphaned task", async () => {
    const h = mixed("commenter", {}, { samRole: "commenter", orphaned: true });
    await takeTaskOwnership(h.peopleDeps, GALE_CALLER, TASK_A, { requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", expectedPeopleRevision: 3 });
    expect(h.db.get(`DEVTASK#${TASK_A}`, "PEOPLE")).toMatchObject({ orphaned: false, people: [SAM_ENTRY("commenter"), GALE_ENTRY("owner")] });
  });

  it("never lets a company B web person take ownership of company A's orphaned task", async () => {
    const h = mixed("commenter", { memberships: { [GALE_ID]: { companyId: COMPANY_B } } }, { samRole: "commenter", orphaned: true });
    const before = JSON.stringify(h.db.get(`DEVTASK#${TASK_A}`, "PEOPLE"));
    expect((await errorOf(takeTaskOwnership(h.peopleDeps, GALE_CALLER, TASK_A, { requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", expectedPeopleRevision: 3 }))).code).toBe("TASK_ACCESS_DENIED");
    expect(JSON.stringify(h.db.get(`DEVTASK#${TASK_A}`, "PEOPLE"))).toBe(before);
  });
});

describe("the route wiring (developerTaskRouteDependencies)", () => {
  const SIGNIN = "signin";
  function routeWorld(options: { slackTeamId?: string; membershipCompany?: string; grantRole?: string; channelPolicy?: boolean; projectCompany?: string; membership?: Record<string, unknown> | null; noCompanies?: true } = {}) {
    const db = new FakeDynamoDb();
    const meta = task();
    db.set(meta as unknown as Record<string, unknown>);
    db.set(webRow());
    db.set(subjectRow(P_GALE, GALE_ID));
    db.set({ pk: `DEVELOPER#${GALE_ID}`, sk: "META", ...galeRecord() });
    const membershipRow = { pk: `COMPANY_MEMBER#${GALE_ID}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: GALE_ID, companyId: options.membershipCompany ?? COMPANY_A, role: "member", joinedAt: CREATED };
    if (options.membership !== null) db.set({ ...membershipRow, ...(options.membership ?? {}) });
    // DEC 254zzz80: the project in its company's own partition.
    db.set(companyProjectRow(options.projectCompany ?? COMPANY_A, "payments", 7, options.channelPolicy === true ? { developerTasks: { enabled: true, channelMembersMayUse: true } } : {}));
    // DEC 254zzz80: the task's company (A) is a named company: its grants live in its own partition.
    if (options.grantRole !== "none") db.set({ pk: `ORG#${COMPANY_A}#MEMBER#${GALE_ID}`, sk: "PROJECT#payments", projectName: "payments", role: options.grantRole ?? "developer" });
    if (options.channelPolicy === true) db.set({ pk: `SLACK_BINDING#${TEAM}`, sk: `CHANNEL#${CHANNEL}`, teamId: TEAM, channelId: CHANNEL, projectName: "payments", updatedAt: CREATED });
    const developer = {
      signInTableName: SIGNIN, issuer: "https://code.example.test", ...(options.noCompanies === true ? {} : { companies: companyMembershipFromDynamo(db, SIGNIN) }),
      ...(options.slackTeamId === undefined ? {} : { slackTeamId: options.slackTeamId, taskPersonProof: vi.fn() }),
    };
    const deps = developerTaskRouteDependencies({ documentClient: db, tableName: "state", developer, now: () => T0, tasks: {} } as never, GALE_CALLER);
    return { db, deps, meta };
  }

  it("proves a web person on an install with no Slack at all", async () => {
    const { deps, meta } = routeWorld();
    await expect(deps.checkTaskPerson!(meta, GALE_ID)).resolves.toMatchObject({ eligible: true, channelMember: true });
  });

  it.each([["developer"], ["administrator"]])("accepts a live %s grant", async (role) => {
    const { deps, meta } = routeWorld({ grantRole: role });
    await expect(deps.checkTaskPerson!(meta, GALE_ID)).resolves.toMatchObject({ eligible: true, channelMember: true });
  });

  it.each([
    ["no grant", { grantRole: "none" }],
    ["a grant role that cannot use the project", { grantRole: "viewer" }],
    ["channel-only access (the project lets channel members use it, and a channel is bound)", { grantRole: "none", channelPolicy: true, slackTeamId: TEAM }],
    ["membership in another company", { membershipCompany: COMPANY_B }],
  ])("finds no web proof with %s", async (_label, options) => {
    const { deps, meta } = routeWorld(options);
    await expect(deps.checkTaskPerson!(meta, GALE_ID)).resolves.toMatchObject({ eligible: false, channelMember: false });
  });

  it.each([
    ["no membership row", { membership: null }],
    ["a revoked membership", { membership: { revokedAt: CREATED, revokedBy: "admin" } }],
  ])("finds a proven loss with %s", async (_label, options) => {
    const { deps, meta } = routeWorld(options);
    await expect(deps.checkTaskPerson!(meta, GALE_ID)).resolves.toMatchObject({ eligible: false, channelMember: false });
  });

  it.each([
    ["a membership row with no join time", { membership: { joinedAt: undefined } }],
    ["a membership row naming another person", { membership: { personId: OLA_ID } }],
    ["a membership row with an unknown role", { membership: { role: "boss" } }],
    ["a membership row of another entity type", { membership: { entityType: "COMPANY_MEMBER_VIEW" } }],
    ["an install without the company layer", { noCompanies: true as const }],
  ])("refuses (unavailable, never a departure) with %s", async (_label, options) => {
    const { deps, meta } = routeWorld(options);
    await expect(deps.checkTaskPerson!(meta, GALE_ID)).rejects.toMatchObject({ code: "SLACK_UNAVAILABLE" });
  });

  it("D2: a Slack-linked OIDC creator with a revoked sign-in still refuses with the Slack build's error on an install with no Slack (never eligible:false)", async () => {
    const { db, deps } = routeWorld();
    const meta = task({ developerId: OLA_ID, provider: "oidc", developerName: "Ola Oidc", slackUserId: SAM });
    db.set(meta as unknown as Record<string, unknown>);
    db.set({ pk: `DEVELOPER#${OLA_ID}`, sk: "META", developerId: OLA_ID, provider: "oidc", issuer: OIDC_ISSUER, subject: "ola-employee", displayName: "Ola Oidc",
      slackUserId: SAM, firstSignInAt: CREATED, lastSignInAt: CREATED, revoked: true });
    // The company layer is on and the task has no workspace for this caller: the same refusal the Slack parts' build gave before C2.
    await expect(deps.checkTaskPerson!(meta, OLA_ID)).rejects.toMatchObject({ name: "SlackWorkspaceRefused" });
  });

  it("refuses (unavailable) when the task's project belongs to another company", async () => {
    const { deps, meta } = routeWorld({ projectCompany: COMPANY_B });
    await expect(deps.checkTaskPerson!(meta, GALE_ID)).rejects.toMatchObject({ code: "SLACK_UNAVAILABLE" });
  });

  it("still refuses a Slack person when the Slack parts cannot be built, with the build's own error and no Slack call", async () => {
    const { db, deps, meta } = routeWorld();
    db.set(slackRow(P_SAM, SAM, "Sam Slack"));
    db.set(subjectRow(P_SAM, SAM_ID));
    await expect(deps.checkTaskPerson!(meta, SAM_ID)).rejects.toMatchObject({ name: "SlackWorkspaceRefused" });
  });
});
