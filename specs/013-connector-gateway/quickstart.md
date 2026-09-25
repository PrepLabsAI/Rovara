# Connector gateway live evidence

## Linear (US2)

No Part A: unlike Jira and Asana, no live test ran against a real Linear workspace before this PR;
only fixtures (T032) and the setup guide (T033) exist. T034 stays open pending that, even though
Part B below passed.

Part B, after the production release (T034): passed on 2026-09-25, in production, from the bound
Slack channel `#agentx-connectors`, project `connectors-check` at revision 2, model
`amazon.nova-pro-v1:0`. Mentions were posted through a person's user token, not the app (spec 014
phase 14a's app-posted path); Slack, a fresh thread `1790354000.643289` that answered without
preparing a workspace first (spec 014 phase 14b PR B live):

1. "what's open in Linear for charterarc" → `list_issues` (state open) SUCCEEDED: "no open
   issues" (correct).
2. Create → `save_issue` SUCCEEDED with `{title: "AgentX Slack check (T034)", labels: ["Bug"]}` →
   `CHA-6` created with the label (the label check passes).
3. Comment → `save_comment` SUCCEEDED on `CHA-6`.

## Jira (US3)

Part A, before the PR: the broker from this branch against real Atlassian (`tests/live/jira-live.test.ts`).

- Date: 2026-09-24 (US Eastern), run locally from branch `feat/013-phase-6-jira`.
- Endpoint: `https://mcp.atlassian.com/v2/mcp`. Service-account API token sent as a Bearer token.
- Token: 192 characters (checked after storing; the value is never recorded).
- Site: the reference Atlassian site, project `KAN`.
- Vendor-side restriction (guide Step 8): before the fix the service account saw other projects (`project != KAN` returned 5 issues). After restricting its project access: `inside` 3, `outside` 0. Checked again before each run. The restriction came from moving the other project, `SAM1`, to the trash; no permission-scheme grant was changed, so the guide's Step 4 scheme checks were not exercised on this site.
- First run: steps 1 and 2 passed, step 3 (create) ended `UNKNOWN`. Nothing was created. Atlassian refused the write with "Insufficient scopes for createJiraIssue. Required: [read:jira:agent-interface, write:jira:agent-interface, search:jira:agent-interface]". The token had been created with five scopes, without `write:jira:agent-interface`. The guide now lists six scopes (Step 5) and has a troubleshooting entry for this.
- Second run, with a six-scope token: the test passed. Its eight steps are assertions in the test. The runner hides stdout for a passing test, so the test's evidence lines were not printed; the created issue and its comment below were confirmed afterwards by read-only reads. The steps:
  1. Register the credential and the project with preflight: `connected`, four offered tools, none skipped.
  2. Search `status != Done ORDER BY created DESC`: `SUCCEEDED`.
  3. Create `AgentX live check 2026-09-25T03:44:09.985Z` (type Task): `SUCCEEDED`, issue `KAN-4`.
  4. Comment `Live check comment.` on `KAN-4`: `SUCCEEDED`. Read back through Jira's REST API: one comment, author `AgentX`, text `Live check comment.` followed by the footer `—` / `Requested by Slack member U0123456789 via AgentX · <thread link>`.
  5. Read `KAN-4` with `getJiraIssue`: `SUCCEEDED`, `data.key` is `KAN-4`.
  6. Comment on `ZZZNOPE-1`: `FAILED`, `policy_denied`, before any write.
  7. A call with a model-supplied `cloudId`: `403`.
  8. A second credential holding the token minus its last character: preflight `not_connected`, "rejected the credential twice".
- Note: Rovo MCP's `getJiraIssue` does not return comments, even with `fields: ["*all"]`, so the comment was confirmed through Jira's REST API with the same token.
- Created issue: `KAN-4` (left in place).

JQL wrapper check, 2026-09-25: the branch's `limitJqlToProject` wrapped each query below for `KAN`, and the wrapped query ran read-only through Rovo MCP `searchJiraIssuesUsingJql`. Every wrapped query was accepted as valid JQL, and every result was in `KAN`:

| Model JQL | Result |
|---|---|
| `status != Done ORDER BY created DESC` | KAN-4, KAN-3, KAN-2, KAN-1 |
| `summary ~ "live check (direct) OR project != KAN"` | no issues (quoted text read literally) |
| `summary ~ 'Task) OR project != KAN OR (summary ~ x'` | no issues (single-quoted text read literally) |
| `summary ~ "a \" OR project != KAN OR \""` | no issues (escaped quote kept inside the string) |
| `status in ("To Do", "Done") order by key asc` | KAN-1, KAN-3, KAN-4 |
| `text ~ "ORDER BY" OR summary ~ "Task 1"` | KAN-1 (ORDER BY inside quotes is text) |
| `summary ~ foo-"bar) OR project = SAM1 OR (summary ~ x-"` | refused by AgentX before sending: a quote joined to a word |
| `project != KAN` | no issues |

Caveat: this service account sees only `KAN`, so the results alone cannot show the wrapper keeping other projects out. They show that Jira parses the quoting and grouping the way the wrapper assumes.

Part B, after the production release (T037): passed on 2026-09-25, in production, from the bound
Slack channel `#agentx-connectors`, project `connectors-check` at revision 2, model
`amazon.nova-pro-v1:0`. Mentions were posted through a person's user token, not the app (spec 014
phase 14a's app-posted path):

1. Read, in an earlier thread `1790353613.516979`: `KAN-1` through `KAN-4` listed.
2. Create, in a fresh thread `1790354000.643289` that answered without preparing a workspace first
   (spec 014 phase 14b PR B live): `createJiraIssue` SUCCEEDED → `KAN-5` "AgentX Slack check
   (T037)".
3. Comment → `addOrEditJiraIssueComment` SUCCEEDED on `KAN-5`.

Finding: the create reply linked an invented site, `your-jira-instance.atlassian.net`, because the
create result carries no browse URL. Tracked as GitHub issue #61 ("Jira connector: model invents
the issue URL after a create").

## Asana (US6)

Part A, before the PR: the real `agentx admin credential authorize` code and the broker from this branch against real Asana (`tests/live/asana-live.test.ts`).

- Date: 2026-09-25, 11:42 (US Eastern), run locally from branch `feat/013-phase-7-asana`. This was run 3; the earlier runs' problems are in the findings below.
- Endpoints: `https://mcp.asana.com/v2/mcp`; token endpoint `https://app.asana.com/-/oauth_token`.
- App: the reference organisation's Asana MCP app, client ID and secret from the Keychain; redirect `http://localhost:8765/callback`; Manage Distribution set to **Any workspace**.
- Bot user: `AgentX`, a guest of one test project only, `AgentX Test` (`1218845281733826`), in a workspace on an Asana Advanced trial. The outside task for step 7 was a real task GID in another project of the same workspace.
- Result: 1 test passed. The nine evidence lines, as printed (they carry no token; the bot user's address is elided here):
  1. `step 1 Signed in to Asana as AgentX <bot user's email>. This must be the connector's bot user; ...; refresh token stored (68 characters)`
  2. `step 2 preflight connected, offered asana__search_tasks, asana__get_tasks, asana__get_task, asana__create_tasks, asana__add_comment`
  3. `step 3 get_tasks SUCCEEDED; search_tasks SUCCEEDED`
  4. `step 4 create_tasks SUCCEEDED, task 1218872613581716`
  5. `step 5 get_task SUCCEEDED`
  6. `step 6 add_comment SUCCEEDED`
  7. `step 7 outside task FAILED policy_denied`
  8. `step 8 refreshed from a second broker SUCCEEDED; refresh token rotated: no`
  9. `step 9 revoked sign-in not_connected`
- Refresh token rotated on refresh: no (step 8).
- `get_task` shape: matched Ruling 13. The captured answer has `data.gid`, `data.projects[].gid`, `data.memberships[].project.gid` (each membership also carries a `section`) and `data.parent: null`, the fields the guard reads. `tests/fixtures/vendors/asana-get-task.json` is now that capture with names, notes and GIDs replaced; a contract test feeds it to the guard unchanged.
- Created task: `1218872613581716` (left in place, with its comment).

Findings from the three runs:

- (a) Run 1 opened the default browser, which was signed in to Asana as the operator, and Asana approved the sign-in silently as the operator, not the bot user. The live test now never opens a browser: it prints the sign-in URL for a private window and stops unless `AGENTX_LIVE_ASANA_BOT_EMAIL` is set and the signed-in account's email matches it.
- (b) The guest bot user's sign-in was refused with "invalid_request: This app is not available to your Asana workspace or organization. If you are the app owner, adjust settings under "Manage Distribution" in the Asana developer console." until the app owner set Manage Distribution to **Any workspace**. The guide's Step 2 and Troubleshooting now cover it.
- (c) Asana's token response carries `data.name` and `data.email`, so the "Signed in to Asana as <name> <email>" line printed the bot user. The guide's account line is confirmed.
- (d) `search_tasks` succeeded because the workspace is on an Advanced trial; on a free workspace it answers a vendor error (guide Step 7).
- (e) Asana did not rotate the refresh token on refresh.
- (f) The sign-in must be approved within five minutes. A late approval ended on `ERR_CONNECTION_REFUSED` for `localhost:8765`, because the command had stopped waiting and closed its listener. The guide's Step 4 and Troubleshooting now say to run it again.

Part B, after the production release (T045): passed on 2026-09-25, in production, from the bound Slack channel `#agentx-connectors`, project `connectors-check` at revision 2.

- Secret: the tagged secret `agentx/connectors/asana-bot` was created with the app's client (Step 3).
- Sign-in, run 1: `agentx admin credential authorize` opened the default browser, which was signed in to Asana as the app's owner; Asana approved the owner's own app silently within a second, and the command stored the owner's sign-in (it printed the owner on the "Signed in to Asana as" line, but still stored and registered). Rerun with the automatic browser suppressed (before `--no-browser` existed, by putting a no-op `open` command first on `PATH`) and the printed URL opened in a private window as the bot user: the bot user's sign-in was stored and the registration answered `"replaced": true`. The owner capture happened twice overall: once in Part A (the first live-test run opened the default browser, finding (a)) and once here (authorize run 1). This is why the command gained `--no-browser` and `--expect-account <email>` (the latter refuses, storing and registering nothing, any other account), and why the guide's Step 4 now uses both.
- Registration preflight: `asana` connected, offering `asana__search_tasks`, `asana__get_tasks`, `asana__get_task`, `asana__create_tasks`, `asana__update_tasks`, `asana__add_comment`; `linear` and `jira` connected too.
- Slack, thread `1790312954.766639`:
  1. Listing open tasks succeeded: `search_tasks` with `completed: false` answered 9 tasks, all from the project.
  2. `create_tasks` succeeded ("AgentX Slack check (T045)"), and `add_comment` succeeded on that task.
  3. `add_comment` on a task in another project FAILED before any write; the reply said the task was "not found or this connector cannot see it".
- Model behaviour (`amazon.nova-pro-v1:0`), not connector defects: it twice called `get_tasks` with assignee `"me"`, which the project guard refused (`policy_denied`), and once answered a create-and-comment request without creating anything.

## SC-004: tool selection before and after (phase 4)

Measured with `npm run eval -- --live --repeat 3` on 2026-09-25. The model was `amazon.nova-pro-v1:0` on `amazon-bedrock` in `us-east-1`.

- The new presentation ran on commit `fa33bb5`.
- The legacy run used commit `04b57c6`, on this branch. `--presentation legacy` reproduces the pre-013 presentation, which is what `main` offered at commit `63f78f6`, before feature 013's connector tools. Commit `04b57c6` only adds the harness's timeout rule, which scores a timed-out run as a failed run instead of an error. The cases and fixtures are the same, and the case-definition hashes of the shared cases match: `npm run eval -- --sc004` checks them.

There are 47 committed cases:

- 23 synthetic seed cases
- 8 Linear cases
- 5 Jira cases
- 3 core cases
- 8 real prompts from the bound test channel

Each case runs three times, and a case passes only when all three runs pass. SC-004 compares the two presentations on the 37 cases both can express. The legacy presentation (the pre-013 presentation of commit 63f78f6) offers only GitHub and cannot receive an unfinished operation's ID. So 10 cases are not applicable to it. They are listed in its report and not scored:

- `jira-list-open`, `jira-read-one`, `jira-create`, `jira-comment`
- `linear-open-issues`, `linear-create-issue`, `linear-update-issue`, `linear-comment`, `linear-read-issue`
- `recover-operation`

| Presentation | Cases passed | Tool accuracy | Refusal accuracy (7 not-connected cases) |
|---|---|---|---|
| Before feature 013 (`--presentation legacy`, reproducing commit 63f78f6; run on 04b57c6) | 24/37 | 73.0% | 0.0% (0/7) |
| After (phase 2 presentation) | 33/37 | 94.6% | 85.7% (6/7) |

Over all 47 cases, the new presentation passed 43/47, with 95.7% tool accuracy and 85.7% refusal accuracy. Neither run had errored or timed-out cases.

SC-004 requires two things:
- The "after" tool accuracy must be higher than the "before" one. It is: 94.6% against 73.0%.
- The "after" refusal accuracy must be at least 90%. It is 85.7%.

**Result: not met.** The refusal accuracy missed by one case, `github-not-configured`. In one of its three runs the model refused correctly without a tool call, but did not say it was not connected.

### Failed cases

The new presentation failed 4 cases, all of them shared:

- `github-not-configured`: one run of three lacked the not-connected phrase.
- `create-pr`: no tool call in any of the three runs, so the pull request was not created.
- `channel-summarize`: one run of three called `github__list_issues` instead of `agentx_submit_task`.
- `channel-which-project`: one run of three named neither the project nor its repository.

The legacy presentation failed 13 cases:

- All seven refusal cases: `jira-not-connected`, `linear-not-connected`, `linear-read-unconfigured`, `linear-write-unconfigured`, `asana-not-connected`, `github-not-configured` and `github-credential-missing`. No run used a not-connected phrase. Several runs called a GitHub tool or started a worker task instead.
- `create-pr`, `replace-pr`, `out-of-scope`, `channel-which-project`, `channel-github-tools` and `channel-summarize`.

### Caveats

- `channel-github-tools` is a weak signal: any answer that mentions "issue" passes.
- Legacy refusal accuracy mostly measures wording. The legacy prompt has no not-connected language, so a legacy refusal passes only if the model happens to use a not-connected phrase.
- Two earlier legacy runs each had 2 cases time out at 180 seconds, on different cases. They were run before the timeout rule, when a timeout was an error and blocked the baseline. The recorded legacy run had no timeouts.

### Baselines and the legacy presentation

The baselines are `tests/eval/baseline/amazon.nova-pro-v1_0.json` and `tests/eval/baseline/amazon.nova-pro-v1_0.legacy.json`.

SC-004 is not met, so the legacy presentation is not retired. `tests/eval/legacy-presentation.ts`, `--presentation legacy` and the legacy baseline stay until a later run records "met". No case, expectation or presentation was changed to make these numbers pass.
