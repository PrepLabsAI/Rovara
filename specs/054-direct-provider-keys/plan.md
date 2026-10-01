# Direct Provider Keys Implementation Plan

**Goal:** Administrators can run any model role on Anthropic's or OpenAI's API with their own key, stored in
Secrets Manager and read into memory at runtime.

**Architecture:** A provider table in `@agentx/model-runtime` describes each keyed provider (OpenRouter, Anthropic,
OpenAI). Credential reading, missing-key fallback, catalog validation, error sanitization and usage telemetry
become table-driven. OpenRouter keeps its routing hook. Infra, init, deploy, doctor and boot each loop over the
table instead of hard-coding OpenRouter. Existing OpenRouter names are unchanged.

**Spec:** `specs/054-direct-provider-keys/spec.md`

## Provider table (`packages/model-runtime/src/providers.ts`, new)

| id | secret name | CFN parameter | SSM key | env var | key prefix | Pi transport |
|---|---|---|---|---|---|---|
| `openrouter` | `agentx/<env>/openrouter` | `OpenRouterSecretArn` | `worker-openrouter-secret-arn` | `AGENTX_OPENROUTER_SECRET_ARN` | `sk-or-` | openai-completions + routing (existing) |
| `anthropic` | `agentx/<env>/anthropic` | `AnthropicSecretArn` | `worker-anthropic-secret-arn` | `AGENTX_ANTHROPIC_SECRET_ARN` | `sk-ant-` | Pi `anthropic` provider |
| `openai` | `agentx/<env>/openai` | `OpenAISecretArn` | `worker-openai-secret-arn` | `AGENTX_OPENAI_SECRET_ARN` | `sk-` (not `sk-or-`/`sk-ant-`) | Pi `openai` provider |

## Tasks

- [x] **T001 Runtime.** Add `providers.ts`. Generalize `readOpenRouterKey` to `readProviderKey(provider, arn)`,
  `MissingOpenRouterSecret` to `MissingProviderSecret` (keeping the old names as aliases), and `openRouterModel` to
  `catalogModel(provider, id)`. In `createConfiguredModelRuntime`, give `anthropic`/`openai` a fresh
  `InMemoryCredentialStore`, set the key with `setRuntimeApiKey`, and wrap Pi's stream with the shared
  safe-error and usage wrapper that is extracted from `safeOpenRouterStream`. Tests: extend
  `tests/integration/openrouter-runtime.test.ts` into `keyed-provider-runtime.test.ts`, with scripted Anthropic SSE
  and OpenAI Responses streams, tool calls, aborts, each error status, missing/empty/denied secrets, and a test
  that `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` in `process.env` are ignored.
- [x] **T002 Callers.** `packages/worker/src/task-model.ts`: apply the thinking-level rule by reasoning support,
  not by `=== "openrouter"`. Audit every `"openrouter"` and `"amazon-bedrock"` branch in `packages/*/src`
  (`contracts/usage.ts` cost labels, `cli/init/plan.ts` pricing, `slack-service`, `orchestrator`) and
  change it to "keyed provider" where the meaning is "not Bedrock". Add `costSource: "list-price"`. Tests:
  `worker-model-selection`, `usage-contract`, `slack-model-selection`.
- [x] **T003 Contracts and settings.** Add `anthropicSecretArn`/`openaiSecretArn` to `WORKER_SETTING_PARAMETERS`
  and the worker settings schema in `contracts/session.ts`, plus the `AGENTX_*_SECRET_ARN` variables. Wire them
  through `broker/aws/session-steps.ts`, `broker/aws/swebench-settings.ts`, `contracts/swebench.ts`,
  `worker/ec2/boot.sh` and `worker/ec2/swebench-boot.sh`. Tests: `session-steps`, `ec2-boot-config`,
  `swebench-broker`.
- [x] **T004 Infra.** Generalize `infra/lib/openrouter.ts` into `infra/lib/model-keys.ts`, which loops over the
  table: a parameter, an `…Enabled` condition and a conditional `…SecretRead` policy per provider. Keep
  OpenRouter's logical IDs. Use it in `control-plane.ts`, `worker-settings.ts`, `slack-orchestrator.ts` (task
  environment, plus `GateClassifierProvider` allowed values) and `swebench-eval.ts`. Tests: `infrastructure`,
  `ec2-worker-infrastructure`, `swebench-eval-infrastructure`, and reviewed snapshot updates.
- [x] **T005 Init and deploy.** `cli/deploy/answer-schemas.ts` adds the providers enum and
  `models.anthropic?/openai?: { secretArn }`. `cli/init/answers.ts` adds provider choices 3 and 4, D3 defaults,
  key prompts, flags, prefix checks and resume/rotation. `cli/init/commands.ts` stores keys under the environment
  lock. `cli/init/plan.ts` lists the secrets and catalog prices. `cli/main.ts` adds the flags.
  `cli/deploy/{parameters,commands}.ts` and `cli/environments/adopt.ts` are updated too. Tests: `init-answers`,
  `init-cli`, `init-plan`, `deploy-parameters`, `environment-adopt`, `export-bundle`.
- [x] **T006 Checks.** `cli/init/prerequisites.ts` gets a `keyedProvider(provider, modelId, config, key?)` check.
  It calls Anthropic `GET /v1/models` then `POST /v1/messages`, or OpenAI `GET /v1/models` then
  `POST /v1/responses`, with 16 output tokens and one tool. Missing keys fall back as OpenRouter's do. Update
  `cli/config/commands.ts`, `cli/doctor/{account,secrets,checks}.ts` and `doctor-services`. Tests:
  `init-prerequisites`, `doctor-services`, `config-commands`.
- [x] **T007 Docs.** Add `docs/model-providers.md` covering install, flags, the answers file, rotation, workspace
  exposure, data handling (OpenAI `store: false`, each vendor's retention policy, and that ZDR is an account
  arrangement) and teardown. Link it from `docs/openrouter.md`, `docs/install.md` and `README.md`.
- [x] **T008 Verify.** Run `npm run typecheck`, `npm run lint` and `npm test`, and keep the typecheck baseline from
  growing. Record the results in `verification.md`. Live SC-003/SC-004 wait on keys, a budget and a release that
  the user runs.

## Ordering and risk

T001→T002 are self-contained and can merge first, because the providers are unreachable until config allows them.
T003→T004 change stack templates. They are backward-compatible (new parameters default to `""`), but the user
runs the production apply. T005–T006 expose the feature. Spec 050 (Pi upgrade) and spec 053 (thinking level)
touch `model-runtime` and `task-model.ts`, so rebase onto whichever lands first.
