import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createSessionStepsHandler, type SessionStepsDependencies } from "../../packages/broker/src/aws/session-steps.js";

const bootScript = readFileSync(new URL("../../packages/worker/ec2/boot.sh", import.meta.url), "utf8");
const workspaceId = randomUUID();

function setup(ping: SessionStepsDependencies["ping"] = async () => "Healthy") {
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
      modelId: "amazon.nova-pro-v1:0",
      promptCacheRetention: "long",
    }),
    invokePublicKey: async () => "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE",
    bootScript: () => bootScript,
    controlPlaneUrl: "https://abc.execute-api.us-east-1.amazonaws.com",
    logGroupName: "/agentx/production/worker",
    ping: pingSpy,
  });
  return { handler, sessions, ping: pingSpy };
}

describe("session steps", () => {
  it("renders the boot script as base64 user data for one generation's volume", async () => {
    const { handler } = setup();
    const result = await handler({ action: "launchConfiguration", workspaceId, generation: 2, volumeId: "vol-0123456789abcdef0", expectNewVolume: false }) as { userData: string };
    const userData = Buffer.from(result.userData, "base64").toString("utf8");
    expect(userData.startsWith("#!/bin/bash\n")).toBe(true);
    expect(userData).toContain(`export AGENTX_WORKSPACE_ID='${workspaceId}'`);
    expect(userData).toContain("export AGENTX_SESSION_GENERATION='2'");
    expect(userData).toContain("export AGENTX_EXPECT_NEW_VOLUME='false'");
    expect(userData).toContain("export AGENTX_MODEL_ID='amazon.nova-pro-v1:0'");
    expect(userData).toContain("export AGENTX_LOG_GROUP='/agentx/production/worker'");
    expect(userData).toContain('main "$@"');
    // EC2 limits user data to 16 KB before encoding.
    expect(Buffer.byteLength(userData)).toBeLessThan(16_384);
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
    ["Healthy", async () => "Healthy", { healthy: true, status: "Healthy" }],
    ["HealthyBusy", async () => "HealthyBusy", { healthy: true, status: "HealthyBusy" }],
    ["unreachable", async () => { throw new Error("connect ECONNREFUSED"); }, { healthy: false, status: "Unreachable" }],
    ["no status", async () => undefined, { healthy: false, status: "Unreachable" }],
  ] as const)("probes the worker's /ping on its private address: %s", async (_name, ping, expected) => {
    const { handler, ping: spy } = setup(ping);
    expect(await handler({ action: "probePing", privateIp: "10.42.128.10" })).toEqual(expected);
    expect(spy).toHaveBeenCalledWith("http://10.42.128.10:8080/ping");
  });

  it("refuses unknown steps and anything but a private IPv4 address to probe", async () => {
    const { handler, ping } = setup();
    await expect(handler({ action: "launchInstance" })).rejects.toThrow();
    await expect(handler({ action: "probePing", privateIp: "example.com" })).rejects.toThrow();
    await expect(handler({ action: "markReady", workspaceId, generation: 1, extra: true })).rejects.toThrow();
    expect(ping).not.toHaveBeenCalled();
  });
});
