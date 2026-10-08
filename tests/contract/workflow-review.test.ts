import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { PiSessionAdapter, PiSessionInput } from "../../packages/worker/src/pi-session.js";
import { parseWorkflowReviewerResponse, runWorkflowReviews } from "../../packages/worker/src/verification/review.js";

const execFile = promisify(execFileCallback);

function reviewerAdapter(prompt: (input: PiSessionInput, text: string) => Promise<void>, onAbort: () => void | Promise<void> = () => undefined): PiSessionAdapter {
  return {
    async create(input) {
      const sessionFile = join(input.sessionDirectory, `${input.conversationId}.jsonl`);
      await writeFile(sessionFile, "{}");
      return {
        conversationId: input.conversationId ?? "review-session",
        sessionFile,
        async prompt(text) { await prompt(input, text); },
        async abort() { await onAbort(); },
        getModel: () => ({ provider: "test", modelId: "review-v1" }),
        getSessionStats: () => ({ tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 } as never),
        subscribe() { return () => undefined; },
        dispose() {},
      };
    },
  };
}

describe("workflow reviewer output", () => {
  it("accepts bounded JSON findings and derives PASS only when findings are empty", () => {
    expect(parseWorkflowReviewerResponse('{"findings":[]}')).toEqual({ status: "PASS", findings: [] });
    expect(parseWorkflowReviewerResponse('{"findings":["Missing authorization check"]}')).toEqual({ status: "FINDINGS", findings: ["Missing authorization check"] });
    const redacted = parseWorkflowReviewerResponse('{"findings":["Leaked ghp_123456789012345678901234567890123456"]}');
    expect(redacted.status).toBe("FINDINGS");
    expect(redacted.findings[0]).not.toContain("ghp_");
  });

  it("fails closed for malformed, oversized, or unbounded output", () => {
    expect(parseWorkflowReviewerResponse("not json")).toEqual({ status: "UNKNOWN", findings: [], failureReason: "INVALID_JSON" });
    expect(parseWorkflowReviewerResponse(JSON.stringify({ findings: ["x".repeat(1001)] }))).toEqual({ status: "UNKNOWN", findings: [], failureReason: "INVALID_SHAPE" });
    expect(parseWorkflowReviewerResponse(" ".repeat(20_001))).toEqual({ status: "UNKNOWN", findings: [], failureReason: "RESPONSE_TOO_LARGE" });
  });

  it("runs critic and security as separate read-only sessions pinned to one unchanged candidate", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "agentx-review-"));
    const repositoryDirectory = join(rootPath, "repo", "payments");
    await mkdir(repositoryDirectory, { recursive: true });
    const git = async (...args: string[]) => { await execFile("git", ["-C", repositoryDirectory, ...args], { encoding: "utf8" }); };
    await git("init", "--quiet");
    await git("config", "user.email", "review@example.invalid");
    await git("config", "user.name", "Review Test");
    await writeFile(join(repositoryDirectory, "app.ts"), "export const value = 1;\n");
    await git("add", "app.ts");
    await git("commit", "--quiet", "-m", "baseline");
    const sessionInputs: Array<{ mode?: string; conversationId?: string }> = [];
    const adapter: PiSessionAdapter = {
      async create(input) {
        sessionInputs.push({ ...(input.workflowMode === undefined ? {} : { mode: input.workflowMode }),
          ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }) });
        const sessionFile = join(input.sessionDirectory, `${input.conversationId}.jsonl`);
        await writeFile(sessionFile, "{}");
        let listener: ((event: unknown) => void) | undefined;
        return {
          conversationId: input.conversationId ?? "review-session",
          sessionFile,
          async prompt() { listener?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: '{"findings":[]}' }] } }); },
          async abort() {},
          getModel: () => ({ provider: "test", modelId: "review-v1" }),
          getSessionStats: () => ({ tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 } as never),
          subscribe(callback) { listener = callback; return () => { listener = undefined; }; },
          dispose() {},
        };
      },
    };
    const usage: Array<{ role: string; outcome: string }> = [];
    try {
      const { readCandidateRepositories } = await import("../../packages/worker/src/verification/candidate.js");
      const repositories = [{ repositoryId: "payments", directory: repositoryDirectory }];
      const candidate = await readCandidateRepositories(repositories);
      const reports = await runWorkflowReviews({
        operationId: "11111111-1111-4111-8111-111111111111",
        rootPath,
        model: { provider: "test", modelId: "review-v1" },
        candidate,
        repositories,
        piAdapter: adapter,
        now: () => "2026-10-05T12:00:00.000Z",
        onUsage: async (entry) => { usage.push({ role: entry.role, outcome: entry.outcome }); },
      });
      expect(reports.map(({ role, status, provider, version }) => ({ role, status, provider, version }))).toEqual([
        { role: "CRITIC", status: "PASS", provider: "test", version: "review-v1" },
        { role: "SECURITY", status: "PASS", provider: "test", version: "review-v1" },
      ]);
      expect(sessionInputs).toHaveLength(2);
      expect(sessionInputs.map(({ mode }) => mode)).toEqual(["REVIEW", "REVIEW"]);
      expect(new Set(sessionInputs.map(({ conversationId }) => conversationId)).size).toBe(2);
      expect(usage).toEqual([{ role: "CRITIC", outcome: "SUCCEEDED" }, { role: "SECURITY", outcome: "SUCCEEDED" }]);

      const missingResponses = await runWorkflowReviews({
        operationId: "11111111-1111-4111-8111-111111111111", rootPath,
        model: { provider: "test", modelId: "review-v1" }, candidate, repositories,
        piAdapter: reviewerAdapter(async () => undefined),
      });
      expect(missingResponses.map((report) => [report.status, report.failureReason])).toEqual([
        ["UNKNOWN", "RESPONSE_MISSING"], ["UNKNOWN", "RESPONSE_MISSING"],
      ]);

      const timeoutReports = await runWorkflowReviews({
        operationId: "11111111-1111-4111-8111-111111111111",
        rootPath, model: { provider: "test", modelId: "review-v1" }, candidate, repositories,
        piAdapter: reviewerAdapter(() => new Promise(() => undefined)), timeoutMs: 5,
      });
      expect(timeoutReports.map((report) => [report.status, report.failureReason])).toEqual([["UNKNOWN", "TIMEOUT"], ["UNKNOWN", "TIMEOUT"]]);
      const unresponsiveAbortReports = await runWorkflowReviews({
        operationId: "11111111-1111-4111-8111-111111111111",
        rootPath, model: { provider: "test", modelId: "review-v1" }, candidate, repositories,
        piAdapter: reviewerAdapter(() => new Promise(() => undefined), () => new Promise(() => undefined)), timeoutMs: 5,
      });
      expect(unresponsiveAbortReports.map((report) => report.status)).toEqual(["UNKNOWN", "UNKNOWN"]);

      const interruption = new AbortController();
      let started!: () => void;
      const reviewStarted = new Promise<void>((resolve) => { started = resolve; });
      let abortCalls = 0;
      const interrupted = runWorkflowReviews({
        operationId: "11111111-1111-4111-8111-111111111111",
        rootPath, model: { provider: "test", modelId: "review-v1" }, candidate, repositories,
        piAdapter: reviewerAdapter(async () => { started(); await new Promise(() => undefined); }, () => { abortCalls += 1; }),
        signal: interruption.signal, timeoutMs: 60_000,
      });
      await reviewStarted;
      interruption.abort();
      const interruptedReports = await interrupted;
      expect(interruptedReports.map((report) => report.status)).toEqual(["INTERRUPTED", "INTERRUPTED"]);
      expect(abortCalls).toBe(1);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("asks once for the required JSON shape when a reviewer first responds in prose", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "agentx-review-json-retry-"));
    const repositoryDirectory = join(rootPath, "repo", "payments");
    await mkdir(repositoryDirectory, { recursive: true });
    const git = async (...args: string[]) => { await execFile("git", ["-C", repositoryDirectory, ...args], { encoding: "utf8" }); };
    await git("init", "--quiet");
    await git("config", "user.email", "review@example.invalid");
    await git("config", "user.name", "Review Test");
    await writeFile(join(repositoryDirectory, "app.ts"), "export const value = 1;\n");
    await git("add", "app.ts");
    await git("commit", "--quiet", "-m", "baseline");
    let responseIndex = 0;
    let listener: ((event: unknown) => void) | undefined;
    const adapter: PiSessionAdapter = {
      async create(input) {
        const sessionFile = join(input.sessionDirectory, `${input.conversationId}.jsonl`);
        await writeFile(sessionFile, "{}");
        return {
          conversationId: input.conversationId ?? "review-session",
          sessionFile,
          async prompt() {
            responseIndex += 1;
            const text = responseIndex === 1 ? "Review complete. No findings." : '{"findings":[]}';
            listener?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
          },
          async abort() {},
          getModel: () => ({ provider: "test", modelId: "review-v1" }),
          getSessionStats: () => ({ tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 } as never),
          subscribe(callback) { listener = callback; return () => { listener = undefined; }; },
          dispose() {},
        };
      },
    };
    try {
      const { readCandidateRepositories } = await import("../../packages/worker/src/verification/candidate.js");
      const repositories = [{ repositoryId: "payments", directory: repositoryDirectory }];
      const candidate = await readCandidateRepositories(repositories);
      const reports = await runWorkflowReviews({
        operationId: "11111111-1111-4111-8111-111111111111",
        rootPath, model: { provider: "test", modelId: "review-v1" }, candidate, repositories, piAdapter: adapter,
      });
      expect(responseIndex).toBe(3);
      expect(reports.map(({ status, failureReason }) => [status, failureReason])).toEqual([
        ["PASS", undefined], ["PASS", undefined],
      ]);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("keeps reviews blocked when the format retry is still malformed", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "agentx-review-json-still-invalid-"));
    const repositoryDirectory = join(rootPath, "repo", "payments");
    await mkdir(repositoryDirectory, { recursive: true });
    const git = async (...args: string[]) => { await execFile("git", ["-C", repositoryDirectory, ...args], { encoding: "utf8" }); };
    await git("init", "--quiet");
    await git("config", "user.email", "review@example.invalid");
    await git("config", "user.name", "Review Test");
    await writeFile(join(repositoryDirectory, "app.ts"), "export const value = 1;\n");
    await git("add", "app.ts");
    await git("commit", "--quiet", "-m", "baseline");
    let responseIndex = 0;
    let listener: ((event: unknown) => void) | undefined;
    const adapter: PiSessionAdapter = {
      async create(input) {
        const sessionFile = join(input.sessionDirectory, `${input.conversationId}.jsonl`);
        await writeFile(sessionFile, "{}");
        return {
          conversationId: input.conversationId ?? "review-session",
          sessionFile,
          async prompt() {
            responseIndex += 1;
            listener?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Review complete. No findings." }] } });
          },
          async abort() {},
          getModel: () => ({ provider: "test", modelId: "review-v1" }),
          getSessionStats: () => ({ tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 } as never),
          subscribe(callback) { listener = callback; return () => { listener = undefined; }; },
          dispose() {},
        };
      },
    };
    try {
      const { readCandidateRepositories } = await import("../../packages/worker/src/verification/candidate.js");
      const repositories = [{ repositoryId: "payments", directory: repositoryDirectory }];
      const candidate = await readCandidateRepositories(repositories);
      const reports = await runWorkflowReviews({
        operationId: "11111111-1111-4111-8111-111111111111",
        rootPath, model: { provider: "test", modelId: "review-v1" }, candidate, repositories, piAdapter: adapter,
      });
      expect(responseIndex).toBe(4);
      expect(reports.map(({ status, failureReason }) => [status, failureReason])).toEqual([
        ["UNKNOWN", "INVALID_JSON"], ["UNKNOWN", "INVALID_JSON"],
      ]);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});
