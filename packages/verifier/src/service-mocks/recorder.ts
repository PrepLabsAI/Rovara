// Service mocks (E8): the recorder. It sends the project's SYNTHETIC inputs to a pre-prod service once (at Prove, then on demand), stores each `{request hash -> response}` as a fixture set, infers a schema of the
// requests and of the responses, and hands the set to a maintainer to review. Rules, in the order they apply:
//   1. the inputs are scanned by the data guard BEFORE anything is sent: nothing that holds personal data or names production ever reaches pre-prod from here;
//   2. a response that is a server error (5xx) or too large is not recorded (a transient fault must not become the service's answer): the recording fails with a fixed reason;
//   3. the recorded responses are scanned again: a hit blocks the whole set and the report names kind, source and entry, never the text;
//   4. the set is validated against the contract (bounds) and its digest is the pin the environment holds.
// Sending is bounded: at most 500 inputs (the set's own limit), one at a time, each with a deadline. `send` is the caller's own (an AWS SDK call with the short-lived role, an HTTP call); the recorder holds no credential.
import {
  SERVICE_MOCK_BODY_MAX_BYTES,
  SERVICE_MOCK_ENTRIES_MAX,
  SERVICE_MOCK_LATENCY_MAX_MS,
  ServiceMockFixtureSetSchema,
  serviceMockFixtureSetDigest,
  type DataGuardReport,
  type ServiceMockFixtureSet,
  type TestEnvProdDeny,
} from "@agentx/contracts";
import { guardFixtureSet, guardInputs } from "../data-guard.js";
import { hashOfRequest } from "./fixture-set.js";
import { inferJsonSchema } from "./schema.js";

export interface RecordInput { method: string; pathAndQuery: string; contentType: string; body: string }
export interface RecordedResponse { status: number; contentType: string; body: string; latencyMs: number }

export type RecordFailure = "no_inputs" | "too_many_inputs" | "input_too_large" | "send_failed" | "preprod_error" | "response_too_large" | "set_invalid";
export type RecordOutcome =
  | { ok: true; set: ServiceMockFixtureSet; digest: string; duplicates: number }
  | { ok: false; reason: "data_guard"; report: DataGuardReport; phase: "inputs" | "responses" }
  | { ok: false; reason: RecordFailure };

const bytes = (value: string): number => new TextEncoder().encode(value).length;

function jsonOf(body: string, contentType: string): unknown {
  if (!/json/iu.test(contentType)) return undefined;
  try { return JSON.parse(body) as unknown; } catch { return undefined; }
}

export async function recordFixtureSet(input: {
  service: ServiceMockFixtureSet["service"];
  revision: number;
  inputs: readonly RecordInput[];
  deny: TestEnvProdDeny;
  now(): Date;
  send(request: RecordInput, signal: AbortSignal): Promise<RecordedResponse>;
  perCallTimeoutMs?: number;
}): Promise<RecordOutcome> {
  if (input.inputs.length === 0) return { ok: false, reason: "no_inputs" };
  if (input.inputs.length > SERVICE_MOCK_ENTRIES_MAX) return { ok: false, reason: "too_many_inputs" };
  if (input.inputs.some((item) => bytes(item.body) > SERVICE_MOCK_BODY_MAX_BYTES)) return { ok: false, reason: "input_too_large" };
  const before = guardInputs(input.inputs.map((item, index) => ({ source: "fixture" as const, path: `inputs[${String(index)}]`, text: `${item.pathAndQuery}\n${item.body}` })), input.deny);
  if (!before.ok) return { ok: false, reason: "data_guard", report: before, phase: "inputs" };

  const skeleton = { schemaVersion: 1 as const, service: input.service, revision: input.revision, recordedAt: input.now().toISOString(), syntheticOnly: true as const, requestSchema: null, responseSchema: null, entries: [], faults: [] };
  const entries = new Map<string, ServiceMockFixtureSet["entries"][number]>();
  let duplicates = 0;
  for (const request of input.inputs) {
    const requestHash = hashOfRequest({ ...skeleton, requestSchema: null, responseSchema: null }, request);
    if (entries.has(requestHash)) { duplicates += 1; continue; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.perCallTimeoutMs ?? 15_000);
    let response: RecordedResponse;
    try {
      response = await input.send(request, controller.signal);
    } catch {
      return { ok: false, reason: "send_failed" };
    } finally {
      clearTimeout(timer);
    }
    // A server error, or a refusal (bad credentials, throttling, timeout), is the role or the service failing, not the service's answer: it is never recorded.
    if (response.status >= 500 || [401, 403, 407, 408, 429].includes(response.status)) return { ok: false, reason: "preprod_error" };
    if (bytes(response.body) > SERVICE_MOCK_BODY_MAX_BYTES) return { ok: false, reason: "response_too_large" };
    entries.set(requestHash, {
      requestHash,
      request: { contentType: request.contentType, body: request.body },
      response: { status: response.status, contentType: response.contentType, body: response.body, latencyMs: Math.min(Math.max(0, Math.round(response.latencyMs)), SERVICE_MOCK_LATENCY_MAX_MS) },
    });
  }
  const list = [...entries.values()];
  const requests = list.map((entry) => jsonOf(entry.request.body, entry.request.contentType)).filter((value) => value !== undefined);
  const responses = list.map((entry) => jsonOf(entry.response.body, entry.response.contentType)).filter((value) => value !== undefined);
  const set = ServiceMockFixtureSetSchema.safeParse({
    ...skeleton,
    requestSchema: requests.length === list.length ? inferJsonSchema(requests) : null,
    responseSchema: responses.length === list.length ? inferJsonSchema(responses) : null,
    entries: list,
  });
  if (!set.success) return { ok: false, reason: "set_invalid" };
  const after = guardFixtureSet(set.data, input.deny);
  if (!after.ok) return { ok: false, reason: "data_guard", report: after, phase: "responses" };
  return { ok: true, set: set.data, digest: serviceMockFixtureSetDigest(set.data), duplicates };
}
