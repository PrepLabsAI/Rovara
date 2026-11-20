import { describe, expect, it, vi } from "vitest";
import { ConnectorsSchema, ProjectDefinitionSchema } from "../../packages/contracts/src/index.js";
import { ASANA_MCP_ENDPOINT, ASANA_TOKEN_ENDPOINT, CredentialUnavailable } from "../../packages/gateway/src/index.js";
import { asanaConnectorType } from "../../packages/broker/src/aws/asana-connector-type.js";
import { resolveConnectors } from "../../packages/broker/src/aws/connector-types.js";
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

});

describe("asana connector type", () => {

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

  it("is authorize at call time when an asana credential is removed after the connector resolved", async () => {
    const credentials = registry([{ ref: "asana-bot", type: "oauth-refresh-token" }]);
    const provider = vi.spyOn(credentials, "provider");
    const [connector] = resolveConnectors(ProjectDefinitionSchema.parse(project([asana()])), { credentialRegistry: credentials });
    await connector!.definition();
    // Spec 055: a built-in connector also refuses a credential pinned to a host other than its endpoint's.
    expect(provider).toHaveBeenCalledWith("asana-bot", { tokenEndpoint: ASANA_TOKEN_ENDPOINT, accepts: ["oauth-refresh-token"], pin: { host: "mcp.asana.com", required: false } });
    await expect(registry().provider("asana-bot", { tokenEndpoint: ASANA_TOKEN_ENDPOINT, accepts: ["oauth-refresh-token"] }).issue(undefined, "read"))
      .rejects.toThrow(new CredentialUnavailable("credential asana-bot is not registered; run agentx admin credential authorize"));
    await expect(registry().provider("linear-key", { accepts: ["static-secret"] }).issue(undefined, "read"))
      .rejects.toThrow(new CredentialUnavailable("credential linear-key is not registered; run agentx admin credential register"));
  });
});
