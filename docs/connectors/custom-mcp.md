# Connect any MCP server

This guide connects one AgentX project to a remote MCP server that AgentX has no built-in connector
for, such as Sentry, PagerDuty, Datadog or Confluence. It is written for the administrator of your
own AgentX deployment. You create the credential in the vendor's own account.

`agentx connector add mcp --project <name>` walks you through it:

1. It asks for the endpoint and the credential.
2. It lists the server's tools as its test read, and asks which ones to approve.
3. It stores the credential, registers it pinned to the endpoint's host, and registers the project's next revision.

Linear, Jira and Asana have their own guides and commands, and keep their own stronger checks. Use
those for them.

## What you need

- **The server's remote MCP endpoint**, an `https://` URL from the vendor's documentation. For
  example:
  - `https://mcp.sentry.dev/mcp`
  - `https://mcp.pagerduty.com/mcp`
  - `https://mcp.atlassian.com/v2/mcp` (Confluence)

  The host must be a public DNS name. AgentX refuses plain `http`, IP addresses, and local names
  such as `.internal`, and checks before every connection that the name does not resolve to a
  private address.
- **A credential**, either:
  - an API key or token, sent in a header; or
  - an OAuth sign-in by a dedicated bot user, done once in a browser.
- The AgentX administration client (`agentx`) logged in, and AWS credentials that can create
  secrets in the deployment's account and region.

## How access works

AgentX calls the MCP server with the credential. The credential is the outer limit: AgentX can never
reach more than it does. So make it as narrow as the vendor allows:
- **An API key:** use one limited to the one project, organization or service this AgentX project
  needs.
- **OAuth:** sign in as a dedicated bot user who is a member of only that.

Within that limit, the project chooses which tools the model may use, and how a call is kept inside
the project:

- **Credential scoping** (the default). There is no further check; each approved tool reaches
  everything the credential reaches. This suits read tools and narrowly scoped keys. A tool that
  changes data needs your explicit acknowledgment (`--acknowledge-unscoped-writes`). The wizard asks
  for it.
- **An ownership rule.** Before a call names an existing item, AgentX reads the item with one of the
  server's own read tools. It refuses the call unless the item belongs to the project's scope. See
  [Ownership rules](#ownership-rules).

Every connector also keeps AgentX's usual protections:
- Only approved tools are offered.
- A tool whose definition changes is refused until it is discovered again.
- Writes are confirmed in Slack, and carry a footer naming the Slack member who asked.
- The credential's value is removed from any result.

### The credential is pinned to one host

AgentX registers the credential with the endpoint's host, for example `mcp.sentry.dev`. It sends the
credential only there, and checks this again each time a token is issued. If the project's
connector entry is later edited to another endpoint, the connector reports as not connected, and no
request is made with the credential.

## Connect with an API key

1. Create the key in the vendor's settings, limited to what this project needs. Copy it.
2. Run:

   ```sh
   agentx --env <env> connector add mcp --project <name> \
     --endpoint https://mcp.sentry.dev/mcp --auth key --key-file ./sentry-key.txt
   ```

   The key is read from the file, `--key-env <NAME>`, or a hidden prompt. It never appears in the
   project file or in logs.
3. The wizard lists the server's tools, with what each does and whether the server marks it
   read-only. Approve tools as a comma-separated list. A tool marked read-only is approved as a
   read; any other is approved as a write. Add `:read` or `:write` to choose yourself, for example
   `--tools get_issue_details,search_issues,update_issue:write`.

Most servers take the key as `Authorization: Bearer <key>`. For one that does not, pass the header
and the text before the key:

| Server | Flags |
|---|---|
| PagerDuty | `--auth-prefix "Token token="` |
| A key in its own header | `--auth-header X-Api-Key --auth-prefix ""` |

## Connect with an OAuth sign-in

For a server that takes only OAuth, a dedicated bot user signs in once. AgentX then keeps the
sign-in fresh on its own.

1. Create the bot user in the vendor, and add it only to what this project needs.
2. Run:

   ```sh
   agentx --env <env> connector add mcp --project <name> \
     --endpoint https://mcp.vendor.example/mcp --auth oauth --register-client
   ```

   AgentX reads where to sign in from the server itself: its OAuth protected resource metadata,
   then its authorization server's metadata. It checks that both describe this endpoint, and that
   the server supports PKCE. With `--register-client`, AgentX registers itself as the server's OAuth
   client.

   If the server does not allow that, create an OAuth app in the vendor:
   - Set its redirect URL to exactly `http://localhost:8765/callback`.
   - Pass `--client-id <id>`, and `--client-secret-file <path>` if the app has a secret.
3. The wizard prints a sign-in address. Open it in a private browser window **signed in as the bot
   user**. On a machine you reach over SSH, forward the port first:
   `ssh -L 8765:127.0.0.1:8765 <that machine>`.
4. AgentX stores the refresh token and registers the credential with the server's token URL and
   resource. It refreshes once to list the tools, then you approve tools as above.

`--scope "<scopes>"` asks for specific scopes. Without it, AgentX asks for what the server requests
or lists. A server that publishes no metadata can be given its endpoints directly:

```sh
agentx admin credential authorize --ref mcp-<name> --secret agentx/<env>/connectors/mcp-<name> \
  --endpoint <mcp url> --authorize-url <url> --token-url <url>
```

## Ownership rules

Give the wizard a JSON file with `--config-file <path>` to add scopes, bound arguments and an
ownership rule. The wizard fills in the endpoint, the names, the credential and the tools. This
example keeps a Sentry-like connector inside one organization:

```json
{
  "scopeNoun": "organization",
  "scopes": [{ "alias": "acme", "values": { "org": "acme" } }],
  "bind": { "required": { "organizationSlug": "org" } },
  "scoping": {
    "mode": "ownership",
    "itemNoun": "issue",
    "references": { "get_issue_details": ["issueId"], "update_issue": ["issueId"] },
    "lookup": { "tool": "get_issue_details", "argument": "issueId" },
    "field": "organization.slug",
    "equals": "org"
  }
}
```

- **`scopes`**: what the model chooses between. Each scope has an alias and named values.
- **`bind`**: arguments AgentX fills from the scope's values. They are removed from what the model
  sees, and a model that tries to set one is refused.
  - `required`: every approved tool must take the argument.
  - `optional`: the argument is bound only on tools that have it.
- **`scoping.references`**: per tool, the arguments that name an existing item. Use `a.b` for a
  field inside an object, `a[].b` for each object in a list, and `ids[]` for a list of IDs.
- **`scoping.lookup`**: the read tool, and the argument the item's ID goes in. Optional `arguments`
  adds constant arguments.
- **`scoping.field` and `equals`**: where the item's owner is in the read tool's JSON result, and
  which scope value it must equal. `field` may end in `[]` when the owner is a list, for example
  `projects[].id`. Then any element may match.
- **Optional fields:**
  - `caseInsensitive`: compare IDs and owners without regard to case.
  - `parent: { "field": "parent.id", "maxDepth": 1-3 }`: follow parents when the item itself does
    not match.
  - `maxLookups` (at most 10).
  - `refuse` and `require` rules for arguments that must not or must appear. Their messages may use
    `{alias}`, `{argument}`, `{tool}` and `{vendor}`.
  - `targetArguments`: the argument names the preflight warns about on unguarded tools.

The rule fails closed. A read that errors, a result that is not JSON, or a missing field all refuse
the call, and nothing is sent. A tool the rule does not name is not checked. Registration's
preflight warns about an approved tool outside the rule whose input names an item.

## Check it

`agentx doctor --env <env>` checks every `mcp` connector it set up:
- **API key:** the secret exists, and the key still reaches every approved tool.
- **OAuth:** the bot's sign-in is stored. It is not refreshed, since a refresh would rotate the
  token AgentX holds.

## By hand

The wizard's steps, for a connector set up without it:

1. Store `{"apiKey": "<key>"}` in Secrets Manager as `agentx/<env>/connectors/<ref>`.
2. Register the credential:

   ```sh
   agentx admin credential register --ref <ref> --type static-secret --secret agentx/<env>/connectors/<ref> --host mcp.sentry.dev
   ```

   For OAuth, use `agentx admin credential authorize --endpoint` instead.
3. Add the connector to the project file's `integrations.connectors`:

   ```yaml
   - name: sentry
     type: mcp
     endpoint: https://mcp.sentry.dev/mcp
     label: Sentry issues
     vendor: Sentry
     credentialRef: <ref>
     scopes: [{ alias: acme, values: {} }]
     scoping: { mode: credential }
     tools:
       - { name: get_issue_details, access: read }
   ```

4. Register the project's next revision.

The full schema is in `specs/055-generic-mcp-connectors/spec.md`.
