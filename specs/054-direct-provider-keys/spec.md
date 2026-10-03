# Feature Specification: Bring Your Own Anthropic or OpenAI API Key

**Feature Branch**: `docs/054-direct-provider-keys` (spec), then `feat/054-direct-provider-keys`  
**Created**: 2026-10-01  
**Status**: Implemented on `feat/054-direct-provider-keys`; awaiting release and live verification (SC-003, SC-004)  
**Input**: "Let's add support for bringing your own API key for Claude or OpenAI." Clarified on 2026-10-01: the key
belongs to the installation's administrator (not a project or a Slack user), and all three model roles can use it.

## Why

Today AgentX reaches models through Amazon Bedrock or OpenRouter (spec 032). An administrator who already pays
Anthropic or OpenAI directly cannot use that account:

- **No Bedrock model access is needed.** A new AWS account must enable each Bedrock model and, for Anthropic models,
  fill in the first-use form. Some models are not offered at all: Claude Opus 5's Bedrock agreement is
  `NOT_AVAILABLE` in the production account, which blocks it from spec 046's campaign.
- **OpenAI models are only reachable through OpenRouter.** That adds a router, its routing policy and its data
  policy between AgentX and the model.
- **Existing spend and limits stay in one place.** Teams with an Anthropic or OpenAI organization keep their
  rate limits, invoices, zero-data-retention arrangements and spending caps.

The pinned Pi SDK (1.0.0 since spec 050; 0.85.1 when this spec was written) already ships an `anthropic` provider (Messages API) and an `openai` provider
(Responses API, sent with `store: false`). Both come with model catalogs that include limits, reasoning support
and list prices. Most of the work is configuration, credentials and checks, following the path OpenRouter
already established.

## User Scenarios

### An administrator installs AgentX on Anthropic's API (Priority: P1)

`agentx init` asks for the model provider. The administrator picks **Anthropic API**, accepts the suggested
models, and pastes the API key into a hidden prompt. Init stores the key in Secrets Manager as
`agentx/<env>/anthropic` and checks each model with a small request. The install then completes. A Slack coding
task runs with the orchestrator, classifier and worker all calling `api.anthropic.com`, with no Bedrock inference.

### An administrator mixes providers (Priority: P1)

The orchestrator and classifier stay on Bedrock and the worker uses OpenAI:
`--worker-provider openai --worker-model gpt-5.4 --openai-key-file ./openai-key.txt`. Only the OpenAI key is
asked for and stored.

### A project approves a direct model next to Bedrock ones (Priority: P1)

The project's `approvedModels` lists `{ "provider": "anthropic", "modelId": "claude-opus-5", "label": "Opus 5
(Anthropic)" }` beside Bedrock Sonnet. `@agentx use Opus 5 (Anthropic)` switches the project's coding model, and
the next turn calls Anthropic directly. SWE-bench and SEC-bench runs (`... model Opus 5 (Anthropic)`) can do the
same.

### An administrator rotates or adds a key on an existing install (Priority: P2)

A rerun of `agentx init --anthropic-key-file ./new-key.txt` replaces the stored key. Adding OpenAI later uses the
same flags. `agentx doctor` reports a missing or empty key secret and gives the command that fixes it.

## Requirements

### Providers and models

- **FR-001:** Add two model providers, `anthropic` and `openai`, alongside `amazon-bedrock` and `openrouter`.
  Every place that accepts a provider accepts them: init and deploy answers, `--model-provider` and the
  per-role provider flags, the `ModelProvider` and `GateClassifierProvider` stack parameters, project
  `approvedModels`, and Slack model selection.
- **FR-002:** A model ID must be in the installed Pi catalog for its provider, with a positive context window and
  output limit. Otherwise the configuration is refused with "not in the installed Pi catalog; choose a supported
  model or update AgentX". This is the rule OpenRouter already uses, and it means AgentX never guesses limits. A
  model newer than the pinned Pi needs a Pi upgrade. Pi 1.0.0 (spec 050) includes `claude-opus-5-5`.
- **FR-003:** Requests use Pi's own transports for each provider: Anthropic Messages for `anthropic` and OpenAI
  Responses for `openai`. Streaming, tool calls, tool-result replay, cancellation, resumption and model switching
  behave as they do for Bedrock. The existing `PI_CACHE_RETENTION` setting applies, and Pi maps it to each API's
  prompt caching. No server-side fallback model is ever requested (Pi 1.0 lists some for Claude models), and
  prompt changes are not sent as mid-conversation system messages, as spec 050 Ruling 7 does for OpenRouter.
- **FR-004:** The thinking level follows the Bedrock rule: `medium` for a model that supports reasoning, `off`
  otherwise. When spec 053 lands, its per-model level applies here too. Refuse an explicit level other than `off`
  on a model without reasoning support, as OpenRouter does.
- **FR-005:** Claude Pro/Max subscription (OAuth) sign-in is out of scope. Pi offers it for `anthropic`, but
  AgentX accepts only API keys.

### Credentials

- **FR-006:** Each provider has one Secrets Manager secret whose value is the **raw API key** (not JSON). By default
  it is `agentx/<env>/anthropic` or `agentx/<env>/openai`, created by init with the AWS-managed encryption key. An
  administrator can instead give the ARN of a secret they made themselves. Only ARNs appear in answers, stack
  parameters, SSM, boot user data and container environment files, never the key.
- **FR-007:** Keys are read into memory when a session opens (worker, orchestrator) or when the service starts
  (classifier). They are handed to Pi through an in-memory credential store. AgentX never sets
  `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_OAUTH_TOKEN` or `OPENAI_API_KEY` in any process
  environment, and a configured provider does not fall back to those variables if they happen to be present.
  Pi reads them by default, so this must be tested.
- **FR-008:** Only the hosted Slack task role and the worker instance role (plus the eval instance role) get
  `secretsmanager:GetSecretValue`, and each role gets it only for the configured ARNs. The grant lives in the
  releasable control-plane stack, as OpenRouter's does. The protected foundation template does not change.
- **FR-009:** The missing-key behavior matches OpenRouter's (spec 032). If the ARN is not configured, the secret
  does not exist, or its value is empty, the role's default Bedrock model is used before the session opens, a
  `model_fallback` event is logged, and the effective model is recorded. Access denied, a malformed key,
  rate limits and inference errors do **not** fall back.
- **FR-010:** Key values are trimmed. An empty key, a key with an embedded newline, or a key shorter than a
  minimum length is refused. Init also rejects a key with the wrong prefix for its provider, for example an
  OpenRouter `sk-or-` key given as the OpenAI key. The existing `sk-` redaction rule already covers both
  providers' key formats. Add a test that proves it for `sk-ant-api03-…` and `sk-proj-…`.

### Install, deploy and day-two

- **FR-011:** The init provider question gains `3. Anthropic API` and `4. OpenAI API`. Each one sets all three
  roles to that provider and offers the default models in Decision D3. Init then asks for that provider's key in
  a hidden prompt. Unattended runs use `--anthropic-key-file`/`--anthropic-key-env`/`--anthropic-secret-arn` and the
  `--openai-…` equivalents, never a flag value, and `--yes` without a key source refuses before creating anything.
  The resume, rotation and `--export` rules are the same as OpenRouter's.
- **FR-012:** Init asks only for the keys of providers that a role uses, or that `--…-key-*` flags name explicitly
  so a project can approve that provider's models. The plan lists each secret init will create.
- **FR-013:** Preflight (init, `config`, `doctor`) checks each direct-provider role the way OpenRouter roles are
  checked. It confirms the model is in the Pi catalog and the provider's model-list API, then sends one completion
  of at most 16 output tokens with a tool attached. Failures name the likely cause: the key, permissions, credits
  or spending limit, model access for the organization, or rate limits. A direct-provider role with a usable key
  makes no Bedrock call.
- **FR-014:** `agentx deploy` answers, `environments adopt`, `doctor secrets`, the teardown text in the export
  bundle, and `docs/` cover the new providers. Adopt refuses an install whose stacks reference different ARNs for
  the same provider.
- **FR-015:** The worker settings in SSM, the EC2 boot script, the SWE-bench eval settings and boot script, and the
  Slack task definition carry `AGENTX_ANTHROPIC_SECRET_ARN` and `AGENTX_OPENAI_SECRET_ARN`, the same way they carry
  the OpenRouter ARN today.

### Usage, cost and errors

- **FR-016:** Usage records name the provider and the requested model, plus the returned model when the API reports
  one. Cost comes from Pi's catalog list price and is labeled `costSource: "list-price"`. When the price is unknown
  it is `null` and labeled `unknown`, never 0. The init plan's cost estimate prices direct-provider roles from the
  same catalog, so spec 048's FR-024 (a price on every offered model) holds.
- **FR-017:** Raw provider errors never reach the Slack transcript or logs. A safe diagnostic replaces them,
  chosen from the HTTP status: 401/403 key or permissions, 402/insufficient-quota credits, 404 model access,
  429 rate limit, 529/overloaded and other 5xx upstream unavailable. This is the treatment OpenRouter's errors
  get today. Prompts, tool results and keys are never logged.

### Compatibility

- **FR-018:** Bedrock and OpenRouter installs behave exactly as before, with no new required parameters. New stack
  parameters default to `""`. Saved answers without the new fields parse and deploy unchanged. Existing stack
  snapshot tests change only where the new optional parameters, conditions and conditional policies are added.

## Out of Scope

- Per-project or per-Slack-user keys, and any key entry through Slack. Only administrators set keys, through init.
- Claude Pro/Max OAuth, Azure OpenAI, Google Vertex and other OpenAI-compatible endpoints (issue #111, gateways).
- An inference proxy that keeps keys away from the worker. The workspace exposure that spec 032 documents for
  OpenRouter applies equally here; see Decision D4.
- Automatic fallback between providers on inference errors.

## Decisions

- **D1: One raw-key secret per provider, defined in one table.** A single table lists each provider with a
  secret-name suffix, CloudFormation parameter, SSM key, environment variable, base URL, key prefix and preflight
  endpoints. Init, deploy, infra, boot and doctor all iterate that table, so a future provider is one new row. Raw
  keys keep self-made secrets simple and allow each key to be rotated separately. OpenRouter keeps its current
  parameter, SSM and environment names, because renaming them would break deployed stacks. It moves onto the table
  only where that is a pure refactor.
- **D2: Missing key falls back to Bedrock (FR-009).** This keeps one rule across all keyed providers and lets
  deploys proceed before the key is stored. An install with no Bedrock model access gets a clear Bedrock error on
  that fallback, not a silent change of provider.
- **D3: Defaults for the one-question install (to confirm).** Anthropic: `claude-sonnet-4-6` for the orchestrator and
  worker and `claude-haiku-4-5` for the classifier, which mirrors the Bedrock defaults. OpenAI: `gpt-5.4` for the
  orchestrator and worker and `gpt-5.4-mini` for the classifier. All are in the Pi catalog with prices.
- **D4: Document the workspace exposure; don't solve it here.** Code running in a worker workspace can reach IMDS
  and read any key the worker role can read. The docs require a dedicated key per installation with a hard
  spending limit (an Anthropic workspace or OpenAI project key), as spec 032 does.

## Open Questions

Both were settled on 2026-10-01 when implementation was approved, by taking the recommendations: D3's
defaults for both providers, and D2's fallback to Bedrock on a missing key.

## Success Criteria

- **SC-001:** Automated tests cover catalog validation, the in-memory key path (including that the env variables
  are ignored), missing, empty, denied and malformed secrets, the init/deploy/adopt/doctor flows, stack parameters
  and IAM conditions, boot and eval settings, usage cost labels, and error sanitization against scripted
  Anthropic SSE and OpenAI Responses streams.
- **SC-002:** All existing Bedrock and OpenRouter tests pass unchanged, except snapshot diffs that only add the new
  optional parameters.
- **SC-003 (live, needs keys and a budget):** In a test environment, one coding task each on Anthropic and OpenAI
  edits a file, runs its test and answers a follow-up after a worker stop/resume. Logs show no Bedrock inference,
  and usage records match each provider's dashboard to within list-price rounding.
- **SC-004:** One SWE-bench Verified run on `anthropic/claude-opus-5` completes from `#swe-bench-evals`, which is
  the path spec 046 needs.
