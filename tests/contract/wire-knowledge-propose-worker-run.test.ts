// Lead 4 L4-AK3, the worker's side. (1) `knowledge_propose`: the tool a coding step suggests team knowledge through; it exists only in the modes that work on the code, takes the same shape the broker takes, sends at most 3 a
// task, says fixed words and never that a suggestion was kept, and carries each one to the broker as progress. (2) Rovara skills: a plan or build step sent `rovaraSkills` offers them through `read_skill` after the
// meta repo's; each is checked against its digest, stripped of pre-run lines and tool grants, and the meta repo's skill wins a name clash (and the session says so).
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KNOWLEDGE_PROPOSALS_PER_TASK_MAX, ROVARA_SKILLS_FEATURE, WORKER_INVOCATION_FEATURES, WorkerInvocationSchema, knowledgeProposalsOfProgress } from "../../packages/contracts/src/index.js";
import { WorkerCancellationController } from "../../packages/worker/src/cancel.js";
import { WORKER_IMPLEMENTED_FEATURES } from "../../packages/worker/src/implemented-features.js";
import type { PiSessionAdapter, PiSessionInput } from "../../packages/worker/src/pi-session.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";
import { PROPOSE_LIMIT_TEXT, PROPOSE_REFUSED_TEXT, PROPOSE_SENT_TEXT, createKnowledgePropose } from "../../packages/worker/src/knowledge-propose-tool.js";
import { mergeSkills, rovaraSkillFiles } from "../../packages/worker/src/knowledge/skills.js";
import { readSkillTool } from "../../packages/worker/src/read-skill-tool.js";
import { skillsPromptSection, type AgentSkillFile } from "../../packages/worker/src/agent-step.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

async function preparedRoot(): Promise<string> {
  const rootPath = await mkdtemp(join(tmpdir(), "wire-propose-"));
  roots.push(rootPath);
  await mkdir(join(rootPath, ".agentx"));
  await writeFile(join(rootPath, ".agentx/preparation-manifest.json"), JSON.stringify({ schemaVersion: 2, projectName: "x", projectRevision: 1, repositories: [], completedSetupSteps: [], readinessResults: [], creationIdentity: "fixture", complete: true, updatedAt: new Date().toISOString() }));
  return rootPath;
}

const BASE_PROMPT = "Implement the approved plan.";
const skillFile = (name: string, content = `---\nname: ${name}\ndescription: d\n---\n\n## Steps\n1. Do it.\n`, over: Record<string, unknown> = {}) => ({ name, description: `How to ${name}`, version: 1, digest: sha(content), content, ...over });

async function step(mode: string | undefined, payload: Record<string, unknown> = {}, duringPrompt?: (input: PiSessionInput) => Promise<void>) {
  const inputs: PiSessionInput[] = [];
  const events: Array<{ type?: string; payload?: Record<string, unknown> }> = [];
  const diagnostics: string[] = [];
  const adapter: PiSessionAdapter = {
    async create(input) {
      inputs.push(input);
      const sessionFile = join(input.sessionDirectory, "fixture.jsonl");
      await writeFile(sessionFile, "");
      return {
        sessionFile, conversationId: "fixture",
        prompt: async () => { await duringPrompt?.(input); }, abort: async () => undefined, getModel: () => ({ provider: "fixture", modelId: "fixture" }),
        getSessionStats: () => ({ sessionFile, sessionId: "fixture", userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 }),
        subscribe: () => () => undefined, dispose: () => undefined,
      };
    },
  };
  const invocation = WorkerInvocationSchema.parse({
    protocolVersion: 1, kind: "task", operationId: randomUUID(), workspaceId: randomUUID(), fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64),
    payload: { conversationId: randomUUID(), prompt: BASE_PROMPT, ...(mode === undefined ? {} : { workflowMode: mode }), ...payload },
  });
  await runTaskInvocation(invocation, {
    rootPath: await preparedRoot(), model: { provider: "fixture", modelId: "fixture" }, piAdapter: adapter, eventSink: async (batch) => { events.push(...(Array.isArray(batch) ? batch : [batch]) as never[]); }, artifactSink: async () => undefined,
    cancellationController: new WorkerCancellationController(), log: (line: unknown) => { diagnostics.push(JSON.stringify(line)); },
  }).then(() => undefined, () => undefined);
  return { inputs, events, diagnostics };
}
const proposalsSent = (events: Array<{ type?: string; payload?: Record<string, unknown> }>) => events.flatMap((event) => (event.type === "progress" ? (knowledgeProposalsOfProgress(event.payload) ?? []) : []));
const run = (tool: { execute: (...args: never[]) => Promise<{ content: Array<{ text: string }> }> }, params: unknown) => (tool.execute as unknown as (id: string, p: unknown, s: undefined, u: undefined, c: undefined) => Promise<{ content: Array<{ text: string }> }>)("call-1", params, undefined, undefined, undefined);

describe("features", () => {
  it("Rovara skills are a feature the contracts know and the worker implements", () => {
    expect(WORKER_INVOCATION_FEATURES as readonly string[]).toContain(ROVARA_SKILLS_FEATURE);
    expect(WORKER_IMPLEMENTED_FEATURES as readonly string[]).toContain(ROVARA_SKILLS_FEATURE);
  });
});

describe("knowledge_propose: only for the modes that work on the code", () => {
  it.each(["UNDERSTAND", "PLAN", "IMPLEMENT"])("%s is given the tool", (mode) => {
    expect(createKnowledgePropose({ mode, emit: () => undefined })).toBeDefined();
  });
  it.each(["REVIEW", "PLAN_CRITIQUE", "SETUP_DRAFT", "SETUP_AGENT", "WIKI_BUILD", "SPEC_WRITE", "FEEDBACK_REVIEW", "CHECKS", "something-else", undefined])("%s is not", (mode) => {
    expect(createKnowledgePropose({ mode, emit: () => undefined })).toBeUndefined();
  });
  it("a worker run offers the tool to a build step and to no judging step, and carries a suggestion to the broker as progress", async () => {
    const told: string[] = [];
    const build = await step("IMPLEMENT", {}, async (input) => { told.push((await run(input.proposeTool as never, { advice: "Keep jobs idempotent", why: "Retries run twice." })).content[0]!.text); });
    expect(build.inputs[0]!.proposeTool?.name).toBe("knowledge_propose");
    expect(told).toEqual([PROPOSE_SENT_TEXT]);
    expect(proposalsSent(build.events)).toEqual([{ advice: "Keep jobs idempotent", why: "Retries run twice." }]);
    for (const mode of ["REVIEW", "PLAN_CRITIQUE", "SETUP_DRAFT"]) expect((await step(mode)).inputs.every((input) => input.proposeTool === undefined), mode).toBe(true);
    // A step with no stated mode is given neither the tool nor Rovara skills (only the modes named are).
    expect((await step(undefined)).inputs.every((input) => input.proposeTool === undefined)).toBe(true);
  });
});

describe("knowledge_propose: the shape, the limit and the words", () => {
  it("checks the same shape the broker does, and echoes nothing of what the model wrote", async () => {
    const sent: unknown[] = [];
    const made = createKnowledgePropose({ mode: "PLAN", emit: (proposal) => sent.push(proposal) })!;
    for (const bad of [{ advice: "short" }, { advice: "x".repeat(81) }, { advice: "Keep jobs idempotent", tool: "bash" }, { advice: "Keep jobs idempotent", type: "review_check" }, { advice: "Keep jobs idempotent", paths: ["a", "b", "c", "d", "e", "f"] }, { advice: "Keep jobs​ idempotent" }, {}]) {
      const answer = await run(made.tool as never, bad);
      expect(answer.content[0]!.text, JSON.stringify(bad)).toBe(PROPOSE_REFUSED_TEXT);
    }
    expect(sent).toEqual([]);
    expect(made.sent()).toBe(0);
    const good = await run(made.tool as never, { advice: "Keep jobs idempotent", why: "Retries run twice.", when: "adding a job", type: "pitfall", paths: ["src/jobs/**"] });
    expect(good.content[0]!.text).toBe(PROPOSE_SENT_TEXT);
    expect(JSON.stringify(good)).not.toContain("idempotent");
    expect(sent).toEqual([{ advice: "Keep jobs idempotent", why: "Retries run twice.", when: "adding a job", type: "pitfall", paths: ["src/jobs/**"] }]);
  });
  it("stops at 3 for the step, and a failed send does not break the tool", async () => {
    const sent: unknown[] = [];
    const made = createKnowledgePropose({ mode: "IMPLEMENT", emit: (proposal) => { sent.push(proposal); if (sent.length === 2) throw new Error("progress down"); } })!;
    const texts: string[] = [];
    for (let n = 0; n < KNOWLEDGE_PROPOSALS_PER_TASK_MAX + 2; n += 1) texts.push((await run(made.tool as never, { advice: `Keep job number ${String(n)} idempotent` })).content[0]!.text);
    expect(texts).toEqual([PROPOSE_SENT_TEXT, PROPOSE_SENT_TEXT, PROPOSE_SENT_TEXT, PROPOSE_LIMIT_TEXT, PROPOSE_LIMIT_TEXT]);
    expect(sent).toHaveLength(KNOWLEDGE_PROPOSALS_PER_TASK_MAX);
    expect(made.sent()).toBe(KNOWLEDGE_PROPOSALS_PER_TASK_MAX);
  });
  it("never promises that a suggestion was kept", () => {
    for (const text of [PROPOSE_SENT_TEXT, PROPOSE_REFUSED_TEXT, PROPOSE_LIMIT_TEXT]) expect(text).not.toMatch(/\b(saved|kept|stored|added to the team|approved)\b/iu);
    expect(PROPOSE_SENT_TEXT).toContain("A person decides");
  });
});

describe("Rovara skills in a step", () => {
  it("rovaraSkillFiles: checks the digest, removes pre-run lines and tool grants, digests the text the session is given, and only for plan and build", () => {
    const dirty = "---\nname: ship-it\ndescription: d\nallowed-tools: Bash\n---\n\n## Steps\n1. Build it !`rm -rf /` now.\n2. Ship it.\n";
    const payload = [skillFile("ship-it", dirty), skillFile("tampered", undefined, { digest: "0".repeat(64) })];
    const files = rovaraSkillFiles(payload, "PLAN");
    expect(files.map((file) => file.name)).toEqual(["ship-it"]);
    expect(files[0]!.content).not.toMatch(/allowed-tools|!`|rm -rf/u);
    expect(files[0]!.content).toContain("2. Ship it.");
    expect(files[0]!.digest).toBe(sha(files[0]!.content));
    expect(rovaraSkillFiles(payload, "IMPLEMENT")).toHaveLength(1);
    for (const mode of ["UNDERSTAND", "REVIEW", "PLAN_CRITIQUE", "SETUP_DRAFT", undefined]) expect(rovaraSkillFiles(payload, mode), String(mode)).toEqual([]);
    expect(rovaraSkillFiles(undefined, "PLAN")).toEqual([]);
    // A description is cleaned again here (hidden characters out, one line).
    const cleaned = rovaraSkillFiles([{ ...skillFile("ship-it"), description: "Ship\u200b it\nfast" }], "PLAN");
    expect(cleaned[0]!.description).toBe("Ship it fast");
  });
  it("a payload that does not parse is dropped whole: too many, two with one name, over 32 KB, an unknown field", () => {
    expect(rovaraSkillFiles(Array.from({ length: 9 }, (_, n) => skillFile(`s-${String(n)}`)), "PLAN")).toEqual([]);
    expect(rovaraSkillFiles([skillFile("a-b"), skillFile("a-b")], "PLAN")).toEqual([]);
    expect(rovaraSkillFiles([skillFile("a-b", `${"x".repeat(32_769)}`)], "PLAN")).toEqual([]);
    expect(rovaraSkillFiles([{ ...skillFile("a-b"), tools: ["bash"] }], "PLAN")).toEqual([]);
    expect(rovaraSkillFiles([skillFile("Bad Name")], "PLAN")).toEqual([]);
    expect(rovaraSkillFiles("nope", "PLAN")).toEqual([]);
  });

  const meta = (name: string): AgentSkillFile => ({ name, description: `meta ${name}`, content: `meta text of ${name}`, digest: sha(`meta text of ${name}`) });
  const rovara = (name: string): AgentSkillFile => ({ name, description: `rovara ${name}`, content: `rovara text of ${name}`, digest: sha(`rovara text of ${name}`) });
  it("the meta repo's skill wins a name clash and the clash is told; the step's own comes first; Rovara's come last", () => {
    const clashes: string[] = [];
    const merged = mergeSkills([{ ...meta("own-one"), description: "own" }], [meta("shared"), meta("meta-only"), meta("own-one")], [rovara("shared"), rovara("rovara-only"), rovara("own-one")], (name) => clashes.push(name))!;
    expect(merged.map((skill) => `${skill.name}:${skill.description}`)).toEqual(["own-one:own", "shared:meta shared", "meta-only:meta meta-only", "rovara-only:rovara rovara-only"]);
    expect(clashes).toEqual(["shared", "own-one"]);
    expect(mergeSkills(undefined, [], [])).toBeUndefined();
    expect(mergeSkills(undefined, [], [rovara("only")])!.map((skill) => skill.name)).toEqual(["only"]);
    expect(mergeSkills(undefined, [meta("a")])!.map((skill) => skill.name)).toEqual(["a"]);
  });
  it("read_skill serves both kinds from the one list, each checked against its digest", async () => {
    const merged = mergeSkills(undefined, [meta("from-meta")], [rovara("from-rovara")])!;
    expect(skillsPromptSection(merged)).toContain("<name>from-meta</name>");
    expect(skillsPromptSection(merged)).toContain("<name>from-rovara</name>");
    const tool = readSkillTool(merged);
    expect((await run(tool as never, { name: "from-meta" })).content[0]!.text).toBe("meta text of from-meta");
    expect((await run(tool as never, { name: "from-rovara" })).content[0]!.text).toBe("rovara text of from-rovara");
    expect((await run(tool as never, { name: "missing" })).content[0]!.text).toContain("No skill called missing");
    const tampered = readSkillTool([{ ...rovara("bad"), content: "changed" }]);
    await expect(run(tampered as never, { name: "bad" })).rejects.toThrow(/does not match the digest/u);
  });
  it("a worker run offers a plan or build step the skills it was sent, in the session's skills; a judging step gets none; an older broker's step is unchanged", async () => {
    const payload = { rovaraSkills: [skillFile("ship-it"), skillFile("add-a-queue")] };
    for (const mode of ["PLAN", "IMPLEMENT"]) {
      const offered = (await step(mode, payload)).inputs[0]!.skills?.map((skill) => skill.name);
      expect(offered, mode).toEqual(["ship-it", "add-a-queue"]);
    }
    for (const mode of ["REVIEW", "UNDERSTAND", "PLAN_CRITIQUE"]) expect((await step(mode, payload)).inputs.every((input) => input.skills === undefined), mode).toBe(true);
    expect((await step("PLAN")).inputs[0]!.skills).toBeUndefined();
    // The invocation schema refuses what is not a skill: the step is built without it (the broker's retry), never half-delivered.
    expect(() => WorkerInvocationSchema.parse({ protocolVersion: 1, kind: "task", operationId: randomUUID(), workspaceId: randomUUID(), fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64), payload: { conversationId: randomUUID(), prompt: "x", rovaraSkills: [{ name: "a-b" }] } })).toThrow();
  });
});
