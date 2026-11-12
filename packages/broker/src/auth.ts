import { createHash } from "node:crypto";
import {
  agentXError,
  type ActorRef,
  type ChannelAdapterRecord,
  type ConversationRef,
  type SlackChannelBinding,
  type SlackRequester,
  type SlackThread,
  type DeveloperSignInMethod,
} from "@agentx/contracts";
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
  slack?: {
    thread: SlackThread;
    requester: SlackRequester;
    requesterName?: string;
    binding: SlackChannelBinding;
  };
  /** Spec 062 Phase 4: an adapter conversation's owner; never set with `slack` or `developer`. */
  channel?: ChannelConversation;
  /** Spec 025: a developer task's workspace owner (FR-017); never set with `slack`. */
  developer?: {
    developerId: string;
    provider: DeveloperSignInMethod;
    name: string;
    client: string;
    taskId: string;
  };
  /**
   * Spec 025 C11: the call comes from a shared task's Slack thread. In `continue` the identity is the
   * task's owner key with the teammate's Slack context; otherwise the thread's own key, which answers
   * VIEW_ONLY and never creates a workspace.
   */
  sharedTask?: {
    taskId: string; workspaceId: string; developerName: string; state: "continue" | "view" | "closed";
    /** Only a Slack-started task's own open thread: the chat agent may be given its read-only task view there, when it asks for task mode. */
    taskAnswer?: true;
  };
}

/** An adapter conversation on the service routes: checked against its adapter, binding and link on every call. */
export interface ChannelConversation {
  ref: ConversationRef;
  actor: ActorRef;
  projectName: string;
  adapter: ChannelAdapterRecord;
  /** The developer the actor is linked to, who is charged and recorded as the requester. */
  developer: { developerId: string; provider: "slack" | "oidc" | "cloud" | "github" | "saml"; name: string; slackUserId?: string };
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
