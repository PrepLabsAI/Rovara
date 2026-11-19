// Port lane L4: the key that signs worker invocations. Cloud signs with a KMS key; a local worker gets the public half at boot (as
// `AGENTX_INVOKE_PUBLIC_KEY`) and accepts only invocations signed by the private half, for its own workspace, within a minute.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { WORKER_INVOKE_AUTHORIZATION_SCHEME, workerInvokeToken, workerInvokeTokenPayload, type WorkerInvocation, type WorkerInvokeTokenClaims } from "@agentx/contracts";
import { INVOKE_KEY_FILE_NAME, readOwnerFile, writeOwnerFile } from "./state-directory.js";
import { join } from "node:path";

/** A token outlives one delivery attempt and nothing more (the same lifetime Cloud's dispatcher uses). */
export const INVOKE_TOKEN_LIFETIME_SECONDS = 60;

export interface InvokeSigner {
  /** The base64 DER SubjectPublicKeyInfo the worker accepts for `AGENTX_INVOKE_PUBLIC_KEY`. */
  publicKey(): string;
  /** `AgentX-Invoke <token>` for this invocation and this machine generation, valid for one delivery. */
  authorization(invocation: WorkerInvocation, nowMs: number, generation: number): string;
}

export function createInvokeSigner(privateKey: KeyObject): InvokeSigner {
  if (privateKey.asymmetricKeyType !== "ec" || privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("the invoke key must be a P-256 EC key");
  const publicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" }).toString("base64");
  return {
    publicKey: () => publicKey,
    authorization(invocation, nowMs, generation) {
      const claims: WorkerInvokeTokenClaims = {
        workspaceId: invocation.workspaceId,
        generation,
        operationId: invocation.operationId,
        fence: invocation.fence,
        expiresAt: Math.floor(nowMs / 1_000) + INVOKE_TOKEN_LIFETIME_SECONDS,
        ...(invocation.kind === "project-setup-smoke"
          ? { purpose: "PROJECT_SETUP" as const, setupExecutionId: invocation.payload.setupExecutionId, setupSubjectId: invocation.payload.subjectId, setupApprovalRevision: invocation.payload.approvalRevision }
          : {
              purpose: "WORKSPACE" as const,
              ...(invocation.kind === "publish" && invocation.payload.publicationMode !== undefined
                ? { publicationMode: invocation.payload.publicationMode, publicationContextDigest: invocation.payload.publicationContextDigest }
                : {}),
            }),
      };
      const payload = workerInvokeTokenPayload(claims);
      const signature = sign("sha256", Buffer.from(payload, "ascii"), { key: privateKey, dsaEncoding: "der" });
      return `${WORKER_INVOKE_AUTHORIZATION_SCHEME} ${workerInvokeToken(payload, signature)}`;
    },
  };
}

/** A key that lives as long as the process: for tests. */
export function createEphemeralInvokeSigner(): InvokeSigner {
  return createInvokeSigner(generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey);
}

/**
 * The owner's invoke key from the state folder (`invoke-key.pem`, mode 0600), made on first use. It is kept so that workers started
 * before a restart of `rovara up` still accept the new process's invocations.
 */
export async function loadInvokeSigner(stateDirectory: string): Promise<InvokeSigner> {
  const path = join(stateDirectory, INVOKE_KEY_FILE_NAME);
  const existing = await readOwnerFile(path, { private: true, label: "invoke key" });
  if (existing !== undefined) return createInvokeSigner(createPrivateKey(existing.text));
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  await writeOwnerFile(path, privateKey.export({ format: "pem", type: "pkcs8" }).toString(), { exclusive: true });
  const written = await readOwnerFile(path, { private: true, label: "invoke key" });
  if (written === undefined) throw new Error("the invoke key could not be saved");
  return createInvokeSigner(createPrivateKey(written.text));
}
