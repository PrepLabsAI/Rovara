// Plan 6 Task 8, the worker's side of the plan check: a read-only model run that ends with a rovara-plan-critique block. An answer whose block can't be read is asked for once more, in the
// same session, with what is wrong; the answer after that is uploaded for the broker to decide. The run has no write tools, and the worker advertises the feature.
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLAN_CRITIQUE_INFO_STRING, type WorkerInvocation } from "@rovara-code/contracts";
import { fauxAssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { WorkerEvent } from "../../packages/worker/src/events.js";
import type { PiSessionAdapter } from "../../packages/worker/src/pi-session.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";
import { FAUX_MODEL, fauxModelRuntime } from "../support/faux-model.js";
import { WORKER_IMPLEMENTED_FEATURES } from "../../packages/worker/src/implemented-features.js";

async function realPi(responses: FauxResponseStep[]) {
  const { modelRuntime, faux } = await fauxModelRuntime();
  faux.setResponses(responses);
  const adapter: PiSessionAdapter = {
    async create({ cwd, sessionDirectory, agentDirectory }) {
      const model = modelRuntime.getModel(FAUX_MODEL.provider, FAUX_MODEL.modelId)!;
      const { session } = await createAgentSession({
        cwd, agentDir: agentDirectory, modelRuntime, model, thinkingLevel: "off", tools: ["bash"],
        sessionManager: SessionManager.create(cwd, sessionDirectory),
      });
      return {
        conversationId: "turn", sessionFile: session.sessionFile!,
        prompt: (text) => session.prompt(text, { expandPromptTemplates: false }),
        steer: async (text) => { await session.steer(text); },
        abort: () => session.abort(),
        getModel: () => ({ provider: FAUX_MODEL.provider, modelId: FAUX_MODEL.modelId }),
        getSessionStats: () => session.getSessionStats(),
        subscribe: (listener) => session.subscribe((event) => listener(event)),
        dispose: () => session.dispose(),
      };
    },
  };
  return adapter;
}

async function preparedRoot(): Promise<string> {
  const rootPath = await mkdtemp(join(tmpdir(), "agentx-critic-"));
  await mkdir(join(rootPath, ".agentx"));
  await mkdir(join(rootPath, "payments/src"), { recursive: true });
  await writeFile(join(rootPath, "payments/src/charge.ts"), `${Array.from({ length: 30 }, (_, index) => `const line${index + 1} = ${index + 1};`).join("\n")}\n`);
  const repository = { name: "payments", path: "payments", defaultBranch: "main", resolvedCommit: "a".repeat(40), resolvedAt: new Date().toISOString(), completedAt: new Date().toISOString() };
  await writeFile(join(rootPath, ".agentx/preparation-manifest.json"), JSON.stringify({
    schemaVersion: 2, projectName: "turn", projectRevision: 1, repositories: [repository], completedSetupSteps: [],
    readinessResults: [], creationIdentity: "fixture", complete: true, updatedAt: new Date().toISOString(),
  }));
  return rootPath;
}

const messageText = (message: unknown): string => {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map((part) => (part as { text?: unknown }).text).filter((text): text is string => typeof text === "string").join("") : "";
};

/** A scripted planner that records the latest user message each of its answers responds to. */
function planner(answers: string[]) {
  const asked: string[] = [];
  const steps: FauxResponseStep[] = answers.map((answer) => async (context: Parameters<Extract<FauxResponseStep, (...args: never[]) => unknown>>[0]) => {
    asked.push(messageText([...context.messages].reverse().find((message) => (message as { role?: string }).role === "user")));
    return fauxAssistantMessage(answer);
  });
  return { asked, steps };
}

function checking(prompt: string): Extract<WorkerInvocation, { kind: "task" }> {
  return {
    protocolVersion: 1, kind: "task", operationId: randomUUID(), workspaceId: randomUUID(), fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64),
    payload: { conversationId: randomUUID(), prompt, workflowMode: "PLAN_CRITIQUE" },
  };
}

async function run(adapter: PiSessionAdapter, invocation: WorkerInvocation) {
  const events: WorkerEvent[] = [];
  const artifacts: Array<{ name: string; mediaType: string; content: string }> = [];
  await runTaskInvocation(invocation, {
    rootPath: await preparedRoot(), model: { provider: FAUX_MODEL.provider, modelId: FAUX_MODEL.modelId }, piAdapter: adapter,
    eventSink: async (batch) => { events.push(...batch); }, artifactSink: async (artifact) => { artifacts.push(artifact); },
  });
  return { events, artifacts, uploaded: artifacts.filter((artifact) => artifact.name === "plan-critique.md").map((artifact) => artifact.content) };
}

const good = `The plan is sound.\n\n\`\`\`${PLAN_CRITIQUE_INFO_STRING}\n${JSON.stringify({ verdict: "revise", points: [{ id: "p1", severity: "blocking", text: "No limit on retries." }] })}\n\`\`\`\n`;
const unreadable = "Looks good to me. Approved.";
const retryProgress = (events: WorkerEvent[]) => events.filter((event) => event.type === "progress" && (event.payload as { message?: unknown }).message === "The plan check could not be read; the agent is asked to answer again.");

describe("the plan check run", () => {
  it("is not refused: the worker advertises the feature, and the run uploads the critic's answer and reports the mode", async () => {
    expect(WORKER_IMPLEMENTED_FEATURES).toContain("task.workflowPlanCritique");
    const { asked, steps } = planner([good]);
    const { uploaded, events } = await run(await realPi(steps), checking("Plan check.\n\nThe plan: ..."));
    expect(asked).toHaveLength(1);
    expect(uploaded).toEqual([good.trim()]);
    expect(events.some((event) => event.type === "result" && (event.payload as { workflowMode?: string }).workflowMode === "PLAN_CRITIQUE")).toBe(true);
    expect(retryProgress(events)).toEqual([]);
  });

  it("asks once more, in the same session, with what is wrong, when the block can't be read, and uploads the new answer", async () => {
    const { asked, steps } = planner([unreadable, good]);
    const { uploaded, events } = await run(await realPi(steps), checking("Plan check."));
    expect(asked).toHaveLength(2);
    expect(asked[1]).toContain(`Your answer could not be read as a plan check. Fix this problem and return the complete answer again, ending with the ${PLAN_CRITIQUE_INFO_STRING} block.`);
    expect(asked[1]).toContain(`Your answer has no ${PLAN_CRITIQUE_INFO_STRING} block.`);
    expect(uploaded).toEqual([good.trim()]);
    expect(retryProgress(events)).toHaveLength(1);
  });

  it("asks only once: a second answer that still can't be read is uploaded as it is, for the broker to block", async () => {
    const { asked, steps } = planner([unreadable, "Still fine.", good]);
    const { uploaded } = await run(await realPi(steps), checking("Plan check."));
    expect(asked).toHaveLength(2);
    expect(uploaded).toEqual(["Still fine."]);
  });

  it("changes nothing in the workspace and reports no check results", async () => {
    const { steps } = planner([good]);
    const root = await preparedRoot();
    const before = await readFile(join(root, "payments/src/charge.ts"), "utf8");
    const events: WorkerEvent[] = [];
    await runTaskInvocation(checking("Plan check."), {
      rootPath: root, model: { provider: FAUX_MODEL.provider, modelId: FAUX_MODEL.modelId }, piAdapter: await realPi(steps),
      eventSink: async (batch) => { events.push(...batch); }, artifactSink: async () => undefined,
    });
    expect(await readFile(join(root, "payments/src/charge.ts"), "utf8")).toBe(before);
    expect(events.some((event) => event.type === "result" && (event.payload as { checks?: unknown }).checks !== undefined)).toBe(false);
  });
});
