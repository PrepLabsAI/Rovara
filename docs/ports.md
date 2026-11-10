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
`build-system`, and the policy seams `admission`, `audit-sink`, `approvers`, `metering` and `model-keys`, `secrets` (below), `object-storage` (provisional, below), `model-provider` (below), `company-instructions` (read-only company rules, below) and `outbound-events` (signed events out, below). A point holds either many
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
| `AuditSink` (`stage` steps for the caller's transaction, `record`) | `rovara up`: `DocumentAuditSink`, an `AUDIT#` row in the same store (lane P6); the bare registry default writes nothing | the audit ledger's outbox |
| `Approvers` (`requirement`, `verify` a proof) | the local machine owner by session, or a repository collaborator with write permission by comment (decision 45.3); one approver, self-approval allowed | a second person, the browser rule |
| `IdentityProvider` (`authenticate`, `resolveExternalAccount`, `getPrincipal`; optional `beginSignIn`, `completeSignIn`, `signOut`, `listMembers`, `accountsOf`) | the local owner (lists itself, its linked accounts), plus outside accounts the owner linked in config | members and single sign-on |
| `Metering` (`price`, `record`; every entry has an `entryId`, recorded once) | tokens times a price table | proxy key spend |

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

### Team-record sources: the unknown-source rule (lane P6, item T1)

The `team-record-source` point is still a name only; its interface is defined when the team record moves to the plug-in. The rule it must keep is already shared (`record-trust.ts`): a source id that nothing registered is never read as
"everyone in the project". `audienceForSource(row, knownSources)` keeps the audience a registered source declared. For ANY unregistered source it returns `unknownSourceAudience` (restricted to the project's maintainers,
`MAINTAINERS_GROUP`) and ignores what the source declared, even a restricted audience: a declared ACL can name any `acl.source` (so its principals would be read as another system's accounts), a broad group or any principal ids.
`knownSources` is the ids of the registered `team-record-source` adapters and of the recorders built in.

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

## Object storage (lane L9a, PROVISIONAL: owner decision 58, until Pratik agrees)

The `object-storage` point (one adapter) is where files live that are too big or too plain for the document store: proof evidence, plan documents, a
worker's results. It is lane L7b's `EvidenceBlobStore` promoted to the registry: `ObjectStorage` in `packages/contracts/src/ports/object-storage.ts`
has `put`, `get` (with a size cap; an object over it is `undefined`, never cut), `stat`, `delete` and `deletePrefix`. Keys are paths of letters, digits and
`. _ = : @ + , ~ -` (`isValidObjectKey`), at most 1024 characters and at most 128 per part (the evidence erase's plain-id rule), no `.` or `..` part, so no adapter can turn a key into a place outside its store. An
object carries a content type, a few small text facts and a retention class (the caller's word, such as `evidence-std`; the adapter maps it to days).
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
- **Not here (decision 51).** The S3 adapter is Cloud's, with its lifecycle rule for retention; a signed download address (lane L8); a sweep of expired files in
  the folder adapter (an expired object is reported absent and removed when it is next read).

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
  Nothing in Code calls these yet. When the lessons pass is ported it must bring Cloud's `guardTarget` and `verifyRepository` checks with it and treat a `"symlink"` path as not a file (Cloud's `lessons-wiring.ts` reader is the model); `pathKind` returning `"symlink"` instead of throwing changes no behaviour today.
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
- **Linear.** The adapter carries its own copy of the Linear webhook rules (`tracker/linear/webhook.ts`: the signature check, the issue key
  rule and the issue-created mapping) because Cloud's adapter imports the trigger framework, which is not ported. The install gives the
  adapter what it may do (read an issue, post a comment, the hook's signing secret); what it is not given, it does not offer.

**Public names (decision 58-60, item R1).** The plug-in contracts are public API, so their words are neutral. `HostScope`'s system caller is `webhook` or
`install` (the install's own work); `private-install`, the name the first copy used, still parses and reads as `install` for one release, then goes. The
company id keeps the `org_` shape (Code's implicit company already uses it). The comments that said adapters are "never loaded from outside" or came from
"Enterprise foundations" are fixed: Code loads the adapters its owner's config names (decision 40), and nothing is Enterprise-only.

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
| `keyFileGlobs` | Files whose content decides what a saved environment holds. | **Not used yet, and refused when non-empty** (`BUILD_SYSTEM_KEY_FILE_GLOBS_WIRED` is false): Code has no saved-environment job builder or environment key yet. When it does, `detectorGlobsWithBuildSystems` puts them in the job's `detectorGlobs` and in the broker's own key, so both sides hash the same files (register: DEFERRED-CHECKS, BUILD-SYSTEM-KEYFILE-GLOBS). |

**It does not travel in a job.** A module path in a job would let every job name code for the worker to load. The profile is the operator's, like the worker image: the machine launcher (`DockerWorkerMachines`, option `buildSystems`,
read from the registry with `collectBuildSystemProfiles`) puts the profiles into the worker's start-up environment as `ROVARA_BUILD_SYSTEMS`, a name a machine spec cannot set. The worker reads it once at boot and refuses to start on a value it cannot
read. The worker also refuses an absolute module path that lies inside its workspace, where repositories are checked out. No line of the worker job (`operation.ts`, `protocol.ts`) is added or changed (decision 65). A profile that is not valid,
or that carries a name other than the adapter's, stops the machine from starting.

**Trust (for the owner, decision 65).** A plug-in detector is trusted, owner-configured code that runs **with the worker's own powers**: the bounded reader limits only what the built-in detectors are handed, and an imported module has `fs`, `child_process` and the network like any other code in the worker image. It parses text from the repository, so a bug in it is worker code execution. Install only a detector you would install into the worker itself. When no detector thread can be started, plug-in detectors are **not** run (and a fixed-words note says so); they are never imported into the worker's main thread. The real-path check of an absolute module path and the later import are two steps; a file the operator swaps in between is imported, and no repository, task or job can reach that window.

The internal build-system detector stays an optional plug-in package outside the core (decision 45.11).

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
  nothing spent**, so with no price table the count limits alone bound the rounds (a decision for the owner under "Needs both owners").
- **Plan risk** (`gradePlanRisk`): the planner's own document may only RAISE the tier. The core computes a floor itself from every path the plan's text and the request name (sensitive paths, count of files, a cost estimate where the task has one) and the tier is the higher of the two; a plan that claims every claim is proved is not thereby low.
- **A task's artifacts**: an artifact name is kept once per operation, except the names in `REPLACEABLE_ARTIFACT_NAMES` (`checks.json`, which the worker saves again after the one extra turn it gives a coding run whose rerun found a regression): the last post stands, each under its own digest.
- **Late callbacks.** Every action of a worker (events, artifacts, the uploads, the pull request, the update) goes through one path: capability, ids, fence, and, for everything but a repeat of the result, that the operation has not ended.
- **Publishing** (`startPublication`, `openPullRequest`, `recordPublished`): the worker pushes the checked tree; the code host, not the worker, says what the branch holds (its head, its tree, that it
  stands on the pinned base); the draft is opened through `reconcileChangeRequest`; its own head is read again and one that is not the checked code is closed and recorded nowhere. The result is
  linked back to the task (the neutral link row), the head indexed, merge tracking enrolled and `openBranchWriters` called.
- **A merge of the base is a new candidate** (owner decision b): the host shows the right parents, not what the merge's tree holds, so the checks run again on the workspace (a CHECKS run whose code must be the code recorded), then the reviews; only then does the task wait for the merge again, and merge tracking marks a pull request ready only while it waits with nothing being changed or checked (`wantsReady`). A merge from a run that did not succeed is not recorded. The update callback records a head as Rovara's only after the host shows the reviewed tree (a fix) or the recorded head and base commit as parents (a merge); a later refusal puts the record back.
- **One automatic retry** applies where it does in Cloud: a blocked VERIFY or REVIEW whose run was lost or whose start was tried until its budget ran out (the AUTOFIX row carries the cause). A coding run, a publication or a push that is lost blocks for the owner's Retry, as in Cloud. Retry works for a blocked coding run, checks, reviews, publication and the push of a fix (the block "pull request update failed").
- **Open pull requests** (`maintain.ts`): the reviewed fix is appended as exactly the reviewed tree onto the recorded head; the base branch is merged in on merge tracking's request. A head that
  moved (a person's push) is never overwritten. Both are `maintain` operations with the `pull-request-update` callback.
- The uploads a coding run makes besides its result (`candidate-export` and friends) feed only the browser and API checks (E2E), which Code does not run yet: they are shape-checked and not kept.

## Shared names Cloud imports, not copies (owner decision 60, item R4)

Some contract files are in Code (signing keys, editions, run estimates, task budgets, record trust, the port types above). The hosted product has copies of some of them. The rule for the step where Cloud
consumes Code: **Cloud imports every shared name from Code's contracts (`@agentx/contracts`); it does not keep a second copy.** Two packages exporting the same name is a bug, because a type or a constant
that drifts in one of them is a silent break. When a name must change, it changes in Code first (the old name kept as an alias for one release where the item says so), and Cloud follows in its next consume step.
Cloud's own files keep only what is Cloud's (its adapters, its policies, its data). Nothing in this repository changes for this rule; it is written down so a Cloud change that adds a copy is caught in review.

## What is not here

- **Artifact (object) storage** now has a provisional port (`object-storage`, above). Cloud's S3 adapter is not in Code.
- **Snapshot reads** (`TransactGet`, 10 uses in Cloud). `getMany` is not a snapshot; use `transact` with `check` steps.
- **Scan** (2 uses). Use `query` on a partition or an index. **Projections** (16 uses) are not offered; read the document.
- **Sets with `contains`, list append with `size`, `attribute_type`, binary attributes.** Cloud's limit and budget code uses them
  (`developer/limits.ts`, `org/budget.ts`, `spend/admission.ts`, `aws/sessions.ts`, `lessons/dynamo-vectors.ts`). They must be
  rewritten before that code sits on this port: one marker item per charged task with `when.absent()` instead of a set, a counter
  instead of a list length, base64 text instead of bytes. That changes the stored format, so it needs a one-time data migration in Cloud. Owner decision 60 settles it (item S2; this replaces
  "a decision for both owners"): **the document store stays small.** Sets and list append are NOT added to the port or to SQLite. Cloud's budget, limit and session code moves to one row per item
  (a marker row per charged task, a counter row) with a one-time migration on the Cloud side. L6a's workspace limits already use that pattern.
- **A scheduler, realtime push and email notices.** Each is a provider dependency of the core
  today and has no port yet (object storage has a provisional one, and secrets have the `secrets` point above). The relay "from a timer" is the caller's timer.
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
- **Keys are Cloud's** (`mergeTrackingKey`, `prHeadKey`, `mergeCommitIndexKey`, the task's own partition), so Cloud consumes the same layout with no migration.
