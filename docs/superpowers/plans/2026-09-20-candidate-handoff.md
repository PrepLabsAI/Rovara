# Immutable candidate handoff implementation plan

Goal: implement the already approved AgentX issue #2 handoff for one real CharterArc round trip.

Architecture: reuse authenticated task admission, fenced worker execution, private artifact storage
and terminal operations. A governed task captures a complete Git snapshot in a fresh Git object
store and returns a self-contained bundle in bounded private artifact chunks. Exact publication is
a subsequent slice; candidate fields and governed-workspace publication fail closed in this slice.

Spec: AgentX issue #2 and `/Users/abhishekgarg/Documents/ChatGPT/charterarc-setup/2026-09-20/candidate-handoff-issue.md`.
Execution: parent explicitly delegated implementation; no additional product decision requested.

Preflight: MSDLC-OBJ-001@0.3, sha256 bc902e9dcecec61f32d748ae290dcab417311db1382e5dbcac59bb1887845843.
Rights: implement and locally test. Preserve untrusted executor claims, independent verification,
named human publication authority, existing standalone behavior. No merge, deployment, live push,
AWS mutation, customer proof or objective change. Dedicated clean job workspace and synthetic demo
data are assumptions. General hostile-process isolation remains a required promotion gate.

1. Add contract tests for strict candidate request/result limits and job/base binding; run RED;
   implement `contracts/candidate.ts` and optional task/publication fields; run GREEN.
2. Add real-Git worker tests for complete source (new/deleted/binary/modes/committed edits), exact
   reconstruction, exclusions, wrong base, cancellation and immutable retries; run RED; implement
   `worker/candidate.ts`, task capture, artifact receipts and durable result replay; run GREEN.
3. Add broker/worker route tests for stored-candidate admission, expiry, wrong job/base, deterministic
   chunk upload, readback and interrupted upload reconciliation. Forward the trusted registered
   project and persisted binding to the worker; validate every retained chunk and whole-bundle hash
   before persisting success. Reject candidate publication and alternate code-changing legacy paths.
   Owner continuation explicitly scopes this checkpoint to candidate return, not PR implementation.
4. Run full tests, typecheck/build and lint; record failures with baseline attribution; commit
   locally and give parent exact commit and contract. Parent coordinates independent review.

Review focus: uncertain upload/callback, worker restart, source mutation during capture, credential
or generated-file inclusion, and alternate publication paths. Freeze retry must replay retained
bytes; uncertain coding execution must never rerun automatically. Max bundle 64 MiB / 32 chunks of
2 MiB; explicit 24h retention binding. Missing or expired data fails closed.

Full-product mapping: exact candidate and authority separation retained/included; general hostile
isolation retained/phased behind managed promotion; other transports retained/phased; production
authority retained/separate and excluded from this change.

## Bounded result and remaining gates

The live handler now admits the exact candidate request and stores its expected binding with the
operation in the existing DynamoDB transaction. Candidate uploads reserve 32 deterministic names,
each at most 2 MiB decoded. S3 conditional creation plus readback protects immutable retry; durable
artifact metadata returns encoded-content digest/size receipts. Task completion checks every
decoded chunk and the complete bundle hash before it exposes `operation.result.candidate`.
Candidate lifetime is at most 24h after capture. Artifact access expires 48h after admission;
this is a logical retrieval boundary, not a claim of physical deletion at that instant.

Local integration exercises the real task freezer and callback client against the real broker HTTP
handler, with an in-memory AWS service substitute and fixture model. It reconstructs a fresh Git
checkout from authenticated artifact GET responses. This proves wire compatibility in a local
fixture, not deployed AWS behavior, independent candidate quality, or model execution.

Remaining: exact publication/approval service, live AWS route run, separate independent verifier,
conversation restoration, and complete process quiescence/hostile-code isolation. Two source scans
detect ordinary capture races but cannot defeat a malicious process controlling runtime state.
Credential detection is a bounded deny policy, not a comprehensive secret detector. Candidate
artifacts and worker state remain untrusted until independent verification. A worker restart during
uncertain coding is not auto-resumed; a later recovery protocol must reconcile that state explicitly.
Failed terminal callbacks replay the persisted result on duplicate invocation. Partial upload
reconciliation is implemented at the artifact/freezer layer; retrying a terminal FAILED task does
not silently rerun coding or promote it to success.

Postflight: executed_against MSDLC-OBJ-001@0.3; alignment pass within this checkpoint;
result_status implemented with local fixture verification; scope_delta none against the latest
bounded delegation; objective_change_attempted false; objective_digest_match true. Publication,
deployment, customer validation and independent review are not claimed.

Verification on 2026-09-20 with Node 22.23.2: `npm test` passed 192 tests in 37 files;
`npm run build`, `npm run lint`, and `git diff --check` passed. Route tests first
failed for dropped bindings, missing receipts, accepting unretained results and unknown repository
selection; the legacy-worker publication guard also failed before its correction. The final route
suite includes full worker/broker reconstruction, interrupted readback retry, wrong bindings,
corrupted retention, bundle digest mismatch, cancellation, stale fence and publication bypass.

## Independent-review race correction

Independent review reproduced stale admission after a candidate finished: a request paused after
reading the old workspace could reuse its old fence and create a legacy publication outbox. Seven
deterministic interleavings (legacy/governed task, publish, append, sync, replace and revert) failed
on checkpoint `41b0dc2`. A separate cancellation interleaving also failed: cancellation could
overwrite a successful candidate after completion won the race.

Admission transactions now require the observed workspace fence; legacy tasks, publication and
code-changing PR lifecycle operations also require the candidate marker to be absent atomically.
Cancellation atomically checks workspace ownership/fence and the observed nonterminal operation
status; if completion wins, it returns the retained terminal result without creating cancellation
state or an outbox. Cancellation completion also requires its target to remain `CANCEL_REQUESTED`
at the matching fence, and checks workspace ownership even when cancellation fails. Three further
regressions reproduced competing cancellation callbacks overwriting a terminal target before this
completion guard. No new authority, publication implementation or deployment is included.

All eleven regressions pass after the correction. Fresh local verification on 2026-09-20 with
Node 22.23.2: `npm test` passed 203 tests in 37 files; `npm run build`, `npm run lint`, and
`git diff --check` passed. These are deterministic service-substitute checks, not live AWS evidence.
One intervening rerun timed out the existing CDK infrastructure synthesis test at its 10s limit
(202 passed, one timeout) while another agent also ran the suite. The unchanged-code rerun passed
all 203 tests; no test timeout or infrastructure behavior was changed to obtain that pass.
The objective digest remains unchanged and all previously listed remaining gates still apply.
