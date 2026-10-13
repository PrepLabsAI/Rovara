import { describe, expect, it } from "vitest";
import { TaskGraphV1Schema, taskGraphDigest, taskGraphOrder, validateTaskGraph } from "@agentx/contracts";

const taskId = "8c330a74-b4c6-4f01-9356-5fe54fc55b19";
const repo = "github:acme/payments";
const graph = () => ({
  schemaVersion: 1 as const,
  taskId,
  version: 1,
  items: [
    { id: "11111111-1111-4111-8111-111111111111", title: "Foundation", description: "Set up the shared interface.", repository: repo, dependsOn: [] },
    { id: "22222222-2222-4222-8222-222222222222", title: "Storage", description: "Add persistence.", repository: repo, dependsOn: ["11111111-1111-4111-8111-111111111111"] },
    { id: "33333333-3333-4333-8333-333333333333", title: "Page", description: "Build the page.", repository: repo, dependsOn: ["11111111-1111-4111-8111-111111111111"] },
    { id: "44444444-4444-4444-8444-444444444444", title: "Integration", description: "Connect the pieces.", repository: repo, dependsOn: ["22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"] },
  ],
});

describe("TaskGraphV1", () => {
  it("accepts a valid same-task, same-repository graph and deterministically orders a diamond", () => {
    const result = validateTaskGraph(graph(), { taskId, repositoryId: repo });
    expect(result.ok).toBe(true);
    expect(taskGraphOrder(graph())).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
    ]);
  });

  it("rejects duplicate IDs, duplicate/self/unknown edges, cycles and foreign task/repository", () => {
    const cases = [
      (value: ReturnType<typeof graph>) => { value.items[1]!.id = value.items[0]!.id; },
      (value: ReturnType<typeof graph>) => { value.items[1]!.dependsOn = [value.items[0]!.id, value.items[0]!.id]; },
      (value: ReturnType<typeof graph>) => { value.items[1]!.dependsOn = [value.items[1]!.id]; },
      (value: ReturnType<typeof graph>) => { value.items[1]!.dependsOn = ["99999999-9999-4999-8999-999999999999"]; },
      (value: ReturnType<typeof graph>) => { value.items[0]!.dependsOn = [value.items[3]!.id]; },
      (value: ReturnType<typeof graph>) => { value.taskId = "2c92c75a-2bfc-4213-b00a-c44e18727c44"; },
      (value: ReturnType<typeof graph>) => { value.items[2]!.repository = "github:acme/other"; },
    ];
    for (const mutate of cases) {
      const value = graph();
      mutate(value);
      expect(validateTaskGraph(value, { taskId, repositoryId: repo }).ok).toBe(false);
    }
  });

  it("enforces item, edge, byte and strict-shape bounds", () => {
    const tooManyItems = graph();
    tooManyItems.items = Array.from({ length: 9 }, (_, index) => ({
      id: `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`, title: "Item", description: "Work", repository: repo, dependsOn: [],
    }));
    expect(TaskGraphV1Schema.safeParse(tooManyItems).success).toBe(false);

    const tooManyEdges = graph();
    tooManyEdges.items = Array.from({ length: 8 }, (_, index) => ({
      id: `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`, title: "Item", description: "Work", repository: repo,
      dependsOn: Array.from({ length: Math.min(index, 4) }, (_unused, dependencyIndex) => `${String(dependencyIndex + 1).padStart(8, "0")}-1111-4111-8111-111111111111`),
    }));
    expect(validateTaskGraph(tooManyEdges, { taskId, repositoryId: repo }).ok).toBe(false);

    const tooLarge = graph();
    tooLarge.items = Array.from({ length: 8 }, (_, index) => ({
      id: `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`, title: "Item", description: "x".repeat(2_000), repository: repo, dependsOn: [],
    }));
    expect(validateTaskGraph(tooLarge, { taskId, repositoryId: repo }).ok).toBe(false);
    expect(TaskGraphV1Schema.safeParse({ ...graph(), surprise: true }).success).toBe(false);
  });

  it("hashes canonical object keys while preserving submitted array order", () => {
    const first = graph();
    const reorderedKeys = TaskGraphV1Schema.parse(JSON.parse(JSON.stringify(first)));
    expect(taskGraphDigest(first)).toBe(taskGraphDigest(reorderedKeys));
    const reorderedItems = graph();
    reorderedItems.items.reverse();
    expect(taskGraphDigest(first)).not.toBe(taskGraphDigest(reorderedItems));
  });
});
