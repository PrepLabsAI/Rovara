// Spec 025 phase 25a: the developer sign-in's shared names and wire shapes. The CLI parses server
// responses with the non-strict schemas here, so a newer control plane can add fields.
import { z } from "zod";
import { EnvironmentNameSchema } from "./environments.js";
import { DeveloperTaskPolicySchema } from "./project.js";
import { SlackChannelIdSchema, SlackUserIdSchema } from "./slack.js";
import { WorkspaceStatusSchema } from "./workspace.js";

export const DEVELOPER_API_VERSION = "1.2";
export const AGENTX_CLI_CLIENT_ID = "agentx-cli";
export const DEVELOPER_TOKEN_AUDIENCE = "agentx-developer";
export const DEVELOPER_ACCESS_TOKEN_SECONDS = 3600;
export const DEVELOPER_SESSION_SECONDS = 7 * 24 * 3600;
export const DEVELOPER_CODE_SECONDS = 300;
export const DEVELOPER_AUTH_REQUEST_SECONDS = 600;
export const SLACK_OIDC_ISSUER = "https://slack.com";

export const DeveloperSignInMethodSchema = z.enum(["slack", "oidc"]);
export type DeveloperSignInMethod = z.infer<typeof DeveloperSignInMethodSchema>;

const LOOPBACK_REDIRECT = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/callback$/;

/** FR-001: the only redirect URIs agentx-cli may use. */
export function isLoopbackRedirectUri(value: string): boolean {
  const match = LOOPBACK_REDIRECT.exec(value);
  return match !== null && Number(match[1]) <= 65_535;
}

export function developerIssuer(apiEndpoint: string): string {
  return `${apiEndpoint.replace(/\/+$/, "")}/v1/auth`;
}

/** FR-048: a different major refuses; a newer server minor shows an upgrade notice. */
export function apiVersionCompatible(server: string, client: string): { compatible: boolean; upgradeNotice: boolean } {
  const parse = (value: string) => /^(\d+)\.(\d+)$/.exec(value);
  const s = parse(server);
  const c = parse(client);
  if (!s || !c) return { compatible: false, upgradeNotice: true };
  if (s[1] !== c[1]) return { compatible: false, upgradeNotice: true };
  return { compatible: true, upgradeNotice: Number(s[2]) > Number(c[2]) };
}

export const AgentXConfigurationSchema = z.object({
  env: EnvironmentNameSchema,
  apiVersion: z.string().regex(/^\d+\.\d+$/),
  issuer: z.string().url(),
  authorizationEndpoint: z.string().url(),
  tokenEndpoint: z.string().url(),
  revocationEndpoint: z.string().url(),
  clientId: z.literal(AGENTX_CLI_CLIENT_ID),
  methods: z.object({
    slack: z.boolean(),
    oidc: z.object({ displayName: z.string().min(1).max(40) }).nullable(),
  }),
});
export type AgentXConfiguration = z.infer<typeof AgentXConfigurationSchema>;

export const DeveloperTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.literal("Bearer"),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().regex(/^agxr_[A-Za-z0-9_-]{43}$/),
});
export type DeveloperTokenResponse = z.infer<typeof DeveloperTokenResponseSchema>;

export const DeveloperSummarySchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  name: z.string().min(1).max(200),
  provider: DeveloperSignInMethodSchema,
  slackUserId: SlackUserIdSchema.optional(),
  email: z.string().email().optional(),
});
export type DeveloperSummary = z.infer<typeof DeveloperSummarySchema>;

interface IntrospectableDef {
  type: string;
  innerType?: z.ZodTypeAny;
  defaultValue?: unknown;
}

/**
 * F6: rebuilds a zod object schema so every nested object accepts unknown keys, not only the
 * outermost one (a plain `.passthrough()` only loosens the schema it is called on; a strict
 * sub-object such as `DeveloperTaskPolicySchema.shareMode`, wrapped in `.default()`, stays
 * strict). Walks `.shape` recursively, unwrapping `.default()`/`.optional()`/`.nullable()` and
 * rewrapping the loosened inner type the same way, so the field list is still defined exactly
 * once, in the schema passed in.
 */
function looseCopy<Output>(schema: z.ZodType<Output>): z.ZodType<Output> {
  const def = (schema as unknown as { _zod: { def: IntrospectableDef } })._zod.def;
  if (def.type === "object") {
    const shape = (schema as unknown as { shape: Record<string, z.ZodTypeAny> }).shape;
    const loosened: Record<string, z.ZodTypeAny> = {};
    for (const [key, value] of Object.entries(shape)) loosened[key] = looseCopy(value);
    return z.object(loosened).passthrough() as unknown as z.ZodType<Output>;
  }
  if (def.type === "default" && def.innerType) {
    return looseCopy(def.innerType).default(def.defaultValue as never) as unknown as z.ZodType<Output>;
  }
  if (def.type === "optional" && def.innerType) {
    return looseCopy(def.innerType).optional() as unknown as z.ZodType<Output>;
  }
  if (def.type === "nullable" && def.innerType) {
    return looseCopy(def.innerType).nullable() as unknown as z.ZodType<Output>;
  }
  return schema;
}

/**
 * F6: a non-strict copy of `DeveloperTaskPolicySchema` (`project.ts`), used only to parse a
 * project's task policy inside this response. A strict schema embedded here would make an old MCP
 * server fail the whole `projects()` response (`whoami`, `agentx_list_projects`) as soon as a
 * newer control plane added one field to the policy, at any nesting level (including inside
 * `shareMode`). The field list stays defined once, in Task 1's schema.
 */
const DeveloperProjectTaskPolicySchema = looseCopy(DeveloperTaskPolicySchema);

export const DeveloperProjectSchema = z.object({
  name: z.string().min(1),
  latestRevision: z.number().int().positive(),
  access: z.enum(["granted", "channel"]),
  channels: z.array(z.object({ channelId: SlackChannelIdSchema, name: z.string().optional(), isPrivate: z.boolean().optional() })),
  // Absent from a 1.0 control plane.
  tasks: DeveloperProjectTaskPolicySchema.optional(),
});
export type DeveloperProject = z.infer<typeof DeveloperProjectSchema>;

export const DeveloperProjectsResponseSchema = z.object({
  developer: DeveloperSummarySchema,
  projects: z.array(DeveloperProjectSchema),
  notices: z.array(z.enum(["slack_unavailable"])),
});
export type DeveloperProjectsResponse = z.infer<typeof DeveloperProjectsResponseSchema>;

/**
 * Spec 041: one workspace as a developer may see it. It names what the workspace is and how it is
 * doing, and nothing about how it runs: no owner key, no instance, no ARN, no manifest.
 */
export const DeveloperWorkspaceSchema = z.object({
  id: z.string().uuid(),
  projectName: z.string().min(1),
  projectRevision: z.number().int().positive(),
  status: WorkspaceStatusSchema,
  /** True while a coding task holds the workspace, so the page can say "working" rather than "busy". */
  busy: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DeveloperWorkspace = z.infer<typeof DeveloperWorkspaceSchema>;

/** The projects the caller may use, each with the workspaces that exist in it, newest first. */
export const DeveloperWorkspacesResponseSchema = z.object({
  developer: DeveloperSummarySchema,
  projects: z.array(DeveloperProjectSchema),
  workspaces: z.array(DeveloperWorkspaceSchema),
  notices: z.array(z.enum(["slack_unavailable"])),
});
export type DeveloperWorkspacesResponse = z.infer<typeof DeveloperWorkspacesResponseSchema>;

/** The most workspaces one listing returns per project, newest first. */
export const DEVELOPER_WORKSPACES_PER_PROJECT = 200;

/** The most channels one channel-members request may name; callers split longer lists. The
 * DeveloperIdentity function allows twice this many Slack calls per request, so a full batch of
 * cold channels fits, with room for a second page of members each. */
export const CHANNEL_MEMBERS_MAX_CHANNELS = 50;

export const ChannelMembersRequestSchema = z
  .object({
    kind: z.literal("channel-members"),
    slackUserId: SlackUserIdSchema,
    channelIds: z.array(SlackChannelIdSchema).max(CHANNEL_MEMBERS_MAX_CHANNELS),
  })
  .strict();
export type ChannelMembersRequest = z.infer<typeof ChannelMembersRequestSchema>;
/** `invalid_request` means the caller sent a request the identity function refused: a caller bug. */
export type ChannelMembersResponse =
  | { ok: true; memberOf: string[] }
  | { ok: false; error: "slack_unavailable" }
  | { ok: false; error: "invalid_request" };

/** R10: the names and privacy of bound channels, read by DeveloperIdentity with the bot token. */
export const ChannelInfoRequestSchema = z
  .object({
    kind: z.literal("channel-info"),
    channelIds: z.array(SlackChannelIdSchema).max(CHANNEL_MEMBERS_MAX_CHANNELS),
  })
  .strict();
export type ChannelInfoRequest = z.infer<typeof ChannelInfoRequestSchema>;
export type ChannelInfoResponse =
  | { ok: true; channels: Array<{ channelId: string; name: string; isPrivate: boolean }> }
  | { ok: false; error: "slack_unavailable" }
  | { ok: false; error: "invalid_request" };
