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

No other client may drive coding work. The administration client authenticates an administrator and
calls administration routes only; the control plane MUST refuse workspace, task, conversation,
event, and publication requests that do not arrive through the hosted orchestrator's service
identity.

### II. Administrator-prepared projects

Administrators MUST define and prepare each product's fixed environment, repository layout,
and setup procedure before any coding task. A developer selects a registered project by posting in
the Slack channel bound to it. Preparing or resuming an isolated instance of that definition MUST
complete before task acceptance. A coding task MUST NOT implicitly define or reconfigure a project.

### III. Shared definitions, isolated instances

Project configuration and immutable environment images MAY be shared. Writable workspaces,
uncommitted changes, caches, credentials, and agent histories MUST be isolated by workspace
instance. A client-supplied name or session identifier MUST NOT grant access. Changes become
available to colleagues through explicit repository publication and integration, never through a
shared writable checkout.

Every workspace is owned by its Slack thread (team, channel, and thread, as verified by Slack's
signed request) and is intentionally shared by the channel members who post in that thread. It
MUST NOT be reachable from any other thread or by a thread identifier supplied through any other
client. Personal, per-developer workspaces are retired: the existing ones are stopped and kept,
and no route creates another.

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

## Scope and Operational Constraints

The production target is pi on Amazon Bedrock AgentCore Instances with persistent EBS-backed
workspace instances. Use a versioned development image and administrator-held AgentX project
configuration.
Dev Container metadata, automatic checkpoints, concurrent writers within one workspace,
automatic merging, and deployment of generated applications are outside the initial release.
These may be specified separately. All orchestration is unattended and runs in the hosted Slack
orchestrator described in Principle I.

A deployment mode named `demo-microvm` MAY use AgentCore microVM compute with public networking
and managed session storage at `/mnt/workspace` to validate the first live workflow without a
customer VPC. This mode MUST preserve per-owner session isolation, administrator preparation,
the orchestration boundary, and ordinary stop/resume behavior. It MUST be labelled non-production
and MUST expose its platform constraints: Preview storage, 1 GiB per session, deletion after 14
idle days, reset on runtime-version update, and an eight-hour maximum compute lifecycle. Evidence
from this mode MUST NOT satisfy production EBS durability or Instances acceptance criteria.

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

**Version**: 2.1.0 | **Ratified**: 2026-09-17 | **Last Amended**: 2026-09-24
