// journey-gate: 3a, 3b, 4
// Journeys 3a, 3b and 4: Linear. A company admin connects the company's Linear workspace and picks a project's team (the real connect routes), a member links their own Linear account (the real 6.1
// routes), and Linear's webhook for an issue reaches the broker's front, signed as Linear signs it, and goes through the real tracker intake into the real company flow. On the real core and the
// real worker; see briefs/arch-cleanup/A1-JOURNEY-TESTS-PLAN.md.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { intakeItemIdOf } from "../../packages/contracts/src/index.js";
import { WORKSPACE_A, type FakeLinearUser } from "../support/fake-linear-oauth.js";
import { createJourneyWorld, type JourneyWorld } from "./harness/hosted-core.js";
import { planUntilCard } from "./harness/task.js";

const MAYA_ON_LINEAR: FakeLinearUser = { id: "11111111-0000-4000-8000-000000000001", name: "Maya Chen" };
const STRANGER_ON_LINEAR: FakeLinearUser = { id: "33333333-0000-4000-8000-000000000003", name: "Sam Stranger" };
const TEAM = "team-a-eng";

let world: JourneyWorld | undefined;
afterEach(async () => { await world?.close(); world = undefined; });

/** A company connected to Linear workspace A with `payments` on its engineering team, an admin (Priya: company admin and the project's administrator) and a member (Maya). */
async function connectedCompany() {
  const w = await createJourneyWorld({ linear: true, colleague: { role: "admin", grant: "administrator" } });
  await w.linear!.connect(w.priya, WORKSPACE_A);
  await w.linear!.pickTeam(w.priya, "payments", TEAM);
  return w;
}
const waitingTickets = async (w: JourneyWorld) => (await w.priya("GET", "/v1/dev/projects/payments/intake")).body as { items: Array<{ id: string; reason: string }> };
const startedTasks = (w: JourneyWorld) => w.harness.db.find((row) => row.entityType === "DEVELOPER_TASK") as Array<{ taskId: string; origin: string; developerId: string; ticket?: { system: string; id: string } }>;

describe("journey 3: Linear, a person who linked their own account", () => {
  it("3a: a member links their own Linear account through the real routes; their issue starts a task as them from the real intake, and the plan, the owner's approval and the build run on the real worker", async () => {
    world = await connectedCompany();
    const linked = await world.linear!.link(world.maya, WORKSPACE_A, MAYA_ON_LINEAR);
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);
    expect(linked.body).toMatchObject({ status: "linked", account: { display: "Maya Chen" } });
    const mine = await world.maya("GET", "/v1/dev/me/tracker-accounts/linear");
    expect(mine.body).toMatchObject({ connected: true, linked: true });
    const hook = await world.linear!.issueCreated(WORKSPACE_A, { teamId: TEAM, actor: MAYA_ON_LINEAR.id, key: "ENG-1" });
    expect(hook.status).toBe(200);
    // The ticket started a task, as Maya, with the ticket on it; nothing waits.
    const started = startedTasks(world);
    expect(started.map((task) => ({ origin: task.origin, owner: task.developerId, ticket: task.ticket }))).toEqual([{ origin: "tracker", owner: "d".repeat(64), ticket: { system: "linear", id: "ENG-1" } }]);
    expect((await waitingTickets(world)).items).toEqual([]);
    const taskId = started[0]!.taskId;
    expect((await world.maya("GET", `/v1/dev/tasks/${taskId}`)).body.task, "Maya reads her task").toMatchObject({ taskId, project: "payments" });
    // The task runs on the real worker to the plan, and Maya approves it.
    await planUntilCard(world, taskId);
    await world.approvePlan(taskId);
    expect(world.taskRow(taskId)!.workflow).toMatchObject({ stage: "IMPLEMENT" });
    await world.runJobs();
    await world.runJobs(120);
    // KNOWN GAP (R1+L1 6.2, "write-back independent of lessons"): nothing is written back to the Linear issue on a hosted install today: no comment, and no write to Linear after the connection.
    expect(world.linear!.server.comments, "no comment on the issue yet").toEqual([]);
    world.proof.assertAllCore();
  }, 180_000);

  it("3b: a member who has not linked their Linear account (Rovara would match them by verified email once 6.2 lands): KNOWN GAP pinned to today's outcome, their ticket waits as unlinked and nothing starts", async () => {
    world = await connectedCompany();
    const hook = await world.linear!.issueCreated(WORKSPACE_A, { teamId: TEAM, actor: MAYA_ON_LINEAR.id, key: "ENG-2" });
    expect(hook.status).toBe(200);
    expect(startedTasks(world), "no task starts").toEqual([]);
    expect((await waitingTickets(world)).items.map((item) => ({ id: item.id, reason: item.reason })), "the ticket waits for the person to link").toEqual([{ id: "ENG-2", reason: "unlinked" }]);
    world.proof.assertAllCore({ callbacks: false });
  }, 120_000);
});

describe("journey 4: Linear, a person who has not linked waits and an admin starts it", () => {
  it("an issue from an unlinked person waits with its reason; a member who is not the project's admin cannot act on it; the project's admin starts it and owns and pays; a second press starts nothing", async () => {
    world = await connectedCompany();
    const hook = await world.linear!.issueCreated(WORKSPACE_A, { teamId: TEAM, actor: STRANGER_ON_LINEAR.id, key: "ENG-3" });
    expect(hook.status).toBe(200);
    expect(startedTasks(world)).toEqual([]);
    const waiting = await waitingTickets(world);
    expect(waiting.items.map((item) => ({ id: item.id, reason: item.reason }))).toEqual([{ id: "ENG-3", reason: "unlinked" }]);
    // Maya is a member with the project grant but not its administrator: the fixed refusal, nothing started.
    const member = await world.proof.probe(() => world!.maya("GET", "/v1/dev/projects/payments/intake"));
    expect({ status: member.status, code: (member.body.error as { code: string }).code }).toEqual({ status: 403, code: "FORBIDDEN" });
    const pressed = await world.proof.probe(() => world!.maya("POST", `/v1/dev/projects/payments/intake/${intakeItemIdOf("linear", "ENG-3")}/start`, { requestId: randomUUID() }));
    expect(pressed.status).toBe(403);
    expect(startedTasks(world)).toEqual([]);
    // The project's admin presses Start: the work is theirs.
    const requestId = randomUUID();
    const start = await world.priya("POST", `/v1/dev/projects/payments/intake/${intakeItemIdOf("linear", "ENG-3")}/start`, { requestId });
    expect(start.body, JSON.stringify(start)).toMatchObject({ started: true });
    const started = startedTasks(world);
    expect(started.map((task) => ({ origin: task.origin, owner: task.developerId, ticket: task.ticket }))).toEqual([{ origin: "tracker", owner: "9".repeat(64), ticket: { system: "linear", id: "ENG-3" } }]);
    expect((await world.priya("GET", `/v1/dev/tasks/${started[0]!.taskId}`)).body.task, "the admin owns it").toMatchObject({ project: "payments" });
    expect((await waitingTickets(world)).items, "it no longer waits").toEqual([]);
    // A second press (a new request) starts nothing more.
    const again = await world.priya("POST", `/v1/dev/projects/payments/intake/${intakeItemIdOf("linear", "ENG-3")}/start`, { requestId: randomUUID() });
    expect({ status: again.status, started: again.body.started, state: again.body.state }).toEqual({ status: 200, started: false, state: "started" });
    expect(startedTasks(world)).toHaveLength(1);
    world.proof.assertAllCore({ callbacks: false });
  }, 120_000);
});
