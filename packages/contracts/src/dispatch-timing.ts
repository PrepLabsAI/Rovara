/** Deployment/runtime timing shared below infra and broker; no provider dependency. */
export const CORE_DISPATCH_VISIBILITY_SECONDS = 120;
/** The hosted dispatcher's complete worker POST, including response headers. */
export const WORKER_POST_TIMEOUT_MS = 10_000;
/** The entire hosted claimant expires before it can be reclaimed. */
export const CORE_DISPATCHER_TIMEOUT_SECONDS = 60;
/** Extra scheduling/network margin after visibility plus an in-flight POST. */
const DISPATCH_CLAIM_MARGIN_MS = 20_000;
export const CORE_DISPATCH_CLAIM_STALE_MS = Math.max(CORE_DISPATCH_VISIBILITY_SECONDS * 1_000 + WORKER_POST_TIMEOUT_MS, CORE_DISPATCHER_TIMEOUT_SECONDS * 1_000) + DISPATCH_CLAIM_MARGIN_MS;

/** The broker hosts the durable outbox relay: Lambda bounds its entire enqueue
 * (queue discovery, SDK retries and send) by this invocation lifetime. */
export const CORE_BROKER_TIMEOUT_SECONDS = 30;
/** A hosted relay invocation has expired before its successor takes ownership.
 * The POST-sized margin also keeps relay recovery inside dispatch freshness. */
export const OUTBOX_RELAY_OWNERSHIP_MS = CORE_BROKER_TIMEOUT_SECONDS * 1_000 + WORKER_POST_TIMEOUT_MS;
