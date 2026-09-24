# Implementation Plan: Discovered GitHub MCP tools

**Date**: 2026-09-23 | **Spec**: [spec.md](spec.md)

## Summary

Connect the control plane to GitHub MCP and register tools dynamically from upstream discovery.
Administrators approve native tool names, access level, optional argument allowlists and value
restrictions. AgentX does not implement individual list/read/create/comment/assign wrappers.

## Technical Context

- TypeScript 5.9, Node 22, existing npm workspaces; MCP SDK pinned to 1.30.1.
- Streamable HTTP to the server-owned GitHub endpoint; bounded pagination and response size.
- Existing Secrets Manager GitHub App key; fresh repository-scoped Issues read/write token.
- Control plane owns discovery, authorization, schema validation, credentials and write records.
- Pi receives only approved descriptions/schemas through a single generic bridge.
- DynamoDB conditional writes; no additional AWS services or worker dispatch.
- Complete external exchange bounded to 20 seconds; no automatic write retries.

## Constitution Check

Principle I amended to 1.3.0 to permit approved third-party issue tools through the authenticated
control plane. Coding and PR publication remain on existing AgentX paths. Initial configuration
approves issue tools only; other permission families require a separate policy extension.

## Project Structure

- packages/contracts/src/github-mcp.ts: policy, catalog, generic request/result contracts.
- packages/broker/src/mcp-client.ts: reusable SDK transport and paginated discovery.
- packages/broker/src/github-mcp.ts: schema narrowing, repository binding, validation, durable invocation.
- packages/broker/src/aws/github-mcp.ts: DynamoDB invocation store.
- packages/broker/src/aws/broker.ts: authorized discovery and call routes.
- packages/broker/src/github-app.ts: repository-scoped Issues credentials.
- packages/cli/src/mcp-tools.ts: single dynamic Pi registration/forwarding bridge.
- Existing orchestrator, API client, main and project contract: opt-in wiring.
- tests/contract/github-mcp*.test.ts and tests/integration/github-mcp.test.ts: behavior/protocol tests.

## Execution

Discover approved tools at orchestrator startup; rediscover before execution and reject schema/policy
changes using a definition hash. Register deterministic names per repository/upstream tool. Bind
owner/repo outside model arguments. Validate against both narrowed and upstream schemas.

Only plain object schemas requiring owner/repo are supported initially. Unsupported routing
shapes are omitted. A provider-level issue-number preflight rejects PR targets because GitHub
issue endpoints also accept PR numbers. This scope guard is not an issue action implementation.

Claim writes before execution; scope durable records to workspace/owner/request ID. Never replay
ambiguous writes. Forward native assignment semantics unchanged: the model reads existing assignees
when asked to add someone and verifies the result. No custom assignment wrapper.

## Hosted Slack correction

Return optional enabled repository aliases from thread-workspace resolution, sourced from its pinned
project revision. Carry those through processor TurnInput into a testable hosted runtime factory.
Move MCP routing into the common authenticated workspace router so existing SigV4 service requests
reach the same policy enforcement. Check bound project in addition to thread ownership and membership.
No new IAM permissions or public unauthenticated endpoints are required.
The service opts into response metadata with includeIntegrations:true so older strict clients
continue to work while the broker-first deployment replaces the ECS service.

Use the Slack event-derived request-ID sequence for MCP tools, retaining call-ID memoization within
a turn. Persist requesting Slack user for every tool invocation (including reads); reject replay under
a different requester. Test signed transport, real Pi registration, thread-scoped routes, disabled
policy, redelivery and native execution. Update the smoke-test guide to use Slack only.
