// Trusted supervisor policy. Child output is data; only bounded tokens reach the matrix.
import { readFileSync } from "node:fs";
import { z } from "zod";
export function cleanSdkEnvironment(home: string, config: string): Record<string, string> {
    return { HOME: home, CLOUDSDK_CONFIG: config, XDG_CONFIG_HOME: config, NO_PROXY: "127.0.0.1,localhost", LANGSMITH_TRACING: "false", LANGCHAIN_TRACING_V2: "false", HF_HUB_OFFLINE: "1", DO_NOT_TRACK: "1" };
}
const token = z.string().max(100).regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/u);
export const SdkResultSchema = z.object({
    library: z.enum(["openai", "anthropic", "google-genai", "google-generativeai", "cohere", "langchain-openai", "langchain-google-genai", "@anthropic-ai/sdk", "@google/genai", "@google/generative-ai", "cohere-ai", "ai-openai", "ai-google"]), version: z.string().regex(/^\d+\.\d+\.\d+(?:[a-zA-Z0-9.+-]*)$/u), scenario: z.enum(["text", "stream", "tool", "embeddings"]),
    outcome: z.enum(["parsed", "error", "unavailable"]), errorClass: token,
    raisedIn: z.enum(["none", "api", "parser", "customer", "transport", "setup"]), finish: token,
    toolArgsParse: z.enum(["na", "valid", "invalid", "schema_invalid"]), textSeen: z.boolean(), usageSeen: z.boolean(),
    secondTurn: z.boolean(), messageSeen: z.boolean(),
    vectorLength: z.number().int().min(0).max(4096), status: z.number().int().min(0).max(599),
}).strict();
export type SdkResult = z.infer<typeof SdkResultSchema>;
export function parseSdkResult(text: string): SdkResult {
    if (text.length > 4096 || text.trim().split("\n").length !== 1)
        throw new Error("invalid SDK result size or line count");
    try {
        return SdkResultSchema.parse(JSON.parse(text) as unknown);
    } catch {
        throw new Error("invalid SDK result");
    }
}
export function assertSdkCanary(path: string): void {
    if (readFileSync(path, "utf8") !== '"model-canary.rovara-canary.dev"\n')
        throw new Error("SDK canary missing or runtime escape recorded");
}
export interface SdkSandboxPaths { privateHome: string; runtime: string; scratch: string }
export function sdkSandboxInvocation(command: string, args: readonly string[], paths: SdkSandboxPaths): { command: string; args: string[] } {
    const profile = '(version 1)(allow default)(deny network*)(allow network-outbound (remote ip "localhost:*"))(allow network-bind (local ip "localhost:*"))(allow network-inbound (local ip "localhost:*"))(deny file-read* (subpath (param "PRIVATE_HOME")))(allow file-read* (subpath (param "RUNTIME")))(allow file-read* (subpath (param "SCRATCH")))';
    return { command: "/usr/bin/sandbox-exec", args: ["-D", `PRIVATE_HOME=${paths.privateHome}`, "-D", `RUNTIME=${paths.runtime}`, "-D", `SCRATCH=${paths.scratch}`, "-p", profile, command, ...args] };
}
export function assertNoEscapes(path: string): void {
    if (readFileSync(path, "utf8").length !== 0)
        throw new Error("SDK run failed: non-loopback attempt recorded");
}
export function retryFinding(observed: number, expected: number): boolean {
    return !Number.isSafeInteger(observed) || !Number.isSafeInteger(expected) || observed !== expected;
}
export function classifySdkResult(result: SdkResult, mode: string, variant: string): string {
    if (result.outcome === "unavailable")
        return "UNVERIFIED";
    if (result.outcome === "error") {
        const expectedStatus = mode === "rate_limit" ? 429 : (mode === "token_limit" && variant === "input" || mode === "unmatched") || result.scenario === "embeddings" && mode !== "" ? 400 : 0;
        if (expectedStatus > 0 && result.raisedIn === "api" && result.status === expectedStatus && result.messageSeen)
            return "PASS-ERROR";
        if (mode === "cut_off_stream" && (result.scenario !== "stream" || result.textSeen) && (result.raisedIn === "transport" || result.raisedIn === "api" && result.status === 0 && ["APIConnectionError", "OpenAIConnectionError"].includes(result.errorClass)))
            return "PASS-ERROR";
        if (result.raisedIn === "customer" && (mode === "token_limit" && variant === "output" && result.errorClass === "LengthFinishReasonError" || mode === "refusal" && variant === "filter" && result.errorClass === "ContentFilterFinishReasonError"))
            return "PASS-ERROR";
        if (mode === "refusal" && result.raisedIn === "customer" && result.errorClass === "BlockedPromptException")
            return "PASS-ERROR";
        if (mode === "bad_tool_json" && result.raisedIn === "customer" && result.errorClass === "InvalidToolInputError")
            return "PASS-ERROR";
        return "FAIL";
    }
    if (mode === "unmatched" || mode === "rate_limit" || mode === "token_limit" && variant === "input")
        return "FAIL";
    if (mode === "cut_off_stream")
        return result.scenario === "stream" && result.textSeen && result.finish === "none" ? "PASS" : "FAIL";
    if (mode === "bad_tool_json")
        return ["invalid", "schema_invalid"].includes(result.toolArgsParse) ? "PASS" : "FAIL";
    if (mode === "token_limit")
        return ["length", "max_tokens", "MAX_TOKENS"].includes(result.finish) ? "PASS" : "FAIL";
    if (mode === "refusal")
        return ["stop", "content_filter", "content-filter", "refusal", "SAFETY", "COMPLETE", "stop_sequence", "end_turn"].includes(result.finish) ? "PASS" : "FAIL";
    if (result.scenario === "embeddings")
        return result.vectorLength === (result.library === "cohere" || result.library === "cohere-ai" ? 1024 : 8) ? "PASS" : "FAIL";
    if (result.scenario === "tool")
        return result.toolArgsParse === "valid" && result.secondTurn ? "PASS" : "FAIL";
    return result.textSeen && result.usageSeen && ["stop", "end_turn", "STOP", "COMPLETE"].includes(result.finish) ? "PASS" : "FAIL";
}
export function assertScenarioCounts(counts: {
    trusted: boolean;
    refused: number;
    escapes: {
        count: number;
    };
    failurePack: number;
    unmatched: number;
    scripted: {
        before_task: number;
        independent: number;
        task_made: number;
    };
}, mode: string, afterCalls: number): void {
    if (!counts.trusted || counts.refused !== 0 || counts.escapes.count !== 0)
        throw new Error("helper safety evidence invalid");
    const scripted = counts.scripted.before_task + counts.scripted.independent + counts.scripted.task_made;
    if (mode !== "" && mode !== "unmatched" && (counts.failurePack < 1 || scripted !== afterCalls))
        throw new Error("failure path or afterCalls boundary not exercised");
    if (mode === "unmatched" && counts.unmatched < 1)
        throw new Error("unmatched path not exercised");
}
export function sdkNodeArguments(input: {
    directory: string;
    log: string;
    home: string;
    config: string;
    file: string;
}): string[] {
    return ["--permission", `--allow-fs-read=${input.directory}`, `--allow-fs-read=${input.log}`, `--allow-fs-read=${input.home}`, `--allow-fs-read=${input.config}`, `--allow-fs-write=${input.log}`, "--import", `${input.directory}/tripwire.mjs`, `${input.directory}/${input.file}`];
}
// Defaults read from the pinned installed sources; no SDK retry setting is overridden.
export function expectedSdkAttempts(language: string, library: string, retries: number, operation: string, mode: string, afterCalls: number): number {
    if (mode === "rate_limit")
        return 1 + afterCalls + (language === "Python" && library === "cohere" && operation === "stream" ? 0 : retries);
    if (mode === "cut_off_stream" && operation === "text" && (language === "Python" && ["openai", "anthropic", "langchain-openai"].includes(library) || language === "Node" && ["ai-openai", "ai-google"].includes(library)))
        return 1 + retries;
    return operation === "tool" ? 2 : 1;
}
