# GitHub MCP setup and validation

1. Run npm ci, npm run build, npm run lint, and npm test.
2. Add this administrator-owned policy to a new registered project revision. Follow normal
   registration/preparation or migration; existing workspace revisions do not change automatically.

```yaml
integrations:
  githubMcp:
    tools:
      - name: issue_read
        access: read
        argumentValues:
          method: [get, get_comments]
      - name: list_issues
        access: read
      - name: issue_write
        access: write
        allowedArguments: [method, issue_number, title, body, assignees]
        argumentValues:
          method: [create, update]
      - name: add_issue_comment
        access: write
```

3. Enabled repositories must use the deployment's GitHub App credentialRef/account. The installed
   app needs Issues read/write access. Approve expanded installation permissions if needed.
4. Deploy broker and updated CLI through the existing release process. This implementation does
   not perform a deployment.
5. Open the interactive CLI orchestrator; it discovers through the control
   plane. Ask to list/read issues; no coding worker should start.
6. In an explicitly authorized test repository, create an issue, comment and assign a known human.
   Inspect GitHub to verify results; mocks are not live evidence.
7. Replay the same write request ID; verify no duplicate. Test cross-owner/unknown-repository
   denial. UNKNOWN or abandoned IN_PROGRESS writes require inspecting GitHub before a new write.

## What is dynamic?

Names, descriptions and schemas come from discovery. YAML approves/narrows tools, not implementations.
New compatible issue tools require no CLI/broker wrappers. Restart the orchestrator to refresh its
catalog after upstream definition changes; stale hashes fail closed at execution.

Owner/repo are bound server-side, excluded from model inputs. Endpoints/credentials are not accepted
from the model. Native assignment may replace the whole list: read existing assignees when adding
someone and verify afterward. Concurrent external changes are not atomic.

## Current limits

- GitHub-hosted MCP; installation identity, not per-user OAuth.
- Issues permission family; others need an explicit credential-policy extension.
- Plain repository-scoped object schemas requiring owner/repo only.
- Administrator-trusted policy: classify writes correctly; MCP annotations are not authority.
- Existing AgentX coding and PR validation/publication tools unchanged.
- Interactive CLI wired. Mainline retired local Slack; the hosted Slack service and its IAM-authenticated
  routes do not yet expose this integration. Extending that identity boundary is separate work.
- Bounded requests/results, schema size, discovery pagination and upstream duration.

## Local verification

Validated on 2026-09-23 after rebasing onto mainline (9448e28):

- npm run build: passed.
- npm run lint: passed.
- npm test: 222 tests passed across 41 files, including actual Pi runtime dynamic registration,
  authenticated HTTP forwarding, broker authorization/deduplication and local HTTP MCP exchange.
- npm run infra:synth: passed. CDK reports a warning about the existing secret-ARN parameter's
  NoEcho flag and unconfigured feature flags; no infrastructure was deployed.
- git diff --check: passed.

No live token minting, MCP authentication or GitHub mutation was performed. Installation permission
approval, deployment and an explicitly authorized live smoke test remain operational follow-ups.
