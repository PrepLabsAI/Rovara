import { describe, expect, it } from "vitest";
import { assertWorkflowDependencyResumeTree } from "../../packages/worker/src/workflow-dependencies.js";

const initialTree = "a".repeat(40);

describe("executeSerialWorkflowDependencies", () => {
  it("rejects a retry whose current workspace tree differs from its retained checkpoint", () => {
    expect(() => assertWorkflowDependencyResumeTree(initialTree, "f".repeat(40))).toThrow(/workspace changed since the retained ordered-work checkpoint/);
    expect(() => assertWorkflowDependencyResumeTree(initialTree, initialTree)).not.toThrow();
  });

});
