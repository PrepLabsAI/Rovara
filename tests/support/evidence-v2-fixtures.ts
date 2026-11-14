// Fixtures for the evidence pack v2 contract tests (TE-A2a): one v1 pack as the broker writes it today and one v2 pack that uses every part. Built from plain objects, no fake secrets.
import type { EvidencePack, EvidencePackV2 } from "../../packages/contracts/src/index.js";

export const DIGEST = "c".repeat(64);
export const SHA = "a".repeat(40);

/** A v1 pack with a test check (with coverage), a lint check and a security check, a selection, one API scenario and one not-tested row. */
export function v1Pack(): EvidencePack {
  return {
    schemaVersion: 1,
    candidateDigest: DIGEST,
    environment: { tier: "sandbox", envRevision: 3, services: [{ name: "stripe", mode: "mocked", recordedAt: "2026-11-12T10:00:00.000Z" }], data: "synthetic", accounts: [] },
    checks: [
      {
        checkId: "readiness:0", kind: "test", label: "pytest -q", before: "failed", after: "passed", class: "fixed", durationMs: 4_000, exitCode: 0,
        tests: { total: 3, passed: 3, failed: 0, skipped: 0, errored: 0, names: [{ name: "tests/a.py::one", status: "passed" }], newTests: ["tests/a.py::one"] },
        coverage: { linesChanged: 10, linesCovered: 9, files: [{ path: "src/a.py", uncovered: [4] }] },
      },
      { checkId: "readiness:1", kind: "lint", label: "ruff", before: "passed", after: "passed", class: "passing", durationMs: 800, exitCode: null },
      {
        checkId: "readiness:2", kind: "security", label: "semgrep", before: "passed", after: "passed", class: "passing", durationMs: 1_200,
        findings: { tool: "semgrep", newCount: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, items: [] },
      },
    ],
    selection: { method: "full", selected: 3, total: 3 },
    api: [{ scenarioId: "orders", samples: [], diff: "none", changedPaths: [] }],
    browser: [],
    notTested: [{ kind: "claim", id: "c1", text: "refund flow", reason: "no test" }],
  };
}

/** A complete v2 pack. `overrides` replace top-level fields. */
export function v2Pack(overrides: Record<string, unknown> = {}): EvidencePackV2 {
  const pack = {
    schemaVersion: 2,
    candidate: { digest: DIGEST, repositories: [{ id: "web", baseBranch: "main", baseCommit: SHA, headCommit: "b".repeat(40) }] },
    producer: { edition: "cloud", isolation: "sealed" },
    level: { reached: "rovara_real_run", required: ["sealed"] },
    result: "verified",
    checks: [
      {
        id: "unit", kind: "test", label: "pytest -q", command: "pytest -q", stage: "sealed", before: "failed", after: "passed", class: "fixed", runBy: "rovara", durationMs: 4_000, exitCode: 0, attribution: "per_test",
        tests: { total: 3, passed: 3, failed: 0, skipped: 0, errored: 0, names: [{ name: "tests/a.py::one", status: "passed" }], newTests: ["tests/a.py::one"] },
        coverage: { linesChanged: 10, linesCovered: 9, files: [{ path: "src/a.py", uncovered: [4] }] },
      },
      {
        id: "bench", kind: "benchmark", label: "render time", stage: "confirm", before: "passed", after: "passed", class: "passing", runBy: "rovara", durationMs: 9_000,
        measures: [{ name: "p95", unit: "ms", base: 120, head: 118, spread: 4, direction: "down_good" }],
      },
    ],
    proof: { verdicts: [{ checkId: "unit", testId: "tests/a.py::one", verdict: "proves_change" }], provenCount: 1, loadFailureOnOld: 0, heldDraft: false },
    dependencies: [
      { name: "stripe", kind: "http", backing: "fake", label: "recorded_fake", trust: "recorded", recordedOn: "2026-11-12" },
      { name: "postgres", kind: "database", backing: "local", label: "real", trust: "real" },
    ],
    meters: { modelUsd: 0.4, machineMinutes: 12, machineUsd: 0.1, caps: { modelUsd: 1, machineMinutes: 60 } },
    notTested: [{ what: "refund flow", reason: "no test" }],
    ...overrides,
  };
  return pack as unknown as EvidencePackV2;
}
