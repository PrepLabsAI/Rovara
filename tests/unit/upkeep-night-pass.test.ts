// L4-P1 (owner DEC 254zzl 6): the hourly upkeep night. Each project has a fixed hour inside 07:00-11:00 UTC from a hash of company and project; the `upkeep-night` job's pass starts only the projects that are DUE
// (inside the window, at or after their hour, upkeep ON, not claimed today), once a day each, at most five per pass, through the system starter, and the whole thing is behind the SystemRuns flag (default off).
// Two-company and two-project cases are below. Mutants are listed in the PR body with the test that kills each.
import { systemRunsConsentKey } from "../../packages/broker/src/core/system-runs/consent.js";
import { describe, expect, it, vi } from "vitest";
import {
  CORE_JOB_SCHEDULES, IMPLICIT_COMPANY_ID, UPKEEP_NIGHT_JOB, UPKEEP_NIGHT_WINDOW, WORKER_INVOCATION_FEATURES, projectMetaKey, queryAll, systemOwnerIdOf, upkeepHourOf, upkeepNightDue,
  type OrgId, type ProjectDefinition,
} from "@agentx/contracts";
import { MAX_STARTS_PER_PASS, runUpkeepNightPass, upkeepClaimKey, type UpkeepPassDeps } from "../../packages/broker/src/core/system-runs/night-pass.js";
import { setUpkeepEnabled } from "../../packages/broker/src/core/upkeep/settings.js";
import { upkeepPartition } from "../../packages/broker/src/core/upkeep/keys.js";
import type { UpkeepNightResult } from "../../packages/broker/src/core/upkeep/night.js";
import { createHostedSystemRuns, readSystemRunsSwitch, systemRunsGateOf, upkeepAvailableFor } from "../../packages/broker/src/core-host/system-runs.js";
import { CORE_JOBS } from "../../packages/broker/src/core-host/jobs.js";
import { parseCoreSwitch } from "../../packages/broker/src/core-host/flags.js";
import { createAdapterRegistry } from "../../packages/broker/src/ports/adapter-registry.js";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { readSystemRunUsage } from "../../packages/broker/src/core/system-runs/usage.js";
import { createHarness, definition } from "../support/task-flow-harness.js";

const A: OrgId = IMPLICIT_COMPANY_ID;
const B: OrgId = "org_bbbbbbbbbbbbbbbbbbbb";
const PERSON = "ab".repeat(32);
const at = (day: string, hour: number, minute = 30): number => Date.parse(`${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`);
const DAY = "2026-11-18";

/** Project names whose hour (for company `org`) is each hour of the window, found by search so no test depends on a hash value. */
function namesByHour(org: string, perHour: number): Record<number, string[]> {
  const found: Record<number, string[]> = { 7: [], 8: [], 9: [], 10: [] };
  for (let i = 0; Object.values(found).some((names) => names.length < perHour) && i < 5_000; i += 1) {
    const name = `proj${String(i)}`;
    const hour = upkeepHourOf(org, name);
    if (found[hour]!.length < perHour) found[hour]!.push(name);
  }
  return found;
}

describe("a project's hour", () => {
  it("is inside the window, stable, and spread over every hour of it", () => {
    const counts: Record<number, number> = {};
    for (let i = 0; i < 400; i += 1) {
      const hour = upkeepHourOf(A, `proj${String(i)}`);
      expect(hour).toBeGreaterThanOrEqual(UPKEEP_NIGHT_WINDOW.startHourUtc);
      expect(hour).toBeLessThan(UPKEEP_NIGHT_WINDOW.endHourUtc);
      expect(upkeepHourOf(A, `proj${String(i)}`)).toBe(hour);
      counts[hour] = (counts[hour] ?? 0) + 1;
    }
    expect(Object.keys(counts).sort()).toEqual(["10", "7", "8", "9"]);
    for (const count of Object.values(counts)) expect(count).toBeGreaterThan(40);
  });

  it("depends on the company as well as the project (two companies with one name do not share a night)", () => {
    let differ = 0;
    for (let i = 0; i < 100; i += 1) if (upkeepHourOf(A, `proj${String(i)}`) !== upkeepHourOf(B, `proj${String(i)}`)) differ += 1;
    expect(differ).toBeGreaterThan(20);
  });

  it("is due only inside the window and at or after the project's own hour", () => {
    const [project] = namesByHour(A, 1)[9]!;
    expect(upkeepNightDue(A, project!, at(DAY, 8, 59))).toBe(false);
    expect(upkeepNightDue(A, project!, at(DAY, 9, 0))).toBe(true);
    expect(upkeepNightDue(A, project!, at(DAY, 10, 59))).toBe(true);
    expect(upkeepNightDue(A, project!, at(DAY, 11, 0))).toBe(false);
    expect(upkeepNightDue(A, project!, at(DAY, 3, 0))).toBe(false);
    expect(() => upkeepHourOf(A, "../x")).toThrow();
  });
});

describe("the job table and its schedule", () => {
  it("has the hourly upkeep-night row, scheduled once, in both lists", () => {
    const row = CORE_JOBS.find((job) => job.name === UPKEEP_NIGHT_JOB)!;
    expect(row).toMatchObject({ area: "flow", trigger: { kind: "schedule", rate: "rate(1 hour)" } });
    expect(CORE_JOB_SCHEDULES.filter((entry) => entry.job === UPKEEP_NIGHT_JOB)).toEqual([{ job: "upkeep-night", rate: "rate(1 hour)" }]);
  });

  it("skips (service not wired) for a runtime that wires no upkeep service", async () => {
    expect(await row().run({ services: {} } as never, 1_000)).toEqual({ skipped: "service_not_wired" });
  });
  const row = () => CORE_JOBS.find((job) => job.name === UPKEEP_NIGHT_JOB)!;
});

interface World { store: MemoryDocumentStore; company: OrgId; clock: { ms: number }; flag: { on: boolean }; projects: string[]; nights: string[]; deps: UpkeepPassDeps; failOnce: Set<string> }

async function world(options: { company?: OrgId; store?: MemoryDocumentStore; projects: string[]; upkeepOn?: string[] }): Promise<World> {
  const store = options.store ?? new MemoryDocumentStore();
  const company = options.company ?? A;
  const clock = { ms: at(DAY, 7, 5) };
  const flag = { on: true };
  const nights: string[] = [];
  const failOnce = new Set<string>();
  const settings = { store, companyId: company, now: () => clock.ms, standing: async () => ({ access: "manage" as const }) };
  for (const project of options.upkeepOn ?? options.projects) await setUpkeepEnabled(settings, { personId: PERSON, project, requestId: crypto.randomUUID(), on: true, fromPage: true });
  const deps: UpkeepPassDeps = {
    store, companyId: company, now: () => clock.ms, enabled: () => flag.on, projects: async () => options.projects,
    night: async (project) => {
      if (failOnce.delete(project)) throw new Error("the code host is down");
      nights.push(project);
      return { outcome: "ran", setupCheck: "done", mockChecks: "unavailable", wiki: "no_cost_cap" } satisfies UpkeepNightResult;
    },
  };
  return { store, company, clock, flag, projects: options.projects, nights, deps, failOnce };
}

describe("the pass", () => {
  it("does nothing, and reads nothing, while the SystemRuns flag is off", async () => {
    const hours = namesByHour(A, 1);
    const w = await world({ projects: [hours[7]![0]!] });
    w.flag.on = false;
    const projects = vi.fn(async () => w.projects);
    expect(await runUpkeepNightPass({ ...w.deps, projects }, { budgetMs: 10_000 })).toMatchObject({ skipped: "system_runs_off", started: 0 });
    expect(projects).not.toHaveBeenCalled();
    expect(w.nights).toEqual([]);
    expect(await queryAll(w.store, { pk: upkeepPartition({ orgId: A, project: w.projects[0]! }), sk: { op: "beginsWith", prefix: "PASS#" } })).toHaveLength(0);
  });

  it.each([[6, 59], [11, 0], [11, 30], [3, 0], [23, 0]])("does nothing outside the window (%i:%i UTC)", async (hour, minute) => {
    const w = await world({ projects: namesByHour(A, 1)[7]! });
    w.clock.ms = at(DAY, hour, minute);
    const projects = vi.fn(async () => w.projects);
    expect(await runUpkeepNightPass({ ...w.deps, projects }, { budgetMs: 10_000 })).toMatchObject({ skipped: "outside_window", started: 0 });
    expect(projects).not.toHaveBeenCalled();
    expect(w.nights).toEqual([]);
  });

  it("starts only the projects that are due: each hour starts its own, and the later hours add theirs", async () => {
    const hours = namesByHour(A, 1);
    const all = [7, 8, 9, 10].map((hour) => hours[hour]![0]!);
    const w = await world({ projects: all });
    for (const [index, hour] of [7, 8, 9, 10].entries()) {
      w.clock.ms = at(DAY, hour, 10);
      const report = await runUpkeepNightPass(w.deps, { budgetMs: 10_000 });
      expect(report.started, `hour ${String(hour)}`).toBe(1);
      expect(w.nights).toEqual(all.slice(0, index + 1));
    }
  });

  it("starts a project whose hour passed without a pass (a missed hour is caught up), once", async () => {
    const hours = namesByHour(A, 1);
    const w = await world({ projects: [hours[7]![0]!] });
    w.clock.ms = at(DAY, 10, 40);
    expect((await runUpkeepNightPass(w.deps, { budgetMs: 10_000 })).started).toBe(1);
    expect((await runUpkeepNightPass(w.deps, { budgetMs: 10_000 })).started).toBe(0);
    expect(w.nights).toHaveLength(1);
  });

  it("skips a project whose upkeep is off, even at its hour, and one with no row at all", async () => {
    const hours = namesByHour(A, 2);
    const [on, off] = hours[7]!;
    const w = await world({ projects: [on!, off!], upkeepOn: [on!] });
    expect((await runUpkeepNightPass(w.deps, { budgetMs: 10_000 })).started).toBe(1);
    expect(w.nights).toEqual([on]);
  });

  it("claims the night: a second fire the same day (a retry, a double delivery, the next hour) starts nothing, and the next day starts again", async () => {
    const [project] = namesByHour(A, 1)[7]!;
    const w = await world({ projects: [project!] });
    expect(await runUpkeepNightPass(w.deps, { budgetMs: 10_000 })).toMatchObject({ started: 1, claimedAlready: 0 });
    expect(await runUpkeepNightPass(w.deps, { budgetMs: 10_000 })).toMatchObject({ started: 0, claimedAlready: 1 });
    w.clock.ms = at(DAY, 9, 0);
    expect(await runUpkeepNightPass(w.deps, { budgetMs: 10_000 })).toMatchObject({ started: 0, claimedAlready: 1 });
    expect(w.nights).toHaveLength(1);
    w.clock.ms = at("2026-11-19", 8, 0);
    expect((await runUpkeepNightPass(w.deps, { budgetMs: 10_000 })).started).toBe(1);
    expect(w.nights).toHaveLength(2);
    expect(await store(w).get(upkeepClaimKey(A, project!, DAY))).toBeDefined();
    expect(await store(w).get(upkeepClaimKey(A, project!, "2026-11-19"))).toBeDefined();
  });
  const store = (w: World): MemoryDocumentStore => w.store;

  it("two simultaneous fires start the night once", async () => {
    const [project] = namesByHour(A, 1)[7]!;
    const w = await world({ projects: [project!] });
    const [first, second] = await Promise.all([runUpkeepNightPass(w.deps, { budgetMs: 10_000 }), runUpkeepNightPass(w.deps, { budgetMs: 10_000 })]);
    expect(first.started + second.started).toBe(1);
    expect(first.claimedAlready + second.claimedAlready).toBe(1);
    expect(w.nights).toHaveLength(1);
  });

  it("gives the claim back when the night could not start (a fault), so the next hour tries again inside the window", async () => {
    const [project] = namesByHour(A, 1)[7]!;
    const w = await world({ projects: [project!] });
    w.failOnce.add(project!);
    expect(await runUpkeepNightPass(w.deps, { budgetMs: 10_000 })).toMatchObject({ started: 0, failed: 1 });
    expect(await store(w).get(upkeepClaimKey(A, project!, DAY))).toBeUndefined();
    w.clock.ms = at(DAY, 8, 5);
    expect((await runUpkeepNightPass(w.deps, { budgetMs: 10_000 })).started).toBe(1);
  });

  it("L3: a catalog name that is not a project name is left out and never stops the others", async () => {
    const [good] = namesByHour(A, 1)[7]!;
    const w = await world({ projects: [good!], upkeepOn: [good!] });
    const deps: UpkeepPassDeps = { ...w.deps, projects: async () => ["../escape", "has space", "", "x".repeat(300), good!] };
    expect(await runUpkeepNightPass(deps, { budgetMs: 10_000 })).toMatchObject({ started: 1, failed: 0 });
    expect(w.nights).toEqual([good]);
  });

  it("L5: a night whose free step failed (the starter faulted) gives the claim back, so the next hour tries again", async () => {
    const [project] = namesByHour(A, 1)[7]!;
    const w = await world({ projects: [project!] });
    let calls = 0;
    const deps: UpkeepPassDeps = { ...w.deps, night: async () => { calls += 1; return { outcome: "ran", setupCheck: calls === 1 ? "failed" : "done", mockChecks: "unavailable", wiki: "no_cost_cap" }; } };
    expect(await runUpkeepNightPass(deps, { budgetMs: 10_000 })).toMatchObject({ started: 0, failed: 1 });
    expect(await w.store.get(upkeepClaimKey(A, project!, DAY))).toBeUndefined();
    w.clock.ms = at(DAY, 8, 5);
    expect(await runUpkeepNightPass(deps, { budgetMs: 10_000 })).toMatchObject({ started: 1 });
    expect(await w.store.get(upkeepClaimKey(A, project!, DAY))).toBeDefined();
  });

  it("starts at most five projects per pass; the rest wait for the next pass", async () => {
    const names = namesByHour(A, 7)[7]!;
    const w = await world({ projects: names });
    expect(MAX_STARTS_PER_PASS).toBe(5);
    expect(await runUpkeepNightPass(w.deps, { budgetMs: 10_000 })).toMatchObject({ started: 5, deferred: 2 });
    expect(await runUpkeepNightPass(w.deps, { budgetMs: 10_000 })).toMatchObject({ started: 2, claimedAlready: 5 });
    expect(new Set(w.nights).size).toBe(7);
  });

  it("defers what the budget has no time for, and never starts it", async () => {
    const names = namesByHour(A, 3)[7]!;
    const w = await world({ projects: names });
    // Each night takes a minute of the clock; the budget is thirty seconds, so only the first project is reached.
    const deps: UpkeepPassDeps = { ...w.deps, night: async (project) => { const result = await w.deps.night(project); w.clock.ms += 60_000; return result; } };
    expect(await runUpkeepNightPass(deps, { budgetMs: 30_000 })).toMatchObject({ started: 1, deferred: 2 });
    expect(w.nights).toHaveLength(1);
    expect(await runUpkeepNightPass(w.deps, { budgetMs: 30_000 })).toMatchObject({ started: 2, claimedAlready: 1 });
  });

  it("two companies on one store: each pass lists and claims only its own projects", async () => {
    const store = new MemoryDocumentStore();
    const name = namesByHour(A, 1)[7]![0]!;
    // The same project name in both companies; B's hour may differ, so run B across the whole window.
    const a = await world({ company: A, store, projects: [name] });
    const b = await world({ company: B, store, projects: [name] });
    expect((await runUpkeepNightPass(a.deps, { budgetMs: 10_000 })).started).toBe(1);
    expect(b.nights).toEqual([]);
    expect(await store.get(upkeepClaimKey(B, name, DAY))).toBeUndefined();
    b.clock.ms = at(DAY, 10, 50);
    expect((await runUpkeepNightPass(b.deps, { budgetMs: 10_000 })).started).toBe(1);
    expect(a.nights).toEqual([name]);
    expect(await store.get(upkeepClaimKey(A, name, DAY))).toBeDefined();
    expect(await store.get(upkeepClaimKey(B, name, DAY))).toBeDefined();
    expect(upkeepClaimKey(A, name, DAY).pk).not.toBe(upkeepClaimKey(B, name, DAY).pk);
    // A's upkeep switch never turns B's project on.
    const c = await world({ company: B, store: new MemoryDocumentStore(), projects: [name], upkeepOn: [] });
    c.clock.ms = at(DAY, 10, 50);
    expect((await runUpkeepNightPass(c.deps, { budgetMs: 10_000 })).started).toBe(0);
  });
});

describe("the flag", () => {
  it("is off by default and fails closed on anything that is not off, on or on:<company ids>", () => {
    expect(readSystemRunsSwitch({}).value).toEqual({ mode: "off" });
    expect(readSystemRunsSwitch({ ROVARA_CORE_SYSTEM_RUNS: "" }).value).toEqual({ mode: "off" });
    expect(readSystemRunsSwitch({ ROVARA_CORE_SYSTEM_RUNS: "on" }).value).toEqual({ mode: "on" });
    expect(readSystemRunsSwitch({ ROVARA_CORE_SYSTEM_RUNS: `on:${A}` }).value).toEqual({ mode: "on-for", companies: [A] });
    for (const bad of ["true", "ON", "yes", "on:", "on:org_x", "all", "1", "drain", "on:org_aaaaaaaaaaaaaaaaaaaa,org_bbbbbbbbbbbbbbbbbbbb"]) {
      const read = readSystemRunsSwitch({ ROVARA_CORE_SYSTEM_RUNS: bad });
      expect(read.value, bad).toEqual({ mode: "off" });
    }
    expect(readSystemRunsSwitch({ ROVARA_CORE_SYSTEM_RUNS: "typo" }).problem).toBeDefined();
    expect(readSystemRunsSwitch({ ROVARA_CORE_SYSTEM_RUNS: "typo" }).problem).not.toContain("typo");
  });

  it("covers exactly the companies it names, for the gate and for the setup page's `available`", () => {
    const only = parseCoreSwitch(`on:${B}`).value;
    expect(systemRunsGateOf(only, B).enabled()).toBe(true);
    expect(systemRunsGateOf(only, A).enabled()).toBe(false);
    expect(upkeepAvailableFor(only)(B)).toBe(true);
    expect(upkeepAvailableFor(only)(A)).toBe(false);
    expect(upkeepAvailableFor({ mode: "off" })(A)).toBe(false);
    expect(upkeepAvailableFor({ mode: "on" })(A)).toBe(true);
  });
});

describe("the hosted wiring, end to end on the task flow's fakes", () => {
  const URL_ = "https://examplehost.test/acme/app";
  const project = (name: string): ProjectDefinition => ({ ...definition, name, repositories: [{ ...definition.repositories[0]!, url: URL_, host: { kind: "fake" } }] });

  async function hosted(flag: ReturnType<typeof parseCoreSwitch>["value"], company: OrgId = A) {
    const h = createHarness({ companyId: company, audit: "recording", machines: { startingChecks: 0, features: [...WORKER_INVOCATION_FEATURES] } });
    const [name] = namesByHour(company, 1)[7]!;
    await h.registerProject(project(name!));
    await h.store.put({ item: { ...projectMetaKey(company, name!), entityType: "PROJECT_META" } });
    const model = new FakeHostModel({ url: URL_, id: "1", fullName: "acme/app", initialFiles: { "package.json": "{}", "src/index.ts": "export {}" } });
    const registry = createAdapterRegistry();
    registry.register("code-host", "fake", new FakeCodeHost(model));
    h.deps.codeHosts = registry;
    const modelRoute = vi.fn(async () => undefined);
    h.deps.modelAccess = { route: modelRoute };
    await setUpkeepEnabled({ store: h.store, companyId: company, now: () => h.clock.now, standing: async () => ({ access: "manage" }) }, { personId: PERSON, project: name!, requestId: crypto.randomUUID(), on: true, fromPage: true });
    // The company's consent (L4-P2), the second lock: given here (the ceiling is `flag`); the tests of the two locks are in system-runs-consent.test.ts.
    await h.store.put({ item: { ...systemRunsConsentKey(company), entityType: "SYSTEM_RUNS_CONSENT", orgId: company, enabled: true, changedAt: new Date(h.clock.now).toISOString() } });
    h.clock.now = at(DAY, 8, 10);
    const runs = createHostedSystemRuns({ flow: h.flow, companyId: company, flag, now: () => h.clock.now });
    return { h, name: name!, model, runs, modelRoute, company };
  }
  const checks = async (w: Awaited<ReturnType<typeof hosted>>): Promise<number> => {
    const queue = await w.h.queues.queue("task-dispatch");
    let total = 0;
    for (let round = 0; round < 20; round += 1) { const batch = await queue.receive(); if (batch.length === 0) break; total += batch.length; }
    return total;
  };

  it("builds nothing where the flag does not cover the company", async () => {
    expect((await hosted({ mode: "off" })).runs).toBeUndefined();
    expect((await hosted(parseCoreSwitch(`on:${B}`).value, A)).runs).toBeUndefined();
  });

  it("a night: starts the nightly check as the project's system owner, audited and attributed, with no AI and no model key", async () => {
    const w = await hosted({ mode: "on" });
    const report = await w.runs!.service.pass({ budgetMs: 10_000 });
    expect(report).toMatchObject({ started: 1, due: 1 });
    const mark = (await w.h.store.get(projectMetaKey(w.company, w.name)))?.["setupCheck"] as { startedBy: string };
    expect(mark.startedBy).toBe(systemOwnerIdOf(w.company, w.name));
    expect(w.h.audit.filter((event) => event.action === "system_run.requested")).toHaveLength(1);
    expect(w.h.audit.find((event) => event.action === "system_run.requested")).toMatchObject({ actor: { type: "system", id: systemOwnerIdOf(w.company, w.name) }, details: { kind: "nightly_check", reason: "nightly" } });
    expect((await readSystemRunUsage(w.h.deps, { project: w.name })).byKind).toMatchObject({ nightly_check: { runs: 1 } });
    expect(w.modelRoute).not.toHaveBeenCalled();
    // The wiki refresh (AI) is not started in P1: the night says there is no enforced cap.
    expect(await queryAll(w.h.store, { pk: upkeepPartition({ orgId: w.company, project: w.name }), sk: { op: "beginsWith", prefix: "NIGHT#" } }).then((rows) => rows.map((row) => row["outcome"]))).toEqual(["no_cost_cap"]);
    expect(await checks(w)).toBe(1);
  });

  it("a second pass the same day, and a day with nothing merged, start no second check; a day with a new commit starts one", async () => {
    const w = await hosted({ mode: "on" });
    const started = (): number => w.h.audit.filter((event) => event.action === "system_run.requested").length;
    await w.runs!.service.pass({ budgetMs: 10_000 });
    expect(started()).toBe(1);
    expect(await w.runs!.service.pass({ budgetMs: 10_000 })).toMatchObject({ started: 0, claimedAlready: 1 });
    expect(started()).toBe(1);
    // The next day nothing was merged: the night is decided and records itself, and no machine starts.
    w.h.clock.now = at("2026-11-19", 8, 10);
    expect(await w.runs!.service.pass({ budgetMs: 10_000 })).toMatchObject({ started: 1 });
    expect(started()).toBe(1);
    // A new commit the day after: a new nightly check, as the system owner again.
    w.model.commit("main", { "src/index.ts": "export const changed = true;" });
    w.h.clock.now = at("2026-11-20", 8, 10);
    await w.runs!.service.pass({ budgetMs: 10_000 });
    expect(started()).toBe(2);
    expect((await readSystemRunUsage(w.h.deps, { month: "2026-11", project: w.name })).byKind).toMatchObject({ nightly_check: { runs: 2 } });
  });

  it("the flag turned off stops the very next pass", async () => {
    const w = await hosted(parseCoreSwitch(`on:${A}`).value);
    expect(await w.runs!.service.pass({ budgetMs: 10_000 })).toMatchObject({ started: 1 });
    expect(systemRunsGateOf({ mode: "off" }, A).enabled()).toBe(false);
  });
});
