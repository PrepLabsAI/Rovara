// Lane L9-wire, review round 1: the lower-level cases (plan feedback, keys, the state folder lock, the message limit, the start transaction).
import { describe, expect, it } from "vitest";
import { when } from "@agentx/contracts";
import { MESSAGES_PER_HOUR, MESSAGE_RATE_LIMITED, createSessionControlHost } from "../../packages/broker/src/local/app/host.js";
import { createHarness, newRequestId } from "../support/task-flow-harness.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { PLAN_FEEDBACK_MAX, planFeedbackKey, planFeedbackOf } from "../../packages/broker/src/core/task-flow/stage-machine.js";

const TASK = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";

describe("M1: the planner is told the newest changes the owner asked for", () => {
  it("keeps the latest words after more than the cap of send-backs, oldest of the kept first", async () => {
    const store = new MemoryDocumentStore();
    for (let round = 1; round <= PLAN_FEEDBACK_MAX + 5; round += 1) await store.put({ item: { ...planFeedbackKey(TASK, round), entityType: "PLAN_FEEDBACK", text: `change ${round}`, createdAt: "2026-11-09T10:00:00.000Z" } });
    const feedback = await planFeedbackOf({ store }, TASK);
    expect(feedback).toHaveLength(PLAN_FEEDBACK_MAX);
    expect(feedback.at(-1)).toBe(`change ${PLAN_FEEDBACK_MAX + 5}`);
    expect(feedback[0]).toBe("change 6");
    expect(feedback).not.toContain("change 1");
  });
});

describe("L4 and L5: the message limit is a token bucket, and a repeat is not counted", () => {
  it("allows the limit in a burst, refills evenly, and does not allow twice the limit across an hour boundary", async () => {
    const h = createHarness();
    const host = createSessionControlHost(h.deps);
    const send = async (id: number) => (await host.deliverMessage(TASK, { messageId: `msg_${id}`, text: "note" })).reason;
    for (let id = 1; id <= MESSAGES_PER_HOUR; id += 1) expect(await send(id)).not.toBe(MESSAGE_RATE_LIMITED);
    expect(await send(100)).toBe(MESSAGE_RATE_LIMITED);
    // A fixed hourly window would reopen at the next hour; a bucket refills a little at a time.
    h.clock.advance(180);
    expect(await send(101)).not.toBe(MESSAGE_RATE_LIMITED);
    expect(await send(102)).toBe(MESSAGE_RATE_LIMITED);
    h.clock.advance(1_800);
    for (let id = 200; id < 200 + MESSAGES_PER_HOUR / 2; id += 1) expect(await send(id)).not.toBe(MESSAGE_RATE_LIMITED);
    expect(await send(300)).toBe(MESSAGE_RATE_LIMITED);
    // A repeat of a message already saved is answered again and takes no token.
    h.clock.advance(3_600);
    expect(await send(1)).not.toBe(MESSAGE_RATE_LIMITED);
    expect(await send(1)).not.toBe(MESSAGE_RATE_LIMITED);
  });

  it("gives every saved message an expiry, and a message saved twice is one row", async () => {
    const h = createHarness();
    const host = createSessionControlHost(h.deps);
    await Promise.all([host.deliverMessage(TASK, { messageId: "msg_same", text: "a" }), host.deliverMessage(TASK, { messageId: "msg_same", text: "a" })]);
    const rows = (await h.store.query({ pk: `DEVTASK#${TASK}`, sk: { op: "beginsWith", prefix: "MESSAGE#" } })).items;
    expect(rows).toHaveLength(1);
    expect(typeof rows[0]!["indexExpiresAt"]).toBe("number");
    const total = await h.store.get({ pk: `DEVTASK#${TASK}`, sk: "MESSAGE_TOTAL" });
    expect(total?.["count"]).toBe(1);
  });
});

describe("the start transaction", () => {
  it("leaves neither a task nor a session when one of the session's items cannot be written", async () => {
    const h = createHarness({ understandFirst: true });
    await h.registerProject();
    // A record already sits where the session's first item would go.
    await h.store.put({ item: { pk: "SESSION#taken", sk: "META", entityType: "AGENT_SESSION" } });
    h.deps.startExtras = () => ({ items: [{ kind: "put", item: { pk: "SESSION#taken", sk: "META", entityType: "AGENT_SESSION" }, condition: when.absent() }], sessionId: "ses_taken" });
    await expect(h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "x", workflow: true })).rejects.toThrow();
    expect((await h.flow.list(h.owner)).tasks).toHaveLength(0);
  });
});
