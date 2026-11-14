// L7 / W1: the memory arm of an eval batch (contracts/src/eval-memory.ts). Contract only: the quality-suite batch that will carry it is not on this branch.
import { describe, expect, it } from "vitest";
import {
  EvalBatchFileSchema, EvalMemoryDimensionSchema, MemoryInputSchema, compareMemoryArms, evalMemoryArmCount, evalMemoryArms, memoryInputForArm, type MemoryArmRow,
} from "@agentx/contracts";

const SNAPSHOT = `snp_${"0123456789abcdef0123"}`;
const row = (task: string, arm: "on" | "off", resolved: boolean | undefined, repeat?: number): MemoryArmRow => ({ task, arm, resolved, ...(repeat === undefined ? {} : { repeat }) });

describe("the memory dimension", () => {
  it("is one or two different arms; anything else is refused", () => {
    for (const ok of [["off"], ["on"], ["off", "on"], ["on", "off"]]) expect(EvalMemoryDimensionSchema.safeParse(ok).success, JSON.stringify(ok)).toBe(true);
    for (const bad of [[], ["on", "on"], ["off", "off"], ["lessons"], ["live"], ["off", "on", "off"], "on", [1], null]) expect(EvalMemoryDimensionSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it("a batch that names none is one arm that changes nothing; two arms double the runs", () => {
    expect(evalMemoryArms(undefined)).toEqual([undefined]);
    expect(evalMemoryArmCount(undefined)).toBe(1);
    expect(evalMemoryArms(["off", "on"])).toEqual(["off", "on"]);
    expect(evalMemoryArmCount(["off", "on"])).toBe(2);
    expect(evalMemoryArmCount(["on"])).toBe(1);
    expect(() => evalMemoryArms(["on", "on"])).toThrow();
  });

  it("is not accepted by today's batch file: nothing runs it yet, so a file that names it is refused rather than run without it", () => {
    const base = { benchmark: "verified", tasks: ["django__django-11099", "astropy__astropy-12907"], models: [{ provider: "anthropic", modelId: "claude-sonnet-4-6", thinkingLevel: "medium" }], costCapUsd: 50 };
    expect(EvalBatchFileSchema.safeParse(base).success).toBe(true);
    expect(EvalBatchFileSchema.safeParse({ ...base, memory: ["off", "on"] }).success).toBe(false);
  });
});

describe("the dispatch input of an arm", () => {
  it("off loads nothing; on reads a frozen snapshot; both are valid memory inputs", () => {
    expect(memoryInputForArm("off")).toEqual({ mode: "off" });
    expect(memoryInputForArm("off", SNAPSHOT)).toEqual({ mode: "off" });
    const on = memoryInputForArm("on", SNAPSHOT);
    expect(on).toEqual({ mode: "snapshot", snapshotId: SNAPSHOT });
    expect(MemoryInputSchema.safeParse(on).success).toBe(true);
  });
  it("an eval never reads live memory: an on arm with no snapshot, or a bad one, is refused, and no arm gives 'live'", () => {
    expect(() => memoryInputForArm("on")).toThrow(RangeError);
    expect(() => memoryInputForArm("on", "latest")).toThrow();
    expect(() => memoryInputForArm("on", `snp_${"G".repeat(20)}`)).toThrow();
    expect(() => memoryInputForArm("live" as never)).toThrow();
    for (const arm of ["off", "on"] as const) expect(memoryInputForArm(arm, SNAPSHOT).mode).not.toBe("live");
  });
});

describe("comparing the arms", () => {
  it("pairs task by task and reports each arm over the same tasks, with who solved what", () => {
    const rows = [
      row("a", "on", true), row("a", "off", false),
      row("b", "on", true), row("b", "off", true),
      row("c", "on", false), row("c", "off", true),
      row("d", "on", false), row("d", "off", false),
      row("e", "on", true), // no off run: left out
      row("f", "on", undefined), row("f", "off", true), // not graded in one arm: left out of both
    ];
    const comparison = compareMemoryArms(rows);
    expect(comparison).toMatchObject({ pairs: 4, unpaired: 2, bothResolved: 1, onlyWithMemory: 1, onlyWithoutMemory: 1, neither: 1 });
    expect(comparison.on).toMatchObject({ runs: 4, resolved: 2, rate: 0.5 });
    expect(comparison.off).toMatchObject({ runs: 4, resolved: 2, rate: 0.5 });
    expect(comparison.delta).toBe(0);
    expect(comparison.on.low).toBeGreaterThanOrEqual(0);
    expect(comparison.on.high).toBeLessThanOrEqual(1);
    expect(comparison.on.low).toBeLessThan(0.5);
    expect(comparison.on.high).toBeGreaterThan(0.5);
  });
  it("memory helping shows as a positive delta over the same tasks, not over all runs", () => {
    const rows = [row("a", "on", true), row("a", "off", false), row("b", "on", true), row("b", "off", false), row("only-on", "on", false)];
    const c = compareMemoryArms(rows);
    expect(c.delta).toBe(1);
    expect(c.pairs).toBe(2);
    expect(c.unpaired).toBe(1);
  });
  it("repeats pair repeat by repeat; the same task run twice in one arm is not double counted", () => {
    const rows = [row("a", "on", true, 1), row("a", "off", false, 1), row("a", "on", false, 2), row("a", "off", false, 2)];
    expect(compareMemoryArms(rows)).toMatchObject({ pairs: 2, onlyWithMemory: 1, neither: 1 });
    expect(() => compareMemoryArms([row("a", "on", true), row("a", "on", true)])).toThrow(RangeError);
  });
  it("nothing to compare is no rate, not zero", () => {
    expect(compareMemoryArms([])).toMatchObject({ pairs: 0, delta: null, on: { rate: null, runs: 0 }, off: { rate: null, runs: 0 } });
    expect(compareMemoryArms([row("a", "on", true)])).toMatchObject({ pairs: 0, unpaired: 1, delta: null });
  });
  it("an arm that is not on or off is refused", () => {
    expect(() => compareMemoryArms([{ task: "a", arm: "live" as never, resolved: true }])).toThrow();
  });
});
