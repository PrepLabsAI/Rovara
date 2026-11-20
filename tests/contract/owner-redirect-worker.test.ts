// Live interaction R1, worker side: the owner's redirect instruction is taken from the owner before the restarted coding step prompts, and framed (untrusted, nonce-tagged) in its prompt in place of
// a plain owner note. The step then stops for re-approval on the marker exactly as for a live steer; the same answer without a redirect does not stop it. An older worker is refused at delivery
// (tests/contract/ec2-dispatch.test.ts), and no log, event or error holds the text.
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REDIRECT_RESTART_NOTE, WORKFLOW_LIVE_STEER_REAPPROVAL_MESSAGE, WorkerInvocationSchema } from "../../packages/contracts/src/index.js";
import { WorkerCancellationController } from "../../packages/worker/src/cancel.js";
import type { PiSessionAdapter } from "../../packages/worker/src/pi-session.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";
import { ownerRedirectPrompt } from "../../packages/worker/src/steer-invocation.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function preparedRoot(): Promise<string> {
  const rootPath = await mkdtemp(join(tmpdir(), "owner-redirect-"));
  roots.push(rootPath);
  await mkdir(join(rootPath, ".agentx"));
  await writeFile(join(rootPath, ".agentx/preparation-manifest.json"), JSON.stringify({ schemaVersion: 2, projectName: "x", projectRevision: 1, repositories: [],
    completedSetupSteps: [], readinessResults: [], creationIdentity: "fixture", complete: true, updatedAt: new Date().toISOString() }));
  return rootPath;
}

const TEXT = "use the retry helper SECRET-REDIRECT-TEXT-91 and stop touching the cache";
const MESSAGE = "msg_0123456789abcdefghij";
const redirect = (overrides: Record<string, unknown> = {}) => ({ messageId: MESSAGE, sender: "person p_a1b2c3", text: TEXT, ...overrides });

/** Runs a coding step whose pi session records its prompts and what the controller held at the moment of the prompt; the step ends with `finalText` as its answer. */
async function codingStep(options: { mode?: string; ownerRedirect?: Record<string, unknown> | undefined; finalText?: string; withController?: boolean } = {}) {
  const controller = new WorkerCancellationController();
  const prompts: string[] = [];
  const heldAtPrompt: Array<ReadonlyArray<{ messageId: string; authority: string }>> = [];
  const listeners: Array<(event: unknown) => void> = [];
  const logs: string[] = [];
  const events: unknown[] = [];
  const operationId = randomUUID();
  const adapter: PiSessionAdapter = {
    async create({ sessionDirectory }) {
      const sessionFile = join(sessionDirectory, "fixture.jsonl");
      await writeFile(sessionFile, "");
      return {
        sessionFile, conversationId: "fixture",
        prompt: async (text: string) => {
          prompts.push(text);
          heldAtPrompt.push([...controller.liveSteers(operationId)]);
          if (options.finalText !== undefined) for (const listener of listeners) listener({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: options.finalText }] } });
        },
        abort: async () => undefined,
        getModel: () => ({ provider: "fixture", modelId: "fixture" }),
        getSessionStats: () => ({ sessionFile, sessionId: "fixture", userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2,
          tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 }),
        subscribe: (listener) => { listeners.push(listener); return () => undefined; },
        dispose: () => undefined,
      };
    },
  };
  const invocation = WorkerInvocationSchema.parse({
    protocolVersion: 1, kind: "task", operationId, workspaceId: randomUUID(), fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64),
    payload: { conversationId: randomUUID(), prompt: "Implement the approved plan.", workflowMode: options.mode ?? "IMPLEMENT", ...(options.ownerRedirect === undefined ? {} : { ownerRedirect: options.ownerRedirect }) },
  });
  const failure = await runTaskInvocation(invocation, {
    rootPath: await preparedRoot(), model: { provider: "fixture", modelId: "fixture" }, piAdapter: adapter, eventSink: async (event) => { events.push(event); }, artifactSink: async () => undefined,
    ...(options.withController === false ? {} : { cancellationController: controller }), log: (_level, line) => { logs.push(line); },
  }).then(() => undefined, (error: unknown) => error as Error);
  return { prompts, heldAtPrompt, failure, logs, events };
}

describe("owner redirect, worker side", () => {

  it("records the message as taken from the owner BEFORE the step prompts, and frames the instruction in the prompt as untrusted text with the restart note", async () => {
    const step = await codingStep({ ownerRedirect: redirect() });
    expect(step.prompts).toHaveLength(1);
    expect(step.heldAtPrompt[0]).toEqual([{ messageId: MESSAGE, authority: "owner_instruction" }]);
    const prompt = step.prompts[0]!;
    expect(prompt.startsWith("Implement the approved plan.")).toBe(true);
    expect(prompt).toContain(REDIRECT_RESTART_NOTE);
    expect(prompt).toContain("task owner (person p_a1b2c3)");
    expect(prompt).toMatch(/<person_message id="[0-9a-f]{16}">use the retry helper SECRET-REDIRECT-TEXT-91 and stop touching the cache<\/person_message>/u);
    expect(prompt).toContain(`"RE-APPROVAL NEEDED:"`);
    // It replaces the plain owner note: the text appears exactly once, inside the tag.
    expect(prompt.split("SECRET-REDIRECT-TEXT-91")).toHaveLength(2);
    expect(prompt).not.toContain("Owner note");
  });

  it("stops the step for re-approval when its answer carries the marker after the redirect (fixed words, the message id, never the text)", async () => {
    const step = await codingStep({ ownerRedirect: redirect(), finalText: "I did not act on all of it.\nRE-APPROVAL NEEDED: also rewrite the billing module" });
    expect(step.failure?.message).toBe(`CONFIG_INVALID: ${WORKFLOW_LIVE_STEER_REAPPROVAL_MESSAGE} (${MESSAGE})`);
    expect(step.failure?.message).not.toContain("billing");
    expect(step.failure?.message).not.toContain("SECRET-REDIRECT-TEXT-91");
  });

  it("fails closed with no cancellation controller: the step does not prompt with an instruction nothing binds", async () => {
    const step = await codingStep({ ownerRedirect: redirect(), withController: false });
    expect(step.prompts).toHaveLength(0);
    expect(step.failure?.message).toMatch(/cancellation controller/u);
    expect(step.failure?.message).not.toContain("SECRET-REDIRECT-TEXT-91");
  });

  it("is refused for a step that is not coding: the payload is not accepted, and the function itself refuses too", () => {
    for (const workflowMode of ["PLAN", "UNDERSTAND", "REVIEW", "CHECKS"]) {
      expect(() => WorkerInvocationSchema.parse({
        protocolVersion: 1, kind: "task", operationId: randomUUID(), workspaceId: randomUUID(), fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64),
        payload: { conversationId: randomUUID(), prompt: "p", workflowMode, ownerRedirect: redirect() },
      }), workflowMode).toThrow();
    }
    expect(() => ownerRedirectPrompt("p", redirect() as never, "PLAN", new WorkerCancellationController(), randomUUID())).toThrow(/coding step/u);
    expect(ownerRedirectPrompt("p", undefined, "PLAN", undefined, randomUUID())).toBe("p");
  });

  it("is refused together with an agent step, which would ignore it", () => {
    const base = { protocolVersion: 1, kind: "task", operationId: randomUUID(), workspaceId: randomUUID(), fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64) };
    const agentStep = { kind: "coding", agentId: "agt_aaaaaaaaaaaaaaaaaaaa", version: 3, stepId: "review", tools: ["read", "grep"] };
    const withStep = WorkerInvocationSchema.safeParse({ ...base, payload: { conversationId: randomUUID(), prompt: "p", workflowMode: "IMPLEMENT", ownerRedirect: redirect(), agentStep } });
    expect(withStep.success).toBe(false);
    if (!withStep.success) expect(JSON.stringify(withStep.error.issues)).toMatch(/agent step/u);
    // Positive control: the same payload without the redirect is accepted, so the refusal above is the redirect's.
    expect(WorkerInvocationSchema.safeParse({ ...base, payload: { conversationId: randomUUID(), prompt: "p", workflowMode: "IMPLEMENT", agentStep } }).success).toBe(true);
  });

});
