# AgentX

A software factory with a local pi-based orchestration client and remote pi coding workers
on Amazon Bedrock AgentCore. Administrators prepare shared product definitions and fixed
development images. Every developer uses an isolated persistent workspace instance.

## Current status

The VPC-free `demo-microvm` profile is deployed and has been validated end to end in `us-east-1`:
OIDC login, workspace preparation, control-plane dispatch, AgentCore managed session storage, Pi
tool use, Amazon Bedrock inference, GitHub App authentication for private repositories, and
result/artifact callbacks are working. Pull-request creation is deployed and its clean-checkout
safety path and changed-checkout publication path have both been validated against a private
repository. Safe existing-PR maintenance, clean replacement, and merged-PR revert are implemented
and locally validated; they require the next AWS deployment before use against the demo account.
Administrator-configured CodeBuild gates are also implemented locally: they test the exact pushed
candidate and block PR creation or PR-head advancement unless every gate succeeds.
The current demo uses Amazon Nova Pro.

The production `instances-ebs` profile and its EBS isolation/stop-resume acceptance remain T045.
The existing directory name `Pi-Bedrock` is retained, but the product is named AgentX.

## How AgentX is structured

```text
local Pi TUI/CLI -> AgentX control plane -> AgentCore microVM -> remote Pi coding agent
                                                        └── /mnt/workspace
```

The local Pi session is an orchestration-only client. It has AgentX control-plane tools but no
local source, file-editing, or shell tools. The remote Pi session owns the coding loop and exposes
`read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls` inside the developer's private workspace.
AgentX wraps remote Pi only to provide authentication, workspace allocation, operation fencing,
durable callbacks, and Git/tool-evidence artifacts.

Both roles currently use `@earendil-works/pi-coding-agent` 0.85.1. GitHub Spec Kit supplies the
specification workflow and demo repository; it is not the coding-agent runtime.

See the [deployed AWS architecture](docs/architecture-deployed-demo.md) for the complete request,
dispatch, runtime, storage, model, and callback paths.

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

The local model can call only AgentX orchestration tools. Repository inspection, editing, shell
commands, builds, and tests are delegated to the remote Pi worker in AgentCore.

### 7. Use a project Slack channel

Slack mode runs the local Pi orchestrator as a headless Socket Mode client. It makes only an
outbound WebSocket connection to Slack, so it does not require a public callback URL. The local
machine must remain awake and the command must remain running.

Configure the Slack app with these minimum permissions:

- Bot token scopes: `app_mentions:read` and `chat:write`.
- Bot event subscription: `app_mention`.
- Socket Mode enabled.
- An app-level token with `connections:write`.

After changing bot scopes, reinstall the app to the workspace. The app-level token is the `xapp-`
value under **Basic Information → App-Level Tokens**. The separate `xoxb-` bot token appears under
**OAuth & Permissions → OAuth Tokens for Your Workspace** after installation. Invite the app to the
project channel with `/invite @AgentX`.

Copy the immutable Slack channel ID and the member IDs that may invoke AgentX, then save the
non-secret project binding locally:

```sh
agentx --project project-a slack configure \
  --team T0BSHLLUGBD \
  --channel C0123456789 \
  --allow-user U0123456789
```

Import both tokens into macOS Keychain or Linux Secret Service. The tokens are never written to the
project YAML or reconnect-state files:

```sh
export SLACK_APP_TOKEN='xapp-...'
export SLACK_BOT_TOKEN='xoxb-...'
agentx --project project-a slack login
unset SLACK_APP_TOKEN SLACK_BOT_TOKEN
```

Start the bridge with the same local model configuration used by the TUI:

```sh
export AWS_PROFILE=agentx-deployer
export AWS_REGION=us-east-1
export AWS_SDK_LOAD_CONFIG=1
export AGENTX_ORCHESTRATOR_PROVIDER=amazon-bedrock
export AGENTX_ORCHESTRATOR_MODEL=amazon.nova-pro-v1:0
agentx --project project-a slack run
```

In the configured channel, mention the app for every request, including follow-ups:

```text
@AgentX inspect the project and implement the navigation fix. Run the relevant tests, but do not
create a pull request.
```

AgentX acknowledges the request and posts the final local-orchestrator response in the same Slack
thread. Requests are serialized because they share one developer workspace and one local Pi
session. Events from other workspaces, channels, users, bots, or duplicate Slack deliveries are
ignored. Stop the bridge with `Ctrl-C`. Remove stored Slack credentials with:

```sh
agentx --project project-a slack logout
```

The running bridge writes timestamped diagnostics to stderr. It logs Socket Mode connection state,
incoming event metadata, allowlist/filter decisions, queue activity, task duration, and Slack reply
status. Tokens, prompt text, and response text are never logged. For example,
`mention.ignored reason="channel_mismatch"` identifies a saved channel-ID mismatch, while no
`socket.envelope_received` line after a real app mention means Slack did not deliver an envelope to
this local Socket Mode connection. Raw-envelope diagnostics include Slack's `apiAppId` and event
type, but omit the message text and all credentials. If envelopes are absent despite a connected
socket, verify the bot-event subscription on that exact App ID and make sure another process or
machine is not connected with the same `xapp-` token and consuming events.

For a working request, the log progresses through `socket.envelope_received` with
`eventType="app_mention"`, `socket.event_received`, `mention.accepted`, `message.posted`, and
`task.started`. An envelope with `eventType="message"` means the Slack app is subscribed to
`message.channels` but not emitting the required `app_mention`; add `app_mention` under **Event
Subscriptions → Subscribe to bot events**, save the change, and reinstall if Slack requests it.
Once `task.started` appears, failures are in the AgentX/Pi workflow rather than Slack delivery and
are reported as `task.failed` plus a safe error type or code.

Slack mode uses the local model provider credentials for the entire lifetime of the bridge. If the
Amazon Bedrock profile expires, refresh it, verify it, and restart the bridge:

```sh
aws login --profile agentx-deployer
AWS_PROFILE=agentx-deployer AWS_REGION=us-east-1 aws sts get-caller-identity
agentx --project project-a slack run
```

Provider failures such as an expired AWS session are returned in the Slack thread as an AgentX
failure; they are not replaced with an empty-response message.

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
  --deployment-mode demo-microvm \
  --endpoint-qualifier DEFAULT

agentx --project payments admin workspace prepare \
  --owner <developer-oidc-subject>
```

The administrator must be logged in with the configured administrator claim, such as membership in
the Cognito `agentx-admin` group. Project revisions and runtime bindings are immutable. Increment
the YAML revision before registering a changed image, repository commit, setup, or readiness
definition.

Run `agentx --help` or `agentx <command> --help` for the complete command surface. For deployment,
use the [VPC-free AWS runbook](docs/deployment-demo.md).

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

Continue with `$speckit-implement` for the remaining production EBS acceptance.
Use `$speckit-converge` only after the remaining release tasks. Spec Kit skills are agent
instructions, not shell commands. No Git repository or branch was created by this setup.

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
