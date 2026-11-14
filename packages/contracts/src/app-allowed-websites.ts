import { z } from "zod";
import { OrgIdSchema } from "./browser-ids.js";
import { AgentXNameSchema } from "./names.js";
import { AllowedDomainSchema } from "./app-projects.js";
const uuid = z.string().uuid(), revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER), fingerprint = z.string().regex(/^[a-f0-9]{64}$/), stamp = z.string().datetime();
const inputDomains = z.array(AllowedDomainSchema).max(50).transform(values => [...new Set(values)].sort());
const domains = z.array(AllowedDomainSchema).max(50).refine(values => new Set(values).size === values.length && values.every((value, i) => i === 0 || values[i - 1]! < value), "Expected a unique canonical website list.");
export const ProjectAllowedWebsitesMutationBodySchema = z.object({ expectedOrgId: OrgIdSchema, requestId: uuid, expectedRevision: revision.max(Number.MAX_SAFE_INTEGER - 1), expectedContextDigest: fingerprint, allowedDomains: inputDomains }).strict();
export const ProjectAllowedWebsitesApprovalBodySchema = z.object({ expectedOrgId: OrgIdSchema, requestId: uuid, soleOwnerAcknowledged: z.boolean().default(false) }).strict();
export const ProjectAllowedWebsitesDecisionBodySchema = z.object({ expectedOrgId: OrgIdSchema, requestId: uuid, reason: z.string().trim().max(280).optional() }).strict();
export const ProjectAllowedWebsitesProposalSchema = z.object({ kind: z.literal("proposal"), proposalId: uuid, proposedBy: z.string().regex(/^[a-f0-9]{64}$/),
 status: z.enum(["pending", "applied", "rejected", "cancelled", "expired", "stale"]), baseRevision: revision, beforeDomains: domains, afterDomains: domains, createdAt: stamp, expiresAt: stamp }).strict();
export const ProjectAllowedWebsitesProposalReaderSchema = ProjectAllowedWebsitesProposalSchema.strip();
export const ProjectAllowedWebsitesReviewSchema = z.object({ kind: z.literal("review"), status: z.literal("review"), orgId: OrgIdSchema, project: AgentXNameSchema, baseRevision: revision,
 contextDigest: fingerprint, allowedDomains: domains, defaultDomains: z.array(z.string().min(1).max(255).regex(/^(?:\*\.)?[a-z0-9][a-z0-9.-]*$/)).max(512),
 staffDomains: z.array(z.object({ domain: AllowedDomainSchema, status: z.enum(["pending", "approved", "rejected", "unknown"]) }).strict()).max(50), liveProposal: ProjectAllowedWebsitesProposalSchema.nullable(),
}).strict().superRefine((value, context) => {
 if (new Set(value.staffDomains.map(entry => entry.domain)).size !== value.staffDomains.length || value.staffDomains.some(entry => !value.allowedDomains.includes(entry.domain))) context.addIssue({ code: "custom", message: "Website staff decisions do not match the canonical list." });
});
export const ProjectAllowedWebsitesReviewReaderSchema = ProjectAllowedWebsitesReviewSchema.strip();
const directReceipt = z.object({ requestId: uuid, state: z.literal("applied"), mode: z.literal("direct_narrowing"), resultRevision: revision, createdAt: stamp }).strict();
const approvalReceipt = z.object({ requestId: uuid, proposalId: uuid, state: z.literal("applied"), mode: z.enum(["second_person", "sole_owner_exception"]), resultRevision: revision, createdAt: stamp }).strict();
const decisionReceipt = z.object({ requestId: uuid, proposalId: uuid, state: z.enum(["rejected", "cancelled"]), createdAt: stamp }).strict();
export const ProjectAllowedWebsitesReceiptSchema = z.union([directReceipt, approvalReceipt, decisionReceipt]);
export const ProjectAllowedWebsitesReceiptResultSchema = z.object({ kind: z.literal("receipt"), proposalId: uuid.optional(), status: z.enum(["applied", "rejected", "cancelled"]), receipt: ProjectAllowedWebsitesReceiptSchema }).strict().superRefine((value, context) => {
 const proposalId = "proposalId" in value.receipt ? value.receipt.proposalId : undefined;
 if (value.status !== value.receipt.state || value.proposalId !== proposalId) context.addIssue({ code: "custom", message: "Receipt identity or outcome mismatch." });
});
export const ProjectAllowedWebsitesUnchangedSchema = z.object({ kind: z.literal("unchanged"), status: z.literal("unchanged"), resultRevision: revision }).strict();
export const ProjectAllowedWebsitesResultReaderSchema = z.union([ProjectAllowedWebsitesProposalReaderSchema, ProjectAllowedWebsitesReceiptResultSchema.strip(), ProjectAllowedWebsitesUnchangedSchema.strip()]);
export type ProjectAllowedWebsitesMutationBody = z.input<typeof ProjectAllowedWebsitesMutationBodySchema>;
export type ProjectAllowedWebsitesApprovalBody = z.input<typeof ProjectAllowedWebsitesApprovalBodySchema>;
export type ProjectAllowedWebsitesDecisionBody = z.input<typeof ProjectAllowedWebsitesDecisionBodySchema>;
export type ProjectAllowedWebsitesReview = z.infer<typeof ProjectAllowedWebsitesReviewSchema>;
export type ProjectAllowedWebsitesProposal = z.infer<typeof ProjectAllowedWebsitesProposalSchema>;
export type ProjectAllowedWebsitesReceipt = z.infer<typeof ProjectAllowedWebsitesReceiptSchema>;
export type ProjectAllowedWebsitesResult = z.infer<typeof ProjectAllowedWebsitesResultReaderSchema>;
