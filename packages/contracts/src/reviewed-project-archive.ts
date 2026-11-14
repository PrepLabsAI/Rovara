// Lane B: browser-safe reviewed archive boundary. A receipt describes the original action;
// current is a fresh authority-checked read and may already be active after a restore.
import { z } from "zod";
import { OrgIdSchema } from "./browser-ids.js";
import { AGENTX_NAME_PATTERN } from "./names.js";
const project = z.string().regex(AGENTX_NAME_PATTERN);
const lifecycle = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1);
const config = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const ReviewedProjectArchiveBodySchema = z.object({ requestId: z.string().uuid(), expectedOrgId: OrgIdSchema.optional(), expectedRevision: lifecycle, expectedProjectRevision: config, acknowledgeNewWorkStops: z.literal(true) }).strict();
export const ReviewedProjectArchivePreviewSchema = z.object({ orgId: OrgIdSchema, project, status: z.enum(["active", "archived"]), expectedRevision: lifecycle, expectedProjectRevision: config, checkedAt: z.string().datetime(), access: z.object({ actions: z.array(z.literal("archive")).max(1) }).strict() }).strict();
const receipt = z.object({ project, status: z.literal("archived"), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), projectRevision: config, archivedAt: z.string().datetime(), egressReconciliation: z.literal("pending") }).strict();
export const ReviewedProjectArchiveOutcomeSchema = z.object({ receipt, replayed: z.boolean(), current: ReviewedProjectArchivePreviewSchema, effects: z.object({ egress: z.enum(["synchronized", "pending", "not_attempted"]), archiveHook: z.enum(["completed", "pending", "not_configured", "not_attempted"]), /** The project's stored proof evidence: removed in the request, or still being removed (a scheduled run finishes it). */ evidenceClean: z.enum(["completed", "pending", "not_configured", "not_attempted"]).optional() }).strict() }).strict();
export type ReviewedProjectArchivePreview = z.infer<typeof ReviewedProjectArchivePreviewSchema>;
export type ReviewedProjectArchiveOutcome = z.infer<typeof ReviewedProjectArchiveOutcomeSchema>;
// HTTP envelopes add requestId. Readers discard envelope-only fields before UI caching.
export const ReviewedProjectArchivePreviewReaderSchema = ReviewedProjectArchivePreviewSchema.strip();
export const ReviewedProjectArchiveOutcomeReaderSchema = ReviewedProjectArchiveOutcomeSchema.strip();
