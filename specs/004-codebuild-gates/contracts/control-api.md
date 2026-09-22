# Internal Control API Contract

## Start a configured build gate

`POST /v1/internal/workspaces/{workspaceId}/operations/{operationId}/codebuild`

Headers: existing `x-agentx-callback-capability`.

Body:

```json
{
  "action": "start",
  "repository": "website",
  "gate": "browser",
  "projectName": "agentx-personal-website-browser",
  "commit": "40-to-64-lowercase-hex"
}
```

Response: normalized build evidence with an `IN_PROGRESS` or terminal status.

## Observe a configured build gate

Same route and authentication.

```json
{
  "action": "status",
  "repository": "website",
  "gate": "browser",
  "projectName": "agentx-personal-website-browser",
  "commit": "40-to-64-lowercase-hex",
  "buildId": "agentx-personal-website-browser:uuid"
}
```

The broker rejects fields or values outside the immutable publication operation, registered repository, and configured gate. Neither request supports build overrides.
