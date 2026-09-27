# Feature Specification: Run the Project's Devcontainer on EC2 Workers

**Feature Branch**: `feat/121-devcontainers`  
**Created**: 2026-09-27  
**Status**: Approved  
**Input**: Issue #121 (part of #76)

## User Scenario

### A project builds and tests inside its own devcontainer (Priority: P1)

A project whose repository has a devcontainer (for example Sample-Project-A: a Node 22 workspace plus
PostgreSQL through Compose) names it in its definition. Its workspace prepares inside that container, and the
agent's shell commands (build, tests, integration tests against the Compose database) run there too. After an
idle stop, the next message resumes with the same container and its data.

## Requirements

- **FR-001**: The project definition MUST accept an optional `devcontainer: { repository, configPath? }` naming
  a registered repository; `configPath` is relative to it and defaults to `.devcontainer/devcontainer.json`.
- **FR-002**: Registration MUST refuse a devcontainer unless the runtime binding is `ec2-ebs`.
- **FR-003**: Preparation MUST start the devcontainer after cloning (and again when a failed preparation
  resumes), record it in the preparation manifest, and run `setup` and `readiness` in it.
- **FR-004**: Every task MUST start the devcontainer first (idempotent), and the agent's shell MUST run in it,
  with timeouts and cancellation stopping the command inside the container.
- **FR-005**: The whole workspace MUST be visible in the devcontainer at the same path as on the host.
- **FR-006**: The EC2 worker MUST get the host's Docker socket, and Docker's data root MUST be on the workspace
  volume so images, containers and named volumes survive an idle stop. The worker's workspace walks MUST skip it.
- **FR-007**: The worker image MUST carry a pinned Docker CLI, Compose plugin and devcontainer CLI; the release's
  smoke test checks them.

## Success Criteria

- **SC-001**: With the real worker image and local Docker, Sample-Project-A prepares in its devcontainer, the
  agent shell runs `npm run test:integration` against its Postgres and passes, and a timed-out or aborted
  command leaves no process in the container.
- **SC-002**: In production, from a Slack thread, Sample-Project-A prepares in its devcontainer, `npm test` and
  `npm run test:integration` pass inside it, and after an idle stop the next message resumes with the
  devcontainer and its Postgres data. Needs #123 for repository access.
- **SC-003**: Typecheck, lint and the full test suite pass.
