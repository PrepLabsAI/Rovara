# Tasks: Worker Usage Telemetry

## Phase 1: Specification and contracts

- [x] T001 Create specification, plan, research, data model, contract, quickstart, and requirements checklist
- [x] T002 Add the public Pi session-statistics accessor and effective cache-retention resolver
- [x] T003 Define the bounded usage payload and add the `usage` worker event type

## Phase 2: Task outcome telemetry

- [x] T004 Publish matching redacted `usage` event and `usage.json` artifact for successful tasks
- [x] T005 Preserve accumulated usage and original errors for failed and cancelled tasks
- [x] T006 Add successful, failed, cancelled, zero-token, and redaction coverage
- [x] T007 Prove the control plane accepts and stores the new event type

## Phase 3: Prompt-cache retention

- [x] T008 Add constrained production `PromptCacheRetention` parameter with default `long`
- [x] T009 Set production `PI_CACHE_RETENTION` and update infrastructure contract tests

## Phase 4: Validation and convergence

- [x] T010 Run focused tests, type checking, lint, full tests, and infrastructure synthesis
- [x] T011 Reconcile all requirements and record validation evidence
