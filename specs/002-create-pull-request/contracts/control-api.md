# Control API Additions

All developer routes use the existing JWT identity and owner-scoped not-found behavior.

## Accept publication

`POST /v1/workspaces/{workspaceId}/pull-requests`

```json
{
  "requestId": "00000000-0000-4000-8000-000000000001",
  "repository": "personal-website",
  "title": "Improve homepage navigation",
  "body": "Summary and validation notes"
}
```

Returns HTTP 202:

```json
{
  "operation": {
    "id": "00000000-0000-4000-8000-000000000002",
    "workspaceId": "00000000-0000-4000-8000-000000000003",
    "kind": "publish",
    "status": "ACCEPTED"
  },
  "duplicate": false,
  "requestId": "gateway-request-id"
}
```

The broker authorizes ownership, requires `READY`, validates the repository against the registered
project revision, acquires the writer fence, records operation/idempotency/outbox atomically, and
generates `agentx/<operationId>`. Duplicates return the original operation; changed payloads conflict.
Polling, event, cancellation, and terminal-result routes are unchanged.

Successful terminal `operation.result`:

```json
{
  "repository": "personal-website",
  "number": 42,
  "url": "https://github.com/example/personal-website/pull/42",
  "headBranch": "agentx/00000000-0000-4000-8000-000000000002",
  "baseBranch": "main",
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "checks": [{ "index": 0, "outcome": "passed", "exitCode": 0 }],
  "reconciled": false
}
```

## Internal push-credential exchange

The existing internal repository-credential exchange adds body field `access: "push"`. The signed
grant must contain that exact access scope. Clone grants cannot be upgraded by the caller.

## Internal pull-request reconciliation

`POST /v1/internal/workspaces/{workspaceId}/operations/{operationId}/pull-request`

Headers: the existing operation callback capability.

Body contains the registered repository name/URL, broker-generated head branch, registered base
branch, commit, title, and optional body. The broker validates the active operation and fence,
mints a PR-only repository token, returns an existing matching open PR or creates one, and emits no
token in its response.

Errors use the existing stable envelope and codes. Check failures and empty diffs are terminal
operation failures; authorization and idempotency errors reject before dispatch.
