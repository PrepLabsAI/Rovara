// a world to test the design review stage in (the task flow on its fakes, a simulated worker).
// The design review stage on the task flow's fakes. A Full task whose project asks for design review goes through Understand, the requirements, the design, a round of fresh
// reviewers (their packets and keys are the broker's), the planner's answer to their findings, a second round, and ends at the owner's approval card: nothing here approves anything, the approval gate does that.
// The worker is simulated by recording results directly; what the broker keeps (packets, slot budgets, key rows) is checked in the store.
import { createHash } from "node:crypto";
import { expect } from "vitest";
import {
  DESIGN_REVIEW_INFO_STRING, DesignReviewBindingSchema, DesignReviewWorkerResultSchema, WORKER_INVOCATION_FEATURES, decideWorkflow, type WorkflowSnapshot, type WorkerInvocation,
} from "@agentx/contracts";
import { dispatchRowItem } from "../../packages/broker/src/core/task-flow/dispatch-rows.js";
import { operationKey, taskKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { fromDocument, type OperationRecord, type TaskRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { createDesignReviewSteps } from "../../packages/broker/src/core/design-review/steps.js";
import { putSlotKey, readSlotCeiling } from "../../packages/broker/src/core/design-review/slot-keys.js";
import { writeDesignReviewSetting } from "../../packages/broker/src/core/design-review/playbook-store.js";
import type { DesignReviewRuntime } from "../../packages/broker/src/core/design-review/round-ports.js";
import { COMPANY, createHarness, newRequestId, type Harness } from "../support/task-flow-harness.js";

export const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
export const SECTIONS = ["§1 Problem and goal", "§2 Current system", "§3 Proposed design", "§4 Alternatives", "§5 Risks", "§6 Areas touched", "§7 Assumptions", "§8 Sources"];
export const META = `\`\`\`rovara-design-meta\n${JSON.stringify({ touches: ["new_api"], repositories: ["demo"], services: [], sources: [] })}\n\`\`\``;
export const design = (extra = ""): string => `# Design\n${SECTIONS.map((section) => `## ${section}\ntext${section.startsWith("§3") ? `\n### 3.1 Retry\nR1: retry once.${extra}` : ""}`).join("\n")}\n${META}\n`;
export const REQUIREMENTS = "# Requirements\nR1: retry a timed-out payment once.\n";
export const BASE = "b".repeat(40);
export const NOW = "2026-11-09T10:00:00.000Z";

export interface World { runtime: DesignReviewRuntime; h: Harness; blobs: Map<string, string>; spend: Map<string, number>; results: Map<string, string>; taskId: string; workspaceId: string; seen: Set<string> }

export async function world(options: { price?: boolean; mode?: "always" | "auto" | "never"; allowSkip?: boolean; holdAnswerable?: boolean; tier?: "light" | "standard" | "thorough"; capUsd?: number; flag?: boolean } = {}): Promise<World> {
  const h = createHarness({ understandFirst: true, machines: { features: [...WORKER_INVOCATION_FEATURES] } });
  const blobs = new Map<string, string>();
  const results = new Map<string, string>();
  const spend = new Map<string, number>();
  h.deps.artifacts = { get: async (key) => (blobs.has(key) ? new TextEncoder().encode(blobs.get(key)) : undefined) };
  const runtime: DesignReviewRuntime = {
    reader: { get: (key) => h.store.get(key), allowedWhenAbsent: true },
    env: options.flag === false ? {} : { ROVARA_DESIGN_REVIEW: "1" },
    holdAnswerable: options.holdAnswerable === true,
    ports: {
      table: h.store, now: () => h.clock.now, proxy: () => ({ ok: true }),
      price: () => (options.price === false ? undefined : { inputUsdPerMTok: 3, outputUsdPerMTok: 15 }),
      capCeilingUsd: async () => undefined, taskRoomUsd: async () => 1_000,
      sourceReaders: async () => ({ readers: { readRepoFile: async () => undefined, readMetaFile: async () => undefined, fetchMcpItem: async () => ({ ok: false }) }, repositoryNames: [], origin: [] }),
    },
    model: async () => ({ selection: { provider: "anthropic", modelId: "m1" }, route: { alias: "anthropic/m1", api: "anthropic-messages", catalog: "m1" } as never, sourceId: "anthropic" }),
    keys: { closeKeys: async () => undefined, keySpend: async (ids) => ids.reduce((sum, id) => sum + (spend.get(id) ?? 0.05), 0) },
    readArtifactText: async (operation, name) => results.get(`${operation.id}:${name}`),
    putDocument: async (key, body) => { blobs.set(key, body); },
  };
  h.deps.designReview = createDesignReviewSteps(runtime);
  await h.registerProject();
  // The project asks for design review, always (the owner's own setting, held to a company lock that is not there).
  await writeDesignReviewSetting({ get: (key) => h.store.get(key), transact: (items) => h.store.transact(items), now: () => h.clock.now },
    { orgId: COMPANY, project: "payments", actorId: "local-owner", expectedRevision: 0, designReview: { mode: options.mode ?? "always", tier: options.tier ?? "light", allowSkip: options.allowSkip ?? true, capUsdPerTask: options.capUsd ?? 10, highRiskApprover: { kind: "maintainers" } } });
  const { task } = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Retry timed-out payments", workflow: true });
  return { runtime, h, blobs, spend, results, taskId: task.taskId, workspaceId: task.workspaceId, seen: new Set() };
}

/** The next job the flow hands to the worker for this workspace (the dispatch consumer runs until it does). */
export async function nextJob(w: World): Promise<{ invocation: WorkerInvocation; operation: OperationRecord }> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await w.h.flow.relayOnce();
    await w.h.flow.dispatchOnce({ maxMessages: 10 });
    const machineId = ((await w.h.store.get(workspaceKey(w.workspaceId)))?.["machine"] as { machineId?: string } | undefined)?.machineId;
    const fresh = machineId === undefined ? undefined : w.h.machines.delivered(machineId).find((job) => !w.seen.has(job.operationId));
    if (fresh !== undefined) {
      w.seen.add(fresh.operationId);
      return { invocation: fresh, operation: fromDocument<OperationRecord>(await w.h.store.get(operationKey(w.workspaceId, fresh.operationId)))! };
    }
    w.h.clock.advance(20);
  }
  throw new Error("the flow did not hand a job to the worker");
}

export const taskOf = async (w: World): Promise<TaskRecord & { workflow: WorkflowSnapshot }> => (await w.h.store.get(taskKey(w.taskId)) as unknown) as TaskRecord & { workflow: WorkflowSnapshot };
export const finish = (w: World, operation: OperationRecord, outcome?: unknown, status: "SUCCEEDED" | "FAILED" = "SUCCEEDED", error?: string) =>
  w.h.flow.recordResult({ workspaceId: w.workspaceId, operationId: operation.id, fence: operation.fence, status, ...(error === undefined ? {} : { error }), ...(outcome === undefined ? {} : { outcome: outcome as never }) });

/** A planner's document as the callback layer reads it: the text kept under its digest, and the workflow artifact that names it. */
export function planned(w: World, operation: OperationRecord, type: "requirements" | "design" | "plan", text: string, version: number) {
  const objectKey = `docs/${operation.id}.md`;
  w.blobs.set(objectKey, text);
  return { kind: "planned", artifact: { id: crypto.randomUUID(), type, version, sha256: sha(text), producer: "agentx-worker-untrusted", objectKey, createdAt: NOW, format: "markdown" } };
}

/** The owner's approval of the document waiting, as the gate's subject applies it (the engine's own move), with the row for the next planning step. */
export async function approve(w: World): Promise<void> {
  const task = await taskOf(w);
  const waiting = task.workflow;
  const digest = waiting.artifacts.at(-1)!.sha256;
  const after = decideWorkflow(waiting, { requestId: newRequestId(), expectedRevision: waiting.revision, decision: "APPROVE", artifactDigest: digest, reason: "ok" }, { actorId: waiting.ownerId, role: "TASK_OWNER" }, { now: NOW, allowedSkipStages: [] });
  const written = await w.h.store.transact([
    { kind: "update", key: taskKey(w.taskId), ops: [{ op: "set", path: ["workflow"], value: JSON.parse(JSON.stringify(after)) as never }], condition: { op: "eq", path: ["workflow", "revision"], value: waiting.revision } },
    dispatchRowItem(w.h.deps, w.taskId, after.revision, "PLAN", NOW),
  ]);
  expect(written.applied).toBe(true);
  await w.h.flow.sweepOnce();
}

/** What the worker saves for a round: every reviewer answers once, with the findings given for its role, and a report that names the key the broker minted for its slot. */
export async function answerRound(w: World, operation: OperationRecord, findingsFor: (role: string) => unknown[]): Promise<void> {
  const binding = DesignReviewBindingSchema.parse(operation.designReview);
  const reviewers = binding.reviewers.map((reviewer, index) => {
    const keyId = sha(`key:${operation.id}:${reviewer.keySlot}`);
    return {
      role: reviewer.role, keySlot: reviewer.keySlot, status: "answered", retried: false,
      report: { sessionId: `session-${operation.id}-${index}`, packetDigest: reviewer.packetDigest, firstRequestMessages: 2, filesRead: [], tools: ["read"], modelKeyId: keyId },
      answer: `Reviewed.\n\n\`\`\`${DESIGN_REVIEW_INFO_STRING}\n${JSON.stringify({ ...(reviewer.role === "critic" ? { paraphrase: { proposes: "Retry a timed-out payment once.", today: "A timed-out payment fails." } } : {}), findings: findingsFor(reviewer.role) })}\n\`\`\`\n`,
      tokensIn: 1_000, tokensOut: 100, costUsd: 0.04, startedAt: NOW, endedAt: NOW,
    };
  });
  const result = { version: 1, round: binding.round, reviewers, merge: { status: "skipped", tokensIn: 0, tokensOut: 0, costUsd: 0 }, findings: [], mergeSource: "code", omitted: 0, droppedCitations: [], droppedFindings: [], stageTimedOut: false };
  DesignReviewWorkerResultSchema.parse(result);
  w.results.set(`${operation.id}:design-review.json`, JSON.stringify(result));
  await finish(w, operation, { kind: "ended" });
}

/** The proxy's side of a round: each slot's key is minted once, and its id recorded (never the key). */
export async function mintKeys(w: World, operation: OperationRecord): Promise<void> {
  const binding = DesignReviewBindingSchema.parse(operation.designReview);
  for (const reviewer of binding.reviewers) {
    const ceiling = await readSlotCeiling(w.h.store, { orgId: COMPANY, operationId: operation.id, slot: reviewer.keySlot });
    expect(ceiling).toBeGreaterThan(0);
    expect(await putSlotKey(w.h.store, { orgId: COMPANY, operationId: operation.id, slot: reviewer.keySlot, purpose: "reviewer", round: binding.round, keyId: sha(`key:${operation.id}:${reviewer.keySlot}`), expiresAt: Date.now() + 1, budgetUsd: ceiling!, alias: "anthropic/m1", nowMs: Date.now() })).toBe(true);
  }
}

/** Understand, the requirements and their approval: the task then waits for its design to be written. */
export async function toDesignPhase(w: World): Promise<void> {
  const prepare = await nextJob(w);
  await finish(w, prepare.operation, { kind: "prepared", base: [{ repositoryId: "demo", baseCommitSha: BASE }] });
  const understand = await nextJob(w);
  expect(understand.invocation.payload).toMatchObject({ workflowMode: "UNDERSTAND" });
  await finish(w, understand.operation, { kind: "understood", assessment: { kind: "ready", path: "QUICK", restatement: "Retry timed-out payments once.", assumptions: [], design: { needed: true, reasons: ["new_api"], note: "Adds a retry" } } });
  // The design review forces the Full path: the first document is the requirements.
  expect((await taskOf(w)).workflow).toMatchObject({ path: "FULL", stage: "PLAN", designReview: { status: "estimating", decidedBy: "always" } });
  const requirements = await nextJob(w);
  await finish(w, requirements.operation, planned(w, requirements.operation, "requirements", REQUIREMENTS, 1));
  expect((await taskOf(w)).workflow).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", reviewPhase: "REQUIREMENTS" });
  await approve(w);
}

/** The design written and handed to the reviewers: the planner's document is submitted and the round (or the review's end) follows. */
export async function toRound(w: World): Promise<void> {
  await toDesignPhase(w);
  const planning = await nextJob(w);
  await finish(w, planning.operation, planned(w, planning.operation, "design", design(), 1));
}

/** A design waiting at the owner's approval with one blocker the planner declined (so it stays open). */
export async function waitingWithBlocker(w: World): Promise<WorkflowSnapshot> {
  await toRound(w);
  const round1 = await nextJob(w);
  await mintKeys(w, round1.operation);
  await answerRound(w, round1.operation, () => [{ id: "1", severity: "blocker", section: "§3", text: "Nothing bounds the retry.", citations: [{ kind: "design", section: "§3" }] }]);
  const run = await nextJob(w);
  const ids = (await taskOf(w)).workflow.designReview!.rounds[0]!.findings.map((finding) => finding.id);
  w.results.set(`${run.operation.id}:plan.md`, `${design()}\n\`\`\`rovara-design-resolve\n${JSON.stringify({ resolutions: ids.map((findingId) => ({ findingId, action: "declined", note: "Left to the owner." })) })}\n\`\`\`\n`);
  await finish(w, run.operation, { kind: "ended" });
  return (await taskOf(w)).workflow;
}

