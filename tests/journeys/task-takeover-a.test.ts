// journey-gate: task-takeover-a
// TASK-TAKEOVER PR A (permissions and money): a step runs for the task's CURRENT owner, not for the person who started it. Real hosted wiring (the journey world: `createBrokerCoreRoot` over the fake table,
// with the deployed broker's own task People proof), a real worker for the step, the company's own member routes, the Code task page's People confirm, and web people (a People owner must be a web person).
//   (a) the company-removal hand-over END TO END: a task with a People list is in flight (plan approved, its next step due); the starter is removed from the company with a named successor, who is on the list;
//       the next step must RUN, for the successor (the person who owns the task from now on).
//   (b) today's orphaned-list "Take ownership": the starter loses the project, a listed colleague takes the task over through People, and the next step must run, for the colleague.
// Both are red on a core whose `checkStep` reads only the task's starter (the step is blocked: the starter is no longer a member, or has no grant).
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { OWNER_LEFT_PROJECT_WORDS, chargedToWords } from "../../packages/contracts/src/index.js";
import { revokeProjectAccess } from "../../packages/broker/src/aws/admin-actions.js";
import { taskSessionId } from "../../packages/broker/src/core/sessions/create.js";
import { createJourneyWorld, type JourneyWorld } from "./harness/hosted-core.js";
import { pageReader, writeReviewSession } from "./harness/page.js";
import { IMPLEMENT_SCRIPT, planUntilCard, startTask } from "./harness/task.js";

let world: JourneyWorld | undefined;
afterEach(async () => { await world?.close(); world = undefined; });

type WebPerson = ReturnType<JourneyWorld["addWebPerson"]>;
interface PeopleList { revision: number; orphaned: boolean; people: Array<{ developerId: string; role: string }> }

/** The stored People list of a task. */
const listOf = (w: JourneyWorld, taskId: string): PeopleList => w.harness.db.get(`DEVTASK#${taskId}`, "PEOPLE") as unknown as PeopleList;
const roleOf = (list: PeopleList, person: WebPerson): string | undefined => list.people.find((entry) => entry.developerId === person.who.developerId)?.role;
/** The task page as a company person's browser sees it (a review session of the person's own company sign-in). */
const pageOf = (w: JourneyWorld, taskId: string, person: WebPerson) => pageReader(w, taskId, writeReviewSession(w, person.who, { company: w.harness.runtime.flow.deps.companyId }));

/** A People change as a person makes it after D1: the propose step on the developer API (the task page's own propose calls are deleted), then the confirm step on the one page that stays, the People confirmation page. */
async function confirmed(w: JourneyWorld, taskId: string, person: WebPerson, endpoint: "people/add" | "people/take-ownership", body: Record<string, unknown>): Promise<void> {
  const requestId = randomUUID();
  const proposed = await person.ask("POST", `/v1/dev/tasks/${taskId}/${endpoint}`, { requestId, ...body });
  expect(proposed.status, JSON.stringify(proposed.body)).toBe(200);
  const page = pageOf(w, taskId, person);
  // Opening the confirmation page hands out the CSRF cookie its confirm call needs.
  expect((await page.open(`/people/confirm/${requestId}`)).status).toBe(200);
  const done = await page.post(`people/requests/${requestId}/confirm`, { requestId });
  expect(done.status, done.text).toBe(200);
  expect(done.json()).toMatchObject({ status: "COMMITTED" });
}

/** A task in flight: started by Wren on the web (so it has a People list), a colleague on the list as a commenter, the plan approved: the next step (the build) is due. */
async function inFlight(piaRole: "commenter" | "owner" = "commenter"): Promise<{ w: JourneyWorld; taskId: string; wren: WebPerson; pia: WebPerson }> {
  const w = world = await createJourneyWorld({ page: true, members: true });
  const wren = w.addWebPerson({ name: "Wren Ito", subject: "wren", grant: "developer" });
  const pia = w.addWebPerson({ name: "Pia Lund", subject: "pia", role: "admin", grant: "developer" });
  const taskId = await startTask(w, { as: wren.ask });
  expect(listOf(w, taskId), "the web starter's task has its People list from the start").toMatchObject({ revision: 1, orphaned: false, people: [{ developerId: wren.who.developerId, role: "owner" }] });
  await confirmed(w, taskId, wren, "people/add", { expectedPeopleRevision: 1, developerId: pia.who.developerId, role: piaRole });
  expect(roleOf(listOf(w, taskId), pia)).toBe(piaRole);
  await planUntilCard(w, taskId);
  await w.approvePlan(taskId, wren.ask);
  expect(w.taskRow(taskId)!.workflow).toMatchObject({ stage: "IMPLEMENT", state: "READY" });
  return { w, taskId, wren, pia };
}

/** The step that now runs: it succeeds, and the operation names who it ran for (the requester: the payer of the model gateway). */
async function buildRuns(w: JourneyWorld, owner: WebPerson): Promise<void> {
  const built = await w.runStep("IMPLEMENT", IMPLEMENT_SCRIPT);
  expect(built.operation.status, String(built.operation.error)).toBe("SUCCEEDED");
  expect((built.operation.requester as { personId?: string }).personId, "the step runs for, and is charged to, the task's current owner").toBe(owner.who.developerId);
}

describe("a task changes owner while a step is due", () => {
  it("(a) the company-removal hand-over: the starter is removed with a named successor, and the task's next step RUNS for the successor", async () => {
    const { w, taskId, wren, pia } = await inFlight();
    const removed = await pia.ask("POST", `/v1/dev/company/members/${wren.who.developerId}/removal`, { requestId: randomUUID(), expectedRole: "member", successorId: pia.who.developerId });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body).toMatchObject({ state: "DONE", successorId: pia.who.developerId, moved: { tasks: 1, tasksLeft: 0 } });
    // The hand-over wrote what it promises: the successor owns the task from now on, the leaver is out of it.
    const list = listOf(w, taskId);
    expect([roleOf(list, pia), roleOf(list, wren), list.orphaned]).toEqual(["owner", "denied", false]);
    await buildRuns(w, pia);
    w.proof.assertAllCore();
  }, 400_000);

  it("(b) an orphaned list: the starter loses the project, a listed colleague takes the task over, and the next step RUNS for the colleague", async () => {
    const { w, taskId, wren, pia } = await inFlight();
    expect(await revokeProjectAccess({ documentClient: w.harness.db, tableName: "state" }, "payments", wren.who.developerId, w.harness.runtime.flow.deps.companyId)).toEqual({ revoked: true });
    // The colleague reads the list: no owner passes the proof any more, so it is orphaned and she may take the task over.
    const view = await pia.ask("GET", `/v1/dev/tasks/${taskId}/people`);
    expect(view.status, JSON.stringify(view.body)).toBe(200);
    const shown = view.body.view as { revision: number; orphaned: boolean; canTakeOwnership: boolean };
    expect([shown.orphaned, shown.canTakeOwnership]).toEqual([true, true]);
    await confirmed(w, taskId, pia, "people/take-ownership", { expectedPeopleRevision: shown.revision });
    const list = listOf(w, taskId);
    expect([roleOf(list, pia), roleOf(list, wren), list.orphaned]).toEqual(["owner", "denied", false]);
    await buildRuns(w, pia);
    w.proof.assertAllCore();
  }, 400_000);

  it("(c) after the hand-over the task says who is charged: the successor owns the session and reads it, the leaver's earlier steps stay with the leaver, the leaver reads nothing", async () => {
    const { w, taskId, wren, pia } = await inFlight();
    const operations = () => w.harness.db.find((row) => row.entityType === "OPERATION" && row.workspaceId === w.taskRow(taskId)!.workspaceId && row.kind === "task")
      .map((row) => ({ mode: String(row.workflowMode), requester: (row.requester as { personId: string }).personId }));
    const before = operations();
    expect(before.length, "the planning steps ran before the hand-over").toBeGreaterThan(0);
    expect(before.every((step) => step.requester === wren.who.developerId), "each ran for the starter").toBe(true);
    expect((await pia.ask("POST", `/v1/dev/company/members/${wren.who.developerId}/removal`, { requestId: randomUUID(), expectedRole: "member", successorId: pia.who.developerId })).status).toBe(200);
    await buildRuns(w, pia);
    // What the starter's steps already spent stays with the starter; only the steps from the hand-over on follow the new owner.
    const after = operations();
    expect(after.filter((step) => step.requester === wren.who.developerId)).toHaveLength(before.length);
    const hers = after.filter((step) => step.requester === pia.who.developerId).map((step) => step.mode);
    expect(hers, "every step since the hand-over ran for her").toContain("IMPLEMENT");
    expect(after.length).toBe(before.length + hers.length);
    const seen = await pia.ask("GET", `/v1/app/sessions/${taskSessionId(taskId)}`);
    expect(seen.status, JSON.stringify(seen.body)).toBe(200);
    const session = seen.body.session as { you: { owner: boolean; ownerLeft?: string; chargedTo?: string }; cost: { payer: { name: string } } };
    expect(session.you.owner).toBe(true);
    expect(session.you).not.toHaveProperty("ownerLeft");
    expect(session.you.chargedTo).toBe(chargedToWords("Pia Lund"));
    expect(session.cost.payer.name).toBe("Pia Lund");
    // A company admin who does not own the task is not told that "the owner left": the task has an owner, and it says who is charged.
    const ada = w.addWebPerson({ name: "Ada Ng", subject: "ada", role: "admin", grant: "developer" });
    const adminSeen = await ada.ask("GET", `/v1/app/sessions/${taskSessionId(taskId)}`);
    expect(adminSeen.status, JSON.stringify(adminSeen.body)).toBe(200);
    const adminView = (adminSeen.body.session as { you: { owner: boolean; ownerLeft?: string; chargedTo?: string } }).you;
    expect([adminView.owner, adminView.ownerLeft, adminView.chargedTo]).toEqual([false, undefined, chargedToWords("Pia Lund")]);
    // The leaver, out of the company, reads nothing: the sign-in check refuses them before any engine is asked.
    expect((await w.proof.signInRefused(() => wren.ask("GET", `/v1/app/sessions/${taskSessionId(taskId)}`))).status).toBe(401);
    w.proof.assertAllCore();
  }, 400_000);

  it("(d) nobody who owns the task still has the project: the next step is refused with the one no-owner sentence, and the admin who reads the task is told what it waits on", async () => {
    const { w, taskId, wren, pia } = await inFlight();
    expect(await revokeProjectAccess({ documentClient: w.harness.db, tableName: "state" }, "payments", wren.who.developerId, w.harness.runtime.flow.deps.companyId)).toEqual({ revoked: true });
    // The next step is due; nobody owns the task with the project, so it does not start: the workflow is blocked in the one sentence.
    for (let attempt = 0; attempt < 10 && w.taskRow(taskId)!.workflow?.state !== "BLOCKED"; attempt += 1) {
      await w.harness.runtime.flow.sweepOnce();
      await w.harness.runtime.flow.relayOnce();
      await w.harness.runtime.flow.dispatchOnce({ waitSeconds: 0 });
      w.harness.world.clock.advance(5);
    }
    expect(w.taskRow(taskId)!.workflow).toMatchObject({ stage: "IMPLEMENT", state: "BLOCKED", blockReason: OWNER_LEFT_PROJECT_WORDS });
    // Nothing runs. (The task read of an orphaned list is refused to everyone but the owner's own readers: that is the take-over read mode, PR B; the session view below is the admin's.)
    expect(w.harness.db.find((row) => row.entityType === "OPERATION" && row.workflowMode === "IMPLEMENT")).toEqual([]);
    const admin = await pia.ask("GET", `/v1/app/sessions/${taskSessionId(taskId)}`);
    expect(admin.status, JSON.stringify(admin.body)).toBe(200);
    expect((admin.body.session as { you: { ownerLeft?: string } }).you.ownerLeft).toBe(OWNER_LEFT_PROJECT_WORDS);
    w.proof.assertAllCore();
  }, 400_000);

  it("(e) a step is charged to the person who PRESSED it: an owner decided last but lost the project by dispatch, so the step is refused (never charged to the other owner); the other owner's Retry is charged, and shown, to them", async () => {
    const { w, taskId, wren, pia } = await inFlight("owner");
    // Wren (an owner) approved the plan, so the build is due on her press. She then loses the project, before the build starts.
    expect(await revokeProjectAccess({ documentClient: w.harness.db, tableName: "state" }, "payments", wren.who.developerId, w.harness.runtime.flow.deps.companyId)).toEqual({ revoked: true });
    for (let attempt = 0; attempt < 10 && w.taskRow(taskId)!.workflow?.state !== "BLOCKED"; attempt += 1) {
      await w.harness.runtime.flow.sweepOnce();
      await w.harness.runtime.flow.relayOnce();
      await w.harness.runtime.flow.dispatchOnce({ waitSeconds: 0 });
      w.harness.world.clock.advance(5);
    }
    const blocked = w.taskRow(taskId)!.workflow as { stage: string; state: string; blockReason?: string; revision: number };
    expect([blocked.stage, blocked.state, blocked.blockReason]).toEqual(["IMPLEMENT", "BLOCKED", OWNER_LEFT_PROJECT_WORDS]);
    expect(w.harness.db.find((row) => row.entityType === "OPERATION" && row.workflowMode === "IMPLEMENT")).toEqual([]);
    // Pia, still an owner, presses Retry: the build is charged to her (not to the owner who decided last), and the session says so.
    const retried = await pia.ask("POST", `/v1/dev/tasks/${taskId}/workflow/retry`, { requestId: randomUUID(), instructions: "Retry the build.", expectedRevision: blocked.revision });
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    await buildRuns(w, pia);
    const seen = await pia.ask("GET", `/v1/app/sessions/${taskSessionId(taskId)}`);
    expect((seen.body.session as { you: { chargedTo?: string } }).you.chargedTo).toBe(chargedToWords("Pia Lund"));
    w.proof.assertAllCore();
  }, 400_000);

  it("(f) with two live owners, the owner who did NOT decide presses Retry and is charged, and shown, not the first listed owner who decided: the press, not the order, names the payer", async () => {
    const { w, taskId, wren, pia } = await inFlight("owner");
    // Wren (first listed, and the owner who decided) loses the project before the build starts: her press is refused, never charged to Pia.
    const companyId = w.harness.runtime.flow.deps.companyId;
    expect(await revokeProjectAccess({ documentClient: w.harness.db, tableName: "state" }, "payments", wren.who.developerId, companyId)).toEqual({ revoked: true });
    for (let attempt = 0; attempt < 10 && w.taskRow(taskId)!.workflow?.state !== "BLOCKED"; attempt += 1) {
      await w.harness.runtime.flow.sweepOnce();
      await w.harness.runtime.flow.relayOnce();
      await w.harness.runtime.flow.dispatchOnce({ waitSeconds: 0 });
      w.harness.world.clock.advance(5);
    }
    const blocked = w.taskRow(taskId)!.workflow as unknown as { state: string; blockReason?: string; revision: number };
    expect([blocked.state, blocked.blockReason]).toEqual(["BLOCKED", OWNER_LEFT_PROJECT_WORDS]);
    // Wren gets the project back (nothing read the list in between, so she is still its first owner): both owners are live, and the order would charge Wren (first listed, latest decision).
    w.harness.db.set({ pk: `ORG#${companyId}#MEMBER#${wren.who.developerId}`, sk: "PROJECT#payments", entityType: "MEMBERSHIP", ownerKey: wren.who.developerId, projectName: "payments", grantId: randomUUID(), role: "developer", companyId });
    expect(roleOf(listOf(w, taskId), wren)).toBe("owner");
    // Pia presses Retry: the build is hers.
    expect((await pia.ask("POST", `/v1/dev/tasks/${taskId}/workflow/retry`, { requestId: randomUUID(), instructions: "Retry the build.", expectedRevision: blocked.revision })).status).toBe(200);
    // The step her press started is running: the session says it is charged to her (not to Wren, the first listed owner who decided) ...
    const seen = await pia.ask("GET", `/v1/app/sessions/${taskSessionId(taskId)}`);
    expect((seen.body.session as { you: { chargedTo?: string } }).you.chargedTo).toBe(chargedToWords("Pia Lund"));
    // ... and so is the operation.
    await buildRuns(w, pia);
    w.proof.assertAllCore();
  }, 400_000);

  it("(g) a Slack person with no grant of their own (the channel is all they have) cannot START a task on ANY start path, so the words table may say \"cannot start or own tasks\": the web and CLI start (one route), the Slack thread start, and the check every other start (tracker, chat thread) asks", async () => {
    world = await createJourneyWorld({ members: true });
    const w = world;
    const { NO_PROJECT_GRANT } = await import("../../packages/broker/src/aws/core-engine-root.js");
    const { startSlackWorkflowOnCore } = await import("../../packages/broker/src/aws/slack-core-start.js");
    const companyId = w.harness.runtime.flow.deps.companyId;
    const PRIYA_ID = "9".repeat(64);
    const tasks = () => w.harness.db.find((row) => row.entityType === "DEVELOPER_TASK").length;
    const start = () => w.priya("POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Add a health endpoint", workflow: true, workflowPath: "QUICK" });
    // The same person WITH the grant starts (so the refusals below are the grant's, not the setup's).
    const granted = await start();
    expect(granted.status, JSON.stringify(granted.body)).toBe(200);
    const before = tasks();
    // Take the grant away: a member, a Slack sign-in, in the project's channel only.
    expect(await revokeProjectAccess({ documentClient: w.harness.db, tableName: "state" }, "payments", PRIYA_ID, companyId)).toEqual({ revoked: true });
    // (1) The web and CLI start: `POST /v1/dev/tasks` (core-host/dev-routes.ts, the one start route of the web app, the CLI and the AI tools).
    const web = await start();
    expect(web.status).toBe(403);
    expect(JSON.stringify(web.body)).toContain(NO_PROJECT_GRANT);
    // (2) The Slack thread start: the thread's task goes to the same core start, as the linked person (slack-core-start.ts).
    // The thread start builds the same `POST /v1/dev/tasks` and hands it to the core's entry; here the entry is the journey's own route, asked as that same person.
    const sent: string[] = [];
    const entry = { route: async (request: { method: string; path: string; body?: string }) => {
      sent.push(`${request.method} ${request.path}`);
      const reply = await w.priya(request.method, request.path, JSON.parse(request.body ?? "{}"));
      return { statusCode: reply.status, headers: {}, body: JSON.stringify(reply.body) };
    }, recordThread: async () => true };
    await expect(startSlackWorkflowOnCore(entry as never, {
      caller: { developerId: PRIYA_ID, sessionId: "s-priya", name: "Priya Rao", amr: "slack", slackUserId: "U0PRIYA001" }, companyId,
      thread: { teamId: "T0TEAM1", channelId: "C0PAY0001", threadTs: "1700000000.000100" }, userId: "U0PRIYA001", requestId: randomUUID(), project: "payments", instructions: "Add a health endpoint", workflowPath: "QUICK",
    })).rejects.toThrow(NO_PROJECT_GRANT);
    expect(sent).toEqual(["POST /v1/dev/tasks"]);
    // (3) The check the tracker start and the chat thread's input ask (`checkStart`): refused in the same words.
    const principal = { companyId, personId: PRIYA_ID, displayName: "Priya Rao", roles: ["member"], provider: "rovara-sign-in" };
    expect(await w.harness.runtime.flow.deps.access.checkStart(principal as never, "payments")).toMatchObject({ allowed: false, message: NO_PROJECT_GRANT });
    // Nothing was started by any of them, and with no company at all the start is refused too.
    expect(tasks()).toBe(before);
    w.harness.db.delete(`COMPANY_MEMBER#${PRIYA_ID}`, "COMPANY");
    expect((await start()).status).not.toBe(200);
    expect(tasks()).toBe(before);
    w.proof.assertAllCore({ callbacks: false });
  }, 400_000);
});
