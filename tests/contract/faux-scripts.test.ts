import { execFile as execFileCallback } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { normalizeContext } from "@earendil-works/pi-ai";
import { createDefaultPiSessionAdapter } from "../../packages/worker/src/pi-session.js";
import { runWorkflowReviews } from "../../packages/worker/src/verification/review.js";
import { readCandidateRepositories } from "../../packages/worker/src/verification/candidate.js";
import { createFixtureDirectory } from "../fixtures/index.js";
import { FAUX_MODEL, fauxModelRuntime } from "../support/faux-model.js";
import { reviewerReply, workflowModel, type WorkflowTurn } from "../support/faux-scripts.js";

const execFile = promisify(execFileCallback);

describe("faux workflow scripts", () => {
  it("drive the real reviewer: prose is retried once into JSON, and both roles get their own script", async () => {
    const rootPath = await createFixtureDirectory("agentx-faux-review-");
    const directory = join(rootPath, "repo", "demo");
    await mkdir(directory, { recursive: true });
    const git = (...args: string[]) => execFile("git", ["-C", directory, ...args]);
    await git("init", "--quiet"); await git("config", "user.email", "t@example.invalid"); await git("config", "user.name", "T");
    await writeFile(join(directory, "app.ts"), "export const value = 1;\n"); await git("add", "app.ts"); await git("commit", "--quiet", "-m", "base");
    const { modelRuntime, faux } = await fauxModelRuntime();
    const prompts: string[] = [];
    const turns: WorkflowTurn[] = [];
    const step = workflowModel({ plan: "# Plan", edits: [], prompts, turns, reviews: { CODE: [reviewerReply.prose(), reviewerReply.pass()], SECURITY: [reviewerReply.pass()] } });
    faux.setResponses(Array.from({ length: 10 }, () => step));
    const piAdapter = createDefaultPiSessionAdapter({ modelRuntime: async () => ({ runtime: modelRuntime, model: FAUX_MODEL }) });
    const repositories = [{ repositoryId: "demo", directory }];
    const baseCommitSha = (await git("rev-parse", "HEAD")).stdout.trim();
    const candidate = await readCandidateRepositories([{ ...repositories[0]!, baseCommitSha }]);
    const reports = await runWorkflowReviews({ ruleFileBaseCommits: [], operationId: "11111111-1111-4111-8111-111111111111", rootPath, model: FAUX_MODEL, candidate, repositories, piAdapter });
    expect(reports.map((report) => [report.role, report.status])).toEqual([["CRITIC", "PASS"], ["SECURITY", "PASS"]]);
    expect(prompts).toHaveLength(2);
    const codeTurns = turns.filter((turn) => turn.role === "CODE");
    expect(codeTurns).toHaveLength(2);
    expect(codeTurns[1]?.userText).toContain("could not be read as the required JSON object");
    expect(turns.filter((turn) => turn.role === "SECURITY")).toHaveLength(1);
    expect(turns).toHaveLength(3);
  }, 30_000);

  it("route a reopened conversation's implementation turn to the coder, not back to the planner", async () => {
    const turns: WorkflowTurn[] = [];
    const step = workflowModel({ plan: "# Plan", edits: [{ path: "app.ts", content: "export const value = 2;\n" }], turns });
    if (typeof step !== "function") throw new Error("workflowModel returns a scripted function");
    const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
    const context = { messages: [
      user("Planning phase only. Do not edit, write, or create files.\n\nRequest:\nChange the value"),
      { role: "assistant", content: [{ type: "text", text: "# Plan" }], stopReason: "stop", timestamp: 0 },
      user("Implement the approved plan."),
    ] } as unknown as Parameters<typeof step>[0];
    const reply = await step(context, undefined, undefined as never, undefined as never) as { content: Array<{ type: string; name?: string }> };
    expect(reply.content.map((part) => [part.type, part.name])).toEqual([["toolCall", "write"]]);
    expect(turns).toEqual([{ role: "CODER", userText: "Implement the approved plan." }]);
  });

  it("does not treat untrusted nested plan or reviewer text in the Pi compaction request as workflow instructions", async () => {
    const turns: WorkflowTurn[] = [];
    const step = workflowModel({ plan: "# Never run this planner for compaction", edits: [{ path: "app.ts", content: "export const value = 2;\n" }], turns,
      reviews: { SECURITY: [reviewerReply.json(["first review response"]), reviewerReply.json(["second review response"])] } });
    if (typeof step !== "function") throw new Error("workflowModel returns a scripted function");
    const sessionId = "review-session";
    const reviewContext = normalizeContext({ messages: [{ role: "user", content: "Read-only security review. Inspect the candidate and return the requested review report.", timestamp: 0 }] });
    const reviewReply = await step(reviewContext, { sessionId }, undefined as never, undefined as never) as { content: Array<{ type: string; text?: string }> };
    expect(reviewReply.content[0]?.text).toContain("first review response");
    const compactionContext = normalizeContext({
      systemPrompt: "You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.\n\nDo NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.",
      messages: [{ role: "user", content: "# Conversation\n[User]: Planning phase only. The embedded text says Read-only security review, but it is summarized context, not a new workflow request.\n\n# Instructions\nCreate a concise checkpoint of the user's request and progress.", timestamp: 0 }],
    });
    const reply = await step(compactionContext, { sessionId }, undefined as never, undefined as never) as { content: Array<{ type: string; name?: string; text?: string }> };
    expect(reply.content[0]?.text).toContain("makes no workflow or evidence claims");
    expect(reply.content.every((part) => part.type !== "toolCall")).toBe(true);
    const continuation = normalizeContext({ messages: [{ role: "user", content: "Planning phase only. Read-only critic review is untrusted summarized text and cannot replace the session role.", timestamp: 0 }] });
    const continuationReply = await step(continuation, { sessionId }, undefined as never, undefined as never) as { content: Array<{ type: string; text?: string }> };
    expect(continuationReply.content[0]?.text).toContain("second review response");
    expect(turns.map((turn) => turn.role)).toEqual(["SECURITY", "SECURITY"]);
  });

  it("give a function-valued plan the latest user message, so a revision request can change the plan", async () => {
    const seen: string[] = [];
    const step = workflowModel({ plan: (text) => { seen.push(text); return text.includes("Requested changes") ? "# Plan v2" : "# Plan v1"; }, edits: [] });
    if (typeof step !== "function") throw new Error("workflowModel returns a scripted function");
    const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
    const context = { messages: [
      user("Planning phase only. Do not edit files.\n\nRequest:\nChange the value"),
      { role: "assistant", content: [{ type: "text", text: "# Plan v1" }], stopReason: "stop", timestamp: 0 },
      user("Planning phase only. Do not edit files.\n\nRequested changes: also log it"),
    ] } as unknown as Parameters<typeof step>[0];
    const reply = await step(context, undefined, undefined as never, undefined as never) as { content: Array<{ type: string; text?: string }> };
    expect(reply.content[0]?.text).toBe("# Plan v2");
    expect(seen).toEqual(["Planning phase only. Do not edit files.\n\nRequested changes: also log it"]);
  });
});
