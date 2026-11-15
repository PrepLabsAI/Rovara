// #661: a task's owner name follows the person's current name: a rename updates the tasks they started, and a one-off refresh fixes older tasks.
import { describe, expect, it } from "vitest";
import { renameTaskOwner } from "../../packages/broker/src/developer/task-owner-name.js";
import { refreshTaskOwnerNames } from "../../scripts/refresh-task-owner-names.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ME = "a".repeat(64), OTHER = "b".repeat(64);
const T1 = "11111111-1111-4111-8111-111111111111", T2 = "22222222-2222-4222-8222-222222222222", T3 = "33333333-3333-4333-8333-333333333333";
function tasks(db: FakeDynamoDb) {
  for (const [taskId, owner, name] of [[T1, ME, "f428f4f8-50f1-705d-bec8-96ac8062825c"], [T2, ME, "Pratik Singhal"], [T3, OTHER, "Grace"]] as const) {
    db.set({ pk: `DEVTASK#${taskId}`, sk: "META", taskId, developerId: owner, developerName: name });
    db.set({ pk: `DEVELOPER#${owner}`, sk: `TASK#2026-11-14T19:15:39.383Z#${taskId}`, taskId });
  }
  // An index row whose task is gone.
  db.set({ pk: `DEVELOPER#${ME}`, sk: "TASK#2026-11-01T00:00:00.000Z#44444444-4444-4444-8444-444444444444", taskId: "44444444-4444-4444-8444-444444444444" });
}

describe("renameTaskOwner", () => {
  it("puts the person's current name on the tasks they started, only where it differs, and on no one else's task", async () => {
    const db = new FakeDynamoDb();
    tasks(db);
    expect(await renameTaskOwner(db as never, "state", ME, "Pratik Singhal")).toEqual({ tasks: 3, renamed: 1 });
    expect(db.get(`DEVTASK#${T1}`, "META")).toMatchObject({ developerName: "Pratik Singhal" });
    expect(db.get(`DEVTASK#${T3}`, "META")).toMatchObject({ developerName: "Grace" });
    expect(db.get("DEVTASK#44444444-4444-4444-8444-444444444444", "META")).toBeUndefined();
    expect(await renameTaskOwner(db as never, "state", ME, "Pratik Singhal")).toEqual({ tasks: 3, renamed: 0 });
  });

  it("never renames a task whose owner is someone else, even through a stray index row", async () => {
    const db = new FakeDynamoDb();
    tasks(db);
    db.set({ pk: `DEVELOPER#${ME}`, sk: `TASK#2026-11-14T00:00:00.000Z#${T3}`, taskId: T3 });
    await renameTaskOwner(db as never, "state", ME, "Pratik Singhal");
    expect(db.get(`DEVTASK#${T3}`, "META")).toMatchObject({ developerName: "Grace" });
  });
});

describe("the owner-name refresh", () => {
  it("applies each registered person's current name to their tasks, skips a revoked person, and changes nothing when run again", async () => {
    const db = new FakeDynamoDb();
    tasks(db);
    const people = [{ pk: `DEVELOPER#${ME}`, displayName: "Pratik Singhal", revoked: false }, { pk: `DEVELOPER#${OTHER}`, displayName: "Grace Hopper", revoked: true }, { pk: "DEVELOPER#not-an-id", displayName: "x" }];
    expect(await refreshTaskOwnerNames(db as never, "state", people)).toEqual({ people: 1, tasks: 3, renamed: 1 });
    expect(db.get(`DEVTASK#${T1}`, "META")).toMatchObject({ developerName: "Pratik Singhal" });
    expect(db.get(`DEVTASK#${T3}`, "META")).toMatchObject({ developerName: "Grace" });
    expect(await refreshTaskOwnerNames(db as never, "state", people)).toEqual({ people: 1, tasks: 3, renamed: 0 });
    expect(await refreshTaskOwnerNames(db as never, "state", people, OTHER)).toEqual({ people: 0, tasks: 0, renamed: 0 });
  });
});
