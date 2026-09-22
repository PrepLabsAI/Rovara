# Implementation Plan: CodeBuild Publication Gates

## Summary

Add administrator-approved CodeBuild gates to repository definitions. The worker pushes a candidate, requests builds through a scoped broker callback, polls bounded status, and creates or advances a pull request only after every build succeeds. AWS credentials and CodeBuild APIs remain in the broker.

## Technical Context

- TypeScript 5.9 / Node.js 22 monorepo
- Zod contracts shared by CLI, broker, and worker
- AWS Lambda broker backed by DynamoDB
- Bedrock AgentCore remote worker with persistent session storage
- AWS SDK v3 CodeBuild client
- Vitest integration and contract tests; AWS CDK infrastructure assertions

## Constitution Check

- Local Pi remains an orchestrator and performs no coding or cloud build execution.
- Registered project revisions remain immutable and administrator-managed.
- Developer workspaces and operation fences remain isolated.
- CodeBuild state is durable and retries are idempotently reconciled.
- The worker receives a narrowly scoped capability, never AWS or GitHub credentials.
- Publication returns verifiable readiness and external build evidence.

## Design

1. Extend each repository definition with optional `codeBuildGates`.
2. Extend publication result contracts with `codeBuildChecks`.
3. Add a broker-side CodeBuild gateway and operation-scoped callback action.
4. Persist one gate record per operation/gate in the existing state table.
5. Add a worker client that starts gates sequentially, polls with bounded backoff, and verifies terminal success plus resolved source revision.
6. Run gates after candidate push but before PR creation. For existing PRs, push a separate validation branch first and fast-forward the PR branch only after success.
7. Grant the broker least-privilege CodeBuild access to `agentx-*` project ARNs.
8. Document administrator project setup and repository buildspec ownership.

## Project Structure

- `packages/contracts/src/project.ts`: gate configuration
- `packages/contracts/src/operation.ts`: build evidence
- `packages/broker/src/codebuild.ts`: AWS boundary and response normalization
- `packages/broker/src/aws/broker.ts`: authorization, durable records, callbacks
- `packages/worker/src/codebuild.ts`: capability client and polling
- `packages/worker/src/publish.ts`: new-PR ordering
- `packages/worker/src/maintain-pull-request.ts`: validation-ref ordering
- `infra/lib/control-plane.ts`: IAM policy
- `tests/contract/`: schema, callback, AWS adapter, and IAM tests
- `tests/integration/`: publication ordering tests

## Complexity Tracking

The temporary validation ref for existing PR updates is necessary because CodeBuild must fetch a remote commit while the visible PR head must remain unchanged on failure. It does not require force push or branch deletion.
