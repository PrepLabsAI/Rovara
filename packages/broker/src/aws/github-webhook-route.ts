// Webhook lane W0: the HTTP front half of POST /v1/github/webhooks, in one place and in the order that keeps a public, unsigned endpoint cheap and safe:
//
//   1. cheap shape checks that read no secret and touch no table: the signature header's shape, the delivery id's, that an event name is present, and the body's size;
//   2. the secret (the loader caches it, a missing or failing one is remembered; this route also refuses to ask for a forced re-read more than once per interval);
//   3. the HMAC over the RAW body, constant time (the shared `verifyGithubWebhookSignature`), BEFORE anything is parsed, mapped or written;
//   3b. an event outside the allow-list is decided only AFTER step 3: a valid signature on an event we do not handle is 202 {ignored: true} (GitHub also sends push, workflow_run and the like to a hook that
//       subscribed to everything; a 403 there is a sustained 4xx that trips the alarm and can get the hook marked unhealthy); a bad signature stays 403 whatever the event, so no one can probe event handling unsigned;
//   4. `ping` (only after a valid signature) and the installation lifecycle events (they verify again with the secret that just verified);
//   5. the core branch for a core-owned task (aws/github-core-webhooks.ts): reads, then the reservation and the wake. Anything else that is signed and maps to no core task (D1: the old workflow engine's
//      pull request path is gone) is 202 IGNORED with no read or write.
//
// A delivery that fails step 1 or 3 does no work and no write. Everything signed that maps to nothing is 202 (GitHub's delivery list stays clean); a bad signature stays 403 (the attack signal, alarmed).
import { AgentXError } from "@agentx/contracts";
import { verifyGithubWebhookSignature } from "../plugins/code-host/github/signature.js";
import { GITHUB_CORE_EVENTS, isGithubCoreEvent, receiveCoreGithubWebhook, type GithubCoreWebhookInput } from "./github-core-webhooks.js";
import { isGithubInstallationEvent } from "./github-lifecycle.js";
import { GITHUB_WEBHOOK_SIGNATURE_INVALID, GithubWebhookRefusal, GithubWebhookRetryableError } from "./github-webhooks.js";

/** The largest body the receiver reads (GitHub's own cap is 25 MB; a bigger event is simply not worth an HMAC). */
export const GITHUB_WEBHOOK_MAX_BYTES = 1_048_576;
const SIGNATURE_SHAPE = /^sha256=[a-f0-9]{64}$/;
const DELIVERY_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_EVENTS = new Set<string>([...GITHUB_CORE_EVENTS, "ping", "installation", "installation_repositories", "repository"]);
/** A forced re-read of the secret is asked for at most this often per container (the loader keeps its own interval too). */
const REFRESH_INTERVAL_MS = 30_000;
const lastRefresh = new WeakMap<object, number>();

export interface GithubWebhookRouteInput {
  headers: Record<string, string | undefined>;
  body: string | undefined;
  /** The webhook HMAC key reader (cached by its loader). Absent: the receiver is not configured. */
  secret: ((options?: { refresh?: boolean }) => Promise<string>) | undefined;
  /** True for the loader's "this secret holds no usable key" refusal. */
  isSecretMissing: (error: unknown) => boolean;
  /** Present when the install has installation bindings: only then is there a core branch. */
  core?: Pick<GithubCoreWebhookInput, "documentClient" | "tableName" | "bindings" | "perMinute"> | undefined;
  now: () => number;
  log: (entry: Record<string, unknown>) => void;
  /** The installation lifecycle handler, called with the secret that verified. Present when the install has installation bindings. */
  installation: ((secret: string) => Promise<{ status: "ACCEPTED"; deliveryId: string }>) | undefined;
}

export interface GithubWebhookRouteAnswer { status: number; body: unknown }

const failure = (status: number, code: string, message: string): GithubWebhookRouteAnswer => ({ status, body: { error: { code, message } } });
const NOT_CONFIGURED = (): GithubWebhookRouteAnswer => failure(503, "RUNTIME_UNAVAILABLE", "GitHub webhook handling is not configured");

/** Shape checks that read nothing: undefined when the request is well formed. `reason` is the metric word (a missing or malformed signature counts as an invalid one: the attack signal). */
function badShape(headers: Record<string, string | undefined>, body: string): { answer: GithubWebhookRouteAnswer; reason: "size" | "signature_invalid" | "header" } | undefined {
  if (Buffer.byteLength(body, "utf8") > GITHUB_WEBHOOK_MAX_BYTES) return { answer: failure(413, "PAYLOAD_TOO_LARGE", "GitHub webhook payload exceeds the size limit"), reason: "size" };
  const signature = headers["x-hub-signature-256"];
  if (signature === undefined || !SIGNATURE_SHAPE.test(signature)) return { answer: failure(403, "FORBIDDEN", GITHUB_WEBHOOK_SIGNATURE_INVALID), reason: "signature_invalid" };
  const delivery = headers["x-github-delivery"];
  if (delivery === undefined || !DELIVERY_SHAPE.test(delivery)) return { answer: failure(403, "FORBIDDEN", "GitHub webhook delivery ID is invalid"), reason: "header" };
  // Only the presence of an event name is a shape rule; whether we handle it is decided after the signature verified (see the header comment).
  const event = headers["x-github-event"];
  if (event === undefined || event === "") return { answer: failure(403, "FORBIDDEN", "GitHub webhook event type is missing"), reason: "header" };
  return undefined;
}

/** GitHub's event names are lower-case words and underscores; anything else (only reachable with a valid signature) is logged as "other". */
const loggableEventName = (event: string): string => (/^[a-z_]{1,64}$/.test(event) ? event : "other");

/** The secret that verifies this body: the cached one, or (once per interval) a forced re-read after a rotation. Undefined when none verifies; "unconfigured" when there is no usable secret. */
async function verifiedSecret(input: GithubWebhookRouteInput, body: string, signature: string): Promise<{ secret: string } | "invalid" | "unconfigured"> {
  const read = async (refresh: boolean): Promise<string | undefined> => {
    try { return await input.secret!(refresh ? { refresh: true } : undefined); }
    catch (error) { if (input.isSecretMissing(error)) return undefined; throw error; }
  };
  const secret = await read(false);
  if (secret === undefined) return "unconfigured";
  if (verifyGithubWebhookSignature(body, signature, secret)) return { secret };
  const asked = lastRefresh.get(input.secret!);
  if (asked !== undefined && input.now() - asked < REFRESH_INTERVAL_MS) return "invalid";
  lastRefresh.set(input.secret!, input.now());
  // The secret may have been changed since this container read it; verifying once more with a fresh copy has no side effect.
  const renewed = await read(true);
  if (renewed === undefined) return "unconfigured";
  return renewed !== secret && verifyGithubWebhookSignature(body, signature, renewed) ? { secret: renewed } : "invalid";
}

async function dispatch(input: GithubWebhookRouteInput, body: string, headers: Record<string, string | undefined>, secret: string): Promise<GithubWebhookRouteAnswer> {
  const event = headers["x-github-event"]!;
  const deliveryId = headers["x-github-delivery"]!;
  if (event === "ping") return { status: 200, body: { delivery: "PONG" } };
  if (input.installation !== undefined && isGithubInstallationEvent(headers)) {
    const result = await input.installation(secret);
    return { status: 200, body: { delivery: result.status, deliveryId: result.deliveryId } };
  }
  if (input.core === undefined || !isGithubCoreEvent(event)) return { status: 202, body: { delivery: "IGNORED" } };
  const outcome = await receiveCoreGithubWebhook({ ...input.core, rawBody: body, eventName: event, deliveryId, now: input.now, log: input.log });
  switch (outcome.kind) {
    case "ignored": return { status: 202, body: { delivery: "IGNORED" } };
    case "throttled": return { status: 202, body: { delivery: "THROTTLED" } };
    case "duplicate": return { status: 200, body: { delivery: "DUPLICATE", deliveryId: outcome.deliveryId } };
    case "accepted": return { status: 200, body: { delivery: "ACCEPTED", deliveryId: outcome.deliveryId } };
  }
}

/**
 * Every refusal the handlers raise gets one structured line (event, action, reason, delivery id: never payload text or a secret) and an answer by its kind: a signed delivery that is not ours to act on is 202
 * (ignored, info; GitHub's delivery list stays clean and the 4xx alarm stays quiet), a reused delivery id is 409 (warn), everything else is the 403 it always was (warn). The signature was verified before any
 * handler ran, so none of this is reachable unsigned.
 */
function refusalAnswer(input: GithubWebhookRouteInput, headers: Record<string, string | undefined>, error: GithubWebhookRefusal): GithubWebhookRouteAnswer {
  const kind = error.details.kind ?? "reject";
  const reason = error.details.reason ?? "refused";
  const line = { hook: loggableEventName(headers["x-github-event"] ?? ""), ...(error.details.action === undefined ? {} : { action: loggableEventName(error.details.action) }), reason, deliveryId: headers["x-github-delivery"]! };
  if (kind === "ignore") {
    input.log({ event: "github_webhook.ignored", level: "info", ...line });
    return { status: 202, body: { ignored: true, reason } };
  }
  input.log({ event: kind === "conflict" ? "github_webhook.conflict" : "github_webhook.refused", level: "warn", ...line });
  return kind === "conflict" ? failure(409, "CONFLICT", error.message) : failure(403, "FORBIDDEN", error.message);
}

/** Signed, but not ours to handle: acknowledge it so GitHub's delivery list stays clean. One info line (event name and delivery id only: no payload, no secret); no table read or write, no rejected-kind log word. Undefined for a handled event. */
function ignoreUnhandledEvent(input: GithubWebhookRouteInput, headers: Record<string, string | undefined>): GithubWebhookRouteAnswer | undefined {
  const event = headers["x-github-event"]!;
  if (ALLOWED_EVENTS.has(event)) return undefined;
  input.log({ event: "github_webhook.ignored", level: "info", reason: "unhandled_event", hook: loggableEventName(event), deliveryId: headers["x-github-delivery"]! });
  return { status: 202, body: { ignored: true } };
}

/** A transient failure is a logged 503 (GitHub's delivery list shows it and a redelivery is safe); anything else is a bug and is rethrown. */
function retryAnswer(input: GithubWebhookRouteInput, headers: Record<string, string | undefined>, error: unknown): GithubWebhookRouteAnswer {
  if (!(error instanceof GithubWebhookRetryableError || (error instanceof AgentXError && error.code === "RUNTIME_UNAVAILABLE"))) throw error;
  input.log({ event: "github_webhook.retry", level: "warn", hook: loggableEventName(headers["x-github-event"] ?? ""), reason: "retryable", deliveryId: headers["x-github-delivery"]! });
  return failure(503, "RUNTIME_UNAVAILABLE", "GitHub webhook processing will be retried");
}

export async function handleGithubWebhookRoute(input: GithubWebhookRouteInput): Promise<GithubWebhookRouteAnswer> {
  if (input.body === undefined || input.secret === undefined) return NOT_CONFIGURED();
  const headers = Object.fromEntries(Object.entries(input.headers).map(([key, value]) => [key.toLowerCase(), value]));
  const shape = badShape(headers, input.body);
  if (shape !== undefined) {
    input.log(shape.reason === "signature_invalid" ? { event: "github_webhook.signature_invalid" } : { event: "github_webhook.rejected", reason: shape.reason });
    return shape.answer;
  }
  try {
    const verified = await verifiedSecret(input, input.body, headers["x-hub-signature-256"]!);
    if (verified === "unconfigured") return NOT_CONFIGURED();
    if (verified === "invalid") { input.log({ event: "github_webhook.signature_invalid" }); return failure(403, "FORBIDDEN", GITHUB_WEBHOOK_SIGNATURE_INVALID); }
    const unhandled = ignoreUnhandledEvent(input, headers);
    if (unhandled !== undefined) return unhandled;
    return await dispatch(input, input.body, headers, verified.secret);
  } catch (error) {
    if (error instanceof GithubWebhookRefusal) return refusalAnswer(input, headers, error);
    return retryAnswer(input, headers, error);
  }
}
