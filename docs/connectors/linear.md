# Connect Linear

This guide connects one AgentX project to Linear. It is written for the administrator of your own
AgentX deployment. You create the Linear credential in your own Linear workspace.

## How access works

AgentX calls Linear's hosted MCP server, `https://mcp.linear.app/mcp`, with a Linear API key,
sent as a Bearer token. The key acts as the Linear user who created it. Every issue or comment AgentX writes shows that
user as the author, and ends with a footer naming the Slack member who asked and linking the
thread.

Two limits can apply. You set the first one in Linear; AgentX enforces the second one on its own:

1. **The key.** Restrict the API key to the one team this connector scopes to. Step 1 below does
   this. A full-access key also works: the project-side guard in point 2 is what actually limits
   every team-scoped call to that team, not the key. Restrict the key anyway, so it cannot reach
   more than this connector is meant to if it is ever used outside AgentX.
2. **The project.** The project file names one or more teams and the tools members may use.
   AgentX sets the team on every tool that takes one, and refuses a model that tries to choose
   another. Before it reads, updates or comments on an existing issue, it checks that the issue is
   in the project's team. This check covers exactly `get_issue`, `save_issue`, `list_comments` and
   `save_comment`. Any other tool that addresses an issue or comment, for example `delete_comment`,
   is not checked, so it must not be approved.

Tools that take no team, such as `list_teams`, `list_users` or `get_workspace`, reach everything
the key reaches, and the guard in point 2 does not cover them. Approve them only if that is
acceptable. Never approve `delete_*` tools.

Linear's OAuth client-credentials tokens are not supported. They reach every public team and
cannot be limited to one.

## Before you start

- You need a Linear account that can create API keys. Admins always can. Members can only if
  **Settings > Administration > API > Member API keys** allows it.
- Consider a dedicated Linear user for AgentX, so writes are not shown as a person's. It uses a
  seat.
- You need the AgentX administration client (`agentx`) logged in, and AWS credentials that can
  create secrets in the deployment's account and region.
- `jq` must be installed.

## 1. Create the API key

1. In Linear, open **Settings > Account > Security & Access**.
2. Under **Personal API keys**, choose **New API key**. Name it after the project, for example
   `AgentX payments`.
3. Permissions: grant **Read**. To let AgentX create issues and comments, also grant
   **Create issues** and **Create comments**. To let it update existing issues (`save_issue` with
   an `id`), grant **Write** instead of those two.
4. Team access: choose **only the teams this project may use**. Do not leave it on all teams.
5. Create the key and copy it. Linear shows it once.

Never paste the key into a chat message or a screenshot. If it is ever exposed, revoke it in
Linear immediately and create a new one.

## 2. Check the key and find the team ID

With the key still on your clipboard, run:

```sh
pbpaste | sed 's/^/Authorization: /' | curl -s https://api.linear.app/graphql \
  -H @- -H 'content-type: application/json' \
  -d '{"query":"{ teams { nodes { id key name } } }"}' | jq '.data.teams.nodes'
```

The list must show only the teams you selected. If it shows more, fix the key's team access
before you continue. Note the `id` of each team the project will use. It looks like
`c408e946-78aa-4db8-923e-f78053dd954f`.

On Linux, replace `pbpaste` with `xclip -o -selection clipboard`.

## 3. Store the key in AWS Secrets Manager

The secret name must start with `agentx/connectors/`. Store the key straight from the clipboard,
so it never appears in your shell history or a terminal prompt:

```sh
export AWS_PROFILE=<your deployer profile> AWS_REGION=<your region>
pbpaste | tr -d '\n' | jq -Rc '{apiKey: .}' | aws secretsmanager create-secret \
  --name agentx/connectors/linear-payments --secret-string file:///dev/stdin
pbcopy < /dev/null
```

Use the default `aws/secretsmanager` key. If you use a customer-managed KMS key, grant the broker
role `kms:Decrypt` on it.

If you also keep a copy in the macOS Keychain, pass the value in the command:

```sh
security add-generic-password -a "$USER" -s agentx-linear-payments -w "$(pbpaste)"
security find-generic-password -s agentx-linear-payments -w | tr -d '\n' | wc -c
```

`-w "$(pbpaste)"` briefly puts the key in that process's command line, visible to anyone who can
run `ps` on the machine while the command runs. Skip this optional Keychain copy on a shared
machine.

Never use `-w` without a value. Its interactive prompt cuts secrets at 128 characters, and the
cut is silent. The second command prints the stored length so you can compare it with the key's.
Do this for any tool you store the key through: a shell tool that silently truncates a long secret
is not limited to the Keychain, so always verify the stored length matches the key you copied.

To rotate the key later, run `aws secretsmanager put-secret-value` with the new key the same way,
then register the credential again (step 4) so AgentX drops the old one at once.

## 4. Register the credential

```sh
agentx admin credential register --ref linear-payments \
  --type static-secret --secret agentx/connectors/linear-payments
agentx admin credential list
```

`list` shows `linear-payments` with type `static-secret`. It never prints the key.

## 5. Add Linear to the project file

Add a connector to `integrations.connectors`, with one scope per team:

```yaml
integrations:
  connectors:
    - name: linear
      type: linear
      credentialRef: linear-payments
      scopes:
        - { alias: payments, teamId: "c408e946-78aa-4db8-923e-f78053dd954f" }
      tools:
        - name: list_issues
          access: read
          description: >-
            List Linear issues in the payments team, filtered by state, assignee or text.
            Use for "what's open". Not for GitHub issues or repository files.
        - name: get_issue
          access: read
          allowedArguments: [id, includeCustomerNeeds, includeReleases]
        - name: save_issue
          access: write
          allowedArguments: [id, title, description, state, assignee, priority, labels, dueDate]
        - name: save_comment
          access: write
          allowedArguments: [issueId, body]
```

- `name` becomes the tool prefix (`linear__list_issues`). Use a second name, such as
  `linear-ops`, for a second Linear workspace.
- With several scopes, members pick a team by its alias.
- `allowedArguments` keeps the model to the fields you list. The `save_issue` and `save_comment`
  fields above are the recommended minimum for writes.
- `save_issue`'s `labels` replaces the full label set on the issue. A live check creating an issue
  with `labels: ["Bug"]` alongside the team succeeded (Slack, 2026-09-25; see T034 in
  `quickstart.md`). `allowedArguments` still leaves out `addLabels` and `removeLabels`: AgentX
  always sends the team on an update, and Linear's schema says a label change through those two
  fields cannot be combined with a team change; whether that combination actually works has not
  yet been verified live. Add them back once it has been.
- `get_issue`'s `allowedArguments` leaves out `includeRelations`; if approved anyway, the connector
  refuses any call that sets it to `true`, because a related issue can belong to another team it
  does not return.
- Leave `attribution` unset to keep the footer.

## 6. Register the project revision

Raise `revision`, then run:

```sh
agentx admin project register --file payments.yaml \
  --runtime-arn <runtime ARN> --deployment-mode <mode>
```

A working setup prints the revision with a `preflight` entry like this, and no warnings:

```json
{ "name": "linear", "status": "connected",
  "offered": ["linear__list_issues", "linear__get_issue", "linear__save_issue", "linear__save_comment"],
  "skipped": [] }
```

What the other results mean:

| Output | Meaning and fix |
|---|---|
| Refused: `connector linear: credential linear-payments is not registered; run agentx admin credential register first` | Run step 4 first. |
| Refused: `connector linear: credential linear-payments is oauth-client-credentials; a Linear connector needs static-secret` | Register a `static-secret` API key instead. |
| Refused: `connector linear: connector credentials are not configured in this deployment` | The control plane was deployed without connector credentials. Redeploy with them. |
| `Warning: connector linear: Linear is not connected: Linear rejected the credential twice; check the Linear API key's permissions and team access` | The key is wrong, revoked or lacks permissions. Check steps 1 to 3. |
| `Warning: connector linear: tool X skipped: not offered by the vendor` | The tool name is wrong or Linear renamed it. Check the name. |
| `Warning: connector linear: tool X skipped: requires arguments outside allowedArguments` | Add the named arguments to `allowedArguments`. |

## 7. Try it in Slack

In a thread in the project's channel, ask "what's open for payments in Linear?", then "create a
Linear issue for the flaky login test". The new issue is in the payments team and ends with the
AgentX footer. Asking to change an issue in another team gets a plain refusal, and nothing is
changed.
