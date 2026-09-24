import { z } from "zod";
import { AGENTX_NAME_PATTERN } from "./names.js";

/** Every provider type. github-app is built in; the last two are reserved for later releases. */
export const CredentialTypeSchema = z.enum(["github-app", "static-secret", "oauth-client-credentials", "oauth-refresh-token", "per-user"]);
export const RegistrableCredentialTypeSchema = z.enum(["static-secret", "oauth-client-credentials"]);
export const CONNECTOR_SECRET_PREFIX = "agentx/connectors/";

const SecretNameSchema = z.string().regex(/^agentx\/connectors\/[A-Za-z0-9_+=.@-]{1,128}$/, "secret name must be agentx/connectors/<name>");

export const CredentialRegistrationSchema = z.object({
  ref: z.string().regex(AGENTX_NAME_PATTERN),
  type: RegistrableCredentialTypeSchema,
  secretName: SecretNameSchema,
}).strict();

export const CredentialRecordSchema = CredentialRegistrationSchema.extend({
  registeredBy: z.string().min(1).max(256),
  registeredAt: z.iso.datetime(),
}).strict();

export const CredentialListEntrySchema = z.object({
  ref: z.string(),
  type: CredentialTypeSchema,
  secretName: z.string(),
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

export type CredentialType = z.infer<typeof CredentialTypeSchema>;
export type CredentialRegistration = z.infer<typeof CredentialRegistrationSchema>;
export type CredentialRecord = z.infer<typeof CredentialRecordSchema>;
export type CredentialListEntry = z.infer<typeof CredentialListEntrySchema>;
export type StaticSecret = z.infer<typeof StaticSecretSchema>;
export type OAuthClientCredentialsSecret = z.infer<typeof OAuthClientCredentialsSecretSchema>;
