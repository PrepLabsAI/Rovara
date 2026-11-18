// The independently approved setup eval envelope. Never read this policy from a repository.
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import { sha256HexOf } from "./service-catalog-verify.js";

export const EVAL_DEFAULT_CALL_BUDGET = 400;
export const EVAL_DEFAULT_COST_BUDGET_MICROS = 4_000_000;
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:/@+-]+$/u);
const amount = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const EstimateSchema = z.object({ calls: amount, costMicros: amount }).strict();
/**
 * L4-EVC (DEC 254zzz20 D8): the dollars the person approved, in the words of the setup card: "about $low-$high per PR, at most $monthlyCap a month". Set by the broker at confirm from its own numbers
 * (never a request's): `perCheckLowMicros` is one run of every case, `perCheckHighMicros` the most a check can cost (the whole approved per-check limit), `monthlyCapMicros` the company's monthly cap
 * at approval. Covered by the item's digest, so what a person approves is exactly what the card showed. Absent (an item approved before): no dollar card, and an edit to the eval always asks again.
 */
export const EvalSpendDollarsSchema = z.object({ perCheckLowMicros: amount, perCheckHighMicros: amount, monthlyCapMicros: amount }).strict()
  .refine(d => d.perCheckLowMicros <= d.perCheckHighMicros, "the low figure is at most the high figure");
export type EvalSpendDollars = z.infer<typeof EvalSpendDollarsSchema>;
export const EvalSpendInputsSchema = z.object({ evalSetHash: hash, judgePin: hash, modelVersion: id, model: id, catalogRowId: id, commandFingerprint: hash, settingsFingerprint: hash }).strict();
export type EvalSpendInputs = z.infer<typeof EvalSpendInputsSchema>;
export const EvalSpendPlanSchema = z.object({
  selection: z.string().min(1).max(512).regex(/^[^\p{Cc}\p{Cf}]+$/u),
  inputs: EvalSpendInputsSchema,
  estimate: EstimateSchema,
  budget: z.object({ usual: EstimateSchema, maximum: EstimateSchema }).strict(),
  /** DEC 253j(1): the digest of the EVAL_PLAN proposed with this item (`evalPlanDigest`). Set only by the broker's proposal, so this item's digest, the one approved, covers the plan. Absent: no plan. */
  evalPlanDigest: hash.optional(),
  /** L4-EVC: the dollars the person approved (see `EvalSpendDollarsSchema`). */
  dollars: EvalSpendDollarsSchema.optional(),
}).strict().refine(p => p.estimate.calls <= p.budget.maximum.calls && p.estimate.costMicros <= p.budget.maximum.costMicros && p.budget.usual.calls <= p.budget.maximum.calls && p.budget.usual.costMicros <= p.budget.maximum.costMicros, "estimate and usual spend must fit the maximum");
export type EvalSpendPlan = z.infer<typeof EvalSpendPlanSchema>;
export const EvalSpendRoleSchema = z.enum(["owner", "admin", "maintainer"]);
export const EvalSpendApprovalRecordSchema = z.object({
  entityType: z.literal("EVAL_SPEND_APPROVAL"), schemaVersion: z.literal(1),
  company: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/u), project: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u),
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  digest: hash, inputsDigest: hash, plan: EvalSpendPlanSchema,
  state: z.enum(["waiting", "approved", "rejected"]),
  /** L4-EVC (DEC 254zzz20 D6): set when a changed eval set was carried onto the earlier approval because it stayed inside the approved limit: the revision it was carried from. Audit and display only; the approver is still `approvedBy`, read live. */
  carriedFrom: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  /** L4-EVC: set on a waiting item that replaced an approved one: why it asks again (`grew`: past the approved limit; `changed`: the model, judge or command changed) and the approved per-check ceiling it grew past. Display only. */
  asksAgain: z.object({ reason: z.enum(["grew", "changed"]), approvedHighMicros: amount.optional() }).strict().optional(),
  /** L4-EVC: the project's setup revision this item was proposed against (stored with the setup revision). Display only. */
  setupRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  approvedBy: z.object({ personId: z.string().min(1).max(256), provider: z.string().min(1).max(200), role: EvalSpendRoleSchema, at: z.iso.datetime() }).strict().optional(),
}).strict().refine(row => row.state === "approved" ? row.approvedBy !== undefined : row.approvedBy === undefined, "only an approved record carries its approver");
export type EvalSpendApprovalRecord = z.infer<typeof EvalSpendApprovalRecordSchema>;

/** Code commits may change during refresh. Eval data, scoring, model and measurement settings may not. */
export const evalSpendInputsDigest = (inputs: EvalSpendInputs): string => sha256HexOf(new TextEncoder().encode(`rovara-eval-inputs/v1\n${canonicalJson(EvalSpendInputsSchema.parse(inputs))}`));
/** A separate digest entry; the existing setup-command digest is deliberately unchanged. */
export const evalSpendDigest = (company: string, project: string, plan: EvalSpendPlan): string => sha256HexOf(new TextEncoder().encode(`rovara-eval-spend/v1\n${canonicalJson({ company, project, plan: EvalSpendPlanSchema.parse(plan) })}`));
