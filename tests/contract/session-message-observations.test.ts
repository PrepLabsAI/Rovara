import { describe, expect, it } from "vitest";
import { legacyMessageSchema } from "../support/session-message-legacy.js";
import { SessionMessageSchema } from "../../packages/contracts/src/agent-sessions.js";
import { SessionMessagePageReaderSchema, SessionMessageReaderSchema } from "../../packages/contracts/src/session-views.js";

const at = "2026-11-21T12:00:00.000Z";
const message = { messageId: "msg_aaaaaaaaaaaaaaaaaaaa", sessionId: "ses_aaaaaaaaaaaaaaaaaaaa", kind: "steer", source: "app", author: { developerId: "a".repeat(64), name: "Owner" }, text: "Use the existing table", createdAt: at, rev: 1 };

describe("message delivery observation readers", () => {
  it("accepts the two observations alongside each unchanged receipt, including legacy absence", () => {
    for (const state of ["queued", "delivered", "not_delivered"] as const) {
      const old = { ...message, delivery: { state, at, reason: "unchanged reason" } };
      expect(SessionMessageSchema.parse(old)).toEqual(old);
      expect(legacyMessageSchema.parse(old)).toEqual(old);
      for (const observation of ["checking", "outside_plan"] as const) {
        const next = { ...old, deliveryObservation: { state: observation } };
        expect(SessionMessageSchema.parse(next)).toEqual(next);
        expect(SessionMessageReaderSchema.parse(next).deliveryObservation).toEqual({ state: observation });
        expect(SessionMessagePageReaderSchema.parse({ messages: [next] }).messages[0]?.deliveryObservation).toEqual({ state: observation });
        expect(legacyMessageSchema.safeParse(next).success).toBe(false);
      }
    }
  });

  it("reads unknown or malformed observations as absent, never Applied", () => {
    for (const observation of [{ state: "applied" }, { state: "future" }, {}, null, { state: 1 }, { state: "checking", changedWork: "unproven" }]) {
      const next = { ...message, delivery: { state: "delivered", at }, deliveryObservation: observation };
      expect(SessionMessageSchema.parse(next).deliveryObservation).toBeUndefined();
      expect(SessionMessageReaderSchema.parse(next).deliveryObservation).toBeUndefined();
      expect(SessionMessagePageReaderSchema.parse({ messages: [next] }).messages[0]?.deliveryObservation).toBeUndefined();
    }
    expect(SessionMessageSchema.parse({ ...message, delivery: { state: "delivered", at } }).deliveryObservation).toBeUndefined();
  });

  it("keeps the receipt strict and never allows observations to make a comment an instruction", () => {
    for (const delivery of [{ state: "applied", at }, { state: "checking", at }, { state: "delivered", at, changedWork: "unproven" }]) {
      expect(SessionMessageSchema.safeParse({ ...message, delivery }).success).toBe(false);
    }
    expect(SessionMessageSchema.safeParse({ ...message, kind: "comment", deliveryObservation: { state: "outside_plan" } }).success).toBe(false);
  });
});
