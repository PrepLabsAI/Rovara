# Your own Anthropic or OpenAI API key

AgentX can call Anthropic's API or OpenAI's API directly, using an API key you supply, instead of (or
alongside) Amazon Bedrock and OpenRouter. Any role can use it: the Slack orchestrator, the action-gate
classifier and the coding worker. Projects can also approve these models for Slack's `@agentx use`. The
key belongs to the installation: only an administrator sets it, through `agentx init`. It is never entered
in Slack. See [spec 054](../specs/054-direct-provider-keys/spec.md).

Use this when you already have an Anthropic or OpenAI organization (its rate limits, invoices, spending
caps or zero-data-retention terms), when a model is not offered on Bedrock in your account, or to run
OpenAI models without a router in between.

## Configure an installation

`agentx init` asks for the model provider first:

```text
1. Amazon Bedrock (recommended) (default)
2. OpenRouter
3. Anthropic API (your own API key)
4. OpenAI API (your own API key)
```

Choosing Anthropic or OpenAI sets all three roles to that provider and suggests a model for each (press
Enter to accept):

| Provider | Orchestrator | Classifier | Worker |
|---|---|---|---|
| `anthropic` | `claude-sonnet-4-6` | `claude-haiku-4-5` | `claude-sonnet-4-6` |
| `openai` | `gpt-5.4` | `gpt-5.4-mini` | `gpt-5.4` |

Init then asks for the **API key** in a hidden prompt. It refuses a key with the wrong prefix for the
provider (`sk-ant-` for Anthropic; `sk-` for OpenAI, but not an OpenRouter `sk-or-` or Anthropic key). It
also refuses a Claude Pro/Max subscription token (`sk-ant-oat…`): AgentX uses API keys only. Init stores the
raw key, not JSON, in the Secrets Manager secret `agentx/<env>/anthropic` or `agentx/<env>/openai`, with the
AWS-managed encryption key, just before it saves its answers. The saved answers hold only the secret's ARN.
The plan lists the secret, and prices each direct-provider role from the provider's list price.

Use a **dedicated key for each installation**: an Anthropic workspace key or an OpenAI project key, with a
hard spending limit set at the provider.

### Unattended and mixed setups

With `--yes`, give the key in a file or an environment variable, never as a flag's value:

```sh
--model-provider anthropic --anthropic-key-file ./anthropic-key.txt
--model-provider openai --openai-key-env OPENAI_KEY_FOR_AGENTX
```

The per-role flags win over `--model-provider`, so a mixed setup comes from flags. For example, keep
Bedrock for the orchestrator and classifier and run the worker on OpenAI:

```sh
--worker-provider openai --worker-model gpt-5.4 --openai-key-file ./openai-key.txt
```

Init asks for a provider's key whenever a role uses that provider. It also stores a key whose
`--anthropic-key-*` or `--openai-key-*` flag you give when no role uses the provider, so projects can
approve its models.

To use a secret you made yourself, store the raw key as its value and pass `--anthropic-secret-arn` or
`--openai-secret-arn`. Init then asks for no key and stores nothing. `init --export` stores no secret, so it
takes only the ARN flags. A deploy answers file uses:

```json
{
  "models": {
    "orchestrator": "claude-sonnet-4-6",
    "classifier": "claude-haiku-4-5",
    "worker": "gpt-5.4",
    "providers": { "orchestrator": "anthropic", "classifier": "anthropic", "worker": "openai" },
    "anthropic": { "secretArn": "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/anthropic-AbCdEf" },
    "openai": { "secretArn": "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/openai-AbCdEf" }
  }
}
```

### Checks

Init, `agentx config set models.<role>` and `agentx doctor` check each direct-provider model. The check
looks the model up in the provider's model list, then sends one request of at most 16 output tokens with
a tool attached, so it can cost a fraction of a cent. A failure says what to fix (the key, the model's
availability to your organization, credits and limits, or provider status) without repeating the key or the
provider's response. A role with a usable key makes no Bedrock call. `agentx doctor` also checks that a
secret init created exists and holds the right kind of key. It skips, and says so, a secret you made
yourself.

## Select a model from Slack

Add approved pairs to the project's `approvedModels`, as for any provider:

```json
[
  { "provider": "amazon-bedrock", "modelId": "us.anthropic.claude-sonnet-4-6", "label": "Bedrock Sonnet" },
  { "provider": "anthropic", "modelId": "claude-opus-5", "label": "Opus 5 (Anthropic)" },
  { "provider": "openai", "modelId": "gpt-5.4", "label": "GPT-5.4" }
]
```

`@agentx use Opus 5 (Anthropic)` switches the project's coding model, and the next turn calls Anthropic
directly. SWE-bench and SEC-bench runs take the same labels (`… model Opus 5 (Anthropic)`). A model must be
in the Pi catalog that AgentX pins; a newer model (for example `claude-opus-5-5` on Pi 0.85.1) needs an
AgentX release with a newer Pi. An unknown model is refused when it is first used, with "not in the
installed Pi catalog".

## How the key is handled

- CloudFormation's `AnthropicSecretArn` and `OpenAISecretArn` parameters go to the control-plane, runtime
  (worker settings) and Slack stacks, and the eval stack when it is deployed. They default to empty, so
  existing installs are unchanged. `agentx deploy` sends the same ARN to every stack. `agentx env adopt`
  refuses stacks that disagree.
- The control plane grants `secretsmanager:GetSecretValue` on exactly that ARN to the Slack task role and the
  worker instance role (`AnthropicSecretRead`, `OpenAISecretRead`), only when the ARN is set. The eval stack
  grants the same to its instance role. The protected foundation template is unchanged.
- Worker settings in SSM (`worker-anthropic-secret-arn`, `worker-openai-secret-arn`), EC2 user data and the
  container environment carry the ARN, never the key.
- Each worker session and orchestrator turn reads the key into an in-memory credential store; the
  classifier reads it when the Slack service starts. AgentX never sets `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN` or `OPENAI_API_KEY`, and a configured key wins over those variables if they are
  present. Restart the Slack service after rotating a key; workers pick it up at their next session.
- Provider errors are replaced with a diagnostic chosen from the HTTP status (key, model access, rate limit
  or credits, overloaded, unavailable) before they reach the transcript or logs.

**Workspace exposure.** As with OpenRouter, code running in a worker's workspace (shell commands,
dependency install scripts) can reach IMDS, obtain the worker role's credentials and read the key. The
in-memory store keeps the key out of files and the environment; it does not isolate it from code the agent
runs. Use only trusted projects, a dedicated key with a spending limit, and rotate the key if you suspect
exposure. See [OpenRouter model access](openrouter.md#workspace-credential-exposure).

## Missing key

The rule is the same as OpenRouter's. When the ARN is empty, the secret does not exist, or its value is
empty, the role runs on its default Bedrock model. The worker uses the deployment's Bedrock worker model if
it has one, or Claude Sonnet 4.6. The classifier uses Nova Lite. The logs record `model_fallback` with the
reason `anthropic_secret_missing` or `openai_secret_missing`. Access denied, a malformed key, rate limits and
inference errors fail the request instead. An installation without Bedrock model access sees the Bedrock
error, not a silent change of provider.

## Usage and cost

`model_request_usage` records name the provider, the requested model and the model the API reports serving
it (for example `claude-sonnet-4-6-20260217`). Task and turn usage carry a cost computed from the Pi
catalog's list price, labeled `costSource: "list-price"`. An unknown price is `null` and `unknown`, never 0.
These figures are not invoices: discounts, batch pricing and your organization's terms are not reflected.
Compare them with the provider's usage dashboard.

## Data handling

Requests go straight from AWS to `api.anthropic.com` or `api.openai.com`. OpenAI requests are sent with
`store: false`. Each provider's own data-retention policy applies to your organization. Zero data retention
is an arrangement with the provider, not something AgentX can turn on. Prompt caching follows the
deployment's `PromptCacheRetention` setting.

## Rotate, add or remove a key

- **Rotate:** rerun `agentx init --resume --anthropic-key-file <new key>` (or `--openai-…`). It replaces the
  value in the secret init created, then restart the Slack service. For a secret you made yourself, put the
  new value there.
- **Add a provider later:** add the provider's ARN to the deploy answers or stacks, then deploy. Approve its
  models in a project.
- **Teardown:** stack deletion does not remove keys init stored. Delete `agentx/<env>/anthropic` and
  `agentx/<env>/openai` with `aws secretsmanager delete-secret --secret-id <name> --force-delete-without-recovery`,
  and revoke the keys at the provider.

## Live verification (not yet performed)

Scripted Anthropic Messages and OpenAI Responses streams cover the transport, tool calls, resumption,
cancellation and error handling in automated tests. These do not establish live compatibility. With a test
environment, keys with spending limits and a budget:

1. Deploy with the orchestrator on `anthropic` and the worker on `openai`. Confirm the templates and boot
   user data hold only ARNs.
2. In Slack, request a small file change and its test. Reply with a follow-up after stopping and resuming
   the worker. Check the logs show no Bedrock inference for these turns.
3. Trigger the action gate and confirm the classifier's usage record names Anthropic.
4. Cancel a running task; then, with a disposable invalid key, confirm the failure names the key without
   quoting it.
5. Run one SWE-bench Verified task on `anthropic/claude-opus-5` from `#swe-bench-evals`.
6. Compare the usage records with each provider's dashboard and record the spend.
