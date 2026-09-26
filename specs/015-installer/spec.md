# Feature Specification: Installer

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

An engineer with admin rights in an AWS account runs `npx @agentx/cli init`. A wizard checks
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
- **FR-003**: Each environment's settings MUST be stored in SSM Parameter Store under
  `/agentx/<env>/`: engine, version, region, models, stack names, alert address, identity mode and
  install progress. SSM is the source of truth.
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
- **FR-014**: The installer MUST deploy the production runtime mode (`instances-ebs`). The
  `demo-microvm` mode and the maintainers' `AgentXReleasePipeline` stack are not installed.

**`agentx init` (US1)**

- **FR-015**: `init` MUST check before creating anything:
  - AWS credentials and account;
  - that the region supports AgentCore Runtime and Bedrock;
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
- **FR-018**: `init` MUST run these steps in order, recording each step's completion in SSM:
  1. prerequisites;
  2. core stacks (foundation, identity, runtime, control plane) with stack outputs passed between
     them automatically;
  3. the AgentX operator role and the CloudFormation service role;
  4. the GitHub App (US1, FR-027 to FR-030);
  5. the Slack app and the Slack service stack (FR-031 to FR-035);
  6. the admin user and login;
  7. the first project (FR-040);
  8. connectors (optional, FR-036 to FR-039);
  9. alerts and the budget (FR-045 to FR-047);
  10. an end-to-end check: a test message in the chosen channel, waiting for a threaded reply.
- **FR-019**: Re-running `init` MUST resume at the first incomplete step. Re-running a completed step
  MUST change nothing. `init --resume` MUST work under the operator role for steps 4 to 10.
- **FR-020**: Every prompt MUST have a flag, so `init` can run without prompts (`--yes` plus flags).
  Secrets MUST be read from hidden prompts, or from an environment variable or file named by a flag,
  never from a flag's value.
- **FR-021**: A new identity stack MUST create a Cognito user pool, an app client for the CLI's PKCE
  login (localhost callback) and an `agentx-admin` group, and output the issuer and audience the
  control plane takes. With bring-your-own OIDC, `init` MUST check that the issuer's discovery
  document is reachable and that the admin's token carries the configured admin group claim.

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
- **FR-025**: When a permission boundary is given, every role AgentX creates MUST carry it.
- **FR-026**: `init --export <dir>` MUST write, without calling any AWS write API:
  - the templates;
  - a parameters file per stack, filled from the answers;
  - the code packages with checksums;
  - the operator role, service role and deployer policies as JSON;
  - a README with the deploy order and the exact commands.

  After the platform team deploys, `init --resume` MUST continue from the first human step.
  `upgrade --export <dir>` MUST write the change for a pipeline in the same way.

**GitHub App**

- **FR-027**: The CLI MUST create the GitHub App with GitHub's manifest flow: it opens a page with a
  pre-filled manifest (the permissions AgentX needs, the webhook URL of this environment, no
  unused events), for a personal account or an organization.
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
- **FR-033**: After deploying the Slack service stack, the CLI MUST confirm Slack has verified the
  events URL and the interactivity URL, and store the bot's user ID and app ID.
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
- **FR-041**: `agentx channel add` MUST bind a channel to a project, invite the bot, and post a
  test message that must get a threaded reply.

**`agentx upgrade` (US4)**

- **FR-042**: `upgrade [--to <version>]` MUST read the environment's version and engine from SSM,
  show the target release's notes, and show every change: added, changed and replaced resources, and
  IAM changes, called out separately. Templates use change sets; cdk uses `cdk diff`.
- **FR-043**: A change that replaces or deletes a table, user pool, bucket or secret MUST stop the
  upgrade unless the operator confirms it by typing the resource's name (or passes
  `--allow-replace <logical-id>`).
- **FR-044**: `upgrade` MUST deploy stacks in the release pipeline's order (runtime, control plane,
  Slack service), stop at the first failure (CloudFormation rolls that stack back), leave earlier
  stacks on the new version, be safe to re-run, and run `doctor` at the end.

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

  Each key maps to one stack parameter or one SSM value, listed in the docs (for example,
  `limits.workspacesPerMember` is `SlackMemberWorkspaceLimit`).

  Unknown keys and invalid values MUST be refused.
- **FR-049**: `config set` MUST show the change before applying it. Stack-parameter keys apply with a
  parameter-only stack update; SSM keys apply at once. Model keys MUST pass the one-token test call
  first.

**`agentx doctor` (US4)**

- **FR-050**: `doctor` MUST check, each with a "what is wrong / how to fix it" line:
  - that stacks exist and are healthy, and that their version matches SSM;
  - engine mismatch and drift;
  - that secrets exist and have the right shape (without reading values out);
  - the Slack token, the verified URLs, and bot membership of bound channels;
  - the GitHub App installation and repository access;
  - each connector's test read;
  - model access;
  - the alert subscription and budget.
- **FR-051**: `doctor --json` MUST print machine-readable results. `doctor` MUST exit non-zero when
  any check fails.

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
- **SC-006**: No secret value appears in any output, log or local file over the test suite.

## Decisions

- **Both engines, one source** (2026-09-25, owner). The templates are generated from the same CDK
  code at release time, and a release check (FR-012) keeps them equal. Templates are the default
  because they need no bootstrap and are what enterprise pipelines deploy. An environment keeps its
  engine; switching is out of scope.
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
- **Published templates are synthesized once for a reserved placeholder environment and rendered for
  the real environment at install, proven equal to a direct synthesis (FR-012).**
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
- **Teardown and account moves are documented, not built** (2026-09-25, owner). Removing an
  environment deletes data that cannot be recovered and needs careful safeguards. Tracked in #66 and
  #67.

## Assumptions and Scope

- **Assumptions:**
  - The npm package name `@agentx/cli` and an ECR Public namespace are available to the project. If
    not, the owner picks the names before release, and the spec is updated.
  - Releases are cut from mainline by a tag, and a GitHub Actions workflow publishes them. The
    maintainers' own `AgentXReleasePipeline` keeps deploying the authors' environment.
  - GitHub's manifest flow and Slack's "create from manifest" remain available.
- **Out of scope:**
  - `agentx destroy` (#66) and moving an environment to another account (#67).
  - Switching an environment between engines.
  - The `demo-microvm` runtime mode.
  - Multiple Slack workspaces or GitHub App installations per environment.
  - The AgentX MCP server for Claude Code (spec 016).

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
  - the operator and service role policies stay within AgentX's names, and carry the permission
    boundary when one is set;
  - an export bundle is complete and self-consistent.
- **Release tests (before each release, in a throwaway AWS account)**:
  - a full non-interactive install with each engine, using pre-made test Slack and GitHub apps passed
    by flags;
  - an upgrade from the previous release with each engine, then `doctor`;
  - the enterprise path: export, deploy with plain CloudFormation, `init --resume`;
  - a live Slack reply, and `alerts test`;
  - teardown by the manual guide, which also proves the guide.
- **Manual check (once, before this spec is done)**: SC-001.
