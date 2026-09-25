import { describe, expect, it, vi } from "vitest";
import { ConnectorsSchema, ProjectDefinitionSchema, StoredProjectDefinitionSchema } from "../../packages/contracts/src/index.js";
import { BUILT_IN_CONNECTOR_TYPES, resolveConnectors } from "../../packages/broker/src/aws/connector-types.js";
import { CredentialRegistry } from "../../packages/broker/src/aws/credentials.js";
import { linearConnectorType } from "../../packages/broker/src/aws/linear-connector-type.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { adminCall, createAdminBroker } from "../support/admin-broker.js";

const CHARTERARC = "c408e946-78aa-4db8-923e-f78053dd954f";
const tools = [{ name: "list_issues", access: "read" }, { name: "save_issue", access: "write" }];
const linear = (overrides: Record<string, unknown> = {}) => ({ name: "linear", type: "linear", credentialRef: "linear-charterarc", scopes: [{ alias: "charterarc", teamId: CHARTERARC }], tools, ...overrides });
const project = (connectors: unknown[]) => ({
  name: "payments", revision: 1,
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
  setup: [], readiness: [], orchestratorInstructions: "x", integrations: { connectors },
});

function registry(records: Array<{ ref: string; type: string }> = []) {
  const db = new FakeDynamoDb();
  for (const record of records) db.set({ pk: "CREDENTIALS", sk: `REF#${record.ref}`, entityType: "CREDENTIAL", ref: record.ref, type: record.type, secretName: `agentx/connectors/${record.ref}`, registeredBy: "admin", registeredAt: "2026-09-24T00:00:00.000Z" });
  const secrets = { read: vi.fn(async () => JSON.stringify({ apiKey: "lin_api_value" })) };
  return new CredentialRegistry({ secrets, githubApp: { ref: "github-app", secretName: "agentx/github-app" }, documentClient: db as never, tableName: "state" });
}

describe("linear connector configuration", () => {
  it("accepts a linear connector beside github, and two linear connectors", () => {
    const github = { name: "github", type: "github", scopes: "all-repositories", tools };
    expect(ProjectDefinitionSchema.safeParse(project([github, linear()])).success).toBe(true);
    expect(ProjectDefinitionSchema.safeParse(project([linear(), linear({ name: "linear-two" })])).success).toBe(true);
  });

  it("refuses a missing credentialRef, a bad teamId, duplicate aliases or teams, an identity field and all-repositories", () => {
    const refused = (value: unknown) => ConnectorsSchema.safeParse([value]).success === false;
    expect(refused(linear({ credentialRef: undefined }))).toBe(true);
    expect(refused(linear({ scopes: [{ alias: "charterarc", teamId: "CharterArc" }] }))).toBe(true);
    expect(refused(linear({ scopes: [{ alias: "a", teamId: CHARTERARC }, { alias: "a", teamId: "0b6f3f7e-5d1a-4c1e-9a53-2f0f5a8f1c11" }] }))).toBe(true);
    expect(refused(linear({ scopes: [{ alias: "a", teamId: CHARTERARC }, { alias: "b", teamId: CHARTERARC.toUpperCase() }] }))).toBe(true);
    expect(refused(linear({ identity: "service" }))).toBe(true);
    expect(refused(linear({ scopes: "all-repositories" }))).toBe(true);
    expect(refused(linear({ scopes: [] }))).toBe(true);
  });

  it("validates a stored linear entry strictly instead of passing it through as an unknown type", () => {
    expect(StoredProjectDefinitionSchema.safeParse(project([linear()])).success).toBe(true);
    expect(StoredProjectDefinitionSchema.safeParse(project([linear({ extra: true })])).success).toBe(false);
  });
});

describe("linear connector type", () => {
  it("is built in and resolves label, vendor, scope noun, ledger and credential", () => {
    expect(BUILT_IN_CONNECTOR_TYPES.linear).toBe(linearConnectorType);
    const [connector] = resolveConnectors(ProjectDefinitionSchema.parse(project([linear({ scopes: [{ alias: "charterarc", teamId: CHARTERARC.toUpperCase() }] })])), { credentialRegistry: registry() });
    expect(connector).toMatchObject({
      name: "linear", type: "linear", label: "Linear issues", vendor: "Linear", scopeNoun: "team", attribution: true,
      ledger: { prefix: "CONNECTOR#linear#", entityType: "CONNECTOR_INVOCATION" },
      credential: { ref: "linear-charterarc", accepts: ["static-secret"] },
      scopes: [{ alias: "charterarc", scope: { alias: "charterarc", teamId: CHARTERARC } }],
    });
  });

  it("is not connected until a static-secret credential is registered, and never throws", async () => {
    const definition = ProjectDefinitionSchema.parse(project([linear()]));
    const none = resolveConnectors(definition, {})[0]!;
    expect(await none.configured()).toBe(false);
    expect(await none.definition()).toEqual({ notConnected: "connector credentials are not configured in this deployment" });

    const missing = resolveConnectors(definition, { credentialRegistry: registry() })[0]!;
    expect(await missing.definition()).toEqual({ notConnected: "credential linear-charterarc is not registered" });

    const oauth = resolveConnectors(definition, { credentialRegistry: registry([{ ref: "linear-charterarc", type: "oauth-client-credentials" }]) })[0]!;
    expect(await oauth.configured()).toBe(false);
    expect(await oauth.definition()).toEqual({ notConnected: "credential linear-charterarc is oauth-client-credentials; a Linear connector needs a static-secret API key" });

    const ready = resolveConnectors(definition, { credentialRegistry: registry([{ ref: "linear-charterarc", type: "static-secret" }]) })[0]!;
    expect(await ready.configured()).toBe(true);
    const resolved = await ready.definition();
    if ("notConnected" in resolved) throw new Error("expected a definition");
    expect(resolved.endpoint.href).toBe("https://mcp.linear.app/mcp");
    expect(await resolved.credentials.issue({ alias: "charterarc", teamId: CHARTERARC }, "read")).toEqual({ token: "lin_api_value", bindings: {} });
  });

  it("treats a malformed stored linear entry as unusable, with a log line naming the bad fields", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const stored = project([linear({ scopes: [{ alias: "charterarc" }] })]) as never;
      expect(resolveConnectors(stored, {})).toEqual([]);
      const lines = log.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>).filter((line) => line.event === "connector.unusable");
      expect(lines).toEqual([{ component: "broker", event: "connector.unusable", project: "payments", revision: 1, connector: "linear", type: "linear", reason: "invalid linear connector configuration: scopes" }]);
    } finally { log.mockRestore(); }
  });
});

describe("credential registry typeOf", () => {
  it("names the built-in GitHub App, a registered type, and nothing for an unknown or malformed ref", async () => {
    const credentials = registry([{ ref: "linear-charterarc", type: "static-secret" }]);
    expect(await credentials.typeOf("github-app")).toBe("github-app");
    expect(await credentials.typeOf("linear-charterarc")).toBe("static-secret");
    expect(await credentials.typeOf("missing")).toBeUndefined();
  });
});

const runtimeBinding = {
  runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/agentx_production_worker-YVirjlFgvk",
  endpointQualifier: "DEFAULT", deploymentMode: "instances-ebs",
  capacityProviderArn: "arn:aws:bedrock-agentcore:us-east-1:111122223333:capacity-provider/agentx_production_capacity_v3-VwkM93EABZ",
};
const secretsFor = (types: Record<string, unknown>) => ({ read: vi.fn(async (name: string) => types[name] === undefined ? undefined : JSON.stringify(types[name])) });

describe("registering a project with a linear connector", () => {
  const register = (handler: Parameters<typeof adminCall>[0], connectors: unknown[], revision = 1) =>
    adminCall(handler, { method: "POST", path: "/v1/admin/projects", body: { definition: { ...project(connectors), revision }, runtimeBinding } });

  it("refuses when the deployment has no credential registry", async () => {
    const { handler } = await createAdminBroker();
    const response = await register(handler, [linear()]);
    expect(response.status).toBe(400);
    expect(response.body.error).toEqual({ code: "CONFIG_INVALID", message: "connector linear: connector credentials are not configured in this deployment" });
  });

  it("refuses an unregistered reference, an OAuth credential and the built-in GitHub App, naming each", async () => {
    const { handler } = await createAdminBroker({ connectorCredentials: {
      secrets: secretsFor({ "agentx/connectors/linear-oauth": { clientId: "c", clientSecret: "s", scopes: ["read"] } }),
      githubApp: { ref: "github-app", secretName: "agentx/github-app" },
    } });
    expect((await adminCall(handler, { method: "POST", path: "/v1/admin/credentials", body: { ref: "linear-oauth", type: "oauth-client-credentials", secretName: "agentx/connectors/linear-oauth" } })).status).toBe(201);
    expect((await register(handler, [linear()])).body.error).toEqual({ code: "CONFIG_INVALID", message: "connector linear: credential linear-charterarc is not registered; run agentx admin credential register first" });
    expect((await register(handler, [linear({ credentialRef: "linear-oauth" })])).body.error).toEqual({ code: "CONFIG_INVALID", message: "connector linear: credential linear-oauth is oauth-client-credentials; a Linear connector needs static-secret" });
    expect((await register(handler, [linear({ credentialRef: "github-app" })])).body.error).toEqual({ code: "CONFIG_INVALID", message: "connector linear: credential github-app is github-app; a Linear connector needs static-secret" });
  });

  it("registers once the static-secret credential exists, without contacting Linear, and stays idempotent", async () => {
    const { handler, db } = await createAdminBroker({ connectorCredentials: {
      secrets: secretsFor({ "agentx/connectors/linear-charterarc": { apiKey: "lin_api_value" } }),
      githubApp: { ref: "github-app", secretName: "agentx/github-app" },
    } });
    expect((await adminCall(handler, { method: "POST", path: "/v1/admin/credentials", body: { ref: "linear-charterarc", type: "static-secret", secretName: "agentx/connectors/linear-charterarc" } })).status).toBe(201);
    expect((await register(handler, [linear()])).status).toBe(201);
    // The credential disappears; re-submitting the same registered revision still answers as a duplicate.
    for (const item of db.find((entry) => entry.pk === "CREDENTIALS")) db.items.delete(`${item.pk as string}\u0000${item.sk as string}`);
    const again = await register(handler, [linear()]);
    expect(again.status).toBe(201);
    expect(again.body.duplicate).toBe(true);
  });
});
