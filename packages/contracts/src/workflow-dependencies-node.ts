import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import { PARALLEL_PARTS_MAX } from "./rovara-code.js";
import { WorkflowDependencyApprovalSchema, WorkItemProgressV1Schema, DigestSchema, TreeSchema } from "./workflow-dependencies.js";
import { createHash } from "node:crypto";

export const TASK_GRAPH_ITEMS_MAX = 8;

export const TASK_GRAPH_EDGES_MAX = 12;

export const TASK_GRAPH_CANONICAL_BYTES_MAX = 16_384;

const GraphItemSchema = z.object({
  id: z.string().uuid(),
  title: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(2_000),
  repository: z.string().trim().min(1).max(200),
  dependsOn: z.array(z.string().uuid()).max(TASK_GRAPH_ITEMS_MAX),
}).strict();

export const TaskGraphV1Schema = z.object({
  schemaVersion: z.literal(1),
  taskId: z.string().uuid(),
  version: z.number().int().positive(),
  items: z.array(GraphItemSchema).min(1).max(TASK_GRAPH_ITEMS_MAX),
}).strict().superRefine((graph, context) => {
  const ids = graph.items.map((item) => item.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", path: ["items"], message: "item IDs must be unique" });
  }
  const known = new Set(ids);
  let edgeCount = 0;
  graph.items.forEach((item, index) => {
    if (new Set(item.dependsOn).size !== item.dependsOn.length) {
      context.addIssue({ code: "custom", path: ["items", index, "dependsOn"], message: "dependencies must be unique" });
    }
    edgeCount += item.dependsOn.length;
    item.dependsOn.forEach((dependency, dependencyIndex) => {
      if (!known.has(dependency)) {
        context.addIssue({ code: "custom", path: ["items", index, "dependsOn", dependencyIndex], message: "dependency must reference an item in this graph" });
      } else if (dependency === item.id) {
        context.addIssue({ code: "custom", path: ["items", index, "dependsOn", dependencyIndex], message: "an item cannot depend on itself" });
      }
    });
  });
  if (edgeCount > TASK_GRAPH_EDGES_MAX) {
    context.addIssue({ code: "custom", path: ["items"], message: `graph has more than ${TASK_GRAPH_EDGES_MAX} dependency edges` });
  }
  if (graph.items.length > 0 && graph.items.some((item) => item.repository !== graph.items[0]?.repository)) {
    context.addIssue({ code: "custom", path: ["items"], message: "all items must use the same repository" });
  }
  if (Buffer.byteLength(canonicalJson(graph), "utf8") > TASK_GRAPH_CANONICAL_BYTES_MAX) {
    context.addIssue({ code: "custom", path: [], message: `canonical graph exceeds ${TASK_GRAPH_CANONICAL_BYTES_MAX} bytes` });
  }
  if (isCyclic(graph.items)) {
    context.addIssue({ code: "custom", path: ["items"], message: "dependencies must form a directed acyclic graph" });
  }
});

export type TaskGraphV1 = z.infer<typeof TaskGraphV1Schema>;

export type WorkflowDependencyApproval = z.infer<typeof WorkflowDependencyApprovalSchema>;

export type WorkItemProgressV1 = z.infer<typeof WorkItemProgressV1Schema>;

export const WorkflowDependencyResultSchema = z.object({
  schemaVersion: z.literal(1),
  taskId: z.string().uuid(),
  graphDigest: DigestSchema,
  runId: z.string().uuid(),
  operationId: z.string().uuid(),
  workflowRevision: z.number().int().positive(),
  status: z.enum(["SUCCEEDED", "FAILED", "UNKNOWN"]),
  items: z.array(WorkItemProgressV1Schema).min(1).max(TASK_GRAPH_ITEMS_MAX),
  candidateDigest: DigestSchema.optional(),
  at: z.string().datetime(),
}).strict().superRefine((result, context) => {
  if (new Set(result.items.map((item) => item.itemId)).size !== result.items.length) {
    context.addIssue({ code: "custom", path: ["items"], message: "result item IDs must be unique" });
  }
  if (result.items.some((item) => item.graphDigest !== result.graphDigest || item.runId !== result.runId)) {
    context.addIssue({ code: "custom", path: ["items"], message: "result item progress must match its graph and run" });
  }
  if (result.status === "SUCCEEDED" && (result.items.some((item) => item.state !== "IMPLEMENTED") || result.candidateDigest === undefined)) {
    context.addIssue({ code: "custom", path: ["status"], message: "success requires every item implemented and a final candidate" });
  }
  if (result.status !== "SUCCEEDED" && result.candidateDigest !== undefined) {
    context.addIssue({ code: "custom", path: ["candidateDigest"], message: "a failed or unknown result cannot claim a final candidate" });
  }
});

export type WorkflowDependencyResult = z.infer<typeof WorkflowDependencyResultSchema>;

/**
 * Independent parts that build at once on the task's one machine (Rovara Code v2 only). `max` is the most that run together, never above PARALLEL_PARTS_MAX. It is the
 * only knob: parts have no spending limit of their own. They all draw on the operation's one model key, so their total can never pass the task's limits.
 */
export const WorkflowParallelSchema = z.object({ max: z.number().int().min(1).max(PARALLEL_PARTS_MAX) }).strict();
export type WorkflowParallel = z.infer<typeof WorkflowParallelSchema>;

/** How many parts may run together when the org has room for `capacity` of them: at most the plan's cap, at least one (one part is the serial run). */
export function parallelPartsFor(capacity: number): number {
  if (!Number.isFinite(capacity)) return 1;
  return Math.max(1, Math.min(PARALLEL_PARTS_MAX, Math.floor(capacity)));
}

export const WorkflowDependencyInvocationSchema = z.object({
  approval: WorkflowDependencyApprovalSchema,
  graph: TaskGraphV1Schema,
  /** Present only for a Rovara Code v2 task, and only sent to a worker that lists task.workflowParallelParts. Absent: one item at a time. */
  parallel: WorkflowParallelSchema.optional(),
  /** Exact retained tree checkpoint required for an explicit retry after a stopped run. */
  resumeTreeSha: TreeSchema.optional(),
  /** Monotonic progress cursor for this approved run, including acknowledged checkpoints from prior operations. */
  sequenceStart: z.number().int().nonnegative().optional(),
  /** The People revision fenced when the Owner accepted this exact graph operation. */
  peopleRevision: z.number().int().nonnegative().optional(),
  /** Latest terminal checkpoints retained from earlier operations of this same approved graph. */
  resumeProgress: z.array(WorkItemProgressV1Schema).max(TASK_GRAPH_ITEMS_MAX).optional(),
}).strict().superRefine((invocation, context) => {
  if (taskGraphDigest(invocation.graph) !== invocation.approval.graphDigest) {
    context.addIssue({ code: "custom", path: ["approval", "graphDigest"], message: "approval digest does not match the invoked graph" });
  }
  if (invocation.resumeProgress !== undefined && (invocation.resumeProgress.some((item) => item.graphDigest !== invocation.approval.graphDigest
    || item.runId !== invocation.approval.runId || item.state === "STARTED" || item.sequence > (invocation.sequenceStart ?? 0))
    || new Set(invocation.resumeProgress.map((item) => item.itemId)).size !== invocation.resumeProgress.length)) {
    context.addIssue({ code: "custom", path: ["resumeProgress"], message: "retained progress must be unique, terminal and bound to this approved graph run" });
  }
});

export type WorkflowDependencyInvocation = z.infer<typeof WorkflowDependencyInvocationSchema>;

export type TaskGraphValidation =
  | { ok: true; graph: TaskGraphV1 }
  | { ok: false; errors: string[] };

export interface TaskGraphValidationContext {
  taskId: string;
  repositoryId: string;
}

function isCyclic(items: ReadonlyArray<z.infer<typeof GraphItemSchema>>): boolean {
  const ids = new Set(items.map((item) => item.id));
  const visited = new Set<string>();
  const active = new Set<string>();
  const byId = new Map(items.map((item) => [item.id, item] as const));
  const visit = (id: string): boolean => {
    if (active.has(id)) return true;
    if (visited.has(id)) return false;
    active.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (ids.has(dependency) && visit(dependency)) return true;
    }
    active.delete(id);
    visited.add(id);
    return false;
  };
  return items.some((item) => visit(item.id));
}

export function validateTaskGraph(input: unknown, expected: TaskGraphValidationContext): TaskGraphValidation {
  const parsed = TaskGraphV1Schema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.slice(0, 20).map((issue) => `${issue.path.join(".") || "graph"}: ${issue.message}`) };
  }
  if (parsed.data.taskId !== expected.taskId) return { ok: false, errors: ["graph.taskId: does not match the current task"] };
  if (parsed.data.items.some((item) => item.repository !== expected.repositoryId)) {
    return { ok: false, errors: ["graph.items.repository: does not match the task's pinned repository"] };
  }
  return { ok: true, graph: parsed.data };
}

/** SHA-256 of canonical graph bytes; arrays retain their submitted order. */
export function taskGraphDigest(graph: TaskGraphV1): string {
  return createHash("sha256").update(canonicalJson(graph), "utf8").digest("hex");
}

/** Stable Kahn ordering. Among currently-ready items, submitted position wins ties. */
export function taskGraphOrder(input: unknown): string[] {
  const parsed = TaskGraphV1Schema.parse(input);
  const position = new Map(parsed.items.map((item, index) => [item.id, index] as const));
  const remaining = new Map(parsed.items.map((item) => [item.id, new Set(item.dependsOn)] as const));
  const result: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, dependencies]) => dependencies.size === 0)
      .map(([id]) => id)
      .sort((left, right) => (position.get(left) ?? 0) - (position.get(right) ?? 0));
    const next = ready[0];
    if (next === undefined) throw new TypeError("graph dependencies contain a cycle");
    result.push(next);
    remaining.delete(next);
    for (const dependencies of remaining.values()) dependencies.delete(next);
  }
  return result;
}

/**
 * Project terminal checkpoints for one immutable operation attempt. The durable event log is the
 * audit history; snapshot progress is a bounded checkpoint window. Only the binding's explicit
 * retained prefix and acknowledgements after its cursor can qualify this attempt.
 */
export function workflowDependencyAttemptTerminalProgress(input: {
  graph: TaskGraphV1;
  approval: WorkflowDependencyApproval;
  operationId: string | undefined;
  sequenceStart: number | undefined;
  resumeProgress: readonly WorkItemProgressV1[] | undefined;
  history: readonly WorkItemProgressV1[];
  /** The operation's parallel setting (Rovara Code v2). With it several items may run at once; without it the rules are the serial ones, unchanged. */
  parallel?: WorkflowParallel | undefined;
}): WorkItemProgressV1[] | undefined {
  const { graph, approval, operationId } = input;
  if (operationId === undefined || !/^[0-9a-f-]{36}$/.test(operationId)) return undefined;
  const sequenceStart = input.sequenceStart ?? 0;
  if (!Number.isSafeInteger(sequenceStart) || sequenceStart < 0 || taskGraphDigest(graph) !== approval.graphDigest) return undefined;
  if (input.parallel !== undefined) return parallelAttemptTerminalProgress({ ...input, operationId, sequenceStart, parallel: input.parallel });
  const order = taskGraphOrder(graph);
  const retained = input.resumeProgress ?? [];
  if (retained.length > order.length) return undefined;
  const terminals = new Map<string, WorkItemProgressV1>();
  let previousRetained: WorkItemProgressV1 | undefined;
  for (const [index, entry] of retained.entries()) {
    if (entry.itemId !== order[index] || entry.state === "STARTED" || entry.graphDigest !== approval.graphDigest || entry.runId !== approval.runId
      || entry.sequence > sequenceStart || (previousRetained !== undefined && (entry.sequence <= previousRetained.sequence
        || previousRetained.state !== "IMPLEMENTED" || previousRetained.candidateTreeSha !== entry.baseTreeSha))
      || !input.history.some((historical) => historical.sequence === entry.sequence && canonicalJson(historical) === canonicalJson(entry))) return undefined;
    terminals.set(entry.itemId, entry);
    previousRetained = entry;
  }

  if (input.history.some((entry) => entry.operationId === operationId && entry.sequence <= sequenceStart)) return undefined;
  const later = input.history.filter((entry) => entry.sequence > sequenceStart);
  if (later.some((entry) => entry.operationId !== operationId)) return undefined;
  later.sort((left, right) => left.sequence - right.sequence);
  let expectedSequence = sequenceStart + 1;
  let active: WorkItemProgressV1 | undefined;
  let halted = false;
  const firstUnimplemented = (): string | undefined => order.find((itemId) => terminals.get(itemId)?.state !== "IMPLEMENTED");
  for (const entry of later) {
    if (entry.sequence !== expectedSequence++ || entry.operationId !== operationId || entry.graphDigest !== approval.graphDigest || entry.runId !== approval.runId
      || halted) return undefined;
    if (entry.state === "STARTED") {
      if (active !== undefined || entry.itemId !== firstUnimplemented()) return undefined;
      active = entry;
      continue;
    }
    if (active === undefined || active.itemId !== entry.itemId || active.baseTreeSha !== entry.baseTreeSha) return undefined;
    active = undefined;
    terminals.set(entry.itemId, entry);
    if (entry.state !== "IMPLEMENTED") halted = true;
  }
  return order.flatMap((itemId) => {
    const entry = terminals.get(itemId);
    return entry === undefined ? [] : [entry];
  });
}

/**
 * The checkpoint rules of an operation that may run several items at once. Retained progress is any set of finished items closed under dependencies (a finished item's
 * dependencies are finished too). Within the attempt, an item starts only when its dependencies are implemented and fewer than `parallel.max` are running; nothing new
 * starts once an item failed (items already running may still finish). An item may start once more, at a different tree, after its first run conflicted when merged.
 * A finish needs a running start with the same base tree. Tree continuity is the broker's check; here only the shape is judged.
 */
function parallelAttemptTerminalProgress(input: {
  graph: TaskGraphV1;
  approval: WorkflowDependencyApproval;
  operationId: string;
  sequenceStart: number;
  resumeProgress: readonly WorkItemProgressV1[] | undefined;
  history: readonly WorkItemProgressV1[];
  parallel: WorkflowParallel;
}): WorkItemProgressV1[] | undefined {
  const { graph, approval, operationId, sequenceStart } = input;
  const order = taskGraphOrder(graph);
  const itemById = new Map(graph.items.map((item) => [item.id, item] as const));
  const terminals = new Map<string, WorkItemProgressV1>();
  const retained = input.resumeProgress ?? [];
  if (retained.length > order.length) return undefined;
  for (const entry of retained) {
    if (!itemById.has(entry.itemId) || terminals.has(entry.itemId) || entry.state === "STARTED" || entry.graphDigest !== approval.graphDigest || entry.runId !== approval.runId
      || entry.sequence > sequenceStart || !input.history.some((historical) => historical.sequence === entry.sequence && canonicalJson(historical) === canonicalJson(entry))) return undefined;
    terminals.set(entry.itemId, entry);
  }
  const implemented = (itemId: string): boolean => terminals.get(itemId)?.state === "IMPLEMENTED";
  for (const entry of terminals.values()) {
    if (entry.state === "IMPLEMENTED" && itemById.get(entry.itemId)!.dependsOn.some((dependency) => !implemented(dependency))) return undefined;
  }

  if (input.history.some((entry) => entry.operationId === operationId && entry.sequence <= sequenceStart)) return undefined;
  const later = input.history.filter((entry) => entry.sequence > sequenceStart);
  if (later.some((entry) => entry.operationId !== operationId)) return undefined;
  later.sort((left, right) => left.sequence - right.sequence);
  let expectedSequence = sequenceStart + 1;
  const running = new Map<string, WorkItemProgressV1>();
  const starts = new Map<string, number>();
  let halted = false;
  for (const entry of later) {
    if (entry.sequence !== expectedSequence++ || entry.operationId !== operationId || entry.graphDigest !== approval.graphDigest || entry.runId !== approval.runId) return undefined;
    const item = itemById.get(entry.itemId);
    if (item === undefined) return undefined;
    if (entry.state === "STARTED") {
      if (halted || implemented(entry.itemId) || item.dependsOn.some((dependency) => !implemented(dependency))) return undefined;
      const open = running.get(entry.itemId);
      if (open !== undefined) {
        if (open.baseTreeSha === entry.baseTreeSha || (starts.get(entry.itemId) ?? 1) >= 2) return undefined;
      } else if (running.size >= input.parallel.max) {
        return undefined;
      }
      starts.set(entry.itemId, (starts.get(entry.itemId) ?? 0) + 1);
      running.set(entry.itemId, entry);
      continue;
    }
    const open = running.get(entry.itemId);
    if (open === undefined || open.baseTreeSha !== entry.baseTreeSha) return undefined;
    running.delete(entry.itemId);
    terminals.set(entry.itemId, entry);
    if (entry.state !== "IMPLEMENTED") halted = true;
  }
  return order.flatMap((itemId) => {
    const entry = terminals.get(itemId);
    return entry === undefined ? [] : [entry];
  });
}

export { DigestSchema, TreeSchema, WorkflowDependencyApprovalSchema, WorkItemProgressV1Schema } from "./workflow-dependencies.js";
