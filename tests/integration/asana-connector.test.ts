// tests/integration/asana-connector.test.ts
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { ASANA_MCP_ENDPOINT, ASANA_TOKEN_ENDPOINT, connectMcp } from "@agentx/gateway";
import { asanaConnectorType } from "../../packages/broker/src/aws/asana-connector-type.js";
import { githubConnectorType, type ConnectorType } from "../../packages/broker/src/aws/connector-types.js";
import { ConnectorCatalogSchema } from "../../packages/contracts/src/connectors.js";
import { SlackThreadWorkspaceResultSchema } from "../../packages/contracts/src/slack.js";
import { startFakeAsana, type FakeAsana } from "../support/fake-asana.js";
import { memorySecretStore } from "../support/refresh-token-fakes.js";
import { call, createBroker, ensureWorkspace, loadSlackBroker, markReady, orchestratorPrincipal, type Handler } from "../support/slack-broker.js";

const team = "T0BSHLLUGBD";
const channel = "C0123456789";
const thread = `${team}/${channel}/1695500000.000001`;
const pratik = "U0123456789";
const admin = { subject: "admin-subject", admin: true };
const service = { principal: orchestratorPrincipal, thread, slackUser: pratik };

const SECRET = "agentx/connectors/asana-bot";
const CLIENT = { clientId: "1210000000000777", clientSecret: `asana-client-secret-${"s".repeat(24)}` };
const REFRESH = `asana-refresh-original-${"r".repeat(40)}`;
const PROJECT = "1210000000000010";
const OTHER_PROJECT = "1210000000000020";
const TASKS = {
  "1210000000000101": { projects: [PROJECT] },
  "1210000000000201": { projects: [OTHER_PROJECT] },
  "1210000000000301": { projects: [], parent: "1210000000000101" },
};

const asanaConfig = {
  name: "asana", type: "asana", credentialRef: "asana-bot",
  scopes: [{ alias: "payments", projectGid: PROJECT }],
  tools: [
    { name: "search_tasks", access: "read" },
    { name: "get_task", access: "read" },
    { name: "get_tasks", access: "read" },
    { name: "create_tasks", access: "write" },
    { name: "add_comment", access: "write" },
  ],
};

function projectRegistrationBody(): Record<string, unknown> {
  return {
    definition: {
      name: "payments", revision: 1,
      repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
      setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
      integrations: { connectors: [asanaConfig] },
    },
    runtimeBinding: {
      runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/agentx_production_worker-YVirjlFgvk",
      endpointQualifier: "DEFAULT", deploymentMode: "instances-ebs",
      capacityProviderArn: "arn:aws:bedrock-agentcore:us-east-1:111122223333:capacity-provider/agentx_production_capacity_v3-VwkM93EABZ",
    },
    preflight: true,
  };
}

let currentFake: FakeAsana | undefined;

/** A broker serving asana against a fresh fake Asana (token endpoint and MCP server). */
async function setupFake() {
  const fake = await startFakeAsana({ ...CLIENT, refreshToken: REFRESH, tasks: TASKS });
  currentFake = fake;
  const connect: typeof connectMcp = (input) => {
    expect(input.endpoint.href).toBe(ASANA_MCP_ENDPOINT.href);
    return connectMcp({ ...input, endpoint: fake.mcpUrl });
  };
  const asana: ConnectorType = { type: "asana", resolve: (config, project, context) => asanaConnectorType.resolve(config, project, { ...context, connect }) };
  // The registry's token requests go to Asana's token endpoint; here that is the fake's.
  const fetchImplementation: typeof fetch = (url, init) => {
    const href = url instanceof URL ? url.href : typeof url === "string" ? url : url.url;
    expect(href).toBe(ASANA_TOKEN_ENDPOINT.href);
    return fetch(fake.tokenUrl, init);
  };
  const secrets = memorySecretStore({ [SECRET]: JSON.stringify({ ...CLIENT, refreshToken: REFRESH }), "agentx/connectors/asana-key": JSON.stringify({ apiKey: "not-an-asana-credential" }) });
  const { db, handler } = createBroker({
    connectorTypes: { github: githubConnectorType, asana },
    connectorCredentials: { secrets, githubApp: { ref: "github-app", secretName: "agentx/connectors/github-app" }, fetchImplementation },
  });
  return { fake, db, handler, secrets };
}

function registerCredential(handler: Handler, type = "oauth-refresh-token", secretName = SECRET) {
  return call(handler, { method: "POST", path: "/v1/admin/credentials", user: admin, body: { ref: "asana-bot", type, secretName } });
}

async function readyBroker() {
  const setup = await setupFake();
  expect((await registerCredential(setup.handler)).status).toBe(201);
  expect((await call(setup.handler, { method: "POST", path: "/v1/admin/projects", user: admin, body: projectRegistrationBody() })).status).toBe(201);
  expect((await call(setup.handler, { method: "PUT", path: `/v1/admin/slack/bindings/${team}/${channel}`, user: admin, body: { projectName: "payments" } })).status).toBe(200);
  const workspaceId = (await ensureWorkspace(setup.handler, thread, pratik)).body.workspaceId as string;
  markReady(setup.db, workspaceId);
  const path = `/v1/service/workspaces/${workspaceId}/connectors/asana`;
  const discovered = await call(setup.handler, { method: "GET", path: `${path}/tools`, service });
  expect(discovered.status).toBe(200);
  const catalog = ConnectorCatalogSchema.parse(discovered.body.catalog);
  const hashOf = (tool: string) => catalog.tools.find((entry) => entry.name === `asana__${tool}`)!.scopes[0]!.schemaHash;
  const run = (tool: string, args: Record<string, unknown>, requestId: string = randomUUID()) =>
    call(setup.handler, { method: "POST", path: `${path}/call`, service, body: { requestId, scope: "payments", tool, schemaHash: hashOf(tool), arguments: args } });
  return { ...setup, workspaceId, path, catalog, run };
}

beforeAll(async () => { await loadSlackBroker(); });

let log: MockInstance<typeof console.log>;
beforeEach(() => { log = vi.spyOn(console, "log").mockImplementation(() => undefined); });
afterEach(async () => {
  log.mockRestore();
  await currentFake?.close();
  currentFake = undefined;
});

/** Every JSON log line the broker wrote during the test. */
function loggedLines(): Array<Record<string, unknown>> {
  return log.mock.calls.flatMap(([line]) => { try { return [JSON.parse(String(line)) as Record<string, unknown>]; } catch { return []; } });
}
const loggedEvents = () => loggedLines().map((line) => line.event);

const writes = (fake: FakeAsana) => fake.calls.filter((entry) => entry.name === "create_tasks" || entry.name === "add_comment");

describe("asana connector, end to end against a fake Asana", () => {
  it("refuses registration until an oauth-refresh-token credential is registered, then registers with a connected preflight", async () => {
    const { fake, handler } = await setupFake();
    const refused = await call(handler, { method: "POST", path: "/v1/admin/projects", user: admin, body: projectRegistrationBody() });
    expect(refused.body).toMatchObject({ error: { code: "CONFIG_INVALID", message: "connector asana: credential asana-bot is not registered; run agentx admin credential authorize first" } });

    expect((await registerCredential(handler, "static-secret", "agentx/connectors/asana-key")).status).toBe(201);
    const wrongType = await call(handler, { method: "POST", path: "/v1/admin/projects", user: admin, body: projectRegistrationBody() });
    expect(wrongType.body).toMatchObject({ error: { code: "CONFIG_INVALID", message: "connector asana: credential asana-bot is static-secret; an Asana connector needs oauth-refresh-token" } });

    expect((await registerCredential(handler)).status).toBe(201);
    const registered = await call(handler, { method: "POST", path: "/v1/admin/projects", user: admin, body: projectRegistrationBody() });
    expect(registered.status).toBe(201);
    expect(registered.body.preflight).toEqual({ connectors: [{
      name: "asana", status: "connected",
      offered: ["asana__search_tasks", "asana__get_task", "asana__get_tasks", "asana__create_tasks", "asana__add_comment"],
      skipped: [],
    }] });
    expect(fake.refreshes).toEqual([REFRESH]);
    for (const authorization of fake.authorizations) expect(authorization).toMatch(/^Bearer asana-access-1-/);
  });

  it("hides the project arguments, binds the registered project, and signs a comment", async () => {
    const { fake, db, workspaceId, catalog, run } = await readyBroker();
    const properties = (tool: string) => Object.keys(catalog.tools.find((entry) => entry.name === `asana__${tool}`)!.inputSchema.properties as Record<string, unknown>);
    expect(properties("search_tasks")).not.toContain("projects_any");
    expect(properties("create_tasks")).not.toContain("default_project");
    expect(properties("get_tasks")).not.toContain("project");

    expect((await run("search_tasks", { text: "login" })).body.result).toMatchObject({ status: "SUCCEEDED" });
    expect(fake.calls.at(-1)).toEqual({ name: "search_tasks", arguments: { text: "login", projects_any: PROJECT } });
    const requestId = randomUUID();
    expect((await run("create_tasks", { tasks: [{ name: "Flaky login" }] }, requestId)).body.result).toMatchObject({ status: "SUCCEEDED" });
    expect(fake.calls.at(-1)).toEqual({ name: "create_tasks", arguments: { tasks: [{ name: "Flaky login" }], default_project: PROJECT } });
    expect(db.get(`WORKSPACE#${workspaceId}`, `CONNECTOR#asana#${requestId}`)).toMatchObject({ entityType: "CONNECTOR_INVOCATION" });

    expect((await run("add_comment", { task_id: "1210000000000301", text: "Deploying now." })).body.result).toMatchObject({ status: "SUCCEEDED" });
    const comment = fake.calls.at(-1)!;
    expect(comment.name).toBe("add_comment");
    expect(String(comment.arguments.text)).toMatch(/^Deploying now\.\n\n—\nRequested by `Slack member U0123456789` via AgentX · https:\/\/slack\.com\/archives\/C0123456789\/p1695500000000001$/);
  });

  it("refuses a write to another project's task with zero upstream writes", async () => {
    const { fake, run } = await readyBroker();
    const comment = await run("add_comment", { task_id: "1210000000000201", text: "Deploying now." });
    expect(comment.body.result).toMatchObject({ status: "FAILED", reason: "policy_denied", text: "Asana task 1210000000000201 is not in the payments project this connector may use." });
    const create = await run("create_tasks", { tasks: [{ name: "Sub", parent: "1210000000000201" }] });
    expect(create.body.result).toMatchObject({ status: "FAILED", reason: "policy_denied" });
    const moved = await run("get_tasks", { tag: "1210000000000900" });
    expect(moved.body.result).toMatchObject({ status: "FAILED", reason: "policy_denied" });
    expect(writes(fake)).toEqual([]);
  });

  it("refreshes after Asana rejects an expired access token, and the call still succeeds", async () => {
    const { fake, run } = await readyBroker();
    fake.expireAccessTokens();
    expect((await run("get_task", { task_id: "1210000000000101" })).body.result).toMatchObject({ status: "SUCCEEDED" });
    expect(fake.refreshes).toEqual([REFRESH, REFRESH]);
  });

  it("writes a rotated refresh token back to the secret and uses it on the next refresh", async () => {
    const { fake, secrets, run } = await readyBroker();
    fake.rotate = true;
    fake.expireAccessTokens();
    expect((await run("get_task", { task_id: "1210000000000101" })).body.result).toMatchObject({ status: "SUCCEEDED" });
    const saved = (JSON.parse(secrets.values[SECRET]!) as { refreshToken: string }).refreshToken;
    expect(saved).toMatch(/^asana-refresh-rotated-2-/);
    expect(secrets.writes).toHaveLength(1);
    fake.expireAccessTokens();
    expect((await run("get_task", { task_id: "1210000000000101" })).body.result).toMatchObject({ status: "SUCCEEDED" });
    expect(fake.refreshes.slice(-1)).toEqual([saved]);
    expect(loggedEvents()).not.toContain("connector.refresh_token_unsaved");
  });

  it("logs a rotated refresh token it could not save, by reason only, and the call still succeeds", async () => {
    const { fake, secrets, run } = await readyBroker();
    fake.rotate = true;
    secrets.failWrites = 100;
    fake.expireAccessTokens();
    expect((await run("get_task", { task_id: "1210000000000101" })).body.result).toMatchObject({ status: "SUCCEEDED" });
    expect(secrets.writes).toEqual([]);
    const unsaved = loggedLines().filter((line) => line.event === "connector.refresh_token_unsaved");
    expect(unsaved).toEqual([{ component: "broker", event: "connector.refresh_token_unsaved", credential: "asana-bot", reason: "AccessDeniedException" }]);
  });

  it("reports a revoked sign-in as not connected, naming the re-authorize command, and writes nothing", async () => {
    const { fake, run } = await readyBroker();
    fake.revokeRefreshToken();
    fake.expireAccessTokens();
    const result = await run("add_comment", { task_id: "1210000000000101", text: "x" });
    expect(result.body.result).toMatchObject({
      status: "FAILED", reason: "not_connected",
      text: "Asana is not connected for this project: credential asana-bot: the token endpoint refused the refresh token with HTTP 400 (invalid_grant); the bot user must sign in again with agentx admin credential authorize --ref asana-bot. An administrator must fix its credential.",
    });
    expect(writes(fake)).toEqual([]);
  });

  it("reports a token-endpoint outage as a vendor error without telling anyone to sign in again, and writes nothing", async () => {
    const { fake, run } = await readyBroker();
    fake.tokenOutageStatus = 503;
    fake.expireAccessTokens();
    const result = await run("add_comment", { task_id: "1210000000000101", text: "x" });
    expect(result.body.result).toMatchObject({
      status: "FAILED", reason: "vendor_error",
      text: "Asana MCP request failed before any write. Check the bot user's access to the Asana project and MCP availability.",
    });
    expect(JSON.stringify(result.body)).not.toContain("authorize");
    expect(writes(fake)).toEqual([]);
  });

  it("lists asana at thread setup for services that opt in", async () => {
    const { handler } = await readyBroker();
    const response = await call(handler, { method: "POST", path: "/v1/service/threads/workspace", service,
      body: { requestId: randomUUID(), includeConnectors: true, includeAllConnectorTypes: true } });
    const { requestId, ...result } = response.body;
    expect(typeof requestId).toBe("string");
    const parsed = SlackThreadWorkspaceResultSchema.parse(result);
    expect(parsed.outcome === "WORKSPACE" && parsed.connectors).toEqual([{ name: "asana", type: "asana", label: "Asana tasks", scopes: ["payments"], connected: true }]);
  });

  it("never reveals an access token, a refresh token or the client secret in responses or logs", async () => {
    const { fake, secrets, handler, run, catalog } = await readyBroker();
    fake.rotate = true;
    const responses: unknown[] = [catalog];
    fake.expireAccessTokens();
    responses.push((await run("get_task", { task_id: "1210000000000101" })).body);
    responses.push((await run("add_comment", { task_id: "1210000000000201", text: "x" })).body);
    responses.push((await call(handler, { method: "GET", path: "/v1/admin/credentials", user: admin })).body);
    fake.revokeRefreshToken();
    fake.expireAccessTokens();
    responses.push((await run("get_task", { task_id: "1210000000000101" })).body);
    const secretsSeen = [REFRESH, CLIENT.clientSecret, (JSON.parse(secrets.values[SECRET]!) as { refreshToken: string }).refreshToken, "asana-access-"];
    const text = `${JSON.stringify(responses)}\n${log.mock.calls.map(([line]) => String(line)).join("\n")}`;
    for (const value of secretsSeen) expect(text).not.toContain(value);
  });
});
