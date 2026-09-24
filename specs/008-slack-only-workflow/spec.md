# Feature Specification: Retire the Local CLI Development Mode

**Feature Branch**: `mainline`

**Created**: 2026-09-23

**Status**: Implemented

**Input**: Issue #11: "Retire the local CLI development mode; keep only the hosted Slack workflow."

**Constitution**: Version 2.0.0. Principle I (one orchestrator), Principle II (project selection through Slack), and Principle III (thread-owned workspaces only) were amended for this feature.

## Context

As of 2026-09-23 developers work only through the hosted Slack orchestrator (feature 006), where each thread owns a workspace. The local `agentx` development mode still existed beside it and caused real divergence: feature 007's GitHub MCP tools were wired only into the local orchestrator, so they never reached Slack, and project files still carried settings that only the local client read.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - One Way To Work (Priority: P1)

A developer asks AgentX for a change by mentioning it in the project's Slack channel. No other entry point exists, so there is no second behaviour to keep in step.

**Independent Test**: Run the Slack flow end to end for a new thread and a follow-up; then confirm the `agentx` executable offers no way to submit a task.

**Acceptance Scenarios**:

1. **Given** the retirement is released, **When** a developer mentions AgentX in a bound channel, **Then** the thread workspace, task, publication and event flow behave exactly as before.
2. **Given** a developer runs `agentx --prompt "..."`, **When** the command is parsed, **Then** it fails as an unknown option, and nothing reaches the control plane.

---

### User Story 2 - Administration Survives (Priority: P1)

An administrator registers a project revision, binds a Slack channel to the project, and stops an idle workspace, all from the command line, because Slack has no setup surface yet.

**Independent Test**: Run `agentx login`, `agentx admin project register`, `agentx admin slack bind|unbind`, and `agentx admin workspace stop` against the control plane.

**Acceptance Scenarios**:

1. **Given** an authenticated administrator, **When** they call an administration command, **Then** the control plane serves it as before.
2. **Given** any OIDC caller, administrator or not, **When** they call a workspace, task, conversation, event or publication route, **Then** the control plane refuses with a message naming Slack as the way developers work.

---

### User Story 3 - The Shared Orchestrator Keeps Working (Priority: P1)

The hosted Slack service keeps running the same orchestrator code, now owned by a package of its own rather than by the retired CLI.

**Independent Test**: Build the Slack orchestrator image and run its smoke test; run the Slack service, control-plane and ingress suites.

## Requirements *(mandatory)*

- **FR-001**: The orchestrator runtime, its orchestration tools, the MCP tool support, the control-plane API client and the event client MUST live in a package that does not depend on the command-line client.
- **FR-002**: `packages/slack-service` MUST NOT depend on `@agentx/cli`.
- **FR-003**: The `agentx` executable MUST expose only `login` and the administration commands `admin project register`, `admin workspace stop`, and `admin slack bind|unbind`. A test MUST assert the exact command list.
- **FR-004**: The retired developer modules MUST be deleted, together with any store only they used.
- **FR-005**: `admin workspace prepare` MUST be removed; personal workspaces are no longer created.
- **FR-006**: The OIDC entry point MUST refuse developer workspace operations with a clear error. Administration routes MUST continue to work, and the Slack service route MUST be unaffected.
- **FR-007**: Existing personal workspaces MUST be stopped, not deleted.
- **FR-008**: Both images, the release image-input lists, and the pipeline trigger globs MUST name the new package, and the trigger-coverage test MUST pass.
- **FR-009**: The constitution, README and production architecture document MUST describe a Slack-only product.

## Success Criteria *(mandatory)*

- **SC-001**: The Slack flow is unchanged: new thread, follow-up, limits and redelivery tests pass untouched in behaviour.
- **SC-002**: `agentx` offers zero developer commands, asserted by test.
- **SC-003**: Zero source files outside `packages/cli` import from `@agentx/cli`.
- **SC-004**: Typecheck, lint, the full suite and `cdk synth` pass.

## Assumptions and Scope

- `login` is kept although issue #11 lists it under developer commands: every remaining administration command authenticates with the token it stores, so removing it would leave the kept commands unusable. Recorded as a deviation on 2026-09-23.
- `admin workspace stop` is kept, as decided before implementation. It is the only lever that stops idle compute for a thread workspace, and it is how the retired personal workspaces are stopped.
- The broker route change ships with this feature, as decided before implementation. Merging deploys it.
- Feature 007's GitHub MCP tools reached Slack in the meantime, so their routes are served from the shared router and the hosted orchestrator discovers them. Closing the OIDC entry point removes their OIDC entry only; their contract tests move to the service path with the rest.
- Workspace deletion remains parked, as in feature 006.
- The slim project definition (removing `schemaVersion`, `controlPlaneUrl`, `auth` and `environment.image`) is a later change; after this retirement `controlPlaneUrl` and `auth` serve only the administration client.
