/** DEC 172: dearest provider/kind already errs high; 50% covers a newly listed model. */
export const CAUTION_FACTOR = 1.5;
/** R3a fallback, only when there are no usable known provider rates. */
export const FLAT_CEILING_MICROS_PER_MTOK = 100_000_000;
/** Two-rate money seam accepts at most $1,000 per million tokens. */
export const PRICE_MAX = 1_000_000_000;
/** Daily prices, hourly retry, and three-day stale alarm (alarm wiring is a later lane). */
export const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const RETRY_MS = 60 * 60 * 1000;
export const STALE_ALARM_MS = 3 * REFRESH_INTERVAL_MS;
/** A stalled request gets 20s; a complete multi-region source gets one 60s deadline. */
export const FETCH_TIMEOUT_MS = 20_000;
export const FETCH_DEADLINE_MS = 60_000;
/** Guard/parked refresh limits; AWS bytes apply across all configured regions together. */
export const LITELLM_MAX_BYTES = 16_000_000;
export const AWS_MAX_BYTES = 64_000_000;
export const MIN_LITELLM_MODELS = 500;
/** Provisional, must be checked using the staging live-check before deployment. */
export const MIN_AWS_MODELS = 10;
export const SHRINK_FLOOR = 0.8;
export const DRIFT_FACTOR = 100;
export const MAX_ENTRIES_PER_SOURCE = 20_000;
export const MAX_NODES = 1_000_000;
export const MAX_PRICE_DEPTH = 16;
/** Correction is incremental so a refresh cannot monopolize the gateway. */
export const CORRECTION_RUN_MAX = 200;
export const CORRECTION_RUN_MS = 25_000;
/** Two calendar months plus headroom; expired unpriceable charges remain estimated. */
export const PENDING_RETENTION_DAYS = 62;
export const DAY_MS = 86_400_000;
/** Bounds for config and labels; reports carry fixed reasons, never source labels. */
export const MAX_AWS_REGIONS = 4;
export const MAX_MODEL_LENGTH = 512;
export const MAX_OVERRIDES = 1280;
export const OVERRIDE_MAX_DAYS = 90;
export const MAX_BAD_PRICE_FRACTION = 0.01;
export const MAX_DRIFT_FRACTION = 0.1;
export const USD_PER_TOKEN_SANITY_MAX = 0.01;
export const RATE_ROUNDING_TOLERANCE = 1e-9;
export const MICROS_PER_USD = 1_000_000;
export const RATE_SCALE = 1_000_000_000_000;
/** Legacy export; pooled effective-price confirmation now governs every decrease. */
export const ALLOW_LOWER: readonly string[] = [];
/** Run up to 5% early to spread replicas without exceeding the daily interval. */
export const REFRESH_JITTER = 0.05;

/** Unknown cached reads cannot cost more than this identity's input rate. */
export const UNKNOWN_READ_FACTOR = 1;
/** R3a M3: the highest current provider cache-write multiplier, applied only to own input. */
export const UNKNOWN_WRITE_FACTOR = 2;
/** Conservative unknown long-context component, applied to its own base component. */
export const UNKNOWN_LONG_FACTOR = 2;
/**
 * AWS's offer names a `_long_ctx` rate but never where its band starts (checked against the public AmazonBedrockFoundationModels
 * offer, 2026-11-17: no attribute or description states it). fetchAWS stores that rate at this band; pooling then moves it down to
 * the lowest band the model's own LiteLLM rows state (effectivePrices), so a model whose band starts earlier (Claude Haiku 5.5:
 * 100k) is never charged its base rate inside the band. It is never moved later.
 */
export const AWS_LONG_CONTEXT_FALLBACK = 200_000;
/** The default long-context band when an identity has no published threshold. */
export const UNKNOWN_LONG_THRESHOLD = 200_000;
