// Proof and evidence P5: the broker builds the evidence pack from the worker's raw parts and its own check report. The raw file is untrusted: bound to the candidate digest, checked against the broker's
// check outcomes and the artifact store, redacted again; whatever fails is dropped and named, and a drop never makes a check look better.
import { describe, expect, it } from "vitest";
import { EVIDENCE_ARTIFACT_RETENTION, consoleErrorsWords, EvidencePackSchema, EvidenceViewSchema, type ArtifactRef, type EvidenceArtifactKind, type EvidenceEnvironment } from "../../packages/contracts/src/evidence.js";
import type { CheckEntry } from "../../packages/contracts/src/checks.js";
import { buildEvidencePack, evidenceHref, evidenceViewOf, type EvidenceBuildInput, type StoredArtifact } from "../../packages/broker/src/core/proof/evidence-pack.js";

const sha = (letter: string) => letter.repeat(64);
const DIGEST = sha("c");
const SECRET = `ghp_${"Ab1Cd2Ef3Gh4".repeat(3)}`;
const ref = (kind: EvidenceArtifactKind, letter: string, bytes = 1_000): ArtifactRef => ({ kind, sha256: sha(letter), bytes, retentionClass: EVIDENCE_ARTIFACT_RETENTION[kind] });
const entry = (id: string, label: string, over: Partial<CheckEntry> = {}): CheckEntry => ({ id, label, source: "project", before: "failed", after: "passed", class: "fixed", output: "", durationMs: 900, exitCode: 0, ...over });
const environment = (over: Partial<EvidenceEnvironment> = {}): EvidenceEnvironment => ({ tier: "sandbox", envRevision: 3, services: [{ name: "partner-scorer", mode: "mocked", fixtureRevision: 2, schemaVersion: 3, recordedAt: "2026-11-02T00:00:00.000Z" }], data: "synthetic", accounts: [{ profileId: "buyer", kind: "run_scoped" }], ...over });
const tests = (over: Record<string, unknown> = {}) => ({ total: 4, passed: 3, failed: 0, skipped: 1, errored: 0, names: [{ name: "test_match.py::test_no_region", status: "passed", proof: "proves_change" }], newTests: ["test_match.py::test_no_region"], ...over });
const raw = (over: Record<string, unknown> = {}) => JSON.stringify({ schemaVersion: 1, candidateDigest: DIGEST, checks: [{ checkId: "readiness:0", tests: tests(), coverage: { linesChanged: 48, linesCovered: 41, files: [{ path: "src/match.py", uncovered: [3, 4] }] } }], ...over });
const ALL_OK = { companyAllows: { video: true, trace: true }, revocationConfirmed: true, tierAllowed: true, gate: { allowed: { video: true, trace: true }, reasons: {} } };
const available = () => "available" as const;
const stored = (...refs: ArtifactRef[]): Map<string, StoredArtifact> => new Map(refs.map((item) => [item.sha256, { kind: item.kind, bytes: item.bytes }]));
const input = (over: Partial<EvidenceBuildInput> = {}): EvidenceBuildInput => ({
  candidateDigest: DIGEST, rawText: raw(), checks: [entry("readiness:0", "pytest -q"), entry("readiness:1", "ruff check .")],
  checkKinds: new Map([["readiness:0", "test"], ["readiness:1", "lint"]]), environment: environment(), storedArtifacts: new Map(), ...over,
});

describe("the pack from the broker's own parts and a good raw file", () => {
  const built = buildEvidencePack(input());
  it("takes labels, outcomes, classes and kinds from the broker, and the test details from the raw file", () => {
    expect(built.problems).toEqual([]);
    const [first, second] = built.pack!.checks;
    expect(first).toMatchObject({ checkId: "readiness:0", kind: "test", label: "pytest -q", before: "failed", after: "passed", class: "fixed", durationMs: 900, exitCode: 0 });
    expect(first?.tests?.newTests).toEqual(["test_match.py::test_no_region"]);
    expect(first?.coverage).toMatchObject({ linesChanged: 48, linesCovered: 41 });
    expect(second).toMatchObject({ kind: "lint", label: "ruff check ." });
    expect(second?.tests).toBeUndefined();
  });
  it("derives the selection from the tests that ran when the worker sent none, and lists mocked services as not tested", () => {
    expect(built.pack?.selection).toEqual({ method: "full", selected: 4, total: 4 });
    expect(built.pack?.notTested).toContainEqual({ kind: "mocked_service", id: "partner-scorer", text: "partner-scorer is mocked", reason: "answered from recorded responses" });
  });
});

describe("a raw file that cannot be used", () => {
  it("for other code is ignored whole, and the pack keeps what the broker knows", () => {
    const built = buildEvidencePack(input({ rawText: raw({ candidateDigest: sha("d") }) }));
    expect(built.problems).toEqual(["raw_for_other_code"]);
    expect(built.pack?.candidateDigest).toBe(DIGEST);
    expect(built.pack?.checks[0]?.tests).toBeUndefined();
    expect(built.pack?.notTested).toContainEqual({ kind: "environment", id: "evidence", text: "Test, coverage and scan details", reason: "could not be read" });
  });
  it("is too large when it is over 2 MiB", () => {
    const built = buildEvidencePack(input({ rawText: raw({ checks: [] }).padEnd(2 * 1_048_576 + 1, " ") }));
    expect(built.problems).toEqual(["raw_too_large"]);
  });
  it("ignores parts about checks the broker did not run", () => {
    const built = buildEvidencePack(input({ rawText: raw({ checks: [{ checkId: "readiness:9", tests: tests() }] }) }));
    expect(built.problems).toEqual(["unknown_check_ignored"]);
    expect(built.pack?.checks.map((check) => check.checkId)).toEqual(["readiness:0", "readiness:1"]);
  });
});

describe("test details are checked against the broker's own outcome", () => {
  const withTests = (over: Record<string, unknown>, checks: CheckEntry[] = [entry("readiness:0", "pytest")]) => buildEvidencePack(input({ checks, rawText: raw({ checks: [{ checkId: "readiness:0", tests: tests(over) }] }) }));
  it("drops a scan that failed with zero new findings, and findings under a check that did not finish", () => {
    const zero = { tool: "bandit", newCount: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, items: [] };
    const failed = buildEvidencePack(input({ checks: [entry("readiness:1", "bandit", { after: "failed", class: "regression", exitCode: 1 })], checkKinds: new Map([["readiness:1", "security"]]), rawText: raw({ checks: [{ checkId: "readiness:1", findings: zero }] }) }));
    expect(failed.problems).toEqual(["findings_disagree_with_check"]);
    expect(failed.pack?.checks[0]?.findings).toBeUndefined();
    const timedOut = buildEvidencePack(input({ checks: [entry("readiness:1", "bandit", { after: "timed_out", class: "not_rerun", exitCode: null })], rawText: raw({ checks: [{ checkId: "readiness:1", findings: zero }] }) }));
    expect(timedOut.pack?.checks[0]?.findings).toBeUndefined();
    const clean = buildEvidencePack(input({ checks: [entry("readiness:1", "bandit")], rawText: raw({ checks: [{ checkId: "readiness:1", findings: zero }] }) }));
    expect(clean.pack?.checks[0]?.findings?.newCount).toBe(0);
  });
  it("drops a report under a check that timed out, was stopped or never ran: it may be left from an older run", () => {
    for (const after of ["timed_out", "unknown", "not_run"] as const) {
      const built = withTests({}, [entry("readiness:0", "pytest", { after, class: "not_rerun", exitCode: null })]);
      expect(built.problems, after).toEqual(["tests_not_trusted"]);
      expect(built.pack?.checks[0]?.tests, after).toBeUndefined();
    }
  });
  it("drops names that outnumber the counts they claim", () => {
    const built = withTests({ total: 4, passed: 3, skipped: 1, names: Array.from({ length: 4 }, (_, index) => ({ name: `t${String(index)}`, status: "skipped" })) });
    expect(built.problems).toEqual(["tests_names_exceed_counts"]);
    expect(built.pack?.checks[0]?.tests).toBeUndefined();
  });
  it("drops coverage whose listed uncovered lines do not fit the numbers, and findings that list more than they count", () => {
    const covered = buildEvidencePack(input({ rawText: raw({ checks: [{ checkId: "readiness:0", coverage: { linesChanged: 10, linesCovered: 9, files: [{ path: "a.py", uncovered: [1, 2, 3] }] } }] }) }));
    expect(covered.problems).toEqual(["coverage_inconsistent"]);
    expect(covered.pack?.checks[0]?.coverage).toBeUndefined();
    const finding = { ruleId: "B101", severity: "high", path: "a.py", line: 3, message: "assert used" };
    const scan = buildEvidencePack(input({ rawText: raw({ checks: [{ checkId: "readiness:1", findings: { tool: "bandit", newCount: 1, bySeverity: { critical: 0, high: 1, medium: 0, low: 0, info: 0 }, items: [finding, finding] } }] }) }));
    expect(scan.problems).toEqual(["findings_inconsistent"]);
    expect(scan.pack?.checks[1]?.findings).toBeUndefined();
  });
});

describe("selection", () => {
  it("says what was not run when the worker selected a part of the tests", () => {
    const selection = { method: "coverage_map", selected: 37, total: 1240, mapAgeHours: 14 };
    const built = buildEvidencePack(input({ rawText: raw({ selection }) }));
    expect(built.pack?.selection).toEqual(selection);
    expect(built.pack?.notTested).toContainEqual({ kind: "not_selected", id: "selection", text: "1203 of 1240 tests were not run", reason: "not selected (coverage map)" });
  });
  it("is refused when the worker selected more than the total", () => {
    expect(buildEvidencePack(input({ rawText: raw({ selection: { method: "full", selected: 5, total: 4 } }) })).pack).toBeUndefined();
  });
});

describe("redaction of everything the raw file wrote", () => {
  it("redacts a secret in a test name, new test, coverage path, finding, migration, scenario and output tail, and the broker's own labels", () => {
    const finding = { ruleId: `rule ${SECRET}`, severity: "low", path: `a/${SECRET}.py`, line: 1, message: `uses ${SECRET}` };
    const built = buildEvidencePack(input({
      checks: [entry("readiness:0", `pytest ${SECRET}`), entry("readiness:1", "scan")],
      rawText: raw({
        checks: [
          { checkId: "readiness:0", tests: tests({ names: [{ name: `test ${SECRET}`, status: "passed" }], newTests: [`new ${SECRET}`] }), coverage: { linesChanged: 3, linesCovered: 2, files: [{ path: `src/${SECRET}.py`, uncovered: [1] }] }, outputTail: `ran with token ${SECRET}\n` },
          { checkId: "readiness:1", findings: { tool: `tool ${SECRET}`, newCount: 1, bySeverity: { critical: 0, high: 0, medium: 0, low: 1, info: 0 }, items: [finding] }, migrations: { applied: [`m ${SECRET}`], rolledBack: true, schemaChanges: [`t ${SECRET}`] } },
        ],
        api: [{ scenarioId: `api ${SECRET}`, samples: [], diff: "changed", changedPaths: [`$.a.${SECRET}`] }],
      }),
    }));
    expect(built.pack).toBeDefined();
    const text = JSON.stringify(built) ;
    expect(text).not.toContain(SECRET);
    expect(text).toContain("[REDACTED]");
    expect(built.newArtifacts[0]?.text).not.toContain(SECRET);
  });
  it("makes a label with hidden characters one plain line, and cuts a long label to 200 characters", () => {
    const built = buildEvidencePack(input({ checks: [entry("readiness:0", `a\nb‮c${"x".repeat(500)}`)], rawText: undefined }));
    const label = built.pack!.checks[0]!.label;
    expect(label).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(Array.from(label).length).toBeLessThanOrEqual(200);
  });
});

describe("artifacts", () => {
  const sample = ref("api_sample_json", "1");
  const shot = ref("jpeg", "2", 4_000);
  const video = ref("webm", "3", 9_000);
  const trace = ref("trace_zip", "4", 12_000);
  const browser = (over: Record<string, unknown> = {}) => ({ scenarioId: "login", strip: { before: [shot], after: [shot] }, video, trace, consoleErrors: 0, ...over });
  const build = (over: Partial<EvidenceBuildInput> = {}, scenario: Record<string, unknown> = {}) => buildEvidencePack(input({
    rawText: raw({ api: [{ scenarioId: "rank", samples: [sample], diff: "none", changedPaths: [] }], browser: [browser(scenario)] }),
    storedArtifacts: stored(sample, shot, video, trace), ...over,
  }));
  it("leaves consoleErrors out when none was measured (never a zero), keeps a count a worker really sent, and reads a pack saved before the field was optional (I5)", () => {
    const unmeasured = buildEvidencePack(input({ rawText: raw({ browser: [{ scenarioId: "login", strip: { before: [], after: [] } }] }) })).pack?.browser[0];
    expect(unmeasured).toBeDefined();
    expect("consoleErrors" in unmeasured!).toBe(false);
    expect(consoleErrorsWords(unmeasured!.consoleErrors)).toBe("not measured");
    const measured = build({}, { consoleErrors: 3 }).pack?.browser[0];
    expect(measured?.consoleErrors).toBe(3);
    expect(consoleErrorsWords(0)).toBe("0 console errors");
    expect(consoleErrorsWords(1)).toBe("1 console error");
    expect(consoleErrorsWords(3)).toBe("3 console errors");
    expect(EvidencePackSchema.safeParse({ ...build().pack, browser: [{ scenarioId: "login", strip: { before: [], after: [] }, consoleErrors: 0 }] }).success).toBe(true);
  });
  it("names the failing gate condition, in order: tier, setting, revocation, and lists every withheld file for deletion", () => {
    const reasons = (media: EvidenceBuildInput["media"], environmentOver: Partial<EvidenceEnvironment> = {}) => build({ media, environment: environment(environmentOver) }).pack?.browser[0]?.withheld?.map((item) => item.reason);
    expect(reasons({ ...ALL_OK, tierAllowed: false })).toEqual(["tier_not_allowed", "tier_not_allowed"]);
    expect(reasons({ ...ALL_OK, companyAllows: { video: false, trace: false } })).toEqual(["company_setting_off", "company_setting_off"]);
    expect(reasons({ ...ALL_OK, revocationConfirmed: false })).toEqual(["revocation_not_confirmed", "revocation_not_confirmed"]);
    // a caller that forgot the proof is a refusal, not a pass (Opus review I2)
    expect(reasons({ ...ALL_OK, revocationConfirmed: undefined as never })).toEqual(["revocation_not_confirmed", "revocation_not_confirmed"]);
    // the full publication gate decides too, including the data check the pack's own schema cannot make
    expect(reasons({ ...ALL_OK, gate: { allowed: { video: false, trace: true }, reasons: { video: "data_not_synthetic" } } })).toEqual(["data_not_synthetic"]);
    expect(reasons({ ...ALL_OK, gate: { allowed: { video: false, trace: false }, reasons: {} } })).toEqual(["data_not_synthetic", "data_not_synthetic"]);
    expect(reasons({ ...ALL_OK, gate: undefined as never })).toEqual(["data_not_synthetic", "data_not_synthetic"]);
    expect(reasons(undefined)).toEqual(["tier_not_allowed", "tier_not_allowed"]);
    expect(reasons({ companyAllows: { video: true, trace: true }, revocationConfirmed: false, tierAllowed: false, gate: undefined as never })).toEqual(["tier_not_allowed", "tier_not_allowed"]);
    // A shared environment with no run-scoped account at all cannot show its accounts were dead.
    expect(reasons(ALL_OK, { tier: "shared", accounts: [] })).toEqual(["account_not_run_scoped", "account_not_run_scoped"]);
    expect(build({ media: { ...ALL_OK, revocationConfirmed: false } }).withheldArtifacts).toEqual([video, trace]);
    expect(build({ media: ALL_OK }).withheldArtifacts).toEqual([]);
    expect(build({ media: ALL_OK }).pack?.browser[0]).toMatchObject({ video, trace });
    expect(build({ media: ALL_OK, environment: environment({ tier: "shared" }) }).pack?.browser[0]).toMatchObject({ video, trace });
  });
  it("says the upload failed when an allowed video is not in the store", () => {
    const built = build({ media: ALL_OK, storedArtifacts: stored(sample, shot, trace) });
    expect(built.pack?.browser[0]?.video).toBeUndefined();
    expect(built.pack?.browser[0]?.withheld).toEqual([{ artifact: "video", reason: "upload_failed" }]);
    expect(built.pack?.browser[0]?.trace).toEqual(trace);
  });
  it("makes an output tail a log artifact of its own, hashed from the redacted text, and cuts it to 64 KiB from the start", () => {
    const tail = `${"é".repeat(40_000)}END`;
    const built = buildEvidencePack(input({ rawText: raw({ checks: [{ checkId: "readiness:0", outputTail: tail.slice(0, 65_536) }] }) }));
    const made = built.newArtifacts[0]!;
    expect(made.ref).toMatchObject({ kind: "log_txt", retentionClass: "evidence-std" });
    expect(made.ref.bytes).toBe(Buffer.byteLength(made.text, "utf8"));
    expect(made.ref.bytes).toBeLessThanOrEqual(65_536);
    expect(built.pack?.checks[0]?.outputTailRef).toEqual(made.ref);
  });
});

describe("the task page's view", () => {
  const sample = ref("api_sample_json", "1");
  const shot = ref("jpeg", "2", 4_000);
  const pack = buildEvidencePack(input({ rawText: raw({ api: [{ scenarioId: "rank", samples: [sample], diff: "none", changedPaths: [] }], browser: [{ scenarioId: "login", strip: { before: [shot], after: [shot] }, consoleErrors: 0 }], checks: [{ checkId: "readiness:0", outputTail: "ok" }] }), storedArtifacts: stored(sample, shot) })).pack!;
  const task = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
  it("links each artifact to a Rovara route while it is available", () => {
    const view = evidenceViewOf(pack, task, available)!;
    expect(EvidenceViewSchema.safeParse(view).success).toBe(true);
    expect(view.api[0]?.samples[0]).toMatchObject({ state: "available", href: `/v1/app/tasks/${task}/evidence/${sample.sha256}` });
    expect(view.browser[0]?.strip.after[0]?.href).toBe(evidenceHref(task, shot));
    expect(view.checks[0]?.outputTailRef?.state).toBe("available");
  });
  it("shows an expired or withheld artifact with no link", () => {
    const view = evidenceViewOf(pack, task, (item) => (item.kind === "jpeg" ? "expired" : "withheld"))!;
    expect(view.browser[0]?.strip.after[0]).toMatchObject({ state: "expired" });
    expect(view.browser[0]?.strip.after[0]).not.toHaveProperty("href");
    expect(view.api[0]?.samples[0]).toMatchObject({ state: "withheld" });
    expect(view.api[0]?.samples[0]).not.toHaveProperty("href");
  });
  it("is undefined, not partial, for a task id that cannot make a route", () => {
    expect(evidenceViewOf(pack, "../../x?y=1", available)).toBeUndefined();
  });
});
