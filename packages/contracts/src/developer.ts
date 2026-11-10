// Spec 025 phase 25a: the developer sign-in's shared names and wire shapes. The CLI parses server
// responses with the non-strict schemas here, so a newer control plane can add fields.
import { z } from "zod";
import { ProjectRoleSchema } from "./app-projects.js";
import { EnvironmentNameSchema } from "./environments.js";
export { normalizeEmail } from "./email.js";
import { looseCopy } from "./loose.js";
import { OrgRoleNameSchema } from "./company-scope.js";
import { DeveloperTaskPolicySchema } from "./project-node.js";
import { SlackChannelIdSchema, SlackTeamIdSchema, SlackUserIdSchema } from "./slack.js";
import { WorkspaceStatusSchema } from "./workspace.js";

export const DEVELOPER_API_VERSION = "1.2";
export const AGENTX_CLI_CLIENT_ID = "agentx-cli";
export const DEVELOPER_TOKEN_AUDIENCE = "agentx-developer";
export const DEVELOPER_ACCESS_TOKEN_SECONDS = 3600;
export const DEVELOPER_SESSION_SECONDS = 7 * 24 * 3600;
export const DEVELOPER_CODE_SECONDS = 300;
export const DEVELOPER_AUTH_REQUEST_SECONDS = 600;
/**
 * Plan 2, Task 8b: how long a sign-in counts as fresh for changing the account's sign-in methods (removing one, adding one back): ten
 * minutes from the interactive sign-in itself. A refresh renewal never extends it.
 */
export const FRESH_SIGN_IN_SECONDS = 600;
export const SLACK_OIDC_ISSUER = "https://slack.com";

export { DeveloperSignInMethodSchema, type DeveloperSignInMethod } from "./developer-web.js";
import { ExternalAccountRefSchema, SignInMethodIdSchema, readExternalAccount } from "./outside-account.js";

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
    /** SAML single sign-on, on installs whose administrator saved and enabled the identity provider's settings; absent from an older server. */
    saml: z.object({ displayName: z.string().min(1).max(40) }).nullable().optional(),
    /** The hosted Rovara sign-in, which creates an org on first sign-in; absent from an older server. */
    cloud: z.object({ displayName: z.string().min(1).max(40) }).nullable().optional(),
    /** Sign up and sign in with GitHub, on cloud installs that configured a GitHub OAuth app; absent from an older server. */
    github: z.object({ displayName: z.string().min(1).max(40) }).nullable().optional(),
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
  provider: SignInMethodIdSchema,
  /** Legacy alias of `account` for a Slack-linked developer: read with `readExternalAccount`; new code writes `account`. */
  slackUserId: SlackUserIdSchema.optional(),
  /** The developer's outside account in the neutral shape (lane P3, item I2). */
  account: ExternalAccountRefSchema.optional(),
  email: z.string().email().optional(),
  /** The developer's role in their org; absent from a control plane that predates it. */
  orgRole: OrgRoleNameSchema.optional(),
}).refine((summary) => (summary.account === undefined || summary.slackUserId === undefined) || readExternalAccount(summary) !== undefined, {
  // The neutral account and the legacy id must name one account: a reader never has to guess which of two was meant (lane P3, review L6).
  message: "account and slackUserId name different accounts", path: ["account"],
});
export type DeveloperSummary = z.infer<typeof DeveloperSummarySchema>;

export { LinkedIdentitySchema, type LinkedIdentity, AppMeResponseSchema, type AppMeResponse } from "./developer-web.js";
import { LinkedIdentitySchema } from "./developer-web.js";

/** `DELETE /v1/app/me/identities/{provider}`: the sign-in methods still linked after one was removed (Plan 2, Task 8). */
export const UnlinkIdentityAppResponseSchema = z.object({ identities: z.array(LinkedIdentitySchema) });
export type UnlinkIdentityAppResponse = z.infer<typeof UnlinkIdentityAppResponseSchema>;

/** `POST /v1/app/me/identities/{provider}`: the sign-in link that adds a method the person removed earlier back to their account (Plan 2, Task 8b). */
export const StartIdentityLinkAppResponseSchema = z.object({ authorizeUrl: z.string().url().max(2048) });
export type StartIdentityLinkAppResponse = z.infer<typeof StartIdentityLinkAppResponseSchema>;

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
  // Plan 2, Task 21: the caller's role in the project, where it comes from, and who added them (absent for the operator console's grants).
  // Absent from an older control plane.
  role: ProjectRoleSchema.optional(),
  roleSource: z.enum(["grant", "org_role", "channel"]).optional(),
  addedBy: z.object({ developerId: z.string(), name: z.string() }).optional(),
});
export type DeveloperProject = z.infer<typeof DeveloperProjectSchema>;

export const DeveloperProjectsResponseSchema = z.object({
  developer: DeveloperSummarySchema,
  projects: z.array(DeveloperProjectSchema),
  notices: z.array(z.enum(["slack_unavailable"])),
});
export type DeveloperProjectsResponse = z.infer<typeof DeveloperProjectsResponseSchema>;

/** POST /v1/dev/projects (ruling R55): what the CLI reads of the answer; the rest of the registration is the broker's. */
export const DeveloperCreateProjectResponseSchema = z.object({
  duplicate: z.boolean(),
  project: z.object({ definition: z.object({ name: z.string().min(1), revision: z.number().int().positive() }) }),
});
export type DeveloperCreateProjectResponse = z.infer<typeof DeveloperCreateProjectResponseSchema>;

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

const TaskPersonInviteAdmissionSchema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  deadlineAt: z.number().int().nonnegative(),
  remainingMs: z.number().int().min(1).max(12_000),
  authorityRemainingMs: z.number().int().min(1).max(6_000),
  slackCallsLimit: z.number().int().min(1).max(100),
  stateReadsLimit: z.number().int().min(1).max(128),
}).strict();

/** Claim-only internal request for the separately deployed invitation endpoint. */
export const TaskPersonInviteClaimRequestSchema = z.object({
  kind: z.literal("task-person-invite-claimed"),
  taskId: z.string().uuid(),
  requestId: z.string().uuid(),
  claimDigest: z.string().regex(/^[a-f0-9]{64}$/),
  admission: TaskPersonInviteAdmissionSchema,
}).strict().superRefine((value, context) => {
  if (value.admission.authorityRemainingMs > value.admission.remainingMs) {
    context.addIssue({ code: "custom", path: ["admission", "authorityRemainingMs"], message: "authority budget cannot exceed request budget" });
  }
});
export type TaskPersonInviteClaimRequest = z.infer<typeof TaskPersonInviteClaimRequestSchema>;

export const TaskPersonInviteReasonSchema = z.enum([
  "disabled", "scope_unavailable", "claim_refused", "authorization_refused", "capability_refused",
  "effect_rejected", "effect_unknown", "transport_unknown", "receipt_conflict",
]);

/** Internal result binds any effect outcome to the claim and the endpoint's durable receipt. */
export const TaskPersonInviteOutcomeSchema = z.object({
  taskId: z.string().uuid(),
  requestId: z.string().uuid(),
  claimDigest: z.string().regex(/^[a-f0-9]{64}$/),
  admissionId: z.string().uuid(),
  status: z.enum(["accepted", "failed", "unknown"]),
  executionReceiptId: z.string().uuid().optional(),
  reason: TaskPersonInviteReasonSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.status === "accepted" && (value.executionReceiptId === undefined || value.reason !== undefined)) {
    context.addIssue({ code: "custom", message: "accepted outcomes require a receipt and cannot include a failure reason" });
  }
  if (value.status === "failed" && value.reason === undefined) {
    context.addIssue({ code: "custom", path: ["reason"], message: "failed outcomes require a definite no-effect reason" });
  }
  if (value.status === "failed" && value.reason !== undefined
    && !["disabled", "scope_unavailable", "claim_refused", "authorization_refused", "capability_refused", "effect_rejected", "receipt_conflict"].includes(value.reason)) {
    context.addIssue({ code: "custom", path: ["reason"], message: "uncertain effects cannot be reported as definite failures" });
  }
  if (value.status === "unknown" && value.reason === undefined) {
    context.addIssue({ code: "custom", path: ["reason"], message: "unknown outcomes require an uncertainty reason" });
  }
});
export type TaskPersonInviteOutcome = z.infer<typeof TaskPersonInviteOutcomeSchema>;

/** Storage-neutral retained execution receipt shape. No Slack credentials or tokens are permitted. */
export const TaskPersonInviteExecutionReceiptSchema = z.object({
  pk: z.string().min(1),
  sk: z.literal("META"),
  entityType: z.literal("TASK_PERSON_INVITE_EXECUTION"),
  executionReceiptId: z.string().uuid(),
  taskId: z.string().uuid(),
  requestId: z.string().uuid(),
  claimDigest: z.string().regex(/^[a-f0-9]{64}$/),
  actorDeveloperId: z.string().regex(/^[a-f0-9]{64}$/),
  targetDeveloperId: z.string().regex(/^[a-f0-9]{64}$/),
  teamId: SlackTeamIdSchema,
  channelId: SlackChannelIdSchema,
  slackUserId: SlackUserIdSchema,
  admissionId: z.string().uuid(),
  attempt: z.literal(1),
  status: z.enum(["STARTED", "ACCEPTED", "FAILED", "UNKNOWN"]),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  reason: TaskPersonInviteReasonSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.status === "STARTED" && value.reason !== undefined) {
    context.addIssue({ code: "custom", path: ["reason"], message: "started receipts cannot have a result reason" });
  }
  if (value.status === "ACCEPTED" && value.reason !== undefined) {
    context.addIssue({ code: "custom", path: ["reason"], message: "accepted receipts cannot have a failure reason" });
  }
  if (value.status === "FAILED" && (value.reason === undefined
    || ["effect_unknown", "transport_unknown"].includes(value.reason))) {
    context.addIssue({ code: "custom", path: ["reason"], message: "failed receipts require a definite no-effect reason" });
  }
  if (value.status === "UNKNOWN" && value.reason === undefined) {
    context.addIssue({ code: "custom", path: ["reason"], message: "unknown receipts require an uncertainty reason" });
  }
});
export type TaskPersonInviteExecutionReceipt = z.infer<typeof TaskPersonInviteExecutionReceiptSchema>;

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

/**
 * Team record source rows (lane task 7): what Slack says a channel IS, read fresh (never cached) by DeveloperIdentity with the bot token. Unlike `channel-info` it also answers for a DM and a group DM
 * (ids starting with D), says whether another organisation shares the channel (Slack Connect), and only answers for the team the bot token belongs to. `{ ok: true }` without a channel: Slack does not know it.
 */
export const ChannelClassRequestSchema = z.object({ kind: z.literal("channel-class"), teamId: SlackTeamIdSchema, channelId: z.string().regex(/^[CGD][A-Z0-9]{2,31}$/) }).strict();
export type ChannelClassRequest = z.infer<typeof ChannelClassRequestSchema>;
export type ChannelClassResponse =
  | { ok: true; channel: { kind: "public" | "private" | "im" | "mpim"; extShared: boolean } }
  | { ok: true }
  | { ok: false; error: "slack_unavailable" }
  | { ok: false; error: "invalid_request" };

/**
 * Team record source pickers (lane task 10): the channels the bot can see, one page of `conversations.list` at a time, read fresh with the same bot token. Only for the team the bot token belongs to.
 * Public channels only: private channels (their names would reach people who are not in them), direct messages and group messages are never listed; they are added by typing the ID. `private` stays in the type so a reply
 * that carries one can be read and dropped on the broker side. `joined` says whether the bot is in the
 * channel (`is_member`; missing is not joined). `cursor` is Slack's own, passed back as Slack gave it.
 * `missing_scope`: the Slack app was installed without the scopes that listing needs (the broker says so in one fixed sentence).
 */
export const ChannelListRequestSchema = z.object({
  kind: z.literal("channel-list"), teamId: SlackTeamIdSchema, cursor: z.string().regex(/^[A-Za-z0-9+/=_%.-]{1,300}$/).optional(),
}).strict();
export type ChannelListRequest = z.infer<typeof ChannelListRequestSchema>;
export type ChannelListEntry = { id: string; name: string; kind: "public" | "private"; extShared: boolean; joined: boolean };
export type ChannelListResponse =
  | { ok: true; channels: ChannelListEntry[]; next?: string }
  | { ok: false; error: "slack_unavailable" | "missing_scope" | "invalid_request" };

/**
 * Team record source pickers (lane task 11): "your private channels". One Slack user's private channels that the bot is also in: `users.conversations` with `user` and `types=private_channel` (with a bot token Slack returns
 * only the private channels the bot shares with that user). The user id is the editor's own linked Slack id, chosen by the broker from its sign-in store, never from a request. Only for the install's own team. The reply is a
 * `ChannelListResponse` whose entries are private channels only. A Slack user who is not in this workspace has no channels here (an empty list).
 */
export const MemberChannelsRequestSchema = z.object({
  kind: z.literal("member-channels"), teamId: SlackTeamIdSchema, userId: SlackUserIdSchema, cursor: z.string().regex(/^[A-Za-z0-9+/=_%.-]{1,300}$/).optional(),
}).strict();
export type MemberChannelsRequest = z.infer<typeof MemberChannelsRequestSchema>;

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

/**
 * ERASE-NAME-1: a person's erase clears the name their sign-in record holds (the broker has no write on that table, so it asks DeveloperIdentity). The record then holds the placeholder name, and a later sign-in
 * leaves it alone. Not found is an answer (the person never signed in).
 */
export const EraseDeveloperNameRequestSchema = z.object({ kind: z.literal("erase-developer-name"), developerId: z.string().regex(/^[a-f0-9]{64}$/), at: z.string().datetime() }).strict();
export type EraseDeveloperNameRequest = z.infer<typeof EraseDeveloperNameRequestSchema>;
export type EraseDeveloperNameResponse = { ok: true } | { ok: false; error: "not_found" | "invalid_request" | "unavailable" };

/**
 * The sign-in methods a person may unlink from their account (Plan 2, Task 8): the two that cloud installs link by verified email, and Slack, which a signed-in web user links
 * to their own account by signing in with Slack (owner decision, 2026-11-05).
 */
export const UnlinkableSignInMethodSchema = z.enum(["cloud", "github", "slack"]);
export type UnlinkableSignInMethod = z.infer<typeof UnlinkableSignInMethodSchema>;
/** The id of a sign-in session (a UUID), which the broker names from the verified token. */
const SessionIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
/**
 * Plan 2, Task 8 and 8b: unlinks one sign-in method from the caller's own developer, through DeveloperIdentity (the broker may not write
 * the sign-in table). `developerId` and `sessionId` are the caller's verified token's, never body values of the public route. The session
 * is what proves the person signed in freshly with a method that is not the one being removed.
 */
export const UnlinkIdentityRequestSchema = z.object({ kind: z.literal("unlink-identity"), developerId: z.string().regex(/^[a-f0-9]{64}$/), sessionId: SessionIdSchema, provider: UnlinkableSignInMethodSchema }).strict();
export type UnlinkIdentityRequest = z.infer<typeof UnlinkIdentityRequestSchema>;
/**
 * `refused` carries the person's words (the store's fixed refusal text); `reauth` is a refusal that a fresh sign-in would fix (its words
 * say which); `not_found` is a method that is not linked.
 */
export type UnlinkIdentityResponse = { ok: true } | { ok: false; error: "refused" | "reauth"; message: string } | { ok: false; error: "not_found" | "invalid_request" | "unavailable" };

/**
 * Plan 2, Task 8b: starts adding a sign-in method the person removed earlier back to their own account. It is made under a fresh session
 * of the caller, which must be fresh again when the person finishes at the provider. The result is the sign-in link to open.
 */
export const StartIdentityLinkRequestSchema = z.object({
  kind: z.literal("start-identity-link"), developerId: z.string().regex(/^[a-f0-9]{64}$/), sessionId: SessionIdSchema, provider: UnlinkableSignInMethodSchema,
  /** The web app started it, from a live browser session: the link then has to be finished in the browser that holds that session. The Slack link is made only this way. */
  browser: z.literal(true).optional(),
  /** UX1: where a browser link of GitHub sends the person back (the account menu, or the onboarding step it was started from). Fixed choices only. */
  returnTo: z.enum(["/app", "/app/onboard", "/app/admin/connections"]).optional(),
}).strict();
export type StartIdentityLinkRequest = z.infer<typeof StartIdentityLinkRequestSchema>;
export type StartIdentityLinkResponse = { ok: true; authorizeUrl: string } | { ok: false; error: "refused" | "reauth"; message: string } | { ok: false; error: "invalid_request" | "unavailable" };

/** Spec 025 E12 (Q8): a public channel of the environment's team, by its name. */
export const ChannelByNameRequestSchema = z.object({ kind: z.literal("channel-by-name"), name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/) }).strict();
export type ChannelByNameRequest = z.infer<typeof ChannelByNameRequestSchema>;
export type ChannelByNameResponse = { ok: true; channel?: { channelId: string; name: string } } | { ok: false; error: "slack_unavailable" | "invalid_request" };
