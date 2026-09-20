# Opt-in bounded demo model execution

Parent-authorized local implementation on 2026-09-20, only on
`codex/charterarc-demo-setup`, starting at `db3821629b11e49f57ae9b52cfdf349db5d68706`.
Objective: MSDLC-OBJ-001@0.3, SHA-256
`bc902e9dcecec61f32d748ae290dcab417311db1382e5dbcac59bb1887845843`.
Rights: implement/test/commit this worker guard; no model calls, cloud writes,
image build, push, deployment, candidate integration or gateway redesign.

## Contract and integration

Set **`AGENTX_DEMO_RUN_LIMITS=1`** in the trusted, dedicated demo worker runtime.
Absent or `0` preserves old project behavior. Any other value fails worker startup.
The main process captures the flag once; task payloads and repository configuration
cannot change its limits. Deploying the source without the flag does not enable it.

Enabled tasks have fixed, non-configurable limits:

- 180-second wall deadline starting at task invocation; abort the model/session
  and reject even if abort does not settle. A late prompt cannot return success
  or begin artifact publication after expiry.
- At most eight Bedrock dispatch reservations per task, shared across direct and
  simple stream APIs. Failed/uncertain calls consume their reservation; no refund.
- At most 4,096 output tokens per call, enforced in the final serialized Bedrock
  request after earlier payload hooks, not merely a prompt or model preference.
- At most 262,144 cumulative UTF-8 serialized request bytes, including system,
  context, tools and overhead. Images/documents/video and binary payloads fail
  closed. This byte counter is not represented as measured billed input tokens.
- Only `amazon-bedrock` / `amazon.nova-pro-v1:0`; no fallback, extra model-request
  fields, project model override or enabled image input.
- Coding tools restricted to `read/edit/write/grep/find/ls`, with no `bash`, for
  this two-attempt minimal demo. Trusted preparation/readiness remain outside the
  coding session and unchanged. Parent explicitly approved this narrowing.
- Pi automatic retry and compaction disabled with an in-memory settings manager.
  Worker forces `AWS_MAX_ATTEMPTS=1`: the installed pi-ai 0.85.1 Bedrock adapter
  does not forward its generic `maxRetries` option to `BedrockRuntimeClient`.
  Offline tests check the actual SDK client's resolved maximum-attempt setting.

The parent separately limits admission to **two live attempts total** and tracks
the owner's **under $30 additional AWS/Bedrock** budget. These are not global
worker counters: a new task has a new reservation. Infrastructure charges,
other runtimes/clients and direct SDK use outside the guarded Pi provider are
not metered by this module. Removing the coding shell closes the straightforward
tool-originated SDK bypass, but does not establish general hostile-code isolation.
No claim of an account-wide AWS billing cap or
hostile-process security isolation is made. SDK abort is cancellation, not proof
that already-accepted remote usage was never billed. Session abort cannot prove
every descendant process stopped.

## Evidence and rulings

- RED: actual serialized requests accepted `maxTokens=99999` and an oversized
  second request; task never returned at 180 seconds; default session did not wire
  the limiter, allowing nine model calls and reaching artifact publication.
- GREEN: scoped tests substitute only AWS SDK transport/coding agent operations,
  retain the real Bedrock serializer, ModelRuntime and worker task code, and prove
  capped dispatch, deadline, cumulative limits and default-disabled behavior.
- Ruling: fixed model and text-only payloads narrow this synthetic demo rather
  than estimate arbitrary model prices/tokenizers. Unsupported input fails closed;
  the cost is refusing otherwise legitimate non-demo jobs when incorrectly enabled.
- Ruling: timeout rejects without waiting for an unresponsive abort. Source and
  process quiescence are not claimed; the cost is retaining an uncertain operation
  that requires explicit reconciliation rather than silently rerunning it.
- Ruling: omit shell execution only in the enabled demo, as approved by the parent.
  This sacrifices coding-time builds/tests; the minimal Slack demonstration must
  not claim application verification from this no-shell run.

Final test/build/lint results and commit are reported in the parent handoff.
Postflight: objective unchanged; scope delta none; result implemented/local-tested,
not deployed, delivered or customer-validated. Live proof and independent review
remain parent-owned gates.
