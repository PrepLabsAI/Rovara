// Engine host (lane E2, step 3): Code's AWS adapter modules for the core, over the wire-level fakes (FakeDynamoDb, FakeSqs, FakeS3, FakeSecretsManager, the GitHub fixture provider).
// Proves: the core starts a task over the real adapters; the State table's TTL never becomes a delete of a kind the deployed broker keeps (the retention wrapper is not skippable);
// hollow inputs refuse at create; a company's secret is read only for that company; the points Code does not fill yet stay empty and the switch is refused by name.
// Nothing here calls AWS. Live runs still owed are listed in the lane report.
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CORE_ENGINE_VARIABLE, change, companyScoped, orgProjectCatalogKey, projectRevisionKey, type JsonValue, type ProjectDefinition } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { createPriceTableMetering, localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { FakeHostModel } from "@agentx/broker/fakes";
import { CoreRegistryError, buildCoreRegistry, createCoreHostApp, engineStampKey, stampOf, type CoreAdapterModule } from "../../packages/broker/src/core-host/index.js";
import { CORE_EXPIRY_COLLISIONS, KEPT_FOR_GOOD_ON_AWS, KEPT_ON_SEPARATE_KEYS, appliesCodeRetention, codeRetentionStore, retentionFor, withCodeRetention } from "../../packages/broker/src/core-host/retention.js";
import { COMPANY_SECRET_PATHS, CORE_DISPATCH_QUEUE, OWED_POINTS, codeAdapterModules, owedPoints, stateTableIndexes, type CodeModuleDeps } from "../../packages/broker/src/core-host/code-modules.js";
import { FakeDynamoDb } from "../support/ports/dynamodb-fake.js";
import { FakeSqs } from "../support/ports/sqs-fake.js";
import { FakeS3, FakeSecretsManager } from "../support/ports/aws-fakes.js";
import { GitHubFixtureProvider } from "../support/ports/github-fixture-provider.js";
import { FAKE_COMPANY, createFakeWorld } from "../support/core-host-fakes.js";
import { BINDING, COMPANY_A, COMPANY_B, createSessionMachinesWorld } from "../support/session-machines-world.js";
import { SessionWorkerFleet, SessionWorkerMachines } from "../../packages/broker/src/aws/worker-machines/session-worker-machines.js";
import { createCoreRuntime, withCompanyMachines } from "../../packages/broker/src/core-host/core-runtime.js";
import { readCoreEngineFlags } from "../../packages/broker/src/core-host/flags.js";
import { costPartition as costPartitionFor, createCostLedger } from "../../packages/broker/src/core/cost/ledger.js";

const OTHER = "org_corehost00000000000b";
const BASE = "https://sqs.us-west-2.amazonaws.com/000000000000";
const PROJECT: ProjectDefinition = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};

interface AwsWorld { dynamo: FakeDynamoDb; sqs: FakeSqs; s3: FakeS3; secrets: FakeSecretsManager; deps: CodeModuleDeps; stripped: string[] }

function awsWorld(overrides: Partial<CodeModuleDeps> = {}): AwsWorld {
  const dynamo = new FakeDynamoDb({ tableName: "State", indexes: stateTableIndexes(), ttlAttribute: "indexExpiresAt" });
  const sqs = new FakeSqs();
  sqs.createQueue(`${BASE}/dispatch-dead`);
  sqs.createQueue(`${BASE}/dispatch`, { maxReceiveCount: 5, deadLetterUrl: `${BASE}/dispatch-dead` });
  const s3 = new FakeS3({ bucket: "artifacts" });
  const secrets = new FakeSecretsManager();
  const stripped: string[] = [];
  const deps: CodeModuleDeps = {
    tableName: "State", dynamo, retentionLog: { stripped: (kind) => stripped.push(kind) },
    queue: { settings: { queues: { [CORE_DISPATCH_QUEUE]: { url: `${BASE}/dispatch`, deadLetterUrl: `${BASE}/dispatch-dead` } } }, client: sqs },
    objects: { client: s3, bucket: "artifacts" },
    secrets: { namePrefix: "agentx/staging/", clientFor: () => secrets },
    codeHost: { provider: new GitHubFixtureProvider(new FakeHostModel({ url: "https://github.com/example/demo.git", id: "1", fullName: "example/demo" })), options: { credentialRef: "host-app" } },
    ...overrides,
  };
  return { dynamo, sqs, s3, secrets, deps, stripped };
}

/** Code's modules, plus the fake world's stand-ins for exactly the points Code does not fill yet (OWED_POINTS). */
function modulesWithOwed(aws: AwsWorld): CoreAdapterModule[] {
  const owed = new Set<string>(owedPoints(aws.deps).map((entry) => entry.point));
  return [...codeAdapterModules(aws.deps), ...createFakeWorld().modules.filter((module) => owed.has(module.point))];
}

/** The EC2 fleet's operations over the session world (no AWS). */
function fleetDeps(): NonNullable<CodeModuleDeps["workerMachines"]> {
  const world = createSessionMachinesWorld();
  return {
    sessions: world.sessions, companyOfWorkspace: async () => COMPANY_A, binding: async () => BINDING,
    stopInstance: async () => ({ gone: true }), sign: (message: Uint8Array) => world.sign(message), post: async () => ({ status: 200, body: "{}" }), ping: async () => undefined,
  };
}

const context = () => ({ installCompanyId: FAKE_COMPANY, now: () => new Date("2026-11-15T10:00:00.000Z"), env: {}, clients: {}, log: () => undefined });

describe("Code's AWS adapter modules", () => {
  it("run the core over the real DynamoDB and SQS adapters: a Quick task starts, carries its core stamp, and is read back through the wire-level table", async () => {
    const aws = awsWorld();
    const app = createCoreHostApp({
      env: { ROVARA_CORE_ENGINE: `on:${FAKE_COMPANY}` }, modules: () => modulesWithOwed(aws), context,
      runtime: () => ({
        callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }),
        now: () => new Date("2026-11-15T10:00:00.000Z"), log: () => undefined,
        services: () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } }),
        // Switch blocker honest-ci (#680): a deployment hands in the project's own CI mode reader.
        ciReporting: { honest: true as const, ciMode: () => "their_ci_fix" as const },
      }),
    });
    const store = (await app.registry()).require("storage");
    expect(appliesCodeRetention(store)).toBe(true);
    await store.put({ item: { ...projectRevisionKey(FAKE_COMPANY, PROJECT.name, PROJECT.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(PROJECT)) as JsonValue } });
    await store.put({ item: { ...orgProjectCatalogKey(FAKE_COMPANY, PROJECT.name), entityType: "PROJECT_CATALOG", latestRevision: PROJECT.revision } });
    const runtime = await app.runtimeFor(FAKE_COMPANY);
    const owner = { principal: localOwnerPrincipal({ companyId: FAKE_COMPANY }), origin: "app" as const, client: "test" };
    const { task } = await runtime.flow.start(owner, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint", workflow: true, workflowPath: "QUICK" });
    expect(stampOf(await store.get(engineStampKey(task.taskId)))).toMatchObject({ engine: "core" });
    expect((await runtime.flow.list(owner)).tasks.map((row) => row.taskId)).toEqual([task.taskId]);
    // Idempotent start: the same request id answers the same task, never a second one.
    const requestId = randomUUID();
    const first = await runtime.flow.start(owner, { requestId, project: "payments", instructions: "Again", workflow: true, workflowPath: "QUICK" });
    const again = await runtime.flow.start(owner, { requestId, project: "payments", instructions: "Again", workflow: true, workflowPath: "QUICK" });
    expect(again.task.taskId).toBe(first.task.taskId);
    expect(again.duplicate).toBe(true);
    // Every write went through the wire-level table (no SDK call left the process).
    expect(aws.dynamo.requests.some((request) => request.operation === "TransactWriteItems")).toBe(true);
  });

  it("never hands out the State table without Code's retention: the core's own expiries stand (its logic reads them), a core expiry on a kind the deployed broker keeps is stripped", async () => {
    const aws = awsWorld();
    const registry = await buildCoreRegistry({ modules: modulesWithOwed(aws), context: context(), areas: ["flow", "build", "merge"] });
    const store = registry.require("storage");
    const past = Math.floor(Date.parse("2026-01-01T00:00:00Z") / 1_000);
    const pk = `ORG#${FAKE_COMPANY}#X`;
    await store.put({ item: { pk, sk: "lock", entityType: "TEST_ENV_LOOK_LOCK", indexExpiresAt: past } });
    await store.put({ item: { pk, sk: "note", entityType: "WORKFLOW_THREAD_NOTE", indexExpiresAt: past } });
    await store.transact([{ kind: "put", item: { pk, sk: "note2", entityType: "WORKFLOW_THREAD_NOTE", indexExpiresAt: past } }]);
    expect(aws.stripped).toEqual(["WORKFLOW_THREAD_NOTE", "WORKFLOW_THREAD_NOTE"]);
    aws.dynamo.sweepExpired();
    // The core-only lock expired as the core meant; the notes the deployed broker keeps for good did not.
    expect(await store.get({ pk, sk: "lock" })).toBeUndefined();
    expect(await store.get({ pk, sk: "note" })).toBeDefined();
    expect(await store.get({ pk, sk: "note2" })).toBeDefined();
  });

  it("refuses hollow inputs at create, with fixed words", async () => {
    const cases: Array<[Partial<CodeModuleDeps>, RegExp]> = [
      [{ tableName: "" }, /storage input is hollow: tableName/],
      [{ queue: { settings: { queues: { other: { url: `${BASE}/dispatch` } } } } }, /queue input is hollow: queues\.task-dispatch/],
      [{ queue: { settings: {} } }, /queue input is hollow/],
      [{ queue: { settings: { queues: { [CORE_DISPATCH_QUEUE]: {} } } } }, /queue input is hollow: queues\.task-dispatch\.url/],
      [{ objects: { client: {} as never, bucket: "artifacts" } }, /objects\.client input is hollow: send/],
      [{ objects: { client: new FakeS3({ bucket: "a" }), bucket: "" } }, /objects input is hollow: bucket/],
      [{ secrets: { namePrefix: "agentx/staging/" } as never }, /secrets input is hollow: clientFor/],
      [{ codeHost: { provider: new GitHubFixtureProvider(new FakeHostModel({ url: "https://github.com/example/demo.git", id: "1", fullName: "example/demo" })), options: { credentialRef: "" } } }, /codeHost input is hollow/],
      [{ checkRunner: { githubActions: {} as never } }, /checkRunner\.githubActions input is hollow/],
      [{ workerMachines: { ...fleetDeps(), sign: undefined as never } }, /workerMachines input is hollow: sign/],
      [{ workerMachines: { ...fleetDeps(), sessions: { get: async () => undefined } as never } }, /workerMachines\.sessions input is hollow: ensureSession, deleteSession, claimStop, markStopped/],
    ];
    for (const [override, words] of cases) {
      await expect(buildCoreRegistry({ modules: modulesWithOwed(awsWorld(override)), context: context(), areas: ["flow", "build", "merge"] }), words.source).rejects.toThrow(words);
    }
  });

  it("reads a company's own secret only for that company (the adapter's company paths are fixed by the list)", async () => {
    const aws = awsWorld();
    aws.secrets.secrets.set(`agentx/staging/org-connectors/${FAKE_COMPANY}/linear`, { string: "own" });
    aws.secrets.secrets.set(`agentx/staging/org-connectors/${OTHER}/linear`, { string: "theirs" });
    const registry = await buildCoreRegistry({ modules: modulesWithOwed(aws), context: context(), areas: ["flow", "build", "merge"] });
    const secrets = registry.require("secrets");
    expect((await secrets.read(FAKE_COMPANY, { awsSecret: `org-connectors/${FAKE_COMPANY}/linear` }))?.reveal()).toBe("own");
    // T6 (#655): another company's secret answers exactly like a missing one, and is never read.
    expect(await secrets.read(FAKE_COMPANY, { awsSecret: `org-connectors/${OTHER}/linear` })).toBeUndefined();
    expect(aws.secrets.reads).toEqual([`agentx/staging/org-connectors/${FAKE_COMPANY}/linear`]);
    expect(COMPANY_SECRET_PATHS).toContain("org-connectors");
  });

  it("leaves the points Code does not fill yet empty, so the switch is refused by name (never a laptop default)", async () => {
    const aws = awsWorld();
    const refused = await buildCoreRegistry({ modules: codeAdapterModules(aws.deps), context: context(), areas: ["flow", "build", "merge"] }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(CoreRegistryError);
    expect((refused as CoreRegistryError).missing.map((entry) => entry.point).sort()).toEqual(Object.keys(OWED_POINTS).sort());
    expect(owedPoints({ checkRunner: { githubActions: {} as never } }).map((entry) => entry.point)).not.toContain("check-runner");
    expect(owedPoints({ workerMachines: fleetDeps() }).map((entry) => entry.point)).not.toContain("worker-machines");
    expect(owedPoints({}).map((entry) => entry.point)).toContain("worker-machines");
    // Building the list makes no client and calls nothing: the adapters are made only when the registry is built (with the switch serving).
    const quiet = awsWorld();
    codeAdapterModules(quiet.deps);
    expect(quiet.sqs.requests).toEqual([]);
    expect(quiet.secrets.reads).toEqual([]);
  });

  it("declares every index the core checks, with one definition each, and the outbox's pending index among them", () => {
    const names = stateTableIndexes().map((index) => index.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.sort()).toEqual(["bySessionState", "byWorkspaceProject", "github-webhook-recovery", "outbox-pending", "workflow-dispatch-due"]);
  });
});

async function sources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return ["core", "local", "core-host"].includes(entry.name) && directory.endsWith(join("broker", "src")) ? [] : await sources(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  }));
  return nested.flat();
}

const EXPIRY = /INDEX_EXPIRY_ATTRIBUTE|indexExpiresAt/;
/** How a kind is named: an item literal, a `change.set`/`setIfAbsent` of it, an UpdateExpression value, or a constant declared in the same file. */
const KIND_PATTERNS = [/entityType:\s*"([A-Z][A-Z0-9_]+)"/g, /"entityType",\s*"([A-Z][A-Z0-9_]+)"/g, /":(?:entity|entityType|type|kind)":\s*"([A-Z][A-Z0-9_]+)"/g, /\["entityType"\],\s*"([A-Z][A-Z0-9_]+)"/g, /path:\s*\["entityType"\],\s*value:\s*"([A-Z][A-Z0-9_]+)"/g];
const KIND_CONSTANT = /entityType:\s*([A-Z][A-Z0-9_]+)\b/g;
const CONSTANT = /const\s+([A-Z][A-Z0-9_]*)\s*=\s*"([A-Z][A-Z0-9_]+)"/g;
function kindsOn(line: string, constants: ReadonlyMap<string, string>): string[] {
  const found = KIND_PATTERNS.flatMap((pattern) => [...line.matchAll(pattern)].map((match) => match[1]!));
  for (const match of line.matchAll(KIND_CONSTANT)) { const value = constants.get(match[1]!); if (value !== undefined) found.push(value); }
  return found;
}
/** The kinds named in these files: all of them, and those within a few lines of the expiry attribute (an item literal can span lines). */
async function kindsIn(files: readonly string[]): Promise<{ all: Set<string>; expiring: Set<string> }> {
  const all = new Set<string>();
  const expiring = new Set<string>();
  for (const file of files) {
    const text = await readFile(file, "utf8");
    const constants = new Map([...text.matchAll(CONSTANT)].map((match) => [match[1]!, match[2]!] as const));
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      for (const kind of kindsOn(line, constants)) all.add(kind);
      if (!EXPIRY.test(line)) return;
      for (const near of lines.slice(Math.max(0, index - 8), index + 9)) for (const kind of kindsOn(near, constants)) expiring.add(kind);
    });
  }
  return { all, expiring };
}

describe("Code's retention for core writes", () => {
  it("decides every kind the core writes with an expiry that the deployed broker also writes (a new collision is reviewed here, a stale one removed)", async () => {
    const root = join(import.meta.dirname, "../../packages/broker/src");
    const core = await kindsIn(await sources(join(root, "core")));
    const deployed = await kindsIn(await sources(root));
    const collisions = [...core.expiring].filter((kind) => deployed.all.has(kind)).sort();
    expect(core.expiring.size).toBeGreaterThan(20);
    expect(Object.keys(CORE_EXPIRY_COLLISIONS).sort()).toEqual(collisions);
    // A `keep` is the dangerous side: the deployed broker must expire that kind itself.
    for (const [kind, action] of Object.entries(CORE_EXPIRY_COLLISIONS)) if (action === "keep" && !KEPT_ON_SEPARATE_KEYS.has(kind)) expect(deployed.expiring.has(kind), kind).toBe(true);
    // The scan sees the forms it must: a digit in a kind, a `change.set` of it, an UpdateExpression value.
    for (const kind of ["WORKFLOW_E2E_BASELINE", "TASK_RATE", "CHANNEL_THREAD"]) expect(collisions, kind).toContain(kind);
  });

  it("keeps the core's own expiries and strips only the kinds decided as strip", () => {
    for (const kind of ["TEST_ENV_LOOK_LOCK", "NOTIFY_PENDING", "SETUP_HOST_OPEN", "WORKFLOW_DISPATCH", undefined, "SOMETHING_NEW", 7]) {
      expect(retentionFor(kind), String(kind)).toBe("keep");
      const plain = { pk: "p", sk: "s", ...(kind === undefined ? {} : { entityType: kind }), indexExpiresAt: 5 };
      expect(withCodeRetention(plain)).toBe(plain);
    }
    expect(retentionFor("WORKFLOW_THREAD_NOTE")).toBe("strip");
    expect(withCodeRetention({ pk: "p", sk: "s", entityType: "WORKFLOW_THREAD_NOTE", indexExpiresAt: 5, other: 1 })).toEqual({ pk: "p", sk: "s", entityType: "WORKFLOW_THREAD_NOTE", other: 1 });
  });

  it("keeps the cost ledger, approvals and decisions for good on AWS (owner decision DEC 222); session and activity records keep the core's expiry", async () => {
    const root = join(import.meta.dirname, "../../packages/broker/src");
    const core = await kindsIn(await sources(join(root, "core")));
    // Every kind on the list is one the core really writes with an expiry (a stale entry fails here).
    for (const kind of KEPT_FOR_GOOD_ON_AWS) {
      expect(core.expiring.has(kind), kind).toBe(true);
      expect(retentionFor(kind), kind).toBe("strip");
      expect(withCodeRetention({ pk: "p", sk: "s", entityType: kind, indexExpiresAt: 5, other: 1 })).toEqual({ pk: "p", sk: "s", entityType: kind, other: 1 });
    }
    // DEC 222a: the per-run cost history is part of the cost ledger.
    expect(KEPT_FOR_GOOD_ON_AWS.has("RUN_COST")).toBe(true);
    // Session summaries and operation and activity events expire as on a laptop.
    for (const kind of ["LIVE_SESSION", "OPERATION_EVENT", "WORK_EVENT", "DECISION_EVIDENCE_OPENED"]) {
      expect(core.expiring.has(kind), kind).toBe(true);
      expect(retentionFor(kind), kind).toBe("keep");
    }
    // Through the core's own ledger on the deployed store: the entry and its once-marker reach the table with no expiry; the totals are kept.
    const inner = new MemoryDocumentStore();
    const stripped: string[] = [];
    const ledger = createCostLedger({ store: codeRetentionStore(inner, { stripped: (kind) => stripped.push(kind) }), metering: createPriceTableMetering({ currency: "USD", models: {} }), now: () => new Date("2026-11-15T10:00:00.000Z") });
    await ledger.recordUsage({ companyId: FAKE_COMPANY, entryId: "e-1", at: "2026-11-15T10:00:00.000Z", taskId: "t-1", usage: { provider: "anthropic", modelId: "m", tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } });
    const written = (await inner.query({ pk: costPartitionFor(FAKE_COMPANY, "t-1") })).items;
    const entry = written.find((item) => item.entityType === "COST_ENTRY")!;
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty("indexExpiresAt");
    const once = await inner.get({ pk: companyScoped(FAKE_COMPANY, "COST_ENTRY"), sk: "e-1" });
    expect(once?.entityType).toBe("COST_ENTRY_ONCE");
    expect(once).not.toHaveProperty("indexExpiresAt");
    expect(stripped.sort()).toEqual(["COST_ENTRY", "COST_ENTRY_ONCE"]);
    // Positive control: the same write on a store without Code's retention keeps the core's expiry.
    const bare = new MemoryDocumentStore();
    await createCostLedger({ store: bare, metering: createPriceTableMetering({ currency: "USD", models: {} }), now: () => new Date("2026-11-15T10:00:00.000Z") })
      .recordUsage({ companyId: FAKE_COMPANY, entryId: "e-1", at: "2026-11-15T10:00:00.000Z", taskId: "t-1", usage: { provider: "anthropic", modelId: "m", tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } });
    expect(await bare.get({ pk: companyScoped(FAKE_COMPANY, "COST_ENTRY"), sk: "e-1" })).toHaveProperty("indexExpiresAt");
  });

  it("judges an update by the kind it sets, else by the item's current kind; a setIfAbsent of the kind names nothing", async () => {
    const inner = new MemoryDocumentStore();
    const store = codeRetentionStore(inner);
    await inner.put({ item: { pk: "a", sk: "kept", entityType: "WORKFLOW_THREAD_NOTE" } });
    await inner.put({ item: { pk: "a", sk: "own", entityType: "NOTIFY_PENDING", indexExpiresAt: 5 } });
    // A durable item cannot be given an expiry by an update that does not name its kind, nor by a setIfAbsent of a kept kind.
    await store.update({ key: { pk: "a", sk: "kept" }, ops: [change.set("indexExpiresAt", 9), change.set("x", 1)] });
    await store.update({ key: { pk: "a", sk: "kept" }, ops: [change.setIfAbsent("entityType", "NOTIFY_PENDING"), change.add("indexExpiresAt", 9)] });
    await store.transact([{ kind: "update", key: { pk: "a", sk: "kept" }, ops: [change.set("indexExpiresAt", 9)] }, { kind: "update", key: { pk: "a", sk: "own" }, ops: [change.set("indexExpiresAt", 99)] }]);
    expect(await inner.get({ pk: "a", sk: "kept" })).toEqual({ pk: "a", sk: "kept", entityType: "WORKFLOW_THREAD_NOTE", x: 1 });
    // The core's own item has its expiry extended, never cut short.
    expect(await inner.get({ pk: "a", sk: "own" })).toHaveProperty("indexExpiresAt", 99);
    await store.update({ key: { pk: "a", sk: "own" }, ops: [change.set("indexExpiresAt", 100)] });
    expect(await inner.get({ pk: "a", sk: "own" })).toHaveProperty("indexExpiresAt", 100);
    // A new item given a stripped kind by setIfAbsent loses the expiry too (it has no kind yet).
    await store.update({ key: { pk: "a", sk: "fresh" }, ops: [change.setIfAbsent("entityType", "WORKFLOW_THREAD_NOTE"), change.set("indexExpiresAt", 9)] });
    expect(await inner.get({ pk: "a", sk: "fresh" })).not.toHaveProperty("indexExpiresAt");
    // A new item set to a stripped kind in the same update loses the expiry.
    await store.update({ key: { pk: "a", sk: "new" }, ops: [change.set("entityType", "WORKFLOW_THREAD_NOTE"), change.set("indexExpiresAt", 9)] });
    expect(await inner.get({ pk: "a", sk: "new" })).not.toHaveProperty("indexExpiresAt");
    // An update that does not touch the expiry reads nothing extra.
    const reads = vi.spyOn(inner, "get");
    await store.update({ key: { pk: "a", sk: "own" }, ops: [change.set("y", 1)] });
    expect(reads).not.toHaveBeenCalled();
    expect(appliesCodeRetention(inner)).toBe(false);
  });
});

describe("the EC2 fleet in the registry", () => {
  it("registers one fleet for every company, which each company's runtime sees bound to that company only", async () => {
    const aws = awsWorld({ workerMachines: fleetDeps() });
    const registry = await buildCoreRegistry({ modules: modulesWithOwed(aws), context: context(), areas: ["flow", "build", "merge"] });
    const fleet = registry.require("worker-machines");
    expect(fleet).toBeInstanceOf(SessionWorkerFleet);
    // The registry as company A's runtime sees it: the fleet bound to A, by `require` and by `get`.
    const seenByA = withCompanyMachines(registry, COMPANY_A);
    const boundA = seenByA.require("worker-machines") as SessionWorkerMachines;
    expect(boundA).toBeInstanceOf(SessionWorkerMachines);
    expect(boundA.companyId).toBe(COMPANY_A);
    expect((seenByA.get("worker-machines", "ec2-sessions") as SessionWorkerMachines).companyId).toBe(COMPANY_A);
    expect((withCompanyMachines(registry, COMPANY_B).require("worker-machines") as SessionWorkerMachines).companyId).toBe(COMPANY_B);
    // Every other point is the registry's own.
    expect(seenByA.require("storage")).toBe(registry.require("storage"));
    // An adapter without `forCompany` (the laptop's, which reads the company from each spec) is handed out as it is.
    const plain = await buildCoreRegistry({ modules: createFakeWorld().modules, context: context(), areas: ["flow", "build", "merge"] });
    expect(withCompanyMachines(plain, COMPANY_A).require("worker-machines")).toBe(plain.require("worker-machines"));
  });

  it("builds a company's core over the fleet bound to that company: the flow's machines are the company's adapter", async () => {
    const aws = awsWorld({ workerMachines: fleetDeps() });
    const registry = await buildCoreRegistry({ modules: modulesWithOwed(aws), context: context(), areas: ["flow", "build", "merge"] });
    const runtime = createCoreRuntime({
      registry, companyId: COMPANY_A, flags: readCoreEngineFlags({ [CORE_ENGINE_VARIABLE]: "on" }), callbackSigningKey: Buffer.alloc(32, 1),
      access: createOwnerTaskAccess(), repositoryCredential: async () => { throw new Error("unused"); }, repositoryGrantKey: Buffer.alloc(32, 2), now: () => new Date(), log: () => undefined,
    });
    expect(runtime.flow.deps.machines).toBeInstanceOf(SessionWorkerMachines);
    expect((runtime.flow.deps.machines as SessionWorkerMachines).companyId).toBe(COMPANY_A);
  });
});
