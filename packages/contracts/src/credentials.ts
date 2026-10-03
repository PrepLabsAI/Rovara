import { z } from "zod";
import { EnvironmentNameSchema } from "./environments.js";
import { DnsHostSchema, publicHttpsUrlSchema } from "./mcp-connector.js";
import { AGENTX_NAME_PATTERN } from "./names.js";

/** Every provider type. github-app is built in; per-user is reserved for a later release. */
export const CredentialTypeSchema = z.enum(["github-app", "static-secret", "oauth-client-credentials", "oauth-refresh-token", "per-user"]);
export const RegistrableCredentialTypeSchema = z.enum(["static-secret", "oauth-client-credentials", "oauth-refresh-token"]);
export const CONNECTOR_SECRET_PREFIX = "agentx/connectors/";

/** Escapes regex metacharacters (including "/") so a literal can be embedded in a RegExp built from a string. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** No "/" in the character class (so no path segments) and the name cannot be only dots (so no "." or ".."). */
const SECRET_LEAF = "(?!\\.+$)[A-Za-z0-9_+=.@-]{1,128}";
// agentx/connectors/<name> (deployments that predate environments): the literal legacy prefix, checked
// first so a plain legacy name is never reinterpreted as an environment form.
const LEGACY_SECRET_NAME_PATTERN = new RegExp(`^${escapeRegExp(CONNECTOR_SECRET_PREFIX)}${SECRET_LEAF}$`);
// agentx/<env>/connectors/<name>: the environment segment is validated with EnvironmentNameSchema
// itself (not just this shape), so every environment-name rule applies here too, including the
// reserved name "connectors" (agentx/connectors/connectors/<name> would otherwise be ambiguous with
// the legacy prefix above).
const ENVIRONMENT_SECRET_NAME_PATTERN = new RegExp(`^agentx/([^/]+)/connectors/(${SECRET_LEAF})$`);
const SECRET_NAME_MESSAGE = "secret name must be agentx/connectors/<name> or agentx/<environment>/connectors/<name>";
const SecretNameSchema = z.string().refine((name) => {
  if (LEGACY_SECRET_NAME_PATTERN.test(name)) return true;
  const match = ENVIRONMENT_SECRET_NAME_PATTERN.exec(name);
  return match !== null && EnvironmentNameSchema.safeParse(match[1]).success;
}, SECRET_NAME_MESSAGE);

const CredentialRegistrationFields = z.object({
  ref: z.string().regex(AGENTX_NAME_PATTERN),
  type: RegistrableCredentialTypeSchema,
  secretName: SecretNameSchema,
  /**
   * Spec 055: the one MCP host this credential may be sent to. A generic `mcp` connector requires it
   * to equal its endpoint's host; a built-in connector refuses a credential pinned anywhere else.
   */
  host: DnsHostSchema.optional(),
  /**
   * Spec 055 phase 2: where an OAuth credential is refreshed or minted, for a connector whose type
   * names no token endpoint of its own (a generic `mcp` connector). Discovered by `authorize --endpoint`.
   */
  tokenUrl: publicHttpsUrlSchema("tokenUrl").optional(),
  /** Spec 055 phase 2: the RFC 8707 resource indicator sent with every token request, as MCP requires. */
  resource: publicHttpsUrlSchema("resource").optional(),
});

/** tokenUrl and resource belong to OAuth credentials only. */
function oauthFieldsOnly(registration: { type: string; tokenUrl?: string | undefined; resource?: string | undefined }, context: z.RefinementCtx): void {
  if (registration.type !== "static-secret") return;
  for (const field of ["tokenUrl", "resource"] as const) {
    if (registration[field] !== undefined) context.addIssue({ code: "custom", path: [field], message: `${field} applies only to OAuth credentials` });
  }
}

export const CredentialRegistrationSchema = CredentialRegistrationFields.strict().superRefine(oauthFieldsOnly);

export const CredentialRecordSchema = CredentialRegistrationFields.extend({
  registeredBy: z.string().min(1).max(256),
  registeredAt: z.iso.datetime(),
}).strict().superRefine(oauthFieldsOnly);

export const CredentialListEntrySchema = z.object({
  ref: z.string(),
  type: CredentialTypeSchema,
  secretName: z.string(),
  host: z.string().optional(),
  tokenUrl: z.string().optional(),
  resource: z.string().optional(),
  builtIn: z.boolean(),
  tokenCached: z.boolean(),
  registeredBy: z.string().optional(),
  registeredAt: z.string().optional(),
}).strict();

export const StaticSecretSchema = z.object({ apiKey: z.string().min(1).max(8_192) }).strict();
export const OAuthClientCredentialsSecretSchema = z.object({
  clientId: z.string().min(1).max(1_024),
  clientSecret: z.string().min(1).max(8_192),
  scopes: z.array(z.string().regex(/^[\x21-\x7e]{1,128}$/)).min(1).max(32),
}).strict();

/**
 * An OAuth app's client and the refresh token a bot user's one-time sign-in produced
 * (`agentx admin credential authorize`). The broker writes a rotated refresh token back here.
 */
export const OAuthRefreshTokenSecretSchema = z.object({
  clientId: z.string().min(1).max(1_024),
  /** Absent for a public client (spec 055 phase 2), such as one a server registered dynamically: PKCE protects its sign-in. */
  clientSecret: z.string().min(1).max(8_192).optional(),
  refreshToken: z.string().min(1).max(8_192),
}).strict();

/** The same secret before its first sign-in: `authorize` reads the client from it and adds the refresh token. */
export const OAuthAppSecretSchema = OAuthRefreshTokenSecretSchema.extend({ refreshToken: z.string().min(1).max(8_192).optional() });

export type CredentialType = z.infer<typeof CredentialTypeSchema>;
export type CredentialRegistration = z.infer<typeof CredentialRegistrationSchema>;
export type CredentialRecord = z.infer<typeof CredentialRecordSchema>;
export type CredentialListEntry = z.infer<typeof CredentialListEntrySchema>;
export type StaticSecret = z.infer<typeof StaticSecretSchema>;
export type OAuthClientCredentialsSecret = z.infer<typeof OAuthClientCredentialsSecretSchema>;
export type OAuthRefreshTokenSecret = z.infer<typeof OAuthRefreshTokenSecretSchema>;
export type OAuthAppSecret = z.infer<typeof OAuthAppSecretSchema>;
