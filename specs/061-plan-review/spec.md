# Feature Specification: Plan Review

A task's requirements, design and coding plan become a readable, interactive review page in the style of the
`html-plan` Claude plugin, tailored to AgentX: a ranked tree of claims backed by evidence AgentX itself
verifies, decisions placed on the claims they change, comments and suggestions from the team, and owner
decisions made on the page or in Slack through one broker transition.

**Feature Branch**: `integration/native-workflow` (follows 056)
**Created**: 2026-10-09
**Status**: Draft for owner review
**Input**: Owner design session 2026-10-09; prototype idea from the "Assess Claude HTML plan plugin" session
**Depends on**: 056 native task workflow (stages, artifacts, decisions), proposed checks, task page (`/review/<task>/task`)

## Context

Today each workflow document is model-written Markdown. Slack shows a three-line summary and links to a
read-only task page that prints every document as raw text, top to bottom. Owners scroll to find the right
document, read unformatted Markdown (including the raw `agentx-checks` block), and can only decide through
Slack buttons. Teammates can reply in the thread, but their input has no place in the plan, and nobody
else can share the decision.

The `html-plan` plugin shows a better way to review a plan: a tree of short claims opened one level at a
time (what someone can do or see, how it works, where in the code), each backed by evidence, with the few
real decisions placed on the claim they change and a recommended answer already picked. Its levels match
AgentX's Full path: requirements are "what", design is "how", the coding plan is "where".

This feature keeps AgentX's trust boundary: the model provides content as data; AgentX validates it,
verifies code references itself, and draws the page with its own template. Approval still only authorizes
the next workflow step; checks, reviews, pull request review and merge remain separate.

## Goals

1. An owner taps a Slack card, lands on the right document, understands the change in under a minute,
   answers the real decisions, and approves or requests changes, on a phone or a laptop.
2. The task is multiplayer: one or more accountable owners decide; the team comments and suggests where it
   matters; everything is attributed.
3. Nothing the model writes can run in, link from, or impersonate the page.

## Non-goals (v1)

- UI mockups (slice 4, below).
- +1 reactions on comments; replies more than one level deep.
- Adding new people from the page, and an "Ask for access" button (later).
- Live presence ("Priya is viewing"); project rules that require a second approver.
- Letting the planner write HTML or arbitrary page content.

## Delivery slices

Each slice ships on its own and is usable.

1. **Structured plans and the readable page**: plan format, planner prompt, AgentX-verified code evidence,
   diagrams, page rendering, deep links, What changed, Earlier versions, History, the new Slack card,
   30-day sign-in. The page is read-only in this slice; decisions stay in Slack.
2. **Deciding on the page**: Approve and Request changes on the page, decision answers, comments with one
   level of replies, suggestions, AgentX's answer to each comment, carry-forward of comments and drafts.
3. **People and roles**: owners, commenters, viewers; the People form in Slack; owners always in the
   channel; Take ownership.
4. **Mockups**: sanitized HTML mockups in a sandboxed frame.

## User stories

### Story 1: Open the right document (P1, slice 1)

The owner taps "Open review" on the Coding plan card and the page opens on the latest coding plan, expanded
and briefly highlighted, with other documents folded away.

**Independent test:** From cards for requirements v1, requirements v2 and coding plan v1, each link opens
the latest version of its own document. Opening the v1 card's link after v2 exists lands on v2 with What
changed switched on and the note "You opened this from v1".

### Story 2: Read a plan quickly (P1, slice 1)

The page shows the title, Why, and the claim tree folded to level 1, ranked by importance, so the folded tree
reads as a summary. Opening a claim shows its evidence and children. Not changing and Risks come last; the
coding plan has a Checks section where each check names the claim it proves.

**Independent test:** A plan with 12 level-1 claims shows the top 5 and "Show 7 more". Code evidence shows
the real lines from GitHub at the plan's base commit. A reference to a missing file shows "Not found at
<commit>". A state machine, a call flow and a schema each render as a diagram.

### Story 3: Decide on the page (P1, slice 2)

An owner answers decisions (recommended answer pre-selected), reads and replies to comments, and presses
Approve. One confirmation summarizes what is sent; the decision is recorded through the same broker
transition Slack uses.

**Independent test:** Approve on the page with one changed answer and two included comments. The coding
worker's Markdown copy shows "Owner chose: Above (AgentX recommended: Below)" next to the claim and the two
comments with authors; the Slack card is edited to "Approved by <owner> · 1 answer changed · 2 comments
included".

### Story 4: Work as a team (P1, slices 2-3)

Channel members comment on claims and suggest answers. The owner sees suggestions on each decision and the
comments that will be sent, and can leave any out. After Request changes, the next version answers each
comment as a reply ("Done: ..." or "Not changed because ...").

**Independent test:** A commenter suggests an option and comments; the owner requests changes; v2 shows a
reply from AgentX under the comment, and the comment carries forward on the same claim marked "from v1".

### Story 5: Share ownership (P2, slice 3)

An owner adds a co-owner from the People form in Slack. If the person is not in the channel, the form offers
to add them to the channel and make them an owner in one step.

**Independent test:** Adding an out-of-channel person as owner invites them to the channel and grants the
role; a guest from another workspace is refused with a reason. When the last owner leaves the channel, the
task pauses and the thread offers Take ownership.

## Functional requirements

### Plan format (slice 1)

- **FR-001** The planner writes each workflow document (requirements, design, coding plan) as one structured
  plan document, validated by a schema in `@agentx/contracts`. A plan has: `title` (3-7 words), `why`
  (quotes from the request and relevant thread replies, each with its author), `claims`, `notChanging`,
  `risks`, `decisions`, and, for coding plans only, `checks`.
- **FR-002** Claims form a tree. Level 1 is what someone can do or see; level 2 is how it works; level 3 is
  where in the code. The planner writes as many claims as the task needs, ranked by importance at every level;
  depth follows the task (a tiny change may have only levels 1 and 3). Claim text should be about 15 words or
  fewer; this is guidance, not a validation rule.
- **FR-003** A claim may carry evidence when it helps: `code` (repository, path, line range, or a labelled
  sketch of new code), `flow` (a call flow), `schema`, `stateMachine`, or `quote`. Evidence is optional.
  `mockup` is reserved for slice 4 and rejected before it.
- **FR-004** Each claim has an ID that stays the same across versions of the same task (`2.1` in v1 is still
  `2.1` in v2 unless removed). New claims get new IDs; IDs are never reused within a task.
- **FR-005** Decisions are ranked by impact. Each has a question, 2-4 options with a short consequence
  each, one recommended option, and the claim it belongs to. Zero decisions is valid.
- **FR-006** `notChanging` and `risks` are required and may each be one line such as "None".
- **FR-007** Coding-plan checks use the proposed-checks rules (executable, args, cwd, timeout, limits) and
  each check names the claim IDs it proves. They replace the `agentx-checks` fenced block for structured
  plans. Project checks remain a floor, as today.
- **FR-008** Ceilings: 50 claims and 20 decisions per document, plus existing artifact size limits. A plan
  that fails validation or exceeds a ceiling is returned to the planner once with the errors (and, for a
  ceiling, an instruction to rank and trim). A second failure blocks the step with Retry planning. A
  partially valid plan is never shown.
- **FR-009** Full path: the tree grows. Requirements hold level-1 claims, Not changing, Risks and decisions.
  Design adds level-2 claims under approved ones. The coding plan adds level-3 claims and checks. A later step
  may edit an approved claim; the page marks it "Changed after approval". Quick writes the whole tree
  in one document.
- **FR-010** The planner is told to scale the plan to the task: tiny tasks get tiny plans.
- **FR-011** AgentX derives a Markdown copy from the structured plan and the recorded decision. The coding
  worker, the code and security reviewers, the MCP tools, and the Slack summary use this copy; none reads the
  page. Owner answers appear next to their claim ("Owner chose: X (AgentX recommended: Y)"), with the
  statement that owner answers override the plan text. Included comments appear quoted with their authors,
  marked as untrusted input.
- **FR-012** Tasks whose documents were written before this feature keep their Markdown documents and render
  as today. Only new documents use the structured format.

### Verified evidence (slice 1)

- **FR-013** For `code` evidence that cites existing code, the broker fetches the cited lines from GitHub at
  the plan's base commit, using the project's GitHub App, and shows those bytes, never the model's copy.
  Limits: at most 40 excerpts per document and 80 lines per excerpt; longer ranges are cut with a note.
- **FR-014** A cited path or range that does not exist at the base commit is shown as "Not found at <short
  commit>" on the claim. GitHub being unavailable shows "Couldn't load this excerpt" without blocking the
  page or the decision.
- **FR-015** New code in a plan must be labelled a sketch and is shown with a "Sketch: not in the repository
  yet" label.
- **FR-016** Diagrams: AgentX draws `stateMachine` (states and transitions), `flow` (an ordered call
  sequence between named participants), and `schema` (tables or types, fields, and relations) from the
  plan's structured data, with AgentX's own renderer. The planner supplies data, never markup. Each diagram
  also has a text alternative for screen readers and for the Markdown copy.

### The page (slice 1 unless noted)

- **FR-017** The page stays at `/review/<task>/task`. Links: `#requirements`, `#design`, `#coding-plan`
  (always the latest version of that document); `#coding-plan-v1` (a specific version); `#coding-plan/2.1`
  (a claim in the latest version). A link opens its document expanded, scrolls to it, and highlights it
  briefly; other documents are folded. With no anchor the page opens the current step's latest document.
- **FR-018** Slack cards link to the document (`#coding-plan`), never a version. Each card also carries the
  version it was posted for, so a page opened from an older card shows "You opened this from v1. Here's what
  changed" with What changed switched on.
- **FR-019** Header: task title, the reader's role, a progress strip (Full: Requirements, Design, Coding plan;
  Quick: Coding plan; then Coding, Checks, Reviews, Pull request), and one status line.
- **FR-020** A document shows Why (one-line summary that opens), the claim tree folded to level 1, decisions
  on their claims with the recommended answer labelled, Not changing, Risks, and for coding plans the Checks
  section. Each level shows its top 5 children and then "Show N more"; decisions likewise.
- **FR-021** Claim badges: New, Changed since v<N>, Changed after approval (claim text only), and a comment count.
- **FR-022** From v2 on, a "What changed since v<N>" switch shows only added, removed and changed claims and
  decisions. Removed claims keep their comments under "Removed claims".
- **FR-023** Earlier versions: a folded list under each document; opening one shows it read-only with "This
  is v1. v3 is the current one." Each version has a Copy link control.
- **FR-024** History: one timeline at the bottom of the page of decisions, versions, role changes and
  ownership changes, with actor and time, linking to the versions involved. It replaces the page's "Thread
  replies" list.
- **FR-025** The page keeps its existing sections (checks, review findings, pull requests) below the
  documents, so it remains the task's home through coding, checks, reviews and the pull request.
- **FR-026** Reading needs no script: the tree uses native disclosure elements and anchors work without
  script. A script adds deciding, commenting, the sticky bar, and staleness checks (slice 2). While open, the
  page checks the task's revision every 20 seconds; when it changes it shows "Coding plan v2 is ready. Show
  it" and keeps unsent work.
- **FR-027** The page works on a 360 px wide screen, in dark mode, with keyboard only, and with a screen
  reader (landmarks, headings, labelled controls, visible focus).
- **FR-028** Sign-in sessions for this page last a fixed 30 days from sign-in (no renewal: the broker only reads the sign-in store) and stay revocable on the server. Sign-in
  works inside Slack's in-app browser on iOS and Android.
- **FR-029** A reader without access sees "You don't have access to this task." If, and only if, the reader
  is a member of the task's Slack workspace who could be added (FR-047), the message also names the owners:
  "Ask Abhishek or Priya to add you." The response never otherwise confirms that a task exists.

### Deciding (slice 2)

- **FR-030** Owners see a sticky bar on the current document: "N to answer" (jumps to the next unanswered
  decision, including hidden ones), Approve, and Request changes. Others see "Only owners decide".
- **FR-031** Approve opens one confirmation listing: answers that differ from the recommendation; decisions
  the owner has not opened, which will use the recommended answer; the comments that will be sent, each with
  its author and a checkbox (all ticked by default); the selected checks; and an optional note.
- **FR-032** Request changes uses the same confirmation and requires at least one included comment or a
  note.
- **FR-033** A page decision calls the same broker workflow transition as Slack, with the expected workflow
  revision, the artifact digest, a request ID, every decision answer (marking which were opened), the
  included comment IDs, the check selection and the note. The broker derives the actor from the session,
  checks the actor is an owner, and records the decision on the task.
- **FR-034** Decision answers are binding instructions to the next step (FR-011). At the coding-plan step
  the code reviewers receive the answers and check the code against them.
- **FR-035** The first decision wins. A later one is refused with "Already approved by Priya a moment ago";
  the page keeps the refused owner's answers and unsent comments and pre-fills them on the new version
  wherever the same decision or claim still exists.
- **FR-036** Slack Approve uses the recommended answers for every decision and includes all open comments.
  The card states this ("Approve uses AgentX's answers for 3 decisions · includes 4 comments"). Slack
  Request changes works as today. MCP decisions behave like Slack's.
- **FR-037** When a plan has three claims or fewer and no decisions, the Slack card shows the whole plan and
  Approve in Slack is enough; opening the page is optional.
- **FR-038** After a decision, the card is edited to state who decided and what (for example "Approved by
  Priya · 2 answers changed · 4 comments included") and its buttons are removed.

### Comments and suggestions (slice 2)

- **FR-039** Owners and commenters can comment on a claim, a decision, a check, or the whole document.
  Comments post immediately and are visible to everyone with access. A comment may have replies, one level
  deep.
- **FR-040** Comments are plain text, up to 2,000 characters, redacted for secrets, and shown escaped; links
  are text. An author may edit or delete their comment until a decision includes it; after that it is
  locked.
- **FR-041** A commenter may suggest one option per decision. The decision shows each option's suggesters
  ("Priya and Sam suggest: Above"). Only an owner's answer is recorded as the decision.
- **FR-042** When a new version is written, open comments carry forward to the same claim marked "from v1";
  comments on removed claims appear under Removed claims.
- **FR-043** After Request changes, the planner receives the included comments with their IDs and must
  return, for each, an answer that is "done" or "not changed" with a short reason. AgentX posts each answer as
  a reply from AgentX under that comment.
- **FR-044** The Slack thread gets a batched nudge for new comments ("Priya left 2 comments on Coding plan
  v1"), at most one per commenter per 10 minutes, with a link.
- **FR-045** Rate limits: 30 comments and 60 suggestions per person per task per 10 minutes.

### People and roles (slice 3)

- **FR-046** Roles: Owner (any number; all owners have equal rights), Commenter, Viewer. The task's creator
  is the first owner. A task always has at least one owner.
- **FR-047** Eligible people: members of the task's Slack workspace (not Slack Connect guests) who can use
  the task's AgentX project under the existing project access rules.
- **FR-048** Defaults: channel members who can use the project are Commenters. Channel members who cannot
  use the project have no page access (they still see the Slack summary). An explicit role overrides the
  default, including making a channel member a Viewer.
- **FR-049** Owners must be members of the task's channel. Making a non-member an owner offers "Add to
  #channel and make owner"; AgentX invites them and then grants the role. If the invite fails, the role is
  not granted and the form says why.
- **FR-050** Owners can add and remove people, change roles, step down when another owner remains, and close
  the task. Commenters can comment and suggest. Viewers can read.
- **FR-051** The People button on each task card opens a Slack form with Slack's user picker for owners,
  commenters and viewers. The page's People panel lists everyone with their role; owners can change roles,
  remove people and step down there. Adding new people from the page is out of scope for v1 and links to the
  Slack form.
- **FR-052** People added from outside the channel receive a Slack direct message with their role and a link
  to the page.
- **FR-053** An owner who leaves the channel becomes a Commenter. If no owner remains in the channel, the
  task pauses and the thread says "This task has no owner in the channel. Someone needs to take it over." Any
  eligible channel member can press Take ownership.
- **FR-054** Every role change and ownership change is recorded with actor and time and shown in History.
- **FR-055** Access is checked on every request; a removed person loses access immediately.

### Mockups (slice 4)

- **FR-056** A claim may carry a `mockup`: HTML and CSS written by the planner. AgentX keeps only an
  allowlist of layout elements and CSS properties; it removes scripts, event handlers, links, forms, external
  resources and URLs in CSS; and it shows the result in a sandboxed frame that cannot run script or
  navigate, labelled "Mockup, drawn by AgentX's planner".

## Security requirements

- **SR-001** All model, comment and suggestion text is untrusted: validated, redacted, escaped, and never
  rendered as markup or links.
- **SR-002** The page's content security policy allows only AgentX's own nonce'd script and styles, connects
  only to the page's own origin, and forbids framing, form posts elsewhere, and external resources (slice 4
  adds only the sandboxed mockup frame).
- **SR-003** Every state-changing request requires the signed-in session, a CSRF token that matches its
  cookie, and an allowed Origin. The actor comes from the session, never the request body. Roles are checked
  on the server for every request.
- **SR-004** Decisions are fenced by workflow revision and artifact digest and are idempotent by request ID.
- **SR-005** Comments reach the planner and coder as quoted, attributed, untrusted data under the same
  boundary as thread replies. The owner sees and can exclude each included comment before deciding.
- **SR-006** Code evidence bytes come only from GitHub at the base commit (FR-013).
- **SR-007** No page response distinguishes "no such task" from "not yours" except as FR-029 allows.

## Edge cases

- A deep link to an older version or an older card: opens the latest version with "You opened this from v1"
  (FR-018); a specific version link opens that version read-only with a pointer to the current one (FR-023).
- Two owners decide at once: the first wins; the second keeps their work (FR-035).
- Someone decides in Slack while the page is open: the page shows the new state within 20 seconds and
  refuses a stale submission with a clear message (FR-026, FR-035).
- A comment on a claim that v2 removed: shown under Removed claims (FR-042).
- The planner ignores a comment in its revision: the comment shows no AgentX reply; the page marks it
  "Not answered" (FR-043).
- A plan cites a file that does not exist: flagged on the claim (FR-014).
- GitHub is unavailable: excerpts show "Couldn't load this excerpt"; reading and deciding still work
  (FR-014).
- A plan with no decisions: the page says "No decisions needed" and Approve needs no answers.
- A tiny Quick plan: Slack-only approval (FR-037).
- The last owner leaves the channel: the task pauses until someone takes ownership (FR-053).
- A channel member without project access opens the link: no access message (FR-029, FR-048).
- Comment flood: rate limits (FR-045).
- A task started before this feature: renders its Markdown documents as today (FR-012).

## Success criteria

- **SC-001** From a Slack card, the right document is on screen with no scrolling.
- **SC-002** On a phone in Slack's in-app browser, a second link within 30 days opens without signing in
  again.
- **SC-003** Every decision made on the page appears in the task's single decision history, identical in
  form to a Slack decision except for answers and comments.
- **SC-004** No content written by the planner, a commenter or a reviewer can run script, open a link, or
  submit anything from the page (verified by an attack-input test suite).
- **SC-005** In a live Full-path test, the owner completes requirements, design and coding-plan review with
  at least one comment, one suggestion from a second person, one changed answer and one Request changes, and
  the merged code reflects the changed answer.

## Testing

- Contract tests for the plan schema, ceilings, claim ID stability, and the Markdown copy (answers next to
  claims, comments quoted).
- Rendering tests: ranking and "Show N more", badges, What changed, Earlier versions, History, diagrams and
  their text alternatives, and an attack-input suite for escaping and the (slice 4) mockup sanitizer.
- Endpoint tests: roles, CSRF and Origin, session expiry, stale revision and digest, idempotency, two owners
  at once, rate limits, the no-access message rules.
- Evidence tests: real excerpts at the base commit, missing paths, GitHub failure.
- End-to-end in the workflow harness: Slack request, structured plan, page decision with a changed answer
  and comments, the worker's Markdown copy, reviewers receiving the answers.
- Live test on a test install, including the phone sign-in check (SC-002) and SC-005.

## Open questions for planning

- Diagram renderer: AgentX's own server-side SVG drawing, or a vendored, pinned client-side library run in
  its most restrictive mode. The constraint is FR-016 and SR-002; the plan picks one with a short spike.
- How the planner's structured output reaches the broker (one JSON artifact beside, or instead of, today's
  Markdown artifact) is a planning detail, provided FR-011 and FR-012 hold.
