import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { githubConnectorType, type ConnectorType } from "../../packages/broker/src/aws/connector-types.js";
import { ConnectorCatalogSchema } from "../../packages/contracts/src/connectors.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { call, createBroker, ensureWorkspace, loadSlackBroker, markReady, orchestratorPrincipal, type Handler } from "../support/slack-broker.js";
import { TRACKER_ENDPOINT, trackerConnectorType } from "../support/tracker-connector.js";

const team = "T0BSHLLUGBD";
const channel = "C0123456789";
const thread = `${team}/${channel}/1695500000.000001`;
const pratik = "U0123456789";
const admin = { subject: "admin-subject", admin: true };
const service = { principal: orchestratorPrincipal, thread, slackUser: pratik };
const TRACKER_KEY = "tracker-api-key-value";
const trackerConfig = {
  name: "tracker", type: "tracker", credentialRef: "tracker-key",
  scopes: [{ alias: "payments", siteId: "site-payments-1" }, { alias: "billing", siteId: "site-billing-2" }],
  tools: [{ name: "list_items", access: "read" }, { name: "create_item", access: "write" }],
};

beforeAll(async () => {
  await loadSlackBroker();
});

let log: MockInstance<typeof console.log>;
beforeEach(() => { log = vi.spyOn(console, "log").mockImplementation(() => undefined); });
afterEach(() => { log.mockRestore(); });

const logLines = () => log.mock.calls.map(([line]) => String(line));

/** A broker serving github and the test-only tracker type, with a project whose latest revision configures both. */
async function trackerBroker() {
  const invoke = vi.fn(async () => ({ content: [{ type: "text", text: "tracker result" }] }));
  const connect = vi.fn<(input: { endpoint: URL; token: string; tools: string[]; signal: AbortSignal }) => Promise<unknown>>(async () => ({
    tools: [
      { name: "list_items", description: "List items on a site", inputSchema: { type: "object", properties: {
        siteId: { type: "string" }, status: { type: "string" },
      }, required: ["siteId"] } },
      { name: "create_item", description: "Create an item on a site", inputSchema: { type: "object", properties: {
        siteId: { type: "string" }, title: { type: "string" }, body: { type: "string" },
      }, required: ["siteId", "title"] } },
      { name: "delete_item", description: "Delete an item", inputSchema: { type: "object", properties: {
        siteId: { type: "string" }, id: { type: "string" },
      }, required: ["siteId", "id"] } },
    ],
    call: invoke,
    close: async () => undefined,
  }));
  // The tracker type has no deployment connect; the test injects its fake into each resolution.
  const tracker: ConnectorType = {
    type: "tracker",
    resolve(config, project, context) {
      const resolved = trackerConnectorType.resolve(config, project, context);
      return "unusable" in resolved ? resolved : { ...resolved, connect: connect as never };
    },
  };
  const secrets = { read: vi.fn(async (name: string) => name === "agentx/connectors/tracker-key" ? JSON.stringify({ apiKey: TRACKER_KEY }) : undefined) };
  const githubConnect = vi.fn();
  const { db, handler } = createBroker({
    githubMcp: { credentials: vi.fn(async () => ({ owner: "example", repo: "demo", token: "installation-secret" })), connect: githubConnect },
    connectorTypes: { github: githubConnectorType, tracker },
    connectorCredentials: { secrets, githubApp: { ref: "github-app", secretName: "agentx/connectors/github-app" } },
  });
  await registerAndBind(handler);
  const workspaceId = (await ensureWorkspace(handler, thread, pratik)).body.workspaceId as string;
  markReady(db, workspaceId);
  seedTracker(db);
  return { db, handler, workspaceId, connect, invoke, githubConnect, path: `/v1/service/workspaces/${workspaceId}/connectors/tracker` };
}

async function registerAndBind(handler: Handler): Promise<void> {
  const registered = await call(handler, { method: "POST", path: "/v1/admin/projects", user: admin, body: {
    definition: {
      name: "payments", revision: 1,
      repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
      setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
      integrations: { connectors: [{ name: "github", type: "github", scopes: "all-repositories", tools: [{ name: "list_issues", access: "read" }] }] },
    },
    runtimeBinding: {
      runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/agentx_production_worker-YVirjlFgvk",
      endpointQualifier: "DEFAULT", deploymentMode: "instances-ebs",
      capacityProviderArn: "arn:aws:bedrock-agentcore:us-east-1:111122223333:capacity-provider/agentx_production_capacity_v3-VwkM93EABZ",
    },
  } });
  expect(registered.status).toBe(201);
  expect((await call(handler, { method: "PUT", path: `/v1/admin/slack/bindings/${team}/${channel}`, user: admin, body: { projectName: "payments" } })).status).toBe(200);
}

/** No production type accepts `tracker` yet, so the stored revision is edited directly; routes do not re-parse it. */
function seedTracker(db: FakeDynamoDb): void {
  const [revision] = db.find((item) => item.pk === "PROJECT#payments" && String(item.sk).startsWith("REV#"));
  if (!revision) throw new Error("project revision is missing");
  const definition = revision.definition as { integrations: { connectors: unknown[] } };
  definition.integrations.connectors.push(trackerConfig);
}

function registerTrackerKey(handler: Handler) {
  return call(handler, { method: "POST", path: "/v1/admin/credentials", user: admin,
    body: { ref: "tracker-key", type: "static-secret", secretName: "agentx/connectors/tracker-key" } });
}

describe("legacy GitHub route", () => {
  it("says the github type is unavailable, not that GitHub MCP is disabled, when this deployment cannot resolve a configured github connector", async () => {
    const { db, handler } = createBroker({
      githubMcp: { credentials: vi.fn(), connect: vi.fn() },
      connectorTypes: { tracker: trackerConnectorType },
    });
    await registerAndBind(handler);
    const workspaceId = (await ensureWorkspace(handler, thread, pratik)).body.workspaceId as string;
    markReady(db, workspaceId);
    const response = await call(handler, { method: "GET", path: `/v1/service/workspaces/${workspaceId}/github/tools?repository=demo`, service });
    expect(response.status).toBe(403);
    expect(response.body.error).toEqual({ code: "FORBIDDEN", message: "github connector type is not available in this deployment" });
  });
});

describe("generic connector routes", () => {
  it("answers not connected, and says why in one log line, while the tracker's credential is unregistered", async () => {
    const { handler, path, connect } = await trackerBroker();
    const discovered = await call(handler, { method: "GET", path: `${path}/tools`, service });
    expect(discovered.status).toBe(200);
    expect(discovered.body.catalog).toEqual({ connector: "tracker", notConnected: true, tools: [], skipped: [] });
    const lines = logLines().filter((line) => line.includes("connector.not_connected"));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ component: "broker", event: "connector.not_connected", project: "payments", revision: 1, connector: "tracker" });
    expect(lines[0]).toContain("credential tracker-key is not registered");

    const requestId = randomUUID();
    const called = await call(handler, { method: "POST", path: `${path}/call`, service,
      body: { requestId, scope: "payments", tool: "list_items", schemaHash: "a".repeat(64), arguments: {} } });
    expect(called.status).toBe(200);
    expect(called.body.result).toMatchObject({ requestId, status: "FAILED", reason: "not_connected", replayed: false });
    expect((called.body.result as { text: string }).text).toContain("Tracker issues is not connected");
    // A malformed request is refused the same way whether or not the connector is connected.
    const unapproved = await call(handler, { method: "POST", path: `${path}/call`, service,
      body: { requestId: randomUUID(), scope: "payments", tool: "delete_item", schemaHash: "a".repeat(64), arguments: {} } });
    expect(unapproved.status).toBe(403);
    expect(unapproved.body.error).toMatchObject({ code: "FORBIDDEN" });
    const unknownScope = await call(handler, { method: "POST", path: `${path}/call`, service,
      body: { requestId: randomUUID(), scope: "shipping", tool: "list_items", schemaHash: "a".repeat(64), arguments: {} } });
    expect(unknownScope.status).toBe(404);
    expect(unknownScope.body.error).toMatchObject({ code: "NOT_FOUND" });
    expect(connect).not.toHaveBeenCalled();
  });

  it("discovers every site with the registered key, binds the site on a write, signs it and never repeats it", async () => {
    const { db, handler, path, connect, invoke, githubConnect, workspaceId } = await trackerBroker();
    const responses: unknown[] = [];
    const send = async (options: Parameters<typeof call>[1]) => {
      const response = await call(handler, options);
      responses.push(response);
      return response;
    };
    expect((await registerTrackerKey(handler)).status).toBe(201);

    const discovered = await send({ method: "GET", path: `${path}/tools`, service });
    expect(discovered.status).toBe(200);
    const catalog = ConnectorCatalogSchema.parse(discovered.body.catalog);
    expect(catalog.connector).toBe("tracker");
    expect(catalog.tools.map((tool) => tool.name)).toEqual(["tracker__list_items", "tracker__create_item"]);
    const list = catalog.tools.find((tool) => tool.name === "tracker__list_items")!;
    expect((list.inputSchema.properties as Record<string, { enum?: string[] }>).target!.enum).toEqual(["payments", "billing"]);
    expect(list.description).toContain("site");
    expect(connect).toHaveBeenCalledTimes(2);
    for (const [input] of connect.mock.calls) {
      expect(input.token).toBe(TRACKER_KEY);
      expect(input.endpoint.href).toBe(TRACKER_ENDPOINT);
    }
    expect(JSON.stringify(catalog)).not.toContain("siteId");
    expect(githubConnect).not.toHaveBeenCalled();

    const create = catalog.tools.find((tool) => tool.name === "tracker__create_item")!;
    const billing = create.scopes.find((scope) => scope.alias === "billing")!;
    const request = { requestId: randomUUID(), scope: "billing", tool: "create_item", schemaHash: billing.schemaHash, arguments: { title: "Refund", body: "Steps" } };
    const written = await send({ method: "POST", path: `${path}/call`, service, body: request });
    expect(written.body.result).toMatchObject({ requestId: request.requestId, status: "SUCCEEDED", replayed: false });
    expect(invoke).toHaveBeenCalledExactlyOnceWith("create_item", {
      siteId: "site-billing-2", title: "Refund",
      body: expect.stringMatching(/^Steps\n\n—\nRequested by `Slack member U0123456789` via AgentX · https:\/\/slack\.com\/archives\/C0123456789\/p1695500000000001$/) as unknown,
    });
    expect(db.get(`WORKSPACE#${workspaceId}`, `CONNECTOR#tracker#${request.requestId}`)).toMatchObject({
      entityType: "CONNECTOR_INVOCATION", connector: "tracker", repository: "billing", tool: "create_item", requestedBy: { teamId: team, userId: pratik },
    });
    expect(db.get(`WORKSPACE#${workspaceId}`, `GITHUB_MCP#${request.requestId}`)).toBeUndefined();

    const replayed = await send({ method: "POST", path: `${path}/call`, service, body: request });
    expect(replayed.body.result).toMatchObject({ status: "SUCCEEDED", replayed: true });
    expect(invoke).toHaveBeenCalledTimes(1);

    const unapproved = await send({ method: "POST", path: `${path}/call`, service,
      body: { ...request, requestId: randomUUID(), tool: "delete_item", arguments: { id: "1" } } });
    expect(unapproved.status).toBe(403);
    expect(unapproved.body.error).toMatchObject({ code: "FORBIDDEN" });
    const unknownScope = await send({ method: "POST", path: `${path}/call`, service, body: { ...request, requestId: randomUUID(), scope: "shipping" } });
    expect(unknownScope.status).toBe(404);
    expect(unknownScope.body.error).toMatchObject({ code: "NOT_FOUND" });

    expect(JSON.stringify(responses)).not.toContain(TRACKER_KEY);
    expect(logLines().join("\n")).not.toContain(TRACKER_KEY);
    expect(JSON.stringify(db.find((item) => item.entityType === "CONNECTOR_INVOCATION"))).not.toContain(TRACKER_KEY);
  });

  it("still answers connector not found for a name the project does not configure", async () => {
    const { handler, workspaceId } = await trackerBroker();
    const response = await call(handler, { method: "GET", path: `/v1/service/workspaces/${workspaceId}/connectors/linear/tools`, service });
    expect(response.status).toBe(404);
    expect(response.body.error).toMatchObject({ code: "NOT_FOUND", message: "connector not found" });
  });
});
