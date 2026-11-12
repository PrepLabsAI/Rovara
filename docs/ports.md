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
a new client token each) and then `conflict`. A stored set or binary value is refused on read (`invalid_request`, decision 60). The change feed
(`DynamoStreamChangeFeed`) adds no stream reader: the host's existing reader passes each batch of stream records to `deliver`, which hands
it to the consumers declared for that process, retries a failing handler 3 times, then calls `onPoison`; a time-to-live removal is
`cause: "expired"`. The durable checkpoint per consumer is the event source mapping's. The plug-in `@rovara/aws-adapters/dynamodb`
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
