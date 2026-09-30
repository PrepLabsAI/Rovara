# Phase 25d: Owner Questions

Planning phase 25d (the admin read tools and routes) raised seven product decisions the spec leaves
open. The owner answered all seven on 2026-09-30: five as recommended, Q5 and Q7 changed. The
plan, [phase-25d-admin-reads.md](phase-25d-admin-reads.md), follows the answers; every task that
depends on one says "Depends on Q<n>", and Task 18 records the answers in the spec. Separately, the
owner deferred all live testing until 25d, 25e and spec 040 phases 2 to 4 are built; the plan's
Task 19 is now the checklist for that combined final live check.

## Q1. Does adding the admin tools bump the developer API version?

25d adds admin routes. Each earlier phase moved `DEVELOPER_API_VERSION` (1.1, then 1.2), and an MCP
server refuses every tool when the control plane's version is older than it needs (FR-048). A
developer who upgrades the CLI before the admin upgrades AgentX would lose every tool, even though
the developer tools did not change.

- **A (recommended).** Give the admin API its own version, `adminApiVersion: "1.0"`, reported beside
  the developer one. `DEVELOPER_API_VERSION` stays 1.2. Against an older AgentX, the developer tools
  keep working, the admin tools are simply not offered, and `agentx_whoami` says an AgentX upgrade
  adds them.
- **B.** Move `DEVELOPER_API_VERSION` to 1.3. Simple, but a new CLI then refuses every tool, the
  developer ones included, until AgentX is upgraded.

**Cost if wrong:** low either way; one constant and one check. A keeps developers working through
an upgrade window; 25e would then move only the admin version (to 1.1).

**Depends on it:** Tasks 1, 10, 14, 16.

**Owner answer (2026-09-30):** A, the recommendation, accepted: `adminApiVersion` 1.0, `DEVELOPER_API_VERSION` stays 1.2.

## Q2. Which projects does the admin project list show?

AgentX has no list of all projects today, and the plan never scans the table (a scan gets slower
and costlier as the table grows). From this release on, every registration also writes a project
list entry. Projects registered before this release are not in that list yet.

- **A (recommended).** Show the new list, plus every project a channel is bound to, plus every
  project the asking admin registered. An older project that nobody binds and another admin
  registered shows up after its next revision. This matches spec 041's rule for workspaces
  ("listings show what was created since the release").
- **B.** Also fill the list once for older projects: the session reconciler reads the whole table a
  page at a time in the background, over hours on a large table, until done.

**Cost if wrong:** with A, an admin may not see an old unbound project in their AI tool until it
gets a new revision (the CLI still works on it by name). B adds a background job and its tests;
it can be added later without changing anything in A.

**Depends on it:** Task 2 (and Tasks 9, 12, which reuse the list).

**Owner answer (2026-09-30):** A, the recommendation, accepted.

## Q3. How does AgentX learn an admin's email?

`GET /v1/admin/me` must say whether the signed-in admin matches a Slack user (FR-041), which 25e's
Slack Confirm button needs, and 25e's audit records want the admin's name (FR-051). The admin
sign-in (Cognito, or the company's OIDC) sends AgentX an access token, and Cognito's access tokens
carry no email.

- **A (recommended).** Ask the admin sign-in's own `userinfo` endpoint (standard OIDC), with the
  admin's token, and trust the email only when it is marked verified. No setup, and it works for
  Cognito and most company sign-ins.
- **B.** Have the CLI also keep the sign-in's ID token and send it with each admin call. More moving
  parts in the CLI, and the ID token expires with the access token anyway.
- **C.** Let each admin link their Slack user by hand (an admin command). Works without email, but
  it is one more setup step, and a mistyped link would send Confirm buttons to the wrong person.

**Cost if wrong:** A is one module; if an environment's sign-in has no `userinfo`, the admin simply
has no Slack link and uses the pop-up confirmation instead. The deferred combined final live check
(Task 19 Step 8) checks Cognito's answer.

**Depends on it:** Task 11.

**Owner answer (2026-09-30):** A, the recommendation, accepted: the admin issuer's `userinfo` endpoint.

## Q4. Does the MCP server renew an expired admin sign-in by itself?

Cognito's admin sign-ins last one hour. Every `agentx admin` command today stops at that point and
says "run agentx login". The MCP server could instead renew it silently, with the renewal token the
computer already holds.

- **A (recommended).** No renewal, the same as the CLI: when the admin sign-in expires, the admin
  tools disappear and a call says to run `npx @charterarc/agentx login --admin`. Short admin
  sessions are safer for tools that will change AgentX in 25e.
- **B.** Renew silently for as long as the renewal token allows (for Cognito, 30 days by default).
  Smoother for the admin, but an AI tool left open keeps admin rights for weeks.

**Cost if wrong:** with A, an admin signs in again about once an hour of admin work. B is a small
change later (the developer sign-in already renews this way).

**Depends on it:** Task 16.

**Owner answer (2026-09-30):** A, the recommendation, accepted: no renewal of the admin sign-in in the MCP server.

## Q5. How do failure and usage records expire after 30 days?

FR-038 says the failure index keeps 30 days. The state table has no automatic expiry, and adding
one would change the table in every environment, including the legacy production template, which
this project never changes.

- **A (recommended).** The session reconciler (already running every 10 minutes) deletes index days
  older than 30 days, up to 500 records a run; reads never look further back than 30 days anyway.
  No template change anywhere.
- **B.** Turn on the table's automatic expiry in named environments only, on a new attribute, and
  leave the legacy deployment's records to pile up (they are small).

**Cost if wrong:** low. A is a small job in code that already exists; B saves that job but changes a
retained table in every named environment and leaves legacy records forever.

**Depends on it:** Task 5.

**Owner answer (2026-09-30):** changed. Use DynamoDB TTL on the failure and usage records in installed (named) environments only: each record carries `indexExpiresAt`, and the named environment's State table enables TTL on that attribute (no other State item carries it; a test pins that). Keep the reconciler cleanup only for the legacy deployment, whose templates stay byte-identical. The plan's A6 and Tasks 1, 4, 5, 6, 8 and 13 follow this.

## Q6. What does `agentx_admin_usage` count?

FR-030 asks for turns, tasks, task time, tokens and cost "as the usage records carry it". Two kinds
of records carry usage: each worker task's usage record (spec 011), and each Slack turn's record of
the orchestrator model's tokens.

- **A (recommended).** Both: `turns` counts Slack turns and adds the orchestrator model's tokens and
  cost; `tasks` counts worker tasks and adds theirs. A cost the provider did not report is counted
  separately (`cost_unknown`) rather than as zero.
- **B.** Worker tasks only. Simpler, but it hides what the orchestrator model costs.

**Cost if wrong:** low; which sources are summed is one function.

**Depends on it:** Task 8.

**Owner answer (2026-09-30):** A, the recommendation, accepted: Slack turns and worker tasks, with unknown costs counted separately.

## Q7. Do admins see private channel names in the AI tool?

For developers, a private channel's name never leaves AgentX (rule R10); only its ID does. Admin
results also go into the AI tool's model context.

- **A (recommended).** Keep the rule for admins too: private channels by ID, with `private: true`;
  public channels by name.
- **B.** Show admins every channel's name. Easier to read, but the names of private channels (which
  can reveal unannounced work) then reach the AI model and its logs.

**Cost if wrong:** one line in one function either way.

**Depends on it:** Task 3.

**Owner answer (2026-09-30):** changed, to a middle option: an admin sees a private channel's name only when the admin's linked Slack user is a member of that channel (checked with `conversations.members`, the same cache rules as the developer access checks); otherwise its ID only. Public channel names are always shown. The plan's A11 and Tasks 3, 11 and 15 follow this.
