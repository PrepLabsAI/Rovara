import { describe, expect, it } from "vitest";
import { companyScoped, IMPLICIT_COMPANY_ID, OrgIdSchema, projectRevisionKey, orgProjectCatalogKey, type JsonValue } from "@agentx/contracts";
import { COMPANY_A, COMPANY_B, SHARED_RAW_IDS } from "../../packages/testing/src/isolation/two-company.js";
import { createTaskFlow, TASK_FLOW_INDEXES } from "../../packages/broker/src/core/task-flow/flow.js";
import { createStoreProjectSource } from "../../packages/broker/src/core/task-flow/project-source.js";
import { MemoryQueueService } from "../../packages/broker/src/ports/memory-queue.js";
import { workspaceOperations } from "../../packages/broker/src/core/task-flow/reads.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { createHarness, definition, newRequestId } from "../support/task-flow-harness.js";
import { dynamoWorld } from "../support/ports/dynamodb-harness.js";

/** Both flows use the real DynamoDocumentStore over ONE wire-level FakeDynamoDb table. */
async function sharedFlows() {
  const world = dynamoWorld({ indexes: TASK_FLOW_INDEXES });
  const project = { ...definition, name: SHARED_RAW_IDS.project };
  const make = async (company: typeof COMPANY_A) => {
    const companyId = OrgIdSchema.parse(company.orgId);
    const h = createHarness({ backend: () => ({ store: world.store, queues: new MemoryQueueService() }) });
    const deps = { ...h.deps, companyId, projects: createStoreProjectSource(world.store, companyId) };
    const caller = { ...h.owner, principal: { ...h.owner.principal, companyId, personId: SHARED_RAW_IDS.user } };
    await world.store.put({ item: { ...projectRevisionKey(companyId, project.name, project.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(project)) as JsonValue } });
    await world.store.put({ item: { ...orgProjectCatalogKey(companyId, project.name), entityType: "PROJECT_CATALOG", latestRevision: project.revision } });
    return { flow: createTaskFlow(deps), caller };
  };
  const a = await make(COMPANY_A);
  const b = await make(COMPANY_B);
  const started = await a.flow.start(a.caller, { requestId: newRequestId(), project: project.name, instructions: COMPANY_A.canary });
  return { world, a, b, taskId: started.task.taskId };
}

describe("DynamoDB two-company task flow (R4 S2)", () => {
  it("unchanged-source control: A reads and lists its own task on the shared real store", async () => {
    const { a, taskId } = await sharedFlows();
    expect(await a.flow.get(a.caller, taskId)).toMatchObject({ taskId, title: COMPANY_A.canary });
    expect((await a.flow.list(a.caller)).tasks).toEqual([expect.objectContaining({ taskId, title: COMPANY_A.canary })]);
  });

  it("B cannot get or close A's task and A's stored task stays unchanged", async () => {
    const { world, a, b, taskId } = await sharedFlows();
    const before = await world.store.get(taskKey(taskId));
    await expect(b.flow.get(b.caller, taskId)).rejects.toMatchObject({ code: "TASK_NOT_FOUND", message: "TASK_NOT_FOUND: no such task" });
    await expect(b.flow.close(b.caller, taskId)).rejects.toMatchObject({ code: "TASK_NOT_FOUND", message: "TASK_NOT_FOUND: no such task" });
    expect(await world.store.get(taskKey(taskId))).toEqual(before);
    expect(await a.flow.get(a.caller, taskId)).toMatchObject({ taskId, title: COMPANY_A.canary });
  });

  it("B lists no A tasks when both companies use the same person and project", async () => {
    const { b } = await sharedFlows();
    expect(await b.flow.list(b.caller)).toEqual({ tasks: [] });
  });
});


describe("core company list paging", () => {
  async function listing(companyId: string) {
    const world = dynamoWorld({ indexes: TASK_FLOW_INDEXES });
    const h = createHarness({ backend: () => ({ store: world.store, queues: new MemoryQueueService() }) });
    const company = OrgIdSchema.parse(companyId);
    const flow = createTaskFlow({ ...h.deps, companyId: company });
    const caller = { ...h.owner, principal: { ...h.owner.principal, companyId: company } };
    const put = async (id: number, orgId?: JsonValue) => world.store.put({ item: {
      pk: `DEVELOPER#${caller.principal.personId}`, sk: `TASK#${String(id).padStart(4, "0")}`,
      entityType: "DEVELOPER_TASK_INDEX", title: `row-${id}`, ...(orgId === undefined ? {} : { orgId }),
    } });
    return { world, flow, caller, put };
  }
  it("fills a page after rejected rows and resumes without losing accepted rows", async () => {
    const { flow, caller, put } = await listing(COMPANY_B.orgId);
    for (const [id, org] of [[6, COMPANY_A.orgId], [5, COMPANY_B.orgId], [4, COMPANY_A.orgId], [3, COMPANY_B.orgId], [2, COMPANY_B.orgId]] as const) await put(id, org);
    const first = await flow.list(caller, { limit: 2 });
    expect(first.tasks.map((row) => row.title)).toEqual(["row-5", "row-3"]);
    expect(first.cursor).toEqual(expect.any(String));
    const second = await flow.list(caller, { limit: 2, cursor: first.cursor! });
    expect(second.tasks.map((row) => row.title)).toEqual(["row-2"]);
    expect(second.cursor).toBeUndefined();
  });
  it("stops at the fixed read bound with a continuation, including an empty filtered page", async () => {
    const { world, flow, caller, put } = await listing(COMPANY_B.orgId);
    for (let i = 1; i <= 11; i++) await put(i, i === 1 ? COMPANY_B.orgId : COMPANY_A.orgId);
    const query = world.store.query.bind(world.store);
    let calls = 0;
    world.store.query = (request) => { calls++; return query(request); };
    const first = await flow.list(caller, { limit: 1 });
    expect(calls).toBe(10);
    expect(first.tasks).toEqual([]);
    expect(first.cursor).toEqual(expect.any(String));
    expect((await flow.list(caller, { limit: 1, cursor: first.cursor! })).tasks.map((row) => row.title)).toEqual(["row-1"]);
  });
  it.each([IMPLICIT_COMPANY_ID, COMPANY_A.orgId])("old rows belong only to implicit company (%s)", async (company) => {
    const { flow, caller, put } = await listing(company);
    await put(1);
    expect((await flow.list(caller)).tasks.map((row) => row.title)).toEqual(company === IMPLICIT_COMPANY_ID ? ["row-1"] : []);
  });
  it.each([null, 1, {}, "", "secret-canary"])('refuses malformed stored company %j', async (org) => {
    const { flow, caller, put } = await listing(IMPLICIT_COMPANY_ID);
    await put(1, org);
    expect(await flow.list(caller)).toEqual({ tasks: [] });
  });
  it.each([0, -1, NaN, Infinity, 1.5])('refuses malformed limit %s with fixed words', async (limit) => {
    const { flow, caller } = await listing(COMPANY_A.orgId);
    await expect(flow.list(caller, { limit })).rejects.toThrow("list limit is invalid");
  });
});


describe("workspace operation rows in the same read module", () => {
  it("filters each operation by company even if a foreign row uses the same workspace key", async () => {
    const { world, a, b } = await sharedFlows();
    for (const [id, companyId] of [["a", COMPANY_A.orgId], ["b", COMPANY_B.orgId], ["old", undefined], ["bad", null]] as const) {
      await world.store.put({ item: { pk: "WORKSPACE#shared", sk: `OPERATION#${id}`, entityType: "OPERATION", id,
        createdAt: "2026-11-09T10:00:00.000Z", fence: 1, ...(companyId === undefined ? {} : { companyId }) } });
    }
    expect((await workspaceOperations(a.flow.deps, "shared")).map((row) => row.id)).toEqual(["a"]);
    expect((await workspaceOperations(b.flow.deps, "shared")).map((row) => row.id)).toEqual(["b"]);
    expect((await workspaceOperations({ ...a.flow.deps, companyId: OrgIdSchema.parse(IMPLICIT_COMPANY_ID) }, "shared")).map((row) => row.id)).toEqual(["old"]);
  });
});


describe("workspace operation total bound", () => {
  it("refuses the whole read at 2,000 rows rather than silently giving partial operations", async () => {
    const world = dynamoWorld({ indexes: TASK_FLOW_INDEXES });
    for (let i = 0; i < 2001; i++) await world.store.put({ item: { pk: "WORKSPACE#large", sk: `OPERATION#${String(i).padStart(4, "0")}`,
      companyId: COMPANY_A.orgId, createdAt: "2026-11-09T10:00:00.000Z", fence: i } });
    const deps = { store: world.store, companyId: OrgIdSchema.parse(COMPANY_A.orgId) };
    await expect(workspaceOperations(deps, "large")).rejects.toThrow("workspace operation limit exceeded");
    await world.store.delete({ key: { pk: "WORKSPACE#large", sk: "OPERATION#2000" } });
    expect(await workspaceOperations(deps, "large")).toHaveLength(2000);
  });
  it("refuses missing company context with fixed words", async () => {
    const world = dynamoWorld({ indexes: TASK_FLOW_INDEXES });
    await expect(workspaceOperations({ store: world.store }, "private-canary")).rejects.toThrow("workspace company is invalid");
  });
});


describe("runtime company context", () => {
  it.each(["", "private-canary"])('rejects a forged flow and principal company %s', async (companyId) => {
    const h = createHarness();
    const bad = companyId;
    const flow = createTaskFlow({ ...h.deps, companyId: bad });
    const caller = { ...h.owner, principal: { ...h.owner.principal, companyId: bad } };
    await h.store.put({ item: { pk: `DEVELOPER#${caller.principal.personId}`, sk: "TASK#1", orgId: companyId, title: "private-canary" } });
    expect(await flow.list(caller)).toEqual({ tasks: [] });
  });
  it("refuses a different caller company even when the index contains this flow's rows", async () => {
    const { a, b } = await sharedFlows();
    expect(await a.flow.list(b.caller)).toEqual({ tasks: [] });
  });
});

// S1/S3 run the common kit against the actual adapter, not a second implementation.
import { assertSurfacesIsolated } from "../../packages/testing/src/isolation/two-company.js";
import { dynamoCompanies } from "../support/ports/dynamodb-companies.js";

it("isolates document and State-index surfaces on one real DynamoDB adapter", async () => {
  const kit = dynamoCompanies();
  await assertSurfacesIsolated(kit.surfaces);
});

it.each(["store", "index", "dispatch-index"] as const)("kit rejects the leaking %s variant", async (mutant) => {
  await expect(assertSurfacesIsolated(dynamoCompanies(mutant).surfaces)).rejects.toThrow();
});


import { STATE_TABLE_INDEXES } from "../../packages/aws-adapters/src/dynamodb/state-table.js";
import { attempt, type IsolationSurface } from "../../packages/testing/src/isolation/two-company.js";

it("isolates prefix-related company keys and refuses delimiters", async () => {
  const { store } = dynamoWorld();
  for (const company of ["short", "shorter"]) await store.put({ item: { pk: companyScoped(company, SHARED_RAW_IDS.documentName), sk: "META", marker: company } });
  for (const company of ["short", "shorter"]) expect((await store.query({ pk: companyScoped(company, SHARED_RAW_IDS.documentName) })).items.map((row) => row.marker)).toEqual([company]);
  for (const company of ["", "a#b", "a b", "a\nb"]) expect(() => companyScoped(company, "shared")).toThrow();
});

it.each(["bySessionState", "github-webhook-recovery"])("known gap: %s lists both companies (T1/T8)", async (index) => {
  const { store } = dynamoWorld({ indexes: STATE_TABLE_INDEXES });
  const definition = STATE_TABLE_INDEXES.find((entry) => entry.name === index)!;
  for (const company of [COMPANY_A, COMPANY_B]) await store.put({ item: {
    pk: companyScoped(company.orgId, SHARED_RAW_IDS.machineKey), sk: "META", marker: company.canary,
    [definition.partitionAttribute]: "shared-partition", [definition.sortAttribute!]: company.label,
  } });
  const seen = JSON.stringify(await store.queryIndex({ index, partition: "shared-partition" }));
  expect(seen).toContain(COMPANY_A.canary); expect(seen).toContain(COMPANY_B.canary);
});

it("known gap: DynamoStreamChangeFeed delivers both companies to every consumer (T8)", async () => {
  const world = dynamoWorld();
  const seen: unknown[] = [];
  const subscription = await world.store.changes!.subscribe("shared-consumer", async (batch) => { seen.push(...batch); });
  try {
    for (const company of [COMPANY_A, COMPANY_B]) await world.store.put({ item: { pk: companyScoped(company.orgId, "same"), sk: "META", marker: company.canary } });
    await world.settled();
    expect(JSON.stringify(seen)).toContain(COMPANY_A.canary); expect(JSON.stringify(seen)).toContain(COMPANY_B.canary);
  } finally { await subscription.stop(); }
});

it.each([false, true])("task flow kit controls and leaking variant (leak=%s)", async (leak) => {
  const { a, b, taskId } = await sharedFlows();
  const surface: IsolationSurface = {
    name: "task get/list/close", kind: "read",
    plant: async (company) => company.label === "A" ? { handle: taskId } : {
      handle: (await b.flow.start(b.caller, { requestId: newRequestId(), project: SHARED_RAW_IDS.project, instructions: COMPANY_B.canary })).task.taskId,
    },
    observe: async (company, planted) => {
      const own = company.label === "A" ? a : b;
      const foreign = company.label === "A" ? b : a;
      return {
        own: await own.flow.get(own.caller, String(planted.own)),
        list: await own.flow.list(own.caller),
        other: await attempt(() => (leak ? foreign : own).flow.get((leak ? foreign : own).caller, String(planted.other))),
        close: await attempt(() => own.flow.close(own.caller, String(planted.other))),
      };
    },
  };
  if (leak) await expect(assertSurfacesIsolated([surface])).rejects.toThrow();
  else await assertSurfacesIsolated([surface]);
});

it.each(["", "not-an-org", COMPANY_B.orgId])("refuses invalid or other principal company %s", async (companyId) => {
  const { a, taskId } = await sharedFlows();
  const caller = { ...a.caller, principal: { ...a.caller.principal, companyId } };
  const refused = await attempt(() => a.flow.get(caller, taskId));
  expect(refused.ok).toBe(false);
  expect(JSON.stringify(refused)).not.toContain(COMPANY_A.canary);
});

import { assertFailsClosed } from "../../packages/testing/src/isolation/two-company.js";
import { companyMembershipFromStore } from "../../packages/broker/src/aws/company-check.js";
import { companyRouteHarness, TASK } from "../support/company-route-harness.js";

it.each([false, true])("membership kit probes through DynamoDocumentStore (fallback mutant=%s)", async (fallback) => {
  const world = dynamoWorld();
  const h = companyRouteHarness();
  const reader = companyMembershipFromStore(world.store);
  const probes = [{
    name: "read A task when membership is unavailable", prepare: async () => { h.task(TASK, undefined, COMPANY_A.canary); },
    attempt: async (mode: "throws" | "undefined") => {
      if (mode === "throws") world.fake.failNext("GetItem", () => new Error(COMPANY_A.canary));
      h.deps.companies = fallback ? { companyOf: async (person) => {
        try { return await reader.companyOf(person) ?? IMPLICIT_COMPANY_ID; } catch { return IMPLICIT_COMPANY_ID; }
      } } : reader;
      const response = await h.read(`/v1/dev/tasks/${TASK}`);
      if (response.statusCode >= 400) throw new Error(response.body);
      return response.body;
    },
  }];
  if (fallback) await expect(assertFailsClosed(probes)).rejects.toThrow();
  else await assertFailsClosed(probes);
});
