import type { WebApiProbeObservation } from "@agentx/contracts";

/**
 * What a failed runtime qualification may say about itself without host access. The qualification log can carry stack traces, paths and values echoed by a
 * schema error, so none of it travels: only stable codes do, and every code is checked against one grammar here and again by the boot hook that reads the file.
 */
export const QUALIFICATION_FAILURE_SCHEMA_VERSION = "runtime-install-failure/v1";
/** `qualification-rejected`, `probe-wrong-cause:api-egress-denial-v1` and the like: lower-case words with hyphens, and at most one colon. */
export const QUALIFICATION_FAILURE_CODE = /^[a-z0-9-]+(:[a-z0-9-]+)?$/;
/** The most codes one failure carries: its stage, then the reasons and the summary together. */
export const QUALIFICATION_FAILURE_MAX_CODES = 16;
/** The most bytes of codes one failure carries. */
export const QUALIFICATION_FAILURE_MAX_BYTES = 2_048;
/** Each side of a code's colon is at most this long (so a code is at most 97 characters and 16 of them are under 2 KB), which the boot hook's filter holds to as well. */
const MAX_PART_LENGTH = 48;

/** Qualification failed closed; `reasons` are the stable per-probe codes, for example `negative-probe-passed:web-csv-negative-v1`, and `summary` the facts of the probes they name. */
export class WebApiQualificationRejected extends Error {
  constructor(readonly reasons: readonly string[], readonly summary: readonly string[] = []) { super(`web/API runtime qualification rejected: ${reasons.join(", ")}`); this.name = "WebApiQualificationRejected"; }
}

/** A step of the qualification that failed with an error whose message is free text; the stage is the only thing of it that is reported. */
export class QualificationStageError extends Error {
  constructor(readonly stage: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "QualificationStageError";
  }
}

/** Runs one step; an error of it other than a rejection is reported as a failure of `stage`. */
export async function qualificationStage<T>(stage: string, step: () => T | Promise<T>): Promise<T> {
  try { return await step(); } catch (error) { throw error instanceof WebApiQualificationRejected ? error : new QualificationStageError(stage, error); }
}

export type QualificationFailure = Readonly<{ schemaVersion: typeof QUALIFICATION_FAILURE_SCHEMA_VERSION; stage: string; reasons: readonly string[]; summary: readonly string[] }>;

const isCode = (value: unknown): value is string => typeof value === "string" && QUALIFICATION_FAILURE_CODE.test(value) && value.split(":").every((part) => part.length <= MAX_PART_LENGTH);

/** The codes that fit the bounds, in order, reasons before summary: only strings of the grammar, and with the stage at most 16 codes and 2 KB in all. */
export function boundQualificationCodes(reasons: readonly unknown[], summary: readonly unknown[]): { reasons: string[]; summary: string[] } {
  // The stage is the first code of the report and takes one place of the budget.
  let count = 1; let bytes = 0;
  const take = (codes: readonly unknown[]): string[] => {
    const kept: string[] = [];
    for (const code of codes) {
      if (!isCode(code)) continue;
      // Each code costs its length, its quotes and a comma in the JSON that carries it.
      if (count >= QUALIFICATION_FAILURE_MAX_CODES || bytes + code.length + 3 > QUALIFICATION_FAILURE_MAX_BYTES) break;
      kept.push(code); count += 1; bytes += code.length + 3;
    }
    return kept;
  };
  const keptReasons = take(reasons);
  return { reasons: keptReasons, summary: take(summary) };
}

const word = (value: string, max: number): string => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, max).replace(/-+$/, "");

/**
 * The few facts of one probe's observation that tell which cause it showed, as codes: enums, short kebab-case reason words and counters only. The
 * probe's own text (blocked hosts, evidence digests) is never read.
 */
export function summarizeProbeObservation(probeId: string, observation: WebApiProbeObservation): string[] {
  const codes: string[] = [`${probeId}:collector-${observation.collectorStatus === null ? "none" : observation.collectorStatus.toLowerCase()}`];
  const add = (prefix: string, text: string | null | undefined) => { const found = text === null || text === undefined ? "" : word(text, MAX_PART_LENGTH - 1 - prefix.length); if (found !== "") codes.push(`${probeId}:${prefix}-${found}`); };
  add("unavailable", observation.runUnavailableReason);
  add("run", observation.runReason);
  for (const kind of observation.failedAssertionKinds.slice(0, 3)) add("assert", kind);
  if (observation.unmockedCalls !== undefined) codes.push(`${probeId}:sinkhole-${observation.unmockedCalls.sinkhole}`, `${probeId}:mocked-${observation.unmockedCalls.mocked}`);
  if (observation.buildExitCode !== null) codes.push(`${probeId}:build-exit-${observation.buildExitCode}`);
  return codes.filter(isCode);
}

/**
 * The failure of one run of the qualification CLI. A rejection contributes its stable reasons and the summary of the probes it rejected; any other error contributes
 * the stage it happened in (`fallbackStage` when it carries none), never its message.
 */
export function qualificationFailureOf(error: unknown, fallbackStage: string): QualificationFailure {
  const rejected = error instanceof WebApiQualificationRejected;
  const stage = rejected ? "qualification-rejected" : error instanceof QualificationStageError ? error.stage : fallbackStage;
  const bounded = rejected ? boundQualificationCodes(error.reasons, error.summary) : { reasons: [], summary: [] };
  // The stage comes first in the file: the boot hook reads codes in order, and the stage is the first it keeps.
  return { schemaVersion: QUALIFICATION_FAILURE_SCHEMA_VERSION, stage: isCode(stage) && !stage.includes(":") ? stage : "internal", reasons: bounded.reasons, summary: bounded.summary };
}
