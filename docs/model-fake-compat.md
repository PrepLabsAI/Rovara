# Model fake SDK compatibility

**Round 2 validation pending:** the table below preserves the Round 1 measurements. It has not been rerun with the new mandatory macOS sandbox or tightened cutoff oracle. Per the agreed split, 9d must run `ROVARA_SANDBOX_TESTS=1` against `model-sdk-compat-sandbox.test.ts` and then the live suite outside Codex. No Round 2 live pass is claimed here.

**Table provenance:** the 20 `FIXED` labels and their fix notes were applied by hand to measured passing cells; the legacy Python gRPC `UNVERIFIED` row was added by hand. The six Vertex normal text/stream rows and the Vertex afterCalls row are measured runner output, not handwritten results. The table was assembled from Round 1 `results.json` outputs; rerendering a fresh run alone does not recreate the manual annotations.

Run date: 2026-11-13. Helper base: 64b10bee72aeec3a28a1ac37ba578763e3c47601 plus the fixes in this PR. Python 3.13.17; Node 22.23.2. Mac-only live run; scripted replies, not real-provider proof.

FAIL: 0, FIXED: 20, N/A: 8, PASS: 166, PASS-ERROR: 139, UNVERIFIED: 1

Exact direct versions are in each measured row and [pins.json](../tests/fixtures/model-sdk-compat/pins.json). All package versions and integrity hashes: [Python requirements](../tests/fixtures/model-sdk-compat/requirements.txt), [npm integrity lock](../tests/fixtures/model-sdk-compat/package-lock.json).

## Scope and safety

These are real SDK calls to the scripted loopback helper on macOS, including full stream consumption, exposed final-response helpers, tool results followed by a second turn, and embeddings. The result labels describe parsing of fake replies, not real-provider compatibility. Normal streams expose finish and usage; dropped streams expose partial text before a transport error (or an unfinished stream). `PASS-ERROR` includes documented SDK API/transport errors and the explicitly identified customer-facing finish/tool exceptions. Parser failures are never accepted.

Every SDK dependency was installed into a disposable directory outside all repositories: 73 Python wheels with exact versions and SHA-256 hashes via `pip --require-hashes --only-binary=:all:`, and 94 npm lock entries with exact versions/integrity via `npm ci --ignore-scripts --no-audit --no-fund`. No SDK install used Rovara's dependencies. The Python wheel hashes target this macOS/Python runtime; Linux live SDKs were not run. AI SDK adapters use `ai` 7.0.172 with `@ai-sdk/openai` 4.0.117 and `@ai-sdk/google` 4.0.120.

In Round 1, each child started with an empty inherited environment, fresh scratch HOME/config directories, loopback redirects, and dummy credentials. Vertex project/location cases remove API-key variables and obtain their dummy credential from the helper's metadata service. Python isolated mode plus its audit hook denies private-home file access and subprocesses; Node's permission flags restrict filesystem reads and writes to the scratch client and evidence. Both preloads refuse network/DNS destinations outside loopback; any nonempty or unreadable refusal log fails the run, even when an SDK catches the error. Native canaries were refused before any SDK ran. Real scenario refusal logs: **0**. The helper's trusted ledger also must show zero refused callers and zero redirect escapes.

## Fixes and retry findings

`fix-http-cutoff` makes a shortened response an incomplete HTTP response: a missing final chunk for SSE and a deliberately unsatisfied Content-Length for non-SSE. The helper flushes the available bytes then closes the socket. Previously several clients attempted to parse a complete malformed document. Regression: `model-sdk-compat-cutoff.test.ts`; removing the incomplete framing, length discrepancy, or close makes it fail.

`fix-openai-usage` adds the standard empty-choices usage chunk immediately before the terminal DONE marker. Normal OpenAI Python/Node and LangChain streams previously had no usage. Regression: `model-sdk-compat-stream-usage.test.ts` covers normal and failure-pack streams, and text containing a marker-like string. Removing usage or replacing the first marker-like string makes the test fail. Existing tool-stream extraction now tolerates the valid usage-only chunk; no stored golden file changed. `FIXED` rows preserve the final outcome in their note.

Expected attempts were read from the pinned installed SDK source, not inferred solely from the measured counts. No SDK retry count is overridden. A 400 takes one attempt. Tool success takes two. The afterCalls-1 rows include the initial successful call.

| SDK | Default 429 attempts | Installed source policy |
|---|---:|---|
| Python OpenAI, Anthropic, LangChain OpenAI | 3 | `openai/_constants.py`, `anthropic/_constants.py`; default two retries in `_base_client.py`; LangChain passes through that default. |
| Node OpenAI, Anthropic | 3 | `src/client.ts` default maxRetries 2; retryable HTTP status handling. |
| Python/Node Google GenAI | 1 | Python `google/genai/_api_client.py: retry_args(None)` stops after one; Node `dist/node/index.mjs` uses one fetch without retryOptions. |
| Python/Node legacy Google | 1 | Generated REST method has no retry policy; Node fetch helper has no retry loop. |
| Python Cohere | 3 unary, 1 stream | `cohere/core/http_client.py` defaults to two retries in request; its stream context manager has no retry loop. |
| Node Cohere | 3 | `dist/core/fetcher/Fetcher.js` defaults to two retries. |
| LangChain Google | 6 | `_common.py` max_retries 6 is passed by `chat_models.py` as `HttpRetryOptions(attempts=6)`, meaning six total attempts. |
| AI SDK OpenAI/Google | 3 | `src/util/retry-with-exponential-backoff.ts` defaults maxRetries to 2. |

Transport-drop finding: Python OpenAI/Anthropic/LangChain OpenAI retry non-stream read failures twice, and AI SDK OpenAI/Google retry their retryable APICallError twice. These text cutoffs therefore take three attempts; other cutoffs take one. Python Cohere's streaming 429 takes one despite its unary default of three. The matrix uses these operation-specific expectations; no unexplained attempt mismatch remains. Node legacy Google replaces a stream socket cause with its own fixed “Error reading from the stream” error; the fixture recognizes only that exact SDK error internally and prints no message. Python OpenAI's final helper raises LengthFinishReasonError/ContentFilterFinishReasonError for the matching finish modes; these are documented customer exceptions, not malformed-byte parse failures.

## Round 2 isolation changes

Every live Python and Node child now runs through `/usr/bin/sandbox-exec`: deny all networking except loopback, deny reads of the real home, and allow the selected interpreter runtime and scratch tree. Any sandbox launch failure, timeout, or nonzero exit fails the run; there is no unsandboxed fallback. The real home is a sandbox profile parameter, never a child environment variable. Python also audits native sendto/sendmsg/getnameinfo and refuses ctypes handles outside explicit paths in the venv. Importing a dependency that needs system ctypes handles will fail closed and needs investigation, not a relaxed guard.

Each preload performs its own refusal canary before SDK imports. Every child log must contain exactly that one canary line and zero runtime refusals; missing, stale, additional or unreadable evidence fails the run. Node reports its installed package version independently of the pins. The supervisor validates the final environment, pins and result schema, and cutoff API errors require a recognized connection class or confirmed transport marker.

## Reproduction

Create a fresh `/private/tmp/sdk-compat-*` directory, venv, and `node` subdirectory outside every repository. Install the committed Python hash file with `--require-hashes --only-binary=:all:` and use the committed npm manifest/lock with `npm ci --ignore-scripts --no-audit --no-fund`; use a scratch HOME for installers. Copy `sitecustomize.py` into that venv's site-packages before running any SDK. The runner copies the client fixtures (stripping `.fixture` from Node filenames), never installs packages, and writes measured results only into scratch. Run the optional live test with `ROVARA_SDK_COMPAT_DIR` pointing at that scratch install through the lane's heavy wrapper. With no such variable, the live test is explicitly skipped as “not run: libraries not installed.”

The offline policy, renderer, process limits, tripwire, cutoff and usage regressions need no downloaded SDKs. Linux proof used the same offline test bodies bundled with the repository's installed dependencies and a node:test adapter, in an already-local Node 22 image with networking disabled, a read-only root and a temporary filesystem. This is offline Linux proof, not a Linux live matrix or a CI run.

## Measured cells

| Runtime | Library | Version | Row | Scenario | Mode | Variant | Result | Attempts observed/expected | Note |
|---|---|---|---|---|---|---|---|---|---|
| Python | `openai` | 3.50.0 | openai | text | normal | default | PASS | 1/1 | finish-stop:tools-na |
| Python | `openai` | 3.50.0 | openai | stream | normal | default | FIXED | 1/1 | fix-openai-usage:PASS;finish-stop:tools-na |
| Python | `openai` | 3.50.0 | openai | tool | normal | default | PASS | 2/2 | finish-tool_calls:tools-valid |
| Python | `openai` | 3.50.0 | openai | embeddings | normal | default | PASS | 1/1 | finish-none:tools-na |
| Python | `openai` | 3.50.0 | openai | text | rate_limit | default | PASS-ERROR | 3/3 | api:RateLimitError:status-429 |
| Python | `openai` | 3.50.0 | openai | text | cut_off_stream | default | FIXED | 3/3 | fix-http-cutoff:PASS-ERROR;api:APIConnectionError:status-0 |
| Python | `openai` | 3.50.0 | openai | text | token_limit | output | PASS | 1/1 | finish-length:tools-na |
| Python | `openai` | 3.50.0 | openai | text | token_limit | input | PASS-ERROR | 1/1 | api:BadRequestError:status-400 |
| Python | `openai` | 3.50.0 | openai | text | refusal | refusal | PASS | 1/1 | finish-stop:tools-na |
| Python | `openai` | 3.50.0 | openai | text | refusal | filter | PASS | 1/1 | finish-content_filter:tools-na |
| Python | `openai` | 3.50.0 | openai | text | bad_tool_json | default | PASS | 1/1 | finish-tool_calls:tools-invalid |
| Python | `openai` | 3.50.0 | openai | stream | rate_limit | default | PASS-ERROR | 3/3 | api:RateLimitError:status-429 |
| Python | `openai` | 3.50.0 | openai | stream | cut_off_stream | default | PASS-ERROR | 1/1 | api:APIConnectionError:status-0 |
| Python | `openai` | 3.50.0 | openai | stream | token_limit | output | PASS-ERROR | 1/1 | customer:LengthFinishReasonError:status-0 |
| Python | `openai` | 3.50.0 | openai | stream | token_limit | input | PASS-ERROR | 1/1 | api:BadRequestError:status-400 |
| Python | `openai` | 3.50.0 | openai | stream | refusal | refusal | PASS | 1/1 | finish-stop:tools-na |
| Python | `openai` | 3.50.0 | openai | stream | refusal | filter | PASS-ERROR | 1/1 | customer:ContentFilterFinishReasonError:status-0 |
| Python | `openai` | 3.50.0 | openai | stream | bad_tool_json | default | PASS | 1/1 | finish-tool_calls:tools-invalid |
| Python | `openai` | 3.50.0 | openai | embeddings | cut_off_stream | default | PASS-ERROR | 1/1 | api:BadRequestError:status-400 |
| Python | `openai` | 3.50.0 | openai | embeddings | refusal | default | PASS-ERROR | 1/1 | api:BadRequestError:status-400 |
| Python | `openai` | 3.50.0 | openai | embeddings | bad_tool_json | default | PASS-ERROR | 1/1 | api:BadRequestError:status-400 |
| Python | `openai` | 3.50.0 | openai | text | unmatched | default | PASS-ERROR | 1/1 | api:BadRequestError:status-400 |
| Python | `openai` | 3.50.0 | openai | stream | unmatched | default | PASS-ERROR | 1/1 | api:BadRequestError:status-400 |
| Python | `openai` | 3.50.0 | openai | text | rate_limit | afterCalls-1 | PASS-ERROR | 4/4 | api:RateLimitError:status-429 |
| Python | `anthropic` | 2.8.0 | anthropic | text | normal | default | PASS | 1/1 | finish-end_turn:tools-na |
| Python | `anthropic` | 2.8.0 | anthropic | stream | normal | default | PASS | 1/1 | finish-end_turn:tools-na |
| Python | `anthropic` | 2.8.0 | anthropic | tool | normal | default | PASS | 2/2 | finish-tool_use:tools-valid |
| Python | `anthropic` | 2.8.0 | anthropic | embeddings | normal | default | N/A | 0/0 | library-has-no-embeddings |
| Python | `anthropic` | 2.8.0 | anthropic | text | rate_limit | default | PASS-ERROR | 3/3 | api:RateLimitError:status-429 |
| Python | `anthropic` | 2.8.0 | anthropic | text | cut_off_stream | default | FIXED | 3/3 | fix-http-cutoff:PASS-ERROR;api:APIConnectionError:status-0 |
| Python | `anthropic` | 2.8.0 | anthropic | text | token_limit | output | PASS | 1/1 | finish-max_tokens:tools-na |
| Python | `anthropic` | 2.8.0 | anthropic | text | token_limit | input | PASS-ERROR | 1/1 | api:BadRequestError:status-400 |
| Python | `anthropic` | 2.8.0 | anthropic | text | refusal | refusal | PASS | 1/1 | finish-refusal:tools-na |
| Python | `anthropic` | 2.8.0 | anthropic | text | refusal | filter | PASS | 1/1 | finish-refusal:tools-na |
| Python | `anthropic` | 2.8.0 | anthropic | text | bad_tool_json | default | PASS | 1/1 | finish-tool_use:tools-schema_invalid |
| Python | `anthropic` | 2.8.0 | anthropic | stream | rate_limit | default | PASS-ERROR | 3/3 | api:RateLimitError:status-429 |
| Python | `anthropic` | 2.8.0 | anthropic | stream | cut_off_stream | default | PASS-ERROR | 1/1 | transport:RemoteProtocolError:status-0 |
| Python | `anthropic` | 2.8.0 | anthropic | stream | token_limit | output | PASS | 1/1 | finish-max_tokens:tools-na |
| Python | `anthropic` | 2.8.0 | anthropic | stream | token_limit | input | PASS-ERROR | 1/1 | api:BadRequestError:status-400 |
| Python | `anthropic` | 2.8.0 | anthropic | stream | refusal | refusal | PASS | 1/1 | finish-refusal:tools-na |
| Python | `anthropic` | 2.8.0 | anthropic | stream | refusal | filter | PASS | 1/1 | finish-refusal:tools-na |
| Python | `anthropic` | 2.8.0 | anthropic | stream | bad_tool_json | default | PASS | 1/1 | finish-tool_use:tools-schema_invalid |
| Python | `anthropic` | 2.8.0 | anthropic | embeddings | cut_off_stream | default | N/A | 0/0 | library-has-no-embeddings |
| Python | `anthropic` | 2.8.0 | anthropic | embeddings | refusal | default | N/A | 0/0 | library-has-no-embeddings |
| Python | `anthropic` | 2.8.0 | anthropic | embeddings | bad_tool_json | default | N/A | 0/0 | library-has-no-embeddings |
| Python | `anthropic` | 2.8.0 | anthropic | text | unmatched | default | PASS-ERROR | 1/1 | api:BadRequestError:status-400 |
| Python | `anthropic` | 2.8.0 | anthropic | stream | unmatched | default | PASS-ERROR | 1/1 | api:BadRequestError:status-400 |
| Python | `anthropic` | 2.8.0 | anthropic | text | rate_limit | afterCalls-1 | PASS-ERROR | 4/4 | api:RateLimitError:status-429 |
| Python | `google-genai` | 3.3.0 | gemini | text | normal | default | PASS | 1/1 | finish-STOP:tools-na |
| Python | `google-genai` | 3.3.0 | gemini | stream | normal | default | PASS | 1/1 | finish-STOP:tools-na |
| Python | `google-genai` | 3.3.0 | gemini | tool | normal | default | PASS | 2/2 | finish-STOP:tools-valid |
| Python | `google-genai` | 3.3.0 | gemini | embeddings | normal | default | PASS | 1/1 | finish-none:tools-na |
| Python | `google-genai` | 3.3.0 | gemini | text | rate_limit | default | PASS-ERROR | 1/1 | api:ClientError:status-429 |
| Python | `google-genai` | 3.3.0 | gemini | text | cut_off_stream | default | FIXED | 1/1 | fix-http-cutoff:PASS-ERROR;transport:RemoteProtocolError:status-0 |
| Python | `google-genai` | 3.3.0 | gemini | text | token_limit | output | PASS | 1/1 | finish-MAX_TOKENS:tools-na |
| Python | `google-genai` | 3.3.0 | gemini | text | token_limit | input | PASS-ERROR | 1/1 | api:ClientError:status-400 |
| Python | `google-genai` | 3.3.0 | gemini | text | refusal | refusal | PASS | 1/1 | finish-SAFETY:tools-na |
| Python | `google-genai` | 3.3.0 | gemini | text | refusal | filter | PASS | 1/1 | finish-SAFETY:tools-na |
| Python | `google-genai` | 3.3.0 | gemini | text | bad_tool_json | default | PASS | 1/1 | finish-STOP:tools-schema_invalid |
| Python | `google-genai` | 3.3.0 | gemini | stream | rate_limit | default | PASS-ERROR | 1/1 | api:ClientError:status-429 |
| Python | `google-genai` | 3.3.0 | gemini | stream | cut_off_stream | default | FIXED | 1/1 | fix-http-cutoff:PASS-ERROR;transport:RemoteProtocolError:status-0 |
| Python | `google-genai` | 3.3.0 | gemini | stream | token_limit | output | PASS | 1/1 | finish-MAX_TOKENS:tools-na |
| Python | `google-genai` | 3.3.0 | gemini | stream | token_limit | input | PASS-ERROR | 1/1 | api:ClientError:status-400 |
| Python | `google-genai` | 3.3.0 | gemini | stream | refusal | refusal | PASS | 1/1 | finish-SAFETY:tools-na |
| Python | `google-genai` | 3.3.0 | gemini | stream | refusal | filter | PASS | 1/1 | finish-SAFETY:tools-na |
| Python | `google-genai` | 3.3.0 | gemini | stream | bad_tool_json | default | PASS | 1/1 | finish-STOP:tools-schema_invalid |
| Python | `google-genai` | 3.3.0 | gemini | embeddings | cut_off_stream | default | PASS-ERROR | 1/1 | api:ClientError:status-400 |
| Python | `google-genai` | 3.3.0 | gemini | embeddings | refusal | default | PASS-ERROR | 1/1 | api:ClientError:status-400 |
| Python | `google-genai` | 3.3.0 | gemini | embeddings | bad_tool_json | default | PASS-ERROR | 1/1 | api:ClientError:status-400 |
| Python | `google-genai` | 3.3.0 | gemini | text | unmatched | default | PASS-ERROR | 1/1 | api:ClientError:status-400 |
| Python | `google-genai` | 3.3.0 | gemini | stream | unmatched | default | PASS-ERROR | 1/1 | api:ClientError:status-400 |
| Python | `google-genai` | 3.3.0 | vertex | text | rate_limit | afterCalls-1 | PASS-ERROR | 2/2 | api:ClientError:status-429 |
| Python | `google-genai` | 3.3.0 | vertex | text | normal | default | PASS | 1/1 | finish-STOP:tools-na |
| Python | `google-genai` | 3.3.0 | vertex | stream | normal | default | PASS | 1/1 | finish-STOP:tools-na |
| Python | `google-genai` | 3.3.0 | gemini | text | rate_limit | afterCalls-1 | PASS-ERROR | 2/2 | api:ClientError:status-429 |
| Python | `google-generativeai` | 0.8.6 | gemini | text | normal | default | PASS | 1/1 | finish-STOP:tools-na |
| Python | `google-generativeai` | 0.8.6 | gemini | stream | normal | default | PASS | 1/1 | finish-STOP:tools-na |
| Python | `google-generativeai` | 0.8.6 | gemini | tool | normal | default | PASS | 2/2 | finish-STOP:tools-valid |
| Python | `google-generativeai` | 0.8.6 | gemini | embeddings | normal | default | PASS | 1/1 | finish-none:tools-na |
| Python | `google-generativeai` | 0.8.6 | gemini | text | rate_limit | default | PASS-ERROR | 1/1 | api:TooManyRequests:status-429 |
| Python | `google-generativeai` | 0.8.6 | gemini | text | cut_off_stream | default | FIXED | 1/1 | fix-http-cutoff:PASS-ERROR;transport:ChunkedEncodingError:status-0 |
| Python | `google-generativeai` | 0.8.6 | gemini | text | token_limit | output | PASS | 1/1 | finish-MAX_TOKENS:tools-na |
| Python | `google-generativeai` | 0.8.6 | gemini | text | token_limit | input | PASS-ERROR | 1/1 | api:BadRequest:status-400 |
| Python | `google-generativeai` | 0.8.6 | gemini | text | refusal | refusal | PASS | 1/1 | finish-SAFETY:tools-na |
| Python | `google-generativeai` | 0.8.6 | gemini | text | refusal | filter | PASS | 1/1 | finish-SAFETY:tools-na |
| Python | `google-generativeai` | 0.8.6 | gemini | text | bad_tool_json | default | PASS | 1/1 | finish-STOP:tools-schema_invalid |
| Python | `google-generativeai` | 0.8.6 | gemini | stream | rate_limit | default | PASS-ERROR | 1/1 | api:TooManyRequests:status-429 |
| Python | `google-generativeai` | 0.8.6 | gemini | stream | cut_off_stream | default | FIXED | 1/1 | fix-http-cutoff:PASS-ERROR;transport:ChunkedEncodingError:status-0 |
| Python | `google-generativeai` | 0.8.6 | gemini | stream | token_limit | output | PASS | 1/1 | finish-MAX_TOKENS:tools-na |
| Python | `google-generativeai` | 0.8.6 | gemini | stream | token_limit | input | PASS-ERROR | 1/1 | api:BadRequest:status-400 |
| Python | `google-generativeai` | 0.8.6 | gemini | stream | refusal | refusal | PASS | 1/1 | finish-SAFETY:tools-na |
| Python | `google-generativeai` | 0.8.6 | gemini | stream | refusal | filter | PASS-ERROR | 1/1 | customer:BlockedPromptException:status-0 |
| Python | `google-generativeai` | 0.8.6 | gemini | stream | bad_tool_json | default | PASS | 1/1 | finish-STOP:tools-schema_invalid |
| Python | `google-generativeai` | 0.8.6 | gemini | embeddings | cut_off_stream | default | PASS-ERROR | 1/1 | api:BadRequest:status-400 |
| Python | `google-generativeai` | 0.8.6 | gemini | embeddings | refusal | default | PASS-ERROR | 1/1 | api:BadRequest:status-400 |
| Python | `google-generativeai` | 0.8.6 | gemini | embeddings | bad_tool_json | default | PASS-ERROR | 1/1 | api:BadRequest:status-400 |
| Python | `google-generativeai` | 0.8.6 | gemini | text | unmatched | default | PASS-ERROR | 1/1 | api:BadRequest:status-400 |
| Python | `google-generativeai` | 0.8.6 | gemini | stream | unmatched | default | PASS-ERROR | 1/1 | api:BadRequest:status-400 |
| Python | `cohere` | 7.3.1 | cohere | text | normal | default | PASS | 1/1 | finish-COMPLETE:tools-na |
| Python | `cohere` | 7.3.1 | cohere | stream | normal | default | PASS | 1/1 | finish-COMPLETE:tools-na |
| Python | `cohere` | 7.3.1 | cohere | tool | normal | default | PASS | 2/2 | finish-TOOL_CALL:tools-valid |
| Python | `cohere` | 7.3.1 | cohere | embeddings | normal | default | PASS | 1/1 | finish-none:tools-na |
| Python | `cohere` | 7.3.1 | cohere | text | rate_limit | default | PASS-ERROR | 3/3 | api:TooManyRequestsError:status-429 |
| Python | `cohere` | 7.3.1 | cohere | text | cut_off_stream | default | FIXED | 1/1 | fix-http-cutoff:PASS-ERROR;transport:RemoteProtocolError:status-0 |
| Python | `cohere` | 7.3.1 | cohere | text | token_limit | output | PASS | 1/1 | finish-MAX_TOKENS:tools-na |
| Python | `cohere` | 7.3.1 | cohere | text | token_limit | input | PASS-ERROR | 1/1 | api:BadRequestError:status-400 |
| Python | `cohere` | 7.3.1 | cohere | text | refusal | refusal | PASS | 1/1 | finish-COMPLETE:tools-na |
| Python | `cohere` | 7.3.1 | cohere | text | refusal | filter | PASS | 1/1 | finish-COMPLETE:tools-na |
| Python | `cohere` | 7.3.1 | cohere | text | bad_tool_json | default | PASS | 1/1 | finish-TOOL_CALL:tools-invalid |
| Python | `cohere` | 7.3.1 | cohere | stream | rate_limit | default | PASS-ERROR | 1/1 | api:TooManyRequestsError:status-429 |
| Python | `cohere` | 7.3.1 | cohere | stream | cut_off_stream | default | PASS-ERROR | 1/1 | transport:RemoteProtocolError:status-0 |
| Python | `cohere` | 7.3.1 | cohere | stream | token_limit | output | PASS | 1/1 | finish-MAX_TOKENS:tools-na |
| Python | `cohere` | 7.3.1 | cohere | stream | token_limit | input | PASS-ERROR | 1/1 | api:BadRequestError:status-400 |
| Python | `cohere` | 7.3.1 | cohere | stream | refusal | refusal | PASS | 1/1 | finish-COMPLETE:tools-na |
| Python | `cohere` | 7.3.1 | cohere | stream | refusal | filter | PASS | 1/1 | finish-COMPLETE:tools-na |
| Python | `cohere` | 7.3.1 | cohere | stream | bad_tool_json | default | PASS | 1/1 | finish-TOOL_CALL:tools-invalid |
| Python | `cohere` | 7.3.1 | cohere | embeddings | cut_off_stream | default | PASS-ERROR | 1/1 | api:BadRequestError:status-400 |
| Python | `cohere` | 7.3.1 | cohere | embeddings | refusal | default | PASS-ERROR | 1/1 | api:BadRequestError:status-400 |
| Python | `cohere` | 7.3.1 | cohere | embeddings | bad_tool_json | default | PASS-ERROR | 1/1 | api:BadRequestError:status-400 |
| Python | `cohere` | 7.3.1 | cohere | text | unmatched | default | PASS-ERROR | 1/1 | api:BadRequestError:status-400 |
| Python | `cohere` | 7.3.1 | cohere | stream | unmatched | default | PASS-ERROR | 1/1 | api:BadRequestError:status-400 |
| Python | `cohere` | 7.3.1 | cohere | text | rate_limit | afterCalls-1 | PASS-ERROR | 4/4 | api:TooManyRequestsError:status-429 |
| Python | `langchain-openai` | 1.7.4 | openai | text | normal | default | PASS | 1/1 | finish-stop:tools-na |
| Python | `langchain-openai` | 1.7.4 | openai | stream | normal | default | FIXED | 1/1 | fix-openai-usage:PASS;finish-stop:tools-na |
| Python | `langchain-openai` | 1.7.4 | openai | tool | normal | default | PASS | 2/2 | finish-tool_calls:tools-valid |
| Python | `langchain-openai` | 1.7.4 | openai | embeddings | normal | default | PASS | 1/1 | finish-none:tools-na |
| Python | `langchain-openai` | 1.7.4 | openai | text | rate_limit | default | PASS-ERROR | 3/3 | api:OpenAIRateLimitError:status-429 |
| Python | `langchain-openai` | 1.7.4 | openai | text | cut_off_stream | default | FIXED | 3/3 | fix-http-cutoff:PASS-ERROR;api:OpenAIConnectionError:status-0 |
| Python | `langchain-openai` | 1.7.4 | openai | text | token_limit | output | PASS | 1/1 | finish-length:tools-na |
| Python | `langchain-openai` | 1.7.4 | openai | text | token_limit | input | PASS-ERROR | 1/1 | api:OpenAIInvalidRequestError:status-400 |
| Python | `langchain-openai` | 1.7.4 | openai | text | refusal | refusal | PASS | 1/1 | finish-stop:tools-na |
| Python | `langchain-openai` | 1.7.4 | openai | text | refusal | filter | PASS | 1/1 | finish-content_filter:tools-na |
| Python | `langchain-openai` | 1.7.4 | openai | text | bad_tool_json | default | PASS | 1/1 | finish-tool_calls:tools-invalid |
| Python | `langchain-openai` | 1.7.4 | openai | stream | rate_limit | default | PASS-ERROR | 3/3 | api:OpenAIRateLimitError:status-429 |
| Python | `langchain-openai` | 1.7.4 | openai | stream | cut_off_stream | default | PASS-ERROR | 1/1 | api:OpenAIConnectionError:status-0 |
| Python | `langchain-openai` | 1.7.4 | openai | stream | token_limit | output | PASS | 1/1 | finish-length:tools-na |
| Python | `langchain-openai` | 1.7.4 | openai | stream | token_limit | input | PASS-ERROR | 1/1 | api:OpenAIInvalidRequestError:status-400 |
| Python | `langchain-openai` | 1.7.4 | openai | stream | refusal | refusal | PASS | 1/1 | finish-stop:tools-na |
| Python | `langchain-openai` | 1.7.4 | openai | stream | refusal | filter | PASS | 1/1 | finish-content_filter:tools-na |
| Python | `langchain-openai` | 1.7.4 | openai | stream | bad_tool_json | default | PASS | 1/1 | finish-tool_calls:tools-schema_invalid |
| Python | `langchain-openai` | 1.7.4 | openai | embeddings | cut_off_stream | default | PASS-ERROR | 1/1 | api:BadRequestError:status-400 |
| Python | `langchain-openai` | 1.7.4 | openai | embeddings | refusal | default | PASS-ERROR | 1/1 | api:BadRequestError:status-400 |
| Python | `langchain-openai` | 1.7.4 | openai | embeddings | bad_tool_json | default | PASS-ERROR | 1/1 | api:BadRequestError:status-400 |
| Python | `langchain-openai` | 1.7.4 | openai | text | unmatched | default | PASS-ERROR | 1/1 | api:OpenAIInvalidRequestError:status-400 |
| Python | `langchain-openai` | 1.7.4 | openai | stream | unmatched | default | PASS-ERROR | 1/1 | api:OpenAIInvalidRequestError:status-400 |
| Python | `langchain-google-genai` | 4.5.0 | gemini | text | normal | default | PASS | 1/1 | finish-STOP:tools-na |
| Python | `langchain-google-genai` | 4.5.0 | gemini | stream | normal | default | PASS | 1/1 | finish-STOP:tools-na |
| Python | `langchain-google-genai` | 4.5.0 | gemini | tool | normal | default | PASS | 2/2 | finish-STOP:tools-valid |
| Python | `langchain-google-genai` | 4.5.0 | gemini | embeddings | normal | default | PASS | 1/1 | finish-none:tools-na |
| Python | `langchain-google-genai` | 4.5.0 | gemini | text | rate_limit | default | PASS-ERROR | 6/6 | api:GoogleRateLimitError:status-429 |
| Python | `langchain-google-genai` | 4.5.0 | gemini | text | cut_off_stream | default | FIXED | 1/1 | fix-http-cutoff:PASS-ERROR;transport:RemoteProtocolError:status-0 |
| Python | `langchain-google-genai` | 4.5.0 | gemini | text | token_limit | output | PASS | 1/1 | finish-MAX_TOKENS:tools-na |
| Python | `langchain-google-genai` | 4.5.0 | gemini | text | token_limit | input | PASS-ERROR | 1/1 | api:GoogleInvalidRequestError:status-400 |
| Python | `langchain-google-genai` | 4.5.0 | gemini | text | refusal | refusal | PASS | 1/1 | finish-SAFETY:tools-na |
| Python | `langchain-google-genai` | 4.5.0 | gemini | text | refusal | filter | PASS | 1/1 | finish-SAFETY:tools-na |
| Python | `langchain-google-genai` | 4.5.0 | gemini | text | bad_tool_json | default | PASS | 1/1 | finish-STOP:tools-schema_invalid |
| Python | `langchain-google-genai` | 4.5.0 | gemini | stream | rate_limit | default | PASS-ERROR | 6/6 | api:GoogleRateLimitError:status-429 |
| Python | `langchain-google-genai` | 4.5.0 | gemini | stream | cut_off_stream | default | FIXED | 1/1 | fix-http-cutoff:PASS-ERROR;transport:RemoteProtocolError:status-0 |
| Python | `langchain-google-genai` | 4.5.0 | gemini | stream | token_limit | output | PASS | 1/1 | finish-MAX_TOKENS:tools-na |
| Python | `langchain-google-genai` | 4.5.0 | gemini | stream | token_limit | input | PASS-ERROR | 1/1 | api:GoogleInvalidRequestError:status-400 |
| Python | `langchain-google-genai` | 4.5.0 | gemini | stream | refusal | refusal | PASS | 1/1 | finish-SAFETY:tools-na |
| Python | `langchain-google-genai` | 4.5.0 | gemini | stream | refusal | filter | PASS | 1/1 | finish-SAFETY:tools-na |
| Python | `langchain-google-genai` | 4.5.0 | gemini | stream | bad_tool_json | default | PASS | 1/1 | finish-STOP:tools-schema_invalid |
| Python | `langchain-google-genai` | 4.5.0 | gemini | embeddings | cut_off_stream | default | PASS-ERROR | 1/1 | api:GoogleGenerativeAIError:status-400 |
| Python | `langchain-google-genai` | 4.5.0 | gemini | embeddings | refusal | default | PASS-ERROR | 1/1 | api:GoogleGenerativeAIError:status-400 |
| Python | `langchain-google-genai` | 4.5.0 | gemini | embeddings | bad_tool_json | default | PASS-ERROR | 1/1 | api:GoogleGenerativeAIError:status-400 |
| Python | `langchain-google-genai` | 4.5.0 | gemini | text | unmatched | default | PASS-ERROR | 1/1 | api:GoogleInvalidRequestError:status-400 |
| Python | `langchain-google-genai` | 4.5.0 | gemini | stream | unmatched | default | PASS-ERROR | 1/1 | api:GoogleInvalidRequestError:status-400 |
| Python | `langchain-google-genai` | 4.5.0 | vertex | text | normal | default | PASS | 1/1 | finish-STOP:tools-na |
| Python | `langchain-google-genai` | 4.5.0 | vertex | stream | normal | default | PASS | 1/1 | finish-STOP:tools-na |
| Node | `openai` | 7.56.0 | openai | text | normal | default | PASS | 1/1 | finish-stop:tools-na |
| Node | `openai` | 7.56.0 | openai | stream | normal | default | FIXED | 1/1 | fix-openai-usage:PASS;finish-stop:tools-na |
| Node | `openai` | 7.56.0 | openai | tool | normal | default | PASS | 2/2 | finish-tool_calls:tools-valid |
| Node | `openai` | 7.56.0 | openai | embeddings | normal | default | PASS | 1/1 | finish-none:tools-na |
| Node | `openai` | 7.56.0 | openai | text | rate_limit | default | PASS-ERROR | 3/3 | api:RateLimitError:status-429 |
| Node | `openai` | 7.56.0 | openai | text | cut_off_stream | default | FIXED | 1/1 | fix-http-cutoff:PASS-ERROR;transport:TypeError:status-0 |
| Node | `openai` | 7.56.0 | openai | text | token_limit | output | PASS | 1/1 | finish-length:tools-na |
| Node | `openai` | 7.56.0 | openai | text | token_limit | input | PASS-ERROR | 1/1 | api:BadRequestError:status-400 |
| Node | `openai` | 7.56.0 | openai | text | refusal | refusal | PASS | 1/1 | finish-stop:tools-na |
| Node | `openai` | 7.56.0 | openai | text | refusal | filter | PASS | 1/1 | finish-content_filter:tools-na |
| Node | `openai` | 7.56.0 | openai | text | bad_tool_json | default | PASS | 1/1 | finish-tool_calls:tools-invalid |
| Node | `openai` | 7.56.0 | openai | stream | rate_limit | default | PASS-ERROR | 3/3 | api:RateLimitError:status-429 |
| Node | `openai` | 7.56.0 | openai | stream | cut_off_stream | default | PASS-ERROR | 1/1 | transport:OpenAIError:status-0 |
| Node | `openai` | 7.56.0 | openai | stream | token_limit | output | PASS | 1/1 | finish-length:tools-na |
| Node | `openai` | 7.56.0 | openai | stream | token_limit | input | PASS-ERROR | 1/1 | api:BadRequestError:status-400 |
| Node | `openai` | 7.56.0 | openai | stream | refusal | refusal | PASS | 1/1 | finish-stop:tools-na |
| Node | `openai` | 7.56.0 | openai | stream | refusal | filter | PASS | 1/1 | finish-content_filter:tools-na |
| Node | `openai` | 7.56.0 | openai | stream | bad_tool_json | default | PASS | 1/1 | finish-tool_calls:tools-invalid |
| Node | `openai` | 7.56.0 | openai | embeddings | cut_off_stream | default | PASS-ERROR | 1/1 | api:BadRequestError:status-400 |
| Node | `openai` | 7.56.0 | openai | embeddings | refusal | default | PASS-ERROR | 1/1 | api:BadRequestError:status-400 |
| Node | `openai` | 7.56.0 | openai | embeddings | bad_tool_json | default | PASS-ERROR | 1/1 | api:BadRequestError:status-400 |
| Node | `openai` | 7.56.0 | openai | text | unmatched | default | PASS-ERROR | 1/1 | api:BadRequestError:status-400 |
| Node | `openai` | 7.56.0 | openai | stream | unmatched | default | PASS-ERROR | 1/1 | api:BadRequestError:status-400 |
| Node | `@anthropic-ai/sdk` | 1.8.0 | anthropic | text | normal | default | PASS | 1/1 | finish-end_turn:tools-na |
| Node | `@anthropic-ai/sdk` | 1.8.0 | anthropic | stream | normal | default | PASS | 1/1 | finish-end_turn:tools-na |
| Node | `@anthropic-ai/sdk` | 1.8.0 | anthropic | tool | normal | default | PASS | 2/2 | finish-tool_use:tools-valid |
| Node | `@anthropic-ai/sdk` | 1.8.0 | anthropic | embeddings | normal | default | N/A | 0/0 | library-has-no-embeddings |
| Node | `@anthropic-ai/sdk` | 1.8.0 | anthropic | text | rate_limit | default | PASS-ERROR | 3/3 | api:RateLimitError:status-429 |
| Node | `@anthropic-ai/sdk` | 1.8.0 | anthropic | text | cut_off_stream | default | FIXED | 1/1 | fix-http-cutoff:PASS-ERROR;transport:TypeError:status-0 |
| Node | `@anthropic-ai/sdk` | 1.8.0 | anthropic | text | token_limit | output | PASS | 1/1 | finish-max_tokens:tools-na |
| Node | `@anthropic-ai/sdk` | 1.8.0 | anthropic | text | token_limit | input | PASS-ERROR | 1/1 | api:BadRequestError:status-400 |
| Node | `@anthropic-ai/sdk` | 1.8.0 | anthropic | text | refusal | refusal | PASS | 1/1 | finish-refusal:tools-na |
| Node | `@anthropic-ai/sdk` | 1.8.0 | anthropic | text | refusal | filter | PASS | 1/1 | finish-refusal:tools-na |
| Node | `@anthropic-ai/sdk` | 1.8.0 | anthropic | text | bad_tool_json | default | PASS | 1/1 | finish-tool_use:tools-schema_invalid |
| Node | `@anthropic-ai/sdk` | 1.8.0 | anthropic | stream | rate_limit | default | PASS-ERROR | 3/3 | api:RateLimitError:status-429 |
| Node | `@anthropic-ai/sdk` | 1.8.0 | anthropic | stream | cut_off_stream | default | PASS-ERROR | 1/1 | transport:AnthropicError:status-0 |
| Node | `@anthropic-ai/sdk` | 1.8.0 | anthropic | stream | token_limit | output | PASS | 1/1 | finish-max_tokens:tools-na |
| Node | `@anthropic-ai/sdk` | 1.8.0 | anthropic | stream | token_limit | input | PASS-ERROR | 1/1 | api:BadRequestError:status-400 |
| Node | `@anthropic-ai/sdk` | 1.8.0 | anthropic | stream | refusal | refusal | PASS | 1/1 | finish-refusal:tools-na |
| Node | `@anthropic-ai/sdk` | 1.8.0 | anthropic | stream | refusal | filter | PASS | 1/1 | finish-refusal:tools-na |
| Node | `@anthropic-ai/sdk` | 1.8.0 | anthropic | stream | bad_tool_json | default | PASS | 1/1 | finish-tool_use:tools-schema_invalid |
| Node | `@anthropic-ai/sdk` | 1.8.0 | anthropic | embeddings | cut_off_stream | default | N/A | 0/0 | library-has-no-embeddings |
| Node | `@anthropic-ai/sdk` | 1.8.0 | anthropic | embeddings | refusal | default | N/A | 0/0 | library-has-no-embeddings |
| Node | `@anthropic-ai/sdk` | 1.8.0 | anthropic | embeddings | bad_tool_json | default | N/A | 0/0 | library-has-no-embeddings |
| Node | `@anthropic-ai/sdk` | 1.8.0 | anthropic | text | unmatched | default | PASS-ERROR | 1/1 | api:BadRequestError:status-400 |
| Node | `@anthropic-ai/sdk` | 1.8.0 | anthropic | stream | unmatched | default | PASS-ERROR | 1/1 | api:BadRequestError:status-400 |
| Node | `@google/genai` | 3.3.0 | gemini | text | normal | default | PASS | 1/1 | finish-STOP:tools-na |
| Node | `@google/genai` | 3.3.0 | gemini | stream | normal | default | PASS | 1/1 | finish-STOP:tools-na |
| Node | `@google/genai` | 3.3.0 | gemini | tool | normal | default | PASS | 2/2 | finish-STOP:tools-valid |
| Node | `@google/genai` | 3.3.0 | gemini | embeddings | normal | default | PASS | 1/1 | finish-none:tools-na |
| Node | `@google/genai` | 3.3.0 | gemini | text | rate_limit | default | PASS-ERROR | 1/1 | api:ApiError:status-429 |
| Node | `@google/genai` | 3.3.0 | gemini | text | cut_off_stream | default | FIXED | 1/1 | fix-http-cutoff:PASS-ERROR;transport:TypeError:status-0 |
| Node | `@google/genai` | 3.3.0 | gemini | text | token_limit | output | PASS | 1/1 | finish-MAX_TOKENS:tools-na |
| Node | `@google/genai` | 3.3.0 | gemini | text | token_limit | input | PASS-ERROR | 1/1 | api:ApiError:status-400 |
| Node | `@google/genai` | 3.3.0 | gemini | text | refusal | refusal | PASS | 1/1 | finish-SAFETY:tools-na |
| Node | `@google/genai` | 3.3.0 | gemini | text | refusal | filter | PASS | 1/1 | finish-SAFETY:tools-na |
| Node | `@google/genai` | 3.3.0 | gemini | text | bad_tool_json | default | PASS | 1/1 | finish-STOP:tools-schema_invalid |
| Node | `@google/genai` | 3.3.0 | gemini | stream | rate_limit | default | PASS-ERROR | 1/1 | api:ApiError:status-429 |
| Node | `@google/genai` | 3.3.0 | gemini | stream | cut_off_stream | default | PASS-ERROR | 1/1 | transport:TypeError:status-0 |
| Node | `@google/genai` | 3.3.0 | gemini | stream | token_limit | output | PASS | 1/1 | finish-MAX_TOKENS:tools-na |
| Node | `@google/genai` | 3.3.0 | gemini | stream | token_limit | input | PASS-ERROR | 1/1 | api:ApiError:status-400 |
| Node | `@google/genai` | 3.3.0 | gemini | stream | refusal | refusal | PASS | 1/1 | finish-SAFETY:tools-na |
| Node | `@google/genai` | 3.3.0 | gemini | stream | refusal | filter | PASS | 1/1 | finish-SAFETY:tools-na |
| Node | `@google/genai` | 3.3.0 | gemini | stream | bad_tool_json | default | PASS | 1/1 | finish-STOP:tools-schema_invalid |
| Node | `@google/genai` | 3.3.0 | gemini | embeddings | cut_off_stream | default | PASS-ERROR | 1/1 | api:ApiError:status-400 |
| Node | `@google/genai` | 3.3.0 | gemini | embeddings | refusal | default | PASS-ERROR | 1/1 | api:ApiError:status-400 |
| Node | `@google/genai` | 3.3.0 | gemini | embeddings | bad_tool_json | default | PASS-ERROR | 1/1 | api:ApiError:status-400 |
| Node | `@google/genai` | 3.3.0 | gemini | text | unmatched | default | PASS-ERROR | 1/1 | api:ApiError:status-400 |
| Node | `@google/genai` | 3.3.0 | gemini | stream | unmatched | default | PASS-ERROR | 1/1 | api:ApiError:status-400 |
| Node | `@google/genai` | 3.3.0 | vertex | text | normal | default | PASS | 1/1 | finish-STOP:tools-na |
| Node | `@google/genai` | 3.3.0 | vertex | stream | normal | default | PASS | 1/1 | finish-STOP:tools-na |
| Node | `@google/generative-ai` | 0.24.1 | gemini | text | normal | default | PASS | 1/1 | finish-STOP:tools-na |
| Node | `@google/generative-ai` | 0.24.1 | gemini | stream | normal | default | PASS | 1/1 | finish-STOP:tools-na |
| Node | `@google/generative-ai` | 0.24.1 | gemini | tool | normal | default | PASS | 2/2 | finish-STOP:tools-valid |
| Node | `@google/generative-ai` | 0.24.1 | gemini | embeddings | normal | default | PASS | 1/1 | finish-none:tools-na |
| Node | `@google/generative-ai` | 0.24.1 | gemini | text | rate_limit | default | PASS-ERROR | 1/1 | api:GoogleGenerativeAIFetchError:status-429 |
| Node | `@google/generative-ai` | 0.24.1 | gemini | text | cut_off_stream | default | FIXED | 1/1 | fix-http-cutoff:PASS-ERROR;transport:TypeError:status-0 |
| Node | `@google/generative-ai` | 0.24.1 | gemini | text | token_limit | output | PASS | 1/1 | finish-MAX_TOKENS:tools-na |
| Node | `@google/generative-ai` | 0.24.1 | gemini | text | token_limit | input | PASS-ERROR | 1/1 | api:GoogleGenerativeAIFetchError:status-400 |
| Node | `@google/generative-ai` | 0.24.1 | gemini | text | refusal | refusal | PASS | 1/1 | finish-SAFETY:tools-na |
| Node | `@google/generative-ai` | 0.24.1 | gemini | text | refusal | filter | PASS | 1/1 | finish-SAFETY:tools-na |
| Node | `@google/generative-ai` | 0.24.1 | gemini | text | bad_tool_json | default | PASS | 1/1 | finish-STOP:tools-schema_invalid |
| Node | `@google/generative-ai` | 0.24.1 | gemini | stream | rate_limit | default | PASS-ERROR | 1/1 | api:GoogleGenerativeAIFetchError:status-429 |
| Node | `@google/generative-ai` | 0.24.1 | gemini | stream | cut_off_stream | default | PASS-ERROR | 1/1 | transport:GoogleGenerativeAIError:status-0 |
| Node | `@google/generative-ai` | 0.24.1 | gemini | stream | token_limit | output | PASS | 1/1 | finish-MAX_TOKENS:tools-na |
| Node | `@google/generative-ai` | 0.24.1 | gemini | stream | token_limit | input | PASS-ERROR | 1/1 | api:GoogleGenerativeAIFetchError:status-400 |
| Node | `@google/generative-ai` | 0.24.1 | gemini | stream | refusal | refusal | PASS | 1/1 | finish-SAFETY:tools-na |
| Node | `@google/generative-ai` | 0.24.1 | gemini | stream | refusal | filter | PASS | 1/1 | finish-SAFETY:tools-na |
| Node | `@google/generative-ai` | 0.24.1 | gemini | stream | bad_tool_json | default | PASS | 1/1 | finish-STOP:tools-schema_invalid |
| Node | `@google/generative-ai` | 0.24.1 | gemini | embeddings | cut_off_stream | default | PASS-ERROR | 1/1 | api:GoogleGenerativeAIFetchError:status-400 |
| Node | `@google/generative-ai` | 0.24.1 | gemini | embeddings | refusal | default | PASS-ERROR | 1/1 | api:GoogleGenerativeAIFetchError:status-400 |
| Node | `@google/generative-ai` | 0.24.1 | gemini | embeddings | bad_tool_json | default | PASS-ERROR | 1/1 | api:GoogleGenerativeAIFetchError:status-400 |
| Node | `@google/generative-ai` | 0.24.1 | gemini | text | unmatched | default | PASS-ERROR | 1/1 | api:GoogleGenerativeAIFetchError:status-400 |
| Node | `@google/generative-ai` | 0.24.1 | gemini | stream | unmatched | default | PASS-ERROR | 1/1 | api:GoogleGenerativeAIFetchError:status-400 |
| Node | `cohere-ai` | 8.3.1 | cohere | text | normal | default | PASS | 1/1 | finish-COMPLETE:tools-na |
| Node | `cohere-ai` | 8.3.1 | cohere | stream | normal | default | PASS | 1/1 | finish-COMPLETE:tools-na |
| Node | `cohere-ai` | 8.3.1 | cohere | tool | normal | default | PASS | 2/2 | finish-TOOL_CALL:tools-valid |
| Node | `cohere-ai` | 8.3.1 | cohere | embeddings | normal | default | PASS | 1/1 | finish-none:tools-na |
| Node | `cohere-ai` | 8.3.1 | cohere | text | rate_limit | default | PASS-ERROR | 3/3 | api:TooManyRequestsError:status-429 |
| Node | `cohere-ai` | 8.3.1 | cohere | text | cut_off_stream | default | FIXED | 1/1 | fix-http-cutoff:PASS-ERROR;transport:CohereError:status-0 |
| Node | `cohere-ai` | 8.3.1 | cohere | text | token_limit | output | PASS | 1/1 | finish-MAX_TOKENS:tools-na |
| Node | `cohere-ai` | 8.3.1 | cohere | text | token_limit | input | PASS-ERROR | 1/1 | api:BadRequestError:status-400 |
| Node | `cohere-ai` | 8.3.1 | cohere | text | refusal | refusal | PASS | 1/1 | finish-COMPLETE:tools-na |
| Node | `cohere-ai` | 8.3.1 | cohere | text | refusal | filter | PASS | 1/1 | finish-COMPLETE:tools-na |
| Node | `cohere-ai` | 8.3.1 | cohere | text | bad_tool_json | default | PASS | 1/1 | finish-TOOL_CALL:tools-invalid |
| Node | `cohere-ai` | 8.3.1 | cohere | stream | rate_limit | default | PASS-ERROR | 3/3 | api:TooManyRequestsError:status-429 |
| Node | `cohere-ai` | 8.3.1 | cohere | stream | cut_off_stream | default | PASS-ERROR | 1/1 | transport:TypeError:status-0 |
| Node | `cohere-ai` | 8.3.1 | cohere | stream | token_limit | output | PASS | 1/1 | finish-MAX_TOKENS:tools-na |
| Node | `cohere-ai` | 8.3.1 | cohere | stream | token_limit | input | PASS-ERROR | 1/1 | api:BadRequestError:status-400 |
| Node | `cohere-ai` | 8.3.1 | cohere | stream | refusal | refusal | PASS | 1/1 | finish-COMPLETE:tools-na |
| Node | `cohere-ai` | 8.3.1 | cohere | stream | refusal | filter | PASS | 1/1 | finish-COMPLETE:tools-na |
| Node | `cohere-ai` | 8.3.1 | cohere | stream | bad_tool_json | default | PASS | 1/1 | finish-TOOL_CALL:tools-invalid |
| Node | `cohere-ai` | 8.3.1 | cohere | embeddings | cut_off_stream | default | PASS-ERROR | 1/1 | api:BadRequestError:status-400 |
| Node | `cohere-ai` | 8.3.1 | cohere | embeddings | refusal | default | PASS-ERROR | 1/1 | api:BadRequestError:status-400 |
| Node | `cohere-ai` | 8.3.1 | cohere | embeddings | bad_tool_json | default | PASS-ERROR | 1/1 | api:BadRequestError:status-400 |
| Node | `cohere-ai` | 8.3.1 | cohere | text | unmatched | default | PASS-ERROR | 1/1 | api:BadRequestError:status-400 |
| Node | `cohere-ai` | 8.3.1 | cohere | stream | unmatched | default | PASS-ERROR | 1/1 | api:BadRequestError:status-400 |
| Node | `ai-openai` | 7.0.172 | openai | text | normal | default | PASS | 1/1 | finish-stop:tools-na |
| Node | `ai-openai` | 7.0.172 | openai | stream | normal | default | PASS | 1/1 | finish-stop:tools-na |
| Node | `ai-openai` | 7.0.172 | openai | tool | normal | default | PASS | 2/2 | finish-tool-calls:tools-valid |
| Node | `ai-openai` | 7.0.172 | openai | embeddings | normal | default | PASS | 1/1 | finish-none:tools-na |
| Node | `ai-openai` | 7.0.172 | openai | text | rate_limit | default | PASS-ERROR | 3/3 | api:RetryError:status-429 |
| Node | `ai-openai` | 7.0.172 | openai | text | cut_off_stream | default | FIXED | 3/3 | fix-http-cutoff:PASS-ERROR;transport:RetryError:status-200 |
| Node | `ai-openai` | 7.0.172 | openai | text | token_limit | output | PASS | 1/1 | finish-length:tools-na |
| Node | `ai-openai` | 7.0.172 | openai | text | token_limit | input | PASS-ERROR | 1/1 | api:APICallError:status-400 |
| Node | `ai-openai` | 7.0.172 | openai | text | refusal | refusal | PASS | 1/1 | finish-content-filter:tools-na |
| Node | `ai-openai` | 7.0.172 | openai | text | refusal | filter | PASS | 1/1 | finish-content-filter:tools-na |
| Node | `ai-openai` | 7.0.172 | openai | text | bad_tool_json | default | PASS | 1/1 | finish-tool-calls:tools-invalid |
| Node | `ai-openai` | 7.0.172 | openai | stream | rate_limit | default | PASS-ERROR | 3/3 | api:RetryError:status-429 |
| Node | `ai-openai` | 7.0.172 | openai | stream | cut_off_stream | default | PASS-ERROR | 1/1 | transport:APICallError:status-200 |
| Node | `ai-openai` | 7.0.172 | openai | stream | token_limit | output | PASS | 1/1 | finish-length:tools-na |
| Node | `ai-openai` | 7.0.172 | openai | stream | token_limit | input | PASS-ERROR | 1/1 | api:APICallError:status-400 |
| Node | `ai-openai` | 7.0.172 | openai | stream | refusal | refusal | PASS | 1/1 | finish-content-filter:tools-na |
| Node | `ai-openai` | 7.0.172 | openai | stream | refusal | filter | PASS | 1/1 | finish-content-filter:tools-na |
| Node | `ai-openai` | 7.0.172 | openai | stream | bad_tool_json | default | PASS | 1/1 | finish-tool-calls:tools-invalid |
| Node | `ai-openai` | 7.0.172 | openai | embeddings | cut_off_stream | default | PASS-ERROR | 1/1 | api:APICallError:status-400 |
| Node | `ai-openai` | 7.0.172 | openai | embeddings | refusal | default | PASS-ERROR | 1/1 | api:APICallError:status-400 |
| Node | `ai-openai` | 7.0.172 | openai | embeddings | bad_tool_json | default | PASS-ERROR | 1/1 | api:APICallError:status-400 |
| Node | `ai-openai` | 7.0.172 | openai | text | unmatched | default | PASS-ERROR | 1/1 | api:APICallError:status-400 |
| Node | `ai-openai` | 7.0.172 | openai | stream | unmatched | default | PASS-ERROR | 1/1 | api:APICallError:status-400 |
| Node | `ai-google` | 7.0.172 | gemini | text | normal | default | PASS | 1/1 | finish-stop:tools-na |
| Node | `ai-google` | 7.0.172 | gemini | stream | normal | default | PASS | 1/1 | finish-stop:tools-na |
| Node | `ai-google` | 7.0.172 | gemini | tool | normal | default | PASS | 2/2 | finish-tool-calls:tools-valid |
| Node | `ai-google` | 7.0.172 | gemini | embeddings | normal | default | PASS | 1/1 | finish-none:tools-na |
| Node | `ai-google` | 7.0.172 | gemini | text | rate_limit | default | PASS-ERROR | 3/3 | api:RetryError:status-429 |
| Node | `ai-google` | 7.0.172 | gemini | text | cut_off_stream | default | FIXED | 3/3 | fix-http-cutoff:PASS-ERROR;transport:RetryError:status-200 |
| Node | `ai-google` | 7.0.172 | gemini | text | token_limit | output | PASS | 1/1 | finish-length:tools-na |
| Node | `ai-google` | 7.0.172 | gemini | text | token_limit | input | PASS-ERROR | 1/1 | api:APICallError:status-400 |
| Node | `ai-google` | 7.0.172 | gemini | text | refusal | refusal | PASS | 1/1 | finish-content-filter:tools-na |
| Node | `ai-google` | 7.0.172 | gemini | text | refusal | filter | PASS | 1/1 | finish-content-filter:tools-na |
| Node | `ai-google` | 7.0.172 | gemini | text | bad_tool_json | default | PASS | 1/1 | finish-tool-calls:tools-schema_invalid |
| Node | `ai-google` | 7.0.172 | gemini | stream | rate_limit | default | PASS-ERROR | 3/3 | api:RetryError:status-429 |
| Node | `ai-google` | 7.0.172 | gemini | stream | cut_off_stream | default | PASS-ERROR | 1/1 | transport:APICallError:status-200 |
| Node | `ai-google` | 7.0.172 | gemini | stream | token_limit | output | PASS | 1/1 | finish-length:tools-na |
| Node | `ai-google` | 7.0.172 | gemini | stream | token_limit | input | PASS-ERROR | 1/1 | api:APICallError:status-400 |
| Node | `ai-google` | 7.0.172 | gemini | stream | refusal | refusal | PASS | 1/1 | finish-content-filter:tools-na |
| Node | `ai-google` | 7.0.172 | gemini | stream | refusal | filter | PASS | 1/1 | finish-content-filter:tools-na |
| Node | `ai-google` | 7.0.172 | gemini | stream | bad_tool_json | default | PASS | 1/1 | finish-tool-calls:tools-schema_invalid |
| Node | `ai-google` | 7.0.172 | gemini | embeddings | cut_off_stream | default | PASS-ERROR | 1/1 | api:APICallError:status-400 |
| Node | `ai-google` | 7.0.172 | gemini | embeddings | refusal | default | PASS-ERROR | 1/1 | api:APICallError:status-400 |
| Node | `ai-google` | 7.0.172 | gemini | embeddings | bad_tool_json | default | PASS-ERROR | 1/1 | api:APICallError:status-400 |
| Node | `ai-google` | 7.0.172 | gemini | text | unmatched | default | PASS-ERROR | 1/1 | api:APICallError:status-400 |
| Node | `ai-google` | 7.0.172 | gemini | stream | unmatched | default | PASS-ERROR | 1/1 | api:APICallError:status-400 |
| Python | `google-generativeai` | 0.8.6 | gemini | all | default-grpc | unsupported | UNVERIFIED | 0/0 | needs-TLS-and-HTTP2;REST-only-measured |

## F0a row notes settled by these runs

- **OpenAI:** the pinned Python/Node clients parse the helper's `/v1` chat and embedding replies, use the explicit base-URL option, consume SSE/final-completion helpers, and raise normal 400/429 API errors. This does not independently verify the real host or environment-variable-only redirection. Responses API was outside this lane.
- **Anthropic:** the helper now has real Python/Node client proof for messages, named SSE, final-message helpers, tools and failure envelopes. The F0a “family not served yet” note is stale for this helper base. These calls use explicit base-URL options.
- **Cohere:** ClientV2 Python/Node parse v2 chat SSE and embeddings using explicit `base_url`/`environment`. This settles the v2 response-shape gap; it does not verify CO_API_URL, the real hosts, or older JSON-lines clients.
- **Gemini:** both modern clients and legacy REST clients parse text, streams, tools and embedding replies. Python legacy requests enum-as-int REST responses and successfully parses the helper's integer finish codes, settling that Gemini enum note for this pinned client. Default gRPC stays UNVERIFIED; Live API and Interactions were not exercised.
- **Vertex:** modern Google GenAI Python/Node and LangChain Google complete text and streaming with metadata-only ADC and no real key file. This settles the ChatGoogleGenerativeAI(vertexai=True) note for the pinned version. Vertex location/mtls lists, legacy Vertex enum-as-int, and Vertex OpenAI OAuth snippets remain outside the measured scope.
- **Other rows:** no claim is made for Gemini's separate OpenAI row, hosted gateways, untested providers, or real-provider behavior. No F0a catalog verification flag was changed.
