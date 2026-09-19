# AgentX Validation Quickstart

Status: the deployable demo slice through T044K is locally validated; live AgentCore acceptance
remains open.

## Prerequisites

- Compatible pinned Node/npm and Docker for local worker integration.
- AWS account and AgentCore-supported region. The demo needs no VPC; production Instances need
  private subnets, security groups, capacity-provider permissions and quotas.
- OIDC application with configured audience/issuer and developer/admin claims.
- Test repository and scoped credentials; allowed model access; built image in ECR.

## Spec Kit workflow available now

```sh
uvx --from specify-cli==1.0.7 specify version
.specify/scripts/bash/check-prerequisites.sh --json --require-spec --require-tasks --include-tasks
```

In a coding-agent session with the installed skills, use `$speckit-implement` for the active
feature, then `$speckit-converge`. Read the specification and task dependencies first.

## Local checks

```sh
npm ci
npm run typecheck
npm test
npm run test:integration
npm run infra:synth
npm run infra:synth:demo
```

Expected: config/path validation, owner denial tests, setup retries, local tool restrictions,
duplicate submission, private persisted files and conversation reopen all pass. No AWS deployment
is implied by these commands. Mock/integration evidence must be labelled separately.

For the VPC-free path, follow `docs/deployment-demo.md`. It builds and publishes an immutable
`linux/arm64` image and deploys the `AgentXDemoRuntime` stack with PUBLIC networking and
per-session storage. Reuse the same broker-owned runtime session ID for a developer reconnect;
changing developers must change the session ID. Do not use demo persistence results to close T045.

The thin entry point exposes the implemented developer and administrator workflows after
`npm run build`:

```sh
node packages/cli/dist/main.js --help
```

## Administrator preparation

After building and deploying the image, control plane and runtime, authenticate as administrator:

```sh
agentx admin project register --file ./examples/projects/payments.yaml \
  --runtime-arn "$AGENTX_RUNTIME_ARN" \
  --deployment-mode demo-microvm
agentx admin workspace prepare --project payments --owner alice-subject
agentx admin workspace prepare --project payments --owner bob-subject
```

Expected: two independent instances report READY before either receives a coding prompt.
Repeat preparation after introducing a private edit; it must preserve that edit.

## First coding task and feedback

As Alice, authenticate and open the project:

```sh
agentx login --project payments
agentx --project payments
```

Ask for a small fixture feature and tests. Verify a remote diff/test result, then ask for a
follow-up. Inspect local filesystem/command instrumentation: no source edits or coding shell
execution occurred locally. Leave an untracked file remotely to exercise persistence.

## Isolation and reconnect

As Bob, select Payments and verify Alice's edits, history and artifacts are absent. Attempt
Alice's workspace/operation/artifact IDs through the broker: every route must deny access.
Verify Bob cannot directly invoke Alice's AgentCore session using developer credentials.

Close Alice's client and reconnect. Stop her idle compute through the admin command and resume.
The same saved tracked edits, untracked file and conversation must remain. Start a new
conversation and verify files still remain. No checkpoint or Git commit should be required.

## Failure and controls

Retry an identical task submission and confirm one operation. Submit competing writes and
confirm one busy response; Bob's independent task can run. Cancel a long-running fixture
subprocess, verify its process group stops and final status is accurate. Interrupt compute
during a task and verify INTERRUPTED rather than a false success or automatic duplicate run.

## Evidence and cleanup

Record test outputs, pinned image/runtime revision, region and stop/resume observations in
`docs/validation/agentx-foundation.md` during implementation. Stop test compute to retain
workspaces. Deleting sessions/capacity providers deletes their data and must be a separate,
explicit cleanup decision; there is no automatic destructive cleanup in this guide.
