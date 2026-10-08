import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { PiSessionAdapter, PiSessionInput } from "../../packages/worker/src/pi-session.js";
import { parseWorkflowReviewerResponse, reclassifyFinding, runWorkflowReviews } from "../../packages/worker/src/verification/review.js";
import { candidateChanges, candidateDiff, parseCandidateChanges, type CandidateChange } from "../../packages/worker/src/verification/diff.js";
import type { WorkflowReviewFinding } from "../../packages/contracts/src/index.js";

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
  it("accepts structured findings and passes when only pre-existing issues are reported", () => {
    expect(parseWorkflowReviewerResponse(JSON.stringify({ findings: [{ text: "Old helper ignores errors", origin: "PRE_EXISTING", severity: "LOW", file: "src/old.ts" }] })))
      .toEqual({ status: "PASS", findings: [{ text: "Old helper ignores errors", origin: "PRE_EXISTING", severity: "LOW", file: "src/old.ts" }] });
    expect(parseWorkflowReviewerResponse(JSON.stringify({ findings: [{ text: "New endpoint skips auth", origin: "INTRODUCED", severity: "HIGH", file: "src/api.ts", line: 12 }] })))
      .toEqual({ status: "FINDINGS", findings: [{ text: "New endpoint skips auth", origin: "INTRODUCED", severity: "HIGH", file: "src/api.ts", line: 12 }] });
    expect(parseWorkflowReviewerResponse('{"findings":["Missing authorization check"]}')).toEqual({ status: "FINDINGS", findings: [{ text: "Missing authorization check", origin: "INTRODUCED" }] });
    const redacted = parseWorkflowReviewerResponse('{"findings":["Leaked ghp_123456789012345678901234567890123456"]}');
    expect(redacted.findings[0]?.text).not.toContain("ghp_");
  });

  it("keeps every PASS row that says anything but a known no-issue phrase, stored as its description", () => {
    for (const [row, description] of [
      ["PASS: but the new endpoint lacks auth", "but the new endpoint lacks auth"],
      ["PASS - but secrets leak", "but secrets leak"],
      ["PASS: endpoint accepts requests without authentication", "endpoint accepts requests without authentication"],
      ["PASS: user input is not escaped (XSS)", "user input is not escaped (XSS)"],
      ["PASS: token is written to logs", "token is written to logs"],
      ["PASS: SSRF via the new fetch URL parameter", "SSRF via the new fetch URL parameter"],
      ["PASS: no rate limit on login", "no rate limit on login"],
      ["Passed – input validation unchanged", "input validation unchanged"],
    ] as const) {
      // The verdict is stripped before redaction, which would otherwise read "PASS: <words>" as a password.
      expect(parseWorkflowReviewerResponse(JSON.stringify({ findings: [row] }))).toEqual({ status: "FINDINGS", findings: [{ text: description, origin: "INTRODUCED" }] });
    }
  });

  it("skips a PASS row only when nothing or a known no-issue phrase follows the verdict", () => {
    const phrases = ["unchanged", "no change", "no changes", "not applicable", "n/a", "no issues", "no issues found", "nothing to report",
      "covered by tests", "tests cover this", "ok", "looks good"];
    for (const phrase of phrases) {
      for (const row of [`PASS: ${phrase}`, `Passed - ${phrase.toUpperCase()}.`, `pass – ${phrase}`]) {
        expect(parseWorkflowReviewerResponse(JSON.stringify({ findings: [row] })), row).toEqual({ status: "PASS", findings: [] });
      }
    }
    expect(parseWorkflowReviewerResponse(JSON.stringify({ findings: ["PASS", "Passed", "PASS:"] }))).toEqual({ status: "PASS", findings: [] });
    // An em dash separates a verdict like the other dashes, and trailing "." or "!" do not stop a match.
    expect(parseWorkflowReviewerResponse(JSON.stringify({ findings: ["PASS — no issues", "PASS: ok!", "Passed - looks good!!"] }))).toEqual({ status: "PASS", findings: [] });
    expect(parseWorkflowReviewerResponse(JSON.stringify({ findings: ["PASS — token logged"] }))).toEqual({ status: "FINDINGS", findings: [{ text: "token logged", origin: "INTRODUCED" }] });
  });

  it("drops an unsafe or secret-bearing finding file, so the finding counts as unlocated", () => {
    for (const file of ["/etc/passwd", "../outside.ts", "src/../../x.ts", "src\\win.ts", "C:/x.ts", "src/a\u0000b.ts", "ghp_123456789012345678901234567890123456.ts"]) {
      const parsed = parseWorkflowReviewerResponse(JSON.stringify({ findings: [{ text: "Old helper ignores errors", origin: "PRE_EXISTING", file }] }));
      expect(parsed.findings).toEqual([{ text: "Old helper ignores errors", origin: "PRE_EXISTING" }]);
    }
    expect(parseWorkflowReviewerResponse(JSON.stringify({ findings: [{ text: "Old helper", origin: "PRE_EXISTING", file: "./src/old.ts" }] })).findings[0]?.file).toBe("src/old.ts");
  });

  it("lets a pre-existing label stand only where AgentX can confirm the change did not cause it", () => {
    const changed: CandidateChange[] = [
      { path: "app.ts", status: "MODIFIED", hunks: [[10, 12], [30, 31]] },
      { path: "payments/app.ts", status: "MODIFIED", hunks: [[10, 12], [30, 31]] },
      { path: "src/added.ts", status: "ADDED", hunks: [[1, 5]] },
      { path: "src/removed.ts", status: "DELETED", hunks: [] },
    ];
    const old = { text: "Old helper ignores errors", origin: "PRE_EXISTING" as const };
    const origin = (finding: Partial<WorkflowReviewFinding>) => reclassifyFinding({ ...old, ...finding }, changed).origin;
    // (a) No file: AgentX cannot confirm the label.
    expect(origin({})).toBe("INTRODUCED");
    // (b) A file the change added, however it is named; a deleted file cannot be placed either.
    for (const file of ["src/added.ts", "added.ts", "payments/src/added.ts"]) expect(origin({ file, line: 99 })).toBe("INTRODUCED");
    expect(origin({ file: "src/removed.ts", line: 3 })).toBe("INTRODUCED");
    // (c) A modified file with a line inside a changed hunk, with or without the repository in front.
    for (const line of [10, 11, 12, 30, 31]) expect(origin({ file: "app.ts", line })).toBe("INTRODUCED");
    expect(origin({ file: "payments/app.ts", line: 11 })).toBe("INTRODUCED");
    // (d) A modified file with no line: AgentX cannot verify it.
    expect(origin({ file: "app.ts" })).toBe("INTRODUCED");
    // A modified file with a line outside every hunk, and an untouched file, stay advisory.
    for (const line of [1, 9, 13, 29, 32]) expect(reclassifyFinding({ ...old, file: "app.ts", line }, changed)).toEqual({ ...old, file: "app.ts", line });
    expect(reclassifyFinding({ ...old, file: "src/legacy.ts" }, changed)).toEqual({ ...old, file: "src/legacy.ts" });
    // Introduced findings are never downgraded.
    expect(reclassifyFinding({ text: "x", origin: "INTRODUCED", file: "src/legacy.ts" }, changed).origin).toBe("INTRODUCED");
    // Reclassified findings rank and decide the status as introduced ones, before the 20-finding cut.
    const many = Array.from({ length: 25 }, (_, index) => ({ text: `Old issue ${index}`, origin: "PRE_EXISTING", file: "src/legacy.ts" }));
    const parsed = parseWorkflowReviewerResponse(JSON.stringify({ findings: [...many, { text: "Hidden", origin: "PRE_EXISTING", file: "app.ts" }] }),
      { classify: (finding) => reclassifyFinding(finding, changed) });
    expect(parsed.status).toBe("FINDINGS");
    expect(parsed.findings[0]).toEqual({ text: "Hidden", origin: "INTRODUCED", file: "app.ts" });
  });

  it("never turns PASS verdict rows or no-issue notes into findings", () => {
    expect(parseWorkflowReviewerResponse(JSON.stringify({ findings: ["PASS: unchanged", "No issues found", { text: "PASS - no changes", origin: "INTRODUCED" }] })))
      .toEqual({ status: "PASS", findings: [] });
  });

  it("keeps real findings whose wording starts like a verdict or no-issue note", () => {
    for (const text of [
      "None of the new routes check authorization",
      "Passed-in token is written to logs",
      "Pass-through proxy forwards the Authorization header",
      "OK handler swallows errors",
      "Looks good overall, but the new query concatenates user input",
      "No issues found in auth.ts, but db.ts builds SQL from input",
    ]) {
      expect(parseWorkflowReviewerResponse(JSON.stringify({ findings: [text] }))).toEqual({ status: "FINDINGS", findings: [{ text, origin: "INTRODUCED" }] });
      expect(parseWorkflowReviewerResponse(JSON.stringify({ findings: [{ text, origin: "INTRODUCED" }] })).status).toBe("FINDINGS");
    }
    const located = { text: "None of the new routes check authorization", origin: "INTRODUCED", severity: "HIGH", file: "src/api.ts", line: 3 };
    expect(parseWorkflowReviewerResponse(JSON.stringify({ findings: [located] }))).toEqual({ status: "FINDINGS", findings: [located] });
    expect(parseWorkflowReviewerResponse(JSON.stringify({ findings: [{ text: "PASS", origin: "INTRODUCED", file: "src/api.ts" }] })).status).toBe("FINDINGS");
    expect(parseWorkflowReviewerResponse(JSON.stringify({ findings: ["None.", "LGTM!", "n/a", "No problems found", "Passed", "PASS – ok"] }))).toEqual({ status: "PASS", findings: [] });
  });

  it("refuses a missing origin and prose or extra JSON around the answer", () => {
    expect(parseWorkflowReviewerResponse(JSON.stringify({ findings: [{ text: "New endpoint skips auth" }] }))).toEqual({ status: "UNKNOWN", findings: [], failureReason: "INVALID_SHAPE" });
    expect(parseWorkflowReviewerResponse('Here is my review:\n```json\n{"findings":[]}\n```\nThanks.')).toEqual({ status: "UNKNOWN", findings: [], failureReason: "INVALID_JSON" });
    expect(parseWorkflowReviewerResponse('{"findings":[]}\n{"findings":["Missing authorization check"]}')).toEqual({ status: "UNKNOWN", findings: [], failureReason: "INVALID_JSON" });
  });

  it("keeps an introduced finding ahead of many pre-existing ones", () => {
    const preExisting = Array.from({ length: 25 }, (_, index) => ({ text: `Old issue ${index}`, origin: "PRE_EXISTING", severity: "HIGH" }));
    const introduced = { text: "New endpoint skips auth", origin: "INTRODUCED" };
    const parsed = parseWorkflowReviewerResponse(JSON.stringify({ findings: [...preExisting, introduced] }));
    expect(parsed.status).toBe("FINDINGS");
    expect(parsed.findings).toHaveLength(20);
    expect(parsed.findings[0]).toEqual(introduced);
  });

  it("reads a fenced JSON answer and refuses an unknown origin", () => {
    expect(parseWorkflowReviewerResponse('```json\n{"findings":[]}\n```')).toEqual({ status: "PASS", findings: [] });
    expect(parseWorkflowReviewerResponse(JSON.stringify({ findings: [{ text: "x", origin: "MAYBE" }] }))).toEqual({ status: "UNKNOWN", findings: [], failureReason: "INVALID_SHAPE" });
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
      const base = (await execFile("git", ["-C", repositoryDirectory, "rev-parse", "HEAD"], { encoding: "utf8" })).stdout.trim();
      const candidate = await readCandidateRepositories([{ ...repositories[0]!, baseCommitSha: base }]);
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
      const base = (await execFile("git", ["-C", repositoryDirectory, "rev-parse", "HEAD"], { encoding: "utf8" })).stdout.trim();
      const candidate = await readCandidateRepositories([{ ...repositories[0]!, baseCommitSha: base }]);
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
      const base = (await execFile("git", ["-C", repositoryDirectory, "rev-parse", "HEAD"], { encoding: "utf8" })).stdout.trim();
      const candidate = await readCandidateRepositories([{ ...repositories[0]!, baseCommitSha: base }]);
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

/** A reviewer that records every prompt and answers each with `answer(prompt)`. */
function answeringAdapter(prompts: string[], answer: (text: string) => string): PiSessionAdapter {
  return {
    async create(input) {
      const sessionFile = join(input.sessionDirectory, `${input.conversationId}.jsonl`);
      await writeFile(sessionFile, "{}");
      let listener: ((event: unknown) => void) | undefined;
      return {
        conversationId: input.conversationId ?? "review-session",
        sessionFile,
        async prompt(text) {
          prompts.push(text);
          listener?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: answer(text) }] } });
        },
        async abort() {},
        getModel: () => ({ provider: "test", modelId: "review-v1" }),
        getSessionStats: () => ({ tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 } as never),
        subscribe(callback) { listener = callback; return () => { listener = undefined; }; },
        dispose() {},
      };
    },
  };
}

describe("workflow reviews of the base-to-candidate change", () => {
  /** A repository with a committed baseline (app.ts, legacy.ts), then app.ts changed and added.ts created. */
  async function changedRepository(rootPath: string) {
    const directory = join(rootPath, "repo", "payments");
    await mkdir(directory, { recursive: true });
    const git = async (...args: string[]) => (await execFile("git", ["-C", directory, ...args], { encoding: "utf8" })).stdout.trim();
    await git("init", "--quiet"); await git("config", "user.email", "r@example.invalid"); await git("config", "user.name", "R");
    await writeFile(join(directory, "app.ts"), "export const value = 1;\n");
    await writeFile(join(directory, "legacy.ts"), "export const legacy = eval;\n");
    await git("add", "app.ts", "legacy.ts"); await git("commit", "--quiet", "-m", "baseline");
    const base = await git("rev-parse", "HEAD");
    await writeFile(join(directory, "app.ts"), "export const value = 2;\n");
    await writeFile(join(directory, "added.ts"), "export const added = true;\n");
    return { directory, base, git };
  }

  it("shows each reviewer the exact base-to-candidate diff and asks it to classify findings by origin", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "agentx-review-diff-"));
    const directory = join(rootPath, "repo", "payments");
    await mkdir(directory, { recursive: true });
    const git = async (...args: string[]) => (await execFile("git", ["-C", directory, ...args], { encoding: "utf8" })).stdout.trim();
    await git("init", "--quiet"); await git("config", "user.email", "r@example.invalid"); await git("config", "user.name", "R");
    await writeFile(join(directory, "app.ts"), "export const value = 1;\n"); await git("add", "app.ts"); await git("commit", "--quiet", "-m", "baseline");
    const base = await git("rev-parse", "HEAD");
    await writeFile(join(directory, "app.ts"), "export const value = 2;\n");
    await writeFile(join(directory, "added.ts"), "export const added = true;\n");
    const { readCandidateRepositories } = await import("../../packages/worker/src/verification/candidate.js");
    const repositories = [{ repositoryId: "payments", directory }];
    const candidate = await readCandidateRepositories([{ ...repositories[0]!, baseCommitSha: base }]);
    const prompts: string[] = [];
    try {
      await runWorkflowReviews({ operationId: randomUUID(), rootPath, model: { provider: "test", modelId: "review-v1" }, candidate, repositories, piAdapter: reviewerAdapter(async (_input, text) => { prompts.push(text); }) });
      expect(prompts[0]).toContain("Review role: CODE");
      expect(prompts[1]).toContain("Review role: SECURITY");
      for (const prompt of prompts.slice(0, 2)) {
        expect(prompt).toContain("diff --git a/app.ts b/app.ts");
        expect(prompt).toContain("+export const value = 2;");
        expect(prompt).toContain("added.ts");
        expect(prompt).toMatch(/INTRODUCED[\s\S]*PRE_EXISTING/);
      }
    } finally { await rm(rootPath, { recursive: true, force: true }); }
  });

  it("records in each report when the change was too large to show the reviewer in full, and only then", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "agentx-review-partial-"));
    try {
      const { directory, base } = await changedRepository(rootPath);
      const { readCandidateRepositories } = await import("../../packages/worker/src/verification/candidate.js");
      const repositories = [{ repositoryId: "payments", directory }];
      const run = async () => runWorkflowReviews({ operationId: randomUUID(), rootPath, model: { provider: "test", modelId: "review-v1" },
        candidate: await readCandidateRepositories([{ ...repositories[0]!, baseCommitSha: base }]), repositories, piAdapter: reviewerAdapter(async () => undefined) });
      expect((await run()).map((report) => report.partialDiff)).toEqual([undefined, undefined]);
      await writeFile(join(directory, "big.txt"), `${"x".repeat(100)}\n`.repeat(2_000));
      expect((await run()).map((report) => report.partialDiff)).toEqual([true, true]);
    } finally { await rm(rootPath, { recursive: true, force: true }); }
  });

  it("reports BASE_UNAVAILABLE instead of reviewing without a recorded base", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "agentx-review-no-base-"));
    const directory = join(rootPath, "repo", "payments");
    await mkdir(directory, { recursive: true });
    const git = async (...args: string[]) => (await execFile("git", ["-C", directory, ...args], { encoding: "utf8" })).stdout.trim();
    await git("init", "--quiet"); await git("config", "user.email", "r@example.invalid"); await git("config", "user.name", "R");
    await writeFile(join(directory, "app.ts"), "export const value = 1;\n"); await git("add", "app.ts"); await git("commit", "--quiet", "-m", "baseline");
    await writeFile(join(directory, "app.ts"), "export const value = 2;\n");
    await writeFile(join(directory, "added.ts"), "export const added = true;\n");
    const { readCandidateRepositories } = await import("../../packages/worker/src/verification/candidate.js");
    const repositories = [{ repositoryId: "payments", directory }];
    const candidate = await readCandidateRepositories(repositories);
    const prompts: string[] = [];
    const operationId = randomUUID();
    try {
      const reports = await runWorkflowReviews({ operationId, rootPath, model: { provider: "test", modelId: "review-v1" }, candidate, repositories, piAdapter: reviewerAdapter(async (_input, text) => { prompts.push(text); }) });
      expect(reports.map(({ role, status, failureReason }) => ({ role, status, failureReason }))).toEqual([
        { role: "CRITIC", status: "UNKNOWN", failureReason: "BASE_UNAVAILABLE" },
        { role: "SECURITY", status: "UNKNOWN", failureReason: "BASE_UNAVAILABLE" },
      ]);
      expect(reports.every((report) => report.operationId === operationId && report.findings.length === 0)).toBe(true);
      expect(prompts).toEqual([]);
    } finally { await rm(rootPath, { recursive: true, force: true }); }
  });

  it("blocks on a pre-existing label it cannot confirm and keeps one in an untouched file advisory", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "agentx-review-origin-"));
    try {
      const { directory, base } = await changedRepository(rootPath);
      const { readCandidateRepositories } = await import("../../packages/worker/src/verification/candidate.js");
      const repositories = [{ repositoryId: "payments", directory }];
      const candidate = await readCandidateRepositories([{ ...repositories[0]!, baseCommitSha: base }]);
      const run = async (finding: Record<string, unknown>) => runWorkflowReviews({ operationId: randomUUID(), rootPath,
        model: { provider: "test", modelId: "review-v1" }, candidate, repositories,
        piAdapter: answeringAdapter([], () => JSON.stringify({ findings: [finding] })) });
      const advisory = { text: "Legacy export uses eval", origin: "PRE_EXISTING", file: "legacy.ts", line: 1 };
      expect((await run(advisory)).map(({ status, findings }) => ({ status, findings }))).toEqual([
        { status: "PASS", findings: [advisory] }, { status: "PASS", findings: [advisory] },
      ]);
      for (const finding of [
        { text: "Value changed without a test", origin: "PRE_EXISTING" },
        { text: "Value changed without a test", origin: "PRE_EXISTING", file: "app.ts", line: 1 },
        { text: "Added flag is never read", origin: "PRE_EXISTING", file: "payments/added.ts" },
        { text: "Escapes the repository", origin: "PRE_EXISTING", file: "../legacy.ts" },
      ]) {
        const reports = await run(finding);
        expect(reports.map((report) => report.status)).toEqual(["FINDINGS", "FINDINGS"]);
        expect(reports[0]?.findings[0]?.origin).toBe("INTRODUCED");
      }
    } finally { await rm(rootPath, { recursive: true, force: true }); }
  });

  it("asks a prose reviewer again for the structured finding shape", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "agentx-review-retry-shape-"));
    try {
      const { directory, base } = await changedRepository(rootPath);
      const { readCandidateRepositories } = await import("../../packages/worker/src/verification/candidate.js");
      const repositories = [{ repositoryId: "payments", directory }];
      const candidate = await readCandidateRepositories([{ ...repositories[0]!, baseCommitSha: base }]);
      const prompts: string[] = [];
      const reports = await runWorkflowReviews({ operationId: randomUUID(), rootPath, model: { provider: "test", modelId: "review-v1" }, candidate, repositories,
        piAdapter: answeringAdapter(prompts, (text) => text.startsWith("Your previous response")
          ? JSON.stringify({ findings: [{ text: "Value changed without a test", origin: "INTRODUCED", severity: "LOW", file: "app.ts", line: 1 }] })
          : "Looks fine to me.") });
      expect(prompts).toHaveLength(4);
      expect(prompts[1]).toContain('"origin":"INTRODUCED"|"PRE_EXISTING"');
      expect(reports.map((report) => report.status)).toEqual(["FINDINGS", "FINDINGS"]);
    } finally { await rm(rootPath, { recursive: true, force: true }); }
  });

  it("reads each changed file's status and changed new-side lines, so only issues the change causes block", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "agentx-review-hunks-"));
    try {
      const directory = join(rootPath, "repo", "payments");
      await mkdir(directory, { recursive: true });
      const git = async (...args: string[]) => (await execFile("git", ["-C", directory, ...args], { encoding: "utf8" })).stdout.trim();
      await git("init", "--quiet"); await git("config", "user.email", "r@example.invalid"); await git("config", "user.name", "R");
      const lines = (count: number, edit: (index: number) => string | undefined = (index) => `line ${index}`) =>
        `${Array.from({ length: count }, (_, index) => edit(index + 1)).filter((entry) => entry !== undefined).join("\n")}\n`;
      await writeFile(join(directory, "lib.ts"), lines(20));
      await writeFile(join(directory, "old.ts"), lines(12, (index) => `export const keep${index} = ${index};`));
      await writeFile(join(directory, "gone.ts"), "export const gone = true;\n");
      await git("add", "."); await git("commit", "--quiet", "-m", "baseline");
      const base = await git("rev-parse", "HEAD");
      // lib.ts: line 5 rewritten, old lines 12 and 13 removed (a pure deletion between new lines 11 and 12).
      await writeFile(join(directory, "lib.ts"), lines(20, (index) => index === 5 ? "line five" : index === 12 || index === 13 ? undefined : `line ${index}`));
      await writeFile(join(directory, "new.ts"), "export const fresh = 1;\n");
      await rm(join(directory, "gone.ts"));
      await execFile("git", ["-C", directory, "mv", "old.ts", "moved.ts"]);
      const { readCandidateRepositories } = await import("../../packages/worker/src/verification/candidate.js");
      const [identity] = await readCandidateRepositories([{ repositoryId: "payments", directory, baseCommitSha: base }]);
      const changes = await candidateChanges({ directory, baseCommitSha: base, treeSha: identity!.treeSha });
      expect(changes).toEqual([
        { path: "gone.ts", status: "DELETED", hunks: [[1, 1]] },
        { path: "lib.ts", status: "MODIFIED", hunks: [[5, 5], [11, 12]] },
        // A rename Git detects is a modification at the new path; an unchanged rename has no changed lines.
        { path: "moved.ts", status: "MODIFIED", hunks: [] },
        { path: "new.ts", status: "ADDED", hunks: [[1, 1]] },
      ]);
      const old = { text: "Old issue", origin: "PRE_EXISTING" as const };
      const origin = (file: string, line?: number) => reclassifyFinding({ ...old, file, ...(line === undefined ? {} : { line }) }, changes).origin;
      expect(origin("new.ts", 1)).toBe("INTRODUCED"); // added file
      expect(origin("lib.ts", 5)).toBe("INTRODUCED"); // modified, in a hunk
      expect(origin("lib.ts", 11)).toBe("INTRODUCED"); // the new-side lines next to removed lines
      expect(origin("lib.ts", 12)).toBe("INTRODUCED");
      expect(origin("lib.ts")).toBe("INTRODUCED"); // modified, no line
      expect(origin("lib.ts", 2)).toBe("PRE_EXISTING"); // modified, outside every hunk
      expect(origin("lib.ts", 15)).toBe("PRE_EXISTING");
      expect(origin("moved.ts", 3)).toBe("PRE_EXISTING"); // renamed without a content change
      // The same rules end to end: a reviewer's out-of-hunk label passes, an in-hunk one blocks.
      const run = async (finding: Record<string, unknown>) => (await runWorkflowReviews({ operationId: randomUUID(), rootPath,
        model: { provider: "test", modelId: "review-v1" }, candidate: [identity!], repositories: [{ repositoryId: "payments", directory }],
        piAdapter: answeringAdapter([], () => JSON.stringify({ findings: [finding] })) })).map((report) => report.status);
      expect(await run({ ...old, file: "lib.ts", line: 2 })).toEqual(["PASS", "PASS"]);
      expect(await run({ ...old, file: "lib.ts", line: 5 })).toEqual(["FINDINGS", "FINDINGS"]);
    } finally { await rm(rootPath, { recursive: true, force: true }); }
  });

  it("shows and places every changed line even when the agent marks files binary through attributes", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "agentx-review-attributes-"));
    try {
      const { directory, base, git } = await changedRepository(rootPath);
      const { readCandidateRepositories } = await import("../../packages/worker/src/verification/candidate.js");
      const check = async () => {
        const [identity] = await readCandidateRepositories([{ repositoryId: "payments", directory, baseCommitSha: base }]);
        const objects = { directory, baseCommitSha: base, treeSha: identity!.treeSha };
        const diff = await candidateDiff({ ...objects, maxBytes: 1_000_000 });
        expect(diff.text).toContain("+export const value = 2;");
        expect(diff.text).not.toContain("Binary files");
        expect((await candidateChanges(objects)).find((change) => change.path === "app.ts")).toEqual({ path: "app.ts", status: "MODIFIED", hunks: [[1, 1]] });
      };
      // Outside the checked tree: .git/info/attributes.
      await writeFile(join(directory, ".git", "info", "attributes"), "* -diff\n");
      await check();
      await rm(join(directory, ".git", "info", "attributes"));
      // A committed-style .gitattributes naming a diff driver the repository config marks binary.
      await writeFile(join(directory, ".gitattributes"), "*.ts diff=x\n");
      await git("config", "diff.x.binary", "true");
      await check();
    } finally { await rm(rootPath, { recursive: true, force: true }); }
  });

  it("fails closed on lines it cannot place: binary patches, unpaired headers and a cut patch", () => {
    const names = ["M", "a.ts", "M", "b.ts", "M", "c.ts", ""].join("\0");
    const header = (path: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}`;
    const patch = [header("a.ts"), "@@ -3 +3 @@", "-x", "+y", header("b.ts"), "Binary files a/b.ts and b/b.ts differ", header("c.ts"), "@@ -9,2 +8,0 @@", "-z", "-w"].join("\n");
    expect(parseCandidateChanges(names, patch, false)).toEqual([
      { path: "a.ts", status: "MODIFIED", hunks: [[3, 3]] },
      { path: "b.ts", status: "UNPLACEABLE", hunks: [] },
      { path: "c.ts", status: "MODIFIED", hunks: [[8, 9]] },
    ]);
    // One header too few: no file can be trusted to own its hunks.
    expect(parseCandidateChanges(names, [header("a.ts"), "@@ -3 +3 @@", header("c.ts")].join("\n"), false).map((change) => change.status))
      .toEqual(["UNPLACEABLE", "UNPLACEABLE", "UNPLACEABLE"]);
    // Cut inside b.ts: a.ts was read whole, b.ts and c.ts were not.
    expect(parseCandidateChanges(names, [header("a.ts"), "@@ -3 +3 @@", header("b.ts"), "@@ -1"].join("\n"), true).map((change) => change.status))
      .toEqual(["MODIFIED", "UNPLACEABLE", "UNPLACEABLE"]);
  });

  it("pairs a file-to-symlink type change, which Git prints as two headers, and cannot place lines in it", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "agentx-review-typechange-"));
    try {
      const { directory, base } = await changedRepository(rootPath);
      await rm(join(directory, "legacy.ts"));
      await symlink("app.ts", join(directory, "legacy.ts"));
      await writeFile(join(directory, "zz.ts"), "export const last = 1;\n");
      const { readCandidateRepositories } = await import("../../packages/worker/src/verification/candidate.js");
      const [identity] = await readCandidateRepositories([{ repositoryId: "payments", directory, baseCommitSha: base }]);
      expect(await candidateChanges({ directory, baseCommitSha: base, treeSha: identity!.treeSha })).toEqual([
        { path: "added.ts", status: "ADDED", hunks: [[1, 1]] },
        { path: "app.ts", status: "MODIFIED", hunks: [[1, 1]] },
        // One hunk from each of its two headers (the deletion and the addition).
        { path: "legacy.ts", status: "UNPLACEABLE", hunks: [[1, 1], [1, 1]] },
        { path: "zz.ts", status: "ADDED", hunks: [[1, 1]] },
      ]);
      expect(reclassifyFinding({ text: "Old", origin: "PRE_EXISTING", file: "legacy.ts", line: 9 }, [{ path: "legacy.ts", status: "UNPLACEABLE", hunks: [] }]).origin).toBe("INTRODUCED");
    } finally { await rm(rootPath, { recursive: true, force: true }); }
  });

  it("reviews a change larger than Git's read limit instead of failing it, and names a broken diff apart from a missing base", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "agentx-review-large-"));
    try {
      const { directory, base } = await changedRepository(rootPath);
      await writeFile(join(directory, "package-lock.json"), `${Array.from({ length: 60_000 }, (_, index) => `  "dependency-${index}": "1.0.${index}",`).join("\n")}\n`);
      const { readCandidateRepositories } = await import("../../packages/worker/src/verification/candidate.js");
      const [identity] = await readCandidateRepositories([{ repositoryId: "payments", directory, baseCommitSha: base }]);
      const cut = await candidateDiff({ directory, baseCommitSha: base, treeSha: identity!.treeSha, maxBytes: 1000 });
      expect(cut.truncated).toBe(true);
      expect(cut.text).toContain("[diff cut at");
      const prompts: string[] = [];
      const reports = await runWorkflowReviews({ operationId: randomUUID(), rootPath, model: { provider: "test", modelId: "review-v1" }, candidate: [identity!],
        repositories: [{ repositoryId: "payments", directory }], piAdapter: answeringAdapter(prompts, () => '{"findings":[]}') });
      expect(reports.map((report) => report.status)).toEqual(["PASS", "PASS"]);
      expect(prompts[0]).toContain("[diff cut at");
      // A base the repository does not hold: the diff cannot be read, which is not a missing base.
      const broken = await runWorkflowReviews({ operationId: randomUUID(), rootPath, model: { provider: "test", modelId: "review-v1" },
        candidate: [{ ...identity!, baseCommitSha: "1".repeat(40) }], repositories: [{ repositoryId: "payments", directory }], piAdapter: answeringAdapter([], () => '{"findings":[]}') });
      expect(broken.map(({ status, failureReason }) => [status, failureReason])).toEqual([["UNKNOWN", "DIFF_UNAVAILABLE"], ["UNKNOWN", "DIFF_UNAVAILABLE"]]);
    } finally { await rm(rootPath, { recursive: true, force: true }); }
  });

  it("cuts a long diff on a character boundary and says where it stopped", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "agentx-review-cut-"));
    try {
      const { directory, base, git } = await changedRepository(rootPath);
      await writeFile(join(directory, "big.ts"), `${"é".repeat(5000)}\n`);
      const { readCandidateRepositories } = await import("../../packages/worker/src/verification/candidate.js");
      const [identity] = await readCandidateRepositories([{ repositoryId: "payments", directory, baseCommitSha: base }]);
      const full = await candidateDiff({ directory, baseCommitSha: base, treeSha: identity!.treeSha, maxBytes: 1_000_000 });
      expect(full.truncated).toBe(false);
      expect(full.text).toContain(" 3 files changed");
      const cut = await candidateDiff({ directory, baseCommitSha: base, treeSha: identity!.treeSha, maxBytes: 2048 + 1 });
      expect(cut.truncated).toBe(true);
      expect(cut.text).not.toContain("�");
      expect(cut.text.endsWith("[diff cut at 2 KB; open the listed files to review the rest]\n")).toBe(true);
      expect(Buffer.byteLength(cut.text.split("[diff cut")[0]!, "utf8")).toBeLessThanOrEqual(2049 + 1);
      // A repository diff driver never runs: AgentX's diff stays the raw patch.
      await writeFile(join(directory, ".gitattributes"), "*.ts diff=evil\n");
      await git("config", "diff.evil.textconv", "sh -c 'echo HIJACKED'");
      await git("config", "diff.evil.command", "sh -c 'echo HIJACKED'");
      const [hardened] = await readCandidateRepositories([{ repositoryId: "payments", directory, baseCommitSha: base }]);
      const raw = await candidateDiff({ directory, baseCommitSha: base, treeSha: hardened!.treeSha, maxBytes: 1_000_000 });
      expect(raw.text).toContain("+export const value = 2;");
      expect(raw.text).not.toContain("HIJACKED");
    } finally { await rm(rootPath, { recursive: true, force: true }); }
  });
});
