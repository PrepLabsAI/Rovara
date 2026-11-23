// vitest: fresh-modules
import { expect, it, vi } from "vitest";
import * as hostApp from "../../packages/broker/src/core-host/app.js";
import * as codeModules from "../../packages/broker/src/core-host/code-modules.js";
import type { CodeModuleDeps } from "../../packages/broker/src/core-host/code-modules.js";
import { CORE_ENGINE_ON } from "../../packages/broker/src/core-host/flags.js";
import { createBrokerCoreRoot } from "../../packages/broker/src/aws/core-engine-root.js";
import { toDocument } from "../../packages/broker/src/core/task-flow/records.js";
import { runUsageKey } from "../../packages/broker/src/core/cost/run-usage.js";
import { createFakeWorld } from "../support/core-host-fakes.js";
import { seed, taskOf } from "../support/task-actions-world.js";

it.each([true, false])("the root close hook rejects failed run-usage recording, then succeeds when storage recovers (Error=%s)", async isError => {
  const world = createFakeWorld();
  const modules = vi.spyOn(codeModules, "codeAdapterModules").mockImplementation(() => world.modules.filter(module =>
    !["metering", "admission", "identity", "approvers", "audit-sink"].includes(module.point)));
  const app = vi.spyOn(hostApp, "createCoreHostApp");
  const lines: Array<Record<string, unknown>> = [];
  try {
    const root = createBrokerCoreRoot({ env: {}, stateTableName: "state", signInTableName: "sign-in",
      documentClient: { send: async () => { throw new Error("unexpected document client call"); } },
      callbackSigningKey: "k".repeat(32), repositoryGrantKey: Buffer.alloc(32, 1),
      repositoryCredential: async () => { throw new Error("unexpected credential call"); }, codeModules: () => ({} as CodeModuleDeps),
      origin: () => "https://api.example", log: line => { lines.push(line); } });
    const registry = await root.app.registry();
    const { h } = await seed();
    const task = await taskOf(h);
    await world.store.put({ item: toDocument(task) });
    // Exercise the hook the real composition root supplies, without running unrelated hosted services.
    const runtime = app.mock.calls[0]![0].runtime(registry, task.companyId, CORE_ENGINE_ON);
    const close = runtime.flowOptions!.onTaskClosed!;
    const transact = world.store.transact.bind(world.store);
    const failure = isError ? new Error("run usage write unavailable") : "run usage write unavailable";
    let attempts = 0;
    world.store.transact = async items => {
      if (items.some(item => item.kind === "put" && item.item["entityType"] === "RUN_USAGE_SAMPLE")) {
        attempts++;
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- the case under test is a thrown non-Error
        throw failure;
      }
      return transact(items);
    };
    const at = new Date(world.clock.now).toISOString();
    await expect(close(task, at)).rejects.toBe(failure);
    expect(attempts).toBe(1);
    expect(lines).toContainEqual(expect.objectContaining({ event: "cost.run_usage_not_recorded", error: isError ? "Error" : "unknown" }));
    const key = runUsageKey(task.companyId, task.project, task.taskId);
    expect(await world.store.get(key)).toBeUndefined();
    world.store.transact = transact;
    await expect(close(task, at)).resolves.toBeUndefined();
    expect(await world.store.get(key)).toMatchObject({ entityType: "RUN_USAGE_SAMPLE", companyId: task.companyId });
  } finally {
    app.mockRestore();
    modules.mockRestore();
  }
});
