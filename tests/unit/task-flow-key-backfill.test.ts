import { STATE_TABLE_INDEXES, STATE_TABLE_PLANNED_INDEXES } from "../../packages/aws-adapters/src/dynamodb/state-table.js";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { workspaceCompanyReader } from "../../packages/broker/src/aws/worker-machines/workspace-company.js";
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
  it("copies closed golden rows, verifies, and atomically replaces legacy META with discovery", async () => {
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
    expect((await w.store.query({ pk: w.meta.pk })).items).toEqual([
      { pk: w.meta.pk, sk: "META", entityType: "WORKSPACE_COMPANY_POINTER", workspaceId: w.meta.id, companyId },
    ]);
    expect(puts.mock.calls.filter(([request]) => request.item.pk === scoped.pk).every(([request]) => request.item.sk !== "META")).toBe(true);
    expect(transactions.mock.invocationCallOrder[0]).toBeGreaterThan(Math.max(...puts.mock.invocationCallOrder));
    const verified = queries.mock.calls.flatMap(([request], index) => request.pk === scoped.pk ? [queries.mock.invocationCallOrder[index]!] : []);
    expect(verified.length).toBeGreaterThan(0);
    expect(deletes.mock.invocationCallOrder[0]).toBeGreaterThan(verified[0]!);
    expect(transactions.mock.calls.at(-1)?.[0].some((item) => item.kind === "put" && item.item.sk === "META")).toBe(true);
    expect(deletes.mock.calls.filter(([request]) => request.key.pk === w.meta.pk).every(([request]) => request.key.sk !== "META")).toBe(true);
    const readCompany = workspaceCompanyReader({ send: async (command: unknown) => {
      if (!(command instanceof GetCommand)) throw new Error("unexpected command");
      return { Item: await w.store.get(command.input.Key as { pk: string; sk: string }) };
    } } as never, "state");
    expect(await readCompany(w.meta.id)).toBe(companyId);
    expect(await locateWorkspace(w.deps, w.meta.id)).toMatchObject({ scope: "company" });
    expect((await backfillWorkspaceKeysPage(w.deps, { limit: 25 })).moved).toBe(0);
  });
  it.each([{ status: "CLOSED", activeOperationId: "active" }, { companyId: "org_bbbbbbbbbbbbbbbbbbbb" }])("skips ineligible workspace %j", async (fields) => {
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
    expect((await w.store.query({ pk: w.meta.pk })).items).toEqual([
      { pk: w.meta.pk, sk: "META", entityType: "WORKSPACE_COMPANY_POINTER", workspaceId: w.meta.id, companyId },
    ]);
    const copied = await queryAll(w.store, { pk: workspaceKey(companyId, w.meta.id).pk });
    expect(copied.filter((row) => row.sk.startsWith("ROW#"))).toHaveLength(2000);
  });
});

it.each(["after copy"])("resumes a crash %s without loss", async (step) => {
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
  expect((await w.store.query({ pk: w.meta.pk })).items).toEqual([
      { pk: w.meta.pk, sk: "META", entityType: "WORKSPACE_COMPANY_POINTER", workspaceId: w.meta.id, companyId },
    ]);
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
it.each(["content"])("verifies the destination %s before publishing META or deleting legacy", async (kind) => {
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

