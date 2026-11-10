# Feature Specification: Channel Adapters

**Feature Branch**: `claude/062-channel-adapters`
**Created**: 2026-11-08
**Status**: Phases 1–2 merged (#424), Phase 3 merged (#425), Phase 4a merged (#426), Phase 4b merged (#427); Phase 5a in progress
**Issue**: #423
**Input**: "We need a way to trigger Rovara through a third-party trigger, like Slack today. I should be able to
do it through WhatsApp or anything, as long as it conforms to the protocol through a lightweight adapter."
Clarified on 2026-11-08: unknown adapter users must link to a Rovara sign-in first; only administrators
register adapters; sensitive actions can require a signed-in click on the task page.

## Why

Slack is not just a trigger. Its IDs are the core's keys:

| Concept | Today |
|---|---|
| Conversation | `SlackThread {teamId, channelId, threadTs}`, stored as subject `T…/C…/ts` |
| Workspace owner | `ownerKeyForSubject("slack-thread", subject)` |
| Person | `SlackRequester {teamId, userId}`, also the connector gateway's `Actor` |
| Project binding | `SLACK_BINDING#<team>` / `CHANNEL#<channel>` |
| Queued request | `SlackRequestMessageSchema` (`version: 1`, Slack `Ev…` event ID) |
| Replies | Slack Web API calls from `slack-service` and the broker |

A second surface means copying all of it. This feature puts a neutral model and a small protocol between the
surfaces and the core, and makes Slack the first adapter.

```
WhatsApp / Slack / … adapter
   │ POST message, POST decision            ▲ signed events
   ▼                                        │
channel API ──► request queue ──► orchestrator / broker / worker (no Slack types)
```

## User Scenarios

### A team starts a task from WhatsApp (Priority: P1)

An administrator registers a WhatsApp adapter and binds a WhatsApp group to project `web`. A linked member
writes "fix the navigation bug" in the group. The adapter posts it to the channel API. Rovara runs the task
exactly as it would from a Slack thread, and the adapter receives `ack`, `progress`, `approval_request`,
`check_report`, `pr` and `done` events and renders them as WhatsApp messages.

### An unknown user writes to an adapter (Priority: P1)

A WhatsApp number that no one has linked writes to a bound group. Rovara runs nothing and sends a
`link_required` event carrying a one-time sign-in link. The person opens it, signs in with the company login
and confirms "Link WhatsApp +91 ••• 4821 to your account". Their next message runs.

### Plan approval from an adapter (Priority: P1)

A plan is waiting for its owner. On a channel whose adapter is set to require step-up for plan approval, the
`approval_request` event carries the task page link and no approve action; the owner approves on the task page.
On other channels, the adapter posts the decision and the core records it once, as for Slack buttons and the
task page today.

### Slack keeps working (Priority: P1)

Existing Slack threads, workspaces, bindings and in-flight requests behave exactly as before, through every
phase. A thread started before the change resumes its workspace after it.

## Requirements

### Neutral model (Phase 1)

- **FR-001:** A `ConversationRef` is `{ channel, tenant, space, thread }`.
  - `channel` matches `^[a-z][a-z0-9-]{1,31}$`. `slack` is reserved for the built-in Slack adapter.
  - `tenant`, `space` and `thread` are 1–128 characters from `[A-Za-z0-9._:+@=-]`. `/` is never allowed, so
    a subject splits unambiguously.
  - For `slack`, `tenant` is the team ID, `space` the channel ID and `thread` the thread timestamp, each
    checked with the existing Slack schemas.
- **FR-002:** A conversation's subject is `<tenant>/<space>/<thread>` for `slack`, the exact string
  `slackThreadSubject` returns today, and `<channel>/<tenant>/<space>/<thread>` for every other channel.
  Parsing a subject returns the same reference. Three segments mean Slack; four mean another channel.
- **FR-003:** A conversation's workspace owner issuer is `slack-thread` for `slack`, so every existing owner
  key is unchanged, and `channel-thread:<channel>` for every other channel. Neither can equal an OIDC issuer,
  which is an `https:` URL.
- **FR-004:** An `ActorRef` is `{ channel, tenant, userId }`, with `userId` under FR-001's rules. For `slack` it
  is exactly a `SlackRequester`.
- **FR-005:** An `InboundMessage` (`version: 2`) is `{ channel, eventId, conversation, actor, text,
  receivedAt }`. `eventId` is the adapter's own ID for the message, 1–128 characters from FR-001's set, and is
  what duplicates are dropped by. `conversation.channel` and `actor.channel` equal `channel`.
- **FR-006:** A `version: 1` Slack request message converts to an `InboundMessage` with no loss, and an
  `InboundMessage` on `slack` converts back. The Slack service accepts both versions during rollout.

### Bindings (Phase 2)

- **FR-010:** A binding maps `{ channel, tenant, space }` to a project. Slack bindings keep their current keys;
  other channels use `BINDING#<channel>/<tenant>` / `SPACE#<space>`.
- **FR-011:** Every binding key is built by one neutral helper, and a conversation's project is read through
  the neutral binding. The per-thread turn limit is keyed by the conversation subject, so it is already
  neutral. A developer's channel access to a task stays Slack-only: it relies on Slack's member list, which
  other channels need not offer.

### Channel API and adapters (Phase 3)

- **FR-020:** Only an administrator registers an adapter: `{ channel, callbackUrl, capabilities, projects }`.
  Registration returns a signing secret once; Rovara stores it in Secrets Manager.
- **FR-021:** `POST /v1/channels/{channel}/messages` accepts an `InboundMessage`;
  `POST /v1/channels/{channel}/decisions` accepts `{ eventId, conversation, actor, requestId, decision,
  answers? }`. Both require a Standard Webhooks signature (`webhook-id`, `webhook-timestamp`,
  `webhook-signature`) made with that adapter's secret, a timestamp within 5 minutes, and a path `channel`
  equal to the body's.
- **FR-022:** Rovara sends typed events to `callbackUrl`, signed the same way: `ack`, `message`, `progress`,
  `question`, `approval_request`, `check_report`, `pr`, `done`, `error`, `link_required`. Delivery is at least once
  with a stable event ID, retried with backoff, then dead-lettered. Everything Rovara says in the conversation is a
  `message`; `done` marks that a request finished and may carry no text.
- **FR-023:** Capabilities are `threads`, `buttons` (max per message), `edits`, `maxTextLength` and
  `proactive`. The core never sends a part the adapter cannot show; without buttons, an approval names a reply
  such as "reply 1 to approve".
- **FR-024:** A message is accepted only when its `{channel, tenant, space}` is bound to a project the adapter
  is registered for.

### Identity (Phase 3)

- **FR-030:** A non-Slack actor acts only when linked to a developer record. An unlinked actor's message runs
  nothing and produces one `link_required` event per actor per hour.
- **FR-031:** A link code is one-time, expires after 10 minutes and is bound to the actor that requested it.
  Redeeming it requires a developer sign-in and an explicit confirmation that names the channel and the masked
  user ID. The link is stored on the developer record and can be removed by the developer or an administrator.
- **FR-032:** Each adapter has `stepUp`, a set from `plan_approval` and `admin`, defaulting to both. A decision
  of a step-up kind posted by that adapter is refused, and the `approval_request` event carries the task page
  link instead of an approve action.
  The refusal is applied where the decision is applied (Phase 4), since only the core knows the request's kind;
  Phase 3 already sends no approve action for a stepped-up kind.
- **FR-033:** Slack actors keep their current verified identity. Slack is never subject to FR-030 to FR-032.

### Adapter conversations run (Phase 4a)

- **FR-035:** The orchestrator runs each queued message and decision in order per conversation, through the same
  processor as a Slack thread. Its replies leave as events; it acts on the service routes for the conversation and
  actor, and the broker checks the adapter, binding, link and developer again on every call.
- **FR-036:** An adapter conversation's workspace is charged to the linked developer: their Slack member's counter
  when the developer is linked to Slack, otherwise their own, and the organization's. Close and a failed preparation
  give it back.
- **FR-037:** An adapter answers an action confirmation with a decision naming it and the digest of its calls, or with
  a "yes" or "cancel" reply. A confirmation an administrator's policy requires is kind `admin`; an adapter that steps
  `admin` up cannot approve it either way (FR-032).
- **FR-038:** SWE-bench runs, eval batches, shared tasks and task-thread answers stay Slack-only; an adapter
  conversation is told so or refused.

### Core without Slack (Phase 4b)

- **FR-040:** The orchestrator's prompts and action gate name no surface; the surface chooses the model's reply
  style. The processor writes every text it posts through the conversation's format: Slack's keeps today's exact
  texts, and an adapter's is plain text the adapter formats.
- **FR-041:** `models` and `use <model>` are core text commands, worded for each surface. `swebench` and eval
  batches stay Slack-only (FR-038). `connect chatgpt`, `chatgpt status` and `disconnect chatgpt` are still answered
  by Slack ingress for the Slack member; they move to the core with the Slack adapter split (Phase 5).
- **FR-042:** In each package, Slack Web API calls go through one module: `slack-web.ts` in the broker and in the
  orchestrator service. (Sign-in's OpenID token exchange and the CLI's setup are not Web API messaging.)

### Slack and WhatsApp on the protocol (Phases 5–6)

- **FR-050:** Slack's signature check and event parsing run in the Slack adapter, which reaches the core only
  through the channel API.
- **FR-051:** `agentx adapter add` registers or changes an adapter (and `--rotate` replaces its secret), `adapter bind`
  and `adapter unbind` bind a space to a project, `adapter unlink` removes an actor's link, and `adapter list` and
  `adapter remove` manage adapters. `agentx channel add` stays the Slack channel binding.
- **FR-052:** A WhatsApp adapter maps a chat to a conversation, uses at most 3 reply buttons, and uses an
  approved template when it may not message first.

## Security considerations

**Untrusted actors:** adapters and anyone who can write to a bound space; the text they send; anyone holding a
link code.

**Trust boundaries:**
1. Adapter → channel API: authenticated by the per-adapter signature (FR-021).
2. Actor identity: asserted by the adapter, trusted only once linked to a developer sign-in (FR-030, FR-031).
3. Space → project: only an administrator's binding, and only for the adapter's registered projects (FR-024).
4. Core → callback URL: event payloads leave the account; they carry no credentials, and URLs follow the
   connector endpoint rules (`publicHttpsUrlProblem`).

**Abuse cases:**
- A forged or replayed request: refused for a bad signature, an old timestamp or a repeated `webhook-id`.
- An adapter claims another adapter's channel: refused by FR-021's path and body check.
- An adapter claims a linked user it is not: possible within that adapter. Limited by admin-only registration,
  per-adapter projects and step-up (FR-020, FR-024, FR-032).
- Link phishing: an attacker sends their own link code to a victim, who signs in and links the attacker's
  number. Countered by FR-031's confirmation naming the channel and masked user ID, and the code's 10-minute,
  single-use life.
- Workspace exhaustion through many new conversations: per-adapter limits on new conversations per hour and on
  open workspaces.
- Prompt injection through adapter text: same as Slack text today; it reaches the orchestrator as user input
  and the action gate still applies.

**Fail-closed:** an unknown channel, unbound space, unlinked actor, missing secret or failed signature runs
nothing.

Phase 1 adds no attack surface: it adds types and conversions, and every Slack key it produces is
byte-for-byte the current one.

## Constitution

Amended to 5.0.0 on 2026-11-08 (MAJOR), ahead of Phase 3. Version 4.1.0 required requests "that Slack has
signed" and workspaces owned by "a Slack thread". Version 5.0.0:

- **I:** the orchestrator accepts a request signed by Slack or by a registered channel adapter; an adapter
  actor must be linked to a developer sign-in and post in a space bound to a project the adapter is registered
  for; only an administrator registers an adapter; adapters get no credentials and run no coding work;
  step-up decisions are made on the task page (FR-020, FR-024, FR-030 to FR-033).
- **II:** a project is also selected by posting in an adapter space bound to it (FR-010).
- **III:** a workspace is owned by a conversation (Slack or adapter) or by one developer task; owner keys of
  different channels never collide (FR-003).
- **VI:** channel adapters are clients, not orchestrators.

The amendment permits adapters; none exists until Phase 3, so no running behaviour changes.

## Success Criteria

- **SC-001:** Every existing Slack owner key, subject and binding key is unchanged (Phase 1 and 2 tests).
- **SC-002:** A WhatsApp message in a bound group starts a task and receives `done`, on a test install.
- **SC-003:** An unlinked actor, an unbound space and a bad signature each run nothing (abuse tests).
- **SC-004:** After Phase 4b, no module outside `slack-web.ts` calls the Slack Web API, and the orchestrator package's
  prompts and gate texts name no surface. After Phase 5, no module outside the Slack adapter imports Slack schemas.
