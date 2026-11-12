// SageMaker endpoints (SM4): the contracts. The fixture document is the one the SageMaker Runtime front accepts (same fields, same limits, a typo refused); the backing is one of canned, stand-in and image; the plan fits
// the memory a run has; a dependency carries its model backing and the two agree; the words are fixed.
import { describe, expect, it } from "vitest";
import {
  SAGEMAKER_ENDPOINT_LIMITS, SAGEMAKER_FIXTURE_LIMITS, SageMakerEndpointBackingSchema, SageMakerEndpointNameSchema, SageMakerFixtureDocumentSchema, SageMakerEndpointPlanSchema, TestEnvDependencySchema,
  SAGEMAKER_DEFAULT_WITHOUT_RECORDING, SAGEMAKER_NO_ANSWER_MARKER, SAGEMAKER_NO_ANSWER_MARKER_PREFIX, SAGEMAKER_NO_ANSWER_MESSAGE_PREFIX, SAGEMAKER_NO_ANSWER_STATUS, sageMakerLedgerMarkerIsNoAnswer, sageMakerNoAnswerEndpoint, SAGEMAKER_NOT_RUN_REASONS, SAGEMAKER_NOT_RUN_REASON_WORDS, SAGEMAKER_STAND_IN_PARKED, binaryScanTexts, sageMakerBackingLessSafe, sageMakerNotRunLine, sageMakerCannedMismatches, sageMakerCardText, sageMakerDocumentMakesUpAnswers, sageMakerDocumentTexts, sageMakerEvidenceLabel, sageMakerEvidenceLine, sageMakerFixtureDigest,
  sageMakerFrontDocument, sageMakerPlanProblems, testEnvDependencyLessSafeChanges, type SageMakerEndpointBacking, type SageMakerFixtureDocument,
} from "../../packages/contracts/src/index.js";

const sha = (letter: string) => letter.repeat(64);
const document = (over: Record<string, unknown> = {}): SageMakerFixtureDocument =>
  SageMakerFixtureDocumentSchema.parse({
    mode: "canned", source: "recorded", recordedOn: "2026-11-20",
    rules: [{ match: { operation: "invoke", contentType: "application/json", bodyEquals: "{\"amount\":10}" }, response: { json: { score: 0.1 }, contentType: "application/json" } }],
    ...over,
  });

describe("the fixture document the front accepts", () => {
  it("takes rules, a queue and a default, with the front's fields", () => {
    const parsed = SageMakerFixtureDocumentSchema.parse({
      source: "handwritten", asyncDelayMs: 50,
      rules: [{ match: { jsonPath: "$.a.b[0]", equals: 3 }, response: { parts: ["a", "b"], partDelayMs: 5, streamError: { errorCode: "StreamBroken" } }, times: 2 }, { match: { matches: "^ok" }, response: { error: { code: "ValidationError", message: "bad" } } }],
      queue: [{ body: "one" }, { bodyBase64: "AAEC" }],
      default: { json: { fallback: true }, variant: "A", customAttributes: "x=1", delayMs: 10 },
    });
    expect(parsed.rules).toHaveLength(2);
    expect(sageMakerDocumentMakesUpAnswers(parsed)).toBe(true);
    expect(sageMakerDocumentMakesUpAnswers({})).toBe(false);
  });
  it("refuses what the front refuses: a typo in a field, two body forms, equals without a path, a bad hash, an oversize answer, a recorded set with no date", () => {
    expect(SageMakerFixtureDocumentSchema.safeParse({ rules: [{ match: { contentTyp: "x" }, response: { body: "x" } }] }).success).toBe(false);
    expect(SageMakerFixtureDocumentSchema.safeParse({ queue: [{ body: "x", json: {} }] }).success).toBe(false);
    expect(SageMakerFixtureDocumentSchema.safeParse({ rules: [{ match: { equals: 1 }, response: { body: "x" } }] }).success).toBe(false);
    expect(SageMakerFixtureDocumentSchema.safeParse({ rules: [{ match: { bodySha256: "ABC" }, response: { body: "x" } }] }).success).toBe(false);
    expect(SageMakerFixtureDocumentSchema.safeParse({ queue: [{ body: "x".repeat(SAGEMAKER_FIXTURE_LIMITS.replyBytes + 1) }] }).success).toBe(false);
    expect(SageMakerFixtureDocumentSchema.safeParse({ source: "recorded", rules: [] }).success).toBe(false);
    expect(SageMakerFixtureDocumentSchema.safeParse({ source: "handwritten", recordedOn: "2026-11-20" }).success).toBe(false);
    expect(SageMakerFixtureDocumentSchema.safeParse({ rules: Array.from({ length: SAGEMAKER_FIXTURE_LIMITS.rules + 1 }, () => ({ match: {}, response: { body: "x" } })) }).success).toBe(false);
    expect(SageMakerFixtureDocumentSchema.safeParse({ queue: [{ bodyBase64: "not base64!" }] }).success).toBe(false);
  });
  it("holds all the answers of one document to 8 MiB", () => {
    const big = "x".repeat(SAGEMAKER_FIXTURE_LIMITS.documentBytes / 2);
    expect(SageMakerFixtureDocumentSchema.safeParse({ queue: [{ body: big }, { body: big }] }).success).toBe(true);
    expect(SageMakerFixtureDocumentSchema.safeParse({ queue: [{ body: big }, { body: big }, { body: big }] }).success).toBe(false);
  });
  it("pins a document by a digest that does not depend on key order", () => {
    const one = document();
    const reordered = SageMakerFixtureDocumentSchema.parse({ rules: [{ response: { contentType: "application/json", json: { score: 0.1 } }, match: { bodyEquals: "{\"amount\":10}", contentType: "application/json", operation: "invoke" } }], recordedOn: "2026-11-20", source: "recorded", mode: "canned" });
    expect(sageMakerFixtureDigest(one)).toBe(sageMakerFixtureDigest(reordered));
    expect(sageMakerFixtureDigest(one)).toMatch(/^[a-f0-9]{64}$/u);
    expect(sageMakerFixtureDigest(document({ recordedOn: "2026-11-21" }))).not.toBe(sageMakerFixtureDigest(one));
  });
  it("lists every text a scan must read, a base64 body decoded so nothing hides in it", () => {
    const doc = SageMakerFixtureDocumentSchema.parse({ rules: [{ match: { bodyEquals: "in" }, response: { bodyBase64: Buffer.from("secret-ish text").toString("base64"), customAttributes: "attr" } }], queue: [{ parts: ["p1", "p2"] }], default: { error: { message: "oops" } } });
    const texts = sageMakerDocumentTexts(doc);
    expect(texts.find((item) => item.path === "rules[0].response.bodyBase64")).toEqual({ path: "rules[0].response.bodyBase64", text: "secret-ish text", binary: false });
    expect(texts.map((item) => item.path)).toEqual(expect.arrayContaining(["rules[0].match.bodyEquals", "rules[0].response.customAttributes", "queue[0].parts[1]", "default.error.message"]));
    const binary = SageMakerFixtureDocumentSchema.parse({ queue: [{ bodyBase64: Buffer.from([0xff, 0xfe, 0x00]).toString("base64") }] });
    expect(sageMakerDocumentTexts(binary)[0]?.binary).toBe(true);
  });
});

describe("what a scan of a document reads", () => {
  it("lists every string field of a rule's match, so none is left out of the scan", () => {
    const doc = SageMakerFixtureDocumentSchema.parse({ rules: [{ match: { contentType: "ct-text", accept: "accept-text", targetVariant: "variant-text", customAttributes: "attr-text", targetModel: "model-text", bodyEquals: "eq", bodyContains: "has", matches: "re", jsonPath: "$.a" }, response: { body: "x" } }] });
    const byPath = new Map(sageMakerDocumentTexts(doc).map((item) => [item.path, item.text]));
    for (const [field, text] of [["contentType", "ct-text"], ["accept", "accept-text"], ["targetVariant", "variant-text"], ["customAttributes", "attr-text"], ["targetModel", "model-text"], ["bodyEquals", "eq"], ["bodyContains", "has"], ["matches", "re"], ["jsonPath", "$.a"]] as const) expect(byPath.get(`rules[0].match.${field}`)).toBe(text);
  });
  it("lists streamed parts joined as well as one by one, so a value split across two parts is whole in one text", () => {
    const doc = SageMakerFixtureDocumentSchema.parse({ queue: [{ parts: ["pat.quill@", "fakemail-sample.io"] }] });
    const texts = sageMakerDocumentTexts(doc);
    expect(texts.find((item) => item.path === "queue[0].parts")?.text).toBe("pat.quill@fakemail-sample.io");
    expect(texts.filter((item) => item.path.startsWith("queue[0].parts[")).map((item) => item.text)).toEqual(["pat.quill@", "fakemail-sample.io"]);
  });
  it("treats a body with a NUL or another control character as binary, and reads a binary body every way it can be read, UTF-16 of either order included", () => {
    const sentence = "{\"e\":\"pat.quill@fakemail-sample.io\"}";
    const le = Buffer.from(sentence, "utf16le");
    const be = Buffer.from(le).swap16();
    for (const bytes of [le, be]) {
      const doc = SageMakerFixtureDocumentSchema.parse({ queue: [{ bodyBase64: bytes.toString("base64") }] });
      const texts = sageMakerDocumentTexts(doc);
      expect(texts.every((item) => item.binary)).toBe(true);
      expect(texts.map((item) => item.text)).toContain(sentence);
    }
    const withNul = SageMakerFixtureDocumentSchema.parse({ queue: [{ body: "a\u0000b" }, { body: "tab\tnewline\ncr\r are text" }] });
    expect(sageMakerDocumentTexts(withNul).map((item) => item.binary)).toEqual([true, false]);
    expect(binaryScanTexts(Buffer.from([0x61, 0x00, 0x62, 0x00])).includes("ab")).toBe(true);
  });
});

describe("the backing of one endpoint", () => {
  const canned: SageMakerEndpointBacking = { mode: "canned", origin: "recorded", fixtureSetRef: sha("a"), recordedOn: "2026-11-20", unmatched: "fail" };
  const standIn: SageMakerEndpointBacking = { mode: "stand_in", schema: { response: { type: "object", properties: { score: { type: "number" } } } }, memoryMiB: 128 };
  const image: SageMakerEndpointBacking = { mode: "image", imageId: "fraud-model", architecture: "arm64", memoryMiB: 1_024, modelArchiveDigest: sha("b") };

  it("accepts each of the three modes, and no other", () => {
    for (const backing of [canned, standIn, image]) expect(SageMakerEndpointBackingSchema.safeParse(backing).success).toBe(true);
    expect(SageMakerEndpointBackingSchema.safeParse({ ...canned, mode: "helper" }).success).toBe(false);
  });
  it("makes a recorded set say when, and a written set not", () => {
    expect(SageMakerEndpointBackingSchema.safeParse({ ...canned, recordedOn: undefined }).success).toBe(false);
    expect(SageMakerEndpointBackingSchema.safeParse({ ...canned, origin: "hand_written" }).success).toBe(false);
    expect(SageMakerEndpointBackingSchema.safeParse({ ...canned, origin: "hand_written", recordedOn: undefined }).success).toBe(true);
  });
  it("holds a stand-in to 64-128 MiB and a declared schema to 16 KiB, and an image to the model budget", () => {
    expect(SageMakerEndpointBackingSchema.safeParse({ ...standIn, memoryMiB: 63 }).success).toBe(false);
    expect(SageMakerEndpointBackingSchema.safeParse({ ...standIn, memoryMiB: 129 }).success).toBe(false);
    expect(SageMakerEndpointBackingSchema.safeParse({ ...standIn, schema: { response: { type: "string", enum: ["x".repeat(SAGEMAKER_ENDPOINT_LIMITS.declaredSchemaBytes)] } } }).success).toBe(false);
    expect(SageMakerEndpointBackingSchema.safeParse({ ...image, memoryMiB: SAGEMAKER_ENDPOINT_LIMITS.imageMemoryMiB.max + 1 }).success).toBe(false);
    expect(SageMakerEndpointBackingSchema.safeParse({ ...image, architecture: "riscv" }).success).toBe(false);
  });
  it("takes SageMaker's own endpoint names", () => {
    for (const ok of ["fraud-scorer", "A", "a--b", "x".repeat(63)]) expect(SageMakerEndpointNameSchema.safeParse(ok).success).toBe(true);
    for (const bad of ["", "-lead", "trail-", "has_underscore", "dot.name", "x".repeat(64)]) expect(SageMakerEndpointNameSchema.safeParse(bad).success).toBe(false);
  });
  it("marks an image, and made-up answers, as less safe", () => {
    expect(sageMakerBackingLessSafe(image)).toBe(true);
    expect(sageMakerBackingLessSafe({ ...canned, unmatched: "made_up" })).toBe(true);
    expect(sageMakerBackingLessSafe(canned)).toBe(false);
    // a stand-in builds every answer from a schema: it makes answers up
    expect(sageMakerBackingLessSafe(standIn)).toBe(true);
  });
  it("refuses a plan that names an endpoint twice, names too many, or needs more model memory than a run has", () => {
    const entry = (endpointName: string, backing: SageMakerEndpointBacking) => ({ endpointName, backing });
    expect(sageMakerPlanProblems([entry("a", canned), entry("b", standIn), entry("c", image)])).toEqual([]);
    expect(sageMakerPlanProblems([entry("a", canned), entry("a", standIn)])).toEqual(["duplicate_endpoint"]);
    expect(sageMakerPlanProblems([entry("a", { ...image, memoryMiB: 1_500 }), entry("b", { ...image, memoryMiB: 500 })])).toEqual(["over_memory_budget"]);
    expect(sageMakerPlanProblems(Array.from({ length: 17 }, (_, index) => entry(`e${String(index)}`, canned)))).toEqual(["too_many_endpoints"]);
    expect(SageMakerEndpointPlanSchema.safeParse([entry("a", { ...image, memoryMiB: 1_500 }), entry("b", { ...image, memoryMiB: 500 })]).success).toBe(false);
    expect(SageMakerEndpointPlanSchema.safeParse([entry("a", canned), entry("b", standIn)]).success).toBe(true);
  });
  it("builds the document the front reads: its helper mode is the stand-in, and a canned set carries its fixtures", () => {
    expect(sageMakerFrontDocument(standIn)).toEqual({ mode: "helper" });
    expect(sageMakerFrontDocument(image)).toEqual({ mode: "image" });
    const sent = sageMakerFrontDocument(canned, document());
    expect(sent).toMatchObject({ mode: "canned", source: "recorded", recordedOn: "2026-11-20" });
    expect(SageMakerFixtureDocumentSchema.safeParse(sent).success).toBe(true);
    expect(sageMakerFrontDocument({ ...canned, origin: "hand_written", recordedOn: undefined }, document({ source: "handwritten", recordedOn: undefined }))).toMatchObject({ source: "handwritten" });
  });
  it("checks that a canned backing describes the document it pins", () => {
    const doc = document();
    const good = { ...canned, fixtureSetRef: sageMakerFixtureDigest(doc) } as Extract<SageMakerEndpointBacking, { mode: "canned" }>;
    expect(sageMakerCannedMismatches(good, doc)).toEqual([]);
    expect(sageMakerCannedMismatches({ ...good, fixtureSetRef: sha("c") }, doc)).toContain("the digest is not the document's");
    expect(sageMakerCannedMismatches({ ...good, origin: "hand_written", recordedOn: undefined }, doc)).toContain("the origin is not the document's source");
    expect(sageMakerCannedMismatches({ ...good, unmatched: "made_up" }, doc)).toContain("the document's default answer and the unmatched rule disagree");
    expect(sageMakerCannedMismatches(good, { rules: [{ match: { equals: 1 }, response: {} }] })).toEqual(["the fixture document is not one the front accepts"]);
  });
});

describe("a dependency carries its model backing", () => {
  const base = (over: Record<string, unknown> = {}) => ({
    id: "fraud-scorer", name: "Fraud scorer", kind: "model_endpoint", family: "aws:sagemaker-runtime", found: [{ path: "app/score.py", line: 12 }], usedBy: ["integration"],
    backing: { kind: "emulated", catalogId: "local-aws@1", awsServices: ["sagemaker-runtime"], region: "us-east-1" },
    config: { endpointName: "fraud-scorer", model: { mode: "canned", origin: "recorded", fixtureSetRef: sha("a"), recordedOn: "2026-11-20", unmatched: "fail" } },
    connect: { env: [], hostAliases: [] }, seeds: [], reset: "fresh_per_round", ...over,
  });
  const issues = (value: unknown) => { const result = TestEnvDependencySchema.safeParse(value); return result.success ? [] : result.error.issues.map((issue) => issue.message); };

  it("accepts fixtures and a stand-in on Rovara local AWS, and an image on the project's own image", () => {
    expect(issues(base())).toEqual([]);
    expect(issues(base({ config: { endpointName: "fraud-scorer", model: { mode: "stand_in", schema: { response: { type: "object" } }, memoryMiB: 96 } } }))).toEqual([]);
    expect(issues(base({ backing: { kind: "project_image", imageId: "fraud-model" }, config: { endpointName: "fraud-scorer", model: { mode: "image", imageId: "fraud-model", architecture: "x86_64", memoryMiB: 512 } } }))).toEqual([]);
  });
  it("refuses a model backing that the dependency's backing does not run", () => {
    expect(issues(base({ backing: { kind: "project_image", imageId: "fraud-model" } }))).toContain("a canned or stand-in endpoint is answered by Rovara local AWS");
    expect(issues(base({ config: { endpointName: "fraud-scorer", model: { mode: "image", imageId: "other-image", architecture: "arm64", memoryMiB: 512 } }, backing: { kind: "project_image", imageId: "fraud-model" } }))).toContain("an image endpoint runs the project image its model backing names");
    expect(issues(base({ family: "aws:s3", kind: "object_store", config: { model: { mode: "canned", origin: "hand_written", fixtureSetRef: sha("a"), unmatched: "fail" } }, backing: { kind: "emulated", catalogId: "local-aws@1", awsServices: ["s3"], region: "us-east-1" } }))).toContain("only a SageMaker Runtime dependency has a model backing");
  });
  it("counts made-up answers, and an image, as less-safe changes", () => {
    const madeUp = TestEnvDependencySchema.parse(base({ config: { endpointName: "fraud-scorer", model: { mode: "canned", origin: "hand_written", fixtureSetRef: sha("a"), unmatched: "made_up" } } }));
    const plain = TestEnvDependencySchema.parse(base());
    expect(testEnvDependencyLessSafeChanges(undefined, [madeUp])).toEqual(["schema_synth"]);
    expect(testEnvDependencyLessSafeChanges(undefined, [plain])).toEqual([]);
    const standIn = TestEnvDependencySchema.parse(base({ config: { endpointName: "fraud-scorer", model: { mode: "stand_in", schema: { response: { type: "object" } }, memoryMiB: 96 } } }));
    expect(testEnvDependencyLessSafeChanges(undefined, [standIn])).toEqual(["schema_synth"]);
    const image = TestEnvDependencySchema.parse(base({ backing: { kind: "project_image", imageId: "fraud-model" }, config: { endpointName: "fraud-scorer", model: { mode: "image", imageId: "fraud-model", architecture: "arm64", memoryMiB: 512 } } }));
    expect(testEnvDependencyLessSafeChanges(undefined, [image])).toEqual(["project_image"]);
  });
});

describe("an endpoint with no recording is not run, by name", () => {
  it("says so in the evidence line, with the reason, as a skip and never a pass", () => {
    const line = "SageMaker endpoint fraud-scorer: not run (no recording of this endpoint's answers; the real model was not run)";
    expect(sageMakerEvidenceLine({ endpointName: "fraud-scorer", answeredBy: "not_run" })).toBe(line);
    expect(sageMakerNotRunLine("fraud-scorer")).toBe(line);
    expect(sageMakerNotRunLine("fraud-scorer", "not_allowed")).toBe("SageMaker endpoint fraud-scorer: not run (the company does not allow a fake here and nothing else backs it; the real model was not run)");
    expect(sageMakerNotRunLine("bad\nname")).toContain("SageMaker endpoint (unnamed): not run");
    // none of the words of a pass
    expect(line).not.toMatch(/answered by|passed/u);
    expect(SAGEMAKER_NOT_RUN_REASONS.every((reason) => SAGEMAKER_NOT_RUN_REASON_WORDS[reason].includes("real model was not run"))).toBe(true);
  });
  it("labels it not available, and writes a card that is medium risk and lists the tests by name", () => {
    expect(sageMakerEvidenceLabel("not_run")).toBe("not_available");
    const card = sageMakerCardText({ endpointName: "fraud-scorer", answeredBy: "not_run" });
    expect(card.risk).toBe("medium");
    expect(card.lines[0]).toBe(sageMakerNotRunLine("fraud-scorer"));
    expect(card.lines.join(" ")).toContain("not run");
    expect(card.lines.join(" ")).toContain("Nothing here counts as a pass.");
    expect(card.summary).toContain("Tests that need it are not run");
  });
  it("is the default, stated in the contract, and the stand-in is parked", () => {
    expect(SAGEMAKER_DEFAULT_WITHOUT_RECORDING).toBe("not_run");
    expect(SAGEMAKER_STAND_IN_PARKED).toBe(true);
  });
});

describe("the front's no-answer contract", () => {
  const message = "Rovara: no answer for endpoint fraud-scorer. No recording or fixture was approved for this endpoint, and the real model was not run. Nothing was made up. This test was NOT RUN: it did not pass and it did not fail.";
  it("names the marker and the message prefix the worker matches on", () => {
    expect(SAGEMAKER_NO_ANSWER_MARKER).toBe("no-answer: no recording for this endpoint");
    expect(SAGEMAKER_NO_ANSWER_MARKER_PREFIX).toBe("no-answer:");
    expect(SAGEMAKER_NO_ANSWER_MESSAGE_PREFIX).toBe("Rovara: no answer for endpoint ");
    expect(SAGEMAKER_NO_ANSWER_STATUS).toBe(400);
  });
  it("keys on the marker, not on a status or an error code", () => {
    expect(sageMakerLedgerMarkerIsNoAnswer(SAGEMAKER_NO_ANSWER_MARKER)).toBe(true);
    expect(sageMakerLedgerMarkerIsNoAnswer("no-answer: some later wording")).toBe(true);
    // a canned backing with no matching rule is a ModelError, with its own marker: not a skip
    expect(sageMakerLedgerMarkerIsNoAnswer("recorded fake; unmatched")).toBe(false);
    expect(sageMakerLedgerMarkerIsNoAnswer("unplanned endpoint")).toBe(false);
    expect(sageMakerLedgerMarkerIsNoAnswer(undefined)).toBe(false);
    expect(sageMakerLedgerMarkerIsNoAnswer(400)).toBe(false);
  });
  it("reads the endpoint from the message by its prefix, and from nothing else", () => {
    expect(sageMakerNoAnswerEndpoint(message)).toBe("fraud-scorer");
    expect(message.startsWith(SAGEMAKER_NO_ANSWER_MESSAGE_PREFIX)).toBe(true);
    expect(sageMakerNoAnswerEndpoint("Endpoint fraud-scorer of account 1 not found.")).toBeUndefined();
    expect(sageMakerNoAnswerEndpoint("Rovara: no answer for endpoint -bad. x")).toBeUndefined();
    expect(sageMakerNoAnswerEndpoint(42)).toBeUndefined();
  });
});

describe("the words", () => {
  it("states what answered each endpoint, in the fixed words", () => {
    expect(sageMakerEvidenceLine({ endpointName: "fraud-scorer", answeredBy: "recorded" })).toBe("SageMaker endpoint fraud-scorer: answered by recorded fixtures (faked). The real model was not run.");
    expect(sageMakerEvidenceLine({ endpointName: "fraud-scorer", answeredBy: "stand_in" })).toBe("SageMaker endpoint fraud-scorer: answered by a stand-in model (faked; the real model was not run)");
    expect(sageMakerEvidenceLine({ endpointName: "fraud-scorer", answeredBy: "image" }).startsWith("SageMaker endpoint fraud-scorer: answered by your model image in the Rovara function runner")).toBe(true);
    expect(sageMakerEvidenceLine({ endpointName: "fraud-scorer", answeredBy: "hand_written" })).toContain("answered by hand-written fixtures (faked)");
  });
  it("adds the date, the counts, the made-up answers and the emulation, and shows an unsafe name as unnamed", () => {
    const line = sageMakerEvidenceLine({ endpointName: "fraud-scorer", answeredBy: "recorded", recordedOn: "2026-11-20", usage: { calls: 41, unmatched: 0, madeUp: 0 } });
    expect(line).toBe("SageMaker endpoint fraud-scorer: answered by recorded fixtures (faked). Recorded on 2026-11-20 in your environment. 41 calls, all matched. The real model was not run.");
    expect(sageMakerEvidenceLine({ endpointName: "x", answeredBy: "hand_written", usage: { calls: 7, unmatched: 7, madeUp: 7 } })).toContain("7 calls got a made-up answer.");
    expect(sageMakerEvidenceLine({ endpointName: "x", answeredBy: "image", emulatedArchitecture: true })).toContain("x86_64 image ran under emulation on arm64");
    expect(sageMakerEvidenceLine({ endpointName: "evil\nname", answeredBy: "stand_in" })).toBe("SageMaker endpoint (unnamed): answered by a stand-in model (faked; the real model was not run)");
    expect(sageMakerEvidenceLine({ endpointName: "x", answeredBy: "recorded", recordedOn: "yesterday" })).not.toContain("yesterday");
  });
  it("labels fixtures as recorded or hand-written fakes and an image as the project's own", () => {
    expect(sageMakerEvidenceLabel("recorded")).toBe("recorded_fake");
    expect(sageMakerEvidenceLabel("hand_written")).toBe("hand_written_fake");
    expect(sageMakerEvidenceLabel("stand_in")).toBe("hand_written_fake");
    expect(sageMakerEvidenceLabel("image")).toBe("real_project_image");
  });
  it("writes the setup card with a high risk for an image or made-up answers", () => {
    expect(sageMakerCardText({ endpointName: "fraud-scorer", answeredBy: "recorded" }).risk).toBe("medium");
    expect(sageMakerCardText({ endpointName: "fraud-scorer", answeredBy: "image" }).risk).toBe("high");
    expect(sageMakerCardText({ endpointName: "fraud-scorer", answeredBy: "stand_in" }).risk).toBe("high");
    expect(sageMakerCardText({ endpointName: "fraud-scorer", answeredBy: "stand_in" }).lines.join(" ")).toContain("making up answers");
    expect(sageMakerCardText({ endpointName: "fraud-scorer", answeredBy: "hand_written", madeUp: true }).risk).toBe("high");
    const card = sageMakerCardText({ endpointName: "fraud-scorer", answeredBy: "stand_in" });
    expect(card.title).toBe("SageMaker endpoint fraud-scorer");
    expect(card.summary).toContain("runs no model");
    expect(card.lines.join(" ")).toContain("Not tested");
  });
});
