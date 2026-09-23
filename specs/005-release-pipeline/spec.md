# Feature Specification: Production Release Pipeline

**Feature Branch**: `mainline`

**Created**: 2026-09-23

**Status**: Implemented and validated locally; pipeline deployment and live acceptance pending

**Input**: User description: "Whenever a new commit drops, build a new Docker image and, following the release process, publish it to ECR and update the AgentCore runtime. Use AWS CodePipeline and AWS CodeBuild. Only build a new image and update the runtime when the worker code is touched."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Release Worker Changes Automatically (Priority: P1)

A developer merges a change that affects the worker image into `mainline`. Without anyone running a release by hand, AWS builds and smoke-tests a new `linux/arm64` worker image, publishes it by immutable digest, updates `AgentXProductionRuntime`, waits until AgentCore is `READY` on that exact digest, and then updates the control plane.

**Why this priority**: This is the requested outcome. It removes the manual `release:prod` step for every worker change.

**Independent Test**: Push a commit that changes `packages/worker`, and confirm that one pipeline execution produces a new `release-*` image and a new runtime version on that digest.

**Acceptance Scenarios**:

1. **Given** a commit on `mainline` that changes any worker image input, **When** the pipeline runs, **Then** it runs typecheck, lint, and tests, builds and pushes a new image, and updates the production runtime before the control plane.
2. **Given** any check, build, smoke test, or deployment step fails, **When** the pipeline runs, **Then** the execution fails and no later release step runs.

---

### User Story 2 - Skip Image Builds When Only Control-Plane Code Changes (Priority: P1)

A developer merges a change that affects only the broker Lambdas or infrastructure. The pipeline reuses the worker image already deployed, leaves the runtime untouched, and deploys the control plane.

**Why this priority**: The user explicitly does not want new images or runtime versions for commits that do not affect the worker.

**Independent Test**: Push a broker-only commit and confirm that no image is pushed, the runtime version is unchanged, and the control-plane Lambdas are updated.

**Acceptance Scenarios**:

1. **Given** no worker image input has changed since the commit that produced the deployed image, **When** the pipeline runs, **Then** it reuses the deployed digest and CloudFormation reports no runtime change.
2. **Given** the deployed image's source commit cannot be determined, or is missing from the checkout history, **When** the pipeline runs, **Then** it builds a new image. Building is always the safe fallback.

---

### User Story 3 - Ignore Commits That Cannot Affect Production (Priority: P2)

A developer merges documentation, specifications, tests outside deployed packages, CLI code, or CI configuration. No pipeline execution starts.

**Independent Test**: Push a docs-only commit and confirm that no pipeline execution is created.

### Edge Cases

- Several commits land while a release is running. Only the newest waiting execution runs; comparing against the deployed image means it still includes every worker change.
- An earlier worker release failed or was superseded. The next execution still detects the worker change, because detection compares against what is deployed rather than against the previous commit.
- A commit changes `infra/lib/production-foundation.ts`. The release refuses to continue until an administrator reviews and deploys the foundation separately.
- `AgentXProductionFoundation` does not exist. The pipeline refuses to create it.
- The Docker base image is pulled from CodeBuild's shared IP addresses, which are subject to Docker Hub anonymous rate limits.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: A CodePipeline V2 pipeline MUST start on pushes to `PrepLabsAI/AgentX` branch `mainline` that change deployable inputs, using the administrator-authorized CodeConnections GitHub connection.
- **FR-002**: Pushes that change only non-deployable paths MUST NOT start the pipeline.
- **FR-003**: Every worker image input copied by `environments/base/Dockerfile` MUST be matched by the pipeline trigger.
- **FR-004**: The build MUST run the existing `release:prod` process, including typecheck, lint, tests, smoke test, digest verification, runtime readiness, and log retention. It MUST NOT skip checks or allow a dirty tree.
- **FR-005**: The build MUST reuse the deployed worker digest when no worker image input changed between the deployed image's source commit and the pipeline commit, and MUST build a new image otherwise.
- **FR-006**: The pipeline MUST NOT create `AgentXProductionFoundation`, and MUST fail when the synthesized foundation differs from the deployed foundation.
- **FR-007**: Only one release build MAY run at a time, and newer waiting executions MUST supersede older waiting ones.
- **FR-008**: The build role MUST be limited to the CDK bootstrap roles, the production ECR repository, read access to the three production stacks and AgentCore resources, runtime log retention, and the GitHub connection.
- **FR-009**: The CodeBuild project name MUST NOT match the `agentx-*` pattern that the broker may start as a CodeBuild gate.
- **FR-010**: The build MUST install the Node.js version pinned in `.node-version`, verified against the official checksum, and a pinned AWS CLI version.
- **FR-011**: The worker base image MUST be pulled by its pinned digest from ECR Public instead of Docker Hub, and the build MUST NOT pull a Dockerfile frontend image from Docker Hub.
- **FR-012**: GitHub Actions CI MUST run on pushes to `mainline`.
- **FR-013**: The release pipeline stack MUST be deployed manually. The pipeline MUST NOT deploy or modify itself.

### Key Entities

- **Worker Image Inputs**: The Git paths that determine the worker image contents.
- **Deployed Worker Revision**: The commit encoded in the deployed image's `release-<time>-<sha>` tag.
- **Release Manifest**: `cdk.out/agentx-production-release.json`, stored as the build's output artifact.

## Success Criteria *(mandatory)*

- **SC-001**: A worker change on `mainline` reaches a `READY` production runtime on the new digest without manual steps.
- **SC-002**: A control-plane-only change produces zero new images and zero new runtime versions.
- **SC-003**: A docs-only change starts zero pipeline executions.
- **SC-004**: Automated tests prove that the trigger covers every Dockerfile input and that the reuse decision builds whenever the source commit is unknown.

## Assumptions and Scope

- `AgentXProductionFoundation`, `AgentXProductionRuntime`, and `AgentXControlPlane` are already deployed in us-east-1. Verified on 2026-09-23.
- The GitHub connection `arn:aws:codeconnections:us-east-1:944937319445:connection/7e76074b-e840-439f-b94c-6806a2bf9513` is already authorized.
- The `demo-microvm` deployment is retired and is out of scope.
- Rollback is a revert on `mainline`, or a manual `release:prod -- --worker-image <digest>`.
- Failure notifications and manual approval stages are out of scope.
