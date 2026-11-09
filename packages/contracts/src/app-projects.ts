// Plan 2, Task 11: what the app shows of a project (its list and its detail) and what each project role may do. A person's
// role in a project is `maintainer`, `contributor` or `viewer`; an org owner or admin is a maintainer of every project in their org.
import { z } from "zod";
import { SlackChannelIdSchema, SlackTeamIdSchema } from "./browser-ids.js";
import { isPublicSuffix } from "./public-suffix.js";
import { ErrorRefSchema } from "./live-interaction.js";

export const ProjectRoleSchema = z.enum(["maintainer", "contributor", "viewer"]);
export type ProjectRole = z.infer<typeof ProjectRoleSchema>;

/**
 * What a project role may do. A union (not an enum of the schema) so a later plan extends it with its own actions.
 * Plan 3 Task 3b adds the agent actions: manage the project's agents, approve spend and writes, and see spend (maintainers only).
 */
export type ProjectPermission =
  | "view"
  | "start_tasks"
  | "edit_settings"
  | "manage_members"
  | "archive"
  | "setup_check"
  | "manage_agents"
  | "approve_spend"
  | "approve_writes"
  | "view_spend";

export const PROJECT_PERMISSIONS: Record<ProjectRole, ReadonlyArray<ProjectPermission>> = {
  maintainer: ["view", "start_tasks", "edit_settings", "manage_members", "archive", "setup_check", "manage_agents", "approve_spend", "approve_writes", "view_spend"],
  contributor: ["view", "start_tasks"],
  viewer: ["view"],
};

export function projectAllows(role: ProjectRole, action: ProjectPermission): boolean {
  return PROJECT_PERMISSIONS[role].includes(action);
}

export const ProjectStatusSchema = z.enum(["active", "archived"]);
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

export const ProjectSetupStatusSchema = z.enum(["unchecked", "checking", "ready", "failed", "outdated"]);
export type ProjectSetupStatus = z.infer<typeof ProjectSetupStatusSchema>;

export const AppProjectSummarySchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  status: ProjectStatusSchema,
  latestRevision: z.number().int().positive(),
  repositories: z.array(z.object({ name: z.string().optional(), fullName: z.string(), defaultBranch: z.string() })),
  myRole: ProjectRoleSchema,
  setup: z.object({
    status: ProjectSetupStatusSchema,
    checkedRevision: z.number().int().positive().optional(),
    checkedAt: z.string().optional(),
    failedStep: z.string().optional(),
    /** Live interaction F1: what "Fix with agent" is about when the setup check failed or is outdated. Fixed codes and ids only. */
    errorRef: ErrorRefSchema.optional(),
  }),
});
export type AppProjectSummary = z.infer<typeof AppProjectSummarySchema>;

export const AppProjectDomainStatusSchema = z.enum(["approved", "pending", "rejected"]);

/**
 * TE-4 (owner decision 2026-11-02): whether the setup and test commands and the dev container now in a project's settings have been PROVED by a check on a fresh machine.
 *   `proven`   these exact commands passed a check (or are the setup restored to one that did)
 *   `checking` a check of them is running
 *   `unproven` they were saved and not (yet) proved: the check failed, did not start, or was never run
 * `held` is the change an API key asked for: it is NOT in the settings. It is written only if its own check passes at the settings revision it was made against.
 * Fixed words and short reasons only: never a command.
 */
export const SettingsHeldFieldSchema = z.enum(["setupCommands", "testCommands", "devcontainer"]);
export const SettingsHeldSchema = z.object({
  status: z.enum(["checking", "failed", "stale", "refused", "not_started"]),
  fields: z.array(SettingsHeldFieldSchema),
  heldAt: z.string(),
  /** Why it did not go in (a failed check's redacted one-liner, or a fixed sentence). */
  reason: z.string().optional(),
}).strict();
export type SettingsHeld = z.infer<typeof SettingsHeldSchema>;
export const SettingsProofSchema = z.object({
  status: z.enum(["proven", "checking", "unproven"]),
  /** When the commands in the settings were proved, if they were. */
  provenAt: z.string().optional(),
  /** Why they are unproven: the check's failing step, or a fixed sentence. */
  reason: z.string().optional(),
  /** When the last setup that was proved was proved; absent when none ever was (then there is nothing to go back to). */
  lastProvenAt: z.string().optional(),
  /** True when the settings differ from the last proved setup, so a maintainer in a browser may undo to it. */
  canUndo: z.boolean(),
  /** A banner for the person who saved commands that then failed their check. */
  notice: z.object({ message: z.string(), at: z.string(), savedBy: z.string().optional() }).strict().optional(),
  held: SettingsHeldSchema.optional(),
}).strict();
export type SettingsProof = z.infer<typeof SettingsProofSchema>;

/** `POST /v1/app/projects/{name}/settings/undo`: write the last proved setup back as a new revision. A maintainer, in a browser session, signed in within the last 10 minutes. */
export const ProjectSettingsUndoBodySchema = z.object({ requestId: z.string().uuid(), expectedRevision: z.number().int().positive() }).strict();
export type ProjectSettingsUndoBody = z.infer<typeof ProjectSettingsUndoBodySchema>;

export const AppProjectDetailSchema = AppProjectSummarySchema.extend({
  savedWorkingBranches: z.array(z.object({repository:z.string(),fullName:z.string(),branch:z.string(),commit:z.string().regex(/^[a-f0-9]{40}$/)})).max(32).optional(),
  settings: z.object({
    setupCommands: z.array(z.string()),
    testCommands: z.array(z.string()),
    devcontainer: z.object({ repository: z.string(), configPath: z.string() }).nullable(),
    /** Each domain with where it stands: on a hosted install a new one is `pending` until staff approve it, and a `rejected` one says why. */
    allowedDomains: z.array(z.object({ domain: z.string(), status: AppProjectDomainStatusSchema, reason: z.string().optional() })),
  }),
  createdAt: z.string(),
  createdBy: z.object({ developerId: z.string(), name: z.string() }),
  /** TE-4: whether the commands in the settings are proved. Absent where setup checks are not set up. */
  settingsProof: SettingsProofSchema.optional(),
});
export type AppProjectDetail = z.infer<typeof AppProjectDetailSchema>;

/** The answer to archiving or restoring a project (Plan 2, Task 20): the project as the app now shows it, and a warning when the firewall could not be told at once. */
export const ProjectArchiveResponseSchema = z.object({ project: AppProjectDetailSchema, warnings: z.array(z.string()) });
export type ProjectArchiveResponse = z.infer<typeof ProjectArchiveResponseSchema>;

/**
 * `POST /v1/app/projects/{name}/setup-check` (Plan 2, Task 22): a maintainer asks for the project's setup and test commands to run on a fresh workspace.
 * The answer is the project as the app now shows it (its `setup.status` is `checking`, or whatever a replayed request's check has become).
 */
export const ProjectSetupCheckBodySchema = z.object({ requestId: z.string().uuid() }).strict();
export type ProjectSetupCheckBody = z.infer<typeof ProjectSetupCheckBodySchema>;
export const ProjectSetupCheckResponseSchema = z.object({ project: AppProjectDetailSchema });
export type ProjectSetupCheckResponse = z.infer<typeof ProjectSetupCheckResponseSchema>;

/** Where a person's role in a project comes from: a grant on the project, or their org role (an owner or admin maintains every project). */
export const ProjectMemberSourceSchema = z.enum(["grant", "org_role"]);
export type ProjectMemberSource = z.infer<typeof ProjectMemberSourceSchema>;

/** One person in a project (Plan 2, Task 21), as `GET /v1/app/projects/{name}/members` lists them. `grantedBy` is absent when the operator console made the grant. */
export const ProjectMemberSchema = z.object({
  developerId: z.string(),
  name: z.string(),
  email: z.string().optional(),
  role: ProjectRoleSchema,
  source: ProjectMemberSourceSchema,
  grantedBy: z.object({ developerId: z.string(), name: z.string() }).optional(),
});
export type ProjectMember = z.infer<typeof ProjectMemberSchema>;

export const ProjectMembersResponseSchema = z.object({ members: z.array(ProjectMemberSchema) });
export type ProjectMembersResponse = z.infer<typeof ProjectMembersResponseSchema>;

/** `PUT /v1/app/projects/{name}/members/{developerId}`: a maintainer gives a member of the org a role in the project. */
export const PutProjectMemberBodySchema = z.object({ requestId: z.string().uuid(), role: ProjectRoleSchema }).strict();
export type PutProjectMemberBody = z.infer<typeof PutProjectMemberBodySchema>;
export const ProjectMemberChangeResponseSchema = z.object({ member: z.object({ developerId: z.string(), role: ProjectRoleSchema }) });
export type ProjectMemberChangeResponse = z.infer<typeof ProjectMemberChangeResponseSchema>;

/** `DELETE /v1/app/projects/{name}/members/{developerId}`: the body carries only the request id; `removed` is false when the person had no grant. */
export const RemoveProjectMemberBodySchema = z.object({ requestId: z.string().uuid() }).strict();
export const ProjectMemberRemoveResponseSchema = z.object({ developerId: z.string(), removed: z.boolean() });
export type ProjectMemberRemoveResponse = z.infer<typeof ProjectMemberRemoveResponseSchema>;

/**
 * `PUT /v1/app/projects/{name}/slack-channel` (release 0.4.17): an org owner or admin binds a Slack channel of the org's Slack workspace to the project.
 * `teamId` is optional: without it the org's single Slack workspace is used. `changed` is false when the channel was already bound to this project.
 */
export const PutProjectSlackChannelBodySchema = z.object({ requestId: z.string().uuid(), channelId: SlackChannelIdSchema, teamId: SlackTeamIdSchema.optional() }).strict();
export type PutProjectSlackChannelBody = z.infer<typeof PutProjectSlackChannelBodySchema>;
export const ProjectSlackChannelResponseSchema = z.object({
  binding: z.object({ teamId: SlackTeamIdSchema, channelId: SlackChannelIdSchema, projectName: z.string(), updatedAt: z.string() }),
  changed: z.boolean(),
});
export type ProjectSlackChannelResponse = z.infer<typeof ProjectSlackChannelResponseSchema>;

/** `DELETE /v1/app/projects/{name}/slack-channel`: unbinds one channel of the project; `removed` is false when it was not bound. */
export const RemoveProjectSlackChannelBodySchema = PutProjectSlackChannelBodySchema;
export const ProjectSlackChannelRemoveResponseSchema = z.object({ teamId: SlackTeamIdSchema, channelId: SlackChannelIdSchema, removed: z.boolean() });
export type ProjectSlackChannelRemoveResponse = z.infer<typeof ProjectSlackChannelRemoveResponseSchema>;

export const AppProjectsResponseSchema = z.object({ projects: z.array(AppProjectSummarySchema) });
export type AppProjectsResponse = z.infer<typeof AppProjectsResponseSchema>;

/** What an allowed-domain refusal says. It names no value: a refusal reaches logs and other people's screens. */
export const ALLOWED_DOMAIN_MESSAGE = "must be a domain name such as artifacts.acme.dev or *.acme.dev";

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// A real top-level name is letters (at least two) or punycode. A last label of digits (an IPv4 address) or with no letters never is one.
const TOP_LEVEL_LABEL = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/** The labels of a lower-cased entry's host (without a leading `*.`) when it is a hostname of at least two labels and up to 253 characters. */
function hostLabelsOf(value: string): string[] | undefined {
  if (value.length > 253) return undefined;
  const labels = (value.startsWith("*.") ? value.slice(2) : value).split(".");
  // A single label (`localhost`, `com`, and so `*` and `*.com`) names no site of one owner.
  // A real top-level name is letters or punycode, so an IPv4 literal never has the shape.
  return labels.length >= 2 && labels.every((label) => DNS_LABEL.test(label)) && TOP_LEVEL_LABEL.test(labels.at(-1)!) ? labels : undefined;
}

/**
 * Whether a lower-cased entry is a hostname, or `*.` and a hostname, that is not a public suffix and does not sit over one. It is the one check
 * between a domain and the DNS firewall: upper case, a trailing dot, `*`, a bare TLD and anything not ASCII (punycode is) all fail it.
 */
export function isAllowedDomain(value: string): boolean {
  const labels = hostLabelsOf(value);
  if (labels === undefined) return false;
  const host = labels.join(".");
  // `github.io` and `*.github.io` are every GitHub Pages site; `*.s3.amazonaws.com` is every bucket. Their owners are not this project's.
  if (isPublicSuffix(host)) return false;
  // `*.sch.uk` is every child of `sch.uk`, and the list says each one is a suffix (a `*.sch.uk` rule): the wildcard is as wide as `*.com`.
  // A child that is not a suffix (an exception rule, as `city.kawasaki.jp`) leaves a name of one owner, so only a child's own suffix test counts.
  return !(value.startsWith("*.") && isPublicSuffix(`x.${host}`));
}

/**
 * A domain as a stored revision holds it: lower-cased and shaped like a hostname, with an optional leading `*.`. The Public Suffix List is
 * not consulted: it is checked when a domain is written (`AllowedDomainSchema`), so a later refresh of the list cannot make a stored
 * project unreadable.
 */
export const StoredAllowedDomainSchema = z.string().transform((value, context) => {
  const domain = value.toLowerCase();
  if (hostLabelsOf(domain) !== undefined) return domain;
  context.addIssue({ code: "custom", message: ALLOWED_DOMAIN_MESSAGE });
  return z.NEVER;
});

/** The index of the first entry a write refuses (the list check `AllowedDomainSchema` makes), or undefined when every entry passes. */
export function firstRefusedDomainIndex(domains: ReadonlyArray<string>): number | undefined {
  const index = domains.findIndex((domain) => !isAllowedDomain(domain.toLowerCase()));
  return index === -1 ? undefined : index;
}

/**
 * A domain a project's machines may reach, as written: a hostname, lower-cased, of up to 253 characters, with an optional leading `*.`
 * (subdomains only, as the DNS firewall reads it). Refused: `*` alone, IP address literals, single-label names, a public suffix, and a
 * wildcard over a public suffix or over names that are all public suffixes. The Public Suffix List decides the last three
 * (`amazonaws.com` is not one, `s3.amazonaws.com` is, and `*.sch.uk` covers only suffixes).
 */
export const AllowedDomainSchema = z.string().transform((value, context) => {
  const domain = value.toLowerCase();
  if (isAllowedDomain(domain)) return domain;
  context.addIssue({ code: "custom", message: ALLOWED_DOMAIN_MESSAGE });
  return z.NEVER;
});

const SETTINGS_COMMAND_MAX_LENGTH = 500;
const SETTINGS_COMMANDS_MAX = 16;
const settingsCommands = z.array(z.string().max(SETTINGS_COMMAND_MAX_LENGTH)).max(SETTINGS_COMMANDS_MAX);
const REPOSITORY_FULL_NAME = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;

/**
 * `PUT /v1/app/projects/{name}/settings`: only the fields given change. Commands and domains replace their whole list. `devcontainer: null`
 * removes the devcontainer. `expectedRevision` is the revision the person was looking at; a newer one refuses the change.
 */
export const ProjectSettingsBodySchema = z.object({
  requestId: z.string().uuid(),
  expectedRevision: z.number().int().positive(),
  description: z.string().max(280).optional(),
  setupCommands: settingsCommands.optional(),
  testCommands: settingsCommands.optional(),
  devcontainer: z.object({ repository: z.string().min(1).max(140), configPath: z.string().min(1).max(512).optional() }).strict().nullable().optional(),
  allowedDomains: z.array(AllowedDomainSchema).max(50).optional(),
  addRepositories: z.array(z.string().regex(REPOSITORY_FULL_NAME, "must be owner/name").refine((value) => !/\/(\.{1,2}|\.git)$/.test(value), "must be owner/name")).max(8).optional(),
  removeRepositories: z.array(z.string().min(1).max(140)).max(8).optional(),
}).strict();
export type ProjectSettingsBody = z.infer<typeof ProjectSettingsBodySchema>;

/** `held` (TE-4): present when an API key asked to change commands or the dev container: they are not in the settings yet, and are written only if their check passes. */
export const ProjectSettingsResponseSchema = z.object({ project: AppProjectDetailSchema, warnings: z.array(z.string()), held: SettingsHeldSchema.optional() });
export type ProjectSettingsResponse = z.infer<typeof ProjectSettingsResponseSchema>;
