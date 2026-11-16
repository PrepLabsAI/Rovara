import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanSdkEnvironment, parseSdkResult, assertNoEscapes, retryFinding } from "../support/model-sdk-compat-policy.js";
const dirs: string[] = [];
const scratch = (): string => { const dir = mkdtempSync(join(tmpdir(), "sdk-policy-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true }); });
const result = { library: "openai", version: "3.50.0", scenario: "text", outcome: "parsed", errorClass: "none", raisedIn: "none", finish: "stop", toolArgsParse: "na", textSeen: true, usageSeen: true, vectorLength: 0, status: 0, secondTurn: false, messageSeen: false } as const;
describe("SDK compatibility supervisor guards", () => {
    it("does not inherit shell variables, credentials or the user's home", () => {
        const before = process.env.SDK_COMPAT_INHERITED;
        process.env.SDK_COMPAT_INHERITED = "must-not-cross";
        try {
            const env = cleanSdkEnvironment("/scratch/home", "/scratch/config");
            expect(env.SDK_COMPAT_INHERITED).toBeUndefined();
            expect(env.HOME).toBe("/scratch/home");
            expect(env.CLOUDSDK_CONFIG).toBe("/scratch/config");
            expect(Object.keys(env).some((name) => /AWS_|TOKEN|KEY|SECRET|PROXY/u.test(name) && name !== "NO_PROXY")).toBe(false);
        }
        finally {
            if (before === undefined)
                delete process.env.SDK_COMPAT_INHERITED;
            else
                process.env.SDK_COMPAT_INHERITED = before;
        }
    });
    it("accepts one complete result and rejects unknown keys, untrusted text and nonfinite numbers", () => {
        expect(parseSdkResult(JSON.stringify(result))).toEqual(result);
        for (const value of [{ ...result, message: "untrusted" }, { ...result, vectorLength: Infinity }, { ...result, errorClass: "[click](https://bad) @owner" }])
            expect(() => parseSdkResult(JSON.stringify(value))).toThrow();
        expect(() => parseSdkResult(JSON.stringify(result) + "\n" + JSON.stringify(result))).toThrow();
        expect(() => parseSdkResult(JSON.stringify(result, null, 2))).toThrow();
        expect(() => parseSdkResult('{"__proto__":{"polluted":true}}')).toThrow();
        expect(() => parseSdkResult("x".repeat(1024 * 1024))).toThrow();
        expect(() => parseSdkResult(JSON.stringify(result) + " ".repeat(4096))).toThrow();
    });
    it("fails the run for any refused connection, even if the client swallowed the error", () => {
        const file = join(scratch(), "tripwire.jsonl");
        writeFileSync(file, "");
        expect(() => assertNoEscapes(file)).not.toThrow();
        writeFileSync(file, JSON.stringify("model-canary.rovara-canary.dev") + "\n");
        expect(() => assertNoEscapes(file)).toThrow();
    });
    it("fails closed when the tripwire evidence is missing or unreadable", () => {
        expect(() => assertNoEscapes(join(scratch(), "missing"))).toThrow();
        expect(() => assertNoEscapes(scratch())).toThrow();
    });
    it("flags both excess and missing retries", () => {
        expect(retryFinding(3, 3)).toBe(false);
        expect(retryFinding(1, 3)).toBe(true);
        expect(retryFinding(3, 1)).toBe(true);
        expect(retryFinding(NaN, 1)).toBe(true);
    });
});
describe("SDK result oracle", () => {
    it("rejects parser crashes, incorrect status, missing finishes and missing tool turns", async () => {
        const { classifySdkResult } = await import("../support/model-sdk-compat-policy.js");
        const good = { ...result, outcome: "parsed" as const, raisedIn: "none" as const, toolArgsParse: "na" as const };
        expect(classifySdkResult({ ...good, outcome: "error", errorClass: "ValidationError", raisedIn: "parser", status: 429, messageSeen: true }, "rate_limit", "")).toBe("FAIL");
        expect(classifySdkResult({ ...good, outcome: "error", errorClass: "RateLimitError", raisedIn: "api", status: 429, messageSeen: true }, "rate_limit", "")).toBe("PASS-ERROR");
        expect(classifySdkResult({ ...good, outcome: "error", raisedIn: "api", status: 400, messageSeen: true }, "rate_limit", "")).toBe("FAIL");
        expect(classifySdkResult({ ...good, scenario: "stream", finish: "none" }, "", "")).toBe("FAIL");
        expect(classifySdkResult({ ...good, scenario: "tool", toolArgsParse: "valid" }, "", "")).toBe("FAIL");
        expect(classifySdkResult({ ...good, scenario: "stream", finish: "none" }, "cut_off_stream", "")).toBe("PASS");
        expect(classifySdkResult({ ...good, toolArgsParse: "invalid" }, "bad_tool_json", "")).toBe("PASS");
        expect(classifySdkResult({ ...good, toolArgsParse: "valid" }, "bad_tool_json", "")).toBe("FAIL");
    });
});
it("recognizes cut-off transport errors and documented tool parse errors without accepting unrelated parser crashes", async () => {
    const { classifySdkResult } = await import("../support/model-sdk-compat-policy.js");
    const error = { ...result, outcome: "error" as const, raisedIn: "transport" as const, toolArgsParse: "na" as const, errorClass: "APIConnectionError", textSeen: false };
    expect(classifySdkResult(error, "cut_off_stream", "")).toBe("PASS-ERROR");
    expect(classifySdkResult({ ...error, raisedIn: "parser", errorClass: "JSONDecodeError" }, "cut_off_stream", "")).toBe("FAIL");
    expect(classifySdkResult({ ...error, raisedIn: "customer", errorClass: "InvalidToolInputError" }, "bad_tool_json", "")).toBe("PASS-ERROR");
});
it("refuses mention syntax and unknown identities from child output", () => {
    for (const value of [{ ...result, errorClass: "@owner" }, { ...result, library: "@owner" }, { ...result, scenario: "unexpected" }, { ...result, finish: "@owner" }])
        expect(() => parseSdkResult(JSON.stringify(value))).toThrow();
});
it("recognizes provider filter enums and refuses a 200 API parsing error as a transport drop", async () => {
    const { classifySdkResult } = await import("../support/model-sdk-compat-policy.js");
    const good = { ...result, outcome: "parsed" as const, raisedIn: "none" as const, toolArgsParse: "na" as const };
    expect(classifySdkResult({ ...good, finish: "content-filter" }, "refusal", "filter")).toBe("PASS");
    expect(classifySdkResult({ ...good, outcome: "error", raisedIn: "api", status: 200, errorClass: "ApiError", messageSeen: true }, "cut_off_stream", "")).toBe("FAIL");
    expect(classifySdkResult({ ...good, outcome: "error", raisedIn: "customer", errorClass: "BlockedPromptException" }, "refusal", "filter")).toBe("PASS-ERROR");
});
it("requires ledger evidence for the selected mode and afterCalls boundary", async () => {
    const { assertScenarioCounts } = await import("../support/model-sdk-compat-policy.js");
    const counts = { trusted: true, refused: 0, escapes: { count: 0 }, failurePack: 3, unmatched: 0, scripted: { before_task: 1, independent: 0, task_made: 0 } };
    expect(() => assertScenarioCounts(counts, "rate_limit", 1)).not.toThrow();
    expect(() => assertScenarioCounts(counts, "unmatched", 0)).toThrow();
    for (const bad of [{ ...counts, trusted: false }, { ...counts, refused: 1 }, { ...counts, escapes: { count: 1 } }, { ...counts, failurePack: 0 }, { ...counts, scripted: { before_task: 2, independent: 0, task_made: 0 } }])
        expect(() => assertScenarioCounts(bad, "rate_limit", 1)).toThrow();
});
it("uses a confirmed socket cause even after a successful HTTP status", async () => {
    const { classifySdkResult } = await import("../support/model-sdk-compat-policy.js");
    expect(classifySdkResult({ ...result, outcome: "error", raisedIn: "transport", toolArgsParse: "na", status: 200, errorClass: "APICallError" }, "cut_off_stream", "")).toBe("PASS-ERROR");
});
it("treats an unmatched-script refusal as the SDK's normal 400 error", async () => {
    const { classifySdkResult } = await import("../support/model-sdk-compat-policy.js");
    expect(classifySdkResult({ ...result, outcome: "error", raisedIn: "api", toolArgsParse: "na", status: 400, errorClass: "BadRequestError", messageSeen: true }, "unmatched", "")).toBe("PASS-ERROR");
});
it("rejects success on an unmatched script and recognizes final-helper finish errors only in their own modes", async () => {
    const { classifySdkResult } = await import("../support/model-sdk-compat-policy.js");
    expect(classifySdkResult(result, "unmatched", "")).toBe("FAIL");
    for (const [errorClass, mode, variant] of [["LengthFinishReasonError", "token_limit", "output"], ["ContentFilterFinishReasonError", "refusal", "filter"]]) {
        const error = { ...result, outcome: "error" as const, raisedIn: "customer" as const, errorClass: errorClass ?? "none" };
        expect(classifySdkResult(error, mode ?? "", variant ?? "")).toBe("PASS-ERROR");
        expect(classifySdkResult(error, "", "")).toBe("FAIL");
    }
});
it("renders the measured matrix deterministically without leaking child messages", async () => {
    const { renderSdkMatrix } = await import("../support/model-sdk-compat-runner.js");
    const cell = { language: "Python", library: "openai", version: "3.50.0", row: "openai", scenario: "text", mode: "normal", variant: "default", result: "PASS", observed: 1, expected: 1, note: "finish-stop:tools-na" };
    const first = renderSdkMatrix([cell], "a".repeat(40), "3.13.17", "22.23.2");
    expect(first).toBe(renderSdkMatrix([cell], "a".repeat(40), "3.13.17", "22.23.2"));
    expect(first).toContain("PASS: 1");
    expect(first).toContain("| 1/1 | finish-stop:tools-na |");
    expect(first).not.toContain("compat-text");
    expect(() => renderSdkMatrix([cell], "untrusted", "3.13.17", "22.23.2")).toThrow();
    expect(() => renderSdkMatrix([cell], "a".repeat(40), "@owner", "22.23.2")).toThrow();
    for (const bad of [{...cell,library:"unknown"},{...cell,language:"unknown"},{...cell,version:"@owner"}]) expect(() => renderSdkMatrix([bad], "a".repeat(40), "3.13.17", "22.23.2")).toThrow();
    for (const note of ["[click](https://bad)", "![x[y]](https://bad)", "[x][ref]", "@owner", "#123", "<img>", "# heading", "> quote", "---", "```", "~~~", "hidden\u200b", "hidden\ufe0f", "x".repeat(1024 * 1024)])
        expect(() => renderSdkMatrix([{ ...cell, note }], "a".repeat(40), "3.13.17", "22.23.2")).toThrow();
    expect(() => renderSdkMatrix([{ ...cell, observed: Infinity }], "a".repeat(40), "3.13.17", "22.23.2")).toThrow();
});
it("uses operation-specific retry defaults, including transport retries and Cohere's unary-only retry loop", async () => {
    const { expectedSdkAttempts } = await import("../support/model-sdk-compat-policy.js");
    expect(expectedSdkAttempts("Python", "cohere", 2, "stream", "rate_limit", 0)).toBe(1);
    expect(expectedSdkAttempts("Python", "cohere", 2, "text", "rate_limit", 1)).toBe(4);
    expect(expectedSdkAttempts("Python", "openai", 2, "text", "cut_off_stream", 0)).toBe(3);
    expect(expectedSdkAttempts("Node", "ai-google", 2, "text", "cut_off_stream", 0)).toBe(3);
    expect(expectedSdkAttempts("Node", "openai", 2, "text", "cut_off_stream", 0)).toBe(1);
    expect(expectedSdkAttempts("Python", "langchain-google-genai", 5, "text", "rate_limit", 0)).toBe(6);
    expect(expectedSdkAttempts("Python", "anthropic", 2, "stream", "cut_off_stream", 0)).toBe(1);
    expect(expectedSdkAttempts("Python", "anthropic", 2, "tool", "", 0)).toBe(2);
    expect(expectedSdkAttempts("Python", "openai", 2, "text", "token_limit", 0)).toBe(1);
});
