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

## Local adapters (SQLite)

`packages/local-adapters` holds the adapters for the laptop path (decision 44): a SQLite `DocumentStore` with its change feed, and a
SQLite `Queue`. They are plug-ins for the registry and are not wired into the broker yet (lane L4 loads them):

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
  `host` (written before the field) is on the legacy kind `github`. `codeHostForKind`, `trackerForKind` and `checkRunnerForKind` do the
  same by kind. A kind with no adapter is refused with a fixed sentence that does not name the kind, and nothing falls back to another
  adapter. `assertRepositoryHostsKnown` refuses a task start whose repositories name a code host nobody registered.
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
  repository, no redirects) are rules the client must keep, written on `GitHubCodeHostProvider`. They have no client conformance suite yet;
  the lane that brings a real client must write and run one (DEFERRED-CHECKS.md).
- **Nothing in the broker calls the routing yet.** The task flow still calls `github-app.ts` directly; the lanes that move it (L6, L7) switch it
  to `codeHostForRecord` and friends. Until then the registry is proven by its tests, not by the core.
- **Untrusted text** from a code host or tracker (comments, logs, item bodies) is data: it reaches a model only inside a labelled block, and
  the GitHub mapping cuts every text to the port's bounds so a long comment never fails a read.
- **Linear.** The adapter carries its own copy of the Linear webhook rules (`tracker/linear/webhook.ts`: the signature check, the issue key
  rule and the issue-created mapping) because Cloud's adapter imports the trigger framework, which is not ported. The install gives the
  adapter what it may do (read an issue, post a comment, the hook's signing secret); what it is not given, it does not offer.

Two comments in the copied contracts are out of date for Code: `plugins/common.ts` says adapters are "registered at build time; never loaded from
outside". Code loads the adapters its owner's config names (decision 40). The file stays identical to the hosted product's copy so lane L1 has no
conflict; read those comments as superseded by this page.

Not ported with these points (they are in Cloud's `plugins/` and belong to later lanes): the event intake and poller
(`events/`, which keep their state in DynamoDB and move onto the document store), the tracker start path (`tracker/start.ts`, which feeds
Cloud's intake engine), and `github-only.ts` (the "this step speaks GitHub only" refusal).

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
