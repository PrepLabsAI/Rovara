// TASK-TAKEOVER PR A (permissions and money): who a task's next step runs for, and who is charged for it, on the real People functions over a fake table.
//   - `hostedTaskAccess.checkStep`: a task with a People list never takes the starter rule; the step is allowed only when a CURRENT owner passes the live proof now (each owner proved again, never its stored role);
//     an orphaned list, an unreadable one and a proof that throws refuse; the verdict names the owner it rests on and fences the People revision.
//   - the owner a step is charged to, with several owners: the owner of the latest decision, else the latest take-over, else the first of the list; always an owner who passed.
//   - re-admission: a previous owner given the project back holds nothing until a current owner sets them back to owner through People; a starter of a task with no list who is given the grant back owns it again.
//   - the workspace slot moves with the owner at a take-over (and, in company-member-handover.test.ts, at a hand-over): nothing double-counted, nothing left on the person who left.
import { describe, expect, it } from "vitest";
import { OWNER_LEFT_PROJECT_WORDS, OWNER_NEEDS_GRANT_WORDS, OWNER_UNREADABLE_WORDS, SLACK_OIDC_ISSUER, type DocumentStore, type OrgId } from "@agentx/contracts";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { hostedTaskAccess, NO_PROJECT_GRANT, NOT_A_MEMBER_HERE } from "../../packages/broker/src/aws/core-engine-root.js";
import { holdsOwnTask, listsAsOwn } from "../../packages/broker/src/aws/task-readers.js";
import { checkTaskPersonIdentity, type TaskPersonIdentityDependencies } from "../../packages/broker/src/developer/task-person-identity.js";
import { changeTaskPeople, getTaskPeople, getTaskPeopleCapabilities, PEOPLE_RECONCILE_ACTOR, resolveTaskListOwners, takeTaskOwnership, taskOwnershipHandOverSteps, type TaskPeopleDependencies, type TaskPersonCheck } from "../../packages/broker/src/developer/task-people.js";
import { taskPeopleEntryOf } from "../../packages/broker/src/developer/task-person-rows.js";
import { taskOwnerKey, type DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import type { DeveloperRecord } from "../../packages/broker/src/developer/store.js";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { T0, TEAM } from "../support/developer-fakes.js";

const TASK = "44444444-4444-4444-8444-444444444444";
const COMPANY: OrgId = `org_${"a".repeat(20)}`;
const GH = "https://github.com";
const CLOUD = "https://cloud.example.test";
const OIDC = "https://id.example.test";
const GALE_ID = ownerKeyForSubject(GH, "gh-1234");
const WREN_ID = ownerKeyForSubject(CLOUD, "wren-7");
const OLA_ID = ownerKeyForSubject(OIDC, "ola-employee");
const P_GALE = "66666666-6666-4666-8666-666666666666";
const P_WREN = "99999999-9999-4999-8999-999999999999";
const P_OLA = "77777777-7777-4777-8777-777777777777";
const CREATED = new Date(T0 - 60_000).toISOString();
const IDENTITIES: Record<string, { provider: "github" | "cloud" | "oidc"; issuer: string; subject: string; name: string }> = {
  [GALE_ID]: { provider: "github", issuer: GH, subject: "gh-1234", name: "Gale GitHub" },
  [WREN_ID]: { provider: "cloud", issuer: CLOUD, subject: "wren-7", name: "Wren Cloud" },
  [OLA_ID]: { provider: "oidc", issuer: OIDC, subject: "ola-employee", name: "Ola Employee" },
};
const identityOf = (developerId: string): { provider: "github" | "cloud" | "oidc"; issuer: string; subject: string; name: string } => { const found = IDENTITIES[developerId]; if (found === undefined) throw new Error("unknown test person"); return found; };
const GALE_MEMBER = `DEVELOPER_LIMIT#${GALE_ID}`;
const WREN_MEMBER = `DEVELOPER_LIMIT#${WREN_ID}`;

/** A task Gale started on the web (no Slack share), holding a workspace slot of her own counter. */
const webTask = (overrides: Record<string, unknown> = {}): DeveloperTaskRecord => ({
  pk: `DEVTASK#${TASK}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: TASK, developerId: GALE_ID, provider: "github", developerName: "Gale GitHub", client: "web", project: "payments", title: "Payments",
  workspaceId: `workspace-${TASK}`, ownerKey: taskOwnerKey(GALE_ID, TASK), conversationId: "conversation", startingRevision: 1,
  charge: { member: { pk: GALE_MEMBER, sk: "MEMBER" }, organization: { pk: "ORG_LIMIT#x", sk: "ORGANIZATION" } }, shared: false, createdAt: CREATED, updatedAt: CREATED, companyId: COMPANY,
  workflow: { revision: 7, stage: "PLAN_REVIEW", state: "WAITING", ownerId: taskOwnerKey(GALE_ID, TASK), decisions: [] }, ...overrides,
}) as unknown as DeveloperTaskRecord;

const personRow = (personId: string, developerId: string) => {
  const who = identityOf(developerId);
  return { pk: `DEVTASK#${TASK}`, sk: `PERSON#${personId}`, schemaVersion: 1, personId, developerId, name: who.name, method: who.provider, issuer: who.issuer, subject: who.subject, createdAt: CREATED };
};
const subjectRow = (personId: string, developerId: string) => ({ pk: `DEVTASK#${TASK}`, sk: `PERSON_SUBJECT#${developerId}`, schemaVersion: 1, personId, developerId, createdAt: CREATED });
const entry = (developerId: string, role: string) => ({ developerId, name: identityOf(developerId).name, role, method: identityOf(developerId).provider });
const peopleRow = (people: unknown[], revision = 3, orphaned = false) => ({ pk: `DEVTASK#${TASK}`, sk: "PEOPLE", schemaVersion: 1, revision, orphaned, people });
const caller = (developerId: string): DeveloperCaller => ({ developerId, name: identityOf(developerId).name, sessionId: `session-${developerId.slice(0, 6)}`, amr: identityOf(developerId).provider === "oidc" ? "oidc" : identityOf(developerId).provider });

interface World { memberships?: Record<string, string | undefined>; grants?: Record<string, boolean>; throwProof?: string[] }

function harness(world: World = {}, task: DeveloperTaskRecord = webTask()) {
  const db = new FakeDynamoDb();
  db.set(task as unknown as Record<string, unknown>);
  const memberships: Record<string, string | undefined> = { [GALE_ID]: COMPANY, [WREN_ID]: COMPANY, [OLA_ID]: COMPANY, ...(world.memberships ?? {}) };
  const grants: Record<string, boolean> = { [GALE_ID]: true, [WREN_ID]: true, [OLA_ID]: true, ...(world.grants ?? {}) };
  const records = Object.fromEntries(Object.entries(IDENTITIES).map(([id, who]) => [id, { developerId: id, provider: who.provider, issuer: who.issuer, subject: who.subject, displayName: who.name, firstSignInAt: CREATED, lastSignInAt: CREATED, revoked: false } satisfies DeveloperRecord]));
  const identityDeps: TaskPersonIdentityDependencies = {
    documentClient: db, tableName: "state", slackTeamId: TEAM, now: () => T0, uuid: () => P_GALE,
    taskPersonProof: async () => { throw new Error("no slack here"); },
    developerRecord: async (developerId) => records[developerId],
    projectChannelIds: async () => [], targetProjectAccess: async () => undefined,
    companyMembership: async (developerId) => memberships[developerId] === undefined ? undefined : { companyId: memberships[developerId] },
    projectGrant: async (developerId) => grants[developerId] ?? false,
  };
  const peopleDeps: TaskPeopleDependencies = {
    documentClient: db, tableName: "state", now: () => T0, taskPeopleConfiguration: { peopleChangesEnabled: true },
    checkTaskPerson: async (t, developerId) => { if (world.throwProof?.includes(developerId)) throw new Error("the proof does not answer"); return checkTaskPersonIdentity(identityDeps, t, developerId); },
  };
  const store = {
    get: async (key: { pk: string; sk: string }) => db.get(key.pk, key.sk),
    query: async (request: { pk: string; sk?: { op: string; prefix?: string }; limit?: number }) => ({ items: db.find((item) => item["pk"] === request.pk && (request.sk?.prefix === undefined || String(item["sk"]).startsWith(request.sk.prefix))).slice(0, request.limit) }),
  } as unknown as DocumentStore;
  const access = (extra: { people?: TaskPeopleDependencies | undefined } = { people: peopleDeps }) => hostedTaskAccess({
    companyId: COMPANY, membershipOf: async (id) => memberships[id] === undefined ? undefined : { companyId: COMPANY, role: "member" }, projectGrant: async (id) => grants[id] ?? false,
    storage: async () => store, ...(extra.people === undefined ? {} : { people: extra.people }),
  });
  const seed = (...rows: Array<Record<string, unknown>>) => { for (const row of rows) db.set(row); };
  const people = () => db.get(`DEVTASK#${TASK}`, "PEOPLE") as unknown as { revision: number; orphaned: boolean; people: Array<{ developerId: string; role: string }> };
  const step = { taskId: TASK, developerId: GALE_ID, project: "payments" };
  return { db, memberships, grants, peopleDeps, access, store, seed, people, step };
}

/** Gale and Wren registered on the task, with the list as given. */
function listed(people: unknown[], world: World = {}, revision = 3, orphaned = false, task: DeveloperTaskRecord = webTask()) {
  const h = harness(world, task);
  h.seed(personRow(P_GALE, GALE_ID), subjectRow(P_GALE, GALE_ID), personRow(P_WREN, WREN_ID), subjectRow(P_WREN, WREN_ID), personRow(P_OLA, OLA_ID), subjectRow(P_OLA, OLA_ID), peopleRow(people, revision, orphaned));
  return h;
}

describe("checkStep: a task with a People list runs for its CURRENT owner, never for its starter", () => {
  it("a task with no list takes the starter rule exactly as before: the starter's own membership and grant, and no owner or fence in the verdict", async () => {
    const h = harness();
    expect(await h.access().checkStep(h.step)).toEqual({ allowed: true });
    h.grants[GALE_ID] = false;
    expect(await h.access().checkStep(h.step)).toEqual({ allowed: false, message: NO_PROJECT_GRANT });
    h.memberships[GALE_ID] = undefined;
    expect(await h.access().checkStep(h.step)).toEqual({ allowed: false, message: NOT_A_MEMBER_HERE });
  });

  it("the starter is the sole owner of the list: allowed, running for the starter, with the People revision fenced", async () => {
    const h = listed([entry(GALE_ID, "owner")], {}, 4);
    expect(await h.access().checkStep(h.step)).toEqual({ allowed: true, owner: { personId: GALE_ID, name: "Gale GitHub" }, items: [expect.objectContaining({ kind: "check", key: { pk: `DEVTASK#${TASK}`, sk: "PEOPLE" } })] });
    const verdict = await h.access().checkStep(h.step);
    expect(JSON.stringify(verdict)).toContain('"revision"');
    expect(JSON.stringify(verdict)).toContain("4");
  });

  it("the starter left the company and a successor owns the task: the step is allowed, for the successor", async () => {
    const h = listed([entry(GALE_ID, "denied"), entry(WREN_ID, "owner")], { memberships: { [GALE_ID]: undefined } });
    expect(await h.access().checkStep(h.step)).toMatchObject({ allowed: true, owner: { personId: WREN_ID, name: "Wren Cloud" } });
  });

  it("the starter lost the project and a colleague took the task over: allowed, for the colleague", async () => {
    const h = listed([entry(GALE_ID, "denied"), entry(WREN_ID, "owner")], { grants: { [GALE_ID]: false } });
    expect(await h.access().checkStep(h.step)).toMatchObject({ allowed: true, owner: { personId: WREN_ID } });
  });

  it("a live starter the list denies is never the person a step runs for: the starter rule is not used while a list exists", async () => {
    // The starter is a member with the grant (they would pass the starter rule), but the list gave the task to someone else: the step runs for that person.
    const given = listed([entry(GALE_ID, "denied"), entry(WREN_ID, "owner")]);
    expect(await given.access().checkStep(given.step)).toMatchObject({ allowed: true, owner: { personId: WREN_ID } });
    // And with nobody left to own it, the starter does not stand in: refused, in the one no-owner sentence.
    const nobody = listed([entry(GALE_ID, "denied")], {}, 3, true);
    expect(await nobody.access().checkStep(nobody.step)).toEqual({ allowed: false, message: OWNER_LEFT_PROJECT_WORDS });
  });

  it("an owner's stored role is never enough: a stale owner entry of a person who is gone does not keep the task running", async () => {
    // Gale and Wren are both stored as owners; Gale has left the company. The step runs for Wren; with Wren gone too, nothing runs.
    const one = listed([entry(GALE_ID, "owner"), entry(WREN_ID, "owner")], { memberships: { [GALE_ID]: undefined } });
    expect(await one.access().checkStep(one.step)).toMatchObject({ allowed: true, owner: { personId: WREN_ID } });
    const none = listed([entry(GALE_ID, "owner"), entry(WREN_ID, "owner")], { memberships: { [GALE_ID]: undefined, [WREN_ID]: undefined } });
    expect(await none.access().checkStep(none.step)).toEqual({ allowed: false, message: OWNER_LEFT_PROJECT_WORDS });
    // The same for a person who lost the project grant only.
    const noGrant = listed([entry(GALE_ID, "owner")], { grants: { [GALE_ID]: false } });
    expect(await noGrant.access().checkStep(noGrant.step)).toEqual({ allowed: false, message: OWNER_LEFT_PROJECT_WORDS });
  });

  it("a person the People proof passes but the company's live membership does not is not an owner either (the access seam is asked for each owner), and is never the one a step is charged to", async () => {
    // Wren's latest decision led to the step, but the access seam (the company's live membership) no longer knows Wren: the step runs for Gale.
    const decided = webTask({ workflow: { revision: 7, stage: "IMPLEMENT", state: "READY", ownerId: taskOwnerKey(GALE_ID, TASK), decisions: [{ requestId: "a", actorId: taskOwnerKey(WREN_ID, TASK) }] } });
    const h = listed([entry(GALE_ID, "owner"), entry(WREN_ID, "owner")], {}, 3, false, decided);
    const gone = hostedTaskAccess({ companyId: COMPANY, membershipOf: async (id) => id === WREN_ID ? undefined : { companyId: COMPANY, role: "member" }, projectGrant: async () => true, storage: async () => h.store, people: h.peopleDeps });
    expect(await gone.checkStep(h.step)).toMatchObject({ allowed: true, owner: { personId: GALE_ID } });
    // Every owner the People proof passes is refused by the access seam: nobody owns the task with the project, in the one sentence (and not "unreadable").
    const nobody = hostedTaskAccess({ companyId: COMPANY, membershipOf: async () => undefined, projectGrant: async () => true, storage: async () => h.store, people: h.peopleDeps });
    expect(await nobody.checkStep(h.step)).toEqual({ allowed: false, message: OWNER_LEFT_PROJECT_WORDS });
    const noGrant = hostedTaskAccess({ companyId: COMPANY, membershipOf: async () => ({ companyId: COMPANY, role: "member" }), projectGrant: async (id) => id !== WREN_ID, storage: async () => h.store, people: h.peopleDeps });
    expect(await noGrant.checkStep(h.step)).toMatchObject({ allowed: true, owner: { personId: GALE_ID } });
  });

  it("a list or a proof that cannot be READ is not an answer: the step THROWS (retried, never a blocked workflow); a list with no People dependencies is refused", async () => {
    const malformed = harness();
    malformed.seed({ pk: `DEVTASK#${TASK}`, sk: "PEOPLE", schemaVersion: 1, revision: 1, orphaned: false, people: "not a list" });
    await expect(malformed.access().checkStep(malformed.step)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    await expect(malformed.access().checkStep(malformed.step)).rejects.toThrow(OWNER_UNREADABLE_WORDS);
    const throws = listed([entry(GALE_ID, "owner")], { throwProof: [GALE_ID] });
    await expect(throws.access().checkStep(throws.step)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    // The access seam throwing for every owner is the same: not "nobody owns it".
    const seam = listed([entry(GALE_ID, "owner")]);
    const broken = hostedTaskAccess({ companyId: COMPANY, membershipOf: async () => { throw new Error("down"); }, projectGrant: async () => true, storage: async () => seam.store, people: seam.peopleDeps });
    await expect(broken.checkStep(seam.step)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    const noPeople = listed([entry(GALE_ID, "owner")]);
    expect(await noPeople.access({ people: undefined }).checkStep(noPeople.step)).toEqual({ allowed: false, message: OWNER_UNREADABLE_WORDS });
  });

  it("an orphaned list refuses whatever its stored entries say", async () => {
    const h = listed([entry(GALE_ID, "owner"), entry(WREN_ID, "commenter")], {}, 3, true);
    expect(await h.access().checkStep(h.step)).toEqual({ allowed: false, message: OWNER_LEFT_PROJECT_WORDS });
  });

  it("a setup run keeps its own rule even with a list", async () => {
    const h = listed([entry(GALE_ID, "denied"), entry(WREN_ID, "owner")], {}, 3, false, webTask({ purpose: "setup_agent" }));
    const access = hostedTaskAccess({ companyId: COMPANY, membershipOf: async () => ({ companyId: COMPANY, role: "member" }), projectGrant: async () => true, storage: async () => h.store, people: h.peopleDeps,
      setupRunStanding: async () => ({ access: "manage", basis: "project-admin" }) });
    expect(await access.checkStep(h.step)).toEqual({ allowed: true });
  });
});

describe("the owner a step is charged to, with several owners", () => {
  const both = (world: World = {}, task: DeveloperTaskRecord = webTask()) => listed([entry(GALE_ID, "owner"), entry(WREN_ID, "owner"), entry(OLA_ID, "owner")], world, 3, false, task);
  const takeOver = (developerId: string, at: string, via: string) => ({ pk: `DEVTASK#${TASK}`, sk: `PEOPLE_EVENT#${at}`, entityType: "TASK_PEOPLE_EVENT", schemaVersion: 1, requestId: at, actorDeveloperId: developerId, targetDeveloperId: developerId, beforeRole: "commenter", afterRole: "owner", createdAt: at, via });

  it("with none to tell them apart: the first owner of the list", async () => {
    const h = both();
    expect(await h.access().checkStep(h.step)).toMatchObject({ allowed: true, owner: { personId: GALE_ID } });
  });

  it("the owner who took the task over most recently (a take-over or a hand-over), not one who was only added", async () => {
    const h = both();
    h.seed(takeOver(WREN_ID, "2026-11-20T10:00:00.000Z", "take_over"), takeOver(OLA_ID, "2026-11-22T10:00:00.000Z", "hand_over"), takeOver(GALE_ID, "2026-11-24T10:00:00.000Z", "added"));
    expect(await h.access().checkStep(h.step)).toMatchObject({ allowed: true, owner: { personId: OLA_ID } });
  });

  it("a history of more than 200 People events is not read newest-first (the rows are keyed by request id): the choice falls to the first owner of the list, never to an older take-over", async () => {
    const h = both();
    h.seed(takeOver(WREN_ID, "2026-11-01T10:00:00.000Z", "take_over"));
    for (let n = 0; n < 200; n += 1) h.seed({ pk: `DEVTASK#${TASK}`, sk: `PEOPLE_EVENT#z${String(n).padStart(4, "0")}`, entityType: "TASK_PEOPLE_EVENT", schemaVersion: 1, requestId: `z${String(n)}`, actorDeveloperId: GALE_ID, targetDeveloperId: OLA_ID, beforeRole: "owner", afterRole: "commenter", createdAt: "2026-11-05T10:00:00.000Z" });
    expect(await h.access().checkStep(h.step)).toMatchObject({ allowed: true, owner: { personId: GALE_ID } });
    // Within the bound (200 rows) the same history is read: Wren's take-over is the latest.
    const within = both();
    within.seed(takeOver(WREN_ID, "2026-11-01T10:00:00.000Z", "take_over"));
    for (let n = 0; n < 199; n += 1) within.seed({ pk: `DEVTASK#${TASK}`, sk: `PEOPLE_EVENT#z${String(n).padStart(4, "0")}`, entityType: "TASK_PEOPLE_EVENT", schemaVersion: 1, requestId: `z${String(n)}`, actorDeveloperId: GALE_ID, targetDeveloperId: OLA_ID, beforeRole: "owner", afterRole: "commenter", createdAt: "2026-11-05T10:00:00.000Z" });
    expect(await within.access().checkStep(within.step)).toMatchObject({ allowed: true, owner: { personId: WREN_ID } });
  });

  it("the owner whose latest decision led to the step, over any take-over, while they are still an owner who passes", async () => {
    const decided = (by: string) => webTask({ workflow: { revision: 7, stage: "IMPLEMENT", state: "READY", ownerId: taskOwnerKey(GALE_ID, TASK), decisions: [{ requestId: "a", actorId: taskOwnerKey(GALE_ID, TASK) }, { requestId: "b", actorId: taskOwnerKey(by, TASK) }] } });
    const h = both({}, decided(WREN_ID));
    h.seed(takeOver(OLA_ID, "2026-11-22T10:00:00.000Z", "hand_over"));
    expect(await h.access().checkStep(h.step)).toMatchObject({ allowed: true, owner: { personId: WREN_ID } });
    // The decider left the company: the step is charged to the next choice, never to someone without access.
    const left = both({ memberships: { [WREN_ID]: undefined } }, decided(WREN_ID));
    left.seed(takeOver(OLA_ID, "2026-11-22T10:00:00.000Z", "hand_over"));
    expect(await left.access().checkStep(left.step)).toMatchObject({ allowed: true, owner: { personId: OLA_ID } });
  });
});

describe("a step a person pressed is charged to the presser", () => {
  const decided = (by: string) => webTask({ workflow: { revision: 7, stage: "IMPLEMENT", state: "READY", ownerId: taskOwnerKey(GALE_ID, TASK), decisions: [{ requestId: "a", actorId: taskOwnerKey(by, TASK) }] } });
  const three = (world: World = {}) => listed([entry(GALE_ID, "owner"), entry(WREN_ID, "owner"), entry(OLA_ID, "owner")], world, 3, false, decided(GALE_ID));

  it("owner A decided last and owner B pressed: B is charged (the order is for steps nobody pressed)", async () => {
    const h = three();
    expect(await h.access().checkStep(h.step)).toMatchObject({ allowed: true, owner: { personId: GALE_ID } });
    expect(await h.access().checkStep(h.step, WREN_ID)).toMatchObject({ allowed: true, owner: { personId: WREN_ID, name: "Wren Cloud" } });
  });

  it("a presser the list still calls an owner who has lost access is refused in the one sentence, never charged to another owner", async () => {
    const lost = three({ memberships: { [WREN_ID]: undefined } });
    expect(await lost.access().checkStep(lost.step, WREN_ID)).toEqual({ allowed: false, message: OWNER_LEFT_PROJECT_WORDS });
    expect(await lost.access().checkStep(lost.step)).toMatchObject({ allowed: true, owner: { personId: GALE_ID } });
    const noGrant = three({ grants: { [WREN_ID]: false } });
    expect(await noGrant.access().checkStep(noGrant.step, WREN_ID)).toEqual({ allowed: false, message: OWNER_LEFT_PROJECT_WORDS });
  });

  it("a presser the list no longer calls an owner (handed over, taken over, denied) has no press that stands: the order applies, to an owner who passes", async () => {
    const h = listed([entry(GALE_ID, "denied"), entry(WREN_ID, "owner")], { memberships: { [GALE_ID]: undefined } });
    expect(await h.access().checkStep(h.step, GALE_ID)).toMatchObject({ allowed: true, owner: { personId: WREN_ID } });
  });

  it("with two owners, a presser whose own proof or membership could not be READ is a thrown retryable error, never \"no owner\"", async () => {
    const proofDown = three({ throwProof: [WREN_ID] });
    await expect(proofDown.access().checkStep(proofDown.step, WREN_ID)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    // Nobody pressed: the owner whose proof reads is charged, as before.
    expect(await proofDown.access().checkStep(proofDown.step)).toMatchObject({ allowed: true, owner: { personId: GALE_ID } });
    const h = three();
    const seamDown = hostedTaskAccess({ companyId: COMPANY, membershipOf: async (id) => { if (id === WREN_ID) throw new Error("down"); return { companyId: COMPANY, role: "member" }; }, projectGrant: async () => true, storage: async () => h.store, people: h.peopleDeps });
    await expect(seamDown.checkStep(h.step, WREN_ID)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(await seamDown.checkStep(h.step)).toMatchObject({ allowed: true, owner: { personId: GALE_ID } });
  });

  it("a task with no list ignores the press: the starter's own rule", async () => {
    const h = harness();
    expect(await h.access().checkStep(h.step, WREN_ID)).toEqual({ allowed: true });
  });
});

describe("re-admission: a previous owner is out until a current owner says otherwise", () => {
  /** Gale (the starter) was handed over to Wren and is out of the list. Gale gets the project grant back (she is a live member with the grant). */
  const handedOver = () => listed([entry(GALE_ID, "denied"), entry(WREN_ID, "owner")]);

  it("the previous owner with the grant back does not run the task, own it, or list it as hers", async () => {
    const h = handedOver();
    const verdict = await h.access().checkStep(h.step);
    expect(verdict).toMatchObject({ allowed: true, owner: { personId: WREN_ID } });
    const reader = { documentClient: h.db, tableName: "state", taskReaderPerson: async () => ({ name: "x", projectMember: true, companyMember: true }) } as never;
    expect(await holdsOwnTask(reader, webTask(), GALE_ID)).toBe(false);
    expect(await holdsOwnTask(reader, webTask(), WREN_ID)).toBe(true);
    expect(await listsAsOwn({ ...(reader as object), companyId: COMPANY } as never, webTask(), GALE_ID, new Map())).toBe(false);
  });

  it("a current owner sets the previous owner back to owner through People, and their steps run again", async () => {
    const h = handedOver();
    await changeTaskPeople(h.peopleDeps, caller(WREN_ID), TASK, { requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", expectedPeopleRevision: 3, targetDeveloperId: GALE_ID, role: "owner" });
    expect(h.people().people.map((person) => [person.developerId, person.role])).toEqual([[GALE_ID, "owner"], [WREN_ID, "owner"]]);
    const verdict = await h.access().checkStep(h.step);
    expect(verdict).toMatchObject({ allowed: true });
    const reader = { documentClient: h.db, tableName: "state", taskReaderPerson: async () => ({ name: "x", projectMember: true, companyMember: true }) } as never;
    expect(await holdsOwnTask(reader, webTask(), GALE_ID)).toBe(true);
    // Wren steps down: the task runs for Gale alone.
    await changeTaskPeople(h.peopleDeps, caller(GALE_ID), TASK, { requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", expectedPeopleRevision: 4, targetDeveloperId: WREN_ID, role: "commenter" });
    expect(await h.access().checkStep(h.step)).toMatchObject({ allowed: true, owner: { personId: GALE_ID } });
  });

  it("a starter of a task with no list who is given the grant back before anyone took the task over owns it again", async () => {
    const h = harness({ grants: { [GALE_ID]: false } });
    const reader = (granted: boolean) => ({ documentClient: h.db, tableName: "state", taskReaderPerson: async () => ({ name: "x", projectMember: granted, companyMember: true }) }) as never;
    expect(await h.access().checkStep(h.step)).toEqual({ allowed: false, message: NO_PROJECT_GRANT });
    expect(await holdsOwnTask(reader(false), webTask(), GALE_ID)).toBe(false);
    h.grants[GALE_ID] = true;
    expect(await h.access().checkStep(h.step)).toEqual({ allowed: true });
    expect(await holdsOwnTask(reader(true), webTask(), GALE_ID)).toBe(true);
    expect(await listsAsOwn({ ...(reader(true) as object), companyId: COMPANY } as never, webTask(), GALE_ID, new Map())).toBe(true);
  });
});

describe("the workspace slot moves with the owner at a take-over", () => {
  const counter = (pk: string, count: number) => ({ pk, sk: "MEMBER", entityType: "DEVELOPER_LIMIT", count });
  const marker = (pk: string) => ({ pk, sk: `TASK#${TASK}`, entityType: "DEVELOPER_LIMIT_TASK", taskId: TASK, memberSk: "MEMBER", chargedAt: CREATED });
  const orphaned = (task: DeveloperTaskRecord = webTask()) => listed([entry(GALE_ID, "denied"), entry(WREN_ID, "commenter")], {}, 3, true, task);
  const take = (h: ReturnType<typeof harness>) => takeTaskOwnership(h.peopleDeps, caller(WREN_ID), TASK, { requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", expectedPeopleRevision: 3 });

  it("the slot goes to the taker in the same write: the old counter and marker are given back, the new ones taken, the task names the new counter, the company's count is unchanged", async () => {
    const h = orphaned();
    h.seed(counter(GALE_MEMBER, 2), marker(GALE_MEMBER), counter(WREN_MEMBER, 1), { pk: "ORG_LIMIT#x", sk: "ORGANIZATION", count: 5 });
    await take(h);
    expect(h.db.get(GALE_MEMBER, "MEMBER")).toMatchObject({ count: 1 });
    expect(h.db.get(GALE_MEMBER, `TASK#${TASK}`)).toBeUndefined();
    expect(h.db.get(WREN_MEMBER, "MEMBER")).toMatchObject({ count: 2, entityType: "DEVELOPER_LIMIT" });
    expect(h.db.get(WREN_MEMBER, `TASK#${TASK}`)).toMatchObject({ taskId: TASK, memberSk: "MEMBER", chargedAt: CREATED });
    expect((h.db.get(`DEVTASK#${TASK}`, "META") as { charge: { member: { pk: string } } }).charge.member.pk).toBe(WREN_MEMBER);
    expect(h.db.get("ORG_LIMIT#x", "ORGANIZATION")).toMatchObject({ count: 5 });
    // The take-over is recorded as one (the step's owner choice reads it).
    expect(h.db.get(`DEVTASK#${TASK}`, "PEOPLE_EVENT#cccccccc-cccc-4ccc-8ccc-cccccccccccc")).toMatchObject({ via: "take_over", targetDeveloperId: WREN_ID, afterRole: "owner" });
  });

  it("a new owner who is over their own limit still takes the task (a limit gates a start, never a running task), and a task that holds no slot moves none", async () => {
    const full = orphaned();
    full.seed(counter(GALE_MEMBER, 1), marker(GALE_MEMBER), counter(WREN_MEMBER, 99));
    await take(full);
    expect(full.db.get(WREN_MEMBER, "MEMBER")).toMatchObject({ count: 100 });
    const none = orphaned();
    none.seed(counter(GALE_MEMBER, 3));
    await take(none);
    expect(none.db.get(GALE_MEMBER, "MEMBER")).toMatchObject({ count: 3 });
    expect(none.db.get(WREN_MEMBER, "MEMBER")).toBeUndefined();
    expect((none.db.get(`DEVTASK#${TASK}`, "META") as { charge: { member: { pk: string } } }).charge.member.pk).toBe(GALE_MEMBER);
    expect(none.people().people.find((person) => person.developerId === WREN_ID)?.role).toBe("owner");
  });
});

describe("ARCH RULING (b): a task owner needs an INDIVIDUAL project grant (a person who reaches the project only through its Slack channel is never an owner)", () => {
  const SLACKER_SLACK = "U0SLACKER1";
  const SLACKER_ID = developerIdForSlackUser(SLACKER_SLACK);
  const P_SLACKER = "88888888-8888-4888-8888-888888888888";
  const slackIdentity = { developerId: SLACKER_ID, slackUserId: SLACKER_SLACK, name: "Sam Slack", method: "slack" as const, issuer: SLACK_OIDC_ISSUER, subject: SLACKER_SLACK };
  const slackEntry = (role: "owner" | "commenter" | "viewer" | "denied") => taskPeopleEntryOf(slackIdentity, role);
  const slackPerson = () => ({ pk: `DEVTASK#${TASK}`, sk: `PERSON#${P_SLACKER}`, schemaVersion: 1, personId: P_SLACKER, ...slackIdentity, createdAt: CREATED });
  const slackSubject = () => subjectRow(P_SLACKER, SLACKER_ID);
  const slackCaller = (): DeveloperCaller => ({ developerId: SLACKER_ID, name: "Sam Slack", sessionId: "session-slacker", amr: "slack", slackUserId: SLACKER_SLACK });
  /** The proof says what the access seam says: this person passes through the project's Slack channel only. */
  const access = { channelOnly: true };
  const channelOnlyCheck = (): TaskPersonCheck => ({ subject: { developerId: SLACKER_ID, slackUserId: SLACKER_SLACK }, identity: slackIdentity, eligible: true, channelMember: true, channelOnly: access.channelOnly });
  /** Gale, Wren and Ola are granted web people; Sam is a channel-only Slack person on the task. */
  const refusal = async (attempt: Promise<unknown>): Promise<{ code?: string; message?: string } | undefined> => attempt.then(() => undefined, (error: { code?: string; message?: string }) => error);
  function withSlacker(people: unknown[], revision = 3, orphaned = false) {
    const h = listed(people, {}, revision, orphaned);
    h.seed(slackPerson(), slackSubject());
    const base = h.peopleDeps.checkTaskPerson!;
    const deps: TaskPeopleDependencies = { ...h.peopleDeps, checkTaskPerson: async (task, developerId, admission) => developerId === SLACKER_ID ? channelOnlyCheck() : base(task, developerId, admission) };
    access.channelOnly = true;
    return { ...h, deps, access: () => h.access({ people: deps }), grantTo: () => { access.channelOnly = false; } };
  }

  it("an owner cannot make a channel-only person an owner: the one sentence, and the list is unchanged (a commenter or a viewer is still fine, and a granted person can still be made an owner)", async () => {
    const h = withSlacker([entry(WREN_ID, "owner"), entry(OLA_ID, "commenter"), slackEntry("commenter")]);
    const refused = await refusal(changeTaskPeople(h.deps, caller(WREN_ID), TASK, { requestId: "11111111-1111-4111-8111-111111111111", expectedPeopleRevision: 3, targetDeveloperId: SLACKER_ID, role: "owner" }));
    expect(refused?.code).toBe("CONFIG_INVALID");
    expect(refused?.message).toContain(OWNER_NEEDS_GRANT_WORDS);
    expect(h.people().revision).toBe(3);
    await changeTaskPeople(h.deps, caller(WREN_ID), TASK, { requestId: "22222222-2222-4222-8222-222222222222", expectedPeopleRevision: 3, targetDeveloperId: SLACKER_ID, role: "viewer" });
    expect(h.people().people.find((person) => person.developerId === SLACKER_ID)?.role).toBe("viewer");
    await changeTaskPeople(h.deps, caller(WREN_ID), TASK, { requestId: "33333333-3333-4333-8333-333333333333", expectedPeopleRevision: 4, targetDeveloperId: OLA_ID, role: "owner" });
    expect(h.people().people.find((person) => person.developerId === OLA_ID)?.role).toBe("owner");
  });

  it("a channel-only person cannot take an ownerless task over, is not offered the take-over, and a granted colleague can", async () => {
    const h = withSlacker([entry(GALE_ID, "denied"), entry(WREN_ID, "commenter"), slackEntry("commenter")], 3, true);
    expect(await getTaskPeopleCapabilities(h.deps, slackCaller(), TASK)).toMatchObject({ canTakeOwnership: false });
    const refused = await refusal(takeTaskOwnership(h.deps, slackCaller(), TASK, { requestId: "44444444-4444-4444-8444-444444444444", expectedPeopleRevision: 3 }));
    expect(refused?.code).toBe("CONFIG_INVALID");
    expect(refused?.message).toContain(OWNER_NEEDS_GRANT_WORDS);
    expect(h.people()).toMatchObject({ revision: 3, orphaned: true });
    expect(await getTaskPeopleCapabilities(h.deps, caller(WREN_ID), TASK)).toMatchObject({ canTakeOwnership: true });
    await takeTaskOwnership(h.deps, caller(WREN_ID), TASK, { requestId: "55555555-5555-4555-8555-555555555555", expectedPeopleRevision: 3 });
    expect(h.people().people.find((person) => person.developerId === WREN_ID)?.role).toBe("owner");
  });

  it("a Slack-native task (provider slack) has no gateway payer: its channel is its project access, so a channel-only person still owns it as before", async () => {
    const h = withSlacker([entry(WREN_ID, "owner"), slackEntry("commenter")]);
    const task = webTask({ provider: "slack" });
    h.db.set(task as unknown as Record<string, unknown>);
    await changeTaskPeople(h.deps, caller(WREN_ID), TASK, { requestId: "88888888-8888-4888-8888-888888888888", expectedPeopleRevision: 3, targetDeveloperId: SLACKER_ID, role: "owner" });
    expect(h.people().people.find((person) => person.developerId === SLACKER_ID)?.role).toBe("owner");
  });

  it("a hand-over never picks a channel-only successor: the task is skipped with the reason every unfit successor has, and a granted successor is taken", async () => {
    const h = withSlacker([entry(GALE_ID, "owner"), entry(WREN_ID, "commenter"), slackEntry("commenter")]);
    const asked = (successorId: string) => ({ leaverId: GALE_ID, successorId, removalId: "66666666-6666-4666-8666-666666666666", by: OLA_ID, preview: true });
    expect(await taskOwnershipHandOverSteps(h.deps, webTask(), asked(SLACKER_ID))).toEqual({ skipped: "successor_cannot_own" });
    expect(await taskOwnershipHandOverSteps(h.deps, webTask(), asked(WREN_ID))).not.toHaveProperty("skipped");
  });

  it("a STORED owner entry of a channel-only person is not rewritten into another shape: it reads as an owner who does not pass, so the task says nobody owns it, shows ownerless and a granted colleague takes it over", async () => {
    const h = withSlacker([entry(GALE_ID, "denied"), entry(WREN_ID, "commenter"), slackEntry("owner")]);
    const before = h.people().people.find((person) => person.developerId === SLACKER_ID);
    // Before any read demotes it, the list's owners are still the ones who PASS: the entry is listed as an owner and is not live.
    expect(await resolveTaskListOwners(h.deps, webTask())).toMatchObject({ ownerIds: [], listed: [SLACKER_ID], status: "OWNERLESS" });
    // The step does not run for them (the access seam is grant-only), and says so in the one sentence.
    expect(await h.access().checkStep(h.step)).toEqual({ allowed: false, message: OWNER_LEFT_PROJECT_WORDS });
    // Reading the list never makes them an owner who passes: the entry keeps its stored shape and only its role is read as not-an-owner.
    const view = await getTaskPeople(h.deps, caller(WREN_ID), TASK);
    expect(view).toMatchObject({ orphaned: true });
    const after = h.people().people.find((person) => person.developerId === SLACKER_ID);
    expect({ ...after, role: undefined }).toEqual({ ...before, role: undefined });
    expect(h.people().orphaned).toBe(true);
    // The demotion is audited as its own kind of event (who, when, and why: no grant of their own, never "lost access"), and the task says nobody owns it.
    expect(h.db.find((item) => String(item["sk"]).startsWith("PEOPLE_EVENT#"))).toEqual([expect.objectContaining({ via: "needs_grant", actorDeveloperId: PEOPLE_RECONCILE_ACTOR, targetDeveloperId: SLACKER_ID, beforeRole: "owner", afterRole: "commenter", entityType: "TASK_PEOPLE_EVENT" })]);
    expect(await h.access().checkStep(h.step)).toEqual({ allowed: false, message: OWNER_LEFT_PROJECT_WORDS });
    // A grant given AFTER the demotion does not silently make them an owner again: only a role change or a take-over does.
    h.grantTo();
    await getTaskPeople(h.deps, caller(WREN_ID), TASK);
    expect(h.people()).toMatchObject({ orphaned: true });
    expect(h.people().people.find((person) => person.developerId === SLACKER_ID)?.role).toBe("commenter");
    expect(await h.access().checkStep(h.step)).toEqual({ allowed: false, message: OWNER_LEFT_PROJECT_WORDS });
    // The take-over works (the task has no owner who passes).
    await takeTaskOwnership(h.deps, caller(WREN_ID), TASK, { requestId: "77777777-7777-4777-8777-777777777777", expectedPeopleRevision: h.people().revision });
    expect(h.people().people.filter((person) => person.role === "owner").map((person) => person.developerId)).toEqual([WREN_ID]);
    expect(await h.access().checkStep(h.step)).toMatchObject({ allowed: true, owner: { personId: WREN_ID } });
    // Now holding a grant, the demoted person is an owner again only because an owner says so.
    await changeTaskPeople(h.deps, caller(WREN_ID), TASK, { requestId: "99999999-9999-4999-8999-999999999990", expectedPeopleRevision: h.people().revision, targetDeveloperId: SLACKER_ID, role: "owner" });
    expect(h.people().people.find((person) => person.developerId === SLACKER_ID)?.role).toBe("owner");
  });
});
