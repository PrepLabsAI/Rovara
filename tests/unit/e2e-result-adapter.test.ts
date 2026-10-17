import { describe, expect, it } from "vitest";
import { parseE2EReport, qualifyE2EReport } from "../../packages/verifier/src/result-adapter.js";

const sha = "a".repeat(64);
const runId = "018f47a2-9b3c-7abc-8def-0123456789ab";
function actualReport(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "report-1",
    run: {
      id: runId, specVersion: "0.1", runner: { name: "e2e", version: "0.20.0" }, status: "passed", exitCode: 0,
      startedAt: "2026-10-13T12:00:00.000Z", finishedAt: "2026-10-13T12:00:01.000Z",
      project: { id: "rovara-contract-p0", configDigest: sha },
      environment: { ci: false, trustNoticeShown: true, os: "darwin", arch: "arm64", runtime: "node" },
      targets: [{ id: "contract-api", index: 0, platform: "contract-api", environment: "test", engine: { name: "none", version: "unversioned", spiVersion: 1 }, capabilities: [], artifactCapabilities: [], stateCapability: false }],
      serialGroups: [],
      results: [{ id: sha, testId: ".agentx/e2e/generated-contract.test.ts::case-a", kind: "test", declarationIndex: 0, titlePath: ["case-a"], file: ".agentx/e2e/generated-contract.test.ts", source: { file: ".agentx/e2e/generated-contract.test.ts", line: 1, column: 1 }, targetId: "contract-api", platform: "contract-api", agent: "default", repeat: 0, selected: true, status: "passed", attempts: [{ id: runId, index: 0, status: "passed", startedAt: "2026-10-13T12:00:00.100Z", durationMs: 0.5, steps: [], artifacts: [], secondaryErrors: [], cleanup: "complete" }] }],
      errors: [], summary: { discovered: 1, selected: 1, executed: 1, passed: 1, failed: 0, interrupted: 0, flaky: 0, skipped: 0 },
      limits: { maxAgentContextBytes: 1024, maxLedgerBytes: 1024, maxObservationBytes: 1024, maxEventsPerStep: 1, maxModelTokensPerCall: 1 },
      usage: { discoveredResults: 1, maxAgentContextBytes: 0, maxLedgerBytes: 0, maxObservationBytes: 0, artifactBytes: 0, downloads: 0, events: 0, modelTokens: 0, maxModelCallsInStep: 0, maxActionStepsInStep: 0 },
    }, ...overrides,
  };
}

describe("strict upstream E2E report adapter", () => {
  it("accepts pinned report-1 shape and fractional duration while exposing no authority", () => {
    const parsed = parseE2EReport(Buffer.from(JSON.stringify(actualReport())));
    expect(parsed.kind).toBe("parsed");
    if (parsed.kind === "parsed") expect(parsed.report.run.results[0]?.attempts[0]?.durationMs).toBe(0.5);
  });

  it("accepts only the pinned runner's bounded optional VCS metadata", () => {
    const valid = actualReport();
    (valid.run as Record<string, unknown>).vcs = { commit: "a".repeat(40), branch: "main", dirty: false };
    const parsed = parseE2EReport(Buffer.from(JSON.stringify(valid)));
    expect(parsed.kind).toBe("parsed");
    if (parsed.kind === "parsed") expect(parsed.report.run.vcs).toEqual({ commit: "a".repeat(40), branch: "main", dirty: false });

    for (const vcs of [
      { commit: "not-a-commit" },
      { commit: "a".repeat(40), dirty: "false" },
      { commit: "a".repeat(40), extra: true },
    ]) {
      const invalid = actualReport();
      (invalid.run as Record<string, unknown>).vcs = vcs;
      expect(parseE2EReport(Buffer.from(JSON.stringify(invalid)))).toMatchObject({ kind: "unavailable" });
    }
  });

  it("never qualifies without independently supplied capture and assertion receipts", () => {
    const parsed = parseE2EReport(Buffer.from(JSON.stringify(actualReport())));
    expect(qualifyE2EReport({ parsed, expected: null, capture: null, receipts: [] }).status).toBe("UNKNOWN");
  });


  it("maps only the exact observed upstream tuple and leaves it UNKNOWN for the native gate", () => {
    const parsed = parseE2EReport(Buffer.from(JSON.stringify(actualReport())));
    if (parsed.kind !== "parsed") throw new Error("test fixture should match report-1");
    const tuple = { caseId: "case-a", compilerCaseIdentity: "b".repeat(64), registrationKey: "op:v1", candidateResponseScope: "contained-candidate-process-response/v1" as const, requestProtocol: "contained-candidate-host-request/v1" as const, upstreamTestId: ".agentx/e2e/generated-contract.test.ts::case-a", upstreamResultId: sha, title: "case-a", targetId: "api", targetName: "contract-api", agent: "default" as const, disposition: "run" as const };
    const mapped = qualifyE2EReport({ parsed, expected: { upstreamRunId: runId, projectId: "rovara-contract-p0", configDigest: sha, selection: { schemaVersion: 1, algorithm: "e2e-public-list-selection/v1", planDigest: "c".repeat(64), groupId: "group-a", tuples: [tuple] }, processExitCode: 0 }, capture: { observed: true }, receipts: [{ observed: true }] });
    expect(mapped.status).toBe("UNKNOWN");
    expect(mapped.cases).toEqual([{ caseId: "case-a", status: "passed", attempts: 1 }]);
  });

  it("turns malformed and over-limit reports into bounded unknowns", () => {
    expect(parseE2EReport(Buffer.from("{"))).toMatchObject({ kind: "unavailable" });
    expect(parseE2EReport(Buffer.alloc(4 * 1024 * 1024 + 1))).toMatchObject({ kind: "unavailable" });
    expect(parseE2EReport(null as never)).toMatchObject({ kind: "unavailable" });
    let invoked = false;
    const hostile = new Uint8Array([123]);
    Object.defineProperty(hostile, "byteLength", { get() { invoked = true; throw new Error("getter"); } });
    expect(parseE2EReport(hostile)).toMatchObject({ kind: "unavailable" });
    expect(invoked).toBe(false);
    expect(parseE2EReport(new Proxy(new Uint8Array([123]), {}))).toMatchObject({ kind: "unavailable" });
  });
});
