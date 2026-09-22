# Isolated fixture execution and the mock-only model route

Lane B, continuation of the durable host. Two things this closes, and several it does not.

The in-process Pi fixture that came before was component evidence: it proved the durable
host drives the real worker. It was never isolation evidence, and `npm test -- packages/host`
could not make it so. This package runs the same real code **inside an invocation-owned
container** with no network, and prices model access through a mock-only route that keeps
the accounting a real route will need.

## What actually runs in the container

`environments/fixture-worker/run.mjs` calls the **real** `runTaskInvocation`. That means the
real preparation-manifest check, the real candidate base binding, the real
`freezeTaskCandidate`, the real workspace diff and the real artifact sink with receipt
verification. The only fixture is the session: a deterministic adapter that edits files and
makes no model call of any kind.

Nothing in that path seeds a terminal row, manufactures a bundle or invents a result. The
candidate commit, tree, bundle digest and chunk hashes are whatever the freezer produced from
the bytes the session wrote.

The workspace and the invocation are **streamed in** on stdin; events, artifacts and the
terminal record are **streamed out** on stdout. Nothing is mounted and nothing per-job is
baked into the image, so the image is identical for every run.

### Why the container does not call back

It has no network, so it cannot. Worker callbacks normally POST to the control plane;
here the sinks write to the container's scratch and the host admits those bytes afterwards
through its own authenticated routes (`ingestIsolatedRun`).

It is also **not given a capability**. The streamed invocation carries an obvious
placeholder in `callbackCapability`, and the host keeps the real one, minted for exactly
that operation and fence, for its own admission. An earlier revision serialized the whole
invocation including the real capability, which contradicted this very claim; independent
review caught it. A worker with no network has no use for a callback credential, and not
issuing one is cheaper than trusting it.

The consequence is worth stating plainly: **callback authority is proven at the host boundary,
not inside the container.** The cross-operation and stale-fence refusals are exercised against
the host's real routes.

## Independent review corrections

Five defects were reproduced by the coordinator and an independent reviewer at
`67de8fd0`, and all five are closed. They are worth stating because each was a case of
something *looking* settled while not being it.

1. **Archive extraction followed symlinks.** The returned tar was written to disk and
   read back, so a symlink member returned a file from outside the extraction directory.
   The archive is now parsed **in memory** by `isolated/tar.ts` and never written, so
   there is no path to redirect. Traversal, absolute names, both link types, device and
   other special entries, duplicates, oversized members and oversized totals are refused.
   Extended (pax) headers are skipped and deliberately **not applied**, because honouring
   a pax path record would reintroduce the same traversal.
2. **`recordUnobservedRun` persisted nothing.** After a reopen the real outbox dispatcher
   delivered the job again, so a lost observation silently authorized a second execution.
   Execution ownership and uncertainty are now durable (`executions`), the dispatcher
   **holds** a job whose execution is `unknown`, and only an explicit
   `reconcileUnknownExecution` releases it.
3. **Admission accepted an unconfirmed cleanup as SUCCEEDED.** Admission now requires a
   clean, owned, settled run: `outcome=completed`, `cleanup=removed`, a matching exit
   status and a well-formed terminal record. Repeat admission is keyed by a stable
   effect id, so an exact replay is one effect — no duplicated progress events — and it
   settles the queued work instead of leaving the outbox pending.
4. **The route trusted a caller-editable token.** Authority is now retained server-side
   and read back at reservation time; the presented token must match it in full, and
   non-finite timestamps are rejected. Reservations, tokens and receipts are durable, and
   every receipt keeps its `caseId`.
5. **The isolated runtime was not connected to durable dispatch.** `isolated/bridge.ts`
   is a real `WorkerTransport`, so the ordinary outbox dispatcher drives the whole
   journey. The acceptance no longer plucks an outbox record by hand.

## Image identity

| Field | Value |
|---|---|
| Base registry reference and platform digest | `node@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9` (linux/arm64) |
| Built local image ID | `sha256:8620a338e2807f68d3b259aa18dd0eaf333db7a9e6d37a50996f8787bf1ae6fb` |
| Tag used by the tests | `agentx-fixture-worker:lane-b` |
| Added to the base | `git` (Debian `1:2.39.5-0+deb12u3`) — the candidate freezer shells out to it |

These are two different things and are recorded separately. **The local image ID is not a
distributable registry pin.** This image has not been pushed anywhere and no registry digest
exists for it; quoting the local ID as though it were one would be a fabricated pin.

## Container invariants

Every invocation-owned container is created with:

`--network none` · `--cap-drop ALL` · `--security-opt no-new-privileges` · `--read-only` root
filesystem · tmpfs `/scratch` and `/tmp` · `--memory 2GiB` · `--pids-limit 256` · `--cpus 2` ·
a non-root user (uid 10001) · labels `charterarc.lane=b` and a per-invocation id.

No privileged mode, no added capabilities, no host mount, no runtime socket, no host
namespace, no published port. seccomp is left at the daemon default and is not weakened.

Identity is the **runtime-issued container id** returned at create. Inspection, termination
and removal all use that id. Nothing is addressed by name, because a name is not proof that
the thing being killed is the thing this process made.

## Denials, and how they are evidenced

`probeDenials()` runs real containers that attempt the reach and reports what happened.

| Denial | Probe | Verified to flip |
|---|---|---|
| External network | `getent hosts example.com` | yes — resolves when a network is attached |
| Other run's network | `ls /sys/class/net` must contain only `lo` | yes — `eth0` appears when a network is attached |
| Host gateway | TCP connect attempt from inside | attempt only; the interface evidence is the stronger fact |
| Runtime socket | `test -S /var/run/docker.sock` | it is never mounted |

The interface probe reads `/sys/class/net` rather than running `ip`, which is **not present in
this image**. An earlier version used `ip` and therefore reported "denied" whenever the tool
was missing — a probe that passes because a command does not exist is not evidence, and that
version was replaced.

## Cleanup and uncertainty

`cleanupOutcomeFor` returns `removed` only when it **observed the container present, removed
it, and observed it gone**. Anything else is `unknown`.

This matters more than it looks. `docker rm --force` exits 0 for an id that never existed, so
trusting its exit status reported a clean removal of a container this process never owned. A
test caught exactly that. An uncertain cleanup cannot pass a gate.

Likewise an unobserved run writes nothing **to the operation**: a host that cannot see what
a worker did must not convert its own blindness into evidence that the checks failed. What
it does write is a durable hold, so the outbox will not hand the same job out again until
someone decides what happened. Recording only in memory — as an earlier revision did — meant
the next reopen dispatched it a second time.

## The mock-only model route

`MockModelRoute` holds **no provider credential and reaches no provider**. Real credential
placement is a separate Tier-3 decision and does not block this work, because the behaviour
worth building first is the accounting and the refusals.

- **Allowlisting.** Only exact model identifiers on the route are dispatchable; anything else
  is refused before a reservation exists.
- **Conservative reservation.** A reservation is the upper bound for the authorized request:
  the exact input bytes plus the route's **whole output cap**, at a named `priceVersion`. The
  response length is not knowable in advance, so the cap is charged in full rather than
  estimated optimistically and reconciled afterwards.
- **Reserve before dispatch, never refund.** A call that failed, or whose outcome could not be
  observed, still consumed the authorization to make it.
- **Unknown keeps its reservation.** `settleUnknown` records `outcome: "unknown"` and leaves
  the reserved amount charged with no observed usage.
- **No success receipt without an observed outcome.** There is no code path that writes
  `succeeded` without a result the route actually saw.
- **The executor cannot author a receipt.** Settling requires a reservation this route made,
  so a claimed compliance statement has nothing to attach to.

The token carries no secret. As with the callback capability, an HMAC-style payload would be
authenticated, not confidential.

## What is still false, and why

`enforced_scope` is **false** and this package does not change it.

A container confines *which filesystem* the worker sees. It does not deny a write to an
arbitrary path *inside* that filesystem, which is what a path allowlist would have to mean. A
sparse checkout would not help: paths that do not exist yet can still be created, and refusing
a candidate after the writes happened is detection, not containment. So requests that require
path containment are **rejected** rather than accepted and quietly not enforced.

`enforced_deadline` is likewise not asserted. The orchestrator terminates the container and
its children when the deadline passes, which is real termination — but it is not a per-job
deadline enforced inside the executor, and expiring model access would not stop already
running shell work either.

**Neither this package nor the mock route sets any ManagedSDLC capability flag to true.** The
adapter pin remains the coordinator's.

## Running it

```
CHARTERARC_REQUIRE_ISOLATED_MOCK=1 npm test -- packages/host/tests/isolated-mock-execution.test.ts
```

Under that flag a missing prerequisite **fails**; it does not skip. Without it, the container
cases skip and the mock-route and scope cases still run. Environment:

```
CHARTERARC_DOCKER=/Users/abhishekgarg/Documents/ChatGPT/ManagedSDLC/.local/toolchain/bin/docker
DOCKER_HOST=unix:///Users/abhishekgarg/.colima/charterarc-team-tasks/docker.sock
CHARTERARC_FIXTURE_IMAGE=agentx-fixture-worker:lane-b
```

The image is built from a staged context because the classic builder (no buildx on this
daemon) honours only the context-root `.dockerignore`, which excludes `node_modules/` and
`dist/` — both of which this image needs. The repository's `.dockerignore` was left unchanged.

Limits observed per run: one container, 2 GiB, 256 pids, 2 CPUs, ten-minute whole-run
deadline — inside the approved three-container / 6 GiB aggregate ceiling.
