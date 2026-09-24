# Research: Worker Usage Telemetry

## Pi statistics API

Use `SessionStats` from the package root and `AgentSession.getSessionStats()`. The public structure includes input, output, cache-read, cache-write, total tokens, and aggregate cost. Internal cost-breakdown helpers are outside the export map and are not used.

## Usage payload

Record the provider and configured model ID because the current aggregate session stats do not include model identity. Record `costUsd` as Pi's estimate rather than recomputing prices. Version the payload for later evolution.

Cache-read ratio is `cacheRead / (input + cacheRead + cacheWrite)`, or zero when the denominator is zero. This describes the share of charged input-side tokens served from cache without inventing a model-specific price calculation.

## Failure semantics

Capture statistics after the success, failure, or cancellation outcome is determined and before disposing the session. Publish both outputs once. If telemetry fails after the task already failed, preserve the task's original error so cancellation classification and diagnostics remain accurate.

## Cache retention

Pi treats only `PI_CACHE_RETENTION=long` as long retention and otherwise uses short retention. The worker reports the same effective value. Production receives a CDK parameter constrained to `short|long`, default `long`; demo retains Pi's short fallback.

## Control-plane compatibility

Both in-memory and AWS event receivers validate only that event type and timestamp are strings. No schema migration is needed. A contract test records the new type to guard this compatibility.
