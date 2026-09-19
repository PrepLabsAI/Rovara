# Control API Contract

## Create pull request

Existing `POST /v1/workspaces/{workspaceId}/pull-requests` remains compatible. Its worker now publishes a one-commit branch based on the latest remote default branch.

## Lifecycle action

`POST /v1/workspaces/{workspaceId}/pull-request-actions`

```json
{
  "requestId": "uuid",
  "repository": "personal-website",
  "pullRequestNumber": 12,
  "action": "append | sync | edit | close | reopen | replace | revert",
  "title": "optional title",
  "body": "optional markdown"
}
```

Response for worker-backed actions is `202` with `{ operation, duplicate, requestId }`. Broker-only metadata/state actions return the same operation envelope already in terminal `SUCCEEDED` state. Reusing a request ID with another payload returns `IDEMPOTENCY_CONFLICT`.

Authorization requires authenticated ownership of the workspace, project membership, registered repository selection, and a durable AgentX pull-request record for that workspace/repository/number.

## Worker callbacks

Existing callback capabilities gain a `pull-request-update` action for a worker to report an expected non-force head transition. Create/replace/revert continue to use `pull-request` creation reconciliation.

Callback payloads include repository identity, PR number, expected old head, new head, action, and readiness evidence. Values outside the accepted operation scope are rejected.
