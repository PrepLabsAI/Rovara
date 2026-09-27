# Jira connector

AgentX is open source and self-hosted. There is no shared Atlassian account. Your organisation
creates its own Atlassian service account and API token, stores the token in your own AWS Secrets
Manager, and registers it with `agentx admin credential register`. This guide walks you through
that, end to end, for one Jira Cloud site and one project.

## What you get

AgentX can search, read, create and comment on Jira issues from Slack. It acts as one Atlassian
service account. Each create and comment ends with a footer naming the Slack member who asked. You must limit
the service account to the project in Jira (Step 4) and prove it (Step 8). That limit is the one
that counts. AgentX also holds the connector to the project you name, as a second line.

## Before you start

You need:

- An Atlassian organization admin.
- A Jira Cloud site.
- An AgentX control plane you can reach with `agentx login` as an administrator.
- The AWS CLI with Secrets Manager access in the control plane's account and region.
- `jq` (included in macOS 15 and later).

## Step 1: Allow API token authentication for the Rovo MCP server

In Atlassian Administration (admin.atlassian.com), open your organization. Open **Apps**, then
**AI settings**, then **Rovo MCP server** (menu names may differ). Open **Authentication** and turn on **Allow
API token authentication**. Without this, Atlassian rejects every AgentX call and preflight
reports the connector as not connected.

## Step 2: Create a service account

In Atlassian Administration open **Directory**, then **Service accounts**, then **Create service
account** (menu names may differ). Name it, for example, `AgentX`.

## Step 3: Give it Jira access with the User role

On the service account, open app access and give **Jira** the **User** role (menu names may differ). Do not give
it Confluence, Loom or admin roles.

## Step 4: Restrict it to the intended projects (mandatory)

This is the access boundary. Do not skip it. A new service account with the Jira User role can
often browse every project that grants **Browse projects** to all logged-in users. Step 8 checks
the result.

- In each project AgentX may use: **Project settings**, then **Access** or **People**, add the
  service account with a role that can browse, create and comment.
- Check every other project: the permission scheme must not grant **Browse projects** to **Any
  logged in user**, to a group the service account is in, or to the Jira application role. Fix
  any scheme that does.
- Spot check: in Jira, **Settings**, **System**, **Permission helper** (menu names may differ). Pick the service
  account, a project it must not see, and **Browse projects**. The answer must be no. Step 8 then
  checks every project at once.

## Step 5: Create an API token with six scopes

On the service account, open **Credentials**, then create an **API token**. Set an
expiry. Choose these scopes: `read:jira-work`, `write:jira-work`, `read:jira-user`,
`read:jira:agent-interface`, `write:jira:agent-interface`, `search:jira:agent-interface`. Without
`write:jira:agent-interface`, searches and reads work but every create or comment is refused with
"Insufficient scopes". Copy the token now; Atlassian shows it
once. It is long (about 192 characters).

Do not create OAuth 2.0 credentials instead. Atlassian's MCP server refuses service-account OAuth
tokens with "Cloud id isn't explicitly granted", even though Jira's REST API accepts them. AgentX
sends the service account's API token as a Bearer token to the MCP server; that is what this guide
sets up.

Never paste the token into chat, a ticket or a screenshot. If a token is ever exposed that way,
revoke it in Atlassian and issue a new one.

## Step 6: Find your cloudId

Open `https://<your-site>.atlassian.net/_edge/tenant_info`. It returns `{"cloudId":"..."}`. That
UUID is your `cloudId`. Write it down lowercase, exactly as returned; AgentX refuses a `cloudId`
that is not lowercase. That same address, `https://<your-site>.atlassian.net` with nothing after
it, is also your `siteUrl` for Step 10: it gives AgentX's replies the issue's real link instead of
a guessed one.

## Step 7: Store the token in Secrets Manager, without cutting it

```sh
read -rs JIRA_TOKEN        # paste the token, press Enter; nothing is shown
printf '%s' "$JIRA_TOKEN" | wc -c   # about 192; 128 means it was cut, start again
jq -n --arg k "$JIRA_TOKEN" '{apiKey: $k}' | aws secretsmanager create-secret \
  --name agentx/connectors/jira-agentx-sa --secret-string file:///dev/stdin
unset JIRA_TOKEN
aws secretsmanager get-secret-value --secret-id agentx/connectors/jira-agentx-sa \
  --query SecretString --output text | jq -r '.apiKey | length'   # same number as above
```

The name must start with `agentx/connectors/`. Use the default `aws/secretsmanager` key, or grant
the broker role `kms:Decrypt` on your own key. If you keep the token in the macOS Keychain, add it
with `security add-generic-password -a agentx -s jira-agentx-sa -w "$(pbpaste)"`, then clear the
clipboard with `pbcopy </dev/null`. While that command runs, the token is briefly visible in the
process list to other users of the same Mac. Never use the interactive `-w` prompt: it keeps only
the first 128 characters. Some other tools cut a stored
secret the same way; whatever you use to store the token, check the stored length against the
number Step 5 gave you.

## Step 8: Prove the service account sees only its projects (mandatory)

Run this from your AgentX checkout after `npm ci && npm run build`. Set `JIRA_PROJECTS` to the
project keys AgentX may use, comma separated. It reads the token from Secrets Manager, so the
token is never typed or shown:

```sh
JIRA_TOKEN="$(aws secretsmanager get-secret-value --secret-id agentx/connectors/jira-agentx-sa \
  --query SecretString --output text | jq -r .apiKey)" \
JIRA_CLOUD_ID='<your cloudId>' JIRA_PROJECTS='PAY' \
node --input-type=module -e '
import { connectMcp } from "./packages/gateway/dist/index.js";
const { JIRA_TOKEN: token, JIRA_CLOUD_ID: cloudId, JIRA_PROJECTS: projects } = process.env;
const connection = await connectMcp({ endpoint: new URL("https://mcp.atlassian.com/v2/mcp"), token, tools: ["searchJiraIssuesUsingJql"], signal: AbortSignal.timeout(30000) });
const keys = async (jql) => {
  const result = await connection.call("searchJiraIssuesUsingJql", { cloudId, jql, maxResults: 5 });
  if (result.isError) throw new Error("search failed; check Steps 1, 5 and 7");
  const text = (result.content ?? []).map((part) => part.text ?? "").join("");
  return [...new Set(text.match(/\b[A-Z][A-Z0-9_]+-[0-9]+\b/g) ?? [])];
};
try {
  console.log("inside:", (await keys(`project in (${projects})`)).length);
  const outside = await keys(`project not in (${projects})`);
  console.log("outside:", outside.length, outside.join(" "));
} finally { await connection.close(); }'
```

`inside` must be more than 0. If it is 0, create one issue in the project and run it again, so the
check can tell an empty answer from a blind one. `outside` must be 0. Any other number means the
service account can read other projects: go back to Step 4, fix the permission schemes it names,
and run this again. Do not register the project until `outside` is 0. If you skip this, AgentX's
own project check is the only thing holding the connector to the project.

## Step 9: Register the credential

```sh
agentx admin credential register --ref jira-agentx-sa --type static-secret \
  --secret agentx/connectors/jira-agentx-sa
agentx admin credential list
```

The type must be `static-secret`. Registering a project refuses a Jira connector whose reference
has another type.

## Step 10: Add the connector to the project YAML

```yaml
integrations:
  connectors:
    - name: jira
      type: jira
      credentialRef: jira-agentx-sa
      scopes:
        - { alias: pay, cloudId: "<your cloudId>", projectKey: PAY, siteUrl: "https://<your-site>.atlassian.net" }
      tools:
        - name: searchJiraIssuesUsingJql
          access: read
          description: >-
            Search Jira issues in project PAY with JQL. AgentX adds the project filter
            itself; send only the rest of the query, for example
            status = "To Do" ORDER BY created DESC. Link a Jira issue as
            https://<your-site>.atlassian.net/browse/<KEY>.
        - name: getJiraIssue
          access: read
        - name: createJiraIssue
          access: write
        - name: addOrEditJiraIssueComment
          access: write
```

`editJiraIssue` and `transitionJiraIssue` may be added too (access `write`). Edits are not signed
with the footer, because Jira takes the description inside `fields`.

`siteUrl` is optional, so a connector registered before this field existed keeps working, but
without it AgentX cannot form a link: it tells the model to give only the issue key and never
write a link, rather than let the model guess a host (a guess is exactly the bug this field fixes).
It must be exactly `https://<site>.atlassian.net`, with no path and no trailing slash, and it must
be lowercase.

**Adding `siteUrl` to an already-registered connector.** Edit the project YAML you registered with:
add `siteUrl` to each scope alongside its `cloudId`, then register the file again the same way as
Step 11 (`agentx --project <name> admin project register --file <file> ...`) with the revision
number increased. Registration is immutable per revision, so this is a new revision, not an edit in
place; existing threads move to it the same way any other revision change reaches them. Do not
change anything else in the same file unless you mean to.

**Rolling back to a broker release from before this field existed.** Remove `siteUrl` from every
scope first. `JiraScopeSchema` is strict (an unrecognised key refuses the whole entry), so an older
broker does not simply ignore a `siteUrl` it does not know: it marks the whole Jira connector
unusable, the same as any other invalid Jira configuration, dropping it from what is offered (the
rest of the project keeps working; only Jira stops) until you register a revision without
`siteUrl`. Registering a new revision that still carries `siteUrl` is refused outright on that
older broker, the same as any other configuration it cannot validate.

Use your own project key in the `description` override, in place of `PAY` above. Without an
override, AgentX adds "AgentX limits every search to project PAY; send only the rest of the query."
to the search tool's description itself, followed by the link sentence above when `siteUrl` is set.
With an override, AgentX shows your text as written and adds nothing, so an override should include
both the project sentence and, if you set `siteUrl`, the link sentence, as the example above does.
AgentX refuses a
`projectKey` longer than 10 characters. That fails closed: if your key is longer, shorten it or
split the project, because registration is refused rather than left to run unchecked.

This list is also the recommended set. The guard checks requests, not responses. `getJiraIssue`
is checked because AgentX looks up the issue's project before the read runs. But its reply can
still include the key, summary and status of linked issues, the parent, the epic or subtasks. If
the service account can see an issue in another project, that issue's summary can appear in the
reply. Step 4 is what stops this: a service account that sees only your project gets only your
project's issues back. `searchJiraIssuesUsingJql` only returns issues in your project, because
AgentX rewrites the query. The same caveat applies to its replies: a search that asks for the
`issuelinks`, `parent` or `subtasks` fields can return the summaries of issues in other projects
the service account can see. Step 4 is the control there too.

## Step 11: Register the project and read the preflight

Register the revision the usual way (`agentx --project <name> admin project register --file
<file> ...`). With `--json`, the result's `preflight` should read:

```json
{"connectors":[{"name":"jira","status":"connected","offered":["jira__searchJiraIssuesUsingJql","jira__getJiraIssue","jira__createJiraIssue","jira__addOrEditJiraIssueComment"],"skipped":[]}]}
```

Registration is refused if the credential reference is not registered or is not `static-secret`.
It is not refused if Atlassian rejects the token: preflight shows `not_connected` with the reason,
and you fix it at Atlassian.

## Tools you should not approve

`getConfluenceContent`, `createConfluenceContent`, `updateConfluenceContent`, `searchConfluence`,
`getLoomVideo`, `getGraphContext`, `getGraphObject`, `addGraphContext`, `search`, `discover`,
`executeRead`, `executeWrite`, `executeDestructive`, `getAccessibleAtlassianResources`,
`atlassianUserInfo`. They reach other products or run any Atlassian operation, so AgentX cannot
hold them to a project. With `projectKey` set, registration refuses them. Without `projectKey`,
only the service account's permissions stop them.

## What AgentX enforces

`cloudId` and `projectKey` are set by AgentX; the model cannot choose them. Searches are rewritten
to `project = "<KEY>" AND (<query>)`. Reads and writes by issue key first check that the issue is
in the project. Issue URLs are refused; the model must pass the key. This is a second line behind
Step 4. On a site where Step 8 does not print `outside: 0`, it is the only line.

The guard's checks are narrow on purpose. In plain words:

- It restricts JQL to the project: every search runs inside `project = "<KEY>" AND (...)`, not
  whatever the model wrote.
- It checks every issue key it can recognise in a write, not only the one named first. For
  example, creating a sub-task with a `parent` checks the parent issue too, and a comment or edit
  checks the issue it targets.
- It refuses an `issuelinks` field outright, in `fields`, `additional_fields` or `update`, because a
  link can reach an issue in another project.
- Lowercase keys are normalised to uppercase only inside link-shaped fields, such as `epic` or
  `Linked Issues`. A `parent` needs an exact uppercase key or a numeric ID; a lowercase `parent`
  key is refused, not normalised. Outside those fields, only an exact uppercase key (for example
  `PAY-7`, not `pay-7`) is recognised and checked as an issue reference.
- Update-verb syntax for a parent or a link, such as `{"parent": [{"set": {"key": "PAY-1"}}]}`, is
  refused outright, not rewritten or checked. Use the plain field form instead (for example
  `{"parent": {"key": "PAY-1"}}`).

Not covered by the guard, so only Step 4 holds these to the project:

- Numeric ids and lowercase keys inside custom fields named by id, for example the Epic Link field
  `customfield_10014`. Only exact uppercase keys are checked there.
- Sprint and board ids (`sprintId`, `boardId`, `assignToSprint`).
- Comment ids (`commentId`).
- Attachment references (`inlineFileId`, `inlineFileCollection`, `inlineFileName`).
- Reply contents. The guard checks requests, not responses.

AgentX creates Jira issues without asking, checks a change to an existing issue (a call with
`issueIdOrKey`, such as `editJiraIssue` or `addOrEditJiraIssueComment`) against what the member
asked, and always asks before `transitionJiraIssue` and before an edit that sets a status or
resolution (for example `fields.status`).

Do not approve `executeWrite`: it can run any Atlassian write, and names no issue AgentX can check,
so the action gate would treat it as a create and run it. With `projectKey` set, registration
refuses it. If a project without `projectKey` has approved it, deny it until it is removed:

```yaml
actionPolicy:
  rules:
    - { connector: jira, tool: executeWrite, outcome: deny, reason: "Use the dedicated Jira tools." }
```

## Troubleshooting

- **Every call fails as not connected, "rejected the credential twice".** Check, in order: API
  token authentication is on (Step 1); the token is complete (Step 7 length check); the token has
  not expired; the scopes are the six in Step 5.
- **Searches and reads work, but every create or comment ends with an unknown outcome.** The token
  is missing `write:jira:agent-interface` (Step 5). Atlassian refuses the write with "Insufficient
  scopes"; AgentX reports the outcome as unknown because it cannot prove nothing changed. Check Jira,
  then issue a token with all six scopes and rotate it (below).
- **You used `https://mcp.atlassian.com/v1/...` in another tool and it worked with OAuth but not
  with the token.** v1 ignores API tokens. AgentX always uses `https://mcp.atlassian.com/v2/mcp`.
- **"Cloud id isn't explicitly granted".** You gave AgentX an OAuth token. Use an API token
  (Step 5) and `--type static-secret` (Step 9).
- **Rotating the token.** Put the new value with `aws secretsmanager put-secret-value --secret-id
  agentx/connectors/jira-agentx-sa --secret-string file:///dev/stdin` (same `jq` pipe as Step 7).
  No re-registration is needed; AgentX re-reads the secret within five minutes, or at once after
  Atlassian rejects the old one.
- **An expired token** makes Jira calls fail as not connected until you rotate it.
