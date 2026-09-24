# Tasks: Slim the Project Definition

**Input**: Design documents from `/specs/010-slim-project-definition/`

## Phase 1: Contracts

- [X] T001 Remove the four fields from `ProjectDefinitionSchema`; add `LEGACY_PROJECT_FIELDS`, `legacyProjectFields` and `StoredProjectDefinitionSchema`
- [X] T002 Parse worker invocations with the stored variant, and drop `environmentDigest` from `WorkspaceInstanceSchema`
- [X] T003 Cover the refusal, the stored reader, the legacy workspace record and the release-window invocation in `tests/contract/contracts.test.ts`

## Phase 2: Broker

- [X] T004 Refuse a registration that carries a retired field, naming the fields
- [X] T005 Stop copying and comparing the environment digest in workspace creation, resolution, resume and the in-memory registry
- [X] T006 Test both in `tests/contract/slack-control-plane.test.ts`, including a revision stored with the fields

## Phase 3: Worker

- [X] T007 Make the manifest's `environmentDigest` optional, stop writing it, and remove the comparisons from preparation, publication, maintenance and resume
- [X] T008 Keep a legacy digest in the publication and maintenance manifest fixtures

## Phase 4: Administration client

- [X] T009 Add `deployment.ts` and `--deployment-file`, and take the control-plane URL and login settings from it
- [X] T010 Report a project file that still carries the retired fields, and check HTTPS on repository URLs only
- [X] T011 Add `tests/contract/deployment-settings.test.ts` and cover login-without-a-project in `tests/contract/cli-execution.test.ts`

## Phase 5: Examples and documentation

- [X] T012 Slim `examples/projects/*.yaml`, add `examples/deployment.yaml`, and update the README's administration section
- [X] T013 Record the spec, plan and tasks

## Evidence

- Typecheck, lint, the full suite and `npm run infra:synth` pass locally.
- No live AWS run was made for this change. The release-order window is covered by a contract test, not by a deployment rehearsal.
