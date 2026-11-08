# Implementation Plan: Channel Adapters

**Spec**: [spec.md](./spec.md) · **Issue**: #423

Each phase is one PR to `mainline` and leaves Slack working.

| Phase | Delivers | Spec |
|---|---|---|
| 1 | Neutral conversation, actor and inbound-message model; Slack keys unchanged | FR-001–006 |
| 2 | Neutral bindings; access checks and rate windows read them | FR-010–011 |
| 3 | Adapter registry, channel API, signed events, account linking, step-up | FR-020–033 |
| 4 | Orchestrator and commands without Slack; Slack API calls behind one adapter module | FR-040–042 |
| 5 | Slack adapter on the protocol; channel routes; `agentx channel add/bind` | FR-050–051 |
| 6 | WhatsApp adapter | FR-052 |

## Phase 1: neutral model (this branch)

| Layer | Change |
|---|---|
| contracts | `conversation.ts`: `ChannelIdSchema`, `ConversationRefSchema`, `ActorRefSchema`, `InboundMessageSchema`; `conversationSubject`, `parseConversationSubject`, `conversationOwnerIssuer`; Slack conversions both ways; `readSlackRequestMessage`. |
| slack-service | `consumer.ts` reads a queued body with `readSlackRequestMessage`, so a Slack `version: 2` message runs exactly as `version: 1`, and another channel's message is discarded. |
| tests | `tests/unit/conversation.test.ts`: Slack subjects and owner issuers equal today's; round trips; refusals. `tests/integration/slack-service.test.ts`: a `version: 2` Slack message is handled, a WhatsApp one is discarded. |
| constitution | 4.1.0 → 5.0.0: Principles I, II, III and VI admit channel adapters (see the spec's Constitution section). `tests/contract/constitution.test.ts` pins the new wording. |

### Decisions

- **Slack keeps its exact keys.** A Slack subject stays three segments and its owner issuer stays
  `slack-thread`, so no DynamoDB row, workspace owner key or S3 session path moves. Other channels get four
  segments, so a subject's channel is known from its shape.
- **IDs are opaque but bounded.** `/` is refused so subjects split unambiguously. The character set covers
  phone numbers (`+`), emails (`@`) and base64url IDs (`=`, `-`, `_`).
- **The queue keeps accepting `version: 1`.** The consumer reads both versions. Slack ingress keeps writing
  `version: 1` until Phase 5, when Slack goes through the channel API: switching earlier gains nothing, and an
  ingress deployed before the consumer would discard Slack messages.
- **`slack.ts` does not delegate to `conversation.ts`.** `conversation.ts` imports the Slack schemas, so
  delegation would be an import cycle. The tests prove the two produce the same subject instead.

### Rollback

Phase 1 changes no stored data and no wire format, so reverting the PR is enough.

## Phase 2: neutral bindings

| Layer | Change |
|---|---|
| contracts | `channel-binding.ts`: `ChannelSpaceRefSchema`, `ChannelBindingSchema`; `channelBindingKey`, `channelBindingPartition`, `channelBindingSortPrefix`, `channelBindingAttributes`, `readChannelBindingItem`, `isChannelBindingKeyOf`; Slack conversions both ways. |
| broker | Every `SLACK_BINDING#` / `CHANNEL#` key now comes from the helpers: `broker.ts` (put, get, delete, developer channel access), `slack-ingress.ts`, `admin-reads.ts`, `admin-change-plans.ts`, `dispatcher.ts`, `developer-routes.ts`, `task-dispatch-access.ts`, `task-person-invite-authority-fence.ts`, `developer/task-project-access.ts`. `getChannelBinding` reads any channel's binding; `getSlackBinding` goes through it. |
| tests | `tests/unit/channel-binding.test.ts`: Slack keys, prefixes and stored attributes equal today's; other channels' keys; refusals. The existing binding contract tests pass unchanged. |

### Decisions

- **Slack rows keep `teamId` and `channelId` and entity type `SLACK_BINDING`;** other channels store `channel`,
  `tenant`, `space` with entity type `CHANNEL_BINDING`. No row moves.
- **A Slack query partition never throws.** An unset `SLACK_TEAM_ID` finds nothing, as today. Another
  channel's tenant must be a valid ID, so `BINDING#<channel>/<tenant>` cannot be forged with `/`.
- **Row integrity checks never throw** (`isChannelBindingKeyOf`); a malformed row is a mismatch, as today.
  Reading a malformed row still throws, as `getSlackBinding` did, so a corrupt row is not "not bound".
- **IAM is unchanged.** The broker and ingress may read only `SLACK_BINDING#*`; `BINDING#*` is granted in
  Phase 3, when the channel API can create the first non-Slack binding.
- **Developer channel access stays Slack-only** (FR-011).

### Rollback

No stored data or wire format changes; revert the PR.
