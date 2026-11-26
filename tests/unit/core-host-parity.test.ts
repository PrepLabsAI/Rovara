// F4-0 (plan rev 3, 3.5 and review finding E1-engine-03): which late-bound deps keys and which job services each composition root SETS, and which it leaves UNSET, TODAY. One assertion per root and per input
// variant, after the runtime is built and `services()` has run, against a checked-in fixture taken from the current code (tests/fixtures/core-host-parity.json). The failure class this catches, that
// the journeys cannot see, is a late-bound key that silently stops being set (a feature that quietly switches off) or one that starts being set where a host never had it.
//
// The four roots: the test harnesses (`createTaskFlow` and the core runtime over the fake world), the laptop (`rovara up`), the hosted broker (`createBrokerCoreRoot`) and the dispatcher
// (`createDispatcherCoreHost`). To change a row on purpose, run once with F4_PARITY_WRITE=1 and review the fixture diff (it is NOT a snapshot update: a person reads and approves each changed row).
// What the fixture does not say: values (it lists defined keys, not what they hold); that is the journeys' job.
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type * as TypeScript from "typescript";
import { SYSTEM_RUNS_VARIABLE, type OrgId } from "@agentx/contracts";
import { createBrokerCoreRoot, type BrokerCoreRootInputs } from "../../packages/broker/src/aws/core-engine-root.js";
import { createHostedLessonsPeople } from "../../packages/broker/src/aws/hosted-lessons-people.js";
import { createDispatcherCoreHost, dispatcherStopInstance, hostedDispatcherFlow, type DispatcherCoreInputs } from "../../packages/broker/src/aws/worker-machines/dispatcher-core.js";
import type * as CoreDispatchHostModule from "../../packages/broker/src/aws/worker-machines/core-dispatch-host.js";
import type { CoreDispatchHostDependencies } from "../../packages/broker/src/aws/worker-machines/core-dispatch-host.js";
import { createCoreHostApp } from "../../packages/broker/src/core-host/app.js";
import type { CoreRuntime } from "../../packages/broker/src/core-host/core-runtime.js";
import { REQUIRED_CORE_SERVICES } from "../../packages/broker/src/core-host/core-wiring-guard.js";
import { hostedPrFeedbackRoutes } from "../../packages/broker/src/core-host/pr-feedback-routes.js";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { FakeWorkerMachines } from "../../packages/broker/src/ports/fake-worker-machines.js";
import { startLocalRuntime } from "../../packages/broker/src/local/runtime.js";
import { taskKeySigner } from "../../packages/broker/src/core-host/gateway-model-access.js";
import { createBrokerCoreServices } from "../../packages/broker/src/aws/core-job-services.js";
import { createHarness } from "../support/task-flow-harness.js";
import { createFakeWorld, FAKE_COMPANY } from "../support/core-host-fakes.js";
import { createFakeOfferedModels } from "../support/offered-models-fake.js";
import { createSessionMachinesWorld, COMPANY_A } from "../support/session-machines-world.js";
import { FakeDocker } from "../support/local/fake-docker.js";
import { FakeDynamoDb } from "../support/ports/dynamodb-fake.js";
import { FakeSqs } from "../support/ports/sqs-fake.js";
import { FakeS3 } from "../support/ports/aws-fakes.js";
import { makeKey, signerOf } from "./policy-hook-fixture.js";

const adapters = vi.hoisted(() => ({ modules: undefined as unknown[] | undefined, security: false }));
const dispatch = vi.hoisted(() => ({ captured: undefined as { depsFor: CoreDispatchHostDependencies["depsFor"] } | undefined }));
const reviewers = vi.hoisted(() => ({ failing: false }));
// The hosted tests substitute only the deployment adapters (the root, the registry and the runtimes are real); the dispatcher's own variants build Code's real modules over the AWS fakes.
vi.mock("../../packages/broker/src/core-host/code-modules.js", async (original) => {
  const actual = await original<Record<string, (...args: unknown[]) => unknown>>();
  return { ...actual, codeAdapterModules: (...args: unknown[]) => adapters.modules ?? actual.codeAdapterModules!(...args) };
});
vi.mock("../../packages/broker/src/core-host/hosted-modules.js", async (original) => {
  const actual = await original<Record<string, (...args: unknown[]) => unknown>>();
  return { ...actual, hostedSecurityModules: (...args: unknown[]) => (adapters.modules === undefined || adapters.security ? actual.hostedSecurityModules!(...args) : []) };
});
// A feature's build that throws (the second review's reviewers, built once per company runtime): only this flag, the real builder otherwise.
vi.mock("../../packages/broker/src/core-host/hosted-reviewers.js", async (original) => {
  const actual = await original<Record<string, (...args: unknown[]) => unknown>>();
  return { ...actual, createHostedReviewers: (...args: unknown[]) => { if (reviewers.failing) throw new Error("the reviewers are down"); return actual.createHostedReviewers!(...args); } };
});
// Observes the dispatch host's own `depsFor` (what each batch of the dispatcher really runs on) without replacing the host.
vi.mock("../../packages/broker/src/aws/worker-machines/core-dispatch-host.js", async (original) => {
  const actual = await original<typeof CoreDispatchHostModule>();
  return { ...actual, createCoreDispatchHost: (dependencies: CoreDispatchHostDependencies) => { dispatch.captured = dependencies; return actual.createCoreDispatchHost(dependencies); } };
});

const FIXTURE = new URL("../fixtures/core-host-parity.json", import.meta.url);
interface Row { /** The deps keys that hold a value after the runtime is built and `services()` has run. */ set: string[]; /** The keys of `universe` that do not. */ unset: string[]; /** The job services (a laptop: the parts of the app) that exist. */ services: string[]; /** The services that do not. */ servicesUnset: string[] }
interface Fixture { note: string; universe: string[]; serviceUniverse: string[]; roots: Record<string, Row> }
const stored: Fixture | undefined = (() => { try { return JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture; } catch { return undefined; } })();
const WRITE = process.env["F4_PARITY_WRITE"] === "1";
const observed: Record<string, Row> = {};

/** Every field name `TaskFlowDeps` declares, read from the compiled source once by the fixture writer, and the services a core runtime can have (`CoreServiceName`). */
const universe = (): string[] => stored?.universe ?? [];
const SERVICE_UNIVERSE = [...REQUIRED_CORE_SERVICES, "automation-stop", "lessons", "person-erase-resume", "after-merge", "upkeep"].sort();

const definedKeys = (value: object): string[] => Object.entries(value).filter(([, entry]) => entry !== undefined).map(([key]) => key).sort();

function rowOf(deps: object, services: object, serviceUniverse: readonly string[] = SERVICE_UNIVERSE): Row {
  const set = definedKeys(deps);
  const names = definedKeys(services);
  return { set, unset: universe().filter((key) => !set.includes(key)), services: names, servicesUnset: serviceUniverse.filter((name) => !names.includes(name)) };
}

/** One row per root and variant: recorded for the fixture writer, compared to the fixture otherwise. */
function pin(name: string, row: Row): void {
  observed[name] = row;
  if (WRITE) return;
  expect(stored, "tests/fixtures/core-host-parity.json is missing: run once with F4_PARITY_WRITE=1").toBeDefined();
  // A key that is in no row of the universe is a NEW deps field: add it to the fixture on purpose.
  expect(row.set.filter((key) => !stored!.universe.includes(key)), `${name}: a deps key that the fixture's universe does not know`).toEqual([]);
  expect(stored!.roots[name], `${name}: no fixture row`).toBeDefined();
  expect(row, name).toEqual(stored!.roots[name]);
}

afterAll(async () => {
  if (!WRITE) return;
  const { createRequire } = await import("node:module");
  const ts = createRequire(import.meta.url)("typescript") as typeof TypeScript;
  const file = new URL("../../packages/broker/src/core/task-flow/deps.ts", import.meta.url);
  const source = ts.createSourceFile("deps.ts", readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const keys: string[] = [];
  source.forEachChild((node) => { if (ts.isInterfaceDeclaration(node) && node.name.text === "TaskFlowDeps") for (const member of node.members) if (member.name !== undefined) keys.push(member.name.getText()); });
  keys.sort();
  const roots = Object.fromEntries(Object.entries(observed).map(([name, row]) => [name, { ...row, unset: keys.filter((key) => !row.set.includes(key)) }]));
  const written: Fixture = { note: "Taken from the code as it was before the feature interface moved anything (F4-0). Read by tests/unit/core-host-parity.test.ts. Regenerate only with F4_PARITY_WRITE=1 and review every changed row.", universe: keys, serviceUniverse: SERVICE_UNIVERSE, roots: Object.fromEntries(Object.entries(roots).sort(([a], [b]) => a.localeCompare(b))) };
  writeFileSync(FIXTURE, `${JSON.stringify(written, null, 2)}\n`);
});

// ---- root 1: the test harnesses

describe("root 1: the test harnesses", () => {
  it("the bare task flow (createHarness): only what a test gives it", () => {
    const h = createHarness();
    pin("harness/createTaskFlow", rowOf(h.deps, {}));
  });

  it("the core runtime over the fake world (the 14 createCoreRuntime tests): the engine stamp, start checks and cost-report events, no job service of its own", async () => {
    const world = createFakeWorld();
    const app = createCoreHostApp({
      modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
      runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined,
        services: () => Object.fromEntries(REQUIRED_CORE_SERVICES.map((name) => [name, { pass: async () => ({}) }])), ciReporting: { honest: true as const, ciMode: () => "their_ci_fix" as const } }),
    });
    const runtime = await app.runtimeFor(FAKE_COMPANY);
    pin("core-runtime/fake-world", rowOf(runtime.flow.deps, runtime.services));
  });
});

// ---- root 2: the laptop

describe("root 2: the laptop (rovara up)", () => {
  const roots: string[] = [];
  afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });
  const launch = async (environment: NodeJS.ProcessEnv) => {
    const root = await mkdtemp(join(tmpdir(), "rovara-f4-parity-"));
    roots.push(root);
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const runtime = await startLocalRuntime({ stateDirectory, cwd: join(root, "project"), environment, gh: async () => undefined, workerImage: "worker:test", docker: new FakeDocker(), version: "9.9.9",
      machines: new FakeWorkerMachines({ startingChecks: 0 }), timers: false, storage: "memory", openBrowser: async () => undefined });
    try {
      // The parts of the app a laptop has (its "services": what the hosted root calls job services).
      return rowOf(runtime.app.flow.deps, runtime.app, []);
    } finally { await runtime.stop(); }
  };

  it.each([
    ["laptop/default", {}],
    ["laptop/run-limit-off", { ROVARA_RUN_LIMIT: "0" }],
    ["laptop/steer-and-notes-off", { ROVARA_LIVE_STEER: "0", ROVARA_STEP_NOTES: "0" }],
  ] as const)("%s", async (name, environment) => {
    pin(name, await launch({ ...environment }));
  }, 120_000);
});

// ---- root 3: the hosted broker

const A = FAKE_COMPANY as OrgId;
const secret = Buffer.alloc(32, 7);
const gateway = { ROVARA_CORE_MODEL_GATEWAY_URL: "https://gateway.example", ROVARA_CORE_AGENT_MODEL: "claude-sonnet-4-6" };
const tokens = { taskTokens: () => ({ signer: taskKeySigner(signerOf(makeKey("t".repeat(16)))), issuer: "https://api.example/v1/auth" }) };
const SERVICES = () => Object.fromEntries(["merge-tracking", "session-sweep", "notify-deliver", "admission-hold-sweep"].map((name) => [name, { pass: async () => ({}) }]));

describe("root 3: the hosted broker (createBrokerCoreRoot): the input variants the review named", () => {
  const rootWith = (env: NodeJS.ProcessEnv, extra: Partial<BrokerCoreRootInputs> = {}) => {
    const world = createFakeWorld();
    world.clock.now = Date.now();
    // Where the model gateway is configured the root builds the hosted security modules itself (the model keys among them), so the fake world gives it only the points those do not fill.
    const gatewayOn = env["ROVARA_CORE_MODEL_GATEWAY_URL"] !== undefined;
    adapters.modules = gatewayOn ? world.modules.filter((module) => ["storage", "queue", "worker-machines", "object-storage", "code-host", "check-runner", "secrets"].includes(module.point)) : world.modules;
    adapters.security = gatewayOn;
    const client = { async send(command: unknown) {
      if (!(command instanceof GetCommand)) throw new Error("unexpected write");
      return { Item: undefined };
    } };
    return createBrokerCoreRoot({
      env, documentClient: client, stateTableName: "state", signInTableName: "signin", callbackSigningKey: secret.toString(), repositoryGrantKey: secret,
      codeModules: () => ({}) as never, repositoryCredential: async () => { throw new Error("unused"); }, origin: () => "https://api.example", log: () => undefined,
      now: () => new Date(world.clock.now), ciReporting: { honest: true, ciMode: async () => "sandbox_only" as const },
      services: gatewayOn
        ? (companyId, flow, registry, wiring) => createBrokerCoreServices({ companyId, flow, registry, ciMode: wiring.ciMode!, now: () => new Date(world.clock.now), taskPeople: { documentClient: { send: async () => ({}) }, tableName: "state" } })
        : SERVICES,
      ...extra,
    });
  };
  const lessonsPeople = (): Partial<BrokerCoreRootInputs> => ({ lessonsPeople: createHostedLessonsPeople({ documentClient: { send: async () => ({}) }, stateTableName: "state", signInTableName: "signin", now: () => 0 }) });
  const chatThreads = { companyOf: () => A, adapterFor: () => undefined, channels: [] } as never;
  const linearIntake = { connections: { connection: async () => undefined, accessToken: async () => "never-used" } } as never;
  const built = async (name: string, root: ReturnType<typeof rootWith>): Promise<CoreRuntime> => {
    const runtime = await root.app.runtimeFor(A);
    pin(`hosted-broker/${name}`, rowOf(runtime.flow.deps, runtime.services));
    // The deps object keeps its identity (pr-feedback-routes keys its routes by it), and its routes exist.
    expect(await root.app.runtimeFor(A)).toBe(runtime);
    expect(hostedPrFeedbackRoutes(runtime.flow.deps), `${name}: hostedPrFeedbackRoutes(deps)`).toBeDefined();
    return runtime;
  };

  it("base: no lessons people, no Linear, no chat, no system runs, no model gateway", async () => { await built("base", rootWith({})); });
  it("lessons on (ROVARA_CORE_LESSONS=on with the hosted people port)", async () => { await built("lessons", rootWith({ ROVARA_CORE_LESSONS: "on" }, lessonsPeople())); });
  it("lessons on without the people port (reported once, not built)", async () => { await built("lessons-switch-without-people", rootWith({ ROVARA_CORE_LESSONS: "on" })); });
  it("lessons and Linear intake: the task log and the ticket write-back", async () => { await built("lessons-linear", rootWith({ ROVARA_CORE_LESSONS: "on" }, { ...lessonsPeople(), linearIntake })); });
  it("lessons and chat threads: the thread handler and thread moments", async () => { await built("lessons-chat-threads", rootWith({ ROVARA_CORE_LESSONS: "on" }, { ...lessonsPeople(), chatThreads })); });
  it("chat threads without lessons", async () => { await built("chat-threads-without-lessons", rootWith({}, { chatThreads })); });
  it("system runs flag on (ROVARA_CORE_SYSTEM_RUNS=on)", async () => { await built("system-runs", rootWith({ [SYSTEM_RUNS_VARIABLE]: "on" })); });
  it("model gateway configured", async () => { await built("model-gateway", rootWith(gateway, tokens)); });
  it("model gateway and the company's model choice: the outbox is wrapped, and its relay asks the choice first", async () => {
    const offered = createFakeOfferedModels();
    const root = rootWith({ ...gateway, ROVARA_CORE_AGENT_MODEL_CHOICE: "on" }, { ...tokens, offeredModels: offered });
    const runtime = await built("model-gateway-model-choice", root);
    expect(offered.asked).toEqual([]);
    await runtime.flow.deps.outbox.relay({ companyId: A });
    // The wrapped relay read the company's offered models before it relayed anything (hosted: core-engine-root.ts flow.deps.outbox wrap).
    expect(offered.asked).toEqual([A]);
  });
  it("a throw while the second review feature is built refuses the company's runtime (never a silent 'feature off'), is not cached, and the next ask builds it", async () => {
    const logs: Array<Record<string, unknown>> = [];
    const root = rootWith({}, { log: (entry) => { logs.push(entry); } });
    reviewers.failing = true;
    try {
      await expect(root.app.runtimeFor(A)).rejects.toThrow("the reviewers are down");
      await expect(root.app.runtimeFor(A)).rejects.toThrow("the reviewers are down");
    } finally { reviewers.failing = false; }
    // Today the root itself logs nothing about the refused runtime (the callers that ask for it answer for it).
    expect(logs).toEqual([]);
    const runtime = await root.app.runtimeFor(A);
    expect(runtime.flow.deps.secondReview).toBeDefined();
  });
  it("everything on at once", async () => { await built("everything", rootWith({ ROVARA_CORE_LESSONS: "on", [SYSTEM_RUNS_VARIABLE]: "on", ...gateway, ROVARA_CORE_AGENT_MODEL_CHOICE: "on" }, { ...tokens, ...lessonsPeople(), linearIntake, chatThreads, offeredModels: createFakeOfferedModels() })); });
});

// ---- root 4: the dispatcher

describe("root 4: the dispatcher (createDispatcherCoreHost)", () => {
  const env = (overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
    CORE_DISPATCH_QUEUE_URL: "https://sqs.us-west-2.amazonaws.com/111122223333/agentx-staging-core-dispatch",
    CORE_DISPATCH_DEAD_LETTER_URL: "https://sqs.us-west-2.amazonaws.com/111122223333/agentx-staging-core-dispatch-dead", STATE_TABLE_NAME: "State",
    ARTIFACT_BUCKET_NAME: "artifacts", AWS_REGION: "us-west-2", EC2_WORKER_SUBNETS: "us-west-2a=subnet-0aaaaaaaaaaaaaaaa", EC2_WORKER_LAUNCH_TEMPLATE_ID: "lt-0123456789abcdef0", ...overrides,
  });
  const owed = new Set<string>(["admission", "metering", "identity", "approvers", "audit-sink", "model-keys"]);
  const build = async (environment: NodeJS.ProcessEnv, extra: Partial<DispatcherCoreInputs> = {}) => {
    adapters.modules = undefined;
    const world = createSessionMachinesWorld();
    const built = createDispatcherCoreHost({
      env: environment, callbackSigningKey: "k".repeat(48), documentClient: world.db, clients: { dynamo: new FakeDynamoDb({ tableName: "State" }), sqs: new FakeSqs(), s3: new FakeS3({ bucket: "artifacts" }) },
      machines: { sessions: world.sessions, stopInstance: dispatcherStopInstance, sign: (message: Uint8Array) => world.sign(message), post: async () => ({ status: 500, body: "" }), ping: async () => undefined, verifyMachine: async () => ({ ok: true }) },
      changeVisibility: async () => undefined, log: () => undefined, now: () => new Date(),
      extraModules: createFakeWorld().modules.filter((module) => owed.has(module.point)),
      flow: { standingInstructions: null, modelAccess: null, learned: null },
      ...extra,
    });
    const runtime = await built.app.runtimeFor(COMPANY_A);
    // What a batch really runs on: the host's own `depsFor` (the flow's deps for the batch's queue, plus the system-runs gate the host sets).
    const queues = runtime.flow.deps.queues;
    const batch = await dispatch.captured!.depsFor(COMPANY_A, queues);
    return { runtime, batch };
  };
  const money: Partial<DispatcherCoreInputs> = { moneyStop: () => ({ gate: async () => undefined }) as never, taskCapUsd: () => async () => 5 };

  it("no flow inputs and none of the money inputs", async () => {
    const { runtime, batch } = await build(env());
    pin("dispatcher/declared-none", rowOf(runtime.flow.deps, runtime.services));
    pin("dispatcher/declared-none/batch-deps", rowOf(batch, runtime.services));
    expect(batch.outbox).not.toBe(runtime.flow.deps.outbox);
  });
  it("with the per-run money stop and the task cap, as the deployed dispatcher passes them", async () => {
    const { runtime, batch } = await build(env(), money);
    pin("dispatcher/money-inputs", rowOf(runtime.flow.deps, runtime.services));
    pin("dispatcher/money-inputs/batch-deps", rowOf(batch, runtime.services));
  });
  it("with lessons declared for the company (ROVARA_CORE_LESSONS=on and a reader)", async () => {
    const environment = env({ ROVARA_CORE_LESSONS: "on" });
    const { runtime } = await build(environment, { flow: () => hostedDispatcherFlow(environment, async () => ({})) });
    pin("dispatcher/lessons-declared", rowOf(runtime.flow.deps, runtime.services));
  });
  it("with the model gateway route configured", async () => {
    const environment = env({ ...gateway });
    const withRoute = await build(environment, { flow: () => hostedDispatcherFlow(environment) });
    pin("dispatcher/model-route-declared", rowOf(withRoute.runtime.flow.deps, withRoute.runtime.services));
  });
});
