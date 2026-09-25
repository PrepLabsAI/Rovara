# Research: Connector Gateway

Checked 2026-09-23 and 2026-09-24. Documented support is not proof of live authentication with
AgentX credentials; each connector's live check is in `quickstart.md`.

## Vendor authentication for a headless broker

| Vendor | Endpoint | Non-interactive credential | Caveats |
|---|---|---|---|
| GitHub | `https://api.githubcopilot.com/mcp/` | GitHub App installation token (live in AgentX since feature 007) | `X-MCP-Tools` pre-filters discovery but is not an authorization boundary |
| Linear | `https://mcp.linear.app/mcp` | "The MCP server supports passing OAuth token and API keys directly in the `Authorization: Bearer <yourtoken>` header"; can act "as an `app` user" or through a read-only restricted API key | Client-credentials tokens act as the application, cover public teams, last 30 days with no refresh token; requesting a different scope set revokes the application's existing tokens |
| Atlassian (Jira) | `https://mcp.atlassian.com/v2/mcp` | Service-account API key as `Authorization: Bearer` | "Authentication via API token must be enabled by your organization admin"; code-search and Teams tools require OAuth 2.1; calls need `cloudId` |
| Asana (deferred) | `https://mcp.asana.com/v2/mcp` | None documented; "you'll be prompted to authorize the application" | OAuth access tokens last about an hour; refresh tokens last while the user keeps the authorization |

Checked 2026-09-24: client-credentials tokens are app actor tokens with access to all public
teams; AgentX uses a team-restricted API key.

Sources: [Linear MCP](https://linear.app/docs/mcp),
[Linear OAuth](https://linear.app/developers/oauth-2-0-authentication),
[Atlassian API-token guide](https://developer.atlassian.com/cloud/rovo-mcp/guides/configuring-authentication-via-api-token/),
[Atlassian authentication](https://support.atlassian.com/atlassian-rovo-mcp-server/docs/authentication-and-authorization/),
[Asana MCP](https://developers.asana.com/docs/using-asanas-model-control-protocol-mcp-server),
[Asana OAuth](https://developers.asana.com/docs/oauth),
[GitHub remote server](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md).

## Build, buy or adopt

No self-hostable project replicates a managed agent-integration layer end to end. Merge Agent
Handler is SaaS with on-premises only at Enterprise. Nango's free self-hosted edition covers
authentication and proxying under the Elastic License. Composio and Arcade have closed engines.
MCP gateways (agentgateway, ToolHive, ContextForge, Obot) cover routing and policy but duplicate
the control plane and bring Kubernetes or Python services. AgentCore Identity is the candidate for
per-user OAuth later. Decision: compose vendor MCP servers with an in-broker gateway.

## Tool selection

- Merge Agent Handler does not publish selection accuracy. Its mechanisms are small curated Tool
  Packs, per-pack description overrides, pinned input values, a `search_tools` meta-tool, an
  evaluation suite comparing expected and actual tool calls, and call logs that omit the tools a
  turn was offered. ([Tool Packs](https://docs.merge.dev/merge-agent-handler/build/tools/tool-packs),
  [description overrides](https://docs.merge.dev/merge-agent-handler/build/tools/tool-description-overrides),
  [MCP integration](https://docs.merge.dev/merge-agent-handler/implementation-guides/mcp-integration),
  [logs](https://docs.merge.dev/merge-agent-handler/observe/tool-call-logs))
- Selection degrades with tool count: Anthropic cites degradation beyond 30–50 tools; OpenAI
  suggests fewer than 20 at the start of a turn; GitHub reduced Copilot's default tools from about
  40 to 13 and improved benchmark results.
  ([Anthropic](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool),
  [OpenAI](https://developers.openai.com/api/docs/guides/function-calling),
  [GitHub](https://github.blog/ai-and-ml/github-copilot/how-were-making-github-copilot-smarter-with-fewer-tools/))
- Descriptions are load-bearing: state when and when not to use a tool, name the competing tool,
  namespace by service, consolidate near-duplicate operations behind an action argument, and avoid
  asking the model for values the server already knows.
  ([Anthropic, define tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools),
  [Anthropic, writing tools](https://www.anthropic.com/engineering/writing-tools-for-agents))
- Anthropic's native deferred tool loading is not available through the Bedrock Converse API that
  Pi uses, so progressive disclosure would be AgentX's own; with a 20-tool budget it is not needed.

## Pi runtime facts relied on

- `ToolDefinition` sends `name`, `description` and `parameters` to the model; `label` is UI only.
- Extensions can observe `tool_execution_start`, `tool_execution_end`, `turn_end` and
  `agent_end`, and can change the active tool set with `setActiveTools`.
- An unknown tool name is answered with `Tool <name> not found` before `tool_call` handlers run,
  so a hook cannot redirect retired names.

## Schema shapes

Feature 007 skips any tool whose schema uses `$ref`, `allOf`, `anyOf`, `oneOf` or
`patternProperties`. GitHub's issue tools avoid them; vendor schemas generated from typed SDKs
commonly use `$ref`/`$defs`. Dereferencing and merging `allOf` before narrowing keeps those tools;
`oneOf` across different object shapes remains unsupported.
