import { describe, expect, it, vi } from "vitest";
import { ProjectDefinitionSchema } from "../../packages/contracts/src/index.js";
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

const runtimeBinding = {
  deploymentMode: "ec2-ebs" as const,
  launchTemplateId: "lt-0123456789abcdef0",
  subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef0" }],
  volumeSizeGiB: 20,
  volumeType: "gp3" as const,
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

});
