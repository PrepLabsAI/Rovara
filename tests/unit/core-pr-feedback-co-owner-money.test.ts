// Controller ruling (a), 2026-11-23 (owner-approved mock state 3c, DEC 254zzz398): a LIVE co-owner of a task reads THAT task's own money
// (its spend, its limit and its payer: the owner's `TaskMoneyV1`). Never company money, another task's, a viewer's, a revoked co-owner's or a script token's.
import { describe, expect, it, vi } from "vitest";
import { toDocument } from "../../packages/broker/src/core/task-flow/records.js";
import { costPartition } from "../../packages/broker/src/core/cost/ledger.js";
import { hostedFeedbackWorld, type FeedbackRouteBody } from "../support/hosted-pr-feedback-world.js";

type World = Awaited<ReturnType<typeof hostedFeedbackWorld>>;
const CO_OWNER = "c".repeat(64);
const OTHER_TASK = "99999999-9999-4999-8999-999999999991";
const runEstimate = { lowUsd: 4.37, highUsd: 10.19, runLimitUsd: 12.71, stopAtUsd: 12.71, basis: "default" as const, samples: 0 };

/** One hosted world whose task has real ledger spend and a 12 dollar limit; the caller is `who` (a member of the company). */
async function moneyWorld(who: "owner" | "co-owner" | "viewer") {
  const w = await hostedFeedbackWorld("BLOCKED");
  w.task.runEstimate = runEstimate;
  await w.h.store.put({ item: toDocument(w.task) });
  await w.h.store.put({ item: { pk: costPartition(w.h.deps.companyId, w.task.taskId), sk: "ENTRY#one", companyId: w.h.deps.companyId, taskId: w.task.taskId, currency: "USD", micros: 1_230_000 } });
  w.wiring.taskActions = { roundCap: async () => ({ limitUsd: 12, spentUsd: 1.23 }) };
  w.membership.role = "member";
  w.caller.principal = { ...w.caller.principal, personId: who === "owner" ? w.task.developerId : CO_OWNER, roles: ["member"] };
  w.h.deps.access.canRead = async () => true;
  w.h.deps.access.canAct = async () => who !== "viewer";
  const live = { co: true };
  w.h.deps.access.ownerActing = async principal => (who === "owner" ? principal.personId === w.task.developerId : who === "co-owner" && live.co && principal.personId === CO_OWNER)
    ? { actorId: CO_OWNER, authority: { actorId: CO_OWNER, ownerIds: [CO_OWNER] } } : undefined;
  return { w, live };
}
const readTask = async (w: World, route = "") => JSON.parse((await w.send("GET", route))!.body) as FeedbackRouteBody;
const walk = (value: unknown): number[] => typeof value === "number" ? [value] : value !== null && typeof value === "object" ? Object.values(value).flatMap(walk) : [];

describe("a live co-owner reads this task's own money", () => {
  it("the task owner still gets the money (and the run estimate)", async () => {
    const { w } = await moneyWorld("owner");
    const body = await readTask(w);
    expect(body.task.money).toMatchObject({ spentMicros: { value: 1_230_000 }, stop: { taskMaximumMicros: { value: 12_000_000 } } });
    expect(body.task.runEstimate).toEqual(runEstimate);
  });

  it("a live co-owner gets exactly the task's spend, limit and payer: the owner's money, nothing else", async () => {
    const owner = (await readTask((await moneyWorld("owner")).w)).task.money;
    const { w } = await moneyWorld("co-owner");
    const body = await readTask(w);
    expect(body.task.money).toEqual(owner);
    expect(body.task.money).toMatchObject({ spentMicros: { value: 1_230_000 }, stop: { taskMaximumMicros: { value: 12_000_000 } }, payer: { state: expect.any(String) as unknown } });
    // Only the money: no run estimate, no design review figures, no company-wide anything.
    expect(body.task).not.toHaveProperty("runEstimate");
    expect(walk(body.task.workflow)).not.toContain(10.19);
    expect(walk({ ...body.task, money: undefined })).not.toContain(1_230_000);
  });

  it("the co-owner's paid-fix response carries the same task money", async () => {
    const { w } = await moneyWorld("co-owner");
    const response = await w.send("POST", "/workflow/feedback-decision", { ...w.request, decision: "DISMISS", selectedFindingIds: [], ownerNote: "The owner kept the pull request as it is." });
    expect(response?.statusCode).toBe(200);
    const task = (JSON.parse(response!.body) as FeedbackRouteBody).task;
    expect(task.money).toMatchObject({ spentMicros: { value: 1_230_000 }, stop: { taskMaximumMicros: { value: 12_000_000 } } });
    expect(task).not.toHaveProperty("runEstimate");
  });

  it("the task list's detail row gives a live co-owner the same spend and limit", async () => {
    const { w } = await moneyWorld("co-owner");
    expect(await w.routes.taskMoney(w.caller, w.task.taskId)).toMatchObject({ costUsd: 1.23, runLimitUsd: 12, money: { spentMicros: { value: 1_230_000 } } });
  });

  it("a plain viewer (may read, is no owner) gets no money and the ledger is never read", async () => {
    const { w } = await moneyWorld("viewer");
    const query = vi.spyOn(w.h.store, "query");
    const body = await readTask(w);
    expect(body.task).not.toHaveProperty("money");
    expect(body.task).not.toHaveProperty("runEstimate");
    for (const figure of [1.23, 1_230_000, 12_000_000, 4.37, 10.19]) expect(walk(body)).not.toContain(figure);
    expect(query.mock.calls.filter(([input]) => input.pk === costPartition(w.h.deps.companyId, w.task.taskId))).toEqual([]);
    expect(await w.routes.taskMoney(w.caller, w.task.taskId)).toBeUndefined();
  });

  it("a REVOKED co-owner gets no money from the very next read", async () => {
    const { w, live } = await moneyWorld("co-owner");
    expect((await readTask(w)).task.money).toBeDefined();
    live.co = false;
    const body = await readTask(w);
    expect(body.task).not.toHaveProperty("money");
    expect(await w.routes.taskMoney(w.caller, w.task.taskId)).toBeUndefined();
  });

  it("a host with no owner rule wired gives a plain viewer no money (nobody is a co-owner by default)", async () => {
    const { w } = await moneyWorld("viewer");
    delete w.h.deps.access.ownerActing;
    const body = await readTask(w);
    expect(body.task).not.toHaveProperty("money");
    expect(await w.routes.taskMoney(w.caller, w.task.taskId)).toBeUndefined();
  });

  it("an ownerActing that throws is no co-owner: no money, and the read itself still answers", async () => {
    const { w } = await moneyWorld("co-owner");
    w.h.deps.access.ownerActing = async () => { throw new Error("People unreadable"); };
    const response = await w.send("GET");
    expect(response?.statusCode).toBe(200);
    expect(JSON.parse(response!.body)).not.toHaveProperty("task.money");
  });

  it("a co-owner of task A asking about task B gets no money for B", async () => {
    const { w } = await moneyWorld("co-owner");
    const taskA = w.task.taskId;
    await w.h.store.put({ item: toDocument({ ...w.task, taskId: OTHER_TASK, pk: `DEVTASK#${OTHER_TASK}` }) });
    await w.h.store.put({ item: { pk: costPartition(w.h.deps.companyId, OTHER_TASK), sk: "ENTRY#one", companyId: w.h.deps.companyId, taskId: OTHER_TASK, currency: "USD", micros: 7_770_000 } });
    // The co-owner row is task A's: the live owner rule answers per task.
    w.h.deps.access.ownerActing = async (principal, task) => task.taskId === taskA ? { actorId: CO_OWNER, authority: { actorId: principal.personId, ownerIds: [principal.personId] } } : undefined;
    const answer = await w.routes.route({ method: "GET", path: `/v1/dev/tasks/${OTHER_TASK}`, headers: {} }, w.caller);
    expect(answer?.statusCode).toBe(200);
    const body = JSON.parse(answer!.body) as FeedbackRouteBody;
    expect(body.task).not.toHaveProperty("money");
    expect(walk(body)).not.toContain(7_770_000);
    expect((await readTask(w)).task.money).toBeDefined();
  });

  it("a script token gets no money even when its person is a live co-owner", async () => {
    const { w } = await moneyWorld("co-owner");
    const answer = await w.routes.route({ method: "GET", path: `/v1/dev/tasks/${w.task.taskId}`, headers: {} }, { ...w.caller, scriptToken: { tokenId: "script" } });
    expect(answer?.statusCode).toBe(200);
    expect(JSON.parse(answer!.body)).not.toHaveProperty("task.money");
    expect(await w.routes.taskMoney({ ...w.caller, scriptToken: { tokenId: "script" } }, w.task.taskId)).toBeUndefined();
  });

  it("a co-owner of another company's task gets no money", async () => {
    const { w } = await moneyWorld("co-owner");
    w.membership.companyId = "org_bbbbbbbbbbbbbbbbbbbb";
    const answer = await w.send("GET");
    expect([401, 404]).toContain(answer?.statusCode);
    expect(answer!.body).not.toContain("1230000");
  });
});
