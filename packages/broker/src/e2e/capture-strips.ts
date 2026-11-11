// The screenshot strip of a browser scenario (one frame at the end of each step), before (the unchanged code, the baseline round) and after (the candidate), as the evidence
// pack's `browser` rows. Everything here is pure: the caller hands over a round's group operator evidence and gets the frames back, already held to what they say they are.
//
// What a frame must be to be kept: listed as a strip frame (`step` set, not dropped), for a case of the group, named for that case and step, base64 that decodes back to the same text, a JPEG of
// exactly the listed size and digest, at most 512 KiB; at most six a case and one per step. Anything of another shape is ignored; nothing here throws for evidence it does not like.
import { createHash } from "node:crypto";
import { EVIDENCE_ARTIFACT_MAX_BYTES, EVIDENCE_ARTIFACT_RETENTION, EVIDENCE_STRIP_MAX, type ArtifactRef, type EvidenceRaw } from "@agentx/contracts";

export interface StripFrame {
  /** The index of the declared step the frame was taken after. */
  step: number;
  sha256: string;
  data: Uint8Array;
}

const STRIP_NAME = /^case-(\d{1,4})-step-(\d{1,4})-screenshot\.jpg$/u;
const sha256Of = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isJpeg = (bytes: Uint8Array) => bytes.byteLength >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

/**
 * The strip frames a group's operator evidence lists (`captures.artifacts`) and carries (`captures.files`), by case id, each case's frames in step order. A group run without a strip (the admission asked
 * for failed screenshots only) gives an empty map.
 */
export function readCaptureStrips(operatorEvidence: unknown, caseIds: ReadonlySet<string>): Map<string, StripFrame[]> {
  const kept = new Map<string, StripFrame[]>();
  try {
    const captures = isRecord(operatorEvidence) ? operatorEvidence.captures : undefined;
    if (!isRecord(captures) || !Array.isArray(captures.artifacts) || !Array.isArray(captures.files)) return kept;
    const used = new Set<string>();
    for (const entry of captures.artifacts as unknown[]) {
      if (!isRecord(entry) || entry.kind !== "screenshot" || entry.omitted !== undefined || typeof entry.caseId !== "string" || !caseIds.has(entry.caseId)) continue;
      if (!Number.isInteger(entry.step) || (entry.step as number) < 0 || (entry.step as number) > 9_999) continue;
      const step = entry.step as number;
      const frames = kept.get(entry.caseId) ?? [];
      if (frames.length >= EVIDENCE_STRIP_MAX || frames.some((frame) => frame.step === step)) continue;
      if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(entry.sha256) || !Number.isInteger(entry.bytes) || (entry.bytes as number) <= 0 || (entry.bytes as number) > EVIDENCE_ARTIFACT_MAX_BYTES.jpeg) continue;
      const file = (captures.files as unknown[]).find((candidate) => isRecord(candidate) && candidate.sha256 === entry.sha256 && typeof candidate.name === "string" && !used.has(candidate.name)
        && STRIP_NAME.exec(candidate.name)?.[2] === String(step));
      if (!isRecord(file) || typeof file.base64 !== "string" || file.bytes !== entry.bytes) continue;
      const bytes = Buffer.from(file.base64, "base64");
      if (bytes.toString("base64") !== file.base64 || bytes.byteLength !== entry.bytes || sha256Of(bytes) !== entry.sha256 || !isJpeg(bytes)) continue;
      used.add(file.name as string);
      frames.push({ step, sha256: entry.sha256, data: new Uint8Array(bytes) });
      kept.set(entry.caseId, frames);
    }
    for (const frames of kept.values()) frames.sort((a, b) => a.step - b.step);
  } catch { /* evidence of the wrong shape keeps nothing */ }
  return kept;
}

/**
 * Pairs the two strips of one scenario. With no baseline frames at all (a baseline that did not run, or ran without a strip) every candidate frame is "after" and "before" is empty. Otherwise a frame is
 * kept only at a step both runs have, so the nth "before" frame and the nth "after" frame are the same step of the same scenario; a step only one side has is left out (the strip shows what can be compared).
 * When the two share no step, it falls back to the unpaired form.
 */
export function pairStrips(input: { after: readonly StripFrame[]; before: readonly StripFrame[] | undefined }): { before: StripFrame[]; after: StripFrame[] } {
  const after = [...input.after].sort((a, b) => a.step - b.step);
  const before = [...(input.before ?? [])].sort((a, b) => a.step - b.step);
  if (before.length === 0) return { before: [], after };
  const shared = new Set(after.filter((frame) => before.some((other) => other.step === frame.step)).map((frame) => frame.step));
  if (shared.size === 0) return { before: [], after };
  return { before: before.filter((frame) => shared.has(frame.step)), after: after.filter((frame) => shared.has(frame.step)) };
}

/** One approved scenario's frames from a round, as the caller read them per case. */
export interface ScenarioStrip {
  scenarioId: string;
  frames: readonly StripFrame[];
}

/**
 * The scenario strips of one round, from its groups: for each scenario, the frames of its first case (by case id) that has any (a scenario run under several accounts shows one of them; the evidence pack has
 * one row per scenario).
 */
export function scenarioStripsOf(groups: ReadonlyArray<{ cases: ReadonlyArray<{ caseId: string; scenarioId: string }>; strips: ReadonlyMap<string, readonly StripFrame[]> }>): ScenarioStrip[] {
  const byScenario = new Map<string, { caseId: string; frames: readonly StripFrame[] }>();
  for (const group of groups) {
    for (const item of group.cases) {
      const frames = group.strips.get(item.caseId);
      if (frames === undefined || frames.length === 0) continue;
      const have = byScenario.get(item.scenarioId);
      if (have === undefined || item.caseId < have.caseId) byScenario.set(item.scenarioId, { caseId: item.caseId, frames });
    }
  }
  return [...byScenario.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([scenarioId, value]) => ({ scenarioId, frames: value.frames }));
}

export interface BrowserEvidenceResult {
  /** The evidence pack's browser rows (the raw shape the broker's pack builder reads). */
  browser: NonNullable<EvidenceRaw["browser"]>;
  /** Each distinct frame, to store as a `jpeg` artifact before the pack is built (the pack drops a reference to one the store does not hold). */
  artifacts: Array<{ ref: ArtifactRef; data: Uint8Array }>;
}

const refOf = (frame: StripFrame): ArtifactRef => ({ kind: "jpeg", sha256: frame.sha256, bytes: frame.data.byteLength, retentionClass: EVIDENCE_ARTIFACT_RETENTION.jpeg });

/**
 * The pack's browser rows for a candidate round and its baseline round: one row per scenario that has candidate frames, `strip.before` from the baseline and `strip.after` from the candidate, paired by step.
 * Scenario ids are the approved ones the broker holds, never text from the worker. `consoleErrors` is left out: no console capture exists yet, so it is NOT MEASURED and is never written as 0.
 */
export function browserEvidenceOf(input: { candidate: readonly ScenarioStrip[]; baseline?: readonly ScenarioStrip[] | undefined }): BrowserEvidenceResult {
  const baseline = new Map((input.baseline ?? []).map((item) => [item.scenarioId, item.frames] as const));
  const artifacts = new Map<string, { ref: ArtifactRef; data: Uint8Array }>();
  const take = (frame: StripFrame): ArtifactRef => {
    const ref = refOf(frame);
    if (!artifacts.has(ref.sha256)) artifacts.set(ref.sha256, { ref, data: frame.data });
    return ref;
  };
  const browser: BrowserEvidenceResult["browser"] = [];
  for (const scenario of input.candidate) {
    if (scenario.frames.length === 0) continue;
    const paired = pairStrips({ after: scenario.frames, before: baseline.get(scenario.scenarioId) });
    browser.push({ scenarioId: scenario.scenarioId, strip: { before: paired.before.map(take), after: paired.after.map(take) } });
  }
  return { browser, artifacts: [...artifacts.values()] };
}
