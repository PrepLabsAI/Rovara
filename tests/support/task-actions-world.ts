// The owner's moves on a task already running (send back, review findings, continue), on the W0 fakes: one task whose workflow is seeded in the state the move starts from, its workspace ready, an approved plan the
// coder can read back, and a small reader for what the move left behind (the operations, the dispatch rows, the audit).
import { createHash, randomUUID } from "node:crypto";
import { WorkflowSnapshotSchema, createCandidateManifest, createWorkflowSnapshot, queryAll, workflowFindingFingerprint, type JsonValue, type WorkflowSnapshot } from "@agentx/contracts";
import { taskOwnerKey } from "../../packages/broker/src/developer/task-records.js";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import type { TaskCaller, TaskFlowDeps } from "../../packages/broker/src/core/task-flow/deps.js";
import { dispatchPartition, developerCharge, taskKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { readTask, workspaceOperations } from "../../packages/broker/src/core/task-flow/reads.js";
import type { OperationRecord, TaskRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { COMPANY, createHarness, type Harness, type HarnessOptions } from "./task-flow-harness.js";

export const NOW = "2026-11-10T10:00:00.000Z";
export const TASK_ID = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
export const WORKSPACE_ID = "0f1d2c3b-4a59-4687-8695-a4b3c2d1e0f9";
export const OWNER_KEY = taskOwnerKey("local-owner", TASK_ID);
export const REQUEST_A = "22222222-2222-4222-8222-222222222222";
export const REQUEST_B = "33333333-3333-4333-8333-333333333333";

export const code = createCandidateManifest([{ repositoryId: "demo", commitSha: "1".repeat(40), treeSha: "1".repeat(40), baseCommitSha: "e".repeat(40) }]);

/** The coding plan the owner approved, as a Markdown document the coder reads back. */
export const PLAN_TEXT = "# Plan\n1. Add the retry flag to src/retry/backoff.ts.\n2. Run the unit tests.\n";
const planSha = createHash("sha256").update(PLAN_TEXT, "utf8").digest("hex");
export const PLAN_ARTIFACT = { id: "plan-1", type: "plan", version: 1, sha256: planSha, producer: "agentx-worker-untrusted", objectKey: `tasks/${TASK_ID}/plan-1.md`, createdAt: NOW } as const;
const artifactReader = { get: async (key: string) => (key === PLAN_ARTIFACT.objectKey ? new TextEncoder().encode(PLAN_TEXT) : undefined) };

export const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export const PARSER = { text: "New parser drops the last line.", origin: "INTRODUCED" as const, file: "src/parse.ts", line: 12 };
export const TOKEN = { text: "A token is written to the log.", origin: "INTRODUCED" as const };
export const parserId = workflowFindingFingerprint("CRITIC", PARSER);
export const tokenId = workflowFindingFingerprint("SECURITY", TOKEN);

export const report = (role: "CRITIC" | "SECURITY", status: "PASS" | "FINDINGS" | "FAILED", findings: unknown[], digest = code.digest) =>
  ({ operationId: "11111111-1111-4111-8111-111111111111", candidateDigest: digest, role, provider: "scripted", version: "1", status, findings, readOnly: true, recordedAt: NOW });

/** A workflow blocked at the reviews, which found `findings` in the critic's report (and a passing security review unless told). */
export function blockedReview(extra: Record<string, unknown> = {}, reviews: unknown[] = [report("CRITIC", "FINDINGS", [PARSER]), report("SECURITY", "PASS", [])]): WorkflowSnapshot {
  return WorkflowSnapshotSchema.parse({
    ...createWorkflowSnapshot({ taskId: TASK_ID, ownerId: OWNER_KEY, now: NOW, definitionVersion: "1.1.0" }),
    stage: "REVIEW", state: "BLOCKED", blockReason: "the critic review did not pass", revision: 6, candidate: code,
    checkPolicy: { required: [{ id: "unit", label: "Unit", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } }], optional: [], selectedOptionalIds: [], proposed: [] },
    verification: { candidateDigest: code.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: NOW, results: [{ checkId: "unit", status: "PASS" }] },
    artifacts: [PLAN_ARTIFACT], reviews, ...extra,
  });
}

export interface Seeded { h: Harness; caller: TaskCaller }

export interface SeedOptions {
  harness?: HarnessOptions;
  workflow?: WorkflowSnapshot | null;
  task?: Record<string, unknown>;
  workspace?: Record<string, unknown>;
  /** Replaces the deps' access (a hosted product's roles). */
  access?: TaskFlowDeps["access"];
}

/** A task in the given state (a workflow, or none for a plain task), its workspace ready, the plan readable. */
export async function seed(options: SeedOptions = {}): Promise<Seeded> {
  const h = createHarness({ audit: "recording", ...options.harness });
  await h.registerProject();
  h.deps.artifacts = artifactReader;
  if (options.access !== undefined) h.deps.access = options.access;
  const workflow = options.workflow === undefined ? blockedReview() : options.workflow;
  await h.store.put({ item: {
    ...taskKey(TASK_ID), entityType: "DEVELOPER_TASK", taskId: TASK_ID, companyId: COMPANY, developerId: "local-owner", provider: "local-owner", developerName: "Local owner", client: "test", project: "payments", title: "Add a retry flag",
    workspaceId: WORKSPACE_ID, ownerKey: OWNER_KEY, conversationId: randomUUID(), startingRevision: 1, charge: plain(developerCharge({ companyId: COMPANY, developerId: "local-owner" })), shared: false, createdAt: NOW, updatedAt: NOW,
    ...(workflow === null ? {} : { workflow: plain(workflow) as unknown as JsonValue }), ...options.task,
  } as never });
  await h.store.put({ item: { ...workspaceKey(WORKSPACE_ID), entityType: "WORKSPACE", id: WORKSPACE_ID, companyId: COMPANY, orgId: COMPANY, ownerKey: OWNER_KEY, projectName: "payments", projectRevision: 1, status: "READY", activeOperationId: null, fence: 1,
    workspaceProject: "payments", workspaceCreatedAt: NOW, createdAt: NOW, updatedAt: NOW, ...options.workspace } });
  return { h, caller: h.owner };
}

export const taskOf = async (h: Harness): Promise<TaskRecord> => (await readTask(h.deps, TASK_ID))!;
export const operationsOf = async (h: Harness): Promise<OperationRecord[]> => workspaceOperations(h.deps, WORKSPACE_ID);
export const codingOperations = async (h: Harness): Promise<OperationRecord[]> => (await operationsOf(h)).filter((operation) => operation.workflowMode === "IMPLEMENT");
export const promptOf = (operation: OperationRecord): string => String((operation.dispatch.payload as { prompt?: unknown }).prompt);
export const dispatchRows = async (h: Harness): Promise<unknown[]> => (await queryAll(h.store, { pk: dispatchPartition(COMPANY), sk: { op: "beginsWith", prefix: `${TASK_ID}#` } }));
export const auditActions = (h: Harness): string[] => h.audit.map((event) => event.action);

/** Everything a move writes, counted, so a refused move can be shown to have written nothing: the workflow, the operations, the dispatch rows, the audit lines and the kept words. */
export async function stateOf(h: Harness): Promise<{ workflow: WorkflowSnapshot | undefined; operations: number; rows: number; audit: number; notes: number }> {
  return {
    workflow: (await taskOf(h)).workflow, operations: (await operationsOf(h)).length, rows: (await dispatchRows(h)).length, audit: h.audit.length,
    notes: (await h.store.query({ pk: `DEVTASK#${TASK_ID}`, sk: { op: "beginsWith", prefix: "OWNER_NOTE#" } })).items.length,
  };
}

/** The same access as Code's, with the owner's moves refused to everyone: a person who may see and drive the task without being an owner of it. */
export function accessWithoutOwners(): TaskFlowDeps["access"] {
  const base = createOwnerTaskAccess();
  return { ...base, canAct: async () => true, ownerActing: async () => undefined };
}
