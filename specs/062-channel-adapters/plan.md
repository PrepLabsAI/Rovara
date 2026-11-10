# Implementation Plan: Channel Adapters

**Spec**: [spec.md](./spec.md) · **Issue**: #423

Each phase is one PR to `mainline` and leaves Slack working.

| Phase | Delivers | Spec |
|---|---|---|
| 1 | Neutral conversation, actor and inbound-message model; Slack keys unchanged | FR-001–006 |
| 2 | Neutral bindings; access checks and rate windows read them | FR-010–011 |
| 3 | Adapter registry, channel API, signed events, account linking, step-up | FR-020–033 |
| 4a | Adapter conversations run end to end: broker identity and charging, channel consumer, events, decisions, step-up | FR-035–038 |
| 4b | Orchestrator and commands without Slack; Slack API calls behind one adapter module | FR-040–042 |
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

## Phase 3: channel API, events, linking

Off by default: the control-plane parameter `ChannelAdapters` (`enabled` | `disabled`, default `disabled`). Disabled, the
broker serves no adapter routes and the channel API answers 404 to everything. Named environments only, since linking
needs developer sign-in.

| Layer | Change |
|---|---|
| contracts | `channel-adapter.ts`: registration, capabilities, step-up, decision, the nine event types, the queued item; Standard Webhooks `signWebhook` / `verifyWebhook` (checked against the published test vector); link codes, link keys, `maskChannelUserId`. |
| broker: registry | `channel-adapters.ts`: `PUT/GET/DELETE /v1/admin/channels[/{channel}]`, `PUT/DELETE /v1/admin/channels/{channel}/bindings/{tenant}/{space}`. The record is written on a condition, then the signing secret to Secrets Manager, returned once; `?rotate=true` replaces it; delete overwrites it first. |
| broker: linking | `channel-links.ts` (codes and links in the state table), `channel-link-web.ts` (`/review/link/<code>`: sign in, confirm naming channel and masked user ID, CSRF-checked form post), `GET/DELETE /v1/dev/channel-links`, `DELETE /v1/admin/channel-links/...`. Browser sign-in accepts `/review/link/<code>` as a return path. |
| channel API | `channel-ingress.ts`: `POST /v1/channels/{channel}/messages` and `/decisions`. Checks in order: known adapter, readable secret, signature and timestamp, `webhook-id` replay, body schema, path channel = body channel, actor tenant = conversation tenant, space bound to one of the adapter's projects, adapter event ID not seen, actor linked. Accepted items go to a FIFO queue grouped by conversation; a message gets an `ack`. |
| events | `channel-events.ts`: signs and posts each event to the callback URL; resolves the host and refuses non-public addresses; no redirects; text cut to `maxTextLength`; no actions on a stepped-up kind. 408/429/5xx and network errors retry with a growing delay (10 s doubling, at most 15 min), then the dead-letter queue (8 receives) and its alarm. |
| infra | `infra/lib/channel-adapters.ts`: the `ChannelState` table (claims, expired by `expiresAt`), the request FIFO queue and its DLQ, the event queue and its DLQ, both Lambdas, the two routes (no authorizer: the Lambda verifies the signature), the alarm, and least-privilege grants. |

### Decisions

- **Queued, not yet run.** Accepted messages and decisions wait in the request queue; its consumer is Phase 4, when
  the orchestrator stops needing Slack. The flag stays `disabled` until then.
- **Step-up is enforced where a decision is applied (Phase 4).** Only the core knows authoritatively which kind of
  request a decision answers. Phase 3 already strips approve actions from stepped-up kinds before an event leaves
  (`fitEventToAdapter`), and `adapterMayDecide` is the check Phase 4 applies.
- **Claims are released on failure.** A transient failure frees the `webhook-id`, event ID and link-notice claims, so
  the adapter's retry runs. A failed `ack` is logged, not failed, so a queued message is never queued twice.
- **Link codes live in the state table,** expiring on its existing `indexExpiresAt` TTL, because the broker's role
  policy is near IAM's inline size limit: a statement for another table pushed CDK into an overflow managed policy,
  which the deploy role may not create. The broker gets one new statement (create and write adapter secrets, under
  `agentx/<env>/channel-adapter/*`, apart from connector secrets).
- **A link is never replaced silently.** Redeeming a code for an actor already linked fails; the old link must be
  removed first, by its developer or an administrator.
- **New Lambdas need a CDK deploy.** `scripts/test-deploy.ts` lists them, so a code-only TEST deploy moves them once
  they exist; the recorded change-set fixture predates them and is judged against the Lambdas it was recorded with.

### Rollback

Leave or set `ChannelAdapters` to `disabled`. Reverting the PR removes the resources; `ChannelState` holds only
expiring claims, and adapter, binding and link rows in the state table are inert without the code.

## Phase 4a: adapter conversations run

The `ChannelAdapters` parameter still gates everything. Enabled, the orchestrator also reads the channel request queue.

| Layer | Change |
|---|---|
| broker | `channel-conversation.ts`: the service routes accept `x-agentx-conversation` (a four-segment subject) and `x-agentx-actor`, and check the adapter, a binding to one of its projects, the link and an active developer on every call. The identity's `channel` replaces `slack` on the routes a conversation uses: workspace ensure (lazy only), prepare, retry, close, models, connectors, task operations. A thread's charge goes through `threadCharging`: Slack's counters as before, or the linked developer's (`developerCharge`), stored on the thread record with the conversation's marker in the counter's `tasks` set. `failed-preparation.ts` gives an adapter conversation's charge back. |
| orchestrator | `processor.ts` is generic over the thread type; `channel-requests.ts` runs queued items through it, posts replies as `message` events, confirmations as `approval_request` events, and a `done` marker. `consumer.ts` takes the body reader. `main.ts` runs the channel consumer beside the Slack one when both queue URLs are set. |
| confirmations | A decision answers like a click, and only when its digest matches the confirmation's calls; `mayApprove` refuses an `admin` confirmation, by decision or reply, on an adapter that steps `admin` up. Requester IDs accept adapter user IDs. |
| contracts | `message` event; `done` without required text; `approval_request.taskUrl` optional; queued items carry the adapter's `stepUp` (default: every kind). |
| infra | The orchestrator role consumes the request queue and sends to the event queue; the control plane outputs both URLs; the orchestrator stack takes them as optional parameters; `ChannelRequestDeadLetters` alarm, which the health probe reads (the queue itself is not added to the broker's queue reads: one more ARN overflows its policy). |

### Decisions

- **The broker trusts the queue less than the ingress did.** The orchestrator role could name any conversation, so
  every call re-checks the adapter, binding, link and developer. An unlink or removal stops the next call.
- **One person, one allowance.** A linked developer with a Slack identity shares that member's counter (R6), so
  WhatsApp is not a second quota.
- **Records keep their keys.** An adapter conversation's thread record lives at `SLACK_THREAD#<ownerKey>` with entity
  type `CHANNEL_THREAD`, so the readers that skip non-Slack subjects (admin owner, unwaited tasks, stuck cancels) need
  no change; renaming the key would move every Slack row.
- **Replies are queued as they are said.** Each post is a `message` event on the queue before the processor counts it
  said, so a crash loses nothing; `done` is only a marker and a failure to queue it is logged.
- **Text is converted at the edge until 4b.** The core still writes Slack markup; `plainText` drops mentions, shows
  link addresses and undoes escapes. The model is not told to write Slack markup for an adapter turn.
- **No progress notes or Details buttons for adapters yet.** Both need edits and turn records, which adapters do not
  have in 4a.

### Rollback

Leave `ChannelAdapters` disabled, or revert: the orchestrator ignores the channel queues when their parameters are
empty. A revert after adapter conversations were prepared leaves their workspace charges held, since only this code
gives them back; close those workspaces first.

## Phase 4b: the core names no surface

| Layer | Change |
|---|---|
| orchestrator | The classifier prompt, the gate's block reason and the close instruction say "conversation", not "Slack thread". `slackSafe` is `inertText` (entity-escaped, so a summary carries no mention or link anywhere). `ReplySurface` is `"slack"` or `"plain"`; `PLAIN_REPLY_INSTRUCTIONS` asks for plain text and full URLs. |
| orchestrator service | `conversation-format.ts`: `SLACK_FORMAT` and `PLAIN_FORMAT` (escape, reply, split, mention, and the words for "this thread", "mention me again", "reply yes"). The processor, confirmations, workspace messages, the lazy worker and the model commands write through the format; Slack's texts are unchanged. The channel consumer uses `PLAIN_FORMAT`, and Phase 4a's `plainText` converter is gone. `slack-web.ts` holds every Slack Web API call the service makes. |
| broker | `slackWebFetch` in `slack-web.ts` is the one transport; ingress, interactivity, member lookup and the directory call through it, each keeping its own error handling. |

### Decisions

- **Slack's texts are pinned, not rewritten.** Each text is a function of the format, and Slack's constants are that
  function with `SLACK_FORMAT`, so the existing Slack tests prove the texts did not move.
- **Confirmation summaries stay entity-escaped in storage.** They are made inert once, by the gate; Slack shows the
  entities as characters and the plain format unescapes them.
- **Slack-only paths keep Slack words.** Shared tasks, task answers, SWE-bench and eval batches never reach an adapter
  conversation (FR-038), so their texts are unchanged.
- **Schemas stay.** Slack types in the broker and processor go when Slack itself is an adapter (Phase 5).

### Rollback

No stored data or wire format changes; revert the PR.

