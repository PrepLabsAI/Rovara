# AgentX execution capabilities — what this branch actually does

Lane B / B3. Characterization of branch `codex/lane-agentx` from
`067ea9e82a6affee106c4854416cc693ed444d77`. This is an inventory of observed behavior, not a
feature list and not an authorization. AgentX reports execution results; CharterArc decides
evidence qualification, readiness and approval.

## Evidence vocabulary

| Value | Meaning |
|---|---|
| `observed_offline` | an offline test on this tree exercised the real code path with injected fakes |
| `observed_live` | seen in a deployed environment against real infrastructure |
| `unsupported` | the code path does not implement it |
| `unknown` | evidence is missing, inaccessible or inconclusive |

**Nothing in this repository is `observed_live`.** No test here runs a paid model, reaches
AWS, or exercises a deployed route. An offline test proves the code does what it says on this
machine; it does not prove a deployment behaves that way.

## Report

```typescript
{
  sourceCommit: "<git rev-parse HEAD at report time>",
  requestLookup:             "observed_offline",
  nativeConversationRestore: "unsupported",
  frozenCandidate:           "observed_offline",
  cancellation:              "observed_offline",
  workerDeadlineEnforcement: "unsupported",
  workerBudgetEnforcement:   "unsupported",
  workerScopeEnforcement:    "observed_offline",
}
```

The report describes test evidence. It is not an executor-issued authorization, and Lane A
configures eligible adapter capabilities independently.

## Per capability

### `requestLookup` — `observed_offline`

`GET /v1/workspaces/{workspaceId}/requests/{requestId}` on both real handlers. Read-only,
owner-scoped, membership-rechecked. See `docs/p02-request-recovery.md`.

Source: `packages/broker/src/request-lookup.ts`, `operations.ts` (`getByRequest`),
`handler.ts`, `aws/broker.ts` (`getOperationByRequest`).
Tests: `tests/contract/request-lookup.test.ts`, `tests/contract/idempotency.test.ts`,
`tests/contract/candidate-broker-routes.test.ts`.

### `nativeConversationRestore` — `unsupported`

**The task path never restores a conversation.** `runTaskInvocation` calls
`createWorkspacePiSession`, which only calls the adapter's `create`. It never calls `open`,
and it never passes `invocation.payload.conversationId` to the adapter. The conversation id
the caller supplies is used by the broker to check a conversation record exists; the worker
then mints a fresh native session and returns *that* id.

The plumbing for restore does exist — `openRegisteredWorkspacePiSession` and
`WorkspaceConversationStore`, which resolves a conversation id to a session file inside
`agent-sessions/` with path containment. Nothing under `packages/` calls either. They are
referenced only by `tests/integration/resumption.test.ts`, and that test drives a **fake**
adapter, so it evidences the manifest/containment plumbing rather than real Pi history
restoration.

This is a wiring gap, not a missing design. It is recorded as `unsupported` rather than as a
supported resume, because a follow-up turn through the current path silently starts a new
conversation.

A caution for readers of the existing suite: `fixturePiAdapter` in
`tests/integration/remote-coding.test.ts` returns the requested conversation id from its own
closure, so tests using it appear to preserve the conversation even though the production
code never supplied it.

Source: `packages/worker/src/run-task.ts:53`, `pi-session.ts:49` / `:78`, `conversations.ts`.
Tests: `tests/contract/unified-execution-capabilities.test.ts` (characterization plus one
skipped desired-behavior test), `tests/integration/resumption.test.ts`.

### `frozenCandidate` — `observed_offline`

Complete and exact. `freezeTaskCandidate` captures the full source set, writes a fresh tree
into an isolated bare object store, commits it parented on the declared base commit and emits
a Git bundle in chunked artifacts with per-chunk SHA-256 and upload receipts.

Preserved properties, each with a test:

- **New and deleted files are both represented.** The tree is rebuilt from `read-tree --empty`
  and the current file set, so a deleted file is simply absent from the candidate tree.
- The workspace is re-fingerprinted after capture; a concurrent mutation raises `STALE_FENCE`.
- Candidate records are immutable once written, and the retained bundle is rehashed on reuse.
- Credential-bearing paths, symlinks, submodules, Git LFS pointers and embedded secrets are
  rejected rather than silently exported.
- Cancellation is rechecked between chunk uploads.

Source: `packages/worker/src/candidate.ts`.
Tests: `tests/integration/candidate-handoff.test.ts` — in particular "reconstructs committed,
new, deleted, binary and executable source beyond display limits", which clones the emitted
bundle and compares the reconstructed worktree.

### Publication — separate from candidate creation, and not candidate-based

Candidate creation and pull-request publication are different invocation kinds (`task` versus
`publish`/`maintain`). They are genuinely separate: producing a candidate publishes nothing.

Beyond that separation, the important finding is what the publish path will **not** do.
`publishWorkspace` refuses outright to consume a candidate or a candidate authorization:

```typescript
if (invocation.payload.candidate !== undefined || invocation.payload.authorization !== undefined) {
  throw agentXError("FORBIDDEN",
    "exact candidate publication is not enabled; legacy publication cannot consume candidate authorization");
}
```

So **exact-candidate publication is `unsupported` on this branch.** The `publish` path is the
legacy one: it publishes from the worker's live workspace checkout, not from the frozen
candidate bundle. The `CandidatePublicationAuthorization` type exists and is tested as a
schema (`tests/contract/candidate-authority.test.ts`), but no publication path accepts one.

That legacy path also does not preserve a verified tree across a moved base. It fetches the
current `origin/<baseBranch>`, computes `merge-tree --write-tree` of the workspace commit
against that base, and creates a **new** commit parented on the new base. When the base has
moved, the published tree is a merge result that no verifier has seen. It is not a silent
rebase of the candidate commit — the candidate bundle is untouched and the result reports its
own base and head — but the published head can differ from the exact tested tree.

For CharterArc this means: a publication observation from this branch cannot be treated as
"the verified candidate reached the remote". Lane A must rebind evidence to the observed head,
and a moved base must invalidate the prior approval rather than inherit it.

Source: `packages/worker/src/publish.ts:32` (the refusal), `:242`–`:264` (base merge),
`packages/contracts/src/candidate.ts`.
Tests: `tests/contract/candidate-authority.test.ts`,
`tests/integration/pull-request-publication.test.ts`,
`tests/integration/pull-request-maintenance.test.ts`.

Successor S5 below covers closing this gap.

### `cancellation` — `observed_offline`

`WorkerCancellationController` aborts the Pi session, then `SIGTERM`s the tracked child
process group, waits a grace period and `SIGKILL`s. It reports `CANCELLED` only when no
process remains and `INTERRUPTED` otherwise — an honest distinction rather than an assumed
stop. Files are not rolled back. The broker preserves a completed candidate when cancellation
loses the terminal race.

Source: `packages/worker/src/cancel.ts`, `packages/broker/src/aws/broker.ts`.
Tests: `tests/integration/task-controls.test.ts`,
`tests/contract/candidate-broker-routes.test.ts`.

### `workerDeadlineEnforcement` — `unsupported`

`DemoRunLimits` does enforce a real wall-clock deadline: a fixed 180 s budget with an
`AbortController` wired into the provider stream and `assertActive()` checkpoints between
stages, proven offline by `tests/integration/demo-run-deadline.test.ts`.

It is nonetheless reported `unsupported`, because **it is not a per-job deadline.** It is a
fixed constant behind a trusted runtime opt-in (`AGENTX_DEMO_RUN_LIMITS=1`), off by default,
and available only for one demo model. The execution request has no deadline field at all, so
a job that asks for a deadline gets none.

### `workerBudgetEnforcement` — `unsupported`

Same shape. `DemoRunLimits` enforces at most 8 model dispatches and 262 144 cumulative input
bytes, reserving before dispatch and never refunding failed or uncertain requests
(`tests/contract/demo-run-limits.test.ts`). Those are fixed constants in demo mode, not the
job's budget. The wire carries no budget field, so `maximum_microunits` is enforced by
nothing.

### `workerScopeEnforcement` — `observed_offline`

What is genuinely enforced per job, from the trusted candidate binding rather than from model
output:

- The tool working directory is resolved through `realpath` and must stay inside the
  workspace; an escaping or symlinked path is refused before a session is created.
- The candidate repository must match the registered project, its remote URL must match, its
  root must match, its `HEAD` must equal the declared base commit and the tree must be clean.
- Session files must stay inside `agent-sessions/`.
- Demo mode removes `bash` from the tool set.

Source: `packages/worker/src/pi-session.ts`, `candidate.ts` (`assertTaskCandidateBase`).
Tests: `tests/integration/candidate-handoff.test.ts`, `tests/contract/demo-session-limits.test.ts`.

This covers workspace and repository containment. It does **not** cover path-level scope: see
below.

## The request contract's own limits are enforced by nothing

The proposed execution request carries fields the current wire body does not include. The
worker cannot enforce what it never receives. Each is `unsupported`:

| Field | Status |
|---|---|
| `approved_plan_digest` | `unsupported` |
| `test_plan_digest` | `unsupported` |
| `allowed_paths` | `unsupported` |
| `deadline` | `unsupported` |
| `maximum_microunits` | `unsupported` |
| `allowed_actions` | `unsupported` |
| `forbidden_actions` | `unsupported` |

The task payload is exactly `{ conversationId, prompt }` plus an optional `candidate`, and a
test pins that shape.

**A prompt is not a control.** Putting "stay under budget, finish before the deadline, only
edit `backend/tasks.py`" into the prompt is model input. Treating it as enforcement would let
an executor qualify its own constraint compliance, which the objective forbids.

Broker and workspace credentials continue to enforce their actual existing scope. That is a
credential boundary, not per-job enforcement.

## Proposed successors, one per real gap

Each is the smallest coherent follow-up. None is authorized by this report; each needs its own
review, and the live ones need the separate activation gate.

### S1 — Wire native conversation restore into the task path

- **Files:** `packages/worker/src/run-task.ts`, `packages/worker/src/pi-session.ts`.
- **Reusable helpers, already present and tested:** `openRegisteredWorkspacePiSession`,
  `WorkspaceConversationStore.resolve` / `.createSessionFile`, `assertContained`.
- **Change:** in `executeTaskInvocation`, resolve `invocation.payload.conversationId` through
  `WorkspaceConversationStore`. On a hit, open the registered session; on a miss, create one
  and register it under the requested id.
- **Inputs/outputs:** unchanged wire body; the returned `conversationId` becomes the requested
  one instead of a freshly minted one.
- **Negative tests:** missing conversation, corrupt manifest, session file outside
  `agent-sessions/`, session file deleted under a live manifest entry, and an id belonging to
  another workspace. A missing history must produce an explicit cannot-restore outcome, never
  a silent new conversation presented as a resume.
- **Acceptance:** un-skip `DESIRED: a follow-up turn resumes the requested native conversation`
  in `tests/contract/unified-execution-capabilities.test.ts`.
- **Authority:** none added. No new credential, network or action scope. Do not add a second
  memory service, transcript store or orchestrator; the manifest already exists.
- **Caveat:** this restores *the saved session file*. Whether the real Pi adapter reconstructs
  usable conversation state from it is `unknown` and needs its own evidence; the existing
  resumption test uses a fake adapter.

### S2 — Carry per-job limits on the wire, then enforce them

- **Files:** `packages/contracts/src/operation.ts` (`OperationRequestSchema`),
  `packages/contracts/src/protocol.ts` (`WorkerInvocationSchema`),
  `packages/broker/src/aws/broker.ts` and `operations.ts` (pass through),
  `packages/worker/src/run-task.ts` and `demo-run-limits.ts` (generalize the fixed constants
  into per-job values).
- **Reusable helper:** `DemoRunLimits` already has the enforcement shape — reserve before
  dispatch, never refund, abort signal, `assertActive()` checkpoints. It needs parameterizing,
  not reinventing.
- **Negative tests:** a job whose limits exceed the runtime ceiling must be narrowed, never
  widened; limits absent from the request must fall back to the runtime ceiling; an expired
  deadline must fail closed without a model call; a limit must not be expandable by task or
  repository input.
- **Hash impact:** adding fields to `OperationRequestSchema` changes `taskPayloadHash` inputs.
  New optional fields absent from a request serialize to nothing and leave existing hashes
  intact, but this must be proven against the published vectors in
  `tests/fixtures/p02-request-recovery.json` before merge.
- **Authority:** this is a contract change. It affects what a job may consume, so it needs an
  explicit gate rather than a lane decision.

### S3 — Enforce `allowed_paths`

- **Files:** `packages/worker/src/candidate.ts` (`captureSource`), `pi-session.ts` (tool set).
- **Change:** refuse a candidate whose captured file set touches a path outside the allowlist,
  checked at freeze time where the trusted binding is already available.
- **Negative tests:** escape by symlink, by `..`, by case-folding collision, and by a file
  created then deleted. Enforcing only at capture means an out-of-scope edit is caught but not
  prevented; that limit must be stated rather than described as sandboxing.
- **Depends on:** S2, since the field must reach the worker first.
- **Authority:** none added; it only narrows.

### S5 — Publish the exact frozen candidate

- **Files:** `packages/worker/src/publish.ts`, `packages/broker/src/candidate-bindings.ts`,
  `packages/broker/src/aws/broker.ts` (publish acceptance).
- **Reusable helpers, already present and tested:** `CandidatePublicationAuthorizationSchema`,
  `validateCandidateBinding`, the retained candidate bundle and its per-chunk digests, and
  `candidateGit` for operating on a bundle without touching the live checkout.
- **Change:** accept a candidate authorization, materialize the retained bundle, and push the
  exact candidate commit. Remove the blanket refusal only for that path; the legacy workspace
  path stays as it is.
- **Negative tests:** expired authorization; authorization naming another candidate, actor,
  repository, base branch or action; candidate digest mismatch against the retained bundle; a
  base that moved since verification, which must be refused as a new candidate rather than
  merged; and a replayed publication that must reconcile to the same pull request.
- **Authority:** this one is consequential. It gives the worker a path from candidate to a real
  remote write, so it needs the explicit publication-authority gate, not a lane decision, and
  its credentials belong to the live-activation package.

### S4 — Live activation evidence

Every `observed_offline` value above becomes `observed_live` only through the separate
activation gate in `parallel-delivery/08-integration-and-acceptance.md` §G5: reviewed machine
and job grants, project-scoped credentials, bounded isolation, real budget and attempt limits,
and a real human decision. This report cannot and does not authorize any of that.
