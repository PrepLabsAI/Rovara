# T1 base evidence and migration proof

Captured from unchanged production at engine-boundary base
`2e717e946`, before changing task-flow keys.
The prior R4 capture was rechecked: the new base adds `origin: "app"` to
stored task rows. Original R4 files and the failed comparison remain in the
lane evidence folder. FIX-2 applies the shared hash normalizer to those base
captures; it does not recapture post-migration production output.

Memory and real DynamoDocumentStore/FakeDynamoDb lifecycles start, dispatch
preparation, record its result, dispatch a second operation, record its
result, and close. Six snapshots contain exact sorted pk/sk keys, full rows,
clock/id position, and exact JSON strings for TaskView, listTasks and
workspaceOperations. The only normalized difference for a new lifecycle is
`ORG#<company>#` on workspace partitions and request-idempotency partitions.
All other bytes must match, except hash-shaped substrings: the recorder and
comparator both use `normalizeT1Golden`, replacing lowercase hex runs of at
least 40 characters with `<hexLENGTH#N>`. References are numbered by first
appearance across the entire capture (including nested JSON and partition
keys), preserving equality and length. Case changes remain observable.
Raw placeholder collisions are refused. Replay consumers use
`materializeT1Golden` to reconstruct deterministic, shape-correct synthetic
hashes at runtime, without storing raw digests. The legacy run preloads the base's start
snapshot and completes dispatch, results, a new step and close entirely in
its original legacy workspace partition. Fixtures read no git history.

Run lifecycle.test.ts and readers.test.ts via ci-like-test.sh with
--maxWorkers=2. T1_CAPTURE_BASE_GOLDENS=1 is a base-only capture helper;
ordinary verification must omit it. Never use it to approve a migration.

Reader fixtures use complete partitions, pointers and actual engine stamps.
#681 routes workspace/list reads. ANSWER-2 classifies workflowBinding,
workflowCandidateSourceExportDigest and cancellation.requireOperation as
reachable through routed callers; their direct legacy reads remain pinned.
Flip LEGACY_CORE_READERS_GUARDED to true after E2's follow-up merges.
Additional probes cover callback, watchdog, reaper and GitHub recordedHead
lookups, with legacy positive controls. GitHub and Slack DEVTASK loaders
remain readable under D2 and are not falsely labelled scoped-row misses.

The renewal-drain probe uses the projection-enforcing IAM fake. Legacy
operations count correctly; scoped operations incorrectly produce a clear
drain. ANSWER-3 explicitly defers that file and its company/projection/IAM
companion. It must close before core switch-on. These known-gap tests are
not deployment approval; final gate and review status is in lane DONE.md.
