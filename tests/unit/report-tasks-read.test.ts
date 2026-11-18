// The cost report's task read (lead 4, A2): one row per task that started in the range, from the task's own record, its milestone rows and the cost ledger; the company boundary; money in whole
// millionths; bounded pages; no person in any row.
import { describe, expect, it } from "vitest";
import { REPORT_PAGE_DEFAULT, REPORT_SCAN_MAX, ReportTaskRowSchema, codeMilestoneKey, reportPartition, reportTaskKey, type OrgId, type ReportTasksResponse, type StoredDocument } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { costPartition } from "../../packages/broker/src/core/cost/ledger.js";
import { createFeatureStore } from "../../packages/broker/src/core/report/feature-store.js";
import { readCompanyReportTasks } from "../../packages/broker/src/core/report/read.js";
import { CLOSED_SETTLE_MS, foldTask, milestoneFactsOf, reportOriginOf, reportStartItems, reportTitleOf, settles, storedRowOf } from "../../packages/broker/src/core/report/task-row.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const DEVELOPER_CANARY = "dev-canary-0123456789abcdef0123456789abcdef";
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ada = { type: "person" as const, id: "ada" };

interface Seed {
  company?: OrgId;
  n: number;
  project?: string;
  title?: string;
  origin?: Parameters<typeof reportStartItems>[0]["origin"];
  startedAt: string;
  closedAt?: string;
  workflow?: Record<string, unknown>;
  cost?: { micros?: unknown; entries?: unknown; unpricedEntries?: unknown; currency?: unknown; companyId?: string };
  milestones?: Array<{ kind: string; at: string; n?: number; orgId?: string }>;
  purpose?: "setup_agent";
}

function world() {
  const store = new MemoryDocumentStore();
  const seed = async (input: Seed): Promise<string> => {
    const company = input.company ?? A;
    const taskId = id(input.n);
    const items = reportStartItems({ companyId: company, taskId, project: input.project ?? "alpha", title: input.title ?? `Task ${input.n}`, origin: input.origin ?? "app", purpose: input.purpose, receivedAt: input.startedAt });
    if (items.length > 0) expect((await store.transact(items)).applied).toBe(true);
    await store.put({ item: { pk: `DEVTASK#${taskId}`, sk: "META", entityType: "DEVELOPER_TASK", companyId: company, taskId, developerId: DEVELOPER_CANARY, project: input.project ?? "alpha", title: input.title ?? `Task ${input.n}`, createdAt: input.startedAt, ...(input.closedAt === undefined ? {} : { closedAt: input.closedAt }), ...(input.workflow === undefined ? {} : { workflow: input.workflow as never }) } });
    if (input.cost !== undefined) {
      await store.put({ item: { pk: costPartition(company, taskId), sk: "TOTAL", entityType: "COST_TOTAL", taskId, companyId: input.cost.companyId ?? company, ...(input.cost.currency === undefined ? {} : { currency: input.cost.currency as string }), micros: (input.cost.micros ?? 0) as number, entries: (input.cost.entries ?? 1) as number, unpricedEntries: (input.cost.unpricedEntries ?? 0) as number } });
    }
    for (const m of input.milestones ?? []) {
      await store.put({ item: { ...codeMilestoneKey(taskId, m.kind, m.n ?? 1), entityType: "CODE_MILESTONE", orgId: m.orgId ?? company, taskId, kind: m.kind, at: m.at, text: "x" } });
    }
    return taskId;
  };
  const read = (company: OrgId, query: Record<string, unknown>, now = NOW): Promise<ReportTasksResponse> => readCompanyReportTasks(store, company, query, now);
  return { store, seed, read };
}
const day = (d: number, hour = 9): string => `2026-11-${String(d).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`;
const merged = (updatedAt: string, prs = [{ url: "https://github.com/acme/web/pull/7", state: "MERGED" }]) => ({ stage: "MERGED", state: "COMPLETE", outcome: "MERGED", path: "FULL", updatedAt, pullRequests: prs });

describe("the start row", () => {
  it("is one put keyed by the start time, in the company's report partition, written only when absent", () => {
    const items = reportStartItems({ companyId: A, taskId: id(1), project: "alpha", title: "Fix\u0000 login", origin: "slack", receivedAt: day(3) });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item).toMatchObject({ kind: "put", condition: { op: "notExists" } });
    const row = (item as { item: StoredDocument }).item;
    expect(row).toMatchObject({ ...reportTaskKey(A, day(3), id(1)), project: "alpha", title: "Fix login", origin: "slack", state: "open", startedAt: day(3) });
    expect(row.pk).toBe(reportPartition(A));
    expect(JSON.stringify(row)).not.toMatch(/developer|person|requester/iu);
  });
  it("is not made for a setup run, a replay, or an input it cannot key; it never throws", () => {
    expect(reportStartItems({ companyId: A, taskId: id(1), project: "alpha", title: "t", origin: "app", purpose: "setup_agent", receivedAt: day(3) })).toEqual([]);
    expect(reportStartItems({ companyId: A, taskId: id(1), project: "alpha", title: "t", origin: "test_run", receivedAt: day(3) })).toEqual([]);
    expect(reportStartItems({ companyId: A, taskId: id(1), project: "alpha", title: "t", origin: "app", receivedAt: "yesterday" })).toEqual([]);
    expect(reportStartItems({ companyId: A, taskId: "not-a-task", project: "alpha", title: "t", origin: "app", receivedAt: day(3) })).toEqual([]);
    expect(reportStartItems({ companyId: "nope", taskId: id(1), project: "alpha", title: "t", origin: "app", receivedAt: day(3) })).toEqual([]);
  });
  it("says where a task started", () => {
    expect(["app", "cli", "mcp", "slack", "linear", "jira", "github_issue", "schedule", undefined].map((o) => reportOriginOf(o as never))).toEqual(["web", "tool", "tool", "slack", "linear", "jira", "other", "other", "other"]);
  });
  it("cuts and cleans a title", () => {
    expect([...reportTitleOf("x".repeat(500))]).toHaveLength(120);
    expect(reportTitleOf(" \u0000 ")).toBe("(no title)");
    expect(reportTitleOf("a\n\tb ‮ c")).toBe("a b c");
  });
});

describe("folding a task", () => {
  it("is merged when the workflow says so, with the merged milestone's time, and counts its pull requests", () => {
    const facts = foldTask({ pk: "DEVTASK#x", sk: "META", companyId: A, workflow: merged(day(5), [{ url: "https://github.com/a/b/pull/1", state: "MERGED" }, { url: "http://insecure.example/pull/2", state: "MERGED" }, { url: "https://user:pw@github.com/a/b/pull/3", state: "OPEN" }]) }, [{ kind: "pr_ready", at: day(4) }, { kind: "merged", at: day(5, 10) }]);
    expect(facts).toEqual({ state: "merged", path: "full", firstPrAt: day(4), endedAt: day(5, 10), prsOpened: 3, prsMerged: 2, prLinks: ["https://github.com/a/b/pull/1"] });
  });
  it("is merged from the milestone alone, and from the workflow alone (its own update time)", () => {
    expect(foldTask({ pk: "p", sk: "META" }, [{ kind: "merged", at: day(6) }])).toMatchObject({ state: "merged", endedAt: day(6) });
    expect(foldTask({ pk: "p", sk: "META", workflow: merged(day(7)) }, [])).toMatchObject({ state: "merged", endedAt: day(7) });
  });
  it("is closed with its close time, open without one, and merged beats closed", () => {
    expect(foldTask({ pk: "p", sk: "META", closedAt: day(8) }, [])).toEqual({ state: "closed", endedAt: day(8), prsOpened: 0, prsMerged: 0, prLinks: [] });
    expect(foldTask({ pk: "p", sk: "META", workflow: { path: "QUICK" } }, [])).toEqual({ state: "open", path: "quick", prsOpened: 0, prsMerged: 0, prLinks: [] });
    expect(foldTask({ pk: "p", sk: "META", closedAt: day(8), workflow: merged(day(7)) }, [])).toMatchObject({ state: "merged" });
  });
  it("takes the earliest of several pr_ready milestones and ignores a milestone of another company or task", () => {
    const rows: StoredDocument[] = [
      { pk: "DEVTASK#t", sk: "a", entityType: "CODE_MILESTONE", orgId: A, taskId: "t", kind: "pr_ready", at: day(9) },
      { pk: "DEVTASK#t", sk: "b", entityType: "CODE_MILESTONE", orgId: A, taskId: "t", kind: "pr_ready", at: day(4) },
      { pk: "DEVTASK#t", sk: "c", entityType: "CODE_MILESTONE", orgId: B, taskId: "t", kind: "pr_ready", at: day(1) },
      { pk: "DEVTASK#t", sk: "d", entityType: "CODE_MILESTONE", orgId: A, taskId: "other", kind: "pr_ready", at: day(1) },
      { pk: "DEVTASK#t", sk: "e", entityType: "CODE_MILESTONE", orgId: A, taskId: "t", kind: "pr_ready", at: "not a time" },
    ];
    expect(foldTask({ pk: "p", sk: "META" }, milestoneFactsOf(rows, A, "t")).firstPrAt).toBe(day(4));
  });
  it("settles at once when merged, a day after closing when closed, never when open", () => {
    const base = { prsOpened: 0, prsMerged: 0, prLinks: [] };
    expect(settles({ state: "merged", ...base }, 0)).toBe(true);
    expect(settles({ state: "open", ...base }, NOW)).toBe(false);
    const closed = { state: "closed" as const, endedAt: day(8), ...base };
    expect(settles(closed, Date.parse(day(8)) + CLOSED_SETTLE_MS - 1)).toBe(false);
    expect(settles(closed, Date.parse(day(8)) + CLOSED_SETTLE_MS)).toBe(true);
  });
});

describe("GET report tasks: the rows", () => {
  it("builds a row field by field from the record, the milestones and the ledger", async () => {
    const w = world();
    const feature = await createFeatureStore({ store: w.store, companyId: A, audit: { stage: () => [] }, now: () => NOW }).create({ name: "Checkout" }, ada);
    const taskId = await w.seed({ n: 1, startedAt: day(3), title: "Add checkout", origin: "linear", workflow: merged(day(5)), milestones: [{ kind: "pr_ready", at: day(4) }, { kind: "merged", at: day(5, 10) }], cost: { micros: 1_234_567, entries: 3, unpricedEntries: 1, currency: "USD" } });
    await createFeatureStore({ store: w.store, companyId: A, audit: { stage: () => [] }, now: () => NOW }).setTaskFeature({ taskId, project: "alpha", featureId: feature.id, source: "chosen" }, ada);
    const page = await w.read(A, { from: day(1) });
    expect(page).toMatchObject({ hasMore: false, skipped: 0, unreadable: 0 });
    expect(page.tasks).toEqual([{
      taskId, taskPage: `/review/${taskId}/task`, project: "alpha", title: "Add checkout", origin: "linear", path: "full", state: "merged", feature: { id: feature.id, source: "chosen" }, startedAt: day(3), firstPrAt: day(4), endedAt: day(5, 10),
      prsOpened: 1, prsMerged: 1, prLinks: ["https://github.com/acme/web/pull/7"], costMicros: 1_234_567, currency: "USD", unpricedCalls: 1,
    }]);
    expect(ReportTaskRowSchema.safeParse(page.tasks[0]).success).toBe(true);
  });

  it("a task with nothing recorded costs exactly zero with no currency, and has no feature", async () => {
    const w = world();
    await w.seed({ n: 1, startedAt: day(3) });
    const [row] = (await w.read(A, { from: day(1) })).tasks;
    expect(row).toMatchObject({ costMicros: 0, unpricedCalls: 0, state: "open" });
    expect(row).not.toHaveProperty("currency");
    expect(row).not.toHaveProperty("feature");
    expect(row).not.toHaveProperty("endedAt");
    expect(row).not.toHaveProperty("firstPrAt");
  });

  it("the wait split and the send-back counts are not there at all in version 0 (never zero)", async () => {
    const w = world();
    await w.seed({ n: 1, startedAt: day(3), workflow: merged(day(5)), cost: { micros: 5 } });
    const [row] = (await w.read(A, { from: day(1) })).tasks;
    for (const name of ["workingMs", "waitingPeopleMs", "waitingSystemMs", "sendBacksRovara", "sendBacksPeople", "timesComplete"]) expect(row).not.toHaveProperty(name);
  });

  it("no row names a person: the task's developer id never leaves", async () => {
    const w = world();
    await w.seed({ n: 1, startedAt: day(3), workflow: merged(day(5)), cost: { micros: 5 } });
    await w.seed({ n: 2, startedAt: day(4) });
    const raw = JSON.stringify(await w.read(A, { from: day(1) }));
    expect(raw).not.toContain(DEVELOPER_CANARY);
    expect(raw).not.toMatch(/requester|developerId|personId/iu);
  });

  it("costs are whole millionths summed by the ledger, passed through exactly (no float, no rounding)", async () => {
    const w = world();
    // 0.1 + 0.2 as a float would be 0.30000000000000004: in millionths it is exactly 300000
    await w.seed({ n: 1, startedAt: day(3), cost: { micros: 100_000 + 200_000, currency: "USD" } });
    await w.seed({ n: 2, startedAt: day(4), cost: { micros: Number.MAX_SAFE_INTEGER, currency: "USD" } });
    const rows = (await w.read(A, { from: day(1) })).tasks;
    expect(rows.map((r) => r.costMicros)).toEqual([300_000, Number.MAX_SAFE_INTEGER]);
    expect(rows.every((r) => Number.isInteger(r.costMicros))).toBe(true);
  });

  it.each([["a fraction", { micros: 1.5 }], ["a negative", { micros: -1 }], ["a string", { micros: "7" }], ["a float of entries", { entries: 0.5 }], ["unpriced as a float", { unpricedEntries: 1.25 }], ["an empty currency", { currency: "" }]])("a ledger total with %s is unreadable: left out and counted, never a wrong number", async (_name, cost) => {
    const w = world();
    await w.seed({ n: 1, startedAt: day(3), cost });
    await w.seed({ n: 2, startedAt: day(4), cost: { micros: 9 } });
    const page = await w.read(A, { from: day(1) });
    expect(page.tasks.map((r) => r.taskId)).toEqual([id(2)]);
    expect(page.unreadable).toBe(1);
  });

  it("a task closed without a merge is closed with its close time; an open one has no end", async () => {
    const w = world();
    await w.seed({ n: 1, startedAt: day(3), closedAt: day(4) });
    await w.seed({ n: 2, startedAt: day(3, 10) });
    const rows = (await w.read(A, { from: day(1) })).tasks;
    expect(rows.map((r) => [r.state, r.endedAt])).toEqual([["closed", day(4)], ["open", undefined]]);
  });

  it("a settled row is served from itself: the task record can be gone", async () => {
    const w = world();
    const taskId = await w.seed({ n: 1, startedAt: day(3), workflow: merged(day(5)), milestones: [{ kind: "merged", at: day(5, 10) }, { kind: "pr_ready", at: day(4) }], cost: { micros: 7 } });
    const first = await w.read(A, { from: day(1) });
    const stored = storedRowOf((await w.store.get(reportTaskKey(A, day(3), taskId)))!, A)!;
    expect(stored).toMatchObject({ state: "merged", endedAt: day(5, 10), firstPrAt: day(4), prsMerged: 1, version: 2 });
    expect(stored.settledAt).toBeDefined();
    await w.store.delete({ key: { pk: `DEVTASK#${taskId}`, sk: "META" } });
    for (const key of [codeMilestoneKey(taskId, "merged", 1), codeMilestoneKey(taskId, "pr_ready", 1)]) await w.store.delete({ key });
    const second = await w.read(A, { from: day(1) });
    expect(second).toEqual(first);
  });

  it("an open task is folded again on every read: it shows the pull request that was opened since", async () => {
    const w = world();
    const taskId = await w.seed({ n: 1, startedAt: day(3) });
    expect((await w.read(A, { from: day(1) })).tasks[0]).toMatchObject({ state: "open", prsOpened: 0 });
    await w.store.update({ key: { pk: `DEVTASK#${taskId}`, sk: "META" }, ops: [{ op: "set", path: ["workflow"], value: { stage: "REVIEW", pullRequests: [{ url: "https://github.com/a/b/pull/1", state: "OPEN" }] } }] });
    await w.store.put({ item: { ...codeMilestoneKey(taskId, "pr_ready", 0), entityType: "CODE_MILESTONE", orgId: A, taskId, kind: "pr_ready", at: day(4), text: "x" } });
    expect((await w.read(A, { from: day(1) })).tasks[0]).toMatchObject({ state: "open", prsOpened: 1, prsMerged: 0, firstPrAt: day(4), prLinks: ["https://github.com/a/b/pull/1"] });
    expect(storedRowOf((await w.store.get(reportTaskKey(A, day(3), taskId)))!, A)).toMatchObject({ prsOpened: 1 });
  });

  it("a task whose record is gone is unreadable (counted, left out)", async () => {
    const w = world();
    const taskId = await w.seed({ n: 1, startedAt: day(3) });
    await w.store.delete({ key: { pk: `DEVTASK#${taskId}`, sk: "META" } });
    expect(await w.read(A, { from: day(1) })).toMatchObject({ tasks: [], unreadable: 1 });
  });

  it("a setup run and a replay are not in the report", async () => {
    const w = world();
    await w.seed({ n: 1, startedAt: day(3), purpose: "setup_agent" });
    await w.seed({ n: 2, startedAt: day(3, 10), origin: "test_run" });
    await w.seed({ n: 3, startedAt: day(3, 11) });
    expect((await w.read(A, { from: day(1) })).tasks.map((r) => r.taskId)).toEqual([id(3)]);
  });
});

describe("GET report tasks: which range a task belongs to", () => {
  it("a task belongs to the range it STARTED in, with its whole cost, even if it ends (and spends) in the next one", async () => {
    const w = world();
    await w.seed({ n: 1, startedAt: "2026-10-31T23:59:59.999Z", workflow: merged("2026-11-02T10:00:00.000Z"), milestones: [{ kind: "merged", at: "2026-11-02T10:00:00.000Z" }], cost: { micros: 40_000_000, currency: "USD" } });
    await w.seed({ n: 2, startedAt: "2026-11-01T00:00:00.000Z", cost: { micros: 2_000_000, currency: "USD" } });
    const october = await w.read(A, { from: "2026-10-01T00:00:00.000Z", to: "2026-10-31T23:59:59.999Z" });
    const november = await w.read(A, { from: "2026-11-01T00:00:00.000Z", to: "2026-11-30T23:59:59.999Z" });
    expect(october.tasks.map((r) => [r.taskId, r.costMicros])).toEqual([[id(1), 40_000_000]]);
    expect(november.tasks.map((r) => [r.taskId, r.costMicros])).toEqual([[id(2), 2_000_000]]);
    // the two ranges together hold each task once: nothing double counted, nothing lost
    expect([...october.tasks, ...november.tasks].reduce((sum, r) => sum + r.costMicros, 0)).toBe(42_000_000);
  });
  it("includes a task that started exactly at `from` and exactly at `to`, and none after `to`", async () => {
    const w = world();
    await w.seed({ n: 1, startedAt: day(3, 0) });
    await w.seed({ n: 2, startedAt: day(5, 0) });
    await w.seed({ n: 3, startedAt: "2026-11-05T00:00:00.001Z" });
    expect((await w.read(A, { from: day(3, 0), to: day(5, 0) })).tasks.map((r) => r.taskId)).toEqual([id(1), id(2)]);
  });
  it("lists oldest start first whatever order they were made in", async () => {
    const w = world();
    await w.seed({ n: 3, startedAt: day(9) });
    await w.seed({ n: 1, startedAt: day(3) });
    await w.seed({ n: 2, startedAt: day(5) });
    expect((await w.read(A, { from: day(1) })).tasks.map((r) => r.taskId)).toEqual([id(1), id(2), id(3)]);
  });
  it("defaults `to` to now", async () => {
    const w = world();
    await w.seed({ n: 1, startedAt: day(3) });
    await w.seed({ n: 2, startedAt: "2026-11-21T00:00:00.000Z" });
    expect((await w.read(A, { from: day(1) })).tasks.map((r) => r.taskId)).toEqual([id(1)]);
  });
});

describe("GET report tasks: filters and paging", () => {
  async function filled() {
    const w = world();
    await w.seed({ n: 1, startedAt: day(3), project: "alpha", origin: "slack", workflow: { path: "QUICK" } });
    await w.seed({ n: 2, startedAt: day(4), project: "beta", origin: "app", workflow: { ...merged(day(6)), path: "FULL" } });
    await w.seed({ n: 3, startedAt: day(5), project: "alpha", origin: "linear", closedAt: day(6), workflow: { path: "FULL" } });
    await w.seed({ n: 4, startedAt: day(6), project: "beta", origin: "slack" });
    return w;
  }
  it.each([
    [{ project: "alpha" }, [1, 3]], [{ project: "beta" }, [2, 4]], [{ origin: "slack" }, [1, 4]], [{ origin: "web" }, [2]], [{ origin: "linear" }, [3]],
    [{ state: "merged" }, [2]], [{ state: "closed" }, [3]], [{ state: "open" }, [1, 4]], [{ state: "failed" }, []],
    [{ path: "quick" }, [1]], [{ path: "full" }, [2, 3]], [{ project: "alpha", state: "closed" }, [3]], [{ project: "alpha", origin: "slack", path: "quick" }, [1]],
  ] as const)("filter %j", async (filter, expected) => {
    const w = await filled();
    expect((await w.read(A, { from: day(1), ...filter })).tasks.map((r) => r.taskId)).toEqual(expected.map(id));
  });

  it("pages with a cursor: every task once, in order, whatever the page size; a short last page ends it", async () => {
    const w = world();
    for (let n = 1; n <= 7; n += 1) await w.seed({ n, startedAt: day(2 + n), cost: { micros: n * 10 } });
    for (const limit of [1, 2, 3, 7, 50]) {
      const seen: string[] = [];
      let query: Record<string, unknown> = { from: day(1), limit };
      for (let pages = 0; pages < 20; pages += 1) {
        const page = await w.read(A, query);
        expect(page.tasks.length).toBeLessThanOrEqual(limit);
        seen.push(...page.tasks.map((r) => r.taskId));
        if (!page.hasMore) break;
        query = { cursor: page.next, limit };
      }
      expect(seen, `limit ${limit}`).toEqual([1, 2, 3, 4, 5, 6, 7].map(id));
    }
  });

  it("paging with a state filter that drops rows still finds every match once", async () => {
    const w = world();
    for (let n = 1; n <= 9; n += 1) await w.seed({ n, startedAt: day(2 + n), ...(n % 3 === 0 ? { workflow: merged(day(20)) } : {}) });
    const seen: string[] = [];
    let query: Record<string, unknown> = { from: day(1), state: "merged", limit: 2 };
    for (let pages = 0; pages < 20; pages += 1) {
      const page = await w.read(A, query);
      seen.push(...page.tasks.map((r) => r.taskId));
      if (!page.hasMore) break;
      query = { cursor: page.next, state: "merged", limit: 2 };
    }
    expect(seen).toEqual([3, 6, 9].map(id));
  });

  it("a read of an empty range gives a cursor that can be passed back (and finds what started since)", async () => {
    const w = world();
    const empty = await w.read(A, { from: day(1) });
    expect(empty).toMatchObject({ tasks: [], hasMore: false });
    await w.seed({ n: 1, startedAt: day(3) });
    expect((await w.read(A, { cursor: empty.next })).tasks.map((r) => r.taskId)).toEqual([id(1)]);
  });

  it("when a filter makes pages overshoot the limit, the rows past the limit are read again next time, not lost", async () => {
    const w = world();
    // pages of 3 stored rows: merged, merged, open | merged, merged, open | merged, merged: two matches a page, limit 3
    for (let n = 1; n <= 8; n += 1) await w.seed({ n, startedAt: day(2 + n), cost: { micros: n }, ...(n % 3 === 0 ? {} : { workflow: merged(day(25)) }) });
    const seen: string[] = [];
    let query: Record<string, unknown> = { from: day(1), state: "merged", limit: 3 };
    for (let pages = 0; pages < 10; pages += 1) {
      const page = await w.read(A, query);
      expect(page.tasks.length).toBeLessThanOrEqual(3);
      seen.push(...page.tasks.map((r) => r.taskId));
      if (!page.hasMore) break;
      query = { cursor: page.next, state: "merged", limit: 3 };
    }
    expect(seen).toEqual([1, 2, 4, 5, 7, 8].map(id));
  });

  it("polls: the cursor after the last page, asked again later, returns what started since", async () => {
    const w = world();
    await w.seed({ n: 1, startedAt: day(3) });
    const first = await w.read(A, { from: day(1) });
    expect(first.hasMore).toBe(false);
    await w.seed({ n: 2, startedAt: day(10) });
    const later = await w.read(A, { cursor: first.next });
    expect(later.tasks.map((r) => r.taskId)).toEqual([id(2)]);
  });

  it("a page is at most the default size when no limit is given, and at most 200 whatever is asked", async () => {
    const w = world();
    for (let n = 1; n <= REPORT_PAGE_DEFAULT + 5; n += 1) await w.seed({ n, startedAt: new Date(Date.parse(day(1)) + n * 1000).toISOString() });
    const page = await w.read(A, { from: day(1) });
    expect(page.tasks).toHaveLength(REPORT_PAGE_DEFAULT);
    expect(page.hasMore).toBe(true);
    await expect(w.read(A, { from: day(1), limit: 201 })).rejects.toThrow(/not valid/u);
  });

  it("a call looks at no more than the scan limit of stored rows, however few match, and says where to go on", async () => {
    const w = world();
    for (let n = 1; n <= REPORT_SCAN_MAX + 30; n += 1) {
      const startedAt = new Date(Date.parse(day(1)) + n * 1000).toISOString();
      await w.store.put({ item: { ...reportTaskKey(A, startedAt, id(n)), entityType: "REPORT_TASK", companyId: A, taskId: id(n), project: "alpha", title: "t", origin: "web", startedAt, state: "open", prsOpened: 0, prsMerged: 0, prLinks: [], version: 1 } });
    }
    const page = await w.read(A, { from: day(1), project: "nomatch" });
    expect(page).toMatchObject({ tasks: [], hasMore: true });
    const rest = await w.read(A, { cursor: page.next, project: "nomatch" });
    expect(rest).toMatchObject({ tasks: [], hasMore: false });
  }, 60_000);
});

describe("GET report tasks: query checks", () => {
  it.each([
    ["no from and no cursor", {}], ["both from and cursor", { from: day(1), cursor: "x" }], ["an unknown field", { from: day(1), person: "ada" }], ["a requester field", { from: day(1), requester: "ada" }],
    ["a from that is not an instant", { from: "2026-11-01" }], ["from after to", { from: day(9), to: day(1) }], ["a limit of zero", { from: day(1), limit: 0 }], ["an origin that does not exist", { from: day(1), origin: "carrier-pigeon" }],
    ["a project that is not a name", { from: day(1), project: "../etc" }], ["a cursor that is not one", { cursor: "not-a-cursor" }],
  ])("refuses %s with fixed words", async (_name, query) => {
    const w = world();
    const error = await w.read(A, query as Record<string, unknown>).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/not valid/u);
    expect((error as Error).message).not.toMatch(/ada|carrier|etc/u);
  });
  it("refuses a company that is not a company id", async () => {
    await expect(world().read("nope", { from: day(1) })).rejects.toThrow(/company is not valid/u);
  });
});

describe("GET report tasks: the company boundary", () => {
  it("two companies, same project names, same times: each reads only its own rows, costs and features", async () => {
    const w = world();
    const fa = await createFeatureStore({ store: w.store, companyId: A, audit: { stage: () => [] }, now: () => NOW }).create({ name: "Shared name" }, ada);
    const fb = await createFeatureStore({ store: w.store, companyId: B, audit: { stage: () => [] }, now: () => NOW }).create({ name: "Shared name" }, ada);
    const a = await w.seed({ company: A, n: 1, startedAt: day(3), cost: { micros: 111, currency: "USD" } });
    const b = await w.seed({ company: B, n: 2, startedAt: day(3), cost: { micros: 222, currency: "USD" } });
    await createFeatureStore({ store: w.store, companyId: A, audit: { stage: () => [] }, now: () => NOW }).setTaskFeature({ taskId: a, project: "alpha", featureId: fa.id, source: "chosen" }, ada);
    await createFeatureStore({ store: w.store, companyId: B, audit: { stage: () => [] }, now: () => NOW }).setTaskFeature({ taskId: b, project: "alpha", featureId: fb.id, source: "chosen" }, ada);
    const [ra, rb] = [await w.read(A, { from: day(1) }), await w.read(B, { from: day(1) })];
    expect(ra.tasks.map((r) => [r.taskId, r.costMicros, r.feature?.id])).toEqual([[a, 111, fa.id]]);
    expect(rb.tasks.map((r) => [r.taskId, r.costMicros, r.feature?.id])).toEqual([[b, 222, fb.id]]);
    expect(JSON.stringify(ra)).not.toContain(b);
    expect(JSON.stringify(rb)).not.toContain(a);
  });

  it("a task of B filed under A's feature id does not read as that feature in B (the feature is not B's)", async () => {
    const w = world();
    const fa = await createFeatureStore({ store: w.store, companyId: A, audit: { stage: () => [] }, now: () => NOW }).create({ name: "A only" }, ada);
    const b = await w.seed({ company: B, n: 2, startedAt: day(3) });
    const row = await w.store.put({ item: { pk: reportPartition(B), sk: `TASKFEAT#${b}`, entityType: "REPORT_TASK_FEATURE", companyId: B, taskId: b, project: "alpha", featureId: fa.id, source: "moved", setAt: day(3), version: 1 } });
    expect(row.applied).toBe(true);
    expect((await w.read(B, { from: day(1) })).tasks[0]).not.toHaveProperty("feature");
  });

  it("a row planted in B's partition that names A is skipped and counted, never shown", async () => {
    const w = world();
    const a = await w.seed({ company: A, n: 1, startedAt: day(3), cost: { micros: 5 } });
    const planted = (await w.store.get(reportTaskKey(A, day(3), a)))!;
    await w.store.put({ item: { ...planted, pk: reportPartition(B) } });
    const page = await w.read(B, { from: day(1) });
    expect(page).toMatchObject({ tasks: [], skipped: 1 });
    expect(JSON.stringify(page)).not.toContain(a);
  });

  it("a stored row of B whose task record is A's is skipped (the record is checked, not only the key)", async () => {
    const w = world();
    const taskId = id(1);
    await w.store.transact(reportStartItems({ companyId: B, taskId, project: "alpha", title: "t", origin: "app", receivedAt: day(3) }));
    await w.store.put({ item: { pk: `DEVTASK#${taskId}`, sk: "META", entityType: "DEVELOPER_TASK", companyId: A, taskId, project: "alpha", title: "A's task" } });
    expect(await w.read(B, { from: day(1) })).toMatchObject({ tasks: [], skipped: 1 });
  });

  it("a stored row whose key does not match its own fields is unreadable (counted, left out)", async () => {
    const w = world();
    const taskId = await w.seed({ n: 1, startedAt: day(3) });
    const row = (await w.store.get(reportTaskKey(A, day(3), taskId)))!;
    await w.store.put({ item: { ...row, startedAt: day(4) } });
    expect(await w.read(A, { from: day(1) })).toMatchObject({ tasks: [], unreadable: 1 });
  });

  it("a task record that names another task than its row is skipped", async () => {
    const w = world();
    const taskId = await w.seed({ n: 1, startedAt: day(3) });
    await w.store.update({ key: { pk: `DEVTASK#${taskId}`, sk: "META" }, ops: [{ op: "set", path: ["taskId"], value: id(99) }] });
    expect(await w.read(A, { from: day(1) })).toMatchObject({ tasks: [], skipped: 1 });
  });

  it("a cost total of another company is skipped, not added", async () => {
    const w = world();
    await w.seed({ company: B, n: 1, startedAt: day(3), cost: { micros: 999, companyId: A } });
    expect(await w.read(B, { from: day(1) })).toMatchObject({ tasks: [], skipped: 1 });
  });

  it("a milestone row of another company never gives a task a pull request time", async () => {
    const w = world();
    await w.seed({ company: B, n: 1, startedAt: day(3), milestones: [{ kind: "pr_ready", at: day(4), orgId: A }] });
    expect((await w.read(B, { from: day(1) })).tasks[0]).not.toHaveProperty("firstPrAt");
  });

  it("a cursor belongs to one company and one question", async () => {
    const w = world();
    for (let n = 1; n <= 3; n += 1) { await w.seed({ company: A, n, startedAt: day(2 + n) }); await w.seed({ company: B, n: n + 10, startedAt: day(2 + n) }); }
    const page = await w.read(A, { from: day(1), limit: 1 });
    expect(page.hasMore).toBe(true);
    await expect(w.read(B, { cursor: page.next, limit: 1 })).rejects.toThrow(/cursor is not valid/u);
    await expect(w.read(A, { cursor: page.next, limit: 1, project: "alpha" })).rejects.toThrow(/cursor is not valid/u);
    await expect(w.read(A, { cursor: page.next, limit: 1, to: day(9) })).rejects.toThrow(/cursor is not valid/u);
    expect((await w.read(A, { cursor: page.next, limit: 1 })).tasks[0]!.taskId).toBe(id(2));
  });

  it("two projects of one company: a project filter shows one project's rows only", async () => {
    const w = world();
    await w.seed({ n: 1, startedAt: day(3), project: "alpha" });
    await w.seed({ n: 2, startedAt: day(4), project: "beta" });
    expect((await w.read(A, { from: day(1), project: "alpha" })).tasks.map((r) => r.project)).toEqual(["alpha"]);
    expect((await w.read(A, { from: day(1), project: "beta" })).tasks.map((r) => r.project)).toEqual(["beta"]);
  });

  it("the rows hold up under a store that lies: a store fault is a fixed 503, never partial rows", async () => {
    const w = world();
    await w.seed({ n: 1, startedAt: day(3) });
    const original = w.store.getMany.bind(w.store);
    w.store.getMany = async () => { throw new Error("boom secret-canary"); };
    const error = await w.read(A, { from: day(1) }).catch((e: Error) => e);
    expect((error as Error).message).toMatch(/can't read the report/u);
    expect((error as Error).message).not.toContain("secret-canary");
    w.store.getMany = original;
  });
});
