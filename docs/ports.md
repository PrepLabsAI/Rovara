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
`build-system`, and the policy seams `admission`, `audit-sink`, `approvers`, `metering` and `model-keys`, `secrets` (below), `object-storage` (provisional, below), `model-provider` (below), `company-instructions` (read-only company rules, below) and `outbound-events` (signed events out, below), `image-registry` (a project's saved environment image, below), `scheduler` (when something is due, below), `realtime` (a hint to open pages that something changed, below) and `email` (one plain notice to one address, below). A point holds either many
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

## Code host: reading and answering comments (optional, lane L12)

Two optional abilities of the `CodeHost` port serve comment commands: `comments(ref, { since, page })` (the comments of a change request's conversation, oldest first: id, the change request it is on, author with account type,
text, `createdAt`, `updatedAt`; **fetch only**, owner decision 66) and `postComment(ref, text)` (one comment of Rovara's own fixed text; on an account that is also a person's it carries `ROVARA_REPLY_MARKER`). A host without them
simply has no comment commands. Whether a comment is a command, fresh, edited, on the right thread or from someone who may approve is decided in Rovara's core (`core/pr-commands/comment-checks.ts`), never by the plug-in.

## Learning

`learning` (`packages/contracts/src/ports/learning.ts`, `LearningAdapter`) is how a host makes lessons comparable, and nothing else: an optional `embedder(company)` (text to a vector of fixed `dimension`, with a `spec` naming the model) and an optional
`vectors(company)` (where a lesson's vector is kept; the default is beside the lessons in the document store). With neither, lessons are compared on code-aware keywords and cited paths, so a laptop needs no network and no model download. The lessons themselves
live in the `storage` point (`DocumentLessonStore`, the keys of `lesson-keys.ts`, the same rows a hosted install keeps), their model calls go through the install's model, their spend through `admission` and `metering`, their audit through `audit-sink`
(`lesson.*` actions; `rovara up` registers the document audit sink, so approvals, including the sole-owner exception, and retire requests are kept) and their approvals through `approvers` (`kind: "lesson"`, bound to the lesson's text and version). Code registers `local` (keywords) as the default; `ROVARA_LESSONS_EMBEDDER=local` makes it also give a hashing embedder
that runs in the process (it finds shared words and word forms, not meaning), and `ROVARA_LESSONS_EMBEDDER=http://127.0.0.1:<port>/v1` with `ROVARA_LESSONS_EMBEDDER_MODEL` a small open model (bge-small class, decision 23) served on this machine by any embedding server with the common `/embeddings` route; only a loopback address is accepted (`createLoopbackEmbedder` in `lessons/local-embedder.ts`). The point's cardinality is many; the first adapter that is not `local` is used. The lessons switch and the gate the library asks before a learning call are process-wide (one install per process), not per project or per company.

The interface is the hosted product's own lessons seam, name for name (`LessonEmbedder`, `LessonVectors`, `StoredLessonVector`, `EmbedderCall`), so the hosted embedder service and its vector store are meant to sit behind it
without changing the TeamRecord rows they keep (not yet run against them). Lane K1 added the checks: `tests/support/ports/learning-conformance.ts` has one suite for an embedder (`runLessonEmbedderConformance`: a spec, a fixed
dimension, finite numbers, `embedMany` in order and equal to `embed`, deterministic) and one for vector storage (`runLessonVectorsConformance`: one vector per lesson, a new spec replaces the old one,
nothing for another spec, idempotent `remove`, companies and projects apart, many ids in one call). Code's hashing embedder and `documentLessonVectors` pass them, as do the fakes
(`createFixedLessonEmbedder`, `createMemoryLessonVectors`, `createMemoryLearningAdapter` in `packages/broker/src/ports/learning.ts`).

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
hand-over and the mark means a second hand-over, which a queue with `dedupe` drops inside its window; otherwise the consumer must be idempotent on its operation (the dispatch consumer claims it with a
conditional write and drops an ended or running one), and `outboxId` identifies the copies. A message that fails `maxAttempts` times is set aside as `DEAD` (reported, off the index); handed-over rows carry an
`expiresAt`. Messages of one ordered group keep their order only if one relay runs at a time. `createTransactionalOutbox` is written
once over the two ports; the store must keep `OUTBOX_PENDING_INDEX`.

**SQS adapter (lane A2, `packages/aws-adapters/src/sqs`, `@rovara/aws-adapters/sqs`; public, opt-in, never Code's default).**
`SqsQueueService` implements `Queue` on queues the deployment declares (settings `queues: { <name>: { url, deadLetterUrl? } }`, `region`,
`endpoint`); it creates and changes no queue. At first use it reads the queue's attributes and takes its visibility timeout, redrive policy
(`maxReceiveCount`; `deadLetterUrl`, read back, must be a queue of the same kind and the one a redrive policy names) and size limit from SQS, and `queue(name, options)` throws for options that differ.
It passes `runQueueConformance` in both modes, and the outbox suite over the DynamoDB store and either mode.
- **Which mode, and why.** The mode is the queue's: a URL ending `.fifo` is FIFO. *Standard* is the default for task dispatch, because the
  core already works with the weakest queue (at least once, no order, no duplicate suppression) and standard has no per-group throughput
  cap; its consumers are idempotent on the operation. *FIFO* is for a use that needs order inside a group (`groupId`) or the 5 minute duplicate
  window. Capabilities: standard `ordered false, dedupe false, maxDelaySeconds 900`; FIFO `ordered true, dedupe true, maxDelaySeconds 0`
  (SQS refuses a per-message delay on FIFO). Both: `detectsStaleHandle false, deadLettersById false`.
- **FIFO details.** A message with no `groupId` gets a solo group, hidden on receive: named after the SHA-256 of its `dedupeId` when it has one
  (so two sends of one id share a group and SQS drops the second even when the queue's `DeduplicationScope` is `messageGroup`), otherwise a group of
  its own (no order owed to any other message). A queue with that scope reports `dedupe: false` (SQS keeps a repeat sent in another explicit
  group); its solo-group messages are still suppressed. The `dedupeId` is sent as its SHA-256 hex (SQS wants 128 characters of a narrow set); no
  `dedupeId` gets a fresh one. SQS does not say a send
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
  `deadLetterScanLimit` (100) messages, keeping the others hidden until the scan ends and then putting them back; `redrive` extends the found message's
  hide first and sends nothing if SQS no longer knows its handle. For a large dead-letter queue use SQS's own redrive.
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
stop, and how many machines it allows. The job's answer comes back through the broker's callback API, not through this port. A machine that is lost after the delivery (`terminated`, `stopped`, `stopping` or `unhealthy` for longer than `runLostGraceSeconds`, 120 s by default) ends the operation on it INTERRUPTED (`sweepLostRuns`, run by the local app's tick; a watch row written with the hand-over names the operation, its fence and its machine), and the task then follows the path of any interrupted step. One lane
each: EC2, local Docker, this machine.

## Policy seams

Each has a Code default (`policy-defaults.ts`) and a suite in `policy-conformance.ts`.

| Seam | Code default | Cloud fills it with |
| --- | --- | --- |
| `Admission` (`admit`, `stage`, `settle`, `release`; every request has an `idempotencyKey`) | allow everything, hold nothing; declares `enforcesCost: false` | budgets and money limits, taken inside the caller's transaction (`stage`); declares `enforcesCost: true` |
| `AuditSink` (`stage` steps for the caller's transaction, `record`) | `rovara up`: `DocumentAuditSink`, an `AUDIT#` row in the same store (lane P6); the bare registry default writes nothing | the audit ledger's outbox |
| `Approvers` (`requirement`, `verify` a proof) | the local machine owner by session, or a repository collaborator with write permission by comment (decision 45.3); one approver, self-approval allowed | a second person, the browser rule |
| `IdentityProvider` (`authenticate`, `resolveExternalAccount`, `getPrincipal`; optional `beginSignIn`, `completeSignIn`, `signOut`, `listMembers`, `accountsOf`) | the local owner (lists itself, its linked accounts), plus outside accounts the owner linked in config | members and single sign-on |
| `Metering` (`price`, `record`; every entry has an `entryId`, recorded once) | tokens times a price: the model provider's own table, else the catalog's list price; a model neither knows is recorded as unknown, never free (`core/cost/price-table.ts`) | proxy key spend |

**The per-step model rule has its own small seam** (`ModelSelectionSeams`, `core/model-selection/service.ts`): which models the install could serve, whether one can be called now, which is the install's own, and how a call to one is routed (the proxy alias and request format). Code answers it from its model providers and key store (`local/app/model-selection.ts`); the hosted product answers it from its model sources. The choice function (`resolveStageModel`), the setting's row (`MODEL_SELECTION_POLICY`, the hosted layout), the record of refused models (`MODEL_USABILITY`) and the price lookup (`ModelPrices`) are shared; a price is the model provider's own table, else the catalog's list price, a cap never assumes less than the catalog's list price, and a model with no price in dollars is not offered where a cap applies.

**What a host that adopts the model rule must keep.** The read and choose path is shared. The owner's write path (`apply`) is for ONE owner on one install: it checks a fresh page session, the revision it was drawn at and the approvers port's *requirement* (never a proof, and it has no request receipt, second-person confirmation or preview across projects), so a host with several people keeps its own writer for the policy row, or adds those here before it writes through this one. A host also passes the two things that are its own: `defaultReviewDefault` (what a policy that does not say reads as: `install-model` for Code, `different-company` for a host whose rule that is) and `capApplies` (a host that always holds a budget passes `() => true`). The worker's calls reach the task's cost ledger through the `Metering` it hands the model proxy (`LocalApp.meter` in Code): a host whose proxy spend is read elsewhere must make that spend readable to `grant`'s budget the same way.

**A `task.start` admission request names the task's path.** `AdmissionRequest.taskStart?` (`AdmissionTaskStart`) is set on `task.start` only: `{ workflow, path?: "QUICK" | "FULL", pathFrom?: "request" | "understand", designFirst? }`, so a host can set a different minimum room for each path. A task that understands first and was not told a path has no `path` yet (`pathFrom: "understand"`). It is optional and additive; Code's default allow-all ignores it, and other actions (`machine.start`, `model.call`) do not carry it.

**An `Admission` adapter declares `enforcesCost`.** `enforcesCost?: boolean` on the `Admission` interface says whether the adapter refuses or holds back a request whose `estimate.cost` is more than its remaining allowance. Rovara starts work with no one present (triggers, schedules, chain steps) only where the registered admission declares `enforcesCost: true`: only an explicit `true` counts, a missing value means `false`, and the adapter's name is never looked at (`admissionEnforcesCost` in `core/automation/run-seam.ts` is the one rule). An adapter that ignores the estimate (an allow-list, a logger, a rate limiter) leaves it unset or `false`. Code's default allow-all declares `false` explicitly, and the conformance suite (`runAdmissionConformance`) requires every adapter to declare it, and an adapter that declares `true` to refuse a request over its allowance. This is an additive change to a plug-in interface (decision 79): existing adapters keep working and are simply treated as not enforcing until they declare it; the owner decides it alone (decision 63), and the plug-in author is told.

**A reserving `Admission` adapter needs a reservation lifetime.** Some callers ask for an allowance, keep its `reservationId` on a record they write next, and give it back when that record's work ends (the second review does: it asks at the review step's start and releases when the operation ends; a design review round asks for its reviewers' ceilings before it is stored, keeps the id on the round's allocation and releases it when the round ends. The rule for a hold that covers model calls made through the proxy: RELEASE it when the work ends, never settle it with the spend, because the proxy already books each call through `Metering` and a settle would charge it twice; a diagnosis and an Ask ask for a `model.call` before their model call and settle it with what the call used as soon as the provider may have been paid, giving it back only when nothing was sent). Every path that ends normally gives it back, and a restart is safe because the id is on the stored record. A crash between `admit` and the write of that record leaves a hold nothing can find: each start asks under a key of its own, so a retry does not reuse it. An adapter that really holds money must therefore expire a reservation by itself (a time to live, or its own sweep). Code's default holds nothing.

**Approvals are bound.** An `ApprovalRequest` carries `requestId`, `revision`, `artifactDigest`, the project and an optional expiry. An
`ApprovalProof` names the request, revision and digest it approves and carries a `token` that the method's issuer checks (the identity
adapter's session; the code host's comment, looked up by id for its author, permission, target and text). `verify` never believes a
principal or account the proof only claims. A proof has a `proofId`; the caller stores it with `when.absent()` in the decision's
transaction, keyed on `approvalProofKey(proof)` (a hash of method, token and request, so a token cannot be reused under a fresh `proofId`); that is the single-use guarantee (the Code default also refuses a repeat in its own process, bounded).

**Strong methods, sign-in time and the company's window (lane P3, decisions 60 and 62).** The approvers plug-in names its own methods in `ApprovalRequirement`: `strongMethods` (a HIGH-risk approval), `rejectMethods`, `changesMethods`, and `commentMethods` (the methods that prove one act by a comment). ONE function, `strictMethodsFor` (`core/decisions/strong-methods.ts`), decides which methods may give an answer, and the decision gate and `pressMerge` both use it: what the plug-in names, else the local session (for a request for changes also a comment). A comment method (`code-host-comment`, any `code-host-*`, anything in `commentMethods`) is never strong and never rejects, whatever is named: reject and high-risk approve need a signed-in session; asking for changes by comment is allowed. The gate's policy option can only narrow: it is intersected with the plug-in's sets, or with the default (the local session) when the plug-in names none. `createDecisionGate` refuses a policy of only comment methods for a strong set, and `gate.verifyPolicy(company)` (call it at startup when a policy is set) throws when the policy empties a set the plug-in made non-empty, instead of a silent lock-out. `Principal.authTime` is the sign-in time the identity adapter knows (and `Principal.methods` the methods used); the decision record keeps it (`ApprovalRecord.approvers[].authTime`). Code does not use it: the local owner has no sign-in time and the local approvers set no `signIn` rule. A plug-in that wants a fresh sign-in puts the company's choice in `ApprovalRequirement.signIn` (`{ mode: "window", seconds }`, 60 to 86400, or `{ mode: "any-active" }`); the gate then refuses a high-risk approval or a rejection (`sign_in_not_fresh`), and `pressMerge` a high-risk merge, when the approver has no readable, non-future sign-in time, the window has passed, the rule is malformed, or the rule is `any-active` and the identity adapter (`identity` in the gate's and the merge press's dependencies) does not report `capabilities.companySignIn`. The company's choice is the setting in `core/decisions/sign-in-setting.ts` (one row per company, default ten minutes; only an owner or admin changes it; the audit record carries the new value and the old; "trust any active company sign-in" is accepted only when the identity adapter's own `capabilities.companySignIn` is true, and is read back as the default window if the company later loses it). Code stores nothing for it until a plug-in asks. In Code a high-risk merge proved by a comment is refused (it was not before; nothing in Code presses a merge yet).

**Identity abilities (lane P3, item I1).** Optional, each behind a capability flag so a caller never branches on an adapter's name: `beginSignIn`, `completeSignIn`, `signOut` (`interactiveSignIn`); `accountsOf(company, person)`, the reverse of `resolveExternalAccount` (`externalAccounts`); `listMembers` (`members`). The merge code's `MergePeople` is no longer a seam of its own: `createIdentityMergePeople(identity, { hostProvider })` (`core/merge/people.ts`) builds it from `accountsOf` and `resolveExternalAccount` (a person may approve when they hold a role the core knows). A person may link several code host accounts: `requestersOf` and the presser check exclude ALL of them (`MergePeople.hostAccountsOf`). `rovara up` still wires `soleOwnerPeople`, which links nobody, until the owner's code host account is linked in config. Roles (item I3): `OrgRoleSchema` stays the closed list (`owner`, `admin`, `member`), so a check that parses a role never passes an unknown one. Shared answers that must carry a role they do not act on use the open `OrgRoleNameSchema` (a lower-case word that is not an object property name); `ownRoleEntry` looks a role up in a table by own keys only. The core acts only on `KNOWN_ORG_ROLES`; an unknown name (`auditor`) is valid data with no power. A consumer that tests `role !== "auditor"` must become a positive list before it adopts open names.

An outside account is an `ExternalAccountRef` (`provider`, `tenant`, `accountId`; `ExternalAccountRefSchema`); no core type names Slack or GitHub. This is the one shape for every new surface (lane P3, item I2): `externalAccountOfActor` / `actorOfExternalAccount` convert a chat `ActorRef`, `externalAccountOfHostAccount` converts a code host login that has a stable id, and `readExternalAccount` reads the legacy `slackUserId` field as an account of the `slack` provider (the neutral `account` wins; two that disagree give no answer, and `DeveloperSummarySchema` refuses such a pair). A sign-in method is an open id (`SignInMethodIdSchema`); `DeveloperSignInMethodSchema` stays as the closed list of `BUILT_IN_SIGN_IN_METHODS` for the hosted sign-in server. The code host
adapter only FETCHES a comment (`CodeHost.comments`: text, author, times, the change request it is on; the author's permission comes from `standing`). Code's default approvers read it through `fetchComment` and the request's thread through `commentContext`, and the checks are Rovara's (owner decision 66, `core/pr-commands/comment-checks.ts`): the right thread, written after the version was posted, never edited, `/rovara approve <version>` naming the version that waits, not a bot (`isBot`) or Rovara's own reply, a writer.

### Audit trail and "audit before add" (lane P6, item L2)

**The audit record commits with the change.** `rovara up` registers `DocumentAuditSink` (`packages/local-adapters/src/document-audit-sink.ts`, plug-in `@agentx/local-adapters/audit-sink`) as the `audit-sink` default. `stage(event)` returns ONE `put`
step for the caller's own `DocumentStore.transact`: an `AUDIT#` row (key: the company and the event id) in the same store as the change (state.db). So a change that is refused, lost to a competing writer (a losing approval, a lost merge claim),
or interrupted before its transaction commits leaves **no** row, and a change that commits always leaves one; the rule "audit before add" holds because the record and the add are one atomic step. The step's condition is "absent, or the same
facts" (who, what, on what, with which details; the time is not part of it): a retry of a committed event is harmless, and an event id reused for **different** facts makes the step fail, so the caller's transaction is refused rather than the
new facts being silently dropped. `record(event)` is the same single write for a caller with no transaction, and it rejects a reused id. A bad event throws before anything is written.

**The copy.** `audit.db` (mode 0600, its own file) is an append-only, hash-chained COPY (`SqliteAuditLog`), fed from COMMITTED `AUDIT#` rows only, through the store's change feed (`startAuditCopy`); it is never the primary record. SQLite
triggers refuse every UPDATE and DELETE, each row holds the hash of the one before it, and after each batch the feeder writes an anchor (row count and newest hash) into the store, apart from audit.db. `rovara up` checks the chain and the anchor at
start (`verifyAuditCopy`) and writes a `audit-copy.verify_failed` line to stderr if rows were changed, removed or cut off. It is a local record for the machine's owner, not a tamper-proof ledger (Cloud's ledger, its verifier and its outbox stay Cloud
only, decision 41). A test that keeps its records in memory (`storage: "memory"`) has the `AUDIT#` rows and no copy; a configured `audit-sink` plug-in replaces both.

### Company instructions (lane P6, item L1)

`company-instructions` is a read-only point that holds one adapter: `current(company)` returns the company's latest approved rules as `{ version, rules: [{ text, priority }] }` (priority `required` or `preferred`), or `undefined` for none. It is
the shape of Cloud's `CompanyInstructionsSource` so Cloud's port is a copy of this one; the sizes (30 rules, 600 characters each, 12,000 in all) and the snapshot schema are in `standing-instructions.ts`. There is no write method.
Code's adapter (`FileCompanyInstructions`, plug-in `@agentx/local-adapters/company-instructions`, the default of `rovara up`) reads `company-instructions.md` in the state folder (`~/.rovara` by default; a plug-in's default is the state folder the install runs from) at every call: bullets under `## Required` and `## Preferred`, a bullet with no
heading is Required, a line it cannot place is refused (naming the line) instead of being dropped, and the file must be a plain file owned by the user and not writable by others, in a folder that is a real folder owned by the user and not writable by group or others. At most 64 KiB are read from the open file. The version is the SHA-256 of the file's bytes, so it is also the hash a task records.
The file is outside every repository on purpose: a repository's writers cannot edit the company's rules.
The core builds the rules into the step's system prompt (`core/instructions`): the dispatch reads them at every step, so a step started after the file changed carries the newest, puts them first (Required, then Preferred), then the project's How we work (`docs/how-we-work.md`),
and refuses the step with a sentence when the file is over the limits, cannot be read, or the whole block is over the worker's limit. A worker that does not list `task.standingInstructions.v1` is refused the step, never sent it without the block.

### Team-record sources (lane K1; the unknown-source rule is lane P6, item T1)

**A new interface: the owner decides it alone (decision 63).** `team-record-source` (`packages/contracts/src/ports/record-source.ts`, many adapters) is where an outside system's events become team record
rows. The record itself (where rows are kept, how long, vectors, erasure) stays the hosted product's (decision 41); Code defines both sides of the seam so a source is written once:

- **`TeamRecordSource`**, the adapter: `source` (the id its rows and permission snapshots carry: `chat`, `codehost:<name>`), `capabilities` (`delivery`: `push` and/or `poll`; `existence`; where its
  permission snapshots come from: `item`, `place` or `none`; the retentions it can honour, `A` live only, `B` process then drop, `C` raw text 30 days, `D` full history) and up to three ways in: `receive(payload, sink)`
  for one delivery the host's route already verified, `poll({ workspaceId, scope, cursor, limit, deadline }, sink)` for a page of changes, and `exists({ workspaceId, system, nativeIds })` (an item deleted at its source
  is deleted everywhere; `forbidden` is never read as `missing`). Each answers counts (`written`, `duplicates`, `refused`, `failed`), never text; a write the sink threw on is `failed`, so the host delivers again.
- **`RecordSink`**, the host's write side, handed to the source on every call: `put(draft)`, `tombstone({ sourceIds | scope, cause })`, `changePrincipals`, `replaceScopeAudience`, and optionally `distillTransient` (retention B
  text, in memory only) and `ensureAccessSeed`. Its contract makes arrival order, repeats and deletes safe:
  - `put` is idempotent on company, source, system, item and version (`recordIdempotencyKey`); versions are ordered by `versionAt ?? occurredAt`, never by arrival; a per-editor change row (`sourceRef.order`) replaces nothing.
  - An item tombstone hides at once and is sticky: a put that arrives after the delete is refused.
  - A scope tombstone with cause `source_deleted` or `excluded` hides the place and every place under it (`recordScopeCovers`: `chat:T1` covers `chat:T1/C9`, not `chat:T10`) and CLOSES them: every later put there is refused,
    so a deleted channel or repository never fills again from a late retry or a backfill. `person_erased` and `project_archived` hide without closing. A draft's place is its restricted snapshot's scope, else its `scope` (`recordDraftScope`).
  - A sink repairs rather than refuses: the stored trust is lowered to the lowest of the draft's, its actor's, its pieces' and its quoted authors', and to at most `system` for outside text with no actor (`recordStoredTrust`); no text is kept under retention A or B (the row is stored without it,
    or not stored); links are trimmed to the first 20 valid http(s) links of at most 2,048 characters (`recordLinks`). It refuses only what is not a draft (`recordDraftRefusal`).
- **`RecordDraft`** keeps the hosted record's field names (`workspaceId` is the company id) and is written out as an interface, so the hosted taps' closed source and kind lists are assignable to it. `RecordDraftSchema`
  checks the shape. A SOURCE is held to more (`recordSourceDraftProblem`, used by the source suite): no text under retention A, a restricted snapshot that names its own source, and a row trust no higher than its actor's or a piece's.
  Text under B is allowed: the source hands it to `distillTransient`.
- Who a source's account is, the source's settings and the capture switch are the adapter's own dependencies, given when it is made (the host's people and settings), not part of the seam.
- **Code registers no source and keeps no record** (owner decision 102: no local team record in Code for now): `createRefusingRecordSink()` answers every write "this install keeps no team record". The fakes are `createMemoryRecordSink()` (keeps the whole contract) and
  `createFakeRecordSource()` (scripted deliveries and polls), in `packages/broker/src/ports/record-source.ts`. `tests/support/ports/record-source-conformance.ts` holds two suites: `runRecordSinkConformance` (for any
  sink) and `runRecordSourceConformance` (for any source, fed recorded deliveries; optionally made with settings it cannot read, when it must record nothing). The sink suite records with a `RecordSample` the harness
  supplies (a source, a row kind, a source instance and how a place is named) and calls the harness's `setup(workspaceId, scope)` before the first write in each place, so a sink that refuses unknown sources or places
  without settings writes its own settings first. Code's fakes use `CHAT_SAMPLE`. The hosted sink is meant to pass the suite over a test table; that has not been run yet.

The rule the point keeps is shared (`record-trust.ts`): a source id that nothing registered is never read as "everyone in the project". `audienceForSource(row, knownSources)` keeps the audience a registered source declared;
`knownRecordSources(registry, builtIn)` gives the `source` ids of the registered adapters plus the recorders built in and the reserved ids (`rovara`); two adapters claiming one id, or an adapter claiming a built-in or reserved id, is refused
(`PluginRegistryError` `already_registered`), because its rows would be believed as another system's. For ANY unregistered source it returns `unknownSourceAudience` (restricted to the project's maintainers,
`MAINTAINERS_GROUP`) and ignores what the source declared, even a restricted audience: a declared ACL can name any `acl.source` (so its principals would be read as another system's accounts), a broad group or any principal ids.

## Model key store

`ModelKeyStore.get(companyId, provider)` returns a `SecretValue` (it prints as `[secret]` in text, JSON and the console). Code has an environment
store (`ANTHROPIC_API_KEY`), a file store (JSON, refused unless only the owner can read it), a layered store and a memory store. Cloud
adapts the port to its secret store and proxy. On a laptop the keys are READ through the `secrets` point (next section): `rovara up`'s `model-keys`
adapter asks for `{ "env": "<PROVIDER>_API_KEY" }` and then `{ "key": "<provider>" }`, in that order, so the environment still wins over `keys.json`, and
`keys.json` keeps its rule (mode 0600, no link). Which providers have a key is the same store's answer for each of `anthropic`, `openai` and `openrouter` (the socket reads one reference at a time, so the listing asks it per provider), so `keys.json` entries for other
names are not listed. A worker never holds a key (the model proxy below reads it through this point).

## Secrets (owner decision 60, item R2)

The `secrets` point (one adapter) is where any adapter's secret is read: a code host's token, a webhook's signing secret, a model key. `SecretStore` in
`packages/contracts/src/ports/secrets.ts` has one method, `read(companyId, ref)`, which returns a `SecretValue` or `undefined`. An adapter names WHERE to read a secret
and asks the point; it does not write its own reader.

- **A reference is plain data**: an object with exactly one entry, whose key is the kind of source and whose value says which one (`SecretRef`, `SecretRefSchema`). A config file holds
  references, never the secret. The kinds belong to the adapter. Code's adapter (`createLocalSecretStore`) knows `{ "env": "NAME" }`, `{ "file": "/absolute/path" }` and
  `{ "key": "provider" }` (an entry of the owner's `keys.json`, the key file alone). `SecretSource` (`{ env }` or `{ file }`, `packages/broker/src/plugins/module-support.ts`) is Code's
  reference format for plug-in settings: it is a `SecretRef` that Code's adapter knows. Cloud's adapter later reads its secret service with its own kind (for example `{ "secretService": "<name>" }`);
  a kind an adapter does not know answers `undefined`, so one config can name sources for more than one install.
- **Failure is quiet**: no secret is `undefined`. A source that exists but must not be used or a reference that is not valid is an error with a FIXED sentence that
  never quotes a path, a variable's value or file content. Code's readers throw `LocalSecretError`: its message is safe to show, and it carries at most the system error CODE (never the system error, whose text quotes the path).
  Callers show only a `LocalSecretError`'s text; any other error from a `secrets` plug-in is replaced by a sentence of the caller's own (for the GitHub token: "the secrets adapter could not read the GitHub token (source kind: key)").
  A caller that wants one sentence for all of it (`secretReader`) says "the secret is not available".
- **A `{ file }` is held to these rules**: an absolute path with no link in ANY part of it (a system's own link such as `/var` on a Mac counts: name the real path; the last part is also opened with `O_NOFOLLOW`), a plain file (not a pipe or a device),
  owned by the current user, not readable by group or others (mode 0600) where the system has modes, and at most 64 KiB (at most that plus one byte is read, so a file that grows after the check is still refused).
- **Every answer is a `SecretValue`**: `createRegistrySecretStore`, `createSecretModelKeyStore` and `contextSecretReader` pass each answer through `asSecretValue`, which wraps an object that has `reveal()` and refuses anything else (a bare string would print), so `[secret]`
  masking always applies, even for a plug-in written without the class.
- **The company comes with each call**, as in every shared port. Code ignores it. `contextSecretReader` (a plug-in's own settings, such as a webhook secret) reads under the config's `defaultCompanyId`, which in Code is the one implicit company.
  That is right for an install-wide secret only: Cloud, which serves many companies, must read a company's own secret with `SecretStore.read(<the caller's company>, ref)`, or change the helper to take the company per call.
- **Read when used.** Nothing caches in the adapter, so a rotated key or token is picked up at once. The GitHub code host keeps a token for 30 seconds; the model proxy reads per request.
- **A plug-in uses it** through `contextSecretReader(context, source)`: the read goes to the registry's `secrets` adapter, looked up on every read (so it does not matter where in the config a `secrets` plug-in sits), and falls back to
  Code's own adapter when none is registered. `createRegistrySecretStore(registry)` is the same lookup as a `SecretStore`.
- **What moved behind it** (`rovara up`): the model keys (`createLocalModelKeyStore`), the laptop GitHub token (`resolveGithubAccess` asks `{ "key": "github" }`, then `GH_TOKEN`, `GITHUB_TOKEN` and the GitHub CLI as before) and a plug-in's
  `webhookSecret`. The rules stay: the key file must be owner-only; the model proxy is the only reader of a model key and a worker never holds one; a token that reaches every repository its owner can is not given to a worker unless
  `allowBroadTokenForWorker` is true. Both stay in the adapters that apply them, not in the secrets adapter.
- **A configured `secrets` plug-in is the source of truth**, everywhere, as `rovara up` and `rovara up --check` use it:
  the GitHub code host is registered only after the config's plug-ins are loaded, and only if the registry's `secrets` adapter (the plug-in, else Code's) or `GH_TOKEN`, `GITHUB_TOKEN` or the GitHub CLI gives a sign-in; the model providers listed (and so the model chosen) are the ones the plug-in has a key for;
  and `rovara up --check` loads the same plug-in and says which source answered ("the key file", "the environment", or `the "<name>" secrets plug-in`). With a plug-in, `keys.json` and the model-key environment variables are NOT read unless the plug-in reads them.
  It must answer the `{ env }` and `{ key }` references, or the install finds no key and `--check` says so.
- **Failures are named, not quoted.** When the model keys cannot be read, the task-start error and the model proxy's 503 say where to look: `~/.rovara/keys.json` for Code's own adapter, or `the "<name>" secrets plug-in` for a configured one; a plug-in's own error text is replaced by a fixed sentence
  (`the model keys could not be read from the "<name>" secrets plug-in`).
- **`SecretStore.close?()`** is optional: the adapter lets go of what it holds (connections, timers). `rovara up` calls it when it stops, and `rovara up --check`, which loads a configured plug-in only to ask it, calls it after the check so the command exits.
  The doctor loads the plug-in into a registry holding only itself, so a `secrets` plug-in that needs another plug-in (a storage, say) cannot be created there; `--check` says it is then only fully checked when `rovara up` starts.
- **Trust model of a `secrets` plug-in.** Only the owner names one: it comes from the plug-in config, which must sit in the owner's state folder (never a repository or a task workspace), and it runs in the broker with the owner's rights, like every
  config-loaded plug-in. It sees every reference asked, and so can answer, and so choose, every model key and the GitHub token; it is trusted as much as the broker itself. Task input and project files cannot name a reference.
  Install a `secrets` plug-in only from a source you trust as you would trust the broker.
- A conformance suite for every adapter is `tests/support/ports/secret-store-conformance.ts`.
- **AWS Secrets Manager (convergence lane A3, owner decision 72 O2).** Opt-in: `{ "point": "secrets", "name": "aws-secrets-manager", "module": "@agentx/broker/plugins/secrets-aws", "settings": { "region",
  one AWS identity, "namePrefix": "rovara/", "companyPaths"? } }` (`createSecretsManagerSecretStore` in `@rovara/aws-adapters/secrets-manager`; the module is `packages/broker/src/plugins/secrets/aws-secrets-manager/`, which shows the adapter's fixed sentences as `LocalSecretError`). Its reference kind is `{ "awsSecret": "<name under the prefix>" }`:
  the secret read is `namePrefix` + the value (the hosted product's names, such as `agentx/<env>/org-connectors/<company>/<id>`, read as they are), and the value is checked first (plain parts, no `.` or `..`),
  so no reference reaches outside the prefix. A value whose first part is one of `companyPaths` names a company's own secret and is read only when its second part is the call's company. A hosted (many-company) setup MUST set `namePrefix` to its environment's path and `companyPaths` (`org-connectors`, `org-hooks`); without `companyPaths` any name under the prefix is read for any company. `clientFor(companyId)`
  lets a deployment sign each company's reads with a session that reaches only that company's secrets (IAM is the second fence). Missing, scheduled for deletion or empty is `undefined`; a refusal, a KMS
  decryption failure, a binary secret or an outage is a fixed sentence that quotes neither the name nor the value. Read on every call. It knows no `{ env }` or `{ key }`, so with it
  configured the model keys and the GitHub token must be named as `{ "awsSecret" }` sources where they are read. Suite: `tests/unit/aws-secrets-manager.test.ts`.

## Monitoring (the `monitoring` point)

A monitoring adapter is one read-only source of operational facts (an error tracker, a metrics service, an on-call tool) that the owner connects to Rovara. The interface is small on purpose
(`packages/contracts/src/ports/monitoring.ts`): `kind` (the connection type it serves), `vendor` (words for the owner), `readOnly: true`, `takesSecret`, `tools()` (name, description and a closed JSON
Schema for each read-only tool) and `check(input)`. **This is a new interface (decision 42a); the owner decides it alone (decision 63), and the plug-in author is told.**

- The point holds many adapters, each named by its kind. Code ships `sentry`, `datadog`, `grafana`, `pagerduty` and `vercel` (`monitoring/native-adapters.ts`, over the connector specs in `connectors/native`); `rovara up`
  registers them after the config's plug-ins are loaded and before the registry is sealed, and a plug-in's own adapter for a kind is left in place. CloudWatch is an AWS service and is not one of them.
- `check` gets the company, the connection's **settings** (never its secret), the saved secret as a `SecretValue` (a kind that assumes a role has none) and **the only fetch it may use**: the core holds it to the vendor's
  origin (or, for an address the owner typed, pins it to the addresses it checked) and follows no redirect. An adapter never builds its own fetch, never stores the secret and never quotes it in a message.
- An adapter does not save a connection, approve a tool or widen what a tool may do: adding a connection and approving a tool are the owner's acts on a page (decision 66). Whatever a tool returns is data; the
  core frames it as untrusted text before a model sees it.
- `connectionChecksFromRegistry(registry)` answers the connection store's checks from whatever adapters the registry holds; a kind with no adapter is "not available on this install".
- Lane K1: `tests/support/ports/monitoring-conformance.ts` is the conformance suite (read-only, a plug-in name for its kind, unique tool names with closed arguments, ok only when the vendor says so, a refusal as
  `{ ok: false }` that never quotes the secret, never ok when the vendor cannot be reached, no vendor call when a secret-taking kind has none, and no fetch but the one it is given). The fake
  (`createFakeMonitoringAdapter`) and Code's Sentry adapter pass it; a hosted install's own adapters (its cloud's alarms, its context sources) run it too.

### Connection secrets

A connection's key or token is not in its record. The record keeps whether a secret was saved and the id of the version its own save wrote; the value is under the name
`agentx/<env>/org-connectors/<company>/<id>` (the hosted product's name, so a later switch moves no data), written and removed through `ConnectionSecrets` (`connections/org-secrets.ts`: `read`, `put`,
`scheduleDelete`). Code's adapter (`connections/local-secrets.ts`) keeps one file per saved version in `<state folder>/connection-secrets/<company>/` (folder `0700`, files `0600`, written without following a link,
at most 16 KiB) and **reads them back through the `secrets` socket** as `{ "file": "<absolute path>" }`, so that socket's file rules apply (no link in the path, a plain file that is yours, not readable by others, small).
A save writes its version first, and the record's commit decides which save won: a version no record names is never read. The newest two versions are kept; older ones are removed; removing a connection removes all.
A `secrets` plug-in that does not know `{ "file" }` makes saved connections read as "no key" until it does (a configured plug-in is the source of truth for reads).

## Object storage (lane L9a, PROVISIONAL: owner decision 58, until Pratik agrees)

The `object-storage` point (one adapter) is where files live that are too big or too plain for the document store: proof evidence, plan documents, a
worker's results. It is lane L7b's `EvidenceBlobStore` promoted to the registry: `ObjectStorage` in `packages/contracts/src/ports/object-storage.ts`
has `put`, `get` (with a size cap; an object over it is `undefined`, never cut), `stat`, `delete` and `deletePrefix`. Keys are paths of letters, digits and
`. _ = : @ + , ~ -` (`isValidObjectKey`), at most 1024 characters and at most 128 per part (the evidence erase's plain-id rule), no `.` or `..` part, so no adapter can turn a key into a place outside its store. An
object carries a content type, a few small text facts (at most 32 and 2 KB in all, `OBJECT_METADATA_LIMITS`: S3's own limit) and a retention class (the caller's word, such as `evidence-std`; the adapter maps it to days).
- **Immutable by default (L9-wire review).** A `put` on a key that holds an object refuses with `ObjectConflictError` and changes nothing; of two writers racing for a key exactly one wins (a
  conditional write in the document adapter, a hard link in the folder adapter). `put(..., { overwrite: true })` replaces on purpose. The proof evidence callers that rewrite a key
  pass it: `storeEvidenceArtifacts` (the key is the content's SHA-256, so a retried capture rewrites the same bytes) and `keepEvidence` (one pack per task and candidate digest, rewritten by a re-check).
  An object that has expired does not hold its key. The folder adapter keeps a part as one file name of at most 255 bytes, so a 128-character part that is mostly capitals is refused (`ObjectKeyError`). It publishes a new object with a hard link (the one step that fails if the name is taken), so its folder must be on a file system that has them; on EPERM, ENOTSUP or EXDEV it throws `FolderHardLinksUnsupportedError` and never falls back to a write two writers could both win.
- **Adapters in Code.** The document-store adapter (`createDocumentObjectStorage`, `core/proof/evidence-blob-store.ts`) is the default `rovara up` registers
  and holds only what fits a document. The folder adapter (`@agentx/local-adapters/object-storage`, `FolderObjectStorage`) keeps one file per object
  under a folder (default `~/.rovara/objects`), written by one rename after a sync, read through O_NOFOLLOW, with every folder checked to lie under the
  real root; capital letters and punctuation are spelled so keys that differ only in case stay apart on a case-insensitive disk.
- **Conformance.** `tests/support/ports/object-storage-conformance.ts` (`runObjectStorageConformance`) is the suite every adapter passes; the two
  adapters above run it in `tests/unit/ports-object-storage.test.ts`.
- **Proof code.** `EvidenceBlobStore`, `EvidenceBlobMeta` and `EvidenceObjectTooBigError` stay as names over the port, so the proof code needs no change; the
  wiring lane takes the store from `registry.require("object-storage")`.
- **S3 (convergence lane A3, owner decision 72 O2: the generic AWS adapters are public).** Opt-in: `{ "point": "object-storage", "name": "s3", "module": "@agentx/broker/plugins/object-storage-s3",
  "settings": { "bucket", "region", one of "profile" / "roleArn" / "allowAmbientAwsCredentials": true, "maxObjectMiB"?, "expectedBucketOwner"? } }` (`S3ObjectStorage` in the public AWS adapters package `@rovara/aws-adapters/s3`, `packages/aws-adapters`; the module that gives it an AWS identity is `packages/broker/src/plugins/object-storage/s3/`). It keeps the hosted
  product's layout so no data moves: the key as given (no prefix), the metadata as S3 user metadata (`x-amz-meta-*`), and a retention class as an object tag only when the settings map it (`"retentionTags": { "<class>": { "key", "value" } }`): the
  adapter names no tag itself, so no object can carry an expiry tag by accident; the hosted deployment passes its own map (`evidence-short`, `evidence-std` and `e2e-screenshot` to its tag), so its
  objects carry the tags they carry today. How long a tagged class is kept is the BUCKET's lifecycle rules; a class the map does not name is untagged and kept until deleted, and the adapter never sets a lifetime itself. Write once is `If-None-Match: *`; an object whose lifecycle expiry
  (`x-amz-expiration`) has passed reads as gone and is replaced only by its ETag (`If-Match`), so one writer wins there too. S3 lower-cases metadata names and keeps at most 2 KB, so this adapter
  refuses upper-case names, non-ASCII values and more than 2 KB (`ObjectMetaError`) instead of storing something that reads back different. `presignGet(key, { contentType, disposition,
  expiresInSeconds })` (not part of the port) signs a GET for one key with the content type forced and the disposition `inline` only for a picture or video type (`S3_INLINE_CONTENT_TYPES`), else always `attachment`, 60 seconds by default and 300 at most; the deployment passes the signer
  (`getSignedUrl` of `@aws-sdk/s3-request-presigner`, which Code does not depend on). Errors never carry S3's words. It passes the suite over a faithful S3 stand-in (`tests/support/ports/aws-fakes.ts`)
  in `tests/unit/aws-object-storage-s3.test.ts`.
- **Not here (decision 51).** A sweep of expired files in the folder adapter (an expired object is reported absent and removed when it is next read).

## Local model proxy (lane L9a, PROVISIONAL: owner decision 58, until Pratik agrees)

The worker never holds a model key. `packages/broker/src/local/model-proxy/` is a small proxy served on the callback listener: a worker asks for a
token with its callback capability (`GET /v1/internal/model-access`, action `model-access`) and sends model calls with it to `/v1/internal/model-proxy/v1/...`;
the proxy reads the real key through the `model-keys` port, forwards to the provider, meters through the `metering` port and holds the task budget. It
mirrors Cloud's proxy (packages/model-proxy in Cloud is LiteLLM plus a Python guard, which Code does not carry): the guard's per-route field allow-lists,
header bans, `anthropic-beta` allow-list and no-redirect rule are carried over field for field (`providers.ts`). Details and limits are in `docs/local.md`.
Interfaces added: the `model-access` callback action, `ModelGrantSource` (what a capability entitles an operation to), the `x-rovara-workspace` stamp the
egress gateway puts on worker calls, and `AGENTX_MODEL_PROXY_URL` in a worker machine's environment.

### Model providers (lane P5, item K2; owner decisions 60 and 61, 63)

A new plug-in point, `model-provider` (many adapters, registered by provider id; the adapter's `kind` is the id, as for a code host). `ModelProviderAdapter` (`contracts/src/ports/model-provider.ts`) states the provider's name, `address`,
`signIn` kind, request `formats` (each with an optional path override, the `vertex` variant of messages, and capability flags), an optional `defaultModel` and `prices`, and an optional `credential()` for a role or a refreshed token.
The provider id is open text (the key store's `provider` always was). The three formats are `anthropic-messages`, `openai-completions` (chat) and `openai-responses`, the worker's `InvocationModelRoute.api` values. Code registers
`anthropic`, `openai` and `openrouter` as default rows; Bedrock is a normal provider with SigV4 sign-in (`bedrockModelProvider`). The local model proxy looks providers up per call: keys and tokens still never reach a worker, the
guard's allow-lists are untouched, and the task budget reads the provider's price table through `metering`. Details and limits: `docs/local.md`, "Model providers".

- **The older closed list stays** (`MODEL_PROVIDERS` in `contracts/src/model-providers.ts`): it is Cloud's list of providers an administrator can configure for a role, and Cloud moves to the plug-in point later (Code first).
- **Cloud rule, for later (documentation only).** A custom provider address in Cloud must be an administrator-approved HTTPS address; Cloud refuses `http`, an address with sign-in data, and an address not on the approved list, and
  the provider's `prices` and `address` are never taken from a project or a task. Code's rule is the laptop one: `https`, or `http` for this computer only.
- **The broker's own one-shot calls.** A diagnosis (Fix with agent) is a model call the broker makes for itself, so it has no worker, workspace or operation record. It goes through the same proxy and the same rules: the broker mints a token in-process (`ModelTokenBook.mint`, never through the capability route) for a one-shot operation of its own (`OneShotOperations`, live only while the call runs, so the proxy's `active` check ends the token with the call), and calls the callback listener over loopback. The route carries a spending cap priced from the model's own rates (a model with no price is not used), and the proxy meters the call as it does a worker's. No interface changes: `ModelGrantSource` is wrapped (`withOneShotOperations`), not extended.

## Code host, tracker and check runner

These three points hold Cloud's ports (`packages/contracts/src/plugins/`), which use neutral words only: change request, revision, check,
review, item. A caller reads an adapter's `capabilities` and never branches on its name. The adapters are in
`packages/broker/src/plugins/<point>/<name>/`; the lookups Cloud's own registry did are plain functions over the one registry in
`plugins/routing.ts`.

| Point | Port | Adapters here | Registry name |
| --- | --- | --- | --- |
| `code-host` | `CodeHost` | GitHub (`code-host/github`), fake | the adapter's `kind` (`github`, `fake`) |
| `check-runner` | `CheckRunnerAdapter` (a factory: `create({ allowedRepositories })` gives a `CheckRunner`) | GitHub Actions, CodeBuild (optional, AWS), fake | `github-actions`, `codebuild`, `fake-checks` |
| `tracker` | `Tracker` | Linear, fake | `linear`, `fake-tracker` |

- **The registry name is the adapter's `kind`.** `register` refuses a code host, tracker or check runner whose `kind` differs from the
  name it is registered under, so a lookup by name finds the adapter that calls itself that.
- **Routing.** `codeHostForRecord(registry, repository)` picks the code host by the repository record's `host.kind`; a record with no
  `host` (written before the field) is on the default connection of the legacy provider `github`. `codeHostForKind`, `trackerForKind` and `checkRunnerForKind` do the
  same by kind. A kind with no adapter is refused with a fixed sentence that does not name the kind, and nothing falls back to another
  adapter. `assertRepositoryHostsKnown` refuses a task start whose repositories name a code host nobody registered. A repository's `host` may be written (lane P2, item C2); see
  "Code host connections" below.
- **Code host connections (lane P2, item C2, decision 60).** A code host adapter is a *connection*: it has a name (`github`, `github-company`; equal to its `kind` and to the name it is registered under) and a
  provider (`CodeHost.provider`, the kind of host it is; absent means its own name). Several connections can share a provider: register one module per connection
  (`githubCodeHostPlugin({ name: "github-company", createProvider })`). A repository record names a connection with `host.kind`; when no connection has that exact name but the name is a provider,
  that provider's **default connection** serves it, and so does a record with no `host`. Exactly one connection of a provider is its default: the only one, or the one whose settings say `"default": true`
  (`CodeHost.defaultConnection`). The repository's explicit connection name always wins; only a record that names none (or names a provider with no connection of that exact name) uses the default: no connection name is special, not even `github`. Several connections with no default, or two defaults, are refused with a fixed sentence, and the config loader refuses such a config when the process starts
  (`connectionProblems`). Nothing falls back to a connection of another provider. The worker's clone and push credential comes from the connection the repository's record resolves to (`codeHostForRepositoryAddress` over the registered records; an address held by records that RESOLVE to different connections is refused; records that name the same connection in different ways agree), the same one its pull request and merge calls use. The check runner and the team lookup are the ones registered under the connection's own name, and only when there is none the provider's (so a second connection never uses another connection's credential unless the install registered the provider's runner for all). Repository keys, the head index, the linked pull request rows (also when a fix or sync moves them to a new candidate) and revert detection and its index are filed by the connection's *provider* (a GitHub connection is `owner/name` whatever it is called, so renaming it orphans nothing); a row an earlier build filed under the connection's own name is still read. A GitHub Enterprise address
  (a base URL for a connection) is not built: the GitHub adapter still accepts github.com only. `GitHubCodeHostProvider` is a lasting extension point (for `gh` and personal-token clients), not a temporary seam.
- **Neutral code-host types (lane P2, item C4, decision 60).** The port speaks Rovara's words and a host's adapter maps its own: the merge state is `clean`, `conflicted`, `behind`, `blocked`, `unstable`, `draft`
  or `unknown` (GitHub's `dirty` and `has_hooks` are mapped in `plugins/code-host/github/mapping.ts`); an account is a `person`, a `bot` or `other` (`HostAccountKind`; only a person can approve); a permission
  is `admin`, `write`, `read` or `none` (`HostPermission` is the mapping target); a reviewer is a `hostUserId` string (the core's approval rules say `hostUserId`, `accountType`); change request ids and commit ids are strings
  and a commit id may be any hash length (`COMMIT_ID_PATTERN`: 40 to 128 lower-case hex digits; the core never decides it is SHA-1, an adapter that knows its host's exact length holds it); the code owners of a branch
  are read and understood by the host (`CodeHost.codeOwners()` answers a `CodeOwnersRead`; the CODEOWNERS file syntax lives in `plugins/code-host/code-owners-file.ts`, not in the merge core); a required check is
  `{ name, source }` where `source` is an opaque word the host also puts on the matching check; whether a check's log can be read is the host's word (`Check.logReadable`), not a comparison with an app id in the core.
  The tracking item's `approval.githubUserId` is now `approval.hostUserId`; an item written with the old spelling still reads and is rewritten with the new one.
  **GitHub pins on another connection:** `host: { kind: "github-company", provider: "github", installationId, repositoryId }` carries the same pins as `kind: "github"` (a connection of any other provider has none), so the transferred-repository check can apply to it.
  **Not done, and why:** the stored pull request `number` (the tracking item, the workflow snapshot's pull requests, the keys) is still a number, because it is the layout Cloud shares and changing it is a data
  migration (the port itself, the refs and the events already use strings; a host with non-numeric ids needs that migration first). `WorkflowFixPayload.startFrom` (a line of the worker's job) stays 40 hex (decision 65).
  The person-linking records (`githubMemberKey`, the learning rows' `githubUserId`) are the identity lane's (I2).
- **Lessons file methods (lane P2, item C1, decision 59).** `CodeHost` has optional `commitFiles` (an expected head, allowlisted branch `rovara/lessons-<12 hex>` and paths, never the base branch, never an existing
  branch for a new change request), `changeRequestForBranch`, `deleteBranch`, `PathKind` `"symlink"`, and the change request facts `authoredByRovara` and `baseRepositoryId`. They are copied from Cloud's lessons repo
  file lane (`commit-files.ts` is `github-commit-files.ts`). A host without them has no lessons file; nothing else changes. On a laptop signed in with the owner's own token `authoredByRovara` is absent (the host
  account is the owner's, so Rovara cannot tell its own pull requests from the owner's): never a guess.
  The lessons pass (`lessons/repo-file-*.ts`) calls them, with `guardTarget` and `verifyRepository` first and a `"symlink"` path read as not a file; it runs only for a repository the owner switched on.
- **External checks (lane P2, item C5, decision 61).** A repository's `externalChecks` are `{ provider, name, reference, timeoutMinutes }`; `codeBuildGates` is the same list in CodeBuild's words and stays readable
  (the two share one set of names, at most 8 together and 420 minutes). A worker is still sent `codeBuildGates` only (its job line is unchanged, decision 65), made from the CodeBuild checks by
  `workerProjectDefinition`, in the order of `repositoryExternalChecks` (generic checks first). A check of a provider no runner of this release runs is refused when the project is saved and when a task starts (before any machine), with a clear sentence; the dispatcher turns the backstop throw into a failed operation. Cloud must not take `externalChecks` until its worker and record readers do (DEFERRED-CHECKS, P2-EXTERNAL-CHECKS-CLOUD-ADOPTION). The check-runner factory (`CheckRunnerAdapter.create`) stays synchronous and takes
  only `allowedRepositories`.
- **No edition gate and no required adapter.** Any kind registers; a registry with no code host simply refuses lookups.
- **A check runner is built per project.** CodeBuild builds for the repositories that project registered and refuses any other.
- **A plug-in module needs its client.** A config entry names a small module that exports `plugin` built by a factory, which is told how the
  install reaches the outside system: `githubCodeHostPlugin({ createProvider })`, `githubActionsPlugin({ createProvider })`,
  `codeBuildPlugin({ createGateway })`, `linearTrackerPlugin({ createAccess })`. The settings block holds names and options, never a secret:
  a secret is `{ "env": "NAME" }` or `{ "file": "/absolute/path" }`, read when it is used. A file is opened without following a link, must be
  a plain file of at most 64 KiB and not readable by other users (the model key file's rules).

  ```json
  { "point": "code-host", "name": "github", "module": "./adapters/github.js",
    "settings": { "credentialRef": "github", "webhookSecret": { "env": "GITHUB_WEBHOOK_SECRET" } } }
  ```

  where `./adapters/github.js` is `export const plugin = githubCodeHostPlugin({ createProvider: () => myGitHubClient })`.
- **The company in the config is an organization id** (`org_` and 20 lower-case letters or digits, `IMPLICIT_COMPANY_ID` by default),
  because code-host and tracker calls carry it as their scope (`HostScope`).
- **The fakes** (`plugins/fake/`) are test helpers with public webhook secrets; they are not in the broker's exports.
- **The GitHub client is a seam of its own** (`code-host/github/provider.ts`, `GitHubCodeHostProvider`). The GitHub adapters are bound to that
  interface, not to `github-app.ts`: this tree's `GitHubAppCredentialProvider` is the older client and lacks 15 of the 24 methods (status,
  feedback, merge, working branches, code owners, standing, path kinds, credential expiry). The plug-in module refuses a client that lacks
  any method when the process starts, naming the missing methods. Cloud's client, a client built on `gh` or a personal token for the local
  runtime, and the test fixture can all sit under the adapters. The adapter holds the cheap input rules itself (working branches `agentx/<uuid>`
  only, an organization scope and pages 1 to 1000 for the branch listing); the rest (tenant binding on every call, least-privilege tokens per
  repository, no redirects) are rules the client must keep, written on `GitHubCodeHostProvider`.
- **Cloud's GitHub client is in this tree** (`code-host/github/client.ts`, a copy of Cloud v0.5.11's `github-app.ts`; `app-client.ts` hands it over as the provider and its
  assignment is the seam check). The older `github-app.ts` stays for the AWS install until lane L13. Anything put under the adapters runs the **client conformance suite**
  (`tests/support/ports/github-client-conformance.ts`, run by `tests/unit/github-client.test.ts` over a fake GitHub HTTP server, never the real one): the tenant binding is asked
  on every call (a repeat and a cached installation or token included) and a refused binding stops the call before a token is minted or a repository is read; a clone credential
  is minted with `contents: read` and a push credential with `contents: write`, nothing else, for the one repository, and no call mints a token for more than one repository or
  a write for a read; every request refuses redirects and has a timeout, and a redirect is never followed to another host; GitHub's rate limit is the neutral error; an unsafe branch or
  path never reaches an address. The suite found five Cloud requests (create, update and read of a pull request, a commit tree, the open-pull-request lookup) with no redirect refusal
  and no timeout; `client.ts` now has both there (marked `L7a`; the suite fails with any one of the five removed), and Cloud should take the same fix. It also pins the exact
  permission set each method may mint a token with, so a widened scope (not only a write) fails, and fails when a method never reaches the repository (a path it cannot see).
- **The laptop's GitHub client signs in with the owner's own token** (lane L11: `code-host/github/token-client.ts`, the adapter `token-code-host.ts`; `rovara up` registers every code host it finds a sign-in for under its kind, through
  `createLocalCodeHosts`; a configured entry of that name replaces it). It is Cloud's `client.ts` unchanged and answers only the App's two requests itself (the installation lookup becomes one read of the repository with the
  owner's token; the token mint hands back the owner's token for that one repository, the one the check read, after checking the token can see it, and can push for a write): its redirect refusal, time limits, rate-limit mapping
  and body bounds are Cloud's. No App request and no App JWT ever leaves the process, the token goes to `api.github.com` only (a `Request` is folded first, a credentialed request is forced to refuse redirects), and only the provider's
  methods are reachable on it. It passes the client conformance suite under the `owner-token` credential model; the mint checks are real there, because the client reports each token request it answers (`observeMint`).
  **What a personal token cannot do:** GitHub mints narrow, short-lived credentials for an App only, so clone and push use the owner's token, and the credential's `expiresAt` is Rovara's own 50-minute re-issue time (never later than the
  token's own expiry). **Three rules stand in for the App's narrowness.** (1) A token that reaches every repository its owner can (a classic token, the GitHub CLI's, any shape that is not a fine-grained `github_pat_` or an `ghs_` installation
  token) is refused as the worker's credential unless the config says `allowBroadTokenForWorker: true`; broker-side reads are unaffected. (2) Only the repositories of the company's registered projects are used, checked before any request that
  carries the token (the registration reads `checkRepository` and `getRepositoryIdentity` are the exception, so a repository can be registered). (3) The binding to the company is asked before anything is sent. **Rovara's own replies** are the
  owner's, so each is one line, a blank line and a hidden marker, and only the token owner's comments in exactly that shape are left out of feedback; an unreadable owner login fails the feedback read. The worker's git refuses redirects
  (`http.followRedirects=false`) and its askpass answers only for github.com and the host of the address it was given. The synthetic installation number the branch listing pins is derived from the owner's name; it is not a GitHub installation id.
  **Sign-in and the setup check are the adapter's** (BOTH-OWNERS-INTERFACE-ITEMS C3, approved in decision 61): `CodeHost.resolveCredentials?()` finds the sign-in (key file, `GH_TOKEN` / `GITHUB_TOKEN`, then `gh auth token`), says where and returns
  no secret; `CodeHost.checkAccess?()` tests the connection once (`GET /user`) and answers `ok`, `warn` or `fail` with the fix in words (a broad token is a `warn` that recommends a fine-grained, repository-limited one). `rovara up --check` calls
  them instead of GitHub-specific code, and `github-access.ts` moved into the adapter. (Decision 59's optional methods are in Code's contract and the client since lane P2: `commitFilesToBranch`, `findLessonsPullRequest`, `deleteLessonsBranch`.)
  **51 follow-up for both owners:** a broker-side git relay so a worker never holds the token at all (the broker adds `Authorization` only for the granted repository and refuses pushes outside `refs/heads/agentx/*`).
- **The merge core calls the routing.** `core/merge/` (lane L7a) reaches a repository through `registryRepositoryResolver(registry, ...)`, which picks the code host by the
  repository record's `host.kind` (`codeHostForRecord`). The task flow's other calls to `github-app.ts` move in their own lanes.
- **Untrusted text** from a code host or tracker (comments, logs, item bodies) is data: it reaches a model only inside a labelled block, and
  the GitHub mapping cuts every text to the port's bounds so a long comment never fails a read.
- **Linear and Jira.** Both adapters bring their own client for a laptop (`tracker/linear/api.ts`, `tracker/jira/`); see "Tracker intake and write-back" below. The Linear adapter carries its own copy of the Linear webhook rules (`tracker/linear/webhook.ts`: the signature check, the issue key
  rule and the issue-created mapping) because Cloud's adapter imports the trigger framework, which is not ported. The install gives the
  adapter what it may do (read an issue, post a comment, the hook's signing secret); what it is not given, it does not offer.

**Public names (decision 58-60, item R1).** The plug-in contracts are public API, so their words are neutral. `HostScope`'s system caller is `webhook` or
`install` (the install's own work); `private-install`, the name the first copy used, still parses and reads as `install` for one release, then goes. The
company id keeps the `org_` shape (Code's implicit company already uses it). The comments that said adapters are "never loaded from outside" or came from
"Enterprise foundations" are fixed: Code loads the adapters its owner's config names (decision 40), and nothing is Enterprise-only.

Not ported with these points (they are in Cloud's `plugins/` and belong to later lanes): the event intake and poller
(`events/`, which keep their state in DynamoDB and move onto the document store), and `github-only.ts` (the "this step speaks GitHub only" refusal). The tracker start path is `core/intake/tracker-events.ts` (see below).

## Tracker intake and write-back

A tracker starts a task and hears about it. The intake engine, its store, the poll, the ticket updates and the session's binding to its ticket are Cloud's, moved onto the document store; every tracker-specific word is in an adapter.

- **The rule (`core/intake/engine.ts`).** A task starts only from a **member's act**: who put the label on (or assigned the ticket) is resolved, through the **identity port** (`resolveExternalAccount` over the neutral outside-account shape `{ provider, tenant, accountId }`: a Linear user id with no tenant, a Jira account id with the site as tenant), to a person the install knows; that person's right to start work is asked of `TaskAccess.checkStart`; the start is the task flow's own `start`, so admission, limits and the project's rules apply. Anyone else, an automation, or an act made right after Rovara changed the ticket (`own-writes.ts`: Rovara notes what it writes before it writes it) waits as a row for the owner to start or dismiss. A ticket **never approves**: the task is a workflow whose plan waits for the owner. An account of another provider than the ticket's tracker is nobody's. The code is tracker-free; `IntakeCandidate.trackerWord` lets an adapter say its deliveries are believed only on its own word (`confirmActor`).
- **Reading (`Tracker.askedFor`, new, optional).** A tracker that cannot send a hook is asked: `askedFor({ when: { label | assignedToRovara }, connection?, limit, signal }, scope)` answers the open items that carry the label or are assigned to the sign-in's own account, each with its title and body (data), the writer, **who did it from the tracker's own history** (a `TrackerActor` with an `ExternalAccountRef`), and the tracker's own change-log entry. A failure is a `TrackerSearchError` with a fixed code (`CONNECTION_MISSING`, `CONNECTION_AMBIGUOUS`, `CONNECTION_REFUSED`, `RATE_LIMITED`, `SEARCH_FAILED`), never the tracker's words. `capabilities.intake` says it. A tracker that sends a hook uses `core/intake/tracker-events.ts` (`events.normalise`, then the item read fresh) into the same engine.
- **Writing (`Tracker.comment` with `TrackerCommentOptions`, `Tracker.setStatusByName`, new, optional).** `comment(ref, body, scope, { key, requirePrivate })`: the same `key` is the same comment (Linear: a comment id made from the company and the key; Jira: a comment property holding a hash of the key, found again only when the sign-in's own account wrote it), and `requirePrivate` makes it internal where the tracker can tell. `setStatusByName(ref, name, scope)` moves the item to the status the project calls `name` (matched without case) or says `no_such_status`. A refusal is a `TrackerWriteRefusedError` (`needs_write_access`, `not_found`, `no_such_status`, `not_connected`); a rate limit or a fault that may pass is an ordinary error and the milestone is delivered again.
- **The write-back (`core/ticket-updates/`).** A milestone handler (`app.milestones.register`) on five moments (`started`, `plan_ready`, `pr_ready` as `pr_opened`, `merged`, `closed`); the first, second and last are written as milestones by `moments.ts` (the plan and the close from the session summary's change hook). It writes only to the ticket the task's session is bound to **and** intake's own item says started this task; fixed words, the task's title made inert, the status moved to, and the pull request's https link; one claim per moment, 12 writes a task and 120 an hour a tracker; a tracker that refuses is noted per tracker (`readWriteAccess`).
- **The binding (`core/sessions/bindings.ts`).** A task's session and its ticket follow each other, bound in the start's own transaction (`startExtras`): the session's `BINDING#tracker_item` row and the reverse `SESSION_SURFACE` row, written together, each only if absent; a ticket follows one session, so a start for a ticket that already follows another is refused. A task started from a ticket keeps `ticket: { system, id }` on its record (set by intake only, never by a request), and the plan page credits its request to the ticket ("from ticket ENG-1"), not to the owner; the request holds the ticket's words in one fenced block no line of the ticket can close, labelled with an id only this install can make. A Linear ticket and a `linear_issue` binding are one surface. The merged milestone and the session view read the bindings, and a Linear ticket's pull request says `Fixes <KEY>`.
- **Who asked (the history).** The account is the author of the change that LAST touched the label (or the assignee) in the issue's WHOLE history, ordered by the changes' own times, never the order of the answer; it counts only when that change put the label on. A removal after it, a tie, a change with no readable time, or a history not read to its end (Linear: more than a few pages of 100; Jira: a change log with no total, or not ended within ten pages) credits nobody, and the ticket waits for the owner. The time of the act is passed on (`occurredAt`), so the own-write windows are measured from it.
- **The poll (`core/intake/poll.ts`).** `rovara up` polls every source (`pollAll`: a laptop has no webhook). It is due by `nextPollAt`, taken by a conditional update, counted per hour, backed off on failure, and a source that has failed for an hour is noted for the owner (`INTAKE_NOTICE` rows and the log). Sources are the project's **intake rule** (`core/intake/sources.ts`): one row each in the one `INTAKE_SOURCES` partition, at most eight a project.
- **Keys.** Cloud's layout, unchanged: `INTAKE_ITEM`, `INTAKE_SOURCES`, `INTAKE_SOURCE_COUNT`, `INTAKE_CALLS`, `INTAKE_EVENT`, `INTAKE_CHANGE`, `INTAKE_OWN`, `INTAKE_NOTICES`, `TICKET_UPDATES`, `TICKET_UPDATE_CALLS`, `TICKET_WRITE_ACCESS`, `SESSION_BINDING`, `SESSION_SURFACE`, and a task's `TICKET_UPDATE#` claims. Who a tracker account is has no Cloud row here: the identity port answers (Code's local identity reads `linkedAccounts` from the config; Cloud's links live in its team record).
- **Not here.** Cloud's org connections and their stored keys (a laptop's sign-in is read from the secrets socket), the tracker people page and the member links (identity), the Home cards, the setup-agent applier, the webhook receivers and the trigger framework, GitHub Issues as a ticket source, the Ask in Linear comments, and linking a session to a ticket by hand (`session link`). Linear and Jira are the only adapters; a third registers itself under its own kind with no change here.

## The channel point and Pratik's registry

`registry.get("channel", name)` returns a `ChannelAdapter`: Pratik's `ChannelCapabilities`, `projects`, `stepUp`, `deliver(ChannelEvent)`
and, for in-process adapters, `start(sink)`. The sink applies the same binding, link, decision and step-up checks as the channel API
(`ChannelInboundSink`). **Not done in W0:** the registry is per process, while Pratik's records live in the state table, so an adapter
registered by an HTTP call is not yet visible to other processes. The follow-up is a record-backed source that wraps each stored
`ChannelAdapterRecord` as a webhook `ChannelAdapter` (signing in `deliver`), and a rule that refuses a config name already used by a
record.

**Slack is an ordinary `channel` adapter now** (owner decision 58). `AdapterChannelIdSchema` takes any channel id, `slack` included; the id a webhook adapter may be REGISTERED over HTTP under (`RegisteredChannelIdSchema`) still excludes `slack`, because the hosted product serves that chat tool on its own built-in path until it moves onto the adapter. The in-process adapter is `packages/broker/src/plugins/channel/slack` (module `@agentx/broker/plugins/channel-slack`; see `docs/local.md`, "Chat and notices"). What an in-process adapter hears goes through `createChannelSink` (`core/channel/sink.ts`), which applies the channel API's checks: the actor and the conversation share a tenant, the space is bound to one of the adapter's projects, the adapter's event id is used once, the account is linked to a person (an unlinked one gets a one-use code, once an hour), and a decision matches an open card Rovara posted (`core/channel/cards.ts`) for that exact conversation, revision and digest, of a kind the adapter may decide (`adapterMayDecide`), before the `decide` seam asks the approval gate with a credential of the method `chat-<channel>`. Links, bindings, cards, claims and the thread of a start are stored under the company scope (`ORG#<company>#...`, decision 58); the hosted adapter registry's records (`CHANNEL_ADAPTERS`, and the unscoped link keys of registered adapters) are unchanged.

**For a many-company host.** The sink reads its company and its person from two seams (`companyOf`, `personOf` in `createChannelSink`), with Code's single company and the owner's links as the defaults: a host whose chat app serves several companies answers `companyOf` from a tenant-to-company index, and a host that identifies people by its own sign-in answers `personOf` from that identity data instead of link rows; every key the sink reads or writes is then under the company that answered. The work seam's items carry the company. Moving a host onto these keys needs a backfill: `ORG#<company>#CHANNEL_TENANTS` (one row per channel and tenant a space is bound in, `<channel>/<tenant>`) is new, so existing bindings must get their row or `listAllChannelBindings` will not find them; unbinding leaves the row, which is harmless. Hosted Slack bindings already use the same `ORG#` layout.

A chat method is one act: `chat-<channel>` is never a strong method. `isCommentMethod` (`core/decisions/strong-methods.ts`) matches it with `code-host-*` and the plug-in's `commentMethods`, so the gate drops it from the high-risk and reject sets whatever an approvers plug-in names, and the credential carries the account that pressed (`claimedAccount`) for the plug-in to check against its own identity data.

New optional field on `progress` event data: `onlyTo`, the one account that may see the text (a link code goes to the person who asked, never to the thread); an adapter that cannot show a message to one person must not post it. The Slack adapter posts it as an ephemeral message. A Slack account of another workspace than the conversation's (a guest from a shared channel) is taken from the speaker's own workspace, and the sink gives it nothing. A Slack conversation's space may now be a direct message; a host with its own Slack path should check nothing there relied on channel ids alone.

New optional field on `ChannelAdapter`: `noThread`, the thread id the adapter reads as "no thread" (a message at the top of a space, such as a direct message). A Slack conversation's space may now be a direct message (`D...`); a binding of a space to a project stays on channels.

### Neutral MCP names (item H3)

The MCP tools an AI tool calls use chat-neutral names, so a second chat adapter needs no schema change. The old names still work for **one release**, then go:

| Neutral name | Replaces | Where |
| --- | --- | --- |
| `share` (boolean: `true` posts the task in the project's chat channel, `false` keeps it private) | `share_to_channel` | `agentx_start`, `agentx_start_task`, `agentx_start_workflow`. `channel` stays the string that names which bound channel to use; a name alone does not ask for a share (a project that requires sharing shares anyway, as before). The two spellings must agree when both are given. |
| `channel_user` | `slack_user` | `agentx_whoami`, and each entry of `channel_turns` in a task answer (both names are sent) |
| `plugins`: one row `{ point, name, status, detail? }` per plug-in set up on the install (a chat or code-host adapter with no probe has no row) | `slack`, `github` | `agentx_admin_health` and `GET /v1/admin/health` (both old fields are still sent, with status unknown when not set up; an older server's answer is turned into rows) |
| `sign_in_provider` and `sign_in_kind` (`chat` or `company`) | `sign_in_method` | `agentx_whoami` |
| `source` (`chat` or `ai_tool`) | `origin` (`slack` means `chat`) | `agentx_admin_failed_tasks`, `agentx_admin_list_workspaces` and the turn records of `agentx_admin_turns` (output, both sent); `agentx_admin_turns` input (`origin` is read as before, the two must agree) |
| `channel_team_id`, `channel_user_id`, `channel_user_name` | `slack_team_id`, `slack_user_id`, `slack_name` | `owner` in `agentx_admin_list_workspaces` (both sent) |

Wording only: the tools' descriptions and the fallback name of a task person with no name now say "chat" where they said Slack (`Chat user`, and the requester text `chat member <id>`).
**Not renamed (internal REST bodies and values, a later lane with I2):** `slackUserId` on the developer principal, task people and turn authors, `shareToChannel` on the start request, `origin: "slack"` in the control plane's records, the `slack_unavailable` notice code, `AdminRequester.kind "slack"`, and the group keys of `agentx_admin_usage` when grouped by origin.

## Build systems (lane P6, item B1)

A `build-system` adapter is a way of building code that the built-in detectors do not know. It has a `name` and a `profile()` that returns a `BuildSystemProfile` (`packages/contracts/src/ports/build-system.ts`):

| Field | What it is for | Where it ends up |
| --- | --- | --- |
| `detectorModule` | A package name the worker image installs, or an absolute `.js`/`.mjs` path inside the image. It exports `detectors: [{ name, run }]` (`run` is the worker's `Detector`). | The worker runs them after the built-in detectors, in the detector thread under its wall clock and memory limit. A name may not be a built-in's. A module that cannot be loaded adds a fixed-words note and nothing else. |
| `setupPrograms` | Program names (never a shell such as `sh` or `bash`, or `env`, `xargs`, `sudo`) the setup governor groups into steps by subcommand (`examplebuild build //a:b` is its own step, as `npm ci` is). | `setup-agent-journal.ts`, set once at worker boot. |
| `keyFileGlobs` | Files whose content decides what a saved environment holds. | The rebuild job builder (`savedEnvBuildInputsOf`, `core/test-env/saved-env-rebuild.ts`) merges them into the job's `detectorGlobs` AND into the broker's own key-file listing with `detectorGlobsWithBuildSystems`, so the worker and the broker hash the same files and a changed key file changes the environment key (`BUILD_SYSTEM_KEY_FILE_GLOBS_WIRED` is true). More than 200 globs in all fails closed. |

**It does not travel in a job.** A module path in a job would let every job name code for the worker to load. The profile is the operator's, like the worker image: the machine launcher (`DockerWorkerMachines`, option `buildSystems`,
read from the registry with `collectBuildSystemProfiles`) puts the profiles into the worker's start-up environment as `ROVARA_BUILD_SYSTEMS`, a name a machine spec cannot set. The worker reads it once at boot and refuses to start on a value it cannot
read. The worker also refuses an absolute module path that lies inside its workspace, where repositories are checked out. No line of the worker job (`operation.ts`, `protocol.ts`) is added or changed (decision 65). A profile that is not valid,
or that carries a name other than the adapter's, stops the machine from starting.

**Trust (for the owner, decision 65).** A plug-in detector is trusted, owner-configured code that runs **with the worker's own powers**: the bounded reader limits only what the built-in detectors are handed, and an imported module has `fs`, `child_process` and the network like any other code in the worker image. It parses text from the repository, so a bug in it is worker code execution. Install only a detector you would install into the worker itself. When no detector thread can be started, plug-in detectors are **not** run (and a fixed-words note says so); they are never imported into the worker's main thread. The real-path check of an absolute module path and the later import are two steps; a file the operator swaps in between is imported, and no repository, task or job can reach that window.

The internal build-system detector stays an optional plug-in package outside the core (decision 45.11).

## Setting a project up (the setup agent)

The setup agent (`packages/broker/src/core/setup-agent/`, the owner's side in `docs/local.md`) is core code on the existing ports; it adds no plug-in interface and changes none.
- `DocumentStore`: the run's pointer, journal, commands, website asks, the proposal row and the candidate revision are plain rows under Cloud's `SETUP_DRAFT#` and project keys; every race is a condition or a transaction (the single-run pointer, the command counter, the open-asks counter, the catalog move).
- `Approvers` through the approval gate: two subjects, `setup-host` (a website a run asked for) and `setup-proposal` (a project's candidate setup commands). Both are `risk: "high"`, so only a strong method decides them (the local page's own session; a code host comment never does), and
  both are bound to what the owner saw: the ask and its time, or the digest of the commands and the candidate revision. The proposal is waiting for a decision only once its candidate check passed.
- `WorkerMachines`: the run and the check are ordinary operations (`workflowMode: "SETUP_AGENT"` with the limits and commits in the payload; a check is a preparation on the candidate revision); the machine's start reads the owner's approved websites (`extraAllowedDomains`).
- `CodeHost`: the citation re-read is `fileAtRevision` at the commit the run read, through the project's own connection.
- `BuildSystem` (see "Build systems" above): the worker's setup governor groups commands by the profiles' `setupPrograms`, and the machine launcher passes the registry's profiles in `ROVARA_BUILD_SYSTEMS` as for every worker; nothing in the setup flow names a build system, and the internal detector is not here (decision 45.11).
- `Metering`/`ModelProvider`: a run's model calls go through the model proxy like any task step; a run without a model route is refused at the start.

Provider-specific code in the flow: none. What stays Cloud-only: the company's locks and the second-admin rule for loosening them, the company switch that turns setup runs off, recipes the company offers its projects (`org/setup-recipes.ts`, `setup-recipe-*`), the audit ledger events of the setup rows (the gate's own audit records the decisions), and the browser step-up.

## Open ids for trackers and events, and the comment seam (lane P6, item E1)

Event sources, event types, intake channels and connection types were fixed lists (`EVENT_SOURCES`/`EVENT_TYPES` in `trigger-specs.ts`, `INTAKE_CHANNELS` in `intake.ts`, `ConnectionTypeSchema` in `connections.ts`). They are **closed on purpose** now
(owner decision 62): they keep the entries they have, a test (`tests/unit/open-ids.test.ts`) holds them, and a new tracker or monitoring source does not add to them. It registers itself instead:

- A tracker declares `eventSource: { types: { "item.created": ["label"], ... } }` (event types, with the keys a trigger may filter each on). The source id is the tracker's `kind`. `open-ids.ts` has the open id shapes (`OpenSourceIdSchema`,
  `OpenEventTypeSchema`), `eventSourceCatalog(registered)` (the built-in sources plus the registered ones; a registration that takes a built-in id, another one's id, or is not well formed is SKIPPED and reported in `skipped`, so one tracker whose kind is `jira` never fails the others) and `checkEventTrigger(spec, registered)` (an unknown source, type or filter key is refused,
  never read as "any"). Chains and triggers are not switched on in Code (decision 45.10), so nothing reads the fixed lists through these yet; whoever switches them on uses `checkEventTrigger`.
- The intake side already had an open way in: the `tracker` channel names its own `system` (`IntakeSystemSchema`). Opening the connection-type union (a stored connection for a tracker that registers itself) is built with the triggers.
- **Comment commands on an item (interface only).** `Tracker.comments?` mirrors `CodeHost.comments?` (fetch only, decision 66): `CommentSubject` is `{ kind: "change-request", ref }` or `{ kind: "item", ref }`, `SubjectComment` is a comment with its
  subject, `CommentSource` is the one interface keyed on a subject, and `commentSubjectKey` is a stable key for claims. `subjectCommentFromHost` turns a code host's comment into the same shape. Nothing calls them yet; the handler in
  `core/pr-commands/` stays keyed on a pull request until chains are switched on.

## Outbound events (lane P6, item R3)

`outbound-events` is a plug-in point that holds many adapters. Rovara emits an `OutboundEvent` for what happens to a task, with references to its artifacts (never their content), so a lightweight adapter (an internal issue tracker, a dashboard) needs no
change to Rovara. **It is the same signed format as the channel events** (spec 062, phase 3) (decision 61): Standard Webhooks, the `webhook-id` header is the event's `id`, `webhook-timestamp` is in seconds, `webhook-signature` is
`v1,<base64 HMAC-SHA256 of "<id>.<timestamp>.<body>">` with the adapter's `whsec_` secret, the envelope has the same `version`, `evt_` id (stable across retries) and `createdAt`. `signOutboundEvent` and `verifyOutboundEvent` are thin over
`webhookHeaders` and `verifyWebhook`, so a receiver that checks a channel event checks this one with the same code.

An event is `{ version: 1, id, type, company, project?, subject?, createdAt, data, artifacts }`. `type` is an open dotted lower-case id; the task milestones are `task.<milestone>` (`outboundEventTypeOfMilestone`). `data` is flat JSON (a name with a text, number, true/false or null value, no nesting) up to 16 KiB; `artifacts` are
references (`kind`, `id`, optional `digest`, optional https `url`), up to 50. An adapter implements `deliver(event)` (AT LEAST ONCE: a receiver drops a repeat of an `id`) and may implement `accepts(type)`. `publishOutboundEvent(registry, event)` sends one
event to every adapter that wants it; each adapter has a time limit (10 s); a failing adapter is reported by name and a FIXED kind (`timeout`, `accepts_failed`, `delivery_failed`), never the adapter's own error name or text, and never stops the others or the caller. An `accepts` that throws is a failure, not a skip.

Not here yet: an HTTP sender (an adapter, with its own address and secret rules), retries and a dead-letter queue, who may register an adapter, and the visibility rule that events follow a task's live visibility. The scheduler (timers), realtime push and
email notices stay names only (decision 61): they are not points until a lane needs them.

## The task flow core (lane L6a)

`packages/broker/src/core/task-flow/` is Cloud's task start, the driver of the stage machine and the dispatch of work to worker machines, built only on
the ports above (`createTaskFlow`, or `createTaskFlowFromRegistry` over the `storage`, `queue`, `worker-machines`, `admission` and `audit-sink` points).
The pure transitions stay in `@agentx/contracts` (`task-workflow-node.ts`); this is what reads a task, applies one, and writes it fenced on the revision.

- **Start** (`startTask`) is one `transact`: workspace, its preparation operation and staged dispatch message, task, index row, callback pointer,
  conversation, idempotency record, the workspace-slot charge, whatever `Admission.stage` and `AuditSink.stage` return, and the first step's dispatch row.
  A retried request id answers with the first task (R8); a refusal writes nothing but an audit record.
- **Operations** carry a `DispatchSpec` (no secret). The queue message is `{ v: 1, workspaceId, operationId }`. The consumer (`runDispatchOnce`) starts the
  workspace's machine (`machineKey` = the workspace id), waits for it to be `ready`, and only then issues the repository grant and the callback capability and
  calls `deliver`; a delivery that waits for a machine therefore never carries an expired credential. Before anything is issued the consumer **claims** the
  operation in one transaction (the workspace is still held by it at its fence and is not closing, and the operation becomes DISPATCHING), so a close that races a
  dispatch sends nothing and a machine started for a closed workspace is stopped again. Each machine of a workspace is admitted on its own (`machine.start:<workspace>:<n>`). A step whose tool boundary the worker cannot enforce
  (`workflowMode` without the `task.workflowMode` feature) is failed, never sent.
- **Fences.** A hold of the workspace takes the next fence; a result for another fence is refused; a workflow write is conditioned on the revision it was
  computed from. Dispatch rows (`WORKFLOW_DISPATCH`, on the company-scoped partition, found by the `workflow-dispatch-due` index) are the "start the next step
  with no one asking" intent; `runDueDispatches` is the recovery sweep.
- **A store given to the flow keeps three indexes** (`TASK_FLOW_INDEXES`): the outbox's, `workflow-dispatch-due` and `byWorkspaceProject`.
- **Workspace limits** use a counter and one marker item per charged task (`TASK#<id>` beside the member counter) in place of Cloud's string set.
- **Seams the flow brings:** `TaskAccess` (the owner by default; `checkStart` at a start, `checkStep` before every step the system starts, with items for the step's transaction), `ProjectSource` (`createStoreProjectSource` reads Cloud's project keys), `StepPrompts`
  (simple defaults; Cloud's prompt builders are not ported), and `OperationResult`/`StepOutcome` (the callback layer reads the worker's artifacts and hands over
  the outcome; object storage is the `object-storage` point, provisional).
- **Gaps the flow states rather than hides:** no sweep reaps an operation nobody holds or a closed workspace that still has a machine; no watchdog ends a step whose worker
  died (a waiting dispatch row is given up on after an hour, a running step is not); `Admission.settle` has no machine-time unit, so a closed task's reservations are
  released; a plain task (no workflow) whose first run `checkStep` refuses stays "starting" with nothing retrying it; a task charged in Cloud's older form (a `tasks` set) closes without freeing a slot it has no marker for.
- **Not in this lane:** plan decisions and approval (L6b), sessions, cost, notifications, merge, proof, branch sync, CI fix, the callback endpoints, the
  Cloud close operation (discard unpublished work, pull-request checks), the stuck-step watchdog, test environments and saved environments.

## The build step (`core/build-step/`, lane L10)

Everything after the plan is approved: coding, the checks, the reviews, Rovara's own fixing of a block, the draft pull request, the push of a fix to it and the merge of the base into it.
It is Cloud's `workflow-items.ts` and `terminal-result.ts` (and the starts in `developer-tasks/`) on the document store, the queue and the code-host port. The task flow reaches it through
`TaskFlowDeps.buildSteps` (`BuildSteps`: `runRow` for a dispatch row of kind IMPLEMENT, REVIEW, PUBLISH, SYNC or AUTOFIX, `onEnded` for the end of a coding run, rerun of the checks, review,
publication or push); `createTaskFlow` fills it. The worker's result reaches it as a `StepOutcome` (`built`, `reviewed`, `published`) that the callback layer did not read: it is the worker's word,
and the build step reads it against the contracts' schemas and the task's own record of where it started (`recordWorkflowVerification`, `submitWorkflowReview`).

- **Coding** (`startImplementation`): from the approved plan (read back through `developer/plan-document-reader.ts`, which checks the digest and reads a Markdown or a structured plan; it
  needs `deps.artifacts`), from a send-back (the problems, as untrusted tagged text) or from a fix round for failing CI or a conflict (what CI said, or the conflicting files). The checks are
  the plan's selected ones; a task whose policy selects none is "review only".
- **Checks** are run by the worker inside the coding run and read here: the candidate (the code the run ended on) must be the code its checks ran on, in every repository, starting from the
  commit preparation recorded (confirmed at the code host before the first pin). A rerun is a CHECKS run.
- **Reviews** start by themselves on the checked code; each report must be for this code, from this run, and exactly the reviews asked for.
- **Fixing a block** (`runAutofix`, the policy in `@agentx/contracts` `workflow-autofix.ts`): a code fault goes back to coding at most twice per approved plan; a hiccup of the checks or reviews is
  retried once; anything unclear, a person's job or a reached limit is an ask (`autofixAsk` on the task), with what failed. `deps.taskSpendUsd` says what the task cost; **nothing priced counts as
  nothing spent**, so a model with no price (neither its provider's table nor the catalog's list) leaves the count limits alone to bound the rounds (the hosted product's to decide).
- **Plan risk** (`gradePlanRisk`): the planner's own document may only RAISE the tier. The core computes a floor itself from every path the plan's text and the request name (sensitive paths, count of files, a cost estimate where the task has one) and the tier is the higher of the two; a plan that claims every claim is proved is not thereby low.
- **A task's artifacts**: an artifact name is kept once per operation, except the names in `REPLACEABLE_ARTIFACT_NAMES` (`checks.json`, which the worker saves again after the one extra turn it gives a coding run whose rerun found a regression): the last post stands, each under its own digest.
- **Late callbacks.** Every action of a worker (events, artifacts, the uploads, the pull request, the update) goes through one path: capability, ids, fence, and, for everything but a repeat of the result, that the operation has not ended.
- **Publishing** (`startPublication`, `openPullRequest`, `recordPublished`): the worker pushes the checked tree; the code host, not the worker, says what the branch holds (its head, its tree, that it
  stands on the pinned base); the draft is opened through `reconcileChangeRequest`; its own head is read again and one that is not the checked code is closed and recorded nowhere. The result is
  linked back to the task (the neutral link row), the head indexed, merge tracking enrolled and `openBranchWriters` called.
- **A merge of the base is a new candidate** (decision 67b, and 70(c) for what follows): the host shows the right parents, not what the merge's tree holds, so the task is blocked at VERIFY with `WORKFLOW_BLOCK_REASONS.baseMergedRecheck` (the earlier checks, reviews and accepted findings are dropped) and the checks run again, then the reviews; only then does the task wait for the merge again, and merge tracking marks a pull request ready only while it waits with nothing being changed or checked (`wantsReady`). **The re-run is automatic** where Rovara may act: an AUTOFIX row with cause `base-merged` is written with the block when automatic fixing is on and the task needs no browser or API checks (a task that does is not synced: its merged code has no source export, so the branch stays behind and the person updates it, `MERGE_NOT_READY_MESSAGES.behindByHand`). The look reads the autonomy again through `TaskFlowDeps.autonomy` (`suggest`, an unreadable setting or no seam asks the owner; `rovara up` answers `prepare`, as merge tracking does), asks if a person pushed since the merge (`head-moved`; an unreadable head asks too), and starts the re-run only inside three allowances: one automatic retry per candidate, three per task per rolling 24 hours (their own count, not the task's six lifetime actions: `BASE_MERGED_RETRIES_PER_DAY`), and the company's per-ten-minutes allowance, which is an `Admission` decision (`autofix.base-merged`, keyed by task, candidate and ten-minute window; the core keeps no counter, so Code's allow-all has none and Cloud's adapter holds five). A refusal makes the row wait a minute plus up to two with no attempt counted. The reviews after the re-run read the autonomy once more (lowered to `suggest`: blocked with `recheckAutonomyLowered` before anything paid starts; the owner's Retry reviews is their go-ahead). A merge the host shows with exactly `[recorded head, asked base commit]` as parents is recorded whatever the run's status (leaving Rovara's own merge unrecorded would read it as someone else's push for good); a merge the host does not show is not. The update callback records a head as Rovara's only after the host shows the reviewed tree (a fix) or the recorded head and base commit as parents (a merge); a later refusal puts the record back (Cloud keeps a fix's head and adopts it from its next webhook; Code has no landed-fix adoption, so it keeps the rollback).
- **One automatic retry** applies where it does in Cloud: a blocked VERIFY or REVIEW whose run was lost or whose start was tried until its budget ran out (the AUTOFIX row carries the cause). A coding run, a publication or a push that is lost blocks for the owner's Retry, as in Cloud. Retry works for a blocked coding run, checks, reviews, publication and the push of a fix (the block "pull request update failed").
- **Open pull requests** (`maintain.ts`): the reviewed fix is appended as exactly the reviewed tree onto the recorded head; the base branch is merged in on merge tracking's request. A head that
  moved (a person's push) is never overwritten. Both are `maintain` operations with the `pull-request-update` callback.
- The uploads a coding run makes besides its result (`candidate-export`, `candidate-build-source`, `baseline-source`) are checked and kept on the object-storage port by `core/e2e/uploads.ts`: they are the committed source the browser and API checks (E2E) run from (see "Browser and API checks" below).

## Browser and API checks (`core/e2e/`)

The checks that run the app a task changed in a browser and against its API (E2E) on the document store and object storage. Cloud's `workflow-e2e-*`, `e2e-*` and `broker/e2e-rounds` code is on DynamoDB and S3; the same code lives under
`packages/broker/src/aws/` (unchanged DynamoDB form, used by the older broker and its tests) and in `packages/broker/src/e2e/` (the shared parts: the plan and admission builders, the evidence verifier, the account registry's rows, the display
and the model route registry). `core/e2e/` is the ports version of what reads and writes:

- **Stored keys are Cloud's, byte for byte**: `ORG#<company>#PROJECT#<project>` / `E2E_ACCOUNT#...`, `E2E_ACCOUNT_LATEST#...` and `E2E_MODEL_BUDGET#<day>` (the org-scoped project partition: `projectPk`), `DEVTASK#<task>` / `E2E_BASELINE#<plan digest>`,
  `E2E_REPLAY#...`, `E2E_GROUNDING#...`, `E2E_FEATURE_VERIFIER#<catalog>` / `PROFILE#<profile>#<kind>`, `WORKSPACE#<workspace>` / `CANDIDATE_EXPORT#<operation>`, `CANDIDATE_BUILD_SOURCE#...`, `BASELINE_SOURCE#...`, `WORKFLOW_E2E_UPLOAD#<operation>#<group run>`,
  and the object keys `workflow-candidate-sources/sha256/...`, `workflow-e2e-admissions/sha256/...`, `workflow-e2e-evidence/sha256/...`, `workflow-e2e-group-evidence/sha256/...`. The account and day-budget rows moved from `PROJECT#<project>` to the company-scoped
  partition (Cloud already stores them there); Code's older broker path now writes the same rows under its one company. Existing `PROJECT#<project>` / `E2E_ACCOUNT*` and `E2E_MODEL_BUDGET*` rows are not read: re-register the project's setup (the day budget starts again).
- **Records** (`baseline.ts`, `replay.ts`, `grounding.ts`, `account-registry.ts`, `runtime-readiness.ts`, `artifacts.ts`): same functions as Cloud with the store parameter changed (`{ store: DocumentStore; now? }` and `{ objects: ObjectStorage }`); a write that fails its condition is the
  same boolean answer; fences are `TransactItem` checks.
- **No cloud client**: the parts of the baseline, replay, grounding and artifact code, and of the model route registry, that touch no cloud client are in `e2e/` (`baseline-round.ts`, `replay-round.ts`, `grounding-round.ts`, `stored-artifacts.ts`, `model-route-read.ts`); `aws/` imports them from there, and `tests/unit/core-e2e-imports.test.ts` fails if anything under `core/e2e` loads a cloud SDK.
- **Uploads** (`uploads.ts`, `uploads-chunks.ts`): the three coding-run uploads, chunk by chunk, bound to the operation and its fence, in order, held to their digest, the tree inventory and the byte bounds, then stored under their content address. They are kept only for a task whose approved plan
  needs the checks (and for a planning run asked for the unchanged code); for any other task `rovara up` answers them in the shape the worker sends and keeps nothing, so the size of a code base never holds up a result. Code too big for the install's object storage is answered
  `{ accepted: false, reason: "too-large" }`, the coding run's row records it, and the checks block with one fixed sentence. A chunk is staged with a short retention class and deleted when its upload fails, so a left-over chunk expires by itself; kept objects use the never-expiring `task-document` class (they are
  the code a round runs on) and grow until the task's files are removed. The worker's reads of its admission and its evidence uploads are served the same way (`callbacks.ts`), bound to the round's record. Local upload rules differ from Cloud's in one way: an operation counts as live in `DISPATCHING` as well as `RUNNING` (the local listener serves no heartbeat).
- **Verification** (`verification.ts`): reads a round's admission and evidence back from where the broker stored them, holds them to their content addresses, re-collects every group itself (the worker's verdict is never read) and judges the result. A baseline, replay or grounding
  round only settles its own record and never moves the workflow. The build step uses it at the end of a candidate's checks: the checks pass only on a round the broker verified, and the rows the verdict stands on are fenced into the transaction that records it.
- **Authority** (`authority.ts`, `local-authority.ts`): whether the owner, the project's policy, the candidate's source and the runtime are still what the round was admitted under is the `E2EAuthority` seam. Code's `createLocalE2EAuthority` checks the approved plan, the project
  policy (pinned and latest), the creator (`TaskAccess.checkStep`, and the proof Code records for its one owner: a direct administrator grant `local-owner`), and the stored source; the runtime rows, the test accounts and the setup approval are one more seam
  (`currentSelection`). With none, no round passes (fail closed). The seam must return only attested rows: runtime rows that passed qualification and are READY now, and the accounts as registered now; this layer fences what it is given (the catalog row, the project's revision with its policy, setup approval and runtime binding, every runtime row the round ran on, the plan's accounts) and fails when the catalog row, the setup approval or a runtime row is missing, but it cannot tell an attested row from one that is not.

What is not here (Cloud-only or waiting on another feature): starting a round (admission building, the runtime and account selection, the baseline, replay and grounding starts), the model budget and route registry on the store (`e2e/model-budget-endpoint.ts`, `e2e/model-route-registry.ts`
and `e2e/model-checks.ts` still read through the DynamoDB client; decision-51 gaps), the dollar cap on AI navigation (Cloud's `e2e/model-spend.ts` is on the spend ledger; Code would bind it to `Admission`), run-scoped accounts' revocation against a live app, and the browser tests of Cloud's web app.

## Shared names Cloud imports, not copies (owner decision 60, item R4)

Some contract files are in Code (signing keys, editions, run estimates, task budgets, record trust, the port types above). The hosted product has copies of some of them. The rule for the step where Cloud
consumes Code: **Cloud imports every shared name from Code's contracts (`@agentx/contracts`); it does not keep a second copy.** Two packages exporting the same name is a bug, because a type or a constant
that drifts in one of them is a silent break. When a name must change, it changes in Code first (the old name kept as an alias for one release where the item says so), and Cloud follows in its next consume step.
Cloud's own files keep only what is Cloud's (its adapters, its policies, its data). Nothing in this repository changes for this rule; it is written down so a Cloud change that adds a copy is caught in review.

## What is not here

- **Artifact (object) storage** now has a provisional port (`object-storage`, above), with an opt-in S3 adapter (lane A3).
- **Snapshot reads** (`TransactGet`, 10 uses in Cloud). `getMany` is not a snapshot; use `transact` with `check` steps.
- **Scan** (2 uses). Use `query` on a partition or an index. **Projections** (16 uses) are not offered; read the document.
- **Sets with `contains`, list append with `size`, `attribute_type`, binary attributes.** Cloud's limit and budget code uses them
  (`developer/limits.ts`, `org/budget.ts`, `spend/admission.ts`, `aws/sessions.ts`, `lessons/dynamo-vectors.ts`). They must be
  rewritten before that code sits on this port: one marker item per charged task with `when.absent()` instead of a set, a counter
  instead of a list length, base64 text instead of bytes. That changes the stored format, so it needs a one-time data migration in Cloud. Owner decision 60 settles it (item S2; this replaces
  "a decision for both owners"): **the document store stays small.** Sets and list append are NOT added to the port or to SQLite. Cloud's budget, limit and session code moves to one row per item
  (a marker row per charged task, a counter row) with a one-time migration on the Cloud side. L6a's workspace limits already use that pattern.
- **Realtime push and email notices** now have ports (`realtime` and `email`, lane K1, below), as do timers (`scheduler`) and the saved environment registry (`image-registry`). The outbox relay "from a timer" is still the caller's timer.
- **Sign-in flows.** `IdentityProvider` answers who a credential is; begin/complete/sign-out, authentication freshness and member
  listing for single sign-on are interface additions for the lane that needs them.
- A SQLite adapter must use UTF-8 text with BINARY collation for the code-point order and refuse lone surrogates in keys.

## Merge and merge tracking (`core/merge/`, lane L7a)

Cloud's B7 merge code on the ports. What is Cloud's and unchanged: the readiness rules and their exact words (`mergeReadiness`), whose approval counts (`humanApprovalOf`),
what the checks, reviews and branch say (`readCi`, `readReviews`, `readBranch`), the CODEOWNERS rules, tracking items kept only when a decision-relevant fact changes, the merge
claim, and the single merge path that re-reads the code host and merges at the checked head. What is different in Code:

- **The proof of a person is the Approvers seam.** `prepareMerge` makes an `ApprovalRequest` (kind `merge`, bound to the workflow's revision and to a digest of the exact pull
  requests, heads, merge method and risk level the person sees); the surface collects an `ApprovalProof` (the local owner's session, or a repository collaborator's comment);
  `pressMerge` verifies it with `Approvers.verify` and only then merges. A proof is used once: its `approvalProofKey` is stored with `when.absent()` in the first claim's
  transaction; a proof whose token names one act (a code-host comment) is also used up by method and token, so the same comment cannot approve a second request. `pressMerge`
  enforces the adapter's `requirement` (a method it does not list is refused; `minApprovers` other than 1 is refused until collecting several verdicts exists). Rovara never merges by itself.
  **What this core does not enforce:** who is calling. Cloud's rule that a token (the CLI, an AI tool) never merges is not here; keeping the local session secret away from tokens and
  agent tools is the job of the surface that collects the proof (lane L8), and a stronger proof for a high-risk merge is a rule of the Approvers adapter (`request.risk` tells it).
- **The audit fact commits with the claim** through `AuditSink.stage`, as Cloud's ledger row did.
- **Seams the neighbouring lanes fill** (`seams.ts`): the task record (`MergeTask`, read by `MergeHost.loadTask`), the session timeline (`SessionTimeline`), the milestone hook
  (`CodeMilestones`), the session bindings, the project's code settings (`CodeSettingsReader`; Code's default has self-approval ON, one owner), the reverse link from a change request
  to its task, and `MergePeople` (who a person is on the code host). Cloud's members, its track record and its reviewer reminders plug into the same seams and hooks.
  `CodeMilestones` is filled by `core/milestones`: the items are Cloud's `CODE_MILESTONE#<kind>#<n>` rows (with the sweep's due-time attributes under `CODE_MILESTONE`) and a session line, committed with the change; `register` takes the handlers an adapter
  supplies, `deliver` tells them after the commit and `deliverDue` (the app's timer) tells again one that failed, at most 5 times (the per-handler `tries_`, `done_` and `lease_` attributes are Cloud's). It needs the dispatch rows' `workflow-dispatch-due` index.
- **Keys are Cloud's** (`mergeTrackingKey`, `prHeadKey`, `mergeCommitIndexKey`, the task's own partition), so Cloud consumes the same layout with no migration.

## Scheduler (a new interface: both owners approve)

The `scheduler` point (one adapter) says WHEN. A `ScheduleEntry` names a company, a schedule id, a rule (a five-field cron in a named time zone, or "every N minutes"), an on/off switch and a target
(`{ kind, ref }`, ids only: a schedule is stored by an outside system and listed in its console, so it never holds a secret or a person's text). `put` creates or replaces (idempotent on company and
id), `remove` deletes (not an error when absent), `get` reads back, and `subscribe` registers the one handler that hears of each fire. A fire is a `DueSchedule`: the time the rule meant, a `slotId`
that is the same for every delivery of one fire, and an `attempt` count. The handler resolves when it has HANDLED the fire, including by deciding to start nothing; if it throws, the scheduler may
deliver the same fire again and finally gives it up.

The core decides what a fire does from what is stored then. The nightly test run checks that the schedule is still on, that the fire is fresh, that something merged, that no run is in flight, and
claims the slot with a conditional write before it starts anything, so a scheduler that fires twice, late or after a restart does no harm. `capabilities` says which rules an adapter honours; a rule
it does not honour is refused at `put`, never run differently. Code's adapter is a timer inside `rovara up` (`createIntervalScheduler` in `@agentx/local-adapters`): UTC crons and intervals, its
schedules kept in the state database, one late delivery for a fire missed while `rovara up` was not running (within an hour). Code's default, `none`, refuses `put` with `unavailable`. Cloud's adapter
will be the cloud scheduler. `tests/support/ports/scheduler-conformance.ts` is the conformance suite (the fake, the local timer and Cloud's later adapter all run it).

## Image registry (a new interface: both owners approve)

The `image-registry` point (one adapter) is where a project's saved environment image lives. The broker never talks to a registry itself: it asks the port for a short-lived login for ONE repository
(`login`, to push or to pull), whether the repository is the one Rovara makes (`inspect`: `matches`, `absent`, or `unusable` when somebody else created it first with other settings), the images it holds
(`list`), and to delete images or the repository. What makes an image trustworthy stays in the core (`core/test-env/saved-env*.ts`): which approved environment it was built for, that a Prove run
passed, that the job that pushes is the job that was queued, the 30-day ceiling, keeping the newest N. A repository name is built by `savedEnvRepositoryName` (a hash of the company and the project) and
every call refuses a name of any other shape, so no wildcard or extra segment reaches a registry call. The worker never sees the registry's own credentials: a login is a `SavedEnvRegistryAuth`.
`capabilities.workerPush` and `workerPull` say whether a worker can push and pull with its own container tooling; when they are false the core queues no build and names no image to a worker.

**What changed in the login's shape:** `SavedEnvRegistryAuth.registry` accepts the cloud registry's host or a registry on this machine (`localhost` or `127.0.0.1` with a port, nothing else), and `username`
is the hosted registry's fixed user name or `rovara-local`. A hosted install validates with `HostedSavedEnvRegistryAuthSchema` (the same schema made by `savedEnvRegistryAuthSchema({ allowLocal: false })`), which takes only the cloud registry's host and user name, so a hosted worker is never told to log in to a loopback address. Code's adapter runs one registry container on the owner's Docker, published on the loopback address only; that registry has no login check, so the adapter refuses worker access until one that checks it is built. Code's default, `none`, answers every call with `unavailable`.
Cloud's adapter will be its cloud registry (a login scoped to one repository; the policy builders are in `saved-env-image.ts`). `tests/support/ports/image-registry-conformance.ts` is
the conformance suite.

## The test environment (`core/test-env/`)

A project's test environment is a setting Rovara PROPOSES, a Prove run checks, and the owner approves once; each approved change is a new immutable revision, and a task keeps the revision it started
with. The stored rows are Cloud's, key for key (`TESTENV#PROPOSAL#<digest>`, `#PROVE#<digest>`, `#REV#<revision>`, `#LATEST`, the task's `#PIN#<task>`, `#NIGHTLY#...`), under `projectPk(company, project)`, so
Cloud can switch to this code with no data move.

- **The approval is a subject of the approval gate** (`createTestEnvironmentSubject`, kind `test-environment`). Cloud's own checks (a maintainer role, a fresh sign-in, a second person for a less-safe
  change, a confirmation card) are the Approvers seam's rules here. A less-safe change, a proposal a setup run or draft made, and any card the contract grades high are HIGH risk, so only the methods the
  approvers plug-in names as strong may approve them, and `minApprovers` says whether a second person is needed. The environment still refuses, in fixed words: an unproved proposal, a seed file the
  check did not load, a production target, recordings outside the sandbox and preview tiers, a kind of backing that is not available, an archived project, and a revision other than the one the person saw.
- **The task flow takes it through one seam** (`TaskFlowDeps.testEnvironment`, `core/test-env/seam.ts`): a starting workflow task pins the newest usable revision in its own start transaction (an environment the flow cannot carry out is
  recorded as not applied, with the reason); a coding or verification run is told the plan of the pinned revision and the worker features it needs (a worker that lacks one is refused the run, never sent it without).
- **Switches** are environment variables read by leaf modules (`switch.ts`): `ROVARA_TEST_ENVIRONMENT` (on unless `0`), `ROVARA_TEST_SERVICES`, `ROVARA_TEST_ACCOUNTS`, `ROVARA_PROJECT_IMAGES`,
  `ROVARA_SAVED_ENVIRONMENTS` and `ROVARA_NIGHTLY_HEALTH` (each on only when exactly `1`).

## Realtime (lane K1, a new interface: the owner decides it alone, decision 63)

The `realtime` point (one adapter, `packages/contracts/src/ports/realtime.ts`) tells an open page that something it shows changed, so it reads again. A notice is a HINT, never the data: a dotted `type` and at most
16 fields, each an id-shaped token, a finite number or a boolean, at most 1 KiB (`isRealtimeNotice`). The port refuses free text, but an id-shaped token can carry anything, so keeping titles, people's words and secrets out of a notice is the core's job. A page that missed one still finds the change when it next reads (a host that
keeps a catch-up feed writes it in its own store before it publishes; that feed is core logic, not this port), so a lost, late or repeated push does no harm.

- `publish({ companyId, entries, deadline })` sends each entry to one audience: everyone watching a session (`{ kind: "session", sessionId }`), a project (`{ kind: "project", project }`) or one person
  (`{ kind: "person", personId }`). It **never throws**: an entry that is not a notice or an audience, past the 200-entry batch, past the deadline or lost by the transport is counted in `failed`; it answers `{ sent, failed }`.
- Who hears a change (the owner, the people a decision waits on, followers) is decided in the core before `publish`; who may LISTEN to an audience is the adapter's own sign-in check where listeners are outside the process.
- **Code's default is `in-process`** (`createInProcessRealtime`, `packages/broker/src/ports/realtime.ts`): the install's own pages `listen(companyId, listener, audience?)` in the same process; with no listener a publish
  reaches nobody, so registering it changes nothing for an install whose pages do not listen. It is also the fake (`published()`, `setDown`). The hosted adapter (not built yet) is meant to post to its cloud events service with its own
  channel names for the three audiences, so nothing it stores or signs would change. `tests/support/ports/realtime-conformance.ts` is the suite.

## Email (lane K1, a new interface: the owner decides it alone, decision 63)

The `email` point (one adapter, `packages/contracts/src/ports/email.ts`) sends one plain notice to one address. The core writes every word; the adapter only sends. The sender's address, its sign-in and its limits are the
adapter's settings, set by the owner: a call never names a sender.

- `send({ companyId, purpose, to, subject, text, html?, unsubscribeUrl?, deadline? })` resolves when the transport took the message. It throws `EmailError`: `refused` (never retried) for what `emailRefusal` refuses (not one
  plain address, a subject that is not one short line, an empty or over-long body, an unsubscribe link that is not plain https, a purpose that is not one word), `unavailable` (retry later) for a transport that is down or past
  the deadline. Errors are fixed sentences, never the address or the subject.
- `html` is an optional second form; an adapter without `capabilities.html` sends the text alone. `unsubscribeUrl` becomes the mail client's own unsubscribe offer where `capabilities.unsubscribeHeader` allows; the text carries the same link.
- `capabilities.available` says whether the adapter can send at all; the core decides before it offers email and falls back to another channel when it is false. The unsubscribe link is sent as the parsed link's `href`
  (`emailUnsubscribeHref`), never the raw text; the recipient and the link get the same control-character check as the subject.
- **Code's default is `none`, and Code ships no other email adapter** (owner decision 101) (`createUnavailableEmailSender`, `available: false`): every send is `unavailable`, so a person's email choice reads as not set up and notices go through the channel adapters, as before. The fake is
  `createFakeEmailSender` (`packages/broker/src/ports/email.ts`). The hosted adapter (not built yet) is meant to be its cloud email service with today's sender address and grant. `tests/support/ports/email-conformance.ts` is the suite.
