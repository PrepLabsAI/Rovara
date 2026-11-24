// Review of DEC 254zzz448 A30 (order always computed): a ONE-repository task whose dependency facts cannot be read.
// The press already treats fewer than two open pull requests as "no order to get wrong" (merge.ts, `subject.pullRequests.length < 2`); the view should not tell a person to confirm an override either.
import { describe, expect, it } from "vitest";
import { mergeViewOf, readMergeTracking } from "../../packages/broker/src/core/merge/index.js";
import { ORG, TASK_ID, mergeWorld } from "../support/merge-world.js";

describe("the Merge view of a one-repository task", () => {
  it.each([["a seam that throws", async (): Promise<unknown> => { throw new Error("down"); }], ["facts that are not edges", async (): Promise<unknown> => "not edges"]] as const)("carries no order, and no override ask, for %s", async (_label, seam) => {
    const world = await mergeWorld({ pullRequests: [{ repositoryId: "app", number: 1 }] });
    await world.seedTracking();
    world.deps.repositoryEdges = seam;
    const view = await mergeViewOf(world.deps, await world.task(), await readMergeTracking(world.store, TASK_ID, ORG), undefined);
    expect(view).not.toHaveProperty("order");
  });
});
