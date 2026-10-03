import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { createSessionStepsHandler, pingWorker, type SessionStepsDependencies } from "../../packages/broker/src/aws/session-steps.js";
import { ec2WorkerBootScript } from "../../packages/contracts/src/session.js";

const bootScript = readFileSync(new URL("../../packages/worker/ec2/boot.sh", import.meta.url), "utf8");
const workspaceId = randomUUID();

function setup(ping: SessionStepsDependencies["ping"] = async () => ({ status: "Healthy" })) {
  const sessions = {
    markVolume: vi.fn(async () => undefined),
    markInstance: vi.fn(async () => undefined),
    markReady: vi.fn(async () => ({ requeued: ["r"] })),
    markFailed: vi.fn(async () => ({ failed: [] })),
    markDeleted: vi.fn(async () => undefined),
  };
  const pingSpy = vi.fn(ping);
  const handler = createSessionStepsHandler({
    sessions,
    workerSettings: async () => ({
      workerImage: `111122223333.dkr.ecr.us-east-1.amazonaws.com/agentx-worker-production@sha256:${"a".repeat(64)}`,
      modelProvider: "amazon-bedrock",
      modelId: "us.anthropic.claude-sonnet-4-6",
      promptCacheRetention: "long",
      openRouterSecretArn: "arn:aws:secretsmanager:us-east-1:111122223333:secret:agentx/production/openrouter-AbCdEf",
      openRouterProviders: "anthropic,amazon-bedrock",
      anthropicSecretArn: "arn:aws:secretsmanager:us-east-1:111122223333:secret:agentx/production/anthropic-AbCdEf",
      openaiSecretArn: "arn:aws:secretsmanager:us-east-1:111122223333:secret:agentx/production/openai-AbCdEf",
    }),
    // Full length, as KMS returns a P-256 public key, so the user data size check is realistic.
    invokePublicKey: async () => `MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE${"A".repeat(88)}`,
    bootScript: () => bootScript,
    controlPlaneUrl: "https://abc.execute-api.us-east-1.amazonaws.com",
    logGroupName: "/agentx/production/worker",
    ping: pingSpy,
  });
  return { handler, sessions, ping: pingSpy };
}

describe("session steps", () => {
  it("renders the boot script as base64 gzip user data for one generation's volume (#229)", async () => {
    const { handler } = setup();
    const result = await handler({ action: "launchConfiguration", workspaceId, generation: 2, volumeId: "vol-0123456789abcdef0", expectNewVolume: false }) as { userData: string };
    // RunInstances takes UserData as base64, once; EC2 hands cloud-init the gzip, which it decompresses.
    const raw = Buffer.from(result.userData, "base64");
    expect([...raw.subarray(0, 2)]).toEqual([0x1f, 0x8b]);
    expect(raw.length).toBeLessThan(16_384);
    const userData = gunzipSync(raw).toString("utf8");
    expect(userData.startsWith("#!/bin/bash\n")).toBe(true);
    expect(userData).toContain(`export AGENTX_WORKSPACE_ID='${workspaceId}'`);
    expect(userData).toContain("export AGENTX_SESSION_GENERATION='2'");
    expect(userData).toContain("export AGENTX_EXPECT_NEW_VOLUME='false'");
    expect(userData).toContain("export AGENTX_MODEL_ID='us.anthropic.claude-sonnet-4-6'");
    expect(userData).toContain("export AGENTX_LOG_GROUP='/agentx/production/worker'");
    expect(userData).toContain('main "$@"');
    expect(userData).toBe(ec2WorkerBootScript({
      workspaceId,
      generation: 2,
      volumeId: "vol-0123456789abcdef0",
      expectNewVolume: false,
      workerImage: `111122223333.dkr.ecr.us-east-1.amazonaws.com/agentx-worker-production@sha256:${"a".repeat(64)}`,
      invokePublicKey: `MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE${"A".repeat(88)}`,
      controlPlaneUrl: "https://abc.execute-api.us-east-1.amazonaws.com",
      modelProvider: "amazon-bedrock",
      modelId: "us.anthropic.claude-sonnet-4-6",
      promptCacheRetention: "long",
      openRouterSecretArn: "arn:aws:secretsmanager:us-east-1:111122223333:secret:agentx/production/openrouter-AbCdEf",
      openRouterProviders: "anthropic,amazon-bedrock",
      anthropicSecretArn: "arn:aws:secretsmanager:us-east-1:111122223333:secret:agentx/production/anthropic-AbCdEf",
      openaiSecretArn: "arn:aws:secretsmanager:us-east-1:111122223333:secret:agentx/production/openai-AbCdEf",
      logGroupName: "/agentx/production/worker",
    }, bootScript));
    expect(userData).toContain("export AGENTX_ANTHROPIC_SECRET_ARN='arn:aws:secretsmanager:us-east-1:111122223333:secret:agentx/production/anthropic-AbCdEf'");
    expect(userData).toContain("export AGENTX_OPENAI_SECRET_ARN='arn:aws:secretsmanager:us-east-1:111122223333:secret:agentx/production/openai-AbCdEf'");
  });

  it("records the volume and instance, and marks the session ready, failed or deleted", async () => {
    const { handler, sessions } = setup();
    await handler({ action: "recordVolume", workspaceId, generation: 1, volumeId: "vol-0123456789abcdef0" });
    await handler({ action: "recordInstance", workspaceId, generation: 1, instanceId: "i-0123456789abcdef0", privateIp: "10.42.128.10" });
    expect(await handler({ action: "markReady", workspaceId, generation: 1 })).toEqual({ requeued: ["r"] });
    await handler({ action: "markFailed", workspaceId, generation: 1, error: "boom" });
    await handler({ action: "markDeleted", workspaceId });
    expect(sessions.markVolume).toHaveBeenCalledWith(workspaceId, 1, "vol-0123456789abcdef0");
    expect(sessions.markInstance).toHaveBeenCalledWith(workspaceId, 1, "i-0123456789abcdef0", "10.42.128.10");
    expect(sessions.markFailed).toHaveBeenCalledWith(workspaceId, 1, "boom");
    expect(sessions.markDeleted).toHaveBeenCalledWith(workspaceId);
  });

  it.each([
    ["Healthy", async () => ({ status: "Healthy" }), { healthy: true, status: "Healthy" }],
    ["HealthyBusy", async () => ({ status: "HealthyBusy" }), { healthy: true, status: "HealthyBusy" }],
    ["unreachable", async () => { throw new Error("connect ECONNREFUSED"); }, { healthy: false, status: "Unreachable" }],
    ["no status", async () => undefined, { healthy: false, status: "Unreachable" }],
    ["an empty answer", async () => ({}), { healthy: false, status: "Unreachable" }],
  ] as const)("probes the worker's /ping on its private address: %s", async (_name, ping, expected) => {
    const { handler, ping: spy } = setup(ping);
    expect(await handler({ action: "probePing", privateIp: "10.42.128.10" })).toEqual(expected);
    expect(spy).toHaveBeenCalledWith("http://10.42.128.10:8080/ping");
  });

  // #211: a failed boot answers /ping with its reason, so the probe fails the provisioning at once
  // (ProbePing's Catch goes to Cleanup) instead of waiting out the 10 minute /ping window.
  it("fails the probe at once with the reason a failed boot reports", async () => {
    const { handler } = setup(async () => ({ status: "BootFailed", reason: "could not install Docker: package download failed after 5 tries" }));
    const probe = handler({ action: "probePing", privateIp: "10.42.128.10" });
    await expect(probe).rejects.toThrow("could not install Docker: package download failed after 5 tries");
    await expect(probe).rejects.toMatchObject({ name: "WorkerBootFailed", stack: "WorkerBootFailed: could not install Docker: package download failed after 5 tries" });
  });

  it("keeps a reported boot failure reason to one short line of plain text", async () => {
    const { handler } = setup(async () => ({ status: "BootFailed", reason: `bad\u0000\nline\t${"x".repeat(1_000)}` }));
    const error: Error = await handler({ action: "probePing", privateIp: "10.42.128.10" }).then(() => new Error("the probe did not fail"), (failure: unknown) => failure as Error);
    expect(error).toMatchObject({ name: "WorkerBootFailed" });
    expect(error.message.startsWith("bad line x")).toBe(true);
    expect(error.message).toHaveLength(300);
    const { handler: unexplained } = setup(async () => ({ status: "BootFailed", reason: 42 as unknown as string }));
    await expect(unexplained({ action: "probePing", privateIp: "10.42.128.10" })).rejects.toThrow("the boot script failed without a reason");
  });

  it("names a reported boot failure in plain words when the session is marked failed", async () => {
    const { handler, sessions } = setup();
    // What ProbePing's Catch hands MarkFailed: the Lambda error's type, then its payload as JSON.
    const cause = JSON.stringify({ errorType: "WorkerBootFailed", errorMessage: "could not install Docker: package download failed after 5 tries", trace: ["WorkerBootFailed: could not install Docker", "    at probe (session-steps.js:1:1)"] });
    await handler({ action: "markFailed", workspaceId, generation: 1, error: `WorkerBootFailed: ${cause}` });
    expect(sessions.markFailed).toHaveBeenCalledWith(workspaceId, 1, "worker boot failed: could not install Docker: package download failed after 5 tries");
    // Any other failure text is passed on as it is.
    await handler({ action: "markFailed", workspaceId, generation: 1, error: "worker did not answer /ping within 10 minutes" });
    expect(sessions.markFailed).toHaveBeenLastCalledWith(workspaceId, 1, "worker did not answer /ping within 10 minutes");
    // MarkFailed cuts its input at 4000 characters, which can leave the payload incomplete.
    await handler({ action: "markFailed", workspaceId, generation: 1, error: `WorkerBootFailed: ${cause.slice(0, 120)}` });
    expect(sessions.markFailed).toHaveBeenLastCalledWith(workspaceId, 1, "worker boot failed: could not install Docker: package download failed after 5 tries");
    await handler({ action: "markFailed", workspaceId, generation: 1, error: "WorkerBootFailed: not json" });
    expect(sessions.markFailed).toHaveBeenLastCalledWith(workspaceId, 1, "worker boot failed (no reason recorded)");
  });

  it("reads the worker's status, and a failed boot's reason, from /ping whatever the HTTP status", async () => {
    const answers: Record<string, [number, string]> = {
      "/healthy": [200, JSON.stringify({ status: "Healthy" })],
      "/failed": [503, JSON.stringify({ status: "BootFailed", reason: "could not download the worker image after 5 tries" })],
      "/garbage": [500, "<html>"],
    };
    const server = createServer((request, response) => {
      const [status, body] = answers[request.url ?? ""] ?? [404, ""];
      response.writeHead(status, { "content-type": "application/json" }).end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect(await pingWorker(`${base}/healthy`)).toEqual({ status: "Healthy" });
      expect(await pingWorker(`${base}/failed`)).toEqual({ status: "BootFailed", reason: "could not download the worker image after 5 tries" });
      await expect(pingWorker(`${base}/garbage`)).rejects.toThrow();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("refuses unknown steps and anything but a private IPv4 address to probe", async () => {
    const { handler, ping } = setup();
    await expect(handler({ action: "launchInstance" })).rejects.toThrow();
    await expect(handler({ action: "probePing", privateIp: "example.com" })).rejects.toThrow();
    await expect(handler({ action: "markReady", workspaceId, generation: 1, extra: true })).rejects.toThrow();
    expect(ping).not.toHaveBeenCalled();
  });
});
