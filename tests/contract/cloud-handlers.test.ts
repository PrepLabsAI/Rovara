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
    const markFailed = vi.fn(async () => undefined);
    const handler = createDispatcherHandler({ invoke, markDispatching, markDelivered, markFailed });
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
    expect(markFailed).not.toHaveBeenCalled();
  });

  it("retries transient dispatch errors and terminally fails the final attempt", async () => {
    const invoke = vi.fn(async () => ({ statusCode: 400, error: "worker rejected the invocation" }));
    const markDispatching = vi.fn(async () => undefined);
    const markDelivered = vi.fn(async () => undefined);
    const markFailed = vi.fn(async () => undefined);
    const log = vi.fn();
    const handler = createDispatcherHandler({
      invoke,
      markDispatching,
      markDelivered,
      markFailed,
      maxAttempts: 3,
      log,
    });
    const operationId = randomUUID();
    const workspaceId = randomUUID();
    const outbox = {
      id: randomUUID(),
      entityType: "OUTBOX",
      status: "QUEUED",
      operationId,
      workspaceId,
      runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/agentx",
      endpointQualifier: "DEFAULT",
      runtimeSessionId: randomUUID(),
      invocation: {
        protocolVersion: 1,
        operationId,
        workspaceId,
        kind: "resume",
        fence: 2,
        projectRevision: 1,
        callbackCapability: "c".repeat(64),
        payload: {},
      },
    } as const;

    await expect(handler({ Records: [{
      messageId: "retry",
      body: JSON.stringify(outbox),
      attributes: { ApproximateReceiveCount: "2" },
    }] })).resolves.toEqual({ batchItemFailures: [{ itemIdentifier: "retry" }] });
    expect(markFailed).not.toHaveBeenCalled();

    await expect(handler({ Records: [{
      messageId: "terminal",
      body: JSON.stringify(outbox),
      attributes: { ApproximateReceiveCount: "3" },
    }] })).resolves.toEqual({ batchItemFailures: [] });
    expect(markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ operationId, workspaceId }),
      expect.stringMatching(/dispatch failed after 3 attempts.*worker rejected the invocation/u),
    );
    expect(markDelivered).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      event: "dispatch.attempt_failed",
      operationId,
      attempt: 3,
      maxAttempts: 3,
      terminal: true,
      errorMessage: "RUNTIME_UNAVAILABLE: AgentCore returned HTTP 400: worker rejected the invocation",
    }));
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
    // Publication now reaches the control plane only through the hosted Slack orchestrator,
    // so the workspace is owned by its Slack thread.
    const teamId = "T0123456789";
    const channelId = "C0123456789";
    const threadSubject = `${teamId}/${channelId}/1758240000.000100`;
    const otherThreadSubject = `${teamId}/${channelId}/1758240000.000200`;
    const ownerKey = createHash("sha256")
      .update("slack-thread")
      .update("\0")
      .update(threadSubject)
      .digest("hex");
    const orchestratorRoleArn = "arn:aws:iam::111122223333:role/service/AgentXSlackOrchestrator-TaskRole";
    const orchestratorPrincipal = "arn:aws:sts::111122223333:assumed-role/AgentXSlackOrchestrator-TaskRole/task";
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
    records.set(key(`SLACK_BINDING#${teamId}`, `CHANNEL#${channelId}`), {
      pk: `SLACK_BINDING#${teamId}`,
      sk: `CHANNEL#${channelId}`,
      entityType: "SLACK_BINDING",
      teamId,
      channelId,
      projectName: "demo",
      projectRevision: 1,
      updatedAt: now,
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
          {
            name: "demo",
            url: "https://github.com/example/demo.git",
            path: "repo/demo",
            defaultBranch: "main",
            credentialRef: "github-app",
            codeBuildGates: [{ name: "quality", projectName: "agentx-demo-quality", timeoutMinutes: 30 }],
          },
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
    const pinnedDefinition = (records.get(key("PROJECT#demo", "REV#000000000001")) as { definition: Record<string, unknown> }).definition;
    records.set(key("PROJECT#demo", "REV#000000000002"), {
      pk: "PROJECT#demo",
      sk: "REV#000000000002",
      entityType: "PROJECT",
      definition: {
        ...pinnedDefinition,
        revision: 2,
        readiness: [{ cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 600 }],
        repositories: [
          {
            name: "demo",
            url: "https://github.com/example/demo.git",
            path: "repo/demo",
            defaultBranch: "main",
            credentialRef: "github-app",
            codeBuildGates: [{ name: "quality", projectName: "agentx-demo-quality-v2", timeoutMinutes: 45 }],
          },
          { name: "other", url: "https://github.com/example/other.git", path: "repo/other", defaultBranch: "main", credentialRef: "github-app" },
        ],
        orchestratorInstructions: "Delegate work (revision 2).",
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
        if (command.constructor.name === "QueryCommand") {
          // The broker finds a project's latest revision with one descending query on REV# keys.
          const values = command.input.ExpressionAttributeValues as Record<string, string>;
          const prefix = `${values[":pk"]}\0${values[":revision"] ?? ""}`;
          const matches = [...records.entries()]
            .filter(([recordKey]) => recordKey.startsWith(prefix))
            .sort(([left], [right]) => right.localeCompare(left))
            .map(([, item]) => item);
          return { Items: matches.slice(0, (command.input.Limit as number | undefined) ?? matches.length) };
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
        if (command.constructor.name === "PutCommand") {
          const record = command.input.Item as Record<string, unknown>;
          written.push(record);
          if (typeof record.pk === "string" && typeof record.sk === "string") {
            records.set(key(record.pk, record.sk), record);
          }
          return {};
        }
        if (command.constructor.name === "UpdateCommand") {
          const inputKey = command.input.Key as { pk: string; sk: string };
          const current = records.get(key(inputKey.pk, inputKey.sk));
          if (!current) throw new Error("missing update record");
          const values = command.input.ExpressionAttributeValues as Record<string, unknown>;
          if (values[":commit"] !== undefined) current.candidateCommit ??= values[":commit"];
          if (values[":evidence"] !== undefined) current.evidence = values[":evidence"];
          return {};
        }
        throw new Error(`unexpected command ${command.constructor.name}`);
      }),
    };
    const grants = new RepositoryGrantService(Buffer.alloc(32, 4), async () => ({ token: "unused" }));
    let reconciledPullRequestNumber = 3;
    const lifecycleOrdering: string[] = [];
    const reconcilePullRequest = vi.fn(async () => {
      lifecycleOrdering.push("create");
      return {
      number: reconciledPullRequestNumber,
      url: `https://github.com/example/demo/pull/${reconciledPullRequestNumber}`,
      reconciled: false,
      };
    });
    let githubState: "open" | "closed" | "merged" = "open";
    let githubTitle = "Publish demo";
    let githubBody = "";
    let githubHead = "d".repeat(40);
    const getPullRequest = vi.fn(async () => {
      const record = [...records.values()].find((candidate) => candidate.entityType === "PULL_REQUEST");
      return {
        number: 3,
        url: "https://github.com/example/demo/pull/3",
        state: githubState,
        headBranch: record?.headBranch as string,
        baseBranch: "main",
        headCommit: githubHead,
        ...(githubState === "merged" ? { mergeCommit: "1".repeat(40) } : {}),
        title: githubTitle,
        body: githubBody,
      } as const;
    });
    const updatePullRequest = vi.fn(async (_url: string, _number: number, update: {
      title?: string; body?: string; state?: "open" | "closed";
    }) => {
      lifecycleOrdering.push("update");
      githubState = update.state ?? githubState;
      githubTitle = update.title ?? githubTitle;
      githubBody = update.body ?? githubBody;
      return { ...(await getPullRequest()), state: githubState, title: githubTitle, body: githubBody };
    });
    const codeBuildStart = vi.fn(async (input: { gate: string; projectName: string; commit: string }) => ({
      gate: input.gate,
      projectName: input.projectName,
      buildId: `${input.projectName}:${randomUUID()}`,
      status: "IN_PROGRESS" as const,
      requestedSourceVersion: input.commit,
    }));
    const codeBuildStatus = vi.fn(async (input: {
      gate: string; projectName: string; commit: string; buildId: string;
    }) => ({
      gate: input.gate,
      projectName: input.projectName,
      buildId: input.buildId,
      status: "SUCCEEDED" as const,
      requestedSourceVersion: input.commit,
      resolvedSourceVersion: input.commit,
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
      githubPullRequests: { reconcilePullRequest, getPullRequest, updatePullRequest },
      codeBuild: { start: codeBuildStart, status: codeBuildStatus },
      slack: { orchestratorRoleArn, memberWorkspaceLimit: 3, organizationWorkspaceLimit: 20 },
    });
    const requestId = randomUUID();
    const publicationEvent = {
      version: "2.0",
      rawPath: `/v1/service/workspaces/${workspaceId}/pull-requests`,
      headers: {
        "x-agentx-slack-thread": threadSubject,
        "x-agentx-slack-user": "U0123456789",
      },
      body: JSON.stringify({ requestId, repository: "demo", title: "Publish demo" }),
      requestContext: {
        requestId: "gateway-request",
        http: { method: "POST" },
        authorizer: { iam: { userArn: orchestratorPrincipal } },
      },
    } as const;
    const response = await handler(publicationEvent);
    expect(response.statusCode).toBe(202);

    // The same publication through the retired OIDC developer path is refused.
    const throughOidc = await handler({
      ...publicationEvent,
      rawPath: `/v1/workspaces/${workspaceId}/pull-requests`,
      headers: {},
      requestContext: {
        requestId: "gateway-request",
        http: { method: "POST" },
        authorizer: { jwt: { claims: { iss: "https://identity.example.test", sub: "alice" } } },
      },
    });
    expect(throughOidc.statusCode).toBe(403);
    expect(throughOidc.body).toContain("Slack");
    const body = JSON.parse(response.body) as { operation: { id: string; kind: string } };
    expect(body.operation.kind).toBe("publish");

    // The workspace stays on the revision its disk was prepared with, while readiness and the
    // CodeBuild gates come from the project's latest registered revision.
    const accepted = records.get(key(`WORKSPACE#${workspaceId}`, `OPERATION#${body.operation.id}`)) as {
      settingsRevision?: number;
      publication?: { codeBuildGates: Array<{ projectName: string }> };
    };
    expect(accepted.settingsRevision).toBe(2);
    expect(accepted.publication?.codeBuildGates).toEqual([
      { name: "quality", projectName: "agentx-demo-quality-v2", timeoutMinutes: 45 },
    ]);
    const dispatched = written.find((record) => record.entityType === "OUTBOX")?.invocation as {
      projectRevision: number;
      payload: { project: { revision: number; readiness: unknown[]; repositories: Array<{ path: string }> } };
    };
    expect(dispatched.projectRevision).toBe(1);
    expect(dispatched.payload.project.revision).toBe(1);
    expect(dispatched.payload.project.readiness).toEqual([
      { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 600 },
    ]);
    expect(dispatched.payload.project.repositories.map(({ path }) => path)).toEqual(["repo/demo", "repo/other"]);
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

    const buildCommit = "d".repeat(40);
    const startBuildEvent = {
      version: "2.0",
      rawPath: `/v1/internal/workspaces/${workspaceId}/operations/${body.operation.id}/codebuild`,
      headers: { "x-agentx-callback-capability": invocation.callbackCapability },
      body: JSON.stringify({
        action: "start",
        repository: "demo",
        gate: "quality",
        projectName: "agentx-demo-quality-v2",
        commit: buildCommit,
      }),
      requestContext: { requestId: "codebuild-start", http: { method: "POST" } },
    } as const;
    const startedBuild = await handler(startBuildEvent);
    expect(startedBuild.statusCode).toBe(200);
    const startedBuildBody = JSON.parse(startedBuild.body) as { buildId: string; status: string };
    expect(startedBuildBody.status).toBe("IN_PROGRESS");
    const repeatedStart = await handler(startBuildEvent);
    expect(repeatedStart.statusCode).toBe(200);
    const repeatedStartBody = JSON.parse(repeatedStart.body) as { buildId: string };
    expect(repeatedStartBody.buildId).toBe(startedBuildBody.buildId);
    expect(codeBuildStart).toHaveBeenCalledOnce();

    const statusBuild = await handler({
      ...startBuildEvent,
      body: JSON.stringify({
        action: "status",
        repository: "demo",
        gate: "quality",
        projectName: "agentx-demo-quality-v2",
        commit: buildCommit,
        buildId: startedBuildBody.buildId,
      }),
      requestContext: { requestId: "codebuild-status", http: { method: "POST" } },
    });
    expect(statusBuild.statusCode).toBe(200);
    expect(JSON.parse(statusBuild.body)).toMatchObject({ status: "SUCCEEDED", resolvedSourceVersion: buildCommit });
    const unscopedBuild = await handler({
      ...startBuildEvent,
      body: JSON.stringify({
        action: "start", repository: "demo", gate: "quality",
        projectName: "other-project", commit: buildCommit,
      }),
      requestContext: { requestId: "codebuild-unscoped", http: { method: "POST" } },
    });
    expect(JSON.parse(unscopedBuild.body)).toMatchObject({ error: { code: "CALLBACK_FORBIDDEN" } });
    expect(unscopedBuild.statusCode).toBe(409);
    expect(codeBuildStart).toHaveBeenCalledOnce();

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
      // A thread publication carries its Slack attribution into the pull request.
      body: `Requested in Slack thread https://slack.com/archives/${channelId}/p1758240000000100 by U0123456789.`,
    });

    const editRequestId = randomUUID();
    const editEvent = {
      version: "2.0",
      rawPath: `/v1/service/workspaces/${workspaceId}/pull-request-actions`,
      headers: {
        "x-agentx-slack-thread": threadSubject,
        "x-agentx-slack-user": "U0123456789",
      },
      body: JSON.stringify({
        requestId: editRequestId,
        repository: "demo",
        pullRequestNumber: 3,
        action: "edit",
        title: "Updated review title",
      }),
      requestContext: {
        requestId: "edit-request",
        http: { method: "POST" },
        authorizer: { iam: { userArn: orchestratorPrincipal } },
      },
    } as const;
    const edit = await handler(editEvent);
    expect(edit.statusCode).toBe(202);
    expect(JSON.parse(edit.body)).toMatchObject({
      operation: { kind: "maintain", status: "SUCCEEDED", result: { action: "edit", number: 3 } },
    });
    expect(updatePullRequest).toHaveBeenCalledWith(
      "https://github.com/example/demo.git",
      3,
      { title: "Updated review title" },
    );
    const duplicateEdit = await handler(editEvent);
    expect(JSON.parse(duplicateEdit.body)).toMatchObject({ duplicate: true });
    expect(updatePullRequest).toHaveBeenCalledTimes(1);

    githubHead = "e".repeat(40);
    const stale = await handler({
      ...editEvent,
      requestContext: { ...editEvent.requestContext, requestId: "stale-request" },
      body: JSON.stringify({
        requestId: randomUUID(), repository: "demo", pullRequestNumber: 3, action: "close",
      }),
    });
    expect(stale.statusCode).toBe(409);
    expect(JSON.parse(stale.body)).toMatchObject({ error: { code: "STALE_FENCE" } });
    const unauthorizedLifecycle = await handler({
      ...editEvent,
      headers: { ...editEvent.headers, "x-agentx-slack-thread": otherThreadSubject },
      requestContext: {
        requestId: "unauthorized-request",
        http: { method: "POST" },
        authorizer: { iam: { userArn: orchestratorPrincipal } },
      },
      body: JSON.stringify({
        requestId: randomUUID(), repository: "demo", pullRequestNumber: 3, action: "close",
      }),
    });
    expect(unauthorizedLifecycle.statusCode).toBe(404);

    githubHead = "d".repeat(40);
    githubState = "open";
    lifecycleOrdering.length = 0;
    const workspaceRecord = records.get(key(`WORKSPACE#${workspaceId}`, "META"));
    if (!workspaceRecord) throw new Error("workspace fixture is missing");
    Object.assign(workspaceRecord, { status: "READY", activeOperationId: null });
    reconciledPullRequestNumber = 4;
    const replacement = await handler({
      ...editEvent,
      requestContext: { ...editEvent.requestContext, requestId: "replacement-request" },
      body: JSON.stringify({
        requestId: randomUUID(), repository: "demo", pullRequestNumber: 3,
        action: "replace", title: "Clean replacement",
      }),
    });
    expect(replacement.statusCode).toBe(202);
    const replacementBody = JSON.parse(replacement.body) as { operation: { id: string } };
    const replacementOutbox = [...written].reverse().find((candidate) => {
      const candidateInvocation = candidate.invocation as { operationId?: string } | undefined;
      return candidate.entityType === "OUTBOX" && candidateInvocation?.operationId === replacementBody.operation.id;
    });
    const replacementInvocation = replacementOutbox?.invocation as {
      callbackCapability: string;
      payload: { headBranch: string };
    };
    const replacementCommit = "f".repeat(40);
    const replacementBuildStart = await handler({
      version: "2.0",
      rawPath: `/v1/internal/workspaces/${workspaceId}/operations/${replacementBody.operation.id}/codebuild`,
      headers: { "x-agentx-callback-capability": replacementInvocation.callbackCapability },
      body: JSON.stringify({
        action: "start", repository: "demo", gate: "quality",
        projectName: "agentx-demo-quality-v2", commit: replacementCommit,
      }),
      requestContext: { requestId: "replacement-build-start", http: { method: "POST" } },
    });
    const replacementBuild = JSON.parse(replacementBuildStart.body) as { buildId: string };
    await handler({
      version: "2.0",
      rawPath: `/v1/internal/workspaces/${workspaceId}/operations/${replacementBody.operation.id}/codebuild`,
      headers: { "x-agentx-callback-capability": replacementInvocation.callbackCapability },
      body: JSON.stringify({
        action: "status", repository: "demo", gate: "quality",
        projectName: "agentx-demo-quality-v2", commit: replacementCommit,
        buildId: replacementBuild.buildId,
      }),
      requestContext: { requestId: "replacement-build-status", http: { method: "POST" } },
    });
    const replacementCallback = await handler({
      version: "2.0",
      rawPath: `/v1/internal/workspaces/${workspaceId}/operations/${replacementBody.operation.id}/pull-request`,
      headers: { "x-agentx-callback-capability": replacementInvocation.callbackCapability },
      body: JSON.stringify({
        repository: "demo",
        repositoryUrl: "https://github.com/example/demo.git",
        headBranch: replacementInvocation.payload.headBranch,
        baseBranch: "main",
        commit: replacementCommit,
        title: "Clean replacement",
        body: "Clean replacement for #3.",
      }),
      requestContext: { requestId: "replacement-callback", http: { method: "POST" } },
    });
    expect(replacementCallback.statusCode).toBe(200);
    expect(lifecycleOrdering).toEqual(["create", "update"]);
    expect([...records.values()].find((candidate) =>
      candidate.entityType === "PULL_REQUEST" && candidate.number === 3)).toMatchObject({
      state: "closed",
      replacedBy: 4,
    });
    expect(written.find((candidate) =>
      candidate.entityType === "PULL_REQUEST" && candidate.number === 4)).toMatchObject({ replacementFor: 3 });

    Object.assign(workspaceRecord, { status: "READY", activeOperationId: null });
    const revertEvent = {
      ...editEvent,
      requestContext: { ...editEvent.requestContext, requestId: "revert-request" },
      body: JSON.stringify({
        requestId: randomUUID(), repository: "demo", pullRequestNumber: 3, action: "revert",
      }),
    } as const;
    const unmergedRevert = await handler(revertEvent);
    expect(unmergedRevert.statusCode).toBe(400);
    githubState = "merged";
    const mergedRevert = await handler({
      ...revertEvent,
      requestContext: { ...revertEvent.requestContext, requestId: "merged-revert-request" },
      body: JSON.stringify({
        requestId: randomUUID(), repository: "demo", pullRequestNumber: 3, action: "revert",
      }),
    });
    expect(mergedRevert.statusCode).toBe(202);
    const mergedRevertBody = JSON.parse(mergedRevert.body) as { operation: { id: string } };
    const revertOutbox = [...written].reverse().find((candidate) => {
      const candidateInvocation = candidate.invocation as { operationId?: string } | undefined;
      return candidate.entityType === "OUTBOX" && candidateInvocation?.operationId === mergedRevertBody.operation.id;
    });
    expect(revertOutbox?.invocation).toMatchObject({
      kind: "publish",
      payload: { mode: "revert", targetPullRequestNumber: 3, revertCommit: "1".repeat(40) },
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
      headers: { ...publicationEvent.headers, "x-agentx-slack-thread": otherThreadSubject },
      requestContext: {
        requestId: "unauthorized-request",
        http: { method: "POST" },
        authorizer: { iam: { userArn: orchestratorPrincipal } },
      },
    });
    expect(unauthorized.statusCode).toBe(404);
    expect(JSON.parse(unauthorized.body)).toMatchObject({ error: { code: "NOT_FOUND" } });
  });
});
