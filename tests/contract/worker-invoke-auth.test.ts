import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  WORKER_INVOKE_AUTHORIZATION_SCHEME,
  workerInvokeToken,
  workerInvokeTokenPayload,
  type WorkerInvocation,
  type WorkerInvokeTokenClaims,
} from "../../packages/contracts/src/index.js";
import {
  OperationJournal,
  createWorkerServerState,
  handleWorkerRequest,
  invokeAuthenticationFromEnvironment,
  invokePublicKey,
  type InvokeAuthentication,
} from "../../packages/worker/src/index.js";

const NOW = 1_790_000_000;
const signer = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const workspaceId = randomUUID();

// Signs as KMS does for ECDSA_SHA_256: SHA-256 over the payload bytes, DER-encoded signature.
function tokenFor(claims: WorkerInvokeTokenClaims, privateKey: KeyObject = signer.privateKey): string {
  const payload = workerInvokeTokenPayload(claims);
  return workerInvokeToken(payload, sign("sha256", Buffer.from(payload, "ascii"), privateKey));
}

function invocationFor(operationId = randomUUID(), fence = 2): WorkerInvocation {
  return {
    protocolVersion: 1,
    kind: "resume",
    operationId,
    workspaceId,
    fence,
    projectRevision: 1,
    callbackCapability: "c".repeat(64),
    payload: {},
  };
}

function claimsFor(invocation: WorkerInvocation, overrides: Partial<WorkerInvokeTokenClaims> = {}): WorkerInvokeTokenClaims {
  return {
    workspaceId: invocation.workspaceId,
    generation: 3,
    operationId: invocation.operationId,
    fence: invocation.fence,
    expiresAt: NOW + 60,
    ...overrides,
  };
}

async function workerState(authentication?: InvokeAuthentication) {
  const journal = new OperationJournal(await mkdtemp(join(tmpdir(), "agentx-invoke-auth-")));
  const execute = vi.fn(async () => undefined);
  return { journal, execute, state: createWorkerServerState(journal, { execute }, {}, authentication) };
}

const authentication: InvokeAuthentication = { publicKey: signer.publicKey, workspaceId, generation: 3, now: () => NOW };

function post(invocation: WorkerInvocation, authorization?: string): Request {
  return new Request("http://worker/invocations", {
    method: "POST",
    headers: { "content-type": "application/json", ...(authorization === undefined ? {} : { authorization }) },
    body: JSON.stringify(invocation),
  });
}

describe("an EC2 worker authenticating invocations", () => {
  it("accepts a token signed for its workspace, generation, operation and fence", async () => {
    const { state, journal } = await workerState(authentication);
    const invocation = invocationFor();
    const accepted = await handleWorkerRequest(post(invocation, `AgentX-Invoke ${tokenFor(claimsFor(invocation))}`), state);
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({ accepted: true, operationId: invocation.operationId });
    expect(await journal.get(invocation.operationId)).toBeDefined();
  });

  it.each([
    ["missing header", () => undefined, "missing"],
    ["another scheme", (claims: WorkerInvokeTokenClaims) => `Bearer ${tokenFor(claims)}`, "missing"],
    ["wrong workspace", (claims: WorkerInvokeTokenClaims) => `AgentX-Invoke ${tokenFor({ ...claims, workspaceId: randomUUID() })}`, "wrong_workspace"],
    ["wrong generation", (claims: WorkerInvokeTokenClaims) => `AgentX-Invoke ${tokenFor({ ...claims, generation: 2 })}`, "wrong_generation"],
    ["expired", (claims: WorkerInvokeTokenClaims) => `AgentX-Invoke ${tokenFor({ ...claims, expiresAt: NOW })}`, "expired"],
    ["another key's signature", (claims: WorkerInvokeTokenClaims) =>
      `AgentX-Invoke ${tokenFor(claims, generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey)}`, "bad_signature"],
    ["tampered claims", (claims: WorkerInvokeTokenClaims) => {
      const [, signature] = tokenFor(claims).split(".");
      return `AgentX-Invoke ${workerInvokeTokenPayload({ ...claims, generation: 3, expiresAt: NOW + 86_400 })}.${signature}`;
    }, "bad_signature"],
    ["no signature", (claims: WorkerInvokeTokenClaims) => `AgentX-Invoke ${workerInvokeTokenPayload(claims)}`, "malformed"],
    ["garbage", () => "AgentX-Invoke not a token!", "malformed"],
  ] as const)("refuses %s with 401 before reading or journaling the invocation", async (_name, header, reason) => {
    const { state, journal, execute } = await workerState(authentication);
    const invocation = invocationFor();
    const request = post(invocation, header(claimsFor(invocation)));
    const refused = await handleWorkerRequest(request, state);
    expect(refused.status).toBe(401);
    await expect(refused.json()).resolves.toEqual({ error: "invocation is not authorized", reason });
    expect(request.bodyUsed).toBe(false);
    expect(await journal.get(invocation.operationId)).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses a valid token presented with a different operation or fence", async () => {
    const { state, journal } = await workerState(authentication);
    const signedFor = invocationFor();
    const token = `AgentX-Invoke ${tokenFor(claimsFor(signedFor))}`;
    for (const other of [invocationFor(), invocationFor(signedFor.operationId, signedFor.fence + 1)]) {
      const refused = await handleWorkerRequest(post(other, token), state);
      expect(refused.status).toBe(401);
      await expect(refused.json()).resolves.toMatchObject({ reason: "invocation_mismatch" });
      expect(await journal.get(other.operationId)).toBeUndefined();
    }
  });

  it("keeps /ping unauthenticated for health probes", async () => {
    const { state } = await workerState(authentication);
    const ping = await handleWorkerRequest(new Request("http://worker/ping"), state);
    expect(ping.status).toBe(200);
    await expect(ping.json()).resolves.toMatchObject({ status: "Healthy" });
  });

  it("uses the shared scheme name", () => {
    expect(WORKER_INVOKE_AUTHORIZATION_SCHEME).toBe("AgentX-Invoke");
  });
});

describe("an AgentCore worker", () => {
  it("still accepts invocations without a token, since AgentCore is its only way in", async () => {
    const { state } = await workerState();
    const accepted = await handleWorkerRequest(post(invocationFor()), state);
    expect(accepted.status).toBe(200);
  });
});

describe("invoke authentication configuration", () => {
  const spki = signer.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const complete = { AGENTX_INVOKE_PUBLIC_KEY: spki, AGENTX_WORKSPACE_ID: workspaceId, AGENTX_SESSION_GENERATION: "3" };

  it("is off with none of its variables and on with all of them", () => {
    expect(invokeAuthenticationFromEnvironment({})).toBeUndefined();
    expect(invokeAuthenticationFromEnvironment(complete)).toMatchObject({ workspaceId, generation: 3 });
  });

  it("refuses to start when partly configured or given invalid values", () => {
    expect(() => invokeAuthenticationFromEnvironment({ AGENTX_INVOKE_PUBLIC_KEY: spki }))
      .toThrow(/missing AGENTX_WORKSPACE_ID, AGENTX_SESSION_GENERATION/);
    expect(() => invokeAuthenticationFromEnvironment({ ...complete, AGENTX_WORKSPACE_ID: "workspace" })).toThrow(/UUID/);
    for (const generation of ["0", "-1", "1.5", "01", "x"]) {
      expect(() => invokeAuthenticationFromEnvironment({ ...complete, AGENTX_SESSION_GENERATION: generation }))
        .toThrow(/positive integer/);
    }
  });

  it("reads the key as KMS GetPublicKey returns it or as PEM, and only a P-256 EC key", () => {
    const pem = signer.publicKey.export({ format: "pem", type: "spki" }).toString();
    expect(invokePublicKey(spki).equals(signer.publicKey)).toBe(true);
    expect(invokePublicKey(pem).equals(signer.publicKey)).toBe(true);
    const otherCurve = generateKeyPairSync("ec", { namedCurve: "secp384r1" }).publicKey.export({ format: "pem", type: "spki" }).toString();
    expect(() => invokePublicKey(otherCurve)).toThrow(/P-256/);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ format: "pem", type: "spki" }).toString();
    expect(() => invokePublicKey(rsa)).toThrow(/P-256/);
  });
});
