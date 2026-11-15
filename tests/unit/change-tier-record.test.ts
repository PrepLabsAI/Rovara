// The `flow` record the change tier writes: it always reads back through the workflow's own schema, stays under its size limit, and keeps the catch counters honest.
import { describe, expect, it } from "vitest";
import { FLOW_MAX_BYTES, WorkflowFlowSchema, flowRecordBytes } from "../../packages/contracts/src/index.js";
import { recordCatch, recordCodeChanged, recordGrowth, recordTier, tierFromDiff, type TierFile } from "../../packages/broker/src/core/decisions/change-tier.js";

const AT = "2026-11-13T12:00:00.000Z";
const patch = "@@ -1,1 +1,1 @@\n-a\n+b";
const manyReasons = (count: number): TierFile[] => Array.from({ length: count }, (_, index) => ({ path: `src/auth/${"x".repeat(400)}${index}.ts`, status: "modified", additions: 1, deletions: 1, patch }));

describe("the flow record", () => {
  it("every record the writers make reads back through the schema, even at the biggest the history can be", () => {
    let flow = recordTier(undefined, tierFromDiff({ files: manyReasons(60), complete: true }, { headSha: "a".repeat(40), at: AT })).flow;
    for (let index = 0; index < 40; index += 1) flow = recordTier(flow, tierFromDiff({ files: manyReasons(60), complete: true }, { headSha: index.toString(16).padStart(40, "0"), at: AT })).flow;
    flow = recordCatch(flow, { step: "code_review", findings: 3, mustFix: 1 });
    expect(flowRecordBytes(flow)).toBeLessThanOrEqual(FLOW_MAX_BYTES);
    expect(WorkflowFlowSchema.safeParse(flow).success).toBe(true);
    // Cutting reasons never cuts the level or the binding.
    expect(flow.tier).toMatchObject({ level: "risky", source: "diff" });
    expect(flow.tier?.headSha).toMatch(/^[a-f0-9]{40}$/u);
  });

  it("catch counters: one per step, replaced when the step runs again, and code changes after it are counted", () => {
    let flow = recordCatch(undefined, { step: "code_review", findings: 2, mustFix: 1 });
    flow = recordCatch(flow, { step: "security_review", findings: 0, mustFix: 0 });
    expect(recordCodeChanged(undefined)).toBeUndefined();
    flow = recordCodeChanged(flow)!;
    flow = recordCodeChanged(flow)!;
    expect(flow.catchCounters).toEqual([{ step: "code_review", findings: 2, mustFix: 1, changedCode: 2 }, { step: "security_review", findings: 0, mustFix: 0, changedCode: 2 }]);
    // A step that ran again starts counting from its new run.
    flow = recordCatch(flow, { step: "code_review", findings: 0, mustFix: 0 });
    expect(flow.catchCounters?.find((counter) => counter.step === "code_review")).toEqual({ step: "code_review", findings: 0, mustFix: 0, changedCode: 0 });
    expect(WorkflowFlowSchema.safeParse(flow).success).toBe(true);
  });

  it("growth is recorded once, from the first level, and never lowered", () => {
    const base = { rulesVersion: 1 };
    const grown = recordGrowth(base, "small", "standard", AT);
    expect(grown.grewAfterBuild).toEqual({ from: "small", to: "standard", at: AT });
    const more = recordGrowth(grown, "standard", "risky", AT);
    expect(more.grewAfterBuild).toMatchObject({ from: "small", to: "risky" });
    expect(recordGrowth(more, "small", "standard", AT)).toBe(more);
    expect(recordGrowth(base, "risky", "small", AT)).toBe(base);
  });
});
