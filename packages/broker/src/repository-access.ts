import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { agentXError } from "@agentx/contracts";

interface RepositoryGrantClaims {
  version: 1;
  ownerKey: string;
  projectName: string;
  workspaceId: string;
  operationId: string;
  credentialRefs: string[];
  expiresAt: number;
  nonce: string;
}

export interface RepositoryCredential {
  username?: string;
  password?: string;
  token?: string;
  sshPrivateKey?: string;
}

export class RepositoryGrantService {
  constructor(
    private readonly signingKey: Buffer,
    private readonly resolveCredential: (reference: string) => Promise<RepositoryCredential>,
  ) {
    if (signingKey.byteLength < 32) throw new Error("repository grant signing key must be at least 32 bytes");
  }

  issue(input: {
    ownerKey: string;
    projectName: string;
    workspaceId: string;
    operationId: string;
    credentialRefs: readonly string[];
    ttlSeconds?: number;
  }): string {
    const claims: RepositoryGrantClaims = {
      version: 1,
      ownerKey: input.ownerKey,
      projectName: input.projectName,
      workspaceId: input.workspaceId,
      operationId: input.operationId,
      credentialRefs: [...new Set(input.credentialRefs)],
      expiresAt: Math.floor(Date.now() / 1_000) + (input.ttlSeconds ?? 900),
      nonce: randomUUID(),
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${payload}.${this.sign(payload)}`;
  }

  async exchange(
    grant: string,
    request: { workspaceId: string; operationId: string; credentialRef: string },
  ): Promise<RepositoryCredential> {
    const claims = this.verify(grant);
    if (
      claims.workspaceId !== request.workspaceId ||
      claims.operationId !== request.operationId ||
      !claims.credentialRefs.includes(request.credentialRef)
    ) {
      throw agentXError("FORBIDDEN", "repository credential grant does not cover this request");
    }
    return this.resolveCredential(request.credentialRef);
  }

  inspect(grant: string): Omit<RepositoryGrantClaims, "nonce"> {
    const claims = this.verify(grant);
    return {
      version: claims.version,
      ownerKey: claims.ownerKey,
      projectName: claims.projectName,
      workspaceId: claims.workspaceId,
      operationId: claims.operationId,
      credentialRefs: claims.credentialRefs,
      expiresAt: claims.expiresAt,
    };
  }

  private verify(grant: string): RepositoryGrantClaims {
    const [payload, signature, extra] = grant.split(".");
    if (!payload || !signature || extra) throw agentXError("FORBIDDEN", "invalid repository grant");
    const expected = Buffer.from(this.sign(payload), "base64url");
    const received = Buffer.from(signature, "base64url");
    if (expected.byteLength !== received.byteLength || !timingSafeEqual(expected, received)) {
      throw agentXError("FORBIDDEN", "invalid repository grant signature");
    }
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as RepositoryGrantClaims;
    if (claims.version !== 1 || claims.expiresAt <= Math.floor(Date.now() / 1_000)) {
      throw agentXError("FORBIDDEN", "repository grant is expired or unsupported");
    }
    return claims;
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.signingKey).update(payload).digest("base64url");
  }
}
