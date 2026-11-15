import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, companyChangeFeed, companyScoped, type DocumentChange, type DueSchedule } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createIntervalScheduler } from "../../packages/local-adapters/src/interval-scheduler.js";
import { SqliteAuditLog } from "../../packages/local-adapters/src/sqlite-audit-log.js";
import { DocumentAuditSink, startAuditCopy } from "../../packages/local-adapters/src/document-audit-sink.js";
import { listWorkEvents, workEventRow } from "../../packages/broker/src/core/work-events/work-events.js";
import { createHarness } from "../support/task-flow-harness.js";
import { operationKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { handleNightlyFire } from "../../packages/broker/src/core/test-env/nightly.js";
import { nightlyWorld } from "../support/nightly-world.js";

const companyId = IMPLICIT_COMPANY_ID;
const at = "2026-11-10T00:00:00.000Z";
function golden(name: string, value: unknown): void {
  const path = new URL(`../fixtures/t8-goldens/${name}.json`, import.meta.url);
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  expect(bytes).toBe(readFileSync(path, "utf8"));
}

describe("T8 byte-identical base goldens", () => {
  it("records ordinary implicit change batches", async () => {
    const store = new MemoryDocumentStore();
    const batches: DocumentChange[][] = [];
    const sub = await companyChangeFeed(store.changes!, companyId).subscribe("golden", async (changes) => { batches.push([...changes]); });
    await store.put({ item: { pk: companyScoped(companyId, "OLD"), sk: "one", value: "scoped" } });
    await store.put({ item: { pk: "OLD", sk: "two", value: "unscoped" } });
    await store.settled();
    await sub.stop();
    golden("changes", batches);
  });
  it("records stored schedule bytes and due fire", async () => {
    const store = new MemoryDocumentStore();
    let now = Date.parse(at);
    const scheduler = createIntervalScheduler({ store, now: () => now, timer: false });
    const due: DueSchedule[] = [];
    scheduler.subscribe(async (item) => { due.push(item); });
    await scheduler.put({ companyId, scheduleId: "golden", when: { kind: "every", minutes: 1 }, enabled: true, target: { kind: "nightly", ref: { project: "golden" } } });
    const stored = await store.get({ pk: companyScoped(companyId, "SCHEDULER"), sk: "SCHEDULE#golden" });
    now += 60_000;
    await scheduler.tick();
    await scheduler.close?.();
    golden("schedule", { stored, due });
  });
  it("records work event row and list", async () => {
    const store = new MemoryDocumentStore();
    const row = workEventRow({ version: 1, id: `wev_${"a".repeat(32)}`, kind: "task_started", orgId: companyId, project: "golden", taskId: "12579b4b-eaa7-4bf2-87bc-6da86b97c9e6", at, actor: { kind: "system" } });
    await store.put({ item: row });
    golden("work-events", { row, result: await listWorkEvents(store, { orgId: companyId, from: at, to: at, now: Date.parse(at) }) });
  });
  it("records the audit events, hashes and head row", async () => {
    const store = new MemoryDocumentStore();
    const log = SqliteAuditLog.open({ path: ":memory:" });
    const sub = await startAuditCopy({ store, log, companyId });
    try {
      await new DocumentAuditSink({ store: () => store }).record({ companyId, eventId: "golden", at, actor: { type: "person", id: "owner" }, action: "task.started", details: { marker: "ordinary" } });
      await store.settled();
      golden("audit", { events: log.read({ companyId }), head: log.head(), row: await store.get({ pk: companyScoped(companyId, "AUDIT_COPY"), sk: "HEAD" }) });
    } finally { await sub?.stop(); log.close(); }
  });
  it("records an old dispatch body and operation unchanged", async () => {
    const h = createHarness();
    const key = operationKey("workspace", "operation");
    const operation = { ...key, id: "operation", workspaceId: "workspace", companyId, status: "SUCCEEDED" };
    await h.store.put({ item: operation });
    await (await h.queues.queue("task-dispatch")).enqueue({ body: { v: 1, workspaceId: "workspace", operationId: "operation" } });
    const report = await h.flow.dispatchOnce();
    const { foreign, ...oldReport } = report;
    expect(foreign).toBe(0);
    golden("dispatch", { report: oldReport, operation: await h.store.get(key) });
  });
  it("records nightly without a resolver", async () => {
    const h = await nightlyWorld();
    golden("nightly", { outcome: await handleNightlyFire(h.deps, h.due()), started: h.started, admitted: h.admitted });
  });
});

import { assertTwoCompanyIsolation } from "../../packages/testing/src/isolation/two-company.js";
import { eventsCompanies } from "../support/ports/events-companies.js";
it("the event surfaces share worlds and keep both companies isolated", async () => { await assertTwoCompanyIsolation(eventsCompanies()); });
