import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as policy from "../support/model-sdk-compat-policy.js";
import * as runner from "../support/model-sdk-compat-runner.js";
import { MODEL_DUMMY_KEY } from "../../packages/worker/src/model-helper-env.js";

afterEach(() => { vi.unstubAllEnvs(); });
const result: policy.SdkResult = { library: "openai", version: "3.50.0", scenario: "stream", outcome: "error", errorClass: "APIError", raisedIn: "api", finish: "none", toolArgsParse: "na", textSeen: true, usageSeen: false, secondTurn: false, messageSeen: true, vectorLength: 0, status: 0 };

it("builds the final child environment without inherited names and applies unset last", () => {
    for (const name of ["SDK_COMPAT_POISON", "AWS_PROFILE", "GITHUB_TOKEN", "OPENAI_API_KEY", "HTTPS_PROXY"])
        vi.stubEnv(name, "inherited-sentinel");
    vi.stubEnv("HOME", "/user-home-sentinel");
    const input = { directory: "/scratch/cell", log: "/scratch/tripwire", library: "openai", scenario: "text", row: "openai", mode: "rate_limit", base: "http://127.0.0.1:1234", scenarioBase: "http://127.0.0.1:1234/p/openai/f/rate_limit/v1", mapped: { environment: { OPENAI_API_KEY: MODEL_DUMMY_KEY, OPENAI_BASE_URL: "http://127.0.0.1:1234/p/openai/v1", GOOGLE_APPLICATION_CREDENTIALS: "remove-me" }, unset: ["GOOGLE_APPLICATION_CREDENTIALS"] } };
    const env = runner.buildSdkChildEnvironment(input);
    expect(env.HOME).toBe("/scratch/cell/home");
    expect(env.SDK_PRIVATE_ROOT).toBe("/scratch/cell/private");
    expect(env.OPENAI_API_KEY).toBe(MODEL_DUMMY_KEY);
    expect(env.OPENAI_BASE_URL).toBe(input.scenarioBase);
    expect(env.BASE_URL).toBe(input.scenarioBase);
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(Object.values(env)).not.toContain("inherited-sentinel");
    expect(Object.values(env)).not.toContain("/user-home-sentinel");
    expect(Object.keys(env).filter(name => /AWS_|TOKEN|SECRET/u.test(name))).toEqual([]);
    expect(env.SDK_COMPAT_POISON).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
    const vertex = runner.buildSdkChildEnvironment({ ...input, row: "vertex", mapped: { ...input.mapped, environment: { ...input.mapped.environment, GOOGLE_API_KEY: MODEL_DUMMY_KEY, GOOGLE_TOKEN: "dummy" } } });
    expect(Object.keys(vertex).filter(name => /KEY|TOKEN/u.test(name))).toEqual(["MODEL_DUMMY_KEY"]);
    expect(runner.buildSdkChildEnvironment({ ...input, mapped: { ...input.mapped, unset: ["MODEL_DUMMY_KEY", "BASE_URL"] } })).not.toHaveProperty("MODEL_DUMMY_KEY");
});

it("wraps either runtime in sandbox-exec and fails the run on sandbox_apply exit 71", async () => {
    const invocation = policy.sdkSandboxInvocation("/runtime/python", ["-I", "/scratch/client.py"], { privateHome: "/private-home", runtime: "/runtime", scratch: "/scratch" });
    expect(invocation.command).toBe("/usr/bin/sandbox-exec");
    expect(invocation.args.slice(-3)).toEqual(["/runtime/python", "-I", "/scratch/client.py"]);
    expect(invocation.args).toContain("PRIVATE_HOME=/private-home");
    expect(invocation.args).toContain("(version 1)(allow default)(deny network*)(allow network-outbound (remote ip \"localhost:*\"))(allow network-bind (local ip \"localhost:*\"))(allow network-inbound (local ip \"localhost:*\"))(deny file-read* (subpath (param \"PRIVATE_HOME\")))(allow file-read* (subpath (param \"RUNTIME\")))(allow file-read* (subpath (param \"SCRATCH\")))");
    const dir = mkdtempSync(join(tmpdir(), "sdk-compat-"));
    const env = { SDK_TRIPWIRE_LOG: join(dir, "tripwire") };
    const run = vi.fn<typeof runner.runSdkChild>().mockImplementation(async () => {
        writeFileSync(env.SDK_TRIPWIRE_LOG, '"model-canary.rovara-canary.dev"\n');
        return { code: 71, timedOut: false, stdout: "" };
    });
    try {
        await expect(runner.runSandboxedSdkChild("/runtime/node", ["client.mjs"], env, "/scratch", 30, { privateHome: "/private-home", runtime: "/runtime", scratch: "/scratch" }, run)).rejects.toThrow("SDK sandbox child failed");
        expect(run).toHaveBeenCalledExactlyOnceWith("/usr/bin/sandbox-exec", expect.arrayContaining(["/runtime/node", "client.mjs"]), env, "/scratch", 30);
        run.mockRejectedValueOnce(new Error("child-controlled-text"));
        await expect(runner.runSandboxedSdkChild("/runtime/node", [], env, "/scratch", 30, { privateHome: "/private-home", runtime: "/runtime", scratch: "/scratch" }, run)).rejects.toThrow(/^SDK sandbox child failed$/u);
        run.mockResolvedValueOnce({ code: 0, timedOut: false, stdout: "result" });
        await expect(runner.runSandboxedSdkChild("/runtime/node", [], {}, "/scratch", 30, { privateHome: "/private-home", runtime: "/runtime", scratch: "/scratch" }, run)).rejects.toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("checks the actual child log on every invocation including afterCalls and never accepts a stale canary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-compat-"));
    const log = join(dir, "tripwire");
    const env = { SDK_TRIPWIRE_LOG: log };
    const paths = { privateHome: "/private-home", runtime: "/runtime", scratch: dir };
    const run = vi.fn<typeof runner.runSdkChild>().mockImplementation(async () => {
        writeFileSync(log, '"model-canary.rovara-canary.dev"\n');
        return { code: 0, timedOut: false, stdout: "result" };
    });
    try {
        await expect(runner.runSandboxedSdkChild("node", [], env, dir, 30, paths, run)).resolves.toMatchObject({ stdout: "result" });
        run.mockResolvedValueOnce({ code: 0, timedOut: false, stdout: "result" });
        await expect(runner.runSandboxedSdkChild("node", [], env, dir, 30, paths, run)).rejects.toThrow();
        run.mockImplementationOnce(async () => {
            writeFileSync(log, '"model-canary.rovara-canary.dev"\n"elsewhere.invalid"\n');
            return { code: 0, timedOut: false, stdout: "result" };
        });
        await expect(runner.runSandboxedSdkChild("node", [], env, dir, 30, paths, run)).rejects.toThrow();
        run.mockImplementationOnce(async () => {
            writeFileSync(log, '"model-canary.rovara-canary.dev"\n');
            return { code: 0, timedOut: true, stdout: "" };
        });
        await expect(runner.runSandboxedSdkChild("node", [], env, dir, 30, paths, run)).rejects.toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("reports only fixed text for malformed JSON and schema errors", () => {
    for (const text of ["untrusted-child-text", JSON.stringify({ ...result, library: "untrusted-child-text" }), JSON.stringify({ ...result, "untrusted-child-text": true })]) {
        expect(() => policy.parseSdkResult(text)).toThrow(/^invalid SDK result$/u);
        try { policy.parseSdkResult(text); } catch (error) { expect((error as Error).cause).toBeUndefined(); }
    }
});

it("requires a recognized cutoff class or a confirmed transport marker, never generic status zero", () => {
    for (const errorClass of ["APIError", "ApiError", "ClientError", "APICallError", "RetryError", "AbortError", "TypeError"])
        expect(policy.classifySdkResult({ ...result, errorClass }, "cut_off_stream", "")).toBe("FAIL");
    expect(policy.classifySdkResult({ ...result, errorClass: "APIConnectionError" }, "cut_off_stream", "")).toBe("PASS-ERROR");
    expect(policy.classifySdkResult({ ...result, library: "langchain-openai", errorClass: "OpenAIConnectionError" }, "cut_off_stream", "")).toBe("PASS-ERROR");
    expect(policy.classifySdkResult({ ...result, raisedIn: "transport", errorClass: "APICallError" }, "cut_off_stream", "")).toBe("PASS-ERROR");
    expect(policy.classifySdkResult({ ...result, raisedIn: "transport", textSeen: false }, "cut_off_stream", "")).toBe("FAIL");
});

it("requires exactly one canary refusal per child and rejects any runtime escape", () => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-compat-"));
    const log = join(dir, "tripwire");
    try {
        for (const contents of ["", '"model-canary.rovara-canary.dev"\n"elsewhere.invalid"\n', '"elsewhere.invalid"\n', '"model-canary.rovara-canary.dev"\n'.repeat(2)]) {
            writeFileSync(log, contents);
            expect(() => policy.assertSdkCanary(log)).toThrow();
        }
        writeFileSync(log, '"model-canary.rovara-canary.dev"\n');
        expect(() => policy.assertSdkCanary(log)).not.toThrow();
        expect(() => policy.assertSdkCanary(join(dir, "missing"))).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
