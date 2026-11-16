// Engine host (migration plan v3.2 lane E2): the deployed composition root. Off by default with no behaviour change; the switch parses fail closed; a task keeps the engine it started on;
// the registry refuses a half-wired core and Code's laptop defaults for money, authority and audit; jobs run per company in isolation; drain serves the tasks the core holds.
// Ported from the monolith's host-root tests (its cloud-app.test.ts: the switch, stamp, off, registry, keep-engine, missing-service and job cases); the Cloud money, retention and Slack cases stay there.
import { createTransactionalOutbox } from "../../packages/broker/src/ports/transactional-outbox.js";
import { outboxCompaniesOf } from "../../packages/broker/src/aws/core-engine-root.js";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { orgProjectCatalogKey, projectRevisionKey, type JsonValue, type ProjectDefinition } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { createAllowAllAdmission, localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import {
  CORE_ENGINE_OFF, CORE_JOBS, CoreRegistryError, coreAreaOn, coreEngineServes, coreInUseKey, createCoreHostApp, engineOfStoredTask, engineStampKey, ensureCoreInUse, parseCoreSwitch, readCoreEngineFlags,
  CORE_START_REFUSED_WORDS, runPerCompany, scheduleEventOf, stampForNewTask, stampItem, stampOf, type CoreHostApp, type CoreService, type CoreServiceName,
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
  it("reads off, on, drain and on:<companies>, and anything else as OFF with a problem that does not echo the text", () => {
    expect(parseCoreSwitch(undefined)).toEqual({ value: { mode: "off" } });
    expect(parseCoreSwitch("")).toEqual({ value: { mode: "off" } });
    expect(parseCoreSwitch("0")).toEqual({ value: { mode: "off" } });
    expect(parseCoreSwitch("off")).toEqual({ value: { mode: "off" } });
    expect(parseCoreSwitch("on")).toEqual({ value: { mode: "on" } });
    expect(parseCoreSwitch("drain")).toEqual({ value: { mode: "off" }, drain: true });
    expect(parseCoreSwitch(`on:${FAKE_COMPANY}:${OTHER}:${FAKE_COMPANY}`)).toEqual({ value: { mode: "on-for", companies: [FAKE_COMPANY, OTHER] } });
    for (const bad of ["1", "ON", "on:", "on:org_short", `on:${FAKE_COMPANY},${OTHER}`, `on:${FAKE_COMPANY}:`, "true", "yes please", "DRAIN"]) {
      const parsed = parseCoreSwitch(bad);
      expect(parsed.value, bad).toEqual({ mode: "off" });
      expect(parsed.drain, bad).toBeUndefined();
      expect(parsed.problem, bad).toBeDefined();
      expect(parsed.problem, bad).not.toContain(bad);
    }
  });

  it("is off by default, and one combined switch moves merge, build and flow together for the named company only", () => {
    expect(readCoreEngineFlags({})).toEqual(CORE_ENGINE_OFF);
    const flags = readCoreEngineFlags({ ROVARA_CORE_ENGINE: `on:${FAKE_COMPANY}` });
    for (const area of ["merge", "build", "flow"] as const) {
      expect(coreAreaOn(flags, area, FAKE_COMPANY)).toBe(true);
      expect(coreAreaOn(flags, area, OTHER)).toBe(false);
    }
  });

  it("a per-area key only narrows: it can never turn an area on that the combined switch leaves off", () => {
    expect(coreAreaOn(readCoreEngineFlags({ ROVARA_CORE_ENGINE_MERGE: "on" }), "merge", FAKE_COMPANY)).toBe(false);
    const narrowed = readCoreEngineFlags({ ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ENGINE_BUILD: "off" });
    expect(coreAreaOn(narrowed, "build", FAKE_COMPANY)).toBe(false);
    expect(coreAreaOn(narrowed, "flow", FAKE_COMPANY)).toBe(true);
    expect(readCoreEngineFlags({ ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ENGINE_FLOW: "bogus" }).problems).toEqual([{ variable: "ROVARA_CORE_ENGINE_FLOW", problem: expect.any(String) as string }]);
    // `drain` on an area key is not a way to serve: it narrows that area to off.
    expect(coreAreaOn(readCoreEngineFlags({ ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ENGINE_FLOW: "drain" }), "flow", FAKE_COMPANY)).toBe(false);
  });

  it("serves in on, on:<ids> and drain only; drain starts no new task on the core", () => {
    expect(coreEngineServes(readCoreEngineFlags({}))).toBe(false);
    expect(coreEngineServes(readCoreEngineFlags({ ROVARA_CORE_ENGINE: "nonsense" }))).toBe(false);
    const drain = readCoreEngineFlags({ ROVARA_CORE_ENGINE: "drain" });
    expect(coreEngineServes(drain)).toBe(true);
    expect(coreAreaOn(drain, "flow", FAKE_COMPANY)).toBe(false);
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

  it("the stamp item is written only when absent: a second stamp for the same task never overwrites the first", async () => {
    const world = createFakeWorld();
    const flags = readCoreEngineFlags({ ROVARA_CORE_ENGINE: "on" });
    expect((await world.store.transact([stampItem(FAKE_COMPANY, "t-1", stampForNewTask(flags, FAKE_COMPANY, new Date("2026-11-15T10:00:00.000Z")))])).applied).toBe(true);
    expect((await world.store.transact([stampItem(FAKE_COMPANY, "t-1", stampForNewTask(CORE_ENGINE_OFF, FAKE_COMPANY, new Date("2026-11-15T11:00:00.000Z")))])).applied).toBe(false);
    expect(stampOf(await world.store.get(engineStampKey("t-1")))).toMatchObject({ engine: "core", stampedAt: "2026-11-15T10:00:00.000Z" });
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

  it("a malformed switch is off too", async () => {
    const world = createFakeWorld();
    const app = appOver(world, { ROVARA_CORE_ENGINE: "on:not-a-company" });
    expect(app.active).toBe(false);
    expect(app.serving).toBe(false);
    expect(app.flags.problems).toHaveLength(1);
    await expect(app.registry()).rejects.toMatchObject({ name: "CoreEngineOffError" });
    expect(world.created).toEqual([]);
  });
});

describe("the registry", () => {
  it("refuses a core with a needed point missing, naming it and the areas that need it", async () => {
    const world = createFakeWorld({ without: ["approvers", "code-host"] });
    const app = appOver(world, { ROVARA_CORE_ENGINE: "on" });
    const error = await app.registry().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CoreRegistryError);
    expect((error as CoreRegistryError).missing.map((entry) => entry.point).sort()).toEqual(["approvers", "code-host"]);
    expect((error as CoreRegistryError).missing.find((entry) => entry.point === "approvers")?.areas).toEqual(["merge", "flow"]);
  });

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

  it("with no company holding core tasks, drain runs nothing", async () => {
    const world = createFakeWorld();
    const app = appOver(world, { ROVARA_CORE_ENGINE: "drain" });
    expect(await app.handleScheduledJob({ source: "agentx.core-job", job: "dispatch-sweep" })).toEqual({ job: "dispatch-sweep", companies: [] });
  });

  it("with the switch ON for that area the runtime is still refused (a switched area is never half-wired)", async () => {
    await expect(appOver(createFakeWorld(), { ROVARA_CORE_ENGINE: "on" }, { services: flowOnly }).runtimeFor(FAKE_COMPANY)).rejects.toThrow(/merge-tracking/);
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

  it("a core start writes the company's in-use mark first, and by default the root's jobs serve every company that holds core tasks", async () => {
    const world = createFakeWorld();
    await registerProject(world, OTHER);
    const app = createCoreHostApp({
      env: { ROVARA_CORE_ENGINE: "on" }, modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
      runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined, services: ALL_SERVICES, ciReporting: HONEST_CI }),
    });
    expect(await app.handleScheduledJob({ source: "agentx.core-job", job: "dispatch-sweep" })).toMatchObject({ companies: [{ companyId: FAKE_COMPANY }] });
    const runtime = await app.runtimeFor(OTHER);
    await runtime.flow.start({ principal: localOwnerPrincipal({ companyId: OTHER }), client: "test", origin: "app" as const }, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint", workflow: true, workflowPath: "QUICK" });
    expect(await world.store.get(coreInUseKey(OTHER))).toMatchObject({ orgId: OTHER });
    const result = await app.handleScheduledJob({ source: "agentx.core-job", job: "dispatch-sweep" }) as { companies: { companyId: string; outcome: string }[] };
    expect(result.companies.map((entry) => entry.companyId).sort()).toEqual([FAKE_COMPANY, OTHER].sort());
    expect(result.companies.every((entry) => entry.outcome === "ran")).toBe(true);
  });

  it("refuses a runtime given no access rule at run time (never the laptop's sole-owner rule by omission)", async () => {
    const world = createFakeWorld();
    const app = createCoreHostApp({
      env: { ROVARA_CORE_ENGINE: "on" }, modules: world.modules, context: () => world.context(),
      runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access: undefined as never, repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined, services: ALL_SERVICES, ciReporting: HONEST_CI }),
    });
    await expect(app.runtimeFor(FAKE_COMPANY)).rejects.toThrow("the core runtime needs an access rule");
  });

  it("refuses a null access rule too (the core's own fallback would take it as absent)", async () => {
    const world = createFakeWorld();
    const app = createCoreHostApp({
      env: { ROVARA_CORE_ENGINE: "on" }, modules: world.modules, context: () => world.context(),
      runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access: null as never, repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined, services: ALL_SERVICES }),
    });
    await expect(app.runtimeFor(FAKE_COMPANY)).rejects.toThrow("the core runtime needs an access rule");
  });

  it("reports an unreadable switch once, by variable and fixed problem, never the value", () => {
    const world = createFakeWorld();
    const entries: Record<string, unknown>[] = [];
    createCoreHostApp({ env: { ROVARA_CORE_ENGINE: "on:hunter2-value" }, modules: world.modules, context: () => world.context(), runtime: () => { throw new Error("unused"); }, log: (entry) => entries.push(entry) });
    expect(entries).toEqual([{ event: "core_engine.switch_unreadable", variable: "ROVARA_CORE_ENGINE", problem: expect.any(String) as string }]);
    expect(JSON.stringify(entries)).not.toContain("hunter2");
  });
});

describe("scheduled jobs", () => {
  it("each company runs isolated: one failure is that company's (class name only), the rest run, and the order rotates so a budget never defers the same tail", async () => {
    const seen: string[][] = [];
    for (const rotation of [0, 1, 2]) {
      const order: string[] = [];
      const reports = await runPerCompany(["a", "b", "c"], async (company) => { order.push(company); if (company === "b") throw new TypeError("customer text"); return {}; }, { rotation, budgetMs: 1_000, nowMs: () => 0 });
      expect(reports.find((report) => report.companyId === "b")).toEqual({ companyId: "b", outcome: "failed", error: "TypeError" });
      expect(reports.filter((report) => report.outcome === "ran")).toHaveLength(2);
      seen.push(order);
    }
    expect(seen.map((order) => order[0])).toEqual(["a", "b", "c"]);
    let clock = 0;
    const budgeted = await runPerCompany(["a", "b", "c"], async () => { clock += 600; return {}; }, { rotation: 0, budgetMs: 1_000, nowMs: () => clock });
    expect(budgeted.map((report) => report.outcome)).toEqual(["ran", "ran", "deferred"]);
    clock = 0;
    const left: number[] = [];
    await runPerCompany(["a", "b"], async (_company, leftMs) => { left.push(leftMs); clock += 300; return {}; }, { rotation: 0, budgetMs: 1_000, nowMs: () => clock });
    expect(left).toEqual([1_000, 700]);
  });

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

  it("plain `on` runs the jobs for the install's company", async () => {
    const world = createFakeWorld();
    const result = await appOver(world, { ROVARA_CORE_ENGINE: "on" }).handleScheduledJob({ source: "agentx.core-job", job: "merge-tracking" });
    expect(result).toEqual({ job: "merge-tracking", companies: [{ companyId: FAKE_COMPANY, outcome: "ran", report: { swept: 0 } }] });
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

  it("every job name is unique and every schedule is a rate EventBridge Scheduler accepts", () => {
    expect(new Set(CORE_JOBS.map((job) => job.name)).size).toBe(CORE_JOBS.length);
    for (const job of CORE_JOBS) if (job.trigger.kind === "schedule") expect(job.trigger.rate).toMatch(/^rate\((1 minute|\d+ minutes)\)$/);
  });
});


it("L9 relays a two-company INSERT batch to each company's own queue messages", async () => {
  const world = createFakeWorld();
  const app = appOver(world, { ROVARA_CORE_ENGINE: "on" });
  const outbox = createTransactionalOutbox({ store: world.store, queues: world.queues });
  for (const companyId of [FAKE_COMPANY, OTHER]) {
    await world.store.transact([outbox.stage({ companyId, id: "same-id", queue: "l9-relay", body: { companyId } })]);
  }
  const batch = { Records: [FAKE_COMPANY, OTHER].map((companyId, index) => ({ eventSource: "aws:dynamodb", eventName: "INSERT", dynamodb: { SequenceNumber: String(index + 1), NewImage: { pk: { S: `ORG#${companyId}#OUTBOX#same-id` }, outboxState: { S: `PENDING#${companyId}` } } } })) };
  expect(await app.relayOutbox(outboxCompaniesOf(batch)!)).toMatchObject([
    { companyId: FAKE_COMPANY, outcome: "ran", report: { delivered: 1 } },
    { companyId: OTHER, outcome: "ran", report: { delivered: 1 } },
  ]);
  const messages = await (await world.queues.queue("l9-relay")).receive({ maxMessages: 10 });
  expect(messages.map(({ body, attributes }) => ({ body, companyId: attributes.companyId, outboxId: attributes.outboxId }))).toEqual([
    { body: { companyId: FAKE_COMPANY }, companyId: FAKE_COMPANY, outboxId: "same-id" },
    { body: { companyId: OTHER }, companyId: OTHER, outboxId: "same-id" },
  ]);
});
