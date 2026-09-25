import { describe, expect, it, vi } from "vitest";
import { CONFIRMATION_TTL_MS, confirmationClickEventId, parseConfirmationClickEventId, type PendingConfirmation, type SlackRequestMessage } from "../../packages/contracts/src/index.js";
import { createGateSession } from "../../packages/orchestrator/src/action-gate.js";
import { createDynamoConfirmationStore } from "../../packages/slack-service/src/confirmation-store.js";
import {
  CANCELLED_TEXT,
  NO_LONGER_PENDING_TEXT,
  YES_TO_ALL_TEXT,
  checkConfirmation,
  confirmationMessage,
  parseConfirmationReply,
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

  it("derives a click's event ID from the confirmation, and reads it back", () => {
    const eventId = confirmationClickEventId(pending.confirmationId, "approve");
    expect(eventId).toBe("EvAgxApprove44444444444454448444444444444444");
    expect(parseConfirmationClickEventId(eventId)).toEqual({ click: "approve", confirmationId: pending.confirmationId });
    expect(parseConfirmationClickEventId(confirmationClickEventId(pending.confirmationId, "cancel"))).toEqual({ click: "cancel", confirmationId: pending.confirmationId });
    expect(parseConfirmationClickEventId("Ev0000000001")).toBeUndefined();
  });
});

describe("the confirmation store", () => {
  it("lets one Slack event claim a live confirmation, and leaves a tombstone only on the confirmation it names", async () => {
    const { db, store } = harness();
    await store.save(subject, pending);
    expect(await store.load(subject)).toEqual(pending);
    expect(db.get(`THREAD#${subject}`, "CONFIRMATION")?.expiresAt).toBe(Math.floor(Date.parse(pending.expiresAt) / 1_000) + 7 * 24 * 60 * 60);
    expect(await store.claim(subject, pending.confirmationId, "EvYES0000001")).toBe(true);
    expect(await store.claim(subject, pending.confirmationId, "EvYES0000001")).toBe(true);
    expect(await store.claim(subject, pending.confirmationId, "EvYES0000002")).toBe(false);
    await store.retire(subject, "55555555-5555-5555-8555-555555555555", "EvYES0000003");
    expect((await store.load(subject))?.retiredAt).toBeUndefined();
    await store.retire(subject, pending.confirmationId, "EvYES0000001");
    expect(await store.load(subject)).toEqual({ ...pending, retiredAt: new Date(postedAt + 120_000).toISOString(), usedBy: "EvYES0000001" });
    expect(await store.claim(subject, pending.confirmationId, "EvYES0000001")).toBe(false);
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
    expect(await check("yes", { eventId: confirmationClickEventId("66666666-6666-5666-8666-666666666666", "approve") })).toEqual({ run: false });
    expect(await check("cancel", { eventId: confirmationClickEventId(pending.confirmationId, "cancel") })).toEqual({ run: false });
    expect(posts).toEqual([NO_LONGER_PENDING_TEXT, CANCELLED_TEXT]);
    expect((await store.load(subject))?.usedBy).toBe(confirmationClickEventId(pending.confirmationId, "cancel"));
  });

  it("runs nothing for a yes from a different member, and says who can confirm", async () => {
    const { store, check, posts, log } = harness();
    await store.save(subject, pending);
    expect(await check("yes", { userId: other })).toEqual({ run: false });
    expect(posts).toEqual([`Only <@${requester}> can confirm what they asked for. Nothing was run.`]);
    expect(log).toHaveBeenCalledWith("gate.confirmation_refused", { eventId: "EvYES0000001", reason: "other_member" });
    expect(await store.load(subject)).toEqual(pending);
  });

  it("answers any yes for a used, cancelled or superseded confirmation with no longer pending, for the rest of its 24 hours", async () => {
    const { store, check, posts } = harness();
    await store.save(subject, pending);
    await store.retire(subject, pending.confirmationId, "EvYES0000001");
    expect(await check("yes", { eventId: "EvYES0000002" })).toEqual({ run: false });
    expect(await check("yes", { eventId: "EvYES0000001" })).toEqual({ run: false });
    expect(posts).toEqual([NO_LONGER_PENDING_TEXT, NO_LONGER_PENDING_TEXT]);
  });

  it("does not count a yes sent before the question was posted, and retires one after it expired", async () => {
    const early = harness();
    await early.store.save(subject, pending);
    expect(await early.check("yes", { receivedAt: new Date(postedAt - 1_000).toISOString() })).toEqual({ run: false });
    expect(early.posts[0]).toContain("arrived before I asked for confirmation");
    const late = harness(postedAt + CONFIRMATION_TTL_MS);
    await late.store.save(subject, pending);
    expect(await late.check("yes", { receivedAt: new Date(postedAt + CONFIRMATION_TTL_MS).toISOString() })).toEqual({ run: false });
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
    expect(await check("yes to all in this thread")).toEqual({ run: false });
    expect(posts).toEqual([YES_TO_ALL_TEXT]);
    expect(await check("create an item")).toEqual({ run: true, session: createGateSession(requester, { yesToAll: true }) });
    await store.save(subject, pending);
    expect(await check("yes to all", { eventId: "EvYES0000009" })).toMatchObject({ run: true, claim: { confirmationId: pending.confirmationId }, session: { yesToAll: true, approvals: [{ tool: "tracker__close_item" }] } });
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

  it("escapes a stored summary's Slack control characters once, so it cannot mention or link anyone", () => {
    const raw = { ...pending, calls: [{ ...pending.calls[0]!, summary: "tracker__save_item: title=<!channel> & <https://x.example|y>" }] };
    expect(confirmationMessage(raw)).toContain("• tracker__save_item: title=&lt;!channel&gt; &amp; &lt;https://x.example|y&gt; (destructive)");
    const escaped = { ...pending, calls: [{ ...pending.calls[0]!, summary: "tracker__save_item: id=&lt;!here&gt; &amp; more" }] };
    expect(confirmationMessage(escaped)).toContain("• tracker__save_item: id=&lt;!here&gt; &amp; more (destructive)");
  });
});
