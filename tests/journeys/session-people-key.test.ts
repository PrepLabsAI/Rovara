// journey-gate: session-people-key
// SESSION-PEOPLE-KEY (security hotfix): a task's People list stores each person by their SIGN-IN id (the id a hosted principal carries as `personId`, and the task's own `developerId`), but the session
// levels looked an entry up by the session's HASHED person id, so no People entry ever matched in a session: a `denied` entry removed nobody from the session, and a commenter or co-owner entry gave nothing.
// Real hosted wiring (the journey world: `createBrokerCoreRoot` over the fake table), the web app's own client, the session routes a person's browser uses. The People list is written in the exact shape
// the product stores (`taskPeopleEntryOf`: `developerId` is the person's sign-in id): the journey world serves no People proof (the panel answers 403 here for everyone), so the list is seeded, not edited.
//   (a) a project MAINTAINER an owner marked `denied`: every session read and act answers "no such session": read, log, steer, stop, retry, answer, revise the plan, follow (Ask is proved on the same access in tests/unit/session-features-access.test.ts: the hosted front serves no Ask route in this world);
//   (b) a project CONTRIBUTOR marked `denied`: the same;
//   (c) the STARTER marked `denied` by another owner: no owner level in the session, no read, no act;
//   (c2) the starter marked denied who is also a COMPANY ADMIN keeps only an admin's view: not an owner, and no steer, retry or answer;
//   (c3) the starter another owner demoted to `viewer` or `commenter` is no owner in the session: no stop, retry or answer (a viewer cannot steer either);
//   (d) the entries that grant: a commenter holds `use`, a viewer `view`, an owner `edit` (a contributor's own level is `view`), and nobody without an entry changes.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { taskSessionId } from "../../packages/broker/src/core/sessions/create.js";
import { createJourneyWorld, MAYA, type JourneyWorld } from "./harness/hosted-core.js";
import { startTask } from "./harness/task.js";

let world: JourneyWorld | undefined;
afterEach(async () => { await world?.close(); world = undefined; });

const PRIYA_ID = "9".repeat(64);
type Role = "owner" | "commenter" | "viewer" | "denied";
/** A `web` entry (a sign-in method, no chat account), as `taskPeopleEntryOf` writes one. */
const webEntry = (developerId: string, name: string, role: Role) => ({ developerId, name, role, method: "github" });
/** The starter's own entry: Maya signs in with Slack, so hers is a `slack` entry (chat account id, no method). */
const mayaEntry = (role: Role) => ({ developerId: MAYA.developerId, slackUserId: MAYA.slackUserId, name: MAYA.name, role });

function writePeople(w: JourneyWorld, taskId: string, people: unknown[]): void {
  w.harness.db.set({ pk: `DEVTASK#${taskId}`, sk: "PEOPLE", schemaVersion: 1, revision: 1, orphaned: false, people });
}

interface Answer { status: number; code: string }
const codeOf = (body: unknown): string => {
  const error = (body as { error?: { code?: unknown } }).error;
  return typeof error?.code === "string" ? error.code : "-";
};

/** Every session read and act the hosted front serves, as the person's own browser makes them. (Ask is not on the hosted front's route list in this world, so it is proved at the access level: tests/unit/session-features-access.test.ts.) */
async function everyRoute(ask: JourneyWorld["priya"], sessionId: string): Promise<Array<[string, Answer]>> {
  const s = `/v1/app/sessions/${sessionId}`;
  const calls: Array<[string, string, string, unknown]> = [
    ["read", "GET", s, undefined],
    ["log", "GET", `${s}/log`, undefined],
    ["steer", "POST", `${s}/messages`, { requestId: randomUUID(), kind: "steer", text: "also add a test" }],
    ["stop", "POST", `${s}/stop`, { requestId: randomUUID() }],
    ["retry", "POST", `${s}/retry`, { requestId: randomUUID() }],
    ["answer", "POST", `${s}/answers`, { requestId: randomUUID(), answers: [] }],
    ["revise plan", "POST", `${s}/revise-plan`, { requestId: randomUUID(), text: "change it" }],
    ["follow", "POST", `${s}/follow`, {}],
  ];
  const out: Array<[string, Answer]> = [];
  for (const [name, method, path, body] of calls) {
    const reply = await ask(method, path, body);
    out.push([name, { status: reply.status, code: codeOf(reply.body) }]);
  }
  return out;
}

/** Every route answers "no such session": never a 2xx, never a validation error (which would mean the access check let the caller in). */
const notThere = (rows: Array<[string, Answer]>): string[] => rows.filter(([, answer]) => !(answer.status === 404 && answer.code === "NOT_FOUND")).map(([name, answer]) => `${name} -> ${String(answer.status)} ${answer.code}`);

async function started(grant: "developer" | "administrator") {
  world = await createJourneyWorld({ colleague: { role: "member", grant } });
  const taskId = await startTask(world);
  return { w: world, taskId, sessionId: taskSessionId(taskId) };
}

describe("a People entry decides a person's level in the task's session", () => {
  it("(control) with no People list, a project maintainer reads and steers, and the session is the starter's", async () => {
    const { w, sessionId } = await started("administrator");
    const read = await w.priya("GET", `/v1/app/sessions/${sessionId}`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body).toMatchObject({ session: { you: { level: "edit", owner: false } } });
    expect(await w.maya("GET", `/v1/app/sessions/${sessionId}`)).toMatchObject({ status: 200, body: { session: { you: { level: "edit", owner: true } } } });
    w.proof.assertAllCore({ callbacks: false });
  }, 240_000);

  it("(a) a project MAINTAINER marked denied on the task's People list is refused every session read and act", async () => {
    const { w, taskId, sessionId } = await started("administrator");
    writePeople(w, taskId, [mayaEntry("owner"), webEntry(PRIYA_ID, "Priya Rao", "denied")]);
    const rows = await everyRoute(w.priya, sessionId);
    expect(notThere(rows), "routes that still answer a denied maintainer").toEqual([]);
    // The starter, whose entry is the owner's, is not touched.
    expect((await w.maya("GET", `/v1/app/sessions/${sessionId}`)).status).toBe(200);
    w.proof.assertAllCore({ callbacks: false });
  }, 240_000);

  it("(b) a project CONTRIBUTOR marked denied is refused every session read and act (a denied contributor can no longer read it)", async () => {
    const { w, taskId, sessionId } = await started("developer");
    // Before the entry: a contributor reads.
    const before = await w.priya("GET", `/v1/app/sessions/${sessionId}`);
    expect(before, JSON.stringify(before.body)).toMatchObject({ status: 200, body: { session: { you: { level: "view" } } } });
    writePeople(w, taskId, [mayaEntry("owner"), webEntry(PRIYA_ID, "Priya Rao", "denied")]);
    const rows = await everyRoute(w.priya, sessionId);
    expect(notThere(rows), "routes that still answer a denied contributor").toEqual([]);
    w.proof.assertAllCore({ callbacks: false });
  }, 240_000);

  it("(c) the STARTER marked denied (another owner remains) loses owner level in the session: no read, no steer, no stop, no retry, no answer", async () => {
    const { w, taskId, sessionId } = await started("developer");
    writePeople(w, taskId, [webEntry(PRIYA_ID, "Priya Rao", "owner"), { ...mayaEntry("denied") }]);
    const rows = await everyRoute(w.maya, sessionId);
    expect(notThere(rows), "routes that still answer a denied starter").toEqual([]);
    w.proof.assertAllCore({ callbacks: false });
  }, 240_000);

  it("(c2) the starter marked denied who is a COMPANY ADMIN keeps only an admin's view: owner is false, and no steer, retry, answer or revise", async () => {
    const { w, taskId, sessionId } = await started("developer");
    const row = w.harness.db.get(`COMPANY_MEMBER#${MAYA.developerId}`, "COMPANY")!;
    w.harness.db.set({ ...row, pk: `COMPANY_MEMBER#${MAYA.developerId}`, sk: "COMPANY", role: "admin" });
    const s = `/v1/app/sessions/${sessionId}`;
    // (control) before the denial she owns it.
    expect(await w.maya("GET", s), "(control) the admin starter owns it").toMatchObject({ status: 200, body: { session: { you: { level: "edit", owner: true } } } });
    writePeople(w, taskId, [webEntry(PRIYA_ID, "Priya Rao", "owner"), mayaEntry("denied")]);
    const read = await w.maya("GET", s);
    expect(read, JSON.stringify(read.body)).toMatchObject({ status: 200, body: { session: { you: { level: "view", owner: false } } } });
    for (const [name, path, body] of [["steer", `${s}/messages`, { kind: "steer", text: "also add a test" }], ["retry", `${s}/retry`, {}], ["answer", `${s}/answers`, { answers: [] }], ["revise plan", `${s}/revise-plan`, { text: "change it" }]] as const) {
      const reply = await w.maya("POST", path, { requestId: randomUUID(), ...body });
      expect([name, reply.status, codeOf(reply.body)], JSON.stringify(reply.body)).toEqual([name, 403, "SESSION_LEVEL_REQUIRED"]);
    }
    w.proof.assertAllCore({ callbacks: false });
  }, 240_000);

  it("(c3) the starter another owner demoted to viewer or commenter is no owner in the session: no stop, retry, answer or revise (the task path lets them only read)", async () => {
    const { w, taskId, sessionId } = await started("developer");
    const s = `/v1/app/sessions/${sessionId}`;
    for (const [role, level] of [["viewer", "view"], ["commenter", "use"]] as const) {
      writePeople(w, taskId, [webEntry(PRIYA_ID, "Priya Rao", "owner"), mayaEntry(role)]);
      expect(await w.maya("GET", s), `a starter demoted to ${role}`).toMatchObject({ status: 200, body: { session: { you: { level, owner: false } } } });
      for (const [name, path, body] of [["stop", `${s}/stop`, {}], ["retry", `${s}/retry`, {}], ["answer", `${s}/answers`, { answers: [] }], ["revise plan", `${s}/revise-plan`, { text: "change it" }]] as const) {
        const reply = await w.maya("POST", path, { requestId: randomUUID(), ...body });
        expect([role, name, reply.status, codeOf(reply.body)], JSON.stringify(reply.body)).toEqual([role, name, 403, "SESSION_LEVEL_REQUIRED"]);
      }
    }
    // (control) with an owner entry she is the owner as before.
    writePeople(w, taskId, [webEntry(PRIYA_ID, "Priya Rao", "owner"), mayaEntry("owner")]);
    expect(await w.maya("GET", s)).toMatchObject({ status: 200, body: { session: { you: { level: "edit", owner: true } } } });
    w.proof.assertAllCore({ callbacks: false });
  }, 240_000);

  it("(d) the entries that grant: a commenter holds `use`, a viewer `view`, an owner `edit`; a person with no entry keeps exactly their project level", async () => {
    const { w, taskId, sessionId } = await started("developer");
    const levelOf = async (): Promise<unknown> => (await w.priya("GET", `/v1/app/sessions/${sessionId}`)).body;
    // No entry: a contributor watches (and is no owner).
    expect(await levelOf()).toMatchObject({ session: { you: { level: "view", owner: false } } });
    writePeople(w, taskId, [mayaEntry("owner"), webEntry(PRIYA_ID, "Priya Rao", "viewer")]);
    expect(await levelOf(), "a viewer entry").toMatchObject({ session: { you: { level: "view" } } });
    writePeople(w, taskId, [mayaEntry("owner"), webEntry(PRIYA_ID, "Priya Rao", "commenter")]);
    expect(await levelOf(), "a commenter entry").toMatchObject({ session: { you: { level: "use" } } });
    writePeople(w, taskId, [mayaEntry("owner"), webEntry(PRIYA_ID, "Priya Rao", "owner")]);
    expect(await levelOf(), "an owner entry").toMatchObject({ session: { you: { level: "edit" } } });
    // A list that names someone else leaves her exactly where her project role puts her.
    writePeople(w, taskId, [mayaEntry("owner")]);
    expect(await levelOf(), "no entry for her").toMatchObject({ session: { you: { level: "view", owner: false } } });
    w.proof.assertAllCore({ callbacks: false });
  }, 240_000);
});
