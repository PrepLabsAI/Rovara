# Feature Specification: Slim the Project Definition

**Feature Branch**: `mainline`

**Created**: 2026-09-24

**Status**: Implemented

**Input**: Issue #20: "Project definition: remove schemaVersion, controlPlaneUrl, auth and environment.image."

**Constitution**: Version 2.0.0. No principle changes. Principle V's pinning still holds: the worker image is pinned by digest through the release, which is what actually runs.

## Context

After the local client was retired (#11), the project definition still carried four fields that serve nothing. `schemaVersion` marked a file format for files that now live in the control plane. `controlPlaneUrl` and `auth` told the retired client where to connect and are identical for every project in a deployment. `environment.image` looks like an image pin but chooses nothing: the runtime runs the `WorkerImageUri` the release deployed, and the value is only copied into each workspace and compared for equality — so editing it breaks existing workspaces and has no other effect.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A Project File Describes Only the Product (Priority: P1)

An administrator writes a project file with repositories, setup, readiness and instructions, and nothing about where AgentX runs.

**Acceptance Scenarios**:

1. **Given** a file without the four fields, **When** it is registered, **Then** registration succeeds.
2. **Given** a file that still carries them, **When** it is registered, **Then** it is refused with those field names.

### User Story 2 - Nothing Registered Before This Breaks (Priority: P1)

Revisions registered with the four fields keep serving threads, workspace records keep resolving, and manifests on existing disks keep validating.

### User Story 3 - The Release Window Is Safe (Priority: P1)

The release deploys the runtime before the control plane, so a new worker briefly receives definitions from the old broker that still contain the fields. It accepts them.

## Requirements *(mandatory)*

- **FR-001**: `ProjectDefinitionSchema` MUST NOT contain `schemaVersion`, `controlPlaneUrl`, `auth` or `environment`.
- **FR-002**: Registration MUST refuse a definition carrying any of them, naming the fields.
- **FR-003**: Readers of stored data MUST drop them: registered revisions, worker invocations, workspace records and preparation manifests.
- **FR-004**: No broker or worker code compares an environment digest.
- **FR-005**: The administration client MUST take its control-plane URL and login settings from one deployment file, not from each project file.
- **FR-006**: `agentx login` MUST work without naming a project.

## Success Criteria *(mandatory)*

- **SC-001**: Existing threads keep working across the change: task, follow-up, publication and maintenance.
- **SC-002**: A worker built from this change accepts an invocation from a broker that predates it.
- **SC-003**: A new project file is four fields and one nested block shorter, and no command reads a URL or login setting from it.

## Decisions

- **Deployment settings live in `~/.agentx/deployment.yaml`** (the issue's Option A), overridable with `--deployment-file`. The administration client is interim until the Slack setup UX replaces it, so a local file beats a discovery route on the control plane. Decided 2026-09-24.
- **Registration refuses a definition that still carries a removed field**, rather than dropping it silently, so an administrator learns that the file moved on.

## Assumptions and Scope

- No migration: stored revisions, workspace records and manifests keep their legacy fields, and readers ignore them.
- `--project` is now a project name for `admin slack bind|unbind`; only `admin project register` reads a project file.
- Deriving repository paths, branches, setup and readiness from the repository is separate work.
