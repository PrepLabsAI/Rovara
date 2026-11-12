// SageMaker endpoints (design: SageMaker endpoint shim, lane SM4): what backs ONE SageMaker endpoint. Deterministic and pure, like `chooseBacking`: the same facts always give the same answer, and every word in it is fixed here.
//
// The order, and why:
//   1. tests that fake the endpoint themselves (`Stubber`, moto, vcr) win, and nothing is started; a maintainer may decline a backing;
//   2. a maintainer's choice is tried first, and must still be allowed and available;
//   3. by default: recorded or written fixtures (canned) when an approved set exists. Otherwise the endpoint is NOT RUN: it is named, the tests that need it are reported "not run" with the reason ("no recording of this
//      endpoint's answers; the real model was not run"), and nothing answers in its place. That is the default, and it reads as a skip, never a pass;
//   4. the customer's own image is NEVER the default. It runs only when a maintainer chose it, the company allows project images, an approved image exists, AND the function runner is there to run it;
//   5. the model stand-in is PARKED (`SAGEMAKER_STAND_IN_PARKED`, owner decision of 2026-11-12). Its branch is kept, but while it is parked nothing reaches it: not a declared schema, not the made-up-answers setting, not a
//      maintainer's choice. A stand-in builds its answers from a schema, so a test that asserts on a value could pass by chance.
// Canned answers are served by Rovara local AWS (the SageMaker Runtime front), so they need the emulator backing allowed; they are fakes, so they need fakes allowed. A set that makes up answers for requests it has no
// recording for needs the company's "fake makes up answers" setting, as for any fake, and so would a stand-in (it builds its answers from a declared schema).
import { SAGEMAKER_STAND_IN_PARKED, sageMakerNotRunLine, type SageMakerEndpointBacking, type SageMakerNotRunReason } from "@agentx/contracts";
import type { AllowedBackings } from "./backing-choice.js";

export type SageMakerChoiceMode = "canned" | "stand_in" | "image";

export interface SageMakerChoiceInput {
  /** The endpoint's name: a skip names it. */
  endpointName: string;
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
  | { mode: "stand_in"; schema: { response: Record<string, unknown>; request?: Record<string, unknown> | undefined }; memoryMiB: number }
  | { mode: "image"; imageId: string; architecture: "arm64" | "x86_64"; memoryMiB: number; modelArchiveDigest?: string | undefined }
  /** NOT RUN: nothing answers this endpoint, and the tests that need it are reported as not run, by name, with the reason. A skip, never a pass. */
  | { mode: "not_run"; reason: SageMakerNotRunReason }
  | { mode: "none"; reason: "declined" | "faked_by_tests" };

export const SAGEMAKER_CHOICE_REASONS = ["faked_by_tests", "maintainer_declined", "maintainer_choice", "recorded_fixtures", "written_fixtures", "declared_schema", "no_recording", "nothing_available"] as const;
export type SageMakerChoiceReason = (typeof SAGEMAKER_CHOICE_REASONS)[number];
export const SAGEMAKER_CHOICE_REASON_WORDS: Record<SageMakerChoiceReason, string> = {
  faked_by_tests: "Your tests fake this endpoint themselves, so Rovara starts nothing.",
  maintainer_declined: "A maintainer chose to run without it.",
  maintainer_choice: "A maintainer chose this.",
  recorded_fixtures: "Recorded answers exist for this endpoint.",
  written_fixtures: "Written answers exist for this endpoint.",
  declared_schema: "No recording exists, and a schema is declared, so a stand-in model answers. (Parked: nothing chooses this while the stand-in is parked.)",
  no_recording: "No recording of this endpoint's answers exists, so it is not run: the real model was not run, and the tests that need it are listed by name.",
  nothing_available: "Nothing that is allowed and available backs this endpoint, so it is not run: the real model was not run.",
};

export const SAGEMAKER_SKIP_REASONS = ["not_allowed", "no_fixtures", "made_up_not_allowed", "stand_in_parked", "stand_in_makes_up_not_allowed", "no_schema", "no_image", "no_runner"] as const;
export type SageMakerSkipReason = (typeof SAGEMAKER_SKIP_REASONS)[number];
export const SAGEMAKER_SKIP_REASON_WORDS: Record<SageMakerSkipReason, string> = {
  not_allowed: "The company or the project does not allow this kind of backing.",
  no_fixtures: "No approved fixture set exists for this endpoint.",
  made_up_not_allowed: "The only fixture set makes up answers, and the company does not allow that.",
  stand_in_parked: "The model stand-in is parked: nothing chooses it for now.",
  stand_in_makes_up_not_allowed: "A stand-in builds its answers from a schema, which is making up answers, and the company does not allow that.",
  no_schema: "No schema is declared for this endpoint's answers.",
  no_image: "No approved project image serves this endpoint's model.",
  no_runner: "The Rovara function runner is not available, and a model image needs it.",
};

export interface SageMakerChoice {
  backing: SageMakerChosen;
  reason: SageMakerChoiceReason;
  words: string;
  /** For a skipped endpoint: the named line the pull request carries, with the reason (`SageMaker endpoint X: not run (...)`). */
  statement?: string;
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

function standInStep(input: SageMakerChoiceInput, parked: boolean): Step {
  // PARKED: while it is, this is the first thing the step asks, so nothing below it can be reached.
  if (parked) return { skip: "stand_in_parked" };
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

const STEPS: Record<SageMakerChoiceMode, (input: SageMakerChoiceInput, parked: boolean) => Step> = { canned: cannedStep, stand_in: standInStep, image: imageStep };

/** What backs one SageMaker endpoint, with the reason in fixed words and every mode passed over. Never throws: facts that are not what the types say leave nothing backing the endpoint, and the answer says so. */
export function chooseSageMakerBacking(input: SageMakerChoiceInput, options: { standInParked?: boolean } = {}): SageMakerChoice {
  try {
    return choose(input, options.standInParked ?? SAGEMAKER_STAND_IN_PARKED);
  } catch {
    return notRun(String(typeof input === "object" && input !== null ? (input as { endpointName?: unknown }).endpointName : ""), "could_not_decide", "nothing_available", []);
  }
}

/** A named skip: nothing answers, nothing is run, and the line says which endpoint and why. */
function notRun(endpointName: string, reason: SageMakerNotRunReason, why: SageMakerChoiceReason, skipped: SageMakerChoice["skipped"]): SageMakerChoice {
  return { backing: { mode: "not_run", reason }, reason: why, words: SAGEMAKER_CHOICE_REASON_WORDS[why], statement: sageMakerNotRunLine(endpointName, reason), skipped, lessSafe: false };
}

function choose(input: SageMakerChoiceInput, parked: boolean): SageMakerChoice {
  const done = (backing: SageMakerChosen, reason: SageMakerChoiceReason, skipped: SageMakerChoice["skipped"]): SageMakerChoice => ({
    backing, reason, words: SAGEMAKER_CHOICE_REASON_WORDS[reason], skipped,
    lessSafe: backing.mode === "image" || backing.mode === "stand_in" || (backing.mode === "canned" && backing.unmatched === "made_up") || (backing.mode === "none" && backing.reason !== "faked_by_tests"),
  });
  if (input.fakedByTests === true) return done({ mode: "none", reason: "faked_by_tests" }, "faked_by_tests", []);
  if (input.maintainerChoice === "none") return done({ mode: "none", reason: "declined" }, "maintainer_declined", []);
  const skipped: SageMakerChoice["skipped"] = [];
  const tryMode = (mode: SageMakerChoiceMode, asChoice: boolean): SageMakerChoice | undefined => {
    const found = STEPS[mode](input, parked);
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
  // Nothing approved to answer: the endpoint is NOT RUN, by name, with the reason. Fakes not being allowed at all is a different reason from there being no recording.
  const fakesAllowed = input.allowed.emulated === true && input.allowed.fakes === true;
  return notRun(input.endpointName, fakesAllowed ? "no_recording" : "not_allowed", fakesAllowed ? "no_recording" : "nothing_available", skipped);
}

/** The pinned backing a chosen mode becomes, or undefined while nothing is there to pin (a set still to be made, no backing at all). The caller supplies a stand-in or image's facts only through the choice. */
export function pinnedSageMakerBacking(chosen: SageMakerChosen): SageMakerEndpointBacking | undefined {
  if (chosen.mode === "none" || chosen.mode === "not_run") return undefined;
  if (chosen.mode === "canned") return { mode: "canned", origin: chosen.origin, fixtureSetRef: chosen.fixtureSetRef, ...(chosen.recordedOn === undefined ? {} : { recordedOn: chosen.recordedOn }), unmatched: chosen.unmatched };
  if (chosen.mode === "stand_in") return { mode: "stand_in", schema: { response: chosen.schema.response, ...(chosen.schema.request === undefined ? {} : { request: chosen.schema.request }) }, memoryMiB: chosen.memoryMiB };
  return { mode: "image", imageId: chosen.imageId, architecture: chosen.architecture, memoryMiB: chosen.memoryMiB, ...(chosen.modelArchiveDigest === undefined ? {} : { modelArchiveDigest: chosen.modelArchiveDigest }) };
}
