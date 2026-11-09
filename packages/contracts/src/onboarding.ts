import { AgentXNameSchema } from "./names.js";
import { forwardReader } from "./forward-reader.js";
import { z } from "zod";
import { cleanDisplayName } from "./display-name.js";
export const RenameOrganizationBodySchema = z.object({
 requestId: z.string().uuid(),
 name: z.string().refine(value => Array.from(value).length <= 80, "must have at most 80 characters").transform(value => cleanDisplayName(value)).refine((value): value is string => value !== undefined, "must have a printable name"),
}).strict();
export const RenameOrganizationResponseSchema = z.object({ org: z.object({ orgId: z.string(), name: z.string(), plan: z.string() }), role: z.literal("owner") });

const COMMAND_MAX_LENGTH = 500;
const DESCRIPTION_MAX_LENGTH = 280;
const REPOSITORY = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;
/** Commands a project is created with: one in `setupCommand`/`testCommand`, or the whole ordered list in `setupCommands`/`testCommands` (the same 16 that project settings keep). */
const COMMANDS_MAX = 16;
const commandList = z.array(z.string().max(COMMAND_MAX_LENGTH)).min(1).max(COMMANDS_MAX);
export const CreateProjectBodySchema = z.object({
  requestId: z.string().uuid(),
  repository: z.string().regex(REPOSITORY, "must be owner/name").refine((value) => !/\/(\.{1,2}|\.git)$/.test(value), "must be owner/name"),
  name: AgentXNameSchema.optional(),
  description: z.string().max(DESCRIPTION_MAX_LENGTH).optional(),
  setupCommand: z.string().max(COMMAND_MAX_LENGTH).optional(),
  testCommand: z.string().max(COMMAND_MAX_LENGTH).optional(),
  setupCommands: commandList.optional(),
  testCommands: commandList.optional(),
}).strict().superRefine((body, context) => {
  for (const [single, list] of [["setupCommand", "setupCommands"], ["testCommand", "testCommands"]] as const) {
    if (body[single] !== undefined && body[list] !== undefined) context.addIssue({ code: "custom", path: [list], message: `give ${single} or ${list}, not both` });
  }
});
export const CreateOrganizationInviteBodySchema = z.object({ requestId: z.string().uuid(), role: z.enum(["admin", "member"]), email: z.string().trim().email().max(254).optional() }).strict();
export const OrganizationInviteResponseSchema = z.object({ inviteUrl: z.string() });
export const GithubConnectResponseSchema = z.object({ installUrl: z.string(), expiresAt: z.string(), orgName: z.string().optional(), ownerName: z.string().optional() });
export const GithubInstallationsResponseSchema = z.object({ installations: z.array(z.object({ installationId: z.number().int().positive(), accountLogin: z.string(), accountType: z.enum(["User", "Organization"]), repositorySelection: z.enum(["all", "selected"]), status: z.enum(["active", "suspended", "removed"]), connectedBy: z.string().regex(/^[a-f0-9]{64}$/).optional(), connectedAt: z.string().max(40).optional() })) });
export const GithubRepositoriesResponseSchema = z.object({ repositories: z.array(z.object({ fullName: z.string(), githubRepositoryId: z.number().int().positive(), private: z.boolean(), defaultBranch: z.string(), project: z.string().optional() })) });
export const CloudProjectCreatedResponseSchema = z.object({ duplicate: z.boolean(), project: z.object({ definition: z.object({ name: AgentXNameSchema }), registeredAt: z.string() }), warnings: z.array(z.string()).optional() });
export const ProjectRosterAddedResponseSchema = z.object({ agent: z.object({ agentId: z.string(), name: z.string().optional() }) });
export const GithubConnectResponseReaderSchema = forwardReader(GithubConnectResponseSchema);
export const GithubInstallationsResponseReaderSchema = forwardReader(GithubInstallationsResponseSchema);
export const GithubRepositoriesResponseReaderSchema = forwardReader(GithubRepositoriesResponseSchema);
export const CloudProjectCreatedResponseReaderSchema = forwardReader(CloudProjectCreatedResponseSchema);

export const RevokeOrganizationInviteBodySchema = z.object({ requestId: z.string().uuid(), expectedRevision: z.number().int().nonnegative() }).strict();
export const RevokeOrganizationInviteResponseSchema = z.object({ inviteId: z.string().uuid(), revokedAt: z.string().datetime(), revision: z.number().int().positive() }).strict();
