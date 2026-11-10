# Channel adapters

A channel adapter lets people use Rovara from a chat surface other than Slack, such as WhatsApp. The adapter is a
small service you run: it turns the surface's messages into signed requests to Rovara's channel API, and turns
Rovara's signed events back into messages. Rovara runs the work exactly as it does for a Slack thread.

```
WhatsApp / other surface ──► your adapter ──POST signed──► Rovara channel API
                                   ▲                              │
                                   └──── signed events ◄──────────┘
```

Channel adapters are off by default. They work only in a named environment, where people can sign in to link their
chat identity.

## For administrators

### Turn them on

Deploy the environment with the control-plane parameter `ChannelAdapters` set to `enabled`, then deploy the
orchestrator stack again so it picks up the channel queues. Until then the channel API answers 404 to everything.

### Register an adapter

```
agentx --env staging adapter add whatsapp \
  --callback-url https://adapter.example.com/rovara \
  --projects web,billing \
  --buttons 3 --max-text 4096
```

- The command prints the adapter's signing secret once. Give it to the adapter; Rovara keeps it in Secrets Manager
  and never shows it again. Use `--secret-file <path>` to write it to a private file instead.
- `--projects` limits the projects the adapter's spaces may be bound to. You must administer each one.
- `--step-up` (default `plan_approval,admin`) lists the decisions only a signed-in person can make on the task page.
  An adapter can't approve those, by button or by reply.
- Run `adapter add` again to change the settings; the secret stays. Add `--rotate` to replace it.
- `agentx adapter list` shows the adapters; `agentx adapter remove whatsapp` removes one, and its secret stops
  working at once.

### Bind a space

A space is the surface's group or chat. Messages run only in a bound space:

```
agentx --env staging adapter bind whatsapp --tenant +14155550100 --space group=AbC-12_x --project web
```

`agentx adapter unbind` removes the binding.

### People link their accounts

The first time someone writes in a bound space, Rovara runs nothing and sends them a one-time link. They sign in with
the company login and confirm the channel and their masked user ID (for example `+91 ••• 4821`). Their next message
runs. A link code lasts 10 minutes and works once.

People list and remove their own links through the developer API (`GET` and `DELETE /v1/dev/channel-links`). An
administrator removes one with:

```
agentx --env staging adapter unlink whatsapp --tenant +14155550100 --user +919876544821
```

Workspaces from an adapter count against the linked person's workspace limit. If they also use Slack, it is the
same limit.

## For adapter authors

### IDs

| Field | Rule |
|---|---|
| `channel` | Your adapter's ID, `^[a-z][a-z0-9-]{1,31}$`, not `slack` |
| `tenant`, `space`, `thread`, `userId`, `eventId` | 1–128 characters from `A–Z a–z 0–9 . _ : + @ = -`; never `/` |

A conversation is `{ channel, tenant, space, thread }`. Use a fixed `thread` (such as `main`) if your surface has no
threads. The actor's `tenant` must equal the conversation's.

### Requests to Rovara

`POST /v1/channels/{channel}/messages`:

```json
{
  "version": 2,
  "channel": "whatsapp",
  "eventId": "wamid.HBgL1",
  "conversation": { "channel": "whatsapp", "tenant": "+14155550100", "space": "group=AbC-12_x", "thread": "main" },
  "actor": { "channel": "whatsapp", "tenant": "+14155550100", "userId": "+919876544821" },
  "text": "fix the navigation bug",
  "receivedAt": "2026-11-08T09:59:59.000Z"
}
```

`POST /v1/channels/{channel}/decisions` answers an `approval_request` event. It echoes the event's `requestId`,
`expectedRevision` and `artifactDigest`, which tie the decision to exactly what was asked:

```json
{
  "version": 1, "channel": "whatsapp", "eventId": "wamid.HBgL2",
  "conversation": { "...": "as above" }, "actor": { "...": "as above" },
  "requestId": "…", "expectedRevision": 1, "artifactDigest": "…",
  "decision": "APPROVE", "reason": "approved from WhatsApp", "receivedAt": "2026-11-08T10:02:00.000Z"
}
```

`decision` is `APPROVE`, `REQUEST_CHANGES`, `REJECT` or `SKIP`. For an action confirmation, anything but `APPROVE`
cancels. Without buttons, people can also reply `yes` or `cancel` as a message.

Rovara drops a repeated `eventId`, so resending after a failure is safe.

### Signing

Both directions use [Standard Webhooks](https://www.standardwebhooks.com/):

- Headers: `webhook-id` (unique per delivery), `webhook-timestamp` (Unix seconds) and `webhook-signature`.
- The signature is `v1,<base64 HMAC-SHA256 of "<id>.<timestamp>.<body>">`, keyed with the base64-decoded part of
  your `whsec_…` secret.
- A request more than 5 minutes old is refused; one with a `webhook-id` already seen is answered as a duplicate and
  runs nothing.

Check Rovara's signature on every event you receive.

### Answers

| Status | Body | Meaning |
|---|---|---|
| 202 | `{"status":"accepted"}` | Queued; Rovara sends an `ack` event for a message |
| 202 | `{"status":"link_required"}` | The person is not linked; Rovara sends them a `link_required` event (at most one an hour) |
| 200 | `{"status":"duplicate"}` | Seen before; nothing more runs |
| 400 | `{"error":"invalid_body"}` | The body does not match the schema |
| 401 | `{"error":"bad_signature"}` (or `missing_headers`, `bad_timestamp`, `stale_timestamp`) | Not signed correctly |
| 403 | `{"error":"space_not_bound"}` (or `channel_mismatch`, `actor_tenant_mismatch`) | Not allowed |
| 404 | | Unknown adapter, or channel adapters are off |
| 413, 503, 500 | | Too large; secret unavailable; try again |

Retry 5xx answers with the same `eventId`.

### Events from Rovara

Rovara posts each event to your callback URL, signed as above, with the event's `id` as `webhook-id`:

```json
{ "version": 1, "id": "evt_…", "channel": "whatsapp", "conversation": { "...": "…" }, "createdAt": "…", "type": "message", "data": { "text": "…" } }
```

| `type` | `data` | Show it as |
|---|---|---|
| `ack` | `inReplyTo` | Optional: a reaction or "typing" on that message |
| `message` | `text` | A message in the conversation |
| `approval_request` | `text`, `kind`, `requestId`, `expectedRevision`, `artifactDigest`, optional `taskUrl` and `actions` | A message with buttons for `actions`; with no `actions`, the text already says how to answer |
| `done` | optional `inReplyTo`, `text` | The request finished; stop any typing indicator |
| `link_required` | `linkUrl`, `expiresAt`, `actor` | A private message to that actor with the link |
| `progress`, `question`, `check_report`, `pr`, `error` | `text` and type-specific fields | A message |

Text is plain, cut to your `--max-text`. Rovara sends no more buttons than `--buttons` allows.

Answer 2xx once you have the event. Rovara retries 408, 429, 5xx and network errors, waiting from 10 seconds up to 15
minutes between tries, then gives up after 8 tries. It drops an event on any other 4xx or a redirect. The callback must
be public HTTPS: Rovara refuses private addresses and never follows redirects. Use the event `id` to drop repeats.
