// Device testing slice 1 (DEC 244; plan: rovara-research briefs/device-testing-plan-2026-11-16.md), the pure half. For a mobile-app change Rovara builds the app on the base code and on the
// candidate, runs named flows on a device, and attaches one masked screenshot per named step, before and after, to the evidence. This file holds what every side agrees on: the project
// setting (off by default), the recipe, which changed flows are picked, the view-tree mask plan, the caps, the fixed words, the evidence-pack check and the pull request's lines.
// Visual evidence only: the check's kind is `visual`, which never counts toward the change proof, and a fake device is never a real run (its labels say so).
// It shares browser evidence's text masks (browser-evidence.ts) instead of copying them. Browser-safe and pure: nothing here imports a Node module.
import { z } from "zod";
import { scrubVisibleText } from "./browser-evidence.js";
import { ArtifactRefSchema, EVIDENCE_ARTIFACT_MAX_BYTES, EVIDENCE_CHECKS_MAX, EVIDENCE_NOT_TESTED_MAX, type ArtifactRef, type EvidenceCheckV2, type EvidencePackV2 } from "./evidence.js";
import { matchPolicyGlob, validPolicyPath, POLICY_PATTERN_MAX } from "./policy-glob.js";

// ---- the setting

/** The project setting (a row of the policy registry, `POLICY_FIELDS`): `off` today and in every preset; only an explicit `on` runs anything. Its own switch, not browser evidence's. */
export const DEVICE_EVIDENCE_SETTING = "device_evidence";
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether a resolved policy turns device evidence on. Fails closed: anything but a `resolved` policy whose own value for the setting is exactly `on` is off. */
export function deviceEvidenceOn(policy: unknown): boolean {
  if (!isRecord(policy) || policy["status"] !== "resolved" || !isRecord(policy["values"])) return false;
  const values = policy["values"];
  if (!Object.hasOwn(values, DEVICE_EVIDENCE_SETTING)) return false;
  const row = values[DEVICE_EVIDENCE_SETTING];
  return isRecord(row) && row["value"] === "on";
}

// ---- caps

/** One screenshot: the pack's own JPEG cap (the same as the e2e capture and browser evidence). */
export const DEVICE_EVIDENCE_SCREENSHOT_MAX_BYTES = EVIDENCE_ARTIFACT_MAX_BYTES.jpeg;
/** Everything one run keeps, before and after together (plan 4.1). */
export const DEVICE_EVIDENCE_TOTAL_MAX_BYTES = 8 * 1_048_576;
/** Flows one run shows, steps in each, and so the steps one run can have. */
export const DEVICE_EVIDENCE_FLOWS_MAX = 5;
export const DEVICE_EVIDENCE_STEPS_MAX = 6;
export const DEVICE_EVIDENCE_RUN_STEPS_MAX = DEVICE_EVIDENCE_FLOWS_MAX * DEVICE_EVIDENCE_STEPS_MAX;
/** Changed files read to pick flows; a longer list is refused whole, never cut. */
export const DEVICE_EVIDENCE_CHANGED_FILES_MAX = 2_000;
/** Glob-matching work one pick may do (the matcher's own step count); more is refused whole. */
export const DEVICE_EVIDENCE_MATCH_STEPS_MAX = 10_000_000;
/** Flows listed as "not shown"; the rest are counted. */
export const DEVICE_EVIDENCE_NOT_SHOWN_MAX = 20;
/**
 * One run, build and device start included, and one step. A device is slower than a page (plan 2.3: an emulator starts in 30 to 90 s cold). Starting values, to be measured in slice 2.
 */
export const DEVICE_EVIDENCE_RUN_MS = 600_000;
export const DEVICE_EVIDENCE_STEP_MS = 30_000;
/** A frame the executor will paint and encode: pixels, so at most 8 million (a 1080 x 2400 phone is 2.6 million). */
export const DEVICE_EVIDENCE_FRAME_PIXELS_MAX = 8_000_000;
/** A view tree the plan will scan: nodes, each text field, and all the text together. A longer one is not scanned: the screen is withheld. */
export const DEVICE_EVIDENCE_TREE_NODES_MAX = 5_000;
export const DEVICE_EVIDENCE_TREE_TEXT_MAX = 10_000;
export const DEVICE_EVIDENCE_TREE_TEXT_TOTAL_MAX = 500_000;
/** The painted rectangles of one screen may cover at most this many times the frame (overlaps counted): over it, painting is not bounded and the screen is withheld. */
export const DEVICE_EVIDENCE_PAINT_AREA_FACTOR = 4;

// ---- the recipe

const NO_HIDDEN = /^[^\p{Cc}\p{Cf}]*$/u;
const line = (max: number) => z.string().min(1).max(max).regex(NO_HIDDEN, "one plain line");
/** A flow or step id: a short plain name (it is part of a pair's id). */
const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/u;
const NameSchema = z.string().regex(NAME, "a short lower-case name");
/** A path inside the project: relative, no `.` or `..` or empty segment, no backslash, at most 200 characters. */
function relativeProjectPath(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 200 && NO_HIDDEN.test(value) && !value.startsWith("/") && !value.includes("\\")
    && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
const GlobSchema = z.string().refine((value) => validPolicyPath(value, POLICY_PATTERN_MAX), "a repository glob");
export const DEVICE_EVIDENCE_RECIPE_FLOWS_MAX = 50;
/** What one step may do before its picture (slice 2: written into a Maestro flow by the executor, never taken from the repository). */
export const DEVICE_EVIDENCE_ACTIONS_MAX = 10;
export const DEVICE_EVIDENCE_ACTION_TEXT_MAX = 200;
const ActionTextSchema = line(DEVICE_EVIDENCE_ACTION_TEXT_MAX);
/**
 * One thing a step does, from a short fixed list (the driver turns each into one Maestro command; nothing here is Maestro's own syntax, so a recipe cannot run a script, open a link or reach
 * another app). `text` and `id` are matched exactly as written. `input` types fixture text, so it never holds a real secret: what it types is masked on the picture like any other text.
 */
export const DeviceEvidenceActionSchema = z.discriminatedUnion("do", [
  z.object({ do: z.literal("tap_text"), text: ActionTextSchema }).strict(),
  z.object({ do: z.literal("tap_id"), id: ActionTextSchema }).strict(),
  z.object({ do: z.literal("input"), text: ActionTextSchema }).strict(),
  z.object({ do: z.literal("wait_text"), text: ActionTextSchema }).strict(),
  z.object({ do: z.literal("wait_id"), id: ActionTextSchema }).strict(),
  z.object({ do: z.literal("scroll") }).strict(),
  z.object({ do: z.literal("back") }).strict(),
  z.object({ do: z.literal("hide_keyboard") }).strict(),
]);
export type DeviceEvidenceAction = z.infer<typeof DeviceEvidenceActionSchema>;
/** An Android application id (package name): dotted words, at least two. */
export const DEVICE_EVIDENCE_APP_ID = /^[A-Za-z][A-Za-z0-9_]{0,63}(?:\.[A-Za-z][A-Za-z0-9_]{0,63}){1,8}$/u;
export const DEVICE_EVIDENCE_MASK_IDS_MAX = 20;
export const DEVICE_EVIDENCE_PLATFORMS = ["android", "ios"] as const;

/**
 * How Rovara shows a project's mobile flows: the platform, the project's own build command and the app file it makes, and the flows (a named list of steps, with the repository files that
 * make each one). `maskIds` name extra elements (an Android resource id, an iOS accessibility identifier) to paint over. `fixtureDataOnly` is an admin's choice to show a screen Rovara cannot
 * read a tree for, unmasked, because the app runs on fixture data only. Kept in Rovara's settings, never in the repository. What a step does before its picture is its `actions` (slice 2: the emulator driver writes them as a Maestro flow).
 */
export const DeviceEvidenceRecipeSchema = z.object({
  platform: z.enum(DEVICE_EVIDENCE_PLATFORMS),
  buildCommand: line(500),
  appFile: z.string().refine(relativeProjectPath, "a path inside the project"),
  /** The app's Android application id; the emulator driver needs it to start the app (slice 2). */
  appId: z.string().max(200).regex(DEVICE_EVIDENCE_APP_ID, "an application id").optional(),
  flows: z.array(z.object({ id: NameSchema, files: z.array(GlobSchema).min(1).max(20),
    steps: z.array(z.object({ id: NameSchema, label: line(80), actions: z.array(DeviceEvidenceActionSchema).max(DEVICE_EVIDENCE_ACTIONS_MAX).optional() }).strict()).min(1).max(DEVICE_EVIDENCE_STEPS_MAX) }).strict())
    .min(1).max(DEVICE_EVIDENCE_RECIPE_FLOWS_MAX),
  maskIds: z.array(line(200)).max(DEVICE_EVIDENCE_MASK_IDS_MAX).optional(),
  fixtureDataOnly: z.boolean().optional(),
}).strict().superRefine((recipe, context) => {
  if (new Set(recipe.flows.map((row) => row.id)).size !== recipe.flows.length) context.addIssue({ code: "custom", message: "flow ids are unique" });
  for (const row of recipe.flows) if (new Set(row.steps.map((step) => step.id)).size !== row.steps.length) context.addIssue({ code: "custom", message: "step ids are unique" });
});
export type DeviceEvidenceRecipe = z.infer<typeof DeviceEvidenceRecipeSchema>;

// ---- fixed reasons and words

/** Why a run, or one step of it, has no before and after pictures. Fixed words, never an error's own text. */
export const DEVICE_EVIDENCE_NOT_RUN_REASONS = ["no_recipe", "no_changed_flow", "changes_unreadable", "too_many_changed_files", "app_did_not_build", "device_did_not_start", "needs_macos",
  "step_failed", "capture_failed", "over_size_cap", "masked_content", "unreadable_screen", "time_limit", "not_stored"] as const;
export type DeviceEvidenceNotRunReason = (typeof DEVICE_EVIDENCE_NOT_RUN_REASONS)[number];
export const DEVICE_EVIDENCE_NOT_RUN_WORDS: Record<DeviceEvidenceNotRunReason, string> = {
  no_recipe: "no build command or flows are set for this project",
  no_changed_flow: "no changed flow found",
  changes_unreadable: "the changed files could not be read",
  too_many_changed_files: "too many changed files to pick flows from",
  app_did_not_build: "the app did not build",
  device_did_not_start: "the emulator or simulator did not start",
  needs_macos: "needs macOS (your CI is not connected)",
  step_failed: "the step did not complete",
  capture_failed: "the screenshot could not be taken",
  over_size_cap: "over the size cap",
  masked_content: "withheld, it may show a secret or personal data",
  unreadable_screen: "this screen cannot be checked for private data",
  time_limit: "the time limit was reached",
  not_stored: "it could not be stored",
};
/** The reasons that need no work from the device: a run that never opened one. */
type PickNotRun = Extract<DeviceEvidenceNotRunReason, "no_recipe" | "no_changed_flow" | "changes_unreadable" | "too_many_changed_files">;
/** Why a changed flow was not run at all. */
export const DEVICE_EVIDENCE_NOT_SHOWN_REASONS = ["over_flow_cap"] as const;
export type DeviceEvidenceNotShownReason = (typeof DEVICE_EVIDENCE_NOT_SHOWN_REASONS)[number];
export const DEVICE_EVIDENCE_NOT_SHOWN_WORDS: Record<DeviceEvidenceNotShownReason, string> = { over_flow_cap: "more changed flows than the cap" };
/** What the picture was taken on. `fake` is slice 1's test stand-in: never a real run. */
export const DEVICE_EVIDENCE_DEVICES = ["fake", "android_emulator", "ios_simulator"] as const;
export type DeviceEvidenceDevice = (typeof DEVICE_EVIDENCE_DEVICES)[number];
/** Where it ran, from the pack's `producer.isolation` (O26: a laptop says so). An iOS simulator never runs in a sandbox. */
export const DEVICE_EVIDENCE_ISOLATIONS = ["sandbox", "developer_machine"] as const;
export type DeviceEvidenceIsolation = (typeof DEVICE_EVIDENCE_ISOLATIONS)[number];
const FAKE_WORDS = "Ran on a fake device (a test stand-in, not a real run)";
export const DEVICE_EVIDENCE_DEVICE_WORDS: { [D in DeviceEvidenceDevice]: Partial<Record<DeviceEvidenceIsolation, string>> } = {
  fake: { sandbox: FAKE_WORDS, developer_machine: FAKE_WORDS },
  android_emulator: { sandbox: "Ran on an Android emulator in Rovara's sandbox", developer_machine: "Ran on an Android emulator on a developer machine" },
  ios_simulator: { developer_machine: "Ran on an iOS simulator on a developer machine, not in a sandbox" },
};
export const DEVICE_EVIDENCE_NOT_PROOF_WORDS = "Visual evidence only: it does not count as change proof.";
const FAKE_LINE_WORDS = "Fake device, not a real run.";
export const DEVICE_EVIDENCE_CHECK_ID = "device_evidence";
const CHECK_LABEL = "Device evidence";
const CHECK_LABELS: Record<DeviceEvidenceDevice, string> = {
  fake: `${CHECK_LABEL}: fake device, not a real run`,
  android_emulator: `${CHECK_LABEL}: Android emulator`,
  ios_simulator: `${CHECK_LABEL}: iOS simulator`,
};
const deviceAllowed = (device: DeviceEvidenceDevice, isolation: DeviceEvidenceIsolation) => DEVICE_EVIDENCE_DEVICE_WORDS[device][isolation] !== undefined;

// ---- which changed flows are picked

export type DeviceEvidenceFlow = { id: string; steps: Array<{ id: string; label: string; actions?: DeviceEvidenceAction[] }> };
export type DeviceEvidenceNotShown = { flow: string; reason: DeviceEvidenceNotShownReason };
export type DeviceEvidencePick =
  | { status: "picked"; flows: DeviceEvidenceFlow[]; notShown: DeviceEvidenceNotShown[]; moreNotShown: number }
  | { status: "not_run"; reason: PickNotRun };

/**
 * The flows a change touches: a flow is picked when a changed file matches one of its globs. Bounded: a list over `DEVICE_EVIDENCE_CHANGED_FILES_MAX` files, or more matching work than
 * `DEVICE_EVIDENCE_MATCH_STEPS_MAX`, is refused whole (never picked from part of the list). At most `DEVICE_EVIDENCE_FLOWS_MAX` flows are taken, in recipe order; the rest are "not shown".
 */
export function pickChangedFlows(input: { changedFiles: unknown; recipe: unknown }): DeviceEvidencePick {
  const recipe = DeviceEvidenceRecipeSchema.safeParse(input.recipe);
  if (!recipe.success) return { status: "not_run", reason: "no_recipe" };
  const files = input.changedFiles;
  if (!Array.isArray(files) || !files.every((file) => typeof file === "string")) return { status: "not_run", reason: "changes_unreadable" };
  if (files.length > DEVICE_EVIDENCE_CHANGED_FILES_MAX) return { status: "not_run", reason: "too_many_changed_files" };
  const hits: DeviceEvidenceFlow[] = [];
  let steps = 0;
  for (const row of recipe.data.flows) {
    let hit = false;
    for (const file of files) {
      for (const glob of row.files) {
        const result = matchPolicyGlob(glob, file);
        steps += result.steps;
        if (steps > DEVICE_EVIDENCE_MATCH_STEPS_MAX) return { status: "not_run", reason: "too_many_changed_files" };
        if (result.matched) { hit = true; break; }
      }
      if (hit) break;
    }
    if (hit) hits.push({ id: row.id, steps: row.steps.map((step) => ({ id: step.id, label: step.label, ...(step.actions === undefined ? {} : { actions: step.actions }) })) });
  }
  if (hits.length === 0) return { status: "not_run", reason: "no_changed_flow" };
  const over = hits.slice(DEVICE_EVIDENCE_FLOWS_MAX).map((row) => ({ flow: row.id, reason: "over_flow_cap" as const }));
  return { status: "picked", flows: hits.slice(0, DEVICE_EVIDENCE_FLOWS_MAX), notShown: over.slice(0, DEVICE_EVIDENCE_NOT_SHOWN_MAX), moreNotShown: Math.max(0, over.length - DEVICE_EVIDENCE_NOT_SHOWN_MAX) };
}

// ---- masking: the view tree

/** A rectangle on the screen, in whole pixels, from the top left. */
export type DeviceRect = { x: number; y: number; width: number; height: number };
const PixelSchema = z.number().int().min(-1_000_000).max(1_000_000);
const BoundsSchema = z.object({ x: PixelSchema, y: PixelSchema, width: z.number().int().min(0).max(1_000_000), height: z.number().int().min(0).max(1_000_000) }).strict();
const TextSchema = z.string().max(DEVICE_EVIDENCE_TREE_TEXT_MAX);
/**
 * One element of the screen's view tree (Android's UI hierarchy dump, iOS's accessibility tree), flattened in reading order by the driver. `secure` is a password or other secure field,
 * `webView` an embedded web page and `surface` a canvas, game, map or other drawn surface (neither has a tree of its own here: both are always painted). `id` is the Android resource id or the iOS accessibility identifier.
 */
const ViewNodeSchema = z.object({
  id: z.string().min(1).max(200).regex(NO_HIDDEN).optional(), text: TextSchema.optional(), description: TextSchema.optional(), hint: TextSchema.optional(),
  secure: z.boolean().optional(), webView: z.boolean().optional(), surface: z.boolean().optional(), bounds: BoundsSchema.optional(),
}).strict();
const ViewTreeSchema = z.object({ width: z.number().int().min(1).max(100_000), height: z.number().int().min(1).max(100_000), nodes: z.array(ViewNodeSchema).max(DEVICE_EVIDENCE_TREE_NODES_MAX) }).strict()
  .refine((tree) => tree.nodes.reduce((sum, row) => sum + (row.text?.length ?? 0) + (row.description?.length ?? 0) + (row.hint?.length ?? 0), 0) <= DEVICE_EVIDENCE_TREE_TEXT_TOTAL_MAX, "bounded text");
export type DeviceViewTree = z.infer<typeof ViewTreeSchema>;
/** The tree as the runner compares it, or undefined when it is not a valid tree. */
export function parseDeviceViewTree(tree: unknown): DeviceViewTree | undefined {
  const parsed = ViewTreeSchema.safeParse(tree);
  return parsed.success ? parsed.data : undefined;
}

export type DeviceMaskPlan =
  | { status: "paint"; rects: DeviceRect[]; /** true when the screen had no readable text and is shown under the admin's fixture-data choice */ unmasked?: true }
  | { status: "unmasked" }
  | { status: "withheld"; reason: Extract<DeviceEvidenceNotRunReason, "masked_content" | "unreadable_screen"> };
const READABLE = /[^\s\p{Cc}\p{Cf}]/u;
const WITHHELD_SECRET = { status: "withheld", reason: "masked_content" } as const;
const WITHHELD_UNREADABLE = { status: "withheld", reason: "unreadable_screen" } as const;

/**
 * What to paint over on a screenshot, from the screen's view tree (plan 4.3): every secure field, every web view, every element the recipe names (`maskIds`), and every element whose text,
 * description or hint matches one of browser evidence's text masks. Text that only reads as a secret across two elements (a label and its value) cannot be painted: the screen is withheld
 * ("masked_content"), and so is a matching element with no usable rectangle. An element wholly off the screen is not in the picture; one partly off is clipped. A screen with no readable
 * tree or no readable text at all, a tree of another size than the frame, or a tree over the caps is withheld ("unreadable_screen"), unless `fixtureDataOnly` is exactly true, which shows a
 * screen with no readable tree or no text unmasked (never a screen with a match it cannot paint). Never throws.
 */
export function planDeviceMask(tree: unknown, options: { frame: { width: number; height: number }; maskIds?: unknown; fixtureDataOnly?: unknown }): DeviceMaskPlan {
  const waived = options.fixtureDataOnly === true;
  // No tree at all (Flutter without semantics, a game, a canvas), or one that is not a valid tree: only the first can be waived, and only by the admin's choice.
  const noTree = tree === null || tree === undefined;
  const parsed = noTree ? undefined : parseDeviceViewTree(tree);
  if (parsed === undefined) return noTree && waived ? { status: "unmasked" } : WITHHELD_UNREADABLE;
  if (parsed.width !== options.frame.width || parsed.height !== options.frame.height) return WITHHELD_UNREADABLE;
  const maskIds = new Set(Array.isArray(options.maskIds) ? (options.maskIds as unknown[]).slice(0, DEVICE_EVIDENCE_MASK_IDS_MAX).filter((id): id is string => typeof id === "string") : []);
  // Text that is only spaces or hidden characters is no text: a screen of it has nothing a tree can vouch for.
  const hasText = parsed.nodes.some((row) => [row.text, row.description, row.hint].some((value) => value !== undefined && READABLE.test(value)));
  if (!hasText && !waived) return WITHHELD_UNREADABLE;

  const paint: DeviceRect[] = [];
  const lines: string[] = [];
  for (const row of parsed.nodes) {
    // A secure field or web view is painted whatever it says; its own text is never read into the label view (a marker stands in, as a form field does on a page).
    const always = row.secure === true || row.webView === true || row.surface === true || (row.id !== undefined && maskIds.has(row.id));
    const fields = [row.text, row.description, row.hint].filter((value): value is string => value !== undefined && value !== "");
    const matches = !always && fields.some((value) => scrubVisibleText(value) !== value);
    if (row.secure === true || row.webView === true || row.surface === true) lines.push("•");
    // A hint shows above or in place of a value, and an accessibility label can be the visible one: all three read in the order a label would come before its value.
    else for (const value of [row.hint, row.description, row.text]) if (value !== undefined && value !== "") lines.push(value);
    if (!always && !matches) continue;
    const rect = row.bounds === undefined ? undefined : clip(row.bounds, parsed.width, parsed.height);
    if (rect !== undefined) { paint.push(rect); continue; }
    // No rectangle on the screen: an element wholly off the screen is not in the picture; a missing or empty one cannot be painted.
    if (row.bounds !== undefined && row.bounds.width > 0 && row.bounds.height > 0) continue;
    return WITHHELD_SECRET;
  }
  // A label and its value in two elements: read as lines of their own, the screen shows a secret that no one rectangle covers (the masks only reach across a line break for this).
  if (scrubVisibleText(lines.join("\n")) !== lines.map(scrubVisibleText).join("\n")) return WITHHELD_SECRET;
  // The painted area is bounded, so painting is: a screen of rectangles that cover the frame many times over is withheld.
  if (paint.reduce((sum, rect) => sum + rect.width * rect.height, 0) > DEVICE_EVIDENCE_PAINT_AREA_FACTOR * parsed.width * parsed.height) return WITHHELD_SECRET;
  // Only an admin's fixture-data choice gets here without text: nothing to paint means the screen is shown as it is, and a screen with only some painted is counted as unmasked too.
  if (!hasText && paint.length === 0) return { status: "unmasked" };
  return { status: "paint", rects: paint, ...(hasText ? {} : { unmasked: true as const }) };
}

/** The part of `bounds` that is on the screen; undefined when none of it is, or when it has no area. */
function clip(bounds: { x: number; y: number; width: number; height: number }, width: number, height: number): DeviceRect | undefined {
  const x0 = Math.max(0, bounds.x);
  const y0 = Math.max(0, bounds.y);
  const x1 = Math.min(width, bounds.x + bounds.width);
  const y1 = Math.min(height, bounds.y + bounds.height);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : undefined;
}

// ---- what a run produced

/** The runner's result, with the screenshots' bytes (the verifier writes it, the broker stores the bytes and turns it into an outcome). */
export type DeviceEvidenceShot = { sha256: string; bytes: Uint8Array };
export type DeviceEvidenceStepResult<Shot> =
  | { flow: string; step: string; status: "shown"; before: Shot; after: Shot }
  | { flow: string; step: string; status: "not_run"; reason: DeviceEvidenceNotRunReason };
type RunResult<Shot> = {
  device: DeviceEvidenceDevice;
  isolation: DeviceEvidenceIsolation;
  durationMs: number;
  steps: Array<DeviceEvidenceStepResult<Shot>>;
  notShown: DeviceEvidenceNotShown[];
  moreNotShown: number;
  /** How many shown steps were shown unmasked (an admin's fixture-data choice for a screen Rovara cannot read). */
  unmasked: number;
  /** The whole run did not happen (no step was run). */
  notRun?: DeviceEvidenceNotRunReason;
};
export type DeviceEvidenceCaptured = RunResult<DeviceEvidenceShot>;
/** What the pack and the pull request are written from: the screenshots as stored refs. */
export type DeviceEvidenceOutcome = RunResult<ArtifactRef>;

const CountSchema = z.number().int().min(0).max(1_000_000);
const JpegRefSchema = ArtifactRefSchema.refine((ref) => ref.kind === "jpeg", "a screenshot is a JPEG");
const ShotSchema = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/u), bytes: z.instanceof(Uint8Array).refine((bytes) => bytes.byteLength > 0 && bytes.byteLength <= DEVICE_EVIDENCE_SCREENSHOT_MAX_BYTES) }).strict();
const stepsOf = <Shot extends z.ZodTypeAny>(shot: Shot) => z.array(z.discriminatedUnion("status", [
  z.object({ flow: NameSchema, step: NameSchema, status: z.literal("shown"), before: shot, after: shot }).strict(),
  z.object({ flow: NameSchema, step: NameSchema, status: z.literal("not_run"), reason: z.enum(DEVICE_EVIDENCE_NOT_RUN_REASONS) }).strict(),
])).max(DEVICE_EVIDENCE_RUN_STEPS_MAX);
const runBase = {
  device: z.enum(DEVICE_EVIDENCE_DEVICES),
  isolation: z.enum(DEVICE_EVIDENCE_ISOLATIONS),
  durationMs: z.number().int().min(0).max(86_400_000),
  notShown: z.array(z.object({ flow: NameSchema, reason: z.enum(DEVICE_EVIDENCE_NOT_SHOWN_REASONS) }).strict()).max(DEVICE_EVIDENCE_NOT_SHOWN_MAX),
  moreNotShown: CountSchema,
  unmasked: CountSchema,
  notRun: z.enum(DEVICE_EVIDENCE_NOT_RUN_REASONS).optional(),
};
type Checkable = { device: DeviceEvidenceDevice; isolation: DeviceEvidenceIsolation; steps: Array<{ flow: string; step: string; status: string }>; unmasked: number; notRun?: unknown };
function checkRun(run: Checkable, context: z.RefinementCtx): void {
  if (new Set(run.steps.map((row) => `${row.flow}/${row.step}`)).size !== run.steps.length) context.addIssue({ code: "custom", message: "steps are unique" });
  if (run.notRun !== undefined && run.steps.length > 0) context.addIssue({ code: "custom", message: "a run that did not happen has no steps" });
  if (!deviceAllowed(run.device, run.isolation)) context.addIssue({ code: "custom", message: "this device does not run there" });
  if (run.unmasked > run.steps.filter((row) => row.status === "shown").length) context.addIssue({ code: "custom", message: "unmasked counts shown steps" });
}
const OutcomeSchema = z.object({ ...runBase, steps: stepsOf(JpegRefSchema) }).strict().superRefine(checkRun);
const CapturedSchema = z.object({ ...runBase, steps: stepsOf(ShotSchema) }).strict().superRefine((captured, context) => {
  checkRun(captured, context);
  const total = captured.steps.reduce((sum, row) => sum + (row.status === "shown" ? row.before.bytes.byteLength + row.after.bytes.byteLength : 0), 0);
  if (total > DEVICE_EVIDENCE_TOTAL_MAX_BYTES) context.addIssue({ code: "custom", message: "a run keeps at most the run's byte budget" });
});

const INVALID = "device evidence outcome is not valid";
/** The runner's result checked whole before anything of it is stored: the shape, every shot within the screenshot cap, and all of them within the run's budget. Throws otherwise. */
export function checkedDeviceEvidenceCaptured(captured: unknown): DeviceEvidenceCaptured {
  const parsed = CapturedSchema.safeParse(captured);
  if (!parsed.success) throw new Error(INVALID);
  return parsed.data as DeviceEvidenceCaptured;
}
function checkedOutcome(outcome: unknown): DeviceEvidenceOutcome {
  const parsed = OutcomeSchema.safeParse(outcome);
  if (!parsed.success) throw new Error(INVALID);
  return parsed.data as DeviceEvidenceOutcome;
}

/**
 * The evidence-pack check (v2) and its not-tested rows. Always kind `visual` (check-kinds.ts: it never counts toward the change proof), run by Rovara, whatever the device: a picture is not a
 * pass, and a fake device is not a real run. One pair per shown step. A run that showed nothing is `not_run` with no pairs. Throws on an outcome it does not understand.
 */
export function deviceEvidenceCheck(outcome: DeviceEvidenceOutcome): { check: EvidenceCheckV2; notTested: EvidencePackV2["notTested"] } {
  const checked = checkedOutcome(outcome);
  const shown = checked.steps.filter((row): row is Extract<DeviceEvidenceStepResult<ArtifactRef>, { status: "shown" }> => row.status === "shown");
  const any = shown.length > 0;
  const check: EvidenceCheckV2 = {
    // `class` is neutral (a picture is not a pass); the stage is the sandbox only when it ran there (a laptop has no stage of its own: the producer says where).
    id: DEVICE_EVIDENCE_CHECK_ID, kind: "visual", label: CHECK_LABELS[checked.device], ...(checked.isolation === "sandbox" ? { stage: "sandbox" as const } : {}), runBy: "rovara",
    before: any ? "passed" : "not_run", after: any ? "passed" : "not_run", class: "not_rerun", durationMs: checked.durationMs,
    ...(any ? { pairs: shown.map((row) => ({ id: `${row.flow}/${row.step}`, before: row.before, after: row.after })) } : {}),
  };
  const notTested: EvidencePackV2["notTested"] = [
    ...(checked.notRun === undefined ? [] : [{ what: CHECK_LABEL, reason: `Not run: ${DEVICE_EVIDENCE_NOT_RUN_WORDS[checked.notRun]}` }]),
    ...checked.steps.flatMap((row) => (row.status === "not_run" ? [{ what: `${CHECK_LABEL}: ${row.flow}/${row.step}`, reason: `Not run: ${DEVICE_EVIDENCE_NOT_RUN_WORDS[row.reason]}` }] : [])),
    ...checked.notShown.map((row) => ({ what: `${CHECK_LABEL}: ${row.flow}`, reason: `Not shown: ${DEVICE_EVIDENCE_NOT_SHOWN_WORDS[row.reason]}` })),
    ...(checked.moreNotShown > 0 ? [{ what: `${CHECK_LABEL}: ${String(checked.moreNotShown)} more changed flows`, reason: `Not shown: ${DEVICE_EVIDENCE_NOT_SHOWN_WORDS.over_flow_cap}` }] : []),
  ];
  return { check, notTested };
}

/**
 * The pack with the device-evidence check added. No outcome: the very same pack object (absent = today's behaviour, byte for byte). Refuses a pack that already has the check, or whose
 * producer says another place than the outcome, or that would go over the pack's own limits.
 */
export function addDeviceEvidenceToPack(pack: EvidencePackV2, outcome: DeviceEvidenceOutcome | undefined): EvidencePackV2 {
  if (outcome === undefined) return pack;
  const { check, notTested } = deviceEvidenceCheck(outcome);
  if (pack.checks.some((entry) => entry.id === DEVICE_EVIDENCE_CHECK_ID) || pack.producer.isolation !== outcome.isolation
    || pack.checks.length + 1 > EVIDENCE_CHECKS_MAX || pack.notTested.length + notTested.length > EVIDENCE_NOT_TESTED_MAX) throw new Error(INVALID);
  return { ...pack, checks: [...pack.checks, check], notTested: [...pack.notTested, ...notTested] };
}

// ---- the pull request

/** A link to the task page, as the PR may carry it: https, a host, a plain path; nothing a reader could mistake for other markup. */
const TASK_LINK = /^https:\/\/[A-Za-z0-9.-]{1,253}(?::\d{1,5})?(?:\/[A-Za-z0-9._~/-]*)?$/u;
const TASK_LINK_MAX = 300;

/**
 * The pull request's lines (O27): text only. Where it ran and that it is not proof, then each step with "before and after screenshots" and a link to the task page behind sign-in, or "Not run"
 * with its fixed reason. Every picture line carries the never-proof words, and a fake device's lines say it is not a real run. No image, no artifact address, no digest is ever written.
 * No outcome: no line (absent = today's behaviour).
 */
export function deviceEvidenceLines(outcome: DeviceEvidenceOutcome | undefined, options: { taskLink?: string | undefined }): string[] {
  if (outcome === undefined) return [];
  const checked = checkedOutcome(outcome);
  const link = typeof options.taskLink === "string" && options.taskLink.length <= TASK_LINK_MAX && TASK_LINK.test(options.taskLink) ? options.taskLink : undefined;
  const where = link === undefined ? " (on the task page, behind sign-in)" : ` (view behind sign-in: ${link})`;
  const fake = checked.device === "fake" ? ` ${FAKE_LINE_WORDS}` : "";
  return [
    `${CHECK_LABEL}: ${DEVICE_EVIDENCE_DEVICE_WORDS[checked.device][checked.isolation]!}. ${DEVICE_EVIDENCE_NOT_PROOF_WORDS}`,
    ...(checked.notRun === undefined ? [] : [`- Not run: ${DEVICE_EVIDENCE_NOT_RUN_WORDS[checked.notRun]}`]),
    ...checked.steps.map((row) => (row.status === "shown"
      ? `- \`${row.flow}/${row.step}\`: before and after screenshots${where}.${fake} ${DEVICE_EVIDENCE_NOT_PROOF_WORDS}`
      : `- \`${row.flow}/${row.step}\`: Not run: ${DEVICE_EVIDENCE_NOT_RUN_WORDS[row.reason]}`)),
    ...checked.notShown.map((row) => `- \`${row.flow}\`: Not shown: ${DEVICE_EVIDENCE_NOT_SHOWN_WORDS[row.reason]}`),
    ...(checked.moreNotShown > 0 ? [`- ${String(checked.moreNotShown)} more changed flows not shown: ${DEVICE_EVIDENCE_NOT_SHOWN_WORDS.over_flow_cap}`] : []),
    ...(checked.unmasked > 0 ? [`- ${String(checked.unmasked)} screen${checked.unmasked === 1 ? "" : "s"} shown unmasked: fixture data only`] : []),
  ];
}
