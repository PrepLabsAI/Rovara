# Quickstart: Validate Worker Usage Telemetry

## Automated validation

```sh
npm run typecheck
npm run lint
npm test
npm run infra:synth
```

Focused validation covers successful, failed, and cancelled task usage; redaction; event compatibility; cache-retention fallback; and production runtime synthesis.

## Manual production validation

After an authorized deployment, run one disposable Slack coding task. Inspect its operation events for one `usage` event and its private artifacts for `usage.json`. Confirm provider, model, retention mode, token counts, ratio, and estimated cost match between them. CloudFormation should show `PromptCacheRetention=long` unless explicitly overridden.

No deployment is part of this implementation task.

## Local validation evidence

Validated on 2026-09-24 from `feature/025-usage-telemetry`:

- `npm run typecheck` — passed.
- `npm run lint` — passed.
- Focused telemetry validation — 6 files and 37 tests passed.
- `npm test` — 46 files and 259 tests passed.
- `npm run infra:synth` — passed; existing CloudFormation warnings about the GitHub private-key secret ARN parameter remain unchanged.

No deployment or live Bedrock usage measurement was performed.
