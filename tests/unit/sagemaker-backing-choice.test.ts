// SageMaker endpoints (SM4): the backing choice for one endpoint. Pure and deterministic: canned by default, a stand-in when a schema is declared, the customer's image only when a maintainer chose it AND the runner is
// there, and every refusal with its fixed reason.
import { describe, expect, it } from "vitest";
import { SageMakerEndpointBackingSchema } from "../../packages/contracts/src/index.js";
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
const input = (over: Partial<SageMakerChoiceInput> = {}): SageMakerChoiceInput => ({ runnerAvailable: false, allowed: allowed({ fakeMakesUpAnswers: true }), ...over });

describe("the default order", () => {
  it("uses approved fixtures first, and says whether they were recorded or written", () => {
    expect(chooseSageMakerBacking(input({ fixtures: recorded, declaredSchema: schema }))).toMatchObject({ backing: { mode: "canned", origin: "recorded", fixtureSetRef: sha("a") }, reason: "recorded_fixtures", lessSafe: false });
    expect(chooseSageMakerBacking(input({ fixtures: { ...recorded, origin: "hand_written", recordedOn: undefined } }))).toMatchObject({ backing: { mode: "canned", origin: "hand_written" }, reason: "written_fixtures" });
  });
  it("uses a stand-in when a schema is declared and nothing was recorded", () => {
    const choice = chooseSageMakerBacking(input({ declaredSchema: schema }));
    expect(choice).toMatchObject({ backing: { mode: "stand_in", memoryMiB: 128 }, reason: "declared_schema" });
    expect(choice.skipped).toEqual([{ mode: "canned", reason: "no_fixtures", words: SAGEMAKER_SKIP_REASON_WORDS.no_fixtures }]);
    expect(choice.lessSafe).toBe(true);
  });
  it("does not use a stand-in where the company does not allow made-up answers: a stand-in builds every answer from the schema", () => {
    const choice = chooseSageMakerBacking(input({ declaredSchema: schema, allowed: allowed({ fakeMakesUpAnswers: false }) }));
    expect(choice.backing).toMatchObject({ mode: "canned", origin: "to_make" });
    expect(choice.skipped).toEqual([
      { mode: "canned", reason: "no_fixtures", words: SAGEMAKER_SKIP_REASON_WORDS.no_fixtures },
      { mode: "stand_in", reason: "stand_in_makes_up_not_allowed", words: SAGEMAKER_SKIP_REASON_WORDS.stand_in_makes_up_not_allowed },
    ]);
    // recorded fixtures still win, and need no such setting
    expect(chooseSageMakerBacking(input({ fixtures: recorded, declaredSchema: schema, allowed: allowed({ fakeMakesUpAnswers: false }) }))).toMatchObject({ backing: { mode: "canned", origin: "recorded" }, lessSafe: false });
    // a maintainer's choice of stand-in is held to the same setting
    expect(chooseSageMakerBacking(input({ maintainerChoice: "stand_in", declaredSchema: schema, allowed: allowed({ fakeMakesUpAnswers: false }) })).backing.mode).toBe("canned");
  });
  it("offers fixtures still to be made when there is neither a set nor a schema, and pins nothing yet", () => {
    const choice = chooseSageMakerBacking(input());
    expect(choice).toMatchObject({ backing: { mode: "canned", origin: "to_make" }, reason: "fixtures_to_make" });
    expect(pinnedSageMakerBacking(choice.backing)).toBeUndefined();
  });
  it("never picks the image by default, even when an approved image and the runner exist", () => {
    const choice = chooseSageMakerBacking(input({ image, runnerAvailable: true, declaredSchema: schema }));
    expect(choice.backing.mode).toBe("stand_in");
    expect(chooseSageMakerBacking(input({ image, runnerAvailable: true })).backing).toMatchObject({ mode: "canned", origin: "to_make" });
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
    expect(chooseSageMakerBacking(input({ maintainerChoice: "stand_in", fixtures: recorded, declaredSchema: schema }))).toMatchObject({ backing: { mode: "stand_in" }, reason: "maintainer_choice" });
    expect(chooseSageMakerBacking(input({ maintainerChoice: "canned", declaredSchema: schema }))).toMatchObject({ backing: { mode: "stand_in" }, reason: "declared_schema" });
  });
  it("reads a choice that is not a mode as no choice", () => {
    expect(chooseSageMakerBacking(input({ maintainerChoice: "helper" as never, fixtures: recorded }))).toMatchObject({ backing: { mode: "canned" }, reason: "recorded_fixtures" });
  });
});

describe("what the company allows", () => {
  it("needs Rovara local AWS and fakes for fixtures and a stand-in", () => {
    expect(chooseSageMakerBacking(input({ fixtures: recorded, allowed: allowed({ emulated: false }) })).backing).toEqual({ mode: "none", reason: "nothing_available" });
    expect(chooseSageMakerBacking(input({ declaredSchema: schema, allowed: allowed({ fakes: false }) })).backing).toEqual({ mode: "none", reason: "nothing_available" });
  });
  it("lets a set that makes up answers through only where the company allows it, and marks it less safe", () => {
    const madeUp = { ...recorded, unmatched: "made_up" as const };
    const blocked = chooseSageMakerBacking(input({ fixtures: madeUp, allowed: allowed({ fakeMakesUpAnswers: false }), declaredSchema: schema }));
    // the stand-in builds its answers from a schema, which is making answers up too, so it is held back by the same setting
    expect(blocked.backing).toMatchObject({ mode: "canned", origin: "to_make" });
    expect(blocked.skipped.map((entry) => [entry.mode, entry.reason])).toEqual([["canned", "made_up_not_allowed"], ["stand_in", "stand_in_makes_up_not_allowed"]]);
    const allowedChoice = chooseSageMakerBacking(input({ fixtures: madeUp, allowed: allowed({ fakeMakesUpAnswers: true }) }));
    expect(allowedChoice).toMatchObject({ backing: { mode: "canned", unmatched: "made_up" }, lessSafe: true });
  });
  it("never throws on facts that are not what the types say", () => {
    expect(chooseSageMakerBacking(undefined as never)).toMatchObject({ backing: { mode: "none", reason: "nothing_available" }, lessSafe: true });
  });
});

describe("the pinned backing", () => {
  it("is a valid backing for each mode, and the words exist for every reason", () => {
    for (const choice of [chooseSageMakerBacking(input({ fixtures: recorded })), chooseSageMakerBacking(input({ declaredSchema: schema })), chooseSageMakerBacking(input({ maintainerChoice: "image", image, runnerAvailable: true, allowed: allowed({ projectImages: true }) }))]) {
      const pinned = pinnedSageMakerBacking(choice.backing);
      expect(SageMakerEndpointBackingSchema.safeParse(pinned).success).toBe(true);
    }
    for (const reason of SAGEMAKER_CHOICE_REASONS) expect(SAGEMAKER_CHOICE_REASON_WORDS[reason].length).toBeGreaterThan(10);
  });
});
