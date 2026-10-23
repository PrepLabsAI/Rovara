// PLANINC-3b: a planning run on the real Pi agent loop and its real retry logic, with Pi's scripted model standing in for Bedrock. The scripted provider is named
// "amazon-bedrock" so the worker classifies its failures as it does the real ones. Offline: no model, no network.
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, type FauxResponseStep } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerCancellationController, WorkerOperationCancelledError } from "../../packages/worker/src/cancel.js";
import type { WorkerEvent } from "../../packages/worker/src/events.js";
import { createDefaultPiSessionAdapter, createWorkerResources } from "../../packages/worker/src/pi-session.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";

const MODEL = { provider: "amazon-bedrock", modelId: "scripted", thinkingLevel: "off" } as const;
const REQUEST_ID = "9e7ea41c-561a-49e1-bbc3-2737b23fa76c";
const SECRET_THINKING = "SECRET-REASONING-TEXT-9d1f";
const ISE_TEXT = "Internal server error: The system encountered an unexpected error during processing. Try your request again. PRIVATE-PROVIDER-DETAIL";

/** The scripted model's version of event 75 of operation 1910a8ce: an InternalServerException with thinking-only content. */
const iseFailure = (): ReturnType<typeof fauxAssistantMessage> => Object.assign(
  fauxAssistantMessage([{ type: "thinking", thinking: SECRET_THINKING }], { stopReason: "error", errorMessage: ISE_TEXT }),
  { durationMs: 441950, diagnostics: [{ type: "bedrock_response_failure", details: { errorCode: "InternalServerException", requestId: REQUEST_ID } }] },
);
/** A model call that waits until it is aborted, as a long stream does. */
const hangsUntilAborted: FauxResponseStep = async (_context, options) => {
  await new Promise<void>((resolve) => {
    if (options?.signal?.aborted) resolve();
    options?.signal?.addEventListener("abort", () => resolve(), { once: true });
  });
  return fauxAssistantMessage([], { stopReason: "aborted" });
};

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function preparedRoot(): Promise<string> {
  const rootPath = await mkdtemp(join(tmpdir(), "planinc-3b-faux-"));
  roots.push(rootPath);
  await mkdir(join(rootPath, ".agentx"));
  await writeFile(join(rootPath, ".agentx/preparation-manifest.json"), JSON.stringify({ schemaVersion: 2, projectName: "x", projectRevision: 1, repositories: [], completedSetupSteps: [],
    readinessResults: [], creationIdentity: "fixture", complete: true, updatedAt: new Date().toISOString() }));
  return rootPath;
}

async function plan(responses: FauxResponseStep[], controller?: WorkerCancellationController, operationId: string = randomUUID()) {
  const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }] });
  faux.setResponses(responses);
  const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  // The default adapter, so the worker's own Pi settings (the retry budget) apply.
  const piAdapter = createDefaultPiSessionAdapter({ modelRuntime: async () => ({ runtime: modelRuntime, model: MODEL }) });
  const sent: WorkerEvent[] = [];
  const artifacts: Array<{ name: string; content: string }> = [];
  const invocation = { protocolVersion: 1 as const, kind: "task" as const, operationId, workspaceId: randomUUID(), fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64),
    payload: { conversationId: randomUUID(), prompt: "Plan the change", workflowMode: "PLAN" as const } };
  const running = runTaskInvocation(invocation, {
    rootPath: await preparedRoot(), model: MODEL, piAdapter,
    eventSink: async (batch) => { sent.push(...batch); }, artifactSink: async (artifact) => { artifacts.push(artifact); },
    log: () => undefined,
    ...(controller === undefined ? {} : { cancellationController: controller }),
  });
  const settled = running.then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error: error as Error }));
  return { faux, sent, artifacts, settled, operationId };
}

const notes = (sent: readonly WorkerEvent[]) => sent.flatMap((event) => {
  const note = (event.payload as { modelCall?: Record<string, unknown> } | null)?.modelCall;
  return event.type === "progress" && note !== undefined ? [note] : [];
});
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const PLAN = planAnswer(planDocument({ title: "Update the route" }));

describe("a planning run on the real Pi loop whose model call fails", () => {
  it("retries a transient failure, reports it once as sanitized notes in order, and saves the plan", async () => {
    const { faux, sent, artifacts, settled } = await plan([iseFailure(), fauxAssistantMessage(PLAN)]);
    expect((await settled).ok).toBe(true);
    expect(faux.state.callCount).toBe(2);
    expect(notes(sent)).toEqual([
      { outcome: "failed", class: "provider-outage", signal: "InternalServerException", attempt: 1, provider: "amazon-bedrock", requestId: REQUEST_ID, durationMs: 441950 },
      { outcome: "retrying", attempt: 1, maxAttempts: 2, delayMs: 2000 },
      { outcome: "retry-finished", success: true, attempt: 1 },
    ]);
    // Order: the failure, then the retry, then the plan's result.
    const indexOf = (outcome: string) => sent.findIndex((event) => (event.payload as { modelCall?: { outcome?: string } } | null)?.modelCall?.outcome === outcome);
    expect(indexOf("failed")).toBeLessThan(indexOf("retrying"));
    expect(indexOf("retrying")).toBeLessThan(sent.findIndex((event) => event.type === "result"));
    const everything = JSON.stringify(sent);
    expect(everything).not.toContain(SECRET_THINKING);
    expect(everything).not.toContain("PRIVATE-PROVIDER-DETAIL");
    expect(sent.some((event) => event.type === "error")).toBe(false);
    expect(artifacts.find((artifact) => artifact.name === "plan.md")?.content).toContain("Update the route");
  }, 30_000);

  it("stops after the retry budget (2 retries, 3 calls) and fails with fixed text naming the class, error type, request and call", async () => {
    const { faux, sent, settled, artifacts } = await plan([iseFailure(), iseFailure(), iseFailure(), fauxAssistantMessage(PLAN)]);
    const result = await settled;
    expect(result.ok).toBe(false);
    // With Pi's own default (3 retries) there would be a fourth call and the plan would be saved.
    expect(faux.state.callCount).toBe(3);
    expect((result as { error: Error }).error.message).toBe(`RUNTIME_UNAVAILABLE: the model call failed: provider-outage InternalServerException request ${REQUEST_ID} attempt 3; retry the step`);
    expect(notes(sent).map((note) => `${String(note.outcome)}:${String(note.attempt)}`)).toEqual(
      ["failed:1", "retrying:1", "failed:2", "retrying:2", "failed:3", "retry-finished:2"]);
    expect(sent.find((event) => event.type === "error")?.payload).toEqual({ message: (result as { error: Error }).error.message });
    expect(JSON.stringify(sent)).not.toContain("PRIVATE-PROVIDER-DETAIL");
    expect(JSON.stringify(sent)).not.toContain(SECRET_THINKING);
    expect(artifacts.some((artifact) => artifact.name === "plan.md")).toBe(false);
    // The usage record says FAILED.
    expect(sent.find((event) => event.type === "usage")?.payload).toMatchObject({ outcome: "FAILED" });
  }, 40_000);

  it("a cancel during streaming ends the run CANCELLED with no further request, and sends the buffered events before the cancel returns", async () => {
    const controller = new WorkerCancellationController();
    const operationId = randomUUID();
    const { faux, sent, settled } = await plan([hangsUntilAborted, fauxAssistantMessage(PLAN)], controller, operationId);
    await wait(300);
    await controller.cancel(operationId);
    // Whatever was buffered is already sent when the cancel call returns: the cancel's own result would make the operation terminal and refuse it.
    expect(sent.some((event) => event.type === "progress" && (event.payload as { message?: string } | null)?.message === "AgentX stopped this run because it was cancelled.")).toBe(true);
    expect(notes(sent).map((note) => note.outcome)).toContain("stopped");
    const result = await settled;
    expect((result as { error: unknown }).error).toBeInstanceOf(WorkerOperationCancelledError);
    expect(faux.state.callCount).toBe(1);
  }, 30_000);

  it("a cancel during the retry wait ends the run CANCELLED and makes no second request", async () => {
    const controller = new WorkerCancellationController();
    const operationId = randomUUID();
    const { faux, sent, settled } = await plan([iseFailure(), fauxAssistantMessage(PLAN)], controller, operationId);
    // The failed call ends at once; Pi then waits 2 s before its retry. Cancel inside that wait.
    await wait(500);
    expect(notes(sent).map((note) => note.outcome)).toEqual(["failed", "retrying"]);
    await controller.cancel(operationId);
    const result = await settled;
    expect((result as { error: unknown }).error).toBeInstanceOf(WorkerOperationCancelledError);
    await wait(2_500);
    expect(faux.state.callCount).toBe(1);
    expect(sent.some((event) => event.type === "result")).toBe(false);
  }, 30_000);
});

describe("the worker's Pi retry budget", () => {
  it("is 2 retries, whatever the agent directory's settings file says", async () => {
    const rootPath = await preparedRoot();
    const agentDirectory = join(rootPath, ".agentx/pi");
    await mkdir(agentDirectory, { recursive: true });
    await writeFile(join(agentDirectory, "settings.json"), JSON.stringify({ retry: { enabled: false, maxRetries: 9, baseDelayMs: 1 } }));
    const { settingsManager } = await createWorkerResources({ cwd: rootPath, agentDirectory, contextFiles: [] });
    expect(settingsManager.getRetrySettings()).toEqual({ enabled: true, maxRetries: 2, baseDelayMs: 2_000, maxAgentDelayMs: 10_000 });
  });
});
