import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  WORKER_INVOKE_AUTHORIZATION_SCHEME,
  workerInvokeToken,
  workerInvokeTokenPayload,
  WorkerInvokeTokenClaimsSchema,
  workflowPublicationContext,
  workflowPublicationContextDigest,
  type WorkerInvocation,
  type WorkerInvokeTokenClaims,
} from "../../packages/contracts/src/index.js";
import {
  OperationJournal,
  createWorkerServerState,
  handleWorkerRequest,
  invokeAuthenticationFromEnvironment,
  invokePublicKey,
  verifyInvokeAuthorization,
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

function invocationFor(operationId: WorkerInvocation["operationId"] = randomUUID(), fence = 2): WorkerInvocation {
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
    purpose: "WORKSPACE",
    ...(invocation.kind === "publish" && invocation.payload.publicationMode !== undefined
      ? { publicationMode: invocation.payload.publicationMode, publicationContextDigest: invocation.payload.publicationContextDigest }
      : {}),
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

  it("requires a signed publication mode to match the candidate-tree invocation", async () => {
    const { state, journal, execute } = await workerState(authentication);
    const invocation = {
      protocolVersion: 1 as const,
      kind: "publish" as const,
      operationId: randomUUID(),
      workspaceId,
      fence: 2,
      projectRevision: 1,
      callbackCapability: "c".repeat(64),
      payload: {
        mode: "create" as const,
        project: { name: "demo", revision: 1, setup: [], readiness: [], orchestratorInstructions: "x",
          repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }] },
        repository: "demo", title: "test", headBranch: `agentx/${randomUUID()}`,
        repositoryGrant: "grant", candidateTreeSha: "a".repeat(40),
        candidateCommitSha: "b".repeat(40), workflowBaseCommit: "c".repeat(40),
        publicationMode: "COMMITTED_HEAD" as const,
      },
    } as WorkerInvocation;
    const context = workflowPublicationContext(invocation);
    if (context === undefined || invocation.kind !== "publish") throw new Error("test publication context should be complete");
    invocation.payload.publicationContextDigest = workflowPublicationContextDigest(context);
    const positive = await workerState(authentication);
    const validToken = `AgentX-Invoke ${tokenFor(claimsFor(invocation))}`;
    const accepted = await handleWorkerRequest(post(invocation, validToken), positive.state);
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({ accepted: true, operationId: invocation.operationId });
    expect(await positive.journal.get(invocation.operationId)).toBeDefined();

    const signedFor = claimsFor(invocation, { publicationMode: "CHECKED_TREE" });
    const token = tokenFor(signedFor);
    expect(WorkerInvokeTokenClaimsSchema.safeParse(signedFor).success).toBe(true);
    const [encodedPayload, encodedSignature] = token.split(".");
    expect(token.length).toBeLessThan(2_048);
    expect(WorkerInvokeTokenClaimsSchema.safeParse(JSON.parse(Buffer.from(encodedPayload!, "base64url").toString("utf8"))).success).toBe(true);
    expect(encodedPayload).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(encodedSignature).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(verifyInvokeAuthorization(`AgentX-Invoke ${token}`, authentication)).toMatchObject({ ok: true });
    const refused = await handleWorkerRequest(post(invocation, `AgentX-Invoke ${token}`), state);
    expect(refused.status).toBe(401);
    await expect(refused.json()).resolves.toMatchObject({ reason: "invocation_mismatch" });
    expect(await journal.get(invocation.operationId)).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects same-token publication candidate and destination mutations before journaling", async () => {
    const { state, journal, execute } = await workerState(authentication);
    const original = {
      protocolVersion: 1 as const,
      kind: "publish" as const,
      operationId: randomUUID(),
      workspaceId,
      fence: 4,
      projectRevision: 2,
      callbackCapability: "c".repeat(64),
      payload: {
        mode: "create" as const,
        project: { name: "demo", revision: 2, setup: [], readiness: [], orchestratorInstructions: "x",
          repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }] },
        repository: "demo", title: "test", headBranch: `agentx/${randomUUID()}`,
        repositoryGrant: "grant", candidateTreeSha: "a".repeat(40), candidateCommitSha: "b".repeat(40),
        workflowBaseCommit: "c".repeat(40), publicationMode: "COMMITTED_HEAD" as const,
      },
    } as WorkerInvocation;
    if (original.kind !== "publish") throw new Error("test invocation should publish");
    const originalContext = workflowPublicationContext(original)!;
    original.payload.publicationContextDigest = workflowPublicationContextDigest(originalContext);
    const token = `AgentX-Invoke ${tokenFor(claimsFor(original))}`;
    const wrongRepo = { ...original.payload.project.repositories[0]!, name: "other" };
    const mutations: WorkerInvocation[] = [
      { ...original, projectRevision: original.projectRevision + 1 },
      { ...original, payload: { ...original.payload, repository: "other", project: { ...original.payload.project, repositories: [wrongRepo] } } },
      { ...original, payload: { ...original.payload, project: { ...original.payload.project, repositories: [{ ...original.payload.project.repositories[0]!, url: "https://github.com/other/demo.git" }] } } },
      { ...original, payload: { ...original.payload, project: { ...original.payload.project, repositories: [{ ...original.payload.project.repositories[0]!, path: "other/demo" }] } } },
      { ...original, payload: { ...original.payload, project: { ...original.payload.project, repositories: [{ ...original.payload.project.repositories[0]!, defaultBranch: "trunk" }] } } },
      { ...original, payload: { ...original.payload, headBranch: `agentx/${randomUUID()}` } },
      { ...original, payload: { ...original.payload, candidateTreeSha: "d".repeat(40) } },
      { ...original, payload: { ...original.payload, candidateCommitSha: "e".repeat(40) } },
      { ...original, payload: { ...original.payload, workflowBaseCommit: "f".repeat(40) } },
    ];
    for (const [mutationIndex, changed] of mutations.entries()) {
      const refused = await handleWorkerRequest(post(changed, token), state);
      const response = await refused.json() as { reason?: string };
      expect(refused.status, `mutation ${mutationIndex} returned ${JSON.stringify(response)}`).toBe(401);
      expect(response).toMatchObject({ reason: "invocation_mismatch" });
      expect(await journal.get(changed.operationId)).toBeUndefined();
    }
    expect(execute).not.toHaveBeenCalled();
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

describe("invoke authentication configuration", () => {
  const spki = signer.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const complete = { AGENTX_INVOKE_PUBLIC_KEY: spki, AGENTX_WORKSPACE_ID: workspaceId, AGENTX_SESSION_GENERATION: "3" };

  it("requires all boot authentication variables", () => {
    expect(() => invokeAuthenticationFromEnvironment({})).toThrow(/missing/);
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
