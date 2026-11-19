// Org connections (Plan 3, ruling R62): the credentials a company gives Rovara for its trackers and MCP servers.
// A connection is a record with no secret in it; its key or token lives in a Secrets Manager secret named from the
// org id and the connection id, which only a role session tagged with that org can read.
import { z } from "zod";
import { ConnectionIdSchema } from "./agent-node.js";
import { ConnectionLabelSchema, ConnectionSecretText } from "./connection-fields.js";
import { ObservabilityConnectionSchemas, ObservabilitySecretSchemas } from "./connection-types-observability.js";
import { McpAuthSchema, McpEndpointSchema } from "./mcp-connector.js";
import { type OrgId } from "./company-scope.js";
import { orgScoped, type OrgKey } from "./company-scope.js";

// CLOSED ON PURPOSE (owner decision 62, item E1): no new connection type. Opening this union (a connection for a tracker that registers itself) is built when chains and triggers are switched on (decision 45.10).
export const ConnectionTypeSchema = z.enum(["linear", "jira", "mcp", "sentry", "datadog", "cloudwatch", "grafana", "vercel", "pagerduty"]);
export type ConnectionType = z.infer<typeof ConnectionTypeSchema>;

export const ConnectionAccessSchema = z.enum(["read", "read_write"]);
export type ConnectionAccess = z.infer<typeof ConnectionAccessSchema>;

export { CONNECTION_LABEL_MAX } from "./connection-fields.js";

const LabelSchema = ConnectionLabelSchema;

/** `https://<site>.atlassian.net`: one DNS label under atlassian.net, no path, so the token only ever goes to Atlassian. */
export const JiraSiteUrlSchema = z.string().regex(/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.atlassian\.net$/, "must be https://<site>.atlassian.net");

const McpVendorSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 .&+-]{0,31}$/);

/**
 * Whose key a Linear or Jira connection holds, said by the person who makes it (the vendor does not tell a bot from a person). A `service` identity is an account only Rovara
 * uses, so every ticket it makes is Rovara's and the trigger loop guard skips it. A `personal` key is a person's own: the guard cannot tell their tickets from Rovara's, so it
 * does not skip them (the subject guard and the run caps bound a loop instead). Left out, it is read as personal.
 */
export const ConnectionIdentitySchema = z.enum(["service", "personal"]);
export type ConnectionIdentity = z.infer<typeof ConnectionIdentitySchema>;

const Common = { connectionId: ConnectionIdSchema, label: LabelSchema, access: ConnectionAccessSchema } as const;

export const OrgConnectionSchema = z.discriminatedUnion("type", [
  z.object({ ...Common, type: z.literal("linear"), identity: ConnectionIdentitySchema.optional() }).strict(),
  z.object({ ...Common, type: z.literal("jira"), siteUrl: JiraSiteUrlSchema, identity: ConnectionIdentitySchema.optional() }).strict(),
  z.object({ ...Common, type: z.literal("mcp"), endpoint: McpEndpointSchema, vendor: McpVendorSchema, auth: McpAuthSchema.optional() }).strict(),
  // Plan 4 Task 11: Sentry, Datadog, CloudWatch, Grafana, Vercel and PagerDuty, read-only.
  ...ObservabilityConnectionSchemas,
]);
export type OrgConnection = z.infer<typeof OrgConnectionSchema>;

const SecretText = ConnectionSecretText;

/**
 * The Atlassian account email a Jira Cloud API token belongs to. Jira Cloud's REST API takes `Basic base64(email:apiToken)`, so
 * the email identifies the credential and lives in the secret with the token. No ":" (it splits the pair) and no whitespace.
 */
const AtlassianEmail = z.string().max(254).regex(/^[^\s:@]+@[^\s:@]+\.[^\s:@]+$/, "must be the Atlassian account email, such as name@company.com");

/** The read-only Atlassian organization admin API key: printable characters, no space, write-only like every secret. */
export const AtlassianOrgAdminKey = SecretText;

/** The id of an Atlassian organization (admin.atlassian.com), as it appears in the admin API's path. */
export const AtlassianOrgId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, "must be the Atlassian organization id");

/**
 * What a secret holds, by connection type: a Linear API key, a Jira account email and API token, an MCP bearer token, and (Plan 4) a Sentry
 * auth token, a Datadog API and application key, a Grafana service account token, a Vercel token and a PagerDuty API key. Write-only: nothing
 * returns it. A CloudWatch connection has none: Rovara assumes the customer's role.
 */
export const ConnectionSecretSchemas = {
  linear: z.object({ apiKey: SecretText }).strict(),
  // `orgAdminKey` and `atlassianOrgId` are optional and go TOGETHER (both or neither): a READ-ONLY Atlassian organization admin API key (scope read:accounts:admin) and the organization's id, so Rovara can read which
  // accounts the company manages (tracker linking, opt-in). Like the token they are write-only: nothing returns them. A save that leaves them out keeps the stored pair; `clearOrgAdmin: true` removes it.
  // Without them no Jira person is linked automatically.
  jira: z.object({ email: AtlassianEmail, apiToken: SecretText, orgAdminKey: SecretText.optional(), atlassianOrgId: AtlassianOrgId.optional(), clearOrgAdmin: z.literal(true).optional() }).strict()
    .refine((secret) => (secret.orgAdminKey === undefined) === (secret.atlassianOrgId === undefined), { message: "orgAdminKey and atlassianOrgId go together" })
    .refine((secret) => secret.clearOrgAdmin !== true || secret.orgAdminKey === undefined, { message: "clearOrgAdmin cannot come with a key" }),
  mcp: z.object({ token: SecretText }).strict(),
  ...ObservabilitySecretSchemas,
} as const;

export const ConnectionSecretSchema = z.union([
  ConnectionSecretSchemas.linear, ConnectionSecretSchemas.jira, ConnectionSecretSchemas.mcp,
  ConnectionSecretSchemas.sentry, ConnectionSecretSchemas.datadog, ConnectionSecretSchemas.grafana, ConnectionSecretSchemas.vercel, ConnectionSecretSchemas.pagerduty,
]);
export type ConnectionSecret = z.infer<typeof ConnectionSecretSchema>;

/** The connection types that hold a secret: every one but CloudWatch. */
export type SecretConnectionType = keyof typeof ConnectionSecretSchemas;

export const connectionTakesSecret = (type: ConnectionType): type is SecretConnectionType => type in ConnectionSecretSchemas;

/** The secret's one value the runtime sends, whatever the type calls it (a Jira connection's email is only for its check; a Datadog connection also has an application key). */
export function connectionSecretToken(type: SecretConnectionType, secret: ConnectionSecret): string {
  switch (type) {
    case "linear": return (secret as { apiKey: string }).apiKey;
    case "jira": return (secret as { apiToken: string }).apiToken;
    case "mcp": return (secret as { token: string }).token;
    case "sentry": return (secret as { authToken: string }).authToken;
    case "datadog": return (secret as { apiKey: string }).apiKey;
    case "grafana": return (secret as { serviceAccountToken: string }).serviceAccountToken;
    case "vercel": return (secret as { token: string }).token;
    case "pagerduty": return (secret as { apiKey: string }).apiKey;
  }
}

/** One connection's partition: its META record. */
export function connectionKey(orgId: OrgId, connectionId: string): OrgKey {
  return { pk: orgScoped(orgId, `CONNECTION#${connectionId}`), sk: "META" };
}

/** The org's connection directory: one item per connection, for listing without reading every partition. */
export function connectionsKey(orgId: OrgId, connectionId: string): OrgKey {
  return { pk: orgScoped(orgId, "CONNECTIONS"), sk: connectionId };
}
