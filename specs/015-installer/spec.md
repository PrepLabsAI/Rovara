# Feature Specification: Installer

> Scope amendment (2026-09-27, #99 / #119, user confirmed): every install, including self-hosted,
> uses `ec2-ebs` for new projects. The first-project step uses `Ec2WorkerLaunchTemplateId` and
> `Ec2WorkerSubnets`, plus volume size/type. Prerequisites check EC2 vCPU quota and that the region has the two Elastic IPs the NAT gateways need (quota L-0263D0A3, checked on a first run so init refuses before creating anything; found live, 2026-09-28); there is no
> separate retired-runtime charge or runtime/capacity-provider teardown. This supersedes the
> legacy assumptions in US1 scenario 3, FR-014, FR-015, FR-040, FR-050, FR-055 and Decisions below.
> Closed workspaces, operations and historical project revisions remain readable only.

**Feature Branch**: `feat/015-installer`
**Created**: 2026-09-25
**Status**: Draft
**Input**: Design discussion with the project owner on 2026-09-25, and the lessons from setting up
the first production deployment and the Linear, Jira and Asana connectors (specs 013 and 014).

## Context

AgentX is open source and self-hosted. Today only its authors can install it. The first production
deployment took many manual steps over several days:

1. **The AWS pieces are deployed by hand.** Six CDK stacks (`infra/bin/agentx.ts`) with fixed names
   (`AgentXControlPlane`, `AgentXProductionRuntime`, and so on) are deployed from a checkout. Their
   parameters (OIDC issuer, GitHub App ID and installation, image URIs, VPC, subnets, secret ARNs)
   are copied between stacks by hand. Only one deployment fits in an account.
2. **Sign-in is set up outside AgentX.** The control plane takes an OIDC issuer and audience as
   parameters. The Cognito user pool behind the current deployment was made by hand.
3. **Images are built into the deployer's own private ECR.** The worker and orchestrator stacks
   take private ECR image URIs, which only the release pipeline in the authors' account produces.
4. **The Slack and GitHub apps are made by hand**, from notes, with scopes and URLs typed in.
5. **Connector setup has traps** that cost hours on 2026-09-25:
   - Asana refused a guest until Manage Distribution was set to "Any workspace".
   - The default browser signed in as the app owner instead of the bot. This was fixed by
     `--no-browser --expect-account` (#60).
   - Jira needs an API token against the `/v2` API.
6. **IAM needs are unclear.** The first deployment ran with broad rights. A company's platform team
   cannot tell what AgentX needs, or deploy it through its own pipeline.
7. **There are no alerts.** Failures are found by reading logs.

This spec makes AgentX installable by any organization, in its own AWS account and with its own
credentials, through one guided command, and operable afterwards with a few day-2 commands.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Install AgentX With One Guided Command (Priority: P1)

An engineer with admin rights in an AWS account runs `npx @charterarc/agentx init`. A wizard checks
prerequisites, asks a few questions, deploys AgentX, walks the engineer through creating the GitHub
and Slack apps, creates their admin user, sets up a first project and channel, and ends with a
working reply in Slack. Nothing is copied between screens by hand.

**Why this priority**: Without it nobody outside the authors can run AgentX.

**Independent Test**: On a clean machine with a new AWS account, a new Slack workspace and a GitHub
organization, `agentx init` completes, and a message in the chosen channel gets an AgentX reply in
its thread, with no step outside the wizard except clicks in Slack, GitHub and AWS pages it opens.

**Acceptance Scenarios**:

1. **Given** AWS credentials with admin rights and a supported region, **When** the engineer runs
   `agentx init` and accepts the defaults, **Then** AgentX is deployed, the admin user can log in,
   and a test message in the chosen channel gets a reply.
2. **Given** `init` stopped halfway (closed terminal, lost network, failed step), **When** the
   engineer runs `agentx init` again, **Then** it continues from the first incomplete step, and
   steps already done change nothing.
3. **Given** a region without AgentCore or Bedrock, or a chosen model that the account cannot use,
   **When** `init` starts, **Then** it stops before deploying anything and says what to change.

### User Story 2 - Choose How AgentX Is Deployed (Priority: P1)

The engineer chooses the deploy engine. The default, **templates**, deploys published
CloudFormation templates and needs no CDK setup. **cdk** deploys from AgentX's CDK code, for teams
that use CDK and want to extend the stacks. Both deploy the same resources and store the same
settings, so every later command works the same either way.

**Why this priority**: The owner decided both must be offered (2026-09-25). Companies differ in
what their pipelines accept.

**Independent Test**: Install one environment with each engine. `doctor` passes on both, and a
resource-by-resource comparison of the two deployments shows the same resources and settings.

**Acceptance Scenarios**:

1. **Given** no `--engine` flag, **When** `init` asks, **Then** templates is the recommended default.
2. **Given** `--engine cdk` in an account without CDK bootstrap, **When** `init` runs, **Then** it
   explains bootstrap, offers to run it, and deploys once bootstrap exists.
3. **Given** an environment installed with one engine, **When** a later command would deploy it with
   the other, **Then** the command refuses and explains, and `doctor` reports the mismatch.

### User Story 3 - Hand the AWS Part to a Platform Team (Priority: P1)

A company does not let developers deploy to AWS directly. The engineer runs
`agentx init --export <dir>`, which writes everything the platform team needs: templates, a
parameters file, the release's code packages, the IAM policies for each role, and a README. The
platform team deploys it through its own pipeline. The engineer then runs `agentx init --resume`
to finish the human steps using only the narrow AgentX operator role.

**Why this priority**: The owner asked for the path enterprises would allow (2026-09-25).

**Independent Test**: Export a bundle, deploy it with plain `aws cloudformation deploy` using only
the files in the bundle, then run `init --resume` under the operator role alone. A Slack message
gets a reply.

**Acceptance Scenarios**:

1. **Given** `--export`, **When** it finishes, **Then** nothing has been created in AWS, and the
   bundle's README lists every stack, parameter, role and policy, in deploy order.
2. **Given** a deployed bundle, **When** `init --resume` runs with the operator role, **Then** it
   finds the environment from SSM and completes the Slack, GitHub, admin, project, connector and
   alert steps without admin rights.

### User Story 4 - Operate AgentX After Install (Priority: P1)

An operator upgrades to a new release, changes settings (models, limits), adds projects, channels
and connectors, and checks health, all with the CLI and the narrow operator role.

**Why this priority**: An install that cannot be upgraded or checked is not usable for long.

**Independent Test**: Upgrade an environment from the previous release to the current one with
each engine. Change the orchestrator model with `config set`. Add a project, channel and connector.
Break one thing on purpose (for example, revoke the Slack token). `doctor` names it and the fix.

**Acceptance Scenarios**:

1. **Given** a newer release, **When** the operator runs `agentx upgrade`, **Then** it shows what
   will change, including IAM changes and any replacement, and applies it only after confirmation.
2. **Given** an upgrade that would replace a table, user pool or secret, **When** it is shown,
   **Then** the upgrade stops unless the operator confirms that replacement by name.
3. **Given** `config set models.orchestrator <id>` with a model the account cannot use, **When** it
   runs, **Then** nothing changes and the command says why.
4. **Given** a broken check, **When** `agentx doctor` runs, **Then** it prints what is wrong and how
   to fix it, and exits non-zero.

### User Story 5 - Get Alerted Where the Team Already Looks (Priority: P2)

The operator gives a PagerDuty or Opsgenie integration address, or an email. AgentX sends alarms
there for failed turns, slow turns, failed Slack deliveries, checker failures, Bedrock throttling
and the budget.

**Why this priority**: Today failures are found only by reading logs.

**Independent Test**: `agentx alerts test` delivers a test alarm to the configured address.

**Acceptance Scenarios**:

1. **Given** an alert address at install, **When** `init` finishes, **Then** a test alarm has been
   sent and the engineer was asked to confirm it arrived.

### Edge Cases

- **A second environment in the same account** (`--env staging`). Its stacks, settings, secrets and
  roles never collide with the first.
- **The existing production deployment**, which predates environments and uses fixed stack names.
  It is adopted as an environment without redeploying (FR-006).
- **Slack workspaces that need admin approval for new apps.** `init` explains, stops at that step,
  and `init --resume` continues after approval.
- **A machine with no browser** (SSH, CI). Every browser step has a `--no-browser` form that prints
  a link and waits for a pasted code or a callback.
- **The wrong account signs in** to GitHub, Slack or a connector. The installer checks the account
  and refuses to save it.
- **A secret typed with stray whitespace or of the wrong shape** (for example, a user token where a
  bot token is expected). It is rejected before it is saved.
- **A long deploy that outlives the admin's AWS session.** `init` notices expired credentials,
  says how to refresh them, and resumes.
- **Two operators running a command on the same environment at once.** The second waits or refuses,
  using a lock in SSM.
- **A release that removes a `config` key** an environment has set. `upgrade` lists it and says
  what replaces it.

## Requirements *(mandatory)*

### Functional Requirements

**Environments and settings**

- **FR-001**: Every command MUST take `--env <name>` (default `production`). Names are lowercase
  letters, digits and hyphens, at most 20 characters.
- **FR-002**: Stacks, roles, secrets, parameters and alarms MUST be named with the environment:
  stacks `agentx-<env>-<part>`, secrets under `agentx/<env>/`, settings under `/agentx/<env>/`.
- **FR-003** (amended 2026-09-27; see Decisions): Each environment's settings MUST be stored in SSM
  Parameter Store under `/agentx/<env>/`: engine, version, region, models, stack names, alert
  address and identity mode. SSM is the source of truth. Install progress is stored separately,
  under `/agentx/<env>/install/`, because settings are written only once the Slack stack exists.
- **FR-004**: `~/.agentx/deployment.yaml` MUST become a per-environment cache the CLI rebuilds from
  SSM. `agentx env use <name>` MUST set up a new machine from SSM alone. `agentx env list` MUST list
  the environments in the account and region.
- **FR-005**: Commands that change an environment MUST take a lock in SSM, and refuse with the
  holder's name and start time if another command holds it. A lock older than 2 hours MAY be taken
  over after confirmation.
- **FR-006**: `agentx env adopt --env <name>` MUST register an existing deployment with fixed stack
  names by writing its settings to SSM, without changing any stack. Later upgrades keep its stack
  names.

**Deploy engines (US2)**

- **FR-007**: `init` MUST ask for the engine, or take `--engine templates|cdk`. The default is
  `templates`. The chosen engine MUST be stored in SSM and used by every later deploy.
- **FR-008**: Each release MUST publish:
  - CloudFormation templates generated from the CDK code with a synthesizer that needs no CDK
    bootstrap, whose code-package locations are template parameters;
  - the code packages (Lambda bundles) as release files with SHA-256 checksums;
  - the worker and orchestrator images on a public registry, referenced by digest;
  - the CLI as an npm package.
- **FR-009**: The templates engine MUST create an AgentX artifact bucket in the account, upload the
  release's code packages into it after checking their checksums, and deploy the templates with
  CloudFormation change sets.
- **FR-010**: The worker and orchestrator images MUST be made available from a private ECR
  repository in the account, pinned to the release's digests, because the runtime pulls from private
  ECR (see Decisions).
- **FR-011**: The cdk engine MUST deploy the same release's CDK code (the published source, at the
  release tag) with the same parameters. It MUST check for CDK bootstrap and offer to run it.
- **FR-012**: A release check MUST prove the published templates equal what the CDK code
  synthesizes for that release, so the two engines cannot drift apart.
- **FR-013**: A command that would deploy an environment with a different engine than the one
  stored MUST refuse. Switching engines is out of scope.
- **FR-014**: The installer MUST deploy EC2 workers (`ec2-ebs`); the retired runtime modes and
  the maintainers' `AgentXReleasePipeline` stack are not installed.

**`agentx init` (US1)**

- **FR-015**: `init` MUST check before creating anything:
  - AWS credentials and account;
  - that the region's EC2 quotas allow a worker (vCPUs `L-1216C47A`) and the environment's two NAT
    gateways (two free EC2-VPC Elastic IPs, `L-0263D0A3`), and that Bedrock is available;
  - that the chosen orchestrator, worker and checker models answer a one-token test call;
  - the required CLIs for the chosen engine (none for templates; Node and CDK for cdk).

  It MUST recommend a dedicated AWS account.
- **FR-016**: `init` MUST ask for, or take as flags:
  - the environment name and region;
  - identity: create Cognito (default) or bring an OIDC issuer and audience;
  - the orchestrator model, the worker model and the checker model (defaults in Decisions);
  - an optional permission boundary ARN;
  - the alert address (PagerDuty or Opsgenie integration address, or an email).
- **FR-017**: Before deploying, `init` MUST show everything it will create, the estimated monthly
  cost for the chosen models at a stated usage, and ask for confirmation.
- **FR-018** (amended 2026-09-27 and 2026-09-28; see Decisions): `init` MUST run these steps in
  order, recording each step's completion in SSM:
  1. prerequisites;
  2. access: the AgentX operator role, the CloudFormation service role and the access stack,
     deployed with the caller's own AWS credentials;
  3. the foundation and identity stacks (identity skipped when bringing your own OIDC);
  4. the GitHub App (US1, FR-027 to FR-030);
  5. the control plane and runtime stacks, with stack outputs passed between them automatically;
  6. the Slack app and the Slack service stack (FR-031 to FR-035);
  7. the admin user and login;
  8. the first project (FR-040);
  9. connectors (optional, FR-036 to FR-039);
  10. alerts and the budget (FR-045 to FR-047);
  11. an end-to-end check: a person mentions the bot in the chosen channel, and init waits for a
      threaded reply.
- **FR-019** (step count updated 2026-09-27 for FR-018's amended order): Re-running `init` MUST
  resume at the first incomplete step. Re-running a completed step MUST change nothing.
  `init --resume` MUST work under the operator role for steps 4 to 11.
- **FR-020**: Every prompt MUST have a flag, so `init` can run without prompts (`--yes` plus flags).
  Secrets MUST be read from hidden prompts, or from an environment variable or file named by a flag,
  never from a flag's value.
- **FR-021**: A new identity stack MUST create a Cognito user pool, an app client for the CLI's PKCE
  login (loopback callback http://127.0.0.1:8765/callback) and an `agentx-admin` group, and output
  the issuer and audience the control plane takes. With bring-your-own OIDC, `init` MUST check that
  the issuer's discovery document is reachable and that the admin's token carries the configured
  admin group claim.

**AWS access (US3)**

- **FR-022**: `init` needs admin rights once. At its start it MUST list the IAM roles and policies
  it will create.
- **FR-023**: `init` MUST create an **AgentX operator** role. It lets the CLI's day-2 commands run:
  it can read and change only resources named for AgentX (`agentx-<env>-*`, `/agentx/<env>/*`,
  `agentx/<env>/*`), create CloudFormation change sets for AgentX stacks, and pass only the
  CloudFormation service role. The operator role MUST be assumable by principals the installer names
  (default: the installing principal's account, restricted by an optional condition).
- **FR-024**: Stacks MUST be deployed through a **CloudFormation service role** created by `init`,
  so operators need no rights to the underlying services.
- **FR-025**: Every role AgentX creates MUST carry a permission boundary: the one given, else the
  access stack's default boundary (see Decisions).
- **FR-026**: `init --export <dir>` MUST write, without calling any AWS write API:
  - the templates;
  - a parameters file per stack, filled from the answers;
  - the code packages with checksums;
  - the operator role, service role and deployer policies as JSON;
  - a README with the deploy order and the exact commands.

  After the platform team deploys, `init --resume` MUST continue from the first human step.
  `upgrade --export <dir>` MUST write the change for a pipeline in the same way.

**GitHub App**

- **FR-027** (amended 2026-09-27; see Decisions): The CLI MUST create the GitHub App with GitHub's
  manifest flow: it opens a page with a pre-filled manifest (contents, pull requests and issues:
  read and write; metadata: read), for a personal account or an organization. The app MUST have no
  webhook and subscribe to no events: AgentX handles no GitHub webhook.
- **FR-028**: The app ID and private key MUST go from GitHub to a one-time local listener and
  straight into Secrets Manager under `agentx/<env>/github-app`. They MUST never be written to disk
  or printed.
- **FR-029**: The CLI MUST then open the app's installation page, wait for the installation, and
  confirm that the app sees at least one repository.
- **FR-030**: With `--no-browser`, the CLI MUST print the links, and accept the manifest code pasted
  back.

**Slack app**

- **FR-031**: The CLI MUST generate a Slack app manifest with AgentX's bot scopes (including
  `users:read`), the events URL, the interactivity URL for this environment, and a bot name the
  engineer picks. It MUST open Slack's "create from manifest" page with it.
- **FR-032**: The bot token and signing secret MUST be read from hidden prompts, checked (the token
  with `auth.test`, which must return a bot user), and stored straight into Secrets Manager.
- **FR-033** (amended 2026-09-27; see Decisions): After deploying the Slack service stack, the CLI
  MUST send both the events URL and the interactivity URL a signed self-probe (a `url_verification`
  challenge to the events URL, which must be echoed back, and a request to the interactivity URL,
  which must answer with a 2xx status), then ask the engineer to confirm the app's Event
  Subscriptions page shows the Request URL as Verified. It MUST store the bot's user ID and app ID.
- **FR-034**: The CLI MUST NOT weaken the ingress's protection against answering itself or other
  bots. Accepting app-posted messages from people stays a setting (`slack.appPostedMessages`, the
  `SlackAppPostedMessages` parameter, spec 014 FR-012), shown during `init`.
- **FR-035**: When the workspace requires admin approval for apps, the CLI MUST say so, record the
  step as waiting, and exit. `init --resume` continues.

**Connectors: `agentx connector add linear|jira|asana` (also offered inside `init`)**

- **FR-036**: Each connector's guide MUST carry the setup lessons of spec 013:
  - **Asana:** set Manage Distribution to "Any workspace"; use `http://localhost:8765` as the
    redirect.
  - **Jira:** use an API token and the `/v2` API.
  - **Linear:** use an API key.
- **FR-037**: Sign-ins for connectors MUST default to `--no-browser`, with the instruction to open
  the link in a private window signed in as the bot account, and `--expect-account <email>`. A
  sign-in by any other account MUST be refused and nothing saved.
- **FR-038**: Each connector MUST be tested with one real read (for example, listing the chosen
  project) before it is saved.
- **FR-039**: The CLI MUST ask which project, team or scope the AgentX project may use, and save it
  to the project's settings as a new revision.

**Projects and channels**

- **FR-040**: `agentx project add` (and `init`'s first-project step) MUST:
  - offer the repositories the GitHub App can see;
  - propose setup and test commands from the repository's files (`package.json`, `pyproject.toml`,
    `Makefile`, and similar) for the engineer to confirm or edit;
  - register the project and ask for a channel.
- **FR-041** (amended 2026-09-28; see Decisions): `agentx channel add` MUST bind a channel to a
  project, invite the bot (or wait for a person to invite it to a private channel), and ask the
  engineer to mention the bot, then wait for a threaded reply.

**`agentx upgrade` (US4)**

- **FR-042**: `upgrade [--to <version>]` MUST read the environment's version and engine from SSM,
  show the target release's notes, and show every change: added, changed and replaced resources, and
  IAM changes, called out separately. Templates use change sets; cdk uses `cdk diff`.
- **FR-043**: A change that replaces or deletes a table, user pool, bucket or secret MUST stop the
  upgrade unless the operator confirms it by typing the resource's name (or passes
  `--allow-replace <logical-id>`).
- **FR-044**: `upgrade` MUST deploy stacks in the upgrade order of the "Deploy order" decision
  (access, foundation, identity, runtime, control-plane, slack; identity skipped with your own
  OIDC), stop at the first failure (CloudFormation rolls that stack back), leave earlier stacks on
  the new version, be safe to re-run, and run `doctor` at the end.

**Alerts and cost (US5)**

- **FR-045**: `init` MUST create one alert topic per environment, subscribe the given address, and
  create alarms for:
  - turn errors;
  - turns slower than `alerts.slowTurnMinutes`;
  - failed Slack deliveries;
  - checker failures (the gate failing closed);
  - Bedrock throttling;
  - the budget.
- **FR-046**: `agentx alerts test` MUST publish a test alarm. `init` MUST run it once and ask the
  engineer to confirm it arrived.
- **FR-047**: `init` MUST offer an AWS budget for the environment's `agentx:env` tag, alerting the
  same topic. Every resource MUST carry the tag `agentx:env=<env>`.

**`agentx config` (US4)**

- **FR-048**: `config list|get|set` MUST work on a fixed, documented set of keys, including:
  - `models.orchestrator`, `models.classifier` and `models.worker`;
  - `limits.workspacesPerMember`, `limits.workspacesPerOrg` and `limits.threadTurnsPerMinute`;
  - `slack.appPostedMessages`;
  - `alerts.address` and `alerts.slowTurnMinutes` (default 5).

  Each key maps to one stack parameter, one SSM value or one control-plane setting, listed in the
  docs (for example, `limits.threadTurnsPerMinute` is `SlackThreadTurnsPerMinute`).
  `limits.workspacesPerMember` and `limits.workspacesPerOrg` map to the control plane's workspace
  limits setting in its state table (spec 025 FR-053 and decision D8), not to the stack parameters
  `SlackMemberWorkspaceLimit` and `SlackOrganizationWorkspaceLimit`, which stay as install-time
  defaults.

  Unknown keys and invalid values MUST be refused.
- **FR-049**: `config set` MUST show the change before applying it. Stack-parameter keys apply with a
  parameter-only stack update; SSM keys and control-plane settings apply at once. Model keys MUST pass the one-token test call
  first.

**`agentx doctor` (US4)**

- **FR-050**: `doctor` MUST check, each with a "what is wrong / how to fix it" line:
  - that stacks exist and are healthy, and that their version matches SSM;
  - engine mismatch and drift;
  - that secrets exist and have the right shape (without reading values out);
  - the Slack token; the Slack URLs, with the same signed self-probe `init` sends (the phase 15d1
    decision "Slack URL verification is a signed self-probe plus a manual 'Verified' check": no
    Slack API reports Verified); and bot membership of the channel `init` bound (no route lists
    bindings until spec 025 phase 25d adds admin reads; see the "bound-channel limit" decision);
  - the GitHub App installation and repository access;
  - each connector's test read;
  - model access;
  - the alert subscription and budget.
- **FR-051**: `doctor --json` MUST print machine-readable results. `doctor` MUST exit non-zero when
  any check fails.

**`agentx destroy` (US4)**

- **FR-055**: `agentx destroy --env <name>` MUST remove one named environment (never the legacy
  deployment):
  - It MUST ask the operator to type the environment's name to confirm (no flag skips this).
  - It MUST turn termination protection off, then delete the stacks in reverse install order
    (slack, runtime, control-plane, identity, foundation, access), stopping at the first failure.
  - It MUST terminate the environment's EC2 worker instances and delete their volumes (tagged
    `DeploymentMode=ec2-ebs`, `Environment=<env>` and `agentx:env=<env>`) after the control-plane
    stack and before the foundation stack.
  - It MUST then remove what the stacks retain: the Cognito user pool (turning its deletion
    protection off), the buckets (emptying every version and delete marker of a versioned bucket
    first), the tables, the log groups, the KMS key (scheduled for deletion, 7 days minimum), and
    every secret under `agentx/<env>/` (deleted without recovery, so the names can be reused).
  - It MUST warn, before confirming, that deleting the worker volumes deletes every worker
    session's workspace.
  - `--keep-data` MUST keep the tables, buckets, secrets, the Cognito user pool and the KMS key,
    and remove the rest.
  - It MUST delete the environment's settings and lock last, and be safe to re-run after a failure.

**Secrets and output**

- **FR-052**: No secret value (GitHub key, Slack tokens, connector keys, OIDC tokens) MAY appear in
  output, logs, local files, shell history or error messages. The CLI MUST NOT store AWS credentials.
- **FR-053**: The demo-setup role's explicit deny on connector secrets MUST remain.

**Documentation**

- **FR-054**: The docs MUST include:
  - an install guide for each path: templates, cdk, and enterprise export;
  - a day-2 guide;
  - a manual teardown guide: which stacks to delete, in what order, and which retained resources
    (tables, user pool, secrets, buckets, log groups) to remove afterwards, linking #66;
  - a "move to another account by reinstalling" guide, linking #67.

### Key Entities

- **Environment**: one AgentX installation in one account and region, named by `--env`. Its settings
  live in SSM under `/agentx/<env>/`.
- **Install progress**: the completed `init` steps and any step waiting on a person (for example,
  Slack admin approval), stored in SSM.
- **Release**: a version with its templates, code packages and checksums, image digests, CDK source
  tag and notes.
- **Export bundle**: the files `init --export` or `upgrade --export` writes for a platform team.
- **Operator role / service role**: the narrow role day-2 commands use, and the role CloudFormation
  deploys through.

## Success Criteria *(mandatory)*

- **SC-001**: A person who has never seen AgentX installs it from the docs on a clean machine and a
  new AWS account, with no help, and gets a Slack reply. Every place they get stuck is recorded and
  fixed before this spec is done.
- **SC-002**: A fresh install with the templates engine takes under 45 minutes of wall time, and
  asks the engineer to act at most 15 times (clicks and pastes).
- **SC-003**: Both engines produce the same resources and settings, over the release test.
- **SC-004**: An upgrade from the previous release passes `doctor` with each engine.
- **SC-005**: Day-2 commands all run under the operator role alone.
  (Note, phase 15e: "all" excludes `agentx destroy`, which needs admin credentials (question 7);
  an access-stack change during `agentx upgrade`, which only admin credentials or the platform
  team can deploy (question 9); and `agentx upgrade` of a cdk environment, since the operator role
  cannot use CDK's bootstrap resources (ruling F20). See Decisions.)
- **SC-006**: No secret value appears in any output, log or local file over the test suite.

## Decisions

- **Both engines, one source** (2026-09-25, owner). The templates are generated from the same CDK
  code at release time, and a release check (FR-012) keeps them equal. Templates are the default
  because they need no bootstrap and are what enterprise pipelines deploy. An environment keeps its
  engine; switching is out of scope.
- **The cdk engine passes parameters as `cdk deploy --parameters`** (2026-09-26, owner), including
  the `NoEcho` callback signing key, which the CDK CLI only accepts as an argument. The runner never
  logs or prints a secret value; its printed command replaces each one with `<redacted>`. The value
  is visible only in the operator's own machine's process list, for the length of that command; this
  is documented as the cdk engine's one difference from the templates engine in secret handling.
- **Settings live in SSM, not on a laptop**, so any operator machine and the enterprise path read the
  same state.
- **Admin once, then a narrow operator role**, with a CloudFormation service role, optional
  permission boundaries and SSO profiles. This is what a company's platform team can approve.
- **Images come to private ECR in the account.** The runtime and the orchestrator task pull from
  private ECR (their IAM statements are scoped to the account's repositories today). The release
  publishes images to ECR Public by digest, and the installer uses an ECR pull-through cache rule for
  ECR Public to serve them from private ECR. **Proven (2026-09-26, account 944937319445):** a
  throwaway AgentCore runtime reached `READY` from an image pulled through an ECR pull-through cache
  rule for `public.ecr.aws`; the cached repository was created on demand and the upstream manifests
  were imported on first pull. The role that does this needs `ecr:BatchImportUpstreamImage` and
  `ecr:CreateRepository` on the cache prefix (that IAM change belongs to phase 15c). Cached images
  carry no tags, so the installer must reference them by digest.
- **A separate access stack** (2026-09-26, owner) holds the service role, operator role, artifact
  bucket and pull-through rule, because the service role cannot deploy its own stack. For an
  enterprise, the access stack is the one template the platform team deploys and reviews; it
  creates every IAM role that operators and CloudFormation will use.
- **Environment roles live under IAM path `/agentx/<env>/`, not a name prefix** (2026-09-26,
  owner). CloudFormation truncates generated role names, which can drop a name prefix, and a name
  prefix would also match a differently-named sibling environment (`agentx-prod-*` also matches
  `prod-eu`). A path cannot collide, because `/` is not a legal character inside an environment
  name. The access stack's own two roles stay at the IAM root path, out of the service role's
  reach.
- **A default permission boundary always applies** (2026-09-26, owner, option B). When the
  company gives no boundary, the access stack creates `agentx-<env>-boundary` (path
  `/agentx/<env>/`, so its ARN is fixed and the other stacks name it without an import), and every
  environment role, the access stack's own included, carries it. It allows the services AgentX's
  roles use, role actions and `PassRole` only on AgentX's roles, and denies IAM users and groups,
  managed-policy management, Organizations and Account changes, and changes to itself. A
  company-supplied boundary replaces it and must allow AgentX's actions. Honest limits: the operator
  role can deploy CloudFormation through the service role, so it is powerful within the account;
  the boundary only stops it creating roles or policies beyond AgentX's own needs. Environments that
  share one account are not a security boundary against each other (resource policies and non-IAM
  access can still reach across), which is why FR-015 recommends a dedicated account per install.
- **Deploy order** (2026-09-26, owner).
  - **Fresh install:** access, foundation, identity, control-plane, runtime, slack. The runtime
    takes the control plane's URL as a parameter, so the control plane must exist first. The
    control plane needs the GitHub App's details, so `init` (phase 15d) creates the GitHub App
    before deploying the control plane.
  - **Upgrade:** access, foundation, identity, runtime, control-plane, slack. The runtime goes
    before the control plane, as in the release pipeline, because the worker parses strictly and
    must be the tolerant side of the window.
  - The identity stack is skipped when the environment brings its own OIDC.
- **Published templates are synthesized once for a reserved placeholder environment and rendered for
  the real environment at install, proven equal to a direct synthesis (FR-012).**
- **Per-region templates** (2026-09-26, owner). The release builder synthesizes the placeholder
  environment once for each region in `SUPPORTED_REGIONS`, exactly the regions with verified
  AgentCore availability-zone IDs in `infra/lib/production-foundation.ts` (today: `us-east-1`).
  Templates are written to `templates/<region>/<part>.template.json`; code packages are shared
  across regions, since asset hashes do not depend on region. Adding a region means adding its
  verified zone IDs; nothing else changes.
- **npm package name and license** (owners, 2026-09-26). The CLI publishes as `@charterarc/agentx`
  (organization `charterarc`; AgentX stays the product name). The repository's license is
  FSL-1.1-ALv2 (Functional Source License, Apache-2.0 future license); the `LICENSE` file is added in
  this phase.
- **Code packages are uploaded into the account**, not read from a public bucket, so the deployment
  does not depend on an outside bucket staying available.
- **Default models** (2026-09-26, owner, from the 2026-09-25 bake-off: 65 evaluation cases, 3 runs
  each, live on Bedrock):
  - The orchestrator defaults to **Claude Sonnet 4.6** (`us.anthropic.claude-sonnet-4-6`). It tied
    for the most cases passed (58 of 65), refused correctly in 7 of 7, and was steady from run to
    run. It costs about $0.025 a turn. Production switched to it on 2026-09-26.
  - `init` offers **GLM 4.7** (`zai.glm-4.7`) as the lower-cost choice: 58 of 65 passed, about
    $0.007 a turn, but it refused correctly in only 6 of 7. `init` states this when it is chosen.
  - Not offered: Nova Pro, which went ahead in 5 of 7 cases where a connector was not set up, and
    MiniMax M2.5, which was slow and had timeouts. Claude Haiku 4.5 (55 of 65) was inconsistent at
    creating items.
  - The worker keeps its current default. The checker defaults to Nova Lite, as today.
- **Identity**: Cognito by default, bring-your-own OIDC as the alternative (2026-09-25, owner).
- **The Slack and GitHub apps are created from manifests**, and secrets go straight from a hidden
  prompt or the vendor's redirect into Secrets Manager.
- **Alerts go to the company's tooling** (PagerDuty or Opsgenie integration address, or email)
  through one topic (2026-09-25, owner).
- **Account moves are documented, not built** (2026-09-25, owner). Tracked in #67.
- **`agentx destroy` is built in phase 15e** (2026-09-27, owner; was documented-only, #66). Removing
  an environment deletes data that cannot be recovered, so it needs a typed confirmation, a fixed
  delete order, emptied versioned buckets, and `--keep-data` (FR-055). Until then the manual
  teardown guide (FR-054) is the way. A named environment's AgentCore runtime has DeletionPolicy
  Delete; the capacity provider and data resources stay Retain.
- **The init step order follows the deploy order** (2026-09-27; phase 15d1 plan, the owner confirms
  in the PR). FR-018 listed the operator and service roles (step 3) after the core stacks (step 2),
  and the GitHub App (step 4) after the control plane; the spec's own deploy-order decision needs
  access first, and the GitHub App before the control plane. FR-018's list is amended to that order.
  Spec 025's `developer-signin` runs after step 6 (2026-09-28; phase 15d2 plan, the owner confirms).
- **The GitHub App has no webhook and subscribes to no events** (2026-09-27; phase 15d1 plan, the
  owner confirms in the PR). AgentX handles no GitHub webhook, and the control plane does not exist
  yet when the app is created. The manifest asks only for contents, pull requests and issues (read
  and write) and metadata (read). FR-027 is amended to say so.
- **Slack URL verification is a signed self-probe plus a manual "Verified" check** (2026-09-27; phase
  15d1 plan, the owner confirms in the PR). No Slack API reports verification without an app
  configuration token, and Slack never verifies the interactivity URL. `init` signs a request to
  both URLs itself, then the engineer confirms "Verified" on the Event Subscriptions page; 15d2's
  end-to-end reply is the real proof. FR-033 is amended to say so.
- **Two hidden-prompt pastes for Slack are kept** (2026-09-27; phase 15d1 plan, the owner confirms in
  the PR). This runs against User Story 1's "nothing is copied between screens by hand", but FR-032
  itself requires hidden prompts; the alternative, Slack's App Manifest API, needs an app
  configuration token pasted instead, and still needs an OAuth install for the bot token. The two
  pastes count toward SC-002's 15 actions; revisit only if SC-001 shows people stumble here.
- **Alert webhook addresses are secrets** (2026-09-27; phase 15d1 plan, the owner confirms in the
  PR). PagerDuty and Opsgenie integration addresses carry their integration key. They are stored in
  `agentx/<env>/alert-endpoint`, and FR-048's `alerts.address` shows only the host for a webhook.
- **`agentx init --export` refuses `production` only when it is already installed** (2026-09-27;
  phase 15d1 plan, the owner confirms in the PR). FR-026's outright refusal of `--env production`
  exists because of the authors' own adopted deployment, but it blocks every other organization's
  natural default name. The rule becomes: refuse only when SSM already holds settings for that
  environment, a read-only check FR-026 already allows. Changed in phase 15d2, with the export
  resume; the interactive `init` in phase 15d1 already follows this rule.
- **A waiting step exits 0** (2026-09-27; phase 15d1 plan, the owner confirms in the PR). A step
  waiting on a person (for example, Slack admin approval) exits 0, with `"status": "waiting"` in
  `--json`, because nothing failed.
- **Install progress lives beside settings, in its own SSM parameters** (2026-09-27; phase 15d1
  plan, the owner confirms in the PR). FR-003 listed install progress among the settings, but
  settings are written only once the Slack stack exists, and one SSM parameter holds at most 4 KB.
  Install progress instead lives in `/agentx/<env>/install/answers` and
  `/agentx/<env>/install/progress`, beside the settings. FR-003 is amended to say so.
- **The cost estimate's basis is a stated usage, checked against the bill in the live test**
  (2026-09-27; phase 15d1 plan, the owner confirms in the PR). The estimate uses list prices at
  1,000 turns, 100 worker sessions, 60 worker instance-hours and 10 kept workspaces a month; it does
  not include any AgentCore charge beyond the EC2 instance and EBS volumes, which the plan could not
  confirm. The live check confirms the AgentCore pricing line against the real bill.
- **`--yes` runs `cdk bootstrap` when the cdk engine needs it** (2026-09-27; phase 15d1 plan, the
  owner confirms in the PR). `--yes` means yes to every question, including this one, rather than
  needing a separate `--cdk-bootstrap` flag.
- **The finishing steps run after developer sign-in** (2026-09-28; phase 15d2 plan, owner decision).
  The order is FR-018's steps 1 to 6, then `developer-signin` (spec 025 FR-044), then steps 7 to 11.
  The new step ids are appended to `INIT_STEP_IDS`, so resume never re-runs a done step.
- **Cognito scoping for the operator role** (2026-09-28; phase 15d2 plan, owner decision; accepted).
  `cognito-idp:AdminCreateUser`, `AdminGetUser` and `AdminAddUserToGroup` on `userpool/*`, with
  `aws:ResourceTag/agentx:env` equal to the environment, proven with the IAM policy simulator in the
  live check; the fallback is the exact pool ARN. The operator role also gains subscribe and list on
  the environment's alert topic, `SetAlarmState` on the test alarm only, `budgets:ViewBudget` on the
  environment's budget, `servicequotas:GetServiceQuota` on the two EC2 quotas prerequisites check
  (vCPUs `L-1216C47A` and Elastic IPs `L-0263D0A3`), and `ec2:DescribeAddresses` in the
  environment's region only, which the Elastic IP check needs on a bundle resume.
- **The budget filters on the `agentx:env` tag by default** (2026-09-28; phase 15d2 plan, owner
  decision; accepted), with a warning that it reads $0 until the tag is activated and the exact
  Billing step to activate it (Billing, Cost allocation tags); `--budget-scope account` is for a
  dedicated account.
- **`agentx alerts test`** (2026-09-28; phase 15d2 plan, owner decision; accepted) flips a CloudWatch
  test alarm, so PagerDuty and Opsgenie get a real alarm. It checks that the subscription is
  confirmed and that the alarm's history shows `ALARM`, then asks the engineer. No SNS
  delivery-status logging.
- **The budget lives in CloudFormation** (2026-09-28; phase 15d2 plan, owner decision; accepted), in
  the control-plane stack, answered with the other questions; the service role gains `budgets`
  permissions.
- **Project files stay at `~/.agentx/projects/<name>.yaml`** (2026-09-28; phase 15d2 plan, owner
  decision; accepted), as `admin project register --file` takes them.
- **A Jira service account that can see other projects is warned about and saved, not refused**
  (2026-09-28; phase 15d2 plan, owner decision; changed). The warning names the other projects it
  can see (up to 5, then "and N more"), says AgentX will be able to read issues in them, and
  suggests narrowing the account. Under `--yes` it saves with the same warning printed. `init`
  records the warning in the install progress (`connectors[].warning`) so `agentx doctor` (15e) can
  show it. An account that finds no issue in the connected project is still refused.
- **Connector test reads** (2026-09-28; phase 15d2 plan, owner decision): Linear lists the key's
  teams; Jira searches inside the project (must find an issue) and outside it (warns, as above);
  Asana reads the project with `get_project` as the bot; then the registration preflight must
  report `connected`. For Asana, the sign-in itself stores and registers the credential before this
  read (FR-038); only the project revision waits for `get_project`.
- **FR-041's test message is posted by a person** (2026-09-28; phase 15d2 plan, owner decision;
  accepted). The engineer mentions the bot and the CLI watches turn records for the threaded reply.
  FR-018 step 11 and FR-041 are reworded to say so.
- **FR-050, for phase 15e**: add "each connector's saved warning (for example, a Jira account that
  can see other projects)" to `doctor`'s checks.
- **FR-045's budget alarm is the AWS budget's notifications to the same topic** (80% actual, 100%
  forecast) (2026-09-28; phase 15d2 plan).
- **FR-014 (`instances-ebs`) and FR-015 (AgentCore Runtime) are superseded by the scope amendment**
  (2026-09-28; phase 15d2 plan, note only). See the note at the top of Requirements; they should be
  reworded in phase 15e, and are left unchanged here. Reworded in phase 15e (2026-09-29).
- **`agentx destroy` confirms by typed name, and by account id where a slip costs most**
  (2026-09-29; phase 15e plan; owner decision; accepted; question 1). Every environment: type its
  name. `production`, or an environment with neither settings nor install answers (AgentX has no
  record of creating it), also: type the AWS account id shown. No flag skips either. The authors'
  adopted deployment is refused outright.
- **`agentx destroy` removes everything by default** (2026-09-29; phase 15e plan; owner decision;
  accepted; question 2), as FR-055 says. `--keep-data` keeps every table (turn records and
  developer sign-in included), bucket, secret, the Cognito user pool and the KMS keys, and removes
  the rest. `agentx admin turns export` exports turns first for anyone who wants them.
- **`agentx upgrade` never moves an environment back** (2026-09-29; phase 15e plan; owner
  decision; accepted; question 3). An older target is refused, naming both versions; the same
  release is allowed, so a re-run finishes a stopped upgrade. A real rollback is a fix released
  forward, or a restore from backups. (Separately from the answer, the plan also refuses every
  prerelease, since the settings record only x.y.z.)
- **The workspace limit keys wait for spec 025 phase 25e** (2026-09-29; phase 15e plan; owner
  decision; accepted; question 4). `config list` and `get` show `limits.workspacesPerMember` and
  `limits.workspacesPerOrg` with the install-time default and say the control plane may hold a
  newer setting; `config set` refuses them, naming 25e's admin change tool.
- **`doctor` reports drift, and never starts detection** (2026-09-29; phase 15e plan; owner
  decision; accepted; question 5). It shows each stack's last drift result from `DescribeStacks`
  and, when drift was never checked or a stack drifted, the admin command to check or see it.
  Detection reads every resource with the caller's rights, which the operator role does not have.
  A `doctor --detect-drift` that needs admin credentials is a small later addition if people ask.
- **The release test's scope** (2026-09-29; phase 15e plan; owner decision; accepted; question 6).
  The workflow installs with each engine up to `developer-signin` (`init --stop-after`), runs
  `doctor`, upgrades from the previous release, changes a setting under the operator role, runs the
  export path under the operator role, and destroys everything, in a throwaway account. (The plan
  runs one environment at a time, as a margin: an empty account's Elastic IPs fit two.) The Slack
  reply, `alerts test`, the manual-guide
  teardown and SC-001 are the manual release check in docs/releases.md.
- **`agentx destroy` needs admin credentials** (2026-09-29; phase 15e plan; owner decision;
  accepted; question 7). It refuses the operator role up front: it deletes the access stack, its
  IAM roles and the kept data, which the operator role cannot do by design. SC-005 excludes it.
- **Changing `alerts.address` leaves the old subscription** (2026-09-29; phase 15e plan; owner
  decision; accepted; question 8). `config set alerts.address` subscribes the new address and
  prints the exact `aws sns unsubscribe` command for each old subscription, for an admin. The
  operator role keeps no `sns:Unsubscribe`. A webhook is shown only by its host.
- **The access stack during `upgrade` under the operator role** (2026-09-29; phase 15e plan; owner
  decision; accepted, its cdk branch changed by ruling F20; question 9). Under the operator role, `upgrade` compares the deployed access
  template with the release's: unchanged, it upgrades every other stack; changed, it stops before
  deploying anything and names `agentx upgrade --export`, whose bundle includes the access stack.
  With admin credentials it deploys access first. The answer's cdk branch (under the operator
  role, print a notice and skip access) cannot work, because the operator role cannot use CDK's
  bootstrap resources, so ruling F20 changed it: a cdk environment upgrades with admin credentials
  only, and `upgrade` refuses the operator role up front. SC-005 excludes both cases.
- **`doctor`'s Asana check does not refresh** (2026-09-29; phase 15e plan; owner decision;
  accepted; question 10). It checks the Asana credential exists with a refresh token; a refresh
  would rotate the token the control plane's broker holds. Linear and Jira get a real read.
  Asking the control plane to test the credential comes later, with spec 025's admin reads.
- **The typed confirmation without a terminal** (2026-09-29; phase 15e plan; owner decision;
  accepted; question 11). When stdin is not a terminal, `destroy` reads each typed answer as a line
  from stdin, so a script must still send the exact name. There is no `--confirm` flag.
- **Operator settings survive upgrades** (2026-09-29; phase 15e plan). An upgrade whose answers do
  not set one of `OPERATOR_PARAMETERS` (the budget and its scope, `SlackAppPostedMessages`,
  `SlackThreadTurnsPerMinute`, the two workspace limits, `SlowTurnMinutes`) sends the deployed
  value. A parameter the target release no longer declares is not sent; `upgrade` names its config
  key and says nothing replaces it.
- **Upgrade review is per stack** (2026-09-29; phase 15e plan). A later stack's parameters depend
  on an earlier stack's new outputs, so each stack's change set (or `cdk diff`) is reviewed as it
  is ready. IAM changes are listed on their own, and a replaced or deleted table, user pool,
  bucket, key or secret stops the upgrade unless named (FR-043). Stopping leaves earlier stacks
  upgraded, as FR-044 allows.
- **`doctor`'s release and engine checks** (2026-09-29; phase 15e plan). A stack records no
  version, so `doctor` compares each stack's code package parameters and image digests with the
  release manifest of the version in the settings. The engine is read from the stack's
  parameters: only a cdk-deployed stack declares `BootstrapVersion`.
- **The bound-channel limit** (2026-09-29; phase 15e plan). No control-plane route lists channel
  bindings until spec 025 phase 25d adds admin reads, so `doctor` checks the bot's membership of
  the channel `init` bound, and says channels bound later are not listed yet (FR-050).

## Assumptions and Scope

- **Assumptions:**
  - The npm package name `@charterarc/agentx` and an ECR Public namespace are available to the
    project. If not, the owner picks the names before release, and the spec is updated.
  - Releases are cut from mainline by a tag, and a GitHub Actions workflow publishes them. The
    maintainers' own `AgentXReleasePipeline` keeps deploying the authors' environment.
  - GitHub's manifest flow and Slack's "create from manifest" remain available.
- **Out of scope:**
  - Moving an environment to another account (#67).
  - Switching an environment between engines.
  - The `demo-microvm` runtime mode.
  - Multiple Slack workspaces or GitHub App installations per environment.
  - The AgentX MCP server for Claude Code (spec 025).

## Testing

- **Unit tests (every PR)**:
  - the wizard's step order, resume from each step, and that re-running a completed step changes
    nothing (AWS, Slack and GitHub faked);
  - snapshots of the Slack and GitHub manifests;
  - validation and routing of every `config` key;
  - the safety checks: replacement refusal, engine mismatch, wrong-account sign-in, failed model
    check, lock contention;
  - that no secret value appears in output, logs, local files or errors;
  - each `doctor` check's failing case, fix message and exit code.
- **Build checks (every PR)**:
  - the templates generated for the release equal the CDK synthesis (FR-012);
  - the operator and service role policies stay within AgentX's names, and every role carries the
    given permission boundary or the default one;
  - an export bundle is complete and self-consistent.
- **Release tests (before each release, in a throwaway AWS account)**:
  - a full non-interactive install with each engine, using pre-made test Slack and GitHub apps passed
    by flags;
  - an upgrade from the previous release with each engine, then `doctor`;
  - the enterprise path: export, deploy with plain CloudFormation, `init --resume`;
  - a live Slack reply, and `alerts test`;
  - teardown by the manual guide, which also proves the guide, and by `agentx destroy`.
- **Manual check (once, before this spec is done)**: SC-001.
