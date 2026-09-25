# Asana connector

AgentX is open source and self-hosted. There is no shared Asana app. Your organisation creates its
own Asana app and its own bot user, stores the app's client secret and the bot user's refresh
token in your own AWS Secrets Manager, and registers them with `agentx admin credential authorize`.
This guide walks you through that, end to end, for one Asana project.

## What you get

AgentX can search, list, read, create, update and comment on Asana tasks in one project from
Slack. It acts as one Asana user, the bot user. Every task or comment it writes shows that user as
the author. Every comment is plain text and ends with a footer naming the Slack member who asked
and linking the thread. The notes of a task it creates or updates carry no footer.

## How access works

Asana's MCP server, `https://mcp.asana.com/v2/mcp`, accepts only OAuth tokens that act as a
signed-in user. It takes no API key and no client credentials. So AgentX works as a bot user that
signs in once in a browser. After that, AgentX renews its access every hour on its own with the
refresh token from that sign-in.

Two limits apply:

1. **The bot user (mandatory).** An Asana OAuth token has no scopes: it reaches everything the bot
   user can see. Make the bot user a guest of only the projects AgentX may use (Step 1), and prove
   it (Step 6). That is the limit that counts.
2. **The project file.** AgentX sets the project on every tool that takes one, and before it reads
   or changes an existing task, it checks that the task is in the project. See
   [What AgentX enforces](#what-agentx-enforces). This is a second line behind Step 1.

## Before you start

You need:

- An Asana account that can create apps in the Asana developer console, and permission to invite
  a user to your project.
- An email address for the bot user that nobody uses for anything else, outside your
  organisation's email domain so the bot user joins as a guest. A plus address on a personal
  mailbox, such as `you+agentx@gmail.com`, works.
- An AgentX control plane you can reach with `agentx login` as an administrator.
- AWS credentials for the control plane's account and region that can create, read, write and tag
  secrets: `secretsmanager:CreateSecret`, `GetSecretValue`, `PutSecretValue` and `TagResource` on
  `agentx/connectors/*`.
- A browser on the machine where you run `agentx`, and local port 8765 free.
- `jq` (included in macOS 15 and later).

## Step 1: Create the bot user and share only the project

1. Invite the bot user's email to the Asana project AgentX will use, with **Editor** access, so it
   can create tasks and comment. An address outside your organisation's email domain joins as a
   **guest**: it sees only what is shared with it, which is what you want.
2. Accept the invitation from the bot user's inbox and set its password.
3. Do not add the bot user to any team, portfolio or other project.

Use a guest. Make the bot user a full member of your organisation only if your Asana plan or
policy leaves no other way, and then only of the intended projects: a member can also see every
public team and project in the organisation, and Step 6 must still pass.

## Step 2: Create the Asana MCP app

1. Open the Asana developer console, `https://app.asana.com/0/my-apps`, and choose **Create new
   app**.
2. For the app type, choose **Asana MCP**. Not "External MCP", and not an API app: only an Asana MCP
   app can call `https://mcp.asana.com/v2/mcp`.
3. After the app is created, open its settings and add this redirect URL, exactly:
   `http://localhost:8765/callback`. Step 4 prints the same URL, so you can check it there.
4. Open the app's **Manage Distribution** settings and make the app available to the bot user's
   workspace or organisation. A guest bot user with an address in another email domain signs in
   through that other domain, so an app limited to your own workspace refuses it. Choosing **Any
   workspace** works. Without this, Asana refuses the bot user's sign-in in Step 4 with "This app
   is not available to your Asana workspace or organization" (see
   [Troubleshooting](#troubleshooting)).
5. Copy the **Client ID** and the **Client secret**. There are no scopes to choose.

Never paste the client secret into a chat message or a screenshot. If it is ever exposed, reset
it in the developer console, then repeat Steps 3 and 4.

## Step 3: Store the app's client in Secrets Manager

The secret name must start with `agentx/connectors/`. Copy the client secret to the clipboard, then
run this. It asks for the client ID, which is not secret, and reads the client secret from the
clipboard so it never appears in your shell history:

```sh
export AWS_PROFILE=<your deployer profile> AWS_REGION=<your region>
printf 'Asana client ID: '; read -r ASANA_CLIENT_ID
pbpaste | tr -d '\n' | jq -Rc --arg id "$ASANA_CLIENT_ID" '{clientId: $id, clientSecret: .}' \
  | aws secretsmanager create-secret --name agentx/connectors/asana-bot \
      --tags Key=agentx-writable,Value=refresh-token --secret-string file:///dev/stdin
pbcopy < /dev/null
```

On Linux, replace `pbpaste` with `xclip -o -selection clipboard`.

Use the default `aws/secretsmanager` key. If a customer-managed KMS key encrypts the secret
instead, the broker role must be allowed `kms:Decrypt` and `kms:GenerateDataKey` on it, plus
`kms:Encrypt` if the key policy requires it, because AgentX writes a rotated refresh token back to
this secret. Your own AWS credentials need the same on that key for Step 4. See the
`connector.refresh_token_unsaved` entry in [Troubleshooting](#troubleshooting) for how a missing
grant shows up.

The `agentx-writable` tag lets AgentX write a new refresh token back to this secret if Asana ever
issues one. AgentX may write only secrets with this tag. Step 4 adds it too, if you left it out.

## Step 4: Sign the bot user in and register the credential

The sign-in must be the bot user's, not yours. Run, with the bot user's email:

```sh
agentx admin credential authorize --ref asana-bot \
  --secret agentx/connectors/asana-bot --provider asana \
  --no-browser --expect-account <bot user's email>
```

Why both flags: without `--no-browser` the command opens your default browser, which is probably
signed in to Asana as you. If you own the Asana app, Asana approves your own app for you silently
within a second, before you can close the tab, and the command would store your sign-in instead of
the bot user's. `--no-browser` only prints the sign-in URL, so nothing signs in until you open it
yourself. `--expect-account` makes the command refuse, storing and registering nothing, when any
account other than that email signs in (compared ignoring case), or when Asana does not say which
account signed in.

The secret must be in the control plane's AWS region. Add `--region <region>` if that is not your
default AWS region. The command prints:

```text
Sign in as the connector's bot user (the Asana app's redirect URL must be exactly http://localhost:8765/callback). Open this URL in a private window signed in as the bot user:
https://app.asana.com/-/oauth_authorize?...
```

(Without `--no-browser` the command also opens your default browser, and the prompt starts "If no
browser opened, or it is signed in as someone else, open this URL ...".)

Copy the URL into a private (incognito) window, sign in there as the bot user and approve access
within five minutes. After five minutes the
command stops waiting and closes its listener, so a later approval ends on a browser error such as
`ERR_CONNECTION_REFUSED` for `localhost:8765`; run the command again. The browser shows "AgentX
received the sign-in", and the command prints which Asana account signed in, then the result:

```text
Signed in to Asana as AgentX Bot <agentx-bot@example.com>. This must be the connector's bot user; if it is not, run the command again with the sign-in URL opened in a private window signed in as the bot user.
Stored the refresh token in agentx/connectors/asana-bot and registered asana-bot as oauth-refresh-token.
```

Check that the "Signed in to Asana as" line names the bot user. With `--expect-account`, any other
account is refused before anything is stored:

```text
AgentX error [AUTH_REQUIRED]: the sign-in was for Your Name <you@example.com>, not agentx-bot@example.com; nothing was stored or registered. Run the command again with --no-browser and open the sign-in URL in a private window signed in as agentx-bot@example.com
```

Without `--expect-account` nothing checks the account: if the line names you, AgentX would act as
you, with everything you can see, so run the command again as above, which replaces the stored
sign-in. If Asana's answer carries no account, the line reads "Signed in to Asana (the account
could not be shown)"; `--expect-account` then refuses the sign-in, and without it nothing proves
whose sign-in was stored, so run the command again in a fresh private window where you signed in
only as the bot user.

What the command did: it signed in with PKCE and a one-time state value, listened only on
`127.0.0.1:8765`, exchanged the code for a refresh token, wrote the refresh token into the secret
beside the client, tagged the secret, and registered it. It never prints a token, the code or the
client secret. `agentx admin credential list` now shows `asana-bot` with type
`oauth-refresh-token`.

If the refresh token was stored and tagged but registering it with the control plane failed (for
example, your `agentx login` session expired), the error ends with the one command that finishes
the job without a new sign-in:

```sh
agentx admin credential register --ref asana-bot --type oauth-refresh-token \
  --secret agentx/connectors/asana-bot
```

If you run `agentx` on a remote machine over SSH, forward the port first:
`ssh -L 8765:127.0.0.1:8765 <host>`. The browser on your own machine then reaches the command.

## Step 5: Find the project GID

Open the project in Asana. Its address contains a long number after `/project/` (for example
`https://app.asana.com/1/1200000000000001/project/1210000000000010/list/...`) or, in older links,
right after `/0/` (`https://app.asana.com/0/1210000000000010/...`). That number is the project GID.

## Step 6: Prove the bot user sees only its project (mandatory)

Signed in to Asana as the bot user:

1. The sidebar lists only the project from Step 1, and no teams.
2. Search for the name of a task you know is in another project of your workspace. Asana finds
   nothing.
3. The "Signed in to Asana as" line Step 4 printed named this bot user. That line is what shows
   whose sign-in was stored. If it named someone else, or could not show the account, run Step 4
   again in a private window. Under your profile photo, **Settings > Apps > Authorized apps**
   listing your AgentX app shows only that the bot user has authorized the app, not that its
   sign-in is the one stored.

Checks 1 and 2 test what the bot user can see; they pass even if Step 4 stored another account's
sign-in, so check 3 matters.

If the bot user sees more, remove it from those projects or teams and check again. Until it
passes, the check in [What AgentX enforces](#what-agentx-enforces) is the only limit.

## Step 7: Add Asana to the project file

Add a connector to `integrations.connectors`, with one scope per project:

```yaml
integrations:
  connectors:
    - name: asana
      type: asana
      credentialRef: asana-bot
      scopes:
        - { alias: payments, projectGid: "1210000000000010" }
      tools:
        - name: search_tasks
          access: read
          description: >-
            Search tasks in the payments Asana project by text, assignee, due date or completion.
            Use for "what's open" or "find the task about". Not for GitHub issues.
        - { name: get_task, access: read }
        - { name: create_tasks, access: write }
        - { name: update_tasks, access: write }
        - { name: add_comment, access: write }
```

Only these tools can be approved, each with the access shown:

| Tool | Access |
|---|---|
| `get_task`, `get_task_stories`, `get_tasks`, `search_tasks`, `get_project` | `read` |
| `create_tasks`, `update_tasks`, `add_comment` | `write` |

`search_tasks` works only on paid Asana plans (a trial of a paid plan counts). On a free workspace, approve `get_tasks` instead.
Registration refuses any other Asana tool, because AgentX cannot hold it to a project.

## Step 8: Register the project and read the preflight

Register the revision the usual way (`agentx --project <name> admin project register --file
<file> ...`). With `--json`, the result's `preflight` should read `"status":"connected"` for
`asana`, with each approved tool under `offered` and nothing under `skipped`.

Registration is refused if the credential reference is not registered (the refusal says to run
`agentx admin credential authorize` first) or is not `oauth-refresh-token`. It is not refused if
Asana refuses the sign-in: preflight shows `not_connected` with the reason, and you fix it with
Step 4.

## Step 9: Try it in Slack

In a thread in a channel bound to the project, ask "what's open in Asana?", then "create an Asana
task titled Test from AgentX". The task appears in the project, created by the bot user.

## What AgentX enforces

The project GID is set by AgentX on every tool that takes one (`project`, `project_id`,
`default_project` and `projects_any`). The model cannot choose it; a request that tries is refused
before AgentX contacts Asana.

Before a call reads or changes an existing task, AgentX reads that task with `get_task` and
refuses the call unless the task is in the project. A subtask that is in no project itself is
accepted when its parent, up to three levels up, is in the project. This covers the task a call
names, and in `create_tasks` and `update_tasks` also every parent and dependency. A call may make
at most 10 of these task lookups, parents included; a parent shared by several tasks is read once.
A call that needs more is refused and must be split.

These are refused outright, because they reach outside the project or move a task between
projects:

- On `get_tasks`: `tag`, `section`, `user_task_list` and `assignee`. Use `search_tasks` with
  `assignee_any` instead.
- On `create_tasks`: a task's `project_id` other than the project's own, `section_id` and
  `assignee_section`. An explicit `null` for any of these is refused too.
- On `update_tasks`: `add_projects`, `remove_projects` and `assignee_section`, an item that does not
  name its task by ID, and `parent: null` (removing the parent) unless the task is itself directly
  in the project, not only through its parent.
- In `create_tasks` and `update_tasks`, any key in a `tasks[]` item other than the keys Asana
  documents for that tool, and any object or list where Asana expects a plain value.
- On `search_tasks`, a `custom_fields` key that is not a custom field GID followed by one of the
  operators `value`, `is_set`, `not_value`, `starts_with`, `ends_with`, `contains`, `less_than`,
  `greater_than`, `before` or `after` (for example `1200456789012345.value`), or a value that is not
  plain.
- On `add_comment`, `html_text`. Comments are plain `text` only, so each one carries the footer.

Task URLs and names are refused; the model must pass the task ID.

Not covered by these checks, so only Step 1 holds these to the project:

- Reply contents. A task in the project can list subtasks, dependencies or other projects it is
  also in, and AgentX returns what Asana returns.
- Users, custom fields and followers that a write names.
- Task links and @-mentions inside `notes`, `html_notes`, comment text and free-text custom field
  values. They can point at tasks in other projects. They do not add a task to the project or
  change what it belongs to, and the bot user can see only what Step 1 shared with it.

Comments are signed. The `notes` and `html_notes` of tasks created or updated are not.

Turn records keep each request's text and tool arguments for 30 days, with known credential
shapes redacted on a best-effort basis; they are readable only by administrators.

### Confirmations

AgentX creates tasks with `create_tasks` without asking, even tasks created already complete. It
checks a change to an existing task against what the member asked: an `update_tasks` call, whose
items name their tasks in `tasks[].task`, and an `add_comment` on a task. It always asks before a
call that sets `completed`, true or false, anywhere in an `update_tasks` item, and before an
`update_tasks` or `create_tasks` call with more than 5 tasks. Asana marks `update_tasks`
destructive; AgentX does not ask for that alone, because it can see the tasks each call names. No
action policy is needed for this.

## Re-authorizing and disconnecting

If the bot user's access is removed, its password is reset or the app's client secret changes, the
refresh token stops working. AgentX then answers that Asana is not connected and names the fix:
run Step 4 again. If you reset the client secret, first update the secret's `clientSecret` with
Step 3's pipe, using `aws secretsmanager put-secret-value --secret-id agentx/connectors/asana-bot`
in place of `create-secret` and dropping `--tags`, then run Step 4.

To disconnect AgentX, signed in as the bot user, remove the app's access in Asana's account
settings, then delete the secret.

## Troubleshooting

- **"port 8765 is in use".** Another program, often another `agentx` command, is listening on it.
  Stop it and run Step 4 again.
- **You approved access, but the browser shows another program's page or an error, and the command
  keeps waiting.** Something else listens on `[::1]:8765`, the IPv6 loopback. The command listens
  only on `127.0.0.1:8765`, so it starts without complaint, but a browser that resolves
  `localhost` to `::1` first sends the sign-in to that other program. Find it with
  `lsof -nP -iTCP:8765 -sTCP:LISTEN`, stop it or free the port, and run Step 4 again.
- **Asana's page says the redirect URI is not allowed.** The app's redirect URL must be exactly the
  one Step 4 prints, `http://localhost:8765/callback` (Step 2, item 3).
- **"no sign-in arrived within 300 seconds".** Nobody approved the sign-in in time, or the browser
  never reached the command. The message repeats the redirect URL the app must use; check it and
  the entry above, then run Step 4 again.
- **After you approve access, the browser shows `ERR_CONNECTION_REFUSED` (or "This site can't be
  reached") for `localhost:8765`.** The command had already stopped waiting: the sign-in must be
  approved within five minutes of starting Step 4, and after that nothing listens on port 8765.
  Run Step 4 again and approve promptly.
- **Asana's page says "invalid_request: This app is not available to your Asana workspace or
  organization. If you are the app owner, adjust settings under "Manage Distribution" in the Asana
  developer console."** The app is not distributed to the bot user's workspace or organisation,
  which is the case for a guest bot user in another email domain. As the app's owner, set **Manage
  Distribution** to **Any workspace**, or add the bot user's workspace or organisation (Step 2,
  item 4), then run Step 4 again.
- **"the token endpoint returned no refresh token".** The app is not an Asana MCP app. Create one
  of that type (Step 2).
- **"the token endpoint refused the sign-in with HTTP 400 (invalid_grant)".** The sign-in took too
  long or was used twice. Run Step 4 again.
- **The command stored your sign-in seconds after it started, before you opened any private
  window.** You ran it without `--no-browser` and you own the Asana app: it opened your default
  browser, signed in to Asana as you, and Asana approved your own app silently. Run Step 4 again
  with `--no-browser --expect-account <bot user's email>`; the new sign-in replaces the stored one.
  Then, signed in as yourself, remove the AgentX app from your own authorized apps in Asana's
  settings.
- **"the sign-in was for ..., not ...; nothing was stored or registered".** `--expect-account`
  refused a sign-in by another account (or by one Asana did not name). AgentX stored and registered
  nothing, but that account has now authorized the app at Asana. Signed in to Asana as that
  account, remove the AgentX app from its authorized apps (Settings → Apps). Then run Step 4 again
  with `--no-browser` and open the URL in a private window signed in only as the bot user.
- **"Signed in to Asana as" names you, or anyone other than the bot user.** The browser was
  signed in to your own account. Run Step 4 again with the sign-in URL opened in a private window
  signed in as the bot user; the new sign-in replaces the stored one. Then, signed in as yourself,
  remove the AgentX app from your own authorized apps in Asana's settings.
- **"secret ... holds binary data, not a JSON string".** The secret was stored as binary. Store it
  again as a JSON string with Step 3's pipe, using `aws secretsmanager put-secret-value --secret-id
  agentx/connectors/asana-bot` in place of `create-secret` and dropping `--tags`.
- **The error says the secret "was not found" and "the control plane reads secrets in its own AWS
  region".** The sign-in stored the token in the region your AWS configuration points at, and the
  control plane runs in another. Running `register` again fails the same way. Create the secret in
  the control plane's region (Step 3 with `--region <region>`), then run Step 4 again with the same
  `--region <region>`, and delete the secret in the wrong region.
- **"could not tag it agentx-writable=refresh-token".** Your AWS credentials lack
  `secretsmanager:TagResource`. Nothing was registered; fix the permission and run Step 4 again.
- **The error ends with "finish with `agentx admin credential register ...` (no new sign-in
  needed)".** The refresh token is stored and tagged; only the registration failed. Run
  `agentx login` if your session expired, then the `register` command the error names (Step 4).
- **Registration is refused with "credential asana-bot is not registered; run agentx admin
  credential authorize first".** Run Step 4, then register the project again.
- **Every call fails as not connected, "sign in again with agentx admin credential authorize".**
  The refresh token was revoked. Run Step 4 again.
- **Every call fails as not connected, "its KMS key does not allow the AgentX broker" or "cannot
  be decrypted".** If a customer-managed key encrypts the secret, the broker role lacks
  `kms:Decrypt` on it (Step 3). Otherwise check the secret's name and region.
- **A log line `connector.refresh_token_unsaved`.** Asana issued a new refresh token and AgentX
  could not save it. In the broker's CloudWatch log group (the control plane stack's `Broker`
  function), search for `connector.refresh_token_unsaved`; the line names the credential and a
  `reason`:
  - `"reason":"AccessDeniedException"` usually means a customer-managed KMS key encrypts the
    secret and the broker role lacks `kms:GenerateDataKey` (or `kms:Encrypt`, if the key policy
    requires it) on it, or that the secret lacks the `agentx-writable` tag. Add the KMS grants from
    Step 3, or run Step 4 again, which tags the secret.
  - `"reason":"LeaseDeadlineExceeded"` means a slow refresh skipped the write; the next refresh
    tries again.
  - `"reason":"SecretChanged"` means the secret's refresh token changed since this refresh read
    it (usually a new sign-in, from Step 4 run again). AgentX dropped the token it could not save
    and kept the secret's. Nothing to do.

  Until the new token is saved, the broker keeps it in memory and retries the write on the next
  refresh. If that copy is lost before it is saved and Asana no longer accepts the old token, calls
  fail as not connected and Step 4 is needed.
- **"Could not confirm that Asana task ... is in the ... project".** Asana answered `get_task` in a
  shape AgentX does not accept, so it refused the call rather than guess. Report it with the
  connector's version.
- **`search_tasks` fails with a vendor error.** The workspace is on a free plan. Approve
  `get_tasks` instead.
