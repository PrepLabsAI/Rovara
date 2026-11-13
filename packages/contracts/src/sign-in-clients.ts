// Spec 063 (FR-001): services an administrator lets sign Rovara users in. Each gets tokens addressed to it (its own
// audience), which Rovara's own API never accepts, and may ask Rovara what a signed-in person can do.
import { z } from "zod";
import { AGENTX_CLI_CLIENT_ID, DEVELOPER_TOKEN_AUDIENCE } from "./developer.js";
import { publicHttpsUrlProblem } from "./mcp-connector.js";

/** A sign-in client's ID: lower-case, and never the Rovara CLI's own. */
export const SignInClientIdSchema = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/).refine((id) => id !== AGENTX_CLI_CLIENT_ID, "agentx-cli is Rovara's own CLI");

/** The audience its tokens carry: its own, never Rovara's. */
export const SignInClientAudienceSchema = z.string().regex(/^[a-z][a-z0-9.:/-]{1,127}$/).refine((audience) => audience !== DEVELOPER_TOKEN_AUDIENCE, "agentx-developer is Rovara's own audience");

/** An exact HTTPS redirect URL on a public host, with no query or fragment. */
export const SignInRedirectUriSchema = z.string().max(2_048).superRefine((value, context) => {
  const problem = publicHttpsUrlProblem(value, "redirect URL");
  if (problem !== undefined) context.addIssue({ code: "custom", message: problem });
});

/** What an administrator registers. `secretHash` (SHA-256, hex) makes it confidential; the secret itself is never sent. */
/**
 * Spec 065: what a sign-in client may do on Rovara as the signed-in person, beyond the access check. An administrator
 * names them when registering the client; the client asks for them at sign-in and its tokens carry the allowed ones.
 */
export const CLIENT_SCOPES = ["projects:members", "projects:create"] as const;
export const ClientScopeSchema = z.enum(CLIENT_SCOPES);
export type ClientScope = z.infer<typeof ClientScopeSchema>;
const ClientScopesSchema = z.array(ClientScopeSchema).max(CLIENT_SCOPES.length).refine((scopes) => new Set(scopes).size === scopes.length, "scopes must be unique");

/** The scopes a token's space-separated `scope` claim names, keeping only known ones. */
export function scopesOf(claim: unknown): ClientScope[] {
  if (typeof claim !== "string") return [];
  return claim.split(" ").filter((scope): scope is ClientScope => ClientScopeSchema.safeParse(scope).success);
}

export const SignInClientRegistrationSchema = z.object({
  name: z.string().trim().min(1).max(80),
  audience: SignInClientAudienceSchema,
  redirectUris: z.array(SignInRedirectUriSchema).max(10).refine((uris) => new Set(uris).size === uris.length, "redirect URLs must be unique"),
  /** It may sign people in from a terminal, with a loopback redirect, as `agentx login` does. */
  loopback: z.boolean(),
  secretHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  /** Spec 065: what it may do as the signed-in person; none when absent. */
  scopes: ClientScopesSchema.optional(),
  /**
   * An update that keeps the client's secret: Rovara carries the stored hash over (the CLI never sees it). Never with a
   * new `secretHash`, and refused for a client that has no secret.
   */
  keepSecret: z.literal(true).optional(),
}).strict()
  .refine((registration) => registration.loopback || registration.redirectUris.length > 0, "a client needs a redirect URL, a loopback redirect, or both")
  .refine((registration) => registration.keepSecret === undefined || registration.secretHash === undefined, "keep the secret or give a new one, not both");
export type SignInClientRegistration = z.infer<typeof SignInClientRegistrationSchema>;

export const SignInClientRecordSchema = z.object({
  clientId: SignInClientIdSchema,
  name: z.string().min(1).max(80),
  audience: SignInClientAudienceSchema,
  redirectUris: z.array(z.string().max(2_048)).max(10),
  loopback: z.boolean(),
  secretHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  scopes: ClientScopesSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  updatedBy: z.string().min(1).max(512),
}).strict();
export type SignInClientRecord = z.infer<typeof SignInClientRecordSchema>;

/** A client as anyone but the sign-in server sees it: never its secret's hash. */
export const SignInClientViewSchema = SignInClientRecordSchema.omit({ secretHash: true }).extend({ confidential: z.boolean() }).strict();
export type SignInClientView = z.infer<typeof SignInClientViewSchema>;

export function signInClientView(record: SignInClientRecord): SignInClientView {
  const { secretHash, ...rest } = record;
  return { ...rest, confidential: secretHash !== undefined };
}

/** Where the sign-in table keeps the registry: one partition, one row per client. */
export const SIGN_IN_CLIENTS_PK = "SIGNIN_CLIENTS";
export const signInClientKey = (clientId: string) => ({ pk: SIGN_IN_CLIENTS_PK, sk: `CLIENT#${SignInClientIdSchema.parse(clientId)}` });

// ---- FR-004: the access check, POST /v1/dev/access ----

/** With a confidential client's secret (HTTP Basic), the developer to ask about; with a person's token, nothing. */
export const AccessCheckRequestSchema = z.object({ developerId: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
export type AccessCheckRequest = z.infer<typeof AccessCheckRequestSchema>;

/** Who the person is and what they can use now. `notices` names a check that could not run (`slack_unavailable`). */
export interface AccessCheckResponse {
  developerId: string;
  displayName: string;
  administrator: boolean;
  /** `administrator` (spec 065): a project the person administers, which task access alone does not list. */
  projects: Array<{ name: string; access: "granted" | "channel" | "administrator" }>;
  notices: string[];
}

// ---- The broker's requests to the sign-in Lambda, which owns the registry ----

/** `keepSecret`: carry the stored client's secret hash over, which only the sign-in server holds. */
export const PutSignInClientRequestSchema = z.object({ kind: z.literal("put-sign-in-client"), client: SignInClientRecordSchema, keepSecret: z.literal(true).optional() }).strict();
export type PutSignInClientRequest = z.infer<typeof PutSignInClientRequestSchema>;
export const RemoveSignInClientRequestSchema = z.object({ kind: z.literal("remove-sign-in-client"), clientId: SignInClientIdSchema }).strict();
export type RemoveSignInClientRequest = z.infer<typeof RemoveSignInClientRequestSchema>;
export const ListSignInClientsRequestSchema = z.object({ kind: z.literal("list-sign-in-clients") }).strict();
export type ListSignInClientsRequest = z.infer<typeof ListSignInClientsRequestSchema>;

export type SignInClientsResponse =
  | { ok: true; clients?: SignInClientView[]; removed?: boolean }
  | { ok: false; error: "invalid_request" | "unavailable" };

// ---- Spec 065: a sign-in client's routes, /v1/dev/client/*, each acting as the signed-in person ----

/** `GET /v1/dev/client/projects/{project}/members` (projects:members). */
export interface ClientProjectMembersResponse {
  project: string;
  members: Array<{ developerId: string; name: string; role: "administrator" | "developer"; grantedAt: string | null }>;
}

/** `PUT` or `DELETE /v1/dev/client/projects/{project}/members/{developer}` (projects:members). */
export interface ClientProjectMemberChangeResponse {
  project: string;
  developerId: string;
  /** PUT: granted (or already was); DELETE: revoked, or was not a member. */
  outcome: "granted" | "already_member" | "revoked" | "not_member";
}
