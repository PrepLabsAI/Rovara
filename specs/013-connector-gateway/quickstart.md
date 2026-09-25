# Connector gateway live evidence

## Jira (US3)

Part A, before the PR: the broker from this branch against real Atlassian (`tests/live/jira-live.test.ts`).

- Date: 2026-09-24 (US Eastern), run locally from branch `feat/013-phase-6-jira`.
- Endpoint: `https://mcp.atlassian.com/v2/mcp`. Service-account API token sent as a Bearer token.
- Token: 192 characters (checked after storing; the value is never recorded).
- Site: the reference Atlassian site, project `KAN`.
- Vendor-side restriction (guide Step 8): before the fix the service account saw other projects (`project != KAN` returned 5 issues). After restricting its project access: `inside` 3, `outside` 0. Checked again before each run.
- First run: steps 1 and 2 passed, step 3 (create) ended `UNKNOWN`. Nothing was created. Atlassian refused the write with "Insufficient scopes for createJiraIssue. Required: [read:jira:agent-interface, write:jira:agent-interface, search:jira:agent-interface]". The token had been created with five scopes, without `write:jira:agent-interface`. The guide now lists six scopes (Step 5) and has a troubleshooting entry for this.
- Second run, with a six-scope token: the test passed. Its eight steps:
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

Part B, after the production release (T037): not yet run.
