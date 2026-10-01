# OpenRouter model access

AgentX can use Bedrock, OpenRouter, or both. Each model is identified by its `provider` and
`modelId`. Project approval controls which coding models Slack users can select. The worker,
Slack orchestrator, and action-gate classifier have independent defaults. To call Anthropic or
OpenAI directly with your own key, see [Your own Anthropic or OpenAI API key](model-providers.md).

## Configure an installation

`agentx init` asks for the model provider first: `1. Amazon Bedrock (recommended) (default)`,
`2. OpenRouter`. Choosing OpenRouter sets the orchestrator, classifier and worker providers to
`openrouter`, asks for each one's OpenRouter model id (there is no default: pick models you have
checked), then asks for your **OpenRouter API key** in a hidden prompt. Init stores the raw key, not
a JSON object, in the Secrets Manager secret `agentx/<env>/openrouter`, with the AWS-managed
encryption key, just before it saves its answers. The saved answers hold only the secret's ARN, never
the key, and the plan lists the secret. A rerun after the key is stored resumes and does not ask again.
Use a dedicated key for each installation and require a hard spending limit on that key before enabling OpenRouter. The $5 smoke-test cap is an example, not a production default.

For an unattended run (`--yes`), give the key in a file or an environment variable, never as a flag's
value; without either, `--yes` refuses before creating anything:

```sh
--model-provider openrouter \
--orchestrator-model anthropic/claude-sonnet-4 --classifier-model anthropic/claude-sonnet-4 --worker-model anthropic/claude-sonnet-4 \
--openrouter-key-file ./openrouter-key.txt \
--openrouter-providers anthropic
```

`--openrouter-key-env <NAME>` reads the key from an environment variable instead. Rerunning the same
command replaces the stored key with the one given, so an unattended rerun works unchanged; once the
install has finished, restart the Slack service and stop/resume workers to pick up a replaced key, as
for any rotation. The per-component flags `--orchestrator-provider`,
`--classifier-provider` and `--worker-provider` win over `--model-provider`, so a mixed setup (for
example an OpenRouter worker with Bedrock for the rest) still comes from flags. A provider or model
flag also skips the provider question: a component no flag sets stays on Bedrock, as before. Init asks
for the key whenever any provider is `openrouter`.

To use a secret you made yourself instead, create it with the **raw OpenRouter API key** as its value
and pass `--openrouter-secret-arn`; init then asks for no key and stores nothing. Use the AWS-managed
Secrets Manager encryption key. Customer-managed encryption keys require an additional
administrator-managed `kms:Decrypt` grant and key policy; AgentX does not add that grant.

```sh
--orchestrator-provider openrouter --orchestrator-model anthropic/claude-sonnet-4 \
--classifier-provider openrouter --classifier-model anthropic/claude-sonnet-4 \
--worker-provider openrouter --worker-model anthropic/claude-sonnet-4 \
--openrouter-secret-arn arn:aws:secretsmanager:us-east-1:123456789012:secret:my-openrouter-key-AbCdEf \
--openrouter-providers anthropic
```

These are example IDs, not a cost or model recommendation. Each omitted provider defaults to
`amazon-bedrock`; an OpenRouter role needs its own OpenRouter model ID. `init --export` stores no
secret, so it takes `--openrouter-secret-arn` (a secret you made yourself), not a key; with
`agentx deploy` the secret ARN may be omitted until the secret is ready. A deploy answers file uses:

```json
{
  "models": {
    "orchestrator": "anthropic/claude-sonnet-4",
    "classifier": "amazon.nova-lite-v1:0",
    "worker": "anthropic/claude-sonnet-4",
    "providers": {
      "orchestrator": "openrouter",
      "classifier": "amazon-bedrock",
      "worker": "openrouter"
    },
    "openRouter": {
      "secretArn": "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/openrouter-AbCdEf",
      "providers": ["anthropic"]
    }
  }
}
```

This fragment belongs in the usual complete deploy answers file. To enable OpenRouter as a
project choice while retaining Bedrock defaults, supply `openRouter` and keep the role
providers omitted or set to `amazon-bedrock`. Legacy saved answers retain their Bedrock behavior.

Init checks the pinned Pi catalog, current OpenRouter model availability, tool support, and a
small completion (up to 16 output tokens). This check can incur an OpenRouter charge. OpenRouter
roles with a usable secret do not run the Bedrock inference check. If the ARN or secret value is missing, init checks and reports the default Bedrock model instead. AWS hosting prerequisites are still checked.

CloudFormation's `OpenRouterSecretArn` is passed to control-plane, worker-settings (`runtime`),
and Slack stacks. The control plane owns the read policy for both the worker instance role
(using the foundation's existing role ARN output) and the Slack task role. The protected
foundation template has no OpenRouter settings or policies. `OpenRouterProviders` configures worker-settings and Slack routing.
The Slack stack also accepts `GateClassifierProvider`, independently of `ModelProvider` and
`GateClassifierModelId`. Direct CDK deployments must set the same secret reference in all three
stacks. Do not use a CloudFormation dynamic reference that substitutes the actual secret value.

For manual change sets, compare `OpenRouterSecretArn` in the control-plane, runtime, and Slack
stack parameters before enabling models or rotating to a different ARN. `agentx deploy` supplies
the same reference to all three; independently edited change sets can drift. A grant/configuration
mismatch causes `AccessDenied` and is deliberately not treated as a missing secret. Repair the
mismatched parameter and redeploy/restart the affected service. A single authoritative reference
for manual deployments is not implemented in this release.

Only the worker instance role and hosted Slack task role receive `GetSecretValue` for that ARN.
Boot user data and the root-owned container environment file contain the ARN, never the key.
Pi receives the resolved key in an in-memory credential store. Worker sessions resolve it when
opened; the long-lived classifier resolves it at service startup, so restart Slack tasks after
rotating its key. Existing EC2 workers need to be stopped/resumed to receive changed boot settings.
Deploy all stacks before enabling OpenRouter project choices.

## Workspace credential exposure

The worker instance role can read the OpenRouter secret. For projects running directly in the
worker container, shell commands and dependency install scripts can reach IMDS over the host
network, obtain that role's credentials, and call Secrets Manager themselves. The in-memory
credential store prevents Pi from writing an auth file; it does **not** isolate the key from code
executed in the workspace. A copied OpenRouter key can be used outside AWS.

Use only trusted projects/dependencies with this mode, keep a dedicated key with a hard spending
limit, monitor provider usage, and revoke/rotate it if exposure is suspected. Do not rely on a
devcontainer as the credential security boundary. Stronger protection requires an inference proxy
outside the worker that holds/injects the key, plus removal of the worker's secret-read permission
and controls preventing bypass. That proxy is not included in this change.

## Select a coding model from Slack

Add approved pairs to the project's existing `approvedModels`, for example:

```json
[
  { "provider": "amazon-bedrock", "modelId": "us.anthropic.claude-sonnet-4-6", "label": "Bedrock Sonnet" },
  { "provider": "openrouter", "modelId": "anthropic/claude-sonnet-4", "label": "OpenRouter Sonnet" }
]
```

Reply in the project thread:

```text
@agentx models
@agentx use OpenRouter Sonnet
```

The list and confirmation show the provider. Selection applies to subsequent coding turns in
**every workspace in that project**. It does not change the orchestrator or classifier. An
ambiguous model ID requires a label or the full `provider/modelId`. Only administrators change
the approved list or credentials; no key is accepted through this Slack flow.

## Routing, limits, and usage

The installed Pi SDK supplies models, context/output limits, reasoning metadata, streaming,
tool-call assembly, and tool-result replay. Unknown IDs are refused instead of assigning guessed
limits. Automatic-router aliases such as `openrouter/auto` are refused. Explicit reasoning on a model without reasoning support is refused. Update AgentX's
pinned Pi version to use models absent from its catalog.

Requests name one model and set `allow_fallbacks: false`, `require_parameters: true`, and
`data_collection: "deny"`. An optional provider allowlist supplies both `only` and `order`.
Without it, OpenRouter chooses an eligible upstream for the requested model. There is no
AgentX model escalation or fallback to Bedrock on inference errors. A missing secret is the explicit exception described below. The transport performs no automatic HTTP retry;
Pi's session recovery retains completed tool results instead of starting the task again.
Unsupported parameters, exhausted credits, and unavailable permitted providers fail the request.
Each request carries the session's current system prompt once, at the start, even after a resumed
Slack turn changes it. AgentX does not send Pi's session ID to OpenRouter (no `x-session-id` header),
and Pi's prompt-cache warming requests are off.

`data_collection: "deny"` is a provider data-policy filter, **not a guarantee of zero retention
or data residency**. Consult [OpenRouter's routing policy documentation](https://openrouter.ai/docs/guides/routing/provider-selection)
and configure account-level policies for additional requirements. Model capability discovery
uses [OpenRouter's model API](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties).

CloudWatch `model_request_usage` records contain the requested model, returned model/upstream
provider when supplied (otherwise null), token counts, outcome, and cost provenance. Pi preserves
its returned-model field in the session as well. Prices from Pi's catalog are labeled `estimated`;
unavailable costs are `null` / `unknown`, not zero. These are not invoices. Existing task/turn
usage records retain the configured provider/model and expose estimated/unknown OpenRouter cost.
Raw provider errors are replaced with a safe credentials/availability/rate-limit diagnostic before
reaching the transcript. Prompt and tool-result contents are not included in the usage log.

## Live smoke test (not yet performed)

Local tests exercise the real Pi transport and session loop against scripted SSE responses.
They do not establish connectivity, billing, or live upstream compatibility.

1. Choose a test environment, a secret reference, supported model IDs for all three roles, and
   a spending limit. Set a key credit limit in OpenRouter before running the test.
2. Deploy this release with all three providers set to `openrouter`. Confirm the three application stacks
   reference the same secret and that the key is absent from templates and boot user data.
3. Approve two supported OpenRouter coding models in a disposable project. In Slack, request a
   small file change and its test. Check the tool result and repository diff.
4. Request an action requiring the gate classifier. Confirm its `model_request_usage` record
   names OpenRouter. Inspect both Slack and worker logs for the requested model and token usage;
   verify there were no Bedrock inference requests for these tasks.
5. Reply with a follow-up referring to the first change. Stop/resume the worker and repeat to
   test persisted conversation continuity. Use `@agentx models`, select the second approved
   model, and check the next coding turn uses it.
6. Cancel a running task. Verify it stops and completed side effects are not repeated on the
   next turn. With a disposable invalid key, verify failures contain no credential or prompt
   text; restore the test secret and restart Slack/worker sessions afterward.
7. Compare OpenRouter's usage dashboard with the estimated/unknown telemetry, record actual
   spend and model/upstream IDs, then close the test workspace and remove test credentials.

## Teardown

Stack deletion does not remove the key init stored. Delete `agentx/<env>/openrouter` with
`aws secretsmanager delete-secret --secret-id agentx/<env>/openrouter --force-delete-without-recovery`,
so a new install can reuse the name, and revoke the key in OpenRouter. A secret you made yourself for
`--openrouter-secret-arn` is yours to keep or delete. See "Tearing down an environment" in
[architecture-production.md](architecture-production.md).

Record environment/release, model pairs, routing allowlist, outcomes, log references, and spend
without copying keys or private prompt contents. Live verification remains pending until this
checklist is executed with an authorized test environment and budget.

### Proposed first run

The user authorized up to **$5 in inference spend** and requested open weights. The proposed
model is `qwen/qwen3-coder` for worker, orchestrator, and classifier, with reasoning off and the
`deepinfra/turbo` endpoint allowlisted. The pinned Pi catalog and OpenRouter's public model and
endpoint APIs list this model with tool support. A populated Secrets Manager secret and the target AWS environment are needed for live OpenRouter verification. Deployment can proceed with missing-secret fallback until that secret is ready. No paid model
request or deployment was made during implementation.

## Default model when the secret is missing

An omitted ARN, a Secrets Manager `ResourceNotFoundException`, or an empty secret value selects
the default Bedrock model before opening the session. The worker uses its deployment's Bedrock
default when one is configured. Otherwise the role defaults match init: Claude Sonnet 4.6
(`us.anthropic.claude-sonnet-4-6`) for the worker and orchestrator, and Nova Lite for the classifier. Logs emit `model_fallback`
with the requested and effective model; session and usage records use the effective model. The
project's selected OpenRouter model remains selected, so subsequent sessions can use it once the
secret is populated. Restart the Slack service to reload the long-lived classifier.

Malformed references/keys, access denied, throttling, and OpenRouter inference errors do not
activate fallback. Bedrock access is needed if the missing-secret fallback is used; a deployment
with a populated, usable OpenRouter secret continues to use OpenRouter without Bedrock inference.
