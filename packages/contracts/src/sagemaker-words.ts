// SageMaker endpoints (design: SageMaker endpoint shim, lane SM4): the words people read about a SageMaker endpoint's backing: the evidence line a pull request carries, the label the evidence tab shows, and the text of the
// setup card that asks a maintainer to approve the choice. Every word is fixed here. Nothing a repository or a person wrote is echoed except an endpoint name that passed SageMaker's own name pattern; anything else is
// shown as "(unnamed)". Pure, and nothing here imports a Node module.
//
// An endpoint with no recording and no approved fixture is NOT RUN, by name, and says why; this is the default and it reads as a skip, never a pass:
//   SageMaker endpoint <name>: not run (no recording of this endpoint's answers; the real model was not run)
// The three evidence lines (the endpoint name stands in for <name>):
//   SageMaker endpoint <name>: answered by recorded fixtures (faked)
//   SageMaker endpoint <name>: answered by a stand-in model (faked; the real model was not run)
//   SageMaker endpoint <name>: answered by your model image in the Rovara function runner
// A canned set that a person wrote (not recorded) says "hand-written fixtures", because "recorded" would be untrue.
import type { EvidenceDependencyLabel } from "./evidence.js";
import { SageMakerEndpointNameSchema, type SageMakerBackingMode } from "./sagemaker-endpoint.js";

/** What answered the endpoint, in fixed words. */
export const SAGEMAKER_ANSWERED_BY_WORDS = {
  not_run: "not run (no recording of this endpoint's answers; the real model was not run)",
  recorded: "answered by recorded fixtures (faked)",
  hand_written: "answered by hand-written fixtures (faked)",
  stand_in: "answered by a stand-in model (faked; the real model was not run)",
  image: "answered by your model image in the Rovara function runner",
} as const;
export type SageMakerAnsweredBy = keyof typeof SAGEMAKER_ANSWERED_BY_WORDS;

/** The kind of answer a backing gives: a canned set is `recorded` or `hand_written`, the others are their mode. */
export function sageMakerAnsweredBy(backing: { mode: "canned"; origin: "recorded" | "hand_written" } | { mode: Exclude<SageMakerBackingMode, "canned"> }): SageMakerAnsweredBy {
  return backing.mode === "canned" ? backing.origin : backing.mode;
}

/** Why an endpoint is not run. Fixed words; the endpoint is named by the line that carries them. */
export const SAGEMAKER_NOT_RUN_REASONS = ["no_recording", "not_allowed", "could_not_decide"] as const;
export type SageMakerNotRunReason = (typeof SAGEMAKER_NOT_RUN_REASONS)[number];
export const SAGEMAKER_NOT_RUN_REASON_WORDS: Record<SageMakerNotRunReason, string> = {
  no_recording: "no recording of this endpoint's answers; the real model was not run",
  not_allowed: "the company does not allow a fake here and nothing else backs it; the real model was not run",
  could_not_decide: "what backs this endpoint could not be decided; the real model was not run",
};

/** The named skip of one endpoint: `SageMaker endpoint fraud-scorer: not run (no recording of this endpoint's answers; the real model was not run)`. */
export const sageMakerNotRunLine = (endpointName: string, reason: SageMakerNotRunReason = "no_recording"): string => `SageMaker endpoint ${name(endpointName)}: not run (${SAGEMAKER_NOT_RUN_REASON_WORDS[reason]})`;

const name = (endpointName: string): string => (SageMakerEndpointNameSchema.safeParse(endpointName).success ? endpointName : "(unnamed)");
const calls = (count: number): string => `${String(count)} ${count === 1 ? "call" : "calls"}`;

export interface SageMakerEvidenceFacts {
  endpointName: string;
  answeredBy: SageMakerAnsweredBy;
  /** `recorded`: the date it was recorded (YYYY-MM-DD). */
  recordedOn?: string | undefined;
  /** The ledger's counts for the endpoint, when the run's record was read. */
  usage?: { calls: number; unmatched: number; madeUp: number } | undefined;
  /** `image`: an x86_64 image on an arm64 host runs under emulation. */
  emulatedArchitecture?: boolean | undefined;
}

/** The evidence line of one SageMaker endpoint: the base words, then what the run adds (when it was recorded, how many calls matched, how many were made up). */
export function sageMakerEvidenceLine(facts: SageMakerEvidenceFacts): string {
  if (facts.answeredBy === "not_run") return sageMakerNotRunLine(facts.endpointName);
  const base = `SageMaker endpoint ${name(facts.endpointName)}: ${SAGEMAKER_ANSWERED_BY_WORDS[facts.answeredBy]}`;
  const more: string[] = [];
  if (facts.answeredBy === "recorded" && facts.recordedOn !== undefined && /^\d{4}-\d{2}-\d{2}$/u.test(facts.recordedOn)) more.push(`Recorded on ${facts.recordedOn} in your environment.`);
  if (facts.usage !== undefined) {
    const { calls: total, unmatched, madeUp } = facts.usage;
    more.push(unmatched === 0 && madeUp === 0 ? `${calls(total)}, all matched.` : `${calls(total)}, ${String(unmatched)} with no matching answer.`);
    if (madeUp > 0) more.push(`${calls(madeUp)} got a made-up answer.`);
  }
  if (facts.answeredBy === "image") {
    more.push("Model output is real; SageMaker hosting (instance type, scaling, GPU) was not tested.");
    if (facts.emulatedArchitecture === true) more.push("An x86_64 image ran under emulation on arm64 (about 10 to 30 times slower).");
  } else if (facts.answeredBy !== "stand_in") more.push("The real model was not run.");
  return `${base}${more.length === 0 ? "" : `. ${more.join(" ")}`}`;
}

/** The label the evidence tab shows for an endpoint's dependency row (`EvidenceDependencyLabel`): fixtures are a recorded or hand-written fake, a stand-in is a hand-written fake, an image is the project's own image. */
export function sageMakerEvidenceLabel(answeredBy: SageMakerAnsweredBy): EvidenceDependencyLabel {
  if (answeredBy === "not_run") return "not_available";
  return answeredBy === "recorded" ? "recorded_fake" : answeredBy === "image" ? "real_project_image" : "hand_written_fake";
}

// ---- the setup card

export type SageMakerCardRisk = "medium" | "high";
export interface SageMakerCardText {
  title: string;
  /** One paragraph: what will answer, and what is not tested. */
  summary: string;
  /** What a person decides, and what each answer means. */
  lines: string[];
  /** `high` when customer code runs or answers are made up, a stand-in's included (a second person approves). */
  risk: SageMakerCardRisk;
}

export const SAGEMAKER_CARD_SUMMARY: Record<SageMakerAnsweredBy, string> = {
  not_run: "Nothing answers this endpoint, because no recording of its answers exists. Tests that need it are not run, and the pull request lists them by name with the reason. Tests that fake the endpoint themselves run as normal. To run the rest, record the endpoint's answers with `rovara record sagemaker` in your own environment.",
  recorded: "Your tests get the answers recorded from your real endpoint, in your own environment, with personal data checked for before the file was written. The real model is not run.",
  hand_written: "Your tests get the answers written in a fixture file. The real model is not run. Rovara's agent can write the file for you, or you can record it from your real endpoint with `rovara record sagemaker`.",
  stand_in: "A small Rovara model server answers with the shape of the schema you declared. It runs no model: tests that check how your service handles a reply, a slow reply, a stream or an error work; tests that check what the model says do not.",
  image: "Your own inference image runs in the Rovara function runner, in a sandbox with no network, so tests see real model output. SageMaker hosting (instance type, scaling, GPU) is not tested. A second person approves an image before it runs.",
};

export const SAGEMAKER_CARD_NOT_TESTED = "Not tested: SageMaker hosting (instance type, scaling, GPU) and, for fixtures and a stand-in, the real model's behaviour.";

/** The text of the card for one endpoint. Fixed words and the endpoint's name only. `madeUp`: the fixture set answers requests it has no recording for. */
export function sageMakerCardText(input: { endpointName: string; answeredBy: SageMakerAnsweredBy; madeUp?: boolean | undefined }): SageMakerCardText {
  const endpoint = name(input.endpointName);
  const risk: SageMakerCardRisk = input.answeredBy === "image" || input.answeredBy === "stand_in" || input.madeUp === true ? "high" : "medium";
  const lines = [
    input.answeredBy === "not_run" ? sageMakerNotRunLine(input.endpointName) : `Endpoint ${endpoint}: ${SAGEMAKER_ANSWERED_BY_WORDS[input.answeredBy]}.`,
    input.answeredBy === "not_run" ? "The pull request lists the tests that were not run, by name, with this reason. Nothing here counts as a pass." : input.madeUp === true ? "A request with no recording gets a made-up answer. Each one is counted and shown in the evidence. A second person approves this." : input.answeredBy === "stand_in" ? "Every answer is built from the schema, which is making up answers. A second person approves this." : input.answeredBy === "image" ? "A second person approves the image and its model file." : "A request with no recording fails, and the failure is shown in the evidence.",
    SAGEMAKER_CARD_NOT_TESTED,
  ];
  return { title: `SageMaker endpoint ${endpoint}`, summary: SAGEMAKER_CARD_SUMMARY[input.answeredBy], lines, risk };
}
