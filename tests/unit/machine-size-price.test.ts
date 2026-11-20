// DEC 254zb (TE-C5 part C): a bigger machine is estimated as costing more, cautiously, in whole micros, and an unknown size, region or duration has no estimate.
import { describe, expect, it } from "vitest";
import { MACHINE_HOURLY_USD, MACHINE_LAUNCH_TYPES, MACHINE_SIZE_ROWS, machineCost, machineCostWords } from "../../packages/contracts/src/index.js";

describe("machine size price", () => {

  it.each([
    ["arm64-2-8", 84_700], ["arm64-4-16", 169_400], ["arm64-8-32", 338_800],
    ["arm64-16-64", 677_600], ["arm64-32-128", 1_355_200],
    ["x86_64-2-8", 105_600], ["x86_64-4-16", 211_200], ["x86_64-8-32", 422_400],
    ["x86_64-16-64", 844_800], ["x86_64-32-128", 1_689_600],
  ])("estimates one hour of %s at the list price plus 10%% (%i micros)", (rowId, micros) => {
    expect(machineCost(rowId, "us-east-1", 60)).toEqual({ micros, currency: "USD" });
    expect(machineCost(rowId, "us-west-2", 60)).toEqual({ micros, currency: "USD" });
  });

  it("rounds a minute up to whole micros and is never below the list price", () => {
    // m6g.large: 77,000 micros an hour; 1,283.33 a minute at list, 1,411.67 with the margin -> 1,412.
    expect(machineCost("arm64-2-8", "us-east-1", 1)).toEqual({ micros: 1412, currency: "USD" });
    for (const row of MACHINE_SIZE_ROWS) for (const minutes of [1, 7, 59, 61, 10_080]) {
      const cost = machineCost(row.id, "us-east-1", minutes)!;
      expect(Number.isInteger(cost.micros)).toBe(true);
      const list = Object.entries(MACHINE_HOURLY_USD).find(([type]) => type === MACHINE_LAUNCH_TYPES[row.id]!.instanceType)![1];
      expect(cost.micros).toBeGreaterThanOrEqual(Math.ceil((list * 1_000_000 * minutes) / 60));
    }
  });

  it("has cost words for every row, none for an unknown size, and never claims it is a charge", () => {
    for (const row of MACHINE_SIZE_ROWS) expect(machineCostWords(row.id)).toMatch(/^(The standard size|About [0-9.]+ times the cost of the standard size), about \$[0-9]+\.[0-9]{2} an hour\.$/u);
    for (const value of ["p5.48xlarge", "toString", undefined, 42]) expect(machineCostWords(value)).toBeUndefined();
  });

  it.each([
    ["an unknown size", "p5.48xlarge", "us-east-1", 60], ["an inherited name", "toString", "us-east-1", 60], ["no size", undefined, "us-east-1", 60],
    ["an unpriced region", "arm64-2-8", "eu-west-1", 60], ["no region", "arm64-2-8", undefined, 60],
    ["zero minutes", "arm64-2-8", "us-east-1", 0], ["a fraction", "arm64-2-8", "us-east-1", 1.5], ["over a week", "arm64-2-8", "us-east-1", 10_081], ["NaN", "arm64-2-8", "us-east-1", Number.NaN],
  ])("has no estimate (never $0) for %s", (_name, rowId, region, minutes) => {
    expect(machineCost(rowId, region, minutes)).toBeUndefined();
  });
});
