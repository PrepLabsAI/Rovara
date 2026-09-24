# GitHub MCP API

Hosted Slack calls both routes under /v1/service/workspaces/{workspaceId}/github/... using
SigV4, the configured orchestrator IAM role and signed Slack thread/requester headers. The broker
checks the channel binding, thread workspace ownership, bound project and project membership.
The existing JWT routes remain for compatibility; a personal identity cannot access a Slack workspace.
The server loads the workspace's pinned registered project revision and githubMcp policy.

The hosted service resolves its workspace with POST /v1/service/threads/workspace and
includeIntegrations:true. Enabled responses include githubMcpRepositories, derived only from the
registered definition. Disabled projects omit it. Older clients omit the flag and receive the
original strict response shape, allowing broker-first rolling deployment.

## Discover

GET /v1/workspaces/{workspaceId}/github/tools?repository={registeredAlias}

Returns { catalog: GitHubMcpCatalogSchema, requestId: HTTP trace ID }, derived from tools/list and intersected with project approvals.
Descriptions/schemas come from MCP, narrowed by administrator argument restrictions. Owner/repo
are bound to the registered alias. Unsupported routing schemas are not exposed.

## Call

POST /v1/workspaces/{workspaceId}/github/call

GitHubMcpRequestSchema: requestId, repository, tool, schemaHash, arguments.
No endpoint/token/owner/repo override. The server obtains credentials, rediscovers and validates
the tool definition and arguments, injects owner/repo and invokes tools/call.

Returns { result: GitHubMcpResultSchema, requestId: HTTP trace ID }; result.requestId is the stable
invocation UUID, distinct from the transport trace ID. Upstream failure/unknown writes are explicit statuses even over
HTTP 200. Same write ID/inputs replay the stored result; changed inputs return IDEMPOTENCY_CONFLICT.
Cross-owner/missing resources return NOT_FOUND; disabled/unapproved tools return FORBIDDEN.
Invalid outer requests return CONFIG_INVALID.

Neither route dispatches a worker or locks a checkout. The internal MCP client is not an
arbitrary-endpoint proxy.

Hosted execution records contain requestedBy:{teamId,userId}, derived from the authenticated
service context, for reads and writes. Replays under a different requester are rejected. Invocation
UUIDs derive from the Slack event sequence, not ephemeral model tool-call IDs.
