// Spec 062 FR-020, FR-024: registering channel adapters and binding their spaces, administrators only.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { verifyWebhook, webhookHeaders } from "@rovara-code/contracts";
import { registerChannelAdapter } from "../../packages/core/src/aws/channel-adapters.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { SLACK_CHANNEL, SLACK_TEAM, call, createBroker, loadSlackBroker, registerSlackProject } from "../support/slack-broker.js";

const admin = { subject: "admin-subject", admin: true };
const outsider = { subject: "other-admin", admin: true };
const developer = { subject: "admin-subject", admin: false };
const registration = {
  callbackUrl: "https://adapter.example.com/rovara",
  capabilities: { threads: false, buttons: 3, edits: false, maxTextLength: 4096, proactive: false },
  projects: ["payments"],
};

beforeAll(async () => { await loadSlackBroker(); });

async function setup(options: { channelAdapters?: boolean } = {}) {
  const secrets = new Map<string, string>();
  const put = vi.fn(async (name: string, value: string) => { secrets.set(name, value); });
  const harness = createBroker(options.channelAdapters === false ? {} : { extra: { channelAdapters: { secretPrefix: "agentx/test/", secrets: { put } } } });
  await registerSlackProject(harness.handler);
  const as = (user: typeof admin, method: string, path: string, body?: unknown) => call(harness.handler, { method, path, user, ...(body === undefined ? {} : { body }) });
  return { ...harness, secrets, put, as };
}

describe("registering an adapter (FR-020)", () => {
  it("is not found in a deployment without channel adapters", async () => {
    const { as } = await setup({ channelAdapters: false });
    expect((await as(admin, "PUT", "/v1/admin/channels/whatsapp", registration)).status).toBe(404);
  });

  it("stores the adapter, keeps its secret in Secrets Manager and returns the secret once", async () => {
    const { as, db, secrets } = await setup();
    const answer = await as(admin, "PUT", "/v1/admin/channels/whatsapp", registration);
    expect(answer.status).toBe(200);
    const signingSecret = answer.body.signingSecret as string;
    expect(signingSecret).toMatch(/^whsec_/);
    expect(secrets.get("agentx/test/channel-adapter/whatsapp")).toBe(signingSecret);
    expect(answer.body.adapter).toMatchObject({ channel: "whatsapp", projects: ["payments"], stepUp: ["plan_approval", "admin"], secretName: "agentx/test/channel-adapter/whatsapp" });
    expect(JSON.stringify(db.get("CHANNEL_ADAPTERS", "CHANNEL#whatsapp"))).not.toContain(signingSecret);

    // The secret signs and verifies as the adapter would use it.
    const message = { secret: signingSecret, id: "msg_1", timestamp: 1_700_000_000, body: "{}" };
    expect(verifyWebhook({ secret: signingSecret, headers: webhookHeaders(message), body: "{}", nowSeconds: 1_700_000_000 }).ok).toBe(true);

    const listed = await as(admin, "GET", "/v1/admin/channels");
    expect(listed.body.adapters).toEqual([answer.body.adapter]);
    expect(JSON.stringify(listed.body)).not.toContain(signingSecret);
  });

  it("keeps the secret when settings change, and replaces it only on rotate", async () => {
    const { as, put, secrets } = await setup();
    const first = (await as(admin, "PUT", "/v1/admin/channels/whatsapp", registration)).body.signingSecret;
    const changed = await as(admin, "PUT", "/v1/admin/channels/whatsapp", { ...registration, stepUp: ["admin"] });
    expect(changed.body.signingSecret).toBeUndefined();
    expect(changed.body.adapter).toMatchObject({ stepUp: ["admin"] });
    expect(put).toHaveBeenCalledTimes(1);
    const rotated = await as(admin, "PUT", "/v1/admin/channels/whatsapp?rotate=true", registration);
    expect(rotated.body.signingSecret).toMatch(/^whsec_/);
    expect(rotated.body.signingSecret).not.toBe(first);
    expect(secrets.get("agentx/test/channel-adapter/whatsapp")).toBe(rotated.body.signingSecret);
  });

  it.each([
    ["a person without the administrator claim", developer, registration, 403],
    // Not a member of the project: NOT_FOUND, as for Slack bindings, so the project is not revealed.
    ["an administrator who does not administer the project", outsider, registration, 404],
    ["a project that is not registered", admin, { ...registration, projects: ["missing"] }, 404],
    ["an http callback", admin, { ...registration, callbackUrl: "http://adapter.example.com/rovara" }, 400],
    ["a callback on an IP address", admin, { ...registration, callbackUrl: "https://203.0.113.9/rovara" }, 400],
  ])("refuses %s", async (_name, user, body, status) => {
    const { as, put } = await setup();
    expect((await as(user, "PUT", "/v1/admin/channels/whatsapp", body)).status).toBe(status);
    expect(put).not.toHaveBeenCalled();
  });

  it("refuses to register slack, which is built in", async () => {
    const { as } = await setup();
    expect((await as(admin, "PUT", "/v1/admin/channels/slack", registration)).status).toBe(400);
  });

  it("revokes the secret and removes the adapter on delete", async () => {
    const { as, secrets, db } = await setup();
    const signingSecret = (await as(admin, "PUT", "/v1/admin/channels/whatsapp", registration)).body.signingSecret;
    expect((await as(outsider, "DELETE", "/v1/admin/channels/whatsapp")).status).toBe(404);
    expect((await as(admin, "DELETE", "/v1/admin/channels/whatsapp")).body).toMatchObject({ deleted: true, channel: "whatsapp" });
    expect(secrets.get("agentx/test/channel-adapter/whatsapp")).not.toBe(signingSecret);
    expect(secrets.get("agentx/test/channel-adapter/whatsapp")).toMatch(/^revoked_/);
    expect(db.get("CHANNEL_ADAPTERS", "CHANNEL#whatsapp")).toBeUndefined();
    expect((await as(admin, "DELETE", "/v1/admin/channels/whatsapp")).status).toBe(404);
  });
});

describe("binding an adapter's space (FR-024)", () => {
  const path = "/v1/admin/channels/whatsapp/bindings/%2B14155550100/group%3DAbC-12_x";

  it("binds a space to a project the adapter is registered for, beside the Slack binding", async () => {
    const { as, db } = await setup();
    await as(admin, "PUT", "/v1/admin/channels/whatsapp", registration);
    const bound = await as(admin, "PUT", path, { projectName: "payments" });
    expect(bound.status).toBe(200);
    expect(bound.body.binding).toMatchObject({ channel: "whatsapp", tenant: "+14155550100", space: "group=AbC-12_x", projectName: "payments" });
    expect(db.get("BINDING#whatsapp/+14155550100", "SPACE#group=AbC-12_x")).toMatchObject({ entityType: "CHANNEL_BINDING", channel: "whatsapp", projectName: "payments" });
    // The Slack binding registerSlackProject made is untouched.
    expect(db.get(`SLACK_BINDING#${SLACK_TEAM}`, `CHANNEL#${SLACK_CHANNEL}`)).toMatchObject({ entityType: "SLACK_BINDING", projectName: "payments" });

    expect((await as(admin, "DELETE", path)).body).toMatchObject({ deleted: true });
    expect(db.get("BINDING#whatsapp/+14155550100", "SPACE#group=AbC-12_x")).toBeUndefined();
  });

  it("refuses a space of an unregistered adapter, a project the adapter is not registered for, and a non-administrator", async () => {
    const { as } = await setup();
    expect((await as(admin, "PUT", path, { projectName: "payments" })).status).toBe(404);
    await as(admin, "PUT", "/v1/admin/channels/whatsapp", registration);
    expect((await as(admin, "PUT", path, { projectName: "other" })).status).toBe(403);
    expect((await as(outsider, "PUT", path, { projectName: "payments" })).status).toBe(404);
  });

  it("refuses a tenant or space with a slash", async () => {
    const { as } = await setup();
    await as(admin, "PUT", "/v1/admin/channels/whatsapp", registration);
    expect((await as(admin, "PUT", "/v1/admin/channels/whatsapp/bindings/a%2Fb/space", { projectName: "payments" })).status).toBe(400);
  });
});

describe("registering concurrently and failing part-way", () => {
  it("never overwrites the secret another administrator was just given", async () => {
    const db = new FakeDynamoDb();
    const put = vi.fn(async () => undefined);
    // The racing registration read no adapter, and the winner's record landed before its write.
    const stale = { send: async (command: { constructor: { name: string }; input: { Key?: { pk?: string } } }) =>
      (command.constructor.name === "GetCommand" && command.input.Key?.pk === "CHANNEL_ADAPTERS" ? {} : db.send(command)) };
    db.set({ pk: "CHANNEL_ADAPTERS", sk: "CHANNEL#whatsapp", entityType: "CHANNEL_ADAPTER", channel: "whatsapp", winner: true });
    const deps = {
      documentClient: stale as never, tableName: "state", channelAdapters: { secretPrefix: "agentx/test/", secrets: { put } },
      requireAdministrator: async () => undefined, requireProject: async () => undefined,
    };
    await expect(registerChannelAdapter(deps, { isAdministrator: true, ownerKey: "admin" } as never, "whatsapp", registration)).rejects.toMatchObject({ code: "CHANGE_STALE" });
    expect(put).not.toHaveBeenCalled();
    expect(db.get("CHANNEL_ADAPTERS", "CHANNEL#whatsapp")).toMatchObject({ winner: true });
  });

  it("says how to recover when the record is saved but the secret write fails", async () => {
    const secrets = { put: vi.fn(async () => { throw new Error("AccessDenied"); }) };
    const harness = createBroker({ extra: { channelAdapters: { secretPrefix: "agentx/test/", secrets } } });
    await registerSlackProject(harness.handler);
    const answer = await call(harness.handler, { method: "PUT", path: "/v1/admin/channels/whatsapp", user: admin, body: registration });
    expect(answer.status).toBe(503);
    expect(JSON.stringify(answer.body)).toContain("rotate=true");
  });
});
