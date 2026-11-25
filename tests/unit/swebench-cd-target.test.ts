// The SWE-bench runner's cd mapping (Spec 051 Ruling X, #299): the runner's testbed folder reads as `testbed`. Split out of
// devcontainer-cd-target.test.ts so that product test no longer reaches into the SWE-bench folder; it goes with the runner.
import { describe, expect, it } from "vitest";
import { testbedRelativeCdTarget } from "../../packages/worker/src/swebench/agent.js";

describe("testbedRelativeCdTarget", () => {
  const paths = { hostFolder: "/runs/r1/testbed", containerFolder: "/testbed" };

  it.each([
    ["/testbed", "testbed"],
    ["/testbed/astropy/io", "testbed/astropy/io"],
  ])("maps %j to %j", (target, mapped) => {
    expect(testbedRelativeCdTarget(target, paths)).toBe(mapped);
  });

  it.each(["/testbedX", "/app", "testbed"])("leaves %j unmapped", (target) => {
    expect(testbedRelativeCdTarget(target, paths)).toBeUndefined();
  });
});
