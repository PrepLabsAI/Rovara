// Trusted setup capabilities. No production adapter is wired in Code yet.
import type { ModelEgressClass } from "../model-egress/classify.js";
import type { ModelEgressFrame } from "../model-egress/frame.js";
import type { ModelEgressEvent } from "./model-egress.js";

/** Read from persisted setup approval, never from the repository, invocation or model output. */
export interface EvalSpendGrant {
  readonly company: string;
  readonly project: string;
  readonly selection: string;
  readonly role: "maintainer" | "admin";
  readonly provider: "customer";
  readonly connected: boolean;
  /** Confirmed per-run ceiling shown with the initial estimate, not the initial observed call count. */
  readonly maxCalls: number;
  /** Confirmed per-run cost ceiling; refreshes within it still reserve against the monthly cap. */
  readonly maxCostMicros: number;
}
export interface EvalSpendApproval {
  /** Resolve current membership and connection; return undefined when absent/revoked/unreadable.
   * One confirmed estimate permits refreshes within this envelope and the monthly cap. */
  read(): Promise<EvalSpendGrant | undefined>;
}
export interface EvalMeterCall {
  /** The metered ModelEgress outcome. Only a completed ok call can supply question evidence. */
  readonly class: ModelEgressClass;
  /** Already scrubbed ModelEgress response events, for the trusted eval adapter to grade. */
  readonly events?: readonly ModelEgressEvent[];
  readonly calls: number;
  readonly costMicros: number;
}
export interface EvalMeterReservation {
  /** Uses the adapter-issued ModelEgress scope bound to the grant. Each call, including failures,
   * MUST be metered against its company/project/customer provider before this promise settles.
   * Enforce the reservation at dispatch and bounded provider deadlines, join all calls,
   * and never retry a failed call implicitly. */
  call(frame: ModelEgressFrame): Promise<EvalMeterCall>;
  /** Join calls before returning; release only unspent reservation. On uncertain usage retain it. */
  close(): Promise<void>;
}
export interface MonthlyMeter {
  /** Atomically reserve the WHOLE estimate against company/project monthly remaining spend.
   * Revalidate the trusted grant and resolve its own opaque provider scope; never synthesize one
   * or accept a repository-supplied payer. Undefined means refusal with no calls dispatched. */
  reserve(input: { readonly approval: EvalSpendGrant; readonly calls: number; readonly costMicros: number }): Promise<EvalMeterReservation | undefined>;
}
