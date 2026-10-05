# Feature Specification: Pull Request Events, Review Comments, and Multi-PR Coordination

**Feature Branch**: `codex/agentx-native-workflow`
**Created**: 2026-10-05
**Status**: Approved for implementation by owner
**Input**: DEC-032, E-030, AgentX spec 002
**Constitution**: 4.1.0

## Context

AgentX can create and manage pull requests, but it does not yet receive PR state changes and review
comments reliably. GitHub remains the source of truth for PR state. AgentX stores verified PR
references and coordinates its task stages. GitHub issue events and issue-to-task linking are out of
scope; a GitHub issue never starts AgentX work.

## User stories & testing

### Story 1 — Track every required pull request (P1)

A task spanning repositories records its expected PR set. It becomes `WAIT_FOR_MERGE` only after
all required PRs exist and satisfy configured checks and reviews. GitHub merge events update each
PR's observed state; one merged PR cannot complete the task early.

**Independent test:** Use fake GitHub events for two repositories; merge one PR and ensure the task
remains waiting; merge the other and confirm the workflow reports observed merge state.

### Story 2 — Ask before acting on PR feedback (P1)

When a new review or discussion comment appears on a workflow PR, AgentX posts a short Slack update
in that task's thread. It links to the comment, summarizes the requested change, and proposes a
small fix plan. AgentX does not change code or reply on GitHub until the task owner approves that
plan in Slack. The approval is bound to the exact task, PR, comment IDs, candidate, and plan version.
After approval, AgentX makes the change and reruns required checks and reviews for the new candidate.

**Independent test:** Deliver a signed PR comment; verify the owner sees its summary and proposed
plan in Slack, no code change occurs before approval, stale approvals are refused, and approval
triggers work followed by fresh candidate-bound checks and reviews. No automatic GitHub reply occurs.

## Functional requirements

- **FR-001:** GitHub ingress MUST verify the provider signature and registered installation/repo
  scope before using PR event data.
- **FR-002:** Each delivery ID MUST be durably deduplicated. Replays have one effect; delayed and
  out-of-order PR events MUST reconcile to current authoritative GitHub state.
- **FR-003:** Only pull-request state and PR comment events are in scope. Issue events MUST be
  rejected and MUST NOT create, start, or restart AgentX work.
- **FR-004:** A workflow MUST record the expected repository/PR set and the candidate manifest for
  each PR. Missing required PRs remain visible blockers.
- **FR-005:** A task with multiple required PRs MUST remain open until every required PR is observed
  merged and every required check/review is current and satisfied.
- **FR-006:** GitHub remains authoritative for open/closed/merged state and branch-protection checks.
  AgentX events are observations, not state overrides.
- **FR-007:** No event or workflow transition may auto-merge, deploy, release, or grant production
  credentials.
- **FR-008:** Failures, refused events, retries, and unresolved provider state MUST be visible in
  task history and recovery status.
- **FR-009:** PR review and discussion comments MUST be treated as untrusted input. AgentX MUST
  notify the task owner and present a proposed fix plan before making code changes. Approval MUST
  identify the exact task, PR, comment set, candidate, and plan revision; any changed candidate,
  comment set, or plan invalidates that approval.
- **FR-010:** AgentX MUST NOT post replies to GitHub comments automatically. Owner approval authorizes
  the proposed code work only, not a GitHub response or merge.

## Success criteria

- **SC-001:** Replayed deliveries create no duplicate task effects; issue events are rejected.
- **SC-002:** Wrong installation, repository, issue, or PR events are refused and audited.
- **SC-003:** One merged PR out of a multi-PR set never reports the task complete.
- **SC-004:** Restart/retry and out-of-order event fixtures converge to the current GitHub state or
  remain visibly unresolved.
- **SC-005:** PR comment events create a Slack owner decision, never a code change; stale approval
  cannot authorize work for changed feedback or a different candidate.

## Scope and assumptions

- Only GitHub installations already registered to an AgentX project are eligible.
- The webhook HMAC key is read from the optional `webhookSecret` field of the GitHub App Secrets Manager JSON object. A legacy PEM-only secret keeps webhook processing unavailable until the field is configured; no secret value is stored in the repository or task record.
- PR status events, submitted reviews, inline review comments, and discussion comments on PRs are in
  scope. GitHub issue events and issue linking are out of scope.
- GitHub credentials and installation tokens remain in the existing broker boundary.
- CharterArc integration, auto-merge, deployment, and production outcome claims are out of scope.
