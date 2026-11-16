import { STATE_TABLE_INDEXES, STATE_TABLE_PLANNED_INDEXES } from "../../packages/aws-adapters/src/dynamodb/state-table.js";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { IMPLICIT_COMPANY_ID, queryAll, type StoredDocument } from "@agentx/contracts";
import { dynamoWorld } from "../support/ports/dynamodb-harness.js";
import { workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { locateWorkspace } from "../../packages/broker/src/core/task-flow/workspace-location.js";
import { materializeT1Golden } from "../support/t1-golden-normalizer.js";

const companyId = IMPLICIT_COMPANY_ID;
const fixture = materializeT1Golden(JSON.parse(readFileSync(new URL("../fixtures/t1-key-goldens/memory.json", import.meta.url), "utf8")) as { snapshots: Array<{ rows: StoredDocument[] }> });
async function world() {
  const w = dynamoWorld({ indexes: [...STATE_TABLE_INDEXES, ...STATE_TABLE_PLANNED_INDEXES] });
  const rows = fixture.snapshots.at(-1)!.rows;
  for (const row of rows) await w.store.put({ item: row });
  const meta = rows.find((row) => row.entityType === "WORKSPACE")!;
  if (typeof meta.id !== "string") throw new Error("invalid fixture workspace");
  return { ...w, meta: { ...meta, id: meta.id }, deps: { companyId, store: w.store, now: () => Date.parse("2026-11-15T00:00:00Z"), continuationKey: Buffer.alloc(32, 7) } };
}
describe("bounded offline workspace backfill", () => {
  it("copies closed golden rows, verifies, switches META last and deletes legacy last", async () => {
    const { backfillWorkspaceKeysPage } = await import("../../packages/broker/src/core/task-flow/key-backfill.js");
    const w = await world(); const before = (await w.store.query({ pk: w.meta.pk })).items;
    const queries = vi.spyOn(w.store, "query"); const puts = vi.spyOn(w.store, "put"); const transactions = vi.spyOn(w.store, "transact"); const deletes = vi.spyOn(w.store, "delete");
    let continuation: string | undefined; let moved = 0;
    for (let page = 0; page < 30; page++) {
      const report = await backfillWorkspaceKeysPage(w.deps, { limit: 25, ...(continuation === undefined ? {} : { continuation }) });
      moved += report.moved; continuation = report.continuation; if (!report.more) break;
    }
    expect(continuation).toBeUndefined(); expect(moved).toBe(1);
    const scoped = workspaceKey(companyId, w.meta.id);
    expect((await w.store.query({ pk: scoped.pk })).items).toEqual(before.map((row) => ({ ...row, pk: scoped.pk })));
    expect((await w.store.query({ pk: w.meta.pk })).items).toEqual([]);
    expect(puts.mock.calls.filter(([request]) => request.item.pk === scoped.pk).every(([request]) => request.item.sk !== "META")).toBe(true);
    expect(transactions.mock.invocationCallOrder[0]).toBeGreaterThan(Math.max(...puts.mock.invocationCallOrder));
    const verified = queries.mock.calls.flatMap(([request], index) => request.pk === scoped.pk ? [queries.mock.invocationCallOrder[index]!] : []);
    expect(verified.length).toBeGreaterThan(0);
    expect(deletes.mock.invocationCallOrder[0]).toBeGreaterThan(verified[0]!);
    expect(transactions.mock.calls.at(-1)?.[0].some((item) => item.kind === "put" && item.item.sk === "META")).toBe(true);
    expect(deletes.mock.calls.filter(([request]) => request.key.pk === w.meta.pk).at(-1)?.[0].key.sk).toBe("META");
    expect(await locateWorkspace(w.deps, w.meta.id)).toMatchObject({ scope: "company" });
    expect((await backfillWorkspaceKeysPage(w.deps, { limit: 25 })).moved).toBe(0);
  });
  it("dryRun writes nothing and forged continuations have fixed refusal words", async () => {
    const { backfillWorkspaceKeysPage } = await import("../../packages/broker/src/core/task-flow/key-backfill.js");
    const w = await world(); const put = vi.spyOn(w.store, "put"), del = vi.spyOn(w.store, "delete"), transact = vi.spyOn(w.store, "transact");
    const partitions = [...new Set([...fixture.snapshots.at(-1)!.rows.map((row) => row.pk), workspaceKey(companyId, w.meta.id).pk])].sort();
    const snapshot = async () => Promise.all(partitions.map((pk) => queryAll(w.store, { pk })));
    const before = await snapshot();
    const requestOffset = w.fake.requests.length;
    await backfillWorkspaceKeysPage(w.deps, { limit: 25, dryRun: true });
    expect(put).not.toHaveBeenCalled(); expect(del).not.toHaveBeenCalled(); expect(transact).not.toHaveBeenCalled();
    expect(w.fake.requests.slice(requestOffset).every(({ operation }) => ["GetItem", "Query"].includes(operation))).toBe(true);
    expect(await snapshot()).toEqual(before);
    await expect(backfillWorkspaceKeysPage(w.deps, { limit: 25, continuation: "forged-canary" })).rejects.toThrow("invalid backfill continuation");
  });
  it.each([{ status: "CLOSED", activeOperationId: "active" }, { status: "BUSY", activeOperationId: null }, { closedAt: "2026-11-15T00:00:00Z" }, { companyId: "org_bbbbbbbbbbbbbbbbbbbb" }, { companyId: "bad" }, { updatedAt: "2026-11-15T00:00:00Z" }])("skips ineligible workspace %j", async (fields) => {
    const { backfillWorkspaceKeysPage } = await import("../../packages/broker/src/core/task-flow/key-backfill.js");
    const w = await world(); await w.store.put({ item: { ...w.meta, ...fields } });
    const report = await backfillWorkspaceKeysPage(w.deps, { limit: 25 });
    expect(report.moved).toBe(0);
    expect(report.skippedForeign).toBe("companyId" in fields ? 1 : 0);
    expect(report.skippedActive).toBe("companyId" in fields ? 0 : 1);
    expect(await w.store.get(workspaceKey(companyId, w.meta.id))).toBeUndefined();
  });
  it("2000-row workspace progresses in pages bounded to 500 total row operations", async () => {
    const { backfillWorkspaceKeysPage } = await import("../../packages/broker/src/core/task-flow/key-backfill.js");
    const w = await world();
    for (let i = 0; i < 2000; i++) await w.store.put({ item: { pk: w.meta.pk, sk: `ROW#${String(i).padStart(5, "0")}`, value: i } });
    const get = vi.spyOn(w.store, "get"), put = vi.spyOn(w.store, "put"), del = vi.spyOn(w.store, "delete"), query = vi.spyOn(w.store, "query");
    const report = await backfillWorkspaceKeysPage(w.deps, { limit: 25 });
    expect(report.more).toBe(true); expect(report.continuation).toBeDefined();
    const queried = (await Promise.all(query.mock.results.map((result) => result.value as Promise<{ items: StoredDocument[] }>))).reduce((n, page) => n + page.items.length, 0);
    expect(get.mock.calls.length + put.mock.calls.length + del.mock.calls.length + queried).toBeLessThanOrEqual(500);
    expect(await locateWorkspace(w.deps, w.meta.id)).toMatchObject({ scope: "legacy" });
    let next = report.continuation; let moved = 0;
    for (let page = 0; page < 160 && next !== undefined; page++) {
      const result = await backfillWorkspaceKeysPage(w.deps, { limit: 25, continuation: next });
      expect(result.failed).toBe(0); moved += result.moved; next = result.continuation;
    }
    expect(next).toBeUndefined(); expect(moved).toBe(1);
    expect((await w.store.query({ pk: w.meta.pk })).items).toEqual([]);
    const copied = await queryAll(w.store, { pk: workspaceKey(companyId, w.meta.id).pk });
    expect(copied.filter((row) => row.sk.startsWith("ROW#"))).toHaveLength(2000);
  });
});

it.each(["after copy", "after META", "mid delete"])("resumes a crash %s without loss", async (step) => {
  const { backfillWorkspaceKeysPage } = await import("../../packages/broker/src/core/task-flow/key-backfill.js");
  const w = await world();
  const original = (await w.store.query({ pk: w.meta.pk })).items;
  let armed = true;
  const put = w.store.put.bind(w.store), del = w.store.delete.bind(w.store), transact = w.store.transact.bind(w.store);
  vi.spyOn(w.store, "put").mockImplementation(async (request) => {
    const result = await put(request);
    if (armed && request.item.pk === workspaceKey(companyId, w.meta.id).pk && ((step === "after copy" && request.item.sk !== "META") || (step === "after META" && request.item.sk === "META"))) {
      armed = false; w.fake.failNext("GetItem", () => new Error("injected storage interruption"));
    }
    return result;
  });
  vi.spyOn(w.store, "transact").mockImplementation(async (items) => {
    const result = await transact(items);
    if (armed && step === "after META" && items.some((item) => item.kind === "put" && item.item.sk === "META")) {
      armed = false; w.fake.failNext("GetItem", () => new Error("injected storage interruption"));
    }
    return result;
  });
  vi.spyOn(w.store, "delete").mockImplementation(async (request) => {
    const result = await del(request);
    if (armed && step === "mid delete" && request.key.sk !== "META") { armed = false; w.fake.failNext("GetItem", () => new Error("injected storage interruption")); }
    return result;
  });
  let continuation: string | undefined, failures = 0;
  for (let page = 0; page < 30; page++) {
    const report = await backfillWorkspaceKeysPage(w.deps, { limit: 25, ...(continuation === undefined ? {} : { continuation }) });
    failures += report.failed; continuation = report.continuation; if (!report.more) break;
  }
  expect(armed).toBe(false); expect(failures).toBeGreaterThan(0); expect(continuation).toBeUndefined();
  const scoped = workspaceKey(companyId, w.meta.id);
  expect((await w.store.query({ pk: scoped.pk })).items).toEqual(original.map((row) => ({ ...row, pk: scoped.pk })));
  expect((await w.store.query({ pk: w.meta.pk })).items).toEqual([]);
});
it("conflicting scoped content is never overwritten or deleted", async () => {
  const { backfillWorkspaceKeysPage } = await import("../../packages/broker/src/core/task-flow/key-backfill.js");
  const w = await world(), key = workspaceKey(companyId, w.meta.id);
  const source = (await w.store.query({ pk: w.meta.pk })).items.find((row) => row.sk !== "META")!;
  await w.store.put({ item: { ...source, pk: key.pk, conflict: true } });
  const result = await backfillWorkspaceKeysPage(w.deps, { limit: 25 });
  expect(result.failed).toBe(1); expect(result.moved).toBe(0);
  expect(await w.store.get({ pk: key.pk, sk: source.sk })).toMatchObject({ conflict: true });
  expect(await w.store.get(w.meta)).toBeDefined(); expect(await w.store.get(key)).toBeUndefined();
});
it("readers select legacy before META and company after META, never partial destination rows", async () => {
  const { backfillWorkspaceKeysPage } = await import("../../packages/broker/src/core/task-flow/key-backfill.js");
  const w = await world(); const put = w.store.put.bind(w.store), transact = w.store.transact.bind(w.store); const seen: string[] = [];
  vi.spyOn(w.store, "put").mockImplementation(async (request) => {
    seen.push((await locateWorkspace(w.deps, w.meta.id))!.scope);
    const result = await put(request);
    seen.push((await locateWorkspace(w.deps, w.meta.id))!.scope);
    return result;
  });
  vi.spyOn(w.store, "transact").mockImplementation(async (items) => {
    seen.push((await locateWorkspace(w.deps, w.meta.id))!.scope);
    const result = await transact(items);
    seen.push((await locateWorkspace(w.deps, w.meta.id))!.scope);
    return result;
  });
  await backfillWorkspaceKeysPage(w.deps, { limit: 25 });
  expect(seen.at(0)).toBe("legacy"); expect(seen.at(-1)).toBe("company");
  const switched = seen.indexOf("company"); expect(seen.slice(switched).every((scope) => scope === "company")).toBe(true);
});
it("caps workspaces, time, invalid requests and tampered signed continuations", async () => {
  const { backfillWorkspaceKeysPage } = await import("../../packages/broker/src/core/task-flow/key-backfill.js");
  const w = await world(); let clock = w.deps.now();
  const report = await backfillWorkspaceKeysPage({ ...w.deps, now: () => clock += 1000 }, { limit: 25 });
  expect(report.more).toBe(true); expect(report.scanned).toBeLessThanOrEqual(1);
  await expect(backfillWorkspaceKeysPage(w.deps, { limit: 26 })).rejects.toThrow("invalid backfill request");
  await expect(backfillWorkspaceKeysPage({ ...w.deps, companyId: "org_bbbbbbbbbbbbbbbbbbbb" }, { limit: 1 })).rejects.toThrow("invalid backfill request");
  await expect(backfillWorkspaceKeysPage(w.deps, { limit: 1, continuation: `${report.continuation}x` })).rejects.toThrow("invalid backfill continuation");
  const [body, signature] = report.continuation!.split(".");
  const forgedState = { ...JSON.parse(Buffer.from(body!, "base64url").toString("utf8")) as Record<string, unknown>, catalogAfter: "PROJECT#changed" };
  const forged = `${Buffer.from(JSON.stringify(forgedState)).toString("base64url")}.${signature}`;
  await expect(backfillWorkspaceKeysPage(w.deps, { limit: 1, continuation: forged })).rejects.toThrow("invalid backfill continuation");
  for (let i = 0; i < 30; i++) await w.store.put({ item: { ...w.meta, pk: `WORKSPACE#bounded-${i}`, id: `bounded-${i}` } });
  expect((await backfillWorkspaceKeysPage(w.deps, { limit: 25, dryRun: true })).scanned).toBe(25);
});
it("does not publish scoped META when the legacy workspace reopens at cutover", async () => {
  const { backfillWorkspaceKeysPage } = await import("../../packages/broker/src/core/task-flow/key-backfill.js");
  const w = await world(); const scoped = workspaceKey(companyId, w.meta.id);
  const put = w.store.put.bind(w.store), transact = w.store.transact.bind(w.store);
  let reopened = false;
  const reopen = async () => { if (!reopened) { reopened = true; await put({ item: { ...w.meta, status: "READY", updatedAt: new Date(w.deps.now()).toISOString() } }); } };
  vi.spyOn(w.store, "put").mockImplementation(async (request) => {
    if (request.item.pk === scoped.pk && request.item.sk === "META") await reopen();
    return put(request);
  });
  vi.spyOn(w.store, "transact").mockImplementation(async (items) => {
    if (items.some((item) => item.kind === "put" && item.item.pk === scoped.pk && item.item.sk === "META")) await reopen();
    return transact(items);
  });
  const report = await backfillWorkspaceKeysPage(w.deps, { limit: 25 });
  expect(reopened).toBe(true); expect(report.moved).toBe(0);
  expect(await w.store.get(scoped)).toBeUndefined(); expect(await w.store.get(w.meta)).toMatchObject({ status: "READY" });
});
it("when.absent prevents overwriting a destination inserted between read and copy", async () => {
  const { backfillWorkspaceKeysPage } = await import("../../packages/broker/src/core/task-flow/key-backfill.js");
  const w = await world(), put = w.store.put.bind(w.store); let collision: StoredDocument | undefined;
  vi.spyOn(w.store, "put").mockImplementation(async (request) => {
    if (collision === undefined && request.item.pk === workspaceKey(companyId, w.meta.id).pk && request.item.sk !== "META") {
      collision = { ...request.item, conflict: "racing writer" }; await put({ item: collision });
    }
    return put(request);
  });
  const report = await backfillWorkspaceKeysPage(w.deps, { limit: 25 });
  expect(collision).toBeDefined(); expect(report.failed).toBe(1); expect(report.moved).toBe(0);
  expect(await w.store.get(collision!)).toEqual(collision);
});
it("counts already scoped workspaces toward the 25-workspace page bound", async () => {
  const { backfillWorkspaceKeysPage } = await import("../../packages/broker/src/core/task-flow/key-backfill.js");
  const w = await world();
  for (let i = 0; i < 40; i++) await w.store.put({ item: { ...w.meta, ...workspaceKey(companyId, `scoped-${i}`), id: `scoped-${i}` } });
  const query = vi.spyOn(w.store, "queryIndex");
  const result = await backfillWorkspaceKeysPage(w.deps, { limit: 25, dryRun: true });
  expect(query.mock.calls.length).toBeLessThanOrEqual(25); expect(result.more).toBe(true);
});
it("bounds total bytes including repeated META reads on large rows", async () => {
  const { backfillWorkspaceKeysPage } = await import("../../packages/broker/src/core/task-flow/key-backfill.js");
  const w = await world(); const padding = "x".repeat(350_000);
  await w.store.put({ item: { ...w.meta, padding } });
  for (let i = 0; i < 40; i++) await w.store.put({ item: { pk: w.meta.pk, sk: `BIG#${i.toString().padStart(4, "0")}`, padding } });
  let bytes = 0;
  const get = w.store.get.bind(w.store), query = w.store.query.bind(w.store), index = w.store.queryIndex.bind(w.store);
  vi.spyOn(w.store, "get").mockImplementation(async (key) => { const row = await get(key); if (row !== undefined) bytes += Buffer.byteLength(JSON.stringify(row)); return row; });
  vi.spyOn(w.store, "query").mockImplementation(async (request) => { const result = await query(request); for (const row of result.items) bytes += Buffer.byteLength(JSON.stringify(row)); return result; });
  vi.spyOn(w.store, "queryIndex").mockImplementation(async (request) => { const result = await index(request); for (const row of result.items) bytes += Buffer.byteLength(JSON.stringify(row)); return result; });
  const result = await backfillWorkspaceKeysPage(w.deps, { limit: 25 });
  expect(result.more).toBe(true); expect(bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
});
it("returns a bounded checkpoint when a store read never answers and starts no late work", async () => {
  const { backfillWorkspaceKeysPage } = await import("../../packages/broker/src/core/task-flow/key-backfill.js");
  const w = await world(); let release!: (value: { items: StoredDocument[] }) => void;
  const query = vi.spyOn(w.store, "query").mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  vi.useFakeTimers();
  let answer: Awaited<ReturnType<typeof backfillWorkspaceKeysPage>> | undefined;
  const pending = backfillWorkspaceKeysPage(w.deps, { limit: 25 }).then(value => { answer = value; return value; });
  try {
    await vi.advanceTimersByTimeAsync(5_001);
    expect(answer).toMatchObject({ more: true });
    const calls = query.mock.calls.length;
    release({ items: [] }); await pending; await Promise.resolve();
    expect(query.mock.calls).toHaveLength(calls);
  } finally { release({ items: [] }); await pending; vi.useRealTimers(); }
});
it("an uncertain timed-out copy can finish late and resume without extra writers", async () => {
  const { backfillWorkspaceKeysPage } = await import("../../packages/broker/src/core/task-flow/key-backfill.js");
  const w = await world(), put = w.store.put.bind(w.store);
  let release!: () => void; let late: Promise<unknown> | undefined; let gated = false;
  const writes = vi.spyOn(w.store, "put").mockImplementation((request) => {
    if (!gated && request.item.pk === workspaceKey(companyId, w.meta.id).pk) {
      gated = true;
      const pending = new Promise<void>(resolve => { release = resolve; }).then(() => put(request));
      late = pending; return pending;
    }
    return put(request);
  });
  vi.useFakeTimers();
  let answer: Awaited<ReturnType<typeof backfillWorkspaceKeysPage>> | undefined;
  const pending = backfillWorkspaceKeysPage(w.deps, { limit: 25 }).then(value => { answer = value; return value; });
  try {
    await vi.advanceTimersByTimeAsync(5_001);
    expect(answer).toMatchObject({ more: true });
    const count = writes.mock.calls.length; release(); await late; await pending;
    expect(writes.mock.calls).toHaveLength(count);
  } finally { release?.(); await late; await pending; vi.useRealTimers(); }
  let continuation = answer!.continuation;
  for (let page = 0; page < 30 && continuation !== undefined; page++) {
    const result = await backfillWorkspaceKeysPage(w.deps, { limit: 25, continuation });
    expect(result.failed).toBe(0); continuation = result.continuation;
  }
  expect(continuation).toBeUndefined();
  expect((await w.store.query({ pk: w.meta.pk })).items).toEqual([]);
  expect(await locateWorkspace(w.deps, w.meta.id)).toMatchObject({ scope: "company" });
});
it.each(["content", "count"])("verifies the destination %s before publishing META or deleting legacy", async (kind) => {
  const { backfillWorkspaceKeysPage } = await import("../../packages/broker/src/core/task-flow/key-backfill.js");
  const w = await world(); const original = (await w.store.query({ pk: w.meta.pk })).items;
  const scoped = workspaceKey(companyId, w.meta.id), query = w.store.query.bind(w.store);
  const source = original.find(row => row.sk !== "META")!; let corrupted = false;
  vi.spyOn(w.store, "query").mockImplementation(async request => {
    if (!corrupted && request.pk === scoped.pk) {
      corrupted = true;
      await w.store.put({ item: { ...source, pk: scoped.pk, ...(kind === "content" ? { changed: true } : { sk: "EXTRA#unexpected" }) } });
    }
    return query(request);
  });
  const report = await backfillWorkspaceKeysPage(w.deps, { limit: 25 });
  expect(corrupted).toBe(true); expect(report.failed).toBe(1); expect(report.moved).toBe(0);
  expect(await w.store.get(scoped)).toBeUndefined();
  expect((await query({ pk: w.meta.pk })).items).toEqual(original);
});

it("retries the indexed workspace after its first META read fails", async () => {
  const { backfillWorkspaceKeysPage } = await import("../../packages/broker/src/core/task-flow/key-backfill.js");
  const w = await world();
  w.fake.failNext("GetItem", () => new Error("injected metadata interruption"));
  const failed = await backfillWorkspaceKeysPage(w.deps, { limit: 25 });
  expect(failed.failed).toBe(1); expect(failed.more).toBe(true);
  let continuation = failed.continuation; let moved = 0;
  for (let page = 0; page < 30 && continuation !== undefined; page++) {
    const report = await backfillWorkspaceKeysPage(w.deps, { limit: 25, continuation });
    expect(report.failed).toBe(0); moved += report.moved; continuation = report.continuation;
  }
  expect(continuation).toBeUndefined(); expect(moved).toBe(1);
  expect(await locateWorkspace(w.deps, w.meta.id)).toMatchObject({ scope: "company" });
  expect((await w.store.query({ pk: w.meta.pk })).items).toEqual([]);
});

it("backfill omits discovery pointers from candidates even with stale legacy workspace fields", async () => {
  const { backfillWorkspaceKeysPage } = await import("../../packages/broker/src/core/task-flow/key-backfill.js");
  const w = await world();
  await w.store.put({ item: { ...w.meta, entityType: "WORKSPACE_COMPANY_POINTER" } });
  const before = (await w.store.query({ pk: w.meta.pk })).items;
  const report = await backfillWorkspaceKeysPage(w.deps, { limit: 25 });
  expect(report).toMatchObject({ moved: 0, skippedActive: 0, failed: 0 });
  expect(await w.store.get(workspaceKey(companyId, w.meta.id))).toBeUndefined();
  expect((await w.store.query({ pk: w.meta.pk })).items).toEqual(before);
});
