import { describe, expect, it } from "vitest";
import {
  DETAILS_ACTION,
  SLACK_SECTION_TEXT_LIMIT,
  TURN_DETAILS_ATTRIBUTES,
  TurnDetailsSchema,
  TurnRecordSchema,
  detailsButtonValue,
  detailsExpireAt,
  detailsReplyBlocks,
  parseDetailsButtonValue,
  splitSectionText,
  turnDetailsFromItem,
  turnDetailsKey,
  turnRecordKeys,
} from "../../packages/contracts/src/index.js";

const subject = "T0BSHLLUGBD/C0123456789/1695500000.000001";
const reference = { receivedAt: "2026-09-24T10:00:00.000Z", eventId: "EvTURN00001" };
const record = TurnRecordSchema.parse({
  ...reference, subject, requestedBy: { teamId: "T0BSHLLUGBD", userId: "U0123456789" },
  disposition: "answered", startedAt: reference.receivedAt, finishedAt: "2026-09-24T10:00:12.300Z", durationMs: 12_300,
  requestText: "close TRK-9", responseText: "Closed TRK-9.", offeredTools: [],
  calls: [{ name: "tracker__close_item", arguments: "{\"id\":\"TRK-9\"}", argumentsFingerprint: "b".repeat(32), validation: "ok", outcome: "SUCCEEDED", durationMs: 800 }],
  emptyResponse: false, workerOperations: [],
});

describe("the Details contract (spec 014 FR-024)", () => {
  it("names a turn by its receive time and event ID, which is the record's key without the thread", () => {
    const value = detailsButtonValue(reference);
    expect(value).toBe("2026-09-24T10:00:00.000Z#EvTURN00001");
    expect(value).toBe(turnRecordKeys(record).exportSk);
    expect(parseDetailsButtonValue(value!)).toEqual(reference);
  });

  it("refuses a value that is not exactly one turn reference", () => {
    for (const value of [
      "", "EvTURN00001", "2026-09-24T10:00:00.000Z", "2026-09-24T10:00:00Z#EvTURN00001",
      "2026-09-24T10:00:00.000+01:00#EvTURN00001", "2026-02-31T10:00:00.000Z#EvTURN00001",
      "2026-09-24T10:00:00.000Z#EvTURN00001#TURN#x", "2026-09-24T10:00:00.000Z#Ev!!", `2026-09-24T10:00:00.000Z#Ev${"a".repeat(65)}`,
      "THREAD#T0BSHLLUGBD/C0999999999/1695500000.000009", "x".repeat(2_000),
    ]) expect(parseDetailsButtonValue(value), value).toBeUndefined();
    expect(detailsButtonValue({ receivedAt: "yesterday", eventId: "EvTURN00001" })).toBeUndefined();
  });

  it("builds the record key from the clicked thread and the value, the key the Slack service writes", () => {
    const keys = turnRecordKeys(record);
    expect(turnDetailsKey(subject, reference)).toEqual({ pk: keys.pk, sk: keys.sk });
    expect(detailsExpireAt(reference)).toBe(keys.expiresAt * 1_000);
  });

  it("carries a reply in sections of at most 3,000 characters with one Details button after them", () => {
    expect(detailsReplyBlocks("Closed TRK-9.", "2026-09-24T10:00:00.000Z#EvTURN00001")).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "Closed TRK-9." } },
      { type: "actions", block_id: "agentx_details", elements: [
        { type: "button", action_id: DETAILS_ACTION, text: { type: "plain_text", text: "Details" }, value: "2026-09-24T10:00:00.000Z#EvTURN00001" },
      ] },
    ]);
    const long = `${"a".repeat(2_000)}\n${"b".repeat(1_400)}`;
    expect(splitSectionText(long)).toEqual(["a".repeat(2_000), "b".repeat(1_400)]);
    const solid = "😀".repeat(1_750);
    const parts = splitSectionText(solid);
    expect(parts.join("")).toBe(solid);
    expect(parts.every((part) => part.length <= SLACK_SECTION_TEXT_LIMIT && !/[\ud800-\udbff]$/.test(part))).toBe(true);
    expect(splitSectionText("")).toEqual([" "]);
  });

  it("lets the view read only what it shows: never request or response text, the workspace or worker operations", () => {
    expect([...TURN_DETAILS_ATTRIBUTES].sort()).toEqual([...Object.keys(TurnDetailsSchema.shape), "expiresAt"].sort());
    for (const name of TURN_DETAILS_ATTRIBUTES) {
      if (name !== "expiresAt") expect(Object.keys(TurnRecordSchema.shape), name).toContain(name);
    }
    for (const name of ["requestText", "responseText", "textTruncated", "workspaceId", "conversationId", "settingsRevision", "manifestHash", "workerOperations", "project"]) {
      expect(TURN_DETAILS_ATTRIBUTES).not.toContain(name);
    }
  });

  it("parses a stored record without its storage keys, keeps a gate decision as data, and names only top-level fields when it cannot", () => {
    const item = { ...turnRecordKeys(record), ...record, calls: [{ ...record.calls[0], gate: { outcome: "ask", source: "rule", reason: "closing always asks" } }] };
    const parsed = turnDetailsFromItem(item);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.details.calls[0]?.gate).toEqual({ outcome: "ask", source: "rule", reason: "closing always asks" });
    expect(parsed.details).not.toHaveProperty("requestText");
    expect(parsed.details).not.toHaveProperty("expiresAt");
    expect(turnDetailsFromItem({ ...item, calls: "not a list", eventId: "the secret plan" })).toEqual({ ok: false, fields: ["eventId", "calls"] });
  });
});
