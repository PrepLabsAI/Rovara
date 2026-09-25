import { describe, expect, it, vi } from "vitest";
import { ASANA_PROJECT_TOOL_ACCESS, ConnectorsSchema, type CredentialType, ProjectDefinitionSchema, StoredProjectDefinitionSchema } from "../../packages/contracts/src/index.js";
import { ASANA_MCP_ENDPOINT, ASANA_TOKEN_ENDPOINT, CredentialUnavailable } from "../../packages/gateway/src/index.js";
import { asanaConnectorType } from "../../packages/broker/src/aws/asana-connector-type.js";
import { BUILT_IN_CONNECTOR_TYPES, resolveConnectors, type ResolvedConnector } from "../../packages/broker/src/aws/connector-types.js";
import { CredentialRegistry } from "../../packages/broker/src/aws/credentials.js";
import { credentialRefusals } from "../../packages/broker/src/aws/registration-preflight.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const PROJECT = "1210000000000010";
const tools = [{ name: "search_tasks", access: "read" }, { name: "get_task", access: "read" }, { name: "create_tasks", access: "write" }, { name: "add_comment", access: "write" }];
const asana = (overrides: Record<string, unknown> = {}) => ({ name: "asana", type: "asana", credentialRef: "asana-bot", scopes: [{ alias: "payments", projectGid: PROJECT }], tools, ...overrides });
const project = (connectors: unknown[]) => ({
  name: "payments", revision: 1,
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
  setup: [], readiness: [], orchestratorInstructions: "x", integrations: { connectors },
});

function registry(records: Array<{ ref: string; type: string }> = []) {
  const db = new FakeDynamoDb();
  for (const record of records) db.set({ pk: "CREDENTIALS", sk: `REF#${record.ref}`, entityType: "CREDENTIAL", ref: record.ref, type: record.type, secretName: `agentx/connectors/${record.ref}`, registeredBy: "admin", registeredAt: "2026-09-25T00:00:00.000Z" });
  const secrets = { read: vi.fn(async () => undefined), write: vi.fn(async () => undefined) };
  return new CredentialRegistry({ secrets, githubApp: { ref: "github-app", secretName: "agentx/github-app" }, documentClient: db as never, tableName: "state" });
}

describe("asana connector configuration", () => {
  it("accepts an asana connector beside github, with every guarded tool at its pinned access", () => {
    const github = { name: "github", type: "github", scopes: "all-repositories", tools: [{ name: "list_issues", access: "read" }] };
    const all = Object.entries(ASANA_PROJECT_TOOL_ACCESS).map(([name, access]) => ({ name, access }));
    expect(ProjectDefinitionSchema.safeParse(project([github, asana({ tools: all, identity: "service" })])).success).toBe(true);
  });

  it("refuses an unguarded tool, a wrong access, duplicate aliases or projects, a bad GID and a missing credential", () => {
    const issues = (value: unknown) => {
      const parsed = ConnectorsSchema.safeParse([value]);
      return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
    };
    expect(issues(asana({ tools: [{ name: "delete_task", access: "write" }] }))).toContain("connector asana: tool delete_task cannot be limited to an Asana project; approve only get_task, get_task_stories, get_tasks, search_tasks, get_project, create_tasks, update_tasks, add_comment");
    expect(issues(asana({ tools: [{ name: "add_comment", access: "read" }] }))).toContain("connector asana: tool add_comment must be approved with access: write");
    expect(issues(asana({ scopes: [{ alias: "a", projectGid: PROJECT }, { alias: "a", projectGid: "1210000000000020" }] }))).toContain("connector asana: scope aliases must be unique");
    expect(issues(asana({ scopes: [{ alias: "a", projectGid: PROJECT }, { alias: "b", projectGid: PROJECT }] }))).toContain("connector asana: scopes must name different Asana projects");
    expect(issues(asana({ scopes: [{ alias: "a", projectGid: "https://app.asana.com/0/1210000000000010" }] }))).not.toEqual([]);
    expect(issues(asana({ credentialRef: undefined }))).not.toEqual([]);
    expect(issues(asana({ scopes: [] }))).not.toEqual([]);
  });

  it("validates a stored asana entry strictly", () => {
    expect(StoredProjectDefinitionSchema.safeParse(project([asana()])).success).toBe(true);
    expect(StoredProjectDefinitionSchema.safeParse(project([asana({ extra: true })])).success).toBe(false);
  });
});

describe("asana connector type", () => {
  it("is built in and resolves label, vendor, scope noun, ledger and an oauth-refresh-token credential", () => {
    expect(BUILT_IN_CONNECTOR_TYPES.asana).toBe(asanaConnectorType);
    const [connector] = resolveConnectors(ProjectDefinitionSchema.parse(project([asana()])), { credentialRegistry: registry() });
    expect(connector).toMatchObject({
      name: "asana", type: "asana", label: "Asana tasks", vendor: "Asana", scopeNoun: "Asana project", attribution: true,
      ledger: { prefix: "CONNECTOR#asana#", entityType: "CONNECTOR_INVOCATION" },
      credential: { ref: "asana-bot", accepts: ["oauth-refresh-token"] },
      scopes: [{ alias: "payments", scope: { alias: "payments", projectGid: PROJECT } }],
    });
  });

  it("is not connected until an oauth-refresh-token credential is registered under its reference", async () => {
    const resolve = (records: Array<{ ref: string; type: string }>) => resolveConnectors(ProjectDefinitionSchema.parse(project([asana()])), { credentialRegistry: registry(records) })[0]!;
    expect(await resolve([]).definition()).toEqual({ notConnected: "credential asana-bot is not registered" });
    expect(await resolve([{ ref: "asana-bot", type: "static-secret" }]).definition())
      .toEqual({ notConnected: "credential asana-bot is static-secret; an Asana connector needs an oauth-refresh-token credential from agentx admin credential authorize" });
    expect(await resolve([{ ref: "asana-bot", type: "static-secret" }]).configured()).toBe(false);
    const connected = resolve([{ ref: "asana-bot", type: "oauth-refresh-token" }]);
    expect(await connected.configured()).toBe(true);
    expect(await connected.definition()).toMatchObject({ label: "Asana", endpoint: ASANA_MCP_ENDPOINT });
    const [withoutRegistry] = resolveConnectors(ProjectDefinitionSchema.parse(project([asana()])), {});
    expect(await withoutRegistry!.definition()).toEqual({ notConnected: "connector credentials are not configured in this deployment" });
  });

  it("is refused at registration unless its reference is a registered oauth-refresh-token credential, in plain English", async () => {
    const connectors = (records: Array<{ ref: string; type: string }>) => {
      const credentials = registry(records);
      return { credentials, resolved: resolveConnectors(ProjectDefinitionSchema.parse(project([asana()])), { credentialRegistry: credentials }) };
    };
    const unregistered = connectors([]);
    expect(await credentialRefusals(unregistered.resolved, unregistered.credentials)).toEqual(["connector asana: credential asana-bot is not registered; run agentx admin credential authorize first"]);
    const wrong = connectors([{ ref: "asana-bot", type: "static-secret" }]);
    expect(await credentialRefusals(wrong.resolved, wrong.credentials)).toEqual(["connector asana: credential asana-bot is static-secret; an Asana connector needs oauth-refresh-token"]);
    const right = connectors([{ ref: "asana-bot", type: "oauth-refresh-token" }]);
    expect(await credentialRefusals(right.resolved, right.credentials)).toEqual([]);
  });

  it("reports a malformed stored entry as unusable, naming the rule, never throwing", () => {
    const result = asanaConnectorType.resolve({ name: "asana", type: "asana", credentialRef: "asana-bot", scopes: [{ alias: "payments", projectGid: PROJECT }], tools: [{ name: "delete_task", access: "write" }] }, ProjectDefinitionSchema.parse(project([asana()])), {});
    expect(result).toEqual({ unusable: expect.stringMatching(/^invalid asana connector configuration: entry; connector asana: tool delete_task cannot be limited/) as unknown });
  });
});

describe("the setup command named for an unregistered credential", () => {
  // Derived from the credential type the connector declares, never from the connector's name.
  const connectorAccepting = (name: string, accepts: readonly CredentialType[]) =>
    ({ name, vendor: "Example", credential: { ref: `${name}-cred`, accepts } }) as unknown as ResolvedConnector;

  it("is authorize for a connector that needs an oauth-refresh-token credential and register for any other", async () => {
    expect(await credentialRefusals([connectorAccepting("bot", ["oauth-refresh-token"]), connectorAccepting("keyed", ["static-secret"]), connectorAccepting("client", ["oauth-client-credentials"])], registry())).toEqual([
      "connector bot: credential bot-cred is not registered; run agentx admin credential authorize first",
      "connector keyed: credential keyed-cred is not registered; run agentx admin credential register first",
      "connector client: credential client-cred is not registered; run agentx admin credential register first",
    ]);
  });

  it("is authorize at call time when an asana credential is removed after the connector resolved", async () => {
    const credentials = registry([{ ref: "asana-bot", type: "oauth-refresh-token" }]);
    const provider = vi.spyOn(credentials, "provider");
    const [connector] = resolveConnectors(ProjectDefinitionSchema.parse(project([asana()])), { credentialRegistry: credentials });
    await connector!.definition();
    expect(provider).toHaveBeenCalledWith("asana-bot", { tokenEndpoint: ASANA_TOKEN_ENDPOINT, accepts: ["oauth-refresh-token"] });
    await expect(registry().provider("asana-bot", { tokenEndpoint: ASANA_TOKEN_ENDPOINT, accepts: ["oauth-refresh-token"] }).issue(undefined, "read"))
      .rejects.toThrow(new CredentialUnavailable("credential asana-bot is not registered; run agentx admin credential authorize"));
    await expect(registry().provider("linear-key", { accepts: ["static-secret"] }).issue(undefined, "read"))
      .rejects.toThrow(new CredentialUnavailable("credential linear-key is not registered; run agentx admin credential register"));
  });
});
