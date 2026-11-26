// READ-RULE-SHARE-B (owner DEC 254zzz577), rule 1 and rule 2 on the stored share's own functions, with the REAL company layer under them:
//   1. a share works for a person with NO project access, but only a SAME-COMPANY one: `taskReaderPerson` (the host's read of the person now) says `companyMember`, from the person's LIVE company read where the company keeps it, and `readerShare` / `grantTaskReader` ask
//      that, not a project grant;
//   2. REMOVAL WINS: `readerShare` is no share for a person the task's People list names `denied`, whatever the share row says.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AgentXError } from "@agentx/contracts";
import { MEMBERSHIP_READ_FAILED_WORDS, membershipReadFailed } from "../../packages/broker/src/core/membership-read.js";
import { taskReaderPerson, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { grantTaskReader, readerShare, type TaskReaderDependencies, type TaskReaderPerson } from "../../packages/broker/src/aws/task-readers.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { FAKE_COMPANY } from "../support/core-host-fakes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const TASK_COMPANY = FAKE_COMPANY;
const OTHER_COMPANY = "org_corehost00000000000b";
const OWNER = "a".repeat(64);
const PERSON = "b".repeat(64);
const GRANTED = "c".repeat(64);
const TASK_ID = randomUUID();

const task = { taskId: TASK_ID, pk: `DEVTASK#${TASK_ID}`, sk: "META", developerId: OWNER, project: "payments", companyId: TASK_COMPANY } as unknown as DeveloperTaskRecord;

/** The host's own read of a person now, over a real company reader and real sign-in and grant rows. */
function layer(companyOf: Record<string, string>, options: { companies?: boolean } = {}) {
  const db = new FakeDynamoDb();
  for (const id of [OWNER, PERSON, GRANTED]) db.set({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, displayName: `Person ${id.slice(0, 1)}`, revoked: false });
  // GRANTED holds a project grant in the task's company; PERSON holds none anywhere.
  db.set({ pk: `ORG#${TASK_COMPANY}#MEMBER#${GRANTED}`, sk: "PROJECT#payments", entityType: "MEMBERSHIP", ownerKey: GRANTED, projectName: "payments", role: "developer" });
  // A legacy grant row (no company layer keys a grant without the company): GRANTED holds one.
  db.set({ pk: `MEMBER#${GRANTED}`, sk: "PROJECT#payments", entityType: "MEMBERSHIP", ownerKey: GRANTED, projectName: "payments", role: "developer" });
  const deps = {
    documentClient: { send: (command: unknown) => db.send(command as never) }, tableName: "state", now: () => 0, developer: { signInTableName: "signin" },
    ...(options.companies === false ? {} : { companies: { companyOf: async (id: string) => { const company = companyOf[id]; if (company === "throws") throw new Error("directory down"); if (company === "read-failed") throw membershipReadFailed(); return company; } } }),
  } as unknown as DeveloperRouteDependencies;
  return { db, deps, person: (id: string) => taskReaderPerson(deps, id, "payments", TASK_COMPANY) };
}

describe("taskReaderPerson: the stored share's person now (rule 1)", () => {
  it("a live member of the task's company is a company member with or without a project grant; a member of ANOTHER company is not, whatever grants they hold; no company layer is one company", async () => {
    const w = layer({ [OWNER]: TASK_COMPANY, [PERSON]: TASK_COMPANY, [GRANTED]: TASK_COMPANY });
    expect(await w.person(PERSON)).toMatchObject({ companyMember: true, projectMember: false });
    expect(await w.person(GRANTED)).toMatchObject({ companyMember: true, projectMember: true });
    // The person MOVED to another company: their live company is read now, so the share's person is not a member of the task's company (and their grant is not counted: it is read in the task's company only).
    const moved = layer({ [PERSON]: OTHER_COMPANY, [GRANTED]: OTHER_COMPANY });
    expect(await moved.person(PERSON)).toEqual({ name: "Person b", projectMember: false, companyMember: false });
    expect(await moved.person(GRANTED)).toEqual({ name: "Person c", projectMember: false, companyMember: false });
    // A person who is registered nowhere or whose sign-in was revoked is no one.
    // (a failing directory is a FAILED membership read: since MEMBERSHIP-READ-FAILS-SAFE it is the retryable 503, never "not a member": see the last describe)
    await expect(layer({ [PERSON]: "throws" }).person(PERSON)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(await layer({}).person("d".repeat(64))).toBeUndefined();
    const revoked = layer({ [PERSON]: TASK_COMPANY });
    revoked.db.set({ ...revoked.db.get(`DEVELOPER#${PERSON}`, "META")!, revoked: true });
    expect(await revoked.person(PERSON)).toBeUndefined();
    // NO company layer (COMPANY_SIGNIN off): "a member of the company" cannot be proved, so a share FAILS CLOSED to the old rule: only a person who holds the project grant counts (a core task can run on such an install, and its sign-ins may belong to several companies).
    const bare = layer({}, { companies: false });
    expect(await bare.person(PERSON)).toEqual({ name: "Person b", projectMember: false, companyMember: false });
    expect(await bare.person(GRANTED)).toMatchObject({ projectMember: true, companyMember: true });
    // The task's own person asking (`ownTask`) gets the same `companyMember`, not a hard-coded true (Opus NIT 1).
    expect(await taskReaderPerson(bare.deps, PERSON, "payments", TASK_COMPANY, { ownTask: true })).toEqual({ name: "Person b", projectMember: false, companyMember: false, mayStart: false });
    expect(await taskReaderPerson(bare.deps, GRANTED, "payments", TASK_COMPANY, { ownTask: true })).toEqual({ name: "Person c", projectMember: true, companyMember: true, mayStart: true });
  });
});

/** The share's own dependencies over one fake table: the task's People list and share rows, and the host's read of the person (here as a plain function). */
function sharing(person: (id: string) => Promise<TaskReaderPerson | undefined>) {
  const db = new FakeDynamoDb();
  const log = vi.fn();
  const deps: TaskReaderDependencies = { documentClient: { send: (command: unknown) => db.send(command as never) }, tableName: "state", now: () => 0, log, taskReaderPerson: async (id) => person(id) };
  const share = (id = PERSON, role = "viewer") => db.set({ pk: `DEVTASK#${TASK_ID}`, sk: `READER#${id}`, schemaVersion: 1, developerId: id, role, grantedBy: OWNER, grantedAt: "2026-11-25T00:00:00.000Z" });
  const people = (entries: Array<{ developerId: string; role: string }>) => db.set({ pk: `DEVTASK#${TASK_ID}`, sk: "PEOPLE", schemaVersion: 1, revision: 1, orphaned: false, people: entries.map((entry) => ({ ...entry, name: "Someone", method: "oidc" })) });
  return { db, deps, log, share, people };
}
const member = (over: Partial<TaskReaderPerson> = {}): TaskReaderPerson => ({ name: "Person", projectMember: false, companyMember: true, ...over });

describe("readerShare: the share is a company member's, and removal wins (rules 1 and 2)", () => {
  it("a company member with NO project grant is a share; a person of another company, and a person who is registered nowhere, is not (the refusal is logged without the person's name)", async () => {
    const w = sharing(async (id) => id === PERSON ? member() : id === GRANTED ? member({ companyMember: false, projectMember: true }) : undefined);
    w.share(PERSON); w.share(GRANTED); w.share("d".repeat(64));
    expect(await readerShare(w.deps, task, PERSON)).toEqual({ role: "viewer" });
    // Another company's person: a grant elsewhere does not make a share.
    expect(await readerShare(w.deps, task, GRANTED)).toBeUndefined();
    expect(await readerShare(w.deps, task, "d".repeat(64))).toBeUndefined();
    expect(w.log.mock.calls.map(([entry]) => (entry as { reason: string }).reason)).toEqual(["not_company_member", "not_registered"]);
  });

  it("a person with no share row is no share, whoever they are", async () => {
    const w = sharing(async () => member());
    expect(await readerShare(w.deps, task, PERSON)).toBeUndefined();
  });

  it("REMOVAL WINS: the People list's `denied` (a deny, or a removal) beats the share row; a person the list names a viewer or does not name stays a share; a list that cannot be read fails the lookup (the rule reads that as no share)", async () => {
    const w = sharing(async () => member());
    w.share(PERSON);
    w.people([{ developerId: PERSON, role: "denied" }]);
    expect(await readerShare(w.deps, task, PERSON)).toBeUndefined();
    expect(w.log.mock.calls.at(-1)![0]).toMatchObject({ event: "developer.task_reader_refused", reason: "removed_on_people_list" });
    w.people([{ developerId: PERSON, role: "viewer" }]);
    expect(await readerShare(w.deps, task, PERSON)).toEqual({ role: "viewer" });
    w.people([{ developerId: OWNER, role: "owner" }]);
    expect(await readerShare(w.deps, task, PERSON)).toEqual({ role: "viewer" });
    // A malformed list does not read as "no denial": the lookup throws.
    w.db.set({ pk: `DEVTASK#${TASK_ID}`, sk: "PEOPLE", schemaVersion: 1, revision: 1, orphaned: false, people: "not a list" });
    await expect(readerShare(w.deps, task, PERSON)).rejects.toBeInstanceOf(AgentXError);
  });

  it("no way to read the person (the deployment's seam is absent) is no share", async () => {
    const w = sharing(async () => member());
    w.share(PERSON);
    const bare: TaskReaderDependencies & { taskReaderPerson?: unknown } = { ...w.deps };
    delete bare.taskReaderPerson;
    expect(await readerShare(bare, task, PERSON)).toBeUndefined();
  });
});

describe("grantTaskReader: the owner shares with a company member, a project grant is not asked (rule 1)", () => {
  const request = () => ({ requestId: randomUUID(), role: "viewer" });
  it("shares with a company member who holds no project grant, says so in the list, and refuses another company's person and a person registered nowhere in the one set of words", async () => {
    const w = sharing(async (id) => id === PERSON ? member() : id === GRANTED ? member({ companyMember: false, projectMember: true }) : undefined);
    expect(await grantTaskReader(w.deps, task as never, OWNER, PERSON, request())).toMatchObject({ reader: { developerId: PERSON, role: "viewer", projectMember: false }, already: false });
    expect(w.db.get(`DEVTASK#${TASK_ID}`, `READER#${PERSON}`)).toMatchObject({ role: "viewer", grantedBy: OWNER });
    const before = JSON.stringify(w.db.find(() => true));
    for (const target of [GRANTED, "d".repeat(64)]) {
      const refused = (await grantTaskReader(w.deps, task as never, OWNER, target, request()).catch((error: unknown) => error)) as AgentXError;
      expect([refused.code, refused.message], target.slice(0, 1)).toEqual(["CONFIG_INVALID", "CONFIG_INVALID: that person isn't a member of your company; add them to the company first"]);
    }
    expect(JSON.stringify(w.db.find(() => true)), "nothing written for a refusal").toBe(before);
  });
});

// READ-RULE-SHARE-B on top of MEMBERSHIP-READ-FAILS-SAFE: a membership read that FAILED (the store threw) is not "not a member". It goes up as the retryable 503, so a share lookup is the retryable 503 through the read rule (never a leaked 404, never a share granted),
// and a share write is the retryable answer with nothing written. (Any throw of the company reader is a failed membership read: `resolveCompany` marks it.)
describe("a failed membership read gives no share and writes none (MEMBERSHIP-READ-FAILS-SAFE)", () => {
  it("taskReaderPerson rethrows the retryable failure; readerShare lets it go up (the read rule rethrows it: see tests/unit/task-read-rule.test.ts); grantTaskReader answers the retryable 503 and writes nothing", async () => {
    const w = layer({ [PERSON]: "read-failed", [OWNER]: TASK_COMPANY });
    const refused = (await w.person(PERSON).catch((error: unknown) => error)) as AgentXError;
    expect([refused.code, refused.message]).toEqual(["RUNTIME_UNAVAILABLE", `RUNTIME_UNAVAILABLE: ${MEMBERSHIP_READ_FAILED_WORDS}`]);
    // The share's own functions over the same real reader.
    const db = w.db;
    db.set({ pk: `DEVTASK#${TASK_ID}`, sk: `READER#${PERSON}`, schemaVersion: 1, developerId: PERSON, role: "viewer", grantedBy: OWNER, grantedAt: "2026-11-25T00:00:00.000Z" });
    const deps: TaskReaderDependencies = { documentClient: { send: (command: unknown) => db.send(command as never) }, tableName: "state", now: () => 0, taskReaderPerson: async (id, project, company, options) => taskReaderPerson(w.deps, id, project, company, options) };
    await expect(readerShare(deps, task, PERSON)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    const before = JSON.stringify(db.find(() => true));
    await expect(grantTaskReader(deps, task as never, OWNER, PERSON, { requestId: randomUUID(), role: "viewer" })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(JSON.stringify(db.find(() => true)), "nothing written").toBe(before);
  });
});
