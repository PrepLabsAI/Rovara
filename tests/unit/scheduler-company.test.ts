import { describe, expect, it, vi } from "vitest";
import { IMPLICIT_COMPANY_ID, type ScheduleEntry } from "@agentx/contracts";
import { createFakeScheduler } from "../../packages/broker/src/ports/fake-scheduler.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { handleNightlyFire } from "../../packages/broker/src/core/test-env/nightly.js";
import { nightlyWorld, ORG } from "../support/nightly-world.js";
const A = IMPLICIT_COMPANY_ID, B = `org_${"b".repeat(20)}`;
const entry = (companyId = A): ScheduleEntry => ({ companyId, scheduleId: "shared", when: { kind: "every", minutes: 1 }, enabled: true, target: { kind: "test", ref: {} } });
describe("schedule ownership", () => {
  const build = () => createFakeScheduler();
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
it("fails closed: nightly missing project and resolver failure never read or retry", async () => {
  for (const projectCompany of [async () => undefined, async () => { throw new Error("secret-canary"); }, async () => "bad-canary"]) {
    const h = await nightlyWorld(); const read = vi.spyOn(h.store, "get"); const lines: unknown[] = [];
    expect(await handleNightlyFire({ ...h.deps, projectCompany, companyLog: (line: unknown) => { lines.push(line); } }, h.due())).toEqual({ outcome: "skipped", reason: "environment_missing" });
    expect(read).not.toHaveBeenCalled(); expect(h.started).toEqual([]); expect(JSON.stringify(lines)).not.toContain("canary");
  }
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

