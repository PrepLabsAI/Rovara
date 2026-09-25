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
