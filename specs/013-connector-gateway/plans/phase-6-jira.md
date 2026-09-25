# Phase 6: Jira Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `jira` connector type so an administrator can register a Jira service-account
API token, approve Jira issue tools for one project, and let a Slack thread search, read, create
and comment on that project's issues through Atlassian's Rovo MCP server. `cloudId` and the
project key are bound by the server and the project limit is enforced twice: by the service
account's Jira permissions (the intended boundary, which the setup guide makes mandatory and
verifiable) and by an AgentX guard (defence in depth, and the only limit on an install that skips
the vendor-side step; see Ruling 5).

**Architecture:** The gateway gains `packages/gateway/src/jira.ts` (endpoint, scope type,
binder, project guard, attribution keys) and `packages/gateway/src/jira-jql.ts` (a pure JQL
project limiter). The gateway engine is not edited: 5b provides `Binder.optionalProperties`,
`GuardInput.scope` and the synchronous `Guard.rewrite`, and the JQL limiter runs as the project
guard's `rewrite`. Contracts
gain `JiraConnectorSchema` in the `ConnectorConfigSchema` union. The broker gains
`jiraConnectorType` in `packages/broker/src/aws/jira-connector-type.ts`, registered in
`BUILT_IN_CONNECTOR_TYPES`. Routes, ledger, catalog cache and presentation do not change (SC-002).

**Tech Stack:** TypeScript 5.9 strict, Node 22.19 to 22.x, Zod 4, Vitest 5, MCP SDK 1.30.1.

**Spec:** [../spec.md](../spec.md): User Story 3, FR-001, FR-005, FR-009, FR-011, FR-014,
FR-019, FR-024, SC-002, SC-005. Also [../data-model.md](../data-model.md) (Jira scope),
[../contracts/project-config.md](../contracts/project-config.md) (Jira example, mandatory
vendor-side restriction). Predecessors: [phase-3-credentials.md](phase-3-credentials.md),
[phase-5a-generic-connectors.md](phase-5a-generic-connectors.md),
[phase-5b-binder.md](phase-5b-binder.md) (shared binder, guard scope and `rewrite`). Sibling:
phase 5 (Linear), which runs in parallel.

**Branch:** `feat/013-jira`, stacked on the 5b head (`feat/013-binder`, which stacks on 5a,
`feat/013-generic-connectors`). Depends on both 5a and 5b. Opened as a PR that depends on the 5b
PR and is rebased when 5a or 5b review changes them.

**Task map to `tasks.md`:** T035 = Tasks 1 to 4. T036 = Task 5. T037 = Task 6.

## Global Constraints

- **No regressions.** Every existing test passes with its assertions unchanged. The one named
  assertion change: `tests/contract/connector-types.test.ts`, test "has a built-in entry for every
  type ConnectorConfigSchema accepts", whose `toEqual(["github"])` becomes
  `toEqual(["github", "jira"])` (or `["github", "linear", "jira"]` if phase 5 merged first),
  because this phase adds a schema type on purpose.
- **Strict TDD.** Every code step is preceded by a failing test that is run and seen failing.
- **GitHub unchanged.** GitHub catalogs, schema hashes, ledger keys and messages stay
  byte-identical. The 5a GitHub golden test must pass untouched.
- **Vendor code placement (FR-001).** Jira endpoint, argument names (`cloudId`, `projectKey`,
  `jql`, `issueIdOrKey`, `parent`), guard and JQL logic live in `packages/gateway`. The broker
  type only parses config and wires the registry.
- **Test imports.** Tests that drive broker code import gateway classes from
  `"@agentx/gateway"` (dist). Gateway-only tests import `packages/gateway/src` (instanceof across
  module copies).
- **Secret safety.** The API token never appears in a response, log line, error message, fixture
  or test snapshot.
- **Docs style.** Plain, short sentences. No em-dashes in any document this phase writes.
- **Open source.** Every organisation creates its own Atlassian service account and token. The
  guide never assumes our site, project or account; our values appear only in `quickstart.md`
  evidence.
- **Node and build.** `export PATH=/private/tmp/claude-501/node-v22.20.0-darwin-arm64/bin:$PATH`;
  `npm run build` before `npm test`.
- **Full check per task.** `npm run typecheck && npm run lint && npm run build && npm test`
  (plus `npm run infra:synth` in Tasks 3 and 5).
- **Commits.** `type(scope): summary`, ending with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **Fix before the PR.** Fix cheap review findings and anything that fails silently before the PR.

## What this phase takes from phase 5b (Interfaces)

Phase 6 uses 5b's API exactly as 5b ships it, with GitHub behaviour unchanged:

```ts
// packages/gateway/src/types.ts (5b)
export interface Binder<Scope> {
  readonly properties: readonly string[];                        // strict: required on every approved tool
  readonly optionalProperties?: readonly string[] | undefined;   // bound only where the tool declares it
  bind(scope: Scope, credential: IssuedCredential): Record<string, unknown>;
}
export interface GuardInput {
  tool: string;
  arguments: Readonly<Record<string, unknown>>;   // after every rewrite
  bound: Readonly<Record<string, unknown>>;       // the whole bind() result
  scope: unknown;                                 // the call's ConnectorContext.scope
  connection: Pick<McpConnection, "call">;
}
export interface RewriteInput {
  tool: string;
  arguments: Readonly<Record<string, unknown>>;
  bound: Readonly<Record<string, unknown>>;
  scope: unknown;
}
export interface Guard {
  requiredTools(tool: string, args: Readonly<Record<string, unknown>>): readonly string[];
  rewrite?(input: RewriteInput): Record<string, unknown>;   // synchronous, pure; may throw GuardRejection
  check(input: GuardInput): Promise<void>;
}
// tests/support/vendor-fixtures.ts (5b)
export function vendorTools(vendor: "linear" | "jira"): McpConnection["tools"];
```

5b's own tests pin these behaviours; this phase relies on them:

1. **Two modes in one binder.** `properties: ["cloudId"]` skips any approved tool without a
   required string `cloudId` (`missing server-bound property cloudId`).
   `optionalProperties: ["projectKey"]` binds `projectKey` only where a tool declares it (today
   only `createJiraIssue`).
2. **A call sends only the bound properties its tool declares.** Every Jira schema has
   `additionalProperties: false`, so `projectKey` never reaches `getJiraIssue`.
3. **Removal and refusal.** Every bound name is removed from the model's schema where present, and
   a model-supplied value for any bound name, on any tool, is refused with FORBIDDEN
   `Jira routing arguments are server controlled` before any connection.
4. **A missing `projectKey` value fails closed** on `createJiraIssue`: FAILED `policy_denied`,
   `Jira has no server-bound value for projectKey. An administrator must fix the connector configuration.`
5. **Guards see the scope and every bound value**, so the search rewrite and the issue check read
   the scope's `projectKey` on tools that have no such property.
6. **`rewrite` order.** Narrowed-schema validation, `bind`, each guard's `rewrite`, merge with the
   bound values, upstream validation, attribution (only keys the model supplied), each guard's
   `check` with the rewritten arguments, vendor call. A rewrite that sets a bound name fails as
   `Jira guard set a server-controlled argument.` The ledger fingerprints the model's own arguments.
7. **Hashes unchanged**, for GitHub and for Jira.

## Coordination with phase 5 (Linear)

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

## Review Focus

1. **Atlassian returns `getJiraIssue` in a shape the guard cannot read.** Expected: every keyed
   call is refused with "Could not confirm which project..." (fail closed, visible), never
   allowed. Tests: Task 2 (the live `data.key` shape passes; a markdown-text response and the older
   top-level `key` shape are refused); Task 6 exercises the real server.
2. **JQL whose quoted text contains parentheses, quotes or the words ORDER BY.** Expected: wrapped
   intact, not refused, not broken out of. Tests: Task 1 table and fuzz invariant.
3. **An administrator stores the token truncated, or registers it as `oauth-client-credentials`.**
   Expected: an OAuth-typed reference is refused at registration, naming the type (the shared
   `credentialRefusals`), and one re-registered later reports not connected; a truncated token
   reports not connected with a message that points at the fix. Tests: Task 3 (OAuth-typed
   record), Task 4 (401 message names the token check).
4. **Two scopes on the same site with different project keys.** Expected: a call with `target: B`
   binds B's `projectKey`, limits JQL to B and checks issues against B. Tests: Task 2.
5. **The model passes a Jira issue URL as `issueIdOrKey`** (the vendor schema invites it).
   Expected: refused with a message asking for the key, before any vendor call. Tests: Task 2.

## File Structure

| File | Responsibility |
|---|---|
| `packages/gateway/src/jira-jql.ts` (new) | `limitJqlToProject`: a quote- and parenthesis-aware JQL wrapper |
| `packages/gateway/src/jira.ts` (new) | `JIRA_MCP_ENDPOINT`, `JiraScope`, `jiraBinder`, `jiraProjectGuard`, `jiraConnector` |
| `packages/gateway/src/index.ts` | Re-exports the two new modules |
| `packages/contracts/src/connectors.ts` | `JIRA_PROJECT_TOOL_ACCESS`, `JiraConnectorSchema`, union option |
| `packages/contracts/src/project.ts` | `githubConnectorOf` finds with a type predicate (shared; the repository-scope loop already skips non-GitHub entries since 5a) |
| `packages/broker/src/aws/jira-connector-type.ts` (new) | `jiraConnectorType` |
| `packages/broker/src/aws/connector-types.ts` | `BUILT_IN_CONNECTOR_TYPES` gains `jira`; `ResolvedConnector.credential?` (shared) |
| `packages/broker/src/aws/credentials.ts` | `CredentialRegistry.typeOf(ref)` (shared) |
| `packages/broker/src/aws/registration-preflight.ts`, `broker.ts` | `credentialRefusals` and its call (shared; whichever phase lands first) |
| `tests/fixtures/vendors/jira-tools.json` (5b's file) | Five more verbatim Atlassian tools appended: `getAccessibleAtlassianResources`, `getConfluenceContent`, `editJiraIssue`, `transitionJiraIssue`, `executeWrite` |
| `tests/fixtures/vendors/jira-get-issue.json` (new) | The live `getJiraIssue` result captured 2026-09-24, summary replaced |
| `tests/support/fake-atlassian-mcp.ts` (new) | Local HTTP MCP server serving the fixtures |
| `tests/contract/gateway-jira-jql.test.ts`, `gateway-jira.test.ts` (new) | Gateway unit tests |
| `tests/integration/jira-connector.test.ts` (new) | Fake server plus broker routes, end to end |
| `tests/live/jira-live.test.ts` (new) | Skipped unless `AGENTX_LIVE_JIRA_TOKEN` is set; drives the broker against real Atlassian |
| `docs/connectors/jira.md` (new) | Setup guide for any administrator |
| `specs/013-connector-gateway/quickstart.md` | Jira live evidence section |

## Pre-decided Rulings

1. **Credential: static secret, not OAuth.** The Jira type reads a `static-secret` record whose
   `apiKey` is a service-account scoped API token, sent as `Authorization: Bearer`. Live finding
   (2026-09-24): service-account OAuth client credentials mint tokens that Jira REST accepts, but
   the Rovo MCP server refuses them with "Cloud id isn't explicitly granted". The type declares
   `credential: { ref, accepts: ["static-secret"] }` (the shared piece in Coordination), so
   registration refuses a new revision whose reference is another type, and `definition()` reports
   a reference re-registered later with another type as not connected, with a reason. Cost if
   wrong: if Atlassian starts accepting service-account OAuth, add the type to `accepts`, pass a
   token endpoint, and update the guide. One line of code.
2. **Endpoint `https://mcp.atlassian.com/v2/mcp`, a constant.** The v1 endpoint ignores API tokens
   (live finding). Cost if wrong: if Atlassian moves it, every Jira call fails and preflight shows
   it; a one-line change and a release.
3. **Binder: `cloudId` strict (`properties`), `projectKey` only where declared
   (`optionalProperties`).** `cloudId` is not on every Atlassian tool (the earlier shared
   notes said it was): it is optional on `executeRead`, `executeWrite` and `executeDestructive`, and absent
   from `discover`, `atlassianUserInfo` and `getAccessibleAtlassianResources`. Strict binding skips
   those six rather than offering them unbound, which is what we want. `projectKey` is bound only
   when the connector's scopes carry one (`jiraBinder(projectScoped)`); a site-wide connector
   leaves `projectKey` to the model. Cost if wrong: an admin cannot approve a cloudId-less
   Atlassian tool; none is useful for Jira issues.
4. **`projectKey` is all or none per connector.** The schema refuses a connector where some
   scopes have `projectKey` and others do not. Otherwise `createJiraIssue` would have a different
   schema per scope, and `presentCatalog` would drop it as "schema differs between scopes". Cost
   if wrong: an admin who wants a site-wide scope beside a project scope must use two connectors.
5. **Project limit: the credential is the intended boundary, the guard is defence in depth.**
   Constitution 2.1.0 makes the service account's Jira permissions the access boundary, and the
   guide makes restricting them a mandatory, explicit step with a check that must return zero
   issues outside the project. Live finding (2026-09-24): on the reference install the service
   account was not restricted; `project != KAN` returned 5 issues. So on any install that skips
   the vendor-side step, the guard below is currently the effective boundary, and its tests carry
   that weight. AgentX enforces the scope's `projectKey`:
   - `getJiraIssue`, `editJiraIssue`, `transitionJiraIssue`, `addOrEditJiraIssueComment`: the
     guard reads the issue with `getJiraIssue` on the call's connection and refuses unless the
     returned `key` is `<projectKey>-<n>`. A moved issue answers with its new key, so it is caught.
   - `createJiraIssue`: `projectKey` is bound; a `parent`, and any `parent`/`project` inside
     `fields`, `additional_fields` or `update`, is checked or refused.
   - `searchJiraIssuesUsingJql`: the guard's `rewrite` wraps the JQL (Ruling 6).
   Cost if wrong: a guard bug that over-refuses shows as a visible `policy_denied` result; one that
   under-restricts still meets the service account's own project limits. The keyed check costs one
   extra MCP read per keyed call (a double read for `getJiraIssue`).
6. **JQL is wrapped, not policed.** The project guard's `rewrite` (5b; synchronous and pure)
   turns `jql` into `project = "KEY" AND (<model JQL>)`, with a
   trailing top-level `ORDER BY` kept outside the parentheses. The limiter refuses JQL with
   unbalanced parentheses, an unterminated string, a backslash outside quotes, `ORDER BY` inside
   parentheses or twice, parentheses after `ORDER BY`, or more than 8,192 characters. Wrapping was
   chosen over "refuse queries that do not say `project = KEY`" because a correct refusal check
   needs a full JQL parser (top-level `OR`, `NOT`, `project in (...)`), while wrapping only needs
   quote and parenthesis tracking, and the model does not have to remember the rule. Cost if
   wrong: a valid JQL form the limiter refuses (the model sees the reason and rewrites), or an
   Atlassian JQL extension that breaks the wrap (caught by the service account's permissions).
7. **With `projectKey`, only the six guarded tools may be approved; registration refuses others.**
   Confluence, Loom, Teamwork Graph, `search`, `discover`, `execute*` and the account tools cannot
   be held to a project, so approving them under a `projectKey` would be a promise AgentX breaks.
   Without `projectKey`, AgentX neither refuses nor warns: the admin chose the credential-only
   boundary, and the guide lists the tools not to approve. Cost if wrong: a new Jira tool that
   Atlassian adds needs a guard rule (a code change) before it can be approved under a project.
8. **Access is pinned for the six guarded tools.** `getJiraIssue` and `searchJiraIssuesUsingJql`
   must be `read`; the other four must be `write`. A write approved as `read` would skip the
   ledger claim and be described as "Read-only." Cost if wrong: none found.
9. **Attribution keys `["description", "commentBody"]`** (fixture field names:
   `createJiraIssue.description`, `addOrEditJiraIssueComment.commentBody`). `editJiraIssue` puts
   the description inside `fields`, so edits are not signed; the guide says so. Cost if wrong:
   some edits lack the footer.
10. **The guard reads the issue key from `data.key`, and refuses anything else.** The live
    `getJiraIssue` result (captured 2026-09-24 on KAN) is
    `{ data: { appliedContentFormat, id, key, fields: { summary, description, status, assignee, updated } } }`.
    The key is at `data.key`; `fields` has no `project`, so the key's prefix is the project.
    A top-level `key` (the Jira REST shape) is not accepted. Cost if wrong: every keyed call is
    refused until the parser is fixed; never a leak.
11. **Presentation strings.** Label `Jira issues`, vendor `Jira`, scope noun `Jira project` when
    scopes carry `projectKey`, else `Jira site`. The manifest's not-connected label (`Jira`)
    stays as it is. Cost if wrong: wording only.
12. **Issue references must be keys or numeric IDs.** `issueIdOrKey` and parent references must
    match `^[A-Z][A-Z0-9_]{1,9}-[1-9][0-9]{0,9}$` or `^[1-9][0-9]{0,17}$`. URLs are refused
    because they can name another site. Cost if wrong: the model retries with the key.
13. **Test harness.** Integration tests drive the real `connectMcp` against a local fake
    Atlassian server, by passing a `connect` override through `ConnectorTypeContext.connect` that
    asserts the endpoint is `JIRA_MCP_ENDPOINT` and redirects to the fake. Production passes no
    override. Cost if wrong: none; the live test in Task 6 uses the production path.
14. **Evaluation.** The Jira presentation snapshot lands now (Tier 1). Model-replay cases go to
    `tests/eval/cases/jira.jsonl` if phase 4 has merged; otherwise they are appended to the seed
    list in `contracts/evaluation.md` for phase 4 to pick up. Cost if wrong: SC-004 is measured
    later for Jira.
15. **Live check in two parts.** Part A (before the PR): a skipped-by-default Vitest file drives
    the real broker code against the real Atlassian site with the user's token. Part B (after the
    automatic production release): a Slack thread in a bound channel. T037 is checked after
    Part B. Cost if wrong: none; deployed acceptance is never inferred from Part A.

---

### Task 1: JQL project limiter

**Files:**
- Create: `packages/gateway/src/jira-jql.ts`, `tests/contract/gateway-jira-jql.test.ts`
- Modify: `packages/gateway/src/index.ts` (`export * from "./jira-jql.js";`)

**Interfaces:**
- Produces:

```ts
export type JqlLimit = { jql: string } | { refused: string };
/** Wraps JQL so it can only return issues in one project. Pure; never throws. */
export function limitJqlToProject(jql: string, projectKey: string): JqlLimit;
export const MAX_JQL_LENGTH = 8_192;
```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/gateway-jira-jql.test.ts
import { describe, expect, it } from "vitest";
import { limitJqlToProject } from "../../packages/gateway/src/index.js";

/** The query with quoted strings as S and every parenthesised group's inside removed. */
function skeleton(jql: string): string {
  let out = "";
  let depth = 0;
  let quote: string | undefined;
  for (let index = 0; index < jql.length; index += 1) {
    const char = jql[index]!;
    if (quote) {
      if (char === "\\") { index += 1; continue; }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; if (depth === 0) out += "S"; continue; }
    if (char === "(") { if (depth === 0) out += "("; depth += 1; continue; }
    if (char === ")") { depth -= 1; if (depth === 0) out += ")"; continue; }
    if (depth === 0) out += char;
  }
  return out;
}
const LIMITED = /^project = S( AND \(\))?( order\s+by(\s[^()]*)?)?$/i;

describe("JQL project limiter", () => {
  it.each([
    ["status = Open", 'project = "PAY" AND (status = Open)'],
    ["status = Open ORDER BY created DESC", 'project = "PAY" AND (status = Open) ORDER BY created DESC'],
    ["status = Open order by rank, created", 'project = "PAY" AND (status = Open) order by rank, created'],
    ["ORDER BY created", 'project = "PAY" ORDER BY created'],
    ["", 'project = "PAY"'],
    ["   ", 'project = "PAY"'],
    ["project = OPS", 'project = "PAY" AND (project = OPS)'],
    ["status = Open OR project = OPS", 'project = "PAY" AND (status = Open OR project = OPS)'],
    ['summary ~ "a) OR (b"', 'project = "PAY" AND (summary ~ "a) OR (b")'],
    ['summary ~ "order by me"', 'project = "PAY" AND (summary ~ "order by me")'],
    ["summary ~ 'it\\'s'", "project = \"PAY\" AND (summary ~ 'it\\'s')"],
    ["(status = Open) ORDER BY created", 'project = "PAY" AND ((status = Open)) ORDER BY created'],
    ["reorder = 1", 'project = "PAY" AND (reorder = 1)'],
  ])("wraps %j", (jql, expected) => {
    expect(limitJqlToProject(jql, "PAY")).toEqual({ jql: expected });
  });

  it.each([
    ["status = Open) OR (project = OPS", "unbalanced parentheses"],
    ["(status = Open", "unbalanced parentheses"],
    ['summary ~ "unterminated', "an unterminated quoted string"],
    ["summary ~ a\\)b", "a backslash outside a quoted string"],
    ["(status = Open ORDER BY created)", "ORDER BY inside parentheses"],
    ["status = Open ORDER BY created ORDER BY rank", "more than one ORDER BY"],
    ["status = Open ORDER BY created, (rank)", "parentheses after ORDER BY"],
    ["a".repeat(8_193), "JQL is longer than 8192 characters"],
  ])("refuses %j", (jql, reason) => {
    expect(limitJqlToProject(jql, "PAY")).toEqual({ refused: reason });
  });

  it("refuses an invalid project key rather than build JQL from it", () => {
    expect(limitJqlToProject("status = Open", 'PAY" OR project = "OPS')).toEqual({ refused: "invalid project key" });
  });

  it("never lets model text escape the parenthesised group, for 5,000 generated queries", () => {
    const tokens = ["(", ")", '"', "'", "\\", " OR ", " AND ", " NOT ", "project = OPS", " ORDER BY x", "order by", "a", " ", "~"];
    let seed = 42;
    const next = () => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed; };
    let accepted = 0;
    for (let run = 0; run < 5_000; run += 1) {
      const length = next() % 12;
      const jql = Array.from({ length }, () => tokens[next() % tokens.length]).join("");
      const result = limitJqlToProject(jql, "PAY");
      if ("refused" in result) { expect(result.refused.length).toBeGreaterThan(0); continue; }
      accepted += 1;
      expect(result.jql.startsWith('project = "PAY"')).toBe(true);
      expect(skeleton(result.jql)).toMatch(LIMITED);
    }
    expect(accepted).toBeGreaterThan(500);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npm run build && npx vitest run tests/contract/gateway-jira-jql.test.ts`
Expected: FAIL, `limitJqlToProject` is not exported.

- [ ] **Step 3: Implement**

```ts
// packages/gateway/src/jira-jql.ts
export type JqlLimit = { jql: string } | { refused: string };
export const MAX_JQL_LENGTH = 8_192;
const PROJECT_KEY = /^[A-Z][A-Z0-9_]{1,9}$/;

/** True when an unquoted, depth-0 `ORDER BY` starts at `index`, as a whole word. */
function startsOrderBy(jql: string, index: number): boolean {
  const before = index === 0 ? " " : jql[index - 1]!;
  if (!/[\s()]/.test(before)) return false;
  return /^order\s+by(?=[\s(]|$)/i.test(jql.slice(index));
}

/**
 * Wraps JQL as `project = "KEY" AND (<jql>)`, keeping a trailing top-level ORDER BY outside the
 * parentheses. Tracks quotes (with backslash escapes inside them) and parenthesis depth so model
 * text can never close the group early. Refuses rather than guesses on anything it cannot track.
 */
export function limitJqlToProject(jql: string, projectKey: string): JqlLimit {
  if (!PROJECT_KEY.test(projectKey)) return { refused: "invalid project key" };
  if (jql.length > MAX_JQL_LENGTH) return { refused: `JQL is longer than ${MAX_JQL_LENGTH} characters` };
  let depth = 0;
  let quote: '"' | "'" | undefined;
  let orderAt: number | undefined;
  for (let index = 0; index < jql.length; index += 1) {
    const char = jql[index]!;
    if (quote) {
      if (char === "\\") { index += 1; continue; }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === "\\") return { refused: "a backslash outside a quoted string" };
    if (char === "(") {
      if (orderAt !== undefined) return { refused: "parentheses after ORDER BY" };
      depth += 1;
    } else if (char === ")") {
      if (orderAt !== undefined) return { refused: "parentheses after ORDER BY" };
      depth -= 1;
      if (depth < 0) return { refused: "unbalanced parentheses" };
    } else if ((char === "o" || char === "O") && startsOrderBy(jql, index)) {
      if (depth !== 0) return { refused: "ORDER BY inside parentheses" };
      if (orderAt !== undefined) return { refused: "more than one ORDER BY" };
      orderAt = index;
    }
  }
  if (quote) return { refused: "an unterminated quoted string" };
  if (depth !== 0) return { refused: "unbalanced parentheses" };
  const where = (orderAt === undefined ? jql : jql.slice(0, orderAt)).trim();
  const order = orderAt === undefined ? "" : ` ${jql.slice(orderAt).trim()}`;
  const limit = `project = "${projectKey}"`;
  return { jql: where ? `${limit} AND (${where})${order}` : `${limit}${order}` };
}
```

Note the check order: an `ORDER BY` inside parentheses is found while `depth > 0`, before the
parenthesis-after-ORDER-BY rule can apply, so `(status = Open ORDER BY created)` reports "ORDER
BY inside parentheses". If a table case disagrees, fix the code, not the expected reason.

- [ ] **Step 4: Run and watch them pass.** Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Full check and commit**

```bash
git add packages/gateway/src/jira-jql.ts packages/gateway/src/index.ts tests/contract/gateway-jira-jql.test.ts
git commit -m "feat(gateway): limit model JQL to one Jira project by wrapping it

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Jira connector definition in the gateway, with recorded fixtures

**Files:**
- Create: `packages/gateway/src/jira.ts`, `tests/contract/gateway-jira.test.ts`,
  `tests/fixtures/vendors/jira-get-issue.json`
- Modify: `tests/fixtures/vendors/jira-tools.json` (append five tools),
  `packages/gateway/src/index.ts` (`export * from "./jira.js";`)
- Modify: `packages/contracts/src/connectors.ts` (only the `JIRA_PROJECT_TOOL_ACCESS` constant;
  the schema comes in Task 3)

**Interfaces:**
- Consumes: 5b `Binder.optionalProperties`, `GuardInput.scope`, `Guard.rewrite` and
  `RewriteInput`, and `vendorTools` from `tests/support/vendor-fixtures.ts`; Task 1
  (`limitJqlToProject`).
- Produces:

```ts
// @agentx/contracts
export const JIRA_PROJECT_TOOL_ACCESS: {
  readonly getJiraIssue: "read"; readonly searchJiraIssuesUsingJql: "read";
  readonly createJiraIssue: "write"; readonly editJiraIssue: "write";
  readonly transitionJiraIssue: "write"; readonly addOrEditJiraIssueComment: "write";
};
// @agentx/gateway
export const JIRA_MCP_ENDPOINT: URL; // https://mcp.atlassian.com/v2/mcp
export interface JiraScope { alias: string; cloudId: string; projectKey?: string | undefined }
export function jiraBinder(projectScoped: boolean): Binder<JiraScope>;
export const jiraProjectGuard: Guard;
export function jiraConnector(credentials: CredentialProvider<JiraScope>, options: { projectScoped: boolean }): ConnectorDefinition<JiraScope>;
```

- [ ] **Step 1: Extend the tool fixture and build the `getJiraIssue` fixture**

Append five tools to 5b's fixture, byte-for-byte from the live v2 `tools/list` recorded
2026-09-24 (21 tools), after 5b's six:

```bash
export PATH=/private/tmp/claude-501/node-v22.20.0-darwin-arm64/bin:$PATH
SRC=/private/tmp/claude-501/-Users-abhishekgarg-web/ffaf1996-7c19-4dcc-8463-6c9e6e330dfc/scratchpad/plans
node -e '
const fs = require("fs");
const all = JSON.parse(fs.readFileSync(process.argv[1] + "/jira-tools.json", "utf8"));
const file = "tests/fixtures/vendors/jira-tools.json";
const kept = JSON.parse(fs.readFileSync(file, "utf8"));
for (const name of ["getAccessibleAtlassianResources", "getConfluenceContent", "editJiraIssue", "transitionJiraIssue", "executeWrite"]) {
  if (kept.some((tool) => tool.name === name)) continue;
  const tool = all.find((entry) => entry.name === name);
  if (!tool) throw new Error(name);
  kept.push(tool);
}
fs.writeFileSync(file, JSON.stringify(kept, null, 2) + "\n");
' "$SRC"
jq -c '[.[].name]' tests/fixtures/vendors/jira-tools.json
```

Expected: `["getJiraIssue","searchJiraIssuesUsingJql","createJiraIssue","addOrEditJiraIssueComment","executeRead","atlassianUserInfo","getAccessibleAtlassianResources","getConfluenceContent","editJiraIssue","transitionJiraIssue","executeWrite"]`.
5b's tests still pass: they approve only their own six tools. If the source file is gone, ask the
controller for it; do not reconstruct schemas by hand.

Build the `getJiraIssue` fixture from the live capture (`getJiraIssue` on `KAN-3`, 2026-09-24).
Keep the shape and every value except the summary:

```bash
SPIKE=/private/tmp/claude-501/-Users-abhishekgarg-web/ffaf1996-7c19-4dcc-8463-6c9e6e330dfc/scratchpad/spike
jq '.data.fields.summary = "Fixture issue"' "$SPIKE/jira-get-issue-raw.json" > tests/fixtures/vendors/jira-get-issue.json
jq -c '{key: .data.key, fields: (.data.fields | keys)}' tests/fixtures/vendors/jira-get-issue.json
```

Expected: `{"key":"KAN-3","fields":["assignee","description","status","summary","updated"]}`.
Grep both files for `ATATT`, `Bearer` and `@`: expected no match.

- [ ] **Step 2: Write the failing tests**

```ts
// tests/contract/gateway-jira.test.ts
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  approveTools, executeTool, reviewTools, jiraBinder, jiraConnector, jiraProjectGuard, JIRA_MCP_ENDPOINT,
  type ConnectorContext, type Invocation, type JiraScope, type Ledger, type McpToolResult, type connectMcp,
} from "../../packages/gateway/src/index.js";
import { vendorTools } from "../support/vendor-fixtures.js";

const recorded = { tools: vendorTools("jira") };
/** The live getJiraIssue result (2026-09-24): `{ data: { appliedContentFormat, id, key, fields } }`. */
const issueFixture = JSON.parse(readFileSync(new URL("../fixtures/vendors/jira-get-issue.json", import.meta.url), "utf8")) as { data: Record<string, unknown> };
/** The live shape for an issue whose current key is `key`. */
const issueWithKey = (key: string) => ({ ...issueFixture, data: { ...issueFixture.data, key } });
const CLOUD = "1437bb04-4c88-4efd-9d38-658e8febfeba";
const text = (value: unknown): McpToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const APPROVALS = [
  { name: "getJiraIssue", access: "read" as const }, { name: "searchJiraIssuesUsingJql", access: "read" as const },
  { name: "createJiraIssue", access: "write" as const }, { name: "editJiraIssue", access: "write" as const },
  { name: "transitionJiraIssue", access: "write" as const }, { name: "addOrEditJiraIssueComment", access: "write" as const },
  { name: "executeWrite", access: "write" as const }, { name: "getAccessibleAtlassianResources", access: "read" as const },
];

/** A Jira connector over the recorded tools; getJiraIssue answers from `issues`. */
function jira(scope: JiraScope, issues: Record<string, unknown> = { "KAN-1": issueWithKey("KAN-1") }) {
  const connector = jiraConnector({ issue: async () => ({ token: "jira-token-value", bindings: {} }) }, { projectScoped: scope.projectKey !== undefined });
  const call = vi.fn<(name: string, args: Record<string, unknown>) => Promise<McpToolResult>>(async (name, args) => {
    if (name !== "getJiraIssue") return text({ ok: true });
    const issue = issues[String(args.issueIdOrKey)];
    return issue === undefined ? { isError: true, content: [{ type: "text", text: "Issue does not exist" }] } : typeof issue === "string" ? { content: [{ type: "text", text: issue }] } : text(issue);
  });
  const connect = vi.fn<typeof connectMcp>(async () => ({ tools: recorded.tools, call, close: async () => undefined }));
  const context: ConnectorContext<JiraScope> = { workspaceId: "w", ownerKey: "alice", scopeAlias: scope.alias, scope, policy: { tools: APPROVALS } };
  const records = new Map<string, Invocation>();
  const ledger: Ledger = {
    claim: async (record) => { if (records.has(record.requestId)) return false; records.set(record.requestId, record); return true; },
    get: async (id) => records.get(id), finish: async (record) => { records.set(record.requestId, record); },
  };
  const run = (tool: string, args: Record<string, unknown>, attribution?: string) => executeTool(
    { requestId: randomUUID(), scope: scope.alias, tool, arguments: args, schemaHash: approveTools({ tools: recorded.tools }, connector, context).find((entry) => entry.name === tool)!.schemaHash },
    connector, context, { connect, ledger, ...(attribution ? { attribution } : {}) });
  return { connector, context, call, connect, run };
}
const kan: JiraScope = { alias: "kan", cloudId: CLOUD, projectKey: "KAN" };
const vendorCalls = (call: ReturnType<typeof jira>["call"]) => call.mock.calls.map(([name, args]) => ({ name, args }));

describe("Jira connector definition", () => {
  it("targets the v2 endpoint, signs description and commentBody, and names what to check on rejection", () => {
    const { connector } = jira(kan);
    expect(JIRA_MCP_ENDPOINT.href).toBe("https://mcp.atlassian.com/v2/mcp");
    expect(connector).toMatchObject({ label: "Jira", endpoint: JIRA_MCP_ENDPOINT, attributionKeys: ["description", "commentBody"], guards: [jiraProjectGuard] });
    expect(connector.permissionsHint).toBe("the service account's API token (complete, not expired), API token authentication in the Rovo MCP server settings, and the service account's Jira project access");
  });

  it("binds cloudId strictly and projectKey only where declared, and only for a project-scoped connector", () => {
    expect(jiraBinder(true)).toMatchObject({ properties: ["cloudId"], optionalProperties: ["projectKey"] });
    expect(jiraBinder(true).bind(kan, { token: "t", bindings: {} })).toEqual({ cloudId: CLOUD, projectKey: "KAN" });
    expect(jiraBinder(false).optionalProperties).toBeUndefined();
    expect(jiraBinder(false).bind({ alias: "site", cloudId: CLOUD }, { token: "t", bindings: {} })).toEqual({ cloudId: CLOUD });
  });

  it("removes cloudId everywhere and projectKey from createJiraIssue, and skips tools without a required cloudId", () => {
    const { connector, context } = jira(kan);
    const { tools, skipped } = reviewTools({ tools: recorded.tools }, connector, context);
    expect(tools.map((tool) => tool.name)).toEqual(["getJiraIssue", "searchJiraIssuesUsingJql", "createJiraIssue", "addOrEditJiraIssueComment", "editJiraIssue", "transitionJiraIssue"]);
    for (const tool of tools) expect(Object.keys(tool.inputSchema.properties as object)).not.toContain("cloudId");
    expect(Object.keys(tools.find((tool) => tool.name === "createJiraIssue")!.inputSchema.properties as object)).not.toContain("projectKey");
    expect(skipped).toEqual([
      { tool: "getAccessibleAtlassianResources", reason: "missing server-bound property cloudId" },
      { tool: "executeWrite", reason: "missing server-bound property cloudId" },
    ]);
  });

  it("keeps projectKey for the model when the connector is not project scoped", () => {
    const site: JiraScope = { alias: "site", cloudId: CLOUD };
    const { connector, context } = jira(site);
    const create = reviewTools({ tools: recorded.tools }, connector, context).tools.find((tool) => tool.name === "createJiraIssue")!;
    expect((create.inputSchema.required as string[])).toContain("projectKey");
  });

  it("binds cloudId and projectKey on create, cloudId alone on reads, and signs the description", async () => {
    const f = jira(kan);
    expect(await f.run("createJiraIssue", { summary: "Flaky login", issueType: "Bug", description: "Fails 1 in 5." }, "Requested by Pratik in Slack")).toMatchObject({ status: "SUCCEEDED" });
    expect(f.call).toHaveBeenLastCalledWith("createJiraIssue", { summary: "Flaky login", issueType: "Bug", description: "Fails 1 in 5.\n\n—\nRequested by Pratik in Slack", cloudId: CLOUD, projectKey: "KAN" });
  });

  it("limits a search to the scope's project and refuses JQL it cannot limit", async () => {
    const f = jira(kan);
    expect(await f.run("searchJiraIssuesUsingJql", { jql: 'status = "To Do" ORDER BY created DESC' })).toMatchObject({ status: "SUCCEEDED" });
    expect(f.call).toHaveBeenLastCalledWith("searchJiraIssuesUsingJql", { jql: 'project = "KAN" AND (status = "To Do") ORDER BY created DESC', cloudId: CLOUD });
    const refused = await f.run("searchJiraIssuesUsingJql", { jql: "status = Open) OR (project = OPS" });
    expect(refused).toMatchObject({ status: "FAILED", reason: "policy_denied" });
    expect(refused.text).toBe('This JQL cannot be limited to Jira project KAN: unbalanced parentheses. AgentX adds "project = KAN" itself; send only the rest of the query.');
    expect(f.call).toHaveBeenCalledTimes(1);
  });

  it("checks an issue's project before a comment, and refuses one in another project without writing", async () => {
    const f = jira(kan, { "KAN-1": issueWithKey("KAN-1"), "OPS-3": issueWithKey("OPS-3") });
    expect(await f.run("addOrEditJiraIssueComment", { issueIdOrKey: "KAN-1", commentBody: "Deployed." }, "Requested by Pratik")).toMatchObject({ status: "SUCCEEDED" });
    expect(vendorCalls(f.call)).toEqual([
      { name: "getJiraIssue", args: { cloudId: CLOUD, issueIdOrKey: "KAN-1" } },
      { name: "addOrEditJiraIssueComment", args: { issueIdOrKey: "KAN-1", commentBody: "Deployed.\n\n—\nRequested by Pratik", cloudId: CLOUD } },
    ]);
    expect(f.connect).toHaveBeenLastCalledWith(expect.objectContaining({ tools: ["addOrEditJiraIssueComment", "getJiraIssue"] }));
    f.call.mockClear();
    const refused = await f.run("addOrEditJiraIssueComment", { issueIdOrKey: "OPS-3", commentBody: "x" });
    expect(refused).toMatchObject({ status: "FAILED", reason: "policy_denied", text: "Jira issue OPS-3 is not in project KAN. This connector works only in KAN." });
    expect(vendorCalls(f.call).map((entry) => entry.name)).toEqual(["getJiraIssue"]);
  });

  it("reads the key from the live getJiraIssue shape", async () => {
    const f = jira(kan, { "KAN-3": issueFixture });
    expect(await f.run("addOrEditJiraIssueComment", { issueIdOrKey: "KAN-3", commentBody: "x" })).toMatchObject({ status: "SUCCEEDED" });
  });

  it("follows a numeric ID or a moved issue to its current key", async () => {
    const f = jira(kan, { "10001": issueWithKey("KAN-5"), "KAN-7": issueWithKey("OPS-9") });
    expect(await f.run("getJiraIssue", { issueIdOrKey: "10001" })).toMatchObject({ status: "SUCCEEDED" });
    expect(await f.run("editJiraIssue", { issueIdOrKey: "KAN-7", fields: { summary: "x" } })).toMatchObject({ status: "FAILED", text: "Jira issue KAN-7 is not in project KAN. This connector works only in KAN." });
  });

  it.each([
    ["an issue URL", { issueIdOrKey: "https://other.atlassian.net/browse/OPS-1" }],
    ["lowercase text", { issueIdOrKey: "kan-1" }],
  ])("refuses %s before any vendor call", async (_label, args) => {
    const f = jira(kan);
    expect(await f.run("getJiraIssue", args)).toMatchObject({ status: "FAILED", reason: "policy_denied", text: "Pass the Jira issue key (for example KAN-123) or its numeric ID, not a URL or other text." });
    expect(f.call).not.toHaveBeenCalled();
  });

  it("refuses when it cannot read the issue or cannot find its key at data.key", async () => {
    const f = jira(kan, { "KAN-2": "**KAN-2** Example issue (markdown, not JSON)", "KAN-4": { key: "KAN-4", fields: {} } });
    expect((await f.run("getJiraIssue", { issueIdOrKey: "KAN-9" })).text).toBe("Could not read Jira issue KAN-9 to check its project. It may not exist, or AgentX's Jira account cannot see it.");
    expect((await f.run("getJiraIssue", { issueIdOrKey: "KAN-2" })).text).toBe("Could not confirm which project Jira issue KAN-2 is in, so AgentX did not run this call.");
    expect((await f.run("getJiraIssue", { issueIdOrKey: "KAN-4" })).text).toBe("Could not confirm which project Jira issue KAN-4 is in, so AgentX did not run this call.");
  });

  it("checks parents and refuses project changes on create, edit and transition", async () => {
    const f = jira(kan, { "KAN-1": issueWithKey("KAN-1"), "OPS-1": issueWithKey("OPS-1") });
    expect((await f.run("createJiraIssue", { summary: "s", issueType: "Sub-task", parent: "OPS-1" })).text).toBe("Jira issue OPS-1 is not in project KAN. This connector works only in KAN.");
    expect(await f.run("createJiraIssue", { summary: "s", issueType: "Sub-task", parent: "KAN-1" })).toMatchObject({ status: "SUCCEEDED" });
    expect((await f.run("createJiraIssue", { summary: "s", issueType: "Task", additional_fields: { Project: "OPS" } })).text).toBe("This connector cannot change an issue's project.");
    expect((await f.run("editJiraIssue", { issueIdOrKey: "KAN-1", fields: { parent: { key: "OPS-1" } } })).text).toBe("Jira issue OPS-1 is not in project KAN. This connector works only in KAN.");
    expect((await f.run("editJiraIssue", { issueIdOrKey: "KAN-1", fields: { parent: { set: "x" } } })).text).toBe("Give the parent as an issue key (for example KAN-10).");
    expect((await f.run("transitionJiraIssue", { issueIdOrKey: "KAN-1", transitionName: "Done", update: { project: [] } })).text).toBe("This connector cannot change an issue's project.");
  });

  it("binds and limits by the chosen scope when two scopes share a site", async () => {
    const ops: JiraScope = { alias: "ops", cloudId: CLOUD, projectKey: "OPS" };
    const f = jira(ops, { "OPS-1": issueWithKey("OPS-1") });
    await f.run("searchJiraIssuesUsingJql", { jql: "status = Open" });
    expect(f.call).toHaveBeenLastCalledWith("searchJiraIssuesUsingJql", { jql: 'project = "OPS" AND (status = Open)', cloudId: CLOUD });
    await f.run("createJiraIssue", { summary: "s", issueType: "Task" });
    expect(f.call).toHaveBeenLastCalledWith("createJiraIssue", { summary: "s", issueType: "Task", cloudId: CLOUD, projectKey: "OPS" });
  });

  it("does not look up or rewrite anything when the connector is not project scoped", async () => {
    const f = jira({ alias: "site", cloudId: CLOUD });
    await f.run("searchJiraIssuesUsingJql", { jql: "status = Open" });
    await f.run("createJiraIssue", { projectKey: "OPS", summary: "s", issueType: "Task" });
    expect(vendorCalls(f.call)).toEqual([
      { name: "searchJiraIssuesUsingJql", args: { jql: "status = Open", cloudId: CLOUD } },
      { name: "createJiraIssue", args: { projectKey: "OPS", summary: "s", issueType: "Task", cloudId: CLOUD } },
    ]);
  });

  it("fails closed when a guard input carries no Jira scope", async () => {
    await expect(jiraProjectGuard.check({ tool: "getJiraIssue", arguments: { issueIdOrKey: "KAN-1" }, bound: { cloudId: CLOUD }, scope: undefined, connection: { call: vi.fn() } }))
      .rejects.toThrow("The Jira project check could not run, so AgentX did not run this call.");
    expect(() => jiraProjectGuard.rewrite!({ tool: "searchJiraIssuesUsingJql", arguments: { jql: "status = Open" }, bound: { cloudId: CLOUD }, scope: undefined }))
      .toThrow("The Jira project check could not run, so AgentX did not run this call.");
  });
});
```

`JIRA_PROJECT_TOOL_ACCESS` gets one assertion in `tests/contract/connector-contracts.test.ts`:
its keys equal the six tool names above and every value is `read` or `write` as in the Interfaces
block.

- [ ] **Step 3: Run and watch them fail**

Run: `npm run build && npx vitest run tests/contract/gateway-jira.test.ts tests/contract/connector-contracts.test.ts`
Expected: FAIL, `jiraConnector` is not exported.

- [ ] **Step 4: Implement**

`packages/contracts/src/connectors.ts` (near the top, after `ConnectorNameSchema`):

```ts
/** The Jira tools AgentX can hold to one project, and the access each must be approved with. */
export const JIRA_PROJECT_TOOL_ACCESS = {
  getJiraIssue: "read",
  searchJiraIssuesUsingJql: "read",
  createJiraIssue: "write",
  editJiraIssue: "write",
  transitionJiraIssue: "write",
  addOrEditJiraIssueComment: "write",
} as const satisfies Record<string, "read" | "write">;
```

`packages/gateway/src/jira.ts`:

```ts
import { GuardRejection, type Binder, type ConnectorDefinition, type CredentialProvider, type Guard } from "./types.js";
import { limitJqlToProject } from "./jira-jql.js";
import { isObject, resultText } from "./util.js";
import type { McpToolResult } from "./mcp-client.js";

/** v2 is the endpoint that accepts API tokens; v1 ignores them. */
export const JIRA_MCP_ENDPOINT = new URL("https://mcp.atlassian.com/v2/mcp");

export interface JiraScope { alias: string; cloudId: string; projectKey?: string | undefined }

const ISSUE_REF = /^(?:[A-Z][A-Z0-9_]{1,9}-[1-9][0-9]{0,9}|[1-9][0-9]{0,17})$/;
const KEYED_TOOLS = new Set(["getJiraIssue", "editJiraIssue", "transitionJiraIssue", "addOrEditJiraIssueComment"]);
/** Free-form field objects a tool accepts, where a project or parent could hide. */
const FIELD_OBJECTS: Readonly<Record<string, readonly string[]>> = {
  createJiraIssue: ["additional_fields"],
  editJiraIssue: ["fields", "additional_fields"],
  transitionJiraIssue: ["fields", "update"],
};
const NO_SCOPE = "The Jira project check could not run, so AgentX did not run this call.";

/**
 * cloudId is strict: every approved tool must require it, and tools without it are skipped.
 * projectKey binds only on tools that declare it, and only for a project-scoped connector; a
 * missing value then fails closed in the engine (5b).
 */
export function jiraBinder(projectScoped: boolean): Binder<JiraScope> {
  return projectScoped
    ? { properties: ["cloudId"], optionalProperties: ["projectKey"], bind: (scope) => ({ cloudId: scope.cloudId, projectKey: scope.projectKey }) }
    : { properties: ["cloudId"], bind: (scope) => ({ cloudId: scope.cloudId }) };
}

function jiraScopeOf(value: unknown): JiraScope | undefined {
  if (!isObject(value) || typeof value.cloudId !== "string") return undefined;
  if (value.projectKey !== undefined && typeof value.projectKey !== "string") return undefined;
  return value as unknown as JiraScope;
}

function issueRef(value: unknown, projectKey: string): string {
  if (typeof value === "string" && ISSUE_REF.test(value)) return value;
  throw new GuardRejection(`Pass the Jira issue key (for example ${projectKey}-123) or its numeric ID, not a URL or other text.`);
}

function parentRef(value: unknown, projectKey: string): string {
  if (typeof value === "string") return issueRef(value, projectKey);
  if (isObject(value) && typeof value.key === "string") return issueRef(value.key, projectKey);
  if (isObject(value) && typeof value.id === "string") return issueRef(value.id, projectKey);
  throw new GuardRejection(`Give the parent as an issue key (for example ${projectKey}-10).`);
}

/** Every issue the call names that must be in the project; throws on a project change. */
function issueReferences(tool: string, args: Readonly<Record<string, unknown>>, projectKey: string): string[] {
  const refs: string[] = [];
  if (KEYED_TOOLS.has(tool)) refs.push(issueRef(args.issueIdOrKey, projectKey));
  if (tool === "createJiraIssue" && args.parent !== undefined) refs.push(parentRef(args.parent, projectKey));
  for (const field of FIELD_OBJECTS[tool] ?? []) {
    const values = args[field];
    if (!isObject(values)) continue;
    for (const [name, value] of Object.entries(values)) {
      const lower = name.toLowerCase();
      if (lower === "project" || lower === "pid") throw new GuardRejection("This connector cannot change an issue's project.");
      if (lower === "parent") refs.push(parentRef(value, projectKey));
    }
  }
  return [...new Set(refs)];
}

/** The live getJiraIssue result (2026-09-24) is `{ data: { id, key, fields } }`. No other shape is trusted. */
function issueKeyOf(result: McpToolResult): string | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(resultText(result)); } catch { return undefined; }
  return isObject(parsed) && isObject(parsed.data) && typeof parsed.data.key === "string" ? parsed.data.key : undefined;
}

/**
 * Defence in depth behind the service account's own Jira permissions: keeps every call inside
 * the scope's project. Does nothing for a scope without a projectKey.
 */
export const jiraProjectGuard: Guard = {
  requiredTools: (tool) => tool !== "getJiraIssue" && (KEYED_TOOLS.has(tool) || Object.hasOwn(FIELD_OBJECTS, tool)) ? ["getJiraIssue"] : [],
  // 5b: synchronous and pure; returns the whole argument object; bound values are merged after it.
  rewrite({ tool, arguments: args, scope }) {
    if (tool !== "searchJiraIssuesUsingJql") return { ...args };
    const jira = jiraScopeOf(scope);
    if (!jira) throw new GuardRejection(NO_SCOPE);
    if (jira.projectKey === undefined) return { ...args };
    const limited = limitJqlToProject(typeof args.jql === "string" ? args.jql : "", jira.projectKey);
    if ("refused" in limited) {
      throw new GuardRejection(`This JQL cannot be limited to Jira project ${jira.projectKey}: ${limited.refused}. AgentX adds "project = ${jira.projectKey}" itself; send only the rest of the query.`);
    }
    return { ...args, jql: limited.jql };
  },
  async check({ tool, arguments: args, connection, scope }) {
    const jira = jiraScopeOf(scope);
    if (!jira) throw new GuardRejection(NO_SCOPE);
    const projectKey = jira.projectKey;
    if (projectKey === undefined) return;
    for (const ref of issueReferences(tool, args, projectKey)) {
      const result = await connection.call("getJiraIssue", { cloudId: jira.cloudId, issueIdOrKey: ref });
      if (result.isError) throw new GuardRejection(`Could not read Jira issue ${ref} to check its project. It may not exist, or AgentX's Jira account cannot see it.`);
      const key = issueKeyOf(result);
      if (key === undefined) throw new GuardRejection(`Could not confirm which project Jira issue ${ref} is in, so AgentX did not run this call.`);
      if (!new RegExp(`^${projectKey}-[1-9][0-9]*$`).test(key)) {
        throw new GuardRejection(`Jira issue ${ref} is not in project ${projectKey}. This connector works only in ${projectKey}.`);
      }
    }
  },
};

export function jiraConnector(credentials: CredentialProvider<JiraScope>, options: { projectScoped: boolean }): ConnectorDefinition<JiraScope> {
  return {
    label: "Jira",
    endpoint: JIRA_MCP_ENDPOINT,
    permissionsHint: "the service account's API token (complete, not expired), API token authentication in the Rovo MCP server settings, and the service account's Jira project access",
    credentials,
    binder: jiraBinder(options.projectScoped),
    guards: [jiraProjectGuard],
    attributionKeys: ["description", "commentBody"],
  };
}
```

Note the check order in `executeTool`: `issueRef` refusals thrown from `check` happen after the
connection opens but before any `connection.call`, so "refuses %s before any vendor call" holds
(the connect happens, the call does not). The URL refusal test asserts `call`, not `connect`.

- [ ] **Step 5: Run and watch them pass.** Run the Step 3 command. Expected: PASS.

- [ ] **Step 6: Full check and commit**

```bash
git add packages/gateway/src/jira.ts packages/gateway/src/index.ts packages/contracts/src/connectors.ts tests/fixtures/atlassian tests/contract/gateway-jira.test.ts tests/contract/connector-contracts.test.ts
git commit -m "feat(gateway): Jira connector with cloudId and project binding and a project guard

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Jira connector configuration and type in the control plane

**Files:**
- Modify: `packages/contracts/src/connectors.ts` (`JiraConnectorSchema`, union option)
- Modify: `packages/contracts/src/project.ts` (`githubConnectorOf` type predicate; shared, skip if
  phase 5 landed it)
- Create: `packages/broker/src/aws/jira-connector-type.ts`
- Modify: `packages/broker/src/aws/connector-types.ts` (`BUILT_IN_CONNECTOR_TYPES`;
  `ResolvedConnector.credential?`, shared)
- Modify: `packages/broker/src/aws/credentials.ts` (`CredentialRegistry.typeOf`, shared)
- Modify: `packages/broker/src/aws/registration-preflight.ts`, `packages/broker/src/aws/broker.ts`
  (`credentialRefusals` and its call, shared)
- Test: `tests/contract/connector-config.test.ts`, `tests/contract/connector-types.test.ts` (one
  named assertion change, plus added tests), `tests/contract/credential-registry.test.ts`,
  `tests/contract/registration-preflight.test.ts` (added tests only)

The shared pieces follow the Coordination table: if phase 5 landed first they exist with the same
code; keep them and add only the Jira type, its schema and its tests.

**Interfaces:**
- Consumes: Task 2 (`jiraConnector`, `JiraScope`, `JIRA_PROJECT_TOOL_ACCESS`).
- Produces:

```ts
// @agentx/contracts
export const JiraConnectorSchema: z.ZodObject<...>; // type "jira"
export type JiraConnectorConfig = z.infer<typeof JiraConnectorSchema>;
// broker
export const jiraConnectorType: ConnectorType;             // jira-connector-type.ts
// Shared with phase 5 (Coordination):
// ResolvedConnector gains: credential?: { ref: string; accepts: readonly CredentialType[] }   // absent for github
// CredentialRegistry.typeOf(ref: string): Promise<CredentialType | undefined>
export async function credentialRefusals(connectors: readonly ResolvedConnector[], registry: CredentialRegistry | undefined): Promise<string[]>;
```

- [ ] **Step 1: Write the failing tests**

In `tests/contract/connector-config.test.ts` (reuse its `project`, `issues` helpers):

```ts
describe("jira connectors", () => {
  const CLOUD = "1437bb04-4c88-4efd-9d38-658e8febfeba";
  const jira = (overrides: Record<string, unknown> = {}) => ({
    name: "jira", type: "jira", credentialRef: "jira-agentx-sa",
    scopes: [{ alias: "pay", cloudId: CLOUD, projectKey: "PAY" }],
    tools: [{ name: "searchJiraIssuesUsingJql", access: "read" }, { name: "createJiraIssue", access: "write" }],
    ...overrides,
  });

  it("parses the contract's jira example beside github", () => {
    const definition = ProjectDefinitionSchema.parse(project({ connectors: [{ name: "github", type: "github", scopes: "all-repositories", tools }, jira()] }));
    expect(definition.integrations?.connectors?.[1]).toMatchObject({ type: "jira", scopes: [{ alias: "pay", cloudId: CLOUD, projectKey: "PAY" }] });
  });

  it("accepts a site-wide connector with no projectKey and any tool", () => {
    expect(issues(project({ connectors: [jira({ scopes: [{ alias: "site", cloudId: CLOUD }], tools: [{ name: "executeRead", access: "read" }] })] }))).toEqual([]);
  });

  it.each([
    ["projectKey on some scopes only", { scopes: [{ alias: "pay", cloudId: CLOUD, projectKey: "PAY" }, { alias: "site", cloudId: CLOUD }] },
      "connector jira: set projectKey on every scope or on none"],
    ["a tool AgentX cannot hold to a project", { tools: [{ name: "executeWrite", access: "write" }] },
      "connector jira: tool executeWrite cannot be limited to a Jira project; approve only getJiraIssue, searchJiraIssuesUsingJql, createJiraIssue, editJiraIssue, transitionJiraIssue, addOrEditJiraIssueComment, or remove projectKey from every scope"],
    ["a write approved as read", { tools: [{ name: "createJiraIssue", access: "read" }] },
      "connector jira: tool createJiraIssue must be approved with access: write"],
    ["the same site and project twice", { scopes: [{ alias: "a", cloudId: CLOUD, projectKey: "PAY" }, { alias: "b", cloudId: CLOUD, projectKey: "PAY" }] },
      "connector jira: scopes a and b address the same Jira site and project"],
    ["a duplicate alias", { scopes: [{ alias: "a", cloudId: CLOUD, projectKey: "PAY" }, { alias: "a", cloudId: CLOUD, projectKey: "OPS" }] },
      "connector jira: scope aliases must be unique"],
  ])("refuses %s", (_label, overrides, message) => {
    expect(issues(project({ connectors: [jira(overrides)] }))).toContain(message);
  });

  it.each([
    ["a cloudId that is not a UUID", { scopes: [{ alias: "pay", cloudId: "abhishek2551996.atlassian.net", projectKey: "PAY" }] }],
    ["a lowercase project key", { scopes: [{ alias: "pay", cloudId: CLOUD, projectKey: "pay" }] }],
    ["no credentialRef", { credentialRef: undefined }],
    ["identity user", { identity: "user" }],
  ])("refuses %s", (_label, overrides) => {
    expect(issues(project({ connectors: [jira(overrides)] })).length).toBeGreaterThan(0);
  });

  it("does not treat jira scopes as repository names", () => {
    expect(issues(project({ connectors: [jira()] })).some((issue) => issue.includes("unregistered repository"))).toBe(false);
  });
});
```

(If `issues` returns issue objects rather than messages, map to `message` in these tests the same
way the file's existing tests do.)

In `tests/contract/connector-types.test.ts`:
- Change the named assertion `expect(schemaTypes).toEqual(["github"])` to
  `expect(schemaTypes).toEqual(["github", "jira"])`, or to `["github", "linear", "jira"]` if phase 5
  landed first (see Global Constraints and Coordination).
- Add:

```ts
  it("resolves a jira connector with its presentation strings, ledger and credential reference", async () => {
    const db = new FakeDynamoDb();
    const credentialRegistry = new CredentialRegistry({
      documentClient: db as never, tableName: "state",
      secrets: { read: vi.fn(async () => JSON.stringify({ apiKey: "jira-token-value" })) }, githubApp: { ref: "github-app", secretName: "agentx/connectors/github-app" },
    });
    const resolve = (scopes: unknown) => resolveConnectors(project({ connectors: [
      { name: "jira", type: "jira", credentialRef: "jira-sa", scopes, tools: [{ name: "getJiraIssue", access: "read" }] },
    ] }), { credentialRegistry })[0]!;
    const projectScoped = resolve([{ alias: "kan", cloudId: "1437bb04-4c88-4efd-9d38-658e8febfeba", projectKey: "KAN" }]);
    expect(projectScoped).toMatchObject({
      name: "jira", type: "jira", label: "Jira issues", vendor: "Jira", scopeNoun: "Jira project", attribution: true,
      credential: { ref: "jira-sa", accepts: ["static-secret"] }, ledger: { prefix: "CONNECTOR#jira#", entityType: "CONNECTOR_INVOCATION" },
    });
    expect(resolve([{ alias: "site", cloudId: "1437bb04-4c88-4efd-9d38-658e8febfeba" }]).scopeNoun).toBe("Jira site");
    expect(await projectScoped.configured()).toBe(false);
    expect(await projectScoped.definition()).toEqual({ notConnected: "credential jira-sa is not registered" });

    db.set({ pk: "CREDENTIALS", sk: "REF#jira-sa", entityType: "CREDENTIAL", ref: "jira-sa", type: "static-secret", secretName: "agentx/connectors/jira-sa", registeredBy: "admin", registeredAt: "2026-09-01T00:00:00.000Z" });
    expect(await projectScoped.configured()).toBe(true);
    const definition = await projectScoped.definition();
    if ("notConnected" in definition) throw new Error("expected a definition");
    expect(definition.endpoint.href).toBe("https://mcp.atlassian.com/v2/mcp");
    expect(await definition.credentials.issue(projectScoped.scopes[0]!.scope, "read")).toEqual({ token: "jira-token-value", bindings: {} });

    // Re-registered later with another type: not connected with a reason, never a throw.
    db.set({ pk: "CREDENTIALS", sk: "REF#jira-sa", entityType: "CREDENTIAL", ref: "jira-sa", type: "oauth-client-credentials", secretName: "agentx/connectors/jira-sa", registeredBy: "admin", registeredAt: "2026-09-02T00:00:00.000Z" });
    expect(await projectScoped.configured()).toBe(false);
    expect(await projectScoped.definition()).toEqual({ notConnected: "credential jira-sa is oauth-client-credentials; a Jira connector needs a static-secret API token" });
  });

  it("skips, with a log line, a stored jira connector that fails its schema", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(resolveConnectors(project({ connectors: [{ name: "jira", type: "jira", scopes: [], tools: [] }] }), {})).toEqual([]);
      const line = log.mock.calls.map(([entry]) => String(entry)).find((entry) => entry.includes("connector.unusable"));
      expect(JSON.parse(line!)).toMatchObject({ event: "connector.unusable", connector: "jira", type: "jira", reason: "invalid jira connector configuration: credentialRef, scopes, tools" });
    } finally { log.mockRestore(); }
  });
```

In `tests/contract/credential-registry.test.ts` (only if phase 5 has not landed `typeOf`; phase 5
tests it in `linear-connector.test.ts`):

```ts
  it("names the provider type behind a reference, and nothing for an unknown one", async () => {
    const { handler, registry } = await createAdminBroker({ connectorCredentials: { secrets, githubApp } });
    await adminCall(handler, { method: "POST", path: "/v1/admin/credentials", body: { ref: "jira-oauth", type: "oauth-client-credentials", secretName: "agentx/connectors/linear" } });
    expect(await registry!.typeOf(githubApp.ref)).toBe("github-app");
    expect(await registry!.typeOf("jira-oauth")).toBe("oauth-client-credentials");
    expect(await registry!.typeOf("missing")).toBeUndefined();
  });
```

(Use the same way this file already obtains `registry` from `createAdminBroker`; the line-60 test
does.)

In `tests/contract/registration-preflight.test.ts` (always; it is this type's registration test):
register, through the admin route, a project whose connectors are GitHub plus the `jira()` config
above with `credentialRef: "jira-sa"`:
- unregistered: status 400, `CONFIG_INVALID`, message
  `connector jira: credential jira-sa is not registered; run agentx admin credential register first`;
- registered as `oauth-client-credentials` under `jira-oauth`, with `credentialRef: "jira-oauth"`:
  status 400, message
  `connector jira: credential jira-oauth is oauth-client-credentials; a Jira connector needs static-secret`;
- after `POST /v1/admin/credentials` for `jira-sa` as `static-secret`: status 201;
- a broker built without `connectorCredentials`: message
  `connector jira: connector credentials are not configured in this deployment`.

- [ ] **Step 2: Run and watch them fail**

Run: `npm run build && npx vitest run tests/contract/connector-config.test.ts tests/contract/connector-types.test.ts tests/contract/credential-registry.test.ts tests/contract/registration-preflight.test.ts`
Expected: FAIL. The schema refuses `type: "jira"` and the type map has no `jira` (and, if phase 5
has not landed, `typeOf` and the credential refusal do not exist).

- [ ] **Step 3: Implement**

`packages/contracts/src/connectors.ts`, after `GitHubConnectorSchema`:

```ts
const JiraScopeSchema = z.object({
  alias: z.string().regex(AGENTX_NAME_PATTERN),
  /** Atlassian site UUID, from https://<site>.atlassian.net/_edge/tenant_info. */
  cloudId: z.guid(),
  projectKey: z.string().regex(/^[A-Z][A-Z0-9_]{1,9}$/).optional(),
}).strict();

export const JiraConnectorSchema = z.object({
  name: ConnectorNameSchema,
  type: z.literal("jira"),
  credentialRef: z.string().regex(AGENTX_NAME_PATTERN),
  identity: z.literal("service").optional(),
  scopes: z.array(JiraScopeSchema).min(1).max(32),
  tools: ToolApprovalListSchema,
  attribution: z.boolean().optional(),
}).strict().superRefine((connector, context) => {
  const issue = (message: string) => context.addIssue({ code: "custom", message: `connector ${connector.name}: ${message}` });
  const aliases = connector.scopes.map((scope) => scope.alias);
  if (new Set(aliases).size !== aliases.length) issue("scope aliases must be unique");
  const seen = new Map<string, string>();
  for (const scope of connector.scopes) {
    const key = `${scope.cloudId.toLowerCase()}/${scope.projectKey ?? ""}`;
    const earlier = seen.get(key);
    if (earlier !== undefined) issue(`scopes ${earlier} and ${scope.alias} address the same Jira site and project`);
    else seen.set(key, scope.alias);
  }
  const keyed = connector.scopes.filter((scope) => scope.projectKey !== undefined).length;
  if (keyed !== 0 && keyed !== connector.scopes.length) issue("set projectKey on every scope or on none");
  const guarded = Object.keys(JIRA_PROJECT_TOOL_ACCESS);
  for (const tool of connector.tools) {
    const pinned = (JIRA_PROJECT_TOOL_ACCESS as Record<string, "read" | "write">)[tool.name];
    if (pinned !== undefined && tool.access !== pinned) issue(`tool ${tool.name} must be approved with access: ${pinned}`);
    if (keyed > 0 && pinned === undefined) {
      issue(`tool ${tool.name} cannot be limited to a Jira project; approve only ${guarded.join(", ")}, or remove projectKey from every scope`);
    }
  }
});

export const ConnectorConfigSchema = z.discriminatedUnion("type", [GitHubConnectorSchema, JiraConnectorSchema]);
export type JiraConnectorConfig = z.infer<typeof JiraConnectorSchema>;
```

With phase 5 landed, the union is `[GitHubConnectorSchema, LinearConnectorSchema, JiraConnectorSchema]`.

If Zod 4's `discriminatedUnion` rejects a refined object in your installed version, move the
`superRefine` body into `ConnectorsSchema.superRefine`, applied to entries whose `type` is
`jira`, and keep the same messages.

`packages/contracts/src/project.ts`: 5a's `checkProjectDefinition` already skips non-GitHub
entries in the repository-scope loop (`if (connector.type !== "github") continue;`); confirm it
still does and add nothing there. In `githubConnectorOf` (shared; skip if phase 5 landed it), make
the find a type predicate so `connector.scopes` narrows to the GitHub shape:
`project.integrations?.connectors?.find((entry): entry is GitHubConnectorConfig => entry.type === "github")`.

`packages/broker/src/aws/credentials.ts`, in `CredentialRegistry` (shared; skip if phase 5 landed it):

```ts
  /** The provider type behind a reference: the built-in GitHub App, a valid stored record's type, or undefined. */
  async typeOf(ref: string): Promise<CredentialType | undefined> {
    if (ref === this.options.githubApp.ref) return "github-app";
    return (await this.readRecord(ref))?.type;
  }
```

`packages/broker/src/aws/jira-connector-type.ts`:

```ts
import { JiraConnectorSchema, type CredentialType } from "@agentx/contracts";
import { jiraConnector, type JiraScope } from "@agentx/gateway";
import { connectorLedgerKeys } from "./connector-ledger.js";
import type { ConnectorType, ResolvedConnector } from "./connector-types.js";

const ACCEPTS: readonly CredentialType[] = ["static-secret"];
const NOT_CONFIGURED = "connector credentials are not configured in this deployment";

/** Jira through Atlassian's Rovo MCP server, with a service-account API token (static secret). */
export const jiraConnectorType: ConnectorType = {
  type: "jira",
  resolve(config, _project, context) {
    const parsed = JiraConnectorSchema.safeParse(config);
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((issue) => issue.path[0] === undefined ? "entry" : String(issue.path[0])))];
      return { unusable: `invalid jira connector configuration: ${fields.join(", ")}` };
    }
    const jira = parsed.data;
    const registry = context.credentialRegistry;
    const projectScoped = jira.scopes.every((scope) => scope.projectKey !== undefined);
    const connector: ResolvedConnector<JiraScope> = {
      name: jira.name,
      type: "jira",
      label: "Jira issues",
      vendor: "Jira",
      scopeNoun: projectScoped ? "Jira project" : "Jira site",
      scopes: jira.scopes.map((scope) => ({ alias: scope.alias, scope })),
      policy: { tools: jira.tools },
      approvals: jira.tools,
      attribution: jira.attribution !== false,
      ledger: connectorLedgerKeys(jira.name),
      credential: { ref: jira.credentialRef, accepts: ACCEPTS },
      configured: async () => (await registry?.typeOf(jira.credentialRef)) === "static-secret",
      async definition() {
        if (!registry) return { notConnected: NOT_CONFIGURED };
        const type = await registry.typeOf(jira.credentialRef);
        if (type === undefined) return { notConnected: `credential ${jira.credentialRef} is not registered` };
        // Atlassian's MCP refuses service-account OAuth tokens, so only a static API token works.
        if (type !== "static-secret") return { notConnected: `credential ${jira.credentialRef} is ${type}; a Jira connector needs a static-secret API token` };
        return jiraConnector(registry.provider(jira.credentialRef), { projectScoped });
      },
      ...(context.connect ? { connect: context.connect } : {}),
    };
    return connector;
  },
};
```

The `import type` from `connector-types.js` keeps the module graph acyclic at runtime.
`connector-types.ts`: import `jiraConnectorType` and set
`BUILT_IN_CONNECTOR_TYPES = { github: githubConnectorType, jira: jiraConnectorType }`
(`{ github, linear, jira }` in that order if phase 5 landed first). Add to `ResolvedConnector`
(shared; skip if phase 5 landed it):

```ts
  /** The registry credential this connector reads and the provider types it accepts; absent for github. */
  credential?: { ref: string; accepts: readonly CredentialType[] };
```

Add to `registration-preflight.ts` (shared; skip if phase 5 landed it, the code is identical):

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

and in `broker.ts` `registerProject` (shared), on the new-revision path only, right after the
budget refusal and before preflight:

```ts
  const credentialProblems = await credentialRefusals(connectors(), dependencies.credentialRegistry);
  if (credentialProblems.length > 0) throw agentXError("CONFIG_INVALID", credentialProblems.join("; "));
```

The existing-revision (idempotent) path does not run it, so revisions stored earlier never start
refusing.

- [ ] **Step 4: Run and watch them pass.** Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Full check and commit**

Run: `npm run typecheck && npm run lint && npm run build && npm test && npm run infra:synth`.
Expected: all pass; the only changed existing assertion is the named one.

```bash
git add packages/contracts/src packages/broker/src/aws tests/contract
git commit -m "feat(broker): jira connector type with a static service-account token

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Fake Atlassian MCP server and a hosted flow through broker routes

**Files:**
- Create: `tests/support/fake-atlassian-mcp.ts`, `tests/integration/jira-connector.test.ts`
- Modify: `tests/contract/tool-presentation.test.ts` (one added test; its snapshot entry is new)

**Interfaces:**
- Consumes: Tasks 2 and 3; `tests/support/slack-broker.ts` (`createBroker`, `call`,
  `ensureWorkspace`, `markReady`, `loadSlackBroker`, `orchestratorPrincipal`).
- Produces:

```ts
export interface FakeAtlassian {
  url: URL;
  calls: Array<{ name: string; arguments: Record<string, unknown> }>;
  authorizations: Array<string | undefined>;
  close(): Promise<void>;
}
export function atlassianTools(): McpConnection["tools"];   // 5b's vendorTools("jira")
/** `issues` maps a reference the model may pass (key or numeric ID) to the issue's current key. */
export async function startFakeAtlassian(options: { token: string; tokenAuth?: boolean; issues: Record<string, string> }): Promise<FakeAtlassian>;
```

- [ ] **Step 1: Write the fake server** (test support, no test of its own; it is exercised by
  Step 2)

```ts
// tests/support/fake-atlassian-mcp.ts
// A local Streamable HTTP MCP server that answers like Atlassian's Rovo MCP server, from 5b's
// recorded tools/list (vendors/jira-tools.json) and the live getJiraIssue shape
// (vendors/jira-get-issue.json). It answers 401 unless the exact Bearer token is sent, or always
// when tokenAuth is false (API token authentication disabled at Atlassian).
import { createServer } from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import type { McpConnection } from "@agentx/gateway";
import { vendorTools } from "./vendor-fixtures.js";

const GET_ISSUE = JSON.parse(readFileSync(new URL("../fixtures/vendors/jira-get-issue.json", import.meta.url), "utf8")) as { data: Record<string, unknown> };
/** The live getJiraIssue shape for an issue whose current key is `key`. */
const issueWithKey = (key: string) => ({ ...GET_ISSUE, data: { ...GET_ISSUE.data, key } });

export interface FakeAtlassian {
  url: URL;
  calls: Array<{ name: string; arguments: Record<string, unknown> }>;
  authorizations: Array<string | undefined>;
  close(): Promise<void>;
}

export function atlassianTools(): McpConnection["tools"] {
  return vendorTools("jira");
}

export async function startFakeAtlassian(options: { token: string; tokenAuth?: boolean; issues: Record<string, string> }): Promise<FakeAtlassian> {
  const calls: FakeAtlassian["calls"] = [];
  const authorizations: FakeAtlassian["authorizations"] = [];
  const tools = atlassianTools();
  const text = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
  const answer = (name: string, args: Record<string, unknown>) => {
    calls.push({ name, arguments: args });
    if (name === "getJiraIssue") {
      const key = options.issues[String(args.issueIdOrKey)];
      return key ? text(issueWithKey(key)) : { isError: true, content: [{ type: "text", text: "Issue does not exist or you do not have permission to see it." }] };
    }
    if (name === "searchJiraIssuesUsingJql") return text({ issues: [...new Set(Object.values(options.issues))].map((key) => ({ key })), isLast: true });
    if (name === "createJiraIssue") return text({ id: "10009", key: "KAN-9" });
    if (name === "addOrEditJiraIssueComment") return text({ commentId: "20001" });
    return text({ ok: true });
  };
  const server = createServer((request, response) => { void (async () => {
    authorizations.push(request.headers.authorization);
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    if (options.tokenAuth === false || request.headers.authorization !== `Bearer ${options.token}`) { response.writeHead(401).end(); return; }
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const message = JSON.parse(body) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake-atlassian", version: "1" } }
      : message.method === "tools/list" ? { tools } : answer(message.params?.name ?? "", message.params?.arguments ?? {});
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  })().catch(() => { response.writeHead(500).end(); }); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fake Atlassian port");
  return {
    url: new URL(`http://127.0.0.1:${address.port}/v2/mcp`), calls, authorizations,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}
```

- [ ] **Step 2: Write the failing integration test**

`tests/integration/jira-connector.test.ts`. Setup, reused by every case:
- `TOKEN = "ATATT-test-" + "x".repeat(181)` (192 characters, like a real service-account token).
- `fake = await startFakeAtlassian({ token: TOKEN, issues: { "KAN-1": "KAN-1", "OPS-1": "OPS-1" } })`.
- `connect = (input) => { expect(input.endpoint.href).toBe(JIRA_MCP_ENDPOINT.href); return connectMcp({ ...input, endpoint: fake.url }); }`,
  with `connectMcp` and `JIRA_MCP_ENDPOINT` imported from `"@agentx/gateway"`.
- `jira: ConnectorType = { type: "jira", resolve: (config, project, context) => jiraConnectorType.resolve(config, project, { ...context, connect }) }`.
- `createBroker({ connectorTypes: { github: githubConnectorType, jira }, connectorCredentials: { secrets, githubApp: { ref: "github-app", secretName: "agentx/connectors/github-app" } } })`,
  where `secrets.read("agentx/connectors/jira-agentx-sa")` returns `JSON.stringify({ apiKey: TOKEN })`.
- The project: one repository, connectors
  `[{ name: "jira", type: "jira", credentialRef: "jira-agentx-sa", scopes: [{ alias: "kan", cloudId: "1437bb04-4c88-4efd-9d38-658e8febfeba", projectKey: "KAN" }], tools: [search (read, with the description override from the guide), getJiraIssue (read), createJiraIssue (write), addOrEditJiraIssueComment (write)] }]`,
  registered through `POST /v1/admin/projects` with `preflight: true`, then bound to the channel,
  exactly as `registerAndBind` in `generic-connector-routes.test.ts` does.
- `console.log` is spied on in `beforeEach` and restored in `afterEach`; `fake.close()` in `afterEach`.

Cases:

1. **"refuses registration until the credential is registered, then registers with a connected
   preflight"**: before `POST /v1/admin/credentials` (`ref: "jira-agentx-sa"`, `type: "static-secret"`),
   registration answers 400 naming `credential jira-agentx-sa is not registered`. After it, 201 with
   `preflight.connectors` equal to
   `[{ name: "jira", status: "connected", offered: ["jira__searchJiraIssuesUsingJql", "jira__getJiraIssue", "jira__createJiraIssue", "jira__addOrEditJiraIssueComment"], skipped: [] }]`
   and every `fake.authorizations` entry equal to `Bearer ${TOKEN}`.
2. **"reports API-token authentication disabled at Atlassian as not connected, naming the
   connector, and still registers"** (US3 scenario 2): start the fake with `tokenAuth: false`.
   Registration is 201; the preflight entry has `status: "not_connected"` and a `problem` that
   contains `Jira rejected the credential twice; check the service account's API token (complete, not expired)`;
   `warnings` contains an entry starting `connector jira: `.
3. **"hides cloudId and projectKey and binds the registered ones on every call"** (US3 scenario
   1): `GET /v1/service/workspaces/<id>/connectors/jira/tools` returns four tools; no
   `inputSchema.properties` has `cloudId`; `jira__createJiraIssue` has no `projectKey`. A
   `POST .../connectors/jira/call` for `createJiraIssue` `{ summary: "Flaky login", issueType: "Bug", description: "Fails 1 in 5." }`
   returns SUCCEEDED; `fake.calls.at(-1)` equals
   `{ name: "createJiraIssue", arguments: { summary: "Flaky login", issueType: "Bug", description: <starts with "Fails 1 in 5.\n\n—\n">, cloudId: "1437bb04-4c88-4efd-9d38-658e8febfeba", projectKey: "KAN" } }`;
   the fake database holds `CONNECTOR#jira#<requestId>` with `entityType: "CONNECTOR_INVOCATION"`;
   replaying the same request ID returns `replayed: true` and adds no fake call.
4. **"limits a search to KAN"**: search `{ jql: 'status = "To Do" ORDER BY created DESC' }`; the
   fake receives `jql: 'project = "KAN" AND (status = "To Do") ORDER BY created DESC'`.
5. **"refuses a comment on another project's issue without writing"**: comment on `OPS-1` returns
   FAILED `policy_denied`; the only new fake call is `getJiraIssue`. Comment on `KAN-1` succeeds
   and its `commentBody` ends with the attribution footer.
6. **"refuses a model-supplied cloudId before contacting Atlassian"**: a call whose arguments
   include `cloudId` answers 403 `FORBIDDEN` `Jira routing arguments are server controlled`; no new
   fake call.
7. **"lists jira at thread setup for services that opt in"**: a thread-workspace request with both
   `includeConnectors: true` and `includeAllConnectorTypes: true` includes
   `{ name: "jira", type: "jira", label: "Jira issues", scopes: ["kan"], connected: true }`.
8. **"never reveals the token"**: after cases 1 to 6 in one broker, `JSON.stringify` of every
   response body and every `console.log` line does not contain `TOKEN`.

In `tests/contract/tool-presentation.test.ts` add a test that builds the Jira catalog from the
recorded fixture (`vendorTools("jira")`, `reviewTools` with `jiraConnector(..., { projectScoped: true })`, scope `kan`,
approvals as in the integration project), presents it with
`presentCatalog({ connector: "jira", label: "Jira", scopeNoun: "Jira project", ... })`, and snapshots
names, descriptions and schemas plus the manifest line for
`{ name: "jira", type: "jira", label: "Jira issues", scopes: ["kan"], connected: true }`. Assert every
description is at most 2,048 characters. This adds a new snapshot entry; no existing entry changes.

- [ ] **Step 3: Run and watch it fail**

Run: `npm run build && npx vitest run tests/integration/jira-connector.test.ts tests/contract/tool-presentation.test.ts`
Expected: before Tasks 2 and 3 this fails on imports; on top of them, cases fail only where
behaviour is missing. If every case passes at first run, inject a fault (for example drop the
`rewrite` from `jiraProjectGuard`) and confirm case 4 fails, then revert.

- [ ] **Step 4: Fix whatever the cases expose** in the owning module (Task 2 or 3 code), with the
  case as the failing test. Do not weaken a case.

- [ ] **Step 5: Run and watch it pass.** Run the Step 3 command. Expected: PASS. Review the new
  snapshot by eye: descriptions end with "Targets the kan Jira project." and the access line.

- [ ] **Step 6: Full check and commit**

```bash
git add tests/support/fake-atlassian-mcp.ts tests/integration/jira-connector.test.ts tests/contract/tool-presentation.test.ts tests/contract/__snapshots__/tool-presentation.test.ts.snap
git commit -m "test: jira connector end to end against a fake Atlassian MCP server

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Setup guide, documents and evaluation cases (T036)

**Files:**
- Create: `docs/connectors/jira.md`
- Create or modify: `specs/013-connector-gateway/quickstart.md` (if new, create it with the title
  `# Connector gateway live evidence`; then add an empty `## Jira (US3)` heading that Task 6 fills;
  see Coordination)
- Modify: `README.md` (Connector credentials section), `specs/013-connector-gateway/contracts/project-config.md`,
  `specs/013-connector-gateway/data-model.md`, `specs/013-connector-gateway/plan.md` (phase 6 row
  links this plan), `specs/013-connector-gateway/contracts/evaluation.md` or
  `tests/eval/cases/jira.jsonl` (Ruling 14)
- Create: `specs/013-connector-gateway/plans/phase-6-jira.md` (a copy of this plan)

- [ ] **Step 1: Write `docs/connectors/jira.md`** with exactly these sections and content. Plain,
  short sentences; no em-dashes. Where a click path is marked "(verify)", Task 6 confirms it
  against the live admin console and corrects it.

1. **What you get.** AgentX can search, read, create and comment on Jira issues from Slack. It acts
   as one Atlassian service account. Each write ends with a footer naming the Slack member who
   asked. You must limit the service account to the project in Jira (Step 4) and prove it (Step 8).
   That limit is the one that counts. AgentX also holds the connector to the project you name, as
   a second line.
2. **Before you start.** You need: an Atlassian organization admin; a Jira Cloud site; an AgentX
   control plane you can reach with `agentx login` as an administrator; the AWS CLI with Secrets
   Manager access in the control plane's account and region; `jq` (included in macOS 15 and later).
3. **Step 1: Allow API token authentication for the Rovo MCP server.** In Atlassian Administration
   (admin.atlassian.com), open your organization. Open **Apps**, then **AI settings**, then **Rovo
   MCP server** (verify). Open **Authentication** and turn on **Allow API token authentication**.
   Without this, Atlassian rejects every AgentX call and preflight reports the connector as not
   connected.
4. **Step 2: Create a service account.** In Atlassian Administration open **Directory**, then
   **Service accounts**, then **Create service account** (verify). Name it, for example,
   `AgentX`.
5. **Step 3: Give it Jira access with the User role.** On the service account, open app access and
   give **Jira** the **User** role (verify). Do not give it Confluence, Loom or admin roles.
6. **Step 4: Restrict it to the intended projects (mandatory).** This is the access boundary. Do
   not skip it. A new service account with the Jira User role can often browse every project that
   grants **Browse projects** to all logged-in users. Step 8 checks the result.
   - In each project AgentX may use: **Project settings**, then **Access** or **People**, add the
     service account with a role that can browse, create and comment.
   - Check every other project: the permission scheme must not grant **Browse projects** to
     **Any logged in user**, to a group the service account is in, or to the Jira application
     role. Fix any scheme that does.
   - Spot check: in Jira, **Settings**, **System**, **Permission helper** (verify). Pick the
     service account, a project it must not see, and **Browse projects**. The answer must be no.
     Step 8 then checks every project at once.
7. **Step 5: Create an API token with five scopes.** On the service account, open
   **Credentials**, then create an **API token** (verify). Set an expiry. Choose these scopes:
   `read:jira-work`, `write:jira-work`, `read:jira-user`, `read:jira:agent-interface`,
   `search:jira:agent-interface`. Copy the token now; Atlassian shows it once. It is long (about
   192 characters). Do not create OAuth 2.0 credentials instead: Atlassian's MCP server refuses
   service-account OAuth tokens with "Cloud id isn't explicitly granted", even though Jira's REST
   API accepts them.
8. **Step 6: Find your cloudId.** Open `https://<your-site>.atlassian.net/_edge/tenant_info`. It
   returns `{"cloudId":"..."}`. That UUID is your `cloudId`.
9. **Step 7: Store the token in Secrets Manager, without cutting it.**

   ```sh
   read -rs JIRA_TOKEN        # paste the token, press Enter; nothing is shown
   printf '%s' "$JIRA_TOKEN" | wc -c   # about 192; 128 means it was cut, start again
   jq -n --arg k "$JIRA_TOKEN" '{apiKey: $k}' | aws secretsmanager create-secret \
     --name agentx/connectors/jira-agentx-sa --secret-string file:///dev/stdin
   unset JIRA_TOKEN
   aws secretsmanager get-secret-value --secret-id agentx/connectors/jira-agentx-sa \
     --query SecretString --output text | jq -r '.apiKey | length'   # same number as above
   ```

   The name must start with `agentx/connectors/`. Use the default `aws/secretsmanager` key, or
   grant the broker role `kms:Decrypt` on your own key. If you keep the token in the macOS
   Keychain, add it with `security add-generic-password -a agentx -s jira-agentx-sa -w "$(pbpaste)"`.
   Never use the interactive `-w` prompt: it keeps only the first 128 characters.
10. **Step 8: Prove the service account sees only its projects (mandatory).** Run this from your
    AgentX checkout after `npm ci && npm run build`. Set `JIRA_PROJECTS` to the project keys
    AgentX may use, comma separated. It reads the token from Secrets Manager, so the token is never
    typed or shown:

    ```sh
    JIRA_TOKEN="$(aws secretsmanager get-secret-value --secret-id agentx/connectors/jira-agentx-sa \
      --query SecretString --output text | jq -r .apiKey)" \
    JIRA_CLOUD_ID='<your cloudId>' JIRA_PROJECTS='PAY' \
    node --input-type=module -e '
    import { connectMcp } from "./packages/gateway/dist/index.js";
    const { JIRA_TOKEN: token, JIRA_CLOUD_ID: cloudId, JIRA_PROJECTS: projects } = process.env;
    const connection = await connectMcp({ endpoint: new URL("https://mcp.atlassian.com/v2/mcp"), token, tools: ["searchJiraIssuesUsingJql"], signal: AbortSignal.timeout(30000) });
    const keys = async (jql) => {
      const result = await connection.call("searchJiraIssuesUsingJql", { cloudId, jql, maxResults: 5 });
      if (result.isError) throw new Error("search failed; check Steps 1, 5 and 7");
      const text = (result.content ?? []).map((part) => part.text ?? "").join("");
      return [...new Set(text.match(/\b[A-Z][A-Z0-9_]+-[0-9]+\b/g) ?? [])];
    };
    try {
      console.log("inside:", (await keys(`project in (${projects})`)).length);
      const outside = await keys(`project not in (${projects})`);
      console.log("outside:", outside.length, outside.join(" "));
    } finally { await connection.close(); }'
    ```

    `inside` must be more than 0. If it is 0, create one issue in the project and run it again,
    so the check can tell an empty answer from a blind one. `outside` must be 0. Any other number
    means the service account can read other projects: go back to Step 4, fix the permission
    schemes it names, and run this again. Do not register the project until `outside` is 0. If you
    skip this, AgentX's own project check is the only thing holding the connector to the project.
11. **Step 9: Register the credential.**

    ```sh
    agentx admin credential register --ref jira-agentx-sa --type static-secret \
      --secret agentx/connectors/jira-agentx-sa
    agentx admin credential list
    ```

    The type must be `static-secret`. Registering a project refuses a Jira connector whose
    reference has another type.
12. **Step 10: Add the connector to the project YAML.**

    ```yaml
    integrations:
      connectors:
        - name: jira
          type: jira
          credentialRef: jira-agentx-sa
          scopes:
            - { alias: pay, cloudId: "<your cloudId>", projectKey: PAY }
          tools:
            - name: searchJiraIssuesUsingJql
              access: read
              description: >-
                Search Jira issues in project PAY with JQL. AgentX adds the project filter
                itself; send only the rest of the query, for example
                status = "To Do" ORDER BY created DESC.
            - name: getJiraIssue
              access: read
            - name: createJiraIssue
              access: write
            - name: addOrEditJiraIssueComment
              access: write
    ```

    `editJiraIssue` and `transitionJiraIssue` may be added too (access `write`). Edits are not
    signed with the footer, because Jira takes the description inside `fields`.
13. **Step 11: Register the project and read the preflight.** Register the revision the usual way
    (`agentx --project <name> admin project register --file <file> ...`). With `--json`, the
    result's `preflight` should read:

    ```json
    {"connectors":[{"name":"jira","status":"connected","offered":["jira__searchJiraIssuesUsingJql","jira__getJiraIssue","jira__createJiraIssue","jira__addOrEditJiraIssueComment"],"skipped":[]}]}
    ```

    Registration is refused if the credential reference is not registered or is not
    `static-secret`. It is not refused if Atlassian rejects the token: preflight shows
    `not_connected` with the reason, and you fix it at Atlassian.
14. **Tools you should not approve.** `getConfluenceContent`, `createConfluenceContent`,
    `updateConfluenceContent`, `searchConfluence`, `getLoomVideo`, `getGraphContext`,
    `getGraphObject`, `addGraphContext`, `search`, `discover`, `executeRead`, `executeWrite`,
    `executeDestructive`, `getAccessibleAtlassianResources`, `atlassianUserInfo`. They reach other
    products or run any Atlassian operation, so AgentX cannot hold them to a project. With
    `projectKey` set, registration refuses them. Without `projectKey`, only the service account's
    permissions stop them.
15. **What AgentX enforces.** `cloudId` and `projectKey` are set by AgentX; the model cannot
    choose them. Searches are rewritten to `project = "<KEY>" AND (<query>)`. Reads and writes by
    issue key first check that the issue is in the project. Issue URLs are refused; the model must
    pass the key. This is a second line behind Step 4. On a site where Step 8 does not print
    `outside: 0`, it is the only line.
16. **Troubleshooting.**
    - **Every call fails as not connected, "rejected the credential twice".** Check, in order:
      API token authentication is on (Step 1); the token is complete (Step 7 length check); the
      token has not expired; the scopes are the five in Step 5.
    - **You used `https://mcp.atlassian.com/v1/...` in another tool and it worked with OAuth but
      not with the token.** v1 ignores API tokens. AgentX always uses
      `https://mcp.atlassian.com/v2/mcp`.
    - **"Cloud id isn't explicitly granted".** You gave AgentX an OAuth token. Use an API token
      (Step 5) and `--type static-secret` (Step 9).
    - **Rotating the token.** Put the new value with
      `aws secretsmanager put-secret-value --secret-id agentx/connectors/jira-agentx-sa --secret-string file:///dev/stdin`
      (same `jq` pipe as Step 7). No re-registration is needed; AgentX re-reads the secret within
      five minutes, or at once after Atlassian rejects the old one.
    - **An expired token** makes Jira calls fail as not connected until you rotate it.

- [ ] **Step 2: Update the other documents**
  - `README.md` "Connector credentials": one paragraph naming Jira, linking
    `docs/connectors/jira.md`, and saying the Jira credential is a `static-secret` API token.
    If phase 5 has not landed, replace the sentence "No connector type reads a registered
    credential yet; Linear is the first, in a later release." with "Jira reads a registered
    `static-secret` API token; see [docs/connectors/jira.md](docs/connectors/jira.md). Registering
    a revision refuses a connector whose `credentialRef` is not registered or has a type the
    connector does not accept." If phase 5 already rewrote it, amend it to name both types and link
    both guides (see Coordination).
  - `contracts/project-config.md`: in the Jira example add `getJiraIssue` and
    `addOrEditJiraIssueComment`; under "Registration outcomes" add three rows:
    "Jira `projectKey` on some scopes only | Refused", "Jira tool AgentX cannot limit, with
    `projectKey` | Refused, naming the tool", "Jira guarded tool with the wrong `access` |
    Refused, naming the tool", "Jira credential reference of another type | Refused, naming the
    type"; in "Mandatory vendor-side restrictions" add "restricted to the intended projects, and
    proven by the setup guide's Step 8: a search outside them returns zero issues".
  - `data-model.md` Jira bindings: `cloudId` (Atlassian site UUID), `projectKey` optional, "on
    every scope of a connector or on none; with `projectKey`, only the six project-guarded Jira
    tools may be approved".
  - `plan.md` phases table: phase 6 row links `plans/phase-6-jira.md`; copy this plan there.
- [ ] **Step 3: Evaluation cases (Ruling 14).** If `tests/eval/cases/` exists, create
  `tests/eval/cases/jira.jsonl` and the fixture project `tests/eval/fixtures/payments-jira.yaml`
  (GitHub plus the Step 1 Jira connector) with these lines; otherwise append the same lines, as a
  "Jira seed cases" block, to `contracts/evaluation.md`:

```json
{ "id": "jira-list-open", "project": "fixtures/payments-jira.yaml", "prompt": "what bugs are open in Jira?", "expect": { "tool": "jira__searchJiraIssuesUsingJql" } }
{ "id": "jira-read-one", "project": "fixtures/payments-jira.yaml", "prompt": "what's the status of PAY-7?", "expect": { "tool": "jira__getJiraIssue", "argsSubset": { "issueIdOrKey": "PAY-7" } } }
{ "id": "jira-create", "project": "fixtures/payments-jira.yaml", "prompt": "create a Jira bug titled Login test is flaky", "expect": { "tool": "jira__createJiraIssue", "argsSubset": { "summary": "Login test is flaky", "issueType": "Bug" } } }
{ "id": "jira-comment", "project": "fixtures/payments-jira.yaml", "prompt": "comment on PAY-12 that the fix is deployed", "expect": { "tool": "jira__addOrEditJiraIssueComment", "argsSubset": { "issueIdOrKey": "PAY-12" } } }
{ "id": "jira-vs-github", "project": "fixtures/payments-jira.yaml", "prompt": "list the open GitHub issues in payments-api", "expect": { "tool": "github__list_issues" } }
```

- [ ] **Step 4: Verify.** Run `npm run typecheck && npm run lint && npm run build && npm test && npm run infra:synth`.
  Grep the new and changed documents for `—` (em-dash): expected no match. Grep for our site name
  and cloudId outside `quickstart.md`: expected no match.
- [ ] **Step 5: Commit**

```bash
git add docs/connectors/jira.md README.md specs/013-connector-gateway tests/eval
git commit -m "docs: jira connector setup guide, contracts and evaluation cases

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Live check against the real KAN project (T037, user-assisted)

Nothing here is inferred from mocks. Part A runs before the PR; Part B after the automatic
production release. Check T037 in `tasks.md` only after Part B's evidence exists.

**Files:**
- Create: `tests/live/jira-live.test.ts`
- Modify: `specs/013-connector-gateway/quickstart.md` (`## Jira (US3)` evidence),
  `docs/connectors/jira.md` (correct any "(verify)" click path), `specs/013-connector-gateway/tasks.md`
  (T035, T036 checked in the PR; T037 after Part B)

- [ ] **Step 1: Write the live test (skipped unless the token is set)**

`tests/live/jira-live.test.ts`, `describe.skipIf(!process.env.AGENTX_LIVE_JIRA_TOKEN)`. It reuses
the Task 4 broker setup with three differences: no `connect` override (the production
`connectMcp` path to `https://mcp.atlassian.com/v2/mcp`), the secret comes from
`AGENTX_LIVE_JIRA_TOKEN`, and `cloudId`/`projectKey` come from `AGENTX_LIVE_JIRA_CLOUD_ID` and
`AGENTX_LIVE_JIRA_PROJECT`. Test timeout 60 seconds. In order it:
1. registers the credential and the project with preflight, and expects `status: "connected"` with
   the four offered tools;
2. searches `status != Done ORDER BY created DESC` and expects SUCCEEDED;
3. creates `AgentX live check <ISO time>` (type `Task`) and expects SUCCEEDED with a
   `<PROJECT>-<n>` key in the text;
4. comments `Live check comment.` on that key and expects SUCCEEDED;
5. reads that key with `getJiraIssue` and expects SUCCEEDED;
6. comments on `ZZZNOPE-1` and expects FAILED `policy_denied` (the issue cannot be read, so the
   guard refuses before any write);
7. sends a call with a model `cloudId` and expects 403;
8. registers a second credential whose secret is the token with its last character removed, and
   expects preflight `not_connected` with "rejected the credential twice".
It writes one evidence line per step to stdout: step, status, issue key, never the token.

Run `npm run build && npx vitest run tests/live/jira-live.test.ts` without the variable: expected
"skipped", suite green.

- [ ] **Step 2: User proves the vendor-side restriction (mandatory before Part A).** The
  `getJiraIssue` shape was captured live on 2026-09-24 and is already the fixture (Task 2), so no
  capture is needed. What is not yet in place is the restriction: on 2026-09-24 the reference
  service account saw other projects (`project != KAN` returned 5 issues). The user:
  1. runs the guide's Step 8 with `JIRA_PROJECTS='KAN'` and records both numbers;
  2. if `outside` is not 0, restricts the service account with the guide's Step 4 and runs Step 8
     again, until `outside` is 0 and `inside` is more than 0;
  3. corrects any Step 4 click path that differed, and records which permission scheme grant had
     to change.
  If `outside` cannot be brought to 0, stop and report to the controller: the guard would then be
  the only boundary on the reference install, and the PR must say so.

- [ ] **Step 3: User runs Part A** (the broker against real Atlassian):

```sh
export PATH=/private/tmp/claude-501/node-v22.20.0-darwin-arm64/bin:$PATH
npm run build
read -rs AGENTX_LIVE_JIRA_TOKEN; export AGENTX_LIVE_JIRA_TOKEN
AGENTX_LIVE_JIRA_CLOUD_ID=1437bb04-4c88-4efd-9d38-658e8febfeba AGENTX_LIVE_JIRA_PROJECT=KAN \
  npx vitest run tests/live/jira-live.test.ts
unset AGENTX_LIVE_JIRA_TOKEN
```

Expected: 1 test passes and prints eight evidence lines. Afterwards the user deletes the created
issue in Jira (or leaves it, noting the key).

- [ ] **Step 4: Record Part A evidence** in `quickstart.md` under `## Jira (US3)`: date, endpoint,
  token length (not the token), site and project, the Step 2 `inside` and `outside` numbers before
  and after the fix, the permission scheme change, the eight
  evidence lines, and the created issue key. Correct any "(verify)" click path in the guide that
  the user found different, and remove the "(verify)" marks the user confirmed.

- [ ] **Step 5: Commit, then open the PR** (T035 and T036 checked in `tasks.md`; T037 not yet)

```bash
git add tests/live/jira-live.test.ts specs/013-connector-gateway docs/connectors/jira.md
git commit -m "test: live jira check against the KAN project, with evidence

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: Part B, after the automatic production release** (the user runs these; no manual
  deployment):
  1. `agentx admin credential register --ref jira-agentx-sa --type static-secret --secret agentx/connectors/jira-agentx-sa`
     (the secret created with the guide's Step 7).
  2. Register a new revision of the test project with the guide's Step 10 connector for `KAN`, read
     the preflight, and bind the Slack channel to it:
     `agentx --project <project> admin slack bind --team <team-id> --channel <channel-id>`.
  3. In a new thread: `@AgentX what's open in Jira?`, then
     `@AgentX create a Jira task titled AgentX Slack live check`, then
     `@AgentX comment on <new key> that this came from Slack`, then
     `@AgentX comment on OPS-1 saying hello` (expect a plain refusal).
  4. Verify in Jira: the issue and comment exist, and both end with the footer naming the Slack
     member. Record the thread link, issue key and replies in `quickstart.md`, check T037 in
     `tasks.md`, and commit as `docs: record jira live check through Slack`.

---

## Self-Review

- **Spec coverage.** US3 scenario 1: Tasks 2 and 4 (case 3). US3 scenario 2: Task 4 (case 2) and
  Task 6 Part A step 8. FR-005 (cloudId strict, project key where the tool has it): Tasks 2 and 4.
  FR-009 (`jira` type added): Task 3. FR-011 (registry, `agentx/connectors/`): Tasks 3 and 5.
  FR-014 (preflight auth failures do not block): Task 4. FR-019 (not connected): Task 3 (OAuth
  record, unregistered ref) and Task 4 (401). FR-024 (attribution): Tasks 2 and 4. SC-002: only
  the type, gateway module, fixtures and guide are added; the engine is not edited (5b owns
  `optionalProperties`, `GuardInput.scope` and `rewrite`). SC-005
  (zero upstream mutation when refused): Tasks 2 and 4 assert no write call on every refusal.
  Mandatory vendor-side restriction: guide Step 8 and Task 6 Step 2 prove it with a zero count.
  Edge case "Jira service-account key expires": guide troubleshooting plus Task 6 step 8.
- **Placeholders.** None intended. The shared pieces (credential refusal, `typeOf`,
  `ResolvedConnector.credential`, the `githubConnectorOf` predicate, README sentence, quickstart
  title) are deliberately conditional on landing order, and the Coordination table says exactly
  what to do either way.
- **Type consistency.** `JiraScope`, `jiraConnector(credentials, { projectScoped })`,
  `jiraProjectGuard`, `limitJqlToProject`, `JIRA_MCP_ENDPOINT`, `JIRA_PROJECT_TOOL_ACCESS`,
  `jiraConnectorType`, `credentialRefusals`, `CredentialRegistry.typeOf`,
  `ResolvedConnector.credential`, and 5b's `optionalProperties`, `GuardInput.scope`, `rewrite` and
  `RewriteInput` are named the same in every task and in the phase 5 plan.
- **Review Focus.** Each of the five lines has its test in Task 1, 2, 3, 4 or 6.
