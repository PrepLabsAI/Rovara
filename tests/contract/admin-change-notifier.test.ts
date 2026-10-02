// tests/contract/admin-change-notifier.test.ts
// Spec 025 E13: a change whose Slack step started gets one direct message with Confirm and Cancel;
// when the change ends, the message is edited to say how. Only the notifier posts (D11).
import { AdminChangePendingRecordSchema } from "@agentx/contracts";
import { marshall } from "@aws-sdk/util-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { ADMIN_CHANGE_EXPIRY_GRACE_MS, cachedSlackClient, createNotifierHandler, noticeDelaySeconds, type NotifierDependencies } from "../../packages/broker/src/aws/developer-task-notifier.js";
import { SlackPostError, chatPostMessage, chatUpdate } from "../../packages/broker/src/aws/slack-web.js";
import { adminChangeMessage, adminChangeOutcomeMessage } from "../../packages/broker/src/developer/change-messages.js";
import { noticesFromStream, type Notice, type StreamRecord } from "../../packages/broker/src/developer/notifications.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const CHANGE = "55555555-5555-4555-8555-555555555555";
const PLANTED = `xoxb-${"4".repeat(10)}-planted`;
const BOT_TOKEN = "xoxb-9999-8888-plantedbottoken";
const pending = (extra: Record<string, unknown> = {}) => ({
  pk: `ADMIN_CHANGE#${CHANGE}`, sk: "META", entityType: "ADMIN_CHANGE", changeId: CHANGE, kind: "bind_channel", status: "pending",
  input: { kind: "bind_channel", channel: "C0LEDGER01", project: "ledger" }, details: {}, stateHash: "h".repeat(64),
  effect: `Bind channel #ledger-dev (C0LEDGER01) to project ledger. It is bound to nothing today. <script> ${PLANTED}`,
  admin: { issuer: "https://identity.example.test", subject: "admin-subject", ownerKey: "o".repeat(64), displayName: "Ada" }, slackUserId: "U0ADA00001",
  methodsOffered: ["slack"], createdAt: "2026-10-02T09:00:00.000Z", proposedAt: "2026-10-02T09:00:00.000Z", expiresAt: "2026-10-02T09:10:00.000Z", traceId: "trace-7",
  indexExpiresAt: 1_762_074_000, ...extra,
});
const DM = { channel: "D0ADMINDM1", ts: "1696237200.000100", postedAt: "2026-10-02T09:00:06.000Z" };
const modify = (before: Record<string, unknown>, after: Record<string, unknown>): StreamRecord => ({ eventID: "e1", eventName: "MODIFY", dynamodb: { OldImage: marshall(before), NewImage: marshall(after) } });
const dmNotice = { id: `${CHANGE}:dm`, kind: "admin_change_dm", changeId: CHANGE, at: "2026-10-02T09:00:05.000Z" };
const outcomeNotice = { id: `${CHANGE}:outcome`, kind: "admin_change_outcome", changeId: CHANGE, at: "2026-10-02T09:02:00.000Z" };

function notifier(db: FakeDynamoDb, now = Date.parse("2026-10-02T09:01:00.000Z"), overrides: Partial<NotifierDependencies> = {}) {
  const posts: Array<{ channel: string; text: string; blocks?: unknown[] }> = [];
  const updates: Array<{ channel: string; ts: string; text: string; blocks: unknown[] }> = [];
  const logs: Array<Record<string, unknown>> = [];
  const clock = { now };
  const deps: NotifierDependencies = {
    documentClient: db, tableName: "state", enqueue: vi.fn(async () => undefined), retryLater: vi.fn(async () => undefined),
    post: vi.fn(async (input: { channel: string; text: string; blocks?: unknown[] }) => { posts.push(input); return { ts: "1696237200.000100", channel: "D0ADMINDM1" }; }),
    update: vi.fn(async (input: { channel: string; ts: string; text: string; blocks: unknown[] }) => { updates.push(input); }),
    now: () => clock.now, log: (entry) => logs.push(entry), deliveryFailed: vi.fn(),
    ...overrides,
  };
  const handler = createNotifierHandler(deps);
  const deliver = (notice: unknown) => handler({ Records: [{ eventSource: "aws:sqs", messageId: "m1", receiptHandle: "r1", body: JSON.stringify(notice) }] });
  return { posts, updates, logs, deliver, clock, deps };
}

describe("the Slack Confirm message (E13)", () => {
  it("turns the start of the Slack step, and the end of a change with a message, into notices", () => {
    expect(noticesFromStream([modify(pending(), pending({ slackRequestedAt: "2026-10-02T09:00:05.000Z" }))])).toEqual([expect.objectContaining({ id: `${CHANGE}:dm`, kind: "admin_change_dm", changeId: CHANGE })]);
    const dm = { channel: "D0ADMINDM1", ts: "1696237200.000100", postedAt: "2026-10-02T09:00:06.000Z" };
    expect(noticesFromStream([modify(pending({ dm }), pending({ dm, status: "applied" }))])).toEqual([expect.objectContaining({ id: `${CHANGE}:outcome`, kind: "admin_change_outcome" })]);
    expect(noticesFromStream([modify(pending(), pending({ status: "applied" }))])).toEqual([]);
  });

  it("gives an outcome notice for every ended status, and none while the change is still pending or applying", () => {
    for (const status of ["applied", "declined", "expired", "failed"]) {
      expect(noticesFromStream([modify(pending({ dm: DM }), pending({ dm: DM, status }))])).toEqual([expect.objectContaining({ id: `${CHANGE}:outcome`, kind: "admin_change_outcome", changeId: CHANGE })]);
    }
    // Task 7's `unavailable` press leaves the change pending: its buttons stay.
    expect(noticesFromStream([modify(pending({ dm: DM }), pending({ dm: DM, claimedAt: "2026-10-02T09:01:00.000Z" }))])).toEqual([]);
    expect(noticesFromStream([modify(pending({ dm: DM }), pending({ dm: DM, status: "applying" }))])).toEqual([]);
    // The notifier's own writes: the claim, the message and its edit, start nothing.
    const requested = { slackRequestedAt: "2026-10-02T09:00:05.000Z" };
    expect(noticesFromStream([modify(pending(requested), pending({ ...requested, dmClaimedAt: "2026-10-02T09:00:06.000Z" }))])).toEqual([]);
    expect(noticesFromStream([modify(pending(requested), pending({ ...requested, dm: DM }))])).toEqual([]);
    expect(noticesFromStream([modify(pending({ dm: DM, status: "applied" }), pending({ dm: DM, status: "applied", dmEditedAt: "2026-10-02T09:02:01.000Z" }))])).toEqual([]);
    // A Slack step on a change that already ended posts nothing.
    expect(noticesFromStream([modify(pending({ status: "declined" }), pending({ status: "declined", ...requested }))])).toEqual([]);
  });

  it("edits a message recorded only after the change ended, so it never keeps live buttons", () => {
    expect(noticesFromStream([modify(pending({ status: "applied" }), pending({ status: "applied", dm: DM }))])).toEqual([expect.objectContaining({ id: `${CHANGE}:outcome`, kind: "admin_change_outcome" })]);
  });

  it("starts nothing when the table's TTL removes a change", () => {
    const removed: StreamRecord = { eventID: "e2", eventName: "REMOVE", dynamodb: { OldImage: marshall(pending({ dm: DM, status: "applied", slackRequestedAt: "2026-10-02T09:00:05.000Z" })) } };
    expect(noticesFromStream([removed])).toEqual([]);
  });

  it("posts one direct message to the admin's Slack user, with Confirm and Cancel, escaped and redacted", async () => {
    const db = new FakeDynamoDb();
    db.set(pending({ slackRequestedAt: "2026-10-02T09:00:05.000Z" }));
    const { posts, logs, deliver } = notifier(db);
    await deliver({ id: `${CHANGE}:dm`, kind: "admin_change_dm", changeId: CHANGE, at: "2026-10-02T09:00:05.000Z" });
    await deliver({ id: `${CHANGE}:dm`, kind: "admin_change_dm", changeId: CHANGE, at: "2026-10-02T09:00:05.000Z" });
    expect(posts).toHaveLength(1);
    expect(posts[0]?.channel).toBe("U0ADA00001");
    expect(posts[0]?.text).toContain("&lt;script&gt;");
    expect(JSON.stringify(posts)).not.toContain(PLANTED);
    expect(JSON.stringify(posts[0]?.blocks)).toContain("agentx_admin_change_confirm");
    expect(JSON.stringify(posts[0]?.blocks)).toContain(`"value":"${CHANGE}"`);
    expect(db.get(`ADMIN_CHANGE#${CHANGE}`, "META")).toMatchObject({ dm: { channel: "D0ADMINDM1", ts: "1696237200.000100" } });
    expect(logs).toContainEqual(expect.objectContaining({ event: "admin_change.dm_posted", changeId: CHANGE, traceId: "trace-7" }));
  });

  it("posts nothing for a change that already ended or expired", async () => {
    const db = new FakeDynamoDb();
    db.set(pending({ slackRequestedAt: "2026-10-02T09:00:05.000Z", status: "declined" }));
    const { posts, deliver } = notifier(db);
    await deliver({ id: `${CHANGE}:dm`, kind: "admin_change_dm", changeId: CHANGE, at: "2026-10-02T09:00:05.000Z" });
    const expired = new FakeDynamoDb();
    expired.set(pending({ slackRequestedAt: "2026-10-02T09:00:05.000Z" }));
    const late = notifier(expired, Date.parse("2026-10-02T09:11:00.000Z"));
    await late.deliver({ id: `${CHANGE}:dm`, kind: "admin_change_dm", changeId: CHANGE, at: "2026-10-02T09:00:05.000Z" });
    expect([...posts, ...late.posts]).toEqual([]);
  });

  it("edits the message once the change ends, removing the buttons", async () => {
    const db = new FakeDynamoDb();
    db.set(pending({ status: "applied", pressedBy: "U0ADA00001", dm: { channel: "D0ADMINDM1", ts: "1696237200.000100", postedAt: "2026-10-02T09:00:06.000Z" } }));
    const { updates, deliver } = notifier(db);
    await deliver({ id: `${CHANGE}:outcome`, kind: "admin_change_outcome", changeId: CHANGE, at: "2026-10-02T09:02:00.000Z" });
    await deliver({ id: `${CHANGE}:outcome`, kind: "admin_change_outcome", changeId: CHANGE, at: "2026-10-02T09:02:00.000Z" });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ channel: "D0ADMINDM1", ts: "1696237200.000100" });
    expect(updates[0]?.text).toContain("Applied, confirmed by <@U0ADA00001>.");
    expect(JSON.stringify(updates[0]?.blocks)).not.toContain("agentx_admin_change_confirm");
  });

  it("edits the message of an ended change that no longer keeps its input (R3 mitigation)", async () => {
    const db = new FakeDynamoDb();
    const ended: Record<string, unknown> = pending({ status: "declined", dm: DM });
    delete ended.input;
    db.set(ended);
    const { updates, deliver } = notifier(db);
    await deliver(outcomeNotice);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ channel: "D0ADMINDM1", ts: "1696237200.000100" });
    expect(AdminChangePendingRecordSchema.safeParse(db.get(`ADMIN_CHANGE#${CHANGE}`, "META")).success).toBe(true);
  });
});

describe("an expired Confirm message loses its buttons without a press (#217)", () => {
  const expiryNotice: Notice = { id: `${CHANGE}:expiry`, kind: "admin_change_expiry", changeId: CHANGE, at: "2026-10-02T09:00:06.000Z", notBefore: "2026-10-02T09:10:05.000Z" };
  const afterExpiry = Date.parse("2026-10-02T09:10:06.000Z");

  it("schedules the expiry edit when it posts the message, just after the change expires", async () => {
    const db = new FakeDynamoDb();
    db.set(pending({ slackRequestedAt: "2026-10-02T09:00:05.000Z" }));
    const enqueue = vi.fn(async () => undefined);
    const h = notifier(db, Date.parse("2026-10-02T09:00:06.000Z"), { enqueue });
    await h.deliver(dmNotice);
    expect(h.posts).toHaveLength(1);
    expect(enqueue).toHaveBeenCalledExactlyOnceWith([expiryNotice]);
    expect(Date.parse(expiryNotice.notBefore!) - Date.parse("2026-10-02T09:10:00.000Z")).toBe(ADMIN_CHANGE_EXPIRY_GRACE_MS);
    // A repeated delivery of a posted message schedules it again (the edit happens once), so a
    // failed schedule is never lost.
    await h.deliver(dmNotice);
    expect(h.posts).toHaveLength(1);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it("delays the queued notice until its time, within SQS's 15 minutes", () => {
    const now = Date.parse("2026-10-02T09:00:06.000Z");
    expect(noticeDelaySeconds(expiryNotice, now)).toBe(599);
    expect(noticeDelaySeconds({ ...expiryNotice, notBefore: "2026-10-02T10:00:00.000Z" }, now)).toBe(900);
    expect(noticeDelaySeconds({ ...expiryNotice, notBefore: "2026-10-02T08:00:00.000Z" }, now)).toBe(0);
    expect(noticeDelaySeconds({ ...dmNotice, kind: "admin_change_dm" }, now)).toBe(0);
  });

  it("edits a still-pending expired message to say it expired, with no buttons, once", async () => {
    const db = new FakeDynamoDb();
    db.set(pending({ slackRequestedAt: "2026-10-02T09:00:05.000Z", dm: DM }));
    const h = notifier(db, afterExpiry);
    await h.deliver(expiryNotice);
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]).toMatchObject({ channel: DM.channel, ts: DM.ts });
    expect(h.updates[0]?.text).toContain("Expired; nothing was changed. Ask again if you still want it.");
    expect(JSON.stringify(h.updates[0]?.blocks)).not.toContain("agentx_admin_change");
    expect(JSON.stringify(h.updates[0])).not.toContain(PLANTED);
    expect(db.get(`ADMIN_CHANGE#${CHANGE}`, "META")).toMatchObject({ status: "pending", dmEditedAt: "2026-10-02T09:10:06.000Z" });
    expect(AdminChangePendingRecordSchema.safeParse(db.get(`ADMIN_CHANGE#${CHANGE}`, "META")).success).toBe(true);
    await h.deliver(expiryNotice);
    // The broker later records the expiry on its first touch; that outcome edits nothing more.
    db.set({ ...db.get(`ADMIN_CHANGE#${CHANGE}`, "META") as Record<string, unknown>, status: "expired" });
    await h.deliver(outcomeNotice);
    expect(h.updates).toHaveLength(1);
  });

  it("waits, editing nothing, while the change has not expired yet", async () => {
    const db = new FakeDynamoDb();
    db.set(pending({ slackRequestedAt: "2026-10-02T09:00:05.000Z", dm: DM }));
    const retryLater = vi.fn(async () => undefined);
    const h = notifier(db, Date.parse("2026-10-02T09:10:01.000Z"), { retryLater });
    const answer = await h.deliver(expiryNotice);
    expect(h.updates).toEqual([]);
    expect(answer.batchItemFailures).toEqual([{ itemIdentifier: "m1" }]);
    expect(retryLater).toHaveBeenCalledOnce();
  });

  it("leaves an answered change's message to its outcome edit", async () => {
    for (const status of ["applying", "applied", "declined"]) {
      const db = new FakeDynamoDb();
      db.set(pending({ status, dm: DM }));
      const h = notifier(db, afterExpiry);
      await h.deliver(expiryNotice);
      expect(h.updates).toEqual([]);
      expect(db.get(`ADMIN_CHANGE#${CHANGE}`, "META")).not.toHaveProperty("dmEditedAt");
    }
  });

  it("puts the outcome back when an outcome edit landed between its read and its expiry edit (review)", async () => {
    const db = new FakeDynamoDb();
    db.set(pending({ dm: DM }));
    const h = notifier(db, afterExpiry, {
      update: vi.fn(async (input: { channel: string; ts: string; text: string; blocks: unknown[] }) => {
        h.updates.push(input);
        // The outcome delivery edited and recorded first; this expiry edit then lands over it.
        if (h.updates.length === 1) db.set({ ...db.get(`ADMIN_CHANGE#${CHANGE}`, "META") as Record<string, unknown>, status: "applied", pressedBy: "U0ADA00001", dmEditedAt: "2026-10-02T09:10:05.500Z" });
      }),
    });
    await h.deliver(expiryNotice);
    expect(h.updates.at(-1)?.text.split("\n\n").at(-1)).toBe("Applied, confirmed by <@U0ADA00001>.");
  });

  it("edits once when a press recorded the expiry while it edited (review)", async () => {
    const db = new FakeDynamoDb();
    db.set(pending({ dm: DM }));
    const h = notifier(db, afterExpiry, {
      update: vi.fn(async (input: { channel: string; ts: string; text: string; blocks: unknown[] }) => {
        h.updates.push(input);
        if (h.updates.length === 1) db.set({ ...db.get(`ADMIN_CHANGE#${CHANGE}`, "META") as Record<string, unknown>, status: "expired" });
      }),
    });
    await h.deliver(expiryNotice);
    expect(h.updates).toHaveLength(1);
    expect(db.get(`ADMIN_CHANGE#${CHANGE}`, "META")).toHaveProperty("dmEditedAt");
  });

  it("writes the outcome over its expiry edit when the change was answered while it edited", async () => {
    const db = new FakeDynamoDb();
    db.set(pending({ dm: DM }));
    // The change applies between the notifier's read and its record of the edit.
    const h = notifier(db, afterExpiry, {
      update: vi.fn(async (input: { channel: string; ts: string; text: string; blocks: unknown[] }) => {
        h.updates.push(input);
        if (h.updates.length === 1) db.set({ ...db.get(`ADMIN_CHANGE#${CHANGE}`, "META") as Record<string, unknown>, status: "applied", pressedBy: "U0ADA00001" });
      }),
    });
    await h.deliver(expiryNotice);
    expect(h.updates.map((update) => update.text.split("\n\n").at(-1))).toEqual(["Expired; nothing was changed. Ask again if you still want it.", "Applied, confirmed by <@U0ADA00001>."]);
    expect(db.get(`ADMIN_CHANGE#${CHANGE}`, "META")).toHaveProperty("dmEditedAt");
  });
});

describe("the message's content (E13, R4, FR-051)", () => {
  const PRIVATE = `Bind channel #secret-launch (C0PRIVATE01, a private channel) to project ledger. ${PLANTED}`;

  it("shows the planning admin the effect that names their private channel, when there is one", async () => {
    const db = new FakeDynamoDb();
    db.set(pending({ slackRequestedAt: "2026-10-02T09:00:05.000Z", effect: "Bind channel C0PRIVATE01 (a private channel) to project ledger.", confirmationEffect: PRIVATE }));
    const { posts, deliver } = notifier(db);
    await deliver(dmNotice);
    expect(posts[0]?.text).toContain("#secret-launch");
    expect(JSON.stringify(posts)).not.toContain(PLANTED);
    const ended = AdminChangePendingRecordSchema.parse(pending({ status: "declined", dm: DM, effect: "Bind channel C0PRIVATE01 (a private channel) to project ledger.", confirmationEffect: PRIVATE }));
    expect(adminChangeOutcomeMessage(ended)?.text).toContain("#secret-launch");
  });

  it("shows the ID-only effect when no private channel is named", async () => {
    const db = new FakeDynamoDb();
    db.set(pending({ slackRequestedAt: "2026-10-02T09:00:05.000Z" }));
    const { posts, deliver } = notifier(db);
    await deliver(dmNotice);
    expect(posts[0]?.text).toContain("Bind channel #ledger-dev (C0LEDGER01) to project ledger.");
    expect(posts[0]?.text).toContain("It expires in 9 minutes.");
  });

  it("says how each ended change ended, with no buttons, no secret and no em dash", () => {
    const failedMessage = `the channel could not be bound; check it, then ask again ${PLANTED} <b>`;
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ status: "applied", pressedBy: "U0ADA00001" }, "Applied, confirmed by <@U0ADA00001>."],
      [{ status: "applied", methodUsed: "cli" }, "Applied."],
      [{ status: "declined" }, "Cancelled; nothing was changed."],
      [{ status: "expired" }, "Expired; nothing was changed. Ask again if you still want it."],
      [{ status: "failed", error: { code: "SLACK_UNAVAILABLE", message: failedMessage } }, "It was not applied: the channel could not be bound; check it, then ask again"],
    ];
    for (const [fields, said] of cases) {
      const message = adminChangeOutcomeMessage(AdminChangePendingRecordSchema.parse(pending({ dm: DM, ...fields })));
      expect(message?.text).toContain(said);
      const all = JSON.stringify(message);
      expect(all).not.toContain(PLANTED);
      expect(all).not.toContain("<b>");
      expect(all).not.toContain("agentx_admin_change");
      expect(all).not.toContain("\u2014");
    }
    for (const status of ["pending", "applying"]) expect(adminChangeOutcomeMessage(AdminChangePendingRecordSchema.parse(pending({ status })))).toBeUndefined();
    const confirm = JSON.stringify(adminChangeMessage(AdminChangePendingRecordSchema.parse(pending()), Date.parse("2026-10-02T09:09:30.000Z")));
    expect(confirm).toContain("It expires in 1 minute.");
    expect(confirm).not.toContain("\u2014");
  });

  it("keeps each block within Slack's section limit, without cutting an escape in two", () => {
    const long = pending({ effect: `${"&".repeat(1_000)} ${"x".repeat(2_990)}` });
    const message = adminChangeMessage(AdminChangePendingRecordSchema.parse(long), Date.parse("2026-10-02T09:01:00.000Z"));
    for (const block of message.blocks as Array<{ type: string; text?: { text: string } }>) {
      if (block.text === undefined) continue;
      expect(block.text.text.length).toBeLessThanOrEqual(3_000);
      expect(block.text.text).not.toMatch(/&[a-z]{0,3}(?:\.\.\.)?$/);
    }
  });
});

describe("delivering the message safely (C9)", () => {
  it("posts nothing to a change with no linked Slack user, nor one the notifier cannot read, and logs no text", async () => {
    const db = new FakeDynamoDb();
    const unlinked: Record<string, unknown> = pending({ slackRequestedAt: "2026-10-02T09:00:05.000Z" });
    delete unlinked.slackUserId;
    db.set(unlinked);
    const first = notifier(db);
    await first.deliver(dmNotice);
    const garbled = new FakeDynamoDb();
    garbled.set({ ...pending({ slackRequestedAt: "2026-10-02T09:00:05.000Z" }), surprise: PLANTED });
    const second = notifier(garbled);
    await second.deliver(dmNotice);
    await second.deliver(outcomeNotice);
    expect([...first.posts, ...second.posts, ...second.updates]).toEqual([]);
    expect(second.logs).toContainEqual(expect.objectContaining({ event: "admin_change.unreadable", changeId: CHANGE }));
    expect(JSON.stringify([...first.logs, ...second.logs])).not.toContain(PLANTED);
    expect(JSON.stringify([...first.logs, ...second.logs])).not.toContain("Bind channel");
  });

  it("answers a gone change as stale, posting nothing", async () => {
    const { posts, updates, logs, deliver } = notifier(new FakeDynamoDb());
    await deliver(dmNotice);
    await deliver(outcomeNotice);
    expect([...posts, ...updates]).toEqual([]);
    expect(logs.filter((entry) => entry.event === "developer_notifier.notice").map((entry) => entry.outcome)).toEqual(["stale", "stale"]);
  });

  it("retries while another delivery holds the claim, then takes a claim left by a delivery that died", async () => {
    const db = new FakeDynamoDb();
    db.set(pending({ slackRequestedAt: "2026-10-02T09:00:05.000Z", dmClaimedAt: "2026-10-02T09:00:50.000Z" }));
    const h = notifier(db);
    expect(await h.deliver(dmNotice)).toEqual({ batchItemFailures: [{ itemIdentifier: "m1" }] });
    expect(h.posts).toHaveLength(0);
    h.clock.now = Date.parse("2026-10-02T09:02:00.000Z");
    expect(await h.deliver(dmNotice)).toEqual({ batchItemFailures: [] });
    expect(h.posts).toHaveLength(1);
  });

  it("gives a failed post's claim back, so the retry posts, and a Slack refusal never logs the token", async () => {
    const db = new FakeDynamoDb();
    db.set(pending({ slackRequestedAt: "2026-10-02T09:00:05.000Z" }));
    let fail = true;
    const posted: unknown[] = [];
    const h = notifier(db, Date.parse("2026-10-02T09:01:00.000Z"), {
      post: vi.fn(async (input) => {
        if (fail) throw new SlackPostError("channel_not_found");
        posted.push(input);
        return { ts: "1696237200.000100", channel: "D0ADMINDM1" };
      }),
    });
    expect(await h.deliver(dmNotice)).toEqual({ batchItemFailures: [{ itemIdentifier: "m1" }] });
    expect(db.get(`ADMIN_CHANGE#${CHANGE}`, "META")).not.toHaveProperty("dmClaimedAt");
    expect(h.logs).toContainEqual(expect.objectContaining({ event: "developer_notifier.retry", kind: "admin_change_dm", reason: "channel_not_found" }));
    fail = false;
    await h.deliver(dmNotice);
    expect(posted).toHaveLength(1);
    expect(JSON.stringify(h.logs)).not.toContain(BOT_TOKEN);
    expect(JSON.stringify(h.logs)).not.toContain(PLANTED);
  });

  it("never recreates a change the TTL removed while its message was being posted", async () => {
    const db = new FakeDynamoDb();
    db.set(pending({ slackRequestedAt: "2026-10-02T09:00:05.000Z" }));
    const h = notifier(db, Date.parse("2026-10-02T09:01:00.000Z"), {
      post: vi.fn(async () => {
        db.delete(`ADMIN_CHANGE#${CHANGE}`, "META");
        return { ts: "1696237200.000100", channel: "D0ADMINDM1" };
      }),
    });
    await h.deliver(dmNotice);
    expect(db.get(`ADMIN_CHANGE#${CHANGE}`, "META")).toBeUndefined();
  });

  it("records the edit at the top level (ruling B2), and a later delivery edits nothing", async () => {
    const db = new FakeDynamoDb();
    db.set(pending({ status: "expired", dm: DM }));
    const h = notifier(db);
    await h.deliver(outcomeNotice);
    const stored = db.get(`ADMIN_CHANGE#${CHANGE}`, "META");
    expect(stored).toMatchObject({ dmEditedAt: "2026-10-02T09:01:00.000Z", dm: DM });
    expect(AdminChangePendingRecordSchema.safeParse(stored).success).toBe(true);
    expect(h.logs).toContainEqual(expect.objectContaining({ event: "admin_change.dm_edited", changeId: CHANGE, traceId: "trace-7", status: "expired" }));
    await h.deliver(outcomeNotice);
    expect(h.updates).toHaveLength(1);
  });

  it("edits nothing while the change is still pending, and nothing without a message", async () => {
    const db = new FakeDynamoDb();
    db.set(pending({ dm: DM }));
    const h = notifier(db);
    await h.deliver(outcomeNotice);
    const none = new FakeDynamoDb();
    none.set(pending({ status: "applied" }));
    const other = notifier(none);
    await other.deliver(outcomeNotice);
    expect([...h.updates, ...other.updates]).toEqual([]);
    expect(other.logs).toContainEqual(expect.objectContaining({ event: "developer_notifier.notice", kind: "admin_change_outcome", outcome: "stale" }));
  });

  it("keeps the stored change readable by the broker after the notifier's writes", async () => {
    const db = new FakeDynamoDb();
    db.set(pending({ slackRequestedAt: "2026-10-02T09:00:05.000Z" }));
    await notifier(db).deliver(dmNotice);
    expect(AdminChangePendingRecordSchema.safeParse(db.get(`ADMIN_CHANGE#${CHANGE}`, "META")).success).toBe(true);
  });
});

// 25c note 3 applied to E13: the Confirm message is claimed and posted once, as the start message
// is, so a post that may have landed (and a lapsed claim) is logged the same way.
describe("an uncertain Confirm message post is logged (25c note 3)", () => {
  const uncertain = (logs: Array<Record<string, unknown>>) => logs.filter((entry) => entry.event === "admin_change.dm_post_uncertain");
  const poster = (fetchImplementation: () => Promise<Response>) => cachedSlackClient(async () => BOT_TOKEN, Date.now, fetchImplementation).post;

  it("logs a post whose request failed before Slack answered, with the IDs and the error's name only", async () => {
    const db = new FakeDynamoDb();
    db.set(pending({ slackRequestedAt: "2026-10-02T09:00:05.000Z" }));
    const h = notifier(db, Date.parse("2026-10-02T09:01:00.000Z"), {
      post: poster(async () => { throw Object.assign(new Error(`the operation was aborted ${BOT_TOKEN}`), { name: "TimeoutError" }); }),
    });
    await h.deliver(dmNotice);
    expect(uncertain(h.logs)).toEqual([{ event: "admin_change.dm_post_uncertain", reason: "post_error", changeId: CHANGE, traceId: "trace-7", error: "TimeoutError" }]);
    expect(JSON.stringify(h.logs)).not.toContain(BOT_TOKEN);
    expect(JSON.stringify(h.logs)).not.toContain(PLANTED);
  });

  it("logs a post that met a 5xx answer, and not one Slack refused with its own error code", async () => {
    const db = new FakeDynamoDb();
    db.set(pending({ slackRequestedAt: "2026-10-02T09:00:05.000Z" }));
    const h = notifier(db, Date.parse("2026-10-02T09:01:00.000Z"), {
      post: poster(async () => ({ ok: false, status: 503, json: async () => { throw new Error("not json"); } }) as unknown as Response),
    });
    await h.deliver(dmNotice);
    expect(uncertain(h.logs)).toEqual([{ event: "admin_change.dm_post_uncertain", reason: "post_error", changeId: CHANGE, traceId: "trace-7", error: "SlackPostError" }]);
    const refusedDb = new FakeDynamoDb();
    refusedDb.set(pending({ slackRequestedAt: "2026-10-02T09:00:05.000Z" }));
    const refused = notifier(refusedDb, Date.parse("2026-10-02T09:01:00.000Z"), {
      post: poster(async () => Response.json({ ok: false, error: "channel_not_found" })),
    });
    await refused.deliver(dmNotice);
    expect(uncertain(refused.logs)).toEqual([]);
  });

  it("logs a claim left by a delivery that died, once, from the delivery that takes it over", async () => {
    const db = new FakeDynamoDb();
    db.set(pending({ slackRequestedAt: "2026-10-02T09:00:05.000Z", dmClaimedAt: "2026-10-02T09:00:50.000Z" }));
    const h = notifier(db);
    await h.deliver(dmNotice);
    expect(uncertain(h.logs)).toEqual([]);
    h.clock.now = Date.parse("2026-10-02T09:02:00.000Z");
    await h.deliver(dmNotice);
    expect(h.posts).toHaveLength(1);
    expect(uncertain(h.logs)).toEqual([{ event: "admin_change.dm_post_uncertain", reason: "claim_lapsed", changeId: CHANGE, traceId: "trace-7" }]);
  });

  it("logs nothing for a first post that lands", async () => {
    const db = new FakeDynamoDb();
    db.set(pending({ slackRequestedAt: "2026-10-02T09:00:05.000Z" }));
    const h = notifier(db);
    await h.deliver(dmNotice);
    expect(h.posts).toHaveLength(1);
    expect(uncertain(h.logs)).toEqual([]);
  });
});

describe("Slack's two calls", () => {
  it("chat.postMessage sends the blocks and answers the message's channel", async () => {
    const ok = vi.fn(async () => Response.json({ ok: true, ts: "1696237200.000100", channel: "D0ADMINDM1" }));
    expect(await chatPostMessage(BOT_TOKEN, { channel: "U0ADA00001", text: "hi", blocks: [{ type: "divider" }] }, ok as unknown as typeof fetch)).toEqual({ ts: "1696237200.000100", channel: "D0ADMINDM1" });
    expect(JSON.parse((ok.mock.calls[0] as unknown as [string, RequestInit & { body: string }])[1].body) as unknown).toMatchObject({ channel: "U0ADA00001", blocks: [{ type: "divider" }] });
  });

  it("chat.update edits by channel and ts, and reports Slack's error code without the token", async () => {
    const ok = vi.fn(async () => Response.json({ ok: true }));
    await chatUpdate(BOT_TOKEN, { channel: "D0ADMINDM1", ts: "1696237200.000100", text: "done", blocks: [] }, ok);
    const [url, init] = ok.mock.calls[0] as unknown as [string, RequestInit & { body: string; headers: Record<string, string> }];
    expect(url).toBe("https://slack.com/api/chat.update");
    expect(init.headers.authorization).toBe(`Bearer ${BOT_TOKEN}`);
    expect(JSON.parse(init.body) as unknown).toEqual({ channel: "D0ADMINDM1", ts: "1696237200.000100", text: "done", blocks: [] });
    expect(init.body).not.toContain(BOT_TOKEN);
    const refused = vi.fn(async () => Response.json({ ok: false, error: "message_not_found" }));
    const error = await chatUpdate(BOT_TOKEN, { channel: "D0ADMINDM1", ts: "1", text: "done", blocks: [] }, refused as unknown as typeof fetch).catch((caught: unknown) => caught as SlackPostError);
    expect(error).toMatchObject({ slackError: "message_not_found" });
    expect(error.message).toContain("chat.update");
    expect(error.message).not.toContain(BOT_TOKEN);
    const broken = vi.fn(async () => new Response(`oops ${BOT_TOKEN}`, { status: 502 }));
    const unreadable = await chatUpdate(BOT_TOKEN, { channel: "D0ADMINDM1", ts: "1", text: "done", blocks: [] }, broken as unknown as typeof fetch).catch((caught: unknown) => caught as SlackPostError);
    expect(unreadable.slackError).toBe("http_502");
    expect(unreadable.message).not.toContain(BOT_TOKEN);
  });

  it("posts and edits with one cached bot token, loaded again after Slack refuses it", async () => {
    const loadToken = vi.fn(async () => BOT_TOKEN);
    let answer: Record<string, unknown> = { ok: true, ts: "1696237200.000100" };
    const fetcher = vi.fn(async () => Response.json(answer));
    const slack = cachedSlackClient(loadToken, () => 0, fetcher);
    await slack.post({ channel: "U0ADA00001", text: "hi" });
    await slack.update({ channel: "D0ADMINDM1", ts: "1696237200.000100", text: "done", blocks: [] });
    expect(loadToken).toHaveBeenCalledTimes(1);
    answer = { ok: false, error: "invalid_auth" };
    await expect(slack.update({ channel: "D0ADMINDM1", ts: "1", text: "done", blocks: [] })).rejects.toMatchObject({ slackError: "invalid_auth" });
    answer = { ok: true, ts: "1696237200.000200" };
    await slack.post({ channel: "U0ADA00001", text: "hi" });
    expect(loadToken).toHaveBeenCalledTimes(2);
  });
});
