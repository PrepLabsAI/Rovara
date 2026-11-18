// EVAL-WIRE-SOURCES (DEC 253c): the worker's side of the `eval-plan` callback. One ask, with this operation's own capability, for the trusted plan, the spend approval and the base-score
// cache entry the broker holds for this run's company and project; the answer becomes three read-only capabilities of `EvalHostSources` (plan, approval, cache).
//
// Fail closed: a refused or failed ask, an answer over `EVAL_PLAN_DELIVERY_MAX_BYTES` (counted while reading, never read whole first), unreadable JSON or a shape that is not exactly the
// contract's is "not_available", and `evalSourcesFromDelivery` then gives nothing (the eval reads "not connected", zero calls). The cache answers only for the exact key the broker read
// (another key is a miss) and never writes: base rounds are not saved from a worker through this route. Nothing here logs, stores or echoes the answer.
import {
  EVAL_PLAN_DELIVERY_ACTION, EVAL_PLAN_DELIVERY_MAX_BYTES, EvalPlanDeliverySchema, evalBaseCacheKey,
  type BaseScoreCache, type EvalEnvironment, type EvalPlanDelivery, type EvalSpendApproval, type EvalStandInDescriptor,
} from "@agentx/contracts";

const NOT_AVAILABLE: EvalPlanDelivery = Object.freeze({ status: "not_available" });

export interface EvalPlanDeliveryRequest {
  readonly controlPlaneUrl: string;
  readonly workspaceId: string;
  readonly operationId: string;
  /** This operation's own callback capability (it must name `eval-plan`). */
  readonly capability: string;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
}

async function boundedText(response: Response, maxBytes: number): Promise<string | undefined> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declared) || declared > maxBytes || response.body === null) return undefined;
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read() as { done: boolean; value?: Uint8Array };
    if (next.done || next.value === undefined) break;
    const value = next.value;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel().catch(() => undefined); return undefined; }
    chunks.push(value);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

/** Asks the broker once. Never throws: any fault is "not_available". */
export async function fetchEvalPlanDelivery(input: EvalPlanDeliveryRequest): Promise<EvalPlanDelivery> {
  try {
    const base = input.controlPlaneUrl.replace(/\/$/u, "");
    const response = await (input.fetch ?? fetch)(`${base}/v1/internal/workspaces/${encodeURIComponent(input.workspaceId)}/operations/${encodeURIComponent(input.operationId)}/${EVAL_PLAN_DELIVERY_ACTION}`, {
      method: "POST", headers: { "content-type": "application/json", "x-agentx-callback-capability": input.capability }, body: "{}",
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (!response.ok) return NOT_AVAILABLE;
    // The broker's reply carries its request id beside the answer, as every callback reply does; that one word is allowed on top of the bound answer.
    const text = await boundedText(response, EVAL_PLAN_DELIVERY_MAX_BYTES + 256);
    if (text === undefined) return NOT_AVAILABLE;
    const reply: unknown = JSON.parse(text);
    if (typeof reply !== "object" || reply === null || Array.isArray(reply)) return NOT_AVAILABLE;
    const answer = EvalPlanDeliverySchema.safeParse(Object.fromEntries(Object.entries(reply).filter(([key]) => key !== "requestId")));
    if (!answer.success || Buffer.byteLength(JSON.stringify(answer.data), "utf8") > EVAL_PLAN_DELIVERY_MAX_BYTES) return NOT_AVAILABLE;
    return answer.data;
  } catch {
    return NOT_AVAILABLE;
  }
}

export interface DeliveredEvalSources {
  plan(): Promise<unknown>;
  /** L4-EVS: the environment the sealed eval runs in (saved image or install steps), when the broker delivered one. A fresh copy per read; the login in it is for one pull and is never stored or logged. */
  environment(): Promise<EvalEnvironment | undefined>;
  /** L4-EINT: what the project's evals reach (the dry run's outside hosts, the writer's set), when the broker delivered it (the operator's switch is on). A fresh copy per read. */
  standIns(): Promise<EvalStandInDescriptor | undefined>;
  readonly approval: EvalSpendApproval;
  readonly cache: BaseScoreCache;
}

/** The plan, approval and cache of a delivered answer, or undefined for "not_available". Each read returns a fresh copy; the cache answers only the key the broker read and never writes. */
export function evalSourcesFromDelivery(answer: EvalPlanDelivery): DeliveredEvalSources | undefined {
  if (answer.status !== "ready") return undefined;
  const { plan, approval, baseline, environment, standIns } = structuredClone(answer);
  const sameKey = (parts: Parameters<BaseScoreCache["read"]>[0]): boolean => {
    if (baseline === null) return false;
    try { return evalBaseCacheKey(parts) === baseline.key; } catch { return false; }
  };
  return {
    plan: async () => structuredClone(plan),
    environment: async () => (environment === undefined ? undefined : structuredClone(environment)),
    standIns: async () => (standIns === undefined ? undefined : structuredClone(standIns)),
    approval: { read: async () => approval === null ? undefined : Object.freeze({ ...approval }) },
    cache: {
      read: async (parts) => sameKey(parts) && baseline?.record != null ? structuredClone(baseline.record) : undefined,
      readMeasurement: async (parts) => sameKey(parts) ? baseline!.measurement : "unavailable",
      write: async () => "refused",
    },
  };
}
