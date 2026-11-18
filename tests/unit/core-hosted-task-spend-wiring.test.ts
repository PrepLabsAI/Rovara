// L4-TSU: the broker's hosted core root gives each company's flow its own `taskSpendUsd` (automatic fixing's per-task dollar cap reads it), over that company's own cost ledger. Real broker root, registry and
// runtimes over fakes. (The dispatcher's runtime is pinned in aws-core-dispatch-host.test.ts; the laptop's own line is pinned at the end of this file.)
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { OrgId } from "@agentx/contracts";
import { createBrokerCoreRoot } from "../../packages/broker/src/aws/core-engine-root.js";
import { costPartition } from "../../packages/broker/src/core/cost/ledger.js";
import { taskKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { TASK_SPEND_UNKNOWN } from "../../packages/broker/src/core-host/company-task-spend.js";
import { taskKeySigner } from "../../packages/broker/src/core-host/gateway-model-access.js";
import { createBrokerCoreServices } from "../../packages/broker/src/aws/core-job-services.js";
import { createFakeWorld } from "../support/core-host-fakes.js";
import { makeKey, signerOf } from "./policy-hook-fixture.js";

const adapters = vi.hoisted(() => ({ modules: [] as unknown[] }));
vi.mock("../../packages/broker/src/core-host/code-modules.js", async (original) => ({ ...await original<object>(), codeAdapterModules: () => adapters.modules }));

const A: OrgId = "org_aaaaaaaaaaaaaaaaaaaa", B: OrgId = "org_bbbbbbbbbbbbbbbbbbbb";
const TASK = "33333333-3333-4333-8333-333333333333";
const TASK_B = "66666666-6666-4666-8666-666666666666";

async function world(extraEnv: Record<string, string> = {}) {
  const w = createFakeWorld();
  w.clock.now = Date.now();
  adapters.modules = w.modules.filter((module) => ["storage", "queue", "worker-machines", "object-storage", "code-host", "check-runner", "secrets"].includes(module.point));
  const logs: Array<Record<string, unknown>> = [];
  const root = createBrokerCoreRoot({
    env: { ROVARA_CORE_ENGINE: `on:${A}:${B}`, ROVARA_CORE_ALLOWED_COMPANIES: `${A}:${B}`, ROVARA_CORE_MODEL_GATEWAY_URL: "https://gateway.example", ROVARA_CORE_AGENT_MODEL: "claude-sonnet-4-6", ...extraEnv },
    taskTokens: () => ({ signer: taskKeySigner(signerOf(makeKey("t".repeat(16)))), issuer: "https://api.example/v1/auth" }),
    documentClient: { async send() { return { Item: undefined }; } }, stateTableName: "state", signInTableName: "signin", callbackSigningKey: "k".repeat(32), repositoryGrantKey: Buffer.alloc(32, 1),
    repositoryCredential: async () => ({ token: "fake" }), codeModules: () => ({}) as never,
    origin: () => "https://api.example", now: () => new Date(w.clock.now), log: (entry) => { logs.push(entry); },
    ciReporting: { honest: true, ciMode: async () => "sandbox_only" as const },
    services: (companyId, flow, registry, wiring) => createBrokerCoreServices({ companyId, flow, registry, ciMode: wiring.ciMode!, now: () => new Date(w.clock.now) }),
  });
  // A task of the company (its record, its workspace, no run yet) and its cost total: the rows a hosted start writes.
  const total = async (companyId: OrgId, micros: number, over: Record<string, unknown> = {}, taskId = companyId === A ? TASK : TASK_B) => {
    await w.store.put({ item: { ...taskKey(taskId), entityType: "DEVELOPER_TASK", taskId, companyId, workspaceId: `ws-${taskId}` } });
    await w.store.put({ item: { ...workspaceKey(companyId, `ws-${taskId}`), entityType: "WORKSPACE", id: `ws-${taskId}`, companyId, orgId: companyId } });
    await w.store.put({ item: { pk: costPartition(companyId, taskId), sk: "TOTAL", entityType: "COST_TOTAL", companyId, taskId, currency: "USD", micros, entries: 2, unpricedEntries: 0, ...over } });
  };
  return { root, w, total, logs };
}

describe("the broker's core root gives each company's flow a taskSpendUsd over its own cost ledger", () => {
  it("sets it on every company's flow, a different function for each", async () => {
    const { root } = await world();
    const [a, b] = [(await root.app.runtimeFor(A)).flow.deps, (await root.app.runtimeFor(B)).flow.deps];
    expect(typeof a.taskSpendUsd).toBe("function");
    expect(typeof b.taskSpendUsd).toBe("function");
    expect(a.taskSpendUsd).not.toBe(b.taskSpendUsd);
  });

  it("reads the company's own task total, fresh each time, and never the other company's row", async () => {
    const { root, total } = await world();
    await total(A, 2_500_000); await total(B, 88_000_000);
    const [a, b] = [(await root.app.runtimeFor(A)).flow.deps, (await root.app.runtimeFor(B)).flow.deps];
    expect(await a.taskSpendUsd!(TASK)).toBe(2.5);
    expect(await b.taskSpendUsd!(TASK_B)).toBe(88);
    await total(A, 14_000_000);
    expect(await a.taskSpendUsd!(TASK)).toBe(14);
    expect(await b.taskSpendUsd!(TASK_B)).toBe(88);
    // each company's reader holds its own task: the other's task id is no row of its own
    await expect(a.taskSpendUsd!(TASK_B)).rejects.toThrow(TASK_SPEND_UNKNOWN);
    await expect(b.taskSpendUsd!(TASK)).rejects.toThrow(TASK_SPEND_UNKNOWN);
  });

  it("an unknown spend throws in fixed words (never zero), and the refusal is logged without the task or company id of the task", async () => {
    const { root, total, logs } = await world();
    const a = (await root.app.runtimeFor(A)).flow.deps;
    // another company's task: its record names the other company, so this company holds no run of it
    await total(B, 1_000_000);
    await expect(a.taskSpendUsd!(TASK_B)).rejects.toThrow(TASK_SPEND_UNKNOWN);
    await total(A, 1_000_000, { unpricedEntries: 1 });
    await expect(a.taskSpendUsd!(TASK)).rejects.toThrow(TASK_SPEND_UNKNOWN);
    const refusals = logs.filter((entry) => entry["event"] === "core_engine.task_spend_refused");
    expect(refusals).toEqual([
      { event: "core_engine.task_spend_refused", companyId: A, reason: "run_unreported" },
      { event: "core_engine.task_spend_refused", companyId: A, reason: "unpriced_usage" },
    ]);
    expect(JSON.stringify(refusals)).not.toContain(TASK);
  });
});

// L4-TA6: automatic fixing is held to the task's LIVE cap (the value Admission and the run stop enforce), set on every company's flow from the install's settings.
describe("the broker's core root gives each company's flow a taskCapUsd that is the task cap Admission enforces (L4-TA6)", () => {
  const taskOf = async (w: Awaited<ReturnType<typeof world>>, companyId: OrgId, taskId: string, project = "demo") => {
    await w.w.store.put({ item: { ...taskKey(taskId), entityType: "DEVELOPER_TASK", taskId, companyId, workspaceId: `ws-${taskId}`, project } });
    return { companyId, taskId, project };
  };

  it("sets it on every company's flow, a different function for each, and it reads the install's task cap ($1 here, never the $15 autofix default)", async () => {
    const w = await world({ ROVARA_CORE_TASK_CAP_USD: "1" });
    const [a, b] = [(await w.root.app.runtimeFor(A)).flow.deps, (await w.root.app.runtimeFor(B)).flow.deps];
    expect(typeof a.taskCapUsd).toBe("function");
    expect(typeof b.taskCapUsd).toBe("function");
    expect(a.taskCapUsd).not.toBe(b.taskCapUsd);
    expect(await a.taskCapUsd!(await taskOf(w, A, TASK) as never)).toBe(1);
    expect(await b.taskCapUsd!(await taskOf(w, B, TASK_B) as never)).toBe(1);
  });

  it("follows the install's setting (the default $5, $3 when set): the same value Admission's own task cap reads", async () => {
    const dflt = await world();
    expect(await (await dflt.root.app.runtimeFor(A)).flow.deps.taskCapUsd!(await taskOf(dflt, A, TASK) as never)).toBe(5);
    const three = await world({ ROVARA_CORE_TASK_CAP_USD: "3" });
    expect(await (await three.root.app.runtimeFor(A)).flow.deps.taskCapUsd!(await taskOf(three, A, TASK) as never)).toBe(3);
  });

  it("a task of another company is no task of this company's reader: it throws (the flow asks), whichever way round", async () => {
    const w = await world({ ROVARA_CORE_TASK_CAP_USD: "1" });
    const [a, b] = [(await w.root.app.runtimeFor(A)).flow.deps, (await w.root.app.runtimeFor(B)).flow.deps];
    const taskA = await taskOf(w, A, TASK), taskB = await taskOf(w, B, TASK_B);
    await expect(a.taskCapUsd!(taskB as never)).rejects.toThrow();
    await expect(b.taskCapUsd!(taskA as never)).rejects.toThrow();
  });
});

describe("the laptop's own taskSpendUsd is unchanged", () => {
  it("still reads the laptop ledger and treats an unpriced figure as nothing spent; the hosted reader is not used there", () => {
    const app = readFileSync(new URL("../../packages/broker/src/local/app/app.ts", import.meta.url), "utf8");
    expect(app).toContain("taskSpendUsd: async (taskId) => costUsdOf(await ledger.taskCost(companyId, taskId)),");
    expect(app).not.toContain("company-task-spend");
    expect(app).not.toContain("createCompanyTaskSpend");
    const autofix = readFileSync(new URL("../../packages/broker/src/core/build-step/autofix.ts", import.meta.url), "utf8");
    expect(autofix).toContain("deps.taskSpendUsd === undefined ? 0 : (await deps.taskSpendUsd(task.taskId)) ?? 0");
    // L4-TA6: and its live cap is the run limit (`taskLimitUsd`, the round cap's own figure), set only while the run limit is held.
    expect(app).toContain("...(options.runLimit === false ? {} : { taskCapUsd: async (task: TaskRecord) => taskLimitUsd(task) }),");
    expect(autofix).toContain("capUsd: await autofixCapUsd(deps, task, config.capUsd)");
  });
});
