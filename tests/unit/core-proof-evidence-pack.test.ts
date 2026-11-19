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
  it("binds to the candidate digest and the approved environment", () => {
    expect(built.pack).toMatchObject({ schemaVersion: 1, candidateDigest: DIGEST, environment: { tier: "sandbox", envRevision: 3 } });
    expect(EvidencePackSchema.safeParse(built.pack).success).toBe(true);
  });
  it("derives the selection from the tests that ran when the worker sent none, and lists mocked services as not tested", () => {
    expect(built.pack?.selection).toEqual({ method: "full", selected: 4, total: 4 });
    expect(built.pack?.notTested).toContainEqual({ kind: "mocked_service", id: "partner-scorer", text: "partner-scorer is mocked", reason: "answered from recorded responses" });
  });
});

describe("a check with no raw parts, or no raw file at all", () => {
  it("is still in the pack, with nothing measured and nothing claimed", () => {
    const built = buildEvidencePack(input({ rawText: undefined }));
    expect(built.problems).toEqual([]);
    expect(built.pack?.checks).toHaveLength(2);
    expect(built.pack?.checks.every((check) => check.tests === undefined && check.coverage === undefined)).toBe(true);
    expect(built.pack?.notTested.some((item) => item.kind === "environment")).toBe(false);
  });
  it("ignores a kind the broker does not know as `other`", () => {
    expect(buildEvidencePack(input({ checkKinds: undefined })).pack?.checks.map((check) => check.kind)).toEqual(["other", "other"]);
    expect(buildEvidencePack(input({ checkKinds: undefined, checks: [{ ...entry("a", "x"), kind: "build" }], rawText: undefined })).pack?.checks[0]?.kind).toBe("build");
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
  it("is unreadable when it is not JSON, does not fit its schema, or has an unknown field", () => {
    for (const rawText of ["not json", "[]", raw({ extra: 1 }), raw({ schemaVersion: 2 }), raw({ checks: [{ checkId: "readiness:0", tests: { ...tests(), total: 99 } }] })]) {
      const built = buildEvidencePack(input({ rawText }));
      expect(built.problems, rawText.slice(0, 40)).toEqual(["raw_unreadable"]);
      expect(built.pack?.checks[0]?.tests).toBeUndefined();
    }
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
  it("keeps a valid test id exactly as it is (NH-1 re-check F2/F5): spaces inside it, double spaces, and up to 500 characters; nothing is cut or collapsed", () => {
    const long = `tests/${"d".repeat(480)}.py::t`;
    const names = ["src/cart.test.ts::cart adds  two items", long, "tests/test_cart.py::test_label[a b]"];
    const built = withTests({ total: 4, passed: 1, failed: 3, skipped: 0, names: names.map((name) => ({ name, status: "failed" })), newTests: names }, [entry("readiness:0", "pytest", { after: "failed", class: "regression", exitCode: 1 })]);
    expect(built.pack?.checks[0]?.tests?.names.map((name) => name.name)).toEqual(names);
    expect(built.pack?.checks[0]?.tests?.names.some((name) => name.unlisted === true)).toBe(false);
    expect(built.pack?.checks[0]?.tests?.newTests).toEqual(names);
  });
  it("shows a name that is not a valid id as one plain line and marks it unlisted, never as the id of another test: a look-alike character, a space at an end, or the worker's own mark", () => {
    const odd = ["tests/a.py::t\u3164x", "tests/a.py::trailing ", "tests/a.py::fine"];
    const built = withTests({ total: 4, passed: 1, failed: 3, skipped: 0, names: odd.map((name) => ({ name, status: "failed", ...(name.endsWith("fine") ? { unlisted: true } : {}) })), newTests: [] }, [entry("readiness:0", "pytest", { after: "failed", class: "regression", exitCode: 1 })]);
    const names = built.pack?.checks[0]?.tests?.names ?? [];
    expect(names.every((name) => name.unlisted === true)).toBe(true);
    expect(names.map((name) => name.name)).toEqual(["tests/a.py::t\u3164x", "tests/a.py::trailing", "tests/a.py::fine"]);
    expect(EvidencePackSchema.safeParse(built.pack).success).toBe(true);
  });
  it("drops tests that show a failure under a check that passed", () => {
    const built = withTests({ total: 4, passed: 2, failed: 1, skipped: 1 });
    expect(built.problems).toEqual(["tests_disagree_with_check"]);
    expect(built.pack?.checks[0]?.tests).toBeUndefined();
  });
  it("keeps failing tests under a check that failed", () => {
    const built = withTests({ total: 4, passed: 2, failed: 1, skipped: 1, names: [{ name: "test_x", status: "failed" }] }, [entry("readiness:0", "pytest", { after: "failed", class: "regression", exitCode: 1 })]);
    expect(built.problems).toEqual([]);
    expect(built.pack?.checks[0]?.tests?.failed).toBe(1);
  });
  it("drops counts that show no failing test under a check that failed: a stale or partial report must not read as clean", () => {
    const built = withTests({}, [entry("readiness:0", "pytest", { after: "failed", class: "regression", exitCode: 1 })]);
    expect(built.problems).toEqual(["tests_disagree_with_check"]);
    expect(built.pack?.checks[0]?.tests).toBeUndefined();
    expect(built.pack?.checks[0]?.after).toBe("failed");
  });
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
  it("names a rise in skips among untouched tests as not tested", () => {
    const built = withTests({ skipped: 1, skippedBefore: 0, skippedAfter: 1 });
    expect(built.pack?.notTested).toContainEqual({ kind: "check", id: "readiness:0", text: "pytest", reason: "more tests skipped than before" });
    expect(withTests({ skipped: 1, skippedBefore: 1, skippedAfter: 1 }).pack?.notTested.some((item) => item.kind === "check")).toBe(false);
  });
});

describe("selection", () => {
  it("says what was not run when the worker selected a part of the tests", () => {
    const selection = { method: "coverage_map", selected: 37, total: 1240, mapAgeHours: 14 };
    const built = buildEvidencePack(input({ rawText: raw({ selection }) }));
    expect(built.pack?.selection).toEqual(selection);
    expect(built.pack?.notTested).toContainEqual({ kind: "not_selected", id: "selection", text: "1203 of 1240 tests were not run", reason: "not selected (coverage map)" });
  });
  it("says the selection was not reported, instead of implying a full run, when a test check ran and the worker sent none", () => {
    const built = buildEvidencePack(input());
    expect(built.pack?.notTested).toContainEqual({ kind: "not_selected", id: "selection", text: "Which tests ran was not reported", reason: "selection not reported" });
    expect(buildEvidencePack(input({ checks: [entry("readiness:1", "ruff")], rawText: undefined })).pack?.notTested.some((item) => item.kind === "not_selected")).toBe(false);
  });
  it("drops a selection that claims fewer tests than the reports measured", () => {
    const built = buildEvidencePack(input({ rawText: raw({ selection: { method: "coverage_map", selected: 2, total: 1240 } }) }));
    expect(built.problems).toEqual(["selection_inconsistent"]);
    expect(built.pack?.selection).toEqual({ method: "full", selected: 4, total: 4 });
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
  it("keeps references the store really holds, and nothing else", () => {
    const built = build({ media: ALL_OK });
    expect(built.problems).toEqual([]);
    expect(built.pack?.api[0]?.samples).toEqual([sample]);
    expect(built.pack?.browser[0]).toMatchObject({ strip: { before: [shot], after: [shot] }, video, trace });
  });
  it("drops a reference the store does not hold, holds under another kind, or holds at another size", () => {
    const missing = build({ storedArtifacts: new Map() });
    expect(missing.problems).toContain("artifact_missing");
    expect(missing.pack?.api[0]?.samples).toEqual([]);
    expect(missing.pack?.browser[0]?.strip).toEqual({ before: [], after: [] });
    const wrongKind = build({ storedArtifacts: new Map([[sample.sha256, { kind: "log_txt" as const, bytes: sample.bytes }], [shot.sha256, { kind: "jpeg" as const, bytes: shot.bytes }]]) });
    expect(wrongKind.pack?.api[0]?.samples).toEqual([]);
    const wrongSize = build({ storedArtifacts: new Map([[sample.sha256, { kind: "api_sample_json" as const, bytes: sample.bytes + 1 }]]) });
    expect(wrongSize.pack?.api[0]?.samples).toEqual([]);
  });
  it("withholds a video and a trace unless the setting and the gate allow them, and says why", () => {
    const built = build();
    expect(built.problems).toContain("media_not_allowed");
    expect(built.pack?.browser[0]?.video).toBeUndefined();
    expect(built.pack?.browser[0]?.trace).toBeUndefined();
    expect(built.pack?.browser[0]?.withheld).toEqual([{ artifact: "video", reason: "tier_not_allowed" }, { artifact: "trace", reason: "tier_not_allowed" }]);
    expect(built.pack?.browser[0]?.strip.after).toEqual([shot]);
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
  it("allows the video and withholds the trace when only the video is allowed", () => {
    const built = build({ media: { ...ALL_OK, companyAllows: { video: true, trace: false } } });
    expect(built.pack?.browser[0]).toMatchObject({ video, withheld: [{ artifact: "trace", reason: "company_setting_off" }] });
  });
  it("withholds both when any account is a long-lived registered one, even if the setting allows them", () => {
    const built = build({ media: ALL_OK, environment: environment({ accounts: [{ profileId: "old", kind: "registered" }] }) });
    expect(built.pack?.browser[0]?.video).toBeUndefined();
    expect(built.pack?.browser[0]?.withheld).toEqual([{ artifact: "video", reason: "account_not_run_scoped" }, { artifact: "trace", reason: "account_not_run_scoped" }]);
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

describe("a pack that does not fit its schema", () => {
  it("is undefined, never partial", () => {
    const built = buildEvidencePack(input({ environment: environment({ services: [environment().services[0]!, environment().services[0]!] }) }));
    expect(built.pack).toBeUndefined();
    expect(built.problems).toContain("pack_invalid");
    expect(built.newArtifacts).toEqual([]);
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
