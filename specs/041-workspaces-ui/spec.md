# Feature Specification: Workspaces UI

**Feature Branch**: `feat/041-workspaces-ui`
**Created**: 2026-09-28
**Status**: Implemented (phase 1)
**Input**: Paperclip PRE-6, "Make the workspaces visible on the UI": a Paperclip-like page that
shows the available workspaces, reading them from the control plane, and the list of projects.

## Context

A developer can already ask the control plane which projects they may use (`agentx whoami`, spec
025's `GET /v1/dev/projects`). Nothing tells them what exists *inside* those projects: every
workspace lives in a Slack thread, and the only way to find one is to remember which thread it was.
An administrator can stop or cancel a workspace by id (`agentx admin workspace stop --workspace
<id>`), but there is no route that answers "which workspaces are there".

This feature adds that route and shows its answer, on a page served from `127.0.0.1` the way spec
040's install wizard serves its own: plain HTML, one stylesheet and one ES module, no bundler and no
second build step.

Two seams already exist and are reused unchanged:

| Seam | Where | What this feature does with it |
| --- | --- | --- |
| `/v1/dev/*`, the developer API | `packages/broker/src/aws/developer-routes.ts` | A second route, with the same sign-in check and the same access resolution |
| The developer session on this computer | `packages/cli/src/developer/session.ts` | The page's data comes through it, so the browser is never given a token |

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See What Is Running (Priority: P1)

A developer runs `agentx workspaces`. A page opens on `127.0.0.1` listing the projects they may use
and, for each, the workspaces in it: what revision each is pinned to, what it is doing, and when it
last changed. The list refreshes while the tab is open.

**Independent Test**: with two projects and workspaces in one of them, the page lists both projects
and every workspace in the one that has them, without the developer knowing any workspace id.

### User Story 2 - Only What They May See (Priority: P1)

The listing is scoped exactly like `agentx whoami`: a project the developer was granted, or one
whose Slack channel they are in. A workspace in any other project is not listed, and nothing about
how a workspace runs (its owner, instance, or ARN) reaches the page.

**Independent Test**: a workspace in an unreachable project never appears in the response, and the
response body contains no owner key.

### User Story 3 - Without A Browser (Priority: P2)

`agentx workspaces --no-ui` prints the same list as text, and `--json` prints the control plane's
own answer. A session with no terminal never tries to open a browser.

**Independent Test**: `agentx workspaces --no-ui` in a pipe prints every project and workspace and
exits, opening nothing.

## Requirements

### The control plane

- **FR-001**: `GET /v1/dev/workspaces` MUST answer with the developer, the projects they may use
  (exactly as `GET /v1/dev/projects` resolves them, channel membership included), and the workspaces
  in those projects, newest first. It MUST need the same developer sign-in as every other
  `/v1/dev/*` route.
- **FR-002**: A project's workspaces MUST be read through a sparse index on the state table
  (`byWorkspaceProject`), never a scan, and MUST be capped per project so one page load cannot turn
  into an unbounded read.
- **FR-003**: A workspace MUST be described by what it is and how it is doing -- id, project,
  pinned revision, status, whether a task holds it, created and updated -- and by nothing about how
  it runs: no owner key, no instance, no ARN, no preparation manifest.
- **FR-004**: A stored record this release cannot parse MUST be left out of the listing with a
  structured log line, rather than failing the whole request.

### The page

- **FR-010**: `agentx workspaces` MUST start an HTTP server bound to `127.0.0.1` on an ephemeral
  port, open the developer's browser at it, and serve the page. It MUST stop with the command.
- **FR-011**: Every request MUST carry a single-use session token minted for that run, and the
  server MUST refuse a request whose `Host`, `Origin`, `Referer` or `Sec-Fetch-Site` is not its own.
  No response MUST carry a CORS header.
- **FR-012**: The developer's AgentX tokens MUST stay in the CLI process. The page MUST have no
  route that changes anything: it reads, and that is all.
- **FR-013**: The page MUST re-read the list on a timer and on demand, and MUST say what to do when
  the control plane refuses (a sign-in that has ended names the command that fixes it).

### The command

- **FR-020**: `--no-ui` MUST print the list as text, and `--json` MUST print the control plane's own
  answer. Neither MUST open a browser, and neither MUST a session with no terminal.
- **FR-021**: The first read MUST happen before the browser opens, so a sign-in that has ended is
  reported in the terminal rather than only on a page nobody is looking at. The page's own first
  request is answered from that read rather than reading the control plane twice.

## Success Criteria

- **SC-001**: HTTP-level tests cover the route's scoping, its shape, its index reads, and its
  refusal without a developer sign-in.
- **SC-002**: HTTP-level tests cover the page server's routes, the session-token refusal, and the
  `Host`/`Origin`/`Referer`/`Sec-Fetch-Site` refusals.
- **SC-003**: CLI tests cover `--no-ui`, `--json`, the no-terminal fallback, the browser path, and a
  sign-in that has ended.
- **SC-004**: The existing `agentx whoami` and developer-route tests pass unchanged.

## Out Of Scope

- Acting on a workspace from the page. It reads; stopping or cancelling one stays an administrator
  command (`agentx admin workspace stop`, `agentx admin workspace cancel`).
- A frontend framework or a second build toolchain, for the same reason as spec 040: the page is
  plain HTML, one ES module and a stylesheet, compiled as strings with the rest of the CLI.
- Remote or multi-user access. Loopback only, one developer, one run.
- Conversations, pull requests and turns inside a workspace. This feature lists workspaces.

## Decisions

- **Location**: `packages/cli/src/workspaces-ui/`, alongside but independent of spec 040's install
  wizard. The two pages share an approach, not code; folding their server guards together once both
  have shipped is worth doing and is not done here.
- **The index, and what it does not show**: `byWorkspaceProject` is sparse, and only workspace
  records written after the release that adds it carry its attributes. Workspaces created before it
  are not listed. No backfill is run: the alternative, a migration over every historical record,
  buys history that a developer has no use for.
- **Per-project cap**: `DEVELOPER_WORKSPACES_PER_PROJECT` (200), newest first. A project busier than
  that needs paging on the wire, which this phase does not add.

## Follow-ups

- Paging for a project with more workspaces than the cap.
- One workspace's detail: its conversation, its pull requests, its last turns.
- Sharing the loopback server's request guards with spec 040's wizard once that has landed.
