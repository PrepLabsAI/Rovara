import { z } from "zod";
import { OrgIdSchema, SlackTeamIdSchema, SlackChannelIdSchema } from "./browser-ids.js";
import { AgentXNameSchema } from "./names.js";
const stamp = z.string().datetime(), uuid = z.string().uuid(), digest = z.string().regex(/^[a-f0-9]{64}$/);
export const ReviewedSlackUnbindBodySchema = z.object({ expectedOrgId: OrgIdSchema, requestId: uuid, teamId: SlackTeamIdSchema, channelId: SlackChannelIdSchema, expectedContextDigest: digest }).strict();
const link = z.object({ teamId: SlackTeamIdSchema, channelId: SlackChannelIdSchema, updatedAt: stamp }).strict();
export const ProjectSlackInventorySchema = z.object({ orgId: OrgIdSchema, project: AgentXNameSchema, workspaces: z.array(SlackTeamIdSchema).max(20), bindings: z.array(link).max(100), continuation: z.string().min(1).max(1024).nullable(), limitReached: z.boolean(), partial: z.boolean(), inspected: z.number().int().min(0).max(1000), botMembership: z.literal("not_verified") }).strict().superRefine((value, ctx) => {
 if ((value.continuation !== null || value.limitReached) && !value.partial) ctx.addIssue({ code: "custom", message: "Incomplete binding evidence must be marked partial." });
 if (new Set(value.workspaces).size !== value.workspaces.length || new Set(value.bindings.map(row => `${row.teamId}:${row.channelId}`)).size !== value.bindings.length || value.bindings.some(row => !value.workspaces.includes(row.teamId))) ctx.addIssue({ code: "custom", message: "Binding evidence scope mismatch." });
});
export const ProjectSlackInventoryReaderSchema = ProjectSlackInventorySchema.strip();
export const ProjectSlackTargetSchema = z.object({ orgId: OrgIdSchema, project: AgentXNameSchema, teamId: SlackTeamIdSchema, channelId: SlackChannelIdSchema, projectStatus: z.enum(["active", "archived"]), state: z.enum(["linked", "unlinked"]), updatedAt: stamp.optional(), contextDigest: digest, botMembership: z.literal("not_verified") }).strict().superRefine((value, ctx) => {
 if ((value.state === "linked") !== (value.updatedAt !== undefined)) ctx.addIssue({ code: "custom", message: "Binding observation mismatch." });
});
export const ProjectSlackTargetReaderSchema = ProjectSlackTargetSchema.strip();
const unbound = z.object({ teamId: SlackTeamIdSchema, channelId: SlackChannelIdSchema, removed: z.boolean() }).strict();
const bound = z.object({ binding: link.extend({ projectName: AgentXNameSchema }).strict(), changed: z.boolean() }).strict();
const receipt = z.discriminatedUnion("operation", [
 z.object({ requestId: uuid, operation: z.literal("unbind"), outcome: unbound, receiptExpiresAt: stamp }).strict(),
 z.object({ requestId: uuid, operation: z.literal("bind"), outcome: bound, receiptExpiresAt: stamp }).strict(),
]);
export const ProjectSlackReceiptSchema = z.object({ kind: z.literal("receipt"), orgId: OrgIdSchema, project: AgentXNameSchema, receipt }).strict().superRefine((value, ctx) => {
 if (value.receipt.operation === "bind" && value.receipt.outcome.binding.projectName !== value.project) ctx.addIssue({ code: "custom", message: "Receipt project mismatch." });
});
export const ProjectSlackReceiptReaderSchema = ProjectSlackReceiptSchema.strip();
export type ReviewedSlackUnbindBody = z.infer<typeof ReviewedSlackUnbindBodySchema>;
export type ProjectSlackTarget = z.infer<typeof ProjectSlackTargetSchema>;
export const ReviewedSlackProposeBodySchema = ReviewedSlackUnbindBodySchema;
export const ReviewedSlackApproveBodySchema = z.object({ expectedOrgId: OrgIdSchema, requestId: uuid }).strict();
const person = z.string().regex(/^[a-f0-9]{64}$/);
export const ProjectSlackProposalViewSchema = z.object({ proposalId: uuid, by: person, teamId: SlackTeamIdSchema, channelId: SlackChannelIdSchema,
 state: z.enum(["pending", "applied", "cancelled", "rejected"]), createdAt: stamp, expiresAt: stamp,
 mode: z.enum(["second_person", "sole_owner_exception"]).optional(), decidedBy: person.optional(), decidedAt: stamp.optional(),
}).strict().superRefine((value, ctx) => {
 if (Date.parse(value.expiresAt) !== Date.parse(value.createdAt) + 86400000 || (value.state === "applied" && (value.mode === undefined || value.decidedBy === undefined || value.decidedAt === undefined))
  || (["cancelled", "rejected"].includes(value.state) && (value.mode !== undefined || value.decidedBy === undefined || value.decidedAt === undefined))
  || (value.state === "pending" && (value.mode !== undefined || value.decidedBy !== undefined || value.decidedAt !== undefined))) ctx.addIssue({ code: "custom", message: "Slack proposal state mismatch." });
});
export const ProjectSlackProposalSchema = z.object({ kind: z.literal("proposal"), orgId: OrgIdSchema, project: AgentXNameSchema, proposal: ProjectSlackProposalViewSchema.nullable() }).strict();
export const ProjectSlackProposalReaderSchema = ProjectSlackProposalSchema.strip();

export const ReviewedSlackDecisionBodySchema = ReviewedSlackApproveBodySchema;
export const ProjectSlackDecisionSchema = z.object({ kind: z.literal("decision"), orgId: OrgIdSchema, project: AgentXNameSchema,
 decision: z.object({ requestId: uuid, proposalId: uuid, state: z.enum(["cancelled", "rejected"]), createdAt: stamp, expiresAt: stamp }).strict() }).strict();
export const ProjectSlackDecisionReaderSchema = ProjectSlackDecisionSchema.strip();
