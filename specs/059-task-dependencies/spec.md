# Feature Specification: Task Dependencies Within an AgentX Workflow

**Feature Branch**: `codex/agentx-native-workflow`
**Created**: 2026-10-05
**Status**: Design draft for owner review
**Input**: Owner request to begin dependency design alongside PR event work; native AgentX workflow spec 056
**Objective**: `MSDLC-OBJ-001@0.4` (unchanged)

## Problem

A larger request may need several pieces of work completed in a particular order. A flat task plan
does not make that order visible, so a person cannot tell which work can begin, what is waiting on
something else, or why a later step is blocked.

## Proposed user experience

When the requester chooses the **Full** workflow path, AgentX presents a short task breakdown in the
task Canvas. Each item shows its name, status, and the items it depends on. The Slack thread shows a
brief summary and links to the Canvas. The owner approves the breakdown before implementation.

For example, a request to add a new payment method might have:

1. Add the payment-method API.
2. Add the account-page form. This waits for item 1's API contract.
3. Add integration tests. This waits for items 1 and 2.

If item 1 fails, items 2 and 3 stay blocked and AgentX explains why. Independent items may be
identified as ready, but automatic parallel execution is not part of the first dependency design.

## Proposed behavior

- A task breakdown is a versioned directed acyclic graph (DAG) of work items.
- Each item has a stable ID, short title, description, repository scope, and a list of dependency IDs.
- An item is `BLOCKED` while any dependency is incomplete, `READY` when all dependencies are
  complete, and otherwise follows its own run state (`RUNNING`, `WAITING`, `FAILED`, `COMPLETE`).
- AgentX rejects duplicate IDs, missing dependencies, self-dependencies, cycles, and references to
  another workflow.
- The owner approves the graph version before implementation. Approval binds the task ID, graph
  digest, and workflow revision. Changing an item or dependency requires a new graph version and
  approval before the affected work continues.
- A failed item blocks only its descendants; unrelated items remain visible with their current
  status. A workflow is not complete until all required items are complete and its normal checks,
  reviews, and PR gates are satisfied.
- Work-item results and evidence identify the work-item ID, graph digest, candidate digest, producer,
  and time. A new candidate invalidates stale checks and reviews under the existing workflow rules.

## Proposed execution phases

1. **Design and contract:** graph schema, validation, readable Canvas representation, owner approval,
   and restart-safe status storage. No scheduling or concurrent execution.
2. **Safe sequencing:** execute ready work items one at a time in a deterministic order; stop and
   report failed dependencies; allow the owner to revise and reapprove the graph.
3. **Parallel execution:** consider only after each item can run in an isolated workspace and results
   can be integrated without overwriting another item's changes. A project-level concurrency limit
   and cancellation/recovery behavior are required before enabling it.

All three phases remain part of the retained product direction unless the owner changes that
decision. Phasing is not a product-scope rejection.

## Authority and safety requirements

- Slack and MCP display the same canonical graph; neither presentation is the source of truth.
- Work items cannot approve their own graph or expand project permissions.
- Required project checks, reviews, task-owner authority, and human-controlled merge remain in force.
- Agent output, dependency suggestions, and comments from GitHub are untrusted proposals until
  accepted by an authorized human.
- A graph edit invalidates approval of the previous graph version. Changed code invalidates evidence
  for the previous candidate.
- Dependencies express ordering. They do not grant production, deployment, or merge authority.

## Acceptance criteria for the design

- A cycle, missing dependency, duplicate ID, or stale graph approval is refused with a short reason.
- The Canvas makes it clear which items are blocked and which dependency is holding each one.
- After restart, graph version, item states, blockers, and the next actionable item are unchanged.
- A failed item blocks descendants but does not falsely mark independent items complete or blocked.
- A graph and its work-item evidence remain traceable through verification and PR creation.

## Open design questions

- Should work items always share one final PR, or can the owner choose a PR per item or dependency
  group?
- How should the owner revise a graph after some items have completed: preserve completed work and
  reapprove only affected descendants, or require approval of the full new graph?
- What is the maximum supported number of items and dependencies for a readable first version?
- Should serial execution be the default even when several items are ready? (Proposed: yes until
  isolated parallel execution is proven safe.)
