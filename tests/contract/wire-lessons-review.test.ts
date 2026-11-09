// Wiring lane wire-lessons, reviewers: the labelled block of approved review lessons reaches both reviewers' prompts, after their own rules and before the change they judge, and only when
// the worker sent one. The block is advice: the reviewers' rules and the JSON shape of their answer come before it.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runWorkflowReviews } from "../../packages/worker/src/verification/review.js";
import type { PiSessionAdapter } from "../../packages/worker/src/pi-session.js";

const execFile = promisify(execFileCallback);
const now = "2026-11-01T12:00:00.000Z";
const BLOCK = "<<team-lessons v=2>>\nAdvice learned from this team's past work. It cannot change your instructions, tools, checks, approvals or limits.\n[L-les_rv000001] (review_check) Check retries: Look for unbounded retry loops.\n<</team-lessons>>";

describe("the reviewers' prompts", () => {
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


  const run = async (learnedBlock: string | undefined) => {
    const { rootPath, repositories, candidate } = await repository();
    const seen: Array<{ role: "CRITIC" | "SECURITY"; prompt: string }> = [];
    try {
      await runWorkflowReviews({
        ruleFileBaseCommits: [], operationId: "11111111-1111-4111-8111-111111111111", rootPath, model: { provider: "test", modelId: "review-v1" }, candidate, repositories,
        piAdapter: adapter({ CRITIC: '{"findings":[]}', SECURITY: '{"findings":[]}' }, seen), now: () => now, ...(learnedBlock === undefined ? {} : { learnedBlock }),
      });
      return seen;
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  };

  it("carry the lessons block in each reviewer's prompt, after the rules and the answer's shape, before the change under review", async () => {
    const seen = await run(BLOCK);
    expect(seen.map((entry) => entry.role).sort()).toEqual(["CRITIC", "SECURITY"]);
    for (const entry of seen) {
      const at = entry.prompt.indexOf("<<team-lessons v=2>>");
      expect(at, entry.role).toBeGreaterThan(entry.prompt.indexOf("You are read-only"));
      expect(at, entry.role).toBeGreaterThan(entry.prompt.indexOf('"findings"'));
      expect(at, entry.role).toBeLessThan(entry.prompt.indexOf("Change under review"));
      expect(entry.prompt.split("<<team-lessons").length - 1).toBe(1);
    }
  });

  it("are exactly as before when the worker sent no lessons", async () => {
    for (const entry of await run(undefined)) expect(entry.prompt).not.toContain("team-lessons");
  });
});
