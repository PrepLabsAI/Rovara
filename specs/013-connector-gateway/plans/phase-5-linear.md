# Phase 5: Linear Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An administrator can register a team-restricted Linear API key, approve Linear tools in a
project, and members can list, read, create and comment on Linear issues of that team from a Slack
thread, with the team bound by the server and every write signed with the requesting member.

**Architecture:** The gateway gains `packages/gateway/src/linear.ts`: the endpoint, a binder that
uses 5b's `optionalProperties` to bind the team as both `team` and `teamId`, an issue-in-team
`Guard` that reads the team from 5b's `GuardInput.scope`, and a `linearConnector(credentials)`
factory. The gateway
engine is not edited; 5b already did that. The
contracts gain `LinearConnectorSchema` in `ConnectorConfigSchema`. The broker gains a
`linearConnectorType` in the built-in type map. It reads a `static-secret` credential through phase
3's `CredentialRegistry`. Registration refuses a Linear connector whose `credentialRef` is missing
from the registry or has the wrong type. Routes, catalog cache, ledger, thread setup and preflight
are the generic 5a paths and do not change.

**Tech Stack:** TypeScript 5.9 strict, Node 22.19 to 22.x, Zod 4, Vitest 5, MCP SDK 1.30.1
(Streamable HTTP), Pi 0.85.1 for the hosted-turn test.

**Spec:** [../spec.md](../spec.md): User Story 2, FR-005, FR-009, FR-011, FR-013, FR-019, FR-024,
SC-002, SC-005. Also [../data-model.md](../data-model.md) (linear scope `teamId`),
[../contracts/project-config.md](../contracts/project-config.md) (linear example, mandatory
vendor-side restriction), [../contracts/evaluation.md](../contracts/evaluation.md). Predecessors:
[phase-3-credentials.md](phase-3-credentials.md) (its ruling moves the `credentialRef` refusal
here) and [phase-5a-generic-connectors.md](phase-5a-generic-connectors.md).

**Branch:** `feat/013-linear-connector`, stacked on the 5b head (`feat/013-binder`, which stacks on
5a `feat/013-generic-connectors`). Depends on both 5a and 5b. Opened as a PR that depends on the 5b
PR, and rebased if 5a or 5b review changes them. Phase 6 (Jira) runs in parallel; see
"Coordination with phase 6 (Jira)".

## Global Constraints

- **No regressions.** Every existing test passes with its assertions unchanged, except the one
  deliberate change named in Task 2 (`connector-types.test.ts`: the schema type list becomes
  `["github", "linear"]`, or `["github", "linear", "jira"]` if phase 6 landed first, because that
  test pins the list of accepted types).
- **GitHub unchanged.** GitHub strings, schema hashes, ledger keys and routes stay byte-identical.
  The 5a golden test in `slack-control-plane.test.ts` must still pass untouched.
- **FR-001 placement.** The Linear endpoint, the argument names `team`, `teamId`, `id`, `issueId` and the tool
  names `get_issue`, `save_issue`, `save_comment`, `list_comments` appear only in
  `packages/gateway/src/linear.ts`. The broker type file may name the label, vendor and scope noun,
  as the GitHub type does.
- **Endpoint.** `https://mcp.linear.app/mcp`, API key as `Authorization: Bearer <key>`.
- **Ledger.** Linear writes `CONNECTOR#<name>#<requestId>` with `entityType` `CONNECTOR_INVOCATION`
  through `connectorLedgerKeys(name)`.
- **Secret safety.** The API key never appears in a response, a log line, a ledger record, a
  preflight report or an error message.
- **Test imports.** Tests that drive broker code import gateway values from `@agentx/gateway`
  (dist). Gateway-only tests import `packages/gateway/src`.
- **Node and build.** `export PATH=/private/tmp/claude-501/node-v22.20.0-darwin-arm64/bin:$PATH`;
  `npm run build` before `npm test`.
- **Docs style.** Plain, short sentences. No em-dashes in prose. Guides are written for any
  administrator of a self-hosted AgentX, never assuming our accounts.
- **Commits.** `type(scope): summary`, ending with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **Fix before the PR.** Fix cheap review findings and anything that fails silently before the PR.

## Review Focus

1. **A write or read addressed to an issue in another team is refused before anything is sent.**
   A key that reaches two teams, with a project scoped to one, must not let `save_issue {id}` or
   `save_comment {issueId}` touch the other team. Tests: Task 1 (guard unit), Task 4 (broker, the
   fake server records `get_issue` only, never `save_issue`).
2. **A tool without `team` or `teamId` is offered and never receives either.** `save_comment` and
   `get_issue` have `additionalProperties: false`; an injected `team` would fail every call as a
   schema error. Tests: Task 1 (engine) and Task 4 assert the recorded `save_comment` arguments have
   no `team` key.
3. **A model-supplied `team` is refused with no vendor call.** Tests: Task 4 (FORBIDDEN, the fake
   server records no `tools/call`).
4. **A credential of the wrong type or a missing reference is loud, never silent.** Registration
   refuses it by name; a revision registered before a re-registration changed the type reports
   not connected, never throws. Tests: Task 3.
5. **The API key never leaks,** including through a guard failure or a vendor error echoing the
   request. Tests: Task 4 checks every response, every log line and every stored item.

## File Structure

| File | Responsibility |
|---|---|
| `packages/gateway/src/linear.ts` (new) | `LINEAR_MCP_ENDPOINT`, `LinearTeamScope`, `linearBinder`, `issueInTeamGuard`, `linearConnector` |
| `packages/gateway/src/index.ts` | Re-export `linear.js` |
| `packages/contracts/src/connectors.ts` | `LinearScopeSchema`, `LinearConnectorSchema`, union member, types |
| `packages/contracts/src/project.ts` | `githubConnectorOf` finds with a type predicate (the repository-scope loop already skips non-GitHub entries since 5a) |
| `packages/broker/src/aws/linear-connector-type.ts` (new) | `linearConnectorType` |
| `packages/broker/src/aws/connector-types.ts` | `ResolvedConnector.credential?`; `linear` in `BUILT_IN_CONNECTOR_TYPES` |
| `packages/broker/src/aws/credentials.ts` | `CredentialRegistry.typeOf(ref)` |
| `packages/broker/src/aws/registration-preflight.ts` | `credentialRefusals(connectors, registry)` |
| `packages/broker/src/aws/broker.ts` | Wiring only: call `credentialRefusals` for new revisions |
| `tests/fixtures/vendors/linear-tools.json` (5b's file) | Three more verbatim Linear tools appended: `list_comments`, `list_teams`, `delete_comment` |
| `tests/fixtures/vendors/linear-get-issue.json` (new) | The live `get_issue` result captured 2026-09-24, free text replaced |
| `tests/support/fake-linear-mcp.ts` (new) | Streamable HTTP fake Linear MCP server |
| `tests/support/linear-broker.ts` (new) | Broker with the Linear type pointed at the fake server, used by Tasks 4 and 5 |
| `tests/support/broker-fetch.ts` (new) | A `fetch` that delivers signed service requests to the broker handler |
| `tests/contract/gateway-linear.test.ts` (new) | Binder, guard and engine behaviour against the fixture |
| `tests/contract/linear-connector.test.ts` (new) | Schema, type resolution, `typeOf`, registration refusals |
| `tests/integration/linear-mcp.test.ts` (new) | Broker routes to the fake server over real HTTP |
| `tests/integration/hosted-slack-linear.test.ts` (new) | Slack processor, Pi runtime, broker, fake server |
| `tests/contract/tool-presentation.test.ts` | One added Linear snapshot case |
| `tests/eval/cases/linear.jsonl`, `tests/eval/fixtures/linear-*.yaml` (new) | Tier-2 evaluation cases |
| `tests/contract/linear-eval-cases.test.ts` (new) | Validates the cases until phase 4's runner exists |
| `docs/connectors/linear.md` (new) | Setup guide for any administrator |
| `README.md`, `specs/013-connector-gateway/*` | Amendments listed in Task 6; `quickstart.md` evidence in Task 7 |

## Pre-decided Rulings

- **R1. Linear takes a `static-secret` API key only.** Linear does support the client-credentials
  grant (`POST https://api.linear.app/oauth/token`, `grant_type=client_credentials`, tokens valid 30
  days). But its documentation (checked 2026-09-24) says the result is an "app actor token that has
  access to all public teams", and a new scope set revokes all existing app tokens. It cannot be
  limited to one team, so it cannot meet the mandatory vendor-side restriction (constitution 2.1.0,
  Principle I). Its acceptance by the MCP server is also unverified. The Linear type therefore
  accepts only `static-secret`, registration refuses any other type, and spec User Story 2
  scenario 2 is amended (Task 6). Cost if wrong: an administrator who wants app-actor identity waits
  for a follow-up that adds the type and the token endpoint constant: one small task.
- **R2. The binder sets `team` and `teamId` on every tool that declares either, including
  `save_issue` updates.** `teamId` is on `list_documents`, `list_cycles` (required),
  `create_issue_label`, `save_issue_label` and `save_project_label` (5b R11); both get the team UUID.
  On an update, `team` is a team change in Linear. The guard (R3) first proves the issue is already
  in the bound team, so the injected value is a no-op. The 5b binder cannot bind by argument, and a
  model-controlled `team` on updates would defeat FR-005. Cost if wrong: Linear may treat a same-team
  `team` as a team change and refuse `addLabels`/`removeLabels` alongside it ("Cannot be combined
  with a team change"). The live check (Task 7) tests this; if it fails, the guide drops those two
  from the recommended `allowedArguments`.
- **R3. The issue-in-team guard covers the four issue-addressed tools.** `get_issue {id}`,
  `list_comments {issueId}`, `save_issue {id}` and `save_comment {issueId}` each call `get_issue`
  first and compare the issue's team with the scope's `teamId`. `save_issue` without `id` is a
  create and needs no check. `save_comment` and `list_comments` refuse `id`, `parentId`,
  `projectId`, `initiativeId`, `documentId`, `milestoneId`, `statusUpdateId` and `statusUpdateType`,
  because there is no tool to prove which team those belong to. Cost if wrong: members cannot reply
  to or edit comments; they get a plain refusal, and a later change can verify replies through
  `list_comments`.
- **R4. The guard fails closed.** A `get_issue` error, an unparseable result or a result with no
  string `teamId` refuses the call (`policy_denied`, nothing sent). The live `get_issue` result
  (captured 2026-09-24 on `CHA-3`) has the team UUID as top-level `teamId`, the team name as
  `team`, the identifier (`CHA-3`) as `id` and the issue UUID as `uuid`. The guard reads only
  `teamId` and compares it case-insensitively with the scope's `teamId`. Cost if wrong: a transient
  `get_issue` failure reads as "not found"; if Linear renames `teamId`, every issue-addressed call
  is refused until the parser is fixed. Nothing is written either way.
- **R5. The guard reads the team from 5b's `GuardInput.scope`.** 5b sets `scope` to the call's
  `ConnectorContext.scope` on every guard call (5b R3), so the checks on `get_issue` and
  `save_comment` know the team and its alias although neither tool has a team property. This
  phase does not touch `engine.ts` or `types.ts`. A scope that is not a Linear team scope (no
  string `alias` and `teamId`) refuses the call with a `GuardRejection`, never a plain error.
  Cost if wrong: none; `bound.teamId` holds the same UUID if a later change prefers it.
- **R6. The `credentialRef` refusal is generic.** A resolved connector may declare
  `credential: { ref, accepts }`. For a new revision, registration refuses when the deployment has
  no credential registry, the reference is not registered, or its type is not accepted (the
  built-in GitHub App reads as type `github-app`). Re-submitting an already-registered revision
  stays idempotent, as for the other refusals. Jira (phase 6) reuses it; whichever phase lands
  first adds it (see Coordination). Cost if wrong: a
  deployment without connector credentials can no longer register Linear connectors at all, which
  is the intent.
- **R7. Scope validation.** `teamId` must have UUID shape (case-insensitive; the resolver
  lowercases it). Aliases and team ids are each unique within one connector. Several `linear`
  connectors per project are allowed (two workspaces). Cost if wrong: a stricter check later
  refuses a stored revision on re-registration only.
- **R8. No `identity` field.** The Linear schema is strict and, like GitHub's, has no `identity`
  key; `service` is implied. Cost if wrong: `identity: service` in YAML is a schema error until an
  optional literal is added to both schemas.
- **R9. Attribution keys are `description` then `body`.** `save_issue` signs `description`,
  `save_comment` signs `body`. An update that edits the description through `patch` is not signed.
  Cost if wrong: patch edits carry no footer; the ledger still records the member.
- **R10. Tests reach the fake server through `context.connect`.** Production keeps the endpoint
  constant. Tests wrap `linearConnectorType` with a `connect` that records the requested endpoint
  (asserted to be `https://mcp.linear.app/mcp`) and then calls the real `connectMcp` against the
  local server. Cost if wrong: none in production.
- **R11. Evaluation cases ship now; the runner arrives with phase 4.** Phase 4 (`npm run eval`,
  T030) has not landed. This phase commits the Linear cases and fixture projects in the
  `contracts/evaluation.md` format, and a contract test that checks each case parses, its project
  parses, and its expected tool is one that project presents. The deterministic tier-1 snapshot
  covers Linear now. If phase 4 lands first, use its case loader and delete the local schema in the
  test. Cost if wrong: the case format drifts and phase 4 edits eight lines.
- **R12. Fixtures extend 5b's files.** Linear tools live in 5b's
  `tests/fixtures/vendors/linear-tools.json`, read with `vendorTools("linear")`. This phase appends
  `list_comments`, `list_teams` and `delete_comment`, byte-for-byte from the live `tools/list`
  recorded 2026-09-24 (59 tools); it never removes or edits 5b's six (5b R10). The `get_issue`
  result at `tests/fixtures/vendors/linear-get-issue.json` is the live capture of 2026-09-24 with
  its free text (title, description, URL slug, branch name) replaced. Cost if wrong: drift shows
  at registration preflight and in the live check.
- **R13. The guide recommends four tools.** `list_issues` (read), `get_issue` (read), `save_issue`
  (write) and `save_comment` (write). It warns that tools without `team` (`list_teams`,
  `list_users`, `get_workspace` and others) reach whatever the key reaches, and that `delete_*`
  tools should not be approved. Cost if wrong: an administrator approves more and relies on the
  key's team restriction, which is the mandatory boundary anyway.

## Interfaces

### What this phase takes from 5b (as 5b ships it)

```ts
// packages/gateway/src/types.ts (5b)
export interface Binder<Scope> {
  readonly properties: readonly string[];                        // strict: required on every approved tool
  readonly optionalProperties?: readonly string[] | undefined;   // bound only where the tool declares it
  bind(scope: Scope, credential: IssuedCredential): Record<string, unknown>;
}
export interface GuardInput {
  tool: string;
  arguments: Readonly<Record<string, unknown>>;
  bound: Readonly<Record<string, unknown>>;   // the whole bind() result
  scope: unknown;                             // the call's ConnectorContext.scope
  connection: Pick<McpConnection, "call">;
}
// Guard.rewrite?(input: RewriteInput) also exists; Linear implements none.
// tests/support/vendor-fixtures.ts (5b)
export function vendorTools(vendor: "linear" | "jira"): McpConnection["tools"];
```

The Linear binder is exactly the one 5b's tests use (5b R11):

```ts
export const linearBinder: Binder<LinearTeamScope> = {
  properties: [],
  optionalProperties: ["team", "teamId"],
  bind: (scope) => ({ team: scope.teamId, teamId: scope.teamId }),
};
```

5b's own tests pin these behaviours; this phase relies on them and does not retest them in depth:

1. **Discovery.** `team` and `teamId` are removed from every approved tool that declares them,
   required or optional. Other tools are offered unchanged. `list_issue_statuses` is presented with
   `required: []`.
2. **A non-string `team` or `teamId`.** The tool is skipped with
   `server-bound property <name> is not a string`.
3. **Call time.** A call sends only the bound properties its tool declares, after validation
   against the presented schema and before validation against the vendor schema.
4. **Missing value.** A missing or empty when-present value fails closed: FAILED `policy_denied`,
   `Linear has no server-bound value for <name>. An administrator must fix the connector configuration.`
5. **Refusal.** A model-supplied `team` or `teamId`, on any Linear tool, is refused with FORBIDDEN
   `Linear routing arguments are server controlled`, before any connection is opened.
6. **Hashes.** Unchanged (`fingerprint({ upstream, policy, repository: scope })`).
7. **Guards see the scope.** `GuardInput.scope` is the call's scope and `GuardInput.bound` the
   whole `bind()` result, on every tool. The issue-in-team guard reads the team from `scope`
   on `get_issue` and `save_comment` too. Linear implements no `rewrite`.
8. **GitHub unchanged.**

### Names this phase produces

```ts
// packages/gateway/src/linear.ts
export const LINEAR_MCP_ENDPOINT: URL; // https://mcp.linear.app/mcp
export interface LinearTeamScope { alias: string; teamId: string }
export const linearBinder: Binder<LinearTeamScope>;
export const issueInTeamGuard: Guard;
export function linearConnector(credentials: CredentialProvider<LinearTeamScope>): ConnectorDefinition<LinearTeamScope>;

// packages/contracts/src/connectors.ts
export const LinearScopeSchema; export const LinearConnectorSchema;
export type LinearConnectorConfig = z.infer<typeof LinearConnectorSchema>;

// packages/broker/src/aws/connector-types.ts
export interface ResolvedConnector<Scope> { /* 5a fields */ credential?: { ref: string; accepts: readonly CredentialType[] } }
// packages/broker/src/aws/linear-connector-type.ts
export const linearConnectorType: ConnectorType;
// packages/broker/src/aws/credentials.ts
CredentialRegistry.typeOf(ref: string): Promise<CredentialType | undefined>;
// packages/broker/src/aws/registration-preflight.ts
export async function credentialRefusals(connectors: readonly ResolvedConnector[], registry: CredentialRegistry | undefined): Promise<string[]>;
```

## Coordination with phase 6 (Jira)

Phases 5 and 6 both branch from the 5b head and run in parallel. Neither edits
`packages/gateway/src/engine.ts`, `types.ts` or `binding.ts`: 5b owns them. For each shared piece
below, whichever phase lands first adds it; the other rebases onto it and adds only its own type.
This table is identical in the phase 5 and phase 6 plans.

| Shared piece | Owner | What the second phase does on rebase |
|---|---|---|
| `ResolvedConnector.credential?: { ref: string; accepts: readonly CredentialType[] }`, `CredentialRegistry.typeOf(ref)`, `credentialRefusals(connectors, registry)` in `registration-preflight.ts`, and its call in `broker.ts` `registerProject` (new revisions only) | first to land (phase 5 Tasks 2 and 3, phase 6 Task 3 carry the same code) | drop its own copy; set `credential` on its type; keep one registration test for its type |
| The three refusal texts | shared | `connector <name>: connector credentials are not configured in this deployment`; `connector <name>: credential <ref> is not registered; run agentx admin credential register first`; `connector <name>: credential <ref> is <type>; a <Vendor> connector needs static-secret` |
| `project.ts` repository-scope loop skips non-GitHub entries | already in 5a (`if (connector.type !== "github") continue;`) | nothing to add; each phase only confirms it |
| `githubConnectorOf` finds with a type predicate (`entry is GitHubConnectorConfig`) | first to land | drop its own copy |
| `ConnectorConfigSchema` union | each adds its own option | order `[GitHubConnectorSchema, LinearConnectorSchema, JiraConnectorSchema]` |
| `BUILT_IN_CONNECTOR_TYPES` | each adds its own entry | `{ github: githubConnectorType, linear: linearConnectorType, jira: jiraConnectorType }` |
| `connector-types.test.ts` named assertion | each changes it | `["github", "linear"]` or `["github", "jira"]` first; `["github", "linear", "jira"]` once both land |
| README "Connector credentials": the sentence "No connector type reads a registered credential yet; Linear is the first, in a later release." | first to land rewrites it, naming its type, its guide and the registration refusal | amend it to name both types and link both guides |
| `specs/013-connector-gateway/quickstart.md` (does not exist yet) | first to land creates it with the title `# Connector gateway live evidence` | add its own section: `## Linear (US2)` or `## Jira (US3)` |
| Vendor fixtures | 5b's `tests/fixtures/vendors/{linear,jira}-tools.json`, loaded with `vendorTools(vendor)` | each phase appends tools to its own vendor's file only; never removes or edits 5b's six |
| Setup guides | `docs/connectors/linear.md` (phase 5), `docs/connectors/jira.md` (phase 6) | no overlap |

---

### Task 1: Linear fixtures and the gateway connector definition (T032, part 1)

**Files:**
- Create: `tests/fixtures/vendors/linear-get-issue.json`, `packages/gateway/src/linear.ts`,
  `tests/contract/gateway-linear.test.ts`
- Modify: `tests/fixtures/vendors/linear-tools.json` (append three tools),
  `packages/gateway/src/index.ts`

**Interfaces:**
- Consumes: 5b `Binder.optionalProperties` and `GuardInput.scope` (see Interfaces above); 5b
  `vendorTools` from `tests/support/vendor-fixtures.ts`; `GuardRejection`, `resultText`, `isObject`.
- Produces: the `linear.ts` names listed above.

- [ ] **Step 1: Extend the tool fixture and build the `get_issue` fixture**

Append three tools to 5b's fixture, byte-for-byte from the live `tools/list` recorded 2026-09-24,
after 5b's six:

```bash
export PATH=/private/tmp/claude-501/node-v22.20.0-darwin-arm64/bin:$PATH
SRC=/private/tmp/claude-501/-Users-abhishekgarg-web/ffaf1996-7c19-4dcc-8463-6c9e6e330dfc/scratchpad/plans
node -e '
const fs = require("fs");
const all = JSON.parse(fs.readFileSync(process.argv[1] + "/linear-tools.json", "utf8"));
const file = "tests/fixtures/vendors/linear-tools.json";
const kept = JSON.parse(fs.readFileSync(file, "utf8"));
for (const name of ["list_comments", "list_teams", "delete_comment"]) {
  if (kept.some((tool) => tool.name === name)) continue;
  const tool = all.find((entry) => entry.name === name);
  if (!tool) throw new Error(name);
  kept.push(tool);
}
fs.writeFileSync(file, JSON.stringify(kept, null, 2) + "\n");
' "$SRC"
jq -c '[.[].name]' tests/fixtures/vendors/linear-tools.json
```

Expected: `["list_issues","save_issue","list_issue_statuses","list_documents","get_issue","save_comment","list_comments","list_teams","delete_comment"]`.
5b's tests still pass: they approve only their own six tools.

Build the `get_issue` fixture from the live capture (`get_issue { id: "CHA-3" }` on the CharterArc
team, 2026-09-24). Keep every key and value except the free text:

```bash
SPIKE=/private/tmp/claude-501/-Users-abhishekgarg-web/ffaf1996-7c19-4dcc-8463-6c9e6e330dfc/scratchpad/spike
jq '.title = "Fixture issue" | .description = "Fixture description." | .url = "https://linear.app/example/issue/CHA-3/fixture-issue" | .gitBranchName = "example/cha-3-fixture-issue"' \
  "$SPIKE/linear-get-issue-raw.json" > tests/fixtures/vendors/linear-get-issue.json
jq -c '{id, uuid, team, teamId}' tests/fixtures/vendors/linear-get-issue.json
grep -c 'uploads.linear.app\|abhishek\|import-your-data' tests/fixtures/vendors/linear-get-issue.json
```

Expected: `{"id":"CHA-3","uuid":"f3d8bbc5-2101-4493-b123-21b1177a9900","team":"CharterArc","teamId":"c408e946-78aa-4db8-923e-f78053dd954f"}`,
then `0`. If the spike file is gone, stop and report to the controller; do not write the fixture by
hand.

- [ ] **Step 2: Write the failing tests**

```ts
// tests/contract/gateway-linear.test.ts
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  LINEAR_MCP_ENDPOINT, executeTool, issueInTeamGuard, linearBinder, linearConnector, reviewTools,
  GuardRejection, type Invocation, type Ledger, type LinearTeamScope,
} from "../../packages/gateway/src/index.js";
import { vendorTools } from "../support/vendor-fixtures.js";

const tools = vendorTools("linear");
/** The live get_issue result (2026-09-24), free text replaced: top-level teamId (UUID), team (name), id (identifier). */
const issueFixture = JSON.parse(readFileSync(new URL("../fixtures/vendors/linear-get-issue.json", import.meta.url), "utf8")) as Record<string, unknown>;
const CHARTERARC = "c408e946-78aa-4db8-923e-f78053dd954f";
const OTHER = "0b6f3f7e-5d1a-4c1e-9a53-2f0f5a8f1c11";
const scope: LinearTeamScope = { alias: "charterarc", teamId: CHARTERARC };
const bound = { team: CHARTERARC, teamId: CHARTERARC };

/** The live get_issue result with its team UUID set to `teamId`. */
const issueIn = (teamId: string): Record<string, unknown> => ({ ...structuredClone(issueFixture), teamId });
const text = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const context = (names: Array<[string, "read" | "write"]>) => ({
  workspaceId: "w", ownerKey: "o", scopeAlias: "charterarc", scope,
  policy: { tools: names.map(([name, access]) => ({ name, access })) },
});

describe("linear connector definition", () => {
  it("points at the Linear MCP endpoint and signs description, then body", () => {
    const definition = linearConnector({ issue: vi.fn() });
    expect(LINEAR_MCP_ENDPOINT.href).toBe("https://mcp.linear.app/mcp");
    expect(definition).toMatchObject({ label: "Linear", endpoint: LINEAR_MCP_ENDPOINT, attributionKeys: ["description", "body"], guards: [issueInTeamGuard], binder: linearBinder });
  });

  it("binds the scope's team id as both team and teamId, where a tool declares them", () => {
    expect(linearBinder).toMatchObject({ properties: [], optionalProperties: ["team", "teamId"] });
    expect(linearBinder.bind(scope, { token: "t", bindings: {} })).toEqual({ team: CHARTERARC, teamId: CHARTERARC });
  });

  it("removes team and teamId where a tool declares them and offers tools without either unchanged", () => {
    const reviewed = reviewTools({ tools }, { binder: linearBinder }, context([
      ["list_issues", "read"], ["list_issue_statuses", "read"], ["list_documents", "read"], ["get_issue", "read"], ["save_issue", "write"], ["save_comment", "write"], ["list_teams", "read"],
    ]));
    expect(reviewed.skipped).toEqual([]);
    const byName = Object.fromEntries(reviewed.tools.map((tool) => [tool.name, tool.inputSchema as { properties: Record<string, unknown>; required: string[] }]));
    expect(Object.keys(byName).sort()).toEqual(["get_issue", "list_documents", "list_issue_statuses", "list_issues", "list_teams", "save_comment", "save_issue"]);
    for (const schema of Object.values(byName)) {
      expect(schema.properties).not.toHaveProperty("team");
      expect(schema.properties).not.toHaveProperty("teamId");
    }
    expect(byName.list_issue_statuses!.required).toEqual([]);
    expect(Object.keys(byName.save_comment!.properties)).toContain("issueId");
    expect(byName.get_issue!.required).toEqual(["id"]);
  });
});

describe("issue-in-team guard", () => {
  const connection = (teamId: string | "error" | "garbage") => ({
    call: vi.fn(async () => teamId === "error" ? { isError: true, content: [{ type: "text", text: "Entity not found" }] }
      : teamId === "garbage" ? { content: [{ type: "text", text: "not json" }] } : text(issueIn(teamId))),
  });
  const check = (tool: string, args: Record<string, unknown>, conn: ReturnType<typeof connection>, target: unknown = scope) =>
    issueInTeamGuard.check({ tool, arguments: args, bound, scope: target, connection: conn } as never);

  it("asks for get_issue only for issue-addressed calls", () => {
    expect(issueInTeamGuard.requiredTools("save_issue", { id: "CHA-1" })).toEqual(["get_issue"]);
    expect(issueInTeamGuard.requiredTools("save_issue", { title: "new" })).toEqual([]);
    expect(issueInTeamGuard.requiredTools("save_comment", { issueId: "CHA-1", body: "x" })).toEqual(["get_issue"]);
    expect(issueInTeamGuard.requiredTools("list_comments", { issueId: "CHA-1" })).toEqual(["get_issue"]);
    expect(issueInTeamGuard.requiredTools("get_issue", { id: "CHA-1" })).toEqual(["get_issue"]);
    expect(issueInTeamGuard.requiredTools("list_issues", {})).toEqual([]);
  });

  it("allows an issue in the scope's team, comparing ids case-insensitively", async () => {
    const conn = connection(CHARTERARC.toUpperCase());
    await expect(check("save_issue", { id: "CHA-1", priority: 2 }, conn)).resolves.toBeUndefined();
    expect(conn.call).toHaveBeenCalledWith("get_issue", { id: "CHA-1" });
  });

  it("reads the team from the call's scope, on tools without a team property too, and fails closed without one", async () => {
    const conn = connection(CHARTERARC);
    await expect(check("save_comment", { issueId: "CHA-3", body: "x" }, conn)).resolves.toBeUndefined();
    await expect(check("get_issue", { id: "CHA-3" }, conn, undefined)).rejects.toThrow(new GuardRejection("The Linear team check could not run, so the request was not sent."));
    await expect(check("get_issue", { id: "CHA-3" }, conn, { alias: "charterarc" })).rejects.toBeInstanceOf(GuardRejection);
    expect(conn.call).toHaveBeenCalledTimes(1);
  });

  it("refuses an issue in another team, a missing issue and an unreadable answer", async () => {
    await expect(check("save_issue", { id: "OTH-9" }, connection(OTHER))).rejects.toThrow(new GuardRejection('Linear issue "OTH-9" is not in the charterarc team this connector may use.'));
    await expect(check("save_comment", { issueId: "OTH-9", body: "x" }, connection(OTHER))).rejects.toBeInstanceOf(GuardRejection);
    await expect(check("get_issue", { id: "OTH-9" }, connection(OTHER))).rejects.toBeInstanceOf(GuardRejection);
    await expect(check("save_issue", { id: "CHA-404" }, connection("error"))).rejects.toThrow(new GuardRejection('Linear issue "CHA-404" was not found or this connector cannot see it.'));
    await expect(check("save_issue", { id: "CHA-1" }, connection("garbage"))).rejects.toThrow(new GuardRejection('Could not confirm that Linear issue "CHA-1" is in the charterarc team, so the request was not sent.'));
    // Only the live field counts: a result with the team name but no teamId is refused.
    const nameOnly = { call: vi.fn(async () => text({ ...issueFixture, teamId: undefined, team: "CharterArc" })) };
    await expect(check("save_issue", { id: "CHA-1" }, nameOnly as never)).rejects.toThrow(new GuardRejection('Could not confirm that Linear issue "CHA-1" is in the charterarc team, so the request was not sent.'));
  });

  it("does not check a create, and refuses comment targets it cannot verify", async () => {
    const conn = connection(CHARTERARC);
    await expect(check("save_issue", { title: "new" }, conn)).resolves.toBeUndefined();
    for (const other of ["id", "parentId", "projectId", "initiativeId", "documentId", "milestoneId", "statusUpdateId", "statusUpdateType"]) {
      await expect(check("save_comment", { [other]: "x", body: "b" }, conn)).rejects.toThrow(new GuardRejection(`This Linear connector only works with comments on issues in the charterarc team, so ${other} is not allowed. Pass issueId.`));
    }
    await expect(check("list_comments", {}, conn)).rejects.toThrow(new GuardRejection("Pass issueId: this Linear connector only works with comments on issues in the charterarc team."));
    expect(conn.call).not.toHaveBeenCalled();
  });
});

describe("linear through the engine", () => {
  function memoryLedger(): Ledger & { records: Map<string, Invocation> } {
    const records = new Map<string, Invocation>();
    return {
      records,
      claim: async (record) => { if (records.has(record.requestId)) return false; records.set(record.requestId, record); return true; },
      get: async (id) => records.get(id),
      finish: async (record) => { records.set(record.requestId, record); },
    };
  }
  function fakeConnect(teamOf: Record<string, string>) {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const connect = vi.fn(async () => ({
      tools,
      call: vi.fn(async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        if (name === "get_issue") return teamOf[String(args.id)] ? text(issueIn(teamOf[String(args.id)]!)) : { isError: true, content: [] };
        return text({ ok: true });
      }),
      close: async () => undefined,
    }));
    return { connect, calls };
  }
  const definition = linearConnector({ issue: async () => ({ token: "lin_api_secret", bindings: {} }) });

  async function hashOf(name: string, connect: ReturnType<typeof fakeConnect>["connect"]) {
    const connection = await connect();
    return reviewTools(connection as never, definition, context([[name, "write"]])).tools[0]!.schemaHash;
  }

  it("creates with the team bound and the description signed", async () => {
    const { connect, calls } = fakeConnect({});
    const schemaHash = await hashOf("save_issue", connect);
    const result = await executeTool({ requestId: "11111111-1111-4111-8111-111111111111", scope: "charterarc", tool: "save_issue", schemaHash, arguments: { title: "Flaky login", description: "Steps" } },
      definition, context([["save_issue", "write"]]), { ledger: memoryLedger(), connect: connect as never, attribution: "Requested by `Slack member U1` via AgentX" });
    expect(result.status).toBe("SUCCEEDED");
    expect(calls).toEqual([{ name: "save_issue", args: { title: "Flaky login", description: "Steps\n\n—\nRequested by `Slack member U1` via AgentX", team: CHARTERARC } }]);
  });

  it("never sends the update when the issue is in another team", async () => {
    const { connect, calls } = fakeConnect({ "OTH-9": OTHER });
    const schemaHash = await hashOf("save_issue", connect);
    const result = await executeTool({ requestId: "22222222-2222-4222-8222-222222222222", scope: "charterarc", tool: "save_issue", schemaHash, arguments: { id: "OTH-9", priority: 1 } },
      definition, context([["save_issue", "write"]]), { ledger: memoryLedger(), connect: connect as never });
    expect(result).toMatchObject({ status: "FAILED", reason: "policy_denied" });
    expect(calls.map((call) => call.name)).toEqual(["get_issue"]);
  });

  it("comments without a team argument", async () => {
    const { connect, calls } = fakeConnect({ "CHA-1": CHARTERARC });
    const schemaHash = await hashOf("save_comment", connect);
    const result = await executeTool({ requestId: "33333333-3333-4333-8333-333333333333", scope: "charterarc", tool: "save_comment", schemaHash, arguments: { issueId: "CHA-1", body: "Deployed" } },
      definition, context([["save_comment", "write"]]), { ledger: memoryLedger(), connect: connect as never, attribution: "Requested by x" });
    expect(result.status).toBe("SUCCEEDED");
    expect(calls).toEqual([{ name: "get_issue", args: { id: "CHA-1" } }, { name: "save_comment", args: { issueId: "CHA-1", body: "Deployed\n\n—\nRequested by x" } }]);
  });

  it("refuses a model-supplied team before connecting", async () => {
    const { connect } = fakeConnect({});
    await expect(executeTool({ requestId: "44444444-4444-4444-8444-444444444444", scope: "charterarc", tool: "save_issue", schemaHash: "0".repeat(64), arguments: { title: "x", team: OTHER } },
      definition, context([["save_issue", "write"]]), { ledger: memoryLedger(), connect: connect as never })).rejects.toThrow("Linear routing arguments are server controlled");
    expect(connect).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `npm run build && npx vitest run tests/contract/gateway-linear.test.ts`
Expected: FAIL, because `linear.ts` does not exist. No gateway engine or types change is needed:
`optionalProperties` and `GuardInput.scope` come from 5b (R5).

- [ ] **Step 4: Implement `packages/gateway/src/linear.ts`**

```ts
import { GuardRejection, type Binder, type ConnectorDefinition, type CredentialProvider, type Guard } from "./types.js";
import { isObject, resultText } from "./util.js";

/** A Linear team a connector may address, by the alias the model sees and the team's UUID. */
export interface LinearTeamScope { alias: string; teamId: string }

export const LINEAR_MCP_ENDPOINT = new URL("https://mcp.linear.app/mcp");

/**
 * Linear names the team `team` (name or id) on some tools and `teamId` (id) on others. Both are
 * bound only on the tools that have them, always to the scope's team UUID. The guard reads the scope.
 */
export const linearBinder: Binder<LinearTeamScope> = {
  properties: [],
  optionalProperties: ["team", "teamId"],
  bind: (scope) => ({ team: scope.teamId, teamId: scope.teamId }),
};

/** The argument naming the issue each issue-addressed tool acts on. */
const ISSUE_ARGUMENT: Readonly<Record<string, string>> = { get_issue: "id", save_issue: "id", list_comments: "issueId", save_comment: "issueId" };
/** Comment targets whose team cannot be proven with a Linear tool. */
const UNVERIFIABLE_COMMENT_TARGETS = ["id", "parentId", "projectId", "initiativeId", "documentId", "milestoneId", "statusUpdateId", "statusUpdateType"] as const;
const NO_TEAM = "The Linear team check could not run, so the request was not sent.";

/** 5b passes the call's scope to every guard. Anything but a Linear team scope refuses the call. */
function scopeOf(scope: unknown): LinearTeamScope {
  if (!isObject(scope) || typeof scope.alias !== "string" || typeof scope.teamId !== "string" || scope.teamId === "") throw new GuardRejection(NO_TEAM);
  return { alias: scope.alias, teamId: scope.teamId };
}

/** The live get_issue result carries the team UUID as top-level `teamId` (`team` is the name). */
function teamIdOf(issue: unknown): string | undefined {
  return isObject(issue) && typeof issue.teamId === "string" ? issue.teamId : undefined;
}

/**
 * The API key may reach more teams than the project scopes. Before a call addresses an existing
 * issue, read it and refuse unless it belongs to the scope's team, so nothing is sent otherwise.
 */
export const issueInTeamGuard: Guard = {
  requiredTools(tool, args) {
    const key = ISSUE_ARGUMENT[tool];
    return key !== undefined && typeof args[key] === "string" ? ["get_issue"] : [];
  },
  async check({ tool, arguments: args, connection, scope }) {
    const key = ISSUE_ARGUMENT[tool];
    if (key === undefined) return;
    const team = scopeOf(scope);
    if (tool === "save_comment" || tool === "list_comments") {
      const other = UNVERIFIABLE_COMMENT_TARGETS.find((name) => args[name] !== undefined);
      if (other !== undefined) throw new GuardRejection(`This Linear connector only works with comments on issues in the ${team.alias} team, so ${other} is not allowed. Pass issueId.`);
      if (args.issueId === undefined) throw new GuardRejection(`Pass issueId: this Linear connector only works with comments on issues in the ${team.alias} team.`);
    }
    const id = args[key];
    if (id === undefined) return; // save_issue without id creates, and the binder sets its team.
    if (typeof id !== "string" || id.length === 0 || id.length > 128) throw new GuardRejection("Invalid Linear issue ID.");
    const shown = JSON.stringify(id.slice(0, 64));
    const result = await connection.call("get_issue", { id });
    if (result.isError) throw new GuardRejection(`Linear issue ${shown} was not found or this connector cannot see it.`);
    let issue: unknown;
    try { issue = JSON.parse(resultText(result)); } catch { issue = undefined; }
    const teamId = teamIdOf(issue);
    if (teamId === undefined) throw new GuardRejection(`Could not confirm that Linear issue ${shown} is in the ${team.alias} team, so the request was not sent.`);
    if (teamId.toLowerCase() !== team.teamId.toLowerCase()) throw new GuardRejection(`Linear issue ${shown} is not in the ${team.alias} team this connector may use.`);
  },
};

export function linearConnector(credentials: CredentialProvider<LinearTeamScope>): ConnectorDefinition<LinearTeamScope> {
  return {
    label: "Linear",
    endpoint: LINEAR_MCP_ENDPOINT,
    permissionsHint: "the Linear API key's permissions and team access",
    credentials,
    binder: linearBinder,
    guards: [issueInTeamGuard],
    attributionKeys: ["description", "body"],
  };
}
```

Add `export * from "./linear.js";` to `packages/gateway/src/index.ts`.

- [ ] **Step 5: Run the tests and watch them pass.** Run the Step 3 command. Expected: PASS.

- [ ] **Step 6: Full suite and commit**

Run: `npm run typecheck && npm run lint && npm run build && npm test`. Expected: all pass.

```bash
git add tests/fixtures/vendors packages/gateway/src/linear.ts packages/gateway/src/index.ts tests/contract/gateway-linear.test.ts
git commit -m "feat(gateway): linear connector with a team binder and an issue-in-team guard

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The `linear` connector type in the contracts and the broker (T032, part 2)

**Files:**
- Create: `packages/broker/src/aws/linear-connector-type.ts`, `tests/contract/linear-connector.test.ts`
- Modify: `packages/contracts/src/connectors.ts`, `packages/contracts/src/project.ts`,
  `packages/broker/src/aws/connector-types.ts`, `packages/broker/src/aws/credentials.ts`
- Test (deliberate assertion change): `tests/contract/connector-types.test.ts`, the line
  `expect(schemaTypes).toEqual(["github"]);` becomes `expect(schemaTypes).toEqual(["github", "linear"]);`
  (or `["github", "linear", "jira"]` if phase 6 landed first). It pins the accepted type list,
  which this task extends.

**Interfaces:**
- Consumes: Task 1 `linearConnector`, `LinearTeamScope`; 5a `ConnectorType`, `connectorLedgerKeys`;
  phase 3 `CredentialRegistry.provider`.
- Produces: `LinearConnectorSchema`, `LinearConnectorConfig`, `linearConnectorType`,
  `ResolvedConnector.credential`, `CredentialRegistry.typeOf`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/linear-connector.test.ts
import { describe, expect, it, vi } from "vitest";
import { ConnectorsSchema, ProjectDefinitionSchema, StoredProjectDefinitionSchema } from "../../packages/contracts/src/index.js";
import { BUILT_IN_CONNECTOR_TYPES, resolveConnectors } from "../../packages/broker/src/aws/connector-types.js";
import { CredentialRegistry } from "../../packages/broker/src/aws/credentials.js";
import { linearConnectorType } from "../../packages/broker/src/aws/linear-connector-type.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const CHARTERARC = "c408e946-78aa-4db8-923e-f78053dd954f";
const tools = [{ name: "list_issues", access: "read" }, { name: "save_issue", access: "write" }];
const linear = (overrides: Record<string, unknown> = {}) => ({ name: "linear", type: "linear", credentialRef: "linear-charterarc", scopes: [{ alias: "charterarc", teamId: CHARTERARC }], tools, ...overrides });
const project = (connectors: unknown[]) => ({
  name: "payments", revision: 1,
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
  setup: [], readiness: [], orchestratorInstructions: "x", integrations: { connectors },
});

function registry(records: Array<{ ref: string; type: string }> = []) {
  const db = new FakeDynamoDb();
  for (const record of records) db.set({ pk: "CREDENTIALS", sk: `REF#${record.ref}`, entityType: "CREDENTIAL", ref: record.ref, type: record.type, secretName: `agentx/connectors/${record.ref}`, registeredBy: "admin", registeredAt: "2026-09-24T00:00:00.000Z" });
  const secrets = { read: vi.fn(async () => JSON.stringify({ apiKey: "lin_api_value" })) };
  return new CredentialRegistry({ secrets, githubApp: { ref: "github-app", secretName: "agentx/github-app" }, documentClient: db as never, tableName: "state" });
}

describe("linear connector configuration", () => {
  it("accepts a linear connector beside github, and two linear connectors", () => {
    const github = { name: "github", type: "github", scopes: "all-repositories", tools };
    expect(ProjectDefinitionSchema.safeParse(project([github, linear()])).success).toBe(true);
    expect(ProjectDefinitionSchema.safeParse(project([linear(), linear({ name: "linear-two" })])).success).toBe(true);
  });

  it("refuses a missing credentialRef, a bad teamId, duplicate aliases or teams, an identity field and all-repositories", () => {
    const refused = (value: unknown) => ConnectorsSchema.safeParse([value]).success === false;
    expect(refused(linear({ credentialRef: undefined }))).toBe(true);
    expect(refused(linear({ scopes: [{ alias: "charterarc", teamId: "CharterArc" }] }))).toBe(true);
    expect(refused(linear({ scopes: [{ alias: "a", teamId: CHARTERARC }, { alias: "a", teamId: "0b6f3f7e-5d1a-4c1e-9a53-2f0f5a8f1c11" }] }))).toBe(true);
    expect(refused(linear({ scopes: [{ alias: "a", teamId: CHARTERARC }, { alias: "b", teamId: CHARTERARC.toUpperCase() }] }))).toBe(true);
    expect(refused(linear({ identity: "service" }))).toBe(true);
    expect(refused(linear({ scopes: "all-repositories" }))).toBe(true);
    expect(refused(linear({ scopes: [] }))).toBe(true);
  });

  it("validates a stored linear entry strictly instead of passing it through as an unknown type", () => {
    expect(StoredProjectDefinitionSchema.safeParse(project([linear()])).success).toBe(true);
    expect(StoredProjectDefinitionSchema.safeParse(project([linear({ extra: true })])).success).toBe(false);
  });
});

describe("linear connector type", () => {
  it("is built in and resolves label, vendor, scope noun, ledger and credential", () => {
    expect(BUILT_IN_CONNECTOR_TYPES.linear).toBe(linearConnectorType);
    const [connector] = resolveConnectors(ProjectDefinitionSchema.parse(project([linear({ scopes: [{ alias: "charterarc", teamId: CHARTERARC.toUpperCase() }] })])), { credentialRegistry: registry() });
    expect(connector).toMatchObject({
      name: "linear", type: "linear", label: "Linear issues", vendor: "Linear", scopeNoun: "team", attribution: true,
      ledger: { prefix: "CONNECTOR#linear#", entityType: "CONNECTOR_INVOCATION" },
      credential: { ref: "linear-charterarc", accepts: ["static-secret"] },
      scopes: [{ alias: "charterarc", scope: { alias: "charterarc", teamId: CHARTERARC } }],
    });
  });

  it("is not connected until a static-secret credential is registered, and never throws", async () => {
    const definition = ProjectDefinitionSchema.parse(project([linear()]));
    const none = resolveConnectors(definition, {})[0]!;
    expect(await none.configured()).toBe(false);
    expect(await none.definition()).toEqual({ notConnected: "connector credentials are not configured in this deployment" });

    const missing = resolveConnectors(definition, { credentialRegistry: registry() })[0]!;
    expect(await missing.definition()).toEqual({ notConnected: "credential linear-charterarc is not registered" });

    const oauth = resolveConnectors(definition, { credentialRegistry: registry([{ ref: "linear-charterarc", type: "oauth-client-credentials" }]) })[0]!;
    expect(await oauth.configured()).toBe(false);
    expect(await oauth.definition()).toEqual({ notConnected: "credential linear-charterarc is oauth-client-credentials; a Linear connector needs a static-secret API key" });

    const ready = resolveConnectors(definition, { credentialRegistry: registry([{ ref: "linear-charterarc", type: "static-secret" }]) })[0]!;
    expect(await ready.configured()).toBe(true);
    const resolved = await ready.definition();
    if ("notConnected" in resolved) throw new Error("expected a definition");
    expect(resolved.endpoint.href).toBe("https://mcp.linear.app/mcp");
    expect(await resolved.credentials.issue({ alias: "charterarc", teamId: CHARTERARC }, "read")).toEqual({ token: "lin_api_value", bindings: {} });
  });

  it("treats a malformed stored linear entry as unusable, with a log line naming the bad fields", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const stored = project([linear({ scopes: [{ alias: "charterarc" }] })]) as never;
      expect(resolveConnectors(stored, {})).toEqual([]);
      const lines = log.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>).filter((line) => line.event === "connector.unusable");
      expect(lines).toEqual([{ component: "broker", event: "connector.unusable", project: "payments", revision: 1, connector: "linear", type: "linear", reason: "invalid linear connector configuration: scopes" }]);
    } finally { log.mockRestore(); }
  });
});

describe("credential registry typeOf", () => {
  it("names the built-in GitHub App, a registered type, and nothing for an unknown or malformed ref", async () => {
    const credentials = registry([{ ref: "linear-charterarc", type: "static-secret" }]);
    expect(await credentials.typeOf("github-app")).toBe("github-app");
    expect(await credentials.typeOf("linear-charterarc")).toBe("static-secret");
    expect(await credentials.typeOf("missing")).toBeUndefined();
  });
});
```

Edit `tests/contract/connector-types.test.ts` as named above.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npm run build && npx vitest run tests/contract/linear-connector.test.ts tests/contract/connector-types.test.ts`
Expected: FAIL, because the module `linear-connector-type.js` is not found and the schema refuses `linear`.

- [ ] **Step 3: Implement**

`packages/contracts/src/connectors.ts`: move `ConnectorAliasSchema` above `GitHubConnectorSchema`
(it is used by the new schema), then add after `GitHubConnectorSchema`:

```ts
/** A Linear team UUID, in any case; resolvers lowercase it. */
const LinearTeamIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "teamId must be a Linear team UUID");

export const LinearScopeSchema = z.object({ alias: ConnectorAliasSchema, teamId: LinearTeamIdSchema }).strict();

/** Linear reads a static-secret API key through the credential registry; each scope is one team. */
export const LinearConnectorSchema = z.object({
  name: ConnectorNameSchema,
  type: z.literal("linear"),
  credentialRef: z.string().regex(AGENTX_NAME_PATTERN),
  scopes: z.array(LinearScopeSchema).min(1).max(32)
    .refine((scopes) => new Set(scopes.map((scope) => scope.alias)).size === scopes.length, "connector scope aliases must be unique")
    .refine((scopes) => new Set(scopes.map((scope) => scope.teamId.toLowerCase())).size === scopes.length, "connector scopes must name different teams"),
  tools: ToolApprovalListSchema,
  attribution: z.boolean().optional(),
}).strict();

export const ConnectorConfigSchema = z.discriminatedUnion("type", [GitHubConnectorSchema, LinearConnectorSchema]);
```

and `export type LinearConnectorConfig = z.infer<typeof LinearConnectorSchema>;`.

If phase 6 landed first, `ResolvedConnector.credential`, `CredentialRegistry.typeOf`, the
`githubConnectorOf` predicate and the Jira union option already exist. Keep them, add only the
Linear pieces, and keep the union order `[GitHubConnectorSchema, LinearConnectorSchema, JiraConnectorSchema]`
(see Coordination).

`packages/contracts/src/project.ts`: 5a's `checkProjectDefinition` already skips non-GitHub
entries in the repository-scope loop (`if (connector.type !== "github") continue;`); confirm it
still does and add nothing there. In `githubConnectorOf`,
make the find a type predicate so `connector.scopes` narrows to the GitHub shape:
`project.integrations?.connectors?.find((entry): entry is GitHubConnectorConfig => entry.type === "github")`
(import the type from `./connectors.js`). No behaviour change for GitHub. `KNOWN_CONNECTOR_TYPES`
is derived from `ConnectorConfigSchema.options`, so `linear` becomes a known type for
`StoredConnectorConfigSchema` without further edits: a stored `linear` entry now validates strictly
instead of passing through.

`packages/broker/src/aws/credentials.ts`, in `CredentialRegistry`:

```ts
  /** The provider type behind a reference: the built-in GitHub App, a valid stored record's type, or undefined. */
  async typeOf(ref: string): Promise<CredentialType | undefined> {
    if (ref === this.options.githubApp.ref) return "github-app";
    return (await this.readRecord(ref))?.type;
  }
```

`packages/broker/src/aws/connector-types.ts`: add to `ResolvedConnector`:

```ts
  /** The registry credential this connector reads and the provider types it accepts; absent for github. */
  credential?: { ref: string; accepts: readonly CredentialType[] };
```

and change the map to
`export const BUILT_IN_CONNECTOR_TYPES: Readonly<Record<string, ConnectorType>> = { github: githubConnectorType, linear: linearConnectorType };`
(import from `./linear-connector-type.js`; with phase 6 landed, `{ github, linear, jira }` in that order).

`packages/broker/src/aws/linear-connector-type.ts`:

```ts
import { LinearConnectorSchema, type CredentialType } from "@agentx/contracts";
import { linearConnector, type LinearTeamScope } from "@agentx/gateway";
import { connectorLedgerKeys } from "./connector-ledger.js";
import type { ConnectorType, ResolvedConnector } from "./connector-types.js";

const ACCEPTS: readonly CredentialType[] = ["static-secret"];
const NOT_CONFIGURED = "connector credentials are not configured in this deployment";

/** Linear: one scope per team, all read through one static-secret API key from the registry. */
export const linearConnectorType: ConnectorType = {
  type: "linear",
  resolve(config, _project, context) {
    // Stored data is validated here, not trusted: a malformed entry is unusable, never a throw.
    const parsed = LinearConnectorSchema.safeParse(config);
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((issue) => issue.path[0] === undefined ? "entry" : String(issue.path[0])))];
      return { unusable: `invalid linear connector configuration: ${fields.join(", ")}` };
    }
    const { name, credentialRef, scopes, tools, attribution } = parsed.data;
    const registry = context.credentialRegistry;
    const connector: ResolvedConnector<LinearTeamScope> = {
      name,
      type: "linear",
      label: "Linear issues",
      vendor: "Linear",
      scopeNoun: "team",
      scopes: scopes.map((scope) => ({ alias: scope.alias, scope: { alias: scope.alias, teamId: scope.teamId.toLowerCase() } })),
      policy: { tools },
      approvals: tools,
      attribution: attribution ?? true,
      ledger: connectorLedgerKeys(name),
      credential: { ref: credentialRef, accepts: ACCEPTS },
      ...(context.connect ? { connect: context.connect } : {}),
      configured: async () => (await registry?.typeOf(credentialRef)) === "static-secret",
      async definition() {
        if (!registry) return { notConnected: NOT_CONFIGURED };
        const type = await registry.typeOf(credentialRef);
        if (type === undefined) return { notConnected: `credential ${credentialRef} is not registered` };
        if (type !== "static-secret") return { notConnected: `credential ${credentialRef} is ${type}; a Linear connector needs a static-secret API key` };
        return linearConnector(registry.provider(credentialRef));
      },
    };
    return connector;
  },
};
```

Fix any type errors the union introduces elsewhere by narrowing on `type === "github"`, never by
casting, and without changing GitHub behaviour.

- [ ] **Step 4: Run the tests and watch them pass.** Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Full suite and commit**

Run: `npm run typecheck && npm run lint && npm run build && npm test`. Expected: all pass; the only
changed existing assertion is the one named above.

```bash
git add packages/contracts/src packages/broker/src/aws tests/contract/linear-connector.test.ts tests/contract/connector-types.test.ts
git commit -m "feat(broker): linear connector type backed by a static-secret credential

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Registration refuses a Linear connector whose credential is not usable (moved from phase 3)

**Files:**
- Modify: `packages/broker/src/aws/registration-preflight.ts`, `packages/broker/src/aws/broker.ts` (wiring)
- Test: `tests/contract/linear-connector.test.ts` (added describe block)

**Interfaces:**
- Consumes: Task 2 `ResolvedConnector.credential`, `CredentialRegistry.typeOf`; `createAdminBroker`, `adminCall`.
- Produces: `credentialRefusals(connectors, registry): Promise<string[]>`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/contract/linear-connector.test.ts`:

```ts
import { adminCall, createAdminBroker } from "../support/admin-broker.js";

const runtimeBinding = {
  runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/agentx_production_worker-YVirjlFgvk",
  endpointQualifier: "DEFAULT", deploymentMode: "instances-ebs",
  capacityProviderArn: "arn:aws:bedrock-agentcore:us-east-1:111122223333:capacity-provider/agentx_production_capacity_v3-VwkM93EABZ",
};
const secretsFor = (types: Record<string, unknown>) => ({ read: vi.fn(async (name: string) => types[name] === undefined ? undefined : JSON.stringify(types[name])) });

describe("registering a project with a linear connector", () => {
  const register = (handler: Parameters<typeof adminCall>[0], connectors: unknown[], revision = 1) =>
    adminCall(handler, { method: "POST", path: "/v1/admin/projects", body: { definition: { ...project(connectors), revision }, runtimeBinding } });

  it("refuses when the deployment has no credential registry", async () => {
    const { handler } = await createAdminBroker();
    const response = await register(handler, [linear()]);
    expect(response.status).toBe(400);
    expect(response.body.error).toEqual({ code: "CONFIG_INVALID", message: "connector linear: connector credentials are not configured in this deployment" });
  });

  it("refuses an unregistered reference, an OAuth credential and the built-in GitHub App, naming each", async () => {
    const { handler } = await createAdminBroker({ connectorCredentials: {
      secrets: secretsFor({ "agentx/connectors/linear-oauth": { clientId: "c", clientSecret: "s", scopes: ["read"] } }),
      githubApp: { ref: "github-app", secretName: "agentx/github-app" },
    } });
    expect((await adminCall(handler, { method: "POST", path: "/v1/admin/credentials", body: { ref: "linear-oauth", type: "oauth-client-credentials", secretName: "agentx/connectors/linear-oauth" } })).status).toBe(201);
    expect((await register(handler, [linear()])).body.error).toEqual({ code: "CONFIG_INVALID", message: "connector linear: credential linear-charterarc is not registered; run agentx admin credential register first" });
    expect((await register(handler, [linear({ credentialRef: "linear-oauth" })])).body.error).toEqual({ code: "CONFIG_INVALID", message: "connector linear: credential linear-oauth is oauth-client-credentials; a Linear connector needs static-secret" });
    expect((await register(handler, [linear({ credentialRef: "github-app" })])).body.error).toEqual({ code: "CONFIG_INVALID", message: "connector linear: credential github-app is github-app; a Linear connector needs static-secret" });
  });

  it("registers once the static-secret credential exists, without contacting Linear, and stays idempotent", async () => {
    const { handler, db } = await createAdminBroker({ connectorCredentials: {
      secrets: secretsFor({ "agentx/connectors/linear-charterarc": { apiKey: "lin_api_value" } }),
      githubApp: { ref: "github-app", secretName: "agentx/github-app" },
    } });
    expect((await adminCall(handler, { method: "POST", path: "/v1/admin/credentials", body: { ref: "linear-charterarc", type: "static-secret", secretName: "agentx/connectors/linear-charterarc" } })).status).toBe(201);
    expect((await register(handler, [linear()])).status).toBe(201);
    // The credential disappears; re-submitting the same registered revision still answers as a duplicate.
    for (const item of db.find((entry) => entry.pk === "CREDENTIALS")) db.delete(item.pk as string, item.sk as string);
    const again = await register(handler, [linear()]);
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
  });
});
```

Before writing the test, check the helper names: `FakeDynamoDb` must have `find` and `delete`
(`grep -n "delete\|find" tests/support/fake-dynamodb.ts`). If `delete` is named differently, use
that name. Check the duplicate status code with the existing idempotency test in
`registration-preflight.test.ts` and use the same one.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npm run build && npx vitest run tests/contract/linear-connector.test.ts`
Expected: FAIL: registrations answer 201 where a refusal is expected.

- [ ] **Step 3: Implement**

If phase 6 landed first, `credentialRefusals` and its `broker.ts` call already exist with this
exact code; keep them, and Step 1's tests pass once Task 2 sets `credential` on the Linear type.

`registration-preflight.ts`:

```ts
import type { CredentialRegistry } from "./credentials.js";

/**
 * A new revision is refused when a connector's credential cannot work in this deployment: no
 * registry, an unregistered reference, or a provider type the connector does not accept.
 * Only the reference and type are named, never a secret.
 */
export async function credentialRefusals(connectors: readonly ResolvedConnector[], registry: CredentialRegistry | undefined): Promise<string[]> {
  const refusals: string[] = [];
  for (const connector of connectors) {
    const credential = connector.credential;
    if (!credential) continue;
    if (!registry) { refusals.push(`connector ${connector.name}: connector credentials are not configured in this deployment`); continue; }
    const type = await registry.typeOf(credential.ref);
    if (type === undefined) refusals.push(`connector ${connector.name}: credential ${credential.ref} is not registered; run agentx admin credential register first`);
    else if (!credential.accepts.includes(type)) refusals.push(`connector ${connector.name}: credential ${credential.ref} is ${type}; a ${connector.vendor} connector needs ${credential.accepts.join(" or ")}`);
  }
  return refusals;
}
```

`broker.ts`, in `registerProject`, directly after the budget refusal line (new revisions only):

```ts
  const credentialProblems = await credentialRefusals(connectors(), dependencies.credentialRegistry);
  if (credentialProblems.length > 0) throw agentXError("CONFIG_INVALID", credentialProblems.join("; "));
```

- [ ] **Step 4: Run the tests and watch them pass.** Run the Step 2 command, then
`npx vitest run tests/contract/registration-preflight.test.ts tests/contract/slack-control-plane.test.ts`.
Expected: PASS, unchanged.

- [ ] **Step 5: Full suite and commit**

Run: `npm run typecheck && npm run lint && npm run build && npm test`.

```bash
git add packages/broker/src/aws/registration-preflight.ts packages/broker/src/aws/broker.ts tests/contract/linear-connector.test.ts
git commit -m "feat(broker): refuse a connector whose credential reference is missing or of the wrong type

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Linear through the broker routes against a fake Linear MCP server (T032, part 3)

**Files:**
- Create: `tests/support/fake-linear-mcp.ts`, `tests/support/linear-broker.ts`, `tests/integration/linear-mcp.test.ts`
- Reads: `tests/fixtures/vendors/linear-tools.json` (through `vendorTools`), `tests/fixtures/vendors/linear-get-issue.json`
- Modify (added case only): `tests/contract/tool-presentation.test.ts`, and its `.snap` gains one new key

**Interfaces:**
- Consumes: Tasks 1 to 3; `createBroker`, `call`, `ensureWorkspace`, `markReady`, `loadSlackBroker`,
  `orchestratorPrincipal` from `tests/support/slack-broker.ts`; `connectMcp` from `@agentx/gateway`.
- Produces: `startFakeLinearMcp` (returns `{ url, calls, headers, unauthorized, close }`),
  `CHARTERARC_TEAM_ID`, `OTHER_TEAM_ID`, `LINEAR_FIXTURE_TOOLS`, `linearViaFake(fake)`, and
  `setupLinearBroker({ preflight })` with `LINEAR_KEY`, `LINEAR_THREAD`, `LINEAR_MEMBER` for Task 5.

- [ ] **Step 1: Write the fake server**

```ts
// tests/support/fake-linear-mcp.ts
// A Streamable HTTP MCP server that answers like Linear's hosted server, from recorded fixtures:
// 5b's vendors/linear-tools.json (verbatim live tools/list entries, 2026-09-24, extended in phase 5)
// and vendors/linear-get-issue.json (the live get_issue result, free text replaced).
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { connectMcp } from "@agentx/gateway";
import type { ConnectorType } from "../../packages/broker/src/aws/connector-types.js";
import { linearConnectorType } from "../../packages/broker/src/aws/linear-connector-type.js";
import { vendorTools } from "./vendor-fixtures.js";

export const LINEAR_FIXTURE_TOOLS = vendorTools("linear");
const GET_ISSUE = JSON.parse(readFileSync(new URL("../fixtures/vendors/linear-get-issue.json", import.meta.url), "utf8")) as Record<string, unknown>;
export const CHARTERARC_TEAM_ID = "c408e946-78aa-4db8-923e-f78053dd954f";
export const OTHER_TEAM_ID = "0b6f3f7e-5d1a-4c1e-9a53-2f0f5a8f1c11";

export interface FakeLinearCall { name: string; arguments: Record<string, unknown> }

/** The live get_issue shape for `identifier`: `id` is the identifier, `teamId` the team UUID, `team` its name. */
function issueIn(identifier: string, teamId: string): Record<string, unknown> {
  return { ...structuredClone(GET_ISSUE), id: identifier, teamId, team: teamId === CHARTERARC_TEAM_ID ? "CharterArc" : "Other team" };
}

const text = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

function answer(name: string, args: Record<string, unknown>, issues: Readonly<Record<string, string>>): unknown {
  if (name === "get_issue") {
    const teamId = issues[String(args.id)];
    return teamId ? text(issueIn(String(args.id), teamId)) : { isError: true, content: [{ type: "text", text: "Entity not found: Issue" }] };
  }
  if (name === "list_issues") return text({ issues: [{ id: "CHA-1", title: "Flaky login test", status: "Todo" }] });
  if (name === "save_issue") return text({ id: args.id ?? "CHA-2", title: args.title ?? "Updated", url: "https://linear.app/example/issue/CHA-2" });
  if (name === "save_comment") return text({ id: "comment-1", issueId: args.issueId });
  return text({});
}

export async function startFakeLinearMcp(options: { issues?: Record<string, string> } = {}) {
  const issues = options.issues ?? { "CHA-1": CHARTERARC_TEAM_ID, "OTH-9": OTHER_TEAM_ID };
  const calls: FakeLinearCall[] = [];
  const headers: IncomingHttpHeaders[] = [];
  /** Set `value` to true to answer every later request with 401, as Linear does for a revoked key. */
  const unauthorized = { value: false };
  const server = createServer((request, response) => { void (async () => {
    headers.push(request.headers);
    if (unauthorized.value) { response.writeHead(401, { "www-authenticate": "Bearer" }).end(); return; }
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const message = JSON.parse(body) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    let result: unknown;
    if (message.method === "initialize") result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "linear-fixture", version: "1" } };
    else if (message.method === "tools/list") result = { tools: LINEAR_FIXTURE_TOOLS };
    else if (message.method === "tools/call") {
      const name = String(message.params?.name); const args = message.params?.arguments ?? {};
      calls.push({ name, arguments: args });
      result = answer(name, args, issues);
    } else {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  })().catch(() => { response.writeHead(500).end(); }); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake Linear server has no port");
  return {
    url: new URL(`http://127.0.0.1:${address.port}/mcp`),
    calls, headers, unauthorized,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

/** The production linear type, whose connection goes to the fake server; records the endpoint it asked for. */
export function linearViaFake(fake: { url: URL }): { type: ConnectorType; requested: URL[] } {
  const requested: URL[] = [];
  const connect = ((input: Parameters<typeof connectMcp>[0]) => { requested.push(input.endpoint); return connectMcp({ ...input, endpoint: fake.url }); }) as typeof connectMcp;
  return { requested, type: { type: "linear", resolve: (config, project, context) => linearConnectorType.resolve(config, project, { ...context, connect }) } };
}
```

Then write the shared broker setup, used by this task and Task 5:

```ts
// tests/support/linear-broker.ts
// A broker with the production linear type pointed at a fresh fake Linear MCP server, a registered
// static-secret credential, a project whose latest revision approves four Linear tools, the test
// channel bound, and a ready thread workspace.
import { expect, vi } from "vitest";
import { githubConnectorType } from "../../packages/broker/src/aws/connector-types.js";
import { CHARTERARC_TEAM_ID, linearViaFake, startFakeLinearMcp } from "./fake-linear-mcp.js";
import { call, createBroker, ensureWorkspace, markReady } from "./slack-broker.js";

export const LINEAR_TEAM = "T0BSHLLUGBD";
export const LINEAR_CHANNEL = "C0123456789";
export const LINEAR_THREAD_TS = "1695500000.000001";
export const LINEAR_THREAD = `${LINEAR_TEAM}/${LINEAR_CHANNEL}/${LINEAR_THREAD_TS}`;
export const LINEAR_MEMBER = "U0123456789";
export const LINEAR_KEY = "lin_api_fixture_key_0123456789abcdef";
const admin = { subject: "admin-subject", admin: true };
export const LINEAR_CONNECTOR = {
  name: "linear", type: "linear", credentialRef: "linear-charterarc",
  scopes: [{ alias: "charterarc", teamId: CHARTERARC_TEAM_ID }],
  tools: [{ name: "list_issues", access: "read" }, { name: "get_issue", access: "read" }, { name: "save_issue", access: "write" }, { name: "save_comment", access: "write" }],
};

export async function setupLinearBroker(options: { preflight: boolean }) {
  const fake = await startFakeLinearMcp();
  const { type, requested } = linearViaFake(fake);
  const secrets = { read: vi.fn(async (name: string) => name === "agentx/connectors/linear-charterarc" ? JSON.stringify({ apiKey: LINEAR_KEY }) : undefined) };
  const { db, handler } = createBroker({
    connectorTypes: { github: githubConnectorType, linear: type },
    connectorCredentials: { secrets, githubApp: { ref: "github-app", secretName: "agentx/connectors/github-app" } },
  });
  expect((await call(handler, { method: "POST", path: "/v1/admin/credentials", user: admin, body: { ref: "linear-charterarc", type: "static-secret", secretName: "agentx/connectors/linear-charterarc" } })).status).toBe(201);
  const registered = await call(handler, { method: "POST", path: "/v1/admin/projects", user: admin, body: {
    definition: {
      name: "payments", revision: 1,
      repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
      setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
      integrations: { connectors: [LINEAR_CONNECTOR] },
    },
    runtimeBinding: {
      runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/agentx_production_worker-YVirjlFgvk",
      endpointQualifier: "DEFAULT", deploymentMode: "instances-ebs",
      capacityProviderArn: "arn:aws:bedrock-agentcore:us-east-1:111122223333:capacity-provider/agentx_production_capacity_v3-VwkM93EABZ",
    },
    ...(options.preflight ? { preflight: true } : {}),
  } });
  expect(registered.status).toBe(201);
  expect((await call(handler, { method: "PUT", path: `/v1/admin/slack/bindings/${LINEAR_TEAM}/${LINEAR_CHANNEL}`, user: admin, body: { projectName: "payments" } })).status).toBe(200);
  const workspaceId = (await ensureWorkspace(handler, LINEAR_THREAD, LINEAR_MEMBER)).body.workspaceId as string;
  markReady(db, workspaceId);
  return { db, handler, fake, requested, registered, workspaceId, path: `/v1/service/workspaces/${workspaceId}/connectors/linear` };
}
```

- [ ] **Step 2: Write the failing integration test**

```ts
// tests/integration/linear-mcp.test.ts
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { ConnectorCatalogSchema, type ConnectorCatalog } from "../../packages/contracts/src/connectors.js";
import { CHARTERARC_TEAM_ID } from "../support/fake-linear-mcp.js";
import { LINEAR_KEY, LINEAR_THREAD, LINEAR_MEMBER, setupLinearBroker } from "../support/linear-broker.js";
import { call, loadSlackBroker, orchestratorPrincipal } from "../support/slack-broker.js";

const service = { principal: orchestratorPrincipal, thread: LINEAR_THREAD, slackUser: LINEAR_MEMBER };
const linearBroker = () => setupLinearBroker({ preflight: true });

beforeAll(async () => { await loadSlackBroker(); });
let log: MockInstance<typeof console.log>;
beforeEach(() => { log = vi.spyOn(console, "log").mockImplementation(() => undefined); });
afterEach(() => { log.mockRestore(); });

describe("Linear connector over Streamable HTTP", () => {
  it("preflights, discovers with the team removed, binds it, guards issues, signs writes and keeps the key secret", async () => {
    const { db, handler, fake, requested, registered, path } = await linearBroker();
    try {
      expect(registered.body.preflight).toEqual({ connectors: [{ name: "linear", status: "connected", offered: ["linear__list_issues", "linear__get_issue", "linear__save_issue", "linear__save_comment"], skipped: [] }] });

      const discovered = await call(handler, { method: "GET", path: `${path}/tools`, service });
      expect(discovered.status).toBe(200);
      const catalog = ConnectorCatalogSchema.parse(discovered.body.catalog) as ConnectorCatalog;
      const byName = Object.fromEntries(catalog.tools.map((tool) => [tool.name, tool]));
      for (const tool of catalog.tools) expect(JSON.stringify(tool.inputSchema)).not.toContain('"team"');
      expect(Object.keys((byName.linear__save_comment!.inputSchema as { properties: object }).properties)).toContain("issueId");
      expect(requested.every((url) => url.href === "https://mcp.linear.app/mcp")).toBe(true);
      expect(fake.headers.filter((entry) => entry.authorization !== undefined).every((entry) => entry.authorization === `Bearer ${LINEAR_KEY}`)).toBe(true);

      const invoke = (tool: string, args: Record<string, unknown>, requestId: string = randomUUID()) => call(handler, { method: "POST", path: `${path}/call`, service,
        body: { requestId, scope: "charterarc", tool, schemaHash: byName[`linear__${tool}`]!.scopes[0]!.schemaHash, arguments: args } });

      // A read binds the team.
      expect((await invoke("list_issues", { state: "started" })).body.result).toMatchObject({ status: "SUCCEEDED" });
      expect(fake.calls.at(-1)).toEqual({ name: "list_issues", arguments: { state: "started", team: CHARTERARC_TEAM_ID } });

      // A create binds the team and signs the description; a replay does not call Linear again.
      const createId = randomUUID();
      expect((await invoke("save_issue", { title: "Flaky login test", description: "Steps" }, createId)).body.result).toMatchObject({ status: "SUCCEEDED" });
      expect(fake.calls.at(-1)).toEqual({ name: "save_issue", arguments: {
        title: "Flaky login test", team: CHARTERARC_TEAM_ID,
        description: expect.stringMatching(/^Steps\n\n—\nRequested by `Slack member U0123456789` via AgentX · https:\/\/slack\.com\/archives\/C0123456789\/p1695500000000001$/) as unknown,
      } });
      const before = fake.calls.length;
      expect((await invoke("save_issue", { title: "Flaky login test", description: "Steps" }, createId)).body.result).toMatchObject({ replayed: true });
      expect(fake.calls.length).toBe(before);
      expect(db.find((item) => item.sk === `CONNECTOR#linear#${createId}`)).toEqual([expect.objectContaining({ entityType: "CONNECTOR_INVOCATION", connector: "linear" })]);

      // An update of an issue in the team is checked, then sent with the same team.
      await invoke("save_issue", { id: "CHA-1", priority: 2 });
      expect(fake.calls.slice(-2)).toEqual([{ name: "get_issue", arguments: { id: "CHA-1" } }, { name: "save_issue", arguments: { id: "CHA-1", priority: 2, team: CHARTERARC_TEAM_ID } }]);

      // An update of another team's issue is refused after the check; nothing is written.
      const outside = await invoke("save_issue", { id: "OTH-9", priority: 1 });
      expect(outside.body.result).toMatchObject({ status: "FAILED", reason: "policy_denied", text: 'Linear issue "OTH-9" is not in the charterarc team this connector may use.' });
      expect(fake.calls.at(-1)).toEqual({ name: "get_issue", arguments: { id: "OTH-9" } });

      // A comment is checked, signed, and carries neither team nor teamId.
      await invoke("save_comment", { issueId: "CHA-1", body: "Deployed" });
      const comment = fake.calls.at(-1)!;
      expect(comment.name).toBe("save_comment");
      expect(comment.arguments).not.toHaveProperty("team");
      expect(comment.arguments).not.toHaveProperty("teamId");
      expect(String(comment.arguments.body)).toMatch(/^Deployed\n\n—\nRequested by /);

      // A reply cannot be verified and is refused without any call.
      const callsBeforeReply = fake.calls.length;
      expect((await invoke("save_comment", { parentId: "comment-1", body: "Thanks" })).body.result).toMatchObject({ status: "FAILED", reason: "policy_denied" });
      expect(fake.calls.length).toBe(callsBeforeReply);

      // A model-supplied team is refused before Linear is contacted.
      const callsBeforeTeam = fake.calls.length;
      const forged = await invoke("list_issues", { team: "Other" });
      expect(forged.status).toBe(403);
      expect(forged.body.error).toEqual({ code: "FORBIDDEN", message: "Linear routing arguments are server controlled" });
      expect(fake.calls.length).toBe(callsBeforeTeam);

      // The key appears nowhere AgentX writes.
      const everything = JSON.stringify([log.mock.calls, db.find(() => true), discovered.body, registered.body]);
      expect(everything).not.toContain(LINEAR_KEY);
    } finally { await fake.close(); }
  });

  it("reports not connected when Linear rejects the key twice, without the key in the log", async () => {
    const { handler, fake, path } = await linearBroker();
    try {
      // Registration's preflight is uncached, so this is the thread's first discovery.
      fake.unauthorized.value = true;
      const discovered = await call(handler, { method: "GET", path: `${path}/tools`, service });
      expect(discovered.status).toBe(200);
      expect(discovered.body.catalog).toEqual({ connector: "linear", notConnected: true, tools: [], skipped: [] });
      const line = log.mock.calls.map(([entry]) => String(entry)).find((entry) => entry.includes("connector.not_connected"));
      expect(line).toContain("Linear rejected the credential twice; check the Linear API key's permissions and team access");
      expect(line).not.toContain(LINEAR_KEY);
    } finally { await fake.close(); }
  });
});
```

- [ ] **Step 3: Add the tier-1 presentation case**

Append inside the `describe` of `tests/contract/tool-presentation.test.ts`:

```ts
  it("for a one-team project with Linear issues", async () => {
    const { linearBinder, reviewTools } = await import("../../packages/gateway/src/index.js");
    const { vendorTools } = await import("../support/vendor-fixtures.js");
    const tools = vendorTools("linear");
    const approvals = [{ name: "list_issues", access: "read" as const }, { name: "get_issue", access: "read" as const }, { name: "save_issue", access: "write" as const }, { name: "save_comment", access: "write" as const }];
    const reviewed = reviewTools({ tools }, { binder: linearBinder }, {
      workspaceId: "w", ownerKey: "o", scopeAlias: "charterarc", scope: { alias: "charterarc", teamId: "c408e946-78aa-4db8-923e-f78053dd954f" }, policy: { tools: approvals },
    });
    const presented = presentCatalog({ connector: "linear", label: "Linear", scopeNoun: "team", approvals, scopes: [{ alias: "charterarc", tools: reviewed.tools }] });
    const catalog: ConnectorCatalog = { connector: "linear", tools: presented.tools, skipped: presented.skipped };
    const manifest = capabilitiesManifest({
      repositories: ["api"],
      connectors: [{ name: "linear", type: "linear", label: "Linear issues", scopes: ["charterarc"], connected: true }],
      catalogs: [catalog],
    });
    expect({ tools: presented.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })), skipped: presented.skipped }).toMatchSnapshot();
    expect(orchestratorSystemPrompt("Delegate every repository read, edit, build and test to the worker.", manifest)).toMatchSnapshot();
    expect(presented.tools.every((tool) => tool.description.length <= 2_048 && /^[a-zA-Z0-9_-]{1,64}$/.test(tool.name))).toBe(true);
  });
```

- [ ] **Step 4: Run the tests and watch the integration test fail, then pass**

Run: `npm run build && npx vitest run tests/integration/linear-mcp.test.ts tests/contract/tool-presentation.test.ts`
Expected before Tasks 1 to 3 are complete: FAIL. On this branch after them, fix only test-harness
mistakes, then expect PASS. Do not run with `-u`. Confirm `git diff tests/contract/__snapshots__`
only adds the two `for a one-team project with Linear issues` keys, and read them: `team` must not
appear in any schema, and the manifest must list `- Linear issues (charterarc): linear__* tools`.

- [ ] **Step 5: Full suite and commit**

Run: `npm run typecheck && npm run lint && npm run build && npm test`.

```bash
git add tests/support/fake-linear-mcp.ts tests/support/linear-broker.ts tests/integration/linear-mcp.test.ts tests/contract/tool-presentation.test.ts tests/contract/__snapshots__/tool-presentation.test.ts.snap
git commit -m "test(broker): linear discovery, binding, guard, attribution and ledger against a fake Linear MCP server

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: A hosted Slack turn reaches Linear through the broker

**Files:**
- Create: `tests/support/broker-fetch.ts`, `tests/integration/hosted-slack-linear.test.ts`

**Interfaces:**
- Consumes: Task 4 `setupLinearBroker`, `LINEAR_*` constants, `CHARTERARC_TEAM_ID`; the processor,
  runtime and signing modules used by `tests/integration/hosted-slack-mcp.test.ts`.
- Produces: `brokerFetch(handler, principal?)`.

- [ ] **Step 1: Write the bridge**

```ts
// tests/support/broker-fetch.ts
import { randomUUID } from "node:crypto";
import { orchestratorPrincipal, type Handler } from "./slack-broker.js";

/**
 * A fetch that hands a Slack service request to the broker handler as API Gateway would after IAM
 * authorization: the signed Authorization header is replaced by the authorizer's principal.
 */
export function brokerFetch(handler: Handler, principal = orchestratorPrincipal): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    const forwarded: Record<string, string> = {};
    for (const name of ["x-agentx-slack-thread", "x-agentx-slack-user", "x-agentx-slack-user-name"]) {
      const value = headers.get(name);
      if (value !== null) forwarded[name] = value;
    }
    const response = await handler({
      version: "2.0", rawPath: url.pathname, rawQueryString: url.search.slice(1), headers: forwarded,
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
      requestContext: { requestId: randomUUID(), http: { method: init?.method ?? "GET" }, authorizer: { iam: { userArn: principal } } },
    });
    return new Response(response.body, { status: response.statusCode, headers: { "content-type": "application/json" } });
  };
}
```

Check the Slack header names the broker reads (`grep -n "x-agentx-slack" packages/broker/src/aws/*.ts`)
and forward exactly those.

- [ ] **Step 2: Write the failing test**

Model it on `tests/integration/hosted-slack-mcp.test.ts`, with these differences:

```ts
// tests/integration/hosted-slack-linear.test.ts
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { SlackThreadWorkspaceResultSchema, type SlackRequestMessage } from "../../packages/contracts/src/slack.js";
import { ControlPlaneApi } from "../../packages/orchestrator/src/control-plane-api.js";
import { processSlackRequest, type ProcessorDependencies } from "../../packages/slack-service/src/processor.js";
import { createHostedSlackRuntime } from "../../packages/slack-service/src/runtime.js";
import { createSignedServiceFetch } from "../../packages/slack-service/src/signing-fetch.js";
import { createFixtureDirectory } from "../fixtures/index.js";
import { brokerFetch } from "../support/broker-fetch.js";
import { CHARTERARC_TEAM_ID } from "../support/fake-linear-mcp.js";
import { LINEAR_CHANNEL, LINEAR_MEMBER, LINEAR_TEAM, LINEAR_THREAD, LINEAR_THREAD_TS, setupLinearBroker } from "../support/linear-broker.js";
import { call, loadSlackBroker, orchestratorPrincipal } from "../support/slack-broker.js";

beforeAll(async () => { await loadSlackBroker(); });

describe("hosted Slack turn with Linear", () => {
  it("offers the Linear tools, lists the team's issues and creates one signed issue for a redelivered event", async () => {
    const message: SlackRequestMessage = {
      version: 1, eventId: "EvLIN000001", receivedAt: new Date().toISOString(), userId: LINEAR_MEMBER,
      thread: { teamId: LINEAR_TEAM, channelId: LINEAR_CHANNEL, threadTs: LINEAR_THREAD_TS },
      text: "Create a Linear issue for the flaky login test.",
    };
    const { handler, fake, workspaceId } = await setupLinearBroker({ preflight: false });
    try {
      // The same thread asks again, as the new Slack service does, to learn its connectors.
      const workspace = await call(handler, { method: "POST", path: "/v1/service/threads/workspace",
        service: { principal: orchestratorPrincipal, thread: LINEAR_THREAD, slackUser: LINEAR_MEMBER },
        body: { requestId: randomUUID(), includeConnectors: true, includeAllConnectorTypes: true, includeSettingsRevision: true } });
      const resolved = SlackThreadWorkspaceResultSchema.parse(workspace.body);
      expect((resolved as { workspaceId: string }).workspaceId).toBe(workspaceId);
      expect((resolved as { connectors: unknown[] }).connectors).toEqual([{ name: "linear", type: "linear", label: "Linear issues", scopes: ["charterarc"], connected: true }]);

      const signedFetch = createSignedServiceFetch({ region: "us-east-1", credentials: { accessKeyId: "test-key", secretAccessKey: "test-secret" },
        thread: message.thread, userId: message.userId, baseFetch: brokerFetch(handler) });
      const api = new ControlPlaneApi("https://agentx.example.test", "slack-service", workspaceId, signedFetch);
      const post = vi.fn(async () => undefined);
      let turn = 0;
      const dependencies: ProcessorDependencies = {
        api: () => ({ ensureWorkspace: async () => ({ ...(resolved as object), status: "READY" }) as never, createConversation: async () => randomUUID(), waitForOperation: vi.fn() }),
        threads: { load: async () => ({ workspaceId, conversationId: "11111111-1111-4111-8111-111111111111" }), saveConversation: vi.fn(), finish: vi.fn() },
        runTurn: async (input) => {
          const runtime = await createHostedSlackRuntime(input, { stateDirectory: await createFixtureDirectory("agentx-slack-linear-"), api, model: { provider: "amazon-bedrock", modelId: "amazon.nova-pro-v1:0" } });
          try {
            expect(runtime.session.getActiveToolNames()).toEqual(expect.arrayContaining(["linear__list_issues", "linear__get_issue", "linear__save_issue", "linear__save_comment"]));
            const list = runtime.session.getToolDefinition("linear__list_issues")!;
            expect(JSON.stringify(list.parameters)).not.toContain('"team"');
            await list.execute(`list-${turn}`, { state: "started" }, undefined, undefined, {} as never);
            const create = runtime.session.getToolDefinition("linear__save_issue")!;
            const callId = `create-${turn++}`;
            await create.execute(callId, { title: "Flaky login test", description: "Fails one run in five." }, undefined, undefined, {} as never);
            await create.execute(callId, { title: "Flaky login test", description: "Fails one run in five." }, undefined, undefined, {} as never);
            return "Created the Linear issue.";
          } finally { await runtime.dispose(); }
        },
        post,
      };
      await processSlackRequest(message, dependencies, { finalAttempt: false });
      await processSlackRequest(message, dependencies, { finalAttempt: false });

      const creates = fake.calls.filter((entry) => entry.name === "save_issue");
      expect(creates).toHaveLength(1);
      expect(creates[0]!.arguments).toMatchObject({ title: "Flaky login test", team: CHARTERARC_TEAM_ID });
      expect(String(creates[0]!.arguments.description)).toMatch(/^Fails one run in five\.\n\n—\nRequested by .+ via AgentX · https:\/\/slack\.com\/archives\/C0123456789\/p1695500000000001$/);
      expect(fake.calls.filter((entry) => entry.name === "list_issues").every((entry) => entry.arguments.team === CHARTERARC_TEAM_ID)).toBe(true);
      expect(post).toHaveBeenLastCalledWith(message.thread, "Created the Linear issue.");
    } finally { await fake.close(); }
  });
});
```

Check the real shapes of `SlackThreadWorkspaceResultSchema` and `ProcessorDependencies.api` before
writing the casts, and drop any cast the real types make unnecessary.

- [ ] **Step 3: Run the test and watch it fail, then pass**

Run: `npm run build && npx vitest run tests/integration/hosted-slack-linear.test.ts`
Expected: FAIL at first on harness details; fix only the test code until it passes. If it fails
because product code misbehaves, stop and use superpowers:systematic-debugging; do not weaken an
assertion.

- [ ] **Step 4: Full suite and commit**

Run: `npm run typecheck && npm run lint && npm run build && npm test`.

```bash
git add tests/support/broker-fetch.ts tests/integration/hosted-slack-linear.test.ts
git commit -m "test(slack-service): a hosted turn lists and creates Linear issues through the broker

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Setup guide, evaluation cases and document amendments (T033)

**Files:**
- Create: `docs/connectors/linear.md`, `tests/eval/cases/linear.jsonl`,
  `tests/eval/fixtures/linear-payments.yaml`, `tests/eval/fixtures/linear-absent.yaml`,
  `tests/contract/linear-eval-cases.test.ts`, `specs/013-connector-gateway/plans/phase-5-linear.md`
  (a copy of this plan)
- Modify: `README.md` (Connector credentials), `specs/013-connector-gateway/spec.md`,
  `contracts/project-config.md`, `research.md`, `plan.md`, `tasks.md`

- [ ] **Step 1: Write the failing evaluation-case test**

```ts
// tests/contract/linear-eval-cases.test.ts
// Phase 4 owns the runner (npm run eval). Until it lands, this checks the Linear cases are well
// formed against contracts/evaluation.md and name tools their project would present.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { z } from "zod";
import { ProjectDefinitionSchema } from "../../packages/contracts/src/index.js";
import { ORCHESTRATION_TOOL_NAMES } from "../../packages/orchestrator/src/orchestration-tools.js";

const CaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,64}$/),
  project: z.string().regex(/^fixtures\/[a-z0-9-]+\.yaml$/),
  prompt: z.string().min(1).max(2_000),
  expect: z.object({ tool: z.string().nullable(), argsSubset: z.record(z.string(), z.unknown()).optional(), refusal: z.string().optional() }).strict(),
}).strict();

const root = new URL("../eval/", import.meta.url);
const cases = readFileSync(new URL("cases/linear.jsonl", root), "utf8").split("\n").filter((line) => line.trim()).map((line) => CaseSchema.parse(JSON.parse(line)));

describe("Linear evaluation cases", () => {
  it("has unique ids and at least one read, write, comment, not-connected and cross-vendor case", () => {
    expect(new Set(cases.map((entry) => entry.id)).size).toBe(cases.length);
    for (const tool of ["linear__list_issues", "linear__save_issue", "linear__save_comment", "linear__get_issue", "github__list_issues", "agentx_submit_task", null]) {
      expect(cases.some((entry) => entry.expect.tool === tool)).toBe(true);
    }
  });

  it.each(cases.map((entry) => [entry.id, entry] as const))("%s names a parsing project and a tool it presents", (_id, entry) => {
    const file = new URL(entry.project, root);
    expect(existsSync(file)).toBe(true);
    const project = ProjectDefinitionSchema.parse(YAML.parse(readFileSync(file, "utf8")));
    const presented = new Set<string>([...ORCHESTRATION_TOOL_NAMES, ...(project.integrations?.connectors ?? []).flatMap((connector) => connector.tools.map((tool) => `${connector.name}__${tool.name}`))]);
    if (entry.expect.tool === null) expect(entry.expect.refusal).toBeDefined();
    else expect(presented.has(entry.expect.tool)).toBe(true);
  });
});
```

Run: `npx vitest run tests/contract/linear-eval-cases.test.ts`. Expected: FAIL (no cases file).

- [ ] **Step 2: Write the cases and fixture projects**

`tests/eval/fixtures/linear-payments.yaml`:

```yaml
name: payments
revision: 1
repositories:
  - name: payments-api
    url: https://github.com/example/payments-api.git
    path: repo/payments-api
    defaultBranch: main
    credentialRef: github-agentx-sdlc
setup: []
readiness: []
orchestratorInstructions: Delegate every repository read, edit, build and test to the worker.
integrations:
  connectors:
    - name: github
      type: github
      scopes: all-repositories
      tools:
        - { name: list_issues, access: read }
    - name: linear
      type: linear
      credentialRef: linear-payments
      scopes:
        - { alias: payments, teamId: "00000000-0000-4000-8000-000000000000" }
      tools:
        - { name: list_issues, access: read }
        - { name: get_issue, access: read }
        - { name: save_issue, access: write }
        - { name: save_comment, access: write, allowedArguments: [issueId, body] }
```

`tests/eval/fixtures/linear-absent.yaml`: the same file without the `linear` entry.

`tests/eval/cases/linear.jsonl` (one JSON object per line):

```json
{"id":"linear-open-issues","project":"fixtures/linear-payments.yaml","prompt":"what's open for payments in Linear?","expect":{"tool":"linear__list_issues"}}
{"id":"linear-create-issue","project":"fixtures/linear-payments.yaml","prompt":"create a Linear issue for the flaky login test","expect":{"tool":"linear__save_issue"}}
{"id":"linear-update-issue","project":"fixtures/linear-payments.yaml","prompt":"set PAY-12 in Linear to high priority","expect":{"tool":"linear__save_issue","argsSubset":{"id":"PAY-12","priority":2}}}
{"id":"linear-comment","project":"fixtures/linear-payments.yaml","prompt":"comment on PAY-12 in Linear that the fix is deployed","expect":{"tool":"linear__save_comment","argsSubset":{"issueId":"PAY-12"}}}
{"id":"linear-read-issue","project":"fixtures/linear-payments.yaml","prompt":"show me Linear issue PAY-7","expect":{"tool":"linear__get_issue","argsSubset":{"id":"PAY-7"}}}
{"id":"github-not-linear","project":"fixtures/linear-payments.yaml","prompt":"list the open GitHub issues in payments-api","expect":{"tool":"github__list_issues"}}
{"id":"files-not-linear","project":"fixtures/linear-payments.yaml","prompt":"list the top-level files in the payments-api repository","expect":{"tool":"agentx_submit_task"}}
{"id":"linear-not-connected","project":"fixtures/linear-absent.yaml","prompt":"what's open in Linear?","expect":{"tool":null,"refusal":"not connected"}}
```

Run the Step 1 command. Expected: PASS. If phase 4 has landed with its own case loader, replace
`CaseSchema` with that loader and keep the two tests' checks.

- [ ] **Step 3: Write the setup guide `docs/connectors/linear.md`**

Write this content (plain sentences, no em-dashes):

````markdown
# Connect Linear

This guide connects one AgentX project to Linear. It is written for the administrator of your own
AgentX deployment. You create the Linear credential in your own Linear workspace.

## How access works

AgentX calls Linear's hosted MCP server, `https://mcp.linear.app/mcp`, with a Linear API key.
The key acts as the Linear user who created it. Every issue or comment AgentX writes shows that
user as the author, and ends with a footer naming the Slack member who asked and linking the
thread.

Two limits apply, and you set the first one in Linear:

1. **The key.** You restrict the API key to the teams AgentX may use. This is mandatory. It is
   the real boundary: AgentX can never reach more than the key can.
2. **The project.** The project file names one or more teams and the tools members may use.
   AgentX sets the team on every tool that takes one, and refuses a model that tries to choose
   another. Before it reads, updates or comments on an existing issue, it checks that the issue is
   in the project's team.

Tools that take no team, such as `list_teams`, `list_users` or `get_workspace`, reach everything
the key reaches. Approve them only if that is acceptable. Never approve `delete_*` tools.

Linear's OAuth client-credentials tokens are not supported. They reach every public team and
cannot be limited to one.

## Before you start

- You need a Linear account that can create API keys. Admins always can. Members can only if
  **Settings > Administration > API > Member API keys** allows it.
- Consider a dedicated Linear user for AgentX, so writes are not shown as a person's. It uses a
  seat.
- You need the AgentX administration client (`agentx`) logged in, and AWS credentials that can
  create secrets in the deployment's account and region.
- `jq` must be installed.

## 1. Create the API key

1. In Linear, open **Settings > Account > Security & Access**.
2. Under **Personal API keys**, choose **New API key**. Name it after the project, for example
   `AgentX payments`.
3. Permissions: grant **Read**. To let AgentX create issues and comments, also grant
   **Create issues** and **Create comments**. To let it update existing issues (`save_issue` with
   an `id`), grant **Write** instead of those two.
4. Team access: choose **only the teams this project may use**. Do not leave it on all teams.
5. Create the key and copy it. Linear shows it once.

## 2. Check the key and find the team ID

With the key still on your clipboard, run:

```sh
pbpaste | sed 's/^/Authorization: /' | curl -s https://api.linear.app/graphql \
  -H @- -H 'content-type: application/json' \
  -d '{"query":"{ teams { nodes { id key name } } }"}' | jq '.data.teams.nodes'
```

The list must show only the teams you selected. If it shows more, fix the key's team access
before you continue. Note the `id` of each team the project will use. It looks like
`c408e946-78aa-4db8-923e-f78053dd954f`.

On Linux, replace `pbpaste` with `xclip -o -selection clipboard`.

## 3. Store the key in AWS Secrets Manager

The secret name must start with `agentx/connectors/`. Store the key straight from the clipboard,
so it never appears in your shell history or a terminal prompt:

```sh
export AWS_PROFILE=<your deployer profile> AWS_REGION=<your region>
pbpaste | tr -d '\n' | jq -Rc '{apiKey: .}' | aws secretsmanager create-secret \
  --name agentx/connectors/linear-payments --secret-string file:///dev/stdin
pbcopy < /dev/null
```

Use the default `aws/secretsmanager` key. If you use a customer-managed KMS key, grant the broker
role `kms:Decrypt` on it.

If you also keep a copy in the macOS Keychain, pass the value in the command:

```sh
security add-generic-password -a "$USER" -s agentx-linear-payments -w "$(pbpaste)"
security find-generic-password -s agentx-linear-payments -w | tr -d '\n' | wc -c
```

Never use `-w` without a value. Its interactive prompt cuts secrets at 128 characters, and the
cut is silent. The second command prints the stored length so you can compare it with the key's.

To rotate the key later, run `aws secretsmanager put-secret-value` with the new key the same way,
then register the credential again (step 4) so AgentX drops the old one at once.

## 4. Register the credential

```sh
agentx admin credential register --ref linear-payments \
  --type static-secret --secret agentx/connectors/linear-payments
agentx admin credential list
```

`list` shows `linear-payments` with type `static-secret`. It never prints the key.

## 5. Add Linear to the project file

Add a connector to `integrations.connectors`, with one scope per team:

```yaml
integrations:
  connectors:
    - name: linear
      type: linear
      credentialRef: linear-payments
      scopes:
        - { alias: payments, teamId: "c408e946-78aa-4db8-923e-f78053dd954f" }
      tools:
        - name: list_issues
          access: read
          description: >-
            List Linear issues in the payments team, filtered by state, assignee or text.
            Use for "what's open". Not for GitHub issues or repository files.
        - name: get_issue
          access: read
        - name: save_issue
          access: write
          allowedArguments: [id, title, description, state, assignee, priority, addLabels, removeLabels, dueDate]
        - name: save_comment
          access: write
          allowedArguments: [issueId, body]
```

- `name` becomes the tool prefix (`linear__list_issues`). Use a second name, such as
  `linear-ops`, for a second Linear workspace.
- With several scopes, members pick a team by its alias.
- `allowedArguments` keeps the model to the fields you list. The two above are the recommended
  minimum for writes.
- Leave `attribution` unset to keep the footer.

## 6. Register the project revision

Raise `revision`, then run:

```sh
agentx admin project register --file payments.yaml \
  --runtime-arn <runtime ARN> --deployment-mode <mode>
```

A working setup prints the revision with a `preflight` entry like this, and no warnings:

```json
{ "name": "linear", "status": "connected",
  "offered": ["linear__list_issues", "linear__get_issue", "linear__save_issue", "linear__save_comment"],
  "skipped": [] }
```

What the other results mean:

| Output | Meaning and fix |
|---|---|
| Refused: `credential linear-payments is not registered` | Run step 4 first. |
| Refused: `credential linear-payments is oauth-client-credentials` | Register a `static-secret` API key instead. |
| Refused: `connector credentials are not configured in this deployment` | The control plane was deployed without connector credentials. Redeploy with them. |
| `Warning: connector linear: Linear is not connected: Linear rejected the credential twice` | The key is wrong, revoked or lacks permissions. Check steps 1 to 3. |
| `Warning: connector linear: tool X skipped: not offered by the vendor` | The tool name is wrong or Linear renamed it. Check the name. |
| `Warning: connector linear: tool X skipped: requires arguments outside allowedArguments` | Add the named arguments to `allowedArguments`. |

## 7. Try it in Slack

In a thread in the project's channel, ask "what's open for payments in Linear?", then "create a
Linear issue for the flaky login test". The new issue is in the payments team and ends with the
AgentX footer. Asking to change an issue in another team gets a plain refusal, and nothing is
changed.
````

- [ ] **Step 4: Amend the documents**

- `README.md`, "Connector credentials": replace the `linear-payments` example with the
  static-secret commands from the guide's steps 3 and 4. Replace "No connector type reads a
  registered credential yet; Linear is the first, in a later release." with "Linear reads a
  registered `static-secret` API key; see [docs/connectors/linear.md](docs/connectors/linear.md).
  Registering a revision refuses a connector whose `credentialRef` is not registered or has a type
  the connector does not accept." If phase 6 landed first and already rewrote that sentence for
  Jira, amend it to name both types and link both guides (see Coordination).
- `spec.md`, User Story 2, scenario 2 becomes: "**Given** a static-secret Linear API key restricted
  to the team, **When** the first call needs a credential, **Then** the gateway reads it from
  Secrets Manager, sends it only as the Bearer header, and never logs or returns it." The edge case
  "A Linear client-credentials token is revoked..." becomes "An OAuth client-credentials token is
  revoked because another process requested different scopes; ...". Add a Decision: "**Linear uses
  a team-restricted API key, not client credentials.** Linear's client-credentials tokens act as
  the application with access to all public teams and cannot meet the mandatory vendor-side
  restriction. Decided 2026-09-24."
- `contracts/project-config.md`: in the example, `create_issue` becomes `save_issue`; the
  credential registration example uses `--type static-secret` and the secret
  `{"apiKey":"…"}`; the `linear` row of "Mandatory vendor-side restrictions" becomes "API key with
  team access limited to the intended teams and the smallest permission set; client-credentials
  tokens are refused because they reach all public teams".
- `research.md`: under the Linear row, add "Checked 2026-09-24: client-credentials tokens are app
  actor tokens with access to all public teams; AgentX uses a team-restricted API key."
- `plan.md`: the phase 5 row links `plans/phase-5-linear.md`; copy this plan there.
- `tasks.md`: check T032 and T033. Leave T034 unchecked.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm run lint && npm run build && npm test && npm run infra:synth`.
Check the new prose has no em-dashes: `grep -n "—" docs/connectors/linear.md` must print nothing.

```bash
git add docs/connectors/linear.md tests/eval tests/contract/linear-eval-cases.test.ts README.md specs/013-connector-gateway
git commit -m "docs: linear setup guide, evaluation cases and the static-secret ruling

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Live check against the CharterArc team (T034, user-assisted)

**Files:**
- Create or modify: `specs/013-connector-gateway/quickstart.md` (section `## Linear (US2)`; if the
  file does not exist, create it with the title `# Connector gateway live evidence`, see
  Coordination)
- Modify: `specs/013-connector-gateway/tasks.md` (check T034 only after the evidence exists)

This task runs after this branch is deployed to the user's AgentX deployment. The agent prepares
the commands and the project file; the user runs every step that touches Linear, AWS or Slack.
Nothing here is inferred from mocks.

- [ ] **Step 1: Prepare the project revision.** Copy the deployed project file the user names and
  add the `linear` connector from the guide's step 5, with
  `credentialRef: linear-charterarc` and the scope
  `{ alias: charterarc, teamId: "c408e946-78aa-4db8-923e-f78053dd954f" }`. Raise `revision` by one.
  Keep `addLabels`/`removeLabels` in `save_issue`'s `allowedArguments` for Step 5's check.

- [ ] **Step 2: The user creates and checks the key.** They follow the guide's steps 1 and 2 in
  the CharterArc workspace, restricting team access to CharterArc. Record the exact permission and
  team-access labels the dialog showed, and the output of the team query (team ids and names only).
  If the query lists a team other than CharterArc, stop.

- [ ] **Step 3: The user stores and registers the key.** Guide steps 3 and 4 with
  `agentx/connectors/linear-charterarc` and `--ref linear-charterarc`. Record the `credential list`
  row.

- [ ] **Step 4: The user registers the revision.** Guide step 6. Record the full `preflight`
  output and stderr. Expected: `status: connected`, four offered tools, no skipped tools, no
  warnings.

- [ ] **Step 5: The user runs these in a new thread in the bound test channel.** Record each
  Slack permalink, AgentX's reply, and the Linear issue identifier:
  1. "what's open for charterarc in Linear?" Expect a list of CharterArc issues and no coding
     worker started.
  2. "create a Linear issue titled 'AgentX live check <date>' saying this was created by the
     Linear connector live check". Expect the issue in CharterArc with the footer naming the
     member and linking the thread.
  3. "set <new issue id> to high priority". Expect success (the update carries the same team).
  4. "add the label <an existing CharterArc label> to <new issue id>". Record whether Linear
     accepts `addLabels` with the same-team `team` (R2). If it refuses, remove `addLabels` and
     `removeLabels` from the guide's recommended `allowedArguments` in a follow-up commit.
  5. "comment on <new issue id> that the live check passed". Expect the comment with the footer.
  6. If the workspace has another team, "set <an issue id from another team> to low priority".
     Expect a plain refusal and no change in Linear. If there is no other team, record "skipped:
     one team".

- [ ] **Step 6: Capture the ledger evidence.** The user runs, with the workspace id from the
  broker log or thread record:

```sh
aws dynamodb query --table-name <state table> \
  --key-condition-expression "pk = :pk AND begins_with(sk, :sk)" \
  --expression-attribute-values '{":pk":{"S":"WORKSPACE#<workspaceId>"},":sk":{"S":"CONNECTOR#linear#"}}' \
  --projection-expression "sk, entityType, connector, tool, #r.#s" \
  --expression-attribute-names '{"#r":"result","#s":"status"}'
```

  Record the rows: one per write, `entityType` `CONNECTOR_INVOCATION`, `connector` `linear`.

- [ ] **Step 7: Confirm the recorded shapes still hold.** The fixtures were built from live
  captures on 2026-09-24, so no capture is needed here. If any Step 5 check was refused with
  "Could not confirm that Linear issue ... is in the charterarc team", or Step 4 skipped a tool,
  Linear changed a shape: stop and report it with the exact reply. Do not loosen the guard.

- [ ] **Step 8: Record the evidence in `quickstart.md`.** Add a section:

```markdown
## Linear (US2)

- Date, AgentX commit, deployment and region.
- Key: permission labels granted, team access (CharterArc only), team query output (ids, names).
- Credential list row for `linear-charterarc`.
- Registration preflight output and stderr.
- Thread permalinks and replies for checks 1 to 6, with the Linear issue identifier and the footer text.
- Result of the same-team `addLabels` check (R2).
- Ledger rows from Step 6.
- Whether any reply named an unreadable `get_issue` result (expected: none).
```

  Never paste the API key, a secret value or a token. Check the section with
  `grep -n "lin_api" specs/013-connector-gateway/quickstart.md` (must print nothing).

- [ ] **Step 9: Commit.** Check T034 in `tasks.md` only now.

```bash
git add specs/013-connector-gateway/quickstart.md specs/013-connector-gateway/tasks.md
git commit -m "docs: record the Linear live check

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage.** US2 scenario 1 (orchestrator calls `linear__<tool>`, no worker): Task 5 and
  Task 7 check 1. Scenario 2 (credential): amended by R1, Task 2 and Task 4. Scenario 3
  (attribution on description): Tasks 1, 4, 5. Scenario 4 (flattening): the real fixture schemas
  go through `reviewTools` in Tasks 1 and 4; they compile today (checked 2026-09-24 against the
  built gateway with no binder: all nine sampled tools offered, none skipped). FR-005: Tasks 1 and
  4. FR-009, FR-011: Tasks 2 and 3. FR-013: not applicable to Linear under R1; covered by phase 3
  for the provider. FR-019: Task 2 (`notConnected`), Task 4 (rejected key). FR-024: Tasks 1, 4, 5.
  SC-002: no route, ledger, catalog, orchestrator or Slack service file changes. SC-005: the guard
  and binder refusals send nothing upstream (Tasks 1 and 4).
- **Known dependency.** Phase 5 depends on 5a and 5b. Task 1 uses 5b's `optionalProperties`,
  `GuardInput.scope` and `vendorTools` exactly as 5b ships them; this
  phase edits no gateway engine or types file. Shared pieces with phase 6 follow the Coordination
  table, which is identical in both plans.
