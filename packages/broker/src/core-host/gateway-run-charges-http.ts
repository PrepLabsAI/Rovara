// LOST-RUN-ACTUAL-SPEND: the model gateway's own record of one run's calls, read for the ACTUAL figure of a run whose usage never reached the broker (a lost run, a Stop the worker did not answer, a
// run that sent no report). Rovara counts only what was actually spent, and the gateway is where every call is settled.
//
//   GET <gateway origin>/v1/service/companies/<company>/runs/<operationId>/charges?task=<taskId>
//     ->  200 { version: 1, operationId, seen: boolean, complete: boolean, indexedSince: ISO time, receipts: [ChargeReceiptV1, ...] }      (GATEWAY-RUN-CHARGES-ROUTE; Cloud serves it)
//     ->  404 for a run the route does not know / 501 when the route is not served at all
//
// The contract the route must keep (the Code reader trusts it, so a $0 here is a final $0):
//   `seen`      true ONLY when the gateway has recorded at least one call for the run, or has positively recorded that the run made none. A run the gateway never saw (a call still in flight upstream, a run that did not
//               use the gateway) is 404 or `seen: false`; the reader treats `seen: false` as UNKNOWN, never as nothing spent.
//   `complete`  the gateway's own word that it holds no call of the run still open (every call it served is settled, or is its own estimate).
//   `indexedSince` when the gateway began indexing calls by run. A run that STARTED before it can read as complete with a smaller sum than it spent (its early calls were never indexed), so such a run is UNKNOWN to
//               the settler, never a final sum (`lost-run-actual.ts`). REQUIRED: a 200 with no `indexedSince`, or one that is not a time, does not read (unknown: the run could have spent before the index began).
//   `receipts`  one ChargeReceiptV1 per call.
// The read is signed with the install's task key like the gateway's other service reads (audience `rovara-model-gateway-run-charges`).
// Answers: a figure (`RunCharges`); `"not_served"` for 404/501 (the route does not exist or does not know the run: there is no actual to be had, so the settler counts as it did before this lane, at the grace); undefined for anything
// else (a failed, refused, slow or unreadable read): "no actual figure yet", the spend stays unreadable (fail closed) and, after the wait, is counted as the hold's room, marked an estimate.
//
// What comes back is reduced to ONE figure: the sum of the receipts' own amounts. A receipt that does not parse, that names another company, task or run, a currency other than USD, or an amount that is not
// available makes the whole read undefined: a figure is never taken from part of a record (rule 8: unknown top-level fields are ignored; each receipt is read by the shared strict reader).
import { OrgIdSchema, chargeValue, parseChargeReceiptV1 } from "@agentx/contracts";
import { readGatewayUrl } from "./gateway-model-access.js";
import { boundedText, signServiceToken, type OfferedModelsHttpInputs } from "./offered-models-http.js";

export const RUN_CHARGES_AUDIENCE = "rovara-model-gateway-run-charges";
const BODY_MAX_BYTES = 1_048_576;
const RECEIPTS_MAX = 500;
const ID = /^[A-Za-z0-9_.:-]{1,200}$/u;

/** What the gateway's record of one run comes to. */
export interface RunCharges {
  /** The gateway holds no call of the run still open: nothing more will be added. */
  complete: boolean;
  /** The sum of the receipts' amounts, in USD micros. */
  actualMicros: number;
  /** Every receipt is final (none is the gateway's own estimate or awaits its usage). */
  final: boolean;
  calls: number;
  /** When the gateway began indexing calls by run (ms since the epoch); a run created before it is unknown. */
  indexedSinceMs: number;
}
export type GatewayRunChargesReader = (companyId: string, taskId: string, operationId: string) => Promise<RunCharges | "not_served" | undefined>;

/** The sum of the receipts' amounts and whether every one is final; undefined when any receipt does not read, names another company, task or run, is not USD or has no amount. */
function sumReceipts(receipts: readonly unknown[], expected: { companyId: string; taskId: string; operationId: string }): { actualMicros: number; final: boolean } | undefined {
  let actualMicros = 0;
  let final = true;
  for (const raw of receipts) {
    const receipt = parseChargeReceiptV1(raw);
    if (receipt === undefined || receipt.companyId !== expected.companyId || receipt.taskId !== expected.taskId || receipt.operationId !== expected.operationId || receipt.currency !== "USD") return undefined;
    const amount = chargeValue(receipt.amountMicros);
    if (amount === undefined) return undefined;
    actualMicros += amount;
    if (!Number.isSafeInteger(actualMicros)) return undefined;
    if (receipt.status !== "final") final = false;
  }
  return { actualMicros, final };
}

/** The figure of a body, or undefined when any part of it does not read (see the file comment). Pure. */
export function readRunCharges(body: unknown, expected: { companyId: string; taskId: string; operationId: string }): RunCharges | undefined {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  const receipts = record["receipts"];
  if (record["version"] !== 1 || record["operationId"] !== expected.operationId || typeof record["complete"] !== "boolean" || typeof record["seen"] !== "boolean" || !Array.isArray(receipts) || receipts.length > RECEIPTS_MAX) return undefined;
  // A run the gateway never saw is unknown: neither a final $0 (an empty record) nor a figure.
  if (record["seen"] !== true) return undefined;
  const sum = sumReceipts(receipts as unknown[], expected);
  const since = record["indexedSince"];
  if (sum === undefined || typeof since !== "string" || !Number.isFinite(Date.parse(since))) return undefined;
  return { complete: record["complete"], ...sum, calls: receipts.length, indexedSinceMs: Date.parse(since) };
}

/** The reader over the gateway's route. A 404 or 501 is "not_served"; a read that fails, is refused, is slow or does not read answers undefined. Never cached: a figure is read when it is needed. */
export function gatewayRunChargesReader(input: Omit<OfferedModelsHttpInputs, "signer" | "issuer"> & { signing: () => { signer: OfferedModelsHttpInputs["signer"]; issuer: string } | undefined }): GatewayRunChargesReader {
  return async (companyId, taskId, operationId) => {
    if (!OrgIdSchema.safeParse(companyId).success || !ID.test(taskId) || !ID.test(operationId)) return undefined;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => { timer = setTimeout(() => { abort.abort(); resolve(undefined); }, input.timeoutMs ?? 4_000); });
    const read = async (): Promise<RunCharges | "not_served" | undefined> => {
      const signing = input.signing();
      if (signing === undefined) return undefined;
      const token = await signServiceToken({ ...signing, ...(input.now === undefined ? {} : { now: input.now }) }, companyId, RUN_CHARGES_AUDIENCE);
      const response = await (input.fetch ?? fetch)(`${input.gatewayUrl.replace(/\/+$/u, "")}/v1/service/companies/${companyId}/runs/${encodeURIComponent(operationId)}/charges?${new URLSearchParams({ task: taskId }).toString()}`, {
        method: "GET", redirect: "error", signal: abort.signal, headers: { accept: "application/json", authorization: `Bearer ${token}` },
      });
      if (response.status !== 200) { await response.body?.cancel().catch(() => undefined); return response.status === 404 || response.status === 501 ? "not_served" : undefined; }
      return readRunCharges(JSON.parse(await boundedText(response, BODY_MAX_BYTES)), { companyId, taskId, operationId });
    };
    try { return await Promise.race([read(), timeout]); } catch { return undefined; } finally { clearTimeout(timer); }
  };
}

/** The reader for a root: the gateway's origin from the environment and the task-key signer it already holds; undefined where either is missing (no reader: the settler counts what it can without the gateway). */
export function gatewayRunChargesReaderFromEnvironment(env: NodeJS.ProcessEnv, tokens: (() => { signer: OfferedModelsHttpInputs["signer"]; issuer: string } | undefined) | undefined, fetchImpl?: typeof fetch): GatewayRunChargesReader | undefined {
  const url = readGatewayUrl(env);
  if (typeof url !== "string" || tokens === undefined) return undefined;
  return gatewayRunChargesReader({ gatewayUrl: url, signing: tokens, ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }) });
}
