// The API samples of an API scenario, and the structural diff between the unchanged code's (baseline) and the candidate's, as the evidence pack's `api` rows.
// Pure. A sample is read back only when it is what it says (a listed, undropped API sample for a case of the group, named for that case and step, base64 that decodes back to the same text,
// of the listed size and digest, and strictly the sample schema); anything else is ignored and nothing here throws. The diff is computed here from the two stored samples, never from anything the
// worker says about them, and it carries paths only, never a value.
import { createHash } from "node:crypto";
import { EVIDENCE_API_SAMPLES_MAX, EVIDENCE_ARTIFACT_MAX_BYTES, EVIDENCE_ARTIFACT_RETENTION, diffApiSamples, parseApiSample, type ApiSample, type ArtifactRef, type EvidenceRaw } from "@agentx/contracts";

export interface SampleFile {
  /** The index of the request step the sample records. */
  step: number;
  sha256: string;
  data: Uint8Array;
  sample: ApiSample;
}

const FILE_NAME = /^case-(\d{1,4})-api-(\d{1,4})\.json$/u;
const sha256Of = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The API samples a group's operator evidence lists and carries, by case id, each case's samples in step order. */
export function readCaptureApiSamples(operatorEvidence: unknown, caseIds: ReadonlySet<string>): Map<string, SampleFile[]> {
  const kept = new Map<string, SampleFile[]>();
  try {
    const captures = isRecord(operatorEvidence) ? operatorEvidence.captures : undefined;
    if (!isRecord(captures) || !Array.isArray(captures.artifacts) || !Array.isArray(captures.files)) return kept;
    const used = new Set<string>();
    for (const entry of captures.artifacts as unknown[]) {
      if (!isRecord(entry) || entry.kind !== "api-sample" || entry.omitted !== undefined || typeof entry.caseId !== "string" || !caseIds.has(entry.caseId)) continue;
      if (!Number.isInteger(entry.step) || (entry.step as number) < 0 || (entry.step as number) > 9_999) continue;
      const step = entry.step as number;
      const list = kept.get(entry.caseId) ?? [];
      if (list.length >= EVIDENCE_API_SAMPLES_MAX || list.some((item) => item.step === step)) continue;
      if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(entry.sha256) || !Number.isInteger(entry.bytes) || (entry.bytes as number) <= 0 || (entry.bytes as number) > EVIDENCE_ARTIFACT_MAX_BYTES.api_sample_json) continue;
      const file = (captures.files as unknown[]).find((candidate) => isRecord(candidate) && candidate.sha256 === entry.sha256 && typeof candidate.name === "string" && !used.has(candidate.name)
        && FILE_NAME.exec(candidate.name)?.[2] === String(step));
      if (!isRecord(file) || typeof file.base64 !== "string" || file.bytes !== entry.bytes) continue;
      const bytes = Buffer.from(file.base64, "base64");
      if (bytes.toString("base64") !== file.base64 || bytes.byteLength !== entry.bytes || sha256Of(bytes) !== entry.sha256) continue;
      const sample = parseApiSample(bytes);
      if (sample === undefined) continue;
      used.add(file.name as string);
      list.push({ step, sha256: entry.sha256, data: new Uint8Array(bytes), sample });
      kept.set(entry.caseId, list);
    }
    for (const list of kept.values()) list.sort((a, b) => a.step - b.step);
  } catch { /* evidence of the wrong shape keeps nothing */ }
  return kept;
}

export interface ScenarioSamples {
  scenarioId: string;
  samples: readonly SampleFile[];
}

/** One entry per approved scenario: the samples of its first case (by case id) that has any. */
export function scenarioSamplesOf(groups: ReadonlyArray<{ cases: ReadonlyArray<{ caseId: string; scenarioId: string }>; samples: ReadonlyMap<string, readonly SampleFile[]> }>): ScenarioSamples[] {
  const byScenario = new Map<string, { caseId: string; samples: readonly SampleFile[] }>();
  for (const group of groups) {
    for (const item of group.cases) {
      const samples = group.samples.get(item.caseId);
      if (samples === undefined || samples.length === 0) continue;
      const have = byScenario.get(item.scenarioId);
      if (have === undefined || item.caseId < have.caseId) byScenario.set(item.scenarioId, { caseId: item.caseId, samples });
    }
  }
  return [...byScenario.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([scenarioId, value]) => ({ scenarioId, samples: value.samples }));
}

export interface ApiEvidenceResult {
  /** The evidence pack's api rows (the raw shape the broker's pack builder reads). */
  api: NonNullable<EvidenceRaw["api"]>;
  /** Each distinct sample, to store as an `api_sample_json` artifact before the pack is built. */
  artifacts: Array<{ ref: ArtifactRef; data: Uint8Array }>;
}

/**
 * The pack's api rows for a candidate round and its baseline: the candidate's samples, and the diff of each against the baseline's sample of the same request step. A step the baseline has no
 * sample for is left out of the comparison; with no step in common the diff is `no_baseline`. A changed step names its paths as `step <n> <path>`.
 */
export function apiEvidenceOf(input: { candidate: readonly ScenarioSamples[]; baseline?: readonly ScenarioSamples[] | undefined }): ApiEvidenceResult {
  const baseline = new Map((input.baseline ?? []).map((item) => [item.scenarioId, item.samples] as const));
  const artifacts = new Map<string, { ref: ArtifactRef; data: Uint8Array }>();
  const api: ApiEvidenceResult["api"] = [];
  for (const scenario of input.candidate) {
    if (scenario.samples.length === 0) continue;
    const before = baseline.get(scenario.scenarioId) ?? [];
    let compared = 0;
    const changedPaths: string[] = [];
    for (const sample of scenario.samples) {
      const match = before.find((item) => item.step === sample.step);
      if (match === undefined) continue;
      compared += 1;
      for (const path of diffApiSamples(match.sample, sample.sample).changedPaths) changedPaths.push(`step ${sample.step} ${path}`);
    }
    const refs = scenario.samples.slice(0, EVIDENCE_API_SAMPLES_MAX).map((sample): ArtifactRef => {
      const ref: ArtifactRef = { kind: "api_sample_json", sha256: sample.sha256, bytes: sample.data.byteLength, retentionClass: EVIDENCE_ARTIFACT_RETENTION.api_sample_json };
      if (!artifacts.has(ref.sha256)) artifacts.set(ref.sha256, { ref, data: sample.data });
      return ref;
    });
    api.push({ scenarioId: scenario.scenarioId, samples: refs, diff: compared === 0 ? "no_baseline" : changedPaths.length === 0 ? "none" : "changed", changedPaths: changedPaths.slice(0, 50) });
  }
  return { api, artifacts: [...artifacts.values()] };
}
