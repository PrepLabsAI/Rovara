// EVAL-WIRE-SOURCES (DEC 253c): the `eval-plan` callback. A CHECKS run whose own invocation carries an `evalRequest` asks the broker here, once, for the three trusted sources its final-check eval
// needs and that only the broker holds: the project's confirmed eval plan, the persisted spend approval (re-read for current authority) and the company's base-score cache entry for that plan.
//
// The answer is read by the broker from the company that runs the operation and the project of the operation's own task, never from the request (the body is empty and is not read). It holds
// nothing of another company or project: a source answer that names another company or project is dropped (the plan) or nulled (the approval), and the cache read is keyed by the run's company.
// The whole answer is bounded (`EVAL_PLAN_DELIVERY_MAX_BYTES`); a larger one is not sent ("not_available"). The worker re-validates the plan (eval-final-check `validPlan`) and the grant, so this
// wire schema is the transport bound, not the plan's meaning.
import { z } from "zod";
import { EvalBaseRecordSchema } from "./eval-base-cache.js";

/** The callback action, its own purpose: a capability for any other action (or `model-access` alone) is refused. */
export const EVAL_PLAN_DELIVERY_ACTION = "eval-plan" as const;
/** The largest answer the broker sends and the worker reads (UTF-8 bytes of the JSON body). */
export const EVAL_PLAN_DELIVERY_MAX_BYTES = 1_048_576;
/** The largest request body the route accepts. It reads no field: an empty object is all a worker sends. */
export const EVAL_PLAN_DELIVERY_REQUEST_MAX_BYTES = 64;

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const whole = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/** The spend grant as delivered: the same fields as `EvalSpendGrant`, each checked. */
export const EvalPlanDeliveryGrantSchema = z.object({
  company: z.string().min(1).max(100), project: z.string().min(1).max(200), selection: z.string().min(1).max(512),
  role: z.enum(["owner", "maintainer", "admin"]), inputsDigest: hash, provider: z.literal("customer"), connected: z.literal(true),
  maxCalls: whole, maxCostMicros: whole,
}).strict();

/** The cache entry for the plan's own key: the key (so the worker answers only for exactly these parts), the record if one is kept, and the measuring mark's state. */
export const EvalPlanDeliveryBaselineSchema = z.object({
  key: hash,
  record: EvalBaseRecordSchema.nullable(),
  measurement: z.enum(["idle", "measuring", "unavailable"]),
}).strict();

export const EvalPlanDeliverySchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    /** The trusted plan as the broker's source gave it, for this company and project only. The worker validates its shape (`validPlan`) before any use. */
    plan: z.record(z.string(), z.unknown()),
    approval: EvalPlanDeliveryGrantSchema.nullable(),
    baseline: EvalPlanDeliveryBaselineSchema.nullable(),
  }).strict(),
  /** No plan for this project, a source that is not wired, a fault, or an answer over the bound: the eval reads "not connected", with zero calls. */
  z.object({ status: z.literal("not_available") }).strict(),
]);
export type EvalPlanDelivery = z.infer<typeof EvalPlanDeliverySchema>;
export type EvalPlanDeliveryGrant = z.infer<typeof EvalPlanDeliveryGrantSchema>;
