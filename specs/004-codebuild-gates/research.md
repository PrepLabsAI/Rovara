# Research: CodeBuild Publication Gates

## Decisions

### Start exact commits with `sourceVersion`

`StartBuild` accepts a commit ID for GitHub sources. AgentX will pass the prepared commit and will not expose any other build override to the worker.

### Use broker-owned AWS access

Only the broker Lambda receives `codebuild:StartBuild` and `codebuild:BatchGetBuilds`. The worker calls an authenticated internal route using its existing fenced capability.

### Consume existing CodeBuild projects

AgentX does not dynamically create projects. Administrators configure source connections, service roles, images, compute, buildspecs, caches, artifacts, and test commands. This makes the repository/team the owner of Playwright and other test semantics.

### Sequential fail-fast gates

Configured gates run in declaration order. This produces deterministic evidence, avoids spending on later builds after an early failure, and is sufficient for the initial integration. Parallel execution can be added without changing the project schema.

### Durable reconciliation plus CodeBuild idempotency

The broker stores one record per operation and gate. A deterministic CodeBuild idempotency token covers the narrow interruption window between AWS accepting `StartBuild` and DynamoDB persistence; subsequent calls reconcile the record.

### Do not implement multi-repository change sets yet

CodeBuild supports secondary sources and batch builds, but current AgentX publish operations own one repository. Testing two unpublished candidate commits and creating multiple PRs atomically needs a higher-level change-set entity and compensation semantics.

## Rejected Alternatives

- Giving the AgentCore worker an AWS role with CodeBuild permission: violates the credential boundary and makes operation scoping harder.
- Starting CodeBuild after PR creation: exposes known-bad PRs and does not meet pre-PR validation.
- Running Playwright directly in AgentCore: duplicates repository CI configuration and couples the coding image to application test infrastructure.
- Updating an existing PR branch before testing: makes failed validations visible and requires a rollback workflow.
- Allowing worker buildspec/image/environment overrides: expands the privilege surface and can disclose secrets configured on the CodeBuild project.
