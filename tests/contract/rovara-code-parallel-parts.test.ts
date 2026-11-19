import { describe, expect, it } from "vitest";
import { PARALLEL_PARTS_MAX, taskGraphDigest, type TaskGraphV1, type WorkItemProgressV1 } from "@agentx/contracts";
import { executeParallelWorkflowDependencies, type ExecuteParallelWorkflowDependenciesInput } from "../../packages/worker/src/parallel-parts.js";

const taskId = "8c330a74-b4c6-4f01-9356-5fe54fc55b19";
const operationId = "8c330a74-b4c6-4f01-9356-5fe54fc55b20";
const runId = "8c330a74-b4c6-4f01-9356-5fe54fc55b21";
const EARLIER = "8c330a74-b4c6-4f01-9356-5fe54fc55b10";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const D = "44444444-4444-4444-8444-444444444444";
const item = (id: string, dependsOn: string[] = []) => ({ id, title: id.slice(0, 2), description: "Do it.", repository: "repo", dependsOn });
const graphOf = (...items: ReturnType<typeof item>[]): TaskGraphV1 => ({ schemaVersion: 1, taskId, version: 1, items });
const initialTree = "a".repeat(40);
const tree = (digit: string) => digit.repeat(40);

/** A fake git: a tree is the sorted set of part names merged into it, named by a digest-like 40-hex string. */
class FakeTrees {
  readonly names = new Map<string, Set<string>>([[initialTree, new Set()]]);
  make(parts: Iterable<string>): string {
    const key = [...new Set(parts)].sort().join(",");
    let hex = "";
    for (let index = 0; hex.length < 40; index += 1) hex += ((key.charCodeAt(index % Math.max(key.length, 1)) || 7) * (index + 3)).toString(16).padStart(2, "0");
    const id = hex.slice(0, 40);
    this.names.set(id, new Set(parts));
    return id;
  }
  parts(id: string): string[] { return [...(this.names.get(id) ?? [])].sort(); }
}

function harness(graph: TaskGraphV1, over: Partial<ExecuteParallelWorkflowDependenciesInput> & { overlap?: number; conflicts?: (itemId: string, attempt: number) => boolean; run?: (itemId: string, base: string, attempt: number) => Promise<void> } = {}) {
  const trees = new FakeTrees();
  const events: WorkItemProgressV1[] = [];
  const log: string[] = [];
  const attempts = new Map<string, number>();
  let persisting = 0;
  let integrating = 0;
  let running = 0;
  let peak = 0;
  // A part that must overlap with others waits here until `overlap` parts are running at once (once that has happened, every later part passes at once). The wait is a
  // barrier, not a sleep, so how late a timer fires cannot decide whether two parts overlapped; the long timeout is only a backstop for a run that never reaches it.
  let reached = over.overlap === undefined || over.overlap <= 1;
  const waiting: Array<() => void> = [];
  const OVERLAP_BACKSTOP_MS = 5_000;
  const holdForOverlap = async (): Promise<void> => {
    if (!reached && over.overlap !== undefined && running >= over.overlap) { reached = true; for (const release of waiting.splice(0)) release(); }
    if (reached) return;
    await new Promise<void>((resolve) => {
      const backstop = setTimeout(resolve, OVERLAP_BACKSTOP_MS);
      waiting.push(() => { clearTimeout(backstop); resolve(); });
    });
  };
  const input: ExecuteParallelWorkflowDependenciesInput = {
    graph, graphDigest: taskGraphDigest(graph), runId, operationId, initialTreeSha: initialTree, maxParallel: 3,
    now: () => "2026-10-26T12:00:00.000Z",
    persist: async (entry) => {
      persisting += 1;
      if (persisting > 1) throw new Error("two checkpoints were persisted at once");
      await new Promise((resolve) => setTimeout(resolve, 1));
      events.push(entry);
      persisting -= 1;
    },
    execute: async (workItem, context) => {
      const attempt = (attempts.get(workItem.id) ?? 0) + 1;
      attempts.set(workItem.id, attempt);
      running += 1;
      peak = Math.max(peak, running);
      await holdForOverlap();
      log.push(`start ${workItem.id.slice(0, 2)}#${attempt} on [${trees.parts(context.baseTreeSha).map((id) => id.slice(0, 2)).join(",")}]`);
      try {
        await over.run?.(workItem.id, context.baseTreeSha, attempt);
        return { treeSha: trees.make([...trees.parts(context.baseTreeSha), workItem.id]) };
      } finally { running -= 1; }
    },
    integrate: async ({ integratedTreeSha, baseTreeSha, partTreeSha, itemId }) => {
      integrating += 1;
      if (integrating > 1) throw new Error("two merges ran at once");
      await new Promise((resolve) => setTimeout(resolve, 1));
      integrating -= 1;
      if (over.conflicts?.(itemId, attempts.get(itemId) ?? 1) === true && integratedTreeSha !== baseTreeSha) return { ok: false };
      return { ok: true, treeSha: trees.make([...trees.parts(integratedTreeSha), ...trees.parts(partTreeSha)]) };
    },
    checkout: async (treeSha) => { log.push(`checkout [${trees.parts(treeSha).map((id) => id.slice(0, 2)).join(",")}]`); },
    ...over,
  };
  delete (input as { conflicts?: unknown }).conflicts;
  delete (input as { run?: unknown }).run;
  delete (input as { overlap?: unknown }).overlap;
  return { input, events, log, trees, peak: () => peak };
}

const states = (events: WorkItemProgressV1[]) => events.map((event) => `${event.itemId.slice(0, 2)}:${event.state}`);

describe("executeParallelWorkflowDependencies", () => {
  it("starts A and B together, then C on both changes, with unique, increasing sequence numbers", async () => {
    const gate = { release: () => undefined as void };
    const both = new Promise<void>((resolve) => { gate.release = resolve; });
    let started = 0;
    const h = harness(graphOf(item(A), item(B), item(C, [A, B])), {
      run: async (itemId) => { if (itemId !== C) { started += 1; if (started === 2) gate.release(); await both; } },
    });
    const result = await executeParallelWorkflowDependencies(h.input);
    expect(h.log.slice(0, 2).sort()).toEqual(["start 11#1 on []", "start 22#1 on []"]);
    expect(h.log[2]).toBe("start 33#1 on [11,22]");
    expect(h.trees.parts(result.finalTreeSha)).toEqual([A, B, C]);
    expect(h.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(states(h.events).slice(0, 2).sort()).toEqual(["11:STARTED", "22:STARTED"]);
    expect(h.events.filter((event) => event.state === "IMPLEMENTED").every((event) => event.integratedTreeSha !== undefined && event.candidateTreeSha !== undefined)).toBe(true);
    expect(h.events.at(-1)?.integratedTreeSha).toBe(result.finalTreeSha);
    expect(h.log.at(-1)).toBe("checkout [11,22,33]");
    expect(result.progress).toEqual(h.events);
  });

  it("never runs more parts than maxParallel, whatever the graph allows", async () => {
    const h = harness(graphOf(item(A), item(B), item(C), item(D)), { maxParallel: 2, overlap: 2, run: async () => { await new Promise((resolve) => setTimeout(resolve, 5)); } });
    await executeParallelWorkflowDependencies(h.input);
    expect(h.peak()).toBe(2);
    const one = harness(graphOf(item(A), item(B), item(C)), { maxParallel: 1, run: async () => { await new Promise((resolve) => setTimeout(resolve, 2)); } });
    await executeParallelWorkflowDependencies(one.input);
    expect(one.peak()).toBe(1);
    const three = harness(graphOf(item(A), item(B), item(C), item(D)), { maxParallel: PARALLEL_PARTS_MAX, overlap: PARALLEL_PARTS_MAX, run: async () => { await new Promise((resolve) => setTimeout(resolve, 5)); } });
    await executeParallelWorkflowDependencies(three.input);
    expect(three.peak()).toBe(PARALLEL_PARTS_MAX);
  });

  it("refuses a maxParallel outside 1 to the plan's cap, before anything runs", async () => {
    for (const bad of [0, -1, PARALLEL_PARTS_MAX + 1, 1.5, Number.NaN]) {
      const h = harness(graphOf(item(A)), { maxParallel: bad });
      await expect(executeParallelWorkflowDependencies(h.input)).rejects.toThrow(/parallel parts/);
      expect(h.events).toEqual([]);
    }
  });

  it("a failed part stops new starts, lets the running part finish and be kept, and checks out what is integrated", async () => {
    const h = harness(graphOf(item(A), item(B), item(C, [A, B])), {
      run: async (itemId) => {
        if (itemId === A) { await new Promise((resolve) => setTimeout(resolve, 2)); throw new Error("model stopped"); }
        await new Promise((resolve) => setTimeout(resolve, 15));
      },
    });
    const failure = await executeParallelWorkflowDependencies(h.input).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/paused after a failed part/);
    expect(((failure as { causes?: Error[] }).causes ?? []).map((cause) => cause.message)).toEqual(["model stopped"]);
    expect(states(h.events).sort()).toEqual(["11:FAILED", "11:STARTED", "22:IMPLEMENTED", "22:STARTED"]);
    expect(h.log).not.toContain(expect.stringMatching(/start 33/));
    expect(h.log.at(-1)).toBe("checkout [22]");
    const failed = h.events.find((event) => event.state === "FAILED");
    expect(failed).toBeDefined();
    expect("candidateTreeSha" in failed!).toBe(false);
  });

  it("a failure stops new starts even when a slot is free and a part is ready", async () => {
    const h = harness(graphOf(item(A), item(B), item(D)), {
      maxParallel: 2,
      run: async (itemId) => {
        if (itemId === A) { await new Promise((resolve) => setTimeout(resolve, 2)); throw new Error("model stopped"); }
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    });
    await expect(executeParallelWorkflowDependencies(h.input)).rejects.toThrow(/paused after a failed part/);
    expect(h.log.some((line) => line.startsWith("start 44"))).toBe(false);
    expect(states(h.events).sort()).toEqual(["11:FAILED", "11:STARTED", "22:IMPLEMENTED", "22:STARTED"]);
  });

  it("on a merge conflict re-runs the part once, alone, at the integrated tree, and keeps both edits", async () => {
    const h = harness(graphOf(item(A), item(B)), {
      conflicts: (itemId, attempt) => itemId === B && attempt === 1,
      run: async (itemId, _base, attempt) => { await new Promise((resolve) => setTimeout(resolve, itemId === A ? 1 : 8)); void attempt; },
    });
    const result = await executeParallelWorkflowDependencies(h.input);
    expect(h.trees.parts(result.finalTreeSha)).toEqual([A, B]);
    expect(h.log.filter((line) => line.startsWith("start 22"))).toEqual(["start 22#1 on []", "start 22#2 on [11]"]);
    const restart = h.events.filter((event) => event.itemId === B && event.state === "STARTED");
    expect(restart).toHaveLength(2);
    expect(restart[1]!.baseTreeSha).not.toBe(restart[0]!.baseTreeSha);
    expect(h.events.filter((event) => event.itemId === B && event.state === "IMPLEMENTED")).toHaveLength(1);
  });

  it("a part re-run for a conflict runs alone: nothing else starts or runs beside it", async () => {
    let othersRunning = 0;
    let sawOverlap = false;
    const h = harness(graphOf(item(A), item(B), item(C), item(D, [C])), {
      maxParallel: 3,
      conflicts: (itemId, attempt) => itemId === B && attempt === 1,
      run: async (itemId, _base, attempt) => {
        if (itemId === B && attempt === 2 && othersRunning > 0) sawOverlap = true;
        if (!(itemId === B && attempt === 2)) othersRunning += 1;
        await new Promise((resolve) => setTimeout(resolve, itemId === C ? 25 : 3));
        if (!(itemId === B && attempt === 2)) othersRunning -= 1;
      },
    });
    await executeParallelWorkflowDependencies(h.input);
    expect(sawOverlap).toBe(false);
    const rerun = h.log.findIndex((line) => line === "start 22#2 on [11,33]" || line.startsWith("start 22#2"));
    expect(rerun).toBeGreaterThan(-1);
    expect(h.log.slice(rerun + 1).filter((line) => line.startsWith("start") && !line.startsWith("start 44"))).toEqual([]);
  });

  it("a second conflict marks the part FAILED and stops new starts", async () => {
    const h = harness(graphOf(item(A), item(B), item(C, [B])), {
      // B conflicts every time, even alone, at the tree it was built on.
      integrate: async ({ itemId, integratedTreeSha, partTreeSha }) => (itemId === B ? { ok: false } : { ok: true, treeSha: partTreeSha.length === 40 && integratedTreeSha ? partTreeSha : integratedTreeSha }),
      run: async (itemId) => { await new Promise((resolve) => setTimeout(resolve, itemId === A ? 1 : 6)); },
    });
    await expect(executeParallelWorkflowDependencies(h.input)).rejects.toThrow(/paused after a failed part/);
    expect(states(h.events)).toContain("22:FAILED");
    expect(h.log.some((line) => line.startsWith("start 33"))).toBe(false);
    expect(h.log.filter((line) => line.startsWith("start 22"))).toHaveLength(2);
  });

  it("resumes from finished parts closed under dependencies: B done, A not, then A and C", async () => {
    const trees = new FakeTrees();
    const doneB = trees.make([B]);
    const retained: WorkItemProgressV1[] = [
      { schemaVersion: 1, graphDigest: taskGraphDigest(graphOf(item(A), item(B), item(C, [A, B]))), runId, itemId: B, sequence: 3, state: "IMPLEMENTED", operationId: EARLIER,
        baseTreeSha: initialTree, candidateTreeSha: doneB, integratedTreeSha: doneB, at: "2026-10-26T11:00:00.000Z", producer: "agentx-worker" },
      { schemaVersion: 1, graphDigest: taskGraphDigest(graphOf(item(A), item(B), item(C, [A, B]))), runId, itemId: A, sequence: 4, state: "UNKNOWN", operationId: EARLIER,
        baseTreeSha: initialTree, at: "2026-10-26T11:00:01.000Z", producer: "agentx-broker-terminal" },
    ];
    const h = harness(graphOf(item(A), item(B), item(C, [A, B])), { initialTreeSha: doneB, sequenceStart: 4, resumeProgress: retained });
    h.trees.names.set(doneB, new Set([B]));
    const result = await executeParallelWorkflowDependencies(h.input);
    expect(h.log.filter((line) => line.startsWith("start")).map((line) => line.slice(6, 8))).toEqual(["11", "33"]);
    expect(h.log[0]).toBe("start 11#1 on [22]");
    expect(h.events.map((event) => event.sequence)).toEqual([5, 6, 7, 8]);
    expect(h.trees.parts(result.finalTreeSha)).toEqual([A, B, C]);
  });

  it("refuses retained progress that is not closed under dependencies, or whose tree is not the workspace's", async () => {
    const g = graphOf(item(A), item(B, [A]));
    const retained = (itemId: string, integrated: string): WorkItemProgressV1 => ({ schemaVersion: 1, graphDigest: taskGraphDigest(g), runId, itemId, sequence: 2, state: "IMPLEMENTED",
      operationId: EARLIER, baseTreeSha: initialTree, candidateTreeSha: integrated, integratedTreeSha: integrated, at: "2026-10-26T11:00:00.000Z", producer: "agentx-worker" });
    const orphan = harness(g, { initialTreeSha: tree("e"), sequenceStart: 2, resumeProgress: [retained(B, tree("e"))] });
    await expect(executeParallelWorkflowDependencies(orphan.input)).rejects.toThrow(/not closed under dependencies/);
    const moved = harness(g, { initialTreeSha: tree("f"), sequenceStart: 2, resumeProgress: [retained(A, tree("e"))] });
    await expect(executeParallelWorkflowDependencies(moved.input)).rejects.toThrow(/workspace changed since the retained/);
    expect(orphan.events).toEqual([]);
    expect(moved.events).toEqual([]);
  });

  it("does not run a part whose STARTED checkpoint cannot be persisted", async () => {
    let executed = false;
    const h = harness(graphOf(item(A)), { persist: async () => { throw new Error("callback unavailable"); }, execute: async () => { executed = true; return { treeSha: tree("2") }; } });
    await expect(executeParallelWorkflowDependencies(h.input)).rejects.toThrow(/callback unavailable|paused/);
    expect(executed).toBe(false);
  });

  it("stops starting parts when the operation is cancelled, and signals the parts that run", async () => {
    let cancelled = false;
    const signals: AbortSignal[] = [];
    const h = harness(graphOf(item(A), item(B), item(C, [A])), {
      shouldContinue: () => !cancelled,
      execute: async (workItem, context) => {
        signals.push(context.signal);
        if (workItem.id === A) { cancelled = true; await new Promise((resolve) => setTimeout(resolve, 5)); }
        return { treeSha: tree("2") };
      },
    });
    await expect(executeParallelWorkflowDependencies(h.input)).rejects.toThrow(/cancelled/);
    expect(signals.length).toBeLessThanOrEqual(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(h.events.some((event) => event.itemId === C)).toBe(false);
  });

  it("integrates parts one at a time and persists checkpoints one at a time, even when parts finish together", async () => {
    const h = harness(graphOf(item(A), item(B), item(C)), { run: async () => { await new Promise((resolve) => setTimeout(resolve, 3)); } });
    await expect(executeParallelWorkflowDependencies(h.input)).resolves.toBeDefined();
    expect(new Set(h.events.map((event) => event.sequence)).size).toBe(h.events.length);
  });

  it("the result is the same whichever part finishes first", async () => {
    const finalTrees = new Set<string>();
    for (const delays of [[1, 9, 5], [9, 1, 5], [5, 9, 1]]) {
      const h = harness(graphOf(item(A), item(B), item(C)), { run: async (itemId) => { await new Promise((resolve) => setTimeout(resolve, delays[[A, B, C].indexOf(itemId)])); } });
      const result = await executeParallelWorkflowDependencies(h.input);
      finalTrees.add(h.trees.parts(result.finalTreeSha).join(","));
    }
    expect([...finalTrees]).toEqual([[A, B, C].join(",")]);
  });
});
