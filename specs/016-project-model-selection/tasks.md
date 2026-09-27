# Tasks: Project Worker Model Selection

## Contracts and policy

- [x] T001 Add strict model policy/API schemas and project/task fields.
- [x] T002 Add command turn dispositions and reject provider/model routing fields.
- [x] T003 Add policy and routing contract tests.

## Broker resolution

- [x] T004 Add selection persistence and signed service GET/PUT routes.
- [x] T005 Resolve current policy for every task with stale-selection diagnostics.
- [x] T006 Test authorization, invalid choices, project scope, fallback, and legacy projects.

## Slack commands

- [x] T007 Parse and format deterministic `models` and `use` commands before workspace creation.
- [x] T008 Add signed thread API methods.
- [x] T009 Test listing, selection, ambiguity, confirmation, and workspace bypass.

## Worker and operations

- [x] T010 Honor task model with environment fallback.
- [x] T011 Surface selection diagnostics and verify actual-model usage.
- [x] T012 Document configuration, model access checks, commands, and rollout.

## Verification

- [x] T013 Run focused tests, typecheck, lint, and complete tests.
- [x] T014 Run Spec Kit convergence.
