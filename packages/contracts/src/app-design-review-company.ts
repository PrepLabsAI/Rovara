// Design review (DR-FU4): the shapes of `/v1/app/org/design-review`, the company's How we work card for design review. A company admin reads and changes: whether design review is ALLOWED for the company and the stricter-only LOCK fields.
// There is no company default mode and no mode floor: once design review is allowed, each project's maintainers turn it on (Auto or Always) or off for their own project. The readers keep fields a newer server adds. Words, numbers and ids only; nobody's name or text is in an answer.
import { z } from "zod";
import { forwardReader } from "./forward-reader.js";
import { DESIGN_REVIEW_CAP_MAX_USD, DESIGN_REVIEW_CAP_MIN_USD, DesignReviewTierSchema } from "./design-review.js";

export const DESIGN_REVIEW_COMPANY_PATH = "/v1/app/org/design-review";

/** The stricter-only lock a company holds on every project's design review. Every field is optional: an absent field locks nothing. */
export const DesignReviewCompanyLockSchema = z.object({
  tierAtLeast: DesignReviewTierSchema.optional(),
  allowSkip: z.literal(false).optional(),
  capCeilingUsd: z.number().min(DESIGN_REVIEW_CAP_MIN_USD).max(DESIGN_REVIEW_CAP_MAX_USD).optional(),
  approverGroupId: z.string().min(1).max(100).optional(),
}).strict();
export type DesignReviewCompanyLock = z.infer<typeof DesignReviewCompanyLockSchema>;

export const DesignReviewCompanyStateSchema = z.object({
  /** The revision a change is made against (`POLICY_STALE` when it moved). */
  revision: z.number().int().min(0),
  allowed: z.boolean(),
  lock: DesignReviewCompanyLockSchema,
  /** The stored policy or lock does not read: the card says so and offers nothing to change. */
  unreadable: z.boolean(),
  /** True only in an edition that has groups: the lock may then name an approver group. */
  groups: z.boolean().optional(),
  /** A request waits for a different admin: to allow design review (`allowed`) or to loosen the rules (`lock`). At most one waits at a time. Only its id, kind and whether it is yours are shown. */
  pending: z.object({ changeId: z.string().min(1).max(100), kind: z.enum(["allowed", "lock"]), proposedByYou: z.boolean(), expiresAt: z.string().datetime() }).strict().optional(),
}).strict();
export type DesignReviewCompanyState = z.infer<typeof DesignReviewCompanyStateSchema>;
export const DesignReviewCompanyStateReaderSchema = forwardReader(DesignReviewCompanyStateSchema);

export const DesignReviewCompanyBodySchema = z.discriminatedUnion("action", [
  /** Replaces the lock. A lock that only tightens applies at once; a lock that loosens anything waits for a different admin (202 needs_approval). */
  z.object({ action: z.literal("save"), expectedRevision: z.number().int().min(0), lock: DesignReviewCompanyLockSchema }).strict(),
  /** Allow (waits for a different admin; only the sole owner alone) or do not allow (applies at once). */
  z.object({ action: z.literal("allow"), expectedRevision: z.number().int().min(0), allowed: z.boolean() }).strict(),
  /** A different admin approves the waiting request (a sign-in within the last 10 minutes). */
  z.object({ action: z.literal("approve"), changeId: z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/u) }).strict(),
  /** Withdraws the waiting request (its proposer, or any admin). */
  z.object({ action: z.literal("cancel"), changeId: z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/u) }).strict(),
]);
export type DesignReviewCompanyBody = z.infer<typeof DesignReviewCompanyBodySchema>;

/** 200 `applied`, or 202 `needs_approval` (allowing design review, or loosening the rules, waits for a different admin). */
export const DesignReviewCompanyAnswerSchema = z.discriminatedUnion("status", [
  DesignReviewCompanyStateSchema.extend({ status: z.literal("applied") }).strict(),
  DesignReviewCompanyStateSchema.extend({ status: z.literal("needs_approval"), changeId: z.string().min(1).max(100) }).strict(),
]);
export const DesignReviewCompanyAnswerReaderSchema = forwardReader(DesignReviewCompanyAnswerSchema);
