// Review test (lead 4 Opus, PEOPLE-IDENTITY-RECORD-FIX): an adapter conversation's linked developer is read from the sign-in row
// `DEVELOPER#<id>` / `META`, which keeps the id only in its key on real rows. A key-only row must work; a row that names someone else
// (its `pk`, or a disagreeing `developerId` attribute) must be refused.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { channelLinkKey, conversationSubject } from "@agentx/contracts";
import { SLACK_TEAM, call, createBroker, loadSlackBroker, orchestratorPrincipal, registerSlackProject, type Handler } from "../support/slack-broker.js";

const admin = { subject: "admin-subject", admin: true };
const developerId = "d".repeat(64);
const otherId = "e".repeat(64);
const conversation = { channel: "whatsapp", tenant: "+14155550100", space: "group=AbC-12_x", thread: "main" };
const actor = { channel: "whatsapp", tenant: "+14155550100", userId: "+919876544821" };
const subject = conversationSubject(conversation);

beforeAll(async () => { await loadSlackBroker(); });

type Shape = "key" | "attribute" | "mismatch" | "foreign-pk";

async function setup(shape: Shape) {
  const harness = createBroker({
    extra: {
      channelAdapters: { secretPrefix: "agentx/test/", secrets: { put: async () => undefined } },
      developer: {
        issuer: "https://rovara.example.com", env: "test", methods: { slack: true, oidc: true }, slackTeamId: SLACK_TEAM, signInTableName: "signin",
        channelMembers: async () => ({ ok: true as const, memberOf: [] }),
      },
    },
  });
  await registerSlackProject(harness.handler);
  const as = (method: string, path: string, body?: unknown) => call(harness.handler, { method, path, user: admin, ...(body === undefined ? {} : { body }) });
  expect((await as("PUT", "/v1/admin/channels/whatsapp", {
    callbackUrl: "https://adapter.example.com/rovara",
    capabilities: { threads: false, buttons: 3, edits: false, maxTextLength: 4096, proactive: false },
    projects: ["payments"],
  })).status).toBe(200);
  expect((await as("PUT", `/v1/admin/channels/whatsapp/bindings/${encodeURIComponent(conversation.tenant)}/${encodeURIComponent(conversation.space)}`, { projectName: "payments" })).status).toBe(200);
  harness.db.set({ ...channelLinkKey(actor), entityType: "CHANNEL_LINK", actor, developerId, linkedAt: "2026-11-08T10:00:00.000Z" });
  const attribute = shape === "attribute" ? { developerId } : shape === "mismatch" ? { developerId: otherId } : {};
  harness.db.set({
    pk: `DEVELOPER#${developerId}`, sk: "META", entityType: "DEVELOPER", ...attribute, provider: "oidc", issuer: "https://login.example.com", subject: "ada", displayName: "Ada Lovelace",
    firstSignInAt: "2026-11-01T00:00:00.000Z", lastSignInAt: "2026-11-01T00:00:00.000Z", revoked: false,
  });
  if (shape === "foreign-pk") {
    // A store that answers a row for the asked key whose own `pk` names someone else (never a real DynamoDB answer): must refuse.
    const db = harness.db as unknown as { send: (command: unknown) => Promise<unknown> };
    const original = db.send.bind(db);
    db.send = async (command: unknown) => {
      const answer = await original(command) as { Item?: Record<string, unknown> };
      const input = (command as { input?: { TableName?: string; Key?: { pk?: string } } }).input;
      if (input?.TableName === "signin" && input.Key?.pk === `DEVELOPER#${developerId}` && answer?.Item !== undefined) return { ...answer, Item: { ...answer.Item, pk: `DEVELOPER#${otherId}` } };
      return answer;
    };
  }
  return harness;
}

const ensure = (handler: Handler) => call(handler, {
  method: "POST", path: "/v1/service/threads/workspace", service: { principal: orchestratorPrincipal },
  headers: { "x-agentx-conversation": subject, "x-agentx-actor": actor.userId },
  body: { requestId: randomUUID(), lazyPreparation: true, includeSettingsRevision: true },
});

describe("an adapter conversation's linked developer, on the stored sign-in row shape", () => {
  it.each(["key", "attribute"] as const)("is accepted with record shape=%s (the id from the key)", async shape => {
    const { handler, db } = await setup(shape);
    if (shape === "key") expect(db.get(`DEVELOPER#${developerId}`, "META")).not.toHaveProperty("developerId");
    const answer = await ensure(handler);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ outcome: "WORKSPACE", created: true });
  });

  it.each(["mismatch", "foreign-pk"] as const)("is refused when the row names another person (%s)", async shape => {
    const { handler } = await setup(shape);
    const answer = await ensure(handler);
    expect(answer.status).toBe(403);
  });
});
