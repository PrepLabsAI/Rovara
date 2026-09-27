# Tasks

- [x] T001 Implement shared model configuration and in-memory OpenRouter runtime with tests.
- [x] T002 Wire worker, orchestrator, classifier and usage/model selection behavior.
- [x] T003 Add secret-reference deployment, IAM, SSM and boot wiring with tests.
- [x] T004 Extend init/deploy and backend-specific preflight with tests.
- [x] T005 Add transport/session regression coverage and live smoke instructions.
- [x] T006 Run checks, assess convergence and report live verification status.

## Phase 2: Convergence

- [x] T007 [FR-003] Refuse dynamic OpenRouter router aliases from the Pi catalog; verify Qwen3-Coder without reasoning and automatic-router rejection in transport tests.
- [ ] T008 [FR-001, FR-005, verification] Execute and record the deployed Slack smoke checklist in docs/openrouter.md. User authorized a $5 inference budget and requested open weights; proposed qwen/qwen3-coder. Live verification is deferred; the secret is assumed to be managed in Secrets Manager and missing credentials use the default model. Do not mark live compatibility verified from scripted tests.

## Phase 3: Missing-secret fallback

- [x] T009 Resolve a missing OpenRouter secret to the role's default Bedrock model before session creation, preserving actual-model telemetry. Permit absent references in init and check the fallback. Cover missing/present/permission-denied secrets and update documentation.
