# P02 — Recovering an accepted request after a lost response

Lane B / AX2. Offline implementation on branch `codex/lane-agentx` from
`067ea9e82a6affee106c4854416cc693ed444d77`. Nothing here is deployed; no AWS route exists
until a separately authorized deployment and live test establish one.

## The problem

A caller submits a task, the broker accepts it, and the response is lost — a dropped
connection, a client restart, a deadline. The caller now holds a `requestId` and does not
know whether a job exists. Before this change the only way to find out was to submit again,
which either created a second job or silently returned an unrelated one.

## The route

```
GET /v1/workspaces/{workspaceId}/requests/{requestId}
```

The response is the existing `Operation` envelope:

```json
200 {"operation": { "id": "…", "workspaceId": "…", "requestId": "…", "payloadHash": "…",
                    "status": "ACCEPTED", "fence": 1, "…": "…" }}
```

This lane introduces no competing request or job schema. CharterArc's existing
operation-envelope parser consumes it unchanged.

Both path fields must be well-formed UUIDs. A malformed path does not match the route at
all, so it never reaches authorization or storage.

## Responses on both handlers

Two real handlers implement this route and both are covered by tests. `createBrokerHandler`
is the local/in-memory handler. `createAwsBrokerHandler` takes an already-parsed claims object
(`event.requestContext.authorizer.jwt.claims`) rather than a raw token, so token signature and
expiry validation happen upstream in the deployment, not in this code. That upstream behavior
is a source-level and deployment-topology reading, not something these offline tests observed.

| Condition | `createBrokerHandler` | `createAwsBrokerHandler` |
|---|---|---|
| Recovered | `200` `{"operation": …}` | `200` `{"operation": …}` |
| Missing bearer token | `401` `AUTH_REQUIRED` | `401` `AUTH_REQUIRED` (absent claims) |
| Foreign issuer or empty subject | `401` `AUTH_REQUIRED` | `401` `AUTH_REQUIRED` |
| **Expired token** | `400` `CONFIG_INVALID` — see the known gap below | not reachable offline: this handler never sees a raw token, only claims. Expiry is the API Gateway authorizer's job, which no offline test can observe. `UNKNOWN` until a live test. |
| Workspace unknown or owned by someone else | `404` `NOT_FOUND` | `404` `NOT_FOUND` |
| Project membership revoked | `404` `NOT_FOUND` | `404` `NOT_FOUND` |
| Request id not indexed for this owner | `404` `NOT_FOUND` | `404` `NOT_FOUND` |
| Malformed workspace or request id | `404` `NOT_FOUND` (`route not found`) | `404` `NOT_FOUND` (`route not found`) |
| Dangling or corrupt index | `503` `RUNTIME_UNAVAILABLE` | `503` `RUNTIME_UNAVAILABLE` |
| Storage read failure | `503` `RUNTIME_UNAVAILABLE` | `503` `RUNTIME_UNAVAILABLE` |

The two handlers agree on every status and error code except the expired-token row. They
differ in one cosmetic respect that predates this lane: the AWS handler strips the
`CODE: ` prefix from `error.message` and the generic handler does not, so the same condition
reads `route not found` on AWS and `NOT_FOUND: route not found` locally. The machine-readable
`error.code` is identical on both.

Every non-`200` row was verified to disclose no operation and to leave the backing store
byte-identical.


## What it does not do

The lookup is read-only in the strict sense. It does not call `acceptTask`, enqueue work,
acquire a writer lease, create a conversation or session, scan across owners, or write
anything. Tests snapshot the entire backing store before and after success, absence and every
error path and assert deep equality, and assert zero worker and publication calls.

## Identity

The owner is taken from the authenticated token and never from the request. The in-memory
store keys its request index by `ownerKey \0 workspaceId \0 requestId`; the AWS store keys it
by `pk=IDEMPOTENCY#<ownerKey>#<workspaceId>`, `sk=REQUEST#<requestId>`. A caller cannot
choose an owner identity, so cross-owner recovery is not expressible.

Ownership and project membership are both checked on every call, against current state.
Membership revoked after the job was accepted stops disclosure immediately — it is not
evaluated once at acceptance time.

## Request identity is case-sensitive

`requestId` is matched **byte for byte**, not case-insensitively.

Task acceptance stores whatever spelling the caller sent and keys its idempotency index on
that exact string — `ownerKey \0 workspaceId \0 requestId` in memory, and the
`REQUEST#<requestId>` sort key on AWS. The schema accepts uppercase and mixed-case UUIDs, so
`AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA` and its lowercase form are two distinct request
identities at every layer.

Recovery therefore preserves the identifier exactly as received. An earlier revision of this
route lowercased the path segments, which made a recovery of an uppercase request look up a
key acceptance had never written and answer `404` for a job that existed. Independent review
caught it; six tests across both real handlers now cover it.

Two consequences worth stating plainly:

- Recover with the **same spelling you submitted**. A different spelling answers `404`,
  correctly: that identity really was never accepted. As everywhere else on this route, that
  `404` must not trigger a resubmission.
- Nothing normalizes stored identity. Case-folding in one layer only would rewrite identities
  the other layer already persisted and lose the operation being recovered. If a canonical
  spelling is ever wanted, it belongs at the point of acceptance, applied consistently, with a
  migration for existing records — not bolted onto the read path.

## A 404 is not proof

**`404` means this owner has no index entry for this request in this workspace. It does not
mean the original submission never reached a worker.**

A lost response is exactly the case where the client's knowledge and the server's state may
disagree, and a read that finds nothing cannot distinguish "never accepted" from "accepted,
then a write we cannot see". Answering `404` by submitting another job re-creates the
duplicate-execution problem this route exists to remove. Resolving that uncertainty requires
an explicit human or control-plane decision, not an automatic retry.

For the same reason a dangling or corrupt index, or a storage read failure, answers `503
RUNTIME_UNAVAILABLE` and never `404`. Unknown state stays visible as unknown. The error
carries no underlying driver message and no stored row.

## This grants nothing

The lookup is an executor observation. It is not verified code, not qualified evidence, and
not permission to act. It confers no publication, merge, deployment or release rights.
AgentX reports execution results; CharterArc determines evidence qualification and approval
authority.

## Compatibility vectors

`tests/fixtures/p02-request-recovery.json` holds sanitized request vectors with their
expected `payloadHash`, the hash definition, and the route's response semantics. The digest
is recorded in the lane receipt. `tests/contract/request-lookup.test.ts` recomputes every
vector with the shipped serializer and drives the real handler with them, so the file cannot
drift from the implementation without failing.

The hash covers `conversationId`, `prompt`, and `candidate` when present, in that key order,
unsorted. `requestId` is deliberately excluded: it is the idempotency key, so two different
payloads under one `requestId` must conflict rather than collide.

## Known gap: expired-token status on the generic handler

`createBrokerHandler` maps a JWT verification failure through its generic catch, so an
**expired** token answers `400 CONFIG_INVALID` while a **missing** token answers `401
AUTH_REQUIRED`. Nothing is disclosed and nothing is changed in either case, and the
test pins the current behavior rather than asserting an aspiration.

Nothing is disclosed and nothing is changed in either case, and this was left unchanged
deliberately: correcting it means mapping authenticator failures to `AUTH_REQUIRED` for every
route on that handler, which is an authentication-semantics change outside the read-only
lookup contract.

Smallest proposed follow-up: in `packages/broker/src/handler.ts`, catch the
`dependencies.authenticator.authenticate` call and rethrow as
`agentXError("AUTH_REQUIRED", "bearer token is not valid")`; add cases for expired, wrong
issuer, wrong audience and bad signature. It needs review because it changes the status code
every route on this handler returns for an invalid token.

The AWS handler needs no equivalent change, because it never receives a raw token. Whether the
deployed authorizer in fact rejects an expired token before the handler runs is `UNKNOWN` from
offline evidence and belongs to the separate live-activation gate.
