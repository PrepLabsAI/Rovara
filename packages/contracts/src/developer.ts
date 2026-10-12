// Spec 025 phase 25a: the developer sign-in's shared names and wire shapes. The CLI parses server
// responses with the non-strict schemas here, so a newer control plane can add fields.
import { z } from "zod";
import { EnvironmentNameSchema } from "./environments.js";
import { looseCopy } from "./loose.js";
import { DeveloperTaskPolicySchema } from "./project.js";
import { SlackChannelIdSchema, SlackTeamIdSchema, SlackUserIdSchema } from "./slack.js";
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

/** Internal, fresh identity and membership proof for a task person. It is never an HTTP route. */
export const TaskPersonProofRequestSchema = z
  .object({
    kind: z.literal("task-person-proof"),
    slackUserId: SlackUserIdSchema,
    channelIds: z.array(SlackChannelIdSchema).max(CHANNEL_MEMBERS_MAX_CHANNELS),
  })
  .strict();
export type TaskPersonProofRequest = z.infer<typeof TaskPersonProofRequestSchema>;

export const TaskPersonProofResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    user: z.object({ id: SlackUserIdSchema, teamId: SlackTeamIdSchema, name: z.string().min(1).max(1024) }).strict(),
    memberOf: z.array(SlackChannelIdSchema).max(CHANNEL_MEMBERS_MAX_CHANNELS),
  }).strict(),
  z.object({ ok: z.literal(false), error: z.enum(["invalid_request", "slack_unavailable", "ineligible"]) }).strict(),
]);
export type TaskPersonProofResponse = z.infer<typeof TaskPersonProofResponseSchema>;

/** Bounded internal Lambda envelope for fresh task-dispatch proof. Never an HTTP request shape. */
export const TaskDispatchProofRequestSchema = z.object({
  kind: z.literal("task-dispatch-person-proof"),
  request: TaskPersonProofRequestSchema,
  admission: z.object({
    version: z.literal(1),
    id: z.string().uuid(),
    deadlineAt: z.number().int().nonnegative(),
    remainingMs: z.number().int().min(1).max(6_000),
    slackCallsLimit: z.number().int().min(1).max(100),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (new Set(value.request.channelIds).size !== value.request.channelIds.length) {
    context.addIssue({ code: "custom", path: ["request", "channelIds"], message: "channel IDs must be unique" });
  }
});
export type TaskDispatchProofRequest = z.infer<typeof TaskDispatchProofRequestSchema>;

export const TaskDispatchProofResponseSchema = z.object({
  kind: z.literal("task-dispatch-person-proof-result"),
  admissionId: z.string().uuid(),
  usage: z.object({
    slackCallsUsed: z.number().int().min(0).max(100),
    completedAt: z.number().int().nonnegative(),
  }).strict(),
  result: TaskPersonProofResponseSchema,
}).strict();
export type TaskDispatchProofResponse = z.infer<typeof TaskDispatchProofResponseSchema>;

/** Internal complete fresh channel directory for Task People. It is never an HTTP route. */
export const TaskChannelPeopleRequestSchema = z.object({
  kind: z.literal("task-channel-people"),
  channelIds: z.array(SlackChannelIdSchema).min(1).max(CHANNEL_MEMBERS_MAX_CHANNELS),
}).strict();
export type TaskChannelPeopleRequest = z.infer<typeof TaskChannelPeopleRequestSchema>;
export const TaskChannelPeopleResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), users: z.array(z.object({ id: SlackUserIdSchema, teamId: SlackTeamIdSchema, name: z.string().min(1).max(80), memberOf: z.array(SlackChannelIdSchema).max(CHANNEL_MEMBERS_MAX_CHANNELS) }).strict()).max(100) }).strict(),
  z.object({ ok: z.literal(false), error: z.enum(["invalid_request", "slack_unavailable", "capacity_exceeded"]) }).strict(),
]);
export type TaskChannelPeopleResponse = z.infer<typeof TaskChannelPeopleResponseSchema>;

/** E display admission: a strict, read-only metered envelope over the unchanged proof/list contracts. */
const TaskPeopleDisplayAdmissionSchema = z.object({
  version: z.literal(1),
  deadlineAt: z.number().int().nonnegative(),
  slackCallsLimit: z.number().int().min(1).max(100),
}).strict();
export const TaskPeopleDisplayReadRequestSchema = z.discriminatedUnion("operation", [
  z.object({
    kind: z.literal("task-people-display-read"), operation: z.literal("proof"),
    admission: TaskPeopleDisplayAdmissionSchema,
    request: TaskPersonProofRequestSchema,
  }).strict(),
  z.object({
    kind: z.literal("task-people-display-read"), operation: z.literal("directory"),
    admission: TaskPeopleDisplayAdmissionSchema,
    request: TaskChannelPeopleRequestSchema,
    remainingNewIdentities: z.number().int().min(0).max(100),
    knownNativeSlackUserIds: z.array(SlackUserIdSchema).max(100).refine((items) => new Set(items).size === items.length),
  }).strict(),
]);
export type TaskPeopleDisplayReadRequest = z.infer<typeof TaskPeopleDisplayReadRequestSchema>;

const TaskPeopleDisplayUsageSchema = z.object({ version: z.literal(1), slackCallsUsed: z.number().int().min(0).max(100) }).strict();
export const TaskPeopleDisplayReadResponseSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("proof"), admission: TaskPeopleDisplayUsageSchema, result: TaskPersonProofResponseSchema }).strict(),
  z.object({ operation: z.literal("directory"), admission: TaskPeopleDisplayUsageSchema, result: TaskChannelPeopleResponseSchema }).strict(),
]);
export type TaskPeopleDisplayReadResponse = z.infer<typeof TaskPeopleDisplayReadResponseSchema>;

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

/** Spec 025 A12: the broker asks DeveloperIdentity which Slack user owns a verified email (FR-012's lookup). */
export const SlackUserByEmailRequestSchema = z.object({ kind: z.literal("slack-user-by-email"), email: z.string().email().max(254) }).strict();
export type SlackUserByEmailRequest = z.infer<typeof SlackUserByEmailRequestSchema>;
export type SlackUserByEmailResponse = { ok: true; userId?: string } | { ok: false; error: "slack_unavailable" | "invalid_request" };

/** Spec 025 A13: the health route's Slack token check (auth.test), through DeveloperIdentity. */
export const SlackAuthCheckRequestSchema = z.object({ kind: z.literal("slack-auth-check") }).strict();
export type SlackAuthCheckRequest = z.infer<typeof SlackAuthCheckRequestSchema>;
export type SlackAuthCheckResponse = { ok: true; teamId: string } | { ok: false; error: string };

/** Spec 025 E9 (Q3): an admin ends every sign-in session a developer has; they may sign in again. */
export const EndDeveloperSessionsRequestSchema = z.object({ kind: z.literal("end-developer-sessions"), developerId: z.string().regex(/^[a-f0-9]{64}$/), at: z.string().datetime() }).strict();
export type EndDeveloperSessionsRequest = z.infer<typeof EndDeveloperSessionsRequestSchema>;
export type EndDeveloperSessionsResponse = { ok: true } | { ok: false; error: "not_found" | "invalid_request" | "unavailable" };

/** Spec 025 E12 (Q8): a public channel of the environment's team, by its name. */
export const ChannelByNameRequestSchema = z.object({ kind: z.literal("channel-by-name"), name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/) }).strict();
export type ChannelByNameRequest = z.infer<typeof ChannelByNameRequestSchema>;
export type ChannelByNameResponse = { ok: true; channel?: { channelId: string; name: string } } | { ok: false; error: "slack_unavailable" | "invalid_request" };
