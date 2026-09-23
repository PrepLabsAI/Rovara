# Tasks: Production Release Pipeline

**Input**: Design documents from `/specs/005-release-pipeline/`

**Tests**: Required by SC-004 and written alongside each implementation boundary.

## Phase 1: Release Command

- [X] T001 Let the shared parser accept caller-declared flags in `scripts/release-demo.ts`
- [X] T002 Add `--reuse-unchanged-worker`, `--require-existing-foundation`, worker image inputs, and the reuse decision in `scripts/release-production.ts`
- [X] T003 Add tests for the flags, every reuse outcome, and Dockerfile input coverage in `tests/contract/release-command.test.ts`

## Phase 2: Pipeline Infrastructure

- [X] T004 Add the `AgentXReleasePipeline` stack in `infra/lib/release-pipeline.ts` and register it in `infra/bin/agentx.ts`
- [X] T005 Add assertions for the trigger, source, build environment, buildspec, gate-name isolation, and least-privilege IAM in `tests/contract/infrastructure.test.ts`
- [X] T006 Add a test proving that the trigger globs match every worker image input in `tests/contract/release-command.test.ts`

## Phase 3: Build Inputs and CI

- [X] T007 Pull the pinned Node.js base image from ECR Public in `environments/base/Dockerfile`
- [X] T008 Run CI on pushes to `mainline` in `.github/workflows/ci.yml`

## Phase 4: Documentation and Local Validation

- [X] T009 Document one-time setup, trigger behavior, reuse, and rollback in `README.md`
- [X] T010 Run typecheck, lint, the full test suite, infrastructure synthesis, and a production release dry run

## Phase 5: Deployment and Live Acceptance

- [X] T011 Deploy `AgentXReleasePipeline` with the authorized GitHub connection ARN
- [ ] T012 Enable branch protection on `mainline`
- [ ] T013 Live: a worker-changing commit produces a new image and a `READY` runtime on that digest
- [ ] T014 Live: a broker-only commit reuses the deployed digest and leaves the runtime version unchanged
- [ ] T015 Live: a docs-only commit starts no pipeline execution

## Dependencies

- T001–T003 make the release command safe to run unattended.
- T004–T006 depend on T002's exported worker image inputs.
- T007–T009 are independent of each other.
- T011–T015 require explicit AWS deployment authorization.
