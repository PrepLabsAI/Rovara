# AgentX

A software factory with a local pi-based orchestration client and remote pi coding workers
on Amazon Bedrock AgentCore. Administrators prepare shared product definitions and fixed
development images. Every developer uses an isolated persistent workspace instance.

## Current status

The VPC-free `demo-microvm` profile is deployed and has been validated end to end in `us-east-1`:
OIDC login, workspace preparation, control-plane dispatch, AgentCore managed session storage, Pi
tool use, Amazon Bedrock inference, GitHub App authentication for private repositories, and
result/artifact callbacks are working. The current demo uses Amazon Nova Pro. The latest local
suite passes 70 tests across 26 test files.

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

The local model can call only AgentX orchestration tools. Repository inspection, editing, shell
commands, builds, and tests are delegated to the remote Pi worker in AgentCore.

### 7. Administrator workflow

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

Continue with `$speckit-implement` for the remaining production EBS acceptance beginning at T045.
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
