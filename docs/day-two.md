# Running AgentX

This guide covers an installed environment: checking it, upgrading it, changing its settings, and
adding projects, channels and connectors. [docs/install.md](install.md) covers the install.

## The operator role

Day-2 commands run with the operator role the install created, `agentx-<env>-operator`. It can do
everything on this page except the few places marked "admin credentials". Its ARN is the access
stack's `OperatorRoleArn` output:

```sh
aws cloudformation describe-stacks --stack-name agentx-<env>-access --region <region> \
  --query "Stacks[0].Outputs[?OutputKey=='OperatorRoleArn'].OutputValue" --output text
```

Add an AWS CLI profile that assumes it, then pass `--profile` or set `AWS_PROFILE`:

```ini
[profile agentx-<env>-operator]
role_arn = <the OperatorRoleArn>
source_profile = <your own profile>
region = <region>
```

Only the principal named at install (`--operator-principal`) may assume it. Without one, any
principal in the account that IAM allows may. Every command below takes `--region <region>`; it
defaults to your AWS configuration.

## Check it

```sh
agentx --env <env> doctor --region <region>
```

`doctor` checks every piece and prints, for each problem, what is wrong and how to fix it. The
checks, in order:

- **stacks**: every stack exists and is healthy, runs the release the settings name (by code
  package hashes and image digests), was deployed by the engine the settings name, and its last
  drift result.
- **secrets**: every secret exists and has the right shape. Values are read only to check their
  shape, and never printed. An OpenRouter key in a secret you made yourself is shown as "skip":
  doctor's role cannot read it, so check it yourself.
- **slack**: the bot token works, both Request URLs answer a signed request (the same check
  `init` makes), and the bot is in the channel `init` bound.
- **github**: the GitHub App's installation and its repository access.
- **connectors**: for each connector in this environment's project files, the credential exists
  and, for Linear and Jira, still works. Saved warnings (such as a Jira account that can see
  other projects) show here.
- **models**: each model answers a one-token call.
- **alerts**: the alert subscription is confirmed, and the budget matches its setting.
- **capacity**: the region's EC2 vCPU quota, and free EC2-VPC Elastic IPs. Fewer than two free is
  a warning: this environment keeps working, but another one in this region would not fit.
- **sign-in**: every check of `agentx signin check`.

`--json` prints the whole report as one JSON document on stdout. The exit code is 0 when no check
failed (warnings and skips are fine), and 2 when any check failed or doctor could not start.

**Drift.** `doctor` shows each stack's last drift result. It never starts drift detection:
detection reads every resource with the caller's own rights, which the operator role does not
have. To check drift, run the command doctor prints, with admin credentials:

```sh
aws cloudformation detect-stack-drift --stack-name agentx-<env>-<part> --region <region>
```

**Bound channels.** No route lists channel bindings yet (spec 025 phase 25d adds it), so doctor
checks only the channel `init` bound. Channels bound later are not listed.

## Upgrade

```sh
agentx --env <env> upgrade --region <region> [--to <version>]
```

Without `--to`, it upgrades to the release of the `agentx` you run. So
`npx @charterarc/agentx@<version> --env <env> upgrade --region <region>` is the usual form.
`--release <dir>` uses a release directory instead of downloading one.

It prints the release notes, then deploys each stack in turn. For each stack it shows the change
set (or, for a cdk environment, `cdk diff`), lists IAM changes on their own, and asks before
deploying. It stops before any change that replaces or deletes a table, user pool, bucket, KMS
key, secret, queue or log group, because that loses its data. To accept one, type its logical
id when asked, or name it in advance:

```sh
agentx --env <env> upgrade --region <region> --allow-replace <LogicalId>
```

Repeat `--allow-replace` for each. `--yes` deploys without asking, but still prints every change
and still stops on a data replacement you did not name. Without a terminal, `--yes` is required.

**The order** is access, foundation, identity (skipped with your own OIDC provider), runtime,
control-plane, slack. The runtime goes before the control plane so the worker, which reads
strictly, is the tolerant side while the two differ.

**Stopping and re-running.** `upgrade` stops at the first failure; CloudFormation rolls that stack
back. Stacks before it stay on the new release. Run the same command again: it continues. When
every stack is done, it records the new version in the settings and runs `doctor`.

**Locking.** `upgrade` holds the environment's lock while it runs, so no other `agentx` command
changes the environment at the same time. A run that was cut off leaves its lock. At a terminal,
the same caller's next `upgrade` asks at once whether to take that lock over; say yes only if the
earlier run is no longer going. A lock someone else holds is refused until it is 2 hours old
(stale); then, at a terminal, `upgrade` asks too. `--yes` never answers this question, so without
a terminal no lock is taken over, not your own and not a stale one someone else holds.

**What it keeps.** Your settings survive: the budget, the limits, `slack.appPostedMessages`,
`alerts.slowTurnMinutes`, the models, the GitHub App, the admin claim and the operator principal
are all read from the environment, and nothing is asked again. If a release drops a `config` key,
`upgrade` names it before deploying, and says nothing replaces it.

**Never back.** `upgrade` refuses a release older than the one the environment runs, naming both,
because a newer release may have written data an older one cannot read. The same release is fine
(a re-run). It also refuses every prerelease (such as `1.4.0-rc.1`).

**The operator role and the access stack.** The operator role cannot change the access stack.
Under it, `upgrade` compares the deployed access template with the release's. If they are the
same, it upgrades every other stack. If they differ, it stops before deploying anything; then
either run it with admin credentials (which deploy access first), or give your platform team an
export (below) and run `upgrade` again once they deployed it.

**The cdk engine.** A cdk environment upgrades with admin credentials and a clean checkout of the
target release's tag (the operator role cannot use CDK's bootstrap resources):

```sh
agentx --env <env> upgrade --region <region> --to <version> --source <checkout of v<version>>
```

**For a pipeline: `upgrade --export`.** This writes the upgrade as files and changes nothing:

```sh
agentx --env <env> upgrade --region <region> --to <version> --export <dir>
```

The bundle holds each stack's template and parameters, the changed code packages, `SHA256SUMS`,
and a `README.md` with every command: check the checksums, upload the packages, and then, stack by
stack, create a change set, read it, execute it and wait. The platform team runs every command
from the bundle's directory. A changed access stack is included, to deploy with their own
credentials. No file holds a secret: kept values are marked `UsePreviousValue`. When they are
done, run `agentx --env <env> upgrade --to <version>` once more: it finds nothing left, records
the version and runs `doctor`. A cdk environment cannot export.

## Change settings

```sh
agentx --env <env> config list --region <region>
agentx --env <env> config get <key> --region <region>
agentx --env <env> config set <key> <value> --region <region>
```

`set` shows the change and asks first (`--yes` skips the question). Each key lives in exactly one
place:

| Key | Where it lives | Default | Notes |
|---|---|---|---|
| `models.orchestrator` | stack parameter ModelId on agentx-<env>-slack, and the settings | from init | tested with one call first |
| `models.classifier` | stack parameter GateClassifierModelId on agentx-<env>-slack, and the settings | from init | tested with one call first |
| `models.worker` | stack parameter ModelId on agentx-<env>-runtime, and the settings | from init | tested with one call first |
| `limits.workspacesPerMember` | control-plane setting WORKSPACE_LIMITS.perPerson (install-time default SlackMemberWorkspaceLimit) | 3 | changed with spec 025 phase 25e's admin tool |
| `limits.workspacesPerOrg` | control-plane setting WORKSPACE_LIMITS.perOrganization (install-time default SlackOrganizationWorkspaceLimit) | 20 | changed with spec 025 phase 25e's admin tool |
| `limits.threadTurnsPerMinute` | stack parameter SlackThreadTurnsPerMinute on agentx-<env>-control-plane | 6 | 1 to 60 |
| `slack.appPostedMessages` | stack parameter SlackAppPostedMessages on agentx-<env>-control-plane | accept | accept or ignore |
| `alerts.address` | SSM /agentx/<env>/settings (alertAddress) | none | a webhook comes from --value-file or --value-env |
| `alerts.slowTurnMinutes` | stack parameter SlowTurnMinutes on agentx-<env>-slack | 5 | 1 to 60 |
| `budget.monthlyUsd` | stack parameter BudgetMonthlyUsd on agentx-<env>-control-plane | 0 | 0 for none |
| `budget.scope` | stack parameter BudgetScope on agentx-<env>-control-plane | tag | tag or account |

- **Models.** A new model must answer a one-token call before anything changes. `set` then
  updates the stack, the settings and the install answers, so `upgrade` and `init --resume` keep
  it.
- **Workspace limits.** `list` and `get` show the install-time default and say the control plane
  may hold a newer setting. `set` refuses both keys until spec 025 phase 25e ships the admin tool
  that changes them.
- **`alerts.address`.** `list` and `get` show only whether it is set, and whether it is an email
  or a webhook, never the address. An email goes on the command line. A PagerDuty or Opsgenie
  address is a secret: pass it with `--value-file <path>` or `--value-env <NAME>`, or leave the
  value out to be asked in a hidden prompt.

**Changing `alerts.address` leaves the old subscription.** `set` subscribes the new address, but
the operator role cannot unsubscribe. For each old subscription it prints the command for an
admin to run:

```sh
aws sns unsubscribe --subscription-arn <the ARN it prints> --region <region>
```

A new email address gets alarms once its owner confirms the subscription. Then send a test alarm
with `agentx --env <env> alerts test`.

## Projects, channels and connectors

- `agentx --env <env> project add --repository <owner/name>`: registers another project on EC2
  workers, and writes its file to `~/.agentx/projects/<name>.yaml`.
- `agentx --env <env> channel add --project <name> --channel <channel>`: binds a Slack channel,
  invites the bot, and waits for a mention to get a threaded reply (`--no-check` skips the wait).
- `agentx --env <env> connector add linear|jira|asana --project <name>`: adds a connector, tests a
  read, and registers the project's next revision.
- `agentx --env <env> alerts test`: sends a test alarm to the alert address and asks whether it
  arrived.

The worker image has Python 3, pip, venv and uv. Debian bookworm's system Python is externally
managed, so a Python project's setup command should make a virtual environment
(`python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`) or use uv (`uv sync`).

## Developer sign-in

- `agentx --env <env> signin show`: which methods are on, and what the control plane offers.
- `agentx --env <env> signin enable slack|oidc`: turns a method on; shows the change and asks.
- `agentx --env <env> signin disable slack|oidc`: turns a method off; everyone signed in with it
  is signed out at once.
- `agentx --env <env> signin check`: checks every piece sign-in needs, and says what to fix.

Developers need no AWS credentials: they run `npx @charterarc/agentx login <control plane URL>`.
