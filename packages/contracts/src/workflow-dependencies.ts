import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";

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

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const TreeSchema = z.string().regex(/^[a-f0-9]{40}$/);

export const WorkflowDependencyApprovalSchema = z.object({
  artifactDigest: DigestSchema,
  graphDigest: DigestSchema,
  workflowRevision: z.number().int().positive(),
  actorId: z.string().regex(/^[a-f0-9]{64}$/),
  runId: z.string().uuid(),
}).strict();
export type WorkflowDependencyApproval = z.infer<typeof WorkflowDependencyApprovalSchema>;

export const WorkItemProgressV1Schema = z.object({
  schemaVersion: z.literal(1),
  graphDigest: DigestSchema,
  runId: z.string().uuid(),
  itemId: z.string().uuid(),
  sequence: z.number().int().positive(),
  state: z.enum(["STARTED", "IMPLEMENTED", "FAILED", "UNKNOWN"]),
  operationId: z.string().uuid(),
  baseTreeSha: TreeSchema,
  candidateTreeSha: TreeSchema.optional(),
  at: z.string().datetime(),
  producer: z.string().trim().min(1).max(80),
}).strict().superRefine((progress, context) => {
  if (progress.state === "IMPLEMENTED" && progress.candidateTreeSha === undefined) {
    context.addIssue({ code: "custom", path: ["candidateTreeSha"], message: "implemented progress requires a candidate tree" });
  }
  if (progress.state !== "IMPLEMENTED" && progress.candidateTreeSha !== undefined) {
    context.addIssue({ code: "custom", path: ["candidateTreeSha"], message: "only implemented progress may name a candidate tree" });
  }
});
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

export const WorkflowDependencyInvocationSchema = z.object({
  approval: WorkflowDependencyApprovalSchema,
  graph: TaskGraphV1Schema,
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
