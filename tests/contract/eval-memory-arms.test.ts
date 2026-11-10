// Lessons replay (DECISIONS 38, 49): the memory dimension with N named arms (off / on:<pipeline> / file:<label> / mcp:<label>) and the comparison over all of them. The two-arm contract
// (`eval-memory-contracts.test.ts`) keeps passing: a result written with arms "on" and "off" is still read.
import { describe, expect, it } from "vitest";
import {
  EVAL_ARMS_MAX, EvalMemoryDimensionSchema, armPipeline, canonicalArm, compareArms, compareMemoryArms, evalMemoryArms, memoryInputForArm, parseArm, readArmRows, type ArmRunRow,
} from "@agentx/contracts";

const SNAPSHOT = `snp_${"0123456789abcdef0123"}`;
const row = (task: string, arm: string, resolved: boolean | undefined, repeat = 1): ArmRunRow => ({ task, arm, resolved, repeat });

describe("arm names", () => {
  it("off, on:<pipeline>, file:<label> and mcp:<label> are arms; an on arm always names its pipeline", () => {
    expect(parseArm("off")).toMatchObject({ kind: "off", name: "off" });
    expect(parseArm("on:current")).toMatchObject({ kind: "on", label: "current", name: "on:current" });
    expect(parseArm("on:consolidated")).toMatchObject({ kind: "on", label: "consolidated" });
    expect(parseArm("file:current")).toMatchObject({ kind: "file", label: "current" });
    expect(parseArm("mcp:current")).toMatchObject({ kind: "mcp", label: "current" });
    expect(armPipeline("on:consolidated")).toBe("consolidated");
    expect(armPipeline("file:current")).toBe("current");
    expect(armPipeline("off")).toBeUndefined();
    for (const bad of ["on:", "on:Current", "on:a b", "off:x", "live", "live:x", "file", "mcp", "", "on:" + "a".repeat(40), "ON:current", "on:cur:rent"]) expect(() => parseArm(bad), bad).toThrow(RangeError);
  });
  it("the bare 'on' of the two-arm contract is read as the pipeline 'legacy' and never produced", () => {
    expect(canonicalArm("on")).toBe("on:legacy");
    expect(canonicalArm("off")).toBe("off");
    expect(canonicalArm("on:current")).toBe("on:current");
    expect(parseArm("on")).toMatchObject({ kind: "on", label: "legacy", legacy: true });
  });
});

describe("the dimension with N arms", () => {
  it("takes up to the arm maximum of different arms; the two-arm lists still parse", () => {
    expect(EVAL_ARMS_MAX).toBeGreaterThanOrEqual(5);
    for (const ok of [["off"], ["on"], ["off", "on"], ["off", "on:current", "on:consolidated"], ["off", "on:current", "file:current", "mcp:current"]]) expect(EvalMemoryDimensionSchema.safeParse(ok).success, JSON.stringify(ok)).toBe(true);
    for (const bad of [[], ["on:current", "on:current"], ["on", "on:legacy"], ["off", "off"], ["live"], ["on:"], "on:current", [null], Array.from({ length: EVAL_ARMS_MAX + 1 }, (_, i) => `on:p${i}`)]) expect(EvalMemoryDimensionSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
  it("expands to the listed arms; none listed is one arm that changes nothing", () => {
    expect(evalMemoryArms(undefined)).toEqual([undefined]);
    expect(evalMemoryArms(["off", "on:current", "on:consolidated"])).toEqual(["off", "on:current", "on:consolidated"]);
  });
});

describe("the dispatch input of an arm", () => {
  it("off loads nothing; every on arm reads ITS OWN frozen snapshot, never live", () => {
    expect(memoryInputForArm("off")).toEqual({ mode: "off" });
    expect(memoryInputForArm("on:current", SNAPSHOT)).toEqual({ mode: "snapshot", snapshotId: SNAPSHOT });
    expect(memoryInputForArm("on:consolidated", SNAPSHOT)).toEqual({ mode: "snapshot", snapshotId: SNAPSHOT });
    expect(memoryInputForArm("on", SNAPSHOT)).toEqual({ mode: "snapshot", snapshotId: SNAPSHOT });
    expect(() => memoryInputForArm("on:current")).toThrow(RangeError);
    expect(() => memoryInputForArm("on:current", "latest")).toThrow();
    expect(() => memoryInputForArm("live")).toThrow();
  });
  it("a file or MCP arm is offered outside a Rovara task's memory input: no memory input exists for it", () => {
    expect(() => memoryInputForArm("file:current", SNAPSHOT)).toThrow(/outside/);
    expect(() => memoryInputForArm("mcp:current", SNAPSHOT)).toThrow(/outside/);
  });
});

describe("reading old two-arm results", () => {
  it("rows with arm 'on' and 'off' read as on:legacy and off, and the two-arm comparison gives the same answer as before", () => {
    const old = [{ task: "a", arm: "on", resolved: true }, { task: "a", arm: "off", resolved: false }, { task: "b", arm: "on", resolved: true, repeat: 2 }, { task: "b", arm: "off", resolved: true, repeat: 2 }];
    const read = readArmRows(old);
    expect(read.map((r) => r.arm)).toEqual(["on:legacy", "off", "on:legacy", "off"]);
    expect(read[2]?.repeat).toBe(2);
    expect(compareMemoryArms(old as never)).toMatchObject({ pairs: 2, onlyWithMemory: 1, bothResolved: 1 });
    const n = compareArms(read);
    expect(n.arms).toEqual(["off", "on:legacy"]);
    expect(n.pairs).toBe(2);
    expect(n.perArm["on:legacy"]).toMatchObject({ runs: 2, resolved: 2 });
    expect(n.perArm["off"]).toMatchObject({ runs: 2, resolved: 1 });
  });
  it("a row that is not an object or names no task or an unknown arm is refused, never skipped", () => {
    expect(() => readArmRows([null])).toThrow();
    expect(() => readArmRows([{ arm: "off", resolved: true }])).toThrow();
    expect(() => readArmRows([{ task: "a", arm: "live", resolved: true }])).toThrow();
    expect(() => readArmRows([{ task: "a", arm: "off", resolved: "yes" }])).toThrow();
  });
});

describe("comparing N arms", () => {
  const rows = (): ArmRunRow[] => [
    // task a: A fails, B solves, C solves.  task b: all solve.  task c: B solves, C fails.  task d: nobody.
    row("a", "off", false), row("a", "on:current", true), row("a", "on:consolidated", true),
    row("b", "off", true), row("b", "on:current", true), row("b", "on:consolidated", true),
    row("c", "off", false), row("c", "on:current", true), row("c", "on:consolidated", false),
    row("d", "off", false), row("d", "on:current", false), row("d", "on:consolidated", false),
  ];
  it("reports each arm over the runs graded in EVERY arm, and who solved what", () => {
    const c = compareArms(rows());
    expect(c.arms).toEqual(["off", "on:consolidated", "on:current"]); // off first, the others by name, whatever the order of the rows
    expect(c.pairs).toBe(4);
    expect(c.unpaired).toBe(0);
    expect(c.perArm["off"]).toMatchObject({ runs: 4, resolved: 1, rate: 0.25 });
    expect(c.perArm["on:current"]).toMatchObject({ runs: 4, resolved: 3, rate: 0.75 });
    expect(c.perArm["on:consolidated"]).toMatchObject({ runs: 4, resolved: 2, rate: 0.5 });
    expect(c.perArm["on:current"]!.low).toBeLessThan(0.75);
    expect(c.perArm["on:current"]!.high).toBeGreaterThan(0.75);
    const bc = c.discordant.find((d) => d.a === "on:consolidated" && d.b === "on:current");
    expect(bc).toMatchObject({ onlyA: [], onlyB: ["c"] });
    const ab = c.discordant.find((d) => d.a === "off" && d.b === "on:current");
    expect(ab).toMatchObject({ onlyA: [], onlyB: ["a", "c"] });
    expect(c.discordant).toHaveLength(3);
  });
  it("a run graded in one arm only, or not graded in one, is left out of ALL arms and counted as unpaired", () => {
    const c = compareArms([...rows(), row("e", "off", true), row("e", "on:current", undefined), row("e", "on:consolidated", true), row("f", "on:current", true)]);
    expect(c.pairs).toBe(4);
    expect(c.unpaired).toBe(2);
    expect(c.perArm["off"]!.runs).toBe(4);
  });
  it("with repeats, a task counts as solved by an arm when most of its repeats solved it; a tie is not solved", () => {
    const r: ArmRunRow[] = [
      row("t", "off", true, 1), row("t", "off", false, 2), row("t", "off", false, 3),
      row("t", "on:current", true, 1), row("t", "on:current", true, 2), row("t", "on:current", false, 3),
    ];
    const c = compareArms(r);
    expect(c.pairs).toBe(3);
    expect(c.discordant[0]).toMatchObject({ a: "off", b: "on:current", onlyA: [], onlyB: ["t"] });
    const tie = compareArms([row("u", "off", true, 1), row("u", "off", false, 2), row("u", "on:current", true, 1), row("u", "on:current", false, 2)]);
    expect(tie.discordant[0]).toMatchObject({ onlyA: [], onlyB: [] });
  });
  it("refuses two rows for one run, an unknown arm, and names every arm it saw even when nothing is paired", () => {
    expect(() => compareArms([row("a", "off", true), row("a", "off", false)])).toThrow(RangeError);
    expect(() => compareArms([row("a", "on", true), row("a", "on:legacy", true)])).toThrow(RangeError);
    expect(() => compareArms([row("a", "live", true)])).toThrow();
    expect(compareArms([])).toMatchObject({ arms: [], pairs: 0, unpaired: 0 });
    const lone = compareArms([row("a", "off", true)]);
    expect(lone).toMatchObject({ arms: ["off"], pairs: 1 });
    expect(lone.perArm["off"]).toMatchObject({ runs: 1, rate: 1 });
  });
  it("does not depend on the order of the rows", () => {
    const forward = compareArms(rows());
    const reversed = compareArms(rows().reverse());
    expect(reversed.perArm).toEqual(forward.perArm);
    expect(reversed.discordant).toEqual(forward.discordant);
    expect(reversed.arms).toEqual(forward.arms);
  });
});
