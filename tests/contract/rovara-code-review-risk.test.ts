// Plan 6 Task 13: the code review of a Rovara Code (version 2) task states a risk level. The reviewer's level is one of three words read from a fixed JSON shape (never free text),
// kept only on the code review of a version 2 task, and it is only one input of the risk level: it can raise the level, never lower it. A version 1 review is exactly as before.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  WORKER_INVOCATION_FEATURES, WorkflowReviewReportSchema, parseWorkflowReviewerResponse, reviewJsonShape,
} from "../../packages/contracts/src/index.js";
import { WorkflowSnapshotSchema, createCandidateManifest, createWorkflowSnapshot, submitWorkflowReview } from "../../packages/contracts/src/task-workflow-node.js";
import { runWorkflowReviews } from "../../packages/worker/src/verification/review.js";
import { WORKER_IMPLEMENTED_FEATURES } from "../../packages/worker/src/implemented-features.js";
import type { PiSessionAdapter } from "../../packages/worker/src/pi-session.js";

const execFile = promisify(execFileCallback);
const now = "2026-10-25T12:00:00.000Z";

describe("a reviewer's answer with a risk level", () => {
  const answer = (body: Record<string, unknown>) => JSON.stringify(body);

  it("reads one of the three words beside the findings, for the code review only when the risk was asked for", () => {
    for (const risk of ["low", "medium", "high"] as const) {
      expect(parseWorkflowReviewerResponse(answer({ findings: [], risk }), { role: "CRITIC", risk: true })).toEqual({ status: "PASS", findings: [], risk });
    }
    const withFinding = parseWorkflowReviewerResponse(answer({ findings: [{ text: "New endpoint skips auth", origin: "INTRODUCED", severity: "HIGH" }], risk: "high" }), { role: "CRITIC", risk: true });
    expect(withFinding).toMatchObject({ status: "FINDINGS", risk: "high" });
  });

  it("a missing level is not a failure: the review stands without one", () => {
    expect(parseWorkflowReviewerResponse(answer({ findings: [] }), { role: "CRITIC", risk: true })).toEqual({ status: "PASS", findings: [] });
  });

  it("anything but the three words fails closed (shape), and so does a risk nobody asked for", () => {
    for (const risk of ["critical", "HIGH", "High", "", " high", 3, null, ["high"], { level: "high" }]) {
      expect(parseWorkflowReviewerResponse(answer({ findings: [], risk }), { role: "CRITIC", risk: true }), String(JSON.stringify(risk))).toEqual({ status: "UNKNOWN", findings: [], failureReason: "INVALID_SHAPE" });
    }
    // Not asked: the answer keeps its one key, as a version 1 review always did.
    expect(parseWorkflowReviewerResponse(answer({ findings: [], risk: "high" }), { role: "CRITIC" })).toEqual({ status: "UNKNOWN", findings: [], failureReason: "INVALID_SHAPE" });
    expect(parseWorkflowReviewerResponse(answer({ findings: [], risk: "high" }))).toEqual({ status: "UNKNOWN", findings: [], failureReason: "INVALID_SHAPE" });
    // The security review states no level.
    expect(parseWorkflowReviewerResponse(answer({ findings: [], risk: "high" }), { role: "SECURITY", risk: true })).toEqual({ status: "UNKNOWN", findings: [], failureReason: "INVALID_SHAPE" });
    // No other key sneaks in beside it.
    expect(parseWorkflowReviewerResponse(answer({ findings: [], risk: "high", note: "x" }), { role: "CRITIC", risk: true })).toEqual({ status: "UNKNOWN", findings: [], failureReason: "INVALID_SHAPE" });
  });

  it("the asked-for shape names the three words for the code review only, and the default shape is unchanged", () => {
    expect(reviewJsonShape("CRITIC", { risk: true })).toContain('"risk":"low"|"medium"|"high"');
    // Blind test 02: a changed response shape was rated "Low" with no word about it. The reviewer is told to count it, and to say so.
    expect(reviewJsonShape("CRITIC", { risk: true })).toMatch(/public API route or the shape of a response that existing callers read/);
    expect(reviewJsonShape("CRITIC", { risk: true })).toMatch(/response shape is at least "medium" even when the plan did not mention it/);
    expect(reviewJsonShape("CRITIC")).not.toMatch(/public API/);
    expect(reviewJsonShape("CRITIC", { risk: true })).toMatch(/risk/i);
    expect(reviewJsonShape("SECURITY", { risk: true })).toBe(reviewJsonShape("SECURITY"));
    expect(reviewJsonShape("CRITIC")).not.toMatch(/risk/i);
    expect(reviewJsonShape("CRITIC", {})).toBe(reviewJsonShape("CRITIC"));
  });
});

describe("the review report", () => {
  const report = (extra: Record<string, unknown>) => ({
    operationId: randomUUID(), candidateDigest: "a".repeat(64), role: "CRITIC", provider: "t", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now, ...extra,
  });

  it("holds a risk level on the code review only, and only one of the three words", () => {
    expect(WorkflowReviewReportSchema.safeParse(report({ risk: "high" })).success).toBe(true);
    expect(WorkflowReviewReportSchema.safeParse(report({})).success).toBe(true);
    expect(WorkflowReviewReportSchema.safeParse(report({ risk: "severe" })).success).toBe(false);
    expect(WorkflowReviewReportSchema.safeParse(report({ role: "SECURITY", risk: "high" })).success).toBe(false);
  });

  it("a stored version 1 snapshot can't hold one", () => {
    const code = createCandidateManifest([{ repositoryId: "payments", commitSha: "1".repeat(40), treeSha: "1".repeat(40), baseCommitSha: "e".repeat(40) }]);
    const withRisk = (definitionVersion: "1.0.0" | "1.1.0") => WorkflowSnapshotSchema.safeParse({
      ...createWorkflowSnapshot({ taskId: "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6", ownerId: "a".repeat(64), now, definitionVersion }),
      stage: "REVIEW", state: "WAITING", candidate: code, reviews: [report({ candidateDigest: code.digest, risk: "high" })],
    }).success;
    expect(withRisk("1.1.0")).toBe(true);
    expect(withRisk("1.0.0")).toBe(false);
  });

  it("is kept on a version 2 task and dropped from a version 1 task when it is recorded", () => {
    const code = createCandidateManifest([{ repositoryId: "payments", commitSha: "1".repeat(40), treeSha: "1".repeat(40), baseCommitSha: "e".repeat(40) }]);
    const at = (definitionVersion: "1.0.0" | "1.1.0") => WorkflowSnapshotSchema.parse({
      ...createWorkflowSnapshot({ taskId: "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6", ownerId: "a".repeat(64), now, definitionVersion }),
      stage: "REVIEW", state: "WAITING", candidate: code,
      verification: { candidateDigest: code.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: now, results: [], reviewOnly: true },
      checkPolicy: { required: [], optional: [], selectedOptionalIds: [], proposed: [], noneReason: "Docs" },
    });
    const incoming = report({ candidateDigest: code.digest, risk: "high" });
    expect(submitWorkflowReview(at("1.1.0"), incoming, now).reviews?.find((review) => review.role === "CRITIC")?.risk).toBe("high");
    expect(submitWorkflowReview(at("1.0.0"), incoming, now).reviews?.find((review) => review.role === "CRITIC")).not.toHaveProperty("risk");
  });
});

describe("the feature", () => {
  it("is known to the contracts and advertised by the worker", () => {
    expect(WORKER_INVOCATION_FEATURES).toContain("task.workflowReviewRisk");
    expect(WORKER_IMPLEMENTED_FEATURES).toContain("task.workflowReviewRisk");
  });
});

describe("the worker's code review", () => {
  async function repository() {
    const rootPath = await mkdtemp(join(tmpdir(), "rovara-risk-review-"));
    const directory = join(rootPath, "repo", "payments");
    await mkdir(directory, { recursive: true });
    const git = async (...args: string[]) => (await execFile("git", ["-C", directory, ...args], { encoding: "utf8" })).stdout.trim();
    await git("init", "--quiet");
    await git("config", "user.email", "review@example.invalid");
    await git("config", "user.name", "Review Test");
    await writeFile(join(directory, "app.ts"), "export const value = 1;\n");
    await git("add", "app.ts");
    await git("commit", "--quiet", "-m", "baseline");
    const baseCommitSha = await git("rev-parse", "HEAD");
    await writeFile(join(directory, "app.ts"), "export const value = 2;\n");
    const { readCandidateRepositories } = await import("../../packages/worker/src/verification/candidate.js");
    const repositories = [{ repositoryId: "payments", directory }];
    const candidate = await readCandidateRepositories([{ ...repositories[0]!, baseCommitSha }]);
    return { rootPath, repositories, candidate };
  }

  /** Each reviewer answers from `answers`; every prompt it is given is recorded by role. */
  function adapter(answers: { CRITIC: string; SECURITY: string }, seen: Array<{ role: "CRITIC" | "SECURITY"; prompt: string }>): PiSessionAdapter {
    return {
      async create(input) {
        const sessionFile = join(input.sessionDirectory, `${input.conversationId}.jsonl`);
        await writeFile(sessionFile, "{}");
        let listener: ((event: unknown) => void) | undefined;
        // One session per reviewer: the role is named in its first prompt, and its format retry goes to the same session.
        let sessionRole: "CRITIC" | "SECURITY" = "SECURITY";
        return {
          conversationId: input.conversationId ?? "review-session", sessionFile,
          async prompt(text) {
            if (text.includes("Review role: CODE")) sessionRole = "CRITIC";
            seen.push({ role: sessionRole, prompt: text });
            listener?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: answers[sessionRole] }] } });
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

  const run = async (reviewRisk: boolean | undefined, answers: { CRITIC: string; SECURITY: string }) => {
    const { rootPath, repositories, candidate } = await repository();
    const seen: Array<{ role: "CRITIC" | "SECURITY"; prompt: string }> = [];
    try {
      const reports = await runWorkflowReviews({
        ruleFileBaseCommits: [], operationId: "11111111-1111-4111-8111-111111111111", rootPath, model: { provider: "test", modelId: "review-v1" }, candidate, repositories,
        piAdapter: adapter(answers, seen), now: () => now, ...(reviewRisk === undefined ? {} : { reviewRisk }),
      });
      return { reports, seen };
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  };

  it("asks the code reviewer, and only the code reviewer, for a risk level and records the answer", async () => {
    const { reports, seen } = await run(true, { CRITIC: '{"findings":[],"risk":"medium"}', SECURITY: '{"findings":[]}' });
    expect(seen.find((entry) => entry.role === "CRITIC")!.prompt).toContain('"risk":"low"|"medium"|"high"');
    expect(seen.find((entry) => entry.role === "SECURITY")!.prompt).not.toMatch(/"risk"/);
    expect(reports.find((report) => report.role === "CRITIC")).toMatchObject({ status: "PASS", risk: "medium" });
    expect(reports.find((report) => report.role === "SECURITY")).not.toHaveProperty("risk");
  });

  it("a code review that states no level still passes, without one", async () => {
    const { reports } = await run(true, { CRITIC: '{"findings":[]}', SECURITY: '{"findings":[]}' });
    expect(reports.find((report) => report.role === "CRITIC")).toMatchObject({ status: "PASS" });
    expect(reports.find((report) => report.role === "CRITIC")).not.toHaveProperty("risk");
  });

  it("a version 1 review is exactly as before: no risk in the prompt, and an answer with one fails its shape", async () => {
    const { reports, seen } = await run(undefined, { CRITIC: '{"findings":[],"risk":"high"}', SECURITY: '{"findings":[]}' });
    expect(seen.every((entry) => !/risk/i.test(entry.prompt.replace(/Change under review[\s\S]*$/, "")))).toBe(true);
    expect(reports.find((report) => report.role === "CRITIC")).toMatchObject({ status: "UNKNOWN", failureReason: "INVALID_SHAPE" });
    expect(reports.find((report) => report.role === "CRITIC")).not.toHaveProperty("risk");
  });
});
