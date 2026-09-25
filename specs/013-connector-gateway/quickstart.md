# Connector gateway live evidence

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

Part B, after the production release (T037): not yet run.

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
