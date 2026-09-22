# Data Model: CodeBuild Publication Gates

## CodeBuildGateDefinition

- `name`: repository-local AgentX name
- `projectName`: approved AWS CodeBuild project name beginning with `agentx-`
- `timeoutMinutes`: integer from 5 through 420; all repository gate timeouts total at most 420

Definitions are part of an immutable registered project revision. Gate names and project names are unique per repository.

## CodeBuildCheckResult

- `gate`: configured gate name
- `projectName`: configured CodeBuild project
- `buildId`: AWS build identifier
- `status`: `SUCCEEDED`, `FAILED`, `FAULT`, `STOPPED`, or `TIMED_OUT`
- `requestedSourceVersion`: candidate Git commit
- `resolvedSourceVersion`: source revision reported by CodeBuild when available
- `currentPhase`: sanitized CodeBuild phase when available
- `startedAt`, `completedAt`: ISO timestamps when available
- `logsUrl`: HTTPS CloudWatch Logs deep link when available

## DurableCodeBuildRecord

Partition: `WORKSPACE#<workspace-id>`

Sort key: `CODEBUILD#<operation-id>#<gate-name>`

Additional attributes: operation ID, fence, repository, gate definition, requested commit, deterministic idempotency token, build ID, latest evidence, and timestamps.

## State Transitions

`REQUESTED -> IN_PROGRESS -> SUCCEEDED | FAILED | FAULT | STOPPED | TIMED_OUT`

The broker only persists states returned by CodeBuild. Terminal records are immutable except for idempotent reads. A source mismatch is treated by the worker as a failed publication even if CodeBuild reports success.

## Relationships

- One registered repository has zero to eight gate definitions.
- One publication operation targets one repository and candidate commit.
- One operation has at most one durable record for each configured gate.
- One pull-request result contains the terminal evidence for every executed gate.
