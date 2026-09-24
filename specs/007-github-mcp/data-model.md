# Data model

- Project: optional integrations.githubMcp.tools, 1..32 unique approvals. Each has a native name,
  trusted read/write classification, optional allowedArguments and argumentValues. Missing policy
  disables the integration. Immutable registered revisions remain authoritative.
- Catalog tool: name, repository alias, upstream description, narrowed inputSchema, schemaHash,
  access. Owner/repo are removed; the server binds them from repository registration.
- Call: UUID requestId, repository alias, native tool, schemaHash, arguments object (maximum
  serialized length 65536). Strict outer schema rejects endpoints/tokens. Arguments must satisfy
  the discovered schema and administrator restrictions.
- Result: requestId, status SUCCEEDED/FAILED/UNKNOWN/IN_PROGRESS, text up to 64000 characters,
  truncated/replayed. MCP success is not proof of every requested postcondition; read back as needed.
- Invocation: workspace, owner, request ID, tool/repository, canonical input fingerprint,
  timestamps and public result. No credentials/raw arguments. Results may contain issue data.
- DynamoDB: WORKSPACE#workspaceId partition, GITHUB_MCP#requestId sort key. Conditional creation
  establishes claim; completion requires matching fingerprint, owner and IN_PROGRESS.
  Terminal/abandoned records never execute again.
- Policy is administrator-trusted. Do not infer access from MCP annotations.
