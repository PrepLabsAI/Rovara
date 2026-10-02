import { describe, expect, it, vi } from "vitest";
import { CONFIRMATION_TTL_MS, PendingConfirmationSchema, answeredConfirmationBlocks, confirmationBlocks, confirmationClickEventId, parseConfirmationClickEventId, parseConfirmationReply, type PendingConfirmation, type SlackRequestMessage } from "../../packages/contracts/src/index.js";
import { createGateSession } from "../../packages/orchestrator/src/action-gate.js";
import { createDynamoConfirmationStore } from "../../packages/slack-service/src/confirmation-store.js";
import {
  ALREADY_USED_BY_THIS_REQUEST_TEXT,
  CANCELLED_TEXT,
  NO_LONGER_PENDING_TEXT,
  YES_TO_ALL_TEXT,
  checkConfirmation,
  confirmationMessage,
  settleConfirmations,
} from "../../packages/slack-service/src/confirmations.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const subject = "T0BSHLLUGBD/C0123456789/1695500000.000001";
const requester = "U0123456789";
const other = "U0456789012";
const postedAt = Date.parse("2026-09-25T10:00:00.000Z");
const pending: PendingConfirmation = {
  confirmationId: "44444444-4444-5444-8444-444444444444", requesterId: requester,
  calls: [{ tool: "tracker__close_item", argumentsHash: "a".repeat(64), summary: "tracker__close_item: id=TRK-9", kind: "destructive" }],
  postedAt: new Date(postedAt).toISOString(), expiresAt: new Date(postedAt + CONFIRMATION_TTL_MS).toISOString(),
};

function message(text: string, overrides: Partial<SlackRequestMessage> = {}): SlackRequestMessage {
  return {
    version: 1, eventId: "EvYES0000001", userId: requester, text, receivedAt: new Date(postedAt + 60_000).toISOString(),
    thread: { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001" }, ...overrides,
  };
}

function harness(now = postedAt + 120_000) {
  const db = new FakeDynamoDb();
  const store = createDynamoConfirmationStore(db, "threads", () => now);
  const posts: string[] = [];
  const log = vi.fn();
  const check = (text: string, overrides: Partial<SlackRequestMessage> = {}) =>
    checkConfirmation({ message: message(text, overrides), subject, store, post: async (value) => { posts.push(value); }, log, now });
  return { db, store, posts, log, check };
}

describe("confirmation replies and clicks", () => {
  it("reads yes, yes to all and cancel, and nothing else, as an answer", () => {
    for (const text of ["yes", "Yes.", "<@U0AGENTX01> yes", "y", "yep", "confirm", "approve", "go ahead!"]) expect(parseConfirmationReply(text)).toBe("yes");
    for (const text of ["yes to all", "Yes, to all in this thread.", "<@U0AGENTX01> yes to all in this thread"]) expect(parseConfirmationReply(text)).toBe("yes_to_all");
    for (const text of ["cancel", "No.", "don't"]) expect(parseConfirmationReply(text)).toBe("cancel");
    for (const text of ["yes, and also close TRK-10", "yesterday", "cancel PR 12", ""]) expect(parseConfirmationReply(text)).toBeUndefined();
  });

  it("reads a few more whole-message answers, and a mention with a label", () => {
    for (const text of ["yes please", "Yes, please.", "ok", "OK!", "okay", "sure", "do it", "<@U0AGENTX01|agentx> yes"]) expect(parseConfirmationReply(text)).toBe("yes");
    for (const text of ["nope", "no thanks", "No, thanks."]) expect(parseConfirmationReply(text)).toBe("cancel");
    expect(parseConfirmationReply("<@U0AGENTX01|agentx> yes to all")).toBe("yes_to_all");
    for (const text of ["yes, but don't delete", "yesterday", "yes\nclose TRK-10", "ok\nand close TRK-10", "sure thing, close all of them"]) expect(parseConfirmationReply(text)).toBeUndefined();
  });

  it("derives a click's event ID from the confirmation, and reads it back", () => {
    const eventId = confirmationClickEventId(pending.confirmationId, "approve");
    expect(eventId).toBe("EvAgxApprove44444444444454448444444444444444");
    expect(parseConfirmationClickEventId(eventId)).toEqual({ click: "approve", confirmationId: pending.confirmationId });
    expect(parseConfirmationClickEventId(confirmationClickEventId(pending.confirmationId, "cancel"))).toEqual({ click: "cancel", confirmationId: pending.confirmationId });
    expect(parseConfirmationClickEventId("Ev0000000001")).toBeUndefined();
  });

  it("gives a click on a re-posted confirmation (same ID, later postedAt) its own event ID, still a valid Slack event ID that reads back", () => {
    const first = confirmationClickEventId(pending.confirmationId, "approve", "2025-09-23T20:00:00.000Z");
    const second = confirmationClickEventId(pending.confirmationId, "approve", "2025-09-23T20:00:30.000Z");
    expect(first).toBe(`EvAgxApprove44444444444454448444444444444444${Date.parse("2025-09-23T20:00:00.000Z").toString(16)}`);
    expect(second).not.toBe(first);
    for (const eventId of [first, second, confirmationClickEventId(pending.confirmationId, "cancel", "2025-09-23T20:00:00.000Z")]) {
      expect(eventId).toMatch(/^Ev[A-Za-z0-9]{4,64}$/);
      expect(parseConfirmationClickEventId(eventId)?.confirmationId).toBe(pending.confirmationId);
    }
    expect(parseConfirmationClickEventId(`${first}0000000000000000`)).toBeUndefined();
  });
});

describe("the confirmation store", () => {
  it("lets one Slack event claim a live confirmation once, and leaves a tombstone only on the confirmation it names", async () => {
    const { db, store } = harness();
    await store.save(subject, pending);
    expect(await store.load(subject)).toEqual(pending);
    expect(db.get(`THREAD#${subject}`, "CONFIRMATION")?.expiresAt).toBe(Math.floor(Date.parse(pending.expiresAt) / 1_000) + 7 * 24 * 60 * 60);
    await store.retire(subject, "55555555-5555-5555-8555-555555555555", "EvYES0000003");
    expect((await store.load(subject))?.retiredAt).toBeUndefined();
    expect(await store.claim(subject, pending.confirmationId, "EvYES0000001")).toBe(true);
    // The claim is the tombstone: a redelivery of the same event, or any other event, cannot claim it again.
    expect(await store.load(subject)).toEqual({ ...pending, retiredAt: new Date(postedAt + 120_000).toISOString(), usedBy: "EvYES0000001" });
    expect(await store.claim(subject, pending.confirmationId, "EvYES0000001")).toBe(false);
    expect(await store.claim(subject, pending.confirmationId, "EvYES0000002")).toBe(false);
    await store.retire(subject, pending.confirmationId, "EvYES0000004");
    expect((await store.load(subject))?.usedBy).toBe("EvYES0000001");
  });

  it("opens only the unposted confirmation it names, and leaves any other item unchanged", async () => {
    const newer = { ...pending, confirmationId: "77777777-7777-5777-8777-777777777777" };
    const cases: Array<[string, (store: ReturnType<typeof createDynamoConfirmationStore>) => Promise<void>]> = [
      ["claimed", async (store) => { await store.save(subject, pending); await store.claim(subject, pending.confirmationId, "EvYES0000001"); }],
      ["cancelled", async (store) => { await store.save(subject, pending); await store.retire(subject, pending.confirmationId, "EvCANCEL0001"); }],
      ["replaced by a newer live one", async (store) => { await store.save(subject, newer); }],
      ["replaced by a newer unposted one", async (store) => { await store.save(subject, { ...newer, retiredAt: newer.postedAt, usedBy: "unposted" }); }],
    ];
    for (const [name, arrange] of cases) {
      const { db, store } = harness();
      await arrange(store);
      const before = structuredClone(db.get(`THREAD#${subject}`, "CONFIRMATION"));
      await expect(store.open(subject, pending.confirmationId), name).rejects.toMatchObject({ name: "ConditionalCheckFailedException" });
      expect(db.get(`THREAD#${subject}`, "CONFIRMATION"), name).toEqual(before);
    }
  });

  it("refuses a claim once the confirmation expired", async () => {
    const { store } = harness(Date.parse(pending.expiresAt) + 10 * 60_000);
    await store.save(subject, pending);
    expect(await store.claim(subject, pending.confirmationId, "EvYES0000001")).toBe(false);
    expect((await store.load(subject))?.retiredAt).toBeUndefined();
  });

  it("refuses to save an invalid confirmation, and logs an unreadable one without its content", async () => {
    const db = new FakeDynamoDb();
    const log = vi.fn();
    const store = createDynamoConfirmationStore(db, "threads", () => postedAt, log);
    await expect(store.save(subject, { ...pending, calls: [] })).rejects.toThrow();
    expect(db.get(`THREAD#${subject}`, "CONFIRMATION")).toBeUndefined();
    db.set({ pk: `THREAD#${subject}`, sk: "CONFIRMATION", confirmationId: pending.confirmationId, confirmation: { ...pending, requesterId: "secret-ish" } });
    expect(await store.load(subject)).toBeUndefined();
    expect(log).toHaveBeenCalledWith("gate.confirmation_unreadable", {});
  });

  it("grants yes to all to one member for 24 hours, renewably", async () => {
    const { db, store } = harness();
    await store.grantYesToAll(subject, requester);
    expect(await store.yesToAll(subject, requester)).toBe(true);
    expect(await store.yesToAll(subject, other)).toBe(false);
    const later = createDynamoConfirmationStore(db, "threads", () => postedAt + 120_000 + 25 * 60 * 60 * 1_000);
    expect(await later.yesToAll(subject, requester)).toBe(false);
    await later.grantYesToAll(subject, requester);
    expect(await later.yesToAll(subject, requester)).toBe(true);
  });
});

describe("checking a message against the thread's confirmation", () => {
  it("approves exactly the pending calls for the requester's yes, and claims nothing yet", async () => {
    const { store, check } = harness();
    await store.save(subject, pending);
    expect(await check("yes")).toEqual({ run: true, claim: { confirmationId: pending.confirmationId },
      session: createGateSession(requester, { approvals: [{ tool: "tracker__close_item", argumentsHash: "a".repeat(64), summary: "tracker__close_item: id=TRK-9" }] }) });
    expect(await store.claim(subject, pending.confirmationId, "EvOTHER00001")).toBe(true);
  });

  it("approves or cancels on the requester's button click for this confirmation, and refuses a click on an older one", async () => {
    const { store, check, posts } = harness();
    await store.save(subject, pending);
    expect(await check("yes", { eventId: confirmationClickEventId(pending.confirmationId, "approve") })).toMatchObject({ run: true, claim: { confirmationId: pending.confirmationId } });
    expect(await check("yes", { eventId: confirmationClickEventId("66666666-6666-5666-8666-666666666666", "approve") })).toEqual({ run: false, refused: "not_pending" });
    expect(await check("cancel", { eventId: confirmationClickEventId(pending.confirmationId, "cancel") })).toEqual({ run: false, answered: "cancelled" });
    expect(posts).toEqual([NO_LONGER_PENDING_TEXT, CANCELLED_TEXT]);
    expect((await store.load(subject))?.usedBy).toBe(confirmationClickEventId(pending.confirmationId, "cancel"));
  });

  it("runs nothing for a yes from a different member, and says who can confirm", async () => {
    const { store, check, posts, log } = harness();
    await store.save(subject, pending);
    expect(await check("yes", { userId: other })).toEqual({ run: false, refused: "other_member" });
    expect(posts).toEqual([`Only <@${requester}> can confirm what they asked for. Nothing was run.`]);
    expect(log).toHaveBeenCalledWith("gate.confirmation_refused", { eventId: "EvYES0000001", reason: "other_member" });
    expect(await store.load(subject)).toEqual(pending);
  });

  it("answers only a redelivery of the event that used, cancelled or superseded a confirmation with no longer pending", async () => {
    const { store, check, posts } = harness();
    await store.save(subject, pending);
    await store.retire(subject, pending.confirmationId, "EvYES0000001");
    // A fresh message after the tombstone is an ordinary request, whoever sends it.
    expect(await check("yes", { eventId: "EvYES0000002", receivedAt: new Date(postedAt + 180_000).toISOString() })).toEqual({ run: true, session: createGateSession(requester) });
    expect(await check("yes", { eventId: "EvYES0000003", userId: other, receivedAt: new Date(postedAt + 180_000).toISOString() })).toEqual({ run: true, session: createGateSession(other) });
    // The same event again hears that its earlier attempt used it (fix round 1, I1: the call may
    // already have run); a redelivered cancel, or one received before the tombstone was left,
    // hears that it is no longer pending.
    expect(await check("yes", { eventId: "EvYES0000001" })).toEqual({ run: false, refused: "already_used_by_this_request" });
    expect(await check("cancel", { eventId: "EvYES0000001" })).toEqual({ run: false, refused: "not_pending" });
    expect(await check("yes", { eventId: "EvYES0000004" })).toEqual({ run: false, refused: "not_pending" });
    // A click can only mean that confirmation: even from a new event after the tombstone, it runs no ordinary turn.
    expect(await check("yes", { eventId: confirmationClickEventId(pending.confirmationId, "approve"), receivedAt: new Date(postedAt + 180_000).toISOString() })).toEqual({ run: false, refused: "not_pending" });
    expect(posts).toEqual([ALREADY_USED_BY_THIS_REQUEST_TEXT, NO_LONGER_PENDING_TEXT, NO_LONGER_PENDING_TEXT, NO_LONGER_PENDING_TEXT]);
  });

  it("treats a fresh ok two minutes after a claim as an ordinary request", async () => {
    const { store, check, posts } = harness();
    await store.save(subject, pending);
    expect(await store.claim(subject, pending.confirmationId, "EvYES0000001")).toBe(true);
    expect(await check("ok", { eventId: "EvYES0000002", receivedAt: new Date(postedAt + 240_000).toISOString() })).toEqual({ run: true, session: createGateSession(requester) });
    expect(posts).toEqual([]);
  });

  it("does not count a yes sent before the question was posted, and retires one after it expired", async () => {
    const early = harness();
    await early.store.save(subject, pending);
    expect(await early.check("yes", { receivedAt: new Date(postedAt - 1_000).toISOString() })).toEqual({ run: false, refused: "before_request" });
    expect(early.posts[0]).toContain("arrived before I asked for confirmation");
    const late = harness(postedAt + CONFIRMATION_TTL_MS);
    await late.store.save(subject, pending);
    expect(await late.check("yes", { receivedAt: new Date(postedAt + CONFIRMATION_TTL_MS).toISOString() })).toEqual({ run: false, refused: "expired" });
    expect(late.posts).toEqual(["That confirmation request expired after 24 hours, so nothing was run. Ask me again if you still want it."]);
    expect((await late.store.load(subject))?.retiredAt).toBeDefined();
  });

  it("treats any other message as a request, which supersedes the requester's own pending confirmation", async () => {
    const { store, check } = harness();
    await store.save(subject, pending);
    expect(await check("actually, what's open?")).toEqual({ run: true, session: createGateSession(requester), superseded: pending.confirmationId });
    expect(await check("what's open?", { userId: other })).toEqual({ run: true, session: createGateSession(other) });
  });

  it("answers a plain yes or no with nothing pending as an ordinary request, and records yes to all", async () => {
    const { store, check, posts } = harness();
    expect(await check("yes")).toEqual({ run: true, session: createGateSession(requester) });
    expect(await check("no")).toEqual({ run: true, session: createGateSession(requester) });
    expect(await check("yes to all in this thread")).toEqual({ run: false, answered: "yes_to_all" });
    expect(posts).toEqual([YES_TO_ALL_TEXT]);
    expect(await check("create an item")).toEqual({ run: true, session: createGateSession(requester, { yesToAll: true }) });
    await store.save(subject, pending);
    expect(await check("yes to all", { eventId: "EvYES0000009" })).toMatchObject({ run: true, claim: { confirmationId: pending.confirmationId }, session: { yesToAll: true, approvals: [{ tool: "tracker__close_item" }] } });
  });
});

describe("tombstones, expiry and yes to all", () => {
  const EXPIRED_TEXT = "That confirmation request expired after 24 hours, so nothing was run. Ask me again if you still want it.";

  it("forgets a used confirmation's tombstone at the end of its 24 hours", async () => {
    const db = new FakeDynamoDb();
    const early = createDynamoConfirmationStore(db, "threads", () => postedAt + 120_000);
    await early.save(subject, pending);
    expect(await early.claim(subject, pending.confirmationId, "EvYES0000001")).toBe(true);
    const now = postedAt + 25 * 60 * 60 * 1_000;
    const store = createDynamoConfirmationStore(db, "threads", () => now);
    const posts: string[] = [];
    const check = (text: string, eventId: string) => checkConfirmation({ message: message(text, { eventId, receivedAt: new Date(now).toISOString() }), subject, store, post: async (value) => { posts.push(value); }, log: vi.fn(), now });
    expect(await check("yes", "EvYES0000002")).toEqual({ run: true, session: createGateSession(requester) });
    expect(await check("yes to all", "EvYES0000003")).toEqual({ run: false, answered: "yes_to_all" });
    expect(posts).toEqual([YES_TO_ALL_TEXT]);
    expect(await store.yesToAll(subject, requester)).toBe(true);
  });

  it("grants yes to all within 24 hours of a used confirmation", async () => {
    const { store, check, posts } = harness();
    await store.save(subject, pending);
    await store.claim(subject, pending.confirmationId, "EvYES0000001");
    expect(await check("yes to all in this thread", { eventId: "EvYES0000002" })).toEqual({ run: false, answered: "yes_to_all" });
    expect(posts).toEqual([YES_TO_ALL_TEXT]);
    expect(await store.yesToAll(subject, requester)).toBe(true);
  });

  it("runs nothing again for a redelivered approving event after its claim", async () => {
    const { store, check, posts } = harness();
    await store.save(subject, pending);
    expect(await check("yes")).toMatchObject({ run: true, claim: { confirmationId: pending.confirmationId } });
    expect(await store.claim(subject, pending.confirmationId, "EvYES0000001")).toBe(true);
    expect(await store.claim(subject, pending.confirmationId, "EvYES0000001")).toBe(false);
    expect(await check("yes")).toEqual({ run: false, refused: "already_used_by_this_request" });
    expect(posts).toEqual([ALREADY_USED_BY_THIS_REQUEST_TEXT]);
    const session = createGateSession(requester, { approvals: pending.calls });
    await settleConfirmations({ check: { run: true, session, claim: { confirmationId: pending.confirmationId } }, message: message("yes"), subject, store, postConfirmation: vi.fn(), log: vi.fn(), now: postedAt + 120_000 });
    expect((await store.load(subject))?.usedBy).toBe("EvYES0000001");
  });

  it("answers any member's yes after expiry with expired, and keeps saying so", async () => {
    const now = Date.parse(pending.expiresAt) + 60_000;
    const { store, check, posts } = harness(now);
    await store.save(subject, pending);
    const receivedAt = new Date(now).toISOString();
    expect(await check("yes", { userId: other, receivedAt })).toEqual({ run: false, refused: "expired" });
    expect((await store.load(subject))?.usedBy).toBe("expired");
    expect(await check("yes", { eventId: "EvYES0000002", receivedAt })).toEqual({ run: false, refused: "expired" });
    expect(posts).toEqual([EXPIRED_TEXT, EXPIRED_TEXT]);
  });

  it("answers expired for 24 hours after the expiry, then treats a yes as an ordinary request", async () => {
    const expiry = Date.parse(pending.expiresAt);
    for (const [after, expected] of [[2, "expired"], [30, "ordinary"]] as const) {
      const now = expiry + after * 60 * 60 * 1_000;
      const { store, check, posts } = harness(now);
      await store.save(subject, pending);
      await store.retire(subject, pending.confirmationId, "expired");
      const result = await check("yes", { eventId: "EvYES0000005", receivedAt: new Date(now).toISOString() });
      if (expected === "expired") {
        expect(result).toEqual({ run: false, refused: "expired" });
        expect(posts).toEqual([EXPIRED_TEXT]);
      } else {
        expect(result).toEqual({ run: true, session: createGateSession(requester) });
        expect(posts).toEqual([]);
      }
    }
  });

  it("forgets a never-answered confirmation 24 hours after its expiry, and answers expired before that", async () => {
    const expiry = Date.parse(pending.expiresAt);
    const soon = harness(expiry + 2 * 60 * 60 * 1_000);
    await soon.store.save(subject, pending);
    expect(await soon.check("yes", { receivedAt: new Date(expiry + 2 * 60 * 60 * 1_000).toISOString() })).toEqual({ run: false, refused: "expired" });
    expect(soon.posts).toEqual([EXPIRED_TEXT]);
    expect(await soon.store.load(subject)).toMatchObject({ usedBy: "expired" });
    const late = harness(expiry + 30 * 60 * 60 * 1_000);
    await late.store.save(subject, pending);
    expect(await late.check("yes", { receivedAt: new Date(expiry + 30 * 60 * 60 * 1_000).toISOString() })).toEqual({ run: true, session: createGateSession(requester) });
    expect(late.posts).toEqual([]);
  });

  it("retires a live confirmation that expired first, so yes to all grants at once and a plain yes hears expired", async () => {
    const now = Date.parse(pending.expiresAt) + 60 * 60 * 1_000;
    const { store, check, posts } = harness(now);
    await store.save(subject, pending);
    const receivedAt = new Date(now).toISOString();
    expect(await check("yes to all", { receivedAt })).toEqual({ run: false, answered: "yes_to_all" });
    expect(posts).toEqual([YES_TO_ALL_TEXT]);
    expect(await store.yesToAll(subject, requester)).toBe(true);
    expect(await store.load(subject)).toMatchObject({ usedBy: "expired" });
    expect(await check("yes", { eventId: "EvYES0000002", receivedAt })).toEqual({ run: false, refused: "expired" });
    expect(posts).toEqual([YES_TO_ALL_TEXT, EXPIRED_TEXT]);
  });

  it("retires a live, expired confirmation as expired on the requester's plain message, rather than superseding it", async () => {
    const now = Date.parse(pending.expiresAt) + 60 * 60 * 1_000;
    const { store, check, posts } = harness(now);
    await store.save(subject, pending);
    expect(await check("what's open?", { receivedAt: new Date(now).toISOString() })).toEqual({ run: true, session: createGateSession(requester) });
    expect(await store.load(subject)).toMatchObject({ usedBy: "expired" });
    expect(posts).toEqual([]);
  });

  it("tells a member whose confirmation another member's replaced that it was replaced", async () => {
    const { store, check, posts } = harness();
    await store.save(subject, pending);
    const session = createGateSession(other);
    session.asks.push({ toolCallId: "1", tool: "tracker__close_item", argumentsHash: "d".repeat(64), summary: "tracker__close_item: id=TRK-2", kind: "destructive" });
    await settleConfirmations({ check: { run: true, session }, message: message("close TRK-2", { eventId: "EvOTHER00001", userId: other }), subject, store, postConfirmation: vi.fn(), log: vi.fn(), now: postedAt + 60_000 });
    expect(await check("yes")).toEqual({ run: false, refused: "replaced" });
    expect(posts).toEqual([`The pending confirmation is <@${other}>'s; yours was replaced. Nothing was run.`]);
  });
});

describe("settling a turn's confirmations", () => {
  it("leaves a tombstone on the used confirmation, then stores and posts one message listing every blocked call once", async () => {
    const { store, log } = harness();
    await store.save(subject, pending);
    const session = createGateSession(requester);
    session.asks.push(
      { toolCallId: "1", tool: "tracker__close_item", argumentsHash: "b".repeat(64), summary: "tracker__close_item: id=TRK-1", kind: "destructive" },
      { toolCallId: "2", tool: "tracker__save_item", argumentsHash: "c".repeat(64), summary: "tracker__save_item: id=&lt;!here&gt;", kind: "classifier" },
      { toolCallId: "3", tool: "tracker__close_item", argumentsHash: "b".repeat(64), summary: "tracker__close_item: id=TRK-1", kind: "destructive" },
    );
    const posted: Array<{ id: string; text: string }> = [];
    const now = postedAt + 300_000;
    await settleConfirmations({ check: { run: true, session, claim: { confirmationId: pending.confirmationId } }, message: message("yes"), subject, store,
      postConfirmation: async (confirmation, text) => { posted.push({ id: confirmation.confirmationId, text }); }, log, now });
    const saved = await store.load(subject);
    expect(saved).toMatchObject({ requesterId: requester, postedAt: new Date(now).toISOString(), expiresAt: new Date(now + CONFIRMATION_TTL_MS).toISOString() });
    expect(saved!.retiredAt).toBeUndefined();
    expect(saved!.calls.map((call) => call.argumentsHash)).toEqual(["b".repeat(64), "c".repeat(64)]);
    expect(posted).toEqual([{ id: saved!.confirmationId, text: [
      `<@${requester}>, before I go ahead, please confirm:`,
      "• tracker__close_item: id=TRK-1 (destructive)",
      "• tracker__save_item: id=&lt;!here&gt; (I'm not sure you asked for this)",
      "Press Approve, or reply `@AgentX yes`, to run exactly these. Press Cancel, or reply `@AgentX cancel`, to drop them. This expires in 24 hours.",
    ].join("\n") }]);
    expect(log).toHaveBeenCalledWith("gate.confirmation_requested", { eventId: "EvYES0000001", calls: 2, kinds: "destructive,classifier" });
  });

  it("only leaves the tombstone when the turn blocked nothing", async () => {
    const { store, log } = harness();
    await store.save(subject, pending);
    const postConfirmation = vi.fn();
    await settleConfirmations({ check: { run: true, session: createGateSession(requester), claim: { confirmationId: pending.confirmationId } }, message: message("yes"), subject, store, postConfirmation, log, now: postedAt });
    expect(await store.load(subject)).toMatchObject({ confirmationId: pending.confirmationId, usedBy: "EvYES0000001" });
    expect(postConfirmation).not.toHaveBeenCalled();
    expect(confirmationMessage(pending)).toContain("• tracker__close_item: id=TRK-9 (destructive)");
  });

  it("adds the doubt note only when the classifier doubted the call, and never shows a tool name (#215)", () => {
    const calls = [
      { tool: "agentx_submit_task", argumentsHash: "1".repeat(64), summary: 'Start a coding task: "replace ZZZ-NOT-THERE with x in README.md"', kind: "unchecked" as const },
      { tool: "tracker__save_item", argumentsHash: "2".repeat(64), summary: "Use tracker to save item: id TRK-5", kind: "classifier" as const },
    ];
    const text = confirmationMessage({ ...pending, calls });
    expect(text.split("\n").slice(1, 3)).toEqual([
      '• Start a coding task: "replace ZZZ-NOT-THERE with x in README.md"',
      "• Use tracker to save item: id TRK-5 (I'm not sure you asked for this)",
    ]);
    expect(text).not.toMatch(/agentx_|tracker__|\(\d+ characters\)/u);
    expect(PendingConfirmationSchema.parse({ ...pending, calls })).toBeDefined();
  });

  it("shows a stronger note for a deny verdict, the softer one for ask, and none for unchecked (owner decision 2026-10-02)", () => {
    const calls = [
      { tool: "tracker__save_item", argumentsHash: "3".repeat(64), summary: "Use tracker to save item: id TRK-5", kind: "deny" as const },
      { tool: "tracker__save_item", argumentsHash: "4".repeat(64), summary: "Use tracker to save item: id TRK-6", kind: "classifier" as const },
      { tool: "agentx_submit_task", argumentsHash: "5".repeat(64), summary: 'Start a coding task: "list files"', kind: "unchecked" as const },
    ];
    const text = confirmationMessage({ ...pending, calls });
    expect(text.split("\n").slice(1, 4)).toEqual([
      "• Use tracker to save item: id TRK-5 (AgentX thinks you did not ask for this. Check it before approving.)",
      "• Use tracker to save item: id TRK-6 (I'm not sure you asked for this)",
      '• Start a coding task: "list files"',
    ]);
    expect(PendingConfirmationSchema.parse({ ...pending, calls })).toBeDefined();
  });

  it("escapes a stored summary's Slack control characters once, so it cannot mention or link anyone", () => {
    const raw = { ...pending, calls: [{ ...pending.calls[0]!, summary: "tracker__save_item: title=<!channel> & <https://x.example|y>" }] };
    expect(confirmationMessage(raw)).toContain("• tracker__save_item: title=&lt;!channel&gt; &amp; &lt;https://x.example|y&gt; (destructive)");
    const escaped = { ...pending, calls: [{ ...pending.calls[0]!, summary: "tracker__save_item: id=&lt;!here&gt; &amp; more" }] };
    expect(confirmationMessage(escaped)).toContain("• tracker__save_item: id=&lt;!here&gt; &amp; more (destructive)");
  });

  it("splits a long confirmation across sections within Slack's 3,000-character limit", () => {
    const calls = Array.from({ length: 20 }, (_, index) => ({ tool: "tracker__save_item", argumentsHash: index.toString(16).padStart(64, "0"), summary: `tracker__save_item: ${String(index).padStart(2, "0")}${"x".repeat(278)}`, kind: "classifier" as const }));
    const text = confirmationMessage({ ...pending, calls });
    for (const blocks of [confirmationBlocks(text, pending.confirmationId), answeredConfirmationBlocks(text, "Approved by <@U0123456789>")]) {
      const sections = (blocks as Array<{ type: string; text?: { text: string } }>).filter((block) => block.type === "section").map((block) => block.text!.text);
      expect(sections.length).toBeGreaterThan(1);
      for (const section of sections) expect(section.length).toBeLessThanOrEqual(3_000);
      expect(sections.join("\n")).toBe(text);
    }
    const huge = confirmationBlocks("y".repeat(7_000), pending.confirmationId) as Array<{ type: string; text?: { text: string } }>;
    expect(huge.filter((block) => block.type === "section").map((block) => block.text!.text.length)).toEqual([3_000, 3_000, 1_000]);
  });

  it("retires the saved confirmation when posting it fails, so no unseen confirmation stays live", async () => {
    const { store, log } = harness();
    const session = createGateSession(requester);
    session.asks.push({ toolCallId: "1", tool: "tracker__close_item", argumentsHash: "b".repeat(64), summary: "tracker__close_item: id=TRK-1", kind: "destructive" });
    await expect(settleConfirmations({ check: { run: true, session }, message: message("close TRK-1"), subject, store,
      postConfirmation: async () => { throw new Error("msg_too_long"); }, log, now: postedAt })).rejects.toThrow("msg_too_long");
    const saved = await store.load(subject);
    expect(saved?.calls[0]?.argumentsHash).toBe("b".repeat(64));
    expect(saved?.retiredAt).toBeDefined();
    expect(log).toHaveBeenCalledWith("gate.confirmation_post_failed", { eventId: "EvYES0000001" });
    expect(await store.claim(subject, saved!.confirmationId, "EvYES0000002")).toBe(false);
    const posts: string[] = [];
    const answer = await checkConfirmation({ message: message("ok", { eventId: "EvYES0000002", receivedAt: new Date(postedAt + 60_000).toISOString() }), subject, store, post: async (value) => { posts.push(value); }, log, now: postedAt + 60_000 });
    expect(answer).toEqual({ run: true, session: createGateSession(requester) });
    expect(posts).toEqual([]);
  });

  it("saves a confirmation closed and opens it only once it is posted", async () => {
    const session = () => {
      const value = createGateSession(requester);
      value.asks.push({ toolCallId: "1", tool: "tracker__close_item", argumentsHash: "b".repeat(64), summary: "tracker__close_item: id=TRK-1", kind: "destructive" });
      return value;
    };
    // Normal path: closed while posting, answerable after.
    const normal = harness();
    let whilePosting: PendingConfirmation | undefined;
    await settleConfirmations({ check: { run: true, session: session() }, message: message("close TRK-1"), subject, store: normal.store,
      postConfirmation: async () => { whilePosting = await normal.store.load(subject); }, log: normal.log, now: postedAt });
    expect(whilePosting).toMatchObject({ usedBy: "unposted" });
    expect(whilePosting?.retiredAt).toBeDefined();
    const opened = await normal.store.load(subject);
    expect(opened?.retiredAt).toBeUndefined();
    expect(opened?.usedBy).toBeUndefined();
    expect(await normal.store.claim(subject, opened!.confirmationId, "EvYES0000002")).toBe(true);
    // Posted, but opening fails: it stays closed, and the open's error is thrown.
    const failing = harness();
    const store = { ...failing.store, open: async () => { throw new Error("throttled"); } };
    await expect(settleConfirmations({ check: { run: true, session: session() }, message: message("close TRK-1"), subject, store,
      postConfirmation: async () => undefined, log: failing.log, now: postedAt })).rejects.toThrow("throttled");
    expect(await failing.store.load(subject)).toMatchObject({ usedBy: "unposted" });
    expect(failing.log).toHaveBeenCalledWith("gate.confirmation_open_failed", { eventId: "EvYES0000001" });
  });
});
