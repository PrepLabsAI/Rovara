// Kept apart from e2e-model-channel.ts (which uses node:crypto) so models.ts, and the browser-safe rovara-code.ts that imports it, reach no Node module.
/**
 * M1.4 Task 4.10B: why a provider call failed, in words that do not depend on the provider. `limit-or-rate-limited` is a quota or a rate limit, `key-rejected` an API key, role or
 * model access the provider did not accept, `model-not-found` a model the provider does not have for this account, `unreachable` no answer at
 * all (DNS, connection, TLS), `request-rejected` a request the provider refused as malformed or too large, `provider-outage` the provider's own fault or a timeout, `unknown` anything else. Two classes come from before any request is sent (Task 4.10C): `secret-unreadable` (the key's secret could
 * not be read) and `not-in-catalog` (Rovara's catalog does not know how to call the model).
 */
export const E2E_MODEL_FAILURE_CLASSES = ["limit-or-rate-limited", "key-rejected", "model-not-found", "unreachable", "request-rejected", "provider-outage", "unknown", "secret-unreadable", "not-in-catalog"] as const;
export type E2EModelFailureClass = (typeof E2E_MODEL_FAILURE_CLASSES)[number];
