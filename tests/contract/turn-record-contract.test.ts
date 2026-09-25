import { describe, expect, it } from "vitest";
import { redactSecrets, redactText } from "../../packages/contracts/src/redaction.js";
import {
  EMPTY_TURN_OBSERVATION,
  TURN_TEXT_LIMIT,
  TurnRecordSchema,
  capText,
  turnRecordKeys,
  type TurnRecord,
} from "../../packages/contracts/src/turns.js";

const record: TurnRecord = {
  ...EMPTY_TURN_OBSERVATION,
  eventId: "EvTURN00001",
  subject: "T0123456789/C0123456789/1695500000.000001",
  receivedAt: "2026-09-24T10:00:00.000Z",
  requestedBy: { teamId: "T0123456789", userId: "U0123456789" },
  disposition: "answered",
  startedAt: "2026-09-24T10:00:01.000Z",
  finishedAt: "2026-09-24T10:00:03.500Z",
  durationMs: 2_500,
  requestText: "list open issues",
  responseText: "There are no open issues.",
};

describe("turn record contract", () => {
  it("accepts a minimal record and refuses unknown fields", () => {
    expect(TurnRecordSchema.parse(record)).toEqual(record);
    expect(TurnRecordSchema.safeParse({ ...record, secret: "x" }).success).toBe(false);
  });

  it("refuses text over the limit and more than 50 calls", () => {
    expect(TurnRecordSchema.safeParse({ ...record, requestText: "a".repeat(TURN_TEXT_LIMIT + 1) }).success).toBe(false);
    const call = { name: "agentx_submit_task", arguments: "{}", argumentsFingerprint: "a".repeat(32), validation: "ok", outcome: "SUCCEEDED", durationMs: 1 };
    expect(TurnRecordSchema.safeParse({ ...record, calls: Array.from({ length: 51 }, () => call) }).success).toBe(false);
  });

  it("caps text and says so", () => {
    expect(capText("abc", 2)).toEqual({ text: "ab", truncated: true });
    expect(capText("abc", 3)).toEqual({ text: "abc", truncated: false });
  });

  it("keys a record by thread and Slack receive time, expiring 30 days later", () => {
    expect(turnRecordKeys(record)).toEqual({
      pk: "THREAD#T0123456789/C0123456789/1695500000.000001",
      sk: "TURN#2026-09-24T10:00:00.000Z#EvTURN00001",
      exportPk: "TURNS",
      exportSk: "2026-09-24T10:00:00.000Z#EvTURN00001",
      expiresAt: Date.parse("2026-09-24T10:00:00.000Z") / 1000 + 30 * 86_400,
    });
  });
});

describe("secret redaction", () => {
  it.each([
    ["ghp_0123456789abcdefghijABCDEFGHIJ012345"],
    ["github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz"],
    ["xoxb-1234567890-0987654321-abcdefghijklmnop"],
    ["lin_api_0123456789abcdefghijABCDEFGHIJ"],
    ["ATATT3xFfGF0abcdefghijklmnopqrstuvwxyz0123456789"],
    ["AKIAABCDEFGHIJKLMNOP"],
  ])("removes the token %s from free text", (token) => {
    const redacted = redactText(`please use ${token} for this`);
    expect(redacted).not.toContain(token);
    expect(redacted).toContain("[REDACTED]");
  });

  it("removes bearer headers, URL user-info, token query parameters and private keys", () => {
    const text = [
      "Authorization: Bearer abc.def.ghi-12345",
      "clone https://user:hunter2@github.com/example/demo.git",
      "https://api.example.test/x?access_token=s3cr3t&page=2",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const redacted = redactText(text);
    for (const secret of ["abc.def.ghi-12345", "hunter2", "s3cr3t", "MIIEow"]) expect(redacted).not.toContain(secret);
    expect(redacted).toContain("page=2");
  });

  it("replaces values under credential-named keys at any depth and keeps other values", () => {
    expect(redactSecrets({ title: "Fix login", nested: { apiKey: "k", password: "p" }, list: [{ token: "t" }] }))
      .toEqual({ title: "Fix login", nested: { apiKey: "[REDACTED]", password: "[REDACTED]" }, list: [{ token: "[REDACTED]" }] });
  });

  it("leaves ordinary text alone", () => {
    expect(redactText("close issue 12 in payments-api")).toBe("close issue 12 in payments-api");
    expect(redactText("I have a basic understanding of the bearer bonds module")).toBe("I have a basic understanding of the bearer bonds module");
  });
});
