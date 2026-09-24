# Contract: Slack Workspace Close

All routes are under `/v1/service`, require the configured Slack orchestrator IAM role, and derive the owner from signed `x-agentx-slack-thread` and `x-agentx-slack-user` headers.

## Start or resume close

`POST /v1/service/threads/workspace/close`

Request:

```json
{ "requestId": "uuid" }
```

Response is one of:

```json
{ "outcome": "NOT_FOUND" }
```

```json
{ "outcome": "CLOSED", "workspaceId": "uuid", "closedAt": "ISO-8601" }
```

```json
{
  "outcome": "PREFLIGHT",
  "workspaceId": "uuid",
  "operationId": "uuid",
  "status": "ACCEPTED|DISPATCHING|RUNNING|SUCCEEDED|FAILED|CANCELLED|INTERRUPTED"
}
```

A busy workspace returns `409 WORKSPACE_BUSY`. The endpoint never creates a workspace.

## Complete resource cleanup

`POST /v1/service/threads/workspace/close/complete`

Request:

```json
{ "requestId": "uuid", "operationId": "uuid" }
```

Response:

```json
{
  "outcome": "CLOSED",
  "workspaceId": "uuid",
  "operationId": "uuid",
  "closedAt": "ISO-8601",
  "storageReleased": true
}
```

The broker accepts completion only for the owning thread, a successful safe close preflight, and the current workspace fence. Repeating completion returns the same closed outcome. An already-absent AgentCore session counts as released.

## Existing workspace resolution

`POST /v1/service/threads/workspace` adds this response for a retained tombstone:

```json
{ "outcome": "CLOSED", "workspaceId": "uuid", "closedAt": "ISO-8601" }
```

The hosted Slack processor posts a closed-workspace explanation and does not create a conversation or model turn.

## Worker protocol

The close preflight invocation uses existing invocation base fields and:

```json
{ "kind": "close", "payload": {} }
```

Its successful terminal result conforms to `ClosePreflightResult` from the data model. Unsafe repository state is represented by `SUCCEEDED` with `safeToClose: false`; worker or inspection failures use `FAILED` and never permit deletion.
