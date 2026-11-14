import { describe, expect, it } from "vitest";
import {
  PARALLEL_PARTS_MAX, WorkItemProgressV1Schema, WorkflowDependencyInvocationSchema, parallelPartsFor, taskGraphDigest,
  workflowDependencyAttemptTerminalProgress, type TaskGraphV1, type WorkItemProgressV1,
} from "../../packages/contracts/src/index.js";

const taskId = "8c330a74-b4c6-4f01-9356-5fe54fc55b19";
const runId = "8c330a74-b4c6-4f01-9356-5fe54fc55b21";
const operationId = "8c330a74-b4c6-4f01-9356-5fe54fc55b20";
const EARLIER = "8c330a74-b4c6-4f01-9356-5fe54fc55b10";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const graph: TaskGraphV1 = {
  schemaVersion: 1, taskId, version: 1,
  items: [
    { id: A, title: "A", description: "A.", repository: "repo", dependsOn: [] },
    { id: B, title: "B", description: "B.", repository: "repo", dependsOn: [] },
    { id: C, title: "C", description: "C.", repository: "repo", dependsOn: [A, B] },
  ],
};
const digest = taskGraphDigest(graph);
const approval = { artifactDigest: "a".repeat(64), graphDigest: digest, workflowRevision: 2, actorId: "b".repeat(64), runId };
const tree = (digit: string) => digit.repeat(40);
let clock = 0;
function event(itemId: string, sequence: number, state: WorkItemProgressV1["state"], baseTreeSha: string, extra: Partial<WorkItemProgressV1> = {}): WorkItemProgressV1 {
  clock += 1;
  return WorkItemProgressV1Schema.parse({
    schemaVersion: 1, graphDigest: digest, runId, itemId, sequence, state, operationId, baseTreeSha,
    ...(state === "IMPLEMENTED" ? { candidateTreeSha: tree("c") } : {}),
    at: new Date(Date.UTC(2026, 9, 26, 12, 0, clock)).toISOString(), producer: "agentx-worker", ...extra,
  });
}
const project = (history: WorkItemProgressV1[], over: Record<string, unknown> = {}) =>
  workflowDependencyAttemptTerminalProgress({ graph, approval, operationId, sequenceStart: 0, resumeProgress: [], history, parallel: { max: 3 }, ...over });

describe("parallel parts: contract shapes", () => {
  it("the invocation carries parallel.max, from 1 to the plan's cap, and nothing else", () => {
    const base = { approval, graph };
    expect(WorkflowDependencyInvocationSchema.safeParse({ ...base, parallel: { max: PARALLEL_PARTS_MAX } }).success).toBe(true);
    expect(WorkflowDependencyInvocationSchema.safeParse({ ...base, parallel: { max: PARALLEL_PARTS_MAX + 1 } }).success).toBe(false);
    expect(WorkflowDependencyInvocationSchema.safeParse({ ...base, parallel: { max: 0 } }).success).toBe(false);
    expect(WorkflowDependencyInvocationSchema.safeParse({ ...base, parallel: { max: 2, perPartUsd: 5 } }).success).toBe(false);
  });

  it("an integrated tree can be named only by implemented progress", () => {
    expect(() => event(A, 1, "IMPLEMENTED", tree("a"), { integratedTreeSha: tree("d") })).not.toThrow();
    expect(() => event(A, 1, "STARTED", tree("a"), { integratedTreeSha: tree("d") })).toThrow();
    expect(() => event(A, 1, "FAILED", tree("a"), { integratedTreeSha: tree("d") })).toThrow();
  });

  it("the number of parts follows the capacity and never passes the plan's cap", () => {
    expect(parallelPartsFor(1)).toBe(1);
    expect(parallelPartsFor(2)).toBe(2);
    expect(parallelPartsFor(PARALLEL_PARTS_MAX)).toBe(PARALLEL_PARTS_MAX);
    expect(parallelPartsFor(500)).toBe(PARALLEL_PARTS_MAX);
    expect(parallelPartsFor(0)).toBe(1);
    expect(parallelPartsFor(Number.NaN)).toBe(1);
  });
});

describe("parallel parts: the checkpoints of one attempt", () => {
  it("accepts two starts before any finish, then the dependent item", () => {
    const history = [
      event(A, 1, "STARTED", tree("a")), event(B, 2, "STARTED", tree("a")),
      event(B, 3, "IMPLEMENTED", tree("a"), { integratedTreeSha: tree("1") }),
      event(A, 4, "IMPLEMENTED", tree("a"), { integratedTreeSha: tree("2") }),
      event(C, 5, "STARTED", tree("2")), event(C, 6, "IMPLEMENTED", tree("2"), { integratedTreeSha: tree("3") }),
    ];
    expect(project(history)?.map((entry) => entry.itemId)).toEqual([A, B, C]);
  });

  it("refuses a start whose dependencies are not implemented", () => {
    expect(project([event(A, 1, "STARTED", tree("a")), event(C, 2, "STARTED", tree("a"))])).toBeUndefined();
  });

  it("refuses more starts than the cap allows", () => {
    expect(project([event(A, 1, "STARTED", tree("a")), event(B, 2, "STARTED", tree("a"))], { parallel: { max: 1 } })).toBeUndefined();
    expect(project([event(A, 1, "STARTED", tree("a")), event(B, 2, "STARTED", tree("a"))], { parallel: { max: 2 } })).toBeDefined();
  });

  it("refuses a finish with no start, or with another base tree", () => {
    expect(project([event(A, 1, "IMPLEMENTED", tree("a"))])).toBeUndefined();
    expect(project([event(A, 1, "STARTED", tree("a")), event(A, 2, "IMPLEMENTED", tree("b"))])).toBeUndefined();
  });

  it("lets a part that is already running finish after another failed, but starts nothing new", () => {
    const failed = [event(A, 1, "STARTED", tree("a")), event(B, 2, "STARTED", tree("a")), event(A, 3, "FAILED", tree("a"))];
    expect(project([...failed, event(B, 4, "IMPLEMENTED", tree("a"), { integratedTreeSha: tree("1") })])?.map((entry) => entry.state)).toEqual(["FAILED", "IMPLEMENTED"]);
    expect(project([...failed, event(C, 4, "STARTED", tree("a"))])).toBeUndefined();
    // An independent part that has not started is not started after a failure either.
    expect(project([event(A, 1, "STARTED", tree("a")), event(A, 2, "FAILED", tree("a")), event(B, 3, "STARTED", tree("a"))])).toBeUndefined();
  });

  it("allows one restart of a part after a merge conflict, never a second", () => {
    const first = [event(A, 1, "STARTED", tree("a")), event(A, 2, "STARTED", tree("1"))];
    expect(project(first)).toBeDefined();
    expect(project([...first, event(A, 3, "STARTED", tree("2"))])).toBeUndefined();
    expect(project([event(A, 1, "STARTED", tree("a")), event(A, 2, "STARTED", tree("a"))])).toBeUndefined();
  });

  it("refuses a start of an item that is already implemented", () => {
    const history = [event(A, 1, "STARTED", tree("a")), event(A, 2, "IMPLEMENTED", tree("a")), event(A, 3, "STARTED", tree("a"))];
    expect(project(history)).toBeUndefined();
  });

  it("keeps the retained finished parts when they are closed under dependencies, and refuses a set that is not", () => {
    const b = event(B, 1, "IMPLEMENTED", tree("a"), { integratedTreeSha: tree("1"), operationId: EARLIER });
    expect(project([b], { sequenceStart: 1, resumeProgress: [b], history: [b] })?.map((entry) => entry.itemId)).toEqual([B]);
    const c = event(C, 2, "IMPLEMENTED", tree("1"), { integratedTreeSha: tree("2"), operationId: EARLIER });
    expect(project([b, c], { sequenceStart: 2, resumeProgress: [b, c], history: [b, c] })).toBeUndefined();
  });

  it("requires the retained entries to be in the stored history", () => {
    const b = event(B, 1, "IMPLEMENTED", tree("a"), { operationId: EARLIER });
    expect(project([], { sequenceStart: 1, resumeProgress: [b], history: [] })).toBeUndefined();
  });

  it("refuses events of another operation after the cursor", () => {
    expect(project([event(A, 1, "STARTED", tree("a"), { operationId: "8c330a74-b4c6-4f01-9356-5fe54fc55b99" })])).toBeUndefined();
  });

  it("without the parallel flag the serial rules are unchanged", () => {
    const history = [event(A, 1, "STARTED", tree("a")), event(B, 2, "STARTED", tree("a"))];
    expect(project(history, { parallel: undefined })).toBeUndefined();
  });
});
