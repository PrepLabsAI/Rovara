// Lightweight vocabulary shared by stage policy, task views and audit; no session-view dependency.
import {z} from "zod";
export const STAGE_IDS = ["understand", "plan", "plan_check", "build", "code_review", "security_review", "pull_request"] as const;
export const StageIdSchema = z.enum(STAGE_IDS);
export type StageId = z.infer<typeof StageIdSchema>;
export const STAGE_MODEL_REFUSAL_CODES = ["MODEL_NOT_VERIFIED", "MODEL_STALE", "MODEL_FORBIDDEN", "MODEL_NOT_ALLOWED_IN_PROJECT", "STAGE_LOCKED", "DIFFERENT_FROM_UNSATISFIABLE", "LOCK_UNSATISFIABLE", "NO_VERIFIED_CANDIDATE", "POLICY_STALE", "DRAFT_STALE", "NEEDS_CONFIRMATION"] as const;
export const StageModelRefusalCodeSchema = z.enum(STAGE_MODEL_REFUSAL_CODES);
export type StageModelRefusalCode = z.infer<typeof StageModelRefusalCodeSchema>;
export const ModelFallbackReasonCodeSchema = z.enum([...STAGE_MODEL_REFUSAL_CODES, "DEFAULT_MODEL_UNAVAILABLE", "CHATGPT_PLAN_UNAVAILABLE", "MODEL_CALL_REFUSED", "CONFIGURED_FALLBACK"]);
const Line = z.string().min(1).max(400).refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), "must be plain text");
export const ModelFallbackSchema = z.object({ stage: StageIdSchema, used: Line, wanted: Line.nullable(), reasonCode: ModelFallbackReasonCodeSchema }).strict();
export type ModelFallback = z.infer<typeof ModelFallbackSchema>;
export const ModelFallbacksSchema = z.array(ModelFallbackSchema).max(64);

