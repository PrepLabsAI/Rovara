// SageMaker endpoints (design: SageMaker endpoint shim, lane SM4): what backs ONE SageMaker endpoint in a test plan. Each endpoint name gets one backing, chosen at setup and pinned in the approved environment:
//   - `canned`   the SageMaker Runtime front of Rovara local AWS answers from a fixture document (`sagemaker-fixtures.ts`): recorded in the customer's own environment (`rovara record sagemaker`) or written by hand.
//                The default. Tests check how the service handles a reply; the real model is not run.
//   - `stand_in` a Rovara model stand-in (a small fake model server) answers with the shape of a schema the plan declares. For tests that need a live model server: timing, streaming, errors. The real model is not run.
//   - `image`    the customer's own inference image runs in the Rovara function runner (never the default: it is customer code, a project image, and a second person approves it).
// An endpoint with NO recording and no approved fixture has no backing at all. That is the default, and it is a NAMED SKIP, never a pass: the endpoint is named, the tests that need it are reported "not run" with the reason
// ("no recording of this endpoint's answers; the real model was not run"), and nothing answers in its place (`SAGEMAKER_DEFAULT_WITHOUT_RECORDING`, and the words in `sagemaker-words.ts`).
// The wire document for the front (`PUT /_rovara/sagemaker/endpoints/<name>`) is `sageMakerFrontDocument`; its `helper` mode is this file's `stand_in`.
// What the schema itself guarantees, so no builder has to remember it:
//   - an endpoint name is SageMaker's own (1 to 63 letters, digits and hyphens, not starting with a hyphen);
//   - a recorded set says when it was recorded and a set that is not recorded has no date; a set that makes up answers for requests it has no recording for says so (`unmatched: "made_up"`);
//   - a stand-in declares the shape of its answers and holds 64 to 128 MiB; an image names its architecture and memory, and the plan as a whole fits the memory one run has for models (`sageMakerPlanProblems`);
//   - an image endpoint is LESS-SAFE (customer code runs), and so are made-up answers (a canned set's default answer, and every answer of a stand-in: the company allows them), and nothing here is a secret.
// Nothing here imports a Node module.
import { z } from "zod";
import { SAGEMAKER_FIXTURE_LIMITS, SageMakerFixtureDocumentSchema, sageMakerDocumentMakesUpAnswers, sageMakerFixtureDigest, type SageMakerFixtureDocument } from "./sagemaker-fixtures.js";

/** What an endpoint with no recording and no approved fixture gets: nothing answers, and the tests that need it are reported as not run, by name, with the reason. Never a stand-in, and never a pass. */
export const SAGEMAKER_DEFAULT_WITHOUT_RECORDING = "not_run" as const;

/**
 * The model stand-in is PARKED (owner decision of 2026-11-12). The code that can choose it stays, but while this is true nothing chooses it: not a declared schema, not the company's made-up-answers setting, not a
 * maintainer's choice. A stand-in builds its answers from a schema, so a test that asserts on a value can pass by chance; recorded answers and a named skip are what a run offers instead. Turning this off is a
 * decision, with a new review of the false-green risk, not a setting. Typed as `boolean` so the branch it guards is kept, not removed as dead code.
 */
export const SAGEMAKER_STAND_IN_PARKED: boolean = true;

/**
 * What the SageMaker Runtime front answers, and writes in its request ledger, for a call to an endpoint that has no backing (no recording and no approved fixture). The front keeps this as a fixed contract so the worker
 * can tell "not run" from a failure:
 *   - the call gets HTTP 400, `X-Amzn-Errortype: ValidationError`, and the body `{"Message": "Rovara: no answer for endpoint <name>. No recording or fixture was approved for this endpoint, and the real model was not
 *     run. Nothing was made up. This test was NOT RUN: it did not pass and it did not fail."}`. Match a message on `SAGEMAKER_NO_ANSWER_MESSAGE_PREFIX`;
 *   - the ledger entry for the call (InvokeEndpoint, InvokeEndpointWithResponseStream and InvokeEndpointAsync alike, status 400) carries the marker `SAGEMAKER_NO_ANSWER_MARKER`. Match on `SAGEMAKER_NO_ANSWER_MARKER_PREFIX`,
 *     and key a test's "not run" state on the marker: a status or an error code alone also fits a real validation error;
 *   - the endpoint table shows the endpoint with backing mode `none`, the label "no answer", `faked: false` and a `noAnswer` counter;
 *   - a canned backing that has no rule matching a request is a different case and is unchanged: a ModelError whose marker is "<label>; unmatched".
 */
export const SAGEMAKER_NO_ANSWER_MESSAGE_PREFIX = "Rovara: no answer for endpoint ";
export const SAGEMAKER_NO_ANSWER_MARKER_PREFIX = "no-answer:";
export const SAGEMAKER_NO_ANSWER_MARKER = "no-answer: no recording for this endpoint";
export const SAGEMAKER_NO_ANSWER_STATUS = 400;

/** Whether a ledger entry's marker says the call found no answer for its endpoint: the marker, not the status or error code, is what says so. */
export const sageMakerLedgerMarkerIsNoAnswer = (marker: unknown): boolean => typeof marker === "string" && marker.startsWith(SAGEMAKER_NO_ANSWER_MARKER_PREFIX);

/** The endpoint named in the front's no-answer message, or undefined when the message is not that one (or the name is not an endpoint name). */
export function sageMakerNoAnswerEndpoint(message: unknown): string | undefined {
  if (typeof message !== "string" || !message.startsWith(SAGEMAKER_NO_ANSWER_MESSAGE_PREFIX)) return undefined;
  const name = /^([A-Za-z0-9](?:-*[A-Za-z0-9]){0,62})\./u.exec(message.slice(SAGEMAKER_NO_ANSWER_MESSAGE_PREFIX.length))?.[1];
  return name;
}

export const SAGEMAKER_BACKING_MODES = ["canned", "stand_in", "image"] as const;
export type SageMakerBackingMode = (typeof SAGEMAKER_BACKING_MODES)[number];
export const SAGEMAKER_CANNED_ORIGINS = ["recorded", "hand_written"] as const;
export const SAGEMAKER_IMAGE_ARCHITECTURES = ["arm64", "x86_64"] as const;

/** SageMaker's endpoint names (its own pattern): 1 to 63 letters, digits and hyphens, starting and ending with a letter or digit. */
export const SageMakerEndpointNameSchema = z.string().regex(/^[A-Za-z0-9](?:-*[A-Za-z0-9]){0,62}$/u, "a SageMaker endpoint name");

/**
 * What a detector saw that says a project uses SageMaker endpoints, as fixed words (never repository text): a Runtime client, a call, the SageMaker Python SDK's names, an endpoint declared in infrastructure code or
 * named in a setting, and the signs of a model the project could serve itself (a `model.tar.gz`, an `inference.py`, an inference image).
 */
export const SAGEMAKER_DETECTION_SIGNALS = ["runtime_client", "invoke_call", "predictor", "model_builder", "local_session", "endpoint_in_iac", "endpoint_name_setting", "model_archive", "inference_script", "inference_image"] as const;
export type SageMakerDetectionSignal = (typeof SAGEMAKER_DETECTION_SIGNALS)[number];

/** What a SageMaker endpoint may be asked, and what is spent on it. One place for every number the planner, the front and the evidence read. */
export const SAGEMAKER_ENDPOINT_LIMITS = {
  /** Endpoints one plan names. */
  endpoints: 16,
  /** A request or an answer, as SageMaker itself limits them. */
  requestBytes: 6 * 1_048_576,
  replyBytes: SAGEMAKER_FIXTURE_LIMITS.replyBytes,
  /** SageMaker's own answer time limit for a synchronous call; the function runner's image mode is held to it, not to the engine's 30 seconds. */
  answerSeconds: 60,
  /** The memory a stand-in holds, in MiB. */
  standInMemoryMiB: { min: 64, max: 128 },
  /** The memory an image may ask for, in MiB, and what is left for models in a run: the 3 GiB budget minus Rovara local AWS (512), the name helper (128) and a database (512). */
  imageMemoryMiB: { min: 256, max: 1_920 },
  modelMemoryBudgetMiB: 1_920,
  /** The largest declared schema (canonical JSON), in bytes. */
  declaredSchemaBytes: 16_384,
} as const;

const Sha256Hex = z.string().regex(/^[a-f0-9]{64}$/u);

/** A declared JSON Schema: a plain object, bounded in size and depth. The stand-in reads the subset the fixtures already use (type, properties, items, enum, format, bounds). */
const DeclaredSchemaSchema = z.record(z.string().max(128), z.unknown()).superRefine((schema, context) => {
  let text: string;
  try { text = JSON.stringify(schema); } catch { context.addIssue({ code: "custom", message: "a schema is JSON" }); return; }
  if (new TextEncoder().encode(text).length > SAGEMAKER_ENDPOINT_LIMITS.declaredSchemaBytes) context.addIssue({ code: "custom", message: "a schema is at most 16 KiB" });
  let depth = 0;
  let max = 0;
  for (const char of text) {
    if (char === "{" || char === "[") { depth += 1; max = Math.max(max, depth); } else if (char === "}" || char === "]") depth -= 1;
  }
  if (max > 32) context.addIssue({ code: "custom", message: "a schema is at most 32 levels deep" });
});

const CannedBackingSchema = z
  .object({
    mode: z.literal("canned"),
    origin: z.enum(SAGEMAKER_CANNED_ORIGINS),
    /** `sageMakerFixtureDigest` of the fixture document: the pin. */
    fixtureSetRef: Sha256Hex,
    /** When a recorded set was recorded (a date). */
    recordedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
    /** `fail`: a request nothing matches fails (the default). `made_up`: the document's default answers it; each such call is counted. */
    unmatched: z.enum(["fail", "made_up"]),
  })
  .strict();

const StandInBackingSchema = z
  .object({
    mode: z.literal("stand_in"),
    /** The shape of the stand-in's answers (`response`) and, optionally, of the requests it accepts (`request`). Declared by a maintainer or read from the project. */
    schema: z.object({ response: DeclaredSchemaSchema, request: DeclaredSchemaSchema.optional() }).strict(),
    memoryMiB: z.number().int().min(SAGEMAKER_ENDPOINT_LIMITS.standInMemoryMiB.min).max(SAGEMAKER_ENDPOINT_LIMITS.standInMemoryMiB.max),
  })
  .strict();

const ImageBackingSchema = z
  .object({
    mode: z.literal("image"),
    /** The approved project image that serves the model (`ProjectImageIdSchema`'s form). */
    imageId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
    architecture: z.enum(SAGEMAKER_IMAGE_ARCHITECTURES),
    memoryMiB: z.number().int().min(SAGEMAKER_ENDPOINT_LIMITS.imageMemoryMiB.min).max(SAGEMAKER_ENDPOINT_LIMITS.imageMemoryMiB.max),
    /** The digest of the approved `model.tar.gz` placed read-only under `/opt/ml/model`; absent when the image carries its model. */
    modelArchiveDigest: Sha256Hex.optional(),
  })
  .strict();

export const SageMakerEndpointBackingSchema = z
  .discriminatedUnion("mode", [CannedBackingSchema, StandInBackingSchema, ImageBackingSchema])
  .superRefine((backing, context) => {
    if (backing.mode !== "canned") return;
    if (backing.origin === "recorded" && backing.recordedOn === undefined) context.addIssue({ code: "custom", path: ["recordedOn"], message: "a recorded set says when it was recorded" });
    if (backing.origin !== "recorded" && backing.recordedOn !== undefined) context.addIssue({ code: "custom", path: ["recordedOn"], message: "only a recorded set has a recording date" });
  });
export type SageMakerEndpointBacking = z.infer<typeof SageMakerEndpointBackingSchema>;

/** One endpoint of a plan: its name and what backs it. */
export const SageMakerEndpointPlanEntrySchema = z.object({ endpointName: SageMakerEndpointNameSchema, backing: SageMakerEndpointBackingSchema }).strict();
export type SageMakerEndpointPlanEntry = z.infer<typeof SageMakerEndpointPlanEntrySchema>;

/** The memory one endpoint holds while the run lasts, in MiB (a canned endpoint holds none beyond the front). */
export function sageMakerBackingMemoryMiB(backing: SageMakerEndpointBacking): number {
  return backing.mode === "canned" ? 0 : backing.memoryMiB;
}

export type SageMakerPlanProblem = "too_many_endpoints" | "duplicate_endpoint" | "over_memory_budget";
export const SAGEMAKER_PLAN_PROBLEM_WORDS: Record<SageMakerPlanProblem, string> = {
  too_many_endpoints: "The plan names more SageMaker endpoints than one run holds.",
  duplicate_endpoint: "A SageMaker endpoint is named twice.",
  over_memory_budget: "The stand-in models and model images together need more memory than a run has for them.",
};

/** What is wrong with a plan's endpoints, in fixed words (an empty list: the plan fits). The planner refuses a plan over the memory cap rather than letting a run fail to start. */
export function sageMakerPlanProblems(entries: ReadonlyArray<Pick<SageMakerEndpointPlanEntry, "endpointName" | "backing">>, budgetMiB: number = SAGEMAKER_ENDPOINT_LIMITS.modelMemoryBudgetMiB): SageMakerPlanProblem[] {
  const problems: SageMakerPlanProblem[] = [];
  if (entries.length > SAGEMAKER_ENDPOINT_LIMITS.endpoints) problems.push("too_many_endpoints");
  if (new Set(entries.map((entry) => entry.endpointName)).size !== entries.length) problems.push("duplicate_endpoint");
  if (entries.reduce((sum, entry) => sum + sageMakerBackingMemoryMiB(entry.backing), 0) > budgetMiB) problems.push("over_memory_budget");
  return problems;
}

export const SageMakerEndpointPlanSchema = z.array(SageMakerEndpointPlanEntrySchema).max(SAGEMAKER_ENDPOINT_LIMITS.endpoints * 2).superRefine((entries, context) => {
  for (const problem of sageMakerPlanProblems(entries)) context.addIssue({ code: "custom", path: [], message: SAGEMAKER_PLAN_PROBLEM_WORDS[problem] });
});

/** Whether a backing is a LESS-SAFE choice (a second person approves it): customer code runs (an image), or answers are made up (a set that answers what it has no recording for, and a stand-in, which builds every answer from a schema). */
export function sageMakerBackingLessSafe(backing: SageMakerEndpointBacking): boolean {
  return backing.mode === "image" || backing.mode === "stand_in" || (backing.mode === "canned" && backing.unmatched === "made_up");
}

/** The refusals of a canned backing that does not describe the document it pins. Empty: the backing and the document agree. */
export function sageMakerCannedMismatches(backing: Extract<SageMakerEndpointBacking, { mode: "canned" }>, document: SageMakerFixtureDocument): string[] {
  const parsed = SageMakerFixtureDocumentSchema.safeParse(document);
  if (!parsed.success) return ["the fixture document is not one the front accepts"];
  const problems: string[] = [];
  if (sageMakerFixtureDigest(parsed.data) !== backing.fixtureSetRef) problems.push("the digest is not the document's");
  if ((parsed.data.source === "recorded") !== (backing.origin === "recorded")) problems.push("the origin is not the document's source");
  if (backing.origin === "recorded" && parsed.data.recordedOn !== undefined && !parsed.data.recordedOn.startsWith(backing.recordedOn ?? "")) problems.push("the recording date is not the document's");
  if (sageMakerDocumentMakesUpAnswers(parsed.data) !== (backing.unmatched === "made_up")) problems.push("the document's default answer and the unmatched rule disagree");
  return problems;
}

/**
 * The document the front reads for an endpoint's backing (`PUT /_rovara/sagemaker/endpoints/<name>`). A canned backing sends its fixture document (the caller passes it: the plan holds only its digest); a stand-in is the
 * front's `helper` mode; an image is `image`. The front answers an image endpoint "not available yet" until the function runner is there.
 */
export function sageMakerFrontDocument(backing: SageMakerEndpointBacking, fixtures?: SageMakerFixtureDocument): { mode: "canned" | "helper" | "image" } & Record<string, unknown> {
  if (backing.mode === "stand_in") return { mode: "helper" };
  if (backing.mode === "image") return { mode: "image" };
  const document = SageMakerFixtureDocumentSchema.parse(fixtures ?? {});
  return { ...document, mode: "canned", source: backing.origin === "recorded" ? "recorded" : "handwritten" };
}
