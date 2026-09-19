<!-- Sync impact: 1.0.0 -> 1.1.0 (adds an explicitly limited deployment mode).
Principles modified: IV. Durable working state, replaceable processes (evidence must identify
the storage mode and its retention boundary).
Sections added: VPC-free demo deployment mode within Scope and Operational Constraints.
Removed sections: none. Follow-up TODOs: none. -->
# AgentX Constitution

## Core Principles

### I. Local orchestration, remote coding

The local pi-based client MUST expose only orchestration capabilities to its agent.
Repository inspection, editing, shell execution, builds, and tests MUST run in remote coding
workers. Tool registration and extension loading MUST enforce this boundary; prompts alone
are insufficient. Local configuration and client-state I/O are permitted.

### II. Administrator-prepared projects

Administrators MUST define and prepare each product's fixed environment, repository layout,
and setup procedure before any coding task. Developers select a registered project through
`agentx --project <name>`. Preparing or resuming an isolated instance of that definition MUST
complete before task acceptance. A coding task MUST NOT implicitly define or reconfigure a project.

### III. Shared definitions, isolated instances

Project configuration and immutable environment images MAY be shared. Writable workspaces,
uncommitted changes, caches, credentials, and agent histories MUST be isolated by authenticated
owner and workspace instance. A client-supplied name or session identifier MUST NOT grant
access. Changes become available to colleagues through explicit repository publication and
integration, never through a shared writable checkout.

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
workspace instances. Use a versioned development image and local AgentX project configuration.
Dev Container metadata, automatic checkpoints, concurrent writers within one workspace,
automatic merging, deployment of generated applications, and unattended orchestration after
client exit are outside the initial release. These may be specified separately.

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

**Version**: 1.1.0 | **Ratified**: 2026-09-17 | **Last Amended**: 2026-09-17
