# Feature Specification: Channel adapters in production

**Feature Branch**: `claude/064-production-adapters`
**Created**: 2026-11-12
**Status**: Draft
**Input**: "Let's go with 1": give the production deployment (the legacy, unnamed stacks) what third-party channel
adapters need, rather than moving production to a named environment.

## Why

Channel adapters (spec 062) only work in a named environment. A person links their chat identity by signing in, and
developer sign-in (spec 025) was built for named environments only. Production is the legacy deployment
(`AgentXControlPlane` and the other fixed-name stacks), so it has no sign-in, no adapter registry and no admin-change
routes. It runs only the built-in Slack adapter. Nothing in the adapter code needs a name; only these missing parts
block it.

## User scenarios

1. **An administrator turns adapters on in production.** They set `ChannelAdapters=enabled` on `AgentXControlPlane`.
   Until then, production behaves exactly as it does today.
2. **An administrator registers and binds an adapter.** `agentx --env production adapter add whatsapp …` and
   `adapter bind …` work against production, as admin changes other administrators can see.
3. **A person links their account.** The first message from them in a bound space gets a one-time link. They sign in
   with the company login (production's Cognito pool) and confirm. Their next message runs.
4. **An adapter drives a conversation.** It receives typed events (#438) and reads a conversation's state (#437).

## Requirements

- **FR-001 (sign-in):** the legacy deployment gets developer sign-in with company login (OIDC). It uses the legacy
  names (`alias/agentx/developer-tokens`, `agentx/production/developer-oidc`). Slack sign-in stays off.
  Its stack parameters default to off, so a release without them changes nothing people can use.
- **FR-002 (registry):** the legacy deployment gets the adapter registry and account linking, behind `ChannelAdapters`
  (default `disabled`). While disabled, the channel API answers 404 for every channel but the built-in Slack adapter.
- **FR-003 (admin changes):** the admin-change routes the adapter commands use work in the legacy deployment, for the
  adapter changes only (`register_channel_adapter`, `remove_channel_adapter`, bindings and unlink). Other admin-change
  kinds still refuse there as they do today.
- **FR-004 (CLI):** `agentx --env production adapter …` works against the adopted legacy deployment.
- **FR-005 (no spill-over):** the task workflow, task notifier, ChatGPT sign-in and the other named-environment parts
  stay out of the legacy deployment. Nothing in production is removed or replaced.
- **FR-006 (proof):** a test adapter registered in production exercises linking, a message, typed events (#438) and
  the conversation-state read (#437).

## Security considerations

- **New public surface:** the sign-in routes (`/v1/auth/*`) and the link page become reachable in production. They are
  the same code that named environments already run, with the same PKCE, state and code checks.
- **Who can link:** only people with a company-login account. In production that means users in the Cognito pool,
  which an administrator adds. There is no self-service sign-up.
- **Who can administer:** admin changes need a company-login token that carries the admin claim (`cognito:groups`
  containing `agentx-admin`). This is the rule production's admin API already uses.
- **Adapter secrets:** they live in Secrets Manager under `agentx/production/channel-adapter/<id>`, and are shown once
  at registration, as in named environments.
- **Fails closed:** if sign-in is unset, `ChannelAdapters` is disabled, or a person is unlinked, a message does not run.
- **Broker IAM:** new grants are scoped to the registry and link partitions, as in named environments. The broker's
  inline policy has room: about 3.8k of 10.2k characters are used today.

## Out of scope

- Slack sign-in in production: it needs a redirect URL added to the production Slack app.
- The task workflow and other named-environment features in production.
- Moving production to a named environment.
