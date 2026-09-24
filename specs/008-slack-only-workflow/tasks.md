# Tasks: Retire the Local CLI Development Mode

**Input**: Design documents from `/specs/008-slack-only-workflow/`

**Tests**: Required by Principle V and written with each boundary.

## Phase 1: Extract the shared orchestrator

- [X] T001 Create `packages/orchestrator` (`@agentx/orchestrator`) and move `orchestrator.ts`, `orchestration-tools.ts`, `mcp-tools.ts`, `control-plane-api.ts` and `event-client.ts` into it, with a root index and the three subpath exports
- [X] T002 Point `packages/slack-service` at `@agentx/orchestrator` in its manifest, its project references and its imports
- [X] T003 Delete `runOrchestratorInteractive` and the unused `initialMessage` option with the TUI, and drop "local" from the orchestrator system prompt and boundary extension name
- [X] T004 Follow the move in `tests/contract/orchestrator-boundary.test.ts`, `tests/contract/github-mcp.test.ts`, `tests/contract/slack-text.test.ts` and `tests/integration/mcp-orchestrator.test.ts`, replacing the TUI's JSON-path test with direct `pollOperation` coverage

## Phase 2: Cut the developer CLI

- [X] T005 Rewrite `packages/cli/src/main.ts` as an administration client: `login`, `admin project register`, `admin workspace stop`, `admin slack bind|unbind`
- [X] T006 Delete `tui.ts`, `connect.ts`, `client-state.ts`, `status.ts`, `cancel.ts`, `pull-request.ts`, `feedback.ts`, `slack-credentials.ts`, `secret-store.ts` and `admin/prepare.ts`, and drop the CLI's now-unused dependencies and `exports` map
- [X] T007 Assert the exact command list in `tests/contract/cli-main.test.ts`, and rewrite `tests/contract/cli-execution.test.ts` around the administration commands and the refused retired ones
- [X] T008 Remove the reconnect-state assertions from `tests/integration/resumption.test.ts` and the workspace-status assertions from `tests/contract/cli-output.test.ts`

## Phase 3: Close the OIDC developer path

- [X] T009 Refuse workspace, task, conversation, event and publication requests on the OIDC entry point with a message naming Slack, keeping administration routes and `/v1/service/*` intact
- [X] T010 Move the publication test in `tests/contract/cloud-handlers.test.ts` and the GitHub MCP authorization test in `tests/contract/github-mcp-broker.test.ts` to the service path, assert the Slack attribution on the pull request, and assert the OIDC refusal; update the isolation expectations in `tests/contract/slack-control-plane.test.ts`

## Phase 4: Build, release and documentation

- [X] T011 Add `packages/orchestrator` to both Dockerfiles, swap it for `packages/cli` in the Slack image, and update `WORKER_IMAGE_INPUTS`, `SLACK_ORCHESTRATOR_IMAGE_INPUTS` and the orchestrator smoke test
- [X] T012 Add the package to `AGENTX_RELEASE_TRIGGER_PATHS` and extend the trigger-coverage test
- [X] T013 Amend the constitution to 2.0.0 and record this feature's spec, plan and tasks
- [X] T014 Rewrite the README around the Slack workflow and the administration client, and remove the developer-machine box from `docs/architecture-production.md`

## Phase 5: Operations

- [ ] T015 Stop the existing personal workspaces after release with `agentx admin workspace stop --workspace <id>`, keeping their storage

## Evidence

- Typecheck, lint, the full suite (42 files, 227 tests) and `npm run infra:synth` pass locally, rebased onto the hosted GitHub MCP change and the project-level channel binding.
- The Slack contract, control-plane, ingress and service suites pass unchanged in behaviour.
- Image builds and their smoke tests run in the release pipeline; no local Docker build was made for this change.
