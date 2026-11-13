// Optional real-SDK run: no package manager, no network except the loopback helper.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, readdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { builtinModelCatalog, type ServedModelFamily, type FailureSpec } from "../../packages/contracts/src/index.js";
import { startModelHelperLoop } from "../../packages/worker/src/model-helper-http.js";
import { createModelLedgerWriter, summarizeModelLedgerFile } from "../../packages/worker/src/model-helper-ledger.js";
import { MODEL_DUMMY_KEY, laptopModelEnvironment, modelRowBaseUrl } from "../../packages/worker/src/model-helper-env.js";
import { stampSet } from "./model-helper-world.js";
import { installModelNetworkTripwire } from "./model-network-tripwire.js";
import { assertNoEscapes, assertScenarioCounts, expectedSdkAttempts, classifySdkResult, cleanSdkEnvironment, sdkNodeArguments, parseSdkResult, retryFinding, type SdkResult } from "./model-sdk-compat-policy.js";
interface Client {
    language: "Python" | "Node";
    library: string;
    file: string;
    row: string;
    retries: number;
    embeddings: boolean;
}
export const SDK_CLIENTS: readonly Client[] = [
    { language: "Python", library: "openai", file: "openai.py", row: "openai", retries: 2, embeddings: true },
    { language: "Python", library: "anthropic", file: "anthropic.py", row: "anthropic", retries: 2, embeddings: false },
    { language: "Python", library: "google-genai", file: "google-genai.py", row: "gemini", retries: 0, embeddings: true },
    { language: "Python", library: "google-generativeai", file: "google-generativeai.py", row: "gemini", retries: 0, embeddings: true },
    { language: "Python", library: "cohere", file: "cohere.py", row: "cohere", retries: 2, embeddings: true },
    { language: "Python", library: "langchain-openai", file: "langchain-openai.py", row: "openai", retries: 2, embeddings: true },
    { language: "Python", library: "langchain-google-genai", file: "langchain-google-genai.py", row: "gemini", retries: 5, embeddings: true },
    { language: "Node", library: "openai", file: "openai.mjs", row: "openai", retries: 2, embeddings: true },
    { language: "Node", library: "@anthropic-ai/sdk", file: "anthropic.mjs", row: "anthropic", retries: 2, embeddings: false },
    { language: "Node", library: "@google/genai", file: "google-genai.mjs", row: "gemini", retries: 0, embeddings: true },
    { language: "Node", library: "@google/generative-ai", file: "google-generative-ai.mjs", row: "gemini", retries: 0, embeddings: true },
    { language: "Node", library: "cohere-ai", file: "cohere.mjs", row: "cohere", retries: 2, embeddings: true },
    { language: "Node", library: "ai-openai", file: "ai-openai.mjs", row: "openai", retries: 2, embeddings: true },
    { language: "Node", library: "ai-google", file: "ai-google.mjs", row: "gemini", retries: 2, embeddings: true },
];
interface Scenario {
    operation: "text" | "stream" | "tool" | "embeddings";
    mode?: FailureSpec["mode"];
    variant?: FailureSpec["variant"];
    afterCalls?: number;
    row?: string;
    unmatched?: boolean;
}
const scenarios = (): Scenario[] => [
    ...(["text", "stream", "tool", "embeddings"] as const).map(operation => ({ operation })),
    ...(["text", "stream"] as const).flatMap(operation => [
        { operation, mode: "rate_limit" as const }, { operation, mode: "cut_off_stream" as const },
        { operation, mode: "token_limit" as const, variant: "output" as const }, { operation, mode: "token_limit" as const, variant: "input" as const },
        { operation, mode: "refusal" as const, variant: "refusal" as const }, { operation, mode: "refusal" as const, variant: "filter" as const },
        { operation, mode: "bad_tool_json" as const },
    ]),
    ...(["cut_off_stream", "refusal", "bad_tool_json"] as const).map(mode => ({ operation: "embeddings" as const, mode })),
];
export interface MatrixCell {
    language: string;
    library: string;
    version: string;
    row: string;
    scenario: string;
    mode: string;
    variant: string;
    result: string;
    observed: number;
    expected: number;
    note: string;
    facts?: SdkResult;
}
export async function runSdkChild(command: string, args: string[], env: Record<string, string>, cwd: string, timeout: number): Promise<{
    stdout: string;
    code: number;
    timedOut: boolean;
}> {
    return new Promise((done, reject) => {
        const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "ignore"] });
        let stdout = "", timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeout);
        child.stdout.on("data", (data: Buffer) => {
            stdout += data.toString("utf8");
            if (stdout.length > 4096)
                child.kill("SIGKILL");
        });
        child.once("error", error => { clearTimeout(timer); reject(error); });
        child.once("close", code => { clearTimeout(timer); done({ stdout, code: code ?? -1, timedOut }); });
    });
}
export async function runSdkCompatibility(scratchInput: string, only?: string, supplementalOnly = false): Promise<MatrixCell[]> {
    const scratch = realpathSync(scratchInput);
    if (!scratch.startsWith("/private/tmp/sdk-compat-") || scratch.includes("/node_modules/"))
        throw new Error("SDK install must be a throwaway /private/tmp directory");
    const runRoot = mkdtempSync(join(scratch, "run-"));
    const fixture = resolve("tests/fixtures/model-sdk-compat");
    const nodeDir = join(scratch, "node"), pyDir = join(scratch, "python");
    mkdirSync(pyDir, { recursive: true });
    mkdirSync(join(runRoot, "results"), { recursive: true });
    mkdirSync(join(runRoot, "tripwire"), { recursive: true });
    for (const file of readdirSync(fixture))
        if (file.endsWith(".mjs.fixture") || file === "pins.json")
            copyFileSync(join(fixture, file), join(nodeDir, file.replace(/\.fixture$/u, "")));
        else if (file.endsWith(".py"))
            copyFileSync(join(fixture, file), join(pyDir, file));
    const pins = JSON.parse(readFileSync(join(fixture, "pins.json"), "utf8")) as {
        python: Record<string, string>;
        node: Record<string, string>;
    };
    const rows = builtinModelCatalog().rows;
    const cells: MatrixCell[] = [];
    const tripwire = installModelNetworkTripwire({ resolver: new Set(), ports: { 443: 1, 80: 1 } });
    let count = 0;
    try {
        for (const client of SDK_CLIENTS) {
            if (only && !`${client.language}:${client.library}`.includes(only))
                continue;
            const jobs: Scenario[] = supplementalOnly ? [] : scenarios();
            jobs.push({ operation: "text", unmatched: true }, { operation: "stream", unmatched: true });
            if (client.language === "Python" && client.library === "google-genai")
                jobs.push({ operation: "text", mode: "rate_limit", afterCalls: 1, row: "vertex" });
            if (!supplementalOnly && (client.library === "google-genai" || client.library === "@google/genai" || client.library === "langchain-google-genai"))
                jobs.push({ operation: "text", row: "vertex" }, { operation: "stream", row: "vertex" });
            if (!supplementalOnly && ["openai", "anthropic", "google-genai", "cohere"].includes(client.library) && client.language === "Python")
                jobs.push({ operation: "text", mode: "rate_limit", afterCalls: 1 });
            for (const scenario of jobs) {
                count += 1;
                const version = (client.language === "Python" ? pins.python[client.library] : pins.node[client.library.startsWith("ai-") ? "ai" : client.library]) ?? "0.0.0";
                const cell: MatrixCell = { language: client.language, library: client.library, version, row: scenario.row ?? client.row, scenario: scenario.operation, mode: scenario.unmatched ? "unmatched" : scenario.mode ?? "normal", variant: scenario.afterCalls === 1 ? "afterCalls-1" : scenario.variant ?? "default", result: "FAIL", observed: 0, expected: expectedSdkAttempts(client.language, client.library, client.retries, scenario.operation, scenario.mode ?? "", scenario.afterCalls ?? 0), note: "pending" };
                if (!client.embeddings && scenario.operation === "embeddings") {
                    cells.push({ ...cell, result: "N/A", expected: 0, note: "library-has-no-embeddings" });
                    continue;
                }
                const dir = join(runRoot, "results", String(count));
                mkdirSync(dir);
                mkdirSync(join(dir, "home"));
                mkdirSync(join(dir, "config"));
                const log = join(runRoot, "tripwire", `${String(count)}.jsonl`);
                writeFileSync(log, "");
                const row = rows.find(r => r.id === cell.row);
                if (!row)
                    throw new Error("missing catalog row");
                const family = row.family as ServedModelFamily;
                const set = stampSet(family, scenario.unmatched ? [] : [{ id: "tool", match: { promptContains: "compat-tool", sequence: 1 }, response: { text: "", finish: "tool_calls", toolCalls: [{ name: "weather", args: { city: "Paris" } }], usage: { inputTokens: 12, outputTokens: 8 } } }, { id: "text", response: { text: "A scripted compatibility answer.", finish: "stop", usage: { inputTokens: 12, outputTokens: 8 } } }]);
                const ledgerPath = join(dir, "ledger.jsonl");
                const ledger = createModelLedgerWriter(ledgerPath, { header: 1, mode: "scripted", blockState: "not_blocked_here", digest: "0".repeat(64), startedAt: 1 });
                const loop = await startModelHelperLoop({ listen: "127.0.0.1", port: 0, metaPort: 0, caller: "127.0.0.1", mode: "scripted", rows, replySets: new Map([[family, set]]), ledger, projectId: "rovara-test-project" });
                try {
                    const base = `http://127.0.0.1:${String(loop.port)}`;
                    const mapped = laptopModelEnvironment({ rows, rowIds: [row.id], baseUrl: base, metadataHostPort: `127.0.0.1:${String(loop.metaPort)}`, projectId: "rovara-test-project", location: "us-central1", adc: { cloudsdkConfigDir: join(dir, "config") }, inherited: {} });
                    if (!mapped.ok)
                        throw new Error("catalog redirect unavailable");
                    const environment = { ...cleanSdkEnvironment(join(dir, "home"), join(dir, "config")), ...mapped.environment };
                    for (const name of mapped.unset)
                        delete environment[name];
                    const scenarioBase = modelRowBaseUrl(row, base, scenario.mode === undefined ? undefined : { mode: scenario.mode, variant: scenario.variant, afterCalls: scenario.afterCalls });
                    for (const name of Object.keys(environment))
                        if (environment[name]?.startsWith(`${base}/p/`))
                            environment[name] = scenarioBase;
                    // Metadata-only Vertex must not select express/API-key authentication.
                    if (row.id === "vertex")
                        for (const name of Object.keys(environment))
                            if (/KEY|TOKEN/u.test(name))
                                delete environment[name];
                    Object.assign(environment, { LIBRARY: client.library, SCENARIO: scenario.operation, ROW: row.id, MODE: scenario.mode ?? "", MODEL_DUMMY_KEY, SDK_PRIVATE_ROOT: process.env.HOME ?? "/unavailable-home", SDK_TRIPWIRE_LOG: log, BASE_URL: modelRowBaseUrl(row, base, scenario.mode === undefined ? undefined : { mode: scenario.mode, variant: scenario.variant, afterCalls: scenario.afterCalls }) });
                    const command = client.language === "Python" ? join(scratch, "venv/bin/python") : process.execPath;
                    const args = client.language === "Python" ? ["-I", join(pyDir, client.file)] : sdkNodeArguments({ directory: nodeDir, log, home: join(dir, "home"), config: join(dir, "config"), file: client.file });
                    if (scenario.afterCalls === 1) {
                        const first = await runSdkChild(command, args, environment, scratch, 30000);
                        assertNoEscapes(log);
                        const firstResult = parseSdkResult(first.stdout);
                        if (classifySdkResult(firstResult, "", "") !== "PASS")
                            throw new Error("afterCalls first call did not succeed");
                    }
                    const child = await runSdkChild(command, args, environment, scratch, scenario.mode === "rate_limit" ? 90000 : 30000);
                    assertNoEscapes(log);
                    const summary = summarizeModelLedgerFile(ledgerPath);
                    assertScenarioCounts(summary, scenario.unmatched ? "unmatched" : scenario.mode ?? "", scenario.afterCalls ?? 0);
                    cell.observed = summary.scripted.before_task + summary.scripted.independent + summary.scripted.task_made + summary.failurePack + summary.unmatched + summary.notServed;
                    if (child.timedOut)
                        cell.note = "scenario-timeout";
                    else if (child.code !== 0)
                        cell.note = "child-exit";
                    else {
                        const facts = parseSdkResult(child.stdout);
                        if (facts.library !== client.library || facts.version !== version || facts.scenario !== scenario.operation)
                            throw new Error("SDK result identity mismatch");
                        cell.facts = facts;
                        cell.result = classifySdkResult(facts, scenario.unmatched ? "unmatched" : scenario.mode ?? "", scenario.variant ?? "");
                        cell.note = facts.outcome === "error" ? `${facts.raisedIn}:${facts.errorClass}:status-${String(facts.status)}` : `finish-${facts.finish}:tools-${facts.toolArgsParse}`;
                        if (retryFinding(cell.observed, cell.expected))
                            cell.note += ";attempt-mismatch";
                    }
                }
                finally {
                    await loop.close();
                }
                cells.push(cell);
                writeFileSync(join(scratch, "results.json"), JSON.stringify(cells, null, 2) + "\n");
                process.stdout.write(`${cell.language} ${cell.library} ${cell.row} ${cell.scenario} ${cell.mode}.${cell.variant} ${cell.result} ${String(cell.observed)}/${String(cell.expected)} ${cell.note}\n`);
            }
        }
    }
    finally {
        tripwire.restore();
    }
    if (tripwire.refused.length > 0)
        throw new Error("supervisor non-loopback attempt");
    return cells;
}
export function renderSdkMatrix(cells: readonly MatrixCell[], helper: string, python: string, node: string): string {
    if (!/^[a-f0-9]{40}$/u.test(helper) || ![python, node].every(version => /^\d+\.\d+\.\d+$/u.test(version)))
        throw new Error("invalid matrix provenance");
    for (const cell of cells) {
        if (!["Python", "Node"].includes(cell.language) || !SDK_CLIENTS.some(client => client.library === cell.library) || !/^\d+\.\d+\.\d+(?:[a-zA-Z0-9.+-]*)$/u.test(cell.version))
            throw new Error("invalid matrix identity");
        if (!["PASS", "PASS-ERROR", "FIXED", "FAIL", "UNVERIFIED", "N/A"].includes(cell.result) || ![cell.row, cell.scenario, cell.mode, cell.variant, cell.note].every(value => /^[A-Za-z][A-Za-z0-9._:;-]{0,199}$/u.test(value)))
            throw new Error("invalid matrix token");
        if (![cell.observed, cell.expected].every(value => Number.isSafeInteger(value) && value >= 0))
            throw new Error("invalid matrix count");
    }
    const notes = "\n## Scope and safety\n\nThese are real SDK calls to the scripted loopback helper on macOS, including full stream consumption, exposed final-response helpers, tool results followed by a second turn, and embeddings. The result labels describe parsing of fake replies, not real-provider compatibility. Normal streams expose finish and usage; dropped streams expose partial text before a transport error (or an unfinished stream). `PASS-ERROR` includes documented SDK API/transport errors and the explicitly identified customer-facing finish/tool exceptions. Parser failures are never accepted.\n\nEvery SDK dependency was installed into a disposable directory outside all repositories: 73 Python wheels with exact versions and SHA-256 hashes via `pip --require-hashes --only-binary=:all:`, and 94 npm lock entries with exact versions/integrity via `npm ci --ignore-scripts --no-audit --no-fund`. No SDK install used Rovara's dependencies. The Python wheel hashes target this macOS/Python runtime; Linux live SDKs were not run. AI SDK adapters use `ai` 7.0.172 with `@ai-sdk/openai` 4.0.117 and `@ai-sdk/google` 4.0.120.\n\nEach child starts with an empty inherited environment, fresh scratch HOME/config directories, loopback redirects, and dummy credentials. Vertex project/location cases remove API-key variables and obtain their dummy credential from the helper's metadata service. Python isolated mode plus its audit hook denies private-home file access and subprocesses; Node's permission flags restrict filesystem reads and writes to the scratch client and evidence. Both preloads refuse network/DNS destinations outside loopback; any nonempty or unreadable refusal log fails the run, even when an SDK catches the error. Native canaries were refused before any SDK ran. Real scenario refusal logs: **0**. The helper's trusted ledger also must show zero refused callers and zero redirect escapes.\n\n## Fixes and retry findings\n\n`fix-http-cutoff` makes a shortened response an incomplete HTTP response: a missing final chunk for SSE and a deliberately unsatisfied Content-Length for non-SSE. The helper flushes the available bytes then closes the socket. Previously several clients attempted to parse a complete malformed document. Regression: `model-sdk-compat-cutoff.test.ts`; removing the incomplete framing, length discrepancy, or close makes it fail.\n\n`fix-openai-usage` adds the standard empty-choices usage chunk immediately before the terminal DONE marker. Normal OpenAI Python/Node and LangChain streams previously had no usage. Regression: `model-sdk-compat-stream-usage.test.ts` covers normal and failure-pack streams, and text containing a marker-like string. Removing usage or replacing the first marker-like string makes the test fail. Existing tool-stream extraction now tolerates the valid usage-only chunk; no stored golden file changed. `FIXED` rows preserve the final outcome in their note.\n\nExpected attempts were read from the pinned installed SDK source, not inferred solely from the measured counts. No SDK retry count is overridden. A 400 takes one attempt. Tool success takes two. The afterCalls-1 rows include the initial successful call.\n\n| SDK | Default 429 attempts | Installed source policy |\n|---|---:|---|\n| Python OpenAI, Anthropic, LangChain OpenAI | 3 | `openai/_constants.py`, `anthropic/_constants.py`; default two retries in `_base_client.py`; LangChain passes through that default. |\n| Node OpenAI, Anthropic | 3 | `src/client.ts` default maxRetries 2; retryable HTTP status handling. |\n| Python/Node Google GenAI | 1 | Python `google/genai/_api_client.py: retry_args(None)` stops after one; Node `dist/node/index.mjs` uses one fetch without retryOptions. |\n| Python/Node legacy Google | 1 | Generated REST method has no retry policy; Node fetch helper has no retry loop. |\n| Python Cohere | 3 unary, 1 stream | `cohere/core/http_client.py` defaults to two retries in request; its stream context manager has no retry loop. |\n| Node Cohere | 3 | `dist/core/fetcher/Fetcher.js` defaults to two retries. |\n| LangChain Google | 6 | `_common.py` max_retries 6 is passed by `chat_models.py` as `HttpRetryOptions(attempts=6)`, meaning six total attempts. |\n| AI SDK OpenAI/Google | 3 | `src/util/retry-with-exponential-backoff.ts` defaults maxRetries to 2. |\n\nTransport-drop finding: Python OpenAI/Anthropic/LangChain OpenAI retry non-stream read failures twice, and AI SDK OpenAI/Google retry their retryable APICallError twice. These text cutoffs therefore take three attempts; other cutoffs take one. Python Cohere's streaming 429 takes one despite its unary default of three. The matrix uses these operation-specific expectations; no unexplained attempt mismatch remains. Node legacy Google replaces a stream socket cause with its own fixed \u201cError reading from the stream\u201d error; the fixture recognizes only that exact SDK error internally and prints no message. Python OpenAI's final helper raises LengthFinishReasonError/ContentFilterFinishReasonError for the matching finish modes; these are documented customer exceptions, not malformed-byte parse failures.\n\n## Reproduction\n\nCreate a fresh `/private/tmp/sdk-compat-*` directory, venv, and `node` subdirectory outside every repository. Install the committed Python hash file with `--require-hashes --only-binary=:all:` and use the committed npm manifest/lock with `npm ci --ignore-scripts --no-audit --no-fund`; use a scratch HOME for installers. Copy `sitecustomize.py` into that venv's site-packages before running any SDK. The runner copies the client fixtures (stripping `.fixture` from Node filenames), never installs packages, and writes measured results only into scratch. Run the optional live test with `ROVARA_SDK_COMPAT_DIR` pointing at that scratch install through the lane's heavy wrapper. With no such variable, the live test is explicitly skipped as \u201cnot run: libraries not installed.\u201d\n\nThe offline policy, renderer, process limits, tripwire, cutoff and usage regressions need no downloaded SDKs. Linux proof used the same offline test bodies bundled with the repository's installed dependencies and a node:test adapter, in an already-local Node 22 image with networking disabled, a read-only root and a temporary filesystem. This is offline Linux proof, not a Linux live matrix or a CI run.\n\n## Measured cells\n";
    const footer = "\n## F0a row notes settled by these runs\n\n- **OpenAI:** the pinned Python/Node clients parse the helper's `/v1` chat and embedding replies, use the explicit base-URL option, consume SSE/final-completion helpers, and raise normal 400/429 API errors. This does not independently verify the real host or environment-variable-only redirection. Responses API was outside this lane.\n- **Anthropic:** the helper now has real Python/Node client proof for messages, named SSE, final-message helpers, tools and failure envelopes. The F0a \u201cfamily not served yet\u201d note is stale for this helper base. These calls use explicit base-URL options.\n- **Cohere:** ClientV2 Python/Node parse v2 chat SSE and embeddings using explicit `base_url`/`environment`. This settles the v2 response-shape gap; it does not verify CO_API_URL, the real hosts, or older JSON-lines clients.\n- **Gemini:** both modern clients and legacy REST clients parse text, streams, tools and embedding replies. Python legacy requests enum-as-int REST responses and successfully parses the helper's integer finish codes, settling that Gemini enum note for this pinned client. Default gRPC stays UNVERIFIED; Live API and Interactions were not exercised.\n- **Vertex:** modern Google GenAI Python/Node and LangChain Google complete text and streaming with metadata-only ADC and no real key file. This settles the ChatGoogleGenerativeAI(vertexai=True) note for the pinned version. Vertex location/mtls lists, legacy Vertex enum-as-int, and Vertex OpenAI OAuth snippets remain outside the measured scope.\n- **Other rows:** no claim is made for Gemini's separate OpenAI row, hosted gateways, untested providers, or real-provider behavior. No F0a catalog verification flag was changed.\n";
    const counts = new Map<string, number>(["PASS", "PASS-ERROR", "FIXED", "FAIL", "UNVERIFIED", "N/A"].map(result => [result, 0]));
    for (const cell of cells)
        counts.set(cell.result, (counts.get(cell.result) ?? 0) + 1);
    return `# Model fake SDK compatibility\n\nRun date: 2026-11-13. Helper base: ${helper} plus the fixes in this PR. Python ${python}; Node ${node}. Mac-only live run; scripted replies, not real-provider proof.\n\n${[...counts].sort().map(([key, count]) => `${key}: ${String(count)}`).join(", ")}\n\nExact direct versions are in each measured row and [pins.json](../tests/fixtures/model-sdk-compat/pins.json). All package versions and integrity hashes: [Python requirements](../tests/fixtures/model-sdk-compat/requirements.txt), [npm integrity lock](../tests/fixtures/model-sdk-compat/package-lock.json).\n${notes}\n| Runtime | Library | Version | Row | Scenario | Mode | Variant | Result | Attempts observed/expected | Note |\n|---|---|---|---|---|---|---|---|---|---|\n` + cells.map(c => `| ${c.language} | \`${c.library}\` | ${c.version} | ${c.row} | ${c.scenario} | ${c.mode} | ${c.variant} | ${c.result} | ${String(c.observed)}/${String(c.expected)} | ${c.note} |`).join("\n") + "\n" + footer;
}
