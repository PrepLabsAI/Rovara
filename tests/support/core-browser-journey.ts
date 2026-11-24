import type { CoreRuntime } from "../../packages/broker/src/core-host/core-runtime.js";
// Native journeys share the State table and bucket across core and hosted routes.
// Sign-in stays in a separate physical fake table; lifecycle verdicts always come from core.
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { E2EPolicySchema, createCandidateManifest, isSafeE2ESourcePath, projectPk, WORKER_INVOKE_AUTHORIZATION_SCHEME, workerInvokeToken, workerInvokeTokenPayload, type E2ESourceSnapshot, type WorkerInvocation, type DeveloperTaskView, type E2EScenarioResults } from "@agentx/contracts";
import { locateWorkspace } from "../../packages/broker/src/core/task-flow/workspace-location.js";
import { e2eRegisteredRuntimeKey } from "../../packages/broker/src/aws/e2e-runtime-readiness.js";
import { createDockerApplicationHost, createProcessDockerCli } from "@agentx/verifier";
import { OperationJournal } from "../../packages/worker/src/journal.js";
import { createWorkerServerState, handleWorkerRequest } from "../../packages/worker/src/server.js";
import { createWorkerCallbackSinks } from "../../packages/worker/src/callback-client.js";
import { createDefaultPiSessionAdapter } from "../../packages/worker/src/pi-session.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";
import { postWorkerTerminalResult } from "../../packages/worker/src/terminal-callback.js";
import { workflowE2EApplicationHostDeps, type WorkflowE2EApplicationRuntimeConfig } from "../../packages/worker/src/workflow-e2e-application-runtime.js";
import type { WorkflowE2EApplicationRuntime } from "../../packages/worker/src/workflow-e2e-application-checks.js";
import { WEB_API_BUILD_IMAGE } from "../../packages/verifier/src/host/docker-application-host.js";
import { ciImage } from "./ci-images.js";
import { call } from "./slack-broker.js";
import { collectOnThisHost } from "./linux-web-api-probes.js";
import { planAnswer, planDocument } from "./plan-documents.js";
import { planningContextUnavailableMessage } from "./planning-context-error.js";
import { FAUX_MODEL, fauxModelRuntime } from "./faux-model.js";
import { PROFILE, shaCanonical, webApiRow, binding as runtimeBinding } from "./e2e-application-plan-fixtures.js";
import type { buildFeatureE2EPlanningContext } from "../../packages/broker/src/e2e/feature-plan-planning-context.js";
import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import * as dynamo from "@aws-sdk/client-dynamodb";
import { FakeDynamoDb as WireDynamo } from "./ports/dynamodb-fake.js";
import { IMPLICIT_COMPANY_ID, ProjectDefinitionSchema, canonicalJson, orgProjectCatalogKey, projectRevisionKey, type DocumentStore, type JsonValue, type OrgId, type ProjectDefinition } from "@agentx/contracts";
import { DynamoDocumentStore } from "../../packages/aws-adapters/src/dynamodb/document-store.js";
import { S3ObjectStorage } from "../../packages/aws-adapters/src/s3/index.js";
import { developerTaskRouteDependencies, type DeveloperApiConfiguration } from "../../packages/broker/src/aws/developer-routes.js";
import { codeSettingsReader } from "../../packages/broker/src/aws/project-code-settings.js";
import { linearAppIntakeDeliver } from "../../packages/broker/src/aws/linear-app-intake.js";
import type { LinearAppSettings, LinearConnections } from "../../packages/broker/src/aws/linear-connections.js";
import { createBrokerCoreServices } from "../../packages/broker/src/aws/core-job-services.js";
import { createBrokerCoreRoot, membershipWithRoleFromDynamo, hostedDisplayNameOf, type BrokerCoreRoot } from "../../packages/broker/src/aws/core-engine-root.js";
import { stateTableIndexes } from "../../packages/broker/src/core-host/code-modules.js";
import type { CoreAdapterModule } from "../../packages/broker/src/core-host/registry.js";
import type { ApplicationE2ESeams } from "../../packages/broker/src/core/e2e/application-seams.js";
import { companyMembershipFromDynamo } from "../../packages/broker/src/aws/company-check.js";
import { githubLinkReaderOver } from "../../packages/broker/src/core/people/github-links.js";
import { createHostedIdentity } from "../../packages/broker/src/core-host/hosted-modules.js";
import { approvalProofKeyOf, createHostedApprovers } from "../../packages/broker/src/core-host/hosted-approvers.js";
import { FakeChannelAdapter } from "../../packages/broker/src/ports/fake-channel-adapter.js";
import { createNoticeService, createSessionService } from "../../packages/broker/src/services/index.js";
import { createTaskFactsSource } from "../../packages/broker/src/local/app/facts.js";
import { recordTaskThread } from "../../packages/broker/src/core/channel/threads.js";
import { createFakeWorld, FAKE_COMPANY, type FakeWorld, type FakeWorldOptions } from "./core-host-fakes.js";
import { createPriceTableMetering } from "../../packages/broker/src/ports/policy-defaults.js";
import { createDeveloperTaskBroker, MAYA, OMAR, type memoryS3 } from "./developer-task-broker.js";
import type { FakeDynamoDb } from "./fake-dynamodb.js";

const adapters = vi.hoisted(() => ({ modules: [] as CoreAdapterModule[] }));
vi.mock("../../packages/broker/src/core-host/code-modules.js", async (original) => ({ ...await original<object>(), codeAdapterModules: () => adapters.modules }));
vi.mock("../../packages/broker/src/core-host/hosted-modules.js", async (original) => ({ ...await original<object>(), hostedSecurityModules: () => [] }));

export const JOURNEY_COMPANY = FAKE_COMPANY as OrgId;
/** The price-table entry that prices the fixture planner's usage report (the fake world's table is empty, and an unpriced usage leaves the task's spend unknown). */
const PLANNER_PROVIDER = "anthropic";
const PLANNER_MODEL_ID = "journey-planner";
const PLANNER_MODEL_KEY = `${PLANNER_PROVIDER}/${PLANNER_MODEL_ID}`;
/** What the fixture's models cost: the planner's report, and the scripted coding model's, whose unpriced usage would stop the run as unknown spend. */
const PRICE = { inputMicrosPerMillionTokens: 3_000_000, outputMicrosPerMillionTokens: 15_000_000 } as const;
export const FOREIGN_COMPANY = "org_corehost00000000000b" as OrgId;
/** The shared internal ports used by parallel parts, never a public API or a substitute verdict. */
export type JourneyApplicationPorts = ApplicationE2ESeams;

/** Both State SDK interfaces address one wire-level fake; sign-in is distinct. The legacy map is only a read projection. */
function wireClient(db: FakeDynamoDb) {
  const wire = new WireDynamo({ tableName: "state", indexes: stateTableIndexes() });
  const signInWire = new WireDynamo({ tableName: "signin" });
  wire.joinTransactions(signInWire);
  const tableForSeed = (item: Record<string, unknown>) => String(item.pk).startsWith("COMPANY_MEMBER#") || String(item.pk).startsWith("SESSION#") || item.pk === "SIGNIN_CLIENTS" || (String(item.pk).startsWith("DEVELOPER#") && item.sk === "META") ? signInWire : wire;
  const originalSet = db.set.bind(db);
  const originalDelete = db.delete.bind(db);
  for (const item of db.items.values()) tableForSeed(item).seed(marshall(item, { removeUndefinedValues: true }));
  for (const table of [wire, signInWire]) table.onStream((record) => {
    if (record.dynamodb?.NewImage !== undefined) originalSet(unmarshall(record.dynamodb.NewImage));
    else if (record.dynamodb?.Keys !== undefined) {
      const key = unmarshall(record.dynamodb.Keys);
      originalDelete(String(key.pk), String(key.sk));
    }
  });
  db.set = (item) => { tableForSeed(item).seed(marshall(item, { removeUndefinedValues: true })); originalSet(item); };
  const encode = (input: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(input).map(([key, value]) => {
    if (["Key", "Item", "ExclusiveStartKey", "ExpressionAttributeValues"].includes(key)) return [key, marshall(value as Record<string, unknown>, { removeUndefinedValues: true })];
    if (key === "TransactItems") return [key, (value as Array<Record<string, Record<string, unknown>>>).map((item) => Object.fromEntries(Object.entries(item).map(([kind, action]) => [kind, encode(action)])))];
    return [key, value];
  }));
  db.send = async (command) => {
    const name = command.constructor.name.replace("TransactWriteCommand", "TransactWriteItemsCommand").replace(/^(Get|Put|Update|Delete)Command$/u, "$1ItemCommand");
    const constructors = dynamo as unknown as Record<string, new (input: unknown) => Parameters<typeof wire.send>[0]>;
    const Constructor = constructors[name];
    if (Constructor === undefined) throw new Error(`unsupported SDK command ${name}`);
    const table = command.input.TableName === "signin" ? signInWire : wire;
    const response = await table.send(new Constructor(encode(command.input))) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(response).map(([key, value]) => {
      if (value !== undefined && ["Item", "Attributes", "LastEvaluatedKey"].includes(key)) return [key, unmarshall(value as Record<string, dynamo.AttributeValue>)];
      if (key === "Items") return [key, (value as Array<Record<string, dynamo.AttributeValue>>).map((item) => unmarshall(item))];
      return [key, value];
    }));
  };
  return wire;
}

export interface CoreBrowserBrokerOptions {
  definition?: ProjectDefinition;
  brokerExtra?: Record<string, unknown>;
  developerExtra?: Partial<DeveloperApiConfiguration>;
  /** The journeys' real-core proof (tests/journeys/harness/core-proof.ts): a wrapper the broker is given instead of the root, to record which requests the core answered. The returned harness keeps the real root. */
  wrapCore?: (root: BrokerCoreRoot) => BrokerCoreRoot;
  /** The deployed job services (merge tracking, session sweep, notice delivery: `createBrokerCoreServices`) instead of this fixture's stand-ins, so a journey can run the jobs a deployment's schedules run. */
  realJobServices?: boolean;
  /** Options of the fake world (its admission, machines, ...), for a journey that needs the deployment's admission to refuse. */
  world?: FakeWorldOptions;
  /**
   * Linear on the hosted root (aws/linear-wiring.ts's pieces): the connections over the broker's table, the company's connect and link routes, the Linear app webhook route on the broker's front and the
   * tracker intake from each company's own runtime. Built with a lazy table client and the world's clock, because both exist only once the broker is built.
   */
  linear?: (ports: { db: { send(command: unknown, options?: unknown): Promise<unknown> }; now: () => number }) => CoreBrowserLinear;
}

export interface CoreBrowserLinear {
  connections: LinearConnections;
  app: () => Promise<LinearAppSettings | undefined>;
  fetch: typeof fetch;
  log: (entry: Record<string, unknown>) => void;
}

/** A contract-only base cannot run a baseline; runnable results fixtures retain the product default. */
export function journeyProjectDefinition(definition: ProjectDefinition, runnableBaseline: boolean): ProjectDefinition {
  return runnableBaseline ? definition : ProjectDefinitionSchema.parse({ ...definition, developerTasks: { ...definition.developerTasks, e2eBaselineRound: false } });
}

type DeveloperTaskBrokerHarness = Awaited<ReturnType<typeof createDeveloperTaskBroker>>;
export interface CoreBrowserBrokerHarness extends DeveloperTaskBrokerHarness { core: BrokerCoreRoot; world: FakeWorld; runtime: CoreRuntime; channel: FakeChannelAdapter }

export async function createCoreBrowserBroker(options: CoreBrowserBrokerOptions = {}): Promise<CoreBrowserBrokerHarness> {
  let core: BrokerCoreRoot | undefined;
  let world: FakeWorld | undefined;
  const channel = new FakeChannelAdapter();
  // Linear's pieces need the table client and the core's store, which exist only inside the broker's own construction below: they are reached through these.
  let tableRef: { send(command: unknown, options?: unknown): Promise<unknown> } | undefined;
  let storeRef: DocumentStore | undefined;
  const lazyTable = { send: (command: unknown, sendOptions?: unknown) => tableRef!.send(command, sendOptions) };
  const lazyStore = new Proxy({} as DocumentStore, { get: (_target, field) => { const value = (storeRef as unknown as Record<PropertyKey, unknown>)[field]; return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(storeRef) : value; } });
  const linear = options.linear?.({ db: lazyTable, now: () => world?.clock.now ?? Date.now() });
  const linearDeveloper = (linear === undefined ? {} : {
    companies: companyMembershipFromDynamo(lazyTable, "signin"),
    linearConnect: { connections: linear.connections, app: linear.app, fetch: linear.fetch, log: linear.log, links: lazyStore },
    linearLink: { connections: linear.connections, links: lazyStore, app: linear.app, fetch: linear.fetch, log: linear.log },
  }) as Partial<DeveloperApiConfiguration>;
  const linearBroker: Record<string, unknown> = linear === undefined ? {} : {
    linearWebhook: { connections: linear.connections, app: linear.app, now: () => world?.clock.now ?? Date.now(), log: linear.log,
      deliver: linearAppIntakeDeliver({ connections: linear.connections, app: linear.app, intakeFor: async (companyId) => core?.intake?.intakeFor(companyId), fetch: linear.fetch, log: linear.log }) },
  };
  const harness = await createDeveloperTaskBroker({ register: false,
    ...(options.developerExtra === undefined && linear === undefined ? {} : { developerExtra: { ...options.developerExtra, ...linearDeveloper } }),
    ...(options.brokerExtra === undefined && linear === undefined ? {} : { brokerExtra: { ...options.brokerExtra, ...linearBroker } }),
    coreRoot: ({ db, s3, callbackSigningKey }) => {
      const store = new DynamoDocumentStore({ client: wireClient(db), tableName: "state", indexes: stateTableIndexes(), retryBaseMs: 1 });
      tableRef = db;
      storeRef = store;
      const objects = new S3ObjectStorage({ client: { send: (command) => s3.send(command as Parameters<typeof s3.send>[0]) }, bucket: "artifacts" });
      world = createFakeWorld({ store, objects, ...options.world });
      world.clock.now = Date.now();
      const identity = createHostedIdentity({ membershipOf: membershipWithRoleFromDynamo(db, "signin"), displayNameOf: hostedDisplayNameOf(db, "signin"), githubLinks: githubLinkReaderOver(store) });
      adapters.modules = world.modules.map((module) => module.point === "identity" ? { ...module, create: () => identity } : module.point === "metering" ? { ...module, create: () => createPriceTableMetering({ currency: "USD", models: { [PLANNER_MODEL_KEY]: PRICE, [`${FAUX_MODEL.provider}/${FAUX_MODEL.modelId}`]: PRICE } }) } : module.point === "approvers" ? { ...module, create: () => createHostedApprovers({ store, identity, key: approvalProofKeyOf(callbackSigningKey), now: () => new Date(world!.clock.now) }) } : module);
      core = createBrokerCoreRoot({ ...(linear === undefined ? {} : { linearIntake: { connections: linear.connections, fetch: linear.fetch } }), env: { AGENTX_E2E_FEATURE_RUNTIME_CATALOG_ID: typeof options.brokerExtra?.["e2eFeatureRuntimeCatalogId"] === "string" ? options.brokerExtra["e2eFeatureRuntimeCatalogId"] : "catalog" }, documentClient: db, stateTableName: "state", signInTableName: "signin", codeSettings: codeSettingsReader({ documentClient: db, tableName: "state" }), callbackSigningKey,
        ...(options.brokerExtra?.["projectSetupSource"] === undefined ? {} : { applicationSource: async (repositoryUrl, ref) => (options.brokerExtra!["projectSetupSource"] as { capture(input: { repositoryUrl: string; ref: string }): Promise<E2ESourceSnapshot> }).capture({ repositoryUrl, ref }) }),
        repositoryGrantKey: Buffer.alloc(32, 4), repositoryCredential: async () => ({ token: "synthetic-local-host-token" }),
        codeModules: () => ({}) as never, origin: () => "https://api.example.test", log: () => undefined, now: () => new Date(world!.clock.now),
        taskRules: (person, companyId) => ({ ...developerTaskRouteDependencies({ documentClient: db, tableName: "state", developer: signIn!, companies: companyMembershipFromDynamo(db, "signin"), now: Date.now }, { developerId: person.developerId, sessionId: "core", name: person.name, amr: "oidc" }, undefined, null), companyId }),
        ciReporting: { honest: true, ciMode: async () => "sandbox_only" as const },
        chatThreads: { channels: ["examplechat"], companyOf: ({ tenant }) => tenant === "journey-team" ? JOURNEY_COMPANY : undefined, adapterFor: (company, name) => company === JOURNEY_COMPANY && name === "examplechat" ? channel : undefined },
        services: (companyId, flow, registry, wiring) => {
          const clock = () => new Date(world!.clock.now);
          // 27c (8c288c790): the job services read the merge requesters from the task People list and refuse to build without that source; the same state table the deployed broker gives it.
          if (options.realJobServices === true) return createBrokerCoreServices({ companyId, flow, registry, ciMode: wiring.ciMode!, now: clock, taskPeople: { documentClient: db, tableName: "state" } });
          const notices = createNoticeService({ store, registry: wiring.notification?.registry ?? registry, now: clock, ...wiring.notification,
            e2e: async (session) => {
              const task = await store.get({ pk: `DEVTASK#${(session.subject.kind === "task" ? session.subject.taskId : "")}`, sk: "META" }) as unknown as Parameters<JourneyApplicationPorts["results"]["notice"]>[0] | undefined;
              return task === undefined ? undefined : await flow.deps.applicationE2E?.results.notice(task);
            } });
          const sessions = createSessionService({ store, facts: createTaskFactsSource(flow.deps), cost: { costUsd: async () => 0 }, notices, now: clock });
          return { "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async ({ budgetMs }) => ({ ...await sessions.sweep({ companyId, budgetMs }) }) }, "notify-deliver": { pass: async ({ budgetMs }) => ({ ...await notices.deliver({ companyId, deadlineMs: world!.clock.now + budgetMs }) }) } };
        },
      });
      return options.wrapCore === undefined ? core : options.wrapCore(core);
    },
  });
  const signIn = harness.brokerInput.developer;
  if (core === undefined || world === undefined) throw new Error("core journey composition missing");
  for (const [person, company] of [[MAYA, JOURNEY_COMPANY], [OMAR, FOREIGN_COMPANY]] as const) {
    harness.db.set({ ...harness.db.get(`DEVELOPER#${person.developerId}`, "META"), pk: `DEVELOPER#${person.developerId}`, sk: "META", entityType: "DEVELOPER", revoked: false });
    harness.db.set({ pk: `COMPANY_MEMBER#${person.developerId}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: person.developerId, companyId: company, role: "member", joinedAt: "2026-11-01T00:00:00.000Z" });
    harness.db.set({ pk: `ORG#${company}#MEMBER#${person.developerId}`, sk: "PROJECT#payments", entityType: "MEMBERSHIP", ownerKey: person.developerId, projectName: "payments", grantId: randomUUID(), role: "developer", companyId: company });
  }
  const definition: ProjectDefinition = options.definition ?? { name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Implement the approved plan.", repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }] };
  const runtime = await core.app.runtimeFor(JOURNEY_COMPANY);
  await runtime.flow.deps.store.put({ item: { ...projectRevisionKey(JOURNEY_COMPANY, definition.name, definition.revision), entityType: "PROJECT", runtimeBinding, definition: JSON.parse(canonicalJson(definition)) as JsonValue } });
  await runtime.flow.deps.store.put({ item: { ...orgProjectCatalogKey(JOURNEY_COMPANY, definition.name), entityType: "PROJECT_CATALOG", latestRevision: definition.revision } });
  return { ...harness, core, world, runtime, channel };
}

/** Use the actual decision card and its digest; never manufacture approval/workflow rows. */
export async function approveJourneyPlan(harness: Awaited<ReturnType<typeof createCoreBrowserBroker>>, taskId: string) {
  const listed = await harness.client("web", MAYA, "GET", "/v1/app/decisions");
  if (listed.status !== 200) throw new Error(`decision list HTTP ${listed.status}`);
  const cards = listed.body.cards as Array<{ id: string; taskId?: string; risk: string }>;
  const card = cards.find((item) => item.taskId === taskId);
  if (card === undefined) throw new Error("no pending plan card for this task");
  const shownDigest = (listed.body.digests as Record<string, string>)[card.id];
  const path = card.id.replace(":", "/");
  const opened = card.risk === "medium" ? await harness.client("web", MAYA, "POST", `/v1/app/decisions/${path}/evidence-opened`, { shownDigest, requestId: randomUUID() }) : { status: 200 };
  if (opened.status !== 200) throw new Error(`evidence-opened HTTP ${opened.status}`);
  const approved = await harness.client("web", MAYA, "POST", `/v1/app/decisions/${path}/approve`, { shownDigest, requestId: randomUUID() });
  if (approved.status !== 200) throw new Error(`plan approval HTTP ${approved.status}`);
}

export type JourneyObjects = ReturnType<typeof memoryS3>;

/** Drain core's own outbox/recovery/dispatch; fake compute reports readiness, never rewrites operation rows. */
export async function takeCoreInvocation(harness: Awaited<ReturnType<typeof createCoreBrowserBroker>>, workspaceId: string, mode: string, after?: string | ReadonlySet<string>) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await harness.runtime.flow.sweepOnce();
    await harness.runtime.flow.relayOnce();
    await harness.runtime.flow.dispatchOnce({ waitSeconds: 0 });
    const rows = harness.db.find((row) => row.entityType === "OPERATION" && row.workspaceId === workspaceId && typeof row.machineId === "string");
    for (const row of rows) {
      const found = harness.world.machines.delivered(String(row.machineId)).find((invocation) => !(typeof after === "string" ? invocation.operationId === after : after?.has(invocation.operationId) === true) && (mode === "prepare" ? invocation.kind === "prepare" : mode === "publish" ? invocation.kind === "publish" : invocation.kind === "task" && invocation.payload.workflowMode === mode));
      if (found !== undefined) return { invocation: found, machineId: String(row.machineId) };
    }
    harness.world.clock.advance(5);
  }
  // Say what the core did instead (no fixture lifecycle rows are ever inserted to make a step appear): where the workflow is, and what its operations are.
  const task = harness.db.find((row) => row.entityType === "DEVELOPER_TASK" && row.workspaceId === workspaceId)[0] as { workflow?: { stage?: string; state?: string; blockReason?: string }; planUnreadable?: { errors?: unknown } } | undefined;
  const operations = harness.db.find((row) => row.entityType === "OPERATION" && row.workspaceId === workspaceId).map((row) => `${String(row.workflowMode ?? row.kind)}:${String(row.status)}`).join(", ");
  const lastOperation = harness.db.find((row) => row.entityType === "OPERATION" && row.workspaceId === workspaceId).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).at(-1);
  const lastPrompt = (lastOperation?.dispatch as { payload?: { prompt?: unknown } } | undefined)?.payload?.prompt;
  const lastAsked = typeof lastPrompt === "string" ? lastPrompt.slice(-900) : undefined;
  throw new Error(`core did not dispatch ${mode}; no fixture lifecycle rows were inserted. The workflow is at ${String(task?.workflow?.stage)}/${String(task?.workflow?.state)}${task?.workflow?.blockReason === undefined ? "" : ` (${task.workflow.blockReason})`}`
    + `${task?.planUnreadable === undefined ? "" : `; the last plan was unreadable: ${JSON.stringify(task.planUnreadable.errors)}`}; operations: ${operations}${lastAsked === undefined ? "" : `; the last operation was asked: ${lastAsked}`}`);
}

const EXECUTOR_IMAGE = process.env.ROVARA_EXECUTOR_IMAGE ?? "rovara-e2e-executor:ci";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8",
  env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" } }).trim();
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const observedDocker = (cli: ReturnType<typeof createProcessDockerCli>, observe: (args: string[]) => void): ReturnType<typeof createProcessDockerCli> => ({ run: (args, options) => { observe(args); return cli.run(args, options); } });

/** The collector compares the toolchain the executor reported (a Linux Node) with the process reading the result; a Mac differs in platform as well as path, a CI runner only in path. */
const collectLikeTheWorker: typeof collectOnThisHost = (input) => {
  if (process.platform === "linux") return collectOnThisHost(input);
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...platform, value: input.actual.runnerToolchain.platform });
  try { return collectOnThisHost(input); } finally { Object.defineProperty(process, "platform", platform); }
};


type PlanningContext = Extract<ReturnType<typeof buildFeatureE2EPlanningContext>, { status: "available" }>;
/** What a journey varies: the fixture app whose files the repository holds, the task, and the plan the planner writes for it. */
export type JourneyInput = Readonly<{ fixtureRoot: string; planningFiles: readonly string[]; instructions: string;
  /** Called with the arguments of every docker command the worker's host issues, just before it runs (a test reads what a mount holds at that moment). */
  observeDocker?: (args: string[]) => void;
  /**
   * The baseline round (owner decision D2). Absent: the project is registered with it switched off (`developerTasks.e2eBaselineRound: false`), because the round is on by default and runs
   * right after the coding run as the first CHECKS operation, so a journey that counts rounds, or whose base commit holds no app, would see it as its round 1. Present: the project keeps it
   * on, and `stageBase` stages the app as the task starts (the unchanged code the baseline runs).
   */
  baseline?: { stageBase(root: string): Promise<string> };
  /** Task 3.4: the project also has the API runtime row READY (a profile registers a web row and an API row), so the plan can run API scenarios beside web ones. */
  apiRuntime?: boolean;
  plan(context: PlanningContext): { title: string; claims: Array<{ id: string; text: string }>; plannerIntent: object } | Promise<{ title: string; claims: Array<{ id: string; text: string }>; plannerIntent: object }> }>;


/**
 * PRODUCT GAP (B), ruled separately: the hosted core reads a project from its COMPANY partition (`projectRevisionKey(company, ...)`, aws/core-application-e2e.ts), but the only code that writes
 * `definition.e2e` is `registerProject`, which refuses an e2e policy for a named company (aws/broker.ts, NAMED_COMPANY_SETUP_APPROVAL_REFUSED) and, for the admin this harness signs in as (no developer
 * id, so no company), writes the LEGACY layout (`PROJECT#name`, the legacy catalog row, and the account registry under the implicit company). No product path puts a policy where the core reads it.
 * Until one exists, this seeds the company partition directly with what the legacy registration just stored: the revision (with its e2e policy, setup approval and runtime binding), the catalog
 * pointer, and the synthetic-account rows. It writes through the core's own store, so the core reads exactly what a company registration would leave. Delete this when (B) lands and register normally.
 */
async function seedCompanyPartitionFromLegacyRegistration(harness: Awaited<ReturnType<typeof createCoreBrowserBroker>>, project: string, revision: number): Promise<void> {
  const store = harness.runtime.flow.deps.store;
  const legacy = harness.db.get(`PROJECT#${project}`, `REV#${String(revision).padStart(12, "0")}`);
  if (legacy === undefined || (legacy.definition as { e2e?: unknown } | undefined)?.e2e === undefined) throw new Error("the legacy registration did not store the e2e revision");
  await store.put({ item: { ...legacy, ...projectRevisionKey(JOURNEY_COMPANY, project, revision) } });
  await store.put({ item: { ...orgProjectCatalogKey(JOURNEY_COMPANY, project), entityType: "PROJECT_CATALOG", latestRevision: revision } });
  const legacyAccountsPk = projectPk(IMPLICIT_COMPANY_ID, project);
  for (const row of harness.db.find((candidate) => candidate.pk === legacyAccountsPk && String(candidate.sk).startsWith("E2E_ACCOUNT"))) await store.put({ item: { ...row, pk: projectPk(JOURNEY_COMPANY, project) } as never });
}

/** A version 2 coding plan must name the files it changes and how it is tested, or the broker asks the planner again (plan/process.ts). The journeys' claims are about the scenarios, so the first one also names both. */
const withFilesAndTest = (claims: Array<{ id: string; text: string }>): Array<{ id: string; text: string }> =>
  claims.map((claim, index) => index === 0 ? { ...claim, text: `${claim.text} The change is in server.mjs and public/index.html, and tests/orders.test.ts covers it.` } : claim);

/**
 * The plan self-check (plan/process.ts) sends back a coding plan with a claim or a "Not changing" entry that no scenario or check proves. The journeys' claims are about their scenarios, so the plan
 * says its first scenario proves every claim and the one "Not changing" entry the plan document carries (`nc1`).
 */
const scenarioProvesOf = (claims: Array<{ id: string }>, intent: object): Record<string, string[]> => {
  const scenarios = (intent as { scenarios?: Array<{ scenarioId: string }> }).scenarios ?? [];
  return scenarios[0] === undefined ? {} : { [scenarios[0].scenarioId]: [...claims.map((claim) => claim.id), "nc1"] };
};

export async function startCoreBrowserJourney(journeyInput: JourneyInput, roots: string[]) {
    const input = journeyInput;
    const base = await realpath(process.env.CONTAINED_FOUNDATION_EVIDENCE_DIR ?? tmpdir());
    const root = await mkdtemp(join(await realpath(tmpdir()), "m1-3-journey-"));
    roots.push(root);
    const runBase = await mkdtemp(join(base, "m1-3-journey-runs-"));
    roots.push(runBase);
    const runRoot = join(runBase, "runs");
    await mkdir(runRoot, { mode: 0o700 });

    // The repository the project is about: one commit holding the app's project contract and the inventory service's OpenAPI document and mock fixture, which setup approval reads.
    const workerWorkspace = join(root, "worker-workspace");
    const repository = join(workerWorkspace, "repo", "demo");
    await mkdir(repository, { recursive: true });
    git(repository, "init", "--quiet", "--initial-branch=main");
    const planningFiles = [...input.planningFiles];
    // A journey that runs the baseline round (owner decision D2) starts from the whole app as the task starts, with its defects: that is the unchanged code the baseline runs. The others
    // start from the project contract alone, and say so to the broker by switching the baseline off (below), so each proves what it was written for.
    const baseApp = input.baseline === undefined ? undefined : await input.baseline.stageBase(root);
    if (baseApp !== undefined) await cp(baseApp, repository, { recursive: true });
    else for (const file of planningFiles) { await mkdir(join(repository, file, ".."), { recursive: true }); await cp(join(input.fixtureRoot, file), join(repository, file)); }
    git(repository, "add", ...(baseApp === undefined ? planningFiles : ["-A"]));
    git(repository, "commit", "--quiet", "-m", baseApp === undefined ? "project contract and what setup approval reads" : "the app as the task starts");
    git(repository, "remote", "add", "origin", "https://github.com/example/demo.git");
    const baseCommit = git(repository, "rev-parse", "HEAD");
    const baseTree = git(repository, "rev-parse", "HEAD^{tree}");
    const treeFiles = baseApp === undefined ? [...planningFiles].sort() : git(repository, "ls-files").split("\n").filter((path) => path !== "").sort();
    const sources = await Promise.all(treeFiles.filter((path) => isSafeE2ESourcePath(path)).map(async (path) => { const bytes = await readFile(join(repository, path));
      return { path, sha256: createHash("sha256").update(bytes).digest("hex"), bytes, kind: "blob" as const }; }));
    const snapshot: E2ESourceSnapshot = { candidate: createCandidateManifest([{ repositoryId: "example/demo", commitSha: baseCommit, treeSha: baseTree }]), commitSha: baseCommit, treeSha: baseTree,
      treeComplete: true, treePaths: treeFiles, sources };

    // The broker, with the project registered and its setup approved on the qualified web profile (one admin proposal, approval and registration, as `agentx admin` makes them).
    const harness = await createCoreBrowserBroker({ brokerExtra: { projectSetupSource: { capture: async () => snapshot }, e2eFeatureRuntimeCatalogId: "catalog", projectSetupRuntimeCatalogId: "setup-catalog" } });
    // Collecting a candidate confirms its starting commit with the code host (build-step/results.ts confirmStartingCommits). The fake host knows no commit of this journey's real local repository,
    // so it answers the journey's base commit with its tree (what the real host does) and refuses every other commit exactly as before.
    const hostTree = harness.world.host.tree.bind(harness.world.host);
    harness.world.host.tree = async (repository, revision, scope) => revision === baseCommit ? baseTree : hostTree(repository, revision, scope);
    const projectRow = () => harness.db.find((row) => row.pk === projectPk(JOURNEY_COMPANY, "payments") && row.entityType === "PROJECT" && (row.definition as { name?: string } | undefined)?.name === "payments")[0]!;
    const projectRuntimeBinding = projectRow().runtimeBinding as typeof runtimeBinding;
    const webRowKey = e2eRegisteredRuntimeKey("catalog", PROFILE, "web");
    const runner = JSON.parse(docker("run", "--rm", "--entrypoint", "node", EXECUTOR_IMAGE, "-p",
      "JSON.stringify({ os: process.platform + ' ' + require('os').release(), arch: process.arch, runtime: 'node ' + process.version, execPath: process.execPath, version: process.version, platform: process.platform })")) as
      { os: string; arch: string; runtime: string; execPath: string; version: "v22.23.2"; platform: string };
    const runnerEnvironment = { ci: true as const, trustNoticeShown: false as const, os: runner.os, arch: runner.arch, runtime: runner.runtime };
    const runnerToolchain = { execPath: runner.execPath, version: runner.version, platform: runner.platform, arch: runner.arch };
    harness.db.set({ ...webRowKey, ...webApiRow("web", { runnerEnvironment, runnerEnvironmentDigest: shaCanonical(runnerEnvironment), runnerToolchain, runnerToolchainDigest: shaCanonical(runnerToolchain) }),
      binding: projectRuntimeBinding, bindingDigest: shaCanonical(projectRuntimeBinding) });
    if (input.apiRuntime === true) {
      harness.db.set({ ...e2eRegisteredRuntimeKey("catalog", PROFILE, "api"), ...webApiRow("api", { runnerEnvironment, runnerEnvironmentDigest: shaCanonical(runnerEnvironment), runnerToolchain, runnerToolchainDigest: shaCanonical(runnerToolchain) }),
        binding: projectRuntimeBinding, bindingDigest: shaCanonical(projectRuntimeBinding) });
    }
    harness.db.set({ pk: "COMPANY_MEMBER#admin-subject", sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: "admin-subject", companyId: JOURNEY_COMPANY, role: "admin", joinedAt: "2026-11-01T00:00:00.000Z" });
    const admin = { subject: "admin-subject", admin: true };
    const proposalResponse = await call(harness.handler, { method: "POST", path: "/v1/admin/projects/setup-proposals", user: admin, body: { repositoryUrl: "https://github.com/example/demo.git", ref: "main" } });
    expect(proposalResponse.status, JSON.stringify(proposalResponse.body)).toBe(200);
    const proposalRef = String(proposalResponse.body.proposalRef);
    const proposalSha256 = String(proposalResponse.body.proposalSha256);
    const approval = await call(harness.handler, { method: "POST", path: "/v1/admin/projects/setup-approvals", user: admin, body: { projectName: "payments", proposalRef, proposalSha256, decision: "approve" } });
    expect(approval.status, JSON.stringify(approval.body)).toBe(200);
    const definition = projectRow().definition as Record<string, unknown> & { revision: number };
    const registration = await call(harness.handler, { method: "POST", path: "/v1/admin/projects", user: admin,
      body: { definition: journeyProjectDefinition({ ...definition, revision: definition.revision + 1, e2e: proposalResponse.body.policy } as unknown as ProjectDefinition, input.baseline !== undefined),
      runtimeBinding: projectRow().runtimeBinding, setupApproval: { proposalRef, proposalSha256, decision: "approve" } } });
    expect(registration.status, JSON.stringify(registration.body)).toBe(201);
    const policy = E2EPolicySchema.parse(proposalResponse.body.policy);
    await seedCompanyPartitionFromLegacyRegistration(harness, "payments", definition.revision + 1);

    // Plan and approve one web scenario for the owner account: open the page, ask for the stock status of an order, and the page must show what the inventory service says.
    const start = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: input.instructions, client: "m1-3-journeys", workflow: true, workflowPath: "QUICK" });
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    const taskId = String((start.body.task as { taskId: string }).taskId);
    const taskKey = { pk: `DEVTASK#${taskId}`, sk: "META" };
    const workspaceId = String((harness.db.get(taskKey.pk, taskKey.sk) as { workspaceId: string }).workspaceId);
    const location = await locateWorkspace(harness.runtime.flow.deps, workspaceId);
    if (location === undefined || location.scope !== "company") throw new Error("core workspace is not company-scoped");
    const workspacePk = location.workspaceKey.pk;
    const operationRows = (match: (row: Record<string, unknown>) => boolean) => harness.db.find((row) => row.pk === workspacePk && row.entityType === "OPERATION" && match(row));
    const callback = async (invocation: WorkerInvocation, action: string, body: unknown) => {
      const response = await call(harness.handler, { method: "POST", path: `/v1/internal/workspaces/${workspaceId}/operations/${invocation.operationId}/${action}`, headers: { "x-agentx-callback-capability": invocation.callbackCapability }, body });
      expect(response.status, `core ${action} callback: ${JSON.stringify(response.body)}`).toBe(200);
    };
    // Preparation is the external repository fixture's response; all lifecycle transitions are production core callbacks.
    await recordTaskThread({ store: harness.runtime.flow.deps.store, orgId: JOURNEY_COMPANY, now: () => harness.world.clock.now }, { sessionId: String(harness.db.get(taskKey.pk, taskKey.sk)?.sessionId), personId: MAYA.developerId, actor: { channel: "examplechat", tenant: "journey-team", userId: "maya" }, conversation: { channel: "examplechat", tenant: "journey-team", space: "orders", thread: taskId } });
    const preparation = await takeCoreInvocation(harness, workspaceId, "prepare");
    await callback(preparation.invocation, "result", { operationId: preparation.invocation.operationId, status: "SUCCEEDED", result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: baseCommit }] } });
    harness.world.machines.finish(preparation.machineId, preparation.invocation.operationId);
    // Every Understand, planning and plan-check step is a model run. Approving the plan starts paid work, which the hosted flow allows only while it can read the task's spend (a run that ended with
    // no usage booked leaves the spend unknown and the approval refused), so each of the fixture's model runs books one priced report through the real events callback, as the worker does.
    const bookUsage = (invocation: WorkerInvocation) => callback(invocation, "events", { events: [{ type: "usage", timestamp: new Date(harness.world.clock.now).toISOString(),
      payload: { schemaVersion: 1, outcome: "SUCCEEDED", provider: PLANNER_PROVIDER, modelId: PLANNER_MODEL_ID, cacheRetention: "short", tokens: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, total: 1200 }, cacheReadRatio: 0, costUsd: null } }] });
    // The hosted default starts a workflow task on workflow 1.1.0: Understand first, and only then the structured PLAN run that is offered the application planning context (a task on the rollback
    // path, `understandFirst: false`, plans in Markdown and is never offered it). The Understand run answers with its assessment, saved as `intent.json`.
    const understanding = await takeCoreInvocation(harness, workspaceId, "UNDERSTAND");
    await bookUsage(understanding.invocation);
    await callback(understanding.invocation, "artifacts", { name: "intent.json", mediaType: "application/json", content: JSON.stringify({ kind: "ready", path: "QUICK", restatement: input.instructions.slice(0, 400), assumptions: [] }) });
    await callback(understanding.invocation, "result", { operationId: understanding.invocation.operationId, status: "SUCCEEDED", result: { workflowMode: "UNDERSTAND" } });
    harness.world.machines.finish(understanding.machineId, understanding.invocation.operationId);
    const planning = await takeCoreInvocation(harness, workspaceId, "PLAN");
    const task = harness.db.get(taskKey.pk, taskKey.sk) as unknown as Parameters<JourneyApplicationPorts["planning"]["context"]>[0];
    const seams = harness.runtime.flow.deps.applicationE2E;
    if (seams === undefined) throw new Error("The production root must compose hosted applicationE2E; native fixtures never supply a fake admission/authority");
    const context = await seams.planning.context(task);
    if (context?.status !== "available") throw new Error(planningContextUnavailableMessage(context));
    const planned = await input.plan(context);
    await bookUsage(planning.invocation);
    await callback(planning.invocation, "artifacts", { name: "plan.md", mediaType: "text/markdown; charset=utf-8", content: planAnswer(planDocument({ title: planned.title, claims: withFilesAndTest(planned.claims), e2e: planned.plannerIntent as never, scenarioProves: scenarioProvesOf(planned.claims, planned.plannerIntent) })) });
    await callback(planning.invocation, "result", { operationId: planning.invocation.operationId, status: "SUCCEEDED", result: { workflowMode: "PLAN" } });
    harness.world.machines.finish(planning.machineId, planning.invocation.operationId);
    // Workflow 1.1.0 has the plan checked by a read-only critic before the owner sees it (the plan check, plan/check.ts). It answers with its verdict block; "ok" sends the plan on to the owner.
    const critique = await takeCoreInvocation(harness, workspaceId, "PLAN_CRITIQUE");
    await bookUsage(critique.invocation);
    await callback(critique.invocation, "artifacts", { name: "plan-critique.md", mediaType: "text/markdown; charset=utf-8", content: `I read the plan against the code.\n\n\`\`\`rovara-plan-critique\n${JSON.stringify({ verdict: "ok", points: [] })}\n\`\`\`\n` });
    await callback(critique.invocation, "result", { operationId: critique.invocation.operationId, status: "SUCCEEDED", result: { workflowMode: "PLAN_CRITIQUE" } });
    harness.world.machines.finish(critique.machineId, critique.invocation.operationId);
    const workflowNow = () => (harness.db.get(taskKey.pk, taskKey.sk) as { workflow: { revision: number; stage: string; state: string; blockReason?: string; artifacts: Array<{ sha256: string }>;
      candidate?: { digest: string }; e2e?: Record<string, unknown> } }).workflow;
    await flushJourneyNotices(harness);
    await approveJourneyPlan(harness, taskId);
    expect(workflowNow()).toMatchObject({ stage: "IMPLEMENT" });

    // The worker: the real task runner behind the real server, delivery and callbacks. Only the model transport is scripted (it is untrusted by design).
    const workerKeys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const journal = new OperationJournal(join(root, "worker-journal"));
    const evidenceRoot = join(root, "worker-evidence");
    await mkdir(evidenceRoot, { mode: 0o700 });
    await mkdir(join(workerWorkspace, ".agentx"), { recursive: true, mode: 0o700 });
    const workerFetch: typeof fetch = async (url, init) => {
      const parsed = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
      const response = await call(harness.handler, { method: init?.method ?? "GET", path: parsed.pathname, headers: Object.fromEntries(new Headers(init?.headers).entries()), ...(body === undefined ? {} : { body }) });
      if (response.status >= 400) throw new Error(`worker callback ${parsed.pathname} HTTP ${response.status}: ${JSON.stringify(response.body)}`);
      return new Response(JSON.stringify(response.body), { status: response.status, headers: { "content-type": "application/json" } });
    };
    const sinksFor = (invocation: WorkerInvocation) => createWorkerCallbackSinks({ controlPlaneUrl: "https://cp.example.test", invocation, fetchImplementation: workerFetch });
    const { modelRuntime, faux } = await fauxModelRuntime();
    /** The runs this journey started, by the labels its host put on their resources: another session's runs on the same Docker are none of this journey's business. */
    const seenRuns = new Set<string>();
    // The host's own credential scan (it holds the run's passwords, which nothing else does), kept to ask it about what the broker stored once the run is over.
    let hostCredentialScan: ((bytes: Uint8Array) => boolean) | undefined;
    // What the run's raw output showed of an echoed credential, read before the host handed anything out (the run directory is read in place; nothing in it is changed).
    let withheldCredential: { carriedCredential: boolean; executorRefusal: boolean } | undefined;
    // What the executor leaves when it withholds a credential: it refuses to record evidence that carries one, and its last scan removes any output file that does (it then ends the run
    // with exit code 2 and reason "credential-leak", and writes this log line).
    const EXECUTOR_REFUSAL = "evidence contains an account credential and cannot be stored";
    const EXECUTOR_REMOVED_FILE = "removed an output file that carried an account credential";
    const executorWithheld = (bytes: Buffer) => bytes.includes(EXECUTOR_REFUSAL) || bytes.includes(EXECUTOR_REMOVED_FILE) || /"reason":\s*"credential-leak"/u.test(bytes.toString("utf8"));
    const scanOutput = async (directory: string, containsCredential: (bytes: Uint8Array) => boolean): Promise<{ carriedCredential: boolean; executorRefusal: boolean }> => {
      const seen = { carriedCredential: false, executorRefusal: false };
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          const inner = await scanOutput(path, containsCredential);
          seen.carriedCredential ||= inner.carriedCredential;
          seen.executorRefusal ||= inner.executorRefusal;
        } else if (entry.isFile()) {
          const bytes = await readFile(path);
          if (bytes.byteLength > 16 * 1024 * 1024) continue;
          seen.carriedCredential ||= containsCredential(bytes);
          seen.executorRefusal ||= executorWithheld(bytes);
        }
      }
      return seen;
    };
    const applicationRuntime: WorkflowE2EApplicationRuntime = { runRoot, collect: collectLikeTheWorker,
      createHost: (hostInput) => {
        const hostDeps = workflowE2EApplicationHostDeps({ executorImage: EXECUTOR_IMAGE, buildImage: ciImage("node-build", WEB_API_BUILD_IMAGE), runRoot } satisfies WorkflowE2EApplicationRuntimeConfig,
          observedDocker(createProcessDockerCli(), (args) => { for (const value of args) if (value.startsWith("rovara.run=")) seenRuns.add(value.slice("rovara.run=".length)); journeyInput.observeDocker?.(args); }), () => Date.now(), hostInput);
        return createDockerApplicationHost({ ...hostDeps, onRunOutput: async (run) => {
          hostCredentialScan = (bytes) => run.containsCredential(bytes);
          const seen = await scanOutput(run.outDir, (bytes) => run.containsCredential(bytes));
          withheldCredential = { carriedCredential: (withheldCredential?.carriedCredential ?? false) || seen.carriedCredential, executorRefusal: (withheldCredential?.executorRefusal ?? false) || seen.executorRefusal };
          await hostDeps.onRunOutput?.(run);
        } });
      } };
    const workerState = createWorkerServerState(journal, {
      execute: async (invocation) => {
        const sinks = sinksFor(invocation);
        return runTaskInvocation(invocation, { rootPath: workerWorkspace, model: FAUX_MODEL, piAdapter: createDefaultPiSessionAdapter({ modelRuntime: async () => ({ runtime: modelRuntime, model: FAUX_MODEL }) }),
          eventSink: sinks.eventSink, artifactSink: sinks.artifactSink, workflowE2EAdmissionReader: sinks.workflowE2EAdmissionReader, workflowE2EEvidenceSink: sinks.workflowE2EEvidenceSink,
          workflowE2EEvidenceRoot: evidenceRoot, workflowE2ERuntimeRoot: process.cwd(), workflowE2EApplicationRuntime: applicationRuntime });
      },
    }, { onTerminal: async (result, invocation) => postWorkerTerminalResult(sinksFor(invocation), result, invocation), retrySleep: async () => undefined },
    { publicKey: workerKeys.publicKey, workspaceId, generation: 1 });
    const deliver = harness.world.machines.deliver.bind(harness.world.machines);
    harness.world.machines.deliver = async (machineId, invocation) => {
      const receipt = await deliver(machineId, invocation);
      if (invocation.kind === "cancel") {
        const payload = workerInvokeTokenPayload({ workspaceId, generation: 1, operationId: invocation.operationId, fence: invocation.fence, expiresAt: Math.floor(Date.now() / 1000) + 3600, purpose: "WORKSPACE" });
        const authorization = `${WORKER_INVOKE_AUTHORIZATION_SCHEME} ${workerInvokeToken(payload, cryptoSign("sha256", Buffer.from(payload, "ascii"), workerKeys.privateKey))}`;
        const response = await handleWorkerRequest(new Request("http://worker/invocations", { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(invocation) }), workerState);
        expect(response.status).toBeLessThan(300);
      }
      return receipt;
    };
    const startedOperations = new Set<string>();
    async function runOperation(workflowMode: "IMPLEMENT" | "CHECKS" | "REVIEW" | "PULL_REQUEST", after?: string, purpose: "candidate" | "baseline" = "candidate") {
      const next = await takeCoreInvocation(harness, workspaceId, workflowMode, after);
      const { invocation } = next;
      expect(startedOperations.has(invocation.operationId), "an operation is never silently consumed twice").toBe(false);
      if (workflowMode === "CHECKS") {
        const actualPurpose = invocation.kind === "task" ? invocation.payload.workflowE2EAdmission?.purpose ?? "candidate" : undefined;
        expect(actualPurpose, "select baseline and candidate rounds explicitly").toBe(purpose);
      }
      startedOperations.add(invocation.operationId);
      const body = JSON.stringify(invocation);
      const payload = workerInvokeTokenPayload({ workspaceId, generation: 1, operationId: invocation.operationId, fence: invocation.fence, expiresAt: Math.floor(Date.now() / 1000) + 3600, purpose: "WORKSPACE" });
      const authorization = `${WORKER_INVOKE_AUTHORIZATION_SCHEME} ${workerInvokeToken(payload, cryptoSign("sha256", Buffer.from(payload, "ascii"), workerKeys.privateKey))}`;
      // The machine adapter is external infrastructure. The server, runner, collectors and callbacks are production code.
      const response = await handleWorkerRequest(new Request("http://worker/invocations", { method: "POST", headers: { authorization, "content-type": "application/json" }, body }), workerState);
      expect(response.status, `worker refused ${workflowMode}: ${await response.clone().text()}`).toBe(200); // the worker server answers 200 with {accepted:true} (packages/worker/src/server.ts); 202 was a stale expectation
      for (let attempt = 0; attempt < Number(process.env.JOURNEY_WAIT_ATTEMPTS ?? 6000); attempt += 1) {
        const operation = harness.db.get(workspacePk, `OPERATION#${invocation.operationId}`);
        if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(String(operation?.status))) {
          harness.world.machines.finish(next.machineId, invocation.operationId);
          return { invocation, operation: operation! };
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const journalFiles = await readdir(join(root, "worker-journal")).catch(() => [] as string[]);
      const journalText = journalFiles.length === 0 ? "none" : (await readFile(join(root, "worker-journal", journalFiles[0]!), "utf8").catch(() => "unreadable")).slice(0, 700);
      throw new Error(`core ${workflowMode} worker did not post a terminal result; the operation is ${String(harness.db.get(workspacePk, `OPERATION#${invocation.operationId}`)?.status)}; the worker's journal: ${journalText}`);
    }
    async function writePreparationManifest(projectRevision: number) {
      await writeFile(join(workerWorkspace, ".agentx", "preparation-manifest.json"), `${JSON.stringify({ schemaVersion: 2, projectName: "payments", projectRevision,
        repositories: [{ name: "demo", path: "repo/demo", defaultBranch: "main", resolvedCommit: baseCommit, resolvedAt: new Date().toISOString(), completedAt: new Date().toISOString() }],
        completedSetupSteps: [], readinessResults: [], creationIdentity: `fixture-${taskId}`, complete: true, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
    }
    /** Readiness runs through the core recovery sweep and fake machine's health port. */
    async function completeReadiness() {
      await harness.runtime.flow.sweepOnce();
      await harness.runtime.flow.relayOnce();
    }
    /** Nothing of the round is left behind: no container (the mocks and the sinkhole included), network or volume still carries the label of a run this journey started, and the run directory is empty. */
    const nothingLeftBehind = async () => {
      expect(seenRuns.size, "the journey's host started at least one run").toBeGreaterThan(0);
      const labelled = (kind: "ps" | "network" | "volume") => [...seenRuns].map((runId) => docker(...(kind === "ps" ? ["ps", "-a", "--filter", `label=rovara.run=${runId}`, "--format", "{{.Names}}"]
        : [kind, "ls", "--filter", `label=rovara.run=${runId}`, "--format", "{{.Name}}"]))).filter((names) => names !== "").join("\n");
      expect({ containers: labelled("ps"), networks: labelled("network"), volumes: labelled("volume") }).toEqual({ containers: "", networks: "", volumes: "" });
      expect(await readdir(runRoot)).toEqual([]);
    };
    const creator = harness.db.get(`DEVELOPER#${MAYA.developerId}`, "META");
    if (creator !== undefined) harness.db.set({ ...creator, entityType: "DEVELOPER" });
    return { root, runRoot, repository, baseCommit, snapshot, harness, policy, taskId, taskKey, workspaceId, faux, workflowNow, operationRows, runOperation, writePreparationManifest, completeReadiness, nothingLeftBehind, evidenceRoot, seenRuns, hostCredentialScan: () => hostCredentialScan, withheldCredential: () => withheldCredential, executorRemovedFile: EXECUTOR_REMOVED_FILE };
  }

export const journeyProjectPk = (project: string) => projectPk(JOURNEY_COMPANY, project);
export async function readJourneyTask(harness: Awaited<ReturnType<typeof createCoreBrowserBroker>>, taskId: string): Promise<DeveloperTaskView> {
  const response = await harness.dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`);
  expect(response.status).toBe(200);
  return response.body.task as DeveloperTaskView;
}
export async function readJourneyResults(harness: Awaited<ReturnType<typeof createCoreBrowserBroker>>, taskId: string): Promise<E2EScenarioResults | undefined> {
  const task = harness.db.get(`DEVTASK#${taskId}`, "META") as unknown as Parameters<JourneyApplicationPorts["results"]["read"]>[0];
  // Native tests also assert the routed presentation, so a leaf-only read never claims route coverage.
  expect((await readJourneyTask(harness, taskId)).e2ePresentation).toBeDefined();
  return (await harness.runtime.flow.deps.applicationE2E?.results.read(task, "owner"))?.scenarioResults;
}
export async function journeyPublicationChecks(harness: Awaited<ReturnType<typeof createCoreBrowserBroker>>, taskId: string) {
  const task = harness.db.get(`DEVTASK#${taskId}`, "META") as unknown as Parameters<JourneyApplicationPorts["publication"]>[0];
  return (await harness.runtime.flow.deps.applicationE2E?.publication(task))?.items;
}
export async function journeyNoticeBlocks(harness: Awaited<ReturnType<typeof createCoreBrowserBroker>>, taskId: string) {
  const task = harness.db.get(`DEVTASK#${taskId}`, "META") as unknown as Parameters<JourneyApplicationPorts["results"]["notice"]>[0];
  return await harness.runtime.flow.deps.applicationE2E?.results.notice(task, `https://api.example.test/review/${taskId}/task`);
}

export const journeyGit = git;

export async function flushJourneyNotices(harness: Awaited<ReturnType<typeof createCoreBrowserBroker>>) {
  await harness.runtime.services["session-sweep"]!.pass({ budgetMs: 10_000 });
  harness.world.clock.advance(301);
  await harness.runtime.services["notify-deliver"]!.pass({ budgetMs: 10_000 });
  const first = JSON.stringify(harness.channel.delivered);
  await harness.runtime.services["notify-deliver"]!.pass({ budgetMs: 10_000 });
  expect(JSON.stringify(harness.channel.delivered), "notices are not delivered twice").toBe(first);
  return harness.channel.delivered;
}

/** A local code host reports the real committed source; core's public callback owns draft reconciliation. */
export async function publishJourneyDraft(journey: Awaited<ReturnType<typeof startCoreBrowserJourney>>) {
  const { harness, taskId, workspaceId, repository, faux, runOperation, workflowNow } = journey;
  const { fauxAssistantMessage } = await import("@earendil-works/pi-ai");
  faux.setResponses([fauxAssistantMessage('{"findings":[]}'), fauxAssistantMessage('{"findings":[]}')]);
  const reviewed = await runOperation("REVIEW");
  expect(reviewed.operation.status).toBe("SUCCEEDED");
  expect(workflowNow()).toMatchObject({ stage: "PULL_REQUEST", state: "READY" });
  const { invocation, machineId } = await takeCoreInvocation(harness, workspaceId, "publish");
  if (invocation.kind !== "publish") throw new Error("core did not issue its publication invocation");
  const operation = harness.db.find((row) => row.entityType === "OPERATION" && row.id === invocation.operationId)[0];
  if (operation === undefined) throw new Error("publication operation missing");
  const expected = operation.publication as { repository: string; repositoryUrl: string; headBranch: string; baseBranch: string; title: string; body: string; expectedTreeSha: string; expectedCommitSha?: string };
  const candidate = workflowNow().candidate!;
  const commit = git(repository, "rev-parse", "HEAD");
  const tree = git(repository, "rev-parse", "HEAD^{tree}");
  expect(expected.expectedTreeSha).toBe(tree);
  expect(expected.expectedCommitSha).toBe(commit);
  const model = harness.world.host.model;
  // Only the external code-host port is scripted. No approval, admission, verdict or PULL_REQUEST row is inserted.
  for (const sha of [journey.baseCommit, commit]) {
    const paths = git(repository, "ls-tree", "-r", "--name-only", sha).split("\n").filter(Boolean);
    const files = new Map(paths.map((path) => [path, git(repository, "show", `${sha}:${path}`)]));
    model.revisions.set(sha, { sha, tree: git(repository, "rev-parse", `${sha}^{tree}`), parents: sha === journey.baseCommit ? [] : [journey.baseCommit], files, entries: new Map(paths.map((path) => [path, "file" as const])), symlinks: new Set() });
  }
  model.branches.set(expected.baseBranch, journey.baseCommit);
  model.branches.set(expected.headBranch, commit);
  const post = async (action: string, body: unknown) => call(harness.handler, { method: "POST", path: `/v1/internal/workspaces/${workspaceId}/operations/${invocation.operationId}/${action}`, headers: { "x-agentx-callback-capability": invocation.callbackCapability }, body });
  const opened = await post("pull-request", { repository: expected.repository, repositoryUrl: expected.repositoryUrl, headBranch: expected.headBranch, baseBranch: expected.baseBranch, title: expected.title, body: expected.body, commit });
  expect(opened.status, JSON.stringify(opened.body)).toBe(200);
  const draft = model.changeRequests.at(-1)!;
  expect(draft).toMatchObject({ draft: true, state: "open", sourceBranch: expected.headBranch });
  expect(model.headRevisionOf(draft)).toBe(commit);
  expect(model.revision(commit).tree).toBe(tree);
  expect((await post("result", { operationId: invocation.operationId, status: "SUCCEEDED", result: { repository: expected.repository, number: opened.body.number, url: opened.body.url, headBranch: expected.headBranch, baseBranch: expected.baseBranch, checks: [], reconciled: opened.body.reconciled, draft: opened.body.draft, commit } })).status).toBe(200);
  harness.world.machines.finish(machineId, invocation.operationId);
  expect(workflowNow().candidate?.digest).toBe(candidate.digest);
  expect((await readJourneyTask(harness, taskId)).workflow?.pullRequests).toEqual(expect.arrayContaining([expect.objectContaining({ headSha: commit, headTreeSha: tree })]));
}

/** A shared reader can read, the owner alone can send back; absent grants never reveal task/page/artifact bytes. */
export async function assertJourneySharing(journey: Awaited<ReturnType<typeof startCoreBrowserJourney>>, screenshotSha: string) {
  const { harness, taskId, workflowNow } = journey;
  const viewer = { developerId: "c".repeat(64), name: "Tess Viewer", provider: "oidc" as const, sessionId: "s-tess" };
  const stranger = { developerId: "b".repeat(64), name: "Sam Ungranted", provider: "oidc" as const, sessionId: "s-sam" };
  const sessions = new Map<string, string>();
  for (const person of [MAYA, viewer, stranger, OMAR]) {
    const companyId = person === OMAR ? FOREIGN_COMPANY : JOURNEY_COMPANY;
    harness.db.set({ pk: `COMPANY_MEMBER#${person.developerId}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: person.developerId, companyId, role: "member", joinedAt: "2026-11-01T00:00:00.000Z" });
    harness.db.set({ pk: `ORG#${companyId}#MEMBER#${person.developerId}`, sk: "PROJECT#payments", entityType: "PROJECT_GRANT", companyId, projectName: "payments", role: "developer" });
    harness.db.set({ pk: `DEVELOPER#${person.developerId}`, sk: "META", entityType: "DEVELOPER", developerId: person.developerId, provider: person.provider, displayName: person.name, revoked: false });
    const sessionId = randomUUID();
    for (const id of [person.sessionId, sessionId]) harness.db.set({ pk: `SESSION#${id}`, sk: "META", sessionId: id, developerId: person.developerId, amr: person.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 3600, reviewExpiresAt: Math.floor(Date.now() / 1000) + 3600 });
    sessions.set(person.developerId, sessionId);
  }
  const base = `/v1/dev/tasks/${taskId}`;
  expect((await harness.dev(MAYA, "PUT", `${base}/readers/${viewer.developerId}`, { requestId: randomUUID(), role: "viewer" })).status).toBe(200);
  expect((await harness.dev(viewer, "GET", base)).status).toBe(200);
  expect((await harness.dev(viewer, "POST", `${base}/workflow/send-back`, { requestId: randomUUID(), expectedRevision: workflowNow().revision, instructions: "A viewer cannot send this back" })).status).toBe(403);
  const page = async (person: { developerId: string }, suffix: string) => harness.handler({ version: "2.0", routeKey: "ANY /review/{proxy+}", rawPath: `/review/${taskId}/task${suffix}`, rawQueryString: "", headers: { host: "api.example.test", cookie: `__Host-agentx_review_session=${sessions.get(person.developerId)}` }, requestContext: { requestId: randomUUID(), http: { method: "GET" } } });
  expect((await page(viewer, "")).statusCode).toBe(200);
  expect((await page(viewer, `/api/e2e/artifacts/${screenshotSha}`)).statusCode).toBe(200);
  for (const person of [stranger, OMAR]) {
    const before = canonicalJson([...harness.db.items.values()]);
    expect((await harness.dev(person, "GET", base)).status).toBe(404);
    expect((await harness.dev(person, "GET", `${base}/readers`)).status).toBe(404);
    expect((await harness.dev(person, "POST", `${base}/workflow/send-back`, { requestId: randomUUID(), expectedRevision: workflowNow().revision, instructions: "An ungranted person cannot act" })).status).toBe(404);
    expect((await page(person, "")).statusCode).toBe(404);
    expect((await page(person, `/api/e2e/artifacts/${screenshotSha}`)).statusCode).toBe(404);
    expect(canonicalJson([...harness.db.items.values()]), "ungranted routes cause no writes").toBe(before);
  }
}
