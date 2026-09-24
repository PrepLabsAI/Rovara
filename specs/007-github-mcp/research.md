# Research

## Transport and credentials

Use https://api.githubcopilot.com/mcp/ with an installation access token. Reuse the existing
Secrets Manager private key/GitHub App; no personal OAuth. Mint a fresh repository-scoped token
with Issues read/write access. Installation administrators approve permission expansion.

## Discovery, not individual wrappers

Discover names, descriptions and schemas through tools/list. Intersect with administrator
approval, narrow arguments if configured, dynamically register in Pi and forward tools/call
through one generic bridge. Server checks remain authoritative. X-MCP-Tools limits discovery
but is not the authorization boundary. Do not combine broad X-MCP-Toolsets: selection is additive.

Initial example approves issue_read, list_issues, issue_write and add_issue_comment.
list_issues uses cursors and uppercase states. issue_write replaces the assignee list; native
semantics are preserved, not wrapped. The model reads existing assignees when adding people
and verifies afterward; GitHub can omit ineligible users. MCP isError is failure even over HTTP
200; attempted writes conservatively become UNKNOWN.

GitHub issue APIs also accept PR numbers. A provider-level preflight requires the canonical
issue URL for issue_number arguments, protecting separate AgentX PR workflows.

## Reliability and limits

Claim writes before execution and retain final/uncertain outcomes. Exactly-once external
execution is not guaranteed after process/network failure. No automatic uncertain-write retry
or reconnect/replay. Fresh clients/tokens isolate requests. Definition hashes fail closed on
schema or policy drift. Only repository-scoped object schemas requiring owner/repo are initially
supported. Other schemas/permission families need explicit policy extensions, not action wrappers.

## Sources

- [Policies and governance](https://github.com/github/github-mcp-server/blob/main/docs/policies-and-governance.md)
- [Host integration](https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md)
- [Server configuration](https://github.com/github/github-mcp-server/blob/main/docs/server-configuration.md)
- [Native issue tools](https://github.com/github/github-mcp-server/blob/main/pkg/github/issues.go)
- [Issue assignees](https://docs.github.com/en/rest/issues/assignees#add-assignees-to-an-issue)

Documented support is not proof of live authentication with the AgentX installation.
