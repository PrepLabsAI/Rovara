import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  adaptHttpApiEvent,
  identityFromJwtClaims,
  parseRuntimeBinding,
} from "../../packages/broker/src/aws/lambda.js";
import { createOutboxPublisherHandler } from "../../packages/broker/src/aws/outbox-publisher.js";
import { createDispatcherHandler } from "../../packages/broker/src/aws/dispatcher.js";

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
});
