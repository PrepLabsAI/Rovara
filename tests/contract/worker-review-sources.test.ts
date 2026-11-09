// Lane E, task E5: a review that has the project's sources. Each reviewer is given the source tools (the reviewer sessions are Review sessions), the prompt says a source
// never shows a change is right, and a finding that cites a source and no code is advisory: it cannot block the change.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { ContextToolCatalog } from "../../packages/contracts/src/index.js";
import { createContextTools } from "../../packages/worker/src/context-sources/bridge.js";
import { runWorkflowReviews } from "../../packages/worker/src/verification/review.js";
import type { PiSessionAdapter, PiSessionInput } from "../../packages/worker/src/pi-session.js";

const execFile = promisify(execFileCallback);
const now = "2026-10-25T12:00:00.000Z";
const catalog: ContextToolCatalog = {
  sources: [{ sourceId: "sim", label: "SIM", quotes: "citations_only" }],
  tools: [{ name: "src_sim_get_ticket", sourceId: "sim", upstreamName: "get_ticket", role: "read", description: "d", inputSchema: { type: "object", properties: { id: { type: "string" } } } }],
  searchTeamKnowledge: false, unavailable: [], disabled: [],
};

async function repository() {
  const rootPath = await mkdtemp(join(tmpdir(), "rovara-source-review-"));
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
  return { rootPath, repositories, candidate: await readCandidateRepositories([{ ...repositories[0]!, baseCommitSha }]) };
}

function adapter(answer: string, created: PiSessionInput[], prompts: string[]): PiSessionAdapter {
  return {
    async create(input) {
      created.push(input);
      const sessionFile = join(input.sessionDirectory, `${input.conversationId}.jsonl`);
      await writeFile(sessionFile, "{}");
      let listener: ((event: unknown) => void) | undefined;
      return {
        conversationId: input.conversationId ?? "review-session", sessionFile,
        async prompt(text) { prompts.push(text); listener?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: answer }] } }); },
        async abort() {}, getModel: () => ({ provider: "test", modelId: "review-v1" }),
        getSessionStats: () => ({ tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 } as never),
        subscribe(callback) { listener = callback; return () => { listener = undefined; }; }, dispose() {},
      };
    },
  };
}

describe("a review with sources", () => {
  const sources = () => ({
    tools: createContextTools(catalog, async () => ({ status: "OK", text: "x" }), { workspaceId: "ws", conversationId: "c", operationId: "op" }),
    note: "Sources note.", labels: [{ label: "SIM" }],
  });
  async function review(answer: string, withSources: boolean) {
    const { rootPath, repositories, candidate } = await repository();
    const created: PiSessionInput[] = [];
    const prompts: string[] = [];
    try {
      const reports = await runWorkflowReviews({
        ruleFileBaseCommits: [], operationId: "11111111-1111-4111-8111-111111111111", rootPath, model: { provider: "test", modelId: "review-v1" }, candidate, repositories,
        piAdapter: adapter(answer, created, prompts), now: () => now, ...(withSources ? { sources: sources() } : {}),
      });
      return { reports, created, prompts };
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  }

  it("gives both reviewers the source tools and the rule that a source never shows a change is right", async () => {
    const { created, prompts } = await review('{"findings":[]}', true);
    expect(created).toHaveLength(2);
    expect(created.every((input) => input.workflowMode === "REVIEW" && input.contextTools?.map((tool) => tool.name).join() === "src_sim_get_ticket")).toBe(true);
    expect(prompts.every((prompt) => prompt.includes("They never show that it is right"))).toBe(true);
  });
  it("makes a finding that cites a source and no file advisory, and leaves a finding with a file as it is", async () => {
    const answer = JSON.stringify({ findings: [
      { text: "The ticket [SIM P1] wants a limit of 3 and none is set.", origin: "INTRODUCED", severity: "HIGH" },
      { text: "No limit in the retry loop, see [SIM P1].", origin: "INTRODUCED", severity: "HIGH", file: "app.ts", line: 1 },
    ] });
    const { reports } = await review(answer, true);
    const critic = reports.find((report) => report.role === "CRITIC")!;
    expect(critic.findings.map((finding) => [finding.advisory === true, finding.file])).toEqual([[true, undefined], [false, "app.ts"]].map(([advisory, file]) => [advisory, file]));
    expect(critic.findings[0]!.text).toContain("does not block");
  });
  it("is exactly as before without sources: no source tools, no new prompt line, and a finding is not changed", async () => {
    const answer = JSON.stringify({ findings: [{ text: "The ticket [SIM P1] wants a limit of 3 and none is set.", origin: "INTRODUCED", severity: "HIGH" }] });
    const { reports, created, prompts } = await review(answer, false);
    expect(created.every((input) => input.contextTools === undefined)).toBe(true);
    expect(prompts.some((prompt) => prompt.includes("They never show that it is right"))).toBe(false);
    expect(reports.find((report) => report.role === "CRITIC")!.findings[0]).not.toHaveProperty("advisory", true);
  });
});
