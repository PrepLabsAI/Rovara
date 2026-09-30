// Issue 157: the thread META row keeps the worker operation a turn waits on, beside the thread's
// other fields, and forgets it only for the event that saved it.
import { describe, expect, it } from "vitest";
import { createDynamoActiveTurnStore } from "../../packages/slack-service/src/active-turn-store.js";
import { activeTurnFromItem, turnNoteFromItem } from "../../packages/slack-service/src/interrupted-turn.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const subject = "T0BSHLLUGBD/C0123456789/1695500000.000001";
const active = { eventId: "EvWORK000001", workspaceId: "11111111-1111-4111-8111-111111111111", operationId: "55555555-5555-4555-8555-555555555555" };

function seeded() {
  const db = new FakeDynamoDb();
  db.set({ pk: `THREAD#${subject}`, sk: "META", workspaceId: active.workspaceId, conversationId: "33333333-3333-4333-8333-333333333333", pendingRequests: 1 });
  return { db, store: createDynamoActiveTurnStore(db, "threads") };
}

describe("the active turn on the thread META row", () => {
  it("saves the turn beside the thread's other fields, and reads it back", async () => {
    const { db, store } = seeded();
    await store.saveActiveTurn(subject, active);
    const item = db.get(`THREAD#${subject}`, "META");
    expect(item).toMatchObject({ workspaceId: active.workspaceId, conversationId: "33333333-3333-4333-8333-333333333333", pendingRequests: 1, activeTurn: active });
    expect(activeTurnFromItem(item?.activeTurn)).toEqual(active);
  });

  it("clears the turn only for the event that saved it", async () => {
    const { db, store } = seeded();
    await store.saveActiveTurn(subject, active);
    await store.clearActiveTurn(subject, "EvOTHER00001");
    expect(db.get(`THREAD#${subject}`, "META")?.activeTurn).toEqual(active);
    await store.clearActiveTurn(subject, active.eventId);
    expect(db.get(`THREAD#${subject}`, "META")).not.toHaveProperty("activeTurn");
    expect(db.get(`THREAD#${subject}`, "META")).toMatchObject({ pendingRequests: 1 });
    // Clearing again, with nothing saved, is not an error.
    await store.clearActiveTurn(subject, active.eventId);
  });

  it("reads a missing or malformed turn as none", () => {
    expect(activeTurnFromItem(undefined)).toBeUndefined();
    expect(activeTurnFromItem("EvWORK000001")).toBeUndefined();
    expect(activeTurnFromItem({ eventId: "EvWORK000001", workspaceId: active.workspaceId })).toBeUndefined();
    expect(activeTurnFromItem({ ...active, operationId: 7 })).toBeUndefined();
  });
});

describe("the turn note on the thread META row", () => {
  it("saves the note beside the thread's other fields, reads it back, and forgets it", async () => {
    const { db, store } = seeded();
    await store.saveTurnNote(subject, { eventId: active.eventId, text: "the task finished" });
    const item = db.get(`THREAD#${subject}`, "META");
    expect(item).toMatchObject({ workspaceId: active.workspaceId, pendingRequests: 1 });
    expect(turnNoteFromItem(item?.turnNote)).toEqual({ eventId: active.eventId, text: "the task finished" });
    await store.saveTurnNote(subject, undefined);
    expect(db.get(`THREAD#${subject}`, "META")).not.toHaveProperty("turnNote");
    expect(db.get(`THREAD#${subject}`, "META")).toMatchObject({ pendingRequests: 1 });
  });

  it("reads a missing or malformed note as none", () => {
    expect(turnNoteFromItem(undefined)).toBeUndefined();
    expect(turnNoteFromItem({ eventId: active.eventId })).toBeUndefined();
    expect(turnNoteFromItem({ eventId: active.eventId, text: "" })).toBeUndefined();
  });
});
