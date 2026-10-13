import { describe, expect, it } from "vitest";
import { collectE2EActualCliRun } from "../../packages/verifier/src/runtime-collection.js";

const actual = { runStartCapture: { status: "missing", capture: null }, rawReportBytes: new Uint8Array(), runProcess: { status: 0 } };

describe("actual runtime capture collection gate", () => {
  it.each(["missing", "duplicate", "invalid"] as const)("keeps an exit-zero run UNKNOWN when the independent capture is %s", (status) => {
    const result = collectE2EActualCliRun({ actual: { ...actual, runStartCapture: { status, capture: null } } } as never);
    expect(result.qualification).toBeNull();
    expect(result.unavailableReason).toContain(status);
  });
});
