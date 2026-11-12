// SageMaker endpoints (design: SageMaker endpoint shim, lane SM4): what backs ONE SageMaker endpoint. Deterministic and pure, like `chooseBacking`: the same facts always give the same answer, and every word in it is fixed here.
//
// The order, and why:
//   1. tests that fake the endpoint themselves (`Stubber`, moto, vcr) win, and nothing is started; a maintainer may decline a backing;
//   2. a maintainer's choice is tried first, and must still be allowed and available;
//   3. by default: recorded or written fixtures (canned) when an approved set exists; else a stand-in when the plan declares a schema; else canned with a set to be written (nothing answers until it is);
//   4. the customer's own image is NEVER the default. It runs only when a maintainer chose it, the company allows project images, an approved image exists, AND the function runner is there to run it.
// Canned answers and a stand-in are served by Rovara local AWS (the SageMaker Runtime front), so they need the emulator backing allowed; both are fakes, so they need fakes allowed. A set that makes up answers for requests it
// has no recording for needs the company's "fake makes up answers" setting, as for any fake, and so does a stand-in (it builds its answers from a declared schema).
import type { SageMakerEndpointBacking } from "@agentx/contracts";
import type { AllowedBackings } from "./backing-choice.js";

export type SageMakerChoiceMode = "canned" | "stand_in" | "image";

export interface SageMakerChoiceInput {
  /** Tests fake the endpoint themselves (D6): nothing is started. */
  fakedByTests?: boolean | undefined;
  /** A maintainer's choice of mode, or `none` to run without the endpoint. */
  maintainerChoice?: SageMakerChoiceMode | "none" | undefined;
  /** An approved fixture set for the endpoint (the caller passes an approved one only). */
  fixtures?: { ref: string; origin: "recorded" | "hand_written"; recordedOn?: string | undefined; unmatched: "fail" | "made_up" } | undefined;
  /** A schema declared for the endpoint's answers (a maintainer's, or read from the project). */
  declaredSchema?: { response: Record<string, unknown>; request?: Record<string, unknown> | undefined } | undefined;
  /** An approved project image that serves the model, when one was found and approved. */
  image?: { imageId: string; architecture: "arm64" | "x86_64"; memoryMiB: number; modelArchiveDigest?: string | undefined } | undefined;
  /** The Rovara function runner is available for this run (it is not yet in every environment). */
  runnerAvailable: boolean;
  allowed: AllowedBackings;
}

export type SageMakerChosen =
  | { mode: "canned"; origin: "recorded" | "hand_written"; fixtureSetRef: string; recordedOn?: string | undefined; unmatched: "fail" | "made_up" }
  /** No approved set exists: a person or the agent writes one (or records one), and nothing answers until then. */
  | { mode: "canned"; origin: "to_make" }
  | { mode: "stand_in"; schema: { response: Record<string, unknown>; request?: Record<string, unknown> | undefined }; memoryMiB: number }
  | { mode: "image"; imageId: string; architecture: "arm64" | "x86_64"; memoryMiB: number; modelArchiveDigest?: string | undefined }
  | { mode: "none"; reason: "declined" | "faked_by_tests" | "nothing_available" };

export const SAGEMAKER_CHOICE_REASONS = ["faked_by_tests", "maintainer_declined", "maintainer_choice", "recorded_fixtures", "written_fixtures", "declared_schema", "fixtures_to_make", "nothing_available"] as const;
export type SageMakerChoiceReason = (typeof SAGEMAKER_CHOICE_REASONS)[number];
export const SAGEMAKER_CHOICE_REASON_WORDS: Record<SageMakerChoiceReason, string> = {
  faked_by_tests: "Your tests fake this endpoint themselves, so Rovara starts nothing.",
  maintainer_declined: "A maintainer chose to run without it.",
  maintainer_choice: "A maintainer chose this.",
  recorded_fixtures: "Recorded answers exist for this endpoint.",
  written_fixtures: "Written answers exist for this endpoint.",
  declared_schema: "No recording exists, and a schema is declared, so a stand-in model answers.",
  fixtures_to_make: "No recording and no schema exist: answers have to be recorded or written before anything answers.",
  nothing_available: "Nothing that is allowed and available backs this endpoint.",
};

export const SAGEMAKER_SKIP_REASONS = ["not_allowed", "no_fixtures", "made_up_not_allowed", "stand_in_makes_up_not_allowed", "no_schema", "no_image", "no_runner"] as const;
export type SageMakerSkipReason = (typeof SAGEMAKER_SKIP_REASONS)[number];
export const SAGEMAKER_SKIP_REASON_WORDS: Record<SageMakerSkipReason, string> = {
  not_allowed: "The company or the project does not allow this kind of backing.",
  no_fixtures: "No approved fixture set exists for this endpoint.",
  made_up_not_allowed: "The only fixture set makes up answers, and the company does not allow that.",
  stand_in_makes_up_not_allowed: "A stand-in builds its answers from a schema, which is making up answers, and the company does not allow that.",
  no_schema: "No schema is declared for this endpoint's answers.",
  no_image: "No approved project image serves this endpoint's model.",
  no_runner: "The Rovara function runner is not available, and a model image needs it.",
};

export interface SageMakerChoice {
  backing: SageMakerChosen;
  reason: SageMakerChoiceReason;
  words: string;
  /** Every mode tried and passed over before the answer, each with its fixed reason. */
  skipped: Array<{ mode: SageMakerChoiceMode; reason: SageMakerSkipReason; words: string }>;
  /** A second person approves: customer code runs (an image), or answers are made up (a set with a default answer, or a stand-in). */
  lessSafe: boolean;
}

type Step = { pick: SageMakerChosen; reason: SageMakerChoiceReason } | { skip: SageMakerSkipReason };

const STAND_IN_MEMORY_MIB = 128;

function cannedStep(input: SageMakerChoiceInput): Step {
  if (input.allowed.emulated !== true || input.allowed.fakes !== true) return { skip: "not_allowed" };
  const set = input.fixtures;
  if (set === undefined) return { skip: "no_fixtures" };
  if (set.unmatched === "made_up" && input.allowed.fakeMakesUpAnswers !== true) return { skip: "made_up_not_allowed" };
  return { pick: { mode: "canned", origin: set.origin, fixtureSetRef: set.ref, ...(set.recordedOn === undefined ? {} : { recordedOn: set.recordedOn }), unmatched: set.unmatched }, reason: set.origin === "recorded" ? "recorded_fixtures" : "written_fixtures" };
}

function standInStep(input: SageMakerChoiceInput): Step {
  if (input.allowed.emulated !== true || input.allowed.fakes !== true) return { skip: "not_allowed" };
  if (input.declaredSchema === undefined) return { skip: "no_schema" };
  // A stand-in that builds its answers from a schema IS making up answers (the same choice as a fake with `schema_synth`), so it needs the company's setting for it.
  if (input.allowed.fakeMakesUpAnswers !== true) return { skip: "stand_in_makes_up_not_allowed" };
  return { pick: { mode: "stand_in", schema: input.declaredSchema, memoryMiB: STAND_IN_MEMORY_MIB }, reason: "declared_schema" };
}

function imageStep(input: SageMakerChoiceInput): Step {
  if (input.allowed.projectImages !== true) return { skip: "not_allowed" };
  if (input.image === undefined) return { skip: "no_image" };
  if (!input.runnerAvailable) return { skip: "no_runner" };
  const { imageId, architecture, memoryMiB, modelArchiveDigest } = input.image;
  return { pick: { mode: "image", imageId, architecture, memoryMiB, ...(modelArchiveDigest === undefined ? {} : { modelArchiveDigest }) }, reason: "maintainer_choice" };
}

const STEPS: Record<SageMakerChoiceMode, (input: SageMakerChoiceInput) => Step> = { canned: cannedStep, stand_in: standInStep, image: imageStep };

/** What backs one SageMaker endpoint, with the reason in fixed words and every mode passed over. Never throws: facts that are not what the types say leave nothing backing the endpoint, and the answer says so. */
export function chooseSageMakerBacking(input: SageMakerChoiceInput): SageMakerChoice {
  try {
    return choose(input);
  } catch {
    return { backing: { mode: "none", reason: "nothing_available" }, reason: "nothing_available", words: SAGEMAKER_CHOICE_REASON_WORDS.nothing_available, skipped: [], lessSafe: true };
  }
}

function choose(input: SageMakerChoiceInput): SageMakerChoice {
  const done = (backing: SageMakerChosen, reason: SageMakerChoiceReason, skipped: SageMakerChoice["skipped"]): SageMakerChoice => ({
    backing, reason, words: SAGEMAKER_CHOICE_REASON_WORDS[reason], skipped,
    lessSafe: backing.mode === "image" || backing.mode === "stand_in" || (backing.mode === "canned" && backing.origin !== "to_make" && backing.unmatched === "made_up") || (backing.mode === "none" && backing.reason !== "faked_by_tests"),
  });
  if (input.fakedByTests === true) return done({ mode: "none", reason: "faked_by_tests" }, "faked_by_tests", []);
  if (input.maintainerChoice === "none") return done({ mode: "none", reason: "declined" }, "maintainer_declined", []);
  const skipped: SageMakerChoice["skipped"] = [];
  const tryMode = (mode: SageMakerChoiceMode, asChoice: boolean): SageMakerChoice | undefined => {
    const found = STEPS[mode](input);
    if ("pick" in found) return done(found.pick, asChoice ? "maintainer_choice" : found.reason, skipped);
    skipped.push({ mode, reason: found.skip, words: SAGEMAKER_SKIP_REASON_WORDS[found.skip] });
    return undefined;
  };
  // A maintainer's choice that is not a mode (a typo) is not tried; the default order applies.
  const asked: unknown = input.maintainerChoice;
  const choice = (["canned", "stand_in", "image"] as const).find((mode) => mode === asked);
  if (choice !== undefined) {
    const chosen = tryMode(choice, true);
    if (chosen !== undefined) return chosen;
  }
  // The default order. The image is not in it.
  for (const mode of ["canned", "stand_in"] as const) {
    if (mode === choice) continue;
    const chosen = tryMode(mode, false);
    if (chosen !== undefined) return chosen;
  }
  // Nothing approved or declared: fixtures to be made, when fakes are allowed at all.
  if (input.allowed.emulated === true && input.allowed.fakes === true) return done({ mode: "canned", origin: "to_make" }, "fixtures_to_make", skipped);
  return done({ mode: "none", reason: "nothing_available" }, "nothing_available", skipped);
}

/** The pinned backing a chosen mode becomes, or undefined while nothing is there to pin (a set still to be made, no backing at all). The caller supplies a stand-in or image's facts only through the choice. */
export function pinnedSageMakerBacking(chosen: SageMakerChosen): SageMakerEndpointBacking | undefined {
  if (chosen.mode === "none") return undefined;
  if (chosen.mode === "canned") return chosen.origin === "to_make" ? undefined : { mode: "canned", origin: chosen.origin, fixtureSetRef: chosen.fixtureSetRef, ...(chosen.recordedOn === undefined ? {} : { recordedOn: chosen.recordedOn }), unmatched: chosen.unmatched };
  if (chosen.mode === "stand_in") return { mode: "stand_in", schema: { response: chosen.schema.response, ...(chosen.schema.request === undefined ? {} : { request: chosen.schema.request }) }, memoryMiB: chosen.memoryMiB };
  return { mode: "image", imageId: chosen.imageId, architecture: chosen.architecture, memoryMiB: chosen.memoryMiB, ...(chosen.modelArchiveDigest === undefined ? {} : { modelArchiveDigest: chosen.modelArchiveDigest }) };
}
