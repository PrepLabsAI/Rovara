# Implementation Plan: GitHub Event and Multi-PR Coordination

## Architecture

Add authenticated GitHub App webhook handling at the broker edge. Verify signatures against the
registered installation/repository boundary, durably deduplicate deliveries, and fetch authoritative
current PR state after event receipt. Only PR state and PR comment events are accepted; issue events
are refused. Link each PR and candidate manifest to one workflow. Do not replace GitHub state or
merge on its behalf.

For PR comments, notify the task owner in the task's Slack thread with a short summary, a link to the
comment, and a proposed fix plan. Treat comment text as untrusted. Require owner approval bound to
the exact task, PR, comments, candidate, and plan before coding. Do not reply to GitHub comments.
After approved code changes, rerun checks and reviews against the new candidate.

## Implementation sequence

1. Add delivery, PR-state, comment, refusal, and multi-PR contract tests.
2. Verify webhook signatures, scope and idempotent delivery persistence.
3. On successful PR publication, atomically write a reverse index from canonical GitHub
   owner/repository/PR number to the task, workspace, repository identity, and candidate digest.
   Reject noncanonical or mismatched PR URLs.
4. Add a public webhook route that preserves the signed request body, verifies signatures and
   confirms the installation ID, GitHub repository ID, and full name against GitHub's current API.
   Durably record accepted PR events for processing.
5. Resolve an event through the reverse index and verify it still matches the task's expected PR
   and candidate, then reconcile state from GitHub's current state.
6. Post PR comment notices and proposed plans to the task Slack thread; persist owner approval bound
   to the comment set, PR, candidate, and plan. Resume work only after that approval.
7. Track the required PR set and reconcile each item from GitHub's current state.
8. Add duplicate/out-of-order/restart and multi-repository fake-event tests.

## Verification

Use signed fixture payloads and a fake GitHub adapter. Verify bad signatures and foreign repositories
are refused, issue events are rejected, duplicate and out-of-order PR events have one effect, stale
comment approvals cannot authorize code changes, and incomplete PR sets cannot finish a workflow.
Then run typecheck and the repository suite. No live webhook or production GitHub mutation is
included.
