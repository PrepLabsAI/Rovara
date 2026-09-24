# GitHub MCP API

Both routes require AgentX JWT authentication, workspace ownership and project membership.
The server loads the workspace's registered project revision and githubMcp policy.

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
