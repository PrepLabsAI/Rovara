import { describe, expect, it, vi } from "vitest";
import { IMPLICIT_COMPANY_ID, companyScoped, type DueSchedule, type JsonValue, type ScheduleEntry } from "@agentx/contracts";
import { createFakeScheduler } from "../../packages/broker/src/ports/fake-scheduler.js";
import { createIntervalScheduler } from "../../packages/local-adapters/src/interval-scheduler.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { handleNightlyFire } from "../../packages/broker/src/core/test-env/nightly.js";
import { handleScheduleFire } from "../../packages/broker/src/core/triggers/schedules.js";
import type { TriggerDispatchDeps } from "../../packages/broker/src/core/triggers/dispatch.js";
import { triggerScheduleId, TRIGGER_SCHEDULE_KIND } from "../../packages/broker/src/core/triggers/schedule-spec.js";
import { nightlyWorld, ORG } from "../support/nightly-world.js";
const A = IMPLICIT_COMPANY_ID, B = `org_${"b".repeat(20)}`;
const entry = (companyId = A): ScheduleEntry => ({ companyId, scheduleId: "shared", when: { kind: "every", minutes: 1 }, enabled: true, target: { kind: "test", ref: {} } });
for (const kind of ["fake", "interval"] as const) describe(`${kind} schedule ownership`, () => {
  const build = () => kind === "fake" ? createFakeScheduler() : createIntervalScheduler({ store: new MemoryDocumentStore(), timer: false });
  it("refuses malformed companies and target company mismatches with fixed text", async () => {
    const scheduler = build();
    for (const companyId of ["", "bad-canary", null, undefined, 3]) await expect(scheduler.put({ ...entry(), companyId } as ScheduleEntry)).rejects.toMatchObject({ code: "refused", message: "invalid schedule company" });
    for (const field of ["orgId", "companyId"]) for (const value of [B, null, "bad-canary"]) await expect(scheduler.put({ ...entry(), target: { kind: "test", ref: { [field]: value } } })).rejects.toMatchObject({ code: "refused", message: "invalid schedule company" });
  });
  it("invalid get/remove do not read or throw; valid companies keep independent schedules", async () => {
    const scheduler = build(); await scheduler.put(entry(A)); await scheduler.put(entry(B));
    expect((await scheduler.get(A, "shared"))?.companyId).toBe(A); expect((await scheduler.get(B, "shared"))?.companyId).toBe(B);
    for (const bad of ["", "bad canary", undefined, null, Symbol("bad"), Object.create(null) as object]) { expect(await scheduler.get(bad as string, "shared")).toBeUndefined(); expect(await scheduler.remove(bad as string, "shared")).toBe(false); }
  });
  it("fails closed: unknown rule and missing target are fixed refusals", async () => {
    const scheduler = build();
    for (const spec of [{ ...entry(), when: { kind: "unknown", minutes: 1 } }, { ...entry(), target: null }, { ...entry(), when: null }]) await expect(scheduler.put(spec as ScheduleEntry)).rejects.toMatchObject({ code: "refused" });
  });
});
it("stored key/entry mismatches never fire or return, and log only the key company", async () => {
  const store = new MemoryDocumentStore(); let now = 0; const lines: unknown[] = [];
  const scheduler = createIntervalScheduler({ store, now: () => now, timer: false, log: (line) => { lines.push(line); } });
  const due: DueSchedule[] = []; scheduler.subscribe(async (d) => { due.push(d); });
  await scheduler.put(entry());
  const key = { pk: companyScoped(A, "SCHEDULER"), sk: "SCHEDULE#shared" };
  const row = (await store.get(key))!;
  for (const changed of [{ ...entry(B) }, { ...entry(), scheduleId: "foreign-canary" }]) {
    await store.put({ item: { ...row, entry: JSON.parse(JSON.stringify(changed)) as JsonValue } }); now += 60_000;
    expect(await scheduler.get(A, "shared")).toBeUndefined(); await scheduler.tick();
  }
  expect(due).toEqual([]); expect(lines.length).toBeGreaterThan(0);
  expect(JSON.stringify(lines)).not.toContain(B); expect(JSON.stringify(lines)).not.toContain("foreign-canary");
  for (const line of lines) expect(line).toEqual({ companyId: A, event: "scheduler.row_invalid" });
  await scheduler.close?.();
});
it("trigger fire compares due, ref and consumer before trigger reads", async () => {
  const triggerId = `ctr_${"a".repeat(20)}`; const get = vi.fn(); const lines: unknown[] = [];
  const deps = { companyId: A, automation: { enabled: async () => true }, triggers: { get }, log: (event: string, fields: unknown) => { lines.push({ event, ...(fields as object) }); } } as unknown as TriggerDispatchDeps;
  await handleScheduleFire(deps, { companyId: B, scheduleId: triggerScheduleId(triggerId), target: { kind: TRIGGER_SCHEDULE_KIND, ref: { orgId: A, triggerId } }, scheduledAt: "2026-11-10T00:00:00.000Z", slotId: "slot", attempt: 1 });
  expect(get).not.toHaveBeenCalled(); expect(lines).toEqual([{ companyId: A, event: "trigger_schedule.fire_other_company" }]);
});
it("nightly resolves stored project company before any environment read and refuses mismatch", async () => {
  const h = await nightlyWorld(); const read = vi.spyOn(h.store, "get"); const lines: unknown[] = [];
  const deps = { ...h.deps, projectCompany: async () => ORG, companyLog: (line: unknown) => { lines.push(line); } };
  expect(await handleNightlyFire(deps, { ...h.due(), companyId: B })).toEqual({ outcome: "skipped", reason: "environment_missing" });
  expect(read).not.toHaveBeenCalled(); expect(h.started).toEqual([]); expect(h.admitted).toEqual([]);
  expect(lines).toEqual([{ companyId: ORG, event: "test_env.nightly_company_refused", scheduleId: "night", count: 1 }]);
});
it("fails closed: nightly missing project and resolver failure never read or retry", async () => {
  for (const projectCompany of [async () => undefined, async () => { throw new Error("secret-canary"); }, async () => "bad-canary"]) {
    const h = await nightlyWorld(); const read = vi.spyOn(h.store, "get"); const lines: unknown[] = [];
    expect(await handleNightlyFire({ ...h.deps, projectCompany, companyLog: (line: unknown) => { lines.push(line); } }, h.due())).toEqual({ outcome: "skipped", reason: "environment_missing" });
    expect(read).not.toHaveBeenCalled(); expect(h.started).toEqual([]); expect(JSON.stringify(lines)).not.toContain("canary");
  }
});
it("nightly accepts a matching stored project company", async () => {
  const h = await nightlyWorld(); expect((await handleNightlyFire({ ...h.deps, projectCompany: async () => ORG }, h.due())).outcome).toBe("started");
});
it("fails closed: hosted nightly requires the project binding", async () => {
  const h = await nightlyWorld(); const read = vi.spyOn(h.store, "get");
  expect(await handleNightlyFire({ ...h.deps, projectCompanyRequired: true }, h.due())).toEqual({ outcome: "skipped", reason: "environment_missing" });
  expect(read).not.toHaveBeenCalled(); expect(h.started).toEqual([]);
});

import { createProjectCompanyResolver } from "../../packages/broker/src/core/test-env/nightly-wiring.js";
it("the project resolver reads the stored company and only absent fields mean implicit", async () => {
  const store = new MemoryDocumentStore();
  const resolver = createProjectCompanyResolver(async (project) => store.get({ pk: "PROJECTS", sk: project }));
  await store.put({ item: { pk: "PROJECTS", sk: "old" } });
  await store.put({ item: { pk: "PROJECTS", sk: "new", companyId: B } });
  await store.put({ item: { pk: "PROJECTS", sk: "bad", companyId: null } });
  expect(await resolver("old")).toBe(A); expect(await resolver("new")).toBe(B); expect(await resolver("bad")).toBeUndefined(); expect(await resolver("missing")).toBeUndefined();
});
it("bound nightly refuses malformed claimed company without a retry or environment read", async () => {
  const h = await nightlyWorld(); const read = vi.spyOn(h.store, "get");
  expect(await handleNightlyFire({ ...h.deps, projectCompany: async () => ORG }, { ...h.due(), companyId: "bad-canary" })).toEqual({ outcome: "skipped", reason: "environment_missing" });
  expect(read).not.toHaveBeenCalled();
});

import { projectPk } from "@agentx/contracts";
import { PROJECT } from "../support/nightly-world.js";
it("a stored project with no company belongs to the implicit company and fires there", async () => {
  const h = await nightlyWorld();
  for (const row of (await h.store.query({ pk: projectPk(ORG, PROJECT) })).items) await h.store.put({ item: { ...row, pk: projectPk(A, PROJECT), orgId: A } });
  await h.store.put({ item: { pk: "PROJECTS", sk: PROJECT } });
  const projectCompany = createProjectCompanyResolver(async (project) => h.store.get({ pk: "PROJECTS", sk: project }));
  expect((await handleNightlyFire({ ...h.deps, projectCompany }, { ...h.due(), companyId: A })).outcome).toBe("started");
  expect(h.started[0]?.orgId).toBe(A);
});
