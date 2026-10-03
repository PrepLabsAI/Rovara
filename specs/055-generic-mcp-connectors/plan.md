# Implementation Plan: Generic MCP Connectors

**Spec**: [spec.md](./spec.md) · **Issue**: #275

## Phase 1: generic runtime and port (this branch)

| Layer | Change |
|---|---|
| contracts | `mcp-connector.ts`: endpoint rules, `McpAuthSchema`, reference paths, `OwnershipRuleSchema`, `DnsHostSchema`. `connectors.ts`: `McpConnectorSchema` in `ConnectorConfigSchema`. `credentials.ts`: optional `host` on a registration. `admin-changes.ts`: optional `host` on `register_credential`. |
| gateway | `generic.ts`: `genericBinder`, `ownershipGuard`, `ownershipGuardedTools` and `mcpConnector`. `endpoint.ts`: `isPublicAddress` and `checkEndpointAddresses` (FR-010). `mcp-client.ts`: configurable auth header and prefix. `engine.ts`: `verifyEndpoint` runs before a credential is issued, and `auth` is passed to connect. `linear.ts`: the guard is `LINEAR_OWNERSHIP`, and the exports keep their names. |
| broker | `connector-presets.ts`: `presetConnectorType` and the `mcp` preset. The `linear`, `jira` and `asana` connector-type files are now preset descriptions. `credentials.ts`: `HostPin` and `hostPinProblem`, checked inside `provider().issue`. `registration-preflight.ts`: pin refusals at registration. |
| cli / mcp | `admin credential register --host`, and a `host` input on `agentx_admin_register_credential`. |

### Decisions

- **Linear only becomes data.** Jira's JQL rewrite and relation-field walk, and Asana's item shape checks and
  parent-removal rule, are not expressible without a policy language that would itself need review. They stay
  as named code guards behind their presets.
- **Pins on presets are optional.** Requiring them would break every registered Linear, Jira and Asana
  credential. A pinned credential is enforced on every connector.
- **IDs are de-duplicated without regard to case only when the rule is `caseInsensitive`.** Otherwise two IDs
  differing in case are both checked, because merging them would leave one unchecked.
- **Unusable-entry reasons** now append schema rule messages for every preset, as Jira and Asana already did,
  capped at 300 characters.

### Rollback

- An older broker parses credential records strictly, so it reads a record with `host` as invalid and treats it
  as not registered. Before rolling back, re-register pinned credentials without `--host`; generic connectors
  stop working either way.
- A stored `type: "mcp"` connector passes through `StoredConnectorConfigSchema` as an unknown type and is skipped
  with `connector.type_unknown`.

### Known gaps (follow-ups)

- **DNS rebinding.** The transport resolves the endpoint again after `checkEndpointAddresses`. Closing this
  needs a dispatcher that connects to the checked address, such as an undici `Agent` with a `connect.lookup`
  hook. That would be a new dependency.
- **`agentx doctor` and `agentx destroy`** do not know `mcp` connectors yet (Phase 3).

## Phase 2: generic OAuth (`feat/055-generic-oauth`, stacked on Phase 1)

| Layer | Change |
|---|---|
| contracts | Credential registrations and records gain `tokenUrl` and `resource`, for OAuth types only. `publicHttpsUrlProblem` is shared with endpoints. `OAuthRefreshTokenSecretSchema.clientSecret` is optional, for public clients. `register_credential` accepts `tokenUrl` and `resource`. |
| gateway | The refresh provider sends `resource` and omits `client_secret` when the secret has none. |
| broker | `buildProvider` uses the type's token endpoint, else the record's `tokenUrl`, and refuses a mismatch (`tokenUrlProblem`). The preset resolver reports a missing token URL for an `mcp` OAuth credential. `MCP_PRESET.accepts` covers all three registrable types. |
| cli | `oauth-discovery.ts` handles discovery (RFC 9728 and RFC 8414) and client registration (RFC 7591). `authorize --endpoint`, `--authorize-url`, `--token-url`, `--scope` and `--register-client`. `register --token-url` and `--resource`. |

### Decisions

- **Public clients are allowed.** Many MCP servers' dynamic registration issues no secret. PKCE protects the
  sign-in, and the refresh token is the grant. An empty `clientSecret` is still refused.
- **The Asana flow is byte-for-byte unchanged.** Its token exchange and refresh still send no `resource`; only
  generic sign-ins do.
- **Discovered URLs are kept exactly as the server spelled them.** Issuer and resource comparisons are exact, and
  URL normalisation would add a trailing slash.

### Known gaps

- Token URLs are not address-checked at refresh time. The schema still refuses IP literals and local names. An
  administrator sets the token URL at registration, never through the connector config.
- A client registered with `--register-client` is left behind if the sign-in then fails. Most servers expire
  unused clients.
- `oauth-client-credentials` on `mcp` connectors works through `register --token-url`. Nothing discovers it
  (there is no browser step).

## Phase 3: admin experience (`feat/055-mcp-admin-experience`)

| Layer | Change |
|---|---|
| gateway | `connectMcp` takes `tools: "all"` for a full listing, and sends no `X-MCP-Tools` header then. |
| contracts | A generic scope may carry no values (0 to 16), for a connector with nothing to bind. |
| cli | `setup/connectors/mcp.ts` is the wizard (FR-014), with `connector add mcp` in `setup/cli.ts`. `vendors.ts` gains `mcpTools` and `oauthAccessToken`. `doctor/connectors.ts` gains mcp checks (FR-015). |
| docs | `docs/connectors/custom-mcp.md`, linked from `project-configuration.md` and the README. |

### Decisions

- **No browser is opened for an OAuth sign-in**, as for Asana. The engineer opens the address in a private
  window as the bot.
- **The credential reference is `mcp-<name>`**, so an mcp connector named `linear` never overwrites the
  Linear connector's secret.
- **Ownership rules come only through `--config-file`.** A rule is a reviewed document, not something to
  build answer by answer in a prompt.

### Remaining

- A live smoke test (SC-004) against a real server, with an API key and with OAuth discovery, then a Slack
  call.
