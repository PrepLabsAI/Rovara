import { describe, expect, it, vi } from "vitest";
import { PutSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { CredentialUnavailable } from "@agentx/gateway";
import { DynamoRefreshLease, DynamoTokenCache, secretsManagerSource } from "../../packages/broker/src/aws/credentials.js";
import { adminCall, createAdminBroker } from "../support/admin-broker.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { fakeTokenEndpoint, memorySecretStore } from "../support/refresh-token-fakes.js";

const githubApp = { ref: "github-app", secretName: "arn:aws:secretsmanager:us-east-1:111122223333:secret:github-key" };
const SECRET = "agentx/connectors/asana-bot";
const CLIENT = { clientId: "1210000000000001", clientSecret: "client-secret-value-0123456789" };
const REFRESH = "refresh-token-original-value";
const tokenEndpoint = new URL("https://auth.vendor.test/-/oauth_token");
const register = (handler: Parameters<typeof adminCall>[0], body: Record<string, unknown>) => adminCall(handler, { method: "POST", path: "/v1/admin/credentials", body });

describe("oauth-refresh-token in the credential registry", () => {
  it("registers a secret holding a refresh token and refuses one without, naming only the shape", async () => {
    const secrets = memorySecretStore({ [SECRET]: JSON.stringify({ ...CLIENT, refreshToken: REFRESH }), "agentx/connectors/asana-new": JSON.stringify(CLIENT) });
    const { handler } = await createAdminBroker({ connectorCredentials: { secrets, githubApp } });
    const registered = await register(handler, { ref: "asana-bot", type: "oauth-refresh-token", secretName: SECRET });
    expect(registered.status).toBe(201);
    expect(registered.body).toMatchObject({ credential: { ref: "asana-bot", type: "oauth-refresh-token", tokenCached: false } });
    const refused = await register(handler, { ref: "asana-new", type: "oauth-refresh-token", secretName: "agentx/connectors/asana-new" });
    expect(refused.body).toMatchObject({ error: { code: "CONFIG_INVALID", message: 'credential asana-new: secret agentx/connectors/asana-new must be JSON {"clientId": "...", "clientSecret": "...", "refreshToken": "..."}' } });
    expect(JSON.stringify([registered.body, refused.body])).not.toMatch(/client-secret-value|refresh-token-original/);
  });

  it("refreshes through the registry, shares the access token in DynamoDB, leaves no lease behind, and lists tokenCached", async () => {
    const secrets = memorySecretStore({ [SECRET]: JSON.stringify({ ...CLIENT, refreshToken: REFRESH }) });
    const endpoint = fakeTokenEndpoint({ ...CLIENT, refreshToken: REFRESH });
    const { db, handler, registry } = await createAdminBroker({ connectorCredentials: { secrets, githubApp, fetchImplementation: endpoint.fetch } });
    await register(handler, { ref: "asana-bot", type: "oauth-refresh-token", secretName: SECRET });
    const issued = await registry!.provider("asana-bot", { tokenEndpoint }).issue(undefined, "read");
    expect(issued).toEqual({ token: endpoint.accessTokens[0], bindings: {} });
    expect(db.get("CREDENTIAL#asana-bot", "TOKEN#refresh-token")).toMatchObject({ entityType: "CREDENTIAL_TOKEN", token: endpoint.accessTokens[0] });
    expect(db.get("CREDENTIAL#asana-bot", "LEASE#refresh")).toBeUndefined();
    const listed = await adminCall(handler, { method: "GET", path: "/v1/admin/credentials" });
    expect(listed.body.credentials).toContainEqual(expect.objectContaining({ ref: "asana-bot", type: "oauth-refresh-token", tokenCached: true }));
    expect(JSON.stringify(listed.body)).not.toContain(endpoint.accessTokens[0]);
  });

  it("needs a token endpoint from the connector type, and a store that can write", async () => {
    const secrets = memorySecretStore({ [SECRET]: JSON.stringify({ ...CLIENT, refreshToken: REFRESH }) });
    const { handler, registry } = await createAdminBroker({ connectorCredentials: { secrets, githubApp } });
    await register(handler, { ref: "asana-bot", type: "oauth-refresh-token", secretName: SECRET });
    await expect(registry!.provider("asana-bot").issue(undefined, "read")).rejects.toThrow(new CredentialUnavailable("credential asana-bot needs a token endpoint from its connector type"));

    const readOnly = { read: vi.fn(async (name: string) => secrets.values[name]) };
    const second = await createAdminBroker({ connectorCredentials: { secrets: readOnly, githubApp } });
    await register(second.handler, { ref: "asana-bot", type: "oauth-refresh-token", secretName: SECRET });
    await expect(second.registry!.provider("asana-bot", { tokenEndpoint }).issue(undefined, "read"))
      .rejects.toThrow(new CredentialUnavailable("credential asana-bot: this deployment cannot save a rotated refresh token"));
  });

  it("logs a rotated token it could not save by error name only", async () => {
    const secrets = memorySecretStore({ [SECRET]: JSON.stringify({ ...CLIENT, refreshToken: REFRESH }) });
    secrets.failWrites = 2;
    const endpoint = fakeTokenEndpoint({ ...CLIENT, refreshToken: REFRESH });
    endpoint.rotate = true;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const { handler, registry } = await createAdminBroker({ connectorCredentials: { secrets, githubApp, fetchImplementation: endpoint.fetch } });
      await register(handler, { ref: "asana-bot", type: "oauth-refresh-token", secretName: SECRET });
      await registry!.provider("asana-bot", { tokenEndpoint }).issue(undefined, "read");
      const lines = log.mock.calls.map(([line]) => String(line));
      expect(lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.event === "connector.refresh_token_unsaved"))
        .toEqual([{ component: "broker", event: "connector.refresh_token_unsaved", credential: "asana-bot", reason: "AccessDeniedException" }]);
      expect(lines.join("\n")).not.toMatch(/refresh-token-rotated|refresh-token-original|access-token-|client-secret-value/);
    } finally { log.mockRestore(); }
  });
});

describe("DynamoRefreshLease", () => {
  it("grants one owner at a time, lets the owner renew, and hands over after expiry", async () => {
    const db = new FakeDynamoDb();
    let now = 1_000;
    const lease = new DynamoRefreshLease(db as never, "state", "asana-bot", () => now);
    expect(await lease.acquire("a", 15_000)).toBe(true);
    expect(await lease.acquire("b", 15_000)).toBe(false);
    expect(await lease.acquire("a", 15_000)).toBe(true);
    now += 15_001;
    expect(await lease.acquire("b", 15_000)).toBe(true);
    expect(db.get("CREDENTIAL#asana-bot", "LEASE#refresh")).toMatchObject({ entityType: "CREDENTIAL_LEASE", owner: "b" });
  });

  it("renews a still-current owner's lease, extending its expiry, while another owner stays refused until the renewed expiry", async () => {
    const db = new FakeDynamoDb();
    let now = 1_000;
    const lease = new DynamoRefreshLease(db as never, "state", "asana-bot", () => now);
    expect(await lease.acquire("owner-1", 15_000)).toBe(true);
    expect(db.get("CREDENTIAL#asana-bot", "LEASE#refresh")).toMatchObject({ owner: "owner-1", expiresAt: 16_000 });
    now = 14_000;
    expect(await lease.acquire("owner-1", 15_000)).toBe(true);
    expect(db.get("CREDENTIAL#asana-bot", "LEASE#refresh")).toMatchObject({ owner: "owner-1", expiresAt: 29_000 });
    now = 20_000; // past the original expiry, before the renewed one
    expect(await lease.acquire("owner-2", 15_000)).toBe(false);
    expect(db.get("CREDENTIAL#asana-bot", "LEASE#refresh")).toMatchObject({ owner: "owner-1", expiresAt: 29_000 });
    now = 29_001;
    expect(await lease.acquire("owner-2", 15_000)).toBe(true);
    expect(db.get("CREDENTIAL#asana-bot", "LEASE#refresh")).toMatchObject({ owner: "owner-2", expiresAt: 44_001 });
  });

  it("releases only the owner's own lease", async () => {
    const db = new FakeDynamoDb();
    const lease = new DynamoRefreshLease(db as never, "state", "asana-bot", () => 1_000);
    await lease.acquire("a", 15_000);
    await lease.release("b");
    expect(db.get("CREDENTIAL#asana-bot", "LEASE#refresh")).toMatchObject({ owner: "a" });
    await lease.release("a");
    expect(db.get("CREDENTIAL#asana-bot", "LEASE#refresh")).toBeUndefined();
  });

  it("treats a DynamoDB failure as acquired and logs only the error name", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const lease = new DynamoRefreshLease({ send: vi.fn(async () => { throw Object.assign(new Error("throttled detail"), { name: "ThrottlingException" }); }) } as never, "state", "asana-bot");
      expect(await lease.acquire("a", 15_000)).toBe(true);
      await expect(lease.release("a")).resolves.toBeUndefined();
      const lines = log.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
      expect(lines.map((line) => [line.event, line.operation, line.error])).toEqual([
        ["connector.refresh_lease_failed", "acquire", "ThrottlingException"],
        ["connector.refresh_lease_failed", "release", "ThrottlingException"],
      ]);
      expect(JSON.stringify(lines)).not.toContain("throttled detail");
    } finally { log.mockRestore(); }
  });
});

describe("DynamoTokenCache refreshAt", () => {
  it("round-trips a finite refreshAt, and stores none when the entry has none", async () => {
    const db = new FakeDynamoDb();
    const cache = new DynamoTokenCache(db as never, "state", "asana-bot");
    await cache.put("refresh-token", { token: "t1", expiresAt: 5_000, refreshAt: 4_000 } as never);
    expect(db.get("CREDENTIAL#asana-bot", "TOKEN#refresh-token")).toMatchObject({ entityType: "CREDENTIAL_TOKEN", token: "t1", expiresAt: 5_000, refreshAt: 4_000 });
    expect(await cache.get("refresh-token")).toEqual({ token: "t1", expiresAt: 5_000, refreshAt: 4_000 });

    await cache.put("client", { token: "t2", expiresAt: 6_000 });
    expect(db.get("CREDENTIAL#asana-bot", "TOKEN#client")).not.toHaveProperty("refreshAt");
    expect(await cache.get("client")).toEqual({ token: "t2", expiresAt: 6_000 });
  });

  it("ignores a refreshAt that is not a finite number, on write and on read", async () => {
    const db = new FakeDynamoDb();
    const cache = new DynamoTokenCache(db as never, "state", "asana-bot");
    await cache.put("a", { token: "t", expiresAt: 5_000, refreshAt: Number.NaN } as never);
    expect(db.get("CREDENTIAL#asana-bot", "TOKEN#a")).not.toHaveProperty("refreshAt");
    for (const refreshAt of ["4000", Number.POSITIVE_INFINITY, null]) {
      db.set({ pk: "CREDENTIAL#asana-bot", sk: "TOKEN#b", entityType: "CREDENTIAL_TOKEN", token: "t", expiresAt: 5_000, refreshAt });
      expect(await cache.get("b")).toEqual({ token: "t", expiresAt: 5_000 });
    }
  });
});

describe("Secrets Manager write", () => {
  it("replaces the secret value with PutSecretValue", async () => {
    const send = vi.fn<(command: unknown) => Promise<object>>(async () => ({}));
    await secretsManagerSource({ send }).write("agentx/connectors/asana-bot", "{\"refreshToken\":\"r\"}");
    const command = send.mock.calls[0]![0] as PutSecretValueCommand;
    expect(command).toBeInstanceOf(PutSecretValueCommand);
    expect(command.input).toEqual({ SecretId: "agentx/connectors/asana-bot", SecretString: "{\"refreshToken\":\"r\"}" });
  });
});
