# Tasks: Discovered GitHub MCP tools

## Phase 1: Setup

- [X] T001 Record revised discovery-based scope and constitution amendment in specs/007-github-mcp/ and .specify/memory/constitution.md.
- [X] T002 Pin MCP SDK in packages/broker/package.json and package-lock.json.

## Phase 2: Foundation

- [X] T003 Add strict policy/catalog/generic-call/result schemas in packages/contracts/src/github-mcp.ts and project opt-in.
- [X] T004 Add repository-scoped Issues read/write token generation in packages/broker/src/github-app.ts and credential tests.

## Phase 3: US1 - Discover and read tools

- [X] T005 [US1] Test policy intersection, future tools, schema drift, narrowing and binding in tests/contract/github-mcp.test.ts.
- [X] T006 [US1] Implement bounded discovery/calls in packages/broker/src/mcp-client.ts and schema/policy enforcement in packages/broker/src/github-mcp.ts.
- [X] T007 [US1] Add authorized routes in packages/broker/src/aws/broker.ts and tests/contract/github-mcp-broker.test.ts.
- [X] T008 [US1] Dynamically register schemas through packages/cli/src/mcp-tools.ts; wire orchestration-tools.ts, orchestrator.ts, control-plane-api.ts and main.ts without individual wrappers.

## Phase 4: US2 - Execute native writes

- [X] T009 [US2] Test duplicate/conflict/unknown outcomes and native assignment in tests/contract/github-mcp.test.ts.
- [X] T010 [US2] Implement invocation service and DynamoDB storage in packages/broker/src/github-mcp.ts and packages/broker/src/aws/github-mcp.ts.
- [X] T011 [US2] Verify SDK protocol exchange, pagination, filtering, credentials and no retry in tests/integration/github-mcp.test.ts.

## Phase 5: Validation and documentation

- [X] T012 Document dynamic policy, setup, limits and unchanged AgentX PR tools in README.md and specs/007-github-mcp/quickstart.md.
- [X] T013 Run build, lint, all tests and infrastructure synthesis; record evidence/live limits in specs/007-github-mcp/quickstart.md.

## Dependencies

Setup -> foundation -> US1 -> US2 -> validation. Read/write tools use one generic bridge.
Existing projects expose only the original AgentX tools. No deployment/live mutation is authorized.
