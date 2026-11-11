// Standing instructions on the worker: the broker-built block is placed in the SYSTEM prompt, after AgentX's own prompt and preamble and before the repository's context files
// and the skills list, for coding steps, the reviewers (the second reviewer included) and agent steps; and it is untouched (golden) when no block is sent.
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fauxAssistantMessage, getCurrentSystemPrompt, type TranscriptContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AGENTX_PREAMBLE, AGENTX_WORKER_PROMPT, AGENT_STEP_PREAMBLE, STANDING_INSTRUCTIONS_FEATURE, WORKER_INVOCATION_FEATURES } from "../../packages/contracts/src/index.js";
import { READ_ONLY_TOOLS } from "@agentx/contracts";
import { DESIGN_REVIEW_MAX_OUTPUT_TOKENS, createReviewSessionOpener } from "../../packages/worker/src/design-review-sessions.js";
import { agentStepSystemPrompt } from "../../packages/worker/src/agent-run/run-agent-step.js";
import { materializeSkills, skillsPromptSection, type AgentSkillFile } from "../../packages/worker/src/agent-step.js";
import { WORKER_IMPLEMENTED_FEATURES } from "../../packages/worker/src/implemented-features.js";
import { createDefaultPiSessionAdapter, createWorkerResources, createWorkspacePiSession, type PiSessionAdapter, type PiSessionInput } from "../../packages/worker/src/pi-session.js";
import { readCandidateRepositories } from "../../packages/worker/src/verification/candidate.js";
import { runWorkflowReviews } from "../../packages/worker/src/verification/review.js";
import { FAUX_MODEL, fauxModelRuntime } from "../support/faux-model.js";

const execFile = promisify(execFileCallback);
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const STANDING = "Standing instructions. HIGHER-WINS.\n\n1. Company rules\nRequired:\n- Never log customer data.";
const COMPANY_ONLY = "Standing instructions. HIGHER-WINS.\n\n1. Company rules\nRequired:\n- Never log customer data.";
const FULL = `${STANDING}\n\n2. How we work\nFrom web process:\nStep-level rule.`;
const CONTENT = "---\nname: payments-style\ndescription: How we write payment code.\n---\n\nAlways use integer cents.\n";
const skill = (): AgentSkillFile => ({ name: "payments-style", description: "How we write payment code.", content: CONTENT, digest: sha256(CONTENT) });

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function temp(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(path);
  return path;
}

describe("the feature", () => {
  it("is listed by the contracts and implemented by this worker, so an older worker is refused the step", () => {
    expect(STANDING_INSTRUCTIONS_FEATURE).toBe("task.standingInstructions.v1");
    expect(WORKER_INVOCATION_FEATURES).toContain(STANDING_INSTRUCTIONS_FEATURE);
    expect(WORKER_IMPLEMENTED_FEATURES).toContain(STANDING_INSTRUCTIONS_FEATURE);
  });
});

describe("createWorkerResources: a coding step's system prompt", () => {
  async function resources(extra: { standingInstructions?: string; withSkill?: boolean; systemPrompt?: string } = {}) {
    const cwd = await temp("agentx-standing-cwd-");
    const agentDirectory = await temp("agentx-standing-agent-");
    const loadedSkills = extra.withSkill === true ? await materializeSkills(agentDirectory, [skill()]) : [];
    const { resourceLoader } = await createWorkerResources({
      cwd, agentDirectory, contextFiles: [{ path: "AGENTS.md", content: "REPO-RULES" }], loadedSkills,
      ...(extra.standingInstructions === undefined ? {} : { standingInstructions: extra.standingInstructions }),
      ...(extra.systemPrompt === undefined ? {} : { systemPrompt: extra.systemPrompt }),
    });
    return { resourceLoader, loadedSkills };
  }

  it("with no block it is exactly what it was: the worker prompt, then the skills list; the preamble alone as the addendum", async () => {
    const { resourceLoader, loadedSkills } = await resources({ withSkill: true });
    expect(resourceLoader.getSystemPrompt()).toBe(`${AGENTX_WORKER_PROMPT}\n\n${skillsPromptSection(loadedSkills)}`);
    expect(resourceLoader.getAppendSystemPrompt()).toEqual([AGENTX_PREAMBLE]);
    expect((await resources()).resourceLoader.getAppendSystemPrompt()).toEqual([AGENTX_PREAMBLE]);
  });

  it("with a block it follows the preamble in the addendum, and the skills list moves after it", async () => {
    const { resourceLoader, loadedSkills } = await resources({ standingInstructions: STANDING, withSkill: true });
    expect(resourceLoader.getSystemPrompt()).toBe(AGENTX_WORKER_PROMPT);
    expect(resourceLoader.getAppendSystemPrompt()).toEqual([AGENTX_PREAMBLE, STANDING, skillsPromptSection(loadedSkills)]);
    expect((await resources({ standingInstructions: STANDING })).resourceLoader.getAppendSystemPrompt()).toEqual([AGENTX_PREAMBLE, STANDING]);
  });

  it("an empty block is no block", async () => {
    expect((await resources({ standingInstructions: "" })).resourceLoader.getAppendSystemPrompt()).toEqual([AGENTX_PREAMBLE]);
  });

  it("a session with its own system prompt (an agent step) does not add the block again: the step builds it into its prompt", async () => {
    const { resourceLoader } = await resources({ standingInstructions: STANDING, systemPrompt: "OWN PROMPT" });
    expect(resourceLoader.getSystemPrompt()).toBe("OWN PROMPT");
    expect(resourceLoader.getAppendSystemPrompt()).toEqual([]);
  });
});

describe("what the model is sent (the real session on the faux model)", () => {
  const modelSystem = (context: TranscriptContext): string => getCurrentSystemPrompt(context.messages) ?? "";

  async function systemPromptOf(standingInstructions: string | undefined): Promise<{ system: string; root: string }> {
    const rootPath = await temp("agentx-standing-root-");
    await mkdir(join(rootPath, ".agentx"));
    await mkdir(join(rootPath, "repos/web"), { recursive: true });
    await writeFile(join(rootPath, "repos/web/AGENTS.md"), "REPO-RULES: run npm test.\n");
    await writeFile(join(rootPath, ".agentx/preparation-manifest.json"), JSON.stringify({
      schemaVersion: 2, projectName: "char", projectRevision: 1, repositories: [{ name: "web", path: "repos/web" }], completedSetupSteps: [],
      readinessResults: [], creationIdentity: "fixture", complete: true, updatedAt: new Date().toISOString(),
    }));
    const { modelRuntime, faux } = await fauxModelRuntime();
    const seen: string[] = [];
    faux.setResponses([(context) => { seen.push(modelSystem(context)); return fauxAssistantMessage("Ok."); }]);
    const adapter = createDefaultPiSessionAdapter({ modelRuntime: async () => ({ runtime: modelRuntime, model: FAUX_MODEL }) });
    const handle = await createWorkspacePiSession({ rootPath, model: FAUX_MODEL, skills: [skill()], ...(standingInstructions === undefined ? {} : { standingInstructions }) }, adapter);
    try { await handle.prompt("go"); } finally { handle.dispose(); }
    return { system: seen[0]!, root: await realpath(rootPath) };
  }

  it("orders it: AgentX's worker prompt, the preamble, the block, the repository's files, the cwd; the skills list sits with the block, before the files", async () => {
    const { system } = await systemPromptOf(STANDING);
    const at = (text: string) => system.indexOf(text);
    for (const part of [AGENTX_WORKER_PROMPT, AGENTX_PREAMBLE, STANDING, "<available_skills>", "<project_context>", "REPO-RULES"]) expect(at(part), part.slice(0, 40)).toBeGreaterThanOrEqual(0);
    expect(at(AGENTX_WORKER_PROMPT)).toBe(0);
    expect(at(AGENTX_WORKER_PROMPT)).toBeLessThan(at(AGENTX_PREAMBLE));
    expect(at(AGENTX_PREAMBLE)).toBeLessThan(at(STANDING));
    expect(at(STANDING)).toBeLessThan(at("<available_skills>"));
    expect(at("<available_skills>")).toBeLessThan(at("<project_context>"));
    expect(at(STANDING)).toBeLessThan(at("REPO-RULES"));
    // The preamble and the block share the one addendum section.
    expect(system).toContain(`<addendum>\n${AGENTX_PREAMBLE}\n\n${STANDING}`);
  });

  it("without a block the prompt has no trace of one, and the skills list stays where it always was (before the preamble)", async () => {
    const { system } = await systemPromptOf(undefined);
    expect(system).not.toContain("Standing instructions");
    expect(system.indexOf("<available_skills>")).toBeLessThan(system.indexOf(AGENTX_PREAMBLE));
    expect(system).toContain(`<addendum>\n${AGENTX_PREAMBLE}\n</addendum>`);
  });
});

describe("an agent step's system prompt", () => {
  it("is the preamble, then the block, then the step's own instructions: company rules rank above the agent's instructions", () => {
    expect(agentStepSystemPrompt("Do it.", STANDING)).toBe(`${AGENT_STEP_PREAMBLE}\n\n${STANDING}\n\nDo it.`);
    expect(agentStepSystemPrompt("", STANDING)).toBe(`${AGENT_STEP_PREAMBLE}\n\n${STANDING}`);
  });

  it("is unchanged without a block", () => {
    expect(agentStepSystemPrompt("")).toBe(AGENT_STEP_PREAMBLE);
    expect(agentStepSystemPrompt("  \n")).toBe(AGENT_STEP_PREAMBLE);
    expect(agentStepSystemPrompt("Do it.")).toBe(`${AGENT_STEP_PREAMBLE}\n\nDo it.`);
    expect(agentStepSystemPrompt("Do it.", "  ")).toBe(`${AGENT_STEP_PREAMBLE}\n\nDo it.`);
  });
});

describe("the reviewers", () => {
  const OPERATION = "11111111-1111-4111-8111-111111111111";

  async function fixture() {
    const rootPath = await temp("agentx-standing-review-");
    const directory = join(rootPath, "repo", "payments");
    await mkdir(directory, { recursive: true });
    const git = async (...args: string[]) => (await execFile("git", ["-C", directory, ...args], { encoding: "utf8" })).stdout.trim();
    await git("init", "--quiet");
    await git("config", "user.email", "review@example.invalid");
    await git("config", "user.name", "Review Test");
    await writeFile(join(directory, "app.ts"), "export const value = 1;\n");
    await git("add", "app.ts");
    await git("commit", "--quiet", "-m", "baseline");
    const base = await git("rev-parse", "HEAD");
    await writeFile(join(directory, "app.ts"), "export const value = 2;\n");
    const repositories = [{ repositoryId: "payments", directory }];
    return { rootPath, repositories, candidate: await readCandidateRepositories([{ ...repositories[0]!, baseCommitSha: base }]) };
  }

  function adapter(inputs: PiSessionInput[]): PiSessionAdapter {
    return {
      async create(input) {
        inputs.push(input);
        const sessionFile = join(input.sessionDirectory, `${input.conversationId}.jsonl`);
        await writeFile(sessionFile, "{}");
        let listener: ((event: unknown) => void) | undefined;
        return {
          conversationId: input.conversationId ?? "review-session", sessionFile,
          async prompt() { listener?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: '{"findings":[]}' }] } }); },
          async abort() {},
          getModel: () => ({ provider: "test", modelId: "review-v1" }),
          getSessionStats: () => ({ tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 } as never),
          subscribe(callback) { listener = callback; return () => { listener = undefined; }; },
          dispose() {},
        };
      },
    };
  }

  it("gives the code and the security reviewer the block in their system prompt, and no block when none is sent", async () => {
    const { rootPath, repositories, candidate } = await fixture();
    const withBlock: PiSessionInput[] = [];
    await runWorkflowReviews({ ruleFileBaseCommits: [], operationId: OPERATION, rootPath, model: { provider: "test", modelId: "review-v1" }, candidate, repositories, piAdapter: adapter(withBlock), standingInstructions: STANDING });
    expect(withBlock.map((input) => input.standingInstructions)).toEqual([STANDING, STANDING]);
    const without: PiSessionInput[] = [];
    await runWorkflowReviews({ ruleFileBaseCommits: [], operationId: OPERATION, rootPath, model: { provider: "test", modelId: "review-v1" }, candidate, repositories, piAdapter: adapter(without) });
    for (const input of without) expect("standingInstructions" in input).toBe(false);
  });

  it("the second reviewer shown only the change still gets the company's rules and nothing else of the block; shown what the first saw, it gets the whole block", async () => {
    for (const [context, expected] of [["change_only", COMPANY_ONLY], ["same_as_first", FULL]] as const) {
      const { rootPath, repositories, candidate } = await fixture();
      const first: PiSessionInput[] = [];
      const second: PiSessionInput[] = [];
      await runWorkflowReviews({
        ruleFileBaseCommits: [], operationId: OPERATION, rootPath, model: { provider: "test", modelId: "review-v1" }, candidate, repositories, piAdapter: adapter(first),
        standingInstructions: FULL, companyStandingInstructions: COMPANY_ONLY,
        secondReviewer: { candidates: [{ model: { provider: "test", modelId: "second-v1" }, piAdapter: adapter(second) }], context },
      });
      expect(first.map((input) => input.standingInstructions), context).toEqual([FULL, FULL]);
      expect(second.map((input) => input.standingInstructions), context).toEqual([expected]);
    }
  });

  it("a second reviewer with no company part (a block with How we work only) gets no block at all in change_only", async () => {
    const { rootPath, repositories, candidate } = await fixture();
    const second: PiSessionInput[] = [];
    await runWorkflowReviews({
      ruleFileBaseCommits: [], operationId: OPERATION, rootPath, model: { provider: "test", modelId: "review-v1" }, candidate, repositories, piAdapter: adapter([]),
      standingInstructions: "Standing instructions.\n\n1. How we work\nFrom p:\nx",
      secondReviewer: { candidates: [{ model: { provider: "test", modelId: "second-v1" }, piAdapter: adapter(second) }], context: "change_only" },
    });
    expect(second).toHaveLength(1);
    expect("standingInstructions" in second[0]!).toBe(false);
  });
});

describe("the design-review session", () => {
  it("standing instructions: the company's rules follow the role prompt in the system text, so what pi holds still begins with the role prompt; none sent, none added", async () => {
    const dir = await temp("dr-standing-");
    const seen: Array<string | undefined> = [];
    const adapter: PiSessionAdapter = {
      async create(input) {
        seen.push(input.agentRun?.systemPrompt);
        const sessionFile = join(input.sessionDirectory, "f.jsonl");
        await writeFile(sessionFile, "");
        return {
          sessionFile, conversationId: "f", prompt: async () => undefined, abort: async () => undefined, getModel: () => ({ provider: "p", modelId: "m" }),
          getSessionStats: () => ({ sessionFile, sessionId: "f", userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0, totalMessages: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
          subscribe: () => () => undefined, dispose: () => undefined,
        };
      },
    };
    const runtimeFor = () => ({ model: { provider: "p", modelId: "m" }, piAdapter: adapter });
    const open = { purpose: "reviewer" as const, keySlot: "slot-critic", model: { provider: "p", modelId: "m" }, system: "ROLE PROMPT", tools: [...READ_ONLY_TOOLS] };
    (await createReviewSessionOpener({ rootPath: dir, localFileTools: true, runtimeFor, standingInstructions: "STANDING BLOCK" })(open)).dispose();
    (await createReviewSessionOpener({ rootPath: dir, localFileTools: true, runtimeFor })(open)).dispose();
    expect(seen).toEqual(["ROLE PROMPT\n\nSTANDING BLOCK", "ROLE PROMPT"]);
    expect(seen[0]!.startsWith("ROLE PROMPT")).toBe(true);
  });

  it("limits one reviewer turn to 16,000 output tokens, so the broker's worst-case reservation for a call fits the reviewer's key budget", async () => {
    const dir = await temp("dr-limit-");
    const limits: Array<number | undefined> = [];
    const adapter: PiSessionAdapter = {
      async create(input) {
        limits.push(input.maxOutputTokens);
        const sessionFile = join(input.sessionDirectory, "f.jsonl");
        await writeFile(sessionFile, "");
        return {
          sessionFile, conversationId: "f", prompt: async () => undefined, abort: async () => undefined, getModel: () => ({ provider: "p", modelId: "m" }),
          getSessionStats: () => ({ sessionFile, sessionId: "f", userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0, totalMessages: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
          subscribe: () => () => undefined, dispose: () => undefined,
        };
      },
    };
    const open = { purpose: "reviewer" as const, keySlot: "slot-critic", model: { provider: "p", modelId: "m" }, system: "ROLE PROMPT", tools: [...READ_ONLY_TOOLS] };
    (await createReviewSessionOpener({ rootPath: dir, localFileTools: true, runtimeFor: () => ({ model: { provider: "p", modelId: "m" }, piAdapter: adapter }) })(open)).dispose();
    // The limit reaches the session adapter, and it is the one the proxy test and the docs name.
    expect(limits).toEqual([16_000]);
    expect(DESIGN_REVIEW_MAX_OUTPUT_TOKENS).toBe(16_000);
  });
});
