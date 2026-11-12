# Plug-in ports

The ports are the seams where one outside system can be swapped for another with no change to the core (owner decisions 40 and 51).
This page says what each port is, where its code is, and what an adapter must do. The interfaces are in
`packages/contracts/src/ports/`; the in-memory fakes, the registry and Code's defaults are in `packages/broker/src/ports/`; the
conformance suites are in `tests/support/ports/`.

A change to any interface on this page needs both owners to approve (decision 42a).

## How an adapter is checked

Every port has a **conformance suite**: one function an adapter's test file calls with a small harness that builds a fresh adapter.
The in-memory fakes pass them today (`tests/unit/ports-*.test.ts`). A DynamoDB adapter and a SQLite adapter run the **same** suite, so
"both satisfy the port" is a test result, not a promise.

```ts
import { runDocumentStoreConformance } from "../support/ports/document-store-conformance.js";
runDocumentStoreConformance("sqlite", { async create() { /* a fresh empty store that keeps CONFORMANCE_INDEXES */ } });
```

## The registry and the config file

One registry holds every adapter, by **plug-in point** and name (`createAdapterRegistry`). The points are `code-host`, `tracker`,
`check-runner`, `channel`, `worker-machines`, `storage`, `queue`, `monitoring`, `learning`, `team-record-source`, `identity`,
`build-system`, and the policy seams `admission`, `audit-sink`, `approvers`, `metering` and `model-keys`. A point holds either many
adapters by name (every code host) or one (the store, the queue, each policy seam).

It is the registry Pratik's channel adapters (spec 062 phase 3) use, with the `channel` point. An out-of-process adapter that an
administrator registers over HTTP is registered under its channel id when it is created and unregistered when it is deleted; an
in-process adapter is named in the config. Both look the same to the core: Pratik's `ChannelCapabilities` and `ChannelEvent`
(`ChannelAdapter` in `plugin-points.ts`). There is no edition gate: nothing is Enterprise-only in Code.

The config file (JSON, `version: 1`) names the adapters to load:

```json
{
  "version": 1,
  "plugins": [
    { "point": "storage", "name": "sqlite", "module": "@rovara/plugin-sqlite", "settings": { "path": ".rovara/state.db" } },
    { "point": "queue", "name": "sqlite", "module": "@rovara/plugin-sqlite" },
    { "point": "channel", "name": "whatsapp", "module": "./adapters/whatsapp.js", "enabled": false }
  ]
}
```

- A `module` is a package name or a relative path starting `./` or `../`. A URL, an absolute path or a path with `..` in the middle is
  refused. The module exports `plugin` (or a default export): `{ point, name, create(context) }`. Its point and name must match the
  config entry.
- A `./` path must stay inside the config file's folder: the loader resolves links and checks the real path, and refuses hidden
  folders. A bare name is a package (never a Node built-in). **The config file is owner-controlled and must never be read from
  repository content an agent works on or from a pull request: naming a module runs its code in the broker.**
- Entries are created in order, so list the store before a queue that needs it. `create` gets `{ defaultCompanyId, settings, registry,
  now }` (the registry as a read-only view), validates its own `settings` and never receives a secret in clear (name where to read it).
  An adapter takes the company from each call; `defaultCompanyId` is Code's one company.
- A one-point (storage, queue, identity and the policy seams) may be configured once. Code's defaults (`registerCodeDefaults`) are
  registered as defaults and are replaced, without a conflict, by a configured adapter.
- Start-up order: register the defaults, load the config, then `registry.seal()`. A sealed registry lets only the `channel` point
  change (administrators add and delete channel adapters while the process runs), so a plug-in cannot swap the approvers or identity.
- `loadAdapters(config, { registry, importModule })` takes the importer as a parameter; `loadAdaptersFromFile` reads a JSON file and
  imports packages and relative paths.

## Company scope

Code runs as one implicit company (`IMPLICIT_COMPANY_ID`) and keeps Cloud's `ORG#<company>#<name>` key scheme (decision 45.6):
`companyScoped(companyId, name)` builds a partition key. The store does not know about companies; the scope is in the key. Company-owned
data is scoped; a few install-wide partitions are not yet (`CHANNEL_ADAPTERS`, `CHANNEL_LINK#...` of spec 062 phase 3, and the old
`OUTBOX#<id>` rows). Lane L1 moves them under the scope (decision 45.6). Adapters and the stores that Cloud serves many companies from take
the company from each call (`ModelKeyStore`, `IdentityProvider`, the outbox, `WorkerMachines`), never from the adapter's construction.

## Document store

`DocumentStore` (`document-store.ts`). Documents are flat JSON with their key (`pk`, `sk`) in them.

- `get`, `getMany` (in the order asked), `put`, `update`, `delete`, each write with an optional **condition** and an optional return value.
- Numbers are JSON numbers in DynamoDB's range (magnitude 1e-130 to 9.99e125, or zero). Documents are at most 400 KB and 32 levels
  deep; a transaction writes at most 4 MiB.
- `query` by partition and sort-key range (`eq`, `beginsWith`, `between`, `lt`, `lte`, `gt`, `gte`), ascending or descending, with a
  filter and an opaque cursor. A filtered page may be short and still have a cursor.
- `queryIndex` over declared sparse secondary indexes. Index reads may lag; a caller never reads its own write through one. Index
  attributes have a fixed type (`sortType`): a write with the wrong type or an empty text is `invalid_request`; to leave an index, leave
  the attribute out. The order of items with equal sort values is not defined.
- `transact`: up to 100 `put`, `update`, `delete` and `check` steps, each with a condition, applied together or not at all. No two
  steps name one key. The answer lists the failing steps. A lost race is the error `conflict` (retryable), not a failed condition; an
  adapter retries a bounded number of times before it throws it.
- An `update` is a list of `set`, `setIfAbsent`, `remove` and `add` steps on paths that do not overlap; each reads the document as
  it was before the update, so their order does not matter (DynamoDB's rule).
- `changes` (optional): a change feed with at-least-once delivery to named, fixed consumers, replacing the DynamoDB stream readers.
  `sequence` is opaque and ordered per key only; a removal by the expiry sweep has `cause: "expired"`; retries are bounded, then
  `onPoison` is called and the consumer goes on; handlers must be idempotent.
- Conditions and updates are data (`when.eq(...)`, `change.add(...)`), never an expression string. A missing path compares false;
  `not` of it is true. Text is ordered by Unicode code point (UTF-8 byte order). Updating an absent item creates it.
- `document-semantics.ts` holds the rules as plain functions; the fake and a SQLite adapter can use them, a DynamoDB adapter
  translates and is held to the same answers by the suite.

**DynamoDB adapter (lane A1, `packages/aws-adapters`, `@rovara/aws-adapters`; public under owner decision 72 O2; opt-in, never Code's default).**
`DynamoDocumentStore` keeps the hosted State table's layout unchanged, so no data moves: table keys `pk`/`sk` (text) are the port's key, a
document's attributes are the item's attributes in the form the hosted broker's document client writes (`S`, `N`, `BOOL`, `NULL`, `L`, `M`),
and the adapter adds no attribute of its own. `STATE_TABLE_INDEXES` names the table's four indexes; `outbox-pending` is listed apart as
planned (adding it is a hosted deployment change, not made here). Conditions and updates become placeholder-only expressions (`add` is
`SET p = if_not_exists(p, 0) + n`); single reads and table queries are strongly consistent; a lost transaction race is retried (4 attempts,
a new client token each) and then `conflict`. By default it refuses to write a number past 2^53 - 1 (`invalid_request`), because the hosted
broker's document client reads one as a BigInt or throws; `cloudReadableNumbers: false` allows the port's full range (the conformance suite
runs that way, since it pins `1e125`). The change feed (`DynamoStreamChangeFeed`) adds no stream reader: the host's existing reader passes each
batch of stream records to `deliver`, which hands it to the consumers declared for that process, retries a failing handler 3 times, then calls
`onPoison`; a time-to-live removal is `cause: "expired"`. The checkpoint is the event source mapping's and is shared by the reader's consumers,
so `deliver` refuses a batch (the mapping hands it over again) while any declared consumer is not subscribed, or when one stops during it.

Rulings (controller review of lane A1, 2026-11-11):
- **Sets and binary values stay refused on read until the D3 migration** (decision 60). A `get` throws `UnrepresentableValueError`; a query
  page or `getMany` leaves the row out and reports its key (`onUnreadable`). Before Cloud cuts over to this store, a one-off scan must prove
  the State table holds no `SS`, `NS`, `BS` or `B` attribute.
- **The port's size cap stays 400 KiB of compact JSON.** DynamoDB measures size its own way (about 3 bytes per one-digit number in a list,
  3 bytes per empty map), so it may refuse some documents under the cap, such as number-dense lists. Such a refusal is `invalid_request`
  (a conformance case pins this for every store). The plug-in `@rovara/aws-adapters/dynamodb`
(settings `tableName`, `region`, `endpoint`, `indexes`, `ttlAttribute`) builds the store without a feed. The suite runs against
`tests/support/ports/dynamodb-fake.ts`, an in-memory DynamoDB that parses the real expressions; it is not yet run against DynamoDB Local.

## Queue and outbox

`QueueService.queue(name, options)` gives a `Queue`: `enqueue` (delay, `dedupeId`, `groupId`), `receive` (visibility timeout,
up to 10), `ack`, `changeVisibility` (extend, or 0 to release), `deadLetter`, `listDeadLetters`, `redrive`, `discardDeadLetter`.
`maxReceiveCount` dead-letters a message after that many unacknowledged deliveries; an `ordered` queue keeps a group's messages in
order, never delivering a later one while an earlier one is in flight. A queue's options belong to where it is declared: `queue(name)`
returns the declared queue and different options throw. `Queue.capabilities` (`ordered`, `dedupe`, `maxDelaySeconds`,
`detectsStaleHandle`, `deadLettersById`) states what the backend guarantees, because SQS cannot detect a stale receipt, signal a
duplicate send, or address a dead letter by id. The suite gates those cases on the capabilities; **the core must work with the weakest,
so a consumer is idempotent.**

`TransactionalOutbox` (`stage`, `relay`) replaces the stream publisher. `stage(message)` is a step for the caller's
`DocumentStore.transact`, so the message exists if and only if the state change commits. `relay({ companyId })` hands that company's
pending messages to their queues, oldest first, then marks them. The pending index partition is per company, so a relay reads only its
own rows. The outbox id travels as the attribute `outboxId` and, scoped by company, as the queue's `dedupeId`: a crash between the
hand-over and the mark means a second hand-over, which a queue with `dedupe` drops inside its window and a consumer drops by `outboxId`
otherwise. A message that fails `maxAttempts` times is set aside as `DEAD` (reported, off the index); handed-over rows carry an
`expiresAt`. Messages of one ordered group keep their order only if one relay runs at a time. `createTransactionalOutbox` is written
once over the two ports; the store must keep `OUTBOX_PENDING_INDEX`.

**SQS adapter (lane A2, `packages/aws-adapters/src/sqs`, `@rovara/aws-adapters/sqs`; public, opt-in, never Code's default).**
`SqsQueueService` implements `Queue` on queues the deployment declares (settings `queues: { <name>: { url, deadLetterUrl? } }`, `region`,
`endpoint`); it creates and changes no queue. At first use it reads the queue's attributes and takes its visibility timeout, redrive policy
(`maxReceiveCount`, checked against `deadLetterUrl`) and size limit from SQS, and `queue(name, options)` throws for options that differ.
It passes `runQueueConformance` in both modes, and the outbox suite over the DynamoDB store and either mode.
- **Which mode, and why.** The mode is the queue's: a URL ending `.fifo` is FIFO. *Standard* is the default for task dispatch, because the
  core already works with the weakest queue (at least once, no order, no duplicate suppression) and standard has no per-group throughput
  cap; its consumers drop a repeat by `outboxId`. *FIFO* is for a use that needs order inside a group (`groupId`) or the 5 minute duplicate
  window. Capabilities: standard `ordered false, dedupe false, maxDelaySeconds 900`; FIFO `ordered true, dedupe true, maxDelaySeconds 0`
  (SQS refuses a per-message delay on FIFO). Both: `detectsStaleHandle false, deadLettersById false`.
- **FIFO details.** A message with no `groupId` gets a group of its own (no order owed to any other message), hidden on receive. The
  `dedupeId` is sent as its SHA-256 hex (SQS wants 128 characters of a narrow set); no `dedupeId` gets a fresh one. SQS does not say a send
  was a duplicate, so `duplicate: true` is reported only for a repeat this process sent inside the window. An ordered queue is received one
  message per request, because a FIFO request can return several messages of one group.
- **Size.** SQS limits body plus attributes (names, type name, values) to 256 KiB, the port limits the body alone. The adapter refuses the
  total before sending, and a queue with a smaller `MaximumMessageSize` is honoured. A message carries at most 9 attributes of its own
  (SQS's 10, one kept for the dead-letter marker). U+FFFE and U+FFFF in a body are written as JSON escapes; other text SQS refuses
  (control characters, an unpaired surrogate) in an attribute, group or reason is refused.
- **Poison and dead letters.** SQS's redrive policy moves a message after `maxReceiveCount` receives and keeps its id. A body that is not
  JSON is not delivered (reported to `onMalformed`) and ends in the dead letters the same way. `deadLetter(handle, reason)` sends the message
  to the declared dead-letter queue with a marker attribute (reason, time, original id, count) and then deletes it, so a crash leaves it on both
  queues, never neither; it needs the body, so only a delivery this process made (bounded memory) can be dead-lettered, and any other handle
  answers false. `listDeadLetters` is a sample of one receive (at most 10, no cursor); `redrive` and `discardDeadLetter` by id scan up to
  `deadLetterScanLimit` (100) messages, putting each other message straight back. For a large dead-letter queue use SQS's own redrive.
- **Stale handles.** SQS answers true to an `ack` with the earlier handle of a message received again (and removes nothing); the core's
  consumers are idempotent for this reason.
- **Errors.** `SqsQueueError` names the call and SQS's error name, never SQS's text; `retryable` is false for refusals that will not change.

**Outbox triggers on AWS (`sqs/outbox-relay.ts`; ports only).** `createOutboxRelayHook` is a change-feed consumer for the store's existing
stream reader: an INSERT of a `PENDING` outbox row makes it call `relay({ companyId, ids })` for exactly the new rows, once per company in a batch.
The relay's own updates (attempt counts, the move to `QUEUED`) are MODIFY records and start nothing. `createOutboxBackstop` is the scheduled
run: one `relay({ companyId })` per company from a supplied list, sequentially, within an optional time budget (the rest is `deferred` to the
next run), and one company's failure does not stop the others. The stream is never the only way a message reaches its queue: a missed record,
a hook error or a failed hand-over is picked up by the backstop, and a row that keeps failing is set aside as `DEAD` by the outbox. Both are
at least once; neither orders messages across calls, so nothing may rely on the outbox for order across overlapping relays.

## Local adapters (SQLite)

`packages/local-adapters` holds the adapters for the laptop path (decision 44): a SQLite `DocumentStore` with its change feed, and a
SQLite `Queue`. They are plug-ins for the registry. `rovara up` registers them as the `storage` and `queue` defaults in `~/.rovara/state.db` with the task flow's indexes (lane L9-wire); a config entry like these replaces them, and then must keep `TASK_FLOW_INDEXES`:

```json
{ "point": "storage", "name": "sqlite", "module": "@agentx/local-adapters/storage", "settings": { "path": ".rovara/state.db", "indexes": [] } },
{ "point": "queue", "name": "sqlite", "module": "@agentx/local-adapters/queue", "settings": { "path": ".rovara/state.db" } }
```

The store plug-in always keeps `OUTBOX_PENDING_INDEX`, and `ttlAttribute` is `expiresAt` unless set (`null` turns expiry off); `indexes`
adds the core's other indexes. The queue may share the store's file (two connections) or use its own. Both plug-ins refuse a setting they do not know, and a
`:memory:` path. `SqliteDocumentStore` and `SqliteQueueService` have `close()`, which the port does not: the process that loads them closes them.

**The library is `node:sqlite`**, which is inside Node (the repository pins `>=22.19 <23`; SQLite 3.51 with WAL). Nothing is downloaded or
compiled on macOS or Linux, arm64 or x64, and there is no dependency to review. The costs are that Node still calls it "active
development" and prints one `ExperimentalWarning` at first use (run with `--disable-warning=ExperimentalWarning` to hide it), and that its
API could change in a later Node line. `better-sqlite3` is the fallback; only `sqlite-database.ts` touches the library, so it is a one-file change.

**How it reuses the rules.** A write reads the documents it touches inside its own `BEGIN IMMEDIATE` transaction, then calls the same functions
as the in-memory fake (`evaluateCondition`, `applyUpdateOps`, the `assertValid...` checks, `indexPlacement`) and writes the result with the
index tables, the time-to-live table and the change log in that one transaction. Text columns are UTF-8 with BINARY collation, so SQL order is the
code point order the port promises. The suites in `tests/support/ports/` run unchanged against it (`tests/unit/local-adapters-*.test.ts`), and a
crash test kills a child process with SIGKILL and reopens the file.

**Change feed.** Changes are written to a log table in the writing transaction by every connection (also one opened with `changeFeed: false`, which only
means it does not subscribe), only while some consumer name is registered in the file. A name that
subscribes for the first time starts at the present; after that it resumes after its stored checkpoint, which is saved after the handler
returns (a crash in between delivers the batch again). A handler that throws is retried with a doubling delay (10 tries by default), then
`onPoison` is called, the checkpoint moves on and `droppedBatches` counts it. `sequence` is the log's row number, padded to 20 digits. The log
is trimmed to the slowest registered consumer, so a consumer that is registered but never subscribes again holds the log forever: retire it
with `removeConsumer(name)`.

**Limits to know.**
- **One process.** WAL lets several connections read while one writes, and the tests run two connections on one file (store and queue, two
  stores). But the change feed, the expiry sweep and the queue's wake-up of a waiting `receive` are per process. Two processes that subscribe
  to one consumer name both deliver every change (handlers are idempotent anyway) and race on the checkpoint. A waiting `receive` in another
  process sees a new message at its next poll (`pollMs`, 250 ms), not at once.
- **Writes are serialised.** A write waits for another connection's lock up to `busyTimeoutMs` (default 5000) and blocks this process's
  event loop while it waits. Then the store throws `conflict` (retryable) and the queue throws `QueueStorageError`. A transaction never
  spans an `await`, so two writes in one process never interleave.
- **Durability.** `synchronous: "FULL"` (default) flushes every commit; a killed process loses nothing. A power cut can still lose recent
  commits on macOS, because SQLite does not ask the disk to flush its cache there (`fullfsync` is off). `"NORMAL"` is faster and can lose the
  last commits in a power cut, never corrupt the file.
- **Local disk only.** WAL needs shared memory. A file system that cannot do it (some network shares, some container mounts) is refused at open.
  To copy a live database use SQLite's backup (`sqlite3 state.db ".backup copy.db"`), not `cp`.
- **Keys and text.** `pk`, `sk`, index key text and queue group, dedupe and reason text must not hold an unpaired surrogate or a NUL
  (SQLite would turn one into U+FFFD and cut the other); they are `invalid_request`. A document body may hold both: it is stored as JSON text.
  Numbers are JavaScript doubles; an index on a number sorts them as doubles.
- **Paging.** A page is cut at `limit` before the filter, so a filtered page can be short with a cursor, as on DynamoDB. A cursor names the
  last item, so a deleted item does not break it.
- **Indexes.** The file remembers its index set and time-to-live attribute, because every connection must maintain the same tables.
  Opening it with a different set is refused (`invalid_request`) unless the opener passes `migrate: true`; the storage plug-in always does, so a
  changed config takes effect at the next start. A migration builds the new index tables from the documents (time grows with their number),
  leaves out a document that does not fit a changed index (wrong sort type), and drops the tables of indexes no longer named. Connections still
  open on the old layout then refuse to write or query an index (`unavailable`) until they are reopened.
- **Expiry.** The sweep runs every 60 s (`sweepIntervalMs`; 0 for none), in pages of 100 documents, at most 50 ms at a time, and its removals
  carry `cause: "expired"`. A document is readable until then.
- **Queue.** Options (visibility, `maxReceiveCount`, `ordered`) belong to the process's declaration and are not stored; the messages, dead
  letters and the 5 minute dedupe window are. `receive` is a poll (an idle poll reads only); `waitSeconds` polls until the time is up.
- **Files.** A folder the store creates is `0700`; the file, and any `-wal` and `-shm` beside it, are set to `0600` at open. A folder that already
  existed keeps its mode.
- **Size.** The port's limits hold (400 KB a document, 4 MiB a transaction, 256 KB a message). Nothing is tuned for a database past a few GB.

## Worker machines

`WorkerMachines`: `start` (idempotent on `machineKey`, wakes a stopped machine), `stop` (keeps the volume), `terminate`, `health`
(never throws for an unknown machine) and `deliver` (a `WorkerInvocation`, idempotent on `operationId`; `MachineError` codes
`not_ready`, `not_found`, `unauthorized`, `rejected`, `unavailable`). `capabilities` says whether it isolates, keeps a volume, can
stop, and how many machines it allows. The job's answer comes back through the broker's callback API, not through this port. One lane
each: EC2, local Docker, this machine.

## Policy seams

Each has a Code default (`policy-defaults.ts`) and a suite in `policy-conformance.ts`.

| Seam | Code default | Cloud fills it with |
| --- | --- | --- |
| `Admission` (`admit`, `stage`, `settle`, `release`; every request has an `idempotencyKey`) | allow everything, hold nothing | budgets and money limits, taken inside the caller's transaction (`stage`) |
| `AuditSink` (`stage` steps for the caller's transaction, `record`) | writes nothing | the audit ledger's outbox |
| `Approvers` (`requirement`, `verify` a proof) | the local machine owner by session, or a repository collaborator with write permission by comment (decision 45.3); one approver, self-approval allowed | a second person, the browser rule |
| `IdentityProvider` (`authenticate`, `resolveExternalAccount`, `getPrincipal`) | the local owner, plus outside accounts the owner linked in config | members and single sign-on |
| `Metering` (`price`, `record`; every entry has an `entryId`, recorded once) | tokens times a price table | proxy key spend |

**Approvals are bound.** An `ApprovalRequest` carries `requestId`, `revision`, `artifactDigest`, the project and an optional expiry. An
`ApprovalProof` names the request, revision and digest it approves and carries a `token` that the method's issuer checks (the identity
adapter's session; the code host's comment, looked up by id for its author, permission, target and text). `verify` never believes a
principal or account the proof only claims. A proof has a `proofId`; the caller stores it with `when.absent()` in the decision's
transaction, keyed on `approvalProofKey(proof)` (a hash of method, token and request, so a token cannot be reused under a fresh `proofId`); that is the single-use guarantee (the Code default also refuses a repeat in its own process, bounded).

An outside account is an `ExternalAccountRef` (`provider`, `tenant`, `accountId`); no core type names Slack or GitHub. The code host
adapter answers "who wrote this comment and what may they do" through `verifyComment`.

## Model key store

`ModelKeyStore.get(companyId, provider)` returns a `SecretValue` (it prints as `[secret]` in text, JSON and the console). Code has an environment
store (`ANTHROPIC_API_KEY`), a file store (JSON, refused unless only the owner can read it), a layered store and a memory store. Cloud
adapts the port to its secret store and proxy.

## The channel point and Pratik's registry

`registry.get("channel", name)` returns a `ChannelAdapter`: Pratik's `ChannelCapabilities`, `projects`, `stepUp`, `deliver(ChannelEvent)`
and, for in-process adapters, `start(sink)`. The sink applies the same binding, link, decision and step-up checks as the channel API
(`ChannelInboundSink`). **Not done in W0:** the registry is per process, while Pratik's records live in the state table, so an adapter
registered by an HTTP call is not yet visible to other processes. The follow-up is a record-backed source that wraps each stored
`ChannelAdapterRecord` as a webhook `ChannelAdapter` (signing in `deliver`), and a rule that refuses a config name already used by a
record. Slack is not a `channel` adapter yet: spec 062's `AdapterChannelIdSchema` refuses the id `slack`.

## What is not here

- **Artifact (object) storage.** Cloud keeps proofs, plan documents and evidence in an object store. No port is defined yet; the lanes
  that move proof and evidence (L4, L6, L7) need one.
- **Snapshot reads** (`TransactGet`, 10 uses in Cloud). `getMany` is not a snapshot; use `transact` with `check` steps.
- **Scan** (2 uses). Use `query` on a partition or an index. **Projections** (16 uses) are not offered; read the document.
- **Sets with `contains`, list append with `size`, `attribute_type`, binary attributes.** Cloud's limit and budget code uses them
  (`developer/limits.ts`, `org/budget.ts`, `spend/admission.ts`, `aws/sessions.ts`, `lessons/dynamo-vectors.ts`). They must be
  rewritten before that code sits on this port: one marker item per charged task with `when.absent()` instead of a set, a counter
  instead of a list length, base64 text instead of bytes. That changes the stored format, so it is a decision for both owners.
- **Secrets, object (artifact) storage, a scheduler, realtime push and email notices.** Each is a provider dependency of the core
  today and has no port yet. The relay "from a timer" is the caller's timer.
- **Sign-in flows.** `IdentityProvider` answers who a credential is; begin/complete/sign-out, authentication freshness and member
  listing for single sign-on are interface additions for the lane that needs them.
- A SQLite adapter must use UTF-8 text with BINARY collation for the code-point order and refuse lone surrogates in keys.
- The ports for code host, tracker and check runner come with lane L1 (Cloud's `plugins/` contracts). Until then their line in
  `PluginPointTypes` is `UnspecifiedAdapter`.
