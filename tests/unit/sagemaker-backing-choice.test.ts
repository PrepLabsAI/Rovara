// SageMaker endpoints (SM4): the backing choice for one endpoint. Pure and deterministic: canned by default, a stand-in when a schema is declared, the customer's image only when a maintainer chose it AND the runner is
// there, and every refusal with its fixed reason.
import { describe, expect, it } from "vitest";
import { SAGEMAKER_DEFAULT_WITHOUT_RECORDING, SAGEMAKER_STAND_IN_PARKED, SageMakerEndpointBackingSchema } from "../../packages/contracts/src/index.js";
import { DEFAULT_ALLOWED_BACKINGS, type AllowedBackings } from "../../packages/broker/src/core/test-env/backing-choice.js";
import {
  SAGEMAKER_CHOICE_REASONS, SAGEMAKER_CHOICE_REASON_WORDS, SAGEMAKER_SKIP_REASON_WORDS, chooseSageMakerBacking, pinnedSageMakerBacking, type SageMakerChoiceInput,
} from "../../packages/broker/src/core/test-env/sagemaker-backing.js";

const sha = (letter: string) => letter.repeat(64);
const allowed = (over: Partial<AllowedBackings> = {}): AllowedBackings => ({ ...DEFAULT_ALLOWED_BACKINGS, ...over });
const recorded = { ref: sha("a"), origin: "recorded" as const, recordedOn: "2026-11-20", unmatched: "fail" as const };
const schema = { response: { type: "object" } };
const image = { imageId: "fraud-model", architecture: "arm64" as const, memoryMiB: 1_024 };
// A stand-in builds its answers from a schema, which is making up answers, so the company setting for it is on wherever a stand-in is expected.
// The stand-in is parked: its branch is kept and tested with the park lifted, and shown here to be unreachable while parked.
const unparked = { standInParked: false };
const input = (over: Partial<SageMakerChoiceInput> = {}): SageMakerChoiceInput => ({ endpointName: "fraud-scorer", runnerAvailable: false, allowed: allowed({ fakeMakesUpAnswers: true }), ...over });

describe("the default order", () => {
  it("uses approved fixtures first, and says whether they were recorded or written", () => {
    expect(chooseSageMakerBacking(input({ fixtures: recorded, declaredSchema: schema }))).toMatchObject({ backing: { mode: "canned", origin: "recorded", fixtureSetRef: sha("a") }, reason: "recorded_fixtures", lessSafe: false });
    expect(chooseSageMakerBacking(input({ fixtures: { ...recorded, origin: "hand_written", recordedOn: undefined } }))).toMatchObject({ backing: { mode: "canned", origin: "hand_written" }, reason: "written_fixtures" });
  });
  it("(parked lifted) uses a stand-in when a schema is declared and nothing was recorded", () => {
    const choice = chooseSageMakerBacking(input({ declaredSchema: schema }), unparked);
    expect(choice).toMatchObject({ backing: { mode: "stand_in", memoryMiB: 128 }, reason: "declared_schema" });
    expect(choice.skipped).toEqual([{ mode: "canned", reason: "no_fixtures", words: SAGEMAKER_SKIP_REASON_WORDS.no_fixtures }]);
    expect(choice.lessSafe).toBe(true);
  });
  it("does not use a stand-in where the company does not allow made-up answers: a stand-in builds every answer from the schema", () => {
    const choice = chooseSageMakerBacking(input({ declaredSchema: schema, allowed: allowed({ fakeMakesUpAnswers: false }) }), unparked);
    expect(choice.backing).toMatchObject({ mode: "not_run", reason: "no_recording" });
    expect(choice.skipped).toEqual([
      { mode: "canned", reason: "no_fixtures", words: SAGEMAKER_SKIP_REASON_WORDS.no_fixtures },
      { mode: "stand_in", reason: "stand_in_makes_up_not_allowed", words: SAGEMAKER_SKIP_REASON_WORDS.stand_in_makes_up_not_allowed },
    ]);
    // recorded fixtures still win, and need no such setting
    expect(chooseSageMakerBacking(input({ fixtures: recorded, declaredSchema: schema, allowed: allowed({ fakeMakesUpAnswers: false }) }))).toMatchObject({ backing: { mode: "canned", origin: "recorded" }, lessSafe: false });
    // a maintainer's choice of stand-in is held to the same setting
    expect(chooseSageMakerBacking(input({ maintainerChoice: "stand_in", declaredSchema: schema, allowed: allowed({ fakeMakesUpAnswers: false }) }), unparked).backing.mode).toBe("not_run");
  });
  it("is NOT RUN, named, when there is no recording and no approved fixture: a skip with its reason, never a pass, and nothing is pinned", () => {
    const choice = chooseSageMakerBacking(input());
    expect(choice).toMatchObject({ backing: { mode: "not_run", reason: "no_recording" }, reason: "no_recording", lessSafe: false });
    expect(choice.statement).toBe("SageMaker endpoint fraud-scorer: not run (no recording of this endpoint's answers; the real model was not run)");
    expect(choice.words).toContain("not run");
    expect(pinnedSageMakerBacking(choice.backing)).toBeUndefined();
    // the default is stated in the contract
    expect(SAGEMAKER_DEFAULT_WITHOUT_RECORDING).toBe("not_run");
  });
  it("names the endpoint it skips, and a name that is not an endpoint name is shown as unnamed", () => {
    expect(chooseSageMakerBacking(input({ endpointName: "ranker-v2" })).statement).toContain("SageMaker endpoint ranker-v2: not run");
    expect(chooseSageMakerBacking(input({ endpointName: "evil\nname" })).statement).toContain("SageMaker endpoint (unnamed): not run");
  });
  it("is not run, with a different reason, where fakes are not allowed at all", () => {
    const choice = chooseSageMakerBacking(input({ allowed: allowed({ fakes: false }) }));
    expect(choice).toMatchObject({ backing: { mode: "not_run", reason: "not_allowed" }, reason: "nothing_available" });
    expect(choice.statement).toContain("not run (the company does not allow a fake here");
  });
  it("is not run for a recording the company cannot use, and no recording is not a fake: the real model was not run", () => {
    const madeUp = chooseSageMakerBacking(input({ fixtures: { ...recorded, unmatched: "made_up" }, allowed: allowed({ fakeMakesUpAnswers: false }) }));
    expect(madeUp.backing).toMatchObject({ mode: "not_run", reason: "no_recording" });
  });
  it("never picks the image by default, even when an approved image and the runner exist", () => {
    const choice = chooseSageMakerBacking(input({ image, runnerAvailable: true, declaredSchema: schema }));
    expect(choice.backing.mode).toBe("not_run");
    expect(chooseSageMakerBacking(input({ image, runnerAvailable: true })).backing).toMatchObject({ mode: "not_run", reason: "no_recording" });
  });
});

describe("the stand-in is parked", () => {
  it("is never chosen while parked: not by a schema, not by the made-up-answers setting, not by a maintainer", () => {
    expect(SAGEMAKER_STAND_IN_PARKED).toBe(true);
    const everything = { declaredSchema: schema, allowed: allowed({ fakeMakesUpAnswers: true, fakes: true, emulated: true, projectImages: true }) };
    for (const choice of [
      chooseSageMakerBacking(input(everything)),
      chooseSageMakerBacking(input({ ...everything, maintainerChoice: "stand_in" })),
      chooseSageMakerBacking(input({ ...everything, maintainerChoice: "canned" })),
      chooseSageMakerBacking(input({ ...everything, image, runnerAvailable: true })),
    ]) {
      expect(choice.backing).toMatchObject({ mode: "not_run", reason: "no_recording" });
      expect(choice.skipped.some((entry) => entry.mode === "stand_in" && entry.reason === "stand_in_parked")).toBe(true);
      expect(pinnedSageMakerBacking(choice.backing)).toBeUndefined();
    }
    // recorded fixtures still answer, and the stand-in is not even asked
    expect(chooseSageMakerBacking(input({ ...everything, fixtures: recorded })).backing).toMatchObject({ mode: "canned", origin: "recorded" });
  });
  it("keeps its branch: with the park lifted the same facts choose it", () => {
    const facts = input({ declaredSchema: schema });
    expect(chooseSageMakerBacking(facts).backing.mode).toBe("not_run");
    expect(chooseSageMakerBacking(facts, unparked).backing.mode).toBe("stand_in");
    expect(chooseSageMakerBacking(facts, { standInParked: true }).backing.mode).toBe("not_run");
  });
});

describe("the exceptions", () => {
  it("lets tests that fake the endpoint win, and a maintainer decline", () => {
    expect(chooseSageMakerBacking(input({ fakedByTests: true, fixtures: recorded }))).toMatchObject({ backing: { mode: "none", reason: "faked_by_tests" }, reason: "faked_by_tests", lessSafe: false });
    expect(chooseSageMakerBacking(input({ maintainerChoice: "none", fixtures: recorded }))).toMatchObject({ backing: { mode: "none", reason: "declined" }, lessSafe: true });
  });
  it("runs the image only when a maintainer chose it, the company allows project images, an approved image exists and the runner is there", () => {
    const base = input({ maintainerChoice: "image", image, runnerAvailable: true, allowed: allowed({ projectImages: true }), fixtures: recorded });
    expect(chooseSageMakerBacking(base)).toMatchObject({ backing: { mode: "image", imageId: "fraud-model", architecture: "arm64", memoryMiB: 1_024 }, reason: "maintainer_choice", lessSafe: true });
    const refused = (over: Partial<SageMakerChoiceInput>, reason: string) => {
      const choice = chooseSageMakerBacking({ ...base, ...over });
      expect(choice.backing).toMatchObject({ mode: "canned", origin: "recorded" });
      expect(choice.skipped[0]).toMatchObject({ mode: "image", reason });
    };
    refused({ runnerAvailable: false }, "no_runner");
    refused({ image: undefined }, "no_image");
    refused({ allowed: allowed({ projectImages: false }) }, "not_allowed");
  });
  it("tries a maintainer's choice of stand-in or canned first", () => {
    expect(chooseSageMakerBacking(input({ maintainerChoice: "stand_in", fixtures: recorded, declaredSchema: schema }), unparked)).toMatchObject({ backing: { mode: "stand_in" }, reason: "maintainer_choice" });
    expect(chooseSageMakerBacking(input({ maintainerChoice: "canned", declaredSchema: schema }), unparked)).toMatchObject({ backing: { mode: "stand_in" }, reason: "declared_schema" });
  });
  it("reads a choice that is not a mode as no choice", () => {
    expect(chooseSageMakerBacking(input({ maintainerChoice: "helper" as never, fixtures: recorded }))).toMatchObject({ backing: { mode: "canned" }, reason: "recorded_fixtures" });
  });
});

describe("what the company allows", () => {
  it("needs Rovara local AWS and fakes for fixtures and a stand-in", () => {
    expect(chooseSageMakerBacking(input({ fixtures: recorded, allowed: allowed({ emulated: false }) })).backing).toEqual({ mode: "not_run", reason: "not_allowed" });
    expect(chooseSageMakerBacking(input({ declaredSchema: schema, allowed: allowed({ fakes: false }) }), unparked).backing).toEqual({ mode: "not_run", reason: "not_allowed" });
  });
  it("lets a set that makes up answers through only where the company allows it, and marks it less safe", () => {
    const madeUp = { ...recorded, unmatched: "made_up" as const };
    const blocked = chooseSageMakerBacking(input({ fixtures: madeUp, allowed: allowed({ fakeMakesUpAnswers: false }), declaredSchema: schema }), unparked);
    // the stand-in builds its answers from a schema, which is making answers up too, so it is held back by the same setting
    expect(blocked.backing).toMatchObject({ mode: "not_run", reason: "no_recording" });
    expect(blocked.skipped.map((entry) => [entry.mode, entry.reason])).toEqual([["canned", "made_up_not_allowed"], ["stand_in", "stand_in_makes_up_not_allowed"]]);
    const allowedChoice = chooseSageMakerBacking(input({ fixtures: madeUp, allowed: allowed({ fakeMakesUpAnswers: true }) }));
    expect(allowedChoice).toMatchObject({ backing: { mode: "canned", unmatched: "made_up" }, lessSafe: true });
  });
  it("never throws on facts that are not what the types say", () => {
    expect(chooseSageMakerBacking(undefined as never)).toMatchObject({ backing: { mode: "not_run", reason: "could_not_decide" }, reason: "nothing_available", lessSafe: false });
    expect(chooseSageMakerBacking(undefined as never).statement).toContain("not run (what backs this endpoint could not be decided");
  });
});

describe("the pinned backing", () => {
  it("is a valid backing for each mode, and the words exist for every reason", () => {
    for (const choice of [chooseSageMakerBacking(input({ fixtures: recorded })), chooseSageMakerBacking(input({ declaredSchema: schema }), unparked), chooseSageMakerBacking(input({ maintainerChoice: "image", image, runnerAvailable: true, allowed: allowed({ projectImages: true }) }))]) {
      const pinned = pinnedSageMakerBacking(choice.backing);
      expect(SageMakerEndpointBackingSchema.safeParse(pinned).success).toBe(true);
    }
    for (const reason of SAGEMAKER_CHOICE_REASONS) expect(SAGEMAKER_CHOICE_REASON_WORDS[reason].length).toBeGreaterThan(10);
  });
});
