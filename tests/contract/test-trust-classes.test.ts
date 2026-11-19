// TE-A3: trust classes over the labels, the vendor_test backing, fake provenance, scripted-reply proof rules and per-test answer sources. Each case fails when the rule it names is removed (mutants are listed in the lane report).
import { describe, expect, it } from "vitest";
import {
  CI_USES_FAKES_WORDS, EVIDENCE_BACKING_KINDS, EVIDENCE_DEPENDENCY_LABELS, EVIDENCE_DEPENDENCY_LABEL_BACKING, EVIDENCE_DEPENDENCY_LABEL_TRUST, EVIDENCE_TRUST_CLASSES, EvidenceDependencySchema, readEvidencePack, renderEvidence, EvidencePackV2Schema,
  REPLY_PROVENANCES, REPLY_PROVENANCE_LABELS, AGENT_REPLIES_UNCONFIRMED_WORDS, TEST_ENV_BACKING_KINDS, TEST_RESULT_STATES, TEST_RESULT_STATE_WORDS, TestAnswerRecordSchema, TestEnvDependencySchema, TestEnvWorkingBackingSchema, TestEnvFallbackSchema,
  CHANGE_PROOF_LABELS, CHANGE_PROOF_LABEL_WORDS, EVAL_NOT_QUALIFIED_REASONS, EVAL_NOT_QUALIFIED_REASON_WORDS, changeProofLabelCountsAsProven, changeProofLabelFailsCheck, changeProofLabelQualified, evalProofLabel, evidenceDependencyTrustClass, checkCountsTowardProof, checkKindInfo, evidenceDependencyLabelFor, evidenceDependencyLabelWords, evidenceDependencyV1ToV2, scriptedRepliesCountTowardProof, testAnswerCountsTowardProof, testAnswerSummaryLines, testAnswerTrustClass,
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
      const result = accepted(dep({ label, backing, trust: trustClassOf(label), recordedOn: trustClassOf(label) === "recorded" ? "2026-11-12" : undefined, ...(label === "rovara_made_fake" ? { mock: { setId: "m1", version: 1, branch: "main", madeIn: "setup", store: "rovara" } } : {}) }));
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
    // recordedOn left out, so only the label-belongs-to-backing rule can refuse these (review 2 M3)
    expect(accepted(dep({ label: "real", backing: "fake", trust: "real", recordedOn: undefined })).success).toBe(false);
    expect(accepted(dep({ label: "vendor_test", backing: "fake", trust: "real", recordedOn: undefined })).success).toBe(false);
    expect(accepted(dep({ label: "real", backing: "local", trust: "real", recordedOn: undefined })).success).toBe(true);
  });
  it("lets a fake that made up answers be written as Made by Rovara (a weaker class, never a better one)", () => {
    expect(accepted(dep({ trust: "made_by_rovara", recordedOn: undefined })).success).toBe(true);
    expect(accepted(dep({ label: "hand_written_fake", trust: "made_by_rovara", recordedOn: undefined })).success).toBe(true);
    // only a fake makes up answers: real software, an emulator or nothing never takes the class this way
    expect(accepted(dep({ label: "real", backing: "local", trust: "made_by_rovara", recordedOn: undefined })).success).toBe(false);
    expect(accepted(dep({ label: "rovara_local_aws", backing: "emulated", trust: "made_by_rovara", recordedOn: undefined })).success).toBe(false);
    expect(accepted(dep({ label: "hand_written_fake", trust: "recorded" })).success).toBe(false);
  });
  const mock = { setId: "payments-mocks", version: 2, branch: "main", madeIn: "this_task", store: "rovara" };
  const made = (over: Record<string, unknown> = {}) => dep({ label: "rovara_made_fake", trust: "made_by_rovara", recordedOn: undefined, mock, ...over });
  it("requires a Rovara-made fake to name its stored mock set, and allows a mock on no other label (review M2)", () => {
    expect(accepted(made()).success).toBe(true);
    expect(accepted(made({ mock: undefined })).success).toBe(false);
    expect(accepted(dep({ mock: mock })).success).toBe(false);
    expect(accepted(dep({ label: "real", backing: "local", trust: "real", recordedOn: undefined, mock: mock })).success).toBe(false);
    expect(accepted(dep({ label: "hand_written_fake", trust: "simulated", recordedOn: undefined, mock: mock })).success).toBe(false);
  });
  it("allows a recording or a recorded day only on a Recorded answer (review M2)", () => {
    expect(accepted(dep({ recordedOn: undefined, recording: { store: "rovara", recordedOn: "2026-11-12" } })).success).toBe(true);
    expect(accepted(made({ recordedOn: "2026-11-12" })).success).toBe(false);
    expect(accepted(made({ recording: { store: "rovara", recordedOn: "2026-11-12" } })).success).toBe(false);
    expect(accepted(dep({ label: "real", backing: "local", trust: "real", recordedOn: "2026-11-12" })).success).toBe(false);
    expect(accepted(dep({ label: "hand_written_fake", trust: "simulated", recordedOn: undefined, recording: { store: "rovara", recordedOn: "2026-11-12" } })).success).toBe(false);
  });
  it("still reads a pack with those fields on any label (readers are tolerant; only the writer refuses)", () => {
    const odd = v2Pack({ dependencies: [dep({ label: "real", backing: "local", trust: "real", recordedOn: "2026-11-12", mock: mock })] });
    expect(readEvidencePack(odd).status).toBe("v2");
    // and an old pack whose dependencies carry no mock or recording at all still passes the writer's rules
    expect(EvidencePackV2Schema.safeParse(v2Pack()).success).toBe(true);
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
  it("makes a fake row with any made-up answers Made by Rovara, whatever else it was, with no recording day (DECISIONS 169, rework b)", () => {
    for (const label of ["recorded_fake", "hand_written_fake", "rovara_made_fake"] as const) {
      const row = evidenceDependencyV1ToV2(v1({ backing: "fake", label, recordedAt: "2026-11-12T10:00:00.000Z", madeUpAnswers: 1 }));
      expect(row.trust, label).toBe("made_by_rovara");
      expect(row.recordedOn, label).toBeUndefined();
      expect(trustClassCountsTowardProof(row.trust), label).toBe(false);
    }
    // no made-up answers: the class its label earns, exactly as before
    expect(evidenceDependencyV1ToV2(v1({ backing: "fake", label: "recorded_fake", recordedAt: "2026-11-12T10:00:00.000Z", madeUpAnswers: 0 })).trust).toBe("recorded");
    expect(evidenceDependencyV1ToV2(v1({ backing: "fake", label: "hand_written_fake" })).trust).toBe("simulated");
  });
  it("reads a made-up count that is not a whole number as unknown, so Made by Rovara, never a better class (review 2 L6)", () => {
    expect(evidenceDependencyTrustClass({ label: "recorded_fake", madeUpAnswers: 3 })).toBe("made_by_rovara");
    expect(evidenceDependencyTrustClass({ label: "recorded_fake" })).toBe("recorded");
    for (const odd of ["3", "0", -1, 1.5, Number.NaN, null]) expect(evidenceDependencyTrustClass({ label: "recorded_fake", madeUpAnswers: odd as never }), String(odd)).toBe("made_by_rovara");
    expect(evidenceDependencyTrustClass({ label: "a_newer_label", madeUpAnswers: 0 })).toBe("simulated");
    expect(evidenceDependencyTrustClass({ label: "a_newer_label", madeUpAnswers: 2 })).toBe("made_by_rovara");
  });
  it("treats a fake that may make up answers, whose count was not read, as Made by Rovara (review 2 M2)", () => {
    // no ledger read: no usage, so the made-up count is unknown
    expect(evidenceDependencyTrustClass({ label: "recorded_fake" }, { makesUpAnswers: true })).toBe("made_by_rovara");
    expect(evidenceDependencyTrustClass({ label: "hand_written_fake" }, { makesUpAnswers: true })).toBe("made_by_rovara");
    // the ledger was read and counted none made up: the label's own class
    expect(evidenceDependencyTrustClass({ label: "recorded_fake", usage: { requests: 4, unmatched: 0, faults: 0 } }, { makesUpAnswers: true })).toBe("recorded");
    expect(evidenceDependencyTrustClass({ label: "recorded_fake", usage: { requests: 4, unmatched: 0, faults: 0 }, madeUpAnswers: 1 }, { makesUpAnswers: true })).toBe("made_by_rovara");
    // a fake that never makes up answers, or one whose setting is not known (old callers): as before
    expect(evidenceDependencyTrustClass({ label: "recorded_fake" }, { makesUpAnswers: false })).toBe("recorded");
    expect(evidenceDependencyTrustClass({ label: "recorded_fake" })).toBe("recorded");
    // only a fake: other labels are unaffected
    expect(evidenceDependencyTrustClass({ label: "real" }, { makesUpAnswers: true })).toBe("real");
    const row = evidenceDependencyV1ToV2({ name: "Payments", backing: "fake", label: "recorded_fake", recordedAt: "2026-11-12T10:00:00.000Z" }, "http_api", { makesUpAnswers: true });
    expect(row).toMatchObject({ trust: "made_by_rovara" });
    expect(row.recordedOn).toBeUndefined();
    expect(EvidencePackV2Schema.safeParse(v2Pack({ dependencies: [row] })).success).toBe(true);
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
  const recordedSet = { origin: "recorded", recordedAt: "2026-11-12T10:00:00.000Z" } as const;
  it("is Recorded only when the fixture store says the set is a recording with its day, and never Real (review L1)", () => {
    expect(testEnvBackingTrustClass(fake(), recordedSet)).toBe("recorded");
    expect(testEnvBackingTrustClass(fake({ origin: "customer" }), recordedSet)).toBe("recorded");
    expect(testEnvBackingTrustClass(fake({ origin: "recorded", recordedOn: "2026-11-12" }), recordedSet)).toBe("recorded");
  });
  it("never takes 'recorded' from the plan's own word: the store decides, and the plan can only make it weaker (review L1)", () => {
    expect(testEnvBackingTrustClass(fake({ origin: "recorded", recordedOn: "2026-11-12" }))).toBe("simulated");
    expect(testEnvBackingTrustClass(fake({ origin: "recorded", recordedOn: "2026-11-12" }), { origin: "hand_written" })).toBe("simulated");
    expect(testEnvBackingTrustClass(fake(), { origin: "recorded" })).toBe("simulated");
    expect(testEnvBackingTrustClass(fake(), { origin: "Recorded", recordedAt: "2026-11-12T10:00:00.000Z" })).toBe("simulated");
    expect(testEnvBackingTrustClass(fake({ origin: "rovara_task", mockSet }), recordedSet)).toBe("made_by_rovara");
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
      [{ kind: "fake", fixtureSetRef: sha("a"), unmatched: "fail", provenance: { origin: "rovara_task", mockSet } }, evidenceDependencyLabelFor({ backing: "fake", recorded: false, madeByRovara: true })],
      [{ kind: "fake", fixtureSetRef: sha("a"), unmatched: "fail", provenance: { origin: "customer" } }, evidenceDependencyLabelFor({ backing: "fake", recorded: false })],
    ] as const) expect(cls(backing), label).toBe(trustClassOf(label));
    // a recorded set: the store says so, as the evidence's own label does (the broker test checks pinnedFakeOf against this for every combination)
    expect(testEnvBackingTrustClass(fake(), recordedSet)).toBe(trustClassOf(evidenceDependencyLabelFor({ backing: "fake", recorded: true })));
  });
});

describe("what counts toward the proof that a change works", () => {
  it("never counts a Made by Rovara answer, and counts the other classes", () => {
    expect(trustClassCountsTowardProof("made_by_rovara")).toBe(false);
    for (const trust of ["real", "recorded", "simulated", "no_outside_calls"] as const) expect(trustClassCountsTowardProof(trust), trust).toBe(true);
    expect(trustClassCountsTowardProof(undefined)).toBe(false);
    expect(trustClassCountsTowardProof("newer")).toBe(false);
  });
  it("counts scripted replies by the Proof table's one rule (DECISIONS 192a): before the task counts, replies written in this task only when the real model agreed, and independent replies (parked by 192a) never", () => {
    expect([...REPLY_PROVENANCES]).toEqual(["before_task", "independent", "task_made"]);
    expect(scriptedRepliesCountTowardProof("before_task")).toBe(true);
    expect(scriptedRepliesCountTowardProof("independent")).toBe(false);
    for (const realModel of [undefined, "confirmed", "unconfirmed", "disagreed"]) expect(scriptedRepliesCountTowardProof("independent", realModel), String(realModel)).toBe(false);
    expect(scriptedRepliesCountTowardProof("task_made")).toBe(false);
    expect(scriptedRepliesCountTowardProof("task_made", "confirmed")).toBe(true);
    expect(scriptedRepliesCountTowardProof("task_made", "unconfirmed")).toBe(false);
    expect(scriptedRepliesCountTowardProof("task_made", "disagreed")).toBe(false);
    expect(scriptedRepliesCountTowardProof("task_made", "Confirmed")).toBe(false);
    // a value this build does not know never counts, even with a confirmed real-model run
    for (const value of [undefined, "project_set", "independent_agent", "coding_agent", "failure_pack", "unmatched", "not_served", "__proto__", 1]) expect(scriptedRepliesCountTowardProof(value, "confirmed"), String(value)).toBe(false);
  });
  it("uses one vocabulary: the reply-set provenance words, and none of the superseded ones", () => {
    expect(REPLY_PROVENANCE_LABELS.task_made).toBe("scripted replies written in this task");
    for (const words of Object.values(REPLY_PROVENANCE_LABELS).filter((_, index) => index < 3)) expect(words).not.toContain("not counted");
    expect(AGENT_REPLIES_UNCONFIRMED_WORDS).toBe("proven with scripted replies written in this task: check them");
  });
  it("counts a check only when its kind proves, its class counts and (for scripted replies) the replies count", () => {
    expect(checkCountsTowardProof({ kind: "test" })).toBe(true);
    expect(checkCountsTowardProof({ kind: "test", trust: "real" })).toBe(true);
    expect(checkCountsTowardProof({ kind: "lint", trust: "real" })).toBe(false);
    expect(checkCountsTowardProof({ kind: "test", trust: "made_by_rovara" })).toBe(false);
    expect(checkCountsTowardProof({ kind: "test", trust: "simulated", proofBasis: "scripted_ai_replies", replies: "independent" })).toBe(false);
    expect(checkCountsTowardProof({ kind: "test", trust: "simulated", proofBasis: "scripted_ai_replies", replies: "before_task" })).toBe(true);
    expect(checkCountsTowardProof({ kind: "test", trust: "simulated", proofBasis: "scripted_ai_replies", replies: "task_made" })).toBe(false);
    expect(checkCountsTowardProof({ kind: "test", trust: "simulated", proofBasis: "scripted_ai_replies", replies: "task_made", realModel: "confirmed" })).toBe(true);
    // a proof with scripted replies and no stated provenance reads as the Proof table reads it today: proven with scripted AI replies
    expect(checkCountsTowardProof({ kind: "test", trust: "simulated", proofBasis: "scripted_ai_replies" })).toBe(true);
  });
  it("gives a reply case the same answer as the Proof table: task_made counts only when confirmed, whatever the proof basis says (review M1)", () => {
    expect(checkCountsTowardProof({ kind: "test", trust: "simulated", replies: "task_made" })).toBe(false);
    expect(checkCountsTowardProof({ kind: "test", replies: "task_made", realModel: "unconfirmed" })).toBe(false);
    expect(checkCountsTowardProof({ kind: "test", replies: "task_made", realModel: "disagreed" })).toBe(false);
    expect(checkCountsTowardProof({ kind: "test", replies: "task_made", realModel: "confirmed" })).toBe(true);
    expect(checkCountsTowardProof({ kind: "test", replies: "somebody_else", realModel: "confirmed" })).toBe(false);
    expect(checkCountsTowardProof({ kind: "test", replies: "independent" })).toBe(false);
    expect(checkCountsTowardProof({ kind: "test", replies: "independent", realModel: "confirmed" })).toBe(false);
    expect(checkCountsTowardProof({ kind: "test", replies: "before_task", realModel: "disagreed" })).toBe(true);
    expect(checkCountsTowardProof({ kind: "test", proofBasis: "something_newer", replies: "before_task" })).toBe(false);
  });
  it("never counts an eval as 'Proven': it has its own labels (DECISIONS 170)", () => {
    expect(checkKindInfo("eval")?.countsTowardProof).toBe(false);
    expect(checkCountsTowardProof({ kind: "eval" })).toBe(false);
    expect(checkCountsTowardProof({ kind: "eval", trust: "simulated", proofBasis: "scripted_ai_replies", replies: "independent" })).toBe(false);
    expect(checkCountsTowardProof({ kind: "eval", trust: "real" })).toBe(false);
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
  const scripted = (provenance: "before_task" | "independent" | "task_made") => ({ source: "scripted", dependency: "model", provenance }) as const;

  it("still reads every record a shipped worker writes", () => {
    for (const record of [passed("a", []), passed("a", [faked]), passed("a", [recorded]), { testId: "a", status: "not_run", uses: [], notRun: { dependency: "x", reason: "no_recording" } }]) expect(TestAnswerRecordSchema.safeParse(record).success).toBe(true);
  });
  it("accepts the new sources and refuses a scripted source with no author or an unknown one", () => {
    for (const use of [emulated, rovara, scripted("independent")]) expect(TestAnswerRecordSchema.safeParse(passed("a", [use])).success).toBe(true);
    expect(TestAnswerRecordSchema.safeParse(passed("a", [{ source: "scripted", dependency: "model" } as never])).success).toBe(false);
    expect(TestAnswerRecordSchema.safeParse(passed("a", [{ source: "scripted", dependency: "model", provenance: "somebody" } as never])).success).toBe(false);
    // the superseded words are refused, not read as a provenance
    expect(TestAnswerRecordSchema.safeParse(passed("a", [{ source: "scripted", dependency: "model", repliesBy: "independent_agent" } as never])).success).toBe(false);
    expect(TestAnswerRecordSchema.safeParse(passed("a", [{ source: "scripted", dependency: "model", provenance: "independent_agent" } as never])).success).toBe(false);
    expect(TestAnswerRecordSchema.safeParse(passed("a", [{ source: "real", dependency: "x" } as never])).success).toBe(false);
  });
  it("gives each source its own state, apart from 'passed'", () => {
    expect(testResultState(passed("a", [emulated]))).toBe("passed_emulated");
    expect(testResultState(passed("a", [rovara]))).toBe("passed_made_by_rovara");
    expect(testResultState(passed("a", [scripted("independent")]))).toBe("passed_scripted");
    expect(testResultState(passed("a", []))).toBe("passed");
    for (const state of TEST_RESULT_STATES) expect(TEST_RESULT_STATE_WORDS[state].length).toBeGreaterThan(0);
    expect(new Set(Object.values(TEST_RESULT_STATE_WORDS)).size).toBe(TEST_RESULT_STATES.length);
  });
  it("names the least trusted answer: Made by Rovara, then scripted, then faked, then an emulator, then a recording", () => {
    expect(testResultState(passed("a", [recorded, emulated, faked, scripted("before_task"), rovara]))).toBe("passed_made_by_rovara");
    expect(testResultState(passed("a", [recorded, emulated, faked, scripted("before_task")]))).toBe("passed_scripted");
    expect(testResultState(passed("a", [recorded, emulated, faked]))).toBe("passed_faked");
    expect(testResultState(passed("a", [recorded, emulated]))).toBe("passed_emulated");
    expect(testResultState(passed("a", [recorded]))).toBe("passed_recorded");
  });
  it("maps each use to one trust class, and a recording to Recorded, never Real", () => {
    // a faked answer may have been made up, so its class is Made by Rovara (review 2 M1)
    expect(testAnswerTrustClass(faked)).toBe("made_by_rovara");
    expect(testAnswerTrustClass(recorded)).toBe("recorded");
    expect(testAnswerTrustClass(emulated)).toBe("simulated");
    expect(testAnswerTrustClass(rovara)).toBe("made_by_rovara");
    expect(testAnswerTrustClass(scripted("independent"))).toBe("simulated");
    expect(testAnswerTrustClass({ source: "real", dependency: "x" } as never)).toBe("simulated");
    expect(testTrustClasses(passed("a", [recorded, faked, recorded]))).toEqual(["recorded", "made_by_rovara"]);
    expect(testTrustClasses(passed("a", [recorded, emulated, recorded]))).toEqual(["recorded", "simulated"]);
    expect(testTrustClasses(passed("a", []))).toEqual([]);
  });
  it("counts a passing test toward the proof only when every answer behind it counts", () => {
    expect(testAnswerCountsTowardProof(recorded)).toBe(true);
    expect(testAnswerCountsTowardProof(emulated)).toBe(true);
    expect(testAnswerCountsTowardProof(rovara)).toBe(false);
    expect(testAnswerCountsTowardProof(scripted("independent"))).toBe(false);
    expect(testAnswerCountsTowardProof(scripted("independent"), "confirmed")).toBe(false);
    expect(testAnswerCountsTowardProof(scripted("before_task"))).toBe(true);
    expect(testAnswerCountsTowardProof(scripted("task_made"))).toBe(false);
    expect(testAnswerCountsTowardProof(scripted("task_made"), "confirmed")).toBe(true);
    expect(testAnswerCountsTowardProof(scripted("task_made"), "disagreed")).toBe(false);
    expect(testAnswerCountsTowardProof({ source: "real", dependency: "x" } as never)).toBe(false);
    expect(testCountsTowardProof(passed("a", []))).toBe(true);
    expect(testCountsTowardProof(passed("a", [recorded, emulated]))).toBe(true);
    expect(testCountsTowardProof(passed("a", [recorded, rovara]))).toBe(false);
    expect(testCountsTowardProof(passed("a", [scripted("before_task"), scripted("task_made")]))).toBe(false);
    expect(testCountsTowardProof(passed("a", [scripted("before_task"), scripted("task_made")]), "confirmed")).toBe(true);
    // one independent reply keeps a test out of the proof, even with the real model's agreement
    expect(testCountsTowardProof(passed("a", [scripted("independent"), scripted("task_made")]), "confirmed")).toBe(false);
    expect(testCountsTowardProof({ testId: "a", status: "failed", uses: [] })).toBe(false);
    expect(testCountsTowardProof({ testId: "a", status: "not_run", uses: [], notRun: { dependency: "x", reason: "no_recording" } })).toBe(false);
  });
  it("gives every source a class whose counting agrees with the answer's own counting (review 2 M1)", () => {
    const uses: TestAnswerRecord["uses"] = [faked, recorded, emulated, rovara, scripted("before_task"), scripted("independent"), scripted("task_made")];
    for (const use of uses) {
      const classCounts = trustClassCountsTowardProof(testAnswerTrustClass(use));
      // an answer that counts always has a counting class
      for (const realModel of [undefined, "confirmed", "unconfirmed", "disagreed"]) if (testAnswerCountsTowardProof(use, realModel)) expect(classCounts, JSON.stringify(use)).toBe(true);
      // and for every source but scripted replies (whose counting also needs the real-model result), the two are equal
      if (use.source !== "scripted") expect(classCounts, JSON.stringify(use)).toBe(testAnswerCountsTowardProof(use));
    }
    // and every scripted provenance a class can stand for counts once the real model agreed, except `independent`, which is parked (192a) and never counts whatever the real model says (its class stays Simulated)
    for (const provenance of REPLY_PROVENANCES) expect(testAnswerCountsTowardProof(scripted(provenance), "confirmed"), provenance).toBe(provenance !== "independent" && trustClassCountsTowardProof(testAnswerTrustClass(scripted(provenance))));
  });
  it("never counts a faked answer: the record cannot tell a hand-written answer from one the fake made up (DECISIONS 169, rework b)", () => {
    expect(testAnswerCountsTowardProof(faked)).toBe(false);
    expect(testCountsTowardProof(passed("a", [faked]))).toBe(false);
    expect(testCountsTowardProof(passed("a", [recorded, faked]))).toBe(false);
    // one made-up answer (written as made_by_rovara) keeps a test out of the proof whatever else answered it
    expect(testCountsTowardProof(passed("a", [recorded, emulated, rovara]))).toBe(false);
  });
  it("writes the pull request lines with fixed words, one per state, and never calls a scripted or made-up answer real", () => {
    const lines = testAnswerSummaryLines([passed("t1", [rovara]), passed("t2", [scripted("independent")]), passed("t3", [scripted("task_made")]), passed("t4", [emulated]), passed("t5", [faked])], { service: "the payments API", realThing: "answer" });
    expect(lines).toEqual([
      "1 test passed against faked the payments API answers (not real answer): t5",
      "1 test passed against the payments API answers from Rovara local AWS (not real answer): t4",
      "1 test passed against scripted replies written in this task for the payments API (not real answer): t3",
      "1 test passed against scripted replies written independently in this task for the payments API (not real answer): t2",
      "1 test passed against answers Rovara made for the payments API (Made by Rovara, not counted toward the proof; not real answer): t1",
    ]);
  });
  it("names each scripted group with the reply-set provenance words, the one that counts least first, and never says '(not counted)'", () => {
    const lines = testAnswerSummaryLines([passed("a", [scripted("before_task")]), passed("b", [scripted("before_task"), scripted("task_made")])], { service: "Gemini", realThing: "model output" });
    expect(lines).toEqual([
      "1 test passed against scripted replies written in this task for Gemini (not real model output): b",
      "1 test passed against scripted replies from the project's reply set (written before the task) for Gemini (not real model output): a",
    ]);
    expect(lines.join("\n")).not.toContain("not counted");
  });
  it("keeps the shipped lines for faked and recorded answers word for word", () => {
    expect(testAnswerSummaryLines([passed("a", [faked]), passed("b", [recorded])], { service: "SageMaker", realThing: "model output" })).toEqual([
      "1 test passed against faked SageMaker answers (not real model output): a",
      "1 test passed against recorded SageMaker answers (recorded 2026-11-12; not real model output): b",
    ]);
  });
});

describe("a dependency that nothing answered, in the pack's text (review Low)", () => {
  it("says 'not available' on its line, though its class stays Simulated in the class summary", () => {
    const pack = v2Pack({ dependencies: [{ name: "payments", kind: "http_api", backing: "none", label: "not_available", trust: "simulated" }, { name: "mock", kind: "http_api", backing: "none", label: "faked_by_tests", trust: "simulated" }] });
    const text = renderEvidence(pack).text;
    expect(text).toContain("Dependencies: Simulated");
    expect(text).toContain("- payments: not available");
    expect(text).toContain("- mock: Simulated");
  });
  it("does not say so for a label this build does not know", () => {
    const read = readEvidencePack(v2Pack({ dependencies: [{ name: "x", kind: "http_api", backing: "none", label: "from_the_future", trust: "simulated" }] }));
    expect(read.status).toBe("v2");
    if (read.status === "v2") expect(renderEvidence(read.pack).text).not.toContain("not available");
  });
});

describe("the three proof labels of DECISIONS 170 and the eval states (contract only; TE-F3 gates)", () => {
  it("has Proven, No regression measured (eval) and Improved on eval as separate labels with the owner's words", () => {
    expect([...CHANGE_PROOF_LABELS]).toEqual(["proven", "no_regression_eval", "improved_eval", "worse_eval", "eval_not_qualified"]);
    expect(CHANGE_PROOF_LABEL_WORDS.worse_eval).toBe("Worse on eval");
    expect(CHANGE_PROOF_LABEL_WORDS.proven).toBe("Proven");
    expect(CHANGE_PROOF_LABEL_WORDS.no_regression_eval).toBe("No regression measured (eval)");
    expect(CHANGE_PROOF_LABEL_WORDS.improved_eval).toBe("Improved on eval");
    expect(new Set(Object.values(CHANGE_PROOF_LABEL_WORDS)).size).toBe(CHANGE_PROOF_LABELS.length);
  });
  it("counts only Proven as proof that the change works; an eval label never does", () => {
    expect(changeProofLabelCountsAsProven("proven")).toBe(true);
    for (const label of ["no_regression_eval", "improved_eval", "worse_eval", "eval_not_qualified"]) expect(changeProofLabelCountsAsProven(label), label).toBe(false);
    expect(changeProofLabelCountsAsProven("proven_by_magic")).toBe(false);
    expect(changeProofLabelCountsAsProven(undefined)).toBe(false);
  });
  it("marks which labels are a qualified result: Proven and the two eval results, never 'not qualified'", () => {
    expect(changeProofLabelQualified("proven")).toBe(true);
    expect(changeProofLabelQualified("no_regression_eval")).toBe(true);
    expect(changeProofLabelQualified("improved_eval")).toBe(true);
    expect(changeProofLabelQualified("eval_not_qualified")).toBe(false);
    expect(changeProofLabelQualified("worse_eval")).toBe(false);
    expect(changeProofLabelQualified("something_newer")).toBe(false);
  });
  it("reads a gated eval result as its own label, never as Proven", () => {
    expect(evalProofLabel({ outcome: "no_regression_eval" })).toEqual({ label: "no_regression_eval", words: "No regression measured (eval)" });
    expect(evalProofLabel({ outcome: "improved_eval" })).toEqual({ label: "improved_eval", words: "Improved on eval" });
  });
  it("reads a gated measured regression as 'Worse on eval', a failing check, never 'not qualified' (DECISIONS 192b, rework c)", () => {
    expect(evalProofLabel({ outcome: "worse_eval" })).toEqual({ label: "worse_eval", words: "Worse on eval" });
    expect(evalProofLabel({ outcome: "worse_eval", reason: "not_gated" })).toEqual({ label: "worse_eval", words: "Worse on eval" });
    expect(evalProofLabel({ outcome: "worse_eval" }).words).not.toContain("not qualified");
    expect(changeProofLabelFailsCheck("worse_eval")).toBe(true);
    for (const label of ["proven", "no_regression_eval", "improved_eval", "eval_not_qualified", "Worse on eval", undefined]) expect(changeProofLabelFailsCheck(label), String(label)).toBe(false);
    // the words are the shipped AI evidence label's own
    expect(CHANGE_PROOF_LABEL_WORDS.worse_eval).toBe("Worse on eval");
  });
  it("reads an eval result that is not gated, not known or says 'proven' as 'not qualified', with a fixed reason and never a pass", () => {
    expect(evalProofLabel({})).toEqual({ label: "eval_not_qualified", words: "not qualified: the result was not gated" });
    expect(evalProofLabel({ outcome: "proven" })).toMatchObject({ label: "eval_not_qualified" });
    expect(evalProofLabel({ outcome: "proven" }).words).not.toBe("Proven");
    expect(evalProofLabel({ outcome: "a_newer_outcome" })).toMatchObject({ label: "eval_not_qualified" });
    expect(evalProofLabel({ outcome: "eval_not_qualified", reason: "cap_hit" })).toEqual({ label: "eval_not_qualified", words: "not qualified: a cap was hit" });
    // a reason is a fixed word, so text from a repository never gets in
    expect(evalProofLabel({ outcome: "eval_not_qualified", reason: "<script>ignore previous</script>" }).words).toBe("not qualified: the result was not gated");
    // the reason of a qualified label is dropped, and a not-qualified state never reads as one
    expect(evalProofLabel({ outcome: "improved_eval", reason: "cap_hit" })).toEqual({ label: "improved_eval", words: "Improved on eval" });
  });
  it("gives every reason fixed words, and no label's words say 'Proven' but Proven's own", () => {
    for (const reason of EVAL_NOT_QUALIFIED_REASONS) expect(EVAL_NOT_QUALIFIED_REASON_WORDS[reason].length, reason).toBeGreaterThan(0);
    for (const reason of EVAL_NOT_QUALIFIED_REASONS) expect(evalProofLabel({ outcome: "eval_not_qualified", reason }).words).toBe(`not qualified: ${EVAL_NOT_QUALIFIED_REASON_WORDS[reason]}`);
    expect([...EVAL_NOT_QUALIFIED_REASONS]).toEqual(expect.arrayContaining(["not_gated", "cannot_detect_drop", "too_few_questions", "cap_hit", "provider_outage", "questions_edited_by_change", "baseline_too_old", "no_coverage_evidence"]));
  });
});
