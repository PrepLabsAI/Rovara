# Spec 025 phases

Spec 025 is too large for one plan. It is built in five phases. Each phase has its own plan, branch
and PR against mainline, and leaves mainline releasable. Each phase's plan is written when the
previous phase merges, so it can build on what actually landed.

| Phase | Plan | What it delivers | Spec |
|---|---|---|---|
| 25a | phase-25a-signin.md | The constitution amendment. The control plane as developer sign-in server: Sign in with Slack with the team check, company OIDC with the optional group, AgentX tokens signed by KMS, rotating refresh tokens, revocation. The second JWT authorizer on `/v1/dev/*`. The environment's Slack team ID. Project access (grants and channel membership, the Slack email link). `agentx login <url>`, `login --admin`, `logout`, `whoami`, `signin enable/disable/show`, the `init` step and `doctor` checks. `GET /v1/dev/projects`. | FR-001 to FR-013, FR-015, FR-044 to FR-046, FR-048, FR-050; US4 |
| 25b | phase-25b-developer-tasks.md | The developer task API with one workspace per task, the task index, shared workspace limits, the developer requester on operations, the PR footer, AI-tool turn records. The `@agentx/mcp` package and `agentx mcp` with the developer tools, waits and progress, redaction, error codes. `agentx mcp install` and the install guide. The `developerTasks` project settings; until 25c ships, a start that asks to share, or on a project whose `share` is `required`, is refused with `CHANNEL_REQUIRED` and a message that sharing is not yet available. | FR-014, FR-016 to FR-030 (developer tools), FR-033, FR-036, FR-037, FR-043, FR-047, FR-049; US1, US2, US7 |
| 25c | phase-25c-sharing.md | Share to channel and required sharing, `agentx_share_task`, the `DeveloperTaskNotifier`, the shared thread's messages and retries, the ingress notice in shared threads. | FR-031, FR-032, FR-034, FR-035; US3 |
| 25d | phase-25d-admin-reads.md | The admin read routes (projects, bindings, workspaces, failures with the failure index, usage, health, me) and the admin read tools; the tool list that depends on the admin token. | FR-028, FR-030 (admin read tools), FR-038; US5 |
| 25e | phase-25e-admin-changes.md | Pending changes and `apply`, the audit record, the three confirmation methods (elicitation, Slack button, one-time code page with a fresh admin sign-in), the admin change tools, and the read-only fallback. | FR-030 (admin change tools), FR-039 to FR-042; US6 |

The order follows the owner's priorities and the dependencies: every later phase needs 25a's
sign-in; developer hand-off (25b) comes before sharing (25c) and before the admin tools (25d, 25e);
admin changes come last because they carry the confirmation machinery, and reuse 25c's notifier for
the Slack Confirm button.

Each phase that changes behavior ends with the live check in the spec's Testing section, with the
owner present, in a throwaway environment.
