
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { orgProjectCatalogKey, projectRevisionKey, type JsonValue, type ProjectDefinition } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { createAllowAllAdmission, localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import type { CoreRegistryError} from "../../packages/broker/src/core-host/index.js";
import {
  CORE_JOBS, coreInUseKey, createCoreHostApp, coreTaskMarkKey, ensureCoreInUse, parseCoreSwitch,
  scheduleEventOf, coreTaskMarkFor, coreTaskMarkItem, coreTaskMarkOf, type CoreHostApp, type CoreService, type CoreServiceName,
} from "../../packages/broker/src/core-host/index.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../support/core-host-fakes.js";

const OTHER = "org_corehost00000000000b";
const PROJECT: ProjectDefinition = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};

const ALL_SERVICES = () => ({
  "merge-tracking": { pass: async () => ({ swept: 0 }) }, "session-sweep": { pass: async () => ({ swept: 0 }) },
  "notify-deliver": { pass: async () => ({ sent: 0 }) }, "admission-hold-sweep": { pass: async () => ({ charged: 0 }) },
});

const HONEST_CI = { honest: true as const, ciMode: () => "their_ci_fix" as const };

function appOver(world: FakeWorld, extra: { servedCompanies?: () => Promise<readonly string[]>; services?: () => Partial<Record<CoreServiceName, CoreService>> } = {}): CoreHostApp {
  return createCoreHostApp({
    modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
    ...(extra.servedCompanies === undefined ? {} : { servedCompanies: extra.servedCompanies }),
    runtime: () => ({
      callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5),
      repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined,
      services: extra.services ?? ALL_SERVICES,
      // Wiring check honest-ci: a deployment hands in the project's own CI mode reader (core-host-wiring-guard.test.ts covers the refusals).
      ciReporting: HONEST_CI,
    }),
  });
}

async function registerProject(world: FakeWorld, companyId: string): Promise<void> {
  await world.store.put({ item: { ...projectRevisionKey(companyId, PROJECT.name, PROJECT.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(PROJECT)) as JsonValue } });
  await world.store.put({ item: { ...orgProjectCatalogKey(companyId, PROJECT.name), entityType: "PROJECT_CATALOG", latestRevision: PROJECT.revision } });
}

describe("the core task mark", () => {
  it("is written in the one shape release N-1 wrote, byte for byte: every area core, the fixed settings text, the start's own time", () => {
    const now = new Date("2026-11-15T10:00:00.000Z");
    expect(coreTaskMarkFor(now)).toEqual({ engine: "core", areas: { merge: "core", build: "core", flow: "core" }, flags: "cc=on", stampedAt: "2026-11-15T10:00:00.000Z" });
    const put = coreTaskMarkItem(FAKE_COMPANY, "t-golden", coreTaskMarkFor(now));
    expect(JSON.stringify(put.item)).toBe(JSON.stringify({ pk: "TASK_ENGINE#t-golden", sk: "STAMP", entityType: "TASK_ENGINE", orgId: FAKE_COMPANY, taskId: "t-golden", coreEngine: { engine: "core", areas: { merge: "core", build: "core", flow: "core" }, flags: "cc=on", stampedAt: "2026-11-15T10:00:00.000Z" } }));
    expect(put.condition).toBeDefined();
  });

  it("reads an absent or malformed mark item as no mark (the boundary's `isCoreTask` then treats an unreadable one as an error, never as not the core's)", async () => {
    const world = createFakeWorld();
    expect(coreTaskMarkOf(await world.store.get(coreTaskMarkKey("t-none")))).toBeUndefined();
    await world.store.put({ item: { ...coreTaskMarkKey("t-bad"), coreEngine: { engine: "core", areas: { merge: "core" }, flags: "x", stampedAt: "x" } } });
    expect(coreTaskMarkOf(await world.store.get(coreTaskMarkKey("t-bad")))).toBeUndefined();
    await world.store.put({ item: { ...coreTaskMarkKey("t-null"), coreEngine: { engine: "core", areas: null, flags: "x", stampedAt: "x" } } });
    expect(coreTaskMarkOf(await world.store.get(coreTaskMarkKey("t-null")))).toBeUndefined();
    await world.store.put({ item: { ...coreTaskMarkKey("t-cloud"), coreEngine: { engine: "cloud", areas: { merge: "cloud", build: "cloud", flow: "cloud" }, flags: "x", stampedAt: "x" } } });
    expect(coreTaskMarkOf(await world.store.get(coreTaskMarkKey("t-cloud")))).toBeUndefined();
  });

  it("reads and writes a mark by its own three area keys, whatever the registry's CORE_AREAS later holds (a rollback to release N-1 and every stored mark depend on it)", async () => {
    const world = createFakeWorld();
    // A stored mark with the three keys plus one more is read; the reader demands only the three it always demanded.
    await world.store.put({ item: { ...coreTaskMarkKey("t-extra"), coreEngine: { engine: "core", areas: { merge: "core", build: "core", flow: "core", e2e: "core" }, flags: "cc=on", stampedAt: "2026-11-15T10:00:00.000Z" } } });
    expect(coreTaskMarkOf(await world.store.get(coreTaskMarkKey("t-extra")))).toMatchObject({ engine: "core", areas: { merge: "core", build: "core", flow: "core" } });
    // A mark missing one of the three is still unreadable, and a new mark has exactly the three, in this order.
    await world.store.put({ item: { ...coreTaskMarkKey("t-short"), coreEngine: { engine: "core", areas: { merge: "core", build: "core" }, flags: "cc=on", stampedAt: "x" } } });
    expect(coreTaskMarkOf(await world.store.get(coreTaskMarkKey("t-short")))).toBeUndefined();
    expect(Object.keys(coreTaskMarkFor(new Date("2026-11-15T10:00:00.000Z")).areas)).toEqual(["merge", "build", "flow"]);
  });

  it("writes the in-use mark once per company per store, only when absent", async () => {
    const world = createFakeWorld();
    const put = vi.spyOn(world.store, "put");
    await ensureCoreInUse(world.store, FAKE_COMPANY);
    await ensureCoreInUse(world.store, FAKE_COMPANY);
    expect(put).toHaveBeenCalledTimes(1);
    expect(await world.store.get(coreInUseKey(FAKE_COMPANY))).toMatchObject({ entityType: "CORE_ENGINE_IN_USE", orgId: FAKE_COMPANY });
  });
});

describe("the registry", () => {

  it("refuses Code's laptop default where a deployed adapter is required (money, authority, audit)", async () => {
    const world = createFakeWorld({ asDefault: ["admission", "audit-sink", "metering", "identity", "approvers"] });
    const error = await appOver(world).registry().catch((caught: unknown) => caught);
    expect([...(error as CoreRegistryError).defaulted].sort()).toEqual(["admission", "approvers", "audit-sink", "identity", "metering"]);
  });

  it("accepts a default that a configured adapter of the same point replaces", async () => {
    const world = createFakeWorld();
    const laptop = { point: "admission" as const, name: "allow-all", owner: "code", isDefault: true, create: () => createAllowAllAdmission() };
    const app = createCoreHostApp({ modules: [laptop, ...world.modules], context: () => world.context(), runtime: () => { throw new Error("unused"); } });
    await expect(app.registry()).resolves.toBeDefined();
  });

  it("is built once per container, sealed, retried after a failed build, and stores through the deployment's wrapper", async () => {
    const world = createFakeWorld();
    let fail = true;
    const wrapped: string[] = [];
    const modules = [{ point: "storage" as const, name: "dynamodb", owner: "fake", create: () => { if (fail) throw new Error("transient"); return world.store; } }, ...world.modules.filter((module) => module.point !== "storage")];
    const app = createCoreHostApp({
      modules, context: () => world.context(), runtime: () => { throw new Error("unused"); },
      wrapStorage: (store) => ({ ...store, indexes: store.indexes, put: async (request) => { wrapped.push(String(request.item.pk)); return await store.put(request); } }),
    });
    await expect(app.registry()).rejects.toThrow("transient");
    fail = false;
    const [one, two] = await Promise.all([app.registry(), app.registry()]);
    expect(one).toBe(two);
    expect(() => { one.register("admission", "other", createAllowAllAdmission()); }).toThrow(/sealed/);
    await one.require("storage").put({ item: { pk: "P#1", sk: "S" } });
    expect(wrapped).toEqual(["P#1"]);
  });
});

describe("a task keeps the core mark it started with", () => {
  it("a core start writes the mark with the task", async () => {
    const world = createFakeWorld();
    await registerProject(world, FAKE_COMPANY);
    const on = appOver(world);
    const runtime = await on.runtimeFor(FAKE_COMPANY);
    expect(await on.runtimeFor(FAKE_COMPANY)).toBe(runtime);
    const owner = { principal: localOwnerPrincipal({ companyId: FAKE_COMPANY }), client: "test", origin: "app" as const };
    const { task } = await runtime.flow.start(owner, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint", workflow: true, workflowPath: "QUICK" });
    expect(coreTaskMarkOf(await world.store.get(coreTaskMarkKey(task.taskId)))).toMatchObject({ engine: "core", flags: "cc=on" });
  });

  it("refuses a runtime that lacks a required service (never a half-wired core)", async () => {
    const world = createFakeWorld();
    const app = appOver(world, { services: () => ({}) });
    await expect(app.runtimeFor(FAKE_COMPANY)).rejects.toThrow(/merge-tracking/);
    await expect(app.runtimeFor(FAKE_COMPANY)).rejects.toThrow(/admission-hold-sweep/);
  });
});

describe("review fixes: access is required", () => {
  it("refuses a runtime given no access rule at run time (never the laptop's sole-owner rule by omission)", async () => {
    const world = createFakeWorld();
    const app = createCoreHostApp({
      modules: world.modules, context: () => world.context(),
      runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access: undefined as never, repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined, services: ALL_SERVICES, ciReporting: HONEST_CI }),
    });
    await expect(app.runtimeFor(FAKE_COMPANY)).rejects.toThrow("the core runtime needs an access rule");
  });
});

describe("scheduled jobs", () => {

  it("runs a job for the install's company through the core, relays any company's outbox, and never runs an unknown job", async () => {
    const world = createFakeWorld();
    const app = appOver(world);
    for (const name of ["dispatch-sweep", "run-watch", "outbox-relay-backstop"]) {
      expect(await app.handleScheduledJob(scheduleEventOf(CORE_JOBS.find((job) => job.name === name)!))).toMatchObject({ job: name, companies: [{ companyId: FAKE_COMPANY, outcome: "ran" }] });
    }
    expect(await app.handleScheduledJob({ source: "agentx.core-job", job: "nope" })).toEqual({ skipped: "unknown_job" });
    expect(await app.relayOutbox([OTHER])).toMatchObject([{ companyId: OTHER, outcome: "ran" }]);
    expect(await app.relayOutbox([FAKE_COMPANY, FAKE_COMPANY])).toMatchObject([{ companyId: FAKE_COMPANY, outcome: "ran" }]);
  });

  it("L4-JA56 B5: a company a lessons or system-runs flag names is listed with no in-use mark; `on`/off flags add nothing", async () => {
    const jobCompanies = async (named: string[], job = "dispatch-sweep"): Promise<string[]> => {
      const world = createFakeWorld();
      const app = createCoreHostApp({
        modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
        alsoNamedBy: named.map((value) => parseCoreSwitch(value).value),
        runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined, services: ALL_SERVICES, ciReporting: HONEST_CI }),
      });
      const result = await app.handleScheduledJob({ source: "agentx.core-job", job }) as { companies?: Array<{ companyId: string }> };
      return (result.companies ?? []).map((entry) => entry.companyId).sort();
    };
    const pilot = "org_pilotaaaaaaaaaaaaaaa";
    expect(await jobCompanies([`on:${pilot}`])).toEqual([FAKE_COMPANY, pilot].sort());
    expect(await jobCompanies(["on", "off", `on:${OTHER}:${pilot}`])).toEqual([FAKE_COMPANY, OTHER, pilot].sort());
    expect(await jobCompanies(["on", "off"])).toEqual([FAKE_COMPANY]);
    expect(await jobCompanies([])).toEqual([FAKE_COMPANY]);
    // The install's company is listed once.
    expect(await jobCompanies([`on:${FAKE_COMPANY}:${pilot}`])).toEqual([FAKE_COMPANY, pilot].sort());
    expect(await jobCompanies([`on:${pilot}`], "merge-tracking")).toEqual([FAKE_COMPANY, pilot].sort());
  });

  it("caps a run's budget by the function's time left, less the exit margin", async () => {
    const world = createFakeWorld();
    const budgets: number[] = [];
    const app = appOver(world, { services: () => ({ ...ALL_SERVICES(), "merge-tracking": { pass: async (options) => { budgets.push(options.budgetMs); return {}; } }, "session-sweep": { pass: async (options) => { budgets.push(options.budgetMs); return {}; } } }) });
    await app.handleScheduledJob({ source: "agentx.core-job", job: "merge-tracking" }, { remainingMs: 30_000 });
    // Merge tracking has its own, smaller exit margin (10 s): its sweep gets a 20 s pass of the 30 s function. Every other job keeps the 20 s margin.
    await app.handleScheduledJob({ source: "agentx.core-job", job: "session-sweep" }, { remainingMs: 30_000 });
    // Less time left than the margin: no budget at all, so the company is deferred and its job is never called.
    expect(await app.handleScheduledJob({ source: "agentx.core-job", job: "merge-tracking" }, { remainingMs: 5_000 })).toEqual({ job: "merge-tracking", companies: [{ companyId: FAKE_COMPANY, outcome: "deferred" }] });
    expect(await app.handleScheduledJob({ source: "agentx.core-job", job: "session-sweep" }, { remainingMs: 15_000 })).toEqual({ job: "session-sweep", companies: [{ companyId: FAKE_COMPANY, outcome: "deferred" }] });
    expect(budgets).toEqual([20_000, 10_000]);
  });
});
