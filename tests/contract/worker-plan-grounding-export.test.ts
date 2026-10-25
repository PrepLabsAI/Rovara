// T7a PLANGROUNDING: when the broker asks, a planning run exports the unchanged code (the task's base commit) for the plan's must-not-change scenarios, and only then. The export travels on the
// baseline-source request, never on the model-visible result.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type E2EScenario } from "@agentx/contracts";
import { WorkerCancellationController } from "../../packages/worker/src/cancel.js";
import type { WorkerEvent } from "../../packages/worker/src/events.js";
import type { PiSessionAdapter } from "../../packages/worker/src/pi-session.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";
import { postWorkerTerminalResult } from "../../packages/worker/src/terminal-callback.js";
import { csvScenario, planFixture } from "../support/e2e-application-plan-fixtures.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";

const REPO_PATH = "orders";
const BASE_ONLY = "BASE-ONLY-TOKEN-4d2c";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

/** A workspace with one repository whose base commit holds `src/app.js` with the base-only token; the working tree then edits it away and adds a file the base does not have. */
function workspace(): { root: string; repo: string; baseSha: string } {
  const root = mkdtempSync(join(tmpdir(), "plan-grounding-"));
  roots.push(root);
  const repo = join(root, REPO_PATH);
  mkdirSync(join(repo, "src"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "package.json"), "{\"name\":\"orders\"}\n");
  writeFileSync(join(repo, "src/app.js"), `export const orders = [];\n// ${BASE_ONLY}\n`);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  const baseSha = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "src/app.js"), "export const orders = [1];\n// edited in the workspace after the base\n");
  writeFileSync(join(repo, "workspace-only.txt"), "not in the base\n");
  return { root, repo, baseSha };
}

const agentScenario: E2EScenario = { ...csvScenario, scenarioId: "agent-orders", steps: [{ kind: "agent", goal: "open the orders page", maxActions: 3 }], assertions: [{ kind: "visible", testId: "orders", equals: true }] };
function planText(options: { scenarios: E2EScenario[]; scenarioProves: Record<string, string[]> }): string {
  const fx = planFixture({});
  return planAnswer(planDocument({ e2e: { ...fx.intent, scenarios: options.scenarios }, scenarioProves: options.scenarioProves }));
}

async function planningRun(options: { answer: string; grounding?: boolean; planVersion2?: boolean }) {
  const ws = workspace();
  await mkdir(join(ws.root, ".agentx"), { recursive: true });
  await writeFile(join(ws.root, ".agentx/preparation-manifest.json"), JSON.stringify({ schemaVersion: 2, projectName: "x", projectRevision: 1,
    repositories: [{ name: REPO_PATH, path: REPO_PATH, defaultBranch: "main", resolvedCommit: ws.baseSha, resolvedAt: new Date().toISOString() }],
    completedSetupSteps: [], readinessResults: [], creationIdentity: "fixture", complete: true, updatedAt: new Date().toISOString() }));
  const adapter: PiSessionAdapter = { async create({ sessionDirectory }) {
    const sessionFile = join(sessionDirectory, "fixture.jsonl");
    await writeFile(sessionFile, "");
    let listener: (event: unknown) => void = () => undefined;
    return {
      sessionFile, conversationId: "fixture",
      prompt: async () => { listener({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: options.answer }] } }); },
      abort: async () => undefined, getModel: () => ({ provider: "fixture", modelId: "fixture" }),
      getSessionStats: () => ({ sessionFile, sessionId: "fixture", userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2,
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 }),
      subscribe: (next) => { listener = next; return () => undefined; }, dispose: () => undefined,
    };
  } };
  const sent: WorkerEvent[] = [];
  const result = await runTaskInvocation({
    protocolVersion: 1, kind: "task", operationId: randomUUID(), workspaceId: randomUUID(), fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64),
    payload: { conversationId: randomUUID(), prompt: "Plan", workflowMode: "PLAN", workflowPhase: "IMPLEMENTATION_PLAN", planFormat: "structured",
      ...(options.planVersion2 === false ? {} : { workflowE2EPlanVersion: 2 }), ...(options.grounding === true ? { workflowE2EGroundingSource: true } : {}) },
  } as never, {
    rootPath: ws.root, model: { provider: "fixture", modelId: "fixture" }, piAdapter: adapter, cancellationController: new WorkerCancellationController(),
    eventSink: async (batch) => { sent.push(...batch); }, artifactSink: async () => undefined, log: () => undefined,
  });
  return { result: result as unknown as Record<string, unknown>, sent, ws };
}
const decodedSource = (result: Record<string, unknown>) => {
  const exported = result["workflowBaselineSource"] as { status: string; source: { repositories: Array<{ commitSha: string; treeSha: string; treePaths: string[]; sources: Array<{ path: string; bytesBase64: string }> }> } };
  return { status: exported.status, repository: exported.source.repositories[0]! };
};
const withProves = (extra: Record<string, string[]>, scenarios: E2EScenario[]) => planText({ scenarios, scenarioProves: extra });

describe("a planning run asked for the grounding source", () => {
  it("exports the base commit's tree for a plan with a must-not-change scenario, not the workspace's, and tells the owner nothing of it on the result events", async () => {
    const { result, sent, ws } = await planningRun({ answer: withProves({ "export-csv": ["nc1"] }, [csvScenario]), grounding: true });
    const { status, repository } = decodedSource(result);
    expect(status).toBe("READY");
    expect(repository.commitSha).toBe(ws.baseSha);
    expect(repository.treeSha).toBe(git(ws.repo, "rev-parse", `${ws.baseSha}^{tree}`));
    // Positive control: the callback holds the bytes of the base, which the workspace no longer has.
    expect(Buffer.from(repository.sources.find((item) => item.path === "src/app.js")!.bytesBase64, "base64").toString("utf8")).toContain(BASE_ONLY);
    expect(repository.treePaths).not.toContain("workspace-only.txt");
    // The export is not in any event the run emits (the model-visible result).
    expect(JSON.stringify(sent)).not.toContain(BASE_ONLY);
  });

  it("exports nothing without the flag (the invocation of an older broker), for a plan with no must-not-change scenario, or when every such scenario needs AI navigation", async () => {
    const proving = withProves({ "export-csv": ["nc1"] }, [csvScenario]);
    expect((await planningRun({ answer: proving })).result).not.toHaveProperty("workflowBaselineSource");
    expect((await planningRun({ answer: withProves({ "export-csv": ["1"] }, [csvScenario]), grounding: true })).result).not.toHaveProperty("workflowBaselineSource");
    expect((await planningRun({ answer: withProves({ "agent-orders": ["nc1"] }, [agentScenario]), grounding: true })).result).not.toHaveProperty("workflowBaselineSource");
    expect((await planningRun({ answer: planAnswer(planDocument()), grounding: true })).result).not.toHaveProperty("workflowBaselineSource");
  });

  it("returns exactly the result it returned before when it is not asked (byte-identical)", async () => {
    const { result } = await planningRun({ answer: withProves({ "export-csv": ["nc1"] }, [csvScenario]) });
    expect(Object.keys(result).sort()).toEqual(["conversationId", "reopened", "workflowMode"]);
  });
});

describe("the grounding source's delivery", () => {
  const exported = { schemaVersion: "workflow-baseline-source/v1", status: "UNAVAILABLE", reason: "fixed reason" };
  const delivered = async (payload: Record<string, unknown>, failing = false) => {
    const uploads: unknown[] = [];
    const terminals: Array<{ result: Record<string, unknown> }> = [];
    const logs: Array<Record<string, unknown>> = [];
    await postWorkerTerminalResult({ candidateSourceExportSink: async () => { throw new Error("not for a planning run"); },
      baselineSourceSink: async (source) => { uploads.push(source); if (failing) throw new Error(`boom ${BASE_ONLY}`); },
      terminalSink: async (value) => { terminals.push(value as never); } },
    { operationId: randomUUID(), result: { workflowMode: "PLAN", workflowBaselineSource: exported } } as never,
    { kind: "task", payload: { workflowMode: "PLAN", ...payload } } as never, (event) => logs.push(event));
    return { uploads, terminals, logs };
  };

  it("posts the export on the baseline-source request for the asked planning run and strips it from the terminal result", async () => {
    const { uploads, terminals } = await delivered({ workflowE2EGroundingSource: true });
    expect(uploads).toEqual([exported]);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]!.result).toEqual({ workflowMode: "PLAN" });
  });

  it("never posts it for a run that was not asked, still strips it, and does not fail the terminal result when the post fails (and logs no text from the failure (a positive control: the failing sink did carry it))", async () => {
    const notAsked = await delivered({});
    expect(notAsked.uploads).toEqual([]);
    expect(notAsked.terminals[0]!.result).toEqual({ workflowMode: "PLAN" });
    const failing = await delivered({ workflowE2EGroundingSource: true }, true);
    expect(failing.uploads).toHaveLength(1);
    expect(failing.terminals).toHaveLength(1);
    expect(failing.logs).toHaveLength(1);
    expect(JSON.stringify(failing.logs)).toContain("grounding-source.delivery_failed");
    expect(JSON.stringify(failing.logs)).not.toContain(BASE_ONLY);
  });
});
