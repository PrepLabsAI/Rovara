// TE-C6 (decision of 9d, owner of B5): a check whose ONLY failures are tests that failed once and passed on the rerun is recorded as passed for VERIFY, with a typed `flakyOnChange` fact on the workflow that B5's
// `flaky_on_change` hold reads (`flakyOnChangeHoldInput`). Anything else stays FAILED. These are the pure parts: the worker's file, the judgement of it against the broker's own check entries, the fact, and the workflow.
import { describe, expect, it } from "vitest";
import {
  CandidateManifestSchema, FLAKY_RERUN_ARTIFACT, FlakyRerunFileSchema, WorkflowSnapshotSchema, createCandidateManifest, createWorkflowSnapshot, flakyHoldFactOf, flakyOnChangeHoldInput, flakyOnlyChecks,
  recordWorkflowVerification, type CheckEntry,
} from "../../packages/contracts/src/index.js";

const ID_A = "tests/test_cart.py::test_total";
const ID_B = "tests/test_cart.py::test_tax";
const file = (checks: unknown) => ({ schemaVersion: 1, checks });
const entry = (over: Partial<CheckEntry> = {}): Pick<CheckEntry, "id" | "source" | "after" | "class"> => ({ id: "readiness:0", source: "project", after: "failed", class: "regression", ...over });

describe("the worker's flaky-rerun file", () => {
  it("is named, strict, and bounded: ids are valid test ids, at least one per check, at most 50, each check once", () => {
    expect(FLAKY_RERUN_ARTIFACT).toBe("flaky-rerun.json");
    expect(FlakyRerunFileSchema.safeParse(file([{ checkId: "readiness:0", flaky: [ID_A] }])).success).toBe(true);
    expect(FlakyRerunFileSchema.safeParse(file([])).success).toBe(true);
    const bad: unknown[] = [
      file([{ checkId: "readiness:0", flaky: [] }]),
      file([{ checkId: "agent:0", flaky: [ID_A] }]),
      file([{ checkId: "readiness:0", flaky: [" bad"] }]),
      file([{ checkId: "readiness:0", flaky: ["a\nb"] }]),
      file([{ checkId: "readiness:0", flaky: Array.from({ length: 51 }, (_, index) => `t.py::t${String(index)}`) }]),
      file([{ checkId: "readiness:0", flaky: [ID_A] }, { checkId: "readiness:0", flaky: [ID_B] }]),
      { ...file([]), extra: 1 },
      { schemaVersion: 2, checks: [] },
    ];
    for (const value of bad) expect(FlakyRerunFileSchema.safeParse(value).success, JSON.stringify(value).slice(0, 80)).toBe(false);
  });
});

describe("flakyOnlyChecks: the file is the worker's word, the broker's own entries decide what it may excuse", () => {
  const parsed = FlakyRerunFileSchema.parse(file([{ checkId: "readiness:0", flaky: [ID_A, ID_B] }, { checkId: "readiness:1", flaky: [ID_A] }]));
  it("excuses a project check that failed as a regression, and only that one", () => {
    const found = flakyOnlyChecks(parsed, [entry(), entry({ id: "readiness:1", after: "passed", class: "passing" })]);
    expect([...found]).toEqual([["readiness:0", [ID_A, ID_B]]]);
  });

  it.each([
    ["a timeout", { after: "timed_out" }],
    ["a check that was not run", { after: "not_run", class: "not_rerun" }],
    ["a check that was already failing", { class: "already_failing" }],
    ["a check with no before", { class: "failing_no_before" }],
    ["an agent command", { source: "agent_commands" }],
  ] as const)("never excuses %s", (_name, over) => {
    expect(flakyOnlyChecks(parsed, [entry(over)]).size).toBe(0);
  });

  it("never excuses a check the broker has no entry for, and nothing without a file", () => {
    expect(flakyOnlyChecks(parsed, [entry({ id: "readiness:7" })]).size).toBe(0);
    expect(flakyOnlyChecks(undefined, [entry()]).size).toBe(0);
  });
});

describe("flakyHoldFactOf: what B5 holds the draft for", () => {
  it("is the rerun-flaky tests the base does not already have as flaky, with their count", () => {
    expect(flakyHoldFactOf([[ID_A, ID_B]], [ID_B])).toEqual({ count: 1, ids: [ID_A] });
    expect(flakyHoldFactOf([[ID_A], [ID_A, ID_B]], undefined)).toEqual({ count: 2, ids: [ID_A, ID_B] });
  });
  it("is nothing when every flaky test is flaky on the base too (flaky on both is no hold), or there are none", () => {
    expect(flakyHoldFactOf([[ID_A, ID_B]], [ID_A, ID_B])).toBeUndefined();
    expect(flakyHoldFactOf([], undefined)).toBeUndefined();
  });
  it("lists at most 50 ids but counts them all", () => {
    const many = Array.from({ length: 120 }, (_, index) => `t.py::t${String(index)}`);
    const fact = flakyHoldFactOf([many.slice(0, 50), many.slice(50, 100), many.slice(100)], []);
    expect(fact?.count).toBe(120);
    expect(fact?.ids).toHaveLength(50);
  });
});

describe("the workflow", () => {
  const now = "2026-11-13T12:00:00.000Z";
  const current = { ...createWorkflowSnapshot({ taskId: "11111111-1111-4111-8111-111111111111", ownerId: "a".repeat(64), now }), stage: "VERIFY" as const, state: "BLOCKED" as const };
  const candidate = (letter: string) => createCandidateManifest([{ repositoryId: "payments", commitSha: letter.repeat(40), treeSha: "1".repeat(40) }]);
  const checks = (digest: string, status: "PASS" | "FAILED") => ({ candidateDigest: digest, producer: "agentx-worker-checks", environmentId: "ws", recordedAt: now, results: [{ checkId: "unit", status }] });
  const record = (manifest: ReturnType<typeof candidate>, status: "PASS" | "FAILED", flakyOnChange?: { count: number; ids: string[] }, from: unknown = current) =>
    recordWorkflowVerification(from, { candidate: CandidateManifestSchema.parse(manifest), checks: checks(manifest.digest, status), now, ...(flakyOnChange === undefined ? {} : { flakyOnChange }) });

  it("records the fact with the candidate it is for, and the hold input reads it back as ids", () => {
    const manifest = candidate("a");
    const recorded = record(manifest, "PASS", { count: 2, ids: [ID_A, ID_B] });
    expect(recorded).toMatchObject({ stage: "REVIEW", state: "WAITING", flakyOnChange: { candidateDigest: manifest.digest, count: 2, ids: [ID_A, ID_B] } });
    expect(flakyOnChangeHoldInput(recorded)).toEqual([ID_A, ID_B]);
    expect(WorkflowSnapshotSchema.safeParse(recorded).success).toBe(true);
  });

  it("without a fact the snapshot has no such key at all (today's snapshot, byte for byte)", () => {
    const recorded = record(candidate("a"), "PASS");
    expect(recorded).not.toHaveProperty("flakyOnChange");
    expect(flakyOnChangeHoldInput(recorded)).toBeUndefined();
    expect(JSON.stringify(recorded)).not.toContain("flakyOnChange");
  });

  it("a failed verification attaches no fact, even if one was offered", () => {
    expect(record(candidate("a"), "FAILED", { count: 1, ids: [ID_A] })).not.toHaveProperty("flakyOnChange");
  });

  it("a later verification replaces the earlier fact; one without a fact clears it", () => {
    const first = record(candidate("a"), "PASS", { count: 1, ids: [ID_A] });
    const again = { ...first, stage: "VERIFY" as const, state: "BLOCKED" as const };
    const second = record(candidate("b"), "PASS", undefined, again);
    expect(second).not.toHaveProperty("flakyOnChange");
    expect(record(candidate("b"), "PASS", { count: 1, ids: [ID_B] }, again).flakyOnChange).toMatchObject({ ids: [ID_B] });
  });

  it("the hold input is only for the candidate the workflow holds: a fact for other code is nothing", () => {
    const recorded = record(candidate("a"), "PASS", { count: 1, ids: [ID_A] });
    expect(flakyOnChangeHoldInput({ ...recorded, candidate: candidate("c") })).toBeUndefined();
    expect(flakyOnChangeHoldInput({ ...recorded, candidate: undefined })).toBeUndefined();
    expect(flakyOnChangeHoldInput(undefined)).toBeUndefined();
  });

  it("refuses a fact that does not add up", () => {
    const recorded = record(candidate("a"), "PASS", { count: 1, ids: [ID_A] });
    for (const fact of [{ candidateDigest: recorded.candidate!.digest, count: 0, ids: [] }, { candidateDigest: recorded.candidate!.digest, count: 1, ids: [ID_A, ID_B] }, { candidateDigest: "x", count: 1, ids: [ID_A] }, { candidateDigest: recorded.candidate!.digest, count: 1, ids: ["bad\nid"] }]) {
      expect(WorkflowSnapshotSchema.safeParse({ ...recorded, flakyOnChange: fact }).success, JSON.stringify(fact)).toBe(false);
    }
  });
});
