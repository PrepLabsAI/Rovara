# Tasks: Connector Gateway

Each phase is one pull request to `mainline`. Check a task only after its evidence exists.

## Phase 1a: Extract the gateway (US1)

- [X] T001 Create `packages/gateway` and wire it into the build, lockfile, Dockerfiles and image-input lists; move `mcp-client.ts` and re-export it from the broker.
- [X] T002 Define gateway types and implement generic `approveTools` with binder-driven property removal; test with a non-GitHub fixture connector.
- [X] T003 Implement generic `discoverTools` and `executeTool` with credential provider, binder, guards and ledger; test injection, guards, actor, redaction and fingerprint compatibility.
- [X] T004 Implement the GitHub connector and turn `packages/broker/src/github-mcp.ts` into a compatibility layer; feature 007 suites pass unchanged; pin schema-hash stability.
- [X] T005 Run typecheck, lint, tests and synthesis; open the phase pull request.

## Phase 1b: Configuration, ledger, schemas, cache (US1, US2 foundation)

- [X] T006 Add `ConnectorConfigSchema` and `integrations.connectors` to the project contract; read `githubMcp` as a `github` connector through `githubConnectorOf`; refuse both keys.
- [X] T008 Write new connector ledger records under `CONNECTOR#<name>#<requestId>`; the `github` connector keeps `GITHUB_MCP#<requestId>`.
- [X] T009 Flatten `$ref`/`$defs` and mergeable `allOf` before narrowing; report unrepresentable tools as skipped.
- [X] T010 Cache catalogs per revision and connector for 10 minutes; keep call-time hash comparison.

## Phase 2: Presentation (US4)

- [X] T007 Add `/v1/workspaces/{id}/connectors/{name}/tools|call` in `packages/broker/src/aws/connectors.ts`; serve `/github/...` as aliases with feature 007 shapes. (moved from phase 1b).
- [X] T011 Add `connectors` and `repositories` to thread workspace resolution for `includeConnectors`; keep `githubMcpRepositories`. (moved from phase 1b)
- [X] T012 Present connector tools as `<connector>__<tool>`, one per tool, with a `target` enum for multiple scopes; refuse names over 64 characters and `target` collisions.
- [X] T013 Assemble descriptions from override or vendor text, target line, access line and examples; cap at 2,048 characters.
- [X] T014 Generate the capabilities manifest, including not-connected connectors and the close command.
- [X] T015 Return `reason: not_connected` for approved connectors without a working credential.
- [X] T016 Replace the seven lifecycle tools with `agentx_manage_pull_request`; update `assertOrchestrationOnly` and feature 002/003 documents. For one release, list the retired tool names and their replacement action in the orchestrator system prompt (not a rename table in the manifest).
- [X] T017 Offer recovery tools only when `recoverableOperations` is non-empty.
- [X] T018 Enforce the 20/40 tool budget and ordering; add the presentation snapshot test.
- [X] T019 Append the attribution footer to write tools' body or description; add the Slack `users:read` scope and display-name cache.
- [X] T038 Report non-terminal thread operations as `recoverableOperations` (phase 2b, with T017)

## Phase 3: Credentials (US2, US3 foundation)

- [X] T020 Add the credential registry store and admin routes; synthesize the built-in GitHub App entry.
- [X] T021 Implement `static-secret` and `oauth-client-credentials` providers with token cache, one re-mint and not-connected reporting.
- [X] T022 Grant the broker `secretsmanager:GetSecretValue` on `agentx/connectors/*` only.
- [X] T023 Add `agentx admin credential register|list`.
- [X] T024 Add registration preflight: missing tools, skipped tools, authentication failures, budget.

## Phase 4: Turn records, metrics, evaluation (US5)

- [X] T025 Move `TaskUsageTelemetry` to `@agentx/contracts`; the worker imports it unchanged.
- [X] T026 Add the hidden turn-recorder extension and the `TurnRecords` writer; one record per Slack event.
- [X] T027 Add `TurnRecords`, the SNS topic and the alarms to `AgentXControlPlane`; grant the Slack service write and the broker read.
- [X] T028 Emit the metrics in `contracts/metrics.md` from broker and Slack service.
- [X] T029 Add the admin turn export route and `agentx admin turns export`.
- [X] T030 Add `npm run eval` with seed cases, legacy presentation mode and baselines; record SC-004.
- [X] T031 Update the README diagnostics paragraph for turn-record retention.
- [X] T039 Send `refresh=1` for connector discovery after a turn recorded a definition-changed failure; the tools route bypasses the per-container catalog cache for it.

## Phase 5b: Shared binder (before 5 and 6)

- [X] T040 Add `Binder.optionalProperties`, `GuardInput.scope` and `Guard.rewrite`; test with recorded Linear and Jira fixtures, the GitHub characterization and the tracker type.

## Phase 5: Linear (US2)

- [X] T032 Record Linear `tools/list` fixtures; add the Linear connector type, team binder and fake-server integration test.
- [X] T033 Write the Linear setup guide with the mandatory vendor-side restriction; add Linear evaluation cases.
- [ ] T034 Live check against a Linear workspace; record evidence in `quickstart.md`.

## Phase 6: Jira (US3)

- [x] T035 Record Atlassian fixtures; add the Jira connector type, `cloudId`/project binder and fake-server integration test.
- [x] T036 Write the Jira setup guide including API-token enablement and service-account limits; add evaluation cases.
- [x] T037 Live check once an Atlassian administrator enables API-token authentication; record evidence.
  Part A (before the PR) and Part B (in production, from Slack) passed on 2026-09-25 and are recorded under `## Jira (US3)` in `quickstart.md`.

## Phase 7: Asana (US6, spec Amendment 1)

- [x] T041 Add the `oauth-refresh-token` provider with shared cache, cross-container lease and rotated-token write-back; register it; grant tag-limited `PutSecretValue`.
- [x] T042 Add `agentx admin credential authorize` (PKCE, state, loopback callback, secret write and tag, registration).
- [x] T043 Record Asana fixtures; add the Asana connector type, project binder and guard, and the fake-Asana flow test.
- [x] T044 Write the Asana setup guide with the mandatory bot-user restriction; add evaluation cases and the presentation snapshot.
- [x] T045 Live check against a real Asana project with a one-time bot-user sign-in; record evidence in `quickstart.md`.
  Part A (before the PR) and Part B (in production, from Slack) passed on 2026-09-25 and are recorded under `## Asana (US6)` in `quickstart.md`. Part B's owner auto-approval led to `--no-browser` and `--expect-account` on `agentx admin credential authorize`.

## Dependencies

1a → 1b → {2, 3}; 2 → 4; 3 → 5a → 5b → {5, 6, 7}. Phases 5, 6 and 7 can run in parallel.
