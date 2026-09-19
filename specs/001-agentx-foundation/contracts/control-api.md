# Authenticated Control API v1

Base URL comes from registered project config. All requests require verified identity.
`issuer + subject` determines the owner. The server loads project membership and instance
ownership for every route, including events and artifact downloads. Unknown or unauthorized
instance IDs return the same `NOT_FOUND` response. Reject extra identity/routing fields.

| Method/path | Input | Behavior |
|---|---|---|
| POST /v1/admin/projects | definition, runtimeBinding | Register immutable revision and deployed runtime binding; admin only |
| POST /v1/admin/workspaces/prepare | projectName, projectRevision, ownerSubject, requestId | Prepare private instance; admin only |
| GET /v1/projects/{project}/workspace | None | Resolve caller's default prepared instance |
| POST /v1/workspaces/{id}/conversations | requestId | Create new history, preserve files |
| POST /v1/workspaces/{id}/tasks | requestId, conversationId, prompt | Accept once, or conflict/busy |
| GET /v1/workspaces/{id}/operations/{operation} | None | Durable operation status/result |
| GET /v1/workspaces/{id}/operations/{operation}/events | cursor, limit | Ordered events and next cursor |
| POST /v1/workspaces/{id}/operations/{operation}/cancel | requestId | Cooperatively cancel existing run |
| POST /v1/admin/workspaces/{id}/stop | requestId | Stop idle compute and retain data |
| GET /v1/workspaces/{id}/artifacts/{artifact} | None | Authorized short-lived object download |

Accepted mutations return HTTP 202 with `operationId`, `status`, and polling location.
Idempotent duplicates return the same operation. Reusing a key for another payload yields 409.
Task acceptance requires READY plus a conditional writer lock and durable outbox record.
Event pages default to 100 entries and permit 1–500. Expired/invalid cursors produce a defined
error and a status refresh path rather than replaying the task.

`runtimeBinding` contains the runtime ARN, endpoint qualifier and deployment mode, plus a
capacity-provider ARN only for `instances-ebs`. It is accepted only on the administrator route,
stored as trusted project state, and omitted from developer responses. The administrator names a
target OIDC subject during preparation; the broker derives the owner key using the configured
issuer and grants that subject developer membership for the project.

Error body: `{"error":{"code":"WORKSPACE_BUSY","message":"...","requestId":"..."}}`.
Codes include CONFIG_INVALID, AUTH_REQUIRED, FORBIDDEN, NOT_FOUND, PROJECT_REVISION_MISMATCH,
WORKSPACE_NOT_READY, WORKSPACE_BUSY, IDEMPOTENCY_CONFLICT, RUNTIME_UNAVAILABLE, OPERATION_INTERRUPTED.

## Internal callbacks

Worker callbacks post batches of events, heartbeats and terminal results to an internal broker
route using a short-lived signed capability bound to workspace, operation, fence and allowed
actions. The broker validates capability, active operation and fence before writes or renewing
the capability. No arbitrary DynamoDB/S3 access is granted to the coding process. Artifact
uploads use object-specific grants obtained through the same capability.

State-changing broker operations use conditional DynamoDB writes. Task acceptance creates the
operation, idempotency record and outbox entry while acquiring the workspace writer fence in one
transaction. DynamoDB Streams publishes pending outbox entries to SQS; the dispatcher alone may
invoke the registered AgentCore runtime with the stored server-owned runtime session ID.

## Reconnect

The client stores only display IDs and event cursors locally. The server reauthorizes them on
every request. Status retrieval works without starting a coding worker; submitting follow-up
to a stopped instance explicitly resumes compute before the task becomes runnable.
