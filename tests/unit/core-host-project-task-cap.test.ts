// L2-5 (b): the core engine enforces a project's own per-task limit (`model_budget_usd`, Code's project settings). The task cap of a task is the install's cap lowered to its project's
// limit when one is set: at task start (the hold and the refusal), before each model run (run.start) and after each booking (the per-run stop). A limit that cannot be read refuses
// (spend unknown); no reader means today's install cap, nothing read. Two companies throughout.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, companyScoped, type AdmissionRequest, type DocumentStore, type MeterEntry, type OrgId } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { companyDayKey } from "../../packages/broker/src/core/cost/ledger.js";
import { holdKey } from "../../packages/broker/src/core/cost/holds.js";
import {
  PROJECT_TASK_CAP_REACHED, SPEND_UNKNOWN, TASK_CAP_REACHED, createHostedAdmission, createHostedLedger, hostedSecurityModules, runSpendState, taskCapOf, type HostedAdmissionSettings, type ProjectTaskCap,
} from "../../packages/broker/src/core-host/hosted-modules.js";
import { RUN_START_ACTION } from "../../packages/broker/src/core/task-flow/money-stop.js";
import { taskKey, taskPointerKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { coreMoneyWiring, enginePolicyHook, hostedRoundCap } from "../../packages/broker/src/aws/core-engine-root.js";
import type { OperationRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { projectTaskCapReader } from "../../packages/broker/src/aws/project-settings.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { buildCoreRegistry, coreAdapter } from "../../packages/broker/src/core-host/registry.js";
import { ISSUER, fakeService, makeKey, settingsFor, signerOf } from "./policy-hook-fixture.js";
import { COMPANY_A_ID, COMPANY_B_ID } from "../../packages/testing/src/isolation/two-company.js";

const A = COMPANY_A_ID as OrgId;
const B = COMPANY_B_ID as OrgId;
const DAY = "2026-11-17";
const NOW = new Date(`${DAY}T10:00:00.000Z`);
const SETTINGS: HostedAdmissionSettings = { allowedCompanies: "all", taskCapMicros: 5_000_000, companyDayCapMicros: 25_000_000 };
const exactMeter = {
  async price() { return null; },
  async record(e: MeterEntry) { return { cost: { micros: e.usage.tokens.input, currency: "USD" }, source: "price-table" as const }; },
};

/** `limits` maps "<company>/<project>" to the project's limit in micros (absent: none); an Error throws. Every ask is recorded. */
function setup(limits: Record<string, number | Error> | undefined) {
  const store = new MemoryDocumentStore();
  const now = () => NOW;
  const ledger = createHostedLedger({ store, metering: exactMeter, now });
  const asked: string[] = [];
  const projectTaskCap: ProjectTaskCap | undefined = limits === undefined ? undefined : async (companyId, project) => {
    asked.push(`${companyId}/${project}`);
    const limit = limits[`${companyId}/${project}`];
    if (limit instanceof Error) throw limit;
    return limit;
  };
  const admission = createHostedAdmission({ settings: SETTINGS, store, ledger, now, runStopWired: true, ...(projectTaskCap === undefined ? {} : { projectTaskCap }) });
  const book = (companyId: string, taskId: string, micros: number) =>
    ledger.recordUsage({ companyId, entryId: randomUUID(), at: NOW.toISOString(), taskId, usage: { provider: "anthropic", modelId: "m", tokens: { input: micros, output: 0, cacheRead: 0, cacheWrite: 0 } } });
  const task = async (companyId: string, project: string) => {
    const taskId = randomUUID();
    await store.put({ item: { ...taskKey(taskId), entityType: "DEVELOPER_TASK", taskId, companyId, project } });
    return taskId;
  };
  const startRequest = (companyId: string, taskId: string, project: string, path: "FULL" | "QUICK" = "FULL"): AdmissionRequest =>
    ({ companyId, idempotencyKey: `task.start:${taskId}`, action: "task.start", projectName: project, subject: { type: "task", id: taskId }, taskStart: { workflow: true, path, pathFrom: "request" } });
  const runStart = (companyId: string, taskId: string, project?: string) =>
    admission.admit({ companyId, idempotencyKey: `${RUN_START_ACTION}:${randomUUID()}`, action: RUN_START_ACTION, ...(project === undefined ? {} : { projectName: project }), subject: { type: "task", id: taskId } });
  const state = (companyId: string, taskId: string, project?: string) => runSpendState({ store, ledger, settings: SETTINGS, now, ...(projectTaskCap === undefined ? {} : { projectTaskCap }) }, companyId, taskId, project);
  return { store, ledger, admission, book, task, startRequest, runStart, state, asked };
}
const heldMicros = async (w: ReturnType<typeof setup>, companyId: string, reservationId: string | undefined) => (reservationId === undefined ? undefined : (await w.store.get(holdKey(companyId, reservationId)))?.["heldMicros"]);

describe("a project's own per-task limit lowers the task cap", () => {
  it("at start: the hold is at most the project's limit, and a task at its limit is refused naming who can raise it", async () => {
    const w = setup({ [`${A}/web`]: 2_000_000 });
    const taskId = await w.task(A, "web");
    const staged = await w.admission.stage(w.startRequest(A, taskId, "web"));
    expect(staged.decision.allowed).toBe(true);
    expect((await w.store.transact([...staged.items])).applied).toBe(true);
    // The full path's planning allowance is $6, the install's cap $5: the project's $2 is what is held.
    expect(await heldMicros(w, A, staged.decision.allowed ? staged.decision.reservationId : undefined)).toBe(2_000_000);
    await w.book(A, taskId, 2_000_000);
    const again = await w.admission.stage({ ...w.startRequest(A, taskId, "web"), idempotencyKey: `task.start:${taskId}:2` });
    expect(again.decision).toEqual({ allowed: false, code: "task_cap", message: PROJECT_TASK_CAP_REACHED });
    expect(again.items).toEqual([]);
    expect(w.asked.every((entry) => entry === `${A}/web`)).toBe(true);
  });

  it("before each model run (run.start) and after each booking (the per-run stop): stopped at the project's limit, not the install's", async () => {
    const w = setup({ [`${A}/web`]: 1_500_000 });
    const taskId = await w.task(A, "web");
    expect(await w.runStart(A, taskId, "web")).toEqual({ allowed: true });
    expect(await w.state(A, taskId)).toBe("within");
    await w.book(A, taskId, 1_499_999);
    expect(await w.state(A, taskId)).toBe("within");
    await w.book(A, taskId, 1);
    expect(await w.state(A, taskId)).toBe("task_cap");
    expect(await w.runStart(A, taskId, "web")).toEqual({ allowed: false, code: "task_cap", message: PROJECT_TASK_CAP_REACHED });
    // Without the request's project name, the task's own row names it.
    expect(await w.state(A, taskId, undefined)).toBe("task_cap");
  });

  it("a lowered limit stops a running task at its next booking; a raised one lets it go on (read each time)", async () => {
    const limits: Record<string, number | Error> = { [`${A}/web`]: 4_000_000 };
    const w = setup(limits);
    const taskId = await w.task(A, "web");
    await w.book(A, taskId, 3_000_000);
    expect(await w.state(A, taskId)).toBe("within");
    limits[`${A}/web`] = 3_000_000;
    expect(await w.state(A, taskId)).toBe("task_cap");
    limits[`${A}/web`] = 4_500_000;
    expect(await w.state(A, taskId)).toBe("within");
  });

  it("a limit of $0 refuses the start", async () => {
    const w = setup({ [`${A}/web`]: 0 });
    const taskId = await w.task(A, "web");
    expect((await w.admission.stage(w.startRequest(A, taskId, "web"))).decision).toEqual({ allowed: false, code: "task_cap", message: PROJECT_TASK_CAP_REACHED });
  });

  it("a limit at or above the install's cap, or none, leaves the install's cap and its words", async () => {
    for (const limit of [undefined, 5_000_000, 50_000_000]) {
      const w = setup(limit === undefined ? {} : { [`${A}/web`]: limit });
      const taskId = await w.task(A, "web");
      const staged = await w.admission.stage(w.startRequest(A, taskId, "web"));
      expect((await w.store.transact([...staged.items])).applied).toBe(true);
      expect(await heldMicros(w, A, staged.decision.allowed ? staged.decision.reservationId : undefined)).toBe(5_000_000);
      await w.book(A, taskId, 5_000_000);
      expect((await w.admission.stage({ ...w.startRequest(A, taskId, "web"), idempotencyKey: "again" })).decision).toEqual({ allowed: false, code: "task_cap", message: TASK_CAP_REACHED });
      expect(await taskCapOf({ store: w.store, settings: SETTINGS, projectTaskCap: async () => limit }, A, taskId, "web")).toEqual({ micros: 5_000_000, project: false });
    }
  });
});

describe("fails closed", () => {
  it("a limit that cannot be read refuses the start, the model run and the booking check (spend unknown), never the install's cap alone", async () => {
    const w = setup({ [`${A}/web`]: new Error("private-canary") });
    const taskId = await w.task(A, "web");
    const staged = await w.admission.stage(w.startRequest(A, taskId, "web"));
    expect(staged).toEqual({ decision: { allowed: false, code: "spend_unknown", message: SPEND_UNKNOWN }, items: [] });
    expect(await w.runStart(A, taskId, "web")).toEqual({ allowed: false, code: "spend_unknown", message: SPEND_UNKNOWN });
    expect(await w.state(A, taskId)).toBe("spend_unknown");
    expect(await w.store.get(companyDayKey(A, DAY))).toBeUndefined();
  });

  it.each([
    ["a missing task", async () => Promise.resolve(randomUUID())],
    ["another company's task", async (w: ReturnType<typeof setup>) => w.task(B, "web")],
    ["a task with no project", async (w: ReturnType<typeof setup>) => { const id = randomUUID(); await w.store.put({ item: { ...taskKey(id), taskId: id, companyId: A } }); return id; }],
  ])("with no project named, %s is spend unknown", async (_label, make) => {
    const w = setup({ [`${A}/web`]: 9_000_000 });
    const taskId = await make(w);
    expect(await w.state(A, taskId)).toBe("spend_unknown");
    expect(await w.runStart(A, taskId)).toEqual({ allowed: false, code: "spend_unknown", message: SPEND_UNKNOWN });
  });

  it("a reader answer that is not a whole non-negative number is spend unknown", async () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const w = setup({ [`${A}/web`]: bad });
      const taskId = await w.task(A, "web");
      expect(await w.state(A, taskId)).toBe("spend_unknown");
    }
  });
});

describe("unchanged without a reader, and two companies", () => {
  it("no reader: the install's cap, and no project read at all", async () => {
    const w = setup(undefined);
    const taskId = randomUUID();
    const staged = await w.admission.stage(w.startRequest(A, taskId, "web"));
    expect((await w.store.transact([...staged.items])).applied).toBe(true);
    expect(await heldMicros(w, A, staged.decision.allowed ? staged.decision.reservationId : undefined)).toBe(5_000_000);
    // No task row exists: without a reader nothing asks for it.
    expect(await w.state(A, taskId)).toBe("within");
    expect(w.asked).toEqual([]);
  });

  it("each company's tasks read only their own project's limit", async () => {
    const w = setup({ [`${A}/web`]: 1_000_000, [`${B}/web`]: 4_000_000 });
    const a = await w.task(A, "web"); const b = await w.task(B, "web");
    await w.book(A, a, 2_000_000); await w.book(B, b, 2_000_000);
    expect(await w.state(A, a)).toBe("task_cap");
    expect(await w.state(B, b)).toBe("within");
    // A run of B's task asked under A reads A's project row only (and the ledger keeps the companies apart).
    w.asked.length = 0;
    await w.state(A, b);
    expect(w.asked).toEqual([]);
  });
});

describe("the engine's reader of the project's settings (projectTaskCapReader)", () => {
  const world = () => {
    const db = new FakeDynamoDb();
    const read = projectTaskCapReader({ documentClient: db, tableName: "state", now: () => NOW.getTime() }, undefined);
    const row = (companyId: string, project: string, overrides: Record<string, unknown>, extra: Record<string, unknown> = {}) => db.set({
      pk: companyScoped(companyId, `PROJECT_SETTINGS#${project}`), sk: "META", entityType: "PROJECT_SETTINGS", companyId, projectName: project, overrides, revision: 1, updatedAt: NOW.toISOString(), updatedBy: "d".repeat(64), ...extra,
    });
    return { db, read, row };
  };
  it("no row, a preset, or an explicit null: no project limit", async () => {
    const w = world();
    expect(await w.read(A, "web")).toBeUndefined();
    w.row(A, "web", {}, { preset: "careful" });
    expect(await w.read(A, "web")).toBeUndefined();
    w.row(A, "web", { model_budget_usd: null });
    expect(await w.read(A, "web")).toBeUndefined();
  });
  it("dollars become whole micros, rounded down, never up past the limit", async () => {
    const w = world();
    for (const [usd, micros] of [[2.5, 2_500_000], [0.07, 70_000], [2.07, 2_070_000], [0, 0], [0.0000019, 1]] as const) {
      w.row(A, "web", { model_budget_usd: usd });
      expect(await w.read(A, "web")).toBe(micros);
    }
    w.row(A, "web", { model_budget_usd: 5_000_000 });
    expect(await w.read(A, "web")).toBe(Number.MAX_SAFE_INTEGER);
  });
  it("resolves as the page does: the company's limit (rules service) lowers a preset's none and an older, higher override; no answer throws", async () => {
    const w = world();
    const install = makeKey("install"); const hookKey = makeKey("hook");
    let answer: Record<string, unknown> | Error = { model_budget_usd: 3 };
    const service = fakeService({ key: hookKey, now: () => NOW.getTime(), answer: () => (answer instanceof Error ? answer : { locks: answer }) });
    const read = projectTaskCapReader({ documentClient: w.db, tableName: "state", now: () => NOW.getTime() }, () => ({ settings: settingsFor(hookKey), install: { issuer: ISSUER, signer: signerOf(install) }, fetch: service.fetch }));
    expect(await read(A, "web")).toBe(3_000_000);
    w.row(A, "web", { model_budget_usd: 10 });
    expect(await read(A, "web")).toBe(3_000_000);
    w.row(A, "web", { model_budget_usd: 2 });
    expect(await read(A, "web")).toBe(2_000_000);
    answer = new Error("private-canary");
    await expect(read(A, "web")).rejects.toThrow();
    const unusable = projectTaskCapReader({ documentClient: w.db, tableName: "state", now: () => NOW.getTime() }, () => { throw new Error("the policy hook is not usable"); });
    await expect(unusable(A, "web")).rejects.toThrow();
  });

  it("reads only the asking company's row; a row naming another company or not parsing throws", async () => {
    const w = world();
    w.row(B, "web", { model_budget_usd: 1 });
    expect(await w.read(A, "web")).toBeUndefined();
    w.row(A, "web", { model_budget_usd: 1 }, { companyId: B });
    await expect(w.read(A, "web")).rejects.toThrow();
    w.row(A, "web", { model_budget_usd: "private-canary" });
    await expect(w.read(A, "web")).rejects.toThrow();
  });
});

describe("races and the task's own project (L2-5 b mutants)", () => {
  it("the start's commit re-checks the task's spend against the project's limit: spend booked between the decision and the commit refuses the commit", async () => {
    const w = setup({ [`${A}/web`]: 2_000_000 });
    const taskId = await w.task(A, "web");
    // A second start attempt of the same task: decided with nothing booked (it holds the whole $2), then $1 is booked before its transaction commits.
    const staged = await w.admission.stage({ ...w.startRequest(A, taskId, "web"), idempotencyKey: `task.start:${taskId}:2` });
    expect(staged.decision.allowed).toBe(true);
    await w.book(A, taskId, 1_000_000);
    expect((await w.store.transact([...staged.items])).applied).toBe(false);
  });

  it("the task's own row names the project: a request naming another project, or a malformed one, refuses (spend unknown); with no row, a malformed name refuses", async () => {
    const w = setup({ [`${A}/web`]: 1_000_000, [`${A}/api`]: 9_000_000 });
    const taskId = await w.task(A, "web");
    await w.book(A, taskId, 1_000_000);
    expect(await w.state(A, taskId, "web")).toBe("task_cap");
    expect(await w.state(A, taskId, "api")).toBe("spend_unknown");
    expect(await w.state(A, taskId, "not a name!")).toBe("spend_unknown");
    expect(w.asked).toEqual([`${A}/web`]);
    const fresh = randomUUID();
    expect((await w.admission.stage(w.startRequest(A, fresh, "not a name!"))).decision).toEqual({ allowed: false, code: "spend_unknown", message: SPEND_UNKNOWN });
  });

  it("the deployed modules (hostedSecurityModules) hand the reader to the admission: a start over the project's limit is refused", async () => {
    const store = new MemoryDocumentStore();
    const modules = hostedSecurityModules({ env: { ROVARA_CORE_ALLOWED_COMPANIES: "all" }, identity: { membershipOf: async () => undefined, displayNameOf: async () => undefined }, runStopWired: true,
      projectTaskCap: async (companyId, project) => (companyId === A && project === "web" ? 0 : undefined) });
    const registry = await buildCoreRegistry({
      modules: [coreAdapter({ point: "storage", name: "memory", owner: "test", create: () => store }), coreAdapter({ point: "metering", name: "exact", owner: "test", create: () => exactMeter }), ...modules.filter((module) => module.point !== "metering")],
      context: { installCompanyId: IMPLICIT_COMPANY_ID, now: () => NOW, env: {}, clients: {}, log: () => undefined }, areas: [],
    });
    const taskId = randomUUID();
    const decision = (await registry.require("admission").stage({ companyId: A, idempotencyKey: `task.start:${taskId}`, action: "task.start", projectName: "web", subject: { type: "task", id: taskId }, taskStart: { workflow: true, path: "FULL", pathFrom: "request" } })).decision;
    expect(decision).toEqual({ allowed: false, code: "task_cap", message: PROJECT_TASK_CAP_REACHED });
  });

  it("the broker root's booking check (coreMoneyWiring) stops a run at the project's limit", async () => {
    const w = setup({ [`${A}/web`]: 1_000_000 });
    const taskId = await w.task(A, "web");
    const operation = { id: randomUUID(), workspaceId: randomUUID(), companyId: A } as unknown as OperationRecord;
    await w.store.put({ item: { ...taskPointerKey(A, operation.workspaceId), entityType: "DEVELOPER_TASK_POINTER", taskId } });
    const registry = { require: ((point: string) => (point === "storage" ? w.store : exactMeter)) as never } as { require: (point: string) => DocumentStore };
    const usage = (input: number, second: number) => [{ type: "usage", timestamp: `${DAY}T10:00:0${String(second)}.000Z`, payload: { schemaVersion: 1, outcome: "SUCCEEDED", provider: "anthropic", modelId: "m", cacheRetention: "short", tokens: { input, output: 0, cacheRead: 0, cacheWrite: 0, total: input }, cacheReadRatio: 0, costUsd: null, checkpoint: true } }];
    const money = coreMoneyWiring(registry as never, A, () => NOW, SETTINGS, async (companyId, project) => (companyId === A && project === "web" ? 1_000_000 : undefined));
    expect(await money.bookUsage(operation, usage(600_000, 1) as never)).toEqual({ booked: 1, unreadable: 0 });
    expect(await money.bookUsage(operation, usage(400_000, 2) as never)).toEqual({ booked: 1, unreadable: 0, spendStop: "task_cap" });
  });

  it("the owner's round's money check uses the cap that applies, and refuses when the limit cannot be read", async () => {
    const w = setup(undefined);
    const taskId = await w.task(A, "web");
    await w.book(A, taskId, 500_000);
    const registry = { require: ((point: string) => (point === "storage" ? w.store : exactMeter)) as never };
    const task = { companyId: A, taskId, project: "web" };
    expect(await hostedRoundCap(registry, A, () => NOW, SETTINGS, async () => 1_000_000, task)).toEqual({ limitUsd: 1, spentUsd: 0.5 });
    expect(await hostedRoundCap(registry, A, () => NOW, SETTINGS, undefined, task)).toEqual({ limitUsd: 5, spentUsd: 0.5 });
    await expect(hostedRoundCap(registry, A, () => NOW, SETTINGS, async () => { throw new Error("private-canary"); }, task)).rejects.toThrow();
    await expect(hostedRoundCap(registry, B, () => NOW, SETTINGS, undefined, task)).rejects.toThrow();
    await expect(hostedRoundCap(registry, A, () => NOW, undefined, undefined, task)).rejects.toThrow();
  });

  it("the broker root resolves through the install's rules service when it has one, and an unusable one refuses", () => {
    const settings = { address: settingsFor(makeKey("hook")).address, jwks: "https://rules.example/keys", thumbprints: ["a".repeat(43)] };
    const install = { issuer: ISSUER, signer: signerOf(makeKey("install")) };
    expect(enginePolicyHook(undefined, false, () => install)).toBeUndefined();
    expect(enginePolicyHook(settings, false, () => install)).toEqual({ settings, install });
    expect(() => enginePolicyHook(settings, false, () => undefined)).toThrow();
    expect(() => enginePolicyHook(settings, false, undefined)).toThrow();
    expect(() => enginePolicyHook(undefined, true, () => install)).toThrow();
  });
});
