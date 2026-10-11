# Feature Specification: Reviewed and Owner-Controlled PR Feedback

**Feature Branch**: `codex/agentx-native-workflow`
**Created**: 2026-10-05
**Status**: Owner-approved for implementation
**Input**: Owner-approved UX direction in this task; specs 056, 057, and 058
**Objective**: `MSDLC-OBJ-001@0.4` (unchanged)

## Context

AgentX already receives GitHub PR feedback and asks the task owner in Slack before changing code.
The current proposal is based on the incoming comment and PR diff; it does not independently review
the code, aggregate all current comments, or explain which comments appear valid. Slack currently
hosts plan canvases and workflow actions, while AgentX's control plane stores the canonical task
workflow. This feature adds an authenticated AgentX browser view for detailed PR-feedback decisions,
a separate read-only AI advisory review of the exact candidate, and a closeout path that preserves
the full record in AgentX before deleting the Slack Canvas.

The user's job in this flow is simple: understand what reviewers want, decide what AgentX should
change, and know that nothing will change until the owner approves it. The interface should answer
three questions first: **What needs attention? What does AgentX recommend? What will happen if I
approve?** Code excerpts, detailed rationale, provenance, and individual comment text should be
available when the owner chooses to inspect them, not forced into the first screen.

GitHub remains authoritative for PR comments, commits, checks, and merge state. Slack remains the
entry and notification surface. AgentX remains the task, approval, and audit record. GitHub issue
events do not start work. AgentX never auto-merges, deploys, or replies to GitHub comments.

## User Scenarios & Testing

### Story 1 — Review all PR feedback together (P1)

When comments arrive on any AgentX-linked PR for a task, AgentX gathers new or not-yet-disposed
feedback across that task's open PRs, groups duplicates, and orders findings by impact while keeping
each PR and its exact head visible. Resolved GitHub review threads are excluded unless they receive
new comments; ordinary PR discussion comments remain eligible until an owner records a disposition.
A separate read-only AI advisory operation compares each comment with the code and task requirements. It may
recommend that an item is stale, already addressed, mistaken, out of scope, or actionable, but it
must explain its reasoning and show uncertainty. This is an AI-generated advisory from a separate
operation, not independent or authoritative evidence. AgentX validates its task, operation, revision,
candidate, and input bindings; only an explicit owner approval can authorize code changes. It never
hides a comment or changes code.

**Independent Test:** Deliver several duplicate, conflicting, stale, actionable, and incorrect PR
comments across two linked PRs. Verify that one task review contains every comment, groups duplicates
without losing IDs, ranks findings, keeps per-PR candidate bindings clear, records evidence and
uncertainty, and starts no code operation.

**Acceptance Scenarios:**

1. Given multiple comments on one linked PR, when the review is ready, then the detail page shows
   all comments together, grouped and ordered by priority.
2. Given an apparently incorrect or obsolete comment, when the reviewer assesses it, then the page
   shows the comment, its classification, evidence, and rationale; it is not silently discarded.
3. Given comments that conflict, when the reviewer cannot resolve the conflict confidently, then it
   marks the conflict and asks the owner to decide.

### Story 2 — Approve a specific set of proposed fixes (P1)

The owner receives a short Slack thread update with the number of comments, how many AgentX
recommends addressing, the highest-priority finding, and a link to the AgentX detail page. The page
repeats that recommendation at the top and uses progressive disclosure for the details. For example:
“4 comments across 2 PRs. AgentX recommends 2 fixes; 1 looks already handled; 1 needs your call.
Highest priority: handle empty input. Approving starts those 2 fixes and reruns the required checks.”
The owner can open the detailed review, approve the recommended batch from Slack or the page, or
request changes in a short form. **Choose findings** lets the owner include or exclude specific
items on the page. Each finding expands to show the original comments, relevant code, evidence, and
reasoning. The page shows each affected PR head, what checks AgentX will rerun, and what approval
authorizes. Dismissing a proposal records the owner's reason and does not resolve the GitHub
comments. Slack thread replies and Request changes submissions are captured as attributed task
input; the bot acknowledges that it recorded the note and points to the separate approval action.
Comments alone never authorize code changes.

**Independent Test:** Verify that only the existing workflow-authorized owner can submit a decision;
comments are retained with author and timestamp; the approval binds exact selected comment IDs,
candidate digests and head SHAs for every affected PR, and proposal digest; and replayed or stale
decisions cannot dispatch work.

**Acceptance Scenarios:**

1. Given an authorized Slack owner, when they open the detail link, then AgentX authenticates them
   and authorizes them against the exact task before showing its content.
2. Given a review with several findings, when the owner approves only selected findings, then only
   those findings enter the work request and every other finding remains visible with its disposition.
3. Given a new PR commit, changed or deleted comment, or revised proposal, when an old approval is
   submitted, then AgentX refuses it and requests a fresh review and decision.
4. Given an unauthorized user or a forwarded link, when they request task details or submit a
   decision, then AgentX refuses access; the link itself is not an authorization token.
5. Given a user opens the link while signed out, when they authenticate with the Slack identity
   configured for AgentX, then AgentX returns them to the same review and checks task authorization
   before showing its contents.
6. Given the AI advisory review fails or cannot confidently assess a comment, when the page opens,
   then AgentX says which comments still need human review and offers a safe next step without
   presenting an incomplete result as a complete review.
7. Given a Slack approval button, when it is pressed, then the button names the batch it approves,
   rechecks the owner's authority and all bound review digests, and explains that it starts code
   changes and checks but does not post a GitHub reply or merge.
8. Given the owner approves a batch, when AgentX starts work, then Slack and the detail page show
   what AgentX is doing, which approved findings it is addressing, what is waiting, and the next
   owner action; repeated progress notices are not sent for unchanged state.

### Story 3 — Keep Slack readable and retain the record in AgentX (P1)

Slack shows brief status and links, not the full review report. When the task reaches a terminal
outcome, AgentX reports that work outcome as complete independently of Slack Canvas cleanup. Before
deleting the Canvases, AgentX verifies the original task artifacts and workflow record and saves a
closeout manifest that links them to the task's Slack Canvases. Cleanup failures are retried in the
background and shown separately on the authenticated AgentX detail page; the owner does not need to
investigate or retry cleanup. AgentX never reports cleanup complete unless Slack confirms deletion.
The remaining Slack thread and any owner-authored replies are still subject to the workspace's Slack
retention settings; the complete task record, review, decisions, and evidence remain in AgentX under
its configured retention policy.

**Independent Test:** Complete and close fixture tasks. Verify preservation and digest validation
before Canvas deletion, safe retry after interruption, no loss of the AgentX record, and no full
review content in Slack notifications or operational logs.

**Acceptance Scenarios:**

1. Given an unarchived Canvas and a terminal task, when AgentX verifies the source workflow artifact
   still exists and its digest matches the task record, then AgentX records the artifact reference,
   digest, and Canvas ID before requesting Canvas deletion.
2. Given an AgentX archive write or digest check failure, when closeout runs, then the Slack Canvas
   is not deleted, the terminal work outcome remains complete, and the AgentX detail page shows
   cleanup as pending.
3. Given a successful archive followed by a transient Slack deletion failure, when retry runs, then
   the existing snapshot is reused and deletion is retried automatically and idempotently without an
   owner action.
4. Given a task with no Canvas or a Canvas already deleted, when closeout runs, then AgentX records
   the observed state without losing or duplicating the canonical record.
5. Given Slack returns an ambiguous `canvas_not_found` result, when closeout runs, then work remains
   complete, cleanup remains visibly pending, and AgentX retries in the background without claiming
   the Canvas is deleted or asking the task owner to investigate.

## Functional Requirements

- **FR-001:** PR comment events MUST be accepted only for an already-linked task PR after signature,
  installation, repository, and task scope validation. Issue events MUST NOT start work.
- **FR-002:** Before review, AgentX MUST reconcile the event with GitHub's current PR head and
  current review/discussion comment state across all open PRs linked to the task. It MUST collect
  new or not-yet-disposed review bodies, review-thread comments, and PR discussion comments, while
  excluding resolved review threads unless new feedback reopens them. The collected set MUST
  preserve each GitHub comment and thread ID, author, URL, update time, body, and relevant file/line
  context.
- **FR-003:** AgentX MUST persist an immutable review bundle bound to the task, repository, PR,
  exact head SHA, candidate digest, comment-set digest, producer/version, and timestamp.
- **FR-004:** A separate critic review MUST inspect the exact candidate read-only, with no workspace
  write, shell mutation, GitHub write, or workflow-state authority. It MUST run as a separate
  operation from code generation and MUST NOT review its own execution output. Its findings are an
  AI-generated advisory, not independent or authoritative evidence; no reviewer identity or
  self-reported read-only flag may establish trust. The broker MUST bind the operation ID, mode,
  task, workflow revision, input digests, and output digest to authoritative operation and workflow
  state. Model/provider details MAY be retained as worker-reported diagnostics. Only explicit owner
  approval may authorize code changes.
- **FR-005:** The review MUST account for every collected comment and keep **priority** separate
  from **AgentX's assessment**. Priority MUST distinguish `MUST_FIX`, `SHOULD_FIX`, and `OPTIONAL`.
  Assessment MUST distinguish `ACTIONABLE`, `ALREADY_ADDRESSED`, `STALE`, `TECHNICALLY_INCORRECT`,
  `OUT_OF_SCOPE`, `CONFLICTING`, and `NEEDS_OWNER_DECISION`. Every finding MUST include evidence,
  plain-language rationale, confidence with its reason, and a proposed disposition. The owner
  remains the authority to skip or reject feedback.
- **FR-006:** Duplicate comments MAY be grouped, but every original comment ID and URL MUST remain
  discoverable in the group. Conflicting comments and low-confidence classifications MUST be
  surfaced for owner decision.
- **FR-007:** Slack notification text MUST be concise: comment count, count recommended for action,
  highest-priority item, a secure AgentX detail link, and clear owner actions to open the review,
  approve the named recommended batch, or request changes. It MUST NOT include full comment sets,
  diffs, or proposed fix plans.
- **FR-008:** The detail page MUST be hosted by AgentX infrastructure and use authenticated
  sessions. The sign-in flow MUST return users to the requested review after authentication. AgentX
  MUST authorize every read and write by verified Slack team/user identity and the exact existing
  workflow owner policy; this feature MUST NOT broaden who can decide. A URL or bearer link alone
  MUST NOT grant access. Browser sessions MUST use secure, HTTP-only cookies and MUST protect
  decision submissions against cross-site requests. The page MUST access task data through the
  control plane; it MUST NOT read DynamoDB or S3 directly from a browser.
- **FR-009:** Authorized owners MUST be able to approve all proposed actionable findings, select a
  subset, request changes with a comment, or dismiss the proposal with a reason. The default action
  MUST be clear about which fixes and checks it authorizes. Dispositions MUST be attributed and
  recorded in the canonical workflow. Findings outside the approved subset remain visible and
  unresolved until the owner disposes of them or a later review supersedes them. Dismissing an
  AgentX proposal MUST NOT mark GitHub comments resolved or dismissed.
- **FR-010:** Slack thread replies and Request changes form submissions MUST be captured as
  attributed task comments. The bot MUST acknowledge captured comments and point to the approval
  action. A comment MUST NOT count as approval without an explicit approval action. Slack replies
  are supported as short notes and remain subject to workspace retention; longer review discussion
  belongs on the authenticated AgentX detail page or in a Slack modal.
- **FR-011:** An approval MUST bind the task, workflow revision, PR, exact head SHA and candidate
  digest, comment-set digest, proposal digest, selected comment IDs and owner decision. Before
  accepting the approval and again before dispatch, AgentX MUST reconcile every affected PR and
  comment set with GitHub's current authoritative state. A change to any bound value MUST invalidate
  the approval and prevent dispatch.
- **FR-012:** Only owner-approved findings MAY be sent to the remote coding worker. GitHub comments
  MUST be treated as untrusted data, not instructions that can override project policy or grant
  tools. After implementation, the normal candidate-bound checks and separate reviews MUST rerun.
- **FR-013:** AgentX MUST NOT automatically post or submit a GitHub reply/review. Owner approval
  authorizes only the recorded code changes, not a GitHub response, merge, deployment, or release.
- **FR-014:** Before Slack Canvas deletion, AgentX MUST verify the canonical source artifacts still
  exist and their digests match the task record, then persist a closeout manifest in AgentX artifact
  storage. Because AgentX creates task Canvases from read-only AgentX artifacts, the manifest MUST
  preserve the artifact references and digests plus every Canvas ID and task/version association.
  The operation MUST be idempotent and recoverable after interruption. Deletion MUST occur only
  after a terminal task state (`MERGED` or an explicit terminal close/cancel outcome) and successful
  artifact verification. Slack thread messages and replies are not deleted by this operation and
  remain subject to the workspace's retention policy. The closeout MUST cover every Canvas created
  for the task, including earlier workflow stages and revised plans, not just the most recent Canvas.
- **FR-015:** Canvas deletion outcome MUST be recorded separately from the task outcome. A cleanup
  failure MUST NOT reverse or delay a terminal task outcome, erase or invalidate the AgentX record,
  or require a task-owner action. AgentX MUST expose a concise cleanup status on the authenticated
  task detail page and retry cleanup in the background.
- **FR-016:** The AgentX closeout manifest MUST record the Slack Canvas IDs and their associated
  AgentX artifact digests. AgentX MUST verify every task Canvas was deleted before declaring Canvas
  cleanup complete. An ambiguous not-found response MUST remain pending and MUST NOT change the task
  outcome.
- **FR-017:** AgentX-authored Slack status messages and CloudWatch logs MUST NOT contain full PR
  comment bodies, full diffs, auth tokens, or full proposal text. Monitoring MUST use redacted
  identifiers, transition outcomes, retry counts, and error categories. User-authored Slack replies
  remain under Slack workspace retention and must not be represented as deleted by Canvas cleanup.
- **FR-018:** Recovery tests MUST cover restarts during review, approval dispatch, snapshot write,
  and Canvas deletion; duplicate and delayed GitHub events; owner retries; stale feedback; and
  partial merges across multiple required PRs.
- **FR-019:** Full-suite failures MUST be triaged against the branch base and grouped as regressions,
  pre-existing failures, or environment limitations. The implementation MUST not claim the suite
  passes while unresolved failures remain.
- **FR-020:** The detail page MUST support keyboard navigation, visible focus, semantic headings and
  controls, readable reflow on narrow screens and zoom, and clear text alternatives for status and
  priority. Accessibility behavior MUST be checked in browser interaction tests, not inferred from
  source structure alone.
- **FR-021:** Authenticated review responses MUST use private, non-cacheable headers, MUST be excluded
  from search indexing, and MUST NOT send comment bodies, diffs, or proposal text to analytics.
- **FR-022:** The Slack thread and detail page MUST show the current workflow state, any blocker, and
  the next responsible action across review collection, owner decision, implementation, verification,
  PR waiting, and terminal closeout. Status updates MUST be emitted on meaningful state changes and
  MUST NOT repeat while state is unchanged.

## Key Entities

- **PR Feedback Bundle:** Linked task/PR, exact candidate and head SHA, full comment set, source
  delivery IDs, comment-set digest, retrieval time, and artifact reference.
- **Feedback Review:** Read-only review operation, reviewer provenance, classifications, ordered
  findings, evidence, confidence, proposed dispositions, candidate binding, and report digest.
- **Feedback Decision:** Authenticated owner, decision, selected comment IDs, owner notes, workflow
  revision, candidate/head/comment/proposal digests, request ID, and time.
- **AgentX Closeout Manifest:** Final workflow record, artifact and evidence references/digests,
  archive state, Slack Canvas IDs, deletion attempt/outcome, and timestamps.

## Success Criteria

- **SC-001:** Every current PR comment in a test bundle appears in the owner review or is linked to
  an explicit grouping; none is silently omitted.
- **SC-002:** 100% of code-change dispatches for PR feedback have a valid owner approval bound to the
  exact candidate, PR head, proposal, and selected comment set.
- **SC-003:** A stale or unauthorized browser session cannot read task details or authorize changes.
- **SC-004:** Duplicate/replayed decisions, webhook deliveries, and archive retries produce one
  durable outcome and do not lose records.
- **SC-005:** Canvas deletion never precedes a verified AgentX snapshot; task outcome remains
  distinct from cleanup state; interrupted closeout is retried automatically and its status remains
  visible without requiring task-owner intervention.
- **SC-006:** Slack messages remain short; detailed comment content and review evidence are available
  in the authenticated AgentX view and canonical AgentX records after closeout. The spec does not
  claim GitHub source comments or Slack-authored thread replies are deleted.
- **SC-007:** Every required PR must be observed merged before the task is marked complete.
- **SC-008:** In usability review, an owner can identify the highest-priority finding, the proposed
  action, and what approval authorizes without opening every comment's technical detail.
- **SC-009:** The service records privacy-safe measures for time from Slack notice to owner decision,
  how often owners change AgentX's recommended dispositions, and how often supposedly resolved
  feedback is reopened. These measures are reviewed after early use to improve ranking and clarity.

## Assumptions and Boundaries

- Specs 056 (native task workflow), 057 (candidate-bound review), and 058 (GitHub coordination) are
  prerequisites and remain the canonical sources for their existing behavior.
- The existing control plane, task records, Slack signing/identity support, S3 artifact storage,
  GitHub App boundary, and remote coding worker are reused where they satisfy these requirements.
- The authenticated browser experience is new unless implementation inspection identifies an
  existing AgentX route suitable for this use.
- The detailed page is an owner work surface, not a second chat. Its first view uses a short
  recommendation and progressive disclosure; the Slack message is a notification, not a duplicate
  report.
- One task-level review may cover several linked PRs, but every finding remains tied to its own PR
  head and candidate. A change to one PR invalidates only the review and approvals that depend on
  that PR unless the overall proposal itself changes.
- “Archive the Canvas” means: preserve and verify its full content and workflow history in AgentX,
  then call Slack's irreversible Canvas deletion operation. Slack thread messages remain concise
  notifications and any user-authored replies remain under Slack workspace retention.
- Canvas cleanup removes the Slack copy of AgentX's task documents. It does not delete original PR
  comments from GitHub or task-thread messages from Slack; both remain under their source service's
  access and retention rules.
- AgentX retention policy controls how long the canonical task and artifact records remain. This
  feature does not silently shorten existing retention.
- The existing retention period for completed workflow artifacts must be confirmed before promising
  long-term posterity. If no policy is configured, retain the task record safely and surface the
  missing policy as an operational setup requirement; do not invent an indefinite-retention default.
- CharterArc integration, issue-triggered work, automatic GitHub replies, auto-merge, deployment,
  and production outcome claims are out of scope.

## References

- Slack Canvas deletion requires `canvases:write` and is irreversible:
  https://api.slack.com/methods/canvases.delete
- `specs/056-native-task-workflow/spec.md`
- `specs/057-candidate-review/spec.md`
- `specs/058-github-coordination/spec.md`
