import { expect, it } from "vitest";
import { developerTaskView } from "../../packages/broker/src/local/app/task-view.js";
import { taskViewOf } from "../../packages/broker/src/core/task-flow/reads.js";
import { workspaceKeys } from "../../packages/broker/src/core/task-flow/workspace-location.js";
import { seed, taskOf } from "../support/task-actions-world.js";
it("shows the broker's recorded manual pull request through the existing task view", async () => {
  const { h } = await seed({ workflow: null });
  const task = await taskOf(h);
  const location = await workspaceKeys(h.deps, task.workspaceId);
  await h.store.put({ item: { ...location.row("PULL_REQUEST#demo#0000000001"), entityType: "PULL_REQUEST", repository: "demo", number: 1, url: "https://github.com/example/demo/pull/1", state: "open" } });
  const view = await developerTaskView(task, await taskViewOf(h.deps, task), {} as never);
  expect(view).toMatchObject({ pullRequests: [{ repository: "demo", number: 1, url: "https://github.com/example/demo/pull/1", state: "open" }] });
});
