// Public's per-task cap is one total for the task, across the task-end run and the human-edit job, in any order: what a task has held is a ladder of once-keys, one per whole cent.
import { describe, expect, it } from "vitest";
import { noteTaskHeld, readTaskHeld, reserveTaskHeld } from "../../../packages/broker/src/lessons/task-held.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import { PROJECT, WS } from "./lesson-helpers.js";

const key = { workspaceId: WS, project: PROJECT };

describe("the task's shared cap ladder", () => {
  it("held amounts are remembered in whole cents (rounded up) and read back; they only grow; float noise does not add a cent", async () => {
    const store = new InMemoryLessonStore();
    expect(await readTaskHeld(store, key, "task-1")).toBe(0);
    await noteTaskHeld(store, key, "task-1", 0.034);
    expect(await readTaskHeld(store, key, "task-1")).toBeCloseTo(0.04, 6);
    await noteTaskHeld(store, key, "task-1", 0.01);
    expect(await readTaskHeld(store, key, "task-1")).toBeCloseTo(0.04, 6);
    await noteTaskHeld(store, key, "task-1", 0.07 + 0.03);
    expect(await readTaskHeld(store, key, "task-1")).toBeCloseTo(0.1, 6);
    expect(await readTaskHeld(store, key, "task-2")).toBe(0);
    // A cap above a dollar is counted in full.
    await noteTaskHeld(store, key, "task-3", 3, 3);
    expect(await readTaskHeld(store, key, "task-3", 3)).toBeCloseTo(3, 6);
  });
  it("a reservation takes free steps one at a time and fails when the cap's steps run out", async () => {
    const store = new InMemoryLessonStore();
    expect(await reserveTaskHeld(store, key, "t", 0.02, 0.03)).toBe(true);
    expect(await reserveTaskHeld(store, key, "t", 0.02, 0.03)).toBe(false);
    expect(await reserveTaskHeld(store, key, "u", 0.01, 0.03)).toBe(true);
    // Two at once never take the same step: of two reservations of the last cent only one wins.
    const results = await Promise.all([reserveTaskHeld(store, key, "v", 0.03, 0.03), reserveTaskHeld(store, key, "v", 0.01, 0.03)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
