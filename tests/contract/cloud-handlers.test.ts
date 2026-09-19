import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  adaptHttpApiEvent,
  identityFromJwtClaims,
  parseRuntimeBinding,
} from "../../packages/broker/src/aws/lambda.js";
import { createOutboxPublisherHandler } from "../../packages/broker/src/aws/outbox-publisher.js";
import { createDispatcherHandler } from "../../packages/broker/src/aws/dispatcher.js";
import { RepositoryGrantService } from "../../packages/broker/src/repository-access.js";

describe("AWS control-plane handlers", () => {
  it("adapts HTTP API events and derives identity only from verified JWT claims", () => {
    const request = adaptHttpApiEvent({
      version: "2.0",
      rawPath: "/v1/projects/payments/workspace",
      rawQueryString: "revision=1",
      headers: { authorization: "Bearer opaque" },
      requestContext: {
        requestId: "request-1",
        http: { method: "GET" },
        authorizer: { jwt: { claims: { iss: "https://issuer.example", sub: "alice", groups: "[admins]" } } },
      },
    });
    expect(request.path).toBe("/v1/projects/payments/workspace?revision=1");
    expect(request.method).toBe("GET");

    const identity = identityFromJwtClaims(request.jwtClaims, {
      issuer: "https://issuer.example",
      adminClaim: "groups",
      adminValues: ["admins"],
    });
    expect(identity.ownerKey).toBe(
      createHash("sha256").update("https://issuer.example").update("\0").update("alice").digest("hex"),
    );
    expect(identity.isAdministrator).toBe(true);
  });

  it("validates administrator runtime bindings by deployment mode", () => {
    const runtimeArn = "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/agentx";
    expect(parseRuntimeBinding({ runtimeArn, endpointQualifier: "DEFAULT", deploymentMode: "demo-microvm" }))
      .toEqual({ runtimeArn, endpointQualifier: "DEFAULT", deploymentMode: "demo-microvm" });
    expect(() => parseRuntimeBinding({
      runtimeArn,
      endpointQualifier: "DEFAULT",
      deploymentMode: "instances-ebs",
    })).toThrow(/capacity provider/i);
  });

  it("publishes only pending outbox stream images and marks them queued", async () => {
    const send = vi.fn(async () => undefined);
    const markQueued = vi.fn(async () => undefined);
    const handler = createOutboxPublisherHandler({ send, markQueued });
    await handler({ Records: [
      { eventName: "INSERT", dynamodb: { NewImage: { entityType: { S: "OUTBOX" }, status: { S: "PENDING" }, id: { S: "one" } } } },
      { eventName: "MODIFY", dynamodb: { NewImage: { entityType: { S: "OUTBOX" }, status: { S: "QUEUED" }, id: { S: "two" } } } },
    ] });
    expect(send).toHaveBeenCalledOnce();
    expect(markQueued).toHaveBeenCalledWith("one");
  });

  it("dispatches the stored invocation with server-owned runtime routing", async () => {
    const invoke = vi.fn(async () => ({ statusCode: 200 }));
    const markDispatching = vi.fn(async () => undefined);
    const markDelivered = vi.fn(async () => undefined);
    const handler = createDispatcherHandler({ invoke, markDispatching, markDelivered });
    const operationId = randomUUID();
    const workspaceId = randomUUID();
    const invocation = {
      protocolVersion: 1,
      operationId,
      workspaceId,
      kind: "resume",
      fence: 1,
      projectRevision: 1,
      callbackCapability: "c".repeat(64),
      payload: {},
    } as const;
    const outbox = {
      id: randomUUID(),
      entityType: "OUTBOX",
      status: "QUEUED",
      operationId,
      workspaceId,
      runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/agentx",
      endpointQualifier: "DEFAULT",
      runtimeSessionId: randomUUID(),
      invocation,
    } as const;

    await handler({ Records: [{ messageId: "m1", body: JSON.stringify(outbox) }] });
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      runtimeSessionId: outbox.runtimeSessionId,
      payload: invocation,
    }));
    expect(markDispatching).toHaveBeenCalledWith(outbox);
    expect(markDelivered).toHaveBeenCalledWith(outbox.id);
  });

  it("accepts one fenced publication and scopes its grant to push on the selected repository", async () => {
    Object.assign(process.env, {
      AWS_REGION: "us-east-1",
      STATE_TABLE_NAME: "unused",
      ARTIFACT_BUCKET_NAME: "unused",
      OIDC_ISSUER: "https://identity.example.test",
      CALLBACK_SIGNING_KEY: "c".repeat(64),
      GITHUB_APP_PRIVATE_KEY_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:111122223333:secret:test",
      GITHUB_APP_CREDENTIAL_REF: "github-app",
      GITHUB_APP_ACCOUNT: "example",
      GITHUB_APP_ID: "123",
      GITHUB_APP_INSTALLATION_ID: "456",
    });
    const { createAwsBrokerHandler } = await import("../../packages/broker/src/aws/broker.js");
    const subject = "alice";
    const ownerKey = createHash("sha256")
      .update("https://identity.example.test")
      .update("\0")
      .update(subject)
      .digest("hex");
    const workspaceId = randomUUID();
    const now = new Date().toISOString();
    const records = new Map<string, Record<string, unknown>>();
    const key = (pk: string, sk: string) => `${pk}\0${sk}`;
    records.set(key(`WORKSPACE#${workspaceId}`, "META"), {
      pk: `WORKSPACE#${workspaceId}`,
      sk: "META",
      entityType: "WORKSPACE",
      id: workspaceId,
      ownerKey,
      projectName: "demo",
      projectRevision: 1,
      environmentDigest: `example.test/agentx@sha256:${"a".repeat(64)}`,
      runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/agentx",
      endpointQualifier: "DEFAULT",
      runtimeSessionId: randomUUID(),
      deploymentMode: "demo-microvm",
      rootPath: "/mnt/workspace",
      status: "READY",
      activeOperationId: null,
      fence: 1,
      createdAt: now,
      updatedAt: now,
    });
    records.set(key(`MEMBER#${ownerKey}`, "PROJECT#demo"), {
      pk: `MEMBER#${ownerKey}`,
      sk: "PROJECT#demo",
      entityType: "MEMBERSHIP",
      ownerKey,
      projectName: "demo",
      role: "developer",
    });
    records.set(key("PROJECT#demo", "REV#000000000001"), {
      pk: "PROJECT#demo",
      sk: "REV#000000000001",
      entityType: "PROJECT",
      definition: {
        schemaVersion: 2,
        name: "demo",
        revision: 1,
        controlPlaneUrl: "https://agentx.example.test",
        auth: { issuer: "https://identity.example.test", clientId: "agentx", audience: "agentx" },
        environment: { image: `example.test/agentx@sha256:${"a".repeat(64)}` },
        repositories: [
          { name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" },
          { name: "other", url: "https://github.com/example/other.git", path: "repo/other", defaultBranch: "main", credentialRef: "github-app" },
        ],
        setup: [],
        readiness: [],
        orchestratorInstructions: "Delegate work.",
      },
      runtimeBinding: {
        runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/agentx",
        endpointQualifier: "DEFAULT",
        deploymentMode: "demo-microvm",
      },
      registeredBy: ownerKey,
      registeredAt: now,
    });
    const written: Record<string, unknown>[] = [];
    const documentClient = {
      send: vi.fn(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        if (command.constructor.name === "GetCommand") {
          const inputKey = command.input.Key as { pk: string; sk: string };
          return { Item: records.get(key(inputKey.pk, inputKey.sk)) };
        }
        if (command.constructor.name === "TransactWriteCommand") {
          const transaction = command.input.TransactItems as Array<{
            Put?: { Item: Record<string, unknown> };
            Update?: {
              Key: { pk: string; sk: string };
              ExpressionAttributeValues?: Record<string, unknown>;
            };
          }>;
          for (const item of transaction) {
            if (item.Update?.Key.sk === "META") {
              const current = records.get(key(item.Update.Key.pk, item.Update.Key.sk));
              const values = item.Update.ExpressionAttributeValues;
              if (current && values?.[":busy"] === "BUSY") {
                Object.assign(current, {
                  status: "BUSY",
                  activeOperationId: values[":operation"],
                  fence: values[":fence"],
                });
              }
            }
            if (item.Put) {
              written.push(item.Put.Item);
              const record = item.Put.Item;
              if (typeof record.pk === "string" && typeof record.sk === "string") {
                records.set(key(record.pk, record.sk), record);
              }
            }
          }
          return {};
        }
        throw new Error(`unexpected command ${command.constructor.name}`);
      }),
    };
    const grants = new RepositoryGrantService(Buffer.alloc(32, 4), async () => ({ token: "unused" }));
    const reconcilePullRequest = vi.fn(async () => ({
      number: 3,
      url: "https://github.com/example/demo/pull/3",
      reconciled: false,
    }));
    const handler = createAwsBrokerHandler({
      documentClient: documentClient as never,
      s3: { send: vi.fn() } as never,
      stopRuntimeSession: vi.fn(),
      tableName: "state",
      artifactBucketName: "artifacts",
      issuer: "https://identity.example.test",
      adminClaim: "groups",
      adminValues: ["admins"],
      callbackSigningKey: "c".repeat(64),
      repositoryGrants: grants,
      githubPullRequests: { reconcilePullRequest },
    });
    const requestId = randomUUID();
    const publicationEvent = {
      version: "2.0",
      rawPath: `/v1/workspaces/${workspaceId}/pull-requests`,
      headers: {},
      body: JSON.stringify({ requestId, repository: "demo", title: "Publish demo" }),
      requestContext: {
        requestId: "gateway-request",
        http: { method: "POST" },
        authorizer: { jwt: { claims: { iss: "https://identity.example.test", sub: subject } } },
      },
    } as const;
    const response = await handler(publicationEvent);
    expect(response.statusCode).toBe(202);
    const body = JSON.parse(response.body) as { operation: { id: string; kind: string } };
    expect(body.operation.kind).toBe("publish");
    const outbox = written.find((record) => record.entityType === "OUTBOX");
    const invocation = outbox?.invocation as {
      callbackCapability: string;
      payload: { repositoryGrant: string; repository: string; headBranch: string };
    };
    expect(invocation.payload.repository).toBe("demo");
    expect(grants.inspect(invocation.payload.repositoryGrant).repositories).toEqual([{
      credentialRef: "github-app",
      repositoryUrl: "https://github.com/example/demo.git",
      access: "push",
    }]);

    const callback = await handler({
      version: "2.0",
      rawPath: `/v1/internal/workspaces/${workspaceId}/operations/${body.operation.id}/pull-request`,
      headers: { "x-agentx-callback-capability": invocation.callbackCapability },
      body: JSON.stringify({
        repository: "demo",
        repositoryUrl: "https://github.com/example/demo.git",
        headBranch: invocation.payload.headBranch,
        baseBranch: "main",
        commit: "d".repeat(40),
        title: "Publish demo",
      }),
      requestContext: { requestId: "callback-request", http: { method: "POST" } },
    });
    expect(callback.statusCode).toBe(200);
    expect(JSON.parse(callback.body)).toMatchObject({
      number: 3,
      url: "https://github.com/example/demo/pull/3",
      reconciled: false,
    });
    expect(reconcilePullRequest).toHaveBeenCalledWith({
      repositoryUrl: "https://github.com/example/demo.git",
      headBranch: invocation.payload.headBranch,
      baseBranch: "main",
      title: "Publish demo",
    });

    const duplicate = await handler(publicationEvent);
    expect(duplicate.statusCode).toBe(202);
    expect(JSON.parse(duplicate.body)).toMatchObject({
      operation: { id: body.operation.id },
      duplicate: true,
    });
    const thirdReplay = await handler(publicationEvent);
    expect(JSON.parse(thirdReplay.body)).toMatchObject({
      operation: { id: body.operation.id },
      duplicate: true,
    });
    const conflict = await handler({
      ...publicationEvent,
      body: JSON.stringify({ requestId, repository: "demo", title: "Changed title" }),
    });
    expect(conflict.statusCode).toBe(409);
    expect(JSON.parse(conflict.body)).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });

    const busy = await handler({
      ...publicationEvent,
      body: JSON.stringify({ requestId: randomUUID(), repository: "demo", title: "Another publication" }),
    });
    expect(busy.statusCode).toBe(409);
    expect(JSON.parse(busy.body)).toMatchObject({ error: { code: "WORKSPACE_BUSY" } });

    const unauthorized = await handler({
      ...publicationEvent,
      body: JSON.stringify({ requestId: randomUUID(), repository: "demo", title: "Unauthorized" }),
      requestContext: {
        requestId: "unauthorized-request",
        http: { method: "POST" },
        authorizer: { jwt: { claims: { iss: "https://identity.example.test", sub: "bob" } } },
      },
    });
    expect(unauthorized.statusCode).toBe(404);
    expect(JSON.parse(unauthorized.body)).toMatchObject({ error: { code: "NOT_FOUND" } });
  });
});
