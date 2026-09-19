import { createHash } from "node:crypto";
import { agentXError } from "@agentx/contracts";
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";

export interface AuthenticatedIdentity {
  issuer: string;
  subject: string;
  ownerKey: string;
  isAdministrator: boolean;
  claims: JWTPayload;
}

export interface JwtAuthenticatorConfig {
  issuer: string;
  audience: string;
  jwksUri?: string;
  adminClaim: string;
  adminValues: string[];
  algorithms?: string[];
}

export class JwtAuthenticator {
  readonly getKey: JWTVerifyGetKey;

  constructor(
    readonly config: JwtAuthenticatorConfig,
    getKey?: JWTVerifyGetKey,
  ) {
    this.getKey =
      getKey ??
      createRemoteJWKSet(new URL(config.jwksUri ?? `${config.issuer.replace(/\/$/, "")}/.well-known/jwks.json`));
  }

  async authenticate(token: string): Promise<AuthenticatedIdentity> {
    if (!token) throw agentXError("AUTH_REQUIRED", "bearer token is required");
    const verified = await jwtVerify(token, this.getKey, {
      issuer: this.config.issuer,
      audience: this.config.audience,
      algorithms: this.config.algorithms ?? ["RS256", "ES256"],
    });
    const subject = verified.payload.sub;
    const issuer = verified.payload.iss;
    if (!subject || !issuer) throw agentXError("AUTH_REQUIRED", "verified token lacks issuer or subject");
    const claim = verified.payload[this.config.adminClaim];
    const values = typeof claim === "string" ? [claim] : Array.isArray(claim) ? claim.filter(isString) : [];
    return {
      issuer,
      subject,
      ownerKey: createHash("sha256").update(issuer).update("\0").update(subject).digest("hex"),
      isAdministrator: values.some((value) => this.config.adminValues.includes(value)),
      claims: verified.payload,
    };
  }
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
