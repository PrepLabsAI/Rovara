# Data Model: Worker Usage Telemetry

## Usage payload

| Field | Constraint | Meaning |
| --- | --- | --- |
| `schemaVersion` | `1` | Payload compatibility version |
| `outcome` | `SUCCEEDED`, `FAILED`, or `CANCELLED` | Task outcome at capture time |
| `provider` | Non-empty string | Pi provider used by the task |
| `modelId` | Non-empty string | Pi model configured for the task |
| `cacheRetention` | `short` or `long` | Effective prompt-cache retention |
| `tokens.input` | Non-negative integer | Uncached input tokens |
| `tokens.output` | Non-negative integer | Output tokens |
| `tokens.cacheRead` | Non-negative integer | Tokens served from cache |
| `tokens.cacheWrite` | Non-negative integer | Tokens written to cache |
| `tokens.total` | Non-negative integer | Pi's aggregate total |
| `cacheReadRatio` | Finite number from 0 through 1 | Cached share of input-side tokens |
| `costUsd` | Non-negative finite number | Pi's aggregate estimated cost |

The payload is emitted once as an operation event with type `usage` and once as a private artifact named `usage.json`. Both contain the same redacted JSON value.

## Runtime parameter

`PromptCacheRetention` is a production CloudFormation string parameter with allowed values `short` and `long`, default `long`. It supplies the runtime environment variable `PI_CACHE_RETENTION`.
