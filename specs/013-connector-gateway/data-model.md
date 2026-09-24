# Data Model: Connector Gateway

## Connector (project definition)

Part of the immutable registered revision under `integrations.connectors` (1..8 entries).

| Field | Type | Rules |
|---|---|---|
| `name` | string | `^[a-z][a-z0-9-]{0,19}$`, unique in the project; becomes the tool prefix |
| `type` | enum | `github` (phase 1b), `linear` (phase 5), `jira` (phase 6); others refuse registration |
| `credentialRef` | string | Resolves through the credential registry; absent for `github`, which uses each repository's GitHub App reference |
| `identity` | enum | `service` (default, only value accepted in v1) |
| `attribution` | boolean | Default `true` |
| `scopes` | list or `all-repositories` | 1..32 scopes; `all-repositories` only for `github` |
| `tools` | list | 1..32 approvals, unique by `name` |

**Scope** — `{ alias, ...bindings }`. `alias` follows the AgentX name pattern and is unique per
connector. Bindings by type:

- `github`: `scopes` is `all-repositories` or a list of registered repository names; each
  repository is a scope aliased by its name. A name that is not registered refuses registration.
- `linear`: `teamId` (Linear team UUID).
- `jira`: `cloudId` (Atlassian site UUID), `projectKey` (optional, `^[A-Z][A-Z0-9_]{1,9}$`).

**Tool approval** — feature 007 fields plus presentation fields:

| Field | Type | Rules |
|---|---|---|
| `name` | string | Upstream tool name, `^[a-zA-Z0-9_-]{1,64}$` |
| `access` | enum | `read` or `write`; administrator-trusted, MCP annotations are not authority |
| `allowedArguments` | string[] | Optional, as feature 007 |
| `argumentValues` | record | Optional, as feature 007 |
| `description` | string | Optional override, at most 1,024 characters |
| `examples` | object[] | Optional, at most 3, each valid against the narrowed schema |

**Legacy** — `integrations.githubMcp` reads as
`{ name: "github", type: "github", scopes: "all-repositories", tools: <policy tools> }` (resolved by
`githubConnectorOf`).
Both keys together refuse registration.

## Credential record (control-plane state)

`pk = CREDENTIAL#<ref>`, `sk = META` in the state table.

| Field | Rules |
|---|---|
| `ref` | AgentX name pattern |
| `type` | `github-app`, `static-secret`, `oauth-client-credentials`; reserved: `oauth-refresh-token`, `per-user` |
| `secretName` | Must begin `agentx/connectors/`, except the built-in GitHub App entry |
| `registeredBy`, `registeredAt` | Administrator identity and time |

Secret payloads: `static-secret` → `{ "apiKey": "…" }`;
`oauth-client-credentials` → `{ "clientId", "clientSecret", "scopes": ["…"] }`. The token endpoint
comes from the connector type in code, never from the secret, so a secret cannot redirect the broker.
The built-in `github-app` entry is synthesized from the existing `GitHubApp*` stack parameters.

**Minted token cache** — `pk = CREDENTIAL#<ref>`, `sk = TOKEN#<scopeHash>`, fields `token`
(the table is encrypted at rest; no route returns this item), `expiresAt`, TTL at `expiresAt`. Only
`oauth-client-credentials` writes it.

## Catalog entry (cached, not durable)

Held in memory per broker container, keyed by project, revision, connector and scope; 10-minute
time-to-live, at most 256 entries; a failed call deletes its entry.

| Field | Notes |
|---|---|
| `presentedName` | `<connector>__<tool>` |
| `upstreamName` | Native tool name |
| `description` | Assembled per FR-017 |
| `inputSchema` | Flattened, narrowed, bound properties removed, `target` added when scopes > 1 |
| `schemaHash` | SHA-256 over upstream definition, approval and connector scopes |
| `access` | `read` or `write` |
| `skipped` | List of `{ tool, reason }` for preflight and metrics |

## Invocation (ledger)

Feature 007 record, generalized. Key `pk = WORKSPACE#<workspaceId>`,
`sk = CONNECTOR#<name>#<requestId>` (`entityType` `CONNECTOR_INVOCATION`), except the `github`
connector, which keeps `sk = GITHUB_MCP#<requestId>` and `entityType` `GITHUB_MCP_INVOCATION`.
Adds `connector`. Status set unchanged:
`IN_PROGRESS`, `SUCCEEDED`, `FAILED`, `UNKNOWN`. `FAILED` results may carry
`reason: not_connected | policy_denied | schema_changed | vendor_error`.

## Workspace resolution additions

The thread workspace response adds, for clients sending `includeIntegrations: true`:

- `connectors`: `[{ name, type, label, scopes: [alias], connected: boolean }]`, from the latest
  registered revision and the credential registry.
- `recoverableOperations`: IDs of non-terminal operations started by this thread, at most 5.

`githubMcpRepositories` remains for one release.

## Turn record

Table `TurnRecords` in `AgentXControlPlane`. `pk = THREAD#<subject>`,
`sk = TURN#<ISO time>#<eventId>`, TTL 30 days. Written once per Slack event with a condition on
absence.

| Field | Notes |
|---|---|
| `eventId`, `requestedBy`, `project`, `settingsRevision`, `workspaceId`, `conversationId` | Identity and routing |
| `model` | `{ provider, modelId }` |
| `startedAt`, `finishedAt`, `durationMs` | Timing |
| `manifestHash` | SHA-256 of the capabilities manifest |
| `offeredTools` | `[{ name, descriptionHash }]` in presentation order |
| `requestText` | At most 40,000 characters |
| `responseText` | At most 40,000 characters |
| `calls` | `[{ name, connector?, arguments, argumentsFingerprint, validation, outcome, reason?, durationMs, requestId?, operationId? }]`; `arguments` redacted and capped at 2,048 characters each |
| `validation` | `ok`, `schema_error`, `policy_denied`, `unknown_tool` |
| `outcome` | `SUCCEEDED`, `FAILED`, `UNKNOWN`, `IN_PROGRESS` |
| `stopReason`, `emptyResponse` | From the final assistant message |
| `usage` | `TaskUsageTelemetry` (feature 011 shape) for the orchestrator's own session |
| `workerOperations` | Operation IDs started by the turn, joinable to worker `usage` events |
| `error` | `{ name, code? }` when the turn failed |
