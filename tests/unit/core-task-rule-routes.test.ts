// Core task web routes (Cloud #188 item 3): the rule routes' own guards, without the developer API around them (tests/contract/core-task-rule-routes.test.ts drives them end to end).
// The core has already read the task from the caller's company; the module checks once more that the task it was handed is that company's and the one the path names, and that only the old route table's
// methods are served. Plan comments keep the old route's own company check of the row.
import { describe, expect, it, vi } from "vitest";
import type { DeveloperTaskRouteDependencies } from "../../packages/broker/src/aws/developer-tasks.js";
import { createCoreTaskRuleRoutes } from "../../packages/broker/src/aws/core-task-rule-routes.js";
import type { TaskReadDecision } from "../../packages/broker/src/core/task-flow/read-rule.js";
import { listCorePlanComments } from "../../packages/broker/src/developer/task-code-routes.js";

const A = "org_corehost00000000000a";
const B = "org_corehost00000000000b";
const TASK = "11111111-1111-4111-8111-111111111111";
const OWNER = "d".repeat(64);
const task = (companyId: string, taskId = TASK) => ({ pk: `DEVTASK#${taskId}`, sk: "META", entityType: "DEVELOPER_TASK", taskId, companyId, developerId: OWNER, project: "payments" });
const request = (method: string, rest: string) => ({ method, path: `/v1/dev/tasks/${TASK}/${rest}`, headers: {}, body: "{}" });

/** The read rule is bound by the host; these cases are refused before it is asked. */
const refuse = async (): Promise<never> => { throw new Error("the read rule was asked"); };

describe("the core task rule routes' own guards", () => {
  it("refuse a task of another company, or not the one the path names, as no such task, before any dependency is built", async () => {
    const depsFor = vi.fn((): DeveloperTaskRouteDependencies => { throw new Error("never built"); });
    const routes = createCoreTaskRuleRoutes(depsFor);
    const store = { query: vi.fn(async () => ({ items: [] })) };
    for (const rest of ["people", "readers", "events", "comments", "diff"]) {
      for (const handed of [task(B), task(A, "22222222-2222-4222-8222-222222222222"), { ...task(A), companyId: undefined }]) {
        await expect(routes.route({ request: request("GET", rest), path: `/v1/dev/tasks/${TASK}/${rest}`, person: { developerId: OWNER, name: "Maya" }, companyId: A, task: handed, store, authorize: refuse }), rest).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
      }
    }
    expect(depsFor).not.toHaveBeenCalled();
    expect(store.query).not.toHaveBeenCalled();
    await expect(routes.route({ request: request("POST", "people"), path: `/v1/dev/tasks/${TASK}/people`, person: { developerId: OWNER, name: "Maya" }, companyId: A, task: task(A), store, authorize: refuse })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("plan comments keep the old route's company check of the row", async () => {
    const send = vi.fn(async () => ({ Items: [] }));
    const deps = { documentClient: { send }, tableName: "state", companyId: A, now: () => 0 } as unknown as DeveloperTaskRouteDependencies;
    await expect(listCorePlanComments(deps, { task: task(B) } as unknown as TaskReadDecision)).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("DEC 254zzz44 (a): the old reader rule for the core task read", () => {
  it("says no for a task of another company without building any dependency", async () => {
    const depsFor = vi.fn((): DeveloperTaskRouteDependencies => { throw new Error("never built"); });
    const routes = createCoreTaskRuleRoutes(depsFor);
    expect(await routes.sharedReader({ person: { developerId: OWNER, name: "Maya" }, companyId: A, task: task(B) })).toBeUndefined();
    expect(depsFor).not.toHaveBeenCalled();
  });
});
