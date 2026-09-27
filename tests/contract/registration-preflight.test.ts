import { createHash } from "node:crypto";
import { IN_HOUSE_TOOL_COUNT, ProjectDefinitionSchema, TOOL_LIMIT, TOOL_WARNING_THRESHOLD } from "@agentx/contracts";
import { TARGET_CONFLICT_REASON } from "@agentx/gateway";
import { describe, expect, it, vi } from "vitest";
import { resolveConnectors, type ResolvedConnector } from "../../packages/broker/src/aws/connector-types.js";
import { CredentialRegistry } from "../../packages/broker/src/aws/credentials.js";
import { preflightConnectors } from "../../packages/broker/src/aws/registration-preflight.js";
import type { GitHubMcpDependencies } from "../../packages/broker/src/github-mcp.js";
import { adminCall, adminIssuer, createAdminBroker, type AdminHandler } from "../support/admin-broker.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { trackerConnectorType } from "../support/tracker-connector.js";

const account = "111122223333";

describe("registration preflight", () => {
  it("does not contact the vendor unless the request asks for preflight", async () => {
    const connect = vi.fn(); const credentials = vi.fn();
    const { handler } = await createAdminBroker({ githubMcp: { credentials, connect } });
    const registered = await register(handler, githubConnector(["list_issues"]));
    expect(registered.status).toBe(201);
    expect(registered.body.preflight).toBeUndefined();
    expect(connect).not.toHaveBeenCalled();
    expect(credentials).not.toHaveBeenCalled();
  });

  it("reports offered, missing and skipped tools per connector and names them in warnings", async () => {
    // Vendor offers list_issues with a plain schema and issue_write with an unrepresentable oneOf; approvals are list_issues, issue_write, retired_tool.
    const { handler } = await createAdminBroker({ githubMcp: vendor([plainTool("list_issues"), oneOfTool("issue_write")]) });
    const registered = await register(handler, githubConnector(["list_issues", "issue_write", "retired_tool"]), { preflight: true });
    expect(registered.status).toBe(201);
    expect(registered.body.preflight).toEqual({ connectors: [{
      name: "github", status: "connected", offered: ["github__list_issues"],
      skipped: [{ tool: "retired_tool", reason: "not offered by the vendor" }, { tool: "issue_write", reason: "schema is not a plain object" }],
    }] });
    expect(registered.body.warnings).toEqual([
      "connector github: tool retired_tool skipped: not offered by the vendor",
      "connector github: tool issue_write skipped: schema is not a plain object",
    ]);
  });

  it("registers when the vendor rejects the credential and reports the connector not connected", async () => {
    const { McpUnauthorized } = await import("@agentx/gateway");
    const { handler, db } = await createAdminBroker({ githubMcp: { credentials: async () => ({ owner: "example", repo: "demo", token: "installation-secret" }), connect: vi.fn(async () => { throw new McpUnauthorized(); }) } });
    const registered = await register(handler, githubConnector(["list_issues"]), { preflight: true });
    expect(registered.status).toBe(201);
    expect(registered.body.preflight).toMatchObject({ connectors: [{ name: "github", status: "not_connected", offered: [], skipped: [] }] });
    expect((registered.body.warnings as string[])[0]).toMatch(/^connector github: GitHub is not connected: GitHub rejected the credential twice/);
    expect(JSON.stringify(registered.body)).not.toContain("installation-secret");
    expect(db.get("PROJECT#payments", "REV#000000000001")).toBeDefined();
  });

  it("reports an unreachable vendor as unavailable without failing registration", async () => {
    const { handler } = await createAdminBroker({ githubMcp: { credentials: async () => ({ owner: "example", repo: "demo", token: "t" }), connect: vi.fn(async () => { throw new Error("ECONNRESET"); }) } });
    const registered = await register(handler, githubConnector(["list_issues"]), { preflight: true });
    expect(registered.status).toBe(201);
    expect(registered.body.preflight).toMatchObject({ connectors: [{ name: "github", status: "unavailable" }] });
  });

  it("refuses a new revision whose repository the GitHub App cannot reach, and checks every repository", async () => {
    const { agentXError } = await import("@agentx/contracts");
    const checked: string[] = [];
    const checkRepositoryAccess = vi.fn(async (repository: { credentialRef: string; url: string }) => {
      checked.push(repository.url);
      if (repository.url.includes("/docs")) throw agentXError("CONFIG_INVALID", "the GitHub App cannot access example/docs; install it on example with access to that repository");
    });
    const { handler, db } = await createAdminBroker({ checkRepositoryAccess });
    const refused = await register(handler, githubConnector(["list_issues"]), { repositories: ["demo", "docs"] });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ error: { code: "CONFIG_INVALID" } });
    expect((refused.body as { error: { message: string } }).error.message).toContain("cannot access example/docs");
    expect(checked).toHaveLength(2);
    expect(db.get("PROJECT#payments", "REV#000000000001")).toBeUndefined();
  });

  it("refuses a devcontainer on an AgentCore binding and accepts it on ec2-ebs", async () => {
    const { handler, db } = await createAdminBroker({});
    const withDevcontainer = { devcontainer: { repository: "demo" } };
    const refused = await register(handler, withDevcontainer);
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ error: { code: "CONFIG_INVALID", message: "a devcontainer needs the ec2-ebs deployment mode, not instances-ebs" } });
    expect(db.get("PROJECT#payments", "REV#000000000001")).toBeUndefined();
    const accepted = await adminCall(handler, {
      method: "POST",
      path: "/v1/admin/projects",
      body: { definition: definition(withDevcontainer), runtimeBinding: ec2Binding },
    });
    expect(accepted.status).toBe(201);
  });

  it("reports a deployment without GitHub MCP as not connected", async () => {
    const { handler } = await createAdminBroker({});
    const registered = await register(handler, githubConnector(["list_issues"]), { preflight: true });
    expect(registered.body.preflight).toEqual({ connectors: [{ name: "github", status: "not_connected", problem: "GitHub MCP is not configured in this deployment", offered: [], skipped: [] }] });
  });

  it("refuses a new revision whose multi-repository tool already has a target argument, naming it", async () => {
    const { handler, db } = await createAdminBroker({ githubMcp: vendor([toolWithTarget("list_issues")]) });
    const refused = await register(handler, githubConnector(["list_issues"]), { preflight: true, repositories: ["demo", "docs"] });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ error: { code: "CONFIG_INVALID", message: "connector github tool list_issues already has a target argument and the connector has several scopes; remove its approval" } });
    expect(db.get("PROJECT#payments", "REV#000000000001")).toBeUndefined();
  });

  it("refuses a new revision with a presented name over 64 characters, but re-accepts an identical registered revision", async () => {
    const { handler, db } = await createAdminBroker({});
    const long = "t".repeat(57);
    expect((await register(handler, githubConnector([long]))).body).toMatchObject({ error: { code: "CONFIG_INVALID" } });
    // Seed a revision registered before this check existed; re-submitting it stays idempotent.
    seedRegisteredRevision(db, githubConnector([long]));
    expect((await register(handler, githubConnector([long]))).body).toMatchObject({ duplicate: true });
  });

  it("answers a registration that lost the write race as a duplicate, with its preflight report and one vendor contact", async () => {
    const githubMcp = vendor([plainTool("list_issues")]);
    const { handler, db } = await createAdminBroker({ githubMcp });
    const overrides = githubConnector(["list_issues"]);
    const send = db.send;
    let raced = false;
    // Another writer stores the same revision between this request's read and its conditional write.
    db.send = async (command) => {
      if (!raced && command.constructor.name === "TransactWriteCommand") {
        raced = true;
        seedRegisteredRevision(db, overrides);
        throw Object.assign(new Error("transaction cancelled"), { name: "TransactionCanceledException" });
      }
      return send(command);
    };
    const registered = await register(handler, overrides, { preflight: true });
    expect(raced).toBe(true);
    expect(registered.status).toBe(201);
    expect(registered.body).toMatchObject({ duplicate: true, preflight: { connectors: [{ name: "github", status: "connected", offered: ["github__list_issues"], skipped: [] }] } });
    expect(githubMcp.connect).toHaveBeenCalledTimes(1);
  });

  it("reports an unreachable vendor with the fixed discovery message, never the raw error", async () => {
    const { handler } = await createAdminBroker({ githubMcp: { credentials: async () => ({ owner: "example", repo: "demo", token: "t" }), connect: vi.fn(async () => { throw new Error("ECONNRESET"); }) } });
    const registered = await register(handler, githubConnector(["list_issues"]), { preflight: true });
    const problem = (registered.body.preflight as { connectors: Array<{ problem?: string }> }).connectors[0]!.problem;
    expect(problem).toBe("GitHub MCP discovery failed; check GitHub App issue permissions and endpoint availability");
    expect(JSON.stringify(registered.body)).not.toContain("ECONNRESET");
  });

  it("registers a single-repository tool that already has a target argument and reports it skipped", async () => {
    const { handler, db } = await createAdminBroker({ githubMcp: vendor([toolWithTarget("list_issues")]) });
    const registered = await register(handler, githubConnector(["list_issues"]), { preflight: true });
    expect(registered.status).toBe(201);
    expect(registered.body.preflight).toEqual({ connectors: [{ name: "github", status: "connected", offered: [], skipped: [{ tool: "list_issues", reason: TARGET_CONFLICT_REASON }] }] });
    expect(registered.body.warnings).toEqual([`connector github: tool list_issues skipped: ${TARGET_CONFLICT_REASON}`]);
    expect(db.get("PROJECT#payments", "REV#000000000001")).toBeDefined();
  });

  it("warns when the model could see more than 20 tools", async () => {
    const { handler } = await createAdminBroker({});
    const names = Array.from({ length: 15 }, (_, index) => `tool_${index}`);
    expect((await register(handler, githubConnector(names))).body.warnings).toEqual(["the model could see 21 tools; above 20, tool choice gets less reliable. Approve fewer connector tools."]);
  });

  it("always includes the visible tool budget in the response, with or without preflight", async () => {
    const { handler } = await createAdminBroker({});
    const registered = await register(handler, githubConnector(["list_issues"]));
    expect(registered.status).toBe(201);
    expect(registered.body.tools).toEqual({ maximum: IN_HOUSE_TOOL_COUNT + 1, warnAbove: TOOL_WARNING_THRESHOLD, limit: TOOL_LIMIT });

    const { handler: preflightHandler } = await createAdminBroker({});
    const registeredWithPreflight = await register(preflightHandler, githubConnector(["list_issues"]), { preflight: true });
    expect(registeredWithPreflight.status).toBe(201);
    expect(registeredWithPreflight.body.tools).toEqual({ maximum: IN_HOUSE_TOOL_COUNT + 1, warnAbove: TOOL_WARNING_THRESHOLD, limit: TOOL_LIMIT });
  });
});

describe("registration preflight across connector types", () => {
  it("reports a resolved tracker connector alongside github, unchanged, moving from not connected to connected as its credential registers", async () => {
    const project = ProjectDefinitionSchema.parse(definition(githubConnector(["list_issues"])));
    const [github] = resolveConnectors(project, { githubMcp: vendor([plainTool("list_issues")]) });
    expect(github).toBeDefined();

    const db = new FakeDynamoDb();
    const credentialRegistry = new CredentialRegistry({
      documentClient: db as never, tableName: "state",
      secrets: { read: vi.fn(async (name: string) => (name === "agentx/connectors/tracker-key" ? JSON.stringify({ apiKey: "tracker-api-key-value" }) : undefined)) },
      githubApp: { ref: "github-app", secretName: "agentx/connectors/github-app" },
    });
    const trackerConfig = {
      name: "tracker", type: "tracker", credentialRef: "tracker-key",
      scopes: [{ alias: "site", siteId: "site-1" }],
      tools: [{ name: "list_items", access: "read" }],
    };
    const resolved = trackerConnectorType.resolve(trackerConfig, project, { credentialRegistry });
    if ("unusable" in resolved) throw new Error(resolved.unusable);
    const connect = vi.fn(async () => ({
      tools: [{ name: "list_items", description: "List items on a site", inputSchema: { type: "object", properties: { siteId: { type: "string" } }, required: ["siteId"] } }],
      call: vi.fn(), close: async () => undefined,
    }));
    const tracker = { ...resolved, connect: connect as never };

    const before = await preflightConnectors([github!, tracker], project, "owner-key");
    expect(before.refusals).toEqual([]);
    expect(before.report.connectors).toEqual([
      { name: "github", status: "connected", offered: ["github__list_issues"], skipped: [] },
      { name: "tracker", status: "not_connected", problem: "credential tracker-key is not registered", offered: [], skipped: [] },
    ]);

    db.set({
      pk: "CREDENTIALS", sk: "REF#tracker-key", entityType: "CREDENTIAL", ref: "tracker-key", type: "static-secret",
      secretName: "agentx/connectors/tracker-key", registeredBy: "admin", registeredAt: "2026-09-01T00:00:00.000Z",
    });

    const after = await preflightConnectors([github!, tracker], project, "owner-key");
    expect(after.refusals).toEqual([]);
    expect(after.report.connectors).toEqual([
      { name: "github", status: "connected", offered: ["github__list_issues"], skipped: [] },
      { name: "tracker", status: "connected", offered: ["tracker__list_items"], skipped: [] },
    ]);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("reports a connector unavailable when its definition() rejects, without failing the whole preflight", async () => {
    const project = ProjectDefinitionSchema.parse(definition(githubConnector(["list_issues"])));
    const [github] = resolveConnectors(project, { githubMcp: vendor([plainTool("list_issues")]) });
    const broken: ResolvedConnector = {
      name: "broken", type: "broken", label: "Broken connector", vendor: "Broken",
      scopeNoun: "scope", scopes: [{ alias: "only", scope: {} }],
      policy: { tools: [] }, approvals: [], attribution: false,
      ledger: { prefix: "CONNECTOR#broken#", entityType: "CONNECTOR_INVOCATION" },
      configured: async () => true,
      definition: () => Promise.reject(new Error("boom")),
    };

    const result = await preflightConnectors([github!, broken], project, "owner-key");
    expect(result.refusals).toEqual([]);
    expect(result.report.connectors).toEqual([
      { name: "github", status: "connected", offered: ["github__list_issues"], skipped: [] },
      { name: "broken", status: "unavailable", problem: "Broken MCP discovery failed", offered: [], skipped: [] },
    ]);
  });

  it("refuses a connector whose definition declares a malformed item argument path, before contacting its vendor", async () => {
    const project = ProjectDefinitionSchema.parse(definition(githubConnector(["list_issues"])));
    const connect = vi.fn();
    const malformed: ResolvedConnector = {
      name: "paths", type: "paths", label: "Paths connector", vendor: "Paths",
      scopeNoun: "scope", scopes: [{ alias: "only", scope: {} }],
      policy: { tools: [] }, approvals: [], attribution: false,
      ledger: { prefix: "CONNECTOR#paths#", entityType: "CONNECTOR_INVOCATION" },
      connect, configured: async () => true,
      definition: () => Promise.resolve({
        label: "Paths", endpoint: new URL("https://mcp.paths.test/mcp"), permissionsHint: "Paths permissions",
        credentials: { issue: () => Promise.reject(new Error("not used")) },
        binder: { properties: [], bind: () => ({}) }, guards: [],
        itemArguments: ["id", "tasks[]"],
      }),
    };

    const result = await preflightConnectors([malformed], project, "owner-key");
    expect(result.refusals).toEqual(["connector paths: malformed item argument path \"tasks[]\""]);
    expect(result.report.connectors).toEqual([
      { name: "paths", status: "unavailable", problem: "connector paths declares unusable item arguments", offered: [], skipped: [] },
    ]);
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("registering a project with a jira connector", () => {
  const CLOUD = "1437bb04-4c88-4efd-9d38-658e8febfeba";
  const jira = (overrides: Record<string, unknown> = {}) => ({
    name: "jira", type: "jira", credentialRef: "jira-sa",
    scopes: [{ alias: "pay", cloudId: CLOUD, projectKey: "PAY" }],
    tools: [{ name: "searchJiraIssuesUsingJql", access: "read" }, { name: "createJiraIssue", access: "write" }],
    ...overrides,
  });
  const withJira = (overrides: Record<string, unknown> = {}): Overrides => ({ integrations: { connectors: [
    { name: "github", type: "github", scopes: "all-repositories", tools: [{ name: "list_issues", access: "read" }] },
    jira(overrides),
  ] } });
  const jiraSecrets = { read: vi.fn(async (name: string) => (name === "agentx/connectors/jira-sa" ? JSON.stringify({ apiKey: "jira-api-token-value" }) : JSON.stringify({ clientId: "id", clientSecret: "s", scopes: ["read"] }))) };
  const connectorCredentials = { secrets: jiraSecrets, githubApp: { ref: "github-app", secretName: "agentx/connectors/github-app" } };

  it("refuses an unregistered credential reference and stores nothing", async () => {
    const { handler, db } = await createAdminBroker({ connectorCredentials });
    const refused = await register(handler, withJira());
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ error: { code: "CONFIG_INVALID", message: "connector jira: credential jira-sa is not registered; run agentx admin credential register first" } });
    expect(db.get("PROJECT#payments", "REV#000000000001")).toBeUndefined();
  });

  it("refuses a credential of a type a Jira connector cannot use", async () => {
    const { handler } = await createAdminBroker({ connectorCredentials });
    expect((await adminCall(handler, { method: "POST", path: "/v1/admin/credentials", body: { ref: "jira-oauth", type: "oauth-client-credentials", secretName: "agentx/connectors/jira-oauth" } })).status).toBe(201);
    const refused = await register(handler, withJira({ credentialRef: "jira-oauth" }));
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ error: { code: "CONFIG_INVALID", message: "connector jira: credential jira-oauth is oauth-client-credentials; a Jira connector needs static-secret" } });
  });

  it("registers once the static-secret credential exists, never returning the token", async () => {
    const { handler } = await createAdminBroker({ connectorCredentials });
    expect((await adminCall(handler, { method: "POST", path: "/v1/admin/credentials", body: { ref: "jira-sa", type: "static-secret", secretName: "agentx/connectors/jira-sa" } })).status).toBe(201);
    const registered = await register(handler, withJira());
    expect(registered.status).toBe(201);
    expect(JSON.stringify(registered.body)).not.toContain("jira-api-token-value");
  });

  it("refuses a jira connector in a deployment without connector credentials", async () => {
    const { handler } = await createAdminBroker({});
    const refused = await register(handler, withJira());
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ error: { code: "CONFIG_INVALID", message: "connector jira: connector credentials are not configured in this deployment" } });
  });

  it("re-accepts an identical revision registered before the credential check existed", async () => {
    const { handler, db } = await createAdminBroker({ connectorCredentials });
    seedRegisteredRevision(db, withJira());
    expect((await register(handler, withJira())).body).toMatchObject({ duplicate: true });
  });
});

type Overrides = Record<string, unknown>;

function githubConnector(names: string[]): Overrides {
  return { integrations: { connectors: [{ name: "github", type: "github", scopes: "all-repositories", tools: names.map((name) => ({ name, access: "read" })) }] } };
}

interface ToolDefinition { name: string; description: string; inputSchema: Record<string, unknown> }

/** Fakes serving `tools`; the credential names the repository its URL points at. */
function vendor(tools: ToolDefinition[]): GitHubMcpDependencies {
  return {
    credentials: vi.fn(async (repository: { url: string }) => ({ owner: "example", repo: /\/([^/]+?)(?:\.git)?$/.exec(repository.url)![1]!, token: "installation-token" })),
    connect: vi.fn(async () => ({ tools, call: vi.fn(), close: async () => undefined })),
  };
}

function boundProperties(): Record<string, unknown> {
  return { owner: { type: "string" }, repo: { type: "string" } };
}

function plainTool(name: string): ToolDefinition {
  return { name, description: `The ${name} tool`, inputSchema: { type: "object", properties: { ...boundProperties(), state: { type: "string" } }, required: ["owner", "repo"] } };
}

function oneOfTool(name: string): ToolDefinition {
  return { name, description: `The ${name} tool`, inputSchema: {
    type: "object",
    properties: { ...boundProperties(), title: { type: "string" }, issue_number: { type: "number" } },
    required: ["owner", "repo"],
    oneOf: [{ required: ["title"] }, { required: ["issue_number"] }],
  } };
}

function toolWithTarget(name: string): ToolDefinition {
  return { name, description: `The ${name} tool`, inputSchema: { type: "object", properties: { ...boundProperties(), target: { type: "string" } }, required: ["owner", "repo"] } };
}

function definition(overrides: Overrides, repositories: string[] = ["demo"]): Record<string, unknown> {
  return {
    name: "payments",
    revision: 1,
    repositories: repositories.map((name) => ({ name, url: `https://github.com/example/${name}.git`, path: `repo/${name}`, defaultBranch: "main", credentialRef: "github-app" })),
    setup: [],
    readiness: [],
    orchestratorInstructions: "Delegate work (revision 1).",
    ...overrides,
  };
}

const ec2Binding = {
  deploymentMode: "ec2-ebs",
  launchTemplateId: "lt-0123456789abcdef0",
  subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0aaaaaaaaaaaaaaaa" }],
  volumeSizeGiB: 20,
  volumeType: "gp3",
};

const runtimeBinding = {
  runtimeArn: `arn:aws:bedrock-agentcore:us-east-1:${account}:runtime/agentx_production_worker-YVirjlFgvk`,
  endpointQualifier: "DEFAULT",
  deploymentMode: "instances-ebs",
  capacityProviderArn: `arn:aws:bedrock-agentcore:us-east-1:${account}:capacity-provider/agentx_production_capacity_v3-VwkM93EABZ`,
};

function register(handler: AdminHandler, overrides: Overrides, options: { preflight?: boolean; repositories?: string[] } = {}) {
  return adminCall(handler, {
    method: "POST",
    path: "/v1/admin/projects",
    body: { definition: definition(overrides, options.repositories), runtimeBinding, ...(options.preflight ? { preflight: true } : {}) },
  });
}

/** The revision and membership a registration made before the static checks existed would have stored. */
function seedRegisteredRevision(db: FakeDynamoDb, overrides: Overrides): void {
  const ownerKey = createHash("sha256").update(adminIssuer).update("\0").update("admin-subject").digest("hex");
  db.set({
    pk: "PROJECT#payments", sk: "REV#000000000001", entityType: "PROJECT",
    definition: ProjectDefinitionSchema.parse(definition(overrides)), runtimeBinding,
    registeredBy: ownerKey, registeredAt: "2026-01-01T00:00:00.000Z",
  });
  db.set({ pk: `MEMBER#${ownerKey}`, sk: "PROJECT#payments", entityType: "MEMBERSHIP", ownerKey, projectName: "payments", role: "administrator" });
}
