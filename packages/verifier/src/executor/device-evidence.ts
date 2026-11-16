// Device testing slice 1 (DEC 244): the runner. For each picked flow it builds and runs the app on the base code ("before") and on the candidate ("after") through a driver that owns the
// device (a fake in slice 1; the Android emulator and the iOS simulator in later slices), and takes one masked screenshot per named step. It holds the run to one time limit (every driver
// call is raced against the time left, so a device that never answers cannot hold the run) and one byte budget, keeps each screenshot within the pack's JPEG cap, and always stops the device
// it started (that wait is bounded too). A step that cannot be shown is "Not run" with a fixed reason.
// Masking (plan 4.3): read the view tree, take the picture, read the tree again (they must agree; one retry, then the screen is withheld); plan what to paint over from the tree
// (contracts/device-evidence.ts: secure fields, web views, the recipe's ids, every text a shared mask matches); paint those rectangles on the pixels; check the paint; only then encode. A screen
// that cannot be checked is withheld. The credential scan of the JPEG bytes here is defence in depth only.
// Nothing here decides whether a change is proven: the result is visual evidence only, and a fake device is never a real run (contracts/device-evidence.ts).
import { createHash } from "node:crypto";
import {
  DEVICE_EVIDENCE_DEVICES, DEVICE_EVIDENCE_DEVICE_WORDS, DEVICE_EVIDENCE_FLOWS_MAX, DEVICE_EVIDENCE_FRAME_PIXELS_MAX, DEVICE_EVIDENCE_ISOLATIONS, DEVICE_EVIDENCE_MASK_IDS_MAX, DEVICE_EVIDENCE_NOT_SHOWN_MAX,
  DEVICE_EVIDENCE_NOT_SHOWN_REASONS, DEVICE_EVIDENCE_RUN_MS, DEVICE_EVIDENCE_STEPS_MAX, DEVICE_EVIDENCE_STEP_MS, DEVICE_EVIDENCE_TOTAL_MAX_BYTES, planDeviceMask,
  type DeviceEvidenceCaptured, type DeviceEvidenceDevice, type DeviceEvidenceFlow, type DeviceEvidenceIsolation, type DeviceEvidenceNotRunReason, type DeviceEvidenceNotShown, type DeviceEvidenceShot,
  type DeviceEvidenceStepResult, type DeviceRect,
} from "@agentx/contracts";
import { CAPTURE_SCREENSHOT_MAX_BYTES } from "./capture.js";

export type DeviceEvidenceSide = "before" | "after";
export type { DeviceEvidenceCaptured };
/** A screenshot before it is encoded: RGBA pixels, row by row from the top left. */
export type DeviceFrame = { width: number; height: number; rgba: Uint8Array };

export type DeviceEvidencePrepareAnswer = "ready" | "app_did_not_build" | "device_did_not_start" | "needs_macos" | "time_limit";
export type DeviceEvidenceStepAnswer = "ok" | "step_failed" | "time_limit";
/**
 * The device, behind one port. Every call is for one side (the base checkout or the candidate). Anything but the documented answers is read as a failure; nothing a driver says is kept
 * as words.
 */
export type DeviceDriver = Readonly<{
  /** What it is. A fake says `fake`, and a fake is never a real run. */
  kind: DeviceEvidenceDevice;
  /** Builds this side's app with the project's own command, starts a clean device (no accounts, fixture data only) and installs the app. */
  prepare(side: DeviceEvidenceSide, options: { timeoutMs: number }): Promise<DeviceEvidencePrepareAnswer>;
  /** Starts a flow from a clean state: the app launched on its first screen. */
  startFlow(side: DeviceEvidenceSide, flow: string, options: { timeoutMs: number }): Promise<DeviceEvidenceStepAnswer>;
  /** Does what the named step does and waits until the screen settles. */
  performStep(side: DeviceEvidenceSide, flow: string, step: string, options: { timeoutMs: number }): Promise<DeviceEvidenceStepAnswer>;
  /** The screen's view tree (Android's UI hierarchy dump, iOS's accessibility tree), flattened in reading order; null when the screen has none. */
  readTree(side: DeviceEvidenceSide, options: { timeoutMs: number }): Promise<unknown>;
  /** The screen's pixels. */
  screenshot(side: DeviceEvidenceSide, options: { timeoutMs: number }): Promise<unknown>;
  /** Stops what `prepare` started for this side. Called once after every `prepare`, whatever it answered. */
  stop(side: DeviceEvidenceSide): Promise<void>;
}>;

export type DeviceEvidenceRunInput = Readonly<{
  platform: "android" | "ios";
  isolation: DeviceEvidenceIsolation;
  /** The picked flows (`pickChangedFlows`), at most `DEVICE_EVIDENCE_FLOWS_MAX`. */
  flows: readonly DeviceEvidenceFlow[];
  notShown: readonly DeviceEvidenceNotShown[];
  moreNotShown: number;
  /** The recipe's extra ids to paint over (the plan always paints secure fields and web views). */
  maskIds: readonly string[];
  /** The recipe's `fixtureDataOnly`: only the exact value `true` shows a screen with no readable tree unmasked. */
  fixtureDataOnly?: boolean;
  driver: DeviceDriver;
  /** Turns the painted pixels into a JPEG (slice 2 brings the real encoder; tests and the fake bring theirs). */
  encodeJpeg(frame: DeviceFrame): Uint8Array;
  /** The run's credential scan (the executor's `CredentialRedactor`) over the JPEG bytes: defence in depth only. */
  redactor?: Readonly<{ contains(bytes: Uint8Array): boolean }>;
  now?: () => number;
  /** Lower limits for this run; the built-in limits are the most a caller can get. */
  limits?: Readonly<{ runMs?: number; stepMs?: number; totalBytes?: number }>;
}>;

const INVALID = "device evidence input is not valid";
const SIDES: readonly DeviceEvidenceSide[] = ["before", "after"];
const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/u;
const isJpeg = (bytes: Uint8Array) => bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
const sha256Of = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** How long `stop` may take, whatever is left of the run: the device is always asked to stop, and the run never waits on it for longer. */
export const DEVICE_EVIDENCE_STOP_MS = 10_000;
const TIMED_OUT = Symbol("timed out");
const FAILED = Symbol("failed");
/** The work's answer, `FAILED` when it throws or rejects, or `TIMED_OUT` once `ms` have passed. */
async function within<T>(work: () => Promise<T>, ms: number): Promise<T | typeof TIMED_OUT | typeof FAILED> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    let started: Promise<T | typeof FAILED>;
    try { started = work().catch((): typeof FAILED => FAILED); } catch { started = Promise.resolve(FAILED); }
    return await Promise.race<T | typeof TIMED_OUT | typeof FAILED>([started, new Promise<typeof TIMED_OUT>((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), Math.max(1, ms)); })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
const lower = (given: number | undefined, most: number) => (typeof given === "number" && Number.isFinite(given) && given > 0 ? Math.min(given, most) : most);

// ---- painting

/** The colour a painted rectangle gets. */
export const DEVICE_EVIDENCE_PAINT = Object.freeze([0, 0, 0, 255] as const);
/** `frame` with every rectangle painted over (a copy: the caller's pixels are never touched). Rectangles are clipped to the frame. */
export function paintDeviceRects(frame: DeviceFrame, rects: readonly DeviceRect[]): DeviceFrame {
  const rgba = Uint8Array.from(frame.rgba);
  for (const rect of rects) {
    const x1 = Math.min(frame.width, rect.x + rect.width);
    const y1 = Math.min(frame.height, rect.y + rect.height);
    for (let y = Math.max(0, rect.y); y < y1; y += 1) {
      for (let x = Math.max(0, rect.x); x < x1; x += 1) rgba.set(DEVICE_EVIDENCE_PAINT, (y * frame.width + x) * 4);
    }
  }
  return { width: frame.width, height: frame.height, rgba };
}
/** Whether every pixel of every rectangle is the paint colour: the check after the paint ("check again"). */
export function deviceRectsPainted(frame: DeviceFrame, rects: readonly DeviceRect[]): boolean {
  for (const rect of rects) {
    const x1 = Math.min(frame.width, rect.x + rect.width);
    const y1 = Math.min(frame.height, rect.y + rect.height);
    for (let y = Math.max(0, rect.y); y < y1; y += 1) {
      for (let x = Math.max(0, rect.x); x < x1; x += 1) {
        const at = (y * frame.width + x) * 4;
        for (let channel = 0; channel < 4; channel += 1) if (frame.rgba[at + channel] !== DEVICE_EVIDENCE_PAINT[channel]) return false;
      }
    }
  }
  return true;
}
/** The driver's answer as a frame, or undefined when it is not one (the wrong size for its pixels, no pixels, more pixels than the cap). */
function frameOf(answer: unknown): DeviceFrame | undefined {
  if (typeof answer !== "object" || answer === null) return undefined;
  const { width, height, rgba } = answer as Record<string, unknown>;
  if (!Number.isInteger(width) || !Number.isInteger(height) || (width as number) < 1 || (height as number) < 1) return undefined;
  if ((width as number) * (height as number) > DEVICE_EVIDENCE_FRAME_PIXELS_MAX || !(rgba instanceof Uint8Array) || rgba.byteLength !== (width as number) * (height as number) * 4) return undefined;
  return { width: width as number, height: height as number, rgba };
}

type Kept = DeviceEvidenceShot & { unmasked: boolean };
type Reason = DeviceEvidenceNotRunReason;

/** One encoded picture, held to what it should be. Never throws; never keeps anyone's own words. */
function keepShot(encode: DeviceEvidenceRunInput["encodeJpeg"], frame: DeviceFrame, unmasked: boolean, redactor: DeviceEvidenceRunInput["redactor"]): Kept | Reason {
  let bytes: unknown;
  try { bytes = encode({ width: frame.width, height: frame.height, rgba: Uint8Array.from(frame.rgba) }); } catch { return "capture_failed"; }
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || !isJpeg(bytes)) return "capture_failed";
  if (bytes.byteLength > CAPTURE_SCREENSHOT_MAX_BYTES) return "over_size_cap";
  try {
    if (redactor?.contains(bytes) === true) return "masked_content";
  } catch { return "masked_content"; }
  const copy = Uint8Array.from(bytes);
  return { bytes: copy, sha256: sha256Of(copy), unmasked };
}

const PREPARE_REASONS: ReadonlyMap<string, Reason> = new Map<string, Reason>([["app_did_not_build", "app_did_not_build"], ["device_did_not_start", "device_did_not_start"], ["needs_macos", "needs_macos"], ["time_limit", "time_limit"]]);

/**
 * Runs the before and after screenshots. For the base code then for the candidate: build and start the device, run each flow from a clean state, and after each named step read the view tree,
 * take the picture, read the tree again (an unchanged tree, or one retry, or the step is withheld), mask, check the mask, encode. Bounded: at most five flows of six steps, one time limit
 * for the whole run (a step reached after it is "Not run: time limit"), each call at most `DEVICE_EVIDENCE_STEP_MS` and never more than what is left, and one byte budget for everything kept
 * (a step whose pair would pass it is "Not run: over the size cap"). An app or device that does not come up on either side means no step is shown. An iOS run in a sandbox is refused up
 * front ("needs macOS"): a simulator runs only on a Mac. Refuses input it was not built for.
 */
export async function runDeviceEvidence(input: DeviceEvidenceRunInput): Promise<DeviceEvidenceCaptured> {
  const { flows, driver } = input;
  // Runtime checks of what TypeScript promises (a list read as unknown first: `Array.isArray` on a typed list would widen it to any[]).
  const notShownInput: unknown = input.notShown;
  const notShownOk = Array.isArray(notShownInput) && notShownInput.length <= DEVICE_EVIDENCE_NOT_SHOWN_MAX && notShownInput.every((row: unknown) => typeof row === "object" && row !== null
    && typeof (row as { flow?: unknown }).flow === "string" && NAME.test((row as { flow: string }).flow) && (DEVICE_EVIDENCE_NOT_SHOWN_REASONS as readonly unknown[]).includes((row as { reason?: unknown }).reason));
  const flowsInput: unknown = flows;
  const flowsOk = Array.isArray(flowsInput) && flowsInput.length >= 1 && flowsInput.length <= DEVICE_EVIDENCE_FLOWS_MAX && new Set(flowsInput.map((row: unknown) => (row as { id?: unknown })?.id)).size === flowsInput.length
    && flowsInput.every((row: unknown) => typeof row === "object" && row !== null && typeof (row as { id?: unknown }).id === "string" && NAME.test((row as { id: string }).id)
      && Array.isArray((row as { steps?: unknown }).steps) && (row as { steps: unknown[] }).steps.length >= 1 && (row as { steps: unknown[] }).steps.length <= DEVICE_EVIDENCE_STEPS_MAX
      && new Set((row as { steps: Array<{ id?: unknown }> }).steps.map((step) => step?.id)).size === (row as { steps: unknown[] }).steps.length
      && (row as { steps: Array<{ id?: unknown }> }).steps.every((step) => typeof step === "object" && step !== null && typeof step.id === "string" && NAME.test(step.id)));
  const kind: unknown = driver?.kind;
  const platformOk = (input.platform === "android" || input.platform === "ios")
    && (kind === "fake" || (kind === "android_emulator" && input.platform === "android") || (kind === "ios_simulator" && input.platform === "ios"));
  const isolation: unknown = input.isolation;
  if (!(DEVICE_EVIDENCE_ISOLATIONS as readonly unknown[]).includes(isolation) || !(DEVICE_EVIDENCE_DEVICES as readonly unknown[]).includes(kind) || !platformOk
    || DEVICE_EVIDENCE_DEVICE_WORDS[kind][isolation as DeviceEvidenceIsolation] === undefined
    || !flowsOk || !notShownOk || !Number.isInteger(input.moreNotShown) || input.moreNotShown < 0 || input.moreNotShown > 1_000_000
    || !Array.isArray(input.maskIds) || input.maskIds.length > DEVICE_EVIDENCE_MASK_IDS_MAX || typeof input.encodeJpeg !== "function") throw new Error(INVALID);
  const device: DeviceEvidenceDevice = kind;
  const now = input.now ?? Date.now;
  const started = now();
  const base = { device, isolation: input.isolation, notShown: input.notShown.map((row) => ({ flow: row.flow, reason: row.reason })), moreNotShown: input.moreNotShown };
  const nothing = (notRun: Reason): DeviceEvidenceCaptured => ({ ...base, durationMs: Math.max(0, now() - started), steps: [], unmasked: 0, notRun });
  // A simulator runs only on a Mac: a run in a sandbox (Cloud) is refused before the driver is touched.
  if (input.platform === "ios" && input.isolation === "sandbox") return nothing("needs_macos");

  const deadline = started + lower(input.limits?.runMs, DEVICE_EVIDENCE_RUN_MS);
  const stepMs = lower(input.limits?.stepMs, DEVICE_EVIDENCE_STEP_MS);
  const totalBytes = lower(input.limits?.totalBytes, DEVICE_EVIDENCE_TOTAL_MAX_BYTES);
  const failed = new Map<string, Reason>();
  const kept: Record<DeviceEvidenceSide, Map<string, Kept>> = { before: new Map(), after: new Map() };
  const keyOf = (flow: string, step: string) => `${flow}/${step}`;
  const fail = (flow: string, step: string, reason: Reason) => { if (!failed.has(keyOf(flow, step))) failed.set(keyOf(flow, step), reason); };
  const left = () => deadline - now();
  /** One driver call, raced against the time left (and the step's own limit). */
  const call = <T>(work: (timeoutMs: number) => Promise<T>) => { const ms = Math.min(stepMs, left()); return within(() => work(ms), ms); };

  /** One step's picture: tree, picture, tree again (equal, or one retry), mask, check the mask, encode. */
  async function capture(side: DeviceEvidenceSide): Promise<Kept | Reason> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (left() <= 0) return "time_limit";
      const first = await call((timeoutMs) => driver.readTree(side, { timeoutMs }));
      if (first === TIMED_OUT) return "time_limit";
      const picture = first === FAILED ? FAILED : await call((timeoutMs) => driver.screenshot(side, { timeoutMs }));
      if (picture === TIMED_OUT) return "time_limit";
      const second = picture === FAILED ? FAILED : await call((timeoutMs) => driver.readTree(side, { timeoutMs }));
      if (second === TIMED_OUT) return "time_limit";
      if (first === FAILED || picture === FAILED || second === FAILED) return "capture_failed";
      let agree: boolean;
      try { agree = JSON.stringify(first) === JSON.stringify(second); } catch { return "capture_failed"; }
      if (!agree) continue;
      const frame = frameOf(picture);
      if (frame === undefined) return "capture_failed";
      const plan = planDeviceMask(second, { frame: { width: frame.width, height: frame.height }, maskIds: input.maskIds, fixtureDataOnly: input.fixtureDataOnly });
      if (plan.status === "withheld") return plan.reason;
      if (plan.status === "unmasked") return keepShot(input.encodeJpeg, frame, true, input.redactor);
      const painted = paintDeviceRects(frame, plan.rects);
      if (!deviceRectsPainted(painted, plan.rects)) return "masked_content";
      return keepShot(input.encodeJpeg, painted, false, input.redactor);
    }
    // The screen changed between the two readings, twice: what was in the picture cannot be told.
    return "masked_content";
  }

  for (const side of SIDES) {
    const pending = flows.filter((flow) => flow.steps.some((step) => !failed.has(keyOf(flow.id, step.id))));
    if (pending.length === 0) break;
    if (left() <= 0) { for (const flow of pending) for (const step of flow.steps) fail(flow.id, step.id, "time_limit"); break; }
    try {
      const budget = left();
      let preparing: Promise<unknown> | undefined;
      const answer = await within(() => { preparing = driver.prepare(side, { timeoutMs: budget }); return preparing; }, budget);
      // A prepare that answers after the run gave up on it has started a device nobody would stop: it is stopped as soon as it settles (bounded like every stop).
      if (answer === TIMED_OUT && preparing !== undefined) void preparing.then(() => within(() => driver.stop(side), DEVICE_EVIDENCE_STOP_MS), () => undefined);
      if (answer !== "ready") {
        const reason = typeof answer === "string" ? PREPARE_REASONS.get(answer) : undefined;
        return nothing(answer === TIMED_OUT ? "time_limit" : (reason ?? "device_did_not_start"));
      }
      for (const flow of pending) {
        const begun = left() <= 0 ? TIMED_OUT : await call((timeoutMs) => driver.startFlow(side, flow.id, { timeoutMs }));
        if (begun !== "ok") {
          for (const step of flow.steps) fail(flow.id, step.id, begun === TIMED_OUT || begun === "time_limit" ? "time_limit" : "step_failed");
          continue;
        }
        for (let at = 0; at < flow.steps.length; at += 1) {
          const step = flow.steps[at]!;
          // A step is performed even when its own picture already failed on the other side: the steps after it start from where it leaves the app.
          const done = left() <= 0 ? TIMED_OUT : await call((timeoutMs) => driver.performStep(side, flow.id, step.id, { timeoutMs }));
          if (done !== "ok") {
            const reason: Reason = done === TIMED_OUT || done === "time_limit" ? "time_limit" : "step_failed";
            for (const later of flow.steps.slice(at)) fail(flow.id, later.id, reason);
            break;
          }
          if (failed.has(keyOf(flow.id, step.id))) continue;
          const shot = await capture(side);
          if (typeof shot === "string") fail(flow.id, step.id, shot);
          else kept[side].set(keyOf(flow.id, step.id), shot);
        }
      }
    } finally {
      // Always asked, never waited on past its bound: a stop that fails or hangs changes no result.
      await within(() => driver.stop(side), DEVICE_EVIDENCE_STOP_MS);
    }
  }

  let used = 0;
  let unmasked = 0;
  const steps: Array<DeviceEvidenceStepResult<DeviceEvidenceShot>> = flows.flatMap((flow) => flow.steps.map((step): DeviceEvidenceStepResult<DeviceEvidenceShot> => {
    const key = keyOf(flow.id, step.id);
    const before = kept.before.get(key);
    const after = kept.after.get(key);
    const reason = failed.get(key);
    if (reason !== undefined || before === undefined || after === undefined) return { flow: flow.id, step: step.id, status: "not_run", reason: reason ?? "capture_failed" };
    if (used + before.bytes.byteLength + after.bytes.byteLength > totalBytes) return { flow: flow.id, step: step.id, status: "not_run", reason: "over_size_cap" };
    used += before.bytes.byteLength + after.bytes.byteLength;
    if (before.unmasked || after.unmasked) unmasked += 1;
    return { flow: flow.id, step: step.id, status: "shown", before: { sha256: before.sha256, bytes: before.bytes }, after: { sha256: after.sha256, bytes: after.bytes } };
  }));
  return { ...base, durationMs: Math.max(0, now() - started), steps, unmasked };
}
