// The cost report's task-page reference (lead 4, L4-TL): each row may carry `taskPage`, Code's own task page path (`/review/<taskId>/task`) for THAT row's task, so the admin portal can link a title. It is a
// reference, not access: the page enforces its own sign-in and task access. These tests prove the reference is built only from a row this company owns, never names another task or company, and that a row
// without one (an older Code) still reads.
import { describe, expect, it } from "vitest";
import { ReportTaskRowSchema, TASK_PAGE_PATH_PATTERN, reportTaskKey, taskPagePath, type OrgId, type ReportTasksResponse } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { reportStartItems } from "../../packages/broker/src/core/report/task-row.js";
import { readCompanyReportTasks } from "../../packages/broker/src/core/report/read.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const day = (d: number, hour = 9): string => `2026-11-${String(d).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`;
const merged = (updatedAt: string) => ({ stage: "MERGED", state: "COMPLETE", outcome: "MERGED", path: "FULL", updatedAt, pullRequests: [{ url: "https://github.com/acme/web/pull/7", state: "MERGED" }] });

function world() {
  const store = new MemoryDocumentStore();
  const seed = async (input: { company?: OrgId; n: number; startedAt: string; closedAt?: string; workflow?: Record<string, unknown>; project?: string }): Promise<string> => {
    const company = input.company ?? A;
    const taskId = id(input.n);
    const items = reportStartItems({ companyId: company, taskId, project: input.project ?? "alpha", title: `Task ${input.n}`, origin: "app", receivedAt: input.startedAt });
    expect((await store.transact(items)).applied).toBe(true);
    await store.put({ item: { pk: `DEVTASK#${taskId}`, sk: "META", entityType: "DEVELOPER_TASK", companyId: company, taskId, project: input.project ?? "alpha", title: `Task ${input.n}`, createdAt: input.startedAt, ...(input.closedAt === undefined ? {} : { closedAt: input.closedAt }), ...(input.workflow === undefined ? {} : { workflow: input.workflow as never }) } });
    return taskId;
  };
  const read = (company: OrgId, query: Record<string, unknown> = { from: day(1) }): Promise<ReportTasksResponse> => readCompanyReportTasks(store, company, query, NOW);
  return { store, seed, read };
}
const row = (taskId: string, extra: Record<string, unknown> = {}) => ({ taskId, project: "alpha", title: "t", origin: "web", state: "open", startedAt: day(3), prsOpened: 0, prsMerged: 0, prLinks: [], costMicros: 0, unpricedCalls: 0, ...extra });

describe("the task page reference in the contract", () => {
  it("is Code's own task page path for a task id, nothing else", () => {
    expect(taskPagePath(id(1))).toBe(`/review/${id(1)}/task`);
    expect(TASK_PAGE_PATH_PATTERN.test(taskPagePath(id(1)))).toBe(true);
  });
  it("a row accepts its own task's page, and a row without one (an older Code) still reads", () => {
    expect(ReportTaskRowSchema.safeParse(row(id(1), { taskPage: `/review/${id(1)}/task` })).success).toBe(true);
    const bare = ReportTaskRowSchema.safeParse(row(id(1)));
    expect(bare.success).toBe(true);
    expect(bare.success && "taskPage" in bare.data).toBe(false);
  });
  it("a row refuses a page of another task, an absolute address, an api path, a query, a fragment, a traversal and a protocol-relative address", () => {
    for (const bad of [
      `/review/${id(2)}/task`, `https://evil.example/review/${id(1)}/task`, `//evil.example/review/${id(1)}/task`, `/review/${id(1)}/task/api/state`, `/review/${id(1)}/task?next=//evil`, `/review/${id(1)}/task#x`,
      `/review/../${id(1)}/task`, `/review/${id(1)}/task/`, `/review/${id(1)}`, `javascript:alert(1)`, "", `/review/${id(1)}/task\n`, `/Review/${id(1)}/task`, `/review/not-a-uuid/task`,
    ]) {
      expect(ReportTaskRowSchema.safeParse(row(id(1), { taskPage: bad })).success, bad).toBe(false);
      // the pattern alone refuses everything but the one shape (Cloud mirrors it and has no row's own task id to compare with at that point)
      if (bad !== `/review/${id(2)}/task`) expect(TASK_PAGE_PATH_PATTERN.test(bad), bad).toBe(false);
    }
  });
});

describe("GET report tasks: task page references", () => {
  // D1-2 review M3: Code's own task page is deleted (DEC 254zzz511), so no row points to it; the field stays in the contract (an older Code, and Cloud's mirror), and a row without it draws its title as plain text.
  it("no row, open, closed, merged and settled, carries a task page reference (the page is gone), and each still reads", async () => {
    const w = world();
    const open = await w.seed({ n: 1, startedAt: day(3) });
    const closed = await w.seed({ n: 2, startedAt: day(4), closedAt: day(5) });
    const done = await w.seed({ n: 3, startedAt: day(6), workflow: merged(day(7)) });
    const first = await w.read(A);
    expect(first.tasks.map((r) => [r.taskId, r.taskPage])).toEqual([[open, undefined], [closed, undefined], [done, undefined]]);
    // the merged task settled: the second read serves it from its own stored row and still names it
    expect(await w.read(A)).toEqual(first);
    for (const r of first.tasks) expect(ReportTaskRowSchema.safeParse(r).success).toBe(true);
  });

  it("a stored row whose task id is not a task id is not shown (unreadable)", async () => {
    const w = world();
    const taskId = await w.seed({ n: 1, startedAt: day(3) });
    const stored = (await w.store.get(reportTaskKey(A, day(3), taskId)))!;
    await w.store.put({ item: { ...stored, taskId: "../../x", sk: `TASK#${day(3)}#../../x` } });
    const page = await w.read(A, { from: day(1), to: day(30) });
    // the planted row is counted unreadable and never shown; the real row still reads
    expect(page.tasks.map((r) => [r.taskId, r.taskPage])).toEqual([[taskId, undefined]]);
    expect(page.unreadable).toBe(1);
    expect(JSON.stringify(page)).not.toContain("../../x");
  });

});
