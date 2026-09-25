import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { connectMcp, JIRA_MCP_ENDPOINT } from "@agentx/gateway";
import { githubConnectorType, type ConnectorType } from "../../packages/broker/src/aws/connector-types.js";
import { jiraConnectorType } from "../../packages/broker/src/aws/jira-connector-type.js";
import { ConnectorCatalogSchema } from "../../packages/contracts/src/connectors.js";
import { SlackThreadWorkspaceResultSchema } from "../../packages/contracts/src/slack.js";
import { startFakeAtlassian, type FakeAtlassian } from "../support/fake-atlassian-mcp.js";
import { call, createBroker, ensureWorkspace, loadSlackBroker, markReady, orchestratorPrincipal, type Handler } from "../support/slack-broker.js";

const team = "T0BSHLLUGBD";
const channel = "C0123456789";
const thread = `${team}/${channel}/1695500000.000001`;
const pratik = "U0123456789";
const admin = { subject: "admin-subject", admin: true };
const service = { principal: orchestratorPrincipal, thread, slackUser: pratik };

// A real service-account API token is about 192 characters; this string is that long too, so a
// truncation bug (the 128-character Keychain cut a real deployment can hit) would show up here.
const TOKEN = `ATATT-test-${"x".repeat(181)}`;
const CLOUD = "1437bb04-4c88-4efd-9d38-658e8febfeba";
// The description override a project can give an approved tool, as docs/connectors/jira.md's
// example does for searchJiraIssuesUsingJql (there for project PAY; here for KAN).
const SEARCH_DESCRIPTION = 'Search Jira issues in project KAN with JQL. AgentX adds the project filter itself; send only the rest of the query, for example status = "To Do" ORDER BY created DESC.';

const jiraConnectorConfig = {
  name: "jira", type: "jira", credentialRef: "jira-agentx-sa",
  scopes: [{ alias: "kan", cloudId: CLOUD, projectKey: "KAN" }],
  tools: [
    { name: "searchJiraIssuesUsingJql", access: "read", description: SEARCH_DESCRIPTION },
    { name: "getJiraIssue", access: "read" },
    { name: "createJiraIssue", access: "write" },
    { name: "addOrEditJiraIssueComment", access: "write" },
  ],
};

function projectRegistrationBody(): Record<string, unknown> {
  return {
    definition: {
      name: "payments", revision: 1,
      repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
      setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
      integrations: { connectors: [jiraConnectorConfig] },
    },
    runtimeBinding: {
      runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/agentx_production_worker-YVirjlFgvk",
      endpointQualifier: "DEFAULT", deploymentMode: "instances-ebs",
      capacityProviderArn: "arn:aws:bedrock-agentcore:us-east-1:111122223333:capacity-provider/agentx_production_capacity_v3-VwkM93EABZ",
    },
    preflight: true,
  };
}

function registerCredential(handler: Handler) {
  return call(handler, { method: "POST", path: "/v1/admin/credentials", user: admin,
    body: { ref: "jira-agentx-sa", type: "static-secret", secretName: "agentx/connectors/jira-agentx-sa" } });
}

async function registerAndBind(handler: Handler): Promise<void> {
  const registered = await call(handler, { method: "POST", path: "/v1/admin/projects", user: admin, body: projectRegistrationBody() });
  expect(registered.status).toBe(201);
  expect((await call(handler, { method: "PUT", path: `/v1/admin/slack/bindings/${team}/${channel}`, user: admin, body: { projectName: "payments" } })).status).toBe(200);
}

let currentFake: FakeAtlassian | undefined;

/** A broker serving github (unused here) and jira, backed by a fresh fake Atlassian MCP server. */
async function setupFake(fakeOptions: { tokenAuth?: boolean } = {}) {
  const fake = await startFakeAtlassian({
    token: TOKEN, issues: { "KAN-1": "KAN-1", "OPS-1": "OPS-1" },
    ...(fakeOptions.tokenAuth === undefined ? {} : { tokenAuth: fakeOptions.tokenAuth }),
  });
  currentFake = fake;
  const connect: typeof connectMcp = (input) => {
    expect(input.endpoint.href).toBe(JIRA_MCP_ENDPOINT.href);
    return connectMcp({ ...input, endpoint: fake.url });
  };
  const jira: ConnectorType = {
    type: "jira",
    resolve: (config, project, context) => jiraConnectorType.resolve(config, project, { ...context, connect }),
  };
  const secrets = { read: vi.fn(async (name: string) => (name === "agentx/connectors/jira-agentx-sa" ? JSON.stringify({ apiKey: TOKEN }) : undefined)) };
  const { db, handler } = createBroker({
    connectorTypes: { github: githubConnectorType, jira },
    connectorCredentials: { secrets, githubApp: { ref: "github-app", secretName: "agentx/connectors/github-app" } },
  });
  return { fake, db, handler };
}

/** setupFake, with the credential registered, the project registered and bound, and the workspace ready. */
async function readyBroker(fakeOptions: { tokenAuth?: boolean } = {}) {
  const { fake, db, handler } = await setupFake(fakeOptions);
  expect((await registerCredential(handler)).status).toBe(201);
  await registerAndBind(handler);
  const workspaceId = (await ensureWorkspace(handler, thread, pratik)).body.workspaceId as string;
  markReady(db, workspaceId);
  return { fake, db, handler, workspaceId, path: `/v1/service/workspaces/${workspaceId}/connectors/jira` };
}

beforeAll(async () => {
  await loadSlackBroker();
});

let log: MockInstance<typeof console.log>;
beforeEach(() => { log = vi.spyOn(console, "log").mockImplementation(() => undefined); });
afterEach(async () => {
  log.mockRestore();
  await currentFake?.close();
  currentFake = undefined;
});

const logLines = () => log.mock.calls.map(([line]) => String(line));

describe("jira connector, end to end against a fake Atlassian MCP server", () => {
  it("refuses registration until the credential is registered, then registers with a connected preflight", async () => {
    const { fake, handler } = await setupFake();
    const refused = await call(handler, { method: "POST", path: "/v1/admin/projects", user: admin, body: projectRegistrationBody() });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ error: {
      code: "CONFIG_INVALID",
      message: "connector jira: credential jira-agentx-sa is not registered; run agentx admin credential register first",
    } });

    expect((await registerCredential(handler)).status).toBe(201);
    const registered = await call(handler, { method: "POST", path: "/v1/admin/projects", user: admin, body: projectRegistrationBody() });
    expect(registered.status).toBe(201);
    expect(registered.body.preflight).toEqual({ connectors: [{
      name: "jira", status: "connected",
      offered: ["jira__searchJiraIssuesUsingJql", "jira__getJiraIssue", "jira__createJiraIssue", "jira__addOrEditJiraIssueComment"],
      skipped: [],
    }] });
    expect(fake.authorizations.length).toBeGreaterThan(0);
    for (const authorization of fake.authorizations) expect(authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("reports API-token authentication disabled at Atlassian as not connected, naming the connector, and still registers", async () => {
    const { handler } = await setupFake({ tokenAuth: false });
    expect((await registerCredential(handler)).status).toBe(201);
    const registered = await call(handler, { method: "POST", path: "/v1/admin/projects", user: admin, body: projectRegistrationBody() });
    expect(registered.status).toBe(201);
    const preflight = registered.body.preflight as { connectors: Array<{ name: string; status: string; problem?: string; offered: string[]; skipped: unknown[] }> };
    expect(preflight.connectors).toHaveLength(1);
    expect(preflight.connectors[0]).toMatchObject({ name: "jira", status: "not_connected", offered: [], skipped: [] });
    expect(preflight.connectors[0]!.problem).toContain("Jira rejected the credential twice; check the service account's API token (complete, not expired)");
    const warnings = registered.body.warnings as string[];
    expect(warnings.some((line) => line.startsWith("connector jira: "))).toBe(true);
  });

  it("hides cloudId and projectKey and binds the registered ones on every call", async () => {
    const { fake, db, handler, workspaceId, path } = await readyBroker();
    const discovered = await call(handler, { method: "GET", path: `${path}/tools`, service });
    expect(discovered.status).toBe(200);
    const catalog = ConnectorCatalogSchema.parse(discovered.body.catalog);
    expect(catalog.tools).toHaveLength(4);
    for (const tool of catalog.tools) {
      expect(Object.keys(tool.inputSchema.properties as Record<string, unknown>)).not.toContain("cloudId");
    }
    const createTool = catalog.tools.find((tool) => tool.name === "jira__createJiraIssue")!;
    expect(Object.keys(createTool.inputSchema.properties as Record<string, unknown>)).not.toContain("projectKey");

    const requestId = randomUUID();
    const schemaHash = createTool.scopes.find((scope) => scope.alias === "kan")!.schemaHash;
    const called = await call(handler, { method: "POST", path: `${path}/call`, service,
      body: { requestId, scope: "kan", tool: "createJiraIssue", schemaHash, arguments: { summary: "Flaky login", issueType: "Bug", description: "Fails 1 in 5." } } });
    expect(called.body.result).toMatchObject({ requestId, status: "SUCCEEDED", replayed: false });
    expect(fake.calls.at(-1)).toEqual({
      name: "createJiraIssue",
      arguments: {
        summary: "Flaky login", issueType: "Bug",
        description: expect.stringMatching(/^Fails 1 in 5\.\n\n—\n/) as unknown,
        cloudId: CLOUD, projectKey: "KAN",
      },
    });
    expect(db.get(`WORKSPACE#${workspaceId}`, `CONNECTOR#jira#${requestId}`)).toMatchObject({ entityType: "CONNECTOR_INVOCATION" });

    const before = fake.calls.length;
    const replayed = await call(handler, { method: "POST", path: `${path}/call`, service,
      body: { requestId, scope: "kan", tool: "createJiraIssue", schemaHash, arguments: { summary: "Flaky login", issueType: "Bug", description: "Fails 1 in 5." } } });
    expect(replayed.body.result).toMatchObject({ status: "SUCCEEDED", replayed: true });
    expect(fake.calls.length).toBe(before);
  });

  it("limits a search to KAN", async () => {
    const { fake, handler, path } = await readyBroker();
    const discovered = await call(handler, { method: "GET", path: `${path}/tools`, service });
    const catalog = ConnectorCatalogSchema.parse(discovered.body.catalog);
    const searchTool = catalog.tools.find((tool) => tool.name === "jira__searchJiraIssuesUsingJql")!;
    const schemaHash = searchTool.scopes.find((scope) => scope.alias === "kan")!.schemaHash;
    const called = await call(handler, { method: "POST", path: `${path}/call`, service,
      body: { requestId: randomUUID(), scope: "kan", tool: "searchJiraIssuesUsingJql", schemaHash, arguments: { jql: 'status = "To Do" ORDER BY created DESC' } } });
    expect(called.body.result).toMatchObject({ status: "SUCCEEDED" });
    expect(fake.calls.at(-1)).toEqual({
      name: "searchJiraIssuesUsingJql",
      arguments: { jql: 'project = "KAN" AND (status = "To Do") ORDER BY created DESC', cloudId: CLOUD },
    });
  });

  it("refuses a comment on another project's issue without writing", async () => {
    const { fake, handler, path } = await readyBroker();
    const discovered = await call(handler, { method: "GET", path: `${path}/tools`, service });
    const catalog = ConnectorCatalogSchema.parse(discovered.body.catalog);
    const commentTool = catalog.tools.find((tool) => tool.name === "jira__addOrEditJiraIssueComment")!;
    const schemaHash = commentTool.scopes.find((scope) => scope.alias === "kan")!.schemaHash;

    const before = fake.calls.length;
    const refused = await call(handler, { method: "POST", path: `${path}/call`, service,
      body: { requestId: randomUUID(), scope: "kan", tool: "addOrEditJiraIssueComment", schemaHash, arguments: { issueIdOrKey: "OPS-1", commentBody: "Deploying now." } } });
    expect(refused.body.result).toMatchObject({ status: "FAILED", reason: "policy_denied" });
    expect(fake.calls.slice(before)).toEqual([{ name: "getJiraIssue", arguments: { cloudId: CLOUD, issueIdOrKey: "OPS-1" } }]);

    const accepted = await call(handler, { method: "POST", path: `${path}/call`, service,
      body: { requestId: randomUUID(), scope: "kan", tool: "addOrEditJiraIssueComment", schemaHash, arguments: { issueIdOrKey: "KAN-1", commentBody: "Deploying now." } } });
    expect(accepted.body.result).toMatchObject({ status: "SUCCEEDED" });
    const last = fake.calls.at(-1)!;
    expect(last.name).toBe("addOrEditJiraIssueComment");
    expect(String(last.arguments.commentBody)).toMatch(/\n\n—\nRequested by `Slack member U0123456789` via AgentX · https:\/\/slack\.com\/archives\/C0123456789\/p1695500000000001$/);
  });

  it("refuses a model-supplied cloudId before contacting Atlassian", async () => {
    const { fake, handler, path } = await readyBroker();
    const discovered = await call(handler, { method: "GET", path: `${path}/tools`, service });
    const catalog = ConnectorCatalogSchema.parse(discovered.body.catalog);
    const getTool = catalog.tools.find((tool) => tool.name === "jira__getJiraIssue")!;
    const schemaHash = getTool.scopes.find((scope) => scope.alias === "kan")!.schemaHash;

    const before = fake.calls.length;
    const refused = await call(handler, { method: "POST", path: `${path}/call`, service,
      body: { requestId: randomUUID(), scope: "kan", tool: "getJiraIssue", schemaHash, arguments: { issueIdOrKey: "KAN-1", cloudId: "attacker-supplied" } } });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toEqual({ code: "FORBIDDEN", message: "Jira routing arguments are server controlled" });
    expect(fake.calls.length).toBe(before);
  });

  it("lists jira at thread setup for services that opt in", async () => {
    const { handler } = await readyBroker();
    const response = await call(handler, { method: "POST", path: "/v1/service/threads/workspace", service,
      body: { requestId: randomUUID(), includeConnectors: true, includeAllConnectorTypes: true } });
    expect(response.status).toBe(200);
    const { requestId, ...result } = response.body;
    expect(typeof requestId).toBe("string");
    const parsed = SlackThreadWorkspaceResultSchema.parse(result);
    expect(parsed.outcome === "WORKSPACE" && parsed.connectors).toEqual([
      { name: "jira", type: "jira", label: "Jira issues", scopes: ["kan"], connected: true },
    ]);
  });

  it("never reveals the token", async () => {
    const { fake, db, handler } = await setupFake();
    const responses: unknown[] = [];
    const send = async (options: Parameters<typeof call>[1]) => {
      const response = await call(handler, options);
      responses.push(response);
      return response;
    };

    // Case 1: refused, then registered, with a connected preflight.
    const refused = await send({ method: "POST", path: "/v1/admin/projects", user: admin, body: projectRegistrationBody() });
    expect(refused.status).toBe(400);
    await send({ method: "POST", path: "/v1/admin/credentials", user: admin,
      body: { ref: "jira-agentx-sa", type: "static-secret", secretName: "agentx/connectors/jira-agentx-sa" } });
    const registered = await send({ method: "POST", path: "/v1/admin/projects", user: admin, body: projectRegistrationBody() });
    expect(registered.status).toBe(201);
    await send({ method: "PUT", path: `/v1/admin/slack/bindings/${team}/${channel}`, user: admin, body: { projectName: "payments" } });

    const workspaceResponse = await ensureWorkspace(handler, thread, pratik);
    responses.push(workspaceResponse);
    const workspaceId = workspaceResponse.body.workspaceId as string;
    markReady(db, workspaceId);
    const path = `/v1/service/workspaces/${workspaceId}/connectors/jira`;

    // Case 3: discover, then a write.
    const discovered = await send({ method: "GET", path: `${path}/tools`, service });
    const catalog = ConnectorCatalogSchema.parse(discovered.body.catalog);
    const hashOf = (name: string) => catalog.tools.find((tool) => tool.name === name)!.scopes.find((scope) => scope.alias === "kan")!.schemaHash;
    await send({ method: "POST", path: `${path}/call`, service,
      body: { requestId: randomUUID(), scope: "kan", tool: "createJiraIssue", schemaHash: hashOf("jira__createJiraIssue"), arguments: { summary: "Flaky login", issueType: "Bug", description: "Fails 1 in 5." } } });

    // Case 4: a search.
    await send({ method: "POST", path: `${path}/call`, service,
      body: { requestId: randomUUID(), scope: "kan", tool: "searchJiraIssuesUsingJql", schemaHash: hashOf("jira__searchJiraIssuesUsingJql"), arguments: { jql: 'status = "To Do" ORDER BY created DESC' } } });

    // Case 5: a refused comment, then an accepted one.
    await send({ method: "POST", path: `${path}/call`, service,
      body: { requestId: randomUUID(), scope: "kan", tool: "addOrEditJiraIssueComment", schemaHash: hashOf("jira__addOrEditJiraIssueComment"), arguments: { issueIdOrKey: "OPS-1", commentBody: "Deploying now." } } });
    await send({ method: "POST", path: `${path}/call`, service,
      body: { requestId: randomUUID(), scope: "kan", tool: "addOrEditJiraIssueComment", schemaHash: hashOf("jira__addOrEditJiraIssueComment"), arguments: { issueIdOrKey: "KAN-1", commentBody: "Deploying now." } } });

    // Case 6: a model-supplied cloudId, refused.
    await send({ method: "POST", path: `${path}/call`, service,
      body: { requestId: randomUUID(), scope: "kan", tool: "getJiraIssue", schemaHash: hashOf("jira__getJiraIssue"), arguments: { issueIdOrKey: "KAN-1", cloudId: "attacker-supplied" } } });

    expect(JSON.stringify(responses)).not.toContain(TOKEN);
    expect(logLines().join("\n")).not.toContain(TOKEN);
    expect(fake.authorizations.length).toBeGreaterThan(0);
  });
});
