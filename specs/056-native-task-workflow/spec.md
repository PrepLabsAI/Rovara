# Feature Specification: Native AgentX Task Workflow

The workflow is started through the bound Slack project channel as the primary user path. The same
canonical workflow record remains available through `agentx_start_workflow` and Developer MCP for
existing clients and operators; the established `agentx_start_task` path remains unchanged.

**Feature Branch**: `codex/agentx-native-workflow`
**Created**: 2026-10-05
**Status**: Approved for implementation by owner
**Input**: Owner decision E-031; current AgentX source observation E-030
**Constitution**: 4.1.0; adds Principle VI

## Context

AgentX already records developer tasks, operations, events, artifacts and pull requests. A task's
ordinary `STARTING/RUNNING/SUCCEEDED/...` status does not say whether its request is understood,
its plan was approved, required evidence is current, or a human still needs to act. This feature
adds a versioned, task-local workflow around those existing records. It does not connect to
CharterArc or synchronize another product's case.

## User stories & testing

### Story 1 — Choose the review path for this task (P1)

At task start, the requester chooses **Quick** or **Full**. Quick is the default: review one concise
implementation plan before code changes. Full adds separate approval points for requirements,
design, and the task breakdown before implementation. Both paths keep project-required checks,
reviews, and human delivery authority in force. The selected path is recorded with the task.

**Independent test:** Start one Quick and one Full task. Verify each presents only its configured
approval points, records the selected path, and cannot start code before its required approvals.

### Story 2 — Review a plan before code changes (P1)

A developer starts a task. AgentX records the request and a plan artifact. Before implementation,
the task pauses for the task owner or project administrator to approve, request changes, or reject
the plan. The worker cannot write source files before approval.

**Independent test:** A scripted worker proposes a plan; an unapproved caller is refused; the
authorized owner approves; only then does the worker receive write capability.

**Acceptance scenarios**

1. A new task receives a versioned workflow record and begins at `PLAN` without changing the
   existing task status or task ID.
2. Missing, malformed, or changed plan artifacts cannot pass the plan gate.
3. A rejected plan remains visible and does not dispatch implementation.
4. A decision is bound to the task, workflow revision, plan digest, actor, decision, reason, and
   time. Replaying its request ID has one effect.

### Story 3 — See and recover the next step (P1)

The task owner sees the current stage, whether it is blocked, who must act, and the next action in
the Developer MCP task tools. A shared Slack thread may display the same status, but does not
become another source of truth.

**Independent test:** Advance a fixture task, restart the broker between stages, and read the same
stage, blocker, history, and next action through MCP.

**Acceptance scenarios**

1. Invalid transitions and stale workflow revisions are refused.
2. A repeated or concurrent command cannot skip a gate or dispatch the same operation twice.
3. Existing task status, cancellation, close, and owner-isolation behavior remain intact.

### Story 4 — Do the work from Slack without long bot messages (P1)

A project member starts a governed task in the project's bound Slack channel. AgentX replies in the
request thread with a short plain-language summary and a link to a task-specific Canvas containing
the concise plan and check choices. The task thread remains the conversation; the Canvas is a
readable detail view, not the authority record. The authorized task owner approves or requests
changes using Slack controls. AgentX records the decision and exact plan version in its workflow
record before dispatching code changes.

To start this path, a member mentions AgentX with `workflow: <request>`, for example
`@AgentX workflow: Add password reset to the account page`. AgentX starts the task in that Slack
thread. The plan message has an **Approve plan** button and a **Request changes** button. Approval
opens a small Slack form showing project-required checks as always on and optional project checks as
checkboxes. Request changes opens a short feedback form. The broker checks the owner's identity,
thread, plan revision and digest before recording either choice.

**Independent test:** Start a workflow from a bound Slack channel, open the linked Canvas, choose
optional checks, approve from the thread, and confirm the exact plan digest and chosen checks are
recorded before an implementation operation is queued.

**Acceptance scenarios**

1. Slack shows a short message with the task status, a link to full plan details, and clear next
   actions; the full plan is not pasted into the channel.
2. The Canvas contains only task-relevant detail in plain language: intended change, files/areas,
   checks, and material risks or open questions. It contains no generic preamble, repeated summary,
   or boilerplate conclusion.
3. Project-required checks are selected and locked. The owner may add or remove only optional checks
   allowed by project policy. The resulting check set is versioned with the plan approval.
4. Only the authorized task owner or project administrator may approve, request changes, or reject;
   channel membership alone does not grant approval authority.
5. Slack buttons and MCP decisions call the same conditional workflow transition. A repeated button
   delivery or stale Canvas cannot dispatch implementation twice.
6. If Slack Canvas is unavailable or the app lacks required permissions, AgentX keeps the workflow
   blocked at plan review and posts a short actionable message; it does not silently start coding.

## Functional requirements

- **FR-001:** The broker MUST persist one versioned workflow record linked to each opted-in task;
  task status and workflow stage remain distinct.
- **FR-002:** Workflow definition and stages MUST be typed, ordered, and server-owned. V1 supports
  `PLAN`, `PLAN_REVIEW`, `IMPLEMENT`, `VERIFY`, `REVIEW`, `PULL_REQUEST`, `WAIT_FOR_MERGE`, and
  terminal `MERGED` or `CLOSED` outcomes. A task MUST record its selected `QUICK` or `FULL` review
  path. Quick requires approval of the implementation plan; Full additionally requires approvals of
  requirements, design, and task breakdown before implementation.
- **FR-003:** Before `IMPLEMENT`, the worker MUST operate in a read-only planning mode enforced by
  tool/workspace capability, not prompt text alone. A human approval is required to grant mutation.
- **FR-004:** Requirements, plan, and test-plan artifacts MUST be versioned, content-addressed,
  task-linked, and attributable. A changed artifact invalidates approval of its earlier digest.
- **FR-005:** Only the authenticated task owner or a project administrator MAY approve, reject,
  request changes to, or skip an eligible stage. Actor identity MUST come from verified auth, not
  request fields.
- **FR-006:** A skip MUST require a stage that the server policy marks skippable, an authorized
  actor, and a reason. It MUST be shown as `SKIPPED`, never `PASSED`.
- **FR-007:** Every decision and transition MUST be durable, ordered, idempotent, and recoverable
  after broker or worker interruption.
- **FR-008:** Slack MUST be the primary interaction surface for Slack-originated workflows. Its
  thread messages MUST be concise, human-readable status and actions; detailed plan text MUST be
  linked from the thread instead of pasted into it. Developer MCP MUST expose the same canonical
  stage, blocker, responsible actor, decision history, artifact references, and next action.
- **FR-009:** The workflow MUST preserve workspace isolation, task ownership, existing API
  compatibility, and task lifecycle semantics.
- **FR-010:** Slack plan display MUST link to a task-specific detail view. The view is a projection
  of an immutable AgentX plan artifact; edits to Slack Canvas content do not change the artifact or
  authorize implementation. Each revised plan gets a new version and approval.
- **FR-011:** The Slack app manifest MUST request only the Canvas scopes needed to create a
  task-specific detail Canvas and resolve its link. Existing installations must be told that a
  reinstall is required to grant newly requested scopes.
- **FR-012:** Required checks MUST be identified as project policy and remain selected. Optional
  checks MAY be chosen by the owner from a bounded, project-approved set. The approved set is part
  of the plan contract; changing it invalidates affected verification evidence.
- **FR-013:** Workflow Slack actions MUST be authenticated from Slack's signed interaction payload,
  mapped to the task and current workflow revision, authorized against the task owner/admin policy,
  and idempotent under repeated delivery.
- **FR-014:** A requester MUST be able to select Quick or Full when starting a workflow in Slack or
  through the workflow MCP tool. Quick is the default. Project-required checks, reviews, and authority
  rules MUST apply to both paths and MUST NOT be disabled by path selection.

## Entities

- **Workflow Record:** task ID, selected workflow path, workflow version, stage, revision, timestamps, responsible role,
  blocker, candidate manifest digest, and links to artifacts and evidence.
- **Workflow Artifact:** task ID, type, version, digest, producer, object reference, and creation
  time.
- **Workflow Decision:** authenticated actor, decision, reason, request ID, workflow revision,
  artifact digest, optional candidate digest, and time.

## Success criteria

- **SC-001:** In scripted tests, a task cannot mutate source before an authorized plan approval.
- **SC-002:** Every invalid, stale, unauthorized, duplicate, or concurrent transition is refused
  or idempotently returns its prior result.
- **SC-003:** After a broker restart, task owner and admin views report the same stage and next step.
- **SC-004:** Existing task API contract and authorization tests remain green.
- **SC-005:** Quick and Full select the expected approval stages, and neither allows code changes
  before its required human approvals.

## Scope and assumptions

- Slack is the primary surface for Slack-originated work. MCP remains available as another surface
  over the same canonical task record; it must not create a parallel approval or evidence history.
- Review reports and worker summaries are claims, not qualified evidence.
- CharterArc integration, automatic merge, release, deployment, and production validation are out
  of scope.
