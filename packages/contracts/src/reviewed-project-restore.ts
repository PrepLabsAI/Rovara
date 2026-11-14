// Lane B reviewed restore browser boundary. Receipt describes the original action;
// current is freshly authorized state, including after a later archive.
import { z } from "zod";
import { OrgIdSchema } from "./browser-ids.js";
import { AGENTX_NAME_PATTERN } from "./names.js";
const project = z.string().regex(AGENTX_NAME_PATTERN);
const lifecycle = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1);
const config = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const ReviewedProjectRestoreBodySchema = z.object({ requestId: z.string().uuid(), expectedOrgId: OrgIdSchema.optional(), expectedRevision: lifecycle, expectedProjectRevision: config, acknowledgeNewWorkAllowed: z.literal(true) }).strict();
export const ReviewedProjectRestorePreviewSchema = z.object({ orgId: OrgIdSchema, project, status: z.enum(["active", "archived"]), expectedRevision: lifecycle, expectedProjectRevision: config, checkedAt: z.string().datetime(), prerequisites: z.enum(["checked", "not_required"]), access: z.object({ actions: z.array(z.literal("restore")).max(1) }).strict() }).strict();
const receipt = z.object({ project, status: z.literal("active"), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), projectRevision: config, restoredAt: z.string().datetime(), egressReconciliation: z.literal("pending") }).strict();
export const ReviewedProjectRestoreOutcomeSchema = z.object({ receipt, replayed: z.boolean(), current: ReviewedProjectRestorePreviewSchema, effects: z.object({ egress: z.enum(["synchronized", "pending", "not_attempted"]) }).strict() }).strict();
export type ReviewedProjectRestorePreview = z.infer<typeof ReviewedProjectRestorePreviewSchema>;
export type ReviewedProjectRestoreOutcome = z.infer<typeof ReviewedProjectRestoreOutcomeSchema>;
export const ReviewedProjectRestorePreviewReaderSchema = ReviewedProjectRestorePreviewSchema.strip();
export const ReviewedProjectRestoreOutcomeReaderSchema = ReviewedProjectRestoreOutcomeSchema.strip();
