import { describe, expect, it } from "vitest";
import { validateInstanceRegion, validateRuntimeSessionId } from "../../scripts/preflight.js";

describe("local preflight", () => {
  it("accepts a documented Instances region", () => {
    expect(() => validateInstanceRegion("us-west-2")).not.toThrow();
  });

  it("rejects an unsupported Instances region", () => {
    expect(() => validateInstanceRegion("eu-west-3")).toThrow(/not recorded as supported/);
  });

  it("enforces AgentCore runtime session ID lengths", () => {
    expect(() => validateRuntimeSessionId("short")).toThrow(/between 33 and 256/);
    expect(() => validateRuntimeSessionId("a".repeat(33))).not.toThrow();
  });
});
