// PROJECT-GRANT-RECHECK, channel-access starters (Opus "CI-red delta" finding on the hotfix): a person who may START a task through a bound Slack channel (no grant row, the project lets
// channel members use it) is the task's own person, and must list and read it the same as one holding a grant. The own-task re-check uses the SAME live project-access test as the start
// (`checkProjectAccess`): a grant, or fresh bound-channel membership while the project's `channelMembersMayUse` is on and the person is Slack-linked. Read on every request; nothing cached.
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { developerTaskRouteDependencies, type DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import { resolveCoreTaskAccess } from "../../packages/broker/src/developer/task-access.js";
import { coreTaskMarkKey } from "../../packages/broker/src/core-host/core-task-mark.js";
import { companyRouteHarness, PERSON, TASK } from "../support/company-route-harness.js";

type Harness = ReturnType<typeof companyRouteHarness>;
const listed = async (h: Harness) => (JSON.parse((await h.read("/v1/dev/tasks")).body) as { tasks: Array<{ taskId: string }> }).tasks.map((t) => t.taskId);
/** The task's own-person path as the page and the core's task routes meet it (the real route wiring): 200 as its owner, 404 when the own-task re-check refuses. */
const events = async (h: Harness) => {
  const caller: DeveloperCaller = { developerId: PERSON, sessionId: "session", amr: "slack", name: "Test Person", slackUserId: "U0SHARED" };
  const task = h.db.get(`DEVTASK#${TASK}`, "META") as never;
  try { return (await resolveCoreTaskAccess(developerTaskRouteDependencies(h.deps, caller), caller, task, "read")).role === "owner" ? 200 : 403; } catch { return 404; }
};
const leave = (h: Harness) => { h.deps.developer.channelMembers = async () => ({ ok: true, memberOf: [] }); };
const channelsOff = (h: Harness) => h.db.set({ pk: "PROJECT#shared-project", sk: "REV#000000000001", entityType: "PROJECT", definition: { name: "shared-project", revision: 1, developerTasks: { channelMembersMayUse: false } } });
// D1-2 (DEC 254zzz502): a task row with no core mark is the retired old workflow's and is never listed; only a marked (core) task lists. The own-person path (`events`) still holds an old row through the channel.
const markCore = (h: Harness) => h.db.set({ ...coreTaskMarkKey(TASK), entityType: "TASK_ENGINE", orgId: IMPLICIT_COMPANY_ID, taskId: TASK, coreEngine: { engine: "core", areas: { merge: "core", build: "core", flow: "core" }, flags: "test", stampedAt: "2026-11-14T12:00:00.000Z" } });
const withCompanyLayer = (h: Harness) => { h.deps.companies = { companyOf: async () => IMPLICIT_COMPANY_ID }; };

describe("a channel-access starter's own task (company layer)", () => {
  // The harness marks every task as the core's (D1-2); these cases are about the OLD row's own-person hold, so the world starts without the mark (the control re-marks it).
  const world = (access: "grant" | "channel" | "none") => { const h = companyRouteHarness(); withCompanyLayer(h); h.project(undefined, access); h.task(); h.db.delete(`TASK_ENGINE#${TASK}`, "STAMP"); return h; };

  it("control: a grant holder lists and reads their own task", async () => {
    const h = world("grant"); markCore(h);
    expect(await listed(h)).toEqual([TASK]);
    expect(await events(h)).toBe(200);
  });

  it("a channel member starts their own task and reads it (an old row is not listed)", async () => {
    const h = world("channel");
    expect(await listed(h)).toEqual([]);
    expect(await events(h)).toBe(200);
  });

  it("the same person after LEAVING the channel loses the task (not listed, 404)", async () => {
    const h = world("channel");
    expect(await events(h)).toBe(200);
    leave(h);
    expect(await listed(h)).toEqual([]);
    expect(await events(h)).toBe(404);
  });

  it("with the project's channel use turned OFF, the channel no longer gives the task (not listed, 404)", async () => {
    const h = world("channel"); channelsOff(h);
    expect(await listed(h)).toEqual([]);
    expect(await events(h)).toBe(404);
  });

  it("Slack unreachable is a no (fails closed, as the start does)", async () => {
    const h = world("channel");
    h.deps.developer.channelMembers = async () => ({ ok: false } as never);
    expect(await listed(h)).toEqual([]);
    expect(await events(h)).toBe(404);
  });

  it("a person with no Slack link gets nothing from a channel", async () => {
    const h = world("channel");
    h.db.set({ pk: `DEVELOPER#${PERSON}`, sk: "META", displayName: "Test Person" });
    expect(await listed(h)).toEqual([]);
    expect(await events(h)).toBe(404);
  });

  it("a grant removed but still in the channel KEEPS the task (the removal plan says they keep access through it)", async () => {
    const h = world("grant");
    expect(await events(h)).toBe(200);
    h.db.delete(`MEMBER#${PERSON}`, "PROJECT#shared-project");
    h.db.set({ pk: "SLACK_BINDING#T0SHARED", sk: "CHANNEL#C0SHARED", teamId: "T0SHARED", channelId: "C0SHARED", projectName: "shared-project", updatedAt: "2026-11-14T12:00:00.000Z" });
    expect(await listed(h)).toEqual([]);
    expect(await events(h)).toBe(200);
    leave(h);
    expect(await listed(h)).toEqual([]);
    expect(await events(h)).toBe(404);
  });

  it("neither a grant nor a channel: the original refusal (not listed, 404)", async () => {
    const h = world("none");
    expect(await listed(h)).toEqual([]);
    expect(await events(h)).toBe(404);
  });
});

it("a channel member who is NOT the task's starter sees nothing of it (company layer: the list names only the caller's own tasks)", async () => {
  const h = companyRouteHarness(); withCompanyLayer(h); h.project(undefined, "channel");
  h.db.set({ ...h.task(), developerId: "e".repeat(64), ownerKey: "e".repeat(64) });
  expect(await listed(h)).toEqual([]);
  expect(await events(h)).toBe(404);
});
