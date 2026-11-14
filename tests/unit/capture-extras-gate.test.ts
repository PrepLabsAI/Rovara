// Proof and evidence fix round 1 (Opus review I6): the new capture-policy fields are gated on a worker capability. This pins WHY the gate is needed (a worker built before B1/B2 refuses the policy) and what the
// broker may do with the fields.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { E2ECapturePolicySchema, E2EWorkflowAdmissionRefSchema, E2E_CAPTURE_EXTRAS_FEATURE, WORKER_INVOCATION_FEATURES, capturePolicyNeedsExtras } from "../../packages/contracts/src/index.js";
import { WORKER_IMPLEMENTED_FEATURES } from "../../packages/worker/src/implemented-features.js";

/** The capture policy exactly as a worker built before B1 and B2 parsed it: strict, with four booleans. */
const OLD_WORKER_CAPTURE_POLICY = z.object({ screenshots: z.boolean(), traces: z.boolean(), video: z.boolean(), downloads: z.boolean() }).strict();
const BASE = { screenshots: true, traces: false, video: false, downloads: true };

describe("why the gate is needed: an older worker refuses the new shape", () => {
  it("parses a policy without the new fields, and refuses one with either", () => {
    expect(OLD_WORKER_CAPTURE_POLICY.safeParse(BASE).success).toBe(true);
    expect(OLD_WORKER_CAPTURE_POLICY.safeParse({ ...BASE, screenshotMode: "all" }).success).toBe(false);
    expect(OLD_WORKER_CAPTURE_POLICY.safeParse({ ...BASE, apiSamples: true }).success).toBe(false);
    expect(E2ECapturePolicySchema.safeParse({ ...BASE, screenshotMode: "all", apiSamples: true }).success).toBe(true);
  });
});

describe("what the broker sets", () => {
  it("says a policy needs the extras exactly when it carries either field (any value, 'failed' included)", () => {
    expect(capturePolicyNeedsExtras(BASE as Parameters<typeof capturePolicyNeedsExtras>[0])).toBe(false);
    expect(capturePolicyNeedsExtras({ ...BASE, screenshotMode: "failed" })).toBe(true);
    expect(capturePolicyNeedsExtras({ ...BASE, screenshotMode: "all" })).toBe(true);
    expect(capturePolicyNeedsExtras({ ...BASE, apiSamples: false })).toBe(true);
    expect(capturePolicyNeedsExtras({ ...BASE, apiSamples: true })).toBe(true);
  });
  it("carries the marker on the admission reference as a literal true, never false", () => {
    const ref = { schemaVersion: 1, kind: "application", taskId: "6c1a7e3a-0000-4000-8000-000000000001", workflowRevision: 1, candidateDigest: "a".repeat(64), roundId: "6c1a7e3a-0000-4000-8000-000000000002",
      groupRunIds: ["6c1a7e3a-0000-4000-8000-000000000003"], admissionRef: { key: `workflow-e2e-admissions/sha256/${"b".repeat(64)}.json`, sha256: "b".repeat(64), byteLength: 100 } };
    expect(E2EWorkflowAdmissionRefSchema.safeParse(ref).success).toBe(true);
    expect(E2EWorkflowAdmissionRefSchema.safeParse({ ...ref, captureExtras: true }).success).toBe(true);
    expect(E2EWorkflowAdmissionRefSchema.safeParse({ ...ref, captureExtras: false }).success).toBe(false);
  });
  it("is a feature every worker of this image lists, and one an older worker does not", () => {
    expect(E2E_CAPTURE_EXTRAS_FEATURE).toBe("task.workflowE2ECaptureExtras.v1");
    expect(WORKER_INVOCATION_FEATURES).toContain(E2E_CAPTURE_EXTRAS_FEATURE);
    expect(WORKER_IMPLEMENTED_FEATURES).toContain(E2E_CAPTURE_EXTRAS_FEATURE);
  });
});
