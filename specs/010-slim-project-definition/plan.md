# Implementation Plan: Slim the Project Definition

## Summary

Remove the four fields from the schema, add a tolerant reader for everything already stored, move the administration client's connection settings into one deployment file, and delete the environment-digest comparison from the broker and the worker.

## Technical Context

- `ProjectDefinitionSchema` is `.strict()` and is used both to validate registrations and, through `WorkerInvocationSchema`, to parse what the worker receives. Those two need opposite behaviour, so they need different schemas.
- `WorkspaceInstanceSchema` is `.strict()` and parses records read from DynamoDB, which carry `environmentDigest`.
- The preparation manifest is a plain interface the worker reads from disk, so old manifests simply keep an extra key.

## Constitution Check (v2.0.0)

- **I, III:** Unchanged; no orchestration or ownership behaviour moves.
- **II:** Registration stays administrator-only and revisions stay immutable. What a revision contains gets smaller.
- **IV:** Durable state is untouched. Removing the digest comparison removes a check that could only ever fail spuriously, since the value never selected the running image.
- **V:** The worker image stays pinned by digest through `AgentXProductionRuntime`'s `WorkerImageUri`, so the release remains reproducible. This spec, plan and tasks, with tests for legacy data and the release window.

## Design

### 1. Contracts

`ProjectDefinitionSchema` loses the four fields. `LEGACY_PROJECT_FIELDS` names them, `legacyProjectFields(value)` reports which a value carries, and `StoredProjectDefinitionSchema` preprocesses them away before the strict parse. `WorkerInvocationSchema` uses the stored variant, so a new worker accepts an old broker's payload. `WorkspaceInstanceSchema` preprocesses `environmentDigest` away, keeping `.strict()` for everything else.

### 2. Broker

Registration reports the retired fields by name before parsing. Workspace creation stops copying the digest, and the three comparisons — resolve, resume and the in-memory registry's workspace check — drop it.

### 3. Worker

`PreparationManifest.environmentDigest` becomes optional and is no longer written or compared, in preparation, publication, maintenance and resume. `verifyWorkspaceResume` loses the parameter.

### 4. Administration client

`packages/cli/src/deployment.ts` loads `~/.agentx/deployment.yaml`, overridable with `--deployment-file`, validated with the same HTTPS rule the project file used. `login` needs no `--project`; `admin project register` reads the project file for its definition only; `admin workspace stop` needs no project at all; `admin slack bind|unbind` takes the project name from `--project`. `loadProjectConfig` reports a file that still carries the retired fields, and its HTTPS check now covers repository URLs only.

## Testing

Contract tests cover the refusal, the stored-definition reader, the workspace record and the release-window invocation. A broker test refuses a registration and then serves a revision that was stored with the fields. A deployment-settings test covers loading, unknown keys, a missing file and the HTTPS rule. A CLI test shows `login` reading the deployment file with no project involved. Manifest fixtures keep a legacy `environmentDigest` so the worker's tolerance is exercised.
