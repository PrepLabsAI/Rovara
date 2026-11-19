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
  it("repeats tiny work until the N sample is at least 20 ms, with the same count at N and 8N", () => {
    const result = expectLinearScaling(linear, { n: 2000, label: "tiny linear" });
    expect(result.ms).toBeGreaterThanOrEqual(20);
    expect(result.batches).toBeGreaterThan(1);
    expect(result.ratio).toBeLessThan(24);
  });
  it("fails quadratic work", () => {
    expect(() => expectLinearScaling(quadratic, { n: 600, label: "quadratic" })).toThrow(/faster than linear/u);
  });
  it("fails work that exceeds the hang limit", () => {
    expect(() => expectLinearScaling(linear, { n: 200_000, unitBytes: 0, hangMs: 0.0001, minSampleMs: 0, label: "hang" })).toThrow(/Hang limit|faster than linear/u);
  });
  it("refuses an 8N input over 256 KiB, so a linear scan cannot fall out of the CPU cache and read a steady ~25", () => {
    expect(() => expectLinearScaling(linear, { n: 40_000, label: "too big" })).toThrow(/8N input is about 320000 bytes, over the 262144 byte limit/u);
    expect(() => expectLinearScaling(linear, { n: 100, unitBytes: 4_000, label: "big unit" })).toThrow(/over the 262144 byte limit/u);
    expect(() => expectLinearScaling(linear, { n: 32_768, label: "exactly at the limit", minSampleMs: 0 })).not.toThrow(/byte limit/u);
    expect(() => expectLinearScaling(linear, { n: 200_000, unitBytes: 0, label: "builds no input", minSampleMs: 0 })).not.toThrow(/byte limit/u);
  });
  it("counts the bytes held in memory whatever n is (fixedBytes) toward the same 256 KiB limit, so a small N with big resident values is refused", () => {
    // 5 values of 32 KB held for the whole run plus an 8N text of 200 KB is a working set over the limit, though 8N alone is not.
    expect(() => expectLinearScaling(linear, { n: 25_000, fixedBytes: 160_500, label: "values held" })).toThrow(/over the 262144 byte limit/u);
    expect(() => expectLinearScaling(linear, { n: 8_000, fixedBytes: 160_500, label: "values held, shrunk", minSampleMs: 0 })).not.toThrow(/byte limit/u);
    expect(() => expectLinearScaling(linear, { n: 10, unitBytes: 0, fixedBytes: 262_145, label: "fixed alone" })).toThrow(/over the 262144 byte limit/u);
    expect(() => expectLinearScaling(linear, { n: 10, fixedBytes: -1 })).toThrow(/bad scaling options/u);
  });
  it("rejects bad options", () => {
    expect(() => expectLinearScaling(linear, { n: 0 })).toThrow(/bad scaling options/u);
    expect(() => expectLinearScaling(linear, { n: 10, k: 1 })).toThrow(/bad scaling options/u);
    expect(() => expectLinearScaling(linear, { n: 10, k: 4, maxRatio: 3 })).toThrow(/bad scaling options/u);
    expect(() => expectLinearScaling(linear, { n: 10, unitBytes: -1 })).toThrow(/bad scaling options/u);
  });
});

describe("expectLinearScalingAsync", () => {
  it("passes linear async work", async () => {
    const result = await expectLinearScalingAsync((n) => async () => { linear(n)(); }, { n: 20_000, label: "async linear" });
    expect(result.ratio).toBeLessThan(24);
  });
  it("repeats tiny async work until the N sample is at least 20 ms", async () => {
    const result = await expectLinearScalingAsync((n) => async () => { linear(n)(); }, { n: 2000, label: "async tiny linear" });
    expect(result.ms).toBeGreaterThanOrEqual(20);
    expect(result.batches).toBeGreaterThan(1);
  });
  it("fails quadratic async work", async () => {
    await expect(expectLinearScalingAsync((n) => async () => { quadratic(n)(); }, { n: 600, label: "async quadratic" })).rejects.toThrow(/faster than linear/u);
  });
});
