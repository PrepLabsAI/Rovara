# Phase 25e: Owner Questions

Planning phase 25e (admin changes with confirmation and audit) raised eleven product decisions the
spec leaves open. The plan, [phase-25e-admin-changes.md](phase-25e-admin-changes.md), follows each
recommendation; every task that depends on one says "Depends on Q<n>", and Task 18 records the
answers in the spec. If an answer differs from the recommendation, the owning task changes first,
with its tests.

Two owner requirements of 2026-09-29 are already in the plan and are not questions:
`agentx_admin_grant_project_access` with a CLI equivalent (`agentx admin project grant`, and
`revoke`), and `agentx config set limits.workspacesPerMember` / `limits.workspacesPerOrg` lifted
from their "until 25e" refusal and sent through the same change path. Q6 asks how those CLI
commands confirm.

## Q1. How does an admin turn the pop-up confirmation off?

The spec says an environment that wants only confirmations AgentX itself checks turns off
`mcp.confirm.elicitation`, leaving the Slack button. It does not say where that setting lives.

- **A (recommended).** A control-plane stack parameter, `McpConfirmElicitation` (`enabled` by
  default), changed with `agentx config set mcp.confirmElicitation disabled`, the same way as the
  other `agentx config` keys, and kept across upgrades.
- **B.** A setting in AgentX's own table, changed through an admin change (with confirmation and
  audit). Faster to change, but it can be switched off from an AI tool with the very pop-up it
  controls, and the sign-in service would need to read the table too.

**Cost if wrong:** low; A reuses `agentx config`'s existing path. Moving to B later is a small
change in two places.

**Depends on it:** Tasks 10, 11.

## Q2. What does "stop a workspace" do?

FR-030 lists `agentx_admin_stop_workspace`. Today's `agentx admin workspace stop` always answers
"manual compute stop is not supported; idle sessions stop automatically", so there is no stop
handler to apply through.

- **A (recommended).** The tool cancels the task running in the workspace (the existing admin
  cancel), and says its compute then stops on its own when idle. A workspace with nothing running is
  refused with that explanation.
- **B.** Build a real compute stop now, through the session machinery the idle reaper uses. It does
  what the name says, but it is new behaviour with its own risks (a stop during a prepare).
- **C.** Drop the tool from this phase.

**Cost if wrong:** A is small and uses code that already works. B can be added later behind the
same tool.

**Depends on it:** Task 6.

## Q3. Does "revoke sign-in" block the person, or only end their sessions?

FR-030: "the developer and their open sign-in sessions, which end at once". AgentX already has a
`revoked` flag on a developer, which blocks every future sign-in, and nothing clears it.

- **A (recommended).** End every current session at once, and let them sign in again. It is the
  safe "sign them out everywhere" an admin usually wants (a lost laptop, a leaked token).
- **B.** Set the permanent block. It also stops future sign-ins, but there is no tool or command to
  undo it, so a mistake needs a manual database edit.

**Cost if wrong:** A leaves a person who should be banned able to sign in again (their Slack
account or company account is the real control, and access still needs a project grant or a
channel). B can be added later as its own tool with an undo.

**Depends on it:** Tasks 3, 6.

## Q4. Can an admin grant access to someone who has never signed in?

FR-030 says a developer is named by "developer ID, email or Slack user". A Slack user's AgentX ID
can be worked out before they sign in; an email cannot, because the company sign-in's ID is known
only after the person signs in.

- **A (recommended).** A Slack user ID works any time (the grant applies when they sign in with
  Slack); an email works once the person has signed in with it (AgentX remembers each verified
  email from this release on); a developer ID works as it is.
- **B.** Also accept an email for someone who has not signed in, keep it as a waiting grant, and
  apply it at their first sign-in. More convenient for company sign-in users, but it adds a new
  kind of record and a step to every sign-in.

**Cost if wrong:** with A, a company-sign-in user must sign in once before an admin can grant them
by email (or the admin uses their Slack ID). B can be added later without changing A.

**Depends on it:** Tasks 3, 4, 6.

## Q5. Where does a new revision's worker setup come from?

`agentx_admin_register_project_revision` takes only the project definition (FR-030). Registration
also needs the worker's runtime binding (launch template, subnets, disk), which the CLI takes as
flags.

- **A (recommended).** Keep the latest revision's runtime binding unchanged. A project's first
  revision still needs `agentx admin project register` with its flags.
- **B.** Add runtime binding fields to the tool. Flexible, but an AI tool would then choose EC2
  launch templates and subnets, which an admin rarely wants to hand to a model.

**Cost if wrong:** low; B is an added input later.

**Depends on it:** Task 5.

## Q6. How do the new CLI commands confirm a change?

`agentx admin project grant|revoke` and `agentx config set limits.*` go through the same change path
as the AI tool, with its audit record. FR-041 says there is no confirmation method but the pop-up
and the Slack button; FR-042 and D12 say a command a person types needs no further confirmation.

- **A (recommended).** The CLI shows the exact effect and asks "Apply this change?" (skipped with
  `--yes`), and the audit records the method `cli`. The person typing the command is the
  confirmation, as D12 already accepts for every `agentx admin` command. `agentx config set
  limits.*` then also needs the admin sign-in (`agentx login --admin`), since the change path is an
  admin route.
- **B.** Send the Slack Confirm button even for a CLI command. Every change then has a
  confirmation AgentX itself checked, but a typed command waits for a Slack press, and an admin
  without a Slack link cannot use it at all.
- **C.** Keep the CLI outside the change path, with no audit record.

**Cost if wrong:** A's honest limit is the spec's own: a model with shell access and the admin's
sign-in could run `--yes`, as it can run any `agentx admin` command today. B is a small change in the
CLI's change runner.

**Depends on it:** Tasks 7, 14, 15.

## Q7. Who may make changes that are not about one project?

Project changes need the admin's `administrator` membership of that project (FR-015). A connector
credential, ending a developer's sign-in and the workspace limits are not about one project.

- **A (recommended).** Any AgentX admin (the admin claim), as `agentx admin credential register`
  works today.
- **B.** Only an admin who administers every project. Safer on paper, but no admin may qualify
  when projects were registered by different people.

**Cost if wrong:** low; one check per plan.

**Depends on it:** Tasks 4, 5, 6.

## Q8. May an admin name a channel by its name?

FR-030 says the bind tool takes "channel (ID or name)". Finding a channel by name means asking Slack
for the workspace's channel list.

- **A (recommended).** An ID works as it is; a public channel's name (with or without `#`) is looked
  up in Slack; a private channel must be given by its ID (its name is not looked up or shown, as
  for developers).
- **B.** IDs only. Simpler, but an admin in an AI tool rarely knows a channel's ID.

**Cost if wrong:** low; the lookup is one function.

**Depends on it:** Tasks 3, 5.

## Q9. Are a declined, expired or stale change results, or errors?

FR-030 says every change tool "returns the change ID, the outcome (applied, declined, expired,
failed or awaiting_confirmation)". FR-049 lists `CONFIRMATION_DECLINED`, `CONFIRMATION_EXPIRED` and
`CHANGE_STALE` as error codes.

- **A (recommended).** `applied` and `awaiting_confirmation` are normal results. A declined, expired
  or stale change is FR-049's error, and its message names the change ID, so the AI tool clearly
  sees that nothing changed and what to do next.
- **B.** Every outcome is a normal result with an `outcome` field; the error codes are used only for
  refusals before a change is planned.

**Cost if wrong:** low; one mapping function. A reads more clearly to a model; B keeps one shape.

**Depends on it:** Tasks 7, 12, 13.

## Q10. Is there an admin change tool for a shared task's mode?

In 25c the owner let an admin switch a shared task between view only and continue, through `agentx
admin task share-mode`, and 25c said 25d or 25e "may wrap this route". FR-030's table has no such
tool.

- **A (recommended).** Not in this phase; the CLI command covers it, and FR-030's list stays as the
  spec has it.
- **B.** Add `agentx_admin_set_task_share_mode` as a tenth change tool, with confirmation and audit.

**Cost if wrong:** B is additive later (one plan, one tool).

**Depends on it:** nothing in this plan (Not in this phase).

## Q11. Does the admin API version move to 1.1?

25d (its Q1) gave the admin API its own version, 1.0. This phase adds the change routes and `GET
/v1/admin/changes`.

- **A (recommended).** Move it to 1.1. A CLI from this release keeps the admin read tools against
  a 25d AgentX, and offers the change tools and `agentx_admin_changes` only against 1.1.
  `DEVELOPER_API_VERSION` stays 1.2.
- **B.** Keep 1.0, and let the change tools fail against an older AgentX with an unclear error.

**Cost if wrong:** one constant either way; A is the rule 25d set.

**Depends on it:** Tasks 1, 13.
