# Verification

## Automated (2026-10-01, branch `feat/054-direct-provider-keys`)

- `npm test`: 374 files and 6,306 tests passed, 20 skipped, 0 failed.
- `npm run typecheck`: clean. `npm run typecheck:all`: 191 errors in 64 files, the same as the baseline (no new errors).
- `npm run lint`: clean.

New coverage:

| Area | Tests |
|---|---|
| Runtime: in-memory key, `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`OPENAI_API_KEY` ignored, scripted Anthropic Messages and OpenAI Responses streams, tool calls and tool-result replay, classifier, session persist/resume with no `auth.json` and no key in the session file, sanitized 401/404/429/529/500, cancellation, missing/empty/not-found/denied secrets, catalog refusal, reasoning refusal, subscription-token refusal, redaction of `sk-ant-api03-…` and `sk-proj-…` | `tests/integration/direct-provider-runtime.test.ts` |
| Usage `list-price`/`unknown` labels; thinking level left to the catalog | `usage-contract`, `worker-model-selection` |
| Worker settings, EC2 user data (new ARNs, never keys, injection refused, worst-case size within the 4 KB headroom), SWE-bench launch environment | `ec2-boot-config`, `session-steps`, `swebench-broker` |
| Stacks: per-provider parameter, condition and conditional read policy; worker SSM settings; snapshot changes are additions only | `ec2-worker-infrastructure`, `infrastructure`, `named-templates`, `legacy-templates` |
| Init questions, defaults, hidden key, prefix refusals, own-secret ARNs, `--yes` refusals, resume rotation and mismatch, plan secrets and list-price costs, prerequisite checks and Bedrock fallback, the HTTP check itself, doctor secret shapes | `tests/contract/direct-provider-cli.test.ts` |
| End-to-end unattended init with `--model-provider anthropic`: key stored before any stack, ARN in all three stacks, rotation on resume, key nowhere else | `init-cli` |
| Deploy parameters and adopt (including ARN drift refusal) | `deploy-parameters`, `environment-adopt` |

## Deviations from the plan

- `SECRET_ARN_MAX_LENGTH` (640) bounds the two new ARN fields in the EC2 boot config. At OpenRouter's 2,048 limit, three
  ARNs would leave less than the required 4 KB of headroom under EC2's 16 KB user-data limit. A real Secrets Manager
  ARN is at most about 600 characters. OpenRouter's existing limit is unchanged.
- OpenRouter's 400/413 errors now say "the request was refused; check the model's context and output limits" instead
  of the generic message. Every other OpenRouter message is unchanged.

## Live (pending)

SC-003 and SC-004 need a release, keys with spending limits and a budget. See the checklist in
[docs/model-providers.md](../../docs/model-providers.md#live-verification-not-yet-performed). No deployment and no paid
request was made during implementation.
