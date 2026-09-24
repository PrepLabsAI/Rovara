# AgentX

A software factory with a local pi-based orchestration client and remote pi coding workers
on Amazon Bedrock AgentCore. Administrators prepare shared product definitions and fixed
development images. Every developer uses an isolated persistent workspace instance.

## Current status

The VPC-free `demo-microvm` profile is deployed and has been validated end to end in `us-east-1`:
OIDC login, workspace preparation, control-plane dispatch, AgentCore managed session storage, Pi
tool use, Amazon Bedrock inference, GitHub App authentication for private repositories, and
result/artifact callbacks are working. Pull-request creation, safe existing-PR maintenance, clean
replacement, merged-PR revert, and administrator-configured CodeBuild gates are deployed. Gates
test the exact pushed candidate and block PR creation or PR-head advancement unless every gate
succeeds. The release workflow deploys the control plane and worker together to prevent protocol
version skew.
The current demo uses Amazon Nova Pro.

The production `instances-ebs` infrastructure is implemented and locally validated. It uses a
protected, retained capacity-provider foundation and a separately releasable runtime so routine
backend releases do not recreate or refresh developer workspaces. The existing demo workspaces
continue to serve traffic until the explicit one-time migration is performed. The existing
directory name `Pi-Bedrock` is retained, but the product is named AgentX.

## How AgentX is structured

```text
Slack mention -> hosted Pi orchestrator -> AgentX control plane -> remote Pi coding worker
                                                              -> approved GitHub MCP tools
```

The hosted Pi session is an orchestration-only client. It has AgentX control-plane and approved
MCP tools but no local source, file-editing, or shell tools. The remote Pi session owns the coding loop and exposes
`read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls` inside the developer's private workspace.
AgentX wraps remote Pi only to provide authentication, workspace allocation, operation fencing,
durable callbacks, and Git/tool-evidence artifacts.

The remote session runs at the workspace root, above the repositories, so Pi's own context-file
discovery never reaches them. For each prepared repository the worker loads the first of
`AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, and `CLAUDE.MD` that exists in the
repository root, and adds it to the session context labelled with that repository's name and
workspace path. The files are read again for every task, so an edited one applies to the next
task. A file that resolves outside its repository or exceeds 64 KiB is skipped and reported as a
progress event.

Both roles currently use `@earendil-works/pi-coding-agent` 0.85.1. GitHub Spec Kit supplies the
specification workflow and demo repository; it is not the coding-agent runtime.

See the [deployed demo architecture](docs/architecture-deployed-demo.md) for the current request
path and the [production architecture](docs/architecture-production.md) for the EBS-backed target.

## Use AgentX

### 1. Build and install the thin client

AgentX requires Node.js 22.19 or newer within the Node 22 release line:

```sh
npm ci
npm run build
(cd packages/cli && npm link)
agentx --help
```

If you do not want a global link, replace `agentx` in the examples below with
`npm run agentx --`.

### 2. Select a project

The administrator distributes one shared YAML definition per product. Store it as
`~/.agentx/projects/<project-name>.yaml`, then select it with `--project` on each invocation. The
examples below use the deployed project named `agentx`.

The YAML contains the control-plane and OIDC metadata, immutable worker image, repositories,
setup steps, and readiness checks. It contains no developer workspace ID, runtime session ID,
access token, or repository secret. See [project configuration](docs/project-configuration.md) and
the illustrative files in [`examples/projects/`](examples/projects/).

Each developer receives a distinct workspace instance. Sharing the project YAML does not share a
writable checkout; another developer sees changes only after they are published through Git.
For a private GitHub repository, set its `credentialRef` to the GitHub App credential reference
configured on the control plane (the deployed demo uses `github-agentx-sdlc`). The YAML still
contains no private key or installation token.

### 3. Log in

```sh
agentx --project speckit login --callback-port 8765
```

The command performs OIDC Authorization Code + PKCE login, opens the managed login page, receives
the callback at `http://127.0.0.1:8765/callback`, and stores the token in the operating-system
credential store. Opening the bare Cognito domain directly is not a login flow and can return
`{"message":"Missing Authentication Token"}`; always start login through the CLI.

Developer operation uses the OIDC token, not local AWS CLI credentials. AWS credentials are needed
only for infrastructure deployment and administration outside the AgentX API.

### 4. Check workspace readiness

```sh
agentx --project speckit status
```

The workspace must report `READY`. If it has not been prepared, an AgentX administrator must run
the preparation command described below.

### 5. Submit a remote task

```sh
agentx --project speckit \
  --prompt "Inspect repo/spec-kit/README.md and briefly explain what this project does."
```

Repository paths are relative to the workspace root. For example, a repository configured with
`path: repo/spec-kit` is available to remote Pi under `/mnt/workspace/repo/spec-kit`.

Without `--json`, the client streams remote Pi and tool events followed by the terminal operation.
For automation, request a stable JSON envelope containing the terminal operation metadata:

```sh
agentx --project speckit \
  --prompt "Inspect repo/spec-kit/README.md without modifying files." \
  --json
```

AgentX reuses the current remote conversation across prompts and preserves workspace files. Start a
new Pi conversation without replacing the workspace files with:

```sh
agentx --project speckit conversation new
```

Cancel an active operation using the operation ID printed when it was accepted:

```sh
agentx --project speckit cancel --operation <operation-id>
```

### 6. Start the interactive Pi orchestrator

Interactive mode requires a model available to the local Pi installation:

```sh
export AGENTX_ORCHESTRATOR_PROVIDER=<pi-provider>
export AGENTX_ORCHESTRATOR_MODEL=<pi-model-id>
agentx --project speckit
```

When the local orchestrator uses Amazon Bedrock, the `agentx` process must also inherit an AWS
credential source. Selecting a profile on an earlier `aws` command does not export it to later
commands:

```sh
export AWS_PROFILE=agentx-deployer
export AWS_REGION=us-east-1
export AWS_SDK_LOAD_CONFIG=1
export AGENTX_ORCHESTRATOR_PROVIDER=amazon-bedrock
export AGENTX_ORCHESTRATOR_MODEL=amazon.nova-pro-v1:0
agentx --project personal-website
```

Alternatively, run `/login amazon-bedrock` inside the TUI, choose **AWS profile**, and enter the
profile name. Pi stores the profile selection, not the underlying IAM secret key.

The local model can call AgentX orchestration tools and explicitly approved, dynamically
discovered GitHub MCP issue tools. Repository code inspection, editing, shell commands, builds,
and tests are delegated to the remote Pi worker in AgentCore.

#### GitHub MCP through hosted Slack

The control plane connects to GitHub's hosted MCP server, discovers its tools with `tools/list`,
and exposes only tools approved in the registered project revision. The orchestrator registers
their discovered descriptions and JSON schemas through one generic bridge; no per-tool GitHub
implementations are needed. Calls go orchestrator → control plane → GitHub MCP, without a worker.

See [GitHub MCP setup and policy example](specs/007-github-mcp/quickstart.md). This release uses
the existing GitHub App installation with repository-scoped **Issues** permissions. Tokens stay
in the control plane. Existing projects remain disabled until an administrator registers an
opt-in revision. Arbitrary endpoints, personal OAuth, and other GitHub permission families are
not included. Existing AgentX coding and validated PR-publication tools remain unchanged.
The hosted Slack service discovers tools from the thread workspace's registered project revision.
Calls use its IAM service identity and carry the requesting Slack user; tokens remain in the broker.
Use a new thread after binding the channel to an enabled revision. Existing threads retain their
workspace revision. Local CLI interaction is not required for users to access this integration.

### 7. Use a project Slack channel

AgentX runs a hosted orchestrator for Slack in the production AWS account, so no developer machine
has to stay online. Slack calls the AgentX Events API route; an ingress Lambda verifies Slack's
signature, acknowledges in the thread, and queues the request. An ECS Fargate service runs the Pi
orchestrator for that thread and posts the result back. It can call AgentX orchestration tools and
administrator-approved GitHub MCP tools; repository coding work runs in the remote Pi worker.

Each Slack thread has its own workspace. The first mention in a new thread creates a workspace
for the channel's bound project. Later mentions in that thread, by any channel member, continue
in the same workspace and Pi conversation. Requests in one thread run in order; different threads
run in parallel.

#### One-time administrator setup

The production release creates the Slack ingress route, queue, and thread storage in
`AgentXControlPlane`. Create the orchestrator service once with the release command's
`--create-slack-orchestrator` flag; the release pipeline updates it after that. Read the Slack
outputs from the control plane stack:

```sh
AWS_PROFILE=agentx-deployer AWS_REGION=us-east-1 aws cloudformation describe-stacks \
  --stack-name AgentXControlPlane \
  --query "Stacks[0].Outputs[?starts_with(OutputKey, 'Slack')].[OutputKey,OutputValue]" \
  --output table
```

Store the Slack app's **Signing Secret** (under **Basic Information → App Credentials**) and its
`xoxb-` bot token (under **OAuth & Permissions**) in the `SlackSecretArn` secret. Until you do,
the secret holds a generated placeholder and every Slack request is rejected. The commands below
read both values without echoing them or writing them to shell history:

```sh
export AWS_PROFILE=agentx-deployer AWS_REGION=us-east-1
SLACK_SECRET_ARN='<SlackSecretArn output>'
read -rs SLACK_SIGNING_SECRET   # paste the Signing Secret, then press Enter
read -rs SLACK_BOT_TOKEN        # paste the xoxb- bot token, then press Enter
export SLACK_SIGNING_SECRET SLACK_BOT_TOKEN
node -e 'process.stdout.write(JSON.stringify({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  botToken: process.env.SLACK_BOT_TOKEN,
}))' | aws secretsmanager put-secret-value \
  --secret-id "$SLACK_SECRET_ARN" --secret-string file:///dev/stdin
unset SLACK_SIGNING_SECRET SLACK_BOT_TOKEN
```

Both services cache the secret for up to five minutes, so allow that long after a change.

Then configure the Slack app:

- Turn **Socket Mode** off. While it is on, Slack delivers events over the socket instead of the
  request URL. The app-level `xapp-` token is no longer used and can be revoked.
- Under **Event Subscriptions**, enable events and set the request URL to the `SlackEventsUrl`
  output. Slack verifies the URL immediately, which succeeds only after the secret is stored.
- Subscribe to the bot event `app_mention`.
- Bot token scopes: `app_mentions:read` and `chat:write`. Reinstall the app after changing scopes.
- Invite the app to the project channel with `/invite @AgentX`.

Finally, bind the channel to the project. Binding requires an administrator login:

```sh
agentx --project project-a admin slack bind --team T0123456789 --channel C0123456789
```

A channel is bound to one project, not to a revision. Each new thread uses the project's latest
registered revision at the moment its workspace is created, so registering a revision publishes it
to every bound channel without binding again. Existing thread workspaces keep the revision they
were created with. `admin slack unbind` removes the binding, so new mentions in that channel are
ignored, but it keeps existing thread workspaces.

#### Working in a thread

Mention the app in the bound channel for every request, including follow-ups in a thread:

```text
@AgentX inspect the project and implement the navigation fix. Run the relevant tests, but do not
create a pull request.
```

AgentX replies within a few seconds. If earlier requests in the thread are still running, it says
how many are ahead. The first request in a new thread also prepares the workspace, which takes a
few minutes. Messages without a mention, edits, bot messages, direct messages, and users from other
Slack organizations are ignored.

Pull requests created from a thread end with a link to the thread and the Slack members who made
requests in it. Every operation records the Slack member who requested it.

Workspaces are limited to protect cost. The member who starts a thread may be the starter of at
most 3 thread workspaces, and the organization may have at most 20. A new thread over either limit
creates nothing, and AgentX replies with the limit that was reached; for the member limit, it also
links to that member's existing threads. Thread workspaces are not deleted yet, so they keep
counting toward the limits. An administrator can change the limits with the `AgentXControlPlane`
parameters `SlackMemberWorkspaceLimit` and `SlackOrganizationWorkspaceLimit`.

#### Diagnostics

The ingress Lambda and the orchestrator service write JSON log lines to CloudWatch Logs, with the
components `slack-ingress` and `slack-orchestrator`. They record event IDs, decisions such as
`event.ignored` with a reason, and failures by error type. Tokens, request text, and response text
are never logged. `event.ignored reason="channel_not_bound"` means the channel has no binding, and
`request.rejected reason="invalid_signature"` usually means the stored signing secret is wrong.

If the orchestrator's turn fails, AgentX posts the failure in the thread. Other failures, such as
workspace preparation or a Slack API error, are retried; on the fifth attempt AgentX posts the
failure and stops. A retry resumes the operations the earlier attempt started instead of starting
new ones. A request that the service could not finish handling five times, for example because it
restarted each time, moves to the `SlackRequestDeadLetterQueueUrl` queue.

#### Retired local Slack mode

`agentx slack run`, `slack configure`, and `slack login` are removed. To delete Slack tokens stored
by the local mode from the OS credential store, run:

```sh
agentx --project project-a slack logout
```

### 8. Validate changes and create a pull request

Pull-request creation is explicit; AgentX never publishes automatically after a coding task. The
registered project's `readiness` commands run inside the AgentCore workspace before a candidate is
pushed. Optional repository `codeBuildGates` then run remotely against that exact pushed commit.
AgentX rejects an empty diff, merge conflicts, or any failed/timed-out check before creating a PR.

From the CLI, select the configured repository by its project YAML `name`:

```sh
agentx --project personal-website pr create \
  --repository personal-website \
  --title "Improve homepage navigation" \
  --body "Summary of the change and validation performed."
```

AgentX creates `agentx/<operation-id>`, makes an AgentX-authored commit, pushes without force, and
creates a ready-for-review PR against the repository's configured `defaultBranch`. The terminal
result includes the PR URL and number, commit, head/base branches, and check evidence. Repeating the
same accepted request reconciles the existing branch and PR rather than creating a duplicate. When
CodeBuild gates are configured, the result also identifies each build and its resolved commit,
status, phase, timestamps, and CloudWatch logs link supplied by AWS.

New publication always captures the intended workspace tree and replays it onto the latest remote
default branch as exactly one commit. Earlier AgentX publication commits left in the persistent
workspace are not inherited by the new PR. A conflict or effective empty diff stops before push.

Maintain an AgentX-owned PR by repository name and PR number:

```sh
agentx --project personal-website pr append --repository personal-website --number 12
agentx --project personal-website pr sync --repository personal-website --number 12
agentx --project personal-website pr update --repository personal-website --number 12 \
  --title "Updated review title" --body "Updated context"
agentx --project personal-website pr close --repository personal-website --number 12
agentx --project personal-website pr reopen --repository personal-website --number 12
```

`append` runs readiness checks and accepts only workspace commits that descend from the recorded
PR head. With CodeBuild gates, append and sync first push an operation-specific validation branch;
the visible PR branch advances only after every build passes. `sync` merges the latest default
branch into the PR branch. Neither action rebases or
force-pushes published history. Remote Pi may rebase or amend commits that are still unpublished,
provided the resulting history remains a descendant of the published PR head; once published, use
another append, or replace the PR with clean history:

```sh
agentx --project personal-website pr replace \
  --repository personal-website --number 12 \
  --title "Clean replacement"
```

Replacement creates the new PR before closing the original and never changes the original branch.
For an already merged AgentX PR, create a reviewable revert PR instead of changing the default
branch directly:

```sh
agentx --project personal-website pr revert \
  --repository personal-website --number 12 \
  --title "Revert unintended changes from #12"
```

Only PRs with durable AgentX ownership evidence are eligible. PRs created by an earlier AgentX
version are adopted only when their `agentx/<operation-id>` branch matches a successful publication
operation in the same developer workspace.

In the interactive TUI, ask explicitly, for example: `Create a pull request for the
personal-website repository titled "Improve homepage navigation".` The local Pi orchestrator then
uses `agentx_create_pull_request`; ordinary coding requests do not expose an implicit publish step.

The installed GitHub App must have these repository permissions:

- **Contents: Read and write** for cloning and pushing the AgentX branch.
- **Pull requests: Read and write** for finding or creating the PR.

Change them under **GitHub Settings → Developer settings → GitHub Apps → AgentX SDLC → Permissions
& events → Repository permissions**. After saving, the installation owner must approve the updated
permissions for the installation. The App private key stays in Secrets Manager; it is never sent to
the AgentCore runtime. AgentX mints short-lived, single-repository tokens separately for clone,
push, and PR operations.

AgentX does not merge, approve, delete branches, add reviewers/labels, or force-push in this
workflow. The worker rejects force flags, force-with-lease flags, and plus-prefixed refspecs at the
credentialed Git command boundary.

#### Configure CodeBuild gates

CodeBuild projects are administrator-owned infrastructure. Create a project with a GitHub source
(use AWS CodeConnections for private repositories), a service role, compute image, and repository
`buildspec.yml`. Its name must begin with `agentx-`. Add the approved project to the repository in
the AgentX project YAML, increment `revision`, register that immutable revision, and re-prepare the
developer workspace:

```yaml
repositories:
  - name: personal-website
    url: https://github.com/example/personal-website.git
    path: repo/personal-website
    defaultBranch: main
    credentialRef: github-agentx-sdlc
    codeBuildGates:
      - name: quality
        projectName: agentx-personal-website-quality
        timeoutMinutes: 30
      - name: browser
        projectName: agentx-personal-website-playwright
        timeoutMinutes: 45
```

Unit tests, backend integration tests, and Playwright commands belong in the CodeBuild project's
buildspec. AgentX supplies only the exact Git commit as `sourceVersion`; it does not allow the
worker to override the buildspec, image, role, environment, source, or artifacts. The broker owns
`StartBuild`/`BatchGetBuilds` permission scoped to `agentx-*` projects, while AgentCore receives no
CodeBuild AWS credentials. A failed new-PR build leaves its candidate branch for diagnosis but
creates no PR. A failed existing-PR build leaves the PR head unchanged.

This release gates one repository publication at a time. Testing unpublished frontend and backend
candidates together and creating multiple PRs as one unit requires a future multi-repository
change-set workflow; a CodeBuild project may use secondary sources, but AgentX does not yet bind
multiple candidate commits atomically.

### 9. Administrator workflow

Before a developer can use a project, an administrator registers its immutable revision and
prepares that developer's private workspace:

```sh
agentx --project payments admin project register \
  --file "$HOME/.agentx/projects/payments.yaml" \
  --runtime-arn <agentcore-runtime-arn> \
  --deployment-mode <demo-microvm-or-instances-ebs> \
  --endpoint-qualifier DEFAULT

agentx --project payments admin workspace prepare \
  --owner <developer-oidc-subject>
```

The administrator must be logged in with the configured administrator claim, such as membership in
the Cognito `agentx-admin` group. Project revisions and runtime bindings are immutable. Increment
the YAML revision before registering a changed image, repository commit, setup, or readiness
definition.

Run `agentx --help` or `agentx <command> --help` for the complete command surface. A subsequent
demo release is one command from a clean checkout:

```sh
npm run release:demo -- --profile agentx-deployer --region us-east-1
```

The command runs all quality gates, applies bounded ECR retention, builds and smoke-tests ARM64,
pushes an immutable digest, deploys both stacks, verifies AgentCore `READY`, and enforces 30-day
runtime-log retention. See the [VPC-free AWS runbook](docs/deployment-demo.md) for first-deployment
environment variables, rollback options, and the manual procedure.

For the production EBS-backed platform, preview the release without changing AWS:

```sh
npm run release:prod -- --profile agentx-deployer --region us-east-1 --dry-run
```

The first real production release creates the protected foundation (dedicated two-AZ VPC, two NAT
gateways, KMS key, private worker security group, flow logs, and stable AgentCore capacity
provider), then creates the production runtime. Later releases refuse to modify that foundation
and update only the runtime and control plane:

```sh
npm run release:prod -- --profile agentx-deployer --region us-east-1
```

This command does not register a project, prepare a workspace, rewrite a workspace record, stop a
demo session, or migrate data. Those are separate, explicit administrative operations. An
`instances-ebs` workspace is identified by the stable capacity provider plus its developer/project
runtime session ID; updating the worker image on the production runtime does not change either
identifier and therefore does not require a workspace refresh.

#### Continuous production releases

`AgentXReleasePipeline` runs the same production release from AWS for every qualifying push to
`mainline`. It is a CodePipeline V2 pipeline with a native ARM CodeBuild project,
`release-agentx-production`, which runs:

```sh
npm run release:prod -- --region "$AWS_REGION" --reuse-unchanged-worker --require-existing-foundation
```

| A push to `mainline` that changes | Result |
|---|---|
| Only docs, specs, top-level `tests/`, CLI source, `scripts/` or `.github` | No pipeline execution |
| `packages/broker`, `infra` or other control-plane code, but no worker image input | Checks, then a control-plane deploy. The deployed worker digest is reused and the runtime is unchanged |
| A worker image input: `packages/worker`, `packages/contracts`, the Dockerfile, `.dockerignore`, root `package.json`, `package-lock.json` or tsconfigs, or a workspace `package.json` | Checks, a new ARM64 image, a runtime update to `READY` on that digest, then a control-plane deploy |

Whether the worker changed is judged against the deployed image. The pipeline reads the commit
from the image's `release-<time>-<commit>` tag and diffs the worker image inputs up to `HEAD`. So
a worker change from a failed or superseded execution is still released by the next one. If that
commit cannot be determined, the pipeline builds a new image. Any change under `infra/` that
alters `AgentXProductionFoundation` fails the release until an administrator reviews and deploys
the foundation manually. The pipeline never creates the foundation and never deploys itself.

One-time setup, with an administrator's credentials:

```sh
npm run build --workspace @agentx/infra
npx cdk deploy AgentXReleasePipeline --app 'node infra/dist/bin/agentx.js' \
  --profile agentx-deployer -c agentxRegion=us-east-1 \
  --parameters GitHubConnectionArn=arn:aws:codeconnections:us-east-1:944937319445:connection/7e76074b-e840-439f-b94c-6806a2bf9513
```

Protect `mainline` in GitHub. The build role can deploy through the CDK bootstrap roles, so push
access to `mainline` is deploy access. To roll back, revert the change on `mainline`, or run
`npm run release:prod -- --worker-image <digest>` locally with an earlier digest from
`agentx-worker-production`.

## Implementation documents

- [Pull-request task list](specs/002-create-pull-request/tasks.md): implementation and validation
  status for explicit publication.
- [Safe PR lifecycle task list](specs/003-safe-pr-lifecycle/tasks.md): clean publication,
  append/sync, replacement, and revert progress.
- [Pull-request specification](specs/002-create-pull-request/spec.md): publication behavior,
  safety, and retry requirements.
- [Task list](specs/001-agentx-foundation/tasks.md): 50 dependency-ordered implementation tasks.
- [Specification](specs/001-agentx-foundation/spec.md): agreed workflows and acceptance criteria.
- [Plan](specs/001-agentx-foundation/plan.md): architecture, boundaries and delivery sequence.
- [Research](specs/001-agentx-foundation/research.md): decisions and primary sources.
- [Deployed AWS architecture](docs/architecture-deployed-demo.md): current VPC-free demo resources
  and request flow.
- [Production AWS architecture](docs/architecture-production.md): stable AgentCore Instances,
  per-session EBS, networking, release, isolation, and migration boundaries.
- [Contracts](specs/001-agentx-foundation/contracts/): project config, control API and worker protocol.
- [Validation guide](specs/001-agentx-foundation/quickstart.md).
- [Constitution](.specify/memory/constitution.md): project principles, version 1.0.0.

## GitHub Spec Kit

Initialized with the official Specify CLI 1.0.7 and Codex skills integration:

```sh
uvx --from specify-cli==1.0.7 specify init --here --integration codex --integration-options="--skills" --script sh --ignore-agent-tools --non-interactive
```

Initialization has already run; do not rerun it over these artifacts unnecessarily.
The installed skills are in `.agents/skills/`, with templates/scripts under `.specify/`.

Spec Kit skills are agent instructions, not shell commands. No Git repository or branch was
created by this setup.

Validate the active feature now:

```sh
.specify/scripts/bash/check-prerequisites.sh --json --require-spec --require-tasks --include-tasks
```

## Local validation

Use Node 22.19 or newer within the Node 22 line:

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run infra:synth
```

The latest observed results are recorded in
[docs/validation/agentx-foundation.md](docs/validation/agentx-foundation.md). Docker and AWS are
not required for this local suite.
