import { describe, expect, it } from "vitest";
import {
  MAX_WORKSPACE_DIFF_BYTES,
  boundWorkspaceDiff,
} from "../../packages/worker/src/artifacts.js";

describe("workspace diff artifact bounds", () => {
  it("preserves small diffs", () => {
    expect(boundWorkspaceDiff("small diff")).toBe("small diff");
  });

  it("truncates oversized UTF-8 diffs below the control-plane limit", () => {
    const bounded = boundWorkspaceDiff("λ".repeat(MAX_WORKSPACE_DIFF_BYTES));

    expect(Buffer.byteLength(bounded, "utf8")).toBeLessThanOrEqual(MAX_WORKSPACE_DIFF_BYTES);
    expect(bounded).toContain("workspace diff truncated");
  });
});
