import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mintCallbackCapability, verifyCallbackCapability } from "../src/capability.js";

const key = randomBytes(32);

function target() {
  return { workspaceId: randomUUID(), operationId: randomUUID(), fence: 3 };
}

function mint(overrides: Partial<{ expiresAt: string; fence: number }> = {}) {
  const bound = target();
  const capability = mintCallbackCapability({
    key,
    ...bound,
    fence: overrides.fence ?? bound.fence,
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 60_000).toISOString(),
  });
  return { ...bound, capability };
}

describe("callback capability", () => {
  it("accepts only the exact workspace, operation and fence it was minted for", () => {
    const { capability, workspaceId, operationId, fence } = mint();

    expect(verifyCallbackCapability({ key, capability, workspaceId, operationId, fence }).operationId)
      .toBe(operationId);

    for (const wrong of [
      { workspaceId: randomUUID(), operationId, fence },
      { workspaceId, operationId: randomUUID(), fence },
      { workspaceId, operationId, fence: fence + 1 },
      { workspaceId, operationId, fence: fence - 1 },
    ]) {
      expect(() => verifyCallbackCapability({ key, capability, ...wrong })).toThrow(/CALLBACK_FORBIDDEN/);
    }
  });

  it("refuses an expired capability", () => {
    const { capability, workspaceId, operationId, fence } = mint({
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    expect(() => verifyCallbackCapability({ key, capability, workspaceId, operationId, fence }))
      .toThrow(/CALLBACK_FORBIDDEN/);
  });

  it("refuses a tampered payload, a tampered signature and a foreign key", () => {
    const { capability, workspaceId, operationId, fence } = mint();
    const [payload, signature] = capability.split(".") as [string, string];
    const forged = Buffer.from(
      JSON.stringify({ workspaceId, operationId, fence: fence + 9, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    ).toString("base64url");

    for (const bad of [
      `${forged}.${signature}`,
      `${payload}.${Buffer.from(randomBytes(32)).toString("base64url")}`,
      payload,
      `${payload}.${signature}.extra`,
      "",
    ]) {
      expect(() => verifyCallbackCapability({ key, capability: bad, workspaceId, operationId, fence }))
        .toThrow(/CALLBACK_FORBIDDEN/);
    }

    expect(() => verifyCallbackCapability({
      key: randomBytes(32), capability, workspaceId, operationId, fence,
    })).toThrow(/CALLBACK_FORBIDDEN/);
  });

  it("is authenticated, not confidential, and carries no secret", () => {
    const { capability, workspaceId, operationId, fence } = mint();
    const payload = JSON.parse(
      Buffer.from(capability.split(".")[0]!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;

    // Anyone holding the capability can read these claims. That is expected: an HMAC
    // authenticates a payload, it does not hide it. Nothing secret may be placed here.
    expect(Object.keys(payload).sort()).toEqual(["expiresAt", "fence", "operationId", "workspaceId"]);
    expect(payload.workspaceId).toBe(workspaceId);
    expect(payload.operationId).toBe(operationId);
    expect(payload.fence).toBe(fence);
    expect(typeof payload.expiresAt).toBe("string");
    expect(Object.keys(payload).some((name) => /key|secret|token|credential/i.test(name))).toBe(false);
  });
});
