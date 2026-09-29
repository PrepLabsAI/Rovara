# Costs

AgentX is source-available and runs in your own AWS account. You pay AWS
for the infrastructure, and you pay your model provider (Amazon Bedrock, OpenRouter, or both) for
model use. Both bills come to you directly.

This page explains what `agentx init` estimates, what keeps cost down, and how to see what each
task actually cost.

## What you pay for

An AgentX environment has two kinds of cost.

- **Always-on infrastructure.** Two NAT gateways, the Slack service on Fargate, and small
  services: API Gateway, Lambda, DynamoDB, SQS, Secrets Manager, KMS and CloudWatch.
- **Usage.** EC2 worker instances while they run, their root volumes, the EBS volume each
  workspace keeps, and the models: the Slack orchestrator, the gate classifier and the coding
  worker.

## What `init` estimates

Before it creates anything, `agentx init` prints every stack, role, secret, app and setting it
will create, and an estimated monthly cost. The estimate is not a quote. The plan itself says
"your bill will differ".

### Prices

The estimate uses us-east-1 list prices, checked in September 2026, and 730 hours a month.

| Item | Price used |
| --- | --- |
| NAT gateway | $0.045 per hour, plus $0.045 per GB processed |
| Fargate arm64 | $0.03238 per vCPU-hour, $0.00356 per GB-hour |
| EC2 m6g.medium, on demand | $0.0385 per hour |
| EBS gp3 | $0.08 per GB-month |
| API Gateway, Lambda, DynamoDB, SQS, Secrets Manager, KMS and CloudWatch | about $10 a month in total, at the stated usage |

Model prices are per use:

| Model | Price used | Basis |
| --- | --- | --- |
| Orchestrator: Claude Sonnet 4.6 (`us.anthropic.claude-sonnet-4-6`) | about $0.025 a turn | the 2026-09-25 bake-off below |
| Orchestrator: GLM 4.7 (`zai.glm-4.7`) | about $0.007 a turn | the 2026-09-25 bake-off below |
| Classifier: Nova Lite (`amazon.nova-lite-v1:0`) | about $0.00015 a check | about 2,000 input and 100 output tokens a check, at $0.06 per 1M input and $0.24 per 1M output |
| Classifier: Claude Haiku 4.5 (`us.anthropic.claude-haiku-4-5-20251001-v1:0`) | about $0.0025 a check | assumed to match Anthropic's own list price ($1 per 1M input, $5 per 1M output); not a confirmed Bedrock rate, and the plan says so |
| Worker: Nova Pro (`amazon.nova-pro-v1:0`) | about $0.192 a session | about 200,000 input and 10,000 output tokens a session, at $0.8 per 1M input and $3.2 per 1M output |

A model with no price on file is not estimated. The plan shows "n/a" for it and names it after
the total. This covers every model reached through OpenRouter, and the default worker model,
Claude Sonnet 4.6 (`us.anthropic.claude-sonnet-4-6`). See
[OpenRouter model access](openrouter.md).

### Stated usage

The estimate assumes this usage each month:

- 1,000 orchestrator turns, each with one classifier check
- 100 worker sessions
- 60 worker instance-hours
- 10 kept workspaces

### The estimate at the defaults

With the default models (Sonnet 4.6 orchestrator, Nova Lite classifier, Sonnet 4.6 worker), the
plan's lines are:

| Line | Estimate | Basis |
| --- | --- | --- |
| Two NAT gateways | $65.70 | 2 x $0.045/hour |
| Slack service (Fargate, 0.5 vCPU, 1 GB, arm64) | $14.42 | one task, always on |
| Worker instances (m6g.medium) | $2.31 | 60 instance-hours at $0.0385/hour |
| Worker root volumes (30 GiB gp3) | $0.20 | 60 instance-hours at 30 GiB gp3; each root volume is deleted with its instance |
| Workspace volumes | $16.00 | 10 kept workspaces x 20 GiB gp3 at $0.08/GB-month |
| API Gateway, Lambda, DynamoDB, SQS, Secrets Manager, KMS and CloudWatch | $10.00 | about, at this usage |
| Orchestrator model | $25.00 | 1,000 turns at about $0.025 each |
| Classifier model | $0.15 | 1,000 checks at about $0.00015 each |
| Worker model | n/a | no price on file for `us.anthropic.claude-sonnet-4-6` |

These lines add up to $133.78 a month. That total leaves out the worker model and NAT data
processing. Your own plan prints the figures for the models you choose.

## Model choice

The orchestrator default comes from a bake-off on 2026-09-25: 65 evaluation cases, 3 runs each,
live on Bedrock. The spec records these results:

| Model | Cases passed | Refused correctly | Cost | Notes |
| --- | --- | --- | --- | --- |
| Claude Sonnet 4.6 | 58 of 65 (tied for most) | 7 of 7 | about $0.025 a turn | steady from run to run; the default |
| GLM 4.7 | 58 of 65 | 6 of 7 | about $0.007 a turn | offered as the lower-cost choice; `init` states the refusal result when it is chosen |
| Claude Haiku 4.5 | 55 of 65 | | | inconsistent at creating items |
| Nova Pro | | | | not offered: went ahead in 5 of 7 cases where a connector was not set up |
| MiniMax M2.5 | | | | not offered: slow, with timeouts |

The worker keeps its current default, and the classifier defaults to Nova Lite. The full decision
is in [the installer spec](../specs/015-installer/spec.md).

## What limits cost

- **Idle compute stops.** Each Slack thread gets its own EC2 worker and encrypted EBS volume. The
  idle reaper stops the compute and keeps the workspace files and conversation state. An
  administrator can also stop a workspace's idle compute with
  `agentx admin workspace stop --workspace <workspace-id>`. See the [CLI reference](cli.md).
- **Workspace limits.** Only threads with a prepared workspace count. The member whose request
  first prepares a thread's workspace is charged for it. Each member may hold at most 3 prepared
  thread workspaces, and the organization at most 20. Over either limit, AgentX prepares nothing
  and says which limit was reached. An administrator can change the limits with the
  `AgentXControlPlane` parameters `SlackMemberWorkspaceLimit` and
  `SlackOrganizationWorkspaceLimit`.
- **A monthly budget.** `init` asks for a monthly AWS budget in whole US dollars. The default is
  100, and 0 means no budget. It creates the budget `agentx-<env>-monthly`, which alerts at 80%
  spent and at 100% forecast. The budget counts either costs tagged `agentx:env` (the default) or
  the whole account. Set this with `--budget` and `--budget-scope`.

A tag-scoped budget reads $0 until someone with billing rights activates the `agentx:env` tag once
in Billing, Cost allocation tags. The tag appears there up to 24 hours after the first tagged
resource is billed. For an account used only by AgentX, `--budget-scope account` needs no tag.

## See what each task cost

Every remote coding task publishes a redacted `usage` operation event and a private `usage.json`
artifact. They hold these fields:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | always `1` |
| `outcome` | `SUCCEEDED`, `FAILED` or `CANCELLED` |
| `provider` | the provider the worker actually used |
| `modelId` | the model the worker actually used |
| `cacheRetention` | the prompt-cache retention mode, `short` or `long` |
| `tokens.input`, `tokens.output`, `tokens.cacheRead`, `tokens.cacheWrite`, `tokens.total` | token counts |
| `cacheReadRatio` | cache-read tokens divided by all input-side tokens (input, cache read and cache write); 0 when there are none |
| `costUsd` | Pi's estimated cost in US dollars, or `null` |
| `costSource` | OpenRouter only: `estimated` when a cost was reported, `unknown` when it was not |

`costUsd` is an estimate from the worker, not your bill. For OpenRouter, a reported cost of zero
becomes `null` with `costSource` set to `unknown`. Your AWS bill and your model provider's bill
are the real record.

### Prompt caching

The production runtime has a CloudFormation parameter, `PromptCacheRetention`, with the values
`short` and `long`. It defaults to `long`, so Bedrock cache entries can survive normal gaps
between Slack turns. `cacheReadRatio` in `usage.json` shows how much of each task's input came
from the cache.
