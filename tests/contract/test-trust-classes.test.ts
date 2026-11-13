// TE-A3: trust classes over the labels, the vendor_test backing, fake provenance, scripted-reply proof rules and per-test answer sources. Each case fails when the rule it names is removed (mutants are listed in the lane report).
import { describe, expect, it } from "vitest";
import {
  CI_USES_FAKES_WORDS, EVIDENCE_BACKING_KINDS, EVIDENCE_DEPENDENCY_LABELS, EVIDENCE_DEPENDENCY_LABEL_BACKING, EVIDENCE_DEPENDENCY_LABEL_TRUST, EVIDENCE_TRUST_CLASSES, EvidenceDependencySchema, EvidencePackV2Schema,
  SCRIPTED_REPLY_SOURCES, SCRIPTED_REPLY_SOURCE_WORDS, TEST_ENV_BACKING_KINDS, TEST_RESULT_STATES, TEST_RESULT_STATE_WORDS, TestAnswerRecordSchema, TestEnvDependencySchema, TestEnvWorkingBackingSchema, TestEnvFallbackSchema,
  checkCountsTowardProof, evidenceDependencyLabelFor, evidenceDependencyLabelWords, evidenceDependencyV1ToV2, scriptedRepliesCountTowardProof, testAnswerCountsTowardProof, testAnswerSummaryLines, testAnswerTrustClass,
  testCountsTowardProof, testEnvBackingTrustClass, testEnvDependencyApprovalRisk, testEnvDependencyLessSafeChanges, testEnvStartedCount, testResultState, testTrustClasses, trustClassCountsTowardProof, trustClassOf,
  type EvidenceDependency, type TestAnswerRecord,
} from "../../packages/contracts/src/index.js";

import { v2Pack } from "../support/evidence-v2-fixtures.js";

const sha = (letter: string) => letter.repeat(64);
const dependency = (backing: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  id: "payments", name: "Payments", kind: "http_api", family: "http:api.example-pay.com", found: ["model"], usedBy: ["integration"], backing,
  connect: { env: [], hostAliases: [] }, seeds: [], reset: "fresh_per_round", ...over,
});
const parses = (value: unknown) => TestEnvDependencySchema.safeParse(value).success;
const mockSet = { setId: "payments-mocks", version: 3, store: "rovara" } as const;

describe("every label maps to exactly one trust class", () => {
  it("has a class for each of the labels, and no other entry", () => {
    expect(Object.keys(EVIDENCE_DEPENDENCY_LABEL_TRUST).sort()).toEqual([...EVIDENCE_DEPENDENCY_LABELS].sort());
    for (const label of EVIDENCE_DEPENDENCY_LABELS) expect(EVIDENCE_TRUST_CLASSES, label).toContain(trustClassOf(label));
  });
  it("gives Real only to real software, a project image, a test account and a vendor test mode", () => {
    const real = EVIDENCE_DEPENDENCY_LABELS.filter((label) => trustClassOf(label) === "real").sort();
    expect(real).toEqual(["company_approved", "real", "real_project_image", "test_account", "vendor_test"].sort());
  });
  it("never lets a recording, an emulator, a fake, a scripted reply or a missing answer be Real", () => {
    for (const label of ["recorded_fake", "rovara_local_aws", "hand_written_fake", "rovara_made_fake", "faked_by_tests", "not_available"] as const) expect(trustClassOf(label), label).not.toBe("real");
    expect(trustClassOf("recorded_fake")).toBe("recorded");
  });
  it("puts an emulator and the customer's own fakes under Simulated, and Rovara's fakes under Made by Rovara", () => {
    expect(trustClassOf("rovara_local_aws")).toBe("simulated");
    expect(trustClassOf("hand_written_fake")).toBe("simulated");
    expect(trustClassOf("faked_by_tests")).toBe("simulated");
    expect(trustClassOf("rovara_made_fake")).toBe("made_by_rovara");
  });
  it("fails closed: a label this build does not know is the weakest class, never Real", () => {
    for (const label of ["quantum_real", "", "__proto__", "constructor", "toString", "REAL"]) expect(trustClassOf(label), label).toBe("simulated");
  });
  it("agrees with the backing the label belongs to", () => {
    expect(evidenceDependencyLabelFor({ backing: "vendor_test" })).toBe("vendor_test");
    expect(evidenceDependencyLabelFor({ backing: "fake", recorded: true })).toBe("recorded_fake");
    expect(evidenceDependencyLabelFor({ backing: "fake", recorded: false })).toBe("hand_written_fake");
    expect(evidenceDependencyLabelFor({ backing: "fake", recorded: false, madeByRovara: true })).toBe("rovara_made_fake");
    // a recording that Rovara made is Made by Rovara, the less trusted word.
    expect(evidenceDependencyLabelFor({ backing: "fake", recorded: true, madeByRovara: true })).toBe("rovara_made_fake");
    for (const label of EVIDENCE_DEPENDENCY_LABELS) expect(EVIDENCE_BACKING_KINDS).toContain(EVIDENCE_DEPENDENCY_LABEL_BACKING[label]);
  });
  it("keeps the evidence backing kinds equal to the contract's", () => {
    expect([...EVIDENCE_BACKING_KINDS]).toEqual([...TEST_ENV_BACKING_KINDS]);
  });
  it("says a Rovara-made fake's made-up answers like the other fakes, and names the vendor test mode", () => {
    expect(evidenceDependencyLabelWords("rovara_made_fake", "x", 2)).toContain("(+2 made-up answers)");
    expect(evidenceDependencyLabelWords("vendor_test", "x")).toBe("vendor test mode");
    expect(evidenceDependencyLabelWords("real", "x")).toBe("real");
  });
});

describe("a pack dependency row", () => {
  const row = (over: Record<string, unknown>) => ({ name: "Payments", backing: "fake", label: "recorded_fake", recordedAt: "2026-11-12T10:00:00.000Z", ...over });
  it("accepts a vendor test mode row and a Rovara-made fake row", () => {
    expect(EvidenceDependencySchema.safeParse({ name: "Payments", backing: "vendor_test", label: "vendor_test" }).success).toBe(true);
    expect(EvidenceDependencySchema.safeParse({ name: "Payments", backing: "fake", label: "rovara_made_fake", fixtureRevision: 2, madeUpAnswers: 4 }).success).toBe(true);
  });
  it("refuses a label that does not fit the backing that ran", () => {
    expect(EvidenceDependencySchema.safeParse({ name: "Payments", backing: "fake", label: "vendor_test" }).success).toBe(false);
    expect(EvidenceDependencySchema.safeParse({ name: "Payments", backing: "vendor_test", label: "real" }).success).toBe(false);
  });
  it("lets a fallback be a Rovara-made fake, and a vendor test mode be what it fell back from, but not the other way round", () => {
    expect(EvidenceDependencySchema.safeParse(row({ label: "rovara_made_fake", recordedAt: undefined, fellBack: { from: "vendor_test", reason: "did_not_start" } })).success).toBe(true);
    expect(EvidenceDependencySchema.safeParse({ name: "P", backing: "vendor_test", label: "vendor_test", fellBack: { from: "vendor_test", reason: "did_not_start" } }).success).toBe(false);
  });
});

describe("a v2 pack's dependency trust is the one its label earns (the writer's rule)", () => {
  const v2 = (dependencies: unknown[]) => v2Pack({ dependencies });
  const dep = (over: Record<string, unknown>) => ({ name: "Payments", kind: "http_api", backing: "fake", label: "recorded_fake", trust: "recorded", recordedOn: "2026-11-12", ...over });
  const accepted = (value: unknown) => EvidencePackV2Schema.safeParse(v2([value]));
  it("accepts every label with its own class", () => {
    for (const label of EVIDENCE_DEPENDENCY_LABELS) {
      const backing = EVIDENCE_DEPENDENCY_LABEL_BACKING[label];
      const result = accepted(dep({ label, backing, trust: trustClassOf(label), ...(trustClassOf(label) === "recorded" ? { recordedOn: "2026-11-12" } : {}) }));
      expect(result.success, `${label}: ${JSON.stringify(result.error?.issues)}`).toBe(true);
    }
  });
  it("refuses a recording written as Real, or any label written with a better class than it earns", () => {
    expect(accepted(dep({ trust: "real" })).success).toBe(false);
    expect(accepted(dep({ label: "rovara_made_fake", trust: "recorded" })).success).toBe(false);
    expect(accepted(dep({ label: "rovara_made_fake", trust: "simulated" })).success).toBe(false);
    expect(accepted(dep({ label: "rovara_local_aws", backing: "emulated", trust: "real" })).success).toBe(false);
    expect(accepted(dep({ label: "faked_by_tests", backing: "none", trust: "no_outside_calls" })).success).toBe(false);
  });
  it("refuses a label that does not belong to its backing", () => {
    expect(accepted(dep({ label: "real", backing: "fake", trust: "real" })).success).toBe(false);
  });
});

describe("old v1 dependency rows read with the new words", () => {
  const v1 = (over: Partial<EvidenceDependency> & { label: EvidenceDependency["label"]; backing: EvidenceDependency["backing"] }): EvidenceDependency => ({ name: "Payments", ...over });
  it("turns each v1 row into a v2 row whose class is the one its label earns, and the pack accepts it", () => {
    const rows: EvidenceDependency[] = [
      v1({ backing: "local", label: "real" }), v1({ backing: "project_image", label: "real_project_image" }), v1({ backing: "local", label: "company_approved", imageDigest: sha("d") }),
      v1({ backing: "emulated", label: "rovara_local_aws" }), v1({ backing: "test_account", label: "test_account" }), v1({ backing: "fake", label: "recorded_fake", recordedAt: "2026-11-12T10:00:00.000Z" }),
      v1({ backing: "fake", label: "hand_written_fake" }), v1({ backing: "none", label: "faked_by_tests" }), v1({ backing: "none", label: "not_available", testsNotRun: 2 }),
    ];
    const converted = rows.map((row) => evidenceDependencyV1ToV2(row));
    expect(converted.map((row) => row.trust)).toEqual(["real", "real", "real", "simulated", "real", "recorded", "simulated", "simulated", "simulated"]);
    expect(converted[5]).toMatchObject({ trust: "recorded", recordedOn: "2026-11-12" });
    for (const row of converted) expect(EvidencePackV2Schema.safeParse(v2Pack({ dependencies: [row] })).success, JSON.stringify(row)).toBe(true);
  });
  it("is Real for the old word 'real' only when real software ran", () => {
    expect(evidenceDependencyV1ToV2(v1({ backing: "fake", label: "recorded_fake" })).trust).not.toBe("real");
  });
});

describe("the vendor_test backing", () => {
  const vendor = { kind: "vendor_test", accountId: "payments-test" };
  it("is a backing with the test-account store's id, and nothing else", () => {
    expect(parses(dependency(vendor))).toBe(true);
    expect(parses(dependency({ ...vendor, extra: 1 }))).toBe(false);
    expect(parses(dependency({ kind: "vendor_test" }))).toBe(false);
    expect(parses(dependency({ ...vendor, accountId: "Not Valid" }))).toBe(false);
  });
  it("is never the coding agent's working backing and never a fallback (the key exists only in sealed rounds)", () => {
    expect(TestEnvWorkingBackingSchema.safeParse(vendor).success).toBe(false);
    expect(TestEnvFallbackSchema.safeParse(vendor).success).toBe(false);
    expect(parses(dependency({ kind: "fake", fixtureSetRef: sha("a"), unmatched: "fail" }, { workingBacking: vendor }))).toBe(false);
    expect(parses(dependency(vendor, { fallback: vendor }))).toBe(false);
  });
  it("cannot be reset between checks, because Rovara does not start it", () => {
    expect(parses(dependency(vendor, { reset: "between_checks" }))).toBe(false);
  });
  it("is a less-safe use that a second person approves, like a test account, and raises the approval risk", () => {
    const parsed = TestEnvDependencySchema.parse(dependency(vendor));
    expect(testEnvDependencyLessSafeChanges(undefined, [parsed])).toEqual(["test_account"]);
    expect(testEnvDependencyApprovalRisk([parsed])).toBe("high");
    const other = TestEnvDependencySchema.parse(dependency({ ...vendor, accountId: "other-test" }));
    expect(testEnvDependencyLessSafeChanges([parsed], [other])).toEqual(["test_account"]);
    expect(testEnvDependencyLessSafeChanges([parsed], [parsed])).toEqual([]);
  });
  it("counts toward the helpers a run starts like a test account (one shared proxy)", () => {
    const parsed = TestEnvDependencySchema.parse(dependency(vendor));
    const account = TestEnvDependencySchema.parse(dependency({ kind: "test_account", accountId: "payments-test" }, { id: "other", family: "http:api.example-other.com" }));
    expect(testEnvStartedCount([parsed])).toBe(1);
    expect(testEnvStartedCount([parsed, account])).toBe(1);
  });
});

describe("fake provenance", () => {
  const fake = (provenance?: Record<string, unknown>) => ({ kind: "fake", fixtureSetRef: sha("a"), unmatched: "fail", ...(provenance === undefined ? {} : { provenance }) });
  it("is optional, so every stored fake still parses", () => {
    expect(parses(dependency(fake()))).toBe(true);
  });
  it("takes customer, recorded with its date, and Rovara's setup and task mocks with their stored set", () => {
    expect(parses(dependency(fake({ origin: "customer" })))).toBe(true);
    expect(parses(dependency(fake({ origin: "customer", mockSet })))).toBe(true);
    expect(parses(dependency(fake({ origin: "recorded", recordedOn: "2026-11-12" })))).toBe(true);
    expect(parses(dependency(fake({ origin: "rovara_setup", mockSet })))).toBe(true);
    expect(parses(dependency(fake({ origin: "rovara_task", mockSet: { ...mockSet, store: "repo", path: ".rovara/mocks/payments" } })))).toBe(true);
  });
  it("refuses the combinations that would hide where an answer came from", () => {
    expect(parses(dependency(fake({ origin: "recorded" })))).toBe(false);
    expect(parses(dependency(fake({ origin: "recorded", recordedOn: "12 Nov" })))).toBe(false);
    expect(parses(dependency(fake({ origin: "customer", recordedOn: "2026-11-12" })))).toBe(false);
    expect(parses(dependency(fake({ origin: "rovara_setup" })))).toBe(false);
    expect(parses(dependency(fake({ origin: "rovara_task" })))).toBe(false);
    expect(parses(dependency(fake({ origin: "rovara_task", mockSet: { ...mockSet, store: "repo" } })))).toBe(false);
    expect(parses(dependency(fake({ origin: "rovara_task", mockSet: { ...mockSet, path: ".rovara/mocks/x" } })))).toBe(false);
    expect(parses(dependency(fake({ origin: "rovara_task", mockSet: { ...mockSet, store: "repo", path: "../escape" } })))).toBe(false);
    expect(parses(dependency(fake({ origin: "somebody" })))).toBe(false);
    expect(parses(dependency(fake({ origin: "customer", extra: 1 })))).toBe(false);
  });
  it("is only on a fake", () => {
    expect(parses(dependency({ kind: "none", reason: "declined", provenance: { origin: "customer" } }))).toBe(false);
  });
});

describe("the trust class of a backing", () => {
  const fake = (provenance?: Record<string, unknown>) => TestEnvDependencySchema.parse(dependency({ kind: "fake", fixtureSetRef: sha("a"), unmatched: "fail", ...(provenance === undefined ? {} : { provenance }) })).backing;
  const cls = (backing: Record<string, unknown>) => testEnvBackingTrustClass(TestEnvDependencySchema.parse(dependency(backing)).backing);
  it("is Real for software, an image, a test account and a vendor test mode", () => {
    expect(cls({ kind: "vendor_test", accountId: "payments-test" })).toBe("real");
    expect(cls({ kind: "test_account", accountId: "payments-test" })).toBe("real");
    expect(testEnvBackingTrustClass({ kind: "local", catalogId: "postgres@16", config: {} })).toBe("real");
    expect(testEnvBackingTrustClass({ kind: "project_image", imageId: "app-image" } as never)).toBe("real");
  });
  it("is Recorded only for a fake that says it is a recording, and never Real", () => {
    expect(testEnvBackingTrustClass(fake({ origin: "recorded", recordedOn: "2026-11-12" }))).toBe("recorded");
  });
  it("is Simulated for a customer's fake, an unlabelled fake, an emulator and a test that fakes it itself", () => {
    expect(testEnvBackingTrustClass(fake({ origin: "customer" }))).toBe("simulated");
    expect(testEnvBackingTrustClass(fake())).toBe("simulated");
    expect(testEnvBackingTrustClass({ kind: "emulated", catalogId: "local-aws@1", awsServices: ["s3"] } as never)).toBe("simulated");
    expect(testEnvBackingTrustClass({ kind: "none", reason: "faked_by_tests" })).toBe("simulated");
  });
  it("is Made by Rovara for Rovara's setup and task mocks", () => {
    expect(testEnvBackingTrustClass(fake({ origin: "rovara_setup", mockSet }))).toBe("made_by_rovara");
    expect(testEnvBackingTrustClass(fake({ origin: "rovara_task", mockSet }))).toBe("made_by_rovara");
  });
  it("is the same class the evidence label of the backing earns", () => {
    for (const [backing, label] of [
      [{ kind: "vendor_test", accountId: "payments-test" }, evidenceDependencyLabelFor({ backing: "vendor_test" })],
      [{ kind: "fake", fixtureSetRef: sha("a"), unmatched: "fail", provenance: { origin: "recorded", recordedOn: "2026-11-12" } }, evidenceDependencyLabelFor({ backing: "fake", recorded: true })],
      [{ kind: "fake", fixtureSetRef: sha("a"), unmatched: "fail", provenance: { origin: "rovara_task", mockSet } }, evidenceDependencyLabelFor({ backing: "fake", recorded: false, madeByRovara: true })],
      [{ kind: "fake", fixtureSetRef: sha("a"), unmatched: "fail", provenance: { origin: "customer" } }, evidenceDependencyLabelFor({ backing: "fake", recorded: false })],
    ] as const) expect(cls(backing), label).toBe(trustClassOf(label));
  });
});

describe("what counts toward the proof that a change works", () => {
  it("never counts a Made by Rovara answer, and counts the other classes", () => {
    expect(trustClassCountsTowardProof("made_by_rovara")).toBe(false);
    for (const trust of ["real", "recorded", "simulated", "no_outside_calls"] as const) expect(trustClassCountsTowardProof(trust), trust).toBe(true);
    expect(trustClassCountsTowardProof(undefined)).toBe(false);
    expect(trustClassCountsTowardProof("newer")).toBe(false);
  });
  it("counts scripted replies only from the project's set from before the task or from an independent agent (DECISIONS 161)", () => {
    expect([...SCRIPTED_REPLY_SOURCES]).toEqual(["project_set", "independent_agent", "coding_agent"]);
    expect(scriptedRepliesCountTowardProof("project_set")).toBe(true);
    expect(scriptedRepliesCountTowardProof("independent_agent")).toBe(true);
    expect(scriptedRepliesCountTowardProof("coding_agent")).toBe(false);
    expect(scriptedRepliesCountTowardProof(undefined)).toBe(false);
    expect(scriptedRepliesCountTowardProof("the_coding_agent_says_so")).toBe(false);
  });
  it("words each source, and the coding agent's replies say they are not counted", () => {
    expect(SCRIPTED_REPLY_SOURCE_WORDS.independent_agent).toBe("scripted replies written independently in this task");
    expect(SCRIPTED_REPLY_SOURCE_WORDS.coding_agent).toBe("scripted replies added in this task (not counted)");
    expect(SCRIPTED_REPLY_SOURCE_WORDS.project_set).toBe("scripted replies from before this task");
  });
  it("counts a check only when its kind proves, its class counts and (for scripted replies) the replies count", () => {
    expect(checkCountsTowardProof({ kind: "test" })).toBe(true);
    expect(checkCountsTowardProof({ kind: "test", trust: "real" })).toBe(true);
    expect(checkCountsTowardProof({ kind: "lint", trust: "real" })).toBe(false);
    expect(checkCountsTowardProof({ kind: "test", trust: "made_by_rovara" })).toBe(false);
    expect(checkCountsTowardProof({ kind: "eval", trust: "simulated", proofBasis: "scripted_ai_replies", scriptedReplies: "independent_agent" })).toBe(true);
    expect(checkCountsTowardProof({ kind: "eval", trust: "simulated", proofBasis: "scripted_ai_replies", scriptedReplies: "coding_agent" })).toBe(false);
    expect(checkCountsTowardProof({ kind: "eval", trust: "simulated", proofBasis: "scripted_ai_replies" })).toBe(false);
  });
  it("fails closed on a kind it does not know", () => {
    expect(checkCountsTowardProof({ kind: "hologram" })).toBe(false);
    expect(checkCountsTowardProof({ kind: "hologram", trust: "real" })).toBe(false);
  });
});

describe("the first line's words for a CI that runs on fakes", () => {
  it("are the owner's", () => {
    expect(CI_USES_FAKES_WORDS).toBe("real check: your CI (uses fakes)");
  });
});

describe("per-test answers from every source", () => {
  const passed = (testId: string, uses: TestAnswerRecord["uses"]): TestAnswerRecord => ({ testId, status: "passed", uses });
  const faked = { source: "faked", dependency: "payments" } as const;
  const recorded = { source: "recorded", dependency: "payments", recordedOn: "2026-11-12" } as const;
  const emulated = { source: "emulated", dependency: "s3" } as const;
  const rovara = { source: "made_by_rovara", dependency: "payments" } as const;
  const scripted = (repliesBy: "project_set" | "independent_agent" | "coding_agent") => ({ source: "scripted", dependency: "model", repliesBy }) as const;

  it("still reads every record a shipped worker writes", () => {
    for (const record of [passed("a", []), passed("a", [faked]), passed("a", [recorded]), { testId: "a", status: "not_run", uses: [], notRun: { dependency: "x", reason: "no_recording" } }]) expect(TestAnswerRecordSchema.safeParse(record).success).toBe(true);
  });
  it("accepts the new sources and refuses a scripted source with no author or an unknown one", () => {
    for (const use of [emulated, rovara, scripted("independent_agent")]) expect(TestAnswerRecordSchema.safeParse(passed("a", [use])).success).toBe(true);
    expect(TestAnswerRecordSchema.safeParse(passed("a", [{ source: "scripted", dependency: "model" } as never])).success).toBe(false);
    expect(TestAnswerRecordSchema.safeParse(passed("a", [{ source: "scripted", dependency: "model", repliesBy: "somebody" } as never])).success).toBe(false);
    expect(TestAnswerRecordSchema.safeParse(passed("a", [{ source: "real", dependency: "x" } as never])).success).toBe(false);
  });
  it("gives each source its own state, apart from 'passed'", () => {
    expect(testResultState(passed("a", [emulated]))).toBe("passed_emulated");
    expect(testResultState(passed("a", [rovara]))).toBe("passed_made_by_rovara");
    expect(testResultState(passed("a", [scripted("independent_agent")]))).toBe("passed_scripted");
    expect(testResultState(passed("a", []))).toBe("passed");
    for (const state of TEST_RESULT_STATES) expect(TEST_RESULT_STATE_WORDS[state].length).toBeGreaterThan(0);
    expect(new Set(Object.values(TEST_RESULT_STATE_WORDS)).size).toBe(TEST_RESULT_STATES.length);
  });
  it("names the least trusted answer: Made by Rovara, then scripted, then faked, then an emulator, then a recording", () => {
    expect(testResultState(passed("a", [recorded, emulated, faked, scripted("project_set"), rovara]))).toBe("passed_made_by_rovara");
    expect(testResultState(passed("a", [recorded, emulated, faked, scripted("project_set")]))).toBe("passed_scripted");
    expect(testResultState(passed("a", [recorded, emulated, faked]))).toBe("passed_faked");
    expect(testResultState(passed("a", [recorded, emulated]))).toBe("passed_emulated");
    expect(testResultState(passed("a", [recorded]))).toBe("passed_recorded");
  });
  it("maps each use to one trust class, and a recording to Recorded, never Real", () => {
    expect(testAnswerTrustClass(faked)).toBe("simulated");
    expect(testAnswerTrustClass(recorded)).toBe("recorded");
    expect(testAnswerTrustClass(emulated)).toBe("simulated");
    expect(testAnswerTrustClass(rovara)).toBe("made_by_rovara");
    expect(testAnswerTrustClass(scripted("independent_agent"))).toBe("simulated");
    expect(testAnswerTrustClass({ source: "real", dependency: "x" } as never)).toBe("simulated");
    expect(testTrustClasses(passed("a", [recorded, faked, recorded]))).toEqual(["recorded", "simulated"]);
    expect(testTrustClasses(passed("a", []))).toEqual([]);
  });
  it("counts a passing test toward the proof only when every answer behind it counts", () => {
    expect(testAnswerCountsTowardProof(faked)).toBe(true);
    expect(testAnswerCountsTowardProof(recorded)).toBe(true);
    expect(testAnswerCountsTowardProof(rovara)).toBe(false);
    expect(testAnswerCountsTowardProof(scripted("independent_agent"))).toBe(true);
    expect(testAnswerCountsTowardProof(scripted("coding_agent"))).toBe(false);
    expect(testAnswerCountsTowardProof({ source: "real", dependency: "x" } as never)).toBe(false);
    expect(testCountsTowardProof(passed("a", []))).toBe(true);
    expect(testCountsTowardProof(passed("a", [faked, recorded]))).toBe(true);
    expect(testCountsTowardProof(passed("a", [faked, rovara]))).toBe(false);
    expect(testCountsTowardProof(passed("a", [scripted("independent_agent"), scripted("coding_agent")]))).toBe(false);
    expect(testCountsTowardProof({ testId: "a", status: "failed", uses: [] })).toBe(false);
    expect(testCountsTowardProof({ testId: "a", status: "not_run", uses: [], notRun: { dependency: "x", reason: "no_recording" } })).toBe(false);
  });
  it("writes the pull request lines with fixed words, one per state, and never calls a scripted or made-up answer real", () => {
    const lines = testAnswerSummaryLines([passed("t1", [rovara]), passed("t2", [scripted("independent_agent")]), passed("t3", [scripted("coding_agent")]), passed("t4", [emulated]), passed("t5", [faked])], { service: "the payments API", realThing: "answer" });
    expect(lines).toEqual([
      "1 test passed against faked the payments API answers (not real answer): t5",
      "1 test passed against the payments API answers from Rovara local AWS (not real answer): t4",
      "1 test passed against scripted the payments API replies (scripted replies written independently in this task; not real answer): t2",
      "1 test passed against scripted the payments API replies (scripted replies added in this task (not counted); not real answer): t3",
      "1 test passed against answers Rovara made for the payments API (Made by Rovara, not counted toward the proof; not real answer): t1",
    ]);
  });
  it("keeps the shipped lines for faked and recorded answers word for word", () => {
    expect(testAnswerSummaryLines([passed("a", [faked]), passed("b", [recorded])], { service: "SageMaker", realThing: "model output" })).toEqual([
      "1 test passed against faked SageMaker answers (not real model output): a",
      "1 test passed against recorded SageMaker answers (recorded 2026-11-12; not real model output): b",
    ]);
  });
});
