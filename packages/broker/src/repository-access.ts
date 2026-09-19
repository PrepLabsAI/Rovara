import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { agentXError } from "@agentx/contracts";

interface RepositoryGrantClaims {
  version: 3;
  ownerKey: string;
  projectName: string;
  workspaceId: string;
  operationId: string;
  repositories: RepositoryGrantScope[];
  expiresAt: number;
  nonce: string;
}

export interface RepositoryGrantScope {
  credentialRef: string;
  repositoryUrl: string;
  access: RepositoryAccess;
}

export type RepositoryAccess = "clone" | "push";

export interface RepositoryCredential {
  username?: string;
  password?: string;
  token?: string;
  sshPrivateKey?: string;
}

export class RepositoryGrantService {
  constructor(
    private readonly signingKey: Buffer,
    private readonly resolveCredential: (
      reference: string,
      repositoryUrl: string,
      access: RepositoryAccess,
    ) => Promise<RepositoryCredential>,
  ) {
    if (signingKey.byteLength < 32) throw new Error("repository grant signing key must be at least 32 bytes");
  }

  issue(input: {
    ownerKey: string;
    projectName: string;
    workspaceId: string;
    operationId: string;
    repositories: readonly RepositoryGrantScope[];
    ttlSeconds?: number;
  }): string {
    const claims: RepositoryGrantClaims = {
      version: 3,
      ownerKey: input.ownerKey,
      projectName: input.projectName,
      workspaceId: input.workspaceId,
      operationId: input.operationId,
      repositories: uniqueScopes(input.repositories),
      expiresAt: Math.floor(Date.now() / 1_000) + (input.ttlSeconds ?? 900),
      nonce: randomUUID(),
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${payload}.${this.sign(payload)}`;
  }

  async exchange(
    grant: string,
    request: {
      workspaceId: string;
      operationId: string;
      credentialRef: string;
      repositoryUrl: string;
      access: RepositoryAccess;
    },
  ): Promise<RepositoryCredential> {
    const claims = this.verify(grant);
    if (
      claims.workspaceId !== request.workspaceId ||
      claims.operationId !== request.operationId ||
      !claims.repositories.some(
        (repository) =>
          repository.credentialRef === request.credentialRef &&
          repository.repositoryUrl === request.repositoryUrl &&
          repository.access === request.access,
      )
    ) {
      throw agentXError("FORBIDDEN", "repository credential grant does not cover this request");
    }
    return this.resolveCredential(request.credentialRef, request.repositoryUrl, request.access);
  }

  inspect(grant: string): Omit<RepositoryGrantClaims, "nonce"> {
    const claims = this.verify(grant);
    return {
      version: claims.version,
      ownerKey: claims.ownerKey,
      projectName: claims.projectName,
      workspaceId: claims.workspaceId,
      operationId: claims.operationId,
      repositories: claims.repositories,
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
    let claims: RepositoryGrantClaims;
    try {
      claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as RepositoryGrantClaims;
    } catch {
      throw agentXError("FORBIDDEN", "invalid repository grant payload");
    }
    if (
      claims.version !== 3 ||
      !Array.isArray(claims.repositories) ||
      claims.expiresAt <= Math.floor(Date.now() / 1_000)
    ) {
      throw agentXError("FORBIDDEN", "repository grant is expired or unsupported");
    }
    return claims;
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.signingKey).update(payload).digest("base64url");
  }
}

function uniqueScopes(scopes: readonly RepositoryGrantScope[]): RepositoryGrantScope[] {
  const seen = new Set<string>();
  return scopes.flatMap((scope) => {
    const key = `${scope.credentialRef}\0${scope.repositoryUrl}\0${scope.access}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ ...scope }];
  });
}
