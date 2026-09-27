// Spec 025 phase 25a: the developer sign-in's shared names and wire shapes. The CLI parses server
// responses with the non-strict schemas here, so a newer control plane can add fields.
import { z } from "zod";
import { EnvironmentNameSchema } from "./environments.js";
import { SlackChannelIdSchema, SlackUserIdSchema } from "./slack.js";

export const DEVELOPER_API_VERSION = "1.0";
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

export const DeveloperProjectSchema = z.object({
  name: z.string().min(1),
  latestRevision: z.number().int().positive(),
  access: z.enum(["granted", "channel"]),
  channels: z.array(z.object({ channelId: SlackChannelIdSchema })),
});
export type DeveloperProject = z.infer<typeof DeveloperProjectSchema>;

export const DeveloperProjectsResponseSchema = z.object({
  developer: DeveloperSummarySchema,
  projects: z.array(DeveloperProjectSchema),
  notices: z.array(z.enum(["slack_unavailable"])),
});
export type DeveloperProjectsResponse = z.infer<typeof DeveloperProjectsResponseSchema>;

/** The most channels one channel-members request may name; callers split longer lists. */
export const CHANNEL_MEMBERS_MAX_CHANNELS = 500;

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
