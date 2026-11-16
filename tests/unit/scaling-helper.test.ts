import { describe, expect, it } from "vitest";
import { expectLinearScaling, expectLinearScalingAsync } from "../support/scaling.js";

const sink: number[] = [];
const linear = (n: number) => () => { let total = 0; for (let i = 0; i < n; i++) total += Math.sqrt(i); sink.push(total); sink.length = 0; };
const quadratic = (n: number) => () => { let total = 0; for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) total += (i ^ j) & 1; sink.push(total); sink.length = 0; };

describe("expectLinearScaling", () => {
  it("passes linear work and reports the ratio", () => {
    const result = expectLinearScaling(linear, { n: 20_000, label: "linear" });
    expect(result.ratio).toBeLessThan(24);
    expect(result.n).toBe(20_000);
    expect(result.k).toBe(8);
  });
  it("fails quadratic work", () => {
    expect(() => expectLinearScaling(quadratic, { n: 600, label: "quadratic" })).toThrow(/faster than linear/u);
  });
  it("fails work that exceeds the hang limit", () => {
    expect(() => expectLinearScaling(linear, { n: 200_000, hangMs: 0.0001, minSampleMs: 0, label: "hang" })).toThrow(/Hang limit|faster than linear/u);
  });
  it("rejects bad options", () => {
    expect(() => expectLinearScaling(linear, { n: 0 })).toThrow(/bad scaling options/u);
    expect(() => expectLinearScaling(linear, { n: 10, k: 1 })).toThrow(/bad scaling options/u);
    expect(() => expectLinearScaling(linear, { n: 10, k: 4, maxRatio: 3 })).toThrow(/bad scaling options/u);
  });
});

describe("expectLinearScalingAsync", () => {
  it("passes linear async work", async () => {
    const result = await expectLinearScalingAsync((n) => async () => { linear(n)(); }, { n: 20_000, label: "async linear" });
    expect(result.ratio).toBeLessThan(24);
  });
  it("fails quadratic async work", async () => {
    await expect(expectLinearScalingAsync((n) => async () => { quadratic(n)(); }, { n: 600, label: "async quadratic" })).rejects.toThrow(/faster than linear/u);
  });
});
