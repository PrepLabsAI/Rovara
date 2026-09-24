# Contract: Connector Routes

All workspace routes accept the existing SigV4 service identity with signed Slack thread and
requester headers, and enforce channel binding, thread ownership, bound project and project
membership before any connector work. Policy comes from the project's latest registered revision.

## Discover

`GET /v1/workspaces/{workspaceId}/connectors/{connector}/tools`

Returns `{ catalog: { connector, tools: [CatalogEntry], skipped: [{ tool, reason }] }, requestId }`.
`CatalogEntry` is `{ name, upstreamName, description, inputSchema, schemaHash, access }`.
Served from the catalog cache when fresh. A connector that is approved but not connected returns
`{ catalog: { connector, notConnected: true, tools: [], skipped: [] } }` with HTTP 200
(`ConnectorCatalogSchema` requires `skipped` on every catalog, including this one).

## Call

`POST /v1/workspaces/{workspaceId}/connectors/{connector}/call`

Body: `{ requestId: uuid, tool: presentedName, schemaHash, arguments }`, strict. `arguments` at
most 65,536 serialized characters and never containing bound properties.

Returns `{ result: { requestId, status, reason?, text, truncated, replayed }, requestId }`.
`status` in `SUCCEEDED | FAILED | UNKNOWN | IN_PROGRESS`. `reason` in
`not_connected | policy_denied | schema_changed | vendor_error` when `FAILED`.

Errors: disabled or unapproved tool `FORBIDDEN`; unknown workspace, connector or foreign replay
`NOT_FOUND`; same request ID with different inputs `IDEMPOTENCY_CONFLICT`; malformed body
`CONFIG_INVALID`.

## Aliases (one release)

`GET /v1/workspaces/{id}/github/tools?repository=<alias>` and `POST /v1/workspaces/{id}/github/call`
are served by the `github` connector. Requests and responses keep the feature 007 shapes (one
catalog per `repository` query, owner and repo removed from schemas, no `reason` on the result).
The `github_<tool>_<hash>` naming belongs only to an older Slack service's own local bridge, which
hashes a name from that feature 007 catalog the way the retired `mcp-tools.ts` used to; the broker
never generates or returns that name itself. The new `/connectors/{connector}/tools|call` route
above returns the already-presented name (for example `github__list_issues`), built server-side by
`presentCatalog`, and an upgraded Slack service registers that name with the model directly.

## Workspace resolution

`POST /v1/threads/workspace` with `includeConnectors: true` adds `connectors` and `repositories` as
described in [data-model.md](../data-model.md). `includeIntegrations: true` alone (without
`includeConnectors`) still returns only the feature 007 `githubMcpRepositories` field; the two flags
are independent, and an older Slack service that only ever sends `includeIntegrations: true` never
receives `connectors` or `repositories`.

## Administration

| Route | Purpose |
|---|---|
| `POST /v1/admin/credentials` | Register or replace a credential record |
| `GET /v1/admin/credentials` | List credential records |
| `GET /v1/admin/turns?since=<ISO>&cursor=<c>` | Page turn records for export, newest first |

All require the administrator claim. Turn export is read-only and paginated at 100 records.
