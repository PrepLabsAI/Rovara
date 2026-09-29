# Phase 25c: Owner Questions

Building phase 25c (sharing a task to its Slack channel, and the stuck-setup sweep) raised nine
product decisions the spec left open. The owner answered all nine on 2026-09-29: seven as
recommended, Q2 changed (an AgentX admin may also switch a shared task's mode), and Q7 approved.
Separately, the owner raised the stuck-setup limit from 15 to 50 minutes, because the instance
provisioner allows 45; the spec's FR-055 and D21 say so. The plan,
[phase-25c-sharing.md](phase-25c-sharing.md), follows every answer; every task that depends on one
says "Depends on Q<n>", and Task 17 records the answers in the spec.

## Q1. What does a view-only thread say when someone mentions AgentX in it?

FR-035 and US3 scenario 4 fix what it must convey (the task is driven from the developer's AI tool;
a new message in the channel starts a new thread workspace) and that it is sent at most once an
hour per thread, but not the words.

- **A (recommended).** "This thread follows a task that a developer is driving from their AI tool,
  so I don't act on messages here. To ask AgentX for something, post a new message in the channel;
  it starts its own thread workspace." A closed task's thread gets the same second sentence after
  "The task this thread followed is closed, so I don't act on messages here."
- **B.** Name the developer ("Maya is driving this task from Claude Code..."). Friendlier, but the
  notice is then no longer fixed text, and it repeats a name the start message already shows.
- **C.** A shorter line ("View only. Start a new message in the channel to ask AgentX."). Terse, but
  a teammate new to AI-tool tasks may not understand why AgentX ignores them.

**Cost if wrong:** low. The words are two constants in the contracts package; changing them is a
one-line change and a test update.

**Depends on it:** Tasks 1, 2, 9, 11.

**Owner answer (2026-09-29):** A, the recommendation, accepted.

## Q2. Who may switch a shared task between view only and continue?

The spec gives the developer `agentx_share_task` (FR-030) and says the admin sets the policy
(`shareMode`), but does not say whether anyone else may flip a given task's mode.

- **A (recommended).** Only the developer who owns the task, from their AI tool, within the
  project's current policy. An admin's control is the policy itself: registering a revision with
  `allowContinue: false` makes later requests for continue view only.
- **B.** Also admins, per task, through a 25e admin change tool (with confirmation and audit).
- **C.** Also channel members, from the thread ("make this view only").

**Cost if wrong:** A to B is additive later (a new admin change tool in 25e). C would be a real
security change (anyone in the channel could open a developer's task to everyone), so choosing it
later means new checks in the ingress and the broker.

**Depends on it:** Task 4 (and the tool description in Task 15).

**Owner answer (2026-09-29):** changed. The owning developer or an AgentX admin may switch a shared task between view only and continue, within the project's `shareMode` policy. The plan's C25 rules on the smallest safe admin path: `POST /v1/admin/tasks/{taskId}/share-mode` behind FR-015's admin checks, and `agentx admin task share-mode`; mode changes only (no first share, no channel change); audited with a `share` record naming the admin; no MCP admin tool until 25d and 25e.

## Q3. What happens to a shared thread when the task closes?

FR-032 says the thread gets a reply when the task is closed, but not what later mentions in that
thread do.

- **A (recommended).** The thread gets "The task is closed, and its workspace is released. This
  thread no longer drives it." The shared thread record is marked closed. Later mentions, in view or
  continue mode, get a closed notice (at most once an hour) and nothing runs; no thread workspace is
  created on the old thread.
- **B.** Ignore later mentions silently.
- **C.** Let a mention after the close start a fresh thread workspace in that same thread, as any
  Slack thread would.

**Cost if wrong:** B is a one-line change from A. C needs the shared record deleted or ignored at
close, and invites confusion (the thread's history is about another workspace), so moving to it later
means changing the close, the ingress and the broker's identity rules.

**Depends on it:** Tasks 4, 7, 9, 10, 11.

**Owner answer (2026-09-29):** A, the recommendation, accepted.

## Q4. Does the stuck-setup sweep cover Slack thread setups too?

FR-055 is written about a developer task's workspace; D21 says "fails any prepare older than 15
minutes". Slack threads have their own existing handling (the Slack service stops waiting and says
setup is slow, and the next mention retries setup).

- **A (recommended).** Only developer-task prepares. The start writes a small watch item the sweep
  reads; Slack thread behaviour does not change (SC-008).
- **B.** Every prepare, Slack threads included.

**Cost if wrong:** with A, a Slack thread whose setup callback is lost stays in setup until the next
mention retries it, as today. With B, a slow but healthy Slack setup (a large devcontainer) could be
failed at 15 minutes, and the Slack path's characterization tests change. Moving from A to B later
means writing the watch item in the Slack prepare paths too.

**Depends on it:** Task 13.

**Owner answer (2026-09-29):** A, developer-task setups only, accepted.

## Q5. When do the 15 minutes start, and are they enough for a cold first setup?

The owner decided 15 minutes (D21). The spec says "15 minutes after it started". A first setup
includes launching the EC2 instance (the provisioner allows up to 45 minutes) and building the
devcontainer.

- **A (recommended).** From the prepare's creation, which is the task's start. Simple and matches
  the words; the live check (Task 18) records how long real first setups take, so the number can be
  revisited with evidence.
- **B.** From when a worker first reports the prepare running (after the instance is ready). Kinder
  to slow launches, but a prepare whose dispatch never happens would then never be swept, which is
  one of the causes D21 meant to cover.
- **C.** Keep A but raise the limit to 30 minutes.

**Cost if wrong:** with A, a slow but healthy first setup is failed and the developer starts the task
again (it reads `setup_failed` with a message saying so). The number is one constant; the start
point is one field of the watch item.

**Depends on it:** Task 13.

**Owner answer (2026-09-29):** A, the clock starts at the task's start, accepted. The limit itself was changed from 15 to 50 minutes (owner decision, 2026-09-29), because the provisioner allows 45 and the reconciler runs every 10, so a stuck setup is failed 50 to 60 minutes after it started.

## Q6. Should the start and share answers wait for the Slack thread link?

FR-030 lists "thread link if shared" in `agentx_start_task`'s output, but the broker cannot post to
Slack (D11), so the link exists only once the notifier has posted, usually within a few seconds.

- **A (recommended).** Answer at once, with `share_posting: true`; `agentx_get_task` shows
  `thread_url` a few seconds later, and a start with `wait_seconds` shows it when the wait ends.
  SC-002's 5-second start holds.
- **B.** Hold the answer up to about 5 seconds, polling for the link.

**Cost if wrong:** B spends most of SC-002's 5-second budget on every shared start and still returns
without a link when Slack is slow. Moving to B later is a small change in the start and share routes.

**Depends on it:** Tasks 3, 4, 15.

**Owner answer (2026-09-29):** A, answer at once, accepted.

## Q7. Does the developer API version move to 1.2?

25c adds a route (`POST /v1/dev/tasks/{taskId}/share`). FR-048's build ruling says a control plane
whose minor version is older than the tools need gets `UPGRADE_REQUIRED` on every tool. The owner
approved 25b's move to 1.1 explicitly (SC-008), so this move needs the same approval.

- **A (recommended).** Move to 1.2. An MCP server from this release refuses a 25b control plane with
  `UPGRADE_REQUIRED` and "ask your AgentX admin to upgrade AgentX", as FR-048 says.
- **B.** Stay on 1.1. Against a 25b control plane every tool works except `agentx_share_task`, which
  fails with `CONTROL_PLANE_UNAVAILABLE`, and `share_to_channel` gets 25b's "not available yet".

**Cost if wrong:** A blocks a developer who upgraded their CLI before the admin upgraded AgentX,
until the admin does. B gives a confusing error for one tool. Either is a one-constant change.

**Depends on it:** Tasks 1, 15.

**Owner answer (2026-09-29):** A, approved: `DEVELOPER_API_VERSION` moves to 1.2.

## Q8. What does "stop" do in a continue thread?

Today any member of a bound channel may stop their thread's running task (#126). In a continue
thread the running operation may be the developer's own, or a teammate's.

- **A (recommended).** A teammate's "stop" cancels the running task operation, whoever started it:
  continue mode means the channel may steer the task, and the developer can already cancel a
  teammate's operation (D4). The developer sees `CANCELLED` in `agentx_get_task`. In a view-only or
  closed thread, "stop" gets the notice and stops nothing.
- **B.** "Stop" cancels only an operation a channel turn started; the developer's own run can only
  be cancelled from their AI tool.

**Cost if wrong:** B needs the stop path to read who started the running operation (the channel
operation record this plan already writes), a small change.

**Depends on it:** Task 10.

**Owner answer (2026-09-29):** A, a teammate's stop cancels the running operation whoever started it, accepted.

## Q9. Is sharing a task, or changing its mode, audited?

FR-037 lists start, continue, pull request, cancel and close as the actions that write an
`accepted` turn record. It does not name sharing, which arrived with 25c.

- **A (recommended).** Yes: `agentx_share_task` writes an `accepted` AI-tool turn record with the
  new action `share` (the record schema's action list gains one value), in the same transaction as
  the change. A share decided at the start is already in the start's record.
- **B.** No record; the thread's own messages show the change.

**Cost if wrong:** A adds one value to the turn record's action list. The CLI's export parses
records with the contracts schema, so a CLI older than this release would refuse an export that
holds a `share` record, the same kind of change 25b's `ai_tool` origin was. B leaves no
admin-readable record of a compliance-relevant change (opening a task to a channel), and adding it
later is the same one-value change plus the write.

**Depends on it:** Tasks 1, 4.

**Owner answer (2026-09-29):** A, audit a `share` action, accepted.

## Q10. Sharing into a private bound channel the developer is not a member of (raised in Task 3's review)

The spec allowed any developer who may use the project to share into any bound channel, private ones included.

**Owner answer (2026-09-29):** refuse it. Sharing into a private channel needs the developer to be a member of it; otherwise the start or share is refused with a message to join the channel first or share to one of the project's public channels. Implemented as a small change after Task 4, and written into FR-031 by Task 17.
