// Design review stage: a review is run only where every reviewer can be given a key of its own (security S9, N4). On an install with no model proxy there are no per-reviewer keys: reviewers would run on
// the install's own credential, report no key and could be checked by their packet digest and nothing else. The broker refuses to dispatch the review there and records it as not run, so the card says so
// instead of showing a review no one could verify. Slice B calls this before it estimates, stores a packet or dispatches a round.

export type DesignReviewProxyCheck = { ok: true } | { ok: false; notRunReason: "no_verified_model" };

/** Whether the broker has a model proxy to mint reviewer keys from (the same thing `/v1/internal/model-access` needs). Pure: reads one field, changes nothing. */
export function designReviewProxyCheck(proxy: { slotKeys?: unknown } | undefined): DesignReviewProxyCheck {
  return proxy !== undefined && proxy.slotKeys !== undefined ? { ok: true } : { ok: false, notRunReason: "no_verified_model" };
}
