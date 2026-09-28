import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { RepositoryGrantService } from "../../packages/broker/src/repository-access.js";
import { GitHubMcpCatalogSchema } from "../../packages/contracts/src/github-mcp.js";

describe("thread-authenticated GitHub MCP routes", () => {
  it("enforces owner, membership, revision policy and repository before discovery, and durably deduplicates writes", async () => {
    Object.assign(process.env, {
      AWS_REGION: "us-east-1", STATE_TABLE_NAME: "unused", ARTIFACT_BUCKET_NAME: "unused",
      OIDC_ISSUER: "https://identity.example.test", CALLBACK_SIGNING_KEY: "c".repeat(64),
      GITHUB_APP_PRIVATE_KEY_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:111122223333:secret:test",
      GITHUB_APP_CREDENTIAL_REF: "github-app", GITHUB_APP_ACCOUNT: "example", GITHUB_APP_ID: "123", GITHUB_APP_INSTALLATION_ID: "456",
    });
    const { createAwsBrokerHandler } = await import("../../packages/broker/src/aws/broker.js");
    const issuer = "https://identity.example.test";
    const teamId = "T0123456789";
    const channelId = "C0123456789";
    const thread = `${teamId}/${channelId}/1758240000.000100`;
    const otherThread = `${teamId}/${channelId}/1758240000.000200`;
    const orchestratorRoleArn = "arn:aws:iam::111122223333:role/service/AgentXSlackOrchestrator-TaskRole";
    const orchestratorPrincipal = "arn:aws:sts::111122223333:assumed-role/AgentXSlackOrchestrator-TaskRole/task";
    const ownerKey = ownerKeyForSubject("slack-thread", thread);
    const workspaceId = randomUUID();
    const now = new Date().toISOString();
    const records = new Map<string, Record<string, unknown>>();
    const key = (pk: string, sk: string) => `${pk}\0${sk}`;
    records.set(key(`WORKSPACE#${workspaceId}`, "META"), {
      deploymentMode: "ec2-ebs" as const,
      id: workspaceId,
      ownerKey,
      projectName: "demo",
      projectRevision: 2,
      environmentDigest: `example.test/agentx@sha256:${"a".repeat(64)}`,
      rootPath: "/mnt/workspace",
      status: "READY",
      activeOperationId: null,
      fence: 1,
      createdAt: now,
      updatedAt: now,
    });
    const membershipKey = key(`MEMBER#${ownerKey}`, "PROJECT#demo");
    records.set(membershipKey, { ownerKey, projectName: "demo", role: "developer" });
    records.set(key(`SLACK_BINDING#${teamId}`, `CHANNEL#${channelId}`), {
      teamId, channelId, projectName: "demo", projectRevision: 2, updatedAt: now,
    });
    const repository = { name: "demo", url: "https://github.com/example/demo.git", credentialRef: "github-app" };
    const policy = { tools: [{ name: "issue_write", access: "write" }] };
    const definition = { revision: 2, repositories: [repository], integrations: { githubMcp: policy } };
    records.set(key("PROJECT#demo", "REV#000000000002"), { definition });
    const documentClient = { send: vi.fn(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (command.constructor.name === "GetCommand") {
        const itemKey = command.input.Key as { pk: string; sk: string };
        return { Item: records.get(key(itemKey.pk, itemKey.sk)) };
      }
      if (command.constructor.name === "QueryCommand") {
        const values = command.input.ExpressionAttributeValues as Record<string, string>;
        const prefix = `${values[":pk"]}\0${values[":revision"] ?? ""}`;
        const matches = [...records.entries()]
          .filter(([recordKey]) => recordKey.startsWith(prefix))
          .sort(([left], [right]) => right.localeCompare(left))
          .map(([, item]) => item);
        return { Items: matches.slice(0, (command.input.Limit as number | undefined) ?? matches.length) };
      }
      if (command.constructor.name === "PutCommand") {
        const item = command.input.Item as { pk: string; sk: string; result: { status: string } };
        const recordKey = key(item.pk, item.sk);
        if (command.input.ConditionExpression === "attribute_not_exists(pk)" && records.has(recordKey)) {
          throw Object.assign(new Error("duplicate"), { name: "ConditionalCheckFailedException" });
        }
        records.set(recordKey, structuredClone(item));
        return {};
      }
      throw new Error("MCP must not dispatch a worker or change workspace state");
    }) };
    const credentials = vi.fn(async () => ({ owner: "example", repo: "demo", token: "server-secret" }));
    const call = vi.fn(async () => ({ content: [{ type: "text", text: "created" }] }));
    const connect = vi.fn(async () => ({
      tools: [{ name: "issue_write", description: "Create an issue", inputSchema: { type: "object", properties: {
        owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" }, method: { type: "string", enum: ["create"] },
      }, required: ["owner", "repo", "method"] } }], call, close: vi.fn(async () => undefined),
    }));
    const handler = createAwsBrokerHandler({
      documentClient: documentClient as never, s3: {} as never, tableName: "state", artifactBucketName: "artifacts",
      issuer, adminClaim: "groups", adminValues: ["admins"], callbackSigningKey: "c".repeat(64),
      repositoryGrants: new RepositoryGrantService({ resolve: async () => ({}) }),
      githubPullRequests: {} as never, codeBuild: {} as never, githubMcp: { credentials, connect },
      slack: { orchestratorRoleArn, memberWorkspaceLimit: 3, organizationWorkspaceLimit: 20 },
    });
    const request = (method: string, requestingThread = thread, body?: unknown, repositoryName = "demo") => handler({
      version: "2.0", rawPath: `/v1/service/workspaces/${workspaceId}/github/${method === "GET" ? "tools" : "call"}`,
      rawQueryString: `repository=${repositoryName}`,
      headers: { "x-agentx-slack-thread": requestingThread, "x-agentx-slack-user": "U0123456789" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      requestContext: { requestId: randomUUID(), http: { method }, authorizer: { iam: { userArn: orchestratorPrincipal } } },
    });
    expect((await request("GET", otherThread)).statusCode).toBe(404);
    expect((await request("GET", thread, undefined, "unknown")).statusCode).toBe(404);
    // The retired OIDC developer path reaches no workspace route at all.
    const throughOidc = await handler({
      version: "2.0", rawPath: `/v1/workspaces/${workspaceId}/github/tools`,
      rawQueryString: "repository=demo", headers: {},
      requestContext: { requestId: randomUUID(), http: { method: "GET" }, authorizer: { jwt: { claims: { iss: issuer, sub: "alice" } } } },
    });
    expect(throughOidc.statusCode).toBe(403);
    expect(throughOidc.body).toContain("Slack");
    const membership = records.get(membershipKey)!;
    records.delete(membershipKey);
    expect((await request("GET")).statusCode).toBe(404);
    records.set(membershipKey, membership);
    records.set(key("PROJECT#demo", "REV#000000000002"), { definition: { revision: 2, repositories: [repository] } });
    expect((await request("GET")).statusCode).toBe(403);
    records.set(key("PROJECT#demo", "REV#000000000002"), { definition });
    expect(credentials).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();

    const discovered = await request("GET");
    expect(discovered.statusCode).toBe(200);
    expect(discovered.body).not.toContain("server-secret");
    const catalogEnvelope = JSON.parse(discovered.body) as { catalog: unknown };
    const tool = GitHubMcpCatalogSchema.parse(catalogEnvelope.catalog).tools[0]!;
    const input = { requestId: randomUUID(), repository: "demo", tool: "issue_write", schemaHash: tool.schemaHash, arguments: { method: "create", title: "Native tool" } };
    const first = await request("POST", thread, input);
    expect(JSON.parse(first.body)).toMatchObject({ result: { requestId: input.requestId, status: "SUCCEEDED", replayed: false } });
    expect(JSON.parse((await request("POST", thread, input)).body)).toMatchObject({ result: { requestId: input.requestId, status: "SUCCEEDED", replayed: true } });
    expect((await request("POST", thread, { ...input, arguments: { ...input.arguments, title: "Changed" } })).statusCode).toBe(409);
    expect((await request("POST", thread, { ...input, arguments: { ...input.arguments, owner: "another" } })).statusCode).toBe(403);
    expect((await request("POST", thread, { ...input, token: "caller-controlled" })).statusCode).toBe(400);
    expect(call).toHaveBeenCalledExactlyOnceWith("issue_write", { method: "create", title: "Native tool", owner: "example", repo: "demo" });
    expect(credentials).toHaveBeenLastCalledWith(repository, "write");
    // The invocation records the revision whose policy authorized it, not the workspace's.
    expect(records.get(key(`WORKSPACE#${workspaceId}`, `GITHUB_MCP#${input.requestId}`))).toMatchObject({
      settingsRevision: 2,
    });

    // A newer revision that withdraws the tool rejects the next call, including one whose schema
    // was discovered while the tool was still approved.
    records.set(key("PROJECT#demo", "REV#000000000003"), {
      definition: { revision: 3, repositories: [repository], integrations: { githubMcp: { tools: [{ name: "list_issues", access: "read" }] } } },
    });
    const withdrawn = await request("POST", thread, { ...input, requestId: randomUUID() });
    expect(withdrawn.statusCode).toBe(403);
    expect(call).toHaveBeenCalledOnce();
    expect(JSON.stringify([...records.values()])).not.toContain("server-secret");
    expect(records.get(key(`WORKSPACE#${workspaceId}`, "META"))?.status).toBe("READY");
  });
});
