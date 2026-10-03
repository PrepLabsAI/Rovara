# Feature Specification: Generic MCP Connectors

**Feature Branch**: `feat/055-generic-mcp-connectors`
**Created**: 2026-10-03
**Status**: Phase 1 implemented on `feat/055-generic-mcp-connectors`; Phases 2 and 3 not started
**Issue**: #275 (covers #138 design needs 2 and 4)
**Input**: "How do we allow AgentX to connect to any external provider without writing any additional code in the
main repository?" Clarified on 2026-10-03: build a generic connector type and port Linear, Jira and Asana onto
it. Each existing vendor becomes a preset. Linear's guard becomes a declarative rule. Jira's and Asana's guards
stay as reviewed code, referenced by name.

## Why

Every connector already talks to its vendor over MCP (spec 013). The gateway engine, catalog, approvals, action
gate (spec 014), ledger and credential registry don't depend on the vendor. Each vendor still costs a config
schema, a `ConnectorType` resolver, a gateway definition (endpoint, binder, guard), an OAuth profile and a CLI
wizard. #138 lists 18 vendors that would each need that work.

The only part that needs real code is the scope guard, which keeps a call inside the project's team, site or
project when the credential reaches further. Everything else is data.

## User Scenarios

### An administrator connects Sentry with no AgentX release (Priority: P1)

The administrator:
1. creates a Sentry token;
2. stores it as `agentx/<env>/connectors/sentry`;
3. registers it with `agentx admin credential register --ref sentry-bot --type static-secret --secret-name … --host mcp.sentry.dev`;
4. registers a project revision containing a `type: "mcp"` connector.

Registration preflight lists the offered tools, and the Slack orchestrator can then use `sentry__get_issue_details`.

### An administrator scopes a generic connector to one team (Priority: P1)

The token reaches every team, but the project should only touch one. The connector's `scoping` is an
`ownership` rule. Before a call that names an existing item, the broker reads that item with the vendor's own
read tool and refuses the call unless the item's team equals the scope's team. This is exactly what Linear's
guard does today.

### A connector entry is edited to point somewhere else (Priority: P1)

An administrator, or a compromised admin session, changes a connector's `endpoint` to another host. The
credential is pinned to `mcp.sentry.dev`, so the broker reports the connector as not connected, and the token is
never sent to the new host.

### Existing projects keep working (Priority: P1)

Registered projects with `linear`, `jira` and `asana` connectors behave exactly as before: same tools, same
schema hashes, same guard refusals and same preflight. The only change is underneath: they now resolve through
the generic path.

## Requirements

### The `mcp` connector type

- **FR-001:** `ConnectorConfigSchema` accepts `type: "mcp"` with these fields:
  - `name`, `tools` and `attribution`, as for every connector.
  - `endpoint`, `label` (1–64), `vendor` (1–32), `scopeNoun` (1–32, default `scope`), `credentialRef`.
  - Optional `auth`, `bind`, `itemArguments`, `attributionKeys` and `permissionsHint`.
  - `scopes`: 1 to 32 entries of `{ alias, values }`. `values` maps 1 to 16 names to strings of up to 256
    characters. A name matches `^[A-Za-z_][A-Za-z0-9_]{0,63}$` and is never `alias`.
  - `scoping`: required (FR-006).
- **FR-002:** `endpoint` must be an `https:` URL with no username, password, query or fragment. Its host must be
  a DNS name with at least one dot. IP literals, `localhost`, and names ending in `.localhost`, `.local`,
  `.internal`, `.localdomain` or `.home.arpa` are refused.
- **FR-003:** `auth` sets how the token is sent: `{ header?: string, prefix?: string }`, defaulting to
  `Authorization` and `Bearer ` (with the space).
  - `header` is a token of 1–64 characters. It is never a header the transport owns: `host`, `content-type`,
    `content-length`, `accept`, `connection`, `transfer-encoding`, `cookie`, `mcp-session-id`,
    `mcp-protocol-version` or `x-mcp-tools`.
  - `prefix` is up to 32 printable ASCII characters. It covers `Token token=` (PagerDuty) and a raw key (`""`).
- **FR-004:** `bind` is `{ required?: { <argument>: <valueName> }, optional?: { <argument>: <valueName> } }`.
  Each value name must appear in every scope's `values`, and no argument may appear in both maps. Required
  arguments follow `Binder.properties` and optional ones `Binder.optionalProperties` (spec 013). The model never
  sees or sets a bound argument.
- **FR-005:** The runtime scope object is `{ alias, ...values }`, which is what guards and the binder read. The
  presets build the same object their types build today, so tool schema hashes do not change.

### Scoping

- **FR-006:** `scoping` is one of two modes.
  - **`{ mode: "credential", acknowledgeUnscopedWrites?: true }`**: no guard, so the credential's own reach is
    the scope. Approving any `write` tool requires `acknowledgeUnscopedWrites: true`.
  - **`{ mode: "ownership", … }`**: a declarative rule (FR-007).
- **FR-007:** An ownership rule has these fields:
  - `itemNoun` (and optional `itemNounPlural`): words for messages, such as `issue`.
  - `references`: per tool, 1 to 16 reference paths naming existing items. A reference path is an item path
    (spec 014). It may end in `[]` for a list of IDs.
  - `lookup: { tool, argument, arguments? }`: the read tool, the argument the ID goes in, and any constant extra
    arguments.
  - `field`: a reference path into the lookup result, parsed as JSON. When it ends in `[]`, any element may
    match.
  - `equals`: the scope value name the field must equal.
  - `caseInsensitive?`.
  - `parent?: { field, maxDepth: 1–3 }`: walk up to a parent item when the item itself does not match.
  - `maxLookups?`: 1–10, default 10.
  - `refuse?`: up to 32 entries of `{ tool, argument, equals?, message }`.
  - `require?`: up to 16 entries of `{ tool, argument, message }`.
  - `targetArguments?`: argument names for the spec 014 / #49 preflight warning. The default is the first step
    of every reference path.

  Messages may use `{alias}`, `{argument}`, `{tool}` and `{vendor}`.
- **FR-008:** The ownership guard fails closed:
  - Each referenced ID must be a non-empty string of at most 128 characters. Null or an empty list means no
    reference, and anything else refuses the call.
  - IDs are de-duplicated without regard to case.
  - More than `maxLookups` IDs, or lookups including parents, refuses the call.
  - A lookup error, unparsable JSON, a missing field, or a parent field that is not an ID refuses the call.

  Every refusal is a `GuardRejection`. The standard messages use the vendor, item noun, alias and scope noun, and
  match Linear's existing wording.

### Credentials and endpoints

- **FR-009:** A credential registration may carry `host`, a lowercase DNS name. The CLI's
  `admin credential register` and admin change plans accept `--host`.
  - An `mcp` connector requires its credential's `host` to equal the endpoint's host. Otherwise it is
    `not_connected`, with a message naming the command that fixes it.
  - A preset connector whose credential carries a different `host` is refused the same way. A preset whose
    credential has no host is unchanged.
  - The check runs when the token is issued, not only at resolution time.
- **FR-010:** Before connecting, an `mcp` connector resolves its endpoint host and refuses, as not connected,
  when any address is loopback, private (RFC 1918, ULA), link-local (including 169.254.169.254), CGNAT,
  unspecified, multicast or reserved. Redirects stay refused (spec 013).

  The residual risk is DNS rebinding between this check and the connection, because the transport resolves the
  name again. That is recorded as a follow-up.
- **FR-011:** Phase 1 `mcp` connectors accept `static-secret` credentials only. OAuth (`oauth-refresh-token`,
  `oauth-client-credentials`) arrives in Phase 2, with the token URL stored on the credential record (FR-013).

### Port

- **FR-012:** Linear, Jira and Asana keep their stored config schemas and become presets. A preset is a mapping
  from the validated stored config to the generic connector description: label, vendor, scope noun, scopes,
  endpoint, binder spec, guards, credential types, token endpoint, approvals and messages. One generic resolver
  serves every preset and the `mcp` type.
  - Linear's `issueInTeamGuard` is an ownership rule.
  - Jira's and Asana's guards are referenced as code.
  - Every existing contract test passes unchanged, except tests that list the schema's types (they gain `mcp`).

### Phase 2 and 3 (not in this change)

- **FR-013:** `agentx admin credential authorize --endpoint <url>` discovers OAuth endpoints (RFC 9728, then RFC
  8414) and optionally registers a client (RFC 7591). It stores `tokenUrl` and `host` on the credential, and the
  broker refreshes against the record's `tokenUrl`.
- **FR-014:** `agentx connector add mcp` connects, lists tools, picks tools and access, and runs preflight.
  `doctor` checks `mcp` connectors, and `docs/connectors/custom-mcp.md` explains setup.

## Success Criteria

- **SC-001:** The existing connector contract and integration tests pass with only the type-list change.
- **SC-002:** An `mcp` connector with an ownership rule reproduces every Linear guard test outcome.
- **SC-003:** An `mcp` connector whose credential host differs from its endpoint host never calls the endpoint.
- **SC-004:** A live Sentry or PagerDuty connector works from Slack without code changes (recorded in the PR,
  after Phase 2 or 3 as needed).
