
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { orgProjectCatalogKey, projectRevisionKey, type JsonValue, type ProjectDefinition } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { createAllowAllAdmission, localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import type { CoreRegistryError} from "../../packages/broker/src/core-host/index.js";
import {
  CORE_JOBS, coreAreaOn, coreInUseKey, createCoreHostApp, engineOfStoredTask, engineStampKey, ensureCoreInUse, parseCoreSwitch, readCoreEngineFlags,
  CORE_START_REFUSED_WORDS, scheduleEventOf, stampForNewTask, stampOf, type CoreHostApp, type CoreService, type CoreServiceName,
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

function appOver(world: FakeWorld, env: NodeJS.ProcessEnv, extra: { servedCompanies?: () => Promise<readonly string[]>; services?: () => Partial<Record<CoreServiceName, CoreService>> } = {}): CoreHostApp {
  return createCoreHostApp({
    env, modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
    ...(extra.servedCompanies === undefined ? {} : { servedCompanies: extra.servedCompanies }),
    runtime: () => ({
      callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5),
      repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined,
      services: extra.services ?? ALL_SERVICES,
      // Switch blocker honest-ci: a deployment hands in the project's own CI mode reader (core-host-switch-blockers.test.ts covers the refusals).
      ciReporting: HONEST_CI,
    }),
  });
}

async function registerProject(world: FakeWorld, companyId: string): Promise<void> {
  await world.store.put({ item: { ...projectRevisionKey(companyId, PROJECT.name, PROJECT.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(PROJECT)) as JsonValue } });
  await world.store.put({ item: { ...orgProjectCatalogKey(companyId, PROJECT.name), entityType: "PROJECT_CATALOG", latestRevision: PROJECT.revision } });
}

describe("the switch", () => {

  it("a per-area key only narrows: it can never turn an area on that the combined switch leaves off", () => {
    expect(coreAreaOn(readCoreEngineFlags({ ROVARA_CORE_ENGINE_MERGE: "on" }), "merge", FAKE_COMPANY)).toBe(false);
    const narrowed = readCoreEngineFlags({ ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ENGINE_BUILD: "off" });
    expect(coreAreaOn(narrowed, "build", FAKE_COMPANY)).toBe(false);
    expect(coreAreaOn(narrowed, "flow", FAKE_COMPANY)).toBe(true);
    expect(readCoreEngineFlags({ ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ENGINE_FLOW: "bogus" }).problems).toEqual([{ variable: "ROVARA_CORE_ENGINE_FLOW", problem: expect.any(String) as string }]);
    // `drain` on an area key is not a way to serve: it narrows that area to off.
    expect(coreAreaOn(readCoreEngineFlags({ ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ENGINE_FLOW: "drain" }), "flow", FAKE_COMPANY)).toBe(false);
  });
});

describe("the engine stamp", () => {
  it("pins all three areas together; narrowing the flow keeps the whole task on the workflow (the core's build and merge read the core's task record)", () => {
    const now = new Date("2026-11-15T10:00:00.000Z");
    expect(stampForNewTask(readCoreEngineFlags({ ROVARA_CORE_ENGINE: "on" }), FAKE_COMPANY, now)).toMatchObject({ engine: "core", areas: { merge: "core", build: "core", flow: "core" }, flags: "cc=on" });
    expect(stampForNewTask(readCoreEngineFlags({ ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ENGINE_FLOW: "off" }), FAKE_COMPANY, now)).toMatchObject({ engine: "workflow", areas: { merge: "workflow", build: "workflow", flow: "workflow" } });
    expect(stampForNewTask(readCoreEngineFlags({ ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ENGINE_MERGE: "off" }), FAKE_COMPANY, now).areas).toEqual({ merge: "workflow", build: "core", flow: "core" });
  });

  it("reads an unstamped or malformed task as the workflow", async () => {
    const world = createFakeWorld();
    expect(await engineOfStoredTask(world.store, "t-none", "flow")).toBe("workflow");
    await world.store.put({ item: { ...engineStampKey("t-bad"), coreEngine: { engine: "core", areas: { merge: "core" }, flags: "x", stampedAt: "x" } } });
    expect(stampOf(await world.store.get(engineStampKey("t-bad")))).toBeUndefined();
    expect(await engineOfStoredTask(world.store, "t-bad", "flow")).toBe("workflow");
    await world.store.put({ item: { ...engineStampKey("t-null"), coreEngine: { engine: "core", areas: null, flags: "x", stampedAt: "x" } } });
    expect(await engineOfStoredTask(world.store, "t-null", "flow")).toBe("workflow");
    await world.store.put({ item: { ...engineStampKey("t-cloud"), coreEngine: { engine: "cloud", areas: { merge: "cloud", build: "cloud", flow: "cloud" }, flags: "x", stampedAt: "x" } } });
    expect(await engineOfStoredTask(world.store, "t-cloud", "flow")).toBe("workflow");
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

describe("with the switch off (the default)", () => {
  it("builds nothing, reads nothing and answers every entry point with off: no behaviour change", async () => {
    const world = createFakeWorld();
    const context = vi.fn(() => world.context());
    const servedCompanies = vi.fn(async () => [FAKE_COMPANY]);
    const app = createCoreHostApp({ env: {}, modules: world.modules, context, servedCompanies, runtime: () => { throw new Error("never"); } });
    const get = vi.spyOn(world.store, "get");
    expect(app.active).toBe(false);
    expect(app.serving).toBe(false);
    expect(app.engineForNewTask(FAKE_COMPANY)).toBe("workflow");
    expect(await app.handleScheduledJob(scheduleEventOf(CORE_JOBS[1]!))).toEqual({ skipped: "off" });
    expect(await app.handleScheduledJob({ source: "aws.events" })).toBeUndefined();
    expect(await app.handleScheduledJob(null)).toBeUndefined();
    expect(await app.relayOutbox([FAKE_COMPANY])).toEqual([]);
    await expect(app.registry()).rejects.toMatchObject({ name: "CoreEngineOffError" });
    await expect(app.runtimeFor(FAKE_COMPANY)).rejects.toMatchObject({ name: "CoreEngineOffError" });
    expect(world.created).toEqual([]);
    expect(context).not.toHaveBeenCalled();
    expect(servedCompanies).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });
});

describe("the registry", () => {

  it("refuses Code's laptop default where a deployed adapter is required (money, authority, audit), even when only one area is switched on", async () => {
    const world = createFakeWorld({ asDefault: ["admission", "audit-sink", "metering", "identity", "approvers"] });
    const error = await appOver(world, { ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ENGINE_FLOW: "off", ROVARA_CORE_ENGINE_BUILD: "off" }).registry().catch((caught: unknown) => caught);
    expect([...(error as CoreRegistryError).defaulted].sort()).toEqual(["admission", "approvers", "audit-sink", "identity", "metering"]);
  });

  it("accepts a default that a configured adapter of the same point replaces", async () => {
    const world = createFakeWorld();
    const laptop = { point: "admission" as const, name: "allow-all", owner: "code", isDefault: true, create: () => createAllowAllAdmission() };
    const app = createCoreHostApp({ env: { ROVARA_CORE_ENGINE: "on" }, modules: [laptop, ...world.modules], context: () => world.context(), runtime: () => { throw new Error("unused"); } });
    await expect(app.registry()).resolves.toBeDefined();
  });

  it("is built once per container, sealed, retried after a failed build, and stores through the deployment's wrapper", async () => {
    const world = createFakeWorld();
    let fail = true;
    const wrapped: string[] = [];
    const modules = [{ point: "storage" as const, name: "dynamodb", owner: "fake", create: () => { if (fail) throw new Error("transient"); return world.store; } }, ...world.modules.filter((module) => module.point !== "storage")];
    const app = createCoreHostApp({
      env: { ROVARA_CORE_ENGINE: "on" }, modules, context: () => world.context(), runtime: () => { throw new Error("unused"); },
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

describe("a task keeps the engine it started on", () => {
  it("a core start writes the stamp with the task; turning the switch off later leaves the running task on the core and sends new tasks to the workflow", async () => {
    const world = createFakeWorld();
    await registerProject(world, FAKE_COMPANY);
    const on = appOver(world, { ROVARA_CORE_ENGINE: `on:${FAKE_COMPANY}` });
    expect(on.engineForNewTask(FAKE_COMPANY)).toBe("core");
    expect(on.engineForNewTask(OTHER)).toBe("workflow");
    await expect(on.runtimeFor(OTHER)).rejects.toMatchObject({ name: "CoreEngineOffError" });
    const runtime = await on.runtimeFor(FAKE_COMPANY);
    expect(await on.runtimeFor(FAKE_COMPANY)).toBe(runtime);
    const owner = { principal: localOwnerPrincipal({ companyId: FAKE_COMPANY }), client: "test", origin: "app" as const };
    const { task } = await runtime.flow.start(owner, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint", workflow: true, workflowPath: "QUICK" });
    expect(await on.engineOfTask(world.store, task.taskId, "build")).toBe("core");
    expect(stampOf(await world.store.get(engineStampKey(task.taskId)))).toMatchObject({ engine: "core", flags: `cc=on:${FAKE_COMPANY}` });

    const off = appOver(world, { ROVARA_CORE_ENGINE: "off" });
    expect(off.engineForNewTask(FAKE_COMPANY)).toBe("workflow");
    for (const area of ["merge", "build", "flow"] as const) expect(await off.engineOfTask(world.store, task.taskId, area)).toBe("core");
  });

  it("refuses a runtime whose switched areas lack a service (never a half-wired core)", async () => {
    const world = createFakeWorld();
    const app = appOver(world, { ROVARA_CORE_ENGINE: "on" }, { services: () => ({}) });
    await expect(app.runtimeFor(FAKE_COMPANY)).rejects.toThrow(/merge-tracking/);
    await expect(app.runtimeFor(FAKE_COMPANY)).rejects.toThrow(/admission-hold-sweep/);
  });
});

describe("drain: the core serves the tasks it holds, and starts none", () => {
  const flowOnly = () => ({ "session-sweep": { pass: async () => ({ swept: 0 }) }, "notify-deliver": { pass: async () => ({ sent: 0 }) }, "admission-hold-sweep": { pass: async () => ({ charged: 0 }) } });

  it("builds a runtime only for a company that holds core tasks; its jobs run, and a missing service in an area that is off is skipped, not fatal", async () => {
    const world = createFakeWorld();
    const app = appOver(world, { ROVARA_CORE_ENGINE: "drain" }, { servedCompanies: async () => [FAKE_COMPANY], services: flowOnly });
    expect(app.active).toBe(false);
    expect(app.serving).toBe(true);
    expect(app.engineForNewTask(FAKE_COMPANY)).toBe("workflow");
    await expect(app.runtimeFor(OTHER)).rejects.toMatchObject({ name: "CoreEngineOffError" });
    await expect(app.runtimeFor(FAKE_COMPANY)).resolves.toBeDefined();
    const merge = await app.handleScheduledJob({ source: "agentx.core-job", job: "merge-tracking" }) as { companies: { companyId: string; outcome: string; report?: unknown }[] };
    expect(merge.companies).toEqual([{ companyId: FAKE_COMPANY, outcome: "ran", report: { skipped: "service_not_wired" } }]);
    const flow = await app.handleScheduledJob({ source: "agentx.core-job", job: "session-sweep" }) as { companies: { outcome: string; report?: unknown }[] };
    expect(flow.companies[0]).toMatchObject({ outcome: "ran", report: { swept: 0 } });
    expect(await app.relayOutbox([OTHER])).toEqual([]);
    expect(await app.relayOutbox([FAKE_COMPANY])).toMatchObject([{ companyId: FAKE_COMPANY, outcome: "ran" }]);
  });
});

describe("review fixes: a start the switch does not send to the core is refused, the in-use mark is kept, access is required", () => {
  it("in drain, a held company's runtime refuses a new start and writes nothing (no task on the core with a workflow stamp)", async () => {
    const world = createFakeWorld();
    await registerProject(world, FAKE_COMPANY);
    const app = appOver(world, { ROVARA_CORE_ENGINE: "drain" }, { servedCompanies: async () => [FAKE_COMPANY] });
    const runtime = await app.runtimeFor(FAKE_COMPANY);
    const owner = { principal: localOwnerPrincipal({ companyId: FAKE_COMPANY }), client: "test", origin: "app" as const };
    const put = vi.spyOn(world.store, "put");
    const transact = vi.spyOn(world.store, "transact");
    await expect(runtime.flow.start(owner, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint", workflow: true, workflowPath: "QUICK" })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: expect.stringContaining(CORE_START_REFUSED_WORDS) as string });
    expect(put).not.toHaveBeenCalled();
    expect(transact).not.toHaveBeenCalled();
    expect((await runtime.flow.list(owner)).tasks).toEqual([]);
  });

  it("the stamp step refuses too, so a start that skips the wrapper still commits nothing", async () => {
    const world = createFakeWorld();
    await registerProject(world, FAKE_COMPANY);
    const runtime = await appOver(world, { ROVARA_CORE_ENGINE: "drain" }, { servedCompanies: async () => [FAKE_COMPANY] }).runtimeFor(FAKE_COMPANY);
    expect(() => runtime.flow.deps.startExtras!({ taskId: "t-1" } as never)).toThrow(CORE_START_REFUSED_WORDS);
  });

  it("refuses a runtime given no access rule at run time (never the laptop's sole-owner rule by omission)", async () => {
    const world = createFakeWorld();
    const app = createCoreHostApp({
      env: { ROVARA_CORE_ENGINE: "on" }, modules: world.modules, context: () => world.context(),
      runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access: undefined as never, repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined, services: ALL_SERVICES, ciReporting: HONEST_CI }),
    });
    await expect(app.runtimeFor(FAKE_COMPANY)).rejects.toThrow("the core runtime needs an access rule");
  });
});

describe("scheduled jobs", () => {

  it("runs a job only for the companies the switch covers, through the core; an unknown job is never run", async () => {
    const world = createFakeWorld();
    const app = appOver(world, { ROVARA_CORE_ENGINE: `on:${FAKE_COMPANY}` });
    for (const name of ["dispatch-sweep", "run-watch", "outbox-relay-backstop"]) {
      expect(await app.handleScheduledJob(scheduleEventOf(CORE_JOBS.find((job) => job.name === name)!))).toMatchObject({ job: name, companies: [{ companyId: FAKE_COMPANY, outcome: "ran" }] });
    }
    expect(await app.handleScheduledJob({ source: "agentx.core-job", job: "nope" })).toEqual({ skipped: "unknown_job" });
    expect(await app.relayOutbox([OTHER])).toEqual([]);
    expect(await app.relayOutbox([FAKE_COMPANY, FAKE_COMPANY])).toMatchObject([{ companyId: FAKE_COMPANY, outcome: "ran" }]);
  });

  it("L4-JA56 B5: under `on`, a company a lessons or system-runs flag names is listed with no in-use mark; `on`/off flags and a company the engine does not cover add nothing", async () => {
    const jobCompanies = async (env: NodeJS.ProcessEnv, named: string[], job = "dispatch-sweep"): Promise<string[]> => {
      const world = createFakeWorld();
      const app = createCoreHostApp({
        env, modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
        alsoNamedBy: named.map((value) => parseCoreSwitch(value).value),
        runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined, services: ALL_SERVICES, ciReporting: HONEST_CI }),
      });
      const result = await app.handleScheduledJob({ source: "agentx.core-job", job }) as { companies?: Array<{ companyId: string }> };
      return (result.companies ?? []).map((entry) => entry.companyId).sort();
    };
    const pilot = "org_pilotaaaaaaaaaaaaaaa";
    expect(await jobCompanies({ ROVARA_CORE_ENGINE: "on" }, [`on:${pilot}`])).toEqual([FAKE_COMPANY, pilot].sort());
    expect(await jobCompanies({ ROVARA_CORE_ENGINE: "on" }, ["on", "off", `on:${OTHER}:${pilot}`])).toEqual([FAKE_COMPANY, OTHER, pilot].sort());
    expect(await jobCompanies({ ROVARA_CORE_ENGINE: "on" }, ["on", "off"])).toEqual([FAKE_COMPANY]);
    expect(await jobCompanies({ ROVARA_CORE_ENGINE: "on" }, [])).toEqual([FAKE_COMPANY]);
    // The engine's own list is not widened: a flag naming a company the engine does not cover adds it nowhere, and the engine-covered company is listed once.
    expect(await jobCompanies({ ROVARA_CORE_ENGINE: `on:${FAKE_COMPANY}` }, [`on:${FAKE_COMPANY}:${pilot}`])).toEqual([FAKE_COMPANY]);
    expect(await jobCompanies({ ROVARA_CORE_ENGINE: "off" }, [`on:${pilot}`])).toEqual([]);
    // Area narrowing: the flow area is on only for the install's company, so a company the flags name is not run for flow jobs, but is for the merge area (which follows the combined switch).
    expect(await jobCompanies({ ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ENGINE_FLOW: `on:${FAKE_COMPANY}` }, [`on:${pilot}`])).toEqual([FAKE_COMPANY]);
    expect(await jobCompanies({ ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ENGINE_FLOW: `on:${FAKE_COMPANY}` }, [`on:${pilot}`], "merge-tracking")).toEqual([FAKE_COMPANY, pilot].sort());
    // Drain starts nothing new: a named company is not added.
    expect(await jobCompanies({ ROVARA_CORE_ENGINE: "drain" }, [`on:${pilot}`])).toEqual([]);
  });

  it("caps a run's budget by the function's time left, less the exit margin", async () => {
    const world = createFakeWorld();
    const budgets: number[] = [];
    const app = appOver(world, { ROVARA_CORE_ENGINE: "on" }, { services: () => ({ ...ALL_SERVICES(), "merge-tracking": { pass: async (options) => { budgets.push(options.budgetMs); return {}; } } }) });
    await app.handleScheduledJob({ source: "agentx.core-job", job: "merge-tracking" }, { remainingMs: 30_000 });
    // Less time left than the margin: no budget at all, so the company is deferred and its job is never called.
    expect(await app.handleScheduledJob({ source: "agentx.core-job", job: "merge-tracking" }, { remainingMs: 5_000 })).toEqual({ job: "merge-tracking", companies: [{ companyId: FAKE_COMPANY, outcome: "deferred" }] });
    expect(budgets).toEqual([10_000]);
  });
});
