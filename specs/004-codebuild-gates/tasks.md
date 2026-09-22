# Tasks: CodeBuild Publication Gates

**Input**: Design documents from `/specs/004-codebuild-gates/`

**Tests**: Required by FR-018 and written alongside each implementation boundary.

## Phase 1: Contracts and Configuration

- [X] T001 Add CodeBuild gate definition validation and backwards-compatibility tests in `tests/contract/contracts.test.ts`
- [X] T002 Add `codeBuildGates` to repository definitions in `packages/contracts/src/project.ts`
- [X] T003 Add normalized CodeBuild evidence to publication result contracts in `packages/contracts/src/operation.ts`

## Phase 2: Broker AWS Boundary

- [X] T004 Add broker CodeBuild adapter tests for exact commits, normalized evidence, invalid AWS responses, and retries in `tests/contract/codebuild.test.ts`
- [X] T005 Add the pinned AWS SDK CodeBuild dependency to `packages/broker/package.json` and the workspace lockfile
- [X] T006 Implement the CodeBuild adapter in `packages/broker/src/codebuild.ts`
- [X] T007 Add operation-scoped CodeBuild callback authorization and durable gate records in `packages/broker/src/aws/broker.ts`
- [X] T008 Add callback route contract tests for configured scope, stale capabilities, project mismatch, and idempotent start in `tests/contract/cloud-handlers.test.ts`

## Phase 3: Worker Validation

- [X] T009 Add worker client tests for polling, timeouts, terminal failures, and source mismatch in `tests/contract/codebuild.test.ts`
- [X] T010 Implement capability-only CodeBuild polling in `packages/worker/src/codebuild.ts` and `packages/worker/src/callback-client.ts`
- [X] T011 Gate new PR creation after candidate push and include evidence in `packages/worker/src/publish.ts`
- [X] T012 Add publication integration tests proving PR callback ordering and failure suppression in `tests/integration/pull-request-publication.test.ts`

## Phase 4: Existing Pull Request Safety

- [X] T013 Push append/sync candidates to an operation validation branch and run gates before advancing the PR head in `packages/worker/src/maintain-pull-request.ts`
- [X] T014 Add integration tests proving failed gates leave existing PR heads unchanged and successful gates fast-forward once in `tests/integration/pull-request-maintenance.test.ts`

## Phase 5: Infrastructure and Documentation

- [X] T015 Add broker-only least-privilege CodeBuild IAM assertions in `tests/contract/infrastructure.test.ts`
- [X] T016 Grant the broker `StartBuild` and `BatchGetBuilds` on `agentx-*` CodeBuild project ARNs in `infra/lib/control-plane.ts`
- [X] T017 Document project configuration, CodeConnections, buildspec ownership, Playwright, failure recovery, and cross-repo limits in `README.md`
- [X] T018 Run typecheck, lint, full tests, and demo infrastructure synthesis; record results in `specs/004-codebuild-gates/quickstart.md`

## Phase 6: Deployment

- [ ] T019 Deploy the updated control plane and worker, register a new project revision, and run a disposable live CodeBuild-to-PR acceptance test

## Dependencies

- T001-T003 establish shared contracts.
- T004-T008 establish the broker AWS and authorization boundary.
- T009-T012 deliver the new-PR MVP.
- T013-T014 extend the same safety rule to existing PRs.
- T015-T018 complete infrastructure, documentation, and local validation.
- T019 requires explicit AWS deployment authorization and working administrator-managed CodeBuild projects.
