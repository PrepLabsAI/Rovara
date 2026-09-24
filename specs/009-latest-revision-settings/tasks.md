# Tasks: Apply Non-Disk Settings From the Latest Revision

**Input**: Design documents from `/specs/009-latest-revision-settings/`

**Tests**: Required by Principle V and written with each boundary.

## Phase 1: GitHub MCP policy

- [X] T001 Resolve the policy and repository alias from `requireLatestProject` in the GitHub MCP route, and carry `settingsRevision` into `GitHubMcpContext` and the durable invocation record
- [X] T002 Cover both directions in `tests/contract/slack-control-plane.test.ts`: a revision that adds a policy reaches an existing thread, and one that withdraws it revokes the tools
- [X] T003 Cover withdrawal against a previously discovered schema, and the recorded revision, in `tests/contract/github-mcp-broker.test.ts`

## Phase 2: Hosted turns

- [X] T004 Read `orchestratorInstructions` and the MCP repository list from the latest revision in `existingThreadWorkspace`, keeping the pinned record for preparation retries
- [X] T005 Add `settingsRevision` to the thread workspace contract behind `includeSettingsRevision`, and request it from the Slack service
- [X] T006 Announce a settings revision change once per thread, recording the first observed revision silently, with tests in `tests/integration/slack-service.test.ts`

## Phase 3: Publication and maintenance

- [X] T007 Add `publicationProject`, merging the latest revision's `readiness` and per-repository `codeBuildGates` onto the pinned definition, and record `settingsRevision` on publish, maintain and task operations
- [X] T008 Assert the merge and the pinned disk fields in `tests/contract/cloud-handlers.test.ts`
- [X] T009 Fail a readiness command whose `cwd` is not a directory in the workspace, with a test in `tests/integration/pull-request-publication.test.ts`

## Phase 4: Documentation

- [X] T010 Record the spec, plan and tasks, and describe the behaviour in the README and the 007 quickstart

## Evidence

- Typecheck, lint and the full suite (42 files, 229 tests) pass locally.
- Not covered by tests: nothing in the acceptance criteria. No live AWS run was made for this change.
