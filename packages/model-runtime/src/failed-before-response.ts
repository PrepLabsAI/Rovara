// SPEND-UNREPORTED-RUN (item 2, root cause R2: behaviour decided by raw text). A model call that failed BEFORE any response (the request never got an answer worth reading: a network, DNS,
// TLS or reset failure with no HTTP status, or an HTTP error answer) spent nothing the provider returned. This runtime says so with ONE stable code on the failed assistant message, with the
// HTTP status when there was one, so the worker decides "refused, nothing used" BY CODE and never by matching the sentence the runtime happens to word for a person.
//
// Skew: a message from a runtime that does not set the code (an older worker image, or a session transcript written by one) carries no field. The worker reads such a message by the old fixed
// sentences only (`legacy reader`, worker/src/usage.ts), and only because it has no code to read.
import type { AssistantMessage } from "@earendil-works/pi-ai";

/** The stable code of a call that failed before any response. Never worded for a person: the words are `safeError`'s. */
export const MODEL_CALL_FAILED_BEFORE_RESPONSE = "model_call_failed_before_response";

/** The code and the status (when an HTTP answer came) a failed message carries. */
export interface FailedBeforeResponse { code: typeof MODEL_CALL_FAILED_BEFORE_RESPONSE; status?: number }

/** Marks a failed assistant message as one that failed before any response. `status` is the HTTP status of the provider's answer, when it gave one. */
export function markFailedBeforeResponse(message: AssistantMessage, status: number | undefined): void {
  const mark: FailedBeforeResponse = { code: MODEL_CALL_FAILED_BEFORE_RESPONSE, ...(status === undefined ? {} : { status }) };
  (message as AssistantMessage & { failedBeforeResponse?: FailedBeforeResponse }).failedBeforeResponse = mark;
}

/**
 * What a message says about failing before any response, read tolerantly (a stored message may carry anything): the code, and the status only when it is a whole HTTP status. Undefined for a
 * message with no such mark (any message that did not fail that way, and any message an older runtime wrote).
 */
export function failedBeforeResponse(message: unknown): FailedBeforeResponse | undefined {
  if (message === null || typeof message !== "object") return undefined;
  const mark = (message as { failedBeforeResponse?: unknown }).failedBeforeResponse;
  if (mark === null || typeof mark !== "object" || (mark as { code?: unknown }).code !== MODEL_CALL_FAILED_BEFORE_RESPONSE) return undefined;
  const status = (mark as { status?: unknown }).status;
  return { code: MODEL_CALL_FAILED_BEFORE_RESPONSE, ...(typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}) };
}
