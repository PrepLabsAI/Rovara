# GitHub MCP setup and validation through hosted Slack

1. Run npm ci, npm run build, npm run lint, and npm test.
2. Add this administrator-owned policy to a new registered project revision. Existing thread
   workspaces keep their old revision; bind the Slack channel to the new revision and use a new thread.

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

The same policy can be declared as a connector (feature 013), which can also limit it to some
repositories. Use one form or the other; a definition with both is refused.

```yaml
integrations:
  connectors:
    - name: github
      type: github
      scopes: all-repositories      # or a list of registered repository names, e.g. [personal-website]
      tools:
        - name: list_issues
          access: read
        # …the same approvals as above
```

3. Enabled repositories must use the deployment's GitHub App credentialRef/account. The installed
   app needs Issues read/write access. Approve expanded installation permissions if needed.
4. Merge the correction and wait for the automatic production release to update both the broker
   and hosted Slack service. This guide does not authorize a manual deployment.
5. As administrator, bind the channel to that revision using the existing admin workflow:
   `agentx --project <project> admin slack bind --team <team-id> --channel <channel-id>`.
   The administrator's YAML must specify the registered revision. End users need no local CLI.
6. In a new thread in the bound channel, mention the bot: `@AgentX list open issues in <repo-alias>`.
   Initial thread setup may prepare a workspace; the issue tool itself must not submit a coding task.
7. In the same thread, ask `@AgentX create an issue in <repo-alias> titled AgentX MCP smoke test`.
   Then explicitly request a comment and assignment to a known human GitHub username. Verify the issue,
   comment and assignee directly on GitHub. Responses must arrive in the original thread.
8. Test with policy disabled, an unknown repository and another thread's workspace: no unauthorized
   upstream calls should occur. Verify the stored invocation's requestedBy identifies the Slack user.
9. In an authorized test harness, redeliver the same Slack event or replay the same invocation ID:
   no duplicate write. A new Slack mention is a new request, not a replay test. UNKNOWN or abandoned
   IN_PROGRESS writes require inspecting GitHub before issuing another mutation.

## What is dynamic?

Names, descriptions and schemas come from discovery. YAML approves/narrows tools, not implementations.
New compatible issue tools require no per-tool wrappers. The hosted runtime refreshes discovery on
each turn; definition changes within a turn fail closed at execution. Since feature 009 the policy
comes from the project's latest registered revision, so approving or withdrawing a tool reaches
every existing thread on its next turn.

Owner/repo are bound server-side, excluded from model inputs. Endpoints/credentials are not accepted
from the model. Native assignment may replace the whole list: read existing assignees when adding
someone and verify afterward. Concurrent external changes are not atomic.

## Current limits

- GitHub-hosted MCP; installation identity, not per-user OAuth.
- Issues permission family; others need an explicit credential-policy extension.
- Plain repository-scoped object schemas requiring owner/repo only.
- Administrator-trusted policy: classify writes correctly; MCP annotations are not authority.
- Existing AgentX coding and PR validation/publication tools unchanged.
- Hosted Slack is the required user path. Existing JWT/CLI compatibility remains, but is not needed
  for ordinary use. Administrator project/channel setup still uses the existing admin commands.
- Bounded requests/results, schema size, discovery pagination and upstream duration.

## Local verification

Initial bridge validation on 2026-09-23 (before the hosted Slack correction):

- npm run build: passed.
- npm run lint: passed.
- npm test: 222 tests passed across 41 files, including actual Pi runtime dynamic registration,
  authenticated HTTP forwarding, broker authorization/deduplication and local HTTP MCP exchange.
- npm run infra:synth: passed. CDK reports a warning about the existing secret-ARN parameter's
  NoEcho flag and unconfigured feature flags; no infrastructure was deployed.
- git diff --check: passed.

No live token minting, MCP authentication or GitHub mutation was performed. Installation permission
approval, deployment and an explicitly authorized live smoke test remain operational follow-ups.

Hosted correction validated locally on 2026-09-23:

- Build and lint: passed.
- Full suite: 226 tests passed across 42 files, including hosted processor → real Pi registration →
  signed MCP API forwarding → reply in the source thread, and same-event redelivery with new model
  call IDs. Broker tests cover role/thread/project isolation, disabled policy and requester audit.
- Infrastructure synthesis: passed, with existing secret-ARN NoEcho/feature-flag warnings.
- Hosted Slack linux/arm64 image build: passed. Network-disabled container import of the hosted
  runtime factory: passed.
- No manual deployment or live Slack/model/GitHub execution was performed. The correction requires
  review, merge, automatic release, project policy setup and a live Slack smoke test before claiming
  production acceptance.
