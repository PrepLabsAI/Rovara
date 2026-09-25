# Contract: Connector Routes

All workspace routes accept the existing SigV4 service identity with signed Slack thread and
requester headers, and enforce channel binding, thread ownership, bound project and project
membership before any connector work. Policy comes from the project's latest registered revision.

One discovery route and one call route serve every connector type the project configures; the
`{connector}` path segment names the entry, and the route resolves its type to decide how to reach
it. A type this deployment does not know, or a stored entry it cannot parse, was already skipped
when the revision's connectors were resolved, so it answers `NOT_FOUND` like any other unknown name.

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

`includeConnectors: true` alone lists only `github` connectors, because an older Slack service
parses the list with a schema that still requires that literal type. Sending
`includeAllConnectorTypes: true` as well adds every other resolved connector to the list, in
definition order. A service that cannot yet parse other connector types must not send this flag.

## Registration preflight

`POST /v1/admin/projects` (feature 001) accepts an added body field, `preflight: true`. It asks
each connector's vendor, at registration, which of its approved tools it can actually offer.
Preflight never blocks registration on that check failing, and it runs only when the field is
sent, so an older administration client, or an existing test that posts a plain registration body,
never makes a vendor call.

When it runs, the response adds `preflight`: `{ connectors: [{ name, status, problem?, offered,
skipped }] }`. `status` is `connected`, `not_connected` (no working credential, or the vendor
rejected it) or `unavailable` (discovery failed for another reason, reported so registration is
never blocked on it). `problem` is set for the two failing statuses. `offered` lists the tool
names the vendor actually presented; `skipped` lists `{ tool, reason }` for each approved tool it
could not present.

The response always includes `tools`: `{ maximum, warnAbove: 20, limit: 40 }`. `maximum` is the
most tools the model could see for this project (six built-in plus every connector approval).
`warnAbove` and `limit` are the fixed thresholds below, sent so a client never has to hardcode
them.

Independently of `preflight`, the response adds `warnings` whenever it is non-empty: one line if
the project could expose more than 20 tools to the model (six built-in plus every connector
approval; this needs no vendor call, so it appears whether or not preflight ran), one line per
connector reported `not_connected` or `unavailable`, and one line per skipped tool.

A project that could expose more than 40 tools, or whose presented name (`<connector>__<tool>`)
exceeds 64 characters, refuses registration outright, naming the count or the tool; both checks
run for a new revision only; a resubmitted, already-registered revision stays idempotent. A
`target` argument collision on a connector with several scopes also refuses a new revision, but
only when preflight ran, because finding it needs the vendor's own tool definitions; without
preflight the same tool is instead reported skipped the first time the connector is used.

## Administration

| Route | Purpose |
|---|---|
| `POST /v1/admin/credentials` | Register or replace a credential record |
| `GET /v1/admin/credentials` | List credential records |
| `GET /v1/admin/turns?since=<ISO>&cursor=<c>` | Page turn records for export, newest first |

All require the administrator claim. Turn export is read-only and paginated at 100 records. Both
credential routes answer `RUNTIME_UNAVAILABLE` when the deployment has no credential configuration.

`POST /v1/admin/credentials` body: `{ ref, type: "static-secret" | "oauth-client-credentials",
secretName }`, strict; `secretName` must begin `agentx/connectors/`. Registration reads the named
secret and checks its shape for `type`, but never echoes it back in the response, an error, or a
log. Response: `{ credential: <list entry>, replaced }`, HTTP 201. Refuses `CONFIG_INVALID` for:
the built-in GitHub App reference (the deployment's `GITHUB_APP_CREDENTIAL_REF`); a secret that
Secrets Manager cannot find, that the broker cannot read or decrypt, or that is scheduled for
deletion (naming only the secret, never the cause); or a secret that does not parse for `type`
(naming the required shape, never its content). A transient Secrets Manager error instead
(throttling, a
service fault) refuses `RUNTIME_UNAVAILABLE`: "could not read secret \<name\> from Secrets Manager;
try again". Re-registering an existing `ref` replaces its record and deletes its cached tokens.

`GET /v1/admin/credentials` response: `{ credentials: [<list entry>] }`, the built-in `github-app`
entry first. A stored record that fails to parse is left out (logged as
`connector.credential_record_invalid`) rather than failing the list. See
[data-model.md](../data-model.md) for the list entry's fields.

`GET /v1/admin/turns?since=<ISO>&cursor=<c>` response: `{ turns: [TurnRecord], cursor?, skipped?,
requestId }`, newest first, at most 100 per page and at most about 4,000,000 bytes of JSON per page,
because Lambda refuses a synchronous response over 6 MB. A page cut short by size carries a `cursor`
that resumes after its last record. `skipped` is present when the page left out stored items that
failed the record schema; the control plane logs their keys as `turn_record.invalid`. `since` is an ISO 8601 time; the CLI turns a duration such
as `7d` into one before sending it. `cursor` is opaque: pass back exactly what the previous page
returned, and treat any other value as invalid. A malformed `since`, or a `cursor` that is not
well-formed, outside the requested `since` window, or otherwise forged, refuses `CONFIG_INVALID`
before any read. A deployment with no turn-record table configured, or a page read that fails,
refuses `RUNTIME_UNAVAILABLE`. Every returned record has had its storage keys removed and gains
`project`, looked up once per distinct workspace on the page from the workspace record (never
stored in the table); a failed lookup leaves `project` off that record rather than failing the
page. A page can come back short, or even empty, and still carry a `cursor`, because expired
records are filtered out after DynamoDB applies its page limit: keep following `cursor` until it is
absent, not until a page has turns in it.
