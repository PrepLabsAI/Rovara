import { afterEach, describe, expect, it, vi } from "vitest";
import { collectApplicationGroupEvidence } from "../support/e2e-application-evidence-fixture.js";
import { createOrdersExecutorPlan } from "../support/e2e-orders-executor-fixture.js";
import { atEvidenceCollectionTime, retainEvidenceCollection } from "../support/agent-evidence-clock.js";
import { createHash } from "node:crypto";
import { canonicalJson } from "@agentx/contracts";
import { decodeE2EApplicationSupervisorReadback, encodeE2EApplicationSupervisorReadback, qualifyE2EApplicationCollection } from "../../packages/verifier/src/application-result-adapter.js";

afterEach(() => { vi.useRealTimers(); });

describe("retained agent evidence uses the run's collection clock", () => {
  it("collects after supervisor assembly crosses the close millisecond, even when read much later", async () => {
    const { plan } = createOrdersExecutorPlan({ probe: "api-state-positive-v1" });
    const at = Date.parse(plan.admission.round.admittedAt) + 1_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at);
    const fixture = await collectApplicationGroupEvidence({ admission: plan.admission,
      observed: { kind: "state", finalValue: { orders: "ready", version: 1 }, disposition: "ready" } });
    const original = fixture.collected.collection!;
    const close = fixture.closedAt;
    const observedAt = new Date(Date.parse(close) + 7).toISOString();
    vi.setSystemTime(close);
    const retained = await retainEvidenceCollection(async () => {
      // Real supervisor frames with their content addresses updated, not a mocked verifier.
      // Assembly is scheduled after close without sleeping or widening the harvest window.
      await Promise.resolve();
      vi.setSystemTime(observedAt);
      const readback = decodeE2EApplicationSupervisorReadback(original.supervisorReadback);
      const reframe = (entry: typeof readback.receipt, edit: (value: Record<string, unknown>) => void) => {
        const value = JSON.parse(Buffer.from(entry.bytes).toString("utf8")) as Record<string, unknown>;
        edit(value);
        const bytes = Buffer.from(canonicalJson(value));
        return { bytes, ref: { ...entry.ref, byteLength: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") } };
      };
      const contextAt = (value: Record<string, unknown>) => { (value["context"] as Record<string, unknown>)["observedAt"] = observedAt; };
      const cleanup = readback.evidence.find((entry) => entry.ref.artifactId === "owned-cleanup")!;
      const updatedCleanup = reframe(cleanup, contextAt);
      const receipt = reframe(readback.receipt, (value) => { contextAt(value); value["cleanupRef"] = updatedCleanup.ref; });
      return { ...original,
        supervisorReadback: encodeE2EApplicationSupervisorReadback({ ...readback, receipt,
          evidence: readback.evidence.map((entry) => entry === cleanup ? updatedCleanup : entry) }),
        supervisorReceiptRefs: original.supervisorReceiptRefs.map((ref) => ref.artifactId === receipt.ref.artifactId ? receipt.ref : ref) };
    });
    const collect = () => qualifyE2EApplicationCollection(fixture.collected.oracle!, { ...retained.evidence, receivedAt: new Date().toISOString() });
    const beforeProof = await atEvidenceCollectionTime(close, collect);
    expect(beforeProof.status).toBe("UNKNOWN");
    expect(beforeProof.reason).toBe("raw supervisor proof was not observed after owned close within the original harvest window");
    vi.setSystemTime(Date.parse(plan.admission.round.deadlineAt) + 61_000);
    expect(await atEvidenceCollectionTime(retained.collectedAt, collect)).toMatchObject({ status: "PASS" });
    // Retaining a clock must never make genuinely late collection valid.
    expect(await atEvidenceCollectionTime(new Date(Date.parse(close) + 30_001).toISOString(), collect)).toMatchObject({ status: "UNKNOWN",
      reason: "application collection was not received inside the original bounded post-close harvest window" });
  });

  it("still collects a passing run after other fixtures consume its run and cleanup window", async () => {
    const { plan } = createOrdersExecutorPlan({ probe: "api-state-positive-v1" });
    const admission = plan.admission;
    const collectedAt = new Date(Date.parse(admission.round.admittedAt) + 1_000).toISOString();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(admission.round.deadlineAt) + 61_000);
    const options = { admission, observed: { kind: "state" as const, finalValue: { orders: "ready", version: 1 }, disposition: "ready" as const } };
    // The old lazy readback assigns the later test's time to owned close.
    await expect(collectApplicationGroupEvidence(options)).rejects.toThrow("protected owned close time is outside the original run and cleanup window");
    const retained = await atEvidenceCollectionTime(collectedAt, () => collectApplicationGroupEvidence(options));
    expect(retained.collected.unavailableReason).toBeNull();
    expect(retained.collected.qualification?.status).toBe("PASS");
  });

  it("restores real time when asynchronous collection rejects", async () => {
    const failure = new Error("collection failed");
    await expect(atEvidenceCollectionTime("2026-01-01T00:00:00.000Z", async () => {
      await Promise.resolve();
      throw failure;
    })).rejects.toBe(failure);
    expect(Date.now()).toBeGreaterThan(Date.parse("2026-01-02T00:00:00.000Z"));
  });
});
