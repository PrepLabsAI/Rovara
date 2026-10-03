// Spec 055: the generic `mcp` connector type in the broker, and credential host pinning for it and
// for the built-in presets.
import { describe, expect, it, vi } from "vitest";
import { ProjectDefinitionSchema } from "../../packages/contracts/src/index.js";
import { CredentialUnavailable } from "../../packages/gateway/src/index.js";
import { mcpConnectorType } from "../../packages/broker/src/aws/connector-presets.js";
import { BUILT_IN_CONNECTOR_TYPES, resolveConnectors } from "../../packages/broker/src/aws/connector-types.js";
import { CredentialRegistry, hostPinProblem } from "../../packages/broker/src/aws/credentials.js";
import { credentialRefusals } from "../../packages/broker/src/aws/registration-preflight.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const TEAM = "c408e946-78aa-4db8-923e-f78053dd954f";
const sentry = (overrides: Record<string, unknown> = {}) => ({
  name: "sentry", type: "mcp", endpoint: "https://mcp.sentry.dev/mcp",
  label: "Sentry issues", vendor: "Sentry", scopeNoun: "organization", credentialRef: "sentry-bot",
  scopes: [{ alias: "acme", values: { organizationSlug: "acme" } }],
  bind: { required: { organizationSlug: "organizationSlug" } },
  scoping: { mode: "credential" },
  tools: [{ name: "get_issue_details", access: "read" }],
  ...overrides,
});
const linear = { name: "linear", type: "linear", credentialRef: "linear-key", scopes: [{ alias: "charterarc", teamId: TEAM }], tools: [{ name: "list_issues", access: "read" }] };
const project = (connectors: unknown[]) => ({
  name: "payments", revision: 1,
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
  setup: [], readiness: [], orchestratorInstructions: "x", integrations: { connectors },
});

type Record_ = { ref: string; type: string; host?: string };
function setup(records: Record_[] = []) {
  const db = new FakeDynamoDb();
  const put = (record: Record_, registeredAt = "2026-10-03T00:00:00.000Z") => db.set({
    pk: "CREDENTIALS", sk: `REF#${record.ref}`, entityType: "CREDENTIAL", ref: record.ref, type: record.type,
    secretName: `agentx/connectors/${record.ref}`, ...(record.host ? { host: record.host } : {}), registeredBy: "admin", registeredAt,
  });
  records.forEach((record) => put(record));
  const registry = new CredentialRegistry({
    secrets: { read: vi.fn(async () => JSON.stringify({ apiKey: "sntrys_value" })) },
    githubApp: { ref: "github-app", secretName: "agentx/connectors/github-app" },
    documentClient: db as never, tableName: "state",
  });
  const resolve = (connector: unknown) => resolveConnectors(ProjectDefinitionSchema.parse(project([connector])), { credentialRegistry: registry })[0]!;
  return { db, registry, put, resolve };
}

describe("mcp connector type", () => {
  it("is built in and resolves labels, scopes as { alias, ...values }, ledger and a required host pin", () => {
    expect(BUILT_IN_CONNECTOR_TYPES.mcp).toBe(mcpConnectorType);
    const { resolve } = setup();
    const connector = resolve(sentry());
    expect(connector).toMatchObject({
      name: "sentry", type: "mcp", label: "Sentry issues", vendor: "Sentry", scopeNoun: "organization", attribution: true,
      ledger: { prefix: "CONNECTOR#sentry#", entityType: "CONNECTOR_INVOCATION" },
      credential: { ref: "sentry-bot", accepts: ["static-secret", "oauth-refresh-token", "oauth-client-credentials"], pin: { host: "mcp.sentry.dev", required: true } },
    });
    expect(connector.scopes).toEqual([{ alias: "acme", scope: { alias: "acme", organizationSlug: "acme" } }]);
    expect(connector.approvals).toEqual([{ name: "get_issue_details", access: "read" }]);
  });

  it("is not connected until its credential is registered, of the right type and pinned to the endpoint's host", async () => {
    const { resolve, put } = setup();
    const connector = resolve(sentry());
    expect(await connector.configured()).toBe(false);
    expect(await connector.definition()).toEqual({ notConnected: "credential sentry-bot is not registered" });
    put({ ref: "sentry-bot", type: "oauth-refresh-token", host: "mcp.sentry.dev" });
    expect(await connector.definition()).toEqual({ notConnected: "credential sentry-bot has no token URL; sign in with agentx admin credential authorize --ref sentry-bot --endpoint https://mcp.sentry.dev/mcp, or register it with --token-url" });
    put({ ref: "sentry-bot", type: "static-secret" });
    expect(await connector.configured()).toBe(false);
    expect(await connector.definition()).toEqual({ notConnected: "credential sentry-bot is not pinned to a host; register it again with --host mcp.sentry.dev" });
    put({ ref: "sentry-bot", type: "static-secret", host: "mcp.evil.example" });
    expect(await connector.definition()).toEqual({ notConnected: "credential sentry-bot is pinned to mcp.evil.example, not mcp.sentry.dev, so AgentX does not send it there" });
    put({ ref: "sentry-bot", type: "static-secret", host: "mcp.sentry.dev" });
    expect(await connector.configured()).toBe(true);
    const definition = await connector.definition();
    if ("notConnected" in definition) throw new Error("expected a definition");
    expect(definition.endpoint.href).toBe("https://mcp.sentry.dev/mcp");
    expect(await definition.credentials.issue(connector.scopes[0]!.scope, "read")).toEqual({ token: "sntrys_value", bindings: {} });
  });

  it("checks the pin again when it issues the token, so a later re-registration elsewhere sends nothing", async () => {
    const { resolve, put } = setup([{ ref: "sentry-bot", type: "static-secret", host: "mcp.sentry.dev" }]);
    const connector = resolve(sentry());
    const definition = await connector.definition();
    if ("notConnected" in definition) throw new Error("expected a definition");
    put({ ref: "sentry-bot", type: "static-secret", host: "mcp.other.example" }, "2026-10-03T01:00:00.000Z");
    await expect(definition.credentials.issue(connector.scopes[0]!.scope, "read"))
      .rejects.toThrow(new CredentialUnavailable("credential sentry-bot is pinned to mcp.other.example, not mcp.sentry.dev, so AgentX does not send it there"));
  });

  it("refuses a revision whose mcp credential is unpinned or pinned elsewhere", async () => {
    const { registry, put, resolve } = setup([{ ref: "sentry-bot", type: "static-secret" }]);
    const connector = resolve(sentry());
    expect(await credentialRefusals([connector], registry)).toEqual(["connector sentry: credential sentry-bot is not pinned to a host; register it again with --host mcp.sentry.dev"]);
    put({ ref: "sentry-bot", type: "static-secret", host: "mcp.sentry.dev" });
    expect(await credentialRefusals([connector], registry)).toEqual([]);
  });

  it("skips, with the schema's own reason, a stored entry with a plain-http endpoint", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const { registry } = setup();
      const stored = { ...project([sentry({ endpoint: "http://mcp.sentry.dev/mcp" })]) };
      expect(resolveConnectors(stored as never, { credentialRegistry: registry })).toEqual([]);
      const line = log.mock.calls.map(([entry]) => String(entry)).find((entry) => entry.includes("connector.unusable"));
      expect(JSON.parse(line!)).toMatchObject({ connector: "sentry", type: "mcp", reason: "invalid mcp connector configuration: endpoint; endpoint must use https" });
    } finally { log.mockRestore(); }
  });
});

describe("host pins on built-in presets", () => {
  it("leave an unpinned credential working, and refuse one pinned to another host", async () => {
    const { resolve, put, registry } = setup([{ ref: "linear-key", type: "static-secret" }]);
    const connector = resolve(linear);
    expect(connector.credential).toMatchObject({ pin: { host: "mcp.linear.app", required: false } });
    expect(await connector.configured()).toBe(true);
    put({ ref: "linear-key", type: "static-secret", host: "mcp.linear.app" });
    expect(await connector.configured()).toBe(true);
    put({ ref: "linear-key", type: "static-secret", host: "mcp.sentry.dev" });
    expect(await connector.configured()).toBe(false);
    expect(await connector.definition()).toEqual({ notConnected: "credential linear-key is pinned to mcp.sentry.dev, not mcp.linear.app, so AgentX does not send it there" });
    expect(await credentialRefusals([connector], registry)).toEqual(["connector linear: credential linear-key is pinned to mcp.sentry.dev, not mcp.linear.app, so AgentX does not send it there"]);
  });

  it("explains each case", () => {
    expect(hostPinProblem("k", undefined, undefined)).toBeUndefined();
    expect(hostPinProblem("k", "a.example", undefined)).toBeUndefined();
    expect(hostPinProblem("k", undefined, { host: "a.example", required: false })).toBeUndefined();
    expect(hostPinProblem("k", "a.example", { host: "a.example", required: true })).toBeUndefined();
    expect(hostPinProblem("k", undefined, { host: "a.example", required: true })).toBe("credential k is not pinned to a host; register it again with --host a.example");
  });
});

describe("credential registration with a host", () => {
  it("stores and lists the host", async () => {
    const { registry, db } = setup();
    const admin = { ownerKey: "admin", isAdministrator: true } as never;
    await registry.register(admin, { ref: "sentry-bot", type: "static-secret", secretName: "agentx/connectors/sentry-bot", host: "mcp.sentry.dev" });
    expect(db.get("CREDENTIALS", "REF#sentry-bot")).toMatchObject({ host: "mcp.sentry.dev" });
    expect((await registry.list(admin)).credentials).toContainEqual(expect.objectContaining({ ref: "sentry-bot", host: "mcp.sentry.dev" }));
    await expect(registry.register(admin, { ref: "sentry-bot", type: "static-secret", secretName: "agentx/connectors/sentry-bot", host: "https://mcp.sentry.dev" }))
      .rejects.toThrow("invalid credential registration");
  });
});

describe("OAuth credentials on generic connectors (phase 2)", () => {
  const TOKEN_URL = "https://auth.sentry.example/oauth/token";
  function oauthSetup(record: Record<string, unknown>) {
    const db = new FakeDynamoDb();
    db.set({ pk: "CREDENTIALS", sk: `REF#${String(record.ref)}`, entityType: "CREDENTIAL", secretName: `agentx/connectors/${String(record.ref)}`, registeredBy: "admin", registeredAt: "2026-10-03T00:00:00.000Z", ...record });
    const refreshes: Array<{ url: string; body: Record<string, string> }> = [];
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      refreshes.push({ url: url instanceof Request ? url.url : url instanceof URL ? url.href : url, body: Object.fromEntries(new URLSearchParams(init?.body as string)) });
      return Response.json({ access_token: "fresh-access", refresh_token: "rotated", expires_in: 3600 });
    });
    const secrets = { read: vi.fn(async () => JSON.stringify({ clientId: "dyn-client", refreshToken: "r-1" })), write: vi.fn(async () => undefined) };
    const registry = new CredentialRegistry({
      secrets, githubApp: { ref: "github-app", secretName: "agentx/connectors/github-app" }, documentClient: db as never, tableName: "state", fetchImplementation,
    });
    const resolve = (connector: unknown) => resolveConnectors(ProjectDefinitionSchema.parse(project([connector])), { credentialRegistry: registry })[0]!;
    return { resolve, refreshes, secrets };
  }

  it("refreshes at the credential's token URL with its resource, as a public client", async () => {
    const { resolve, refreshes, secrets } = oauthSetup({ ref: "sentry-bot", type: "oauth-refresh-token", host: "mcp.sentry.dev", tokenUrl: TOKEN_URL, resource: "https://mcp.sentry.dev/mcp" });
    const connector = resolve(sentry());
    expect(await connector.configured()).toBe(true);
    const definition = await connector.definition();
    if ("notConnected" in definition) throw new Error(definition.notConnected);
    expect(await definition.credentials.issue(connector.scopes[0]!.scope, "read")).toMatchObject({ token: "fresh-access" });
    expect(refreshes).toEqual([{ url: TOKEN_URL, body: { grant_type: "refresh_token", refresh_token: "r-1", client_id: "dyn-client", resource: "https://mcp.sentry.dev/mcp" } }]);
    expect(secrets.write).toHaveBeenCalledWith("agentx/connectors/sentry-bot", JSON.stringify({ clientId: "dyn-client", refreshToken: "rotated" }));
  });

  it("refuses a preset credential registered for another token URL", async () => {
    const asana = {
      name: "asana", type: "asana", credentialRef: "asana-bot", scopes: [{ alias: "payments", projectGid: "1210000000000010" }],
      tools: [{ name: "get_task", access: "read" }],
    };
    const { resolve, refreshes } = oauthSetup({ ref: "asana-bot", type: "oauth-refresh-token", tokenUrl: TOKEN_URL });
    const connector = resolve(asana);
    expect(await connector.definition()).toEqual({ notConnected: `credential asana-bot is registered for token URL ${TOKEN_URL}, not https://app.asana.com/-/oauth_token, so AgentX does not send it there` });
    expect(refreshes).toEqual([]);
  });
});
