# Service API Contract

Existing signed Slack service identity applies. The broker derives the project from channel binding.

## `GET /v1/service/project/models`

Returns `{ projectName, approved, current, source }`, where source is `selection` or `default`. A project without model policy returns `CONFIG_INVALID` with administrator guidance.

## `PUT /v1/service/project/model`

Accepts `{ provider, modelId }`. The broker revalidates against the latest list, writes updater/time, and returns the effective model response. A disallowed pair makes no write.

## Worker task extension

The task payload optionally carries `model: { provider, modelId }` and bounded `modelSelectionDiagnostic`. Both fields are optional for rolling compatibility.
