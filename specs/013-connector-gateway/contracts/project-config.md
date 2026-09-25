# Contract: Connector Configuration

A project definition after feature 010 plus `integrations.connectors`. Tool names shown for
Linear and Jira are illustrative; approvals must match names returned by the vendor's `tools/list`.

```yaml
name: payments
revision: 7
repositories:
  - name: payments-api
    url: https://github.com/example/payments-api.git
    path: repo/payments-api
    defaultBranch: main
    credentialRef: github-agentx-sdlc
setup: []
readiness: []
orchestratorInstructions: Delegate every repository read, edit, build and test to the worker.
integrations:
  connectors:
    - name: github
      type: github                 # uses each repository's GitHub App credentialRef
      scopes: all-repositories     # or a list of registered repository names
      tools:
        - name: list_issues
          access: read
        - name: issue_write
          access: write
          allowedArguments: [method, issue_number, title, body, assignees]
          argumentValues: { method: [create, update] }
    - name: linear
      type: linear
      credentialRef: linear-payments
      scopes:
        - { alias: payments, teamId: "00000000-0000-0000-0000-000000000000" }
      tools:
        - name: list_issues
          access: read
          description: >-
            List Linear issues in the payments team, optionally filtered by state or assignee.
            Use for "what's open" or "show tickets". Not for GitHub issues (github__list_issues)
            or repository files (agentx_submit_task).
          examples: [{ state: "started" }]
        - name: save_issue
          access: write
    - name: jira
      type: jira
      credentialRef: jira-agentx-sa
      scopes:
        - { alias: pay, cloudId: "00000000-0000-0000-0000-000000000000", projectKey: PAY }
      tools:
        - name: searchJiraIssuesUsingJql
          access: read
        - name: getJiraIssue
          access: read
        - name: createJiraIssue
          access: write
        - name: addOrEditJiraIssueComment
          access: write
```

## Registration outcomes

| Condition | Result |
|---|---|
| Both `githubMcp` and `connectors` | Refused, naming both keys |
| Connector type other than `github`, `linear`, `jira` or `asana` | Refused |
| GitHub scope naming an unregistered repository | Refused, naming it |
| Unknown `type` or `identity` other than `service` | Refused |
| `credentialRef` not in the registry | Refused, naming the reference |
| `credentialRef` of a type the connector does not accept | Refused, naming the reference and type |
| Presented name longer than 64 characters | Refused, naming the tool |
| Upstream schema already has `target` and the connector has several scopes | Refused, naming the tool |
| Visible tools over 40 | Refused with the count |
| Visible tools over 20 | Registered, with a warning |
| Vendor authentication fails | Registered, with the connector reported as not connected |
| Approved tool not found upstream or not representable | Registered, with the tool reported as skipped |
| Jira `projectKey` on some scopes only | Refused |
| Jira tool AgentX cannot limit, with `projectKey` | Refused, naming the tool |
| Jira guarded tool with the wrong `access` | Refused, naming the tool |
| Jira credential reference of another type | Refused, naming the type |
| Asana tool other than the eight guarded tools, or with the wrong `access` | Refused, naming the tool (phase 7) |
| Asana scopes with a repeated alias or project GID | Refused (phase 7) |
| Asana credential reference that is not `oauth-refresh-token` | Refused, naming the type (phase 7) |

## Credential registration

```sh
aws secretsmanager create-secret --name agentx/connectors/linear-payments \
  --secret-string file:///dev/stdin   # {"apiKey":"…"}

agentx admin credential register --ref linear-payments \
  --type static-secret --secret agentx/connectors/linear-payments
agentx admin credential list
```

An Asana credential is created by a browser sign-in instead (phase 7; see
[docs/connectors/asana.md](../../../docs/connectors/asana.md)):

```sh
agentx admin credential authorize --ref asana-bot \
  --secret agentx/connectors/asana-bot --provider asana \
  --no-browser --expect-account <bot user's email>   # secret first holds {"clientId","clientSecret"}
```

The secret must use the default `aws/secretsmanager` key. If the administrator uses a
customer-managed KMS key instead, they must grant the broker role `kms:Decrypt` on that key. An `oauth-refresh-token` secret is also written back when a refresh token rotates, so on a
customer-managed key the broker role also needs `kms:GenerateDataKey` (and `kms:Encrypt` if the key
policy requires it).

`list` prints each credential's reference, type, secret name, whether it is the built-in GitHub App
entry (which always lists first), and whether a token is cached; a registered entry also carries
who registered it and when. It never prints a secret or token value.

## Mandatory vendor-side restrictions

| Type | Restriction the administrator must apply |
|---|---|
| `github` | App installed only on approved repositories; Issues permission only for issue tools |
| `linear` | API key with team access limited to the intended teams and the smallest permission set; client-credentials tokens are refused because they reach all public teams |
| `jira` | API-token authentication enabled for the Rovo MCP server; service account restricted to the intended projects, and proven by the setup guide's Step 8: a search outside them returns zero issues |
| `asana` | A dedicated bot user that is a guest (a member only if it must be) of only the intended projects, proven by the setup guide's Step 6; an Asana MCP app owned by the organisation (phase 7) |
