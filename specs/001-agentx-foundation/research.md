# AgentX Research and Decisions

Date: 2026-09-17. Documentation verified; no live AWS deployment or pi compatibility test yet.

## R1 — Use Spec Kit's actual installed workflow

**Decision**: Initialize with official `specify-cli==1.0.7`, Codex skills integration, Bash
scripts. Maintain constitution, specification, plan, contracts and tasks in its native layout.
**Rationale**: The user requested GitHub Spec Kit; its installed scripts resolve feature paths
and templates consistently. No global CLI installation is required (`uvx` is sufficient).
**Alternatives considered**: Ad hoc Markdown task list; rejected because it loses the requested workflow.
**Source**: https://github.com/github/spec-kit and https://github.github.io/spec-kit/installation.html

## R2 — AgentCore Instances with EBS

**Decision**: Use capacity-provider volumes at `/mnt/workspace`; prepare with an explicit
initialization invocation before accepting a coding task. Retain volumes when stopping compute.
**Rationale**: AWS documents per-session EBS retention and reattachment on resume; session or
capacity-provider deletion removes its persistent data. Instances offer x86_64 and arm64 options.
**Alternatives considered**: MicroVM session storage is documented as Preview; external EC2
workers would change the requested deployment model. Neither is the selected design.
**Sources**:
- https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-instances-how-it-works.html
- https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-filesystem-configurations.html
- https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-instances-get-started-cli.html

## R3 — Authenticated routing service

**Decision**: Bind verified issuer/subject and project membership to a server-owned workspace
record. Only the broker/dispatcher can select internal runtime session IDs and invoke runtimes.
**Rationale**: AWS authorizes the runtime resource, not session ownership. Caller-selected session
IDs and opaque runtime user headers are insufficient. Shared client configuration must contain
neither a developer's session ID nor authority to access another owner's state.
**Alternatives considered**: Direct invocation with client-side ownership checks is bypassable.
Separate IAM-scoped runtime resources per developer could work but add provisioning overhead.
**Source**: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-instances-security.html

## R4 — Durable task acceptance and short polling

**Decision**: Persist operations and an outbox transactionally, dispatch with retries, acknowledge
quickly in the worker and execute in the background. Poll stored events through the broker.
**Rationale**: A task can outlive a client connection and ordinary API request timeouts. AWS
documents HealthyBusy ping status for background work. Worker deduplication handles delivery
retries; process loss around shell effects remains an explicit interruption case.
**Alternatives considered**: Holding a Lambda response for an entire coding task; rejected.
WebSocket/SSE transport is optional future work once durable event semantics are working.
**Source**: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-long-run.html

## R5 — pi SDK for local and remote roles

**Decision**: Embed pi's interactive interface locally with a controlled resource loader and
orchestration-only tools; use its SDK remotely with a workspace cwd and persisted session file.
**Rationale**: Official main currently documents `@earendil-works/pi-coding-agent`, built-in tool
disabling, custom tools, event subscription, and SessionManager.open. Main is not proof that a
compatible package release is available; verify and lock an actual release in T001/T002.
**Alternatives considered**: Recreating a TUI or using an unconstrained local pi process.
**Sources**:
- https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sdk.md
- https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/package.json

## R6 — Fixed image plus project definition

**Decision**: Administrator-prebuilt OCI image pinned by digest, plus AgentX YAML describing
repository layout and readiness commands. Each instance owns separate writable storage.
**Rationale**: Tools are reproducible while source edits remain private and persistent.
**Alternatives considered**: A new image per coding turn; unnecessary. Dev Container metadata
is optional because no editor integration is required for the initial CLI workflow.
**Sources**: https://docs.docker.com/get-started/docker-overview/ and https://containers.dev/overview.html

## R7 — Persistence without automatic checkpoints

**Decision**: Save normal workspace files, pi session JSONL, and operation journals. Keep automatic
snapshots, rollback and checkpoint storage out of this release. Publish Git changes only explicitly.
**Rationale**: This directly implements the agreed follow-up/resume behavior without conflating
persistence, backup, and sharing. A stopped process restarts; its in-memory execution does not resume.
**Alternatives considered**: AgentCore Memory as filesystem or pi-session replacement; wrong abstraction.

## R8 — VPC-free microVM demonstration profile

**Decision**: Add a named `demo-microvm` deployment profile with PUBLIC networking and one
managed session-storage mount at `/mnt/workspace`. Build its worker image for `linux/arm64` and
route every developer workspace through a distinct, broker-owned runtime session ID. Keep
`instances-ebs` and its live acceptance task as the production path.

**Rationale**: AgentCore microVM runtimes do not require a VPC, and managed session storage is
isolated per session and survives stop/resume when the same session ID is used. This makes the
profile suitable for a low-infrastructure working demonstration without reintroducing a shared
writable workspace.

**Limitations**: Managed session storage is Preview, limited to 1 GiB, expires after 14 idle
days, resets when the runtime version changes, and does not replace production EBS evidence.
Runtime compute has an eight-hour maximum lifetime. The demo must treat its workspaces as
disposable and surface the deployment mode in trusted state.

**Alternatives considered**: Default-VPC networking still requires VPC configuration and does
not remove the operational dependency. A shared EFS workspace violates per-developer writable
isolation. External EC2 workers change the requested AgentCore architecture.

**Sources**:
- https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-filesystem-configurations.html
- https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-lifecycle-settings.html
- https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-permissions.html

## Deployment inputs and implementation gates

- Account, Instances-supported region, VPC/subnets, supported EC2 types, quotas and IAM permissions.
- Existing OIDC issuer/client/audience and stable owner/admin claims; repository host and scoped
  credential provider; Bedrock model access. Implement configurable interfaces, not invented values.
- Current SDK support for capacity providers, volumes and lifecycle APIs; CDK resource support
  or narrowly scoped custom resources if required. Networking comes from the capacity provider.
- Actual pi release/API compatibility, chosen Node version, container architecture, cold dispatch
  timing, mounted-volume readiness and background task lifecycle must be verified in T001/T045.
- Node/npm/Docker are not on the current shell PATH. `uv` and Git are available. This affects
  executable implementation checks, not specification generation; provision tooling in T002.

These are explicit preflight and deployment gates. No alternative architecture is silently selected.
