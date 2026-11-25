// Opus security review of DEC 254zzz488 (the Linear app webhook route on the legacy layout too): what an unauthenticated caller can make the broker do before the signature holds.
//  - an unsigned, forged, stale, future, oversize or non-JSON request makes NO State table call at all (no replay record, no binding read, no connection read): the only cost is the
//    invocation and one fixed log line;
//  - a correctly signed body over 1 MB is refused before it is parsed or stored;
//  - a correctly signed but stale body is refused before the replay record is written (so an old captured delivery cannot even grow the table);
//  - every refusal is byte-for-byte the same answer (no oracle between "bad signature", "stale", "oversize" and "not JSON").
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { handleLinearAppWebhook, LINEAR_WEBHOOK_WINDOW_MS, type LinearWebhookWiring } from "../../packages/broker/src/aws/linear-app-webhook.js";

const SECRET = "whsec_review_only_0123456789";
const NOW = 1_800_000_000_000;
const sign = (raw: string, secret = SECRET) => createHmac("sha256", secret).update(Buffer.from(raw, "utf8")).digest("hex");

function wiring() {
  const calls: string[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const record = (name: string) => async () => { calls.push(name); return undefined as never; };
  const w: LinearWebhookWiring = {
    connections: {
      takeDelivery: async () => { calls.push("takeDelivery"); return true; },
      releaseDelivery: record("releaseDelivery"), companyOfWorkspace: record("companyOfWorkspace"), connection: record("connection"),
      teamPicks: async () => { calls.push("teamPicks"); return []; }, markRevoked: record("markRevoked"),
    },
    app: async () => ({ clientId: "client_review_1", clientSecret: "cs_review", webhookSecret: SECRET, redirectUri: "https://example.invalid/api/connect/linear/callback" }),
    now: () => NOW,
    deliver: async () => { calls.push("deliver"); },
    log: (entry) => { logs.push(entry); },
  };
  return { w, calls, logs };
}

const body = (extra: Record<string, unknown> = {}) => JSON.stringify({ type: "Issue", action: "create", organizationId: "org-1", webhookTimestamp: NOW, data: { id: "i1", teamId: "team-1" }, ...extra });

describe("Linear app webhook: nothing is stored or read before the signature and the window hold", () => {
  const cases: Array<[string, string, Record<string, string>]> = [
    ["no signature", body(), {}],
    ["a forged signature", body(), { "linear-signature": "a".repeat(64) }],
    ["another secret's signature", body(), { "linear-signature": sign(body(), "other-secret") }],
    ["a signature over another body", body({ action: "update" }), { "linear-signature": sign(body()) }],
    ["a signed body that is too old", body({ webhookTimestamp: NOW - LINEAR_WEBHOOK_WINDOW_MS - 1 }), { "linear-signature": sign(body({ webhookTimestamp: NOW - LINEAR_WEBHOOK_WINDOW_MS - 1 })) }],
    ["a signed body from the future", body({ webhookTimestamp: NOW + LINEAR_WEBHOOK_WINDOW_MS + 1 }), { "linear-signature": sign(body({ webhookTimestamp: NOW + LINEAR_WEBHOOK_WINDOW_MS + 1 })) }],
    ["a signed body over 1 MB", body({ pad: "x".repeat(1_048_576) }), { "linear-signature": sign(body({ pad: "x".repeat(1_048_576) })) }],
    ["a signed body that is not JSON", "not json", { "linear-signature": sign("not json") }],
    ["a signed body with no timestamp", JSON.stringify({ type: "Issue", action: "create", organizationId: "org-1" }), { "linear-signature": sign(JSON.stringify({ type: "Issue", action: "create", organizationId: "org-1" })) }],
    ["a signed body with a hostile workspace id", body({ organizationId: "../../COMPANY#x" }), { "linear-signature": sign(body({ organizationId: "../../COMPANY#x" })) }],
  ];
  const answers: unknown[] = [];
  for (const [label, raw, headers] of cases) {
    it(`${label}: 401, no State call, no delivery, nothing of the body or secret logged`, async () => {
      const { w, calls, logs } = wiring();
      const answer = await handleLinearAppWebhook(w, { rawBody: raw, headers });
      expect(answer).toEqual({ status: 401, body: { error: { code: "CALLBACK_FORBIDDEN", message: "the delivery is not a valid Linear app delivery" } } });
      answers.push(answer);
      expect(calls).toEqual([]);
      const logged = JSON.stringify(logs);
      expect(logged).not.toContain(SECRET);
      expect(logged).not.toContain("xxxxxxxx");
      for (const value of Object.values(headers)) expect(logged).not.toContain(value);
      expect(logs.every((entry) => entry.event === "linear.webhook_signature_failed")).toBe(true);
      expect(logs.length).toBeLessThanOrEqual(1);
    });
  }
  it("every refusal is the same answer", () => {
    expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1);
  });
  it("a missing body is refused with no State call", async () => {
    const { w, calls } = wiring();
    expect((await handleLinearAppWebhook(w, { rawBody: undefined, headers: { "linear-signature": sign("") } })).status).toBe(401);
    expect(calls).toEqual([]);
  });
  it("only a signed, fresh body reaches the replay record, and the replay record comes before the binding read", async () => {
    const { w, calls } = wiring();
    expect((await handleLinearAppWebhook(w, { rawBody: body(), headers: { "Linear-Signature": sign(body()).toUpperCase() } })).status).toBe(200);
    expect(calls.slice(0, 2)).toEqual(["takeDelivery", "companyOfWorkspace"]);
  });
});
