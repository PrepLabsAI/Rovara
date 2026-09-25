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
        - name: create_issue
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
| Connector type other than `github` (until phases 5–6) | Refused |
| GitHub scope naming an unregistered repository | Refused, naming it |
| Unknown `type` or `identity` other than `service` | Refused |
| `credentialRef` not in the registry | Refused, naming the reference |
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

## Credential registration

```sh
aws secretsmanager create-secret --name agentx/connectors/linear-payments \
  --secret-string file:///dev/stdin   # {"clientId":"…","clientSecret":"…","scopes":["read","write"]}

agentx admin credential register --ref linear-payments \
  --type oauth-client-credentials --secret agentx/connectors/linear-payments
agentx admin credential list
```

The secret must use the default `aws/secretsmanager` key. If the administrator uses a
customer-managed KMS key instead, they must grant the broker role `kms:Decrypt` on that key.

`list` prints each credential's reference, type, secret name, whether it is the built-in GitHub App
entry (which always lists first), and whether a token is cached; a registered entry also carries
who registered it and when. It never prints a secret or token value.

## Mandatory vendor-side restrictions

| Type | Restriction the administrator must apply |
|---|---|
| `github` | App installed only on approved repositories; Issues permission only for issue tools |
| `linear` | OAuth application or API key limited to the intended teams; one scope set per application |
| `jira` | API-token authentication enabled for the Rovo MCP server; service account restricted to the intended projects, and proven by the setup guide's Step 8: a search outside them returns zero issues |
