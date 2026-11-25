// PROJECT-GRANT-RECHECK, ARCH RULING (a): channel access holds an OLD-engine task only. A NEW-engine (core) task's own person holds it by the project grant alone, as its start and every one of
// its steps do (core-engine-root.ts `checkStart`, `resolve`, `checkStep`). The two engines are told apart by the engine stamp item `TASK_ENGINE#<id>` / `STAMP` (core-host/engine-stamp.ts, written
// only by the core's own start, in the start's transaction): a task WITHOUT one is an old-engine task; a stamp whose flow runs on the core is a core task; a stamp that is there but cannot be
// read, or a read that fails, is NOT an old-engine task (fail closed: grant only).
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { createCoreTaskRuleRoutes } from "../../packages/broker/src/aws/core-task-rule-routes.js";
import { developerTaskRouteDependencies, type DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import { holdsOwnTask } from "../../packages/broker/src/aws/task-readers.js";
import { engineStampKey } from "../../packages/broker/src/core-host/engine-stamp.js";
import { resolveCoreTaskAccess } from "../../packages/broker/src/developer/task-access.js";
import { companyRouteHarness, PERSON, TASK, TIME } from "../support/company-route-harness.js";

type Harness = ReturnType<typeof companyRouteHarness>;
const caller: DeveloperCaller = { developerId: PERSON, sessionId: "session", amr: "slack", name: "Test Person", slackUserId: "U0SHARED" };
const STAMP = { engine: "core", areas: { merge: "core", build: "core", flow: "core" }, flags: "test", stampedAt: TIME };

/** The engine stamp the core's start writes with a task. `areas`/`raw` change it to a mixed or a damaged one. */
const stamp = (h: Harness, value: unknown = STAMP) => h.db.set({ ...engineStampKey(TASK), entityType: "TASK_ENGINE", orgId: IMPLICIT_COMPANY_ID, taskId: TASK, coreEngine: value });
const listed = async (h: Harness) => (JSON.parse((await h.read("/v1/dev/tasks")).body) as { tasks: Array<{ taskId: string }> }).tasks.map((t) => t.taskId);
const taskRow = (h: Harness) => h.db.get(`DEVTASK#${TASK}`, "META") as never;
/** The own-person path of the page and the core's task routes (the real wiring): 200 as the owner, 404 when the own-task re-check refuses. */
const ownerRead = async (h: Harness) => {
  try { return (await resolveCoreTaskAccess(developerTaskRouteDependencies(h.deps, caller), caller, taskRow(h), "read")).role === "owner" ? 200 : 403; } catch { return 404; }
};
/** The core's task rule routes (events, readers), the way the core host serves them for a task of the caller's company. */
const rule = async (h: Harness, rest: "events" | "readers") => {
  const routes = createCoreTaskRuleRoutes((_person, companyId) => ({ ...developerTaskRouteDependencies(h.deps, caller), companyId }));
  const path = `/v1/dev/tasks/${TASK}/${rest}`;
  try { return (await routes.route({ request: { method: "GET", path, headers: {} }, path, person: { developerId: PERSON, name: "Test Person" }, companyId: IMPLICIT_COMPANY_ID, task: taskRow(h), store: { query: async () => ({ items: [] }) } })).statusCode; }
  catch (error) { return (error as { statusCode?: number }).statusCode ?? 500; }
};
const leave = (h: Harness) => { h.deps.developer.channelMembers = async () => ({ ok: true, memberOf: [] }); };

/** The person started the task with a grant, the grant is gone, and they are still in the bound channel (the removal plan tells the admin "they keep access through it"). */
function removedFromProjectStillInChannel(): Harness {
  const h = companyRouteHarness(); h.deps.companies = { companyOf: async () => IMPLICIT_COMPANY_ID };
  h.project(undefined, "grant"); h.task(TASK, IMPLICIT_COMPANY_ID);
  h.db.delete(`MEMBER#${PERSON}`, "PROJECT#shared-project");
  h.db.set({ pk: "SLACK_BINDING#T0SHARED", sk: "CHANNEL#C0SHARED", teamId: "T0SHARED", channelId: "C0SHARED", projectName: "shared-project", updatedAt: TIME });
  return h;
}

describe("a NEW-engine task's own person: grant only (a person removed from the project but still in the channel holds nothing of it)", () => {
  it("control: with the grant the person lists the task, reads it as its owner, and reads its events and readers", async () => {
    const h = companyRouteHarness(); h.deps.companies = { companyOf: async () => IMPLICIT_COMPANY_ID };
    h.project(undefined, "grant"); h.task(TASK, IMPLICIT_COMPANY_ID); stamp(h);
    expect(await listed(h)).toEqual([TASK]);
    expect(await ownerRead(h)).toBe(200);
    expect(await rule(h, "events")).toBe(200);
    expect(await rule(h, "readers")).toBe(200);
  });

  it("grant removed, still in the bound channel: not listed, not the owner, no events, no readers (the removed person's own 404)", async () => {
    const h = removedFromProjectStillInChannel(); stamp(h);
    expect(await listed(h)).toEqual([]);
    expect(await ownerRead(h)).toBe(404);
    expect(await holdsOwnTask(developerTaskRouteDependencies(h.deps, caller), taskRow(h), PERSON)).toBe(false);
    expect(await rule(h, "events")).toBe(404);
    expect(await rule(h, "readers")).toBe(404);
  });

  it("a stamp whose flow stays on the workflow (a mixed one) is an OLD-engine task: the channel still holds it", async () => {
    const h = removedFromProjectStillInChannel(); stamp(h, { ...STAMP, engine: "workflow", areas: { merge: "core", build: "core", flow: "workflow" } });
    expect(await listed(h)).toEqual([TASK]);
    expect(await ownerRead(h)).toBe(200);
  });

  it("an engine stamp that is there but cannot be read is NOT an old-engine task: grant only (fail closed)", async () => {
    for (const damaged of [null, "x", { engine: "core" }, { ...STAMP, areas: { flow: "elsewhere", build: "core", merge: "core" } }]) {
      const h = removedFromProjectStillInChannel(); stamp(h, damaged);
      expect(await listed(h)).toEqual([]);
      expect(await ownerRead(h)).toBe(404);
      expect(await rule(h, "events")).toBe(404);
    }
  });

  it("a stamp read that FAILS is not an old-engine task either: grant only", async () => {
    const h = removedFromProjectStillInChannel();
    const send = h.db.send.bind(h.db);
    h.deps.documentClient = { send: async (command: Parameters<typeof send>[0]) => { if (String((command as unknown as { input?: { Key?: { pk?: string } } }).input?.Key?.pk).startsWith("TASK_ENGINE#")) throw new Error("table unavailable"); return send(command); } };
    expect(await listed(h)).toEqual([]);
    expect(await ownerRead(h)).toBe(404);
    expect(await rule(h, "events")).toBe(404);
  });

  it("one page of the list, one project, an old-engine and a new-engine task: only the old-engine task lists (a channel hold is never kept for the project)", async () => {
    const OTHER = "22222222-2222-4222-8222-222222222222";
    for (const stampedFirst of [true, false]) {
      const h = removedFromProjectStillInChannel();
      h.task(OTHER, IMPLICIT_COMPANY_ID);
      h.db.set({ ...engineStampKey(stampedFirst ? TASK : OTHER), entityType: "TASK_ENGINE", orgId: IMPLICIT_COMPANY_ID, taskId: stampedFirst ? TASK : OTHER, coreEngine: STAMP });
      expect(await listed(h)).toEqual([stampedFirst ? OTHER : TASK]);
    }
  });

  it("the OLD-engine counterpart (no stamp) keeps its task through the channel, and loses it on leaving", async () => {
    const h = removedFromProjectStillInChannel();
    expect(await listed(h)).toEqual([TASK]);
    expect(await ownerRead(h)).toBe(200);
    expect(await rule(h, "events")).toBe(200);
    leave(h);
    expect(await listed(h)).toEqual([]);
    expect(await ownerRead(h)).toBe(404);
    expect(await rule(h, "events")).toBe(404);
  });
});
