import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { isAssumedRoleOf } from "../../packages/broker/src/aws/lambda.js";
import { RepositoryGrantService } from "../../packages/broker/src/repository-access.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import type { GitHubMcpDependencies } from "../../packages/broker/src/github-mcp.js";
import { GitHubMcpCatalogSchema, GitHubMcpResultSchema } from "../../packages/contracts/src/github-mcp.js";
import { ConnectorCatalogSchema } from "../../packages/contracts/src/connectors.js";

const issuer = "https://identity.example.test";
const account = "111122223333";
const orchestratorRoleArn = `arn:aws:iam::${account}:role/AgentXSlackOrchestrator-TaskRole`;
const orchestratorPrincipal = `arn:aws:sts::${account}:assumed-role/AgentXSlackOrchestrator-TaskRole/ecs-task-1`;
const team = "T0BSHLLUGBD";
const channel = "C0123456789";
const threadOne = `${team}/${channel}/1695500000.000001`;
const threadTwo = `${team}/${channel}/1695500000.000002`;
const threadThree = `${team}/${channel}/1695500000.000003`;
const pratik = "U0123456789";
const bob = "U0456789012";
const carol = "U0789012345";

type Handler = (event: unknown) => Promise<{ statusCode: number; body: string }>;
let createAwsBrokerHandler: (dependencies: never) => Handler;
let deleteCapacityProviderWorkspaceSession: (
  client: { send(command: unknown): Promise<unknown> },
  input: { capacityProviderArn: string; runtimeSessionId: string },
) => Promise<void>;

beforeAll(async () => {
  Object.assign(process.env, {
    AWS_REGION: "us-east-1",
    STATE_TABLE_NAME: "unused",
    ARTIFACT_BUCKET_NAME: "unused",
    OIDC_ISSUER: issuer,
    CALLBACK_SIGNING_KEY: "c".repeat(64),
    GITHUB_APP_PRIVATE_KEY_SECRET_ARN: `arn:aws:secretsmanager:us-east-1:${account}:secret:test`,
    GITHUB_APP_CREDENTIAL_REF: "github-app",
    GITHUB_APP_ACCOUNT: "example",
    GITHUB_APP_ID: "123",
    GITHUB_APP_INSTALLATION_ID: "456",
  });
  ({ createAwsBrokerHandler, deleteCapacityProviderWorkspaceSession } = await import("../../packages/broker/src/aws/broker.js") as unknown as {
    createAwsBrokerHandler: typeof createAwsBrokerHandler;
    deleteCapacityProviderWorkspaceSession: typeof deleteCapacityProviderWorkspaceSession;
  });
});

function createBroker(options: {
  memberLimit?: number;
  organizationLimit?: number;
  slack?: boolean;
  githubMcp?: GitHubMcpDependencies;
  deleteWorkspaceSession?: () => Promise<void>;
} = {}) {
  const db = new FakeDynamoDb();
  const deleteWorkspaceSession = vi.fn(options.deleteWorkspaceSession ?? (async () => undefined));
  const handler = createAwsBrokerHandler({
    documentClient: db,
    s3: { send: vi.fn() },
    stopRuntimeSession: vi.fn(),
    deleteWorkspaceSession,
    tableName: "state",
    artifactBucketName: "artifacts",
    issuer,
    adminClaim: "groups",
    adminValues: ["admins"],
    callbackSigningKey: "c".repeat(64),
    repositoryGrants: new RepositoryGrantService(Buffer.alloc(32, 4), async () => ({ token: "unused" })),
    githubPullRequests: { reconcilePullRequest: vi.fn(), getPullRequest: vi.fn(), updatePullRequest: vi.fn() },
    codeBuild: { start: vi.fn(), status: vi.fn() },
    ...(options.githubMcp ? { githubMcp: options.githubMcp } : {}),
    ...(options.slack === false
      ? {}
      : {
          slack: {
            orchestratorRoleArn,
            memberWorkspaceLimit: options.memberLimit ?? 3,
            organizationWorkspaceLimit: options.organizationLimit ?? 20,
          },
        }),
  } as never);
  return { db, handler, deleteWorkspaceSession };
}

interface CallOptions {
  method: string;
  path: string;
  body?: unknown;
  user?: { subject: string; admin?: boolean };
  service?: { principal?: string; thread?: string; slackUser?: string };
  headers?: Record<string, string>;
}

async function call(handler: Handler, options: CallOptions): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.service?.thread !== undefined) headers["x-agentx-slack-thread"] = options.service.thread;
  if (options.service?.slackUser !== undefined) headers["x-agentx-slack-user"] = options.service.slackUser;
  const authorizer = options.user
    ? { jwt: { claims: { iss: issuer, sub: options.user.subject, groups: options.user.admin ? ["admins"] : [] } } }
    : options.service?.principal
      ? { iam: { userArn: options.service.principal } }
      : undefined;
  const response = await handler({
    version: "2.0",
    rawPath: options.path.split("?")[0],
    rawQueryString: options.path.split("?")[1] ?? "",
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    requestContext: { requestId: randomUUID(), http: { method: options.method }, ...(authorizer ? { authorizer } : {}) },
  });
  return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
}

const admin = { subject: "admin-subject", admin: true };

async function registerProjectAndBind(handler: Handler, integrations: boolean | Record<string, unknown> = false, extraRepositories: string[] = []): Promise<void> {
  await registerRevision(handler, 1, integrations, extraRepositories);
  const bound = await call(handler, {
    method: "PUT",
    path: `/v1/admin/slack/bindings/${team}/${channel}`,
    user: admin,
    body: { projectName: "payments" },
  });
  expect(bound.status).toBe(200);
}

async function registerRevision(handler: Handler, revision: number, integrations: boolean | Record<string, unknown> = false, extraRepositories: string[] = []): Promise<void> {
  const registered = await call(handler, {
    method: "POST",
    path: "/v1/admin/projects",
    user: admin,
    body: {
      definition: {
        name: "payments",
        revision,
        repositories: [
          { name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" },
          ...extraRepositories.map((name) => ({ name, url: `https://github.com/example/${name}.git`, path: `repo/${name}`, defaultBranch: "main", credentialRef: "github-app" })),
        ],
        setup: [],
        readiness: [],
        orchestratorInstructions: `Delegate work (revision ${revision}).`,
        ...(integrations === true
          ? { integrations: { githubMcp: { tools: [{ name: "issue_write", access: "write" }, { name: "list_issues", access: "read" }] } } }
          : integrations ? { integrations } : {}),
      },
      runtimeBinding: {
        runtimeArn: `arn:aws:bedrock-agentcore:us-east-1:${account}:runtime/agentx_production_worker-YVirjlFgvk`,
        endpointQualifier: "DEFAULT",
        deploymentMode: "instances-ebs",
        capacityProviderArn: `arn:aws:bedrock-agentcore:us-east-1:${account}:capacity-provider/agentx_production_capacity_v3-VwkM93EABZ`,
      },
    },
  });
  expect(registered.status).toBe(201);
}

function ensureWorkspace(handler: Handler, thread: string, slackUser: string, requestId = randomUUID()) {
  return call(handler, {
    method: "POST",
    path: "/v1/service/threads/workspace",
    service: { principal: orchestratorPrincipal, thread, slackUser },
    body: { requestId, includeIntegrations: true, includeSettingsRevision: true },
  });
}

function startClose(handler: Handler, thread: string, slackUser: string, requestId = randomUUID()) {
  return call(handler, {
    method: "POST",
    path: "/v1/service/threads/workspace/close",
    service: { principal: orchestratorPrincipal, thread, slackUser },
    body: { requestId },
  });
}

function completeClose(handler: Handler, thread: string, slackUser: string, operationId: string) {
  return call(handler, {
    method: "POST",
    path: "/v1/service/threads/workspace/close/complete",
    service: { principal: orchestratorPrincipal, thread, slackUser },
    body: { requestId: randomUUID(), operationId },
  });
}

async function finishClosePreflight(
  handler: Handler,
  db: FakeDynamoDb,
  workspaceId: string,
  operationId: string,
  result: { safeToClose: boolean; repositories: Array<{ name: string; reasons: string[] }> },
): Promise<void> {
  const outbox = db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0];
  const invocation = outbox?.invocation as { callbackCapability?: string } | undefined;
  if (!invocation?.callbackCapability) throw new Error("close callback capability is missing");
  const response = await call(handler, {
    method: "POST",
    path: `/v1/internal/workspaces/${workspaceId}/operations/${operationId}/result`,
    headers: { "x-agentx-callback-capability": invocation.callbackCapability },
    body: { operationId, status: "SUCCEEDED", result },
  });
  expect(response.status).toBe(200);
}

function invocationOf(db: FakeDynamoDb, operationId: string) {
  const outbox = db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0];
  if (!outbox) throw new Error("outbox record is missing");
  return outbox.invocation as { callbackCapability: string; payload: Record<string, unknown> };
}

function markReady(db: FakeDynamoDb, workspaceId: string): void {
  const workspace = db.get(`WORKSPACE#${workspaceId}`, "META");
  if (!workspace) throw new Error("workspace record is missing");
  // Mirrors the broker's terminal transition, which removes activeOperationId rather than nulling it.
  workspace.status = "READY";
  delete workspace.activeOperationId;
}

describe("hosted Slack GitHub MCP", () => {
  it("keeps long non-Latin names, renders every name as an inert code span, and never signs a GitHub description", async () => {
    const credentials = vi.fn(async () => ({ owner: "example", repo: "demo", token: "installation-secret" }));
    const invoke = vi.fn(async () => ({ content: [{ type: "text", text: "created" }] }));
    const connect = vi.fn(async () => ({
      tools: [{ name: "issue_write", description: "Create an issue", inputSchema: { type: "object", properties: {
        owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" }, body: { type: "string" }, description: { type: "string" },
      }, required: ["owner", "repo", "title"] } }], call: invoke, close: async () => undefined,
    }));
    const { db, handler } = createBroker({ githubMcp: { credentials, connect } });
    await registerProjectAndBind(handler, { connectors: [{ name: "github", type: "github", scopes: "all-repositories", tools: [{ name: "issue_write", access: "write" }] }] });
    const workspaceId = (await ensureWorkspace(handler, threadOne, pratik)).body.workspaceId as string;
    markReady(db, workspaceId);
    const service = { principal: orchestratorPrincipal, thread: threadOne, slackUser: pratik };
    const path = `/v1/service/workspaces/${workspaceId}/connectors/github`;
    const catalog = ConnectorCatalogSchema.parse((await call(handler, { method: "GET", path: `${path}/tools`, service })).body.catalog);
    const schemaHash = catalog.tools[0]!.scopes[0]!.schemaHash;
    const write = (args: Record<string, unknown>, name: string) => call(handler, { method: "POST", path: `${path}/call`, service,
      headers: { "x-agentx-slack-user-name": encodeURIComponent(name) },
      body: { requestId: randomUUID(), scope: "demo", tool: "issue_write", schemaHash, arguments: args } });
    const threadUrl = `https://slack.com/archives/${threadOne.split("/")[1]}/p${threadOne.split("/")[2]!.replace(".", "")}`;
    await write({ title: "Bug", body: "Steps" }, "क".repeat(80));
    expect(invoke).toHaveBeenLastCalledWith("issue_write", expect.objectContaining({ body: `Steps\n\n—\nRequested by \`${"क".repeat(80)}\` via AgentX · ${threadUrl}` }));
    // Each name is rendered only inside a code span, so GitHub shows it literally: no mention,
    // link, autolink, HTML or issue reference. The fence is one backtick longer than the name's
    // longest backtick run, padded with a space when the name starts or ends with a backtick.
    const signed: Array<[string, string]> = [
      ["@org/security [x](https://e.test) `code`", "`` @org/security [x](https://e.test) `code` ``"],
      ["https://evil.example/login www.evil.example", "`https://evil.example/login www.evil.example`"],
      ["fixes #1 and GH-2", "`fixes #1 and GH-2`"],
      ["<img src=\"https://t.example/p.gif\"> Bob", "`<img src=\"https://t.example/p.gif\"> Bob`"],
      ["a``b`c", "```a``b`c```"],
      ["`lead", "`` `lead ``"],
    ];
    for (const [name, span] of signed) {
      await write({ title: "Bug", body: "Steps" }, name);
      expect(invoke).toHaveBeenLastCalledWith("issue_write", expect.objectContaining({ body: `Steps\n\n—\nRequested by ${span} via AgentX · ${threadUrl}` }));
    }
    await write({ title: "Label", description: "Short" }, "Pratik Singhal");
    expect(invoke).toHaveBeenLastCalledWith("issue_write", { owner: "example", repo: "demo", title: "Label", description: "Short" });
  });

  it("signs connector writes with the requesting member and thread, unless the connector turns it off", async () => {
    const credentials = vi.fn(async () => ({ owner: "example", repo: "demo", token: "installation-secret" }));
    const invoke = vi.fn(async () => ({ content: [{ type: "text", text: "created" }] }));
    const connect = vi.fn(async () => ({
      tools: [{ name: "issue_write", description: "Create an issue", inputSchema: { type: "object", properties: {
        owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" }, body: { type: "string" },
      }, required: ["owner", "repo", "title"] } }], call: invoke, close: async () => undefined,
    }));
    const { db, handler } = createBroker({ githubMcp: { credentials, connect } });
    const connector = { name: "github", type: "github", scopes: "all-repositories", tools: [{ name: "issue_write", access: "write" }] };
    await registerProjectAndBind(handler, { connectors: [connector] });
    const workspaceId = (await ensureWorkspace(handler, threadOne, pratik)).body.workspaceId as string;
    markReady(db, workspaceId);
    const service = { principal: orchestratorPrincipal, thread: threadOne, slackUser: pratik };
    const path = `/v1/service/workspaces/${workspaceId}/connectors/github`;
    const catalog = ConnectorCatalogSchema.parse((await call(handler, { method: "GET", path: `${path}/tools`, service })).body.catalog);
    const schemaHash = catalog.tools[0]!.scopes[0]!.schemaHash;
    const write = (headers: Record<string, string> = {}) => call(handler, { method: "POST", path: `${path}/call`, service, headers,
      body: { requestId: randomUUID(), scope: "demo", tool: "issue_write", schemaHash, arguments: { title: "Bug", body: "Steps" } } });
    const threadUrl = `https://slack.com/archives/${threadOne.split("/")[1]}/p${threadOne.split("/")[2]!.replace(".", "")}`;
    await write({ "x-agentx-slack-user-name": encodeURIComponent("Pratik Singhal") });
    expect(invoke).toHaveBeenLastCalledWith("issue_write", expect.objectContaining({ body: `Steps\n\n—\nRequested by \`Pratik Singhal\` via AgentX · ${threadUrl}` }));
    await write();
    expect(invoke).toHaveBeenLastCalledWith("issue_write", expect.objectContaining({ body: `Steps\n\n—\nRequested by \`Slack member ${pratik}\` via AgentX · ${threadUrl}` }));
    await write({ "x-agentx-slack-user-name": encodeURIComponent("Evil\u0007Name") });
    expect(invoke).toHaveBeenLastCalledWith("issue_write", expect.objectContaining({ body: `Steps\n\n—\nRequested by \`Evil Name\` via AgentX · ${threadUrl}` }));
    await registerRevision(handler, 2, { connectors: [{ ...connector, attribution: false }] });
    const catalogOff = ConnectorCatalogSchema.parse((await call(handler, { method: "GET", path: `${path}/tools`, service })).body.catalog);
    await call(handler, { method: "POST", path: `${path}/call`, service,
      body: { requestId: randomUUID(), scope: "demo", tool: "issue_write", schemaHash: catalogOff.tools[0]!.scopes[0]!.schemaHash, arguments: { title: "Bug", body: "Steps" } } });
    expect(invoke).toHaveBeenLastCalledWith("issue_write", expect.objectContaining({ body: "Steps" }));
  });

  it("removes a repository from an existing thread when a revision narrows the connector's scopes", async () => {
    const credentials = vi.fn(async () => ({ owner: "example", repo: "docs", token: "installation-secret" }));
    const invoke = vi.fn(async () => ({ content: [{ type: "text", text: "GitHub result" }] }));
    const connect = vi.fn(async () => ({
      tools: [{ name: "list_issues", description: "Native list_issues", inputSchema: {
        type: "object", properties: { owner: { type: "string" }, repo: { type: "string" } }, required: ["owner", "repo"],
      } }], call: invoke, close: async () => undefined,
    }));
    const { db, handler } = createBroker({ githubMcp: { credentials, connect } });
    const tools = [{ name: "list_issues", access: "read" }];
    await registerProjectAndBind(handler, { connectors: [{ name: "github", type: "github", scopes: "all-repositories", tools }] }, ["docs"]);
    const resolved = await ensureWorkspace(handler, threadOne, pratik);
    expect(resolved.body.githubMcpRepositories).toEqual(["demo", "docs"]);
    const workspaceId = resolved.body.workspaceId as string;
    markReady(db, workspaceId);
    const service = { principal: orchestratorPrincipal, thread: threadOne, slackUser: pratik };
    const path = `/v1/service/workspaces/${workspaceId}/github`;
    const before = await call(handler, { method: "GET", path: `${path}/tools?repository=docs`, service });
    expect(before.status).toBe(200);
    const tool = GitHubMcpCatalogSchema.parse(before.body.catalog).tools[0]!;
    await registerRevision(handler, 2, { connectors: [{ name: "github", type: "github", scopes: ["demo"], tools }] }, ["docs"]);
    expect((await ensureWorkspace(handler, threadOne, pratik)).body.githubMcpRepositories).toEqual(["demo"]);
    expect((await call(handler, { method: "GET", path: `${path}/tools?repository=docs`, service })).status).toBe(404);
    const removed = { requestId: randomUUID(), repository: "docs", tool: "list_issues", schemaHash: tool.schemaHash, arguments: {} };
    expect((await call(handler, { method: "POST", path: `${path}/call`, service, body: removed })).status).toBe(404);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("logs the approved tools it cannot offer, without secrets", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const credentials = vi.fn(async () => ({ owner: "example", repo: "demo", token: "installation-secret" }));
      const connect = vi.fn(async () => ({
        tools: [{ name: "list_issues", description: "No routing", inputSchema: { type: "object", properties: {} } }],
        call: vi.fn(), close: async () => undefined,
      }));
      const { db, handler } = createBroker({ githubMcp: { credentials, connect } });
      await registerProjectAndBind(handler, { connectors: [{ name: "github", type: "github", scopes: "all-repositories", tools: [
        { name: "list_issues", access: "read" }, { name: "issue_write", access: "write" },
      ] }] });
      const workspaceId = (await ensureWorkspace(handler, threadOne, pratik)).body.workspaceId as string;
      markReady(db, workspaceId);
      const service = { principal: orchestratorPrincipal, thread: threadOne, slackUser: pratik };
      const catalog = await call(handler, { method: "GET", path: `/v1/service/workspaces/${workspaceId}/github/tools?repository=demo`, service });
      expect(catalog.status).toBe(200);
      expect(catalog.body.catalog).toEqual({ tools: [] });
      const lines = log.mock.calls.map(([line]) => String(line)).filter((line) => line.includes("connector.tools_skipped"));
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toEqual({
        component: "broker", event: "connector.tools_skipped", project: "payments", revision: 1, connector: "github", scope: "demo",
        skipped: [{ tool: "issue_write", reason: "not offered by the vendor" }, { tool: "list_issues", reason: "missing server-bound property owner" }],
      });
      expect(lines[0]).not.toContain("installation-secret");
    } finally { log.mockRestore(); }
  });

  it("serves a github connector declared in integrations.connectors", async () => {
    const credentials = vi.fn(async () => ({ owner: "example", repo: "demo", token: "installation-secret" }));
    const invoke = vi.fn(async () => ({ content: [{ type: "text", text: "GitHub result" }] }));
    const connect = vi.fn(async () => ({
      tools: [{ name: "list_issues", description: "Native list_issues", inputSchema: {
        type: "object", properties: { owner: { type: "string" }, repo: { type: "string" } }, required: ["owner", "repo"],
      } }], call: invoke, close: async () => undefined,
    }));
    const { db, handler } = createBroker({ githubMcp: { credentials, connect } });
    await registerProjectAndBind(handler, { connectors: [{ name: "github", type: "github", scopes: ["demo"], tools: [{ name: "list_issues", access: "read" }] }] });
    const resolved = await ensureWorkspace(handler, threadOne, pratik);
    expect(resolved.body.githubMcpRepositories).toEqual(["demo"]);
    const workspaceId = resolved.body.workspaceId as string;
    markReady(db, workspaceId);
    const service = { principal: orchestratorPrincipal, thread: threadOne, slackUser: pratik };
    const path = `/v1/service/workspaces/${workspaceId}/github`;
    const catalog = await call(handler, { method: "GET", path: `${path}/tools?repository=demo`, service });
    const tool = GitHubMcpCatalogSchema.parse(catalog.body.catalog).tools[0]!;
    const request = { requestId: randomUUID(), repository: "demo", tool: "list_issues", schemaHash: tool.schemaHash, arguments: {} };
    expect((await call(handler, { method: "POST", path: `${path}/call`, service, body: request })).body.result).toMatchObject({ status: "SUCCEEDED" });
    expect(db.get(`WORKSPACE#${workspaceId}`, `GITHUB_MCP#${request.requestId}`)).toMatchObject({ connector: "github" });
  });

  it("reuses a revision's discovered catalog and rediscovers after a new revision or a vendor schema change", async () => {
    const credentials = vi.fn(async () => ({ owner: "example", repo: "demo", token: "installation-secret" }));
    const invoke = vi.fn(async () => ({ content: [{ type: "text", text: "GitHub result" }] }));
    let description = "Native list_issues";
    const connect = vi.fn(async () => ({
      tools: [{ name: "list_issues", description, inputSchema: {
        type: "object", properties: { owner: { type: "string" }, repo: { type: "string" } }, required: ["owner", "repo"],
      } }], call: invoke, close: async () => undefined,
    }));
    const { db, handler } = createBroker({ githubMcp: { credentials, connect } });
    const integrations = { connectors: [{ name: "github", type: "github", scopes: "all-repositories", tools: [{ name: "list_issues", access: "read" }] }] };
    await registerProjectAndBind(handler, integrations);
    const workspaceId = (await ensureWorkspace(handler, threadOne, pratik)).body.workspaceId as string;
    markReady(db, workspaceId);
    const service = { principal: orchestratorPrincipal, thread: threadOne, slackUser: pratik };
    const path = `/v1/service/workspaces/${workspaceId}/github`;
    const discover = () => call(handler, { method: "GET", path: `${path}/tools?repository=demo`, service });
    const first = await discover();
    await discover();
    expect(connect).toHaveBeenCalledTimes(1);
    await registerRevision(handler, 2, integrations);
    await discover();
    expect(connect).toHaveBeenCalledTimes(2);
    invoke.mockResolvedValueOnce({ isError: true, content: [{ type: "text", text: "upstream failure" }] } as never);
    const tool = GitHubMcpCatalogSchema.parse(first.body.catalog).tools[0]!;
    const failed = await call(handler, { method: "POST", path: `${path}/call`, service, body: { requestId: randomUUID(), repository: "demo", tool: "list_issues", schemaHash: tool.schemaHash, arguments: {} } });
    expect(failed.body.result).toMatchObject({ status: "FAILED" });
    // A vendor error is not a definition change, so the cached catalog stays.
    const callsAfterFailure = connect.mock.calls.length;
    await discover();
    expect(connect).toHaveBeenCalledTimes(callsAfterFailure);
    // A changed vendor definition fails the call and forces the next discovery to the vendor.
    description = "Changed list_issues";
    const changed = await call(handler, { method: "POST", path: `${path}/call`, service, body: { requestId: randomUUID(), repository: "demo", tool: "list_issues", schemaHash: tool.schemaHash, arguments: {} } });
    expect(changed.body.result).toMatchObject({ status: "FAILED" });
    expect((changed.body.result as { text: string }).text).toContain("definition changed");
    const callsAfterChange = connect.mock.calls.length;
    await discover();
    expect(connect).toHaveBeenCalledTimes(callsAfterChange + 1);
  });

  it("discovers and executes within the thread, audits the requester and never repeats a write", async () => {
    const credentials = vi.fn(async () => ({ owner: "example", repo: "demo", token: "installation-secret" }));
    const invoke = vi.fn(async () => ({ content: [{ type: "text", text: "GitHub result" }] }));
    const connect = vi.fn(async () => ({
      tools: ["issue_write", "list_issues"].map((name) => ({ name, description: `Native ${name}`, inputSchema: {
        type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" } }, required: ["owner", "repo"],
      } })), call: invoke, close: async () => undefined,
    }));
    const { db, handler } = createBroker({ githubMcp: { credentials, connect } });
    await registerProjectAndBind(handler, true);
    const resolved = await ensureWorkspace(handler, threadOne, pratik);
    expect(resolved.body.githubMcpRepositories).toEqual(["demo"]);
    const legacy = await call(handler, { method: "POST", path: "/v1/service/threads/workspace",
      service: { principal: orchestratorPrincipal, thread: threadOne, slackUser: pratik }, body: { requestId: randomUUID() },
    });
    expect(legacy.status).toBe(200);
    expect(legacy.body.githubMcpRepositories).toBeUndefined();
    const workspaceId = resolved.body.workspaceId as string;
    markReady(db, workspaceId);
    const service = { principal: orchestratorPrincipal, thread: threadOne, slackUser: pratik };
    const path = `/v1/service/workspaces/${workspaceId}/github`;
    const catalog = await call(handler, { method: "GET", path: `${path}/tools?repository=demo`, service });
    expect(catalog.status).toBe(200);
    const tools = GitHubMcpCatalogSchema.parse(catalog.body.catalog).tools;
    const request = { requestId: randomUUID(), repository: "demo", tool: "issue_write", schemaHash: tools[0]!.schemaHash, arguments: { title: "From Slack" } };
    const first = await call(handler, { method: "POST", path: `${path}/call`, service, body: request });
    expect(first.body.result).toMatchObject({ status: "SUCCEEDED", replayed: false });
    expect((await call(handler, { method: "POST", path: `${path}/call`, service, body: request })).body.result).toMatchObject({ status: "SUCCEEDED", replayed: true });
    expect(invoke).toHaveBeenCalledExactlyOnceWith("issue_write", { owner: "example", repo: "demo", title: "From Slack" });
    expect(db.get(`WORKSPACE#${workspaceId}`, `GITHUB_MCP#${request.requestId}`)).toMatchObject({ requestedBy: { teamId: team, userId: pratik } });
    const read = { ...request, requestId: randomUUID(), tool: "list_issues", schemaHash: tools[1]!.schemaHash, arguments: {} };
    expect((await call(handler, { method: "POST", path: `${path}/call`, service, body: read })).body.result).toMatchObject({ status: "SUCCEEDED" });
    expect(db.get(`WORKSPACE#${workspaceId}`, `GITHUB_MCP#${read.requestId}`)).toMatchObject({ requestedBy: { teamId: team, userId: pratik } });
    const bobRead = { ...read, requestId: randomUUID() };
    expect((await call(handler, { method: "POST", path: `${path}/call`, service: { ...service, slackUser: bob }, body: bobRead })).body.result).toMatchObject({ status: "SUCCEEDED" });
    expect(db.get(`WORKSPACE#${workspaceId}`, `GITHUB_MCP#${bobRead.requestId}`)).toMatchObject({ requestedBy: { teamId: team, userId: bob } });
    expect(JSON.stringify(db.find((item) => item.entityType === "GITHUB_MCP_INVOCATION"))).not.toContain("installation-secret");
    expect(db.find((item) => item.entityType === "OPERATION" && item.kind !== "prepare")).toHaveLength(0);

    const callsBefore = credentials.mock.calls.length;
    expect((await call(handler, { method: "GET", path: `${path}/tools?repository=demo`, service: { ...service, thread: threadTwo } })).status).toBe(404);
    expect((await call(handler, { method: "GET", path: `${path}/tools?repository=demo`, service: { ...service, principal: `arn:aws:sts::${account}:assumed-role/OtherRole/session` } })).status).toBe(403);
    // An administrator login reaches no workspace route: the OIDC entry point serves administration only.
    expect((await call(handler, { method: "GET", path: `/v1/workspaces/${workspaceId}/github/tools?repository=demo`, user: admin })).status).toBe(403);
    expect((await call(handler, { method: "POST", path: `${path}/call`, service: { ...service, slackUser: bob }, body: request })).status).toBe(404);
    expect((await call(handler, { method: "GET", path: `${path}/tools?repository=unknown`, service })).status).toBe(404);
    expect((await call(handler, { method: "GET", path: `${path}/tools?repository=demo`, service: { ...service, thread: `${team}/C0999999999/1695500000.000001` } })).status).toBe(403);
    const owner = db.get(`WORKSPACE#${workspaceId}`, "META")!.ownerKey as string;
    const membership = db.get(`MEMBER#${owner}`, "PROJECT#payments")!;
    db.items.delete(`MEMBER#${owner}\u0000PROJECT#payments`);
    expect((await call(handler, { method: "GET", path: `${path}/tools?repository=demo`, service })).status).toBe(404);
    db.set(membership);
    const binding = db.get(`SLACK_BINDING#${team}`, `CHANNEL#${channel}`)!;
    binding.projectName = "another-project";
    expect((await call(handler, { method: "GET", path: `${path}/tools?repository=demo`, service })).status).toBe(403);
    expect(credentials).toHaveBeenCalledTimes(callsBefore);
  });

  it("follows the latest revision's MCP policy in an existing thread, both ways", async () => {
    const credentials = vi.fn();
    const { db, handler } = createBroker({ githubMcp: { credentials } });
    await registerProjectAndBind(handler);
    const resolved = await ensureWorkspace(handler, threadOne, pratik);
    expect(resolved.body.githubMcpRepositories).toBeUndefined();
    const workspaceId = resolved.body.workspaceId as string;
    markReady(db, workspaceId);
    const service = { principal: orchestratorPrincipal, thread: threadOne, slackUser: pratik };
    const tools = () => call(handler, {
      method: "GET",
      path: `/v1/service/workspaces/${workspaceId}/github/tools?repository=demo`,
      service,
    });
    expect((await tools()).status).toBe(403);

    // Registering a revision that adds the policy reaches this existing thread's next turn.
    await registerRevision(handler, 2, true);
    const enabled = await ensureWorkspace(handler, threadOne, pratik);
    expect(enabled.body).toMatchObject({ githubMcpRepositories: ["demo"], settingsRevision: 2 });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ projectRevision: 1 });

    // Registering a revision that removes it revokes the tools from the same thread.
    await registerRevision(handler, 3);
    const revoked = await ensureWorkspace(handler, threadOne, pratik);
    expect(revoked.body.githubMcpRepositories).toBeUndefined();
    expect(revoked.body.settingsRevision).toBe(3);
    expect((await tools()).status).toBe(403);
    expect(credentials).not.toHaveBeenCalled();
  });

  it("presents a multi-repository github connector once and calls the chosen target", async () => {
    const credentials = vi.fn(async (repository: { url: string }) => ({ owner: "example", repo: repository.url.includes("docs") ? "docs" : "demo", token: "installation-secret" }));
    const invoke = vi.fn(async () => ({ content: [{ type: "text", text: "GitHub result" }] }));
    const connect = vi.fn(async () => ({
      tools: [{ name: "list_issues", description: "Native list_issues", inputSchema: {
        type: "object", properties: { owner: { type: "string" }, repo: { type: "string" } }, required: ["owner", "repo"],
      } }], call: invoke, close: async () => undefined,
    }));
    const { db, handler } = createBroker({ githubMcp: { credentials, connect } });
    await registerProjectAndBind(handler, { connectors: [{ name: "github", type: "github", scopes: "all-repositories", tools: [{ name: "list_issues", access: "read" }] }] }, ["docs"]);
    const resolved = await call(handler, { method: "POST", path: "/v1/service/threads/workspace",
      service: { principal: orchestratorPrincipal, thread: threadOne, slackUser: pratik },
      body: { requestId: randomUUID(), includeIntegrations: true, includeConnectors: true },
    });
    expect(resolved.body).toMatchObject({
      repositories: ["demo", "docs"],
      connectors: [{ name: "github", type: "github", label: "GitHub issues", scopes: ["demo", "docs"], connected: true }],
    });
    const workspaceId = resolved.body.workspaceId as string;
    markReady(db, workspaceId);
    const service = { principal: orchestratorPrincipal, thread: threadOne, slackUser: pratik };
    const path = `/v1/service/workspaces/${workspaceId}/connectors/github`;
    const catalog = ConnectorCatalogSchema.parse((await call(handler, { method: "GET", path: `${path}/tools`, service })).body.catalog);
    expect(catalog.tools.map((tool) => tool.name)).toEqual(["github__list_issues"]);
    expect((catalog.tools[0]!.inputSchema.properties as Record<string, { enum: string[] }>).target.enum).toEqual(["demo", "docs"]);
    const docs = catalog.tools[0]!.scopes.find((scope) => scope.alias === "docs")!;
    const result = await call(handler, { method: "POST", path: `${path}/call`, service,
      body: { requestId: randomUUID(), scope: "docs", tool: "list_issues", schemaHash: docs.schemaHash, arguments: {} } });
    expect(result.body.result).toMatchObject({ status: "SUCCEEDED" });
    expect(invoke).toHaveBeenCalledExactlyOnceWith("list_issues", { owner: "example", repo: "docs" });
    expect((await call(handler, { method: "POST", path: `${path}/call`, service,
      body: { requestId: randomUUID(), scope: "mobile", tool: "list_issues", schemaHash: docs.schemaHash, arguments: {} } })).status).toBe(404);
    expect((await call(handler, { method: "GET", path: `/v1/service/workspaces/${workspaceId}/connectors/linear/tools`, service })).status).toBe(404);
  });

  it("answers not connected, without contacting a vendor, when the deployment has no GitHub credential", async () => {
    const { db, handler } = createBroker();
    await registerProjectAndBind(handler, { connectors: [{ name: "github", type: "github", scopes: "all-repositories", tools: [{ name: "list_issues", access: "read" }] }] });
    const resolved = await call(handler, { method: "POST", path: "/v1/service/threads/workspace",
      service: { principal: orchestratorPrincipal, thread: threadOne, slackUser: pratik },
      body: { requestId: randomUUID(), includeIntegrations: true, includeConnectors: true },
    });
    expect(resolved.body.connectors).toEqual([{ name: "github", type: "github", label: "GitHub issues", scopes: ["demo"], connected: false }]);
    const workspaceId = resolved.body.workspaceId as string;
    markReady(db, workspaceId);
    const service = { principal: orchestratorPrincipal, thread: threadOne, slackUser: pratik };
    const path = `/v1/service/workspaces/${workspaceId}/connectors/github`;
    expect((await call(handler, { method: "GET", path: `${path}/tools`, service })).body.catalog)
      .toEqual({ connector: "github", notConnected: true, tools: [], skipped: [] });
    const requestId = randomUUID();
    expect((await call(handler, { method: "POST", path: `${path}/call`, service,
      body: { requestId, scope: "demo", tool: "list_issues", schemaHash: "a".repeat(64), arguments: {} } })).body.result).toEqual({
      requestId, status: "FAILED", reason: "not_connected", truncated: false, replayed: false,
      text: "GitHub issues is not connected for this project. An administrator must configure its credential.",
    });
    // An unknown scope or an unapproved tool is refused the same way whether or not a credential is configured.
    expect((await call(handler, { method: "POST", path: `${path}/call`, service,
      body: { requestId: randomUUID(), scope: "mobile", tool: "list_issues", schemaHash: "a".repeat(64), arguments: {} } })).status).toBe(404);
    expect((await call(handler, { method: "POST", path: `${path}/call`, service,
      body: { requestId: randomUUID(), scope: "demo", tool: "issue_write", schemaHash: "a".repeat(64), arguments: {} } })).status).toBe(403);
  });

  it("gives an older Slack service exactly the feature 007 fields", async () => {
    const { handler } = createBroker({ githubMcp: { credentials: vi.fn(), connect: vi.fn() } });
    await registerProjectAndBind(handler, true);
    const resolved = await call(handler, { method: "POST", path: "/v1/service/threads/workspace",
      service: { principal: orchestratorPrincipal, thread: threadOne, slackUser: pratik },
      body: { requestId: randomUUID(), includeIntegrations: true },
    });
    expect(resolved.body.githubMcpRepositories).toEqual(["demo"]);
    expect(resolved.body).not.toHaveProperty("connectors");
    expect(resolved.body).not.toHaveProperty("repositories");
  });

  it("keeps the legacy GitHub route's failed result strict, with no reason, for older Slack services", async () => {
    const credentials = vi.fn(async () => ({ owner: "example", repo: "demo", token: "installation-secret" }));
    const invoke = vi.fn(async () => ({ isError: true, content: [{ type: "text", text: "upstream failure" }] }));
    const connect = vi.fn(async () => ({
      tools: [{ name: "list_issues", description: "Native list_issues", inputSchema: {
        type: "object", properties: { owner: { type: "string" }, repo: { type: "string" } }, required: ["owner", "repo"],
      } }], call: invoke, close: async () => undefined,
    }));
    const { db, handler } = createBroker({ githubMcp: { credentials, connect } });
    await registerProjectAndBind(handler, true);
    const workspaceId = (await ensureWorkspace(handler, threadOne, pratik)).body.workspaceId as string;
    markReady(db, workspaceId);
    const service = { principal: orchestratorPrincipal, thread: threadOne, slackUser: pratik };
    const path = `/v1/service/workspaces/${workspaceId}/github`;
    const catalog = await call(handler, { method: "GET", path: `${path}/tools?repository=demo`, service });
    const tool = GitHubMcpCatalogSchema.parse(catalog.body.catalog).tools[0]!;
    const request = { requestId: randomUUID(), repository: "demo", tool: "list_issues", schemaHash: tool.schemaHash, arguments: {} };
    const failed = await call(handler, { method: "POST", path: `${path}/call`, service, body: request });
    expect(failed.body.result).not.toHaveProperty("reason");
    const result = GitHubMcpResultSchema.parse(failed.body.result);
    expect(result.status).toBe("FAILED");
  });

  it("reports a thread's unfinished operation as recoverable, only to services that opt in to recoverable operations", async () => {
    const { db, handler } = createBroker({ githubMcp: { credentials: vi.fn(), connect: vi.fn() } });
    await registerProjectAndBind(handler, true);
    const service = { principal: orchestratorPrincipal, thread: threadOne, slackUser: pratik };
    // "connectors" is the Slack service deployed before this flag existed; "recoverable" is the current one.
    const resolve = (client: "legacy" | "connectors" | "recoverable") => call(handler, { method: "POST", path: "/v1/service/threads/workspace", service,
      body: {
        requestId: randomUUID(), includeIntegrations: true,
        ...(client === "legacy" ? {} : { includeConnectors: true }),
        ...(client === "recoverable" ? { includeRecoverableOperations: true } : {}),
      } });
    const created = await resolve("recoverable");
    expect(created.body.recoverableOperations).toEqual([]);
    const workspaceId = created.body.workspaceId as string;
    markReady(db, workspaceId);
    expect((await resolve("recoverable")).body.recoverableOperations).toEqual([]);
    const running = randomUUID();
    const workspace = db.get(`WORKSPACE#${workspaceId}`, "META")!;
    workspace.status = "BUSY";
    workspace.activeOperationId = running;
    expect((await resolve("recoverable")).body.recoverableOperations).toEqual([running]);
    expect((await resolve("legacy")).body).not.toHaveProperty("recoverableOperations");
    const deployed = await resolve("connectors");
    expect(deployed.body).toHaveProperty("connectors");
    expect(deployed.body).not.toHaveProperty("recoverableOperations");
  });

  it("does not send recoverable operations for a new workspace to a service that sends only includeConnectors", async () => {
    const { handler } = createBroker({ githubMcp: { credentials: vi.fn(), connect: vi.fn() } });
    await registerProjectAndBind(handler, true);
    const service = { principal: orchestratorPrincipal, thread: threadOne, slackUser: pratik };
    const created = await call(handler, { method: "POST", path: "/v1/service/threads/workspace", service,
      body: { requestId: randomUUID(), includeIntegrations: true, includeSettingsRevision: true, includeConnectors: true } });
    expect(created.body.created).toBe(true);
    expect(created.body).toHaveProperty("connectors");
    expect(created.body).not.toHaveProperty("recoverableOperations");
  });
});

describe("Slack service identity", () => {
  it("matches only an assumed session of the configured orchestrator role", () => {
    expect(isAssumedRoleOf(orchestratorPrincipal, orchestratorRoleArn)).toBe(true);
    expect(isAssumedRoleOf(orchestratorPrincipal, `arn:aws:iam::${account}:role/service/AgentXSlackOrchestrator-TaskRole`)).toBe(true);
    expect(isAssumedRoleOf(orchestratorPrincipal, `arn:aws:iam::999988887777:role/AgentXSlackOrchestrator-TaskRole`)).toBe(false);
    expect(isAssumedRoleOf(orchestratorPrincipal, `arn:aws:iam::${account}:role/OtherRole`)).toBe(false);
    expect(isAssumedRoleOf(`arn:aws:iam::${account}:user/AgentXSlackOrchestrator-TaskRole`, orchestratorRoleArn)).toBe(false);
  });

  it("rejects callers other than the orchestrator, malformed thread headers, and unbound channels", async () => {
    const { handler } = createBroker();
    await registerProjectAndBind(handler);
    const path = "/v1/service/threads/workspace";
    const body = { requestId: randomUUID() };
    expect((await call(handler, { method: "POST", path, body, service: { thread: threadOne, slackUser: pratik } })).status).toBe(403);
    expect((await call(handler, {
      method: "POST",
      path,
      body,
      service: { principal: `arn:aws:sts::${account}:assumed-role/OtherRole/session`, thread: threadOne, slackUser: pratik },
    })).status).toBe(403);
    expect((await call(handler, { method: "POST", path, body, service: { principal: orchestratorPrincipal, thread: "not-a-thread", slackUser: pratik } })).status).toBe(400);
    expect((await call(handler, { method: "POST", path, body, service: { principal: orchestratorPrincipal, thread: threadOne, slackUser: "B0123456789" } })).status).toBe(400);
    const unbound = await ensureWorkspace(handler, `${team}/C0999999999/1695500000.000001`, pratik);
    expect(unbound.status).toBe(403);

    const { handler: disabled } = createBroker({ slack: false });
    expect((await ensureWorkspace(disabled, threadOne, pratik)).status).toBe(404);
  });
});

describe("Slack channel bindings", () => {
  it("lets only project administrators bind and unbind channels", async () => {
    const { db, handler } = createBroker();
    await registerProjectAndBind(handler);
    const stored = db.get(`SLACK_BINDING#${team}`, `CHANNEL#${channel}`);
    expect(stored).toMatchObject({ projectName: "payments" });
    expect(stored).not.toHaveProperty("projectRevision");

    const denied = await call(handler, {
      method: "PUT",
      path: `/v1/admin/slack/bindings/${team}/C0222222222`,
      user: { subject: "developer" },
      body: { projectName: "payments" },
    });
    expect(denied.status).toBe(403);
    const unknownProject = await call(handler, {
      method: "PUT",
      path: `/v1/admin/slack/bindings/${team}/C0222222222`,
      user: admin,
      body: { projectName: "ledger" },
    });
    expect(unknownProject.status).toBe(404);
    // Older CLIs still send a revision; the binding ignores it and follows the latest revision.
    const olderClient = await call(handler, {
      method: "PUT",
      path: `/v1/admin/slack/bindings/${team}/C0222222222`,
      user: admin,
      body: { projectName: "payments", projectRevision: 7 },
    });
    expect(olderClient.status).toBe(200);
    expect(olderClient.body).toMatchObject({ binding: { projectName: "payments" }, latestRevision: 1 });
    expect(db.get(`SLACK_BINDING#${team}`, "CHANNEL#C0222222222")).not.toHaveProperty("projectRevision");

    expect((await call(handler, { method: "DELETE", path: `/v1/admin/slack/bindings/${team}/C0333333333`, user: admin })).status).toBe(404);
    const removed = await call(handler, { method: "DELETE", path: `/v1/admin/slack/bindings/${team}/${channel}`, user: admin });
    expect(removed.status).toBe(200);
    expect(db.get(`SLACK_BINDING#${team}`, `CHANNEL#${channel}`)).toBeUndefined();
    expect((await ensureWorkspace(handler, threadOne, pratik)).status).toBe(403);
  });
});

describe("project registration", () => {
  it("refuses a definition that still carries the retired fields, and keeps serving the ones already stored", async () => {
    const { db, handler } = createBroker();
    await registerProjectAndBind(handler);

    const refused = await call(handler, {
      method: "POST",
      path: "/v1/admin/projects",
      user: admin,
      body: {
        definition: {
          name: "payments",
          revision: 2,
          controlPlaneUrl: "https://agentx.example.test",
          environment: { image: `example.test/agentx@sha256:${"a".repeat(64)}` },
          repositories: [
            { name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" },
          ],
          setup: [],
          readiness: [],
          orchestratorInstructions: "Delegate work (revision 2).",
        },
        runtimeBinding: {
          runtimeArn: `arn:aws:bedrock-agentcore:us-east-1:${account}:runtime/agentx_production_worker-YVirjlFgvk`,
          endpointQualifier: "DEFAULT",
          deploymentMode: "instances-ebs",
          capacityProviderArn: `arn:aws:bedrock-agentcore:us-east-1:${account}:capacity-provider/agentx_production_capacity_v3-VwkM93EABZ`,
        },
      },
    });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain("controlPlaneUrl, environment");
    expect(db.get("PROJECT#payments", "REV#000000000002")).toBeUndefined();

    // A revision stored before the removal keeps working for an existing thread.
    const stored = db.get("PROJECT#payments", "REV#000000000001");
    if (!stored) throw new Error("registered revision is missing");
    const definition = stored.definition as Record<string, unknown>;
    definition.schemaVersion = 2;
    definition.controlPlaneUrl = "https://agentx.example.test";
    definition.auth = { issuer, clientId: "agentx", audience: "agentx" };
    definition.environment = { image: `example.test/agentx@sha256:${"a".repeat(64)}` };
    const created = await ensureWorkspace(handler, threadOne, pratik);
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ created: true, orchestratorInstructions: "Delegate work (revision 1)." });
  });
});

describe("Slack thread workspaces", () => {
  it("creates one workspace per thread and reuses it for any member's follow-up", async () => {
    const { db, handler } = createBroker();
    await registerProjectAndBind(handler);

    const first = await ensureWorkspace(handler, threadOne, pratik);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ outcome: "WORKSPACE", status: "PREPARING", created: true });
    const followUp = await ensureWorkspace(handler, threadOne, bob);
    expect(followUp.body).toMatchObject({ outcome: "WORKSPACE", workspaceId: first.body.workspaceId, created: false });

    const prepare = db.find((item) => item.entityType === "OPERATION" && item.kind === "prepare");
    expect(prepare).toHaveLength(1);
    expect(prepare[0]?.requestedBy).toEqual({ teamId: team, userId: pratik });
    expect(db.find((item) => item.entityType === "OUTBOX")).toHaveLength(1);
    expect(db.get(`SLACK_LIMIT#${team}`, `MEMBER#${pratik}`)).toMatchObject({ count: 1, threads: [threadOne] });
    expect(db.get(`SLACK_LIMIT#${team}`, "ORGANIZATION")).toMatchObject({ count: 1 });

    const threadRecords = db.find((item) => item.entityType === "SLACK_THREAD");
    expect(threadRecords).toHaveLength(1);
    expect(threadRecords[0]).toMatchObject({ thread: threadOne, starterUserId: pratik, workspaceId: first.body.workspaceId });
    expect([...(threadRecords[0]?.requesters as Set<string>)].sort()).toEqual([pratik, bob].sort());

    const second = await ensureWorkspace(handler, threadTwo, pratik);
    expect(second.body).toMatchObject({ outcome: "WORKSPACE", created: true });
    expect(second.body.workspaceId).not.toBe(first.body.workspaceId);
  });

  it("prepares each workspace once and applies the latest revision's settings to every thread", async () => {
    const { db, handler } = createBroker();
    await registerProjectAndBind(handler);
    const first = await ensureWorkspace(handler, threadOne, pratik);
    expect(first.body).toMatchObject({ created: true, orchestratorInstructions: "Delegate work (revision 1)." });
    expect(db.get(`WORKSPACE#${String(first.body.workspaceId)}`, "META")).toMatchObject({ projectRevision: 1 });

    // Revision keys are zero-padded, so revision 10 sorts after revision 2.
    await registerRevision(handler, 10);
    await registerRevision(handler, 2);
    const second = await ensureWorkspace(handler, threadTwo, pratik);
    expect(second.body).toMatchObject({ created: true, orchestratorInstructions: "Delegate work (revision 10)." });
    expect(db.get(`WORKSPACE#${String(second.body.workspaceId)}`, "META")).toMatchObject({ projectRevision: 10 });

    // The workspace keeps the revision its disk was prepared with, while the instructions the
    // orchestrator runs with follow the project's latest revision.
    markReady(db, String(first.body.workspaceId));
    const followUp = await ensureWorkspace(handler, threadOne, bob);
    expect(followUp.body).toMatchObject({
      workspaceId: first.body.workspaceId,
      created: false,
      orchestratorInstructions: "Delegate work (revision 10).",
      settingsRevision: 10,
    });
    expect(db.get(`WORKSPACE#${String(first.body.workspaceId)}`, "META")).toMatchObject({ projectRevision: 1 });

    // A binding stored while bindings named a revision still follows the latest revision.
    const stored = db.get(`SLACK_BINDING#${team}`, `CHANNEL#${channel}`);
    if (!stored) throw new Error("binding record is missing");
    stored.projectRevision = 1;
    const third = await ensureWorkspace(handler, threadThree, bob);
    expect(db.get(`WORKSPACE#${String(third.body.workspaceId)}`, "META")).toMatchObject({ projectRevision: 10 });
  });

  it("declines new threads beyond the member and organization limits without blocking follow-ups", async () => {
    const { db, handler } = createBroker({ memberLimit: 2, organizationLimit: 3 });
    await registerProjectAndBind(handler);
    expect((await ensureWorkspace(handler, threadOne, pratik)).body.created).toBe(true);
    expect((await ensureWorkspace(handler, threadTwo, pratik)).body.created).toBe(true);

    const overMember = await ensureWorkspace(handler, threadThree, pratik);
    expect(overMember.body).toEqual(expect.objectContaining({
      outcome: "LIMIT_REACHED",
      limit: "MEMBER",
      maximum: 2,
      starterThreads: [
        { teamId: team, channelId: channel, threadTs: "1695500000.000001" },
        { teamId: team, channelId: channel, threadTs: "1695500000.000002" },
      ],
    }));
    expect((await ensureWorkspace(handler, threadOne, pratik)).body).toMatchObject({ outcome: "WORKSPACE", created: false });

    expect((await ensureWorkspace(handler, threadThree, bob)).body.created).toBe(true);
    const overOrganization = await ensureWorkspace(handler, `${team}/${channel}/1695500000.000004`, carol);
    expect(overOrganization.body).toMatchObject({ outcome: "LIMIT_REACHED", limit: "ORGANIZATION", maximum: 3, starterThreads: [] });
    expect(db.find((item) => item.entityType === "DEFAULT_WORKSPACE")).toHaveLength(3);
    expect(db.get(`SLACK_LIMIT#${team}`, "ORGANIZATION")).toMatchObject({ count: 3 });
  });

  it("never exceeds a limit when new threads race for the last slot", async () => {
    const { db, handler } = createBroker({ memberLimit: 1 });
    await registerProjectAndBind(handler);
    const results = await Promise.all([
      ensureWorkspace(handler, threadOne, pratik),
      ensureWorkspace(handler, threadTwo, pratik),
    ]);
    expect(results.map((result) => result.body.outcome).sort()).toEqual(["LIMIT_REACHED", "WORKSPACE"]);
    expect(db.get(`SLACK_LIMIT#${team}`, `MEMBER#${pratik}`)).toMatchObject({ count: 1 });
    expect(db.find((item) => item.entityType === "DEFAULT_WORKSPACE")).toHaveLength(1);
  });

  it("returns the existing workspace when the same request is retried", async () => {
    const { db, handler } = createBroker();
    await registerProjectAndBind(handler);
    const requestId = randomUUID();
    const first = await ensureWorkspace(handler, threadOne, pratik, requestId);
    const retried = await ensureWorkspace(handler, threadOne, pratik, requestId);
    expect(retried.body).toMatchObject({ workspaceId: first.body.workspaceId, created: false });
    expect(db.get(`SLACK_LIMIT#${team}`, `MEMBER#${pratik}`)).toMatchObject({ count: 1 });
  });
});

describe("Slack thread workspace closure", () => {
  it("treats an already-absent capacity-provider session as idempotent cleanup", async () => {
    const notFound = new Error("session is absent");
    notFound.name = "ResourceNotFoundException";
    const send = vi.fn(async () => Promise.reject(notFound));
    await expect(deleteCapacityProviderWorkspaceSession(
      { send },
      {
        capacityProviderArn: `arn:aws:bedrock-agentcore:us-east-1:${account}:capacity-provider/provider-1234567890`,
        runtimeSessionId: "11111111-1111-4111-8111-111111111111",
      },
    )).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("fences a clean workspace, deletes its capacity-provider session, releases quota, and retains a tombstone", async () => {
    const { db, handler, deleteWorkspaceSession } = createBroker();
    await registerProjectAndBind(handler);
    const created = await ensureWorkspace(handler, threadOne, pratik);
    const workspaceId = created.body.workspaceId as string;
    markReady(db, workspaceId);

    const requestId = randomUUID();
    const started = await startClose(handler, threadOne, bob, requestId);
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ outcome: "PREFLIGHT", workspaceId, status: "ACCEPTED" });
    const operationId = started.body.operationId as string;
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({
      status: "CLOSING",
      activeOperationId: operationId,
      closeOperationId: operationId,
      closedBy: { teamId: team, userId: bob },
    });
    expect(db.find((item) => item.entityType === "OPERATION" && item.kind === "close")).toHaveLength(1);

    const duplicates = await Promise.all(Array.from({ length: 10 }, () => startClose(handler, threadOne, bob, requestId)));
    expect(duplicates.every((duplicate) => duplicate.body.operationId === operationId)).toBe(true);
    expect(db.find((item) => item.entityType === "OPERATION" && item.kind === "close")).toHaveLength(1);

    const conversation = await call(handler, {
      method: "POST",
      path: `/v1/service/workspaces/${workspaceId}/conversations`,
      service: { principal: orchestratorPrincipal, thread: threadOne, slackUser: bob },
    });
    const task = await call(handler, {
      method: "POST",
      path: `/v1/service/workspaces/${workspaceId}/tasks`,
      service: { principal: orchestratorPrincipal, thread: threadOne, slackUser: bob },
      body: { requestId: randomUUID(), conversationId: (conversation.body.conversation as { id: string }).id, prompt: "race" },
    });
    expect(task.status).toBe(409);

    await finishClosePreflight(handler, db, workspaceId, operationId, { safeToClose: true, repositories: [] });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "CLOSING", closeOperationId: operationId });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).not.toHaveProperty("activeOperationId");

    const runtimeSessionId = db.get(`WORKSPACE#${workspaceId}`, "META")?.runtimeSessionId;
    const completed = await completeClose(handler, threadOne, bob, operationId);
    expect(completed.status).toBe(200);
    expect(completed.body).toMatchObject({ outcome: "CLOSED", workspaceId, operationId, storageReleased: true });
    expect(deleteWorkspaceSession).toHaveBeenCalledExactlyOnceWith({
      capacityProviderArn: `arn:aws:bedrock-agentcore:us-east-1:${account}:capacity-provider/agentx_production_capacity_v3-VwkM93EABZ`,
      runtimeSessionId,
    });
    const closed = db.get(`WORKSPACE#${workspaceId}`, "META");
    expect(closed).toMatchObject({ status: "CLOSED" });
    expect(typeof closed?.closedAt).toBe("string");
    expect(db.get(`SLACK_LIMIT#${team}`, "ORGANIZATION")).toMatchObject({ count: 0 });
    expect(db.get(`SLACK_LIMIT#${team}`, `MEMBER#${pratik}`)).toMatchObject({ count: 0, threads: [] });

    const repeated = await completeClose(handler, threadOne, pratik, operationId);
    expect(repeated.body).toMatchObject({ outcome: "CLOSED", workspaceId, operationId });
    expect(deleteWorkspaceSession).toHaveBeenCalledTimes(1);
    expect((await ensureWorkspace(handler, threadOne, pratik)).body).toMatchObject({ outcome: "CLOSED", workspaceId });
  });

  it("does not create a workspace for an empty thread and cannot close another thread's workspace", async () => {
    const { db, handler, deleteWorkspaceSession } = createBroker();
    await registerProjectAndBind(handler);
    const created = await ensureWorkspace(handler, threadOne, pratik);
    markReady(db, created.body.workspaceId as string);
    expect((await startClose(handler, threadTwo, bob)).body).toEqual(expect.objectContaining({ outcome: "NOT_FOUND" }));
    expect(deleteWorkspaceSession).not.toHaveBeenCalled();
    expect(db.get(`WORKSPACE#${String(created.body.workspaceId)}`, "META")).toMatchObject({ status: "READY" });
  });

  it("refuses busy workspaces and restores an unsafe workspace without deleting storage", async () => {
    const { db, handler, deleteWorkspaceSession } = createBroker();
    await registerProjectAndBind(handler);
    const created = await ensureWorkspace(handler, threadOne, pratik);
    const workspaceId = created.body.workspaceId as string;
    expect((await startClose(handler, threadOne, pratik)).status).toBe(409);
    markReady(db, workspaceId);
    const started = await startClose(handler, threadOne, pratik);
    const operationId = started.body.operationId as string;
    await finishClosePreflight(handler, db, workspaceId, operationId, {
      safeToClose: false,
      repositories: [{ name: "demo", reasons: ["untracked_files"] }],
    });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "READY", closeError: "workspace contains unpublished work" });
    expect((await completeClose(handler, threadOne, pratik, operationId)).status).toBe(409);
    expect(deleteWorkspaceSession).not.toHaveBeenCalled();
    expect(db.get(`SLACK_LIMIT#${team}`, "ORGANIZATION")).toMatchObject({ count: 1 });
  });

  it("keeps a safe workspace closing when resource cleanup fails and succeeds on retry", async () => {
    let attempts = 0;
    const { db, handler, deleteWorkspaceSession } = createBroker({
      deleteWorkspaceSession: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary AgentCore failure");
      },
    });
    await registerProjectAndBind(handler);
    const created = await ensureWorkspace(handler, threadOne, pratik);
    const workspaceId = created.body.workspaceId as string;
    markReady(db, workspaceId);
    const started = await startClose(handler, threadOne, pratik);
    const operationId = started.body.operationId as string;
    await finishClosePreflight(handler, db, workspaceId, operationId, { safeToClose: true, repositories: [] });

    const failed = await completeClose(handler, threadOne, pratik, operationId);
    expect(failed.status).toBe(503);
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "CLOSING" });
    expect(db.get(`SLACK_LIMIT#${team}`, "ORGANIZATION")).toMatchObject({ count: 1 });

    expect((await completeClose(handler, threadOne, pratik, operationId)).status).toBe(200);
    expect(deleteWorkspaceSession).toHaveBeenCalledTimes(2);
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "CLOSED" });
  });
});

describe("Slack thread isolation and attribution", () => {
  it("keeps thread workspaces unreachable from personal logins and other threads", async () => {
    const { db, handler } = createBroker();
    await registerProjectAndBind(handler);
    const created = await ensureWorkspace(handler, threadOne, pratik);
    const workspaceId = created.body.workspaceId as string;
    const operationPath = `/workspaces/${workspaceId}/operations/${created.body.operationId as string}`;

    // The OIDC entry point serves administration only, so neither a personal login nor an
    // administrator reaches a thread workspace's operations through it.
    const personal = await call(handler, { method: "GET", path: `/v1${operationPath}`, user: { subject: "pratik-oidc-subject" } });
    expect(personal.status).toBe(403);
    expect(JSON.stringify(personal.body)).toContain("Slack");
    expect((await call(handler, { method: "GET", path: `/v1${operationPath}`, user: admin })).status).toBe(403);
    expect((await call(handler, {
      method: "GET",
      path: `/v1/service${operationPath}`,
      service: { principal: orchestratorPrincipal, thread: threadTwo, slackUser: pratik },
    })).status).toBe(404);
    const own = await call(handler, {
      method: "GET",
      path: `/v1/service${operationPath}`,
      service: { principal: orchestratorPrincipal, thread: threadOne, slackUser: bob },
    });
    expect(own.status).toBe(200);
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")?.ownerKey).not.toBe(db.find((item) => item.entityType === "MEMBERSHIP" && item.role === "administrator")[0]?.ownerKey);
  });

  it("records the Slack requester on tasks and names every thread requester on pull requests", async () => {
    const { db, handler } = createBroker();
    await registerProjectAndBind(handler);
    const created = await ensureWorkspace(handler, threadOne, pratik);
    await ensureWorkspace(handler, threadOne, bob);
    const workspaceId = created.body.workspaceId as string;
    markReady(db, workspaceId);
    const service = { principal: orchestratorPrincipal, thread: threadOne, slackUser: bob };

    const conversation = await call(handler, { method: "POST", path: `/v1/service/workspaces/${workspaceId}/conversations`, service });
    expect(conversation.status).toBe(201);
    const conversationId = (conversation.body.conversation as { id: string }).id;
    const task = await call(handler, {
      method: "POST",
      path: `/v1/service/workspaces/${workspaceId}/tasks`,
      service,
      body: { requestId: randomUUID(), conversationId, prompt: "Fix the navigation bug." },
    });
    expect(task.status).toBe(202);
    expect((task.body.operation as { requestedBy?: unknown }).requestedBy).toEqual({ teamId: team, userId: bob });

    markReady(db, workspaceId);
    const pullRequest = await call(handler, {
      method: "POST",
      path: `/v1/service/workspaces/${workspaceId}/pull-requests`,
      service,
      body: { requestId: randomUUID(), repository: "demo", title: "Fix navigation", body: "Fixes the menu." },
    });
    expect(pullRequest.status).toBe(202);
    const publication = db.find((item) => item.entityType === "OPERATION" && item.kind === "publish")[0]?.publication as { body?: string };
    expect(publication.body).toBe(
      `Fixes the menu.\n\n---\nRequested in Slack thread https://slack.com/archives/${channel}/p1695500000000001 by ${[bob, pratik].sort().join(", ")}.`,
    );
  });

  it("records that a conversation owns a session once, and tells its next task to reopen", async () => {
    const { db, handler } = createBroker();
    await registerProjectAndBind(handler);
    const created = await ensureWorkspace(handler, threadOne, pratik);
    const workspaceId = created.body.workspaceId as string;
    markReady(db, workspaceId);
    const service = { principal: orchestratorPrincipal, thread: threadOne, slackUser: pratik };
    const conversation = await call(handler, {
      method: "POST",
      path: `/v1/service/workspaces/${workspaceId}/conversations`,
      service,
    });
    const conversationId = (conversation.body.conversation as { id: string }).id;
    const conversationKey = [`WORKSPACE#${workspaceId}`, `CONVERSATION#${conversationId}`] as const;

    const first = await call(handler, {
      method: "POST",
      path: `/v1/service/workspaces/${workspaceId}/tasks`,
      service,
      body: { requestId: randomUUID(), conversationId, prompt: "Use the existing button style." },
    });
    expect(first.status).toBe(202);
    const firstOperationId = (first.body.operation as { id: string }).id;
    const firstInvocation = invocationOf(db, firstOperationId);
    expect(firstInvocation.payload).toMatchObject({ conversationId, conversationStarted: false });
    expect(db.get(...conversationKey)?.startedAt).toBeUndefined();

    const lifecycle = {
      events: [
        {
          type: "lifecycle",
          timestamp: new Date().toISOString(),
          payload: { status: "RUNNING", conversationId, conversation: { started: true, reopened: false } },
        },
      ],
    };
    const callbackPath = `/v1/internal/workspaces/${workspaceId}/operations/${firstOperationId}/events`;
    expect((await call(handler, { method: "POST", path: callbackPath, headers: { "x-agentx-callback-capability": firstInvocation.callbackCapability }, body: lifecycle })).status).toBe(200);
    const startedAt = db.get(...conversationKey)?.startedAt;
    expect(typeof startedAt).toBe("string");

    // A redelivered batch must not move the record, which is what makes it a first-use marker.
    await call(handler, { method: "POST", path: callbackPath, headers: { "x-agentx-callback-capability": firstInvocation.callbackCapability }, body: lifecycle });
    expect(db.get(...conversationKey)?.startedAt).toBe(startedAt);

    markReady(db, workspaceId);
    const second = await call(handler, {
      method: "POST",
      path: `/v1/service/workspaces/${workspaceId}/tasks`,
      service,
      body: { requestId: randomUUID(), conversationId, prompt: "Now add the Done filter." },
    });
    expect(second.status).toBe(202);
    expect(invocationOf(db, (second.body.operation as { id: string }).id).payload).toMatchObject({
      conversationId,
      conversationStarted: true,
    });
  });
});
