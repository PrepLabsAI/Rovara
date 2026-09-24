import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { isAssumedRoleOf } from "../../packages/broker/src/aws/lambda.js";
import { RepositoryGrantService } from "../../packages/broker/src/repository-access.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import type { GitHubMcpDependencies } from "../../packages/broker/src/github-mcp.js";
import { GitHubMcpCatalogSchema } from "../../packages/contracts/src/github-mcp.js";

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
  ({ createAwsBrokerHandler } = await import("../../packages/broker/src/aws/broker.js") as unknown as {
    createAwsBrokerHandler: typeof createAwsBrokerHandler;
  });
});

function createBroker(options: { memberLimit?: number; organizationLimit?: number; slack?: boolean; githubMcp?: GitHubMcpDependencies } = {}) {
  const db = new FakeDynamoDb();
  const handler = createAwsBrokerHandler({
    documentClient: db,
    s3: { send: vi.fn() },
    stopRuntimeSession: vi.fn(),
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
  return { db, handler };
}

interface CallOptions {
  method: string;
  path: string;
  body?: unknown;
  user?: { subject: string; admin?: boolean };
  service?: { principal?: string; thread?: string; slackUser?: string };
}

async function call(handler: Handler, options: CallOptions): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
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

async function registerProjectAndBind(handler: Handler, githubMcp = false): Promise<void> {
  await registerRevision(handler, 1, githubMcp);
  const bound = await call(handler, {
    method: "PUT",
    path: `/v1/admin/slack/bindings/${team}/${channel}`,
    user: admin,
    body: { projectName: "payments" },
  });
  expect(bound.status).toBe(200);
}

async function registerRevision(handler: Handler, revision: number, githubMcp = false): Promise<void> {
  const registered = await call(handler, {
    method: "POST",
    path: "/v1/admin/projects",
    user: admin,
    body: {
      definition: {
        schemaVersion: 2,
        name: "payments",
        revision,
        controlPlaneUrl: "https://agentx.example.test",
        auth: { issuer, clientId: "agentx", audience: "agentx" },
        environment: { image: `example.test/agentx@sha256:${"a".repeat(64)}` },
        repositories: [
          { name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" },
        ],
        setup: [],
        readiness: [],
        orchestratorInstructions: `Delegate work (revision ${revision}).`,
        ...(githubMcp ? { integrations: { githubMcp: { tools: [{ name: "issue_write", access: "write" }, { name: "list_issues", access: "read" }] } } } : {}),
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

function markReady(db: FakeDynamoDb, workspaceId: string): void {
  const workspace = db.get(`WORKSPACE#${workspaceId}`, "META");
  if (!workspace) throw new Error("workspace record is missing");
  // Mirrors the broker's terminal transition, which removes activeOperationId rather than nulling it.
  workspace.status = "READY";
  delete workspace.activeOperationId;
}

describe("hosted Slack GitHub MCP", () => {
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
});
