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
- [X] T013 Live: a worker-changing commit produces a new image and a `READY` runtime on that digest
- [X] T014 Live: a broker-only commit reuses the deployed digest and leaves the runtime version unchanged
- [X] T015 Live: a docs-only commit starts no pipeline execution

### Live verification evidence

- Pipeline execution `4467b032-c3f7-48d5-93b5-d84fcce44a4c` released commit `b536609`,
  published worker digest `sha256:87179c0f8864ce569ee2bf3ed39c8a80f0da92f1984b82807879c1ad1657b249`,
  and advanced the production AgentCore runtime from version 5 to `READY` version 6.
- Manual verification execution `d99e6d63-d489-43b6-bf08-6091d5ea5fdb` reran commit `b536609`,
  reused that digest, published no image, and left the runtime at version 6. This proves the image-reuse
  path; T014 remains open until a new broker-only commit exercises the webhook path.
- Docs-only commit `57a7c6e` produced no CodePipeline execution, proving the path filter excludes
  documentation and specification changes.
- Broker-only commit `c78a2bf` triggered webhook execution `154ed5f9-f233-4817-8933-d662863e7380`,
  reused the deployed worker digest, updated the control plane, and left the AgentCore runtime at
  version 6.

## Dependencies

- T001–T003 make the release command safe to run unattended.
- T004–T006 depend on T002's exported worker image inputs.
- T007–T009 are independent of each other.
- T011–T015 require explicit AWS deployment authorization.
