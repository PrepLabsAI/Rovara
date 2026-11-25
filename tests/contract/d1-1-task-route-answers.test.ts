// D1-1 (old-engine removal, permissions piece): the exact-answer table. Every `/v1/dev/tasks/**` route of the route table, for every kind of caller, answers a core task
// byte for byte as it did before D1-1 moved the "no task of yours" answer from the old developer route into the core. The golden file was RECORDED ON THE BASE (800b647ed, the base's
// answers are the same as dc8265473's: only core/merge/merge.ts moved between them) with `D1_1_RECORD=1`; this test compares status and the full body (task ids, other ids and times
// are normalised, the broker's request id is stripped). The dropped old rows of the task list (DEC 254zzz502) are D1-2b's change, not this one.
//
// ONE deliberate change of answer, recorded in the golden after the pre-review (M1): a script token of ANOTHER company asking GET /v1/dev/tasks/<core task>/evidence was told 403 "A script token
// cannot do that." where an id with no task is told 404 (the path was refused before the task was looked up). It now reads the task first and is told what a missing task is told. The
// OWNER's own script token still gets the 403, and no other row differs.
//
// Callers: the owner, a colleague who CAN read (a member of the owner's company with the owner role: its 403s on stop and the like say "only the owner or an admin", which it may be told because it
// can read the task; they are NOT a leak), a company admin, a colleague who may NOT read (a plain member), another company's member, another company's script token, a person the core knows no
// company for, a caller the deployment's mapping does not know, the owner's script token, the owner of an OLD task (a real DEVTASK row with no stamp), and an install with no core entry.
// The entry is built through the access-paused retry wrapper, as core-engine-root.ts:1420 does. Routes: every suffix the router serves (the five method shapes), the start, and the list with
// its options. NOT in the table and NOT touched by D1-1: GET /v1/dev/tasks/start-requests/{requestId} (task-start-request-routes.ts, not the task router), and a WIRED merge (the harness wires none,
// so every merge row is "merging from Rovara is not set up"). A second test says that every caller who may not read a task is told exactly what an id with no task is told.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { orgProjectCatalogKey, projectRevisionKey, type JsonValue, type ProjectDefinition, type StoredDocument } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import type { TaskFlowDeps } from "../../packages/broker/src/core/task-flow/deps.js";
import { developerIdOf } from "../../packages/broker/src/core/sessions/create.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createCoreHostApp, engineStampKey, type CoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { createCoreDevRoutes, type CompanyMembership, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import { coreTaskEntryFrom, type CoreTaskEntry } from "../../packages/broker/src/aws/engine-boundary.js";
import { accessRetryRoute } from "../../packages/broker/src/aws/core-access-retry.js";
import { MAYA, OMAR, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { loadSlackBroker } from "../support/slack-broker.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../support/core-host-fakes.js";

const GOLDEN = new URL("./fixtures/d1-1-task-route-answers.json", import.meta.url);
const RECORD = process.env["D1_1_RECORD"] === "1";
const OTHER = "org_corehost00000000000b";
const REQUEST_ID = "11111111-1111-4111-8111-1111111111a1";
const PROJECT: ProjectDefinition = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};
const HONEST_CI = { honest: true as const, ciMode: () => "their_ci_fix" as const };
const SERVICES = () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } });

beforeAll(async () => { await loadSlackBroker(); });

// Every suffix routeDeveloperTaskRequest serves after `/v1/dev/tasks/<id>`, plus ones that are no route.
const SUFFIXES = ["", "/events", "/plan", "/messages", "/diff", "/comments", "/people", "/people/role", "/people/take-ownership", "/people/candidates", "/people/add", "/people/requests/abc", "/readers", "/readers/abc",
  "/continue", "/cancel", "/close", "/pull-requests", "/share", "/workflow/decision", "/workflow/retry", "/workflow/review", "/workflow/publish-retry", "/workflow/keep-pull-requests",
  "/workflow/send-back", "/workflow/review-findings", "/workflow/feedback", "/workflow/feedback-decision", "/workflow/feedback-retry", "/canvas-closeout/retry", "/e2e-publication-context", "/answers", "/evidence",
  "/merge", "/nope"];
const SHAPES: ReadonlyArray<{ label: string; method: string; body?: unknown }> = [
  { label: "GET", method: "GET" },
  { label: "POST no body", method: "POST" },
  { label: "POST body", method: "POST", body: { requestId: REQUEST_ID, instructions: "Also log it", expectedRevision: 1, round: 1, answers: [] } },
  { label: "PUT", method: "PUT", body: { requestId: REQUEST_ID } },
  { label: "DELETE", method: "DELETE" },
];

async function registerProject(world: FakeWorld, companyId: string): Promise<void> {
  await world.store.put({ item: { ...projectRevisionKey(companyId, PROJECT.name, PROJECT.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(PROJECT)) as JsonValue } });
  await world.store.put({ item: { ...orgProjectCatalogKey(companyId, PROJECT.name), entityType: "PROJECT_CATALOG", latestRevision: PROJECT.revision } });
}

function appOver(world: FakeWorld, access: TaskFlowDeps["access"]): CoreHostApp {
  return createCoreHostApp({
    modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
    runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access, repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined, services: SERVICES, ciReporting: HONEST_CI }),
  });
}

/** The company's owner rule as a deployment wires it (DECISIONS 198): only the person the task runs for acts as its owner. */
const ownerRule = (): TaskFlowDeps["access"] => ({
  ...createOwnerTaskAccess(),
  ownerActing: async (principal, task) => (principal.personId === task.developerId || developerIdOf(principal) === task.developerId ? { actorId: task.ownerKey } : undefined),
});

type Caller = "owner" | "colleague" | "no-read-colleague" | "admin" | "stranger" | "stranger-script-token" | "no-company" | "unmapped" | "script-token" | "old-task-owner" | "no-core-entry";
interface Variant { name: string; caller: Caller; actions: boolean }
const VARIANTS: readonly Variant[] = [
  { name: "owner", caller: "owner", actions: true }, { name: "owner, moves unwired", caller: "owner", actions: false },
  { name: "colleague", caller: "colleague", actions: true }, { name: "colleague, moves unwired", caller: "colleague", actions: false },
  { name: "no-read colleague", caller: "no-read-colleague", actions: true }, { name: "stranger script token", caller: "stranger-script-token", actions: true },
  { name: "admin", caller: "admin", actions: true },
  { name: "stranger", caller: "stranger", actions: true }, { name: "stranger, moves unwired", caller: "stranger", actions: false },
  { name: "no company", caller: "no-company", actions: true }, { name: "unmapped", caller: "unmapped", actions: true },
  { name: "script token", caller: "script-token", actions: true }, { name: "old task owner", caller: "old-task-owner", actions: true },
  { name: "no core entry", caller: "no-core-entry", actions: true },
];

async function partition(world: FakeWorld, pk: string): Promise<StoredDocument[]> {
  const items: StoredDocument[] = [];
  let cursor: string | undefined;
  do {
    const page = await world.store.query({ pk, ...(cursor === undefined ? {} : { cursor }) });
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return items;
}

async function worldFor(variant: Variant) {
  const world = createFakeWorld();
  await registerProject(world, FAKE_COMPANY);
  await registerProject(world, OTHER);
  const app = appOver(world, variant.actions ? ownerRule() : createOwnerTaskAccess());
  const owner = localOwnerPrincipal({ companyId: FAKE_COMPANY });
  const runtime = await app.runtimeFor(FAKE_COMPANY);
  const { task } = await runtime.flow.start({ principal: owner, client: "test", origin: "app" }, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint", workflow: true, workflowPath: "QUICK" as const });
  const colleague = { ...owner, personId: "colleague-person-0001" };
  const principals = new Map<string, DeployedCaller>([[MAYA.developerId, { principal: owner, client: "cli" }], [OMAR.developerId, { principal: localOwnerPrincipal({ companyId: OTHER }), client: "cli" }]]);
  const members = new Map<string, CompanyMembership>([[`${owner.personId}${FAKE_COMPANY}`, { companyId: FAKE_COMPANY, role: "owner" }], [`${owner.personId}${OTHER}`, { companyId: OTHER, role: "owner" }]]);
  if (variant.caller === "no-read-colleague") {
    const member = { ...colleague, roles: ["member"] };
    principals.set(MAYA.developerId, { principal: member, client: "cli" });
    members.set(`${member.personId}${FAKE_COMPANY}`, { companyId: FAKE_COMPANY, role: "member" });
  }
  if (variant.caller === "stranger-script-token") principals.set(OMAR.developerId, { principal: localOwnerPrincipal({ companyId: OTHER }), client: "cli", scriptToken: { tokenId: "token-0002" } });
  if (variant.caller === "colleague" || variant.caller === "admin") {
    principals.set(MAYA.developerId, { principal: colleague, client: "cli" });
    members.set(`${colleague.personId}${FAKE_COMPANY}`, { companyId: FAKE_COMPANY, role: variant.caller === "admin" ? "admin" : "member" });
  }
  if (variant.caller === "no-company") members.delete(`${owner.personId}${FAKE_COMPANY}`);
  if (variant.caller === "unmapped") principals.delete(MAYA.developerId);
  if (variant.caller === "script-token") principals.set(MAYA.developerId, { principal: owner, client: "cli", scriptToken: { tokenId: "token-0001" } });
  const routes = createCoreDevRoutes({ app, companyOf: async (caller) => members.get(caller.principal.personId + caller.principal.companyId), wiring: () => ({ origin: () => "https://api.example", ...(variant.actions ? { taskActions: { roundCap: async () => undefined } } : {}) }) });
  // The deployment's caller mapping (deployedCallerFromMembership): a person with no live membership is no caller at all.
  const deployedCallerOf = async (caller: { developerId: string }): Promise<DeployedCaller | undefined> => {
    const found = principals.get(caller.developerId);
    return found === undefined || !members.has(`${found.principal.personId}${found.principal.companyId}`) ? undefined : found;
  };
  const inner: CoreTaskEntry = coreTaskEntryFrom(routes, deployedCallerOf);
  // The production root wraps the entry's route with the access-paused retry (core-engine-root.ts:1420).
  const coreTasks: CoreTaskEntry = { ...inner, route: accessRetryRoute(inner, { caller: deployedCallerOf, flowFor: async (companyId) => (await app.runtimeFor(companyId)).flow.deps }) };
  const harness = await createDeveloperTaskBroker(variant.caller === "no-core-entry" ? {} : { developerExtra: { coreTasks } });
  const rows = [
    ...await partition(world, `DEVTASK#${task.taskId}`), ...await partition(world, engineStampKey(task.taskId).pk), ...await partition(world, `DEVELOPER#${developerIdOf(owner)}`),
    ...await partition(world, `WORKSPACE#${task.workspaceId}`),
  ];
  for (const row of rows) harness.db.set(JSON.parse(JSON.stringify(row)) as Record<string, unknown> & { pk: string; sk: string });
  // The owner of an OLD task: the same rows, but nothing marks the task as the core's.
  if (variant.caller === "old-task-owner") harness.db.delete(engineStampKey(task.taskId).pk, engineStampKey(task.taskId).sk);
  return { harness, task, who: (variant.caller === "stranger" || variant.caller === "stranger-script-token" ? OMAR : MAYA) };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;
const TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/gu;
const HASH = /\b[0-9a-f]{64}\b/gu;
const normalise = (text: string, taskId: string): string => text.replaceAll(taskId, "<task>").replace(UUID, "<uuid>").replace(HASH, "<hash>").replace(TIME, "<time>");
type Recorded = { status: number; body?: string; sha?: string };

async function runTable(): Promise<Record<string, Recorded>> {
  const answers: Record<string, Recorded> = {};
  for (const variant of VARIANTS) {
    const { harness, task, who } = await worldFor(variant);
    const ask = async (key: string, method: string, path: string, body?: unknown): Promise<void> => {
      const reply = await harness.dev(who, method, path, body);
      const { requestId: _requestId, ...rest } = reply.body;
      void _requestId;
      const text = normalise(JSON.stringify(rest), task.taskId);
      // A refusal is kept whole (its words are what the table is for); a 200 view is long and kept as its hash.
      answers[`${variant.name} | ${key}`] = reply.status === 200 ? { status: 200, sha: createHash("sha256").update(text).digest("hex").slice(0, 16) } : { status: reply.status, body: text };
    };
    for (const suffix of SUFFIXES) for (const shape of SHAPES) await ask(`${shape.label} ${suffix === "" ? "/" : suffix}`, shape.method, `/v1/dev/tasks/${task.taskId}${suffix}`, shape.body);
    // A malformed id, a very long one and an id with no task, on a few routes.
    for (const id of ["not-a-task", "x".repeat(300), randomUUID()]) for (const suffix of ["", "/cancel", "/workflow/decision"]) await ask(`${id.length > 40 ? "long" : id.includes("-") && id.length === 36 ? "missing" : id} ${suffix}`, suffix === "" ? "GET" : "POST", `/v1/dev/tasks/${id}${suffix}`, suffix === "" ? undefined : { requestId: REQUEST_ID });
    await ask("start", "POST", "/v1/dev/tasks", { requestId: REQUEST_ID, project: "payments", instructions: "Add a health endpoint", workflow: true, workflowPath: "QUICK" });
    for (const query of ["", "?detail=1", "?status=RUNNING", "?project=payments", "?involved=1", "?detail=1&involved=1"]) await ask(`list ${query}`, "GET", `/v1/dev/tasks${query}`);
  }
  return answers;
}

describe("D1-1: the exact answers of every task route, for every kind of caller", () => {
  it("answer byte for byte as they did on the base sha (recorded there; nothing may differ)", async () => {
    const answers = await runTable();
    if (RECORD) {
      writeFileSync(GOLDEN, `${JSON.stringify(Object.fromEntries(Object.entries(answers).sort(([a], [b]) => (a < b ? -1 : 1))), null, 1)}\n`);
      return;
    }
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as Record<string, Recorded>;
    expect(Object.keys(answers).sort()).toEqual(Object.keys(golden).sort());
    const different = Object.entries(answers).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(golden[key])).map(([key, value]) => ({ key, now: value, base: golden[key] }));
    expect(different).toEqual([]);
    // The table is not vacuous: it holds the refusals the core now words itself, and more than one kind of answer.
    const statuses = new Set(Object.values(golden).map((answer) => answer.status));
    expect([...statuses].sort()).toEqual(expect.arrayContaining([200, 400, 404]));
    expect(Object.values(golden).filter((answer) => answer.body?.includes("no task <task> of yours")).length).toBeGreaterThan(300);
  }, 600_000);
});

describe("D1-1: a caller who may not read a core task is told exactly what an id with no task is told", () => {
  // Every route and method shape, the real core task's id against a random id with no task, the same caller: status and full body equal (ids normalised). This is outside the real-core proof on purpose.
  for (const name of ["stranger", "stranger, moves unwired", "no-read colleague", "stranger script token", "no company", "unmapped"]) {
    it(name, async () => {
      const variant = VARIANTS.find((candidate) => candidate.name === name)!;
      const { harness, task, who } = await worldFor(variant);
      const ask = async (id: string, suffix: string, method: string, body?: unknown) => {
        const reply = await harness.dev(who, method, `/v1/dev/tasks/${id}${suffix}`, body);
        const { requestId: _requestId, ...rest } = reply.body;
        void _requestId;
        return { status: reply.status, body: normalise(JSON.stringify(rest), id) };
      };
      const differences: unknown[] = [];
      for (const suffix of SUFFIXES) for (const shape of SHAPES) {
        const real = await ask(task.taskId, suffix, shape.method, shape.body);
        const missing = await ask(randomUUID(), suffix, shape.method, shape.body);
        if (JSON.stringify(real) !== JSON.stringify(missing)) differences.push({ route: `${shape.label} ${suffix}`, real, missing });
      }
      expect(differences).toEqual([]);
    }, 300_000);
  }
});
