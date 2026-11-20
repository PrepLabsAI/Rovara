// SageMaker endpoints (SM4): the backing choice for one endpoint. Pure and deterministic: canned by default, a stand-in when a schema is declared, the customer's image only when a maintainer chose it AND the runner is
// there, and every refusal with its fixed reason.
import { describe, expect, it } from "vitest";
import { SAGEMAKER_STAND_IN_PARKED, SageMakerEndpointBackingSchema } from "../../packages/contracts/src/index.js";
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
  it("is not run for a recording the company cannot use, and no recording is not a fake: the real model was not run", () => {
    const madeUp = chooseSageMakerBacking(input({ fixtures: { ...recorded, unmatched: "made_up" }, allowed: allowed({ fakeMakesUpAnswers: false }) }));
    expect(madeUp.backing).toMatchObject({ mode: "not_run", reason: "no_recording" });
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
});

describe("what the company allows", () => {
  it("needs Rovara local AWS and fakes for fixtures and a stand-in", () => {
    expect(chooseSageMakerBacking(input({ fixtures: recorded, allowed: allowed({ emulated: false }) })).backing).toEqual({ mode: "not_run", reason: "not_allowed" });
    expect(chooseSageMakerBacking(input({ declaredSchema: schema, allowed: allowed({ fakes: false }) }), unparked).backing).toEqual({ mode: "not_run", reason: "not_allowed" });
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
