<!-- Sync impact: 4.0.0 -> 4.1.0 (adds a native, human-gated task workflow without adding an orchestrator model).
Principles modified: I. One orchestrator, remote coding (the control plane remains the only workflow
coordinator; it may pause for an attributable human decision and resume only on an authenticated
command); V. Evidence-based incremental delivery (workflow stages and their evidence obligations
are versioned, candidate-bound, and recoverable).
Principle added: VI. Human-gated task workflow (AgentX may run a native task-to-PR lifecycle with
typed stages, durable decisions, explicit skips, separately executed checks, and read-only review;
no automatic merge or deployment).
Sections modified: Scope and Operational Constraints (workflow pauses are allowed at named gates).
CharterArc integration is outside this feature. Design and verification are recorded in specs/056,
specs/057, and specs/058.
Follow-up TODOs: none. -->
<!-- Sync impact: 3.0.0 -> 4.0.0 (reverses spec 008's Slack-only rule for developers' AI tools).
Principles modified: I. One orchestrator, remote coding (the Slack orchestrator stays the only
orchestrator model; a second client, the developer task API, may drive coding work for a signed-in
developer whose own AI tool writes the instructions); II. Administrator-prepared projects (a
developer may also select a project by name through the developer task API); III. Shared
definitions, isolated instances (a workspace is owned by a Slack thread or by one developer task).
Sections modified: Scope and Operational Constraints (developer tasks are unattended too).
Removed sections: none.
Design and verification are recorded in specs/025-mcp-server/.
Follow-up TODOs: none. -->
<!-- Sync impact: 2.1.0 -> 3.0.0. Issue #119 retires old deployment modes for all installs,
including self-hosted, as confirmed by the user on 2026-09-27. Historical records stay readable.
Scope and operational constraints updated; design: specs/036-ec2-only-runtime/. -->
<!-- Sync impact: 2.0.0 -> 2.1.0 (widens third-party issue tools to connector tools).
Principles modified: I. One orchestrator, remote coding (administrator-enabled third-party tools are
no longer limited to issue tools, so Linear, Jira and later connectors share one boundary; scope is
the project plus each connector's registered scope rather than repositories alone; the third-party
credential, not project policy, is the access boundary). The permission widens under the same
conditions plus one new one; no other rule changes.
Sections modified: none. Removed sections: none.
Design and verification will be recorded in specs/013-connector-gateway/.
Follow-up TODOs: none. -->
<!-- Previous: 1.3.0 -> 2.0.0 (retires the local development client; AgentX is Slack-only).
Principles modified: I. Orchestration-only clients, remote coding -> I. One orchestrator, remote
coding (the local pi-based client is removed; the hosted Slack orchestrator is the only
orchestrator, and the remaining client administers projects); II. Administrator-prepared projects
(a developer selects a project by posting in its bound Slack channel, not with `agentx --project`);
III. Shared definitions, isolated instances (workspaces are owned by Slack threads only; personal
workspaces are retired).
Sections modified: Scope and Operational Constraints (local project configuration now serves
administration; all orchestration is unattended). Removed sections: none.
Design and verification are recorded in specs/008-slack-only-workflow/.
Follow-up TODOs: none. -->
<!-- Previous: 1.2.0 -> 1.3.0. Principle I permits project-approved third-party issue
tools through the authenticated control plane. Repository code/file and shell access remains
worker-only. Design and verification are recorded in specs/007-github-mcp/. -->
<!-- Sync impact: 1.1.0 -> 1.2.0 (adds a hosted Slack orchestrator with thread-owned workspaces).
Principles modified: I. Orchestration-only clients, remote coding (renamed; the boundary now covers
the hosted Slack orchestrator); III. Shared definitions, isolated instances (adds Slack thread
workspaces as the only shared writable checkout).
Sections modified: Scope and Operational Constraints (unattended orchestration is limited to the
hosted Slack orchestrator). Removed sections: none.
Follow-up TODOs: specify the hosted Slack orchestrator as its own Spec Kit feature. -->
<!-- Previous: 1.0.0 -> 1.1.0 added the explicitly limited demo-microvm deployment mode. -->
# AgentX Constitution

## Core Principles

### I. One orchestrator, remote coding

The hosted Slack orchestrator is the only orchestrator. It MUST expose only orchestration
capabilities and administrator-enabled third-party connector tools mediated by the authenticated
control plane to its agent. Those connector tools MUST enforce project scope and each connector's
registered scope, keep credentials out of model context, and deduplicate writes durably. The
credential a connector uses MUST itself be limited at the third party to that registered scope;
project policy narrows what the agent is offered but is not the access boundary.
Repository code inspection, editing, shell execution,
builds, and tests MUST run in remote coding workers. Tool registration and extension loading MUST
enforce this boundary; prompts alone are insufficient. The orchestrator runs unattended. It MUST
accept only requests that Slack has signed and that come from a member of the channel bound to the
project. It MUST act through a service identity limited to Slack thread workspaces, and MUST record
the requesting Slack user with every operation.

The hosted Slack orchestrator is the only AgentX orchestrator model. A second client, the developer
task API, may drive coding work. It MUST authenticate a developer through the control plane's
developer sign-in, and the developer's own AI tool writes the instructions, which reach the remote
worker unchanged with no AgentX model in between.
It MUST record the requesting developer with every operation.
The administration client authenticates an administrator and calls administration routes only.
The control plane MUST refuse workspace, task, conversation, event and publication requests that
arrive neither through the hosted orchestrator's service identity nor through the developer task
API with a developer sign-in.

### II. Administrator-prepared projects

Administrators MUST define and prepare each product's fixed environment, repository layout,
and setup procedure before any coding task. A developer selects a registered project by posting in
the Slack channel bound to it, or by name through the developer task API when they may use it.
Preparing or resuming an isolated instance of that definition MUST complete before task acceptance.
A coding task MUST NOT implicitly define or reconfigure a project.

### III. Shared definitions, isolated instances

Project configuration and immutable environment images MAY be shared. Writable workspaces,
uncommitted changes, caches, credentials, and agent histories MUST be isolated by workspace
instance. A client-supplied name or session identifier MUST NOT grant access. Changes become
available to colleagues through explicit repository publication and integration, never through a
shared writable checkout.

Every workspace is owned by a Slack thread or by one developer task. A Slack thread's workspace is
owned by its thread (team, channel and thread, as verified by Slack's signed request) and is
intentionally shared by the channel members who post in that thread. A developer task's workspace
is reachable only by the developer who started it, and, while the developer shares it in continue
mode, by the members of the bound channel who post in its shared thread. No workspace is reachable
from any other thread, task, or identifier supplied through any other client.
Personal workspaces not tied to a task stay retired.
The existing ones are stopped and kept, and no route creates another.

### IV. Durable working state, replaceable processes

Working files and pi conversation state MUST persist independently of the worker process.
Reconnects MUST resolve the existing instance and resume its state without resetting code.
Commands interrupted by process loss MUST be reconciled explicitly. Only one mutating run
may own a checkout at a time. Request retries MUST NOT silently duplicate accepted work.
Persistent workspaces, optional recovery checkpoints, and Git publication are distinct concepts.
Evidence and user-visible status MUST identify the active storage mode and MUST NOT describe a
time-limited demo workspace as production-durable storage.

### V. Evidence-based incremental delivery

Requirements, design decisions, and dependency-ordered tasks MUST live in Spec Kit artifacts.
Isolation, tool restrictions, setup idempotency, retries, and resumption MUST have behavioral
verification. Mock success MUST NOT be reported as verified AWS behavior. Dependency versions
and environment image digests MUST be pinned when implemented. Complexity requires a recorded
need; optional features MUST NOT delay the first complete coding workflow.

### VI. Human-gated task workflow

AgentX MAY maintain a versioned task workflow that pauses at named human decision gates. One
control-plane workflow coordinator owns state transitions; Slack and developer MCP are clients,
not separate orchestrators. A gate MUST record the authenticated actor, decision, reason, task,
workflow revision, and candidate digest where applicable. A worker or reviewer MUST NOT approve
its own output or change workflow state directly. A skip is an explicit, attributable outcome,
never a pass. A new candidate or workflow-contract revision invalidates dependent approvals,
checks, and reviews. GitHub remains authoritative for issue and pull-request state; a person merges
pull requests. This principle grants no automatic merge, deployment, or production authority.

## Scope and Operational Constraints

The production target is pi on Amazon EC2 with persistent EBS-backed
workspace instances. Use a versioned development image and administrator-held AgentX project
configuration.
Dev Container metadata, automatic checkpoints, concurrent writers within one workspace,
automatic merging, and deployment of generated applications are outside the initial release.
These may be specified separately. The coordinator runs unattended except when a workflow reaches
a named human decision gate; it waits for an authenticated decision and resumes from durable state.
Coding remains in remote workers, as Principle I describes.

Historical deployment modes remain readable for audit only. New registrations and execution MUST
use `ec2-ebs` on every install, including self-hosted installs.

Project files MUST contain credential references rather than secret values. Runtime access MUST
validate project membership and workspace ownership before exposing files or invoking pi.
Live infrastructure creation requires concrete account, region, network, and identity settings;
their absence does not prevent local implementation or infrastructure synthesis.

## Development Workflow and Quality Gates

Follow constitution -> specification -> plan -> tasks -> implementation -> convergence.
Record assumptions separately from user-confirmed requirements. Complete a testable increment
before broadening scope. Update task checkboxes only after the corresponding evidence exists.
Review each change against these principles and run checks proportional to its behavior.

## Governance

This constitution records the agreed AgentX boundaries. User instructions take precedence.
Amendments MUST identify changed principles and update affected specifications and plans.
Use semantic versioning: major for incompatible principles, minor for new principles, patch
for clarifications. Reviewers MUST identify and resolve violations before declaring delivery complete.

**Version**: 4.1.0 | **Ratified**: 2026-09-17 | **Last Amended**: 2026-10-05
