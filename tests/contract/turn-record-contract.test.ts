import { describe, expect, it } from "vitest";
import { redactSecrets, redactText } from "../../packages/contracts/src/redaction.js";
import {
  EMPTY_TURN_OBSERVATION,
  TURN_TEXT_LIMIT,
  TurnRecordSchema,
  capText,
  redactAndCap,
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

  it("removes a JWT from free text", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dGhpc19pc19hX3NpZ25hdHVyZQ";
    const redacted = redactText(`please use ${jwt} for auth`);
    expect(redacted).not.toContain(jwt);
    expect(redacted).toContain("[REDACTED]");
  });

  it("removes a bearer header made only of letters", () => {
    const text = "Authorization: Bearer abcdefghijklmnopqrstuvwxyzABCDEF";
    const redacted = redactText(text);
    expect(redacted).not.toContain("abcdefghijklmnopqrstuvwxyzABCDEF");
    expect(redacted).toContain("[REDACTED]");
  });

  it("removes key=value and key: value secrets from free text", () => {
    expect(redactText("password=hunter2")).toBe("password=[REDACTED]");
    expect(redactText("api_key: abc123secretvalue")).toBe("api_key: [REDACTED]");
    expect(redactText("aws_secret_access_key = wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY")).toBe(
      "aws_secret_access_key = [REDACTED]",
    );
  });

  it("removes credential values from pasted JSON text", () => {
    const redacted = redactText('{"apiKey":"sk-live-4242424242424242","password":"hunter2"}');
    expect(redacted).not.toContain("sk-live-4242424242424242");
    expect(redacted).not.toContain("hunter2");
    expect(redacted).toContain('"apiKey":"[REDACTED]"');
    expect(redacted).toContain('"password":"[REDACTED]"');
  });

  it("removes a quoted Authorization value nested in pasted JSON", () => {
    const redacted = redactText('{"headers":{"Authorization":"Basic dXNlcjpwYXNz"}}');
    expect(redacted).not.toContain("dXNlcjpwYXNz");
    expect(redacted).toContain('"Authorization":"[REDACTED]"');
  });

  it("removes credentials from non-HTTP connection strings", () => {
    const cases: Array<[string, string]> = [
      ["postgres://admin:S3cret!@db.example.com:5432/app", "S3cret!"],
      ["redis://user:hunter2@cache.example.com:6379", "hunter2"],
      ["amqp://guest:guestpass@mq.example.com:5672/vhost", "guestpass"],
    ];
    for (const [url, secret] of cases) {
      const redacted = redactText(url);
      expect(redacted).not.toContain(secret);
      expect(redacted).toContain("[REDACTED]@");
    }
  });

  it("redacts any query parameter whose name contains a credential term", () => {
    const text = "https://api.example.test/oauth?client_secret=abcdef123&refresh_token=ghijkl456&ok=1";
    const redacted = redactText(text);
    expect(redacted).not.toContain("abcdef123");
    expect(redacted).not.toContain("ghijkl456");
    expect(redacted).toContain("ok=1");
  });

  it("redacts an AWS-style signed-URL signature parameter", () => {
    const text = "https://bucket.s3.amazonaws.com/key?X-Amz-Signature=deadbeefcafef00d&X-Amz-Expires=900";
    const redacted = redactText(text);
    expect(redacted).not.toContain("deadbeefcafef00d");
    expect(redacted).toContain("X-Amz-Expires=900");
  });

  it("redacts passphrase, pwd, cookie and auth object keys", () => {
    expect(redactSecrets({ passphrase: "a", pwd: "b", cookie: "c", auth: "d", note: "keep" })).toEqual({
      passphrase: "[REDACTED]",
      pwd: "[REDACTED]",
      cookie: "[REDACTED]",
      auth: "[REDACTED]",
      note: "keep",
    });
  });

  it("does not redact token-count fields, only real credentials (over-redaction)", () => {
    expect(redactSecrets({ tokenCount: 5, max_tokens: 100, input_tokens: 50, apiKey: "k" })).toEqual({
      tokenCount: 5,
      max_tokens: 100,
      input_tokens: 50,
      apiKey: "[REDACTED]",
    });
  });

  it("redacts a truncated private key with no END line to the end of the text", () => {
    const secret = "MIIEowIBAAKCAQEAsomeverylongbase64";
    const redacted = redactText(`-----BEGIN RSA PRIVATE KEY-----\n${secret}`);
    expect(redacted).not.toContain(secret);
    expect(redacted).toContain("[REDACTED]");
  });

  it("stops a truncated private key redaction at a blank line", () => {
    const redacted = redactText("-----BEGIN RSA PRIVATE KEY-----\nMIIEowmore\n\nplease also see the report");
    expect(redacted).not.toContain("MIIEowmore");
    expect(redacted).toContain("please also see the report");
  });

  it.each([
    ["sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN"],
    ["sk-live-4242424242424242424242424242"],
  ])("removes the API key %s from free text", (token) => {
    const redacted = redactText(`use ${token} please`);
    expect(redacted).not.toContain(token);
    expect(redacted).toContain("[REDACTED]");
  });

  it("removes a Slack webhook URL", () => {
    const url = "https://hooks.slack.com/services/T0123456789/B0123456789/abcdefghijklmnopqrstuvwx";
    const redacted = redactText(`post to ${url} now`);
    expect(redacted).not.toContain(url);
    expect(redacted).toContain("[REDACTED]");
  });

  it("catches vendor tokens glued to an underscore or another word", () => {
    const token = "ghp_0123456789abcdefghijABCDEFGHIJ012345";
    expect(redactText(`x_${token}`)).not.toContain(token);
    expect(redactText(`token${token}`)).not.toContain(token);
  });

  it("does not flag ordinary prose that merely contains the words bearer or basic", () => {
    expect(redactText("Basic auth-examples of the flow")).toBe("Basic auth-examples of the flow");
  });
});

describe("capText and redactAndCap", () => {
  it("does not split a surrogate pair when capping", () => {
    const text = "hi\u{1F600}!";
    expect(capText(text, 3)).toEqual({ text: "hi", truncated: true });
  });

  it("redacts before capping so a truncated secret cannot leak", () => {
    const secret = `ghp_${"a".repeat(40)}`;
    const text = `please use ${secret} now`;
    const limit = 20;

    const capThenRedact = redactText(capText(text, limit).text);
    expect(capThenRedact).toBe("please use ghp_aaaaa");

    const result = redactAndCap(text, limit);
    expect(result.text).not.toContain("aaaaa");
  });
});
