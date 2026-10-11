# Feature Specification: Candidate-Bound Verification and Review

**Feature Branch**: `codex/agentx-native-workflow`
**Created**: 2026-10-05
**Status**: Approved for implementation by owner
**Input**: DEC-032, E-030, AgentX spec 051
**Constitution**: 4.1.0

## Context

AgentX already runs configured checks and reports their before/after results. It does not yet bind
all workflow evidence to one immutable candidate or provide separate read-only review stages.
This feature uses existing checks and adds attributable review reports. A reviewer's conclusion is
a reviewer claim; it is not an independently qualified test result or merge authorization.

## User stories & testing

### Story 1 — Know which code was checked (P1)

A task owner can see that checks and reviews describe the exact repository heads proposed for its
PRs. If code changes, old results visibly become stale and the workflow returns to verification.

**Independent test:** Change a fixture commit after a successful check and reviewer report; verify
the previous results no longer satisfy the gate.

### Story 2 — Get separate critic and security reviews (P1)

AgentX runs bounded read-only critic and security reviews against the candidate. Reports identify
review role, implementation/version, candidate, findings, and status. Reviewers cannot modify the
workspace or approve themselves.

**Independent test:** Run scripted reviewer adapters in a read-only worker sandbox; attempt a write
and confirm it is denied; interrupt one reviewer and confirm the stage stays unresolved.

## Functional requirements

- **FR-001:** The workflow MUST reuse configured AgentX checks and bind each result to repository,
  immutable candidate head/tree digest, environment identity, producer, command/check ID, and time.
- **FR-002:** A candidate is a canonical sorted manifest of repository IDs and exact commit/tree
  hashes. Its digest is computed by AgentX; callers and workers cannot select a substitute digest.
- **FR-003:** Any candidate or material test-plan change MUST invalidate dependent check results,
  reviewer reports, and approvals and return the workflow to the earliest affected stage.
- **FR-004:** Critic and security reviewers MUST be separate, read-only executions over the exact
  candidate, in a separate broker-issued review operation from implementation. The broker MUST
  bind each report to that operation and the exact candidate. Reviewer output MUST be labelled as a
  claim and MUST NOT qualify itself as evidence.
- **FR-005:** A review is `PASS`, `FINDINGS`, `FAILED`, `INTERRUPTED`, or `UNKNOWN`; missing,
  timed-out, interrupted, stale, or malformed output MUST NOT count as pass.
- **FR-006:** A required failed check or blocking review finding MUST prevent `PULL_REQUEST_READY`;
  existing draft-PR behavior for failed checks remains supported.
- **FR-007:** Reports MUST be bounded, redacted, attributable, and link to the exact candidate.
- **FR-008:** Human merge authority remains in GitHub; no reviewer result can merge, deploy, or
  mark production delivered/validated.

## Success criteria

- **SC-001:** Changing any repository head makes every dependent result stale.
- **SC-002:** Reviewer processes cannot write to candidate files, alter workflow state, or create
  their own approval.
- **SC-003:** Missing, stale, interrupted, or failed results never produce a passing review stage.
- **SC-004:** Existing configured checks retain their before/after and redaction behavior.

## Scope and assumptions

- V1 uses scripted adapters for local acceptance; no paid evaluation or live customer validation
  is included.
- AI review is decision support and remains attributed to its provider/model/version.
- CharterArc integration and automatic merge/deployment are out of scope.
