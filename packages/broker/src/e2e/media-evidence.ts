// Video and trace files a worker uploaded for a browser scenario, made into the evidence pack's browser rows. The worker's files are UNTRUSTED. Each is held to its kind
// (magic bytes, the artifact size cap), a trace is scrubbed AGAIN here and the broker stores its own scrubbed bytes (never the worker's), and every file is scanned for the run's credentials. What fails is
// left out and named. Whether a kept file is shown is not decided here: the evidence pack builder applies the gate (run-scoped accounts, tier, company setting, revocation proof) and the caller deletes the
// files it withholds, so a withheld video cannot be fetched by its hash.
import { createHash } from "node:crypto";
import { EVIDENCE_ARTIFACT_MAX_BYTES, EVIDENCE_ARTIFACT_MAGIC, EVIDENCE_ARTIFACT_RETENTION, evaluatePublicationGate, type ArtifactRef, type EvidenceRaw, type MediaGateInput, type MediaGateResult } from "@agentx/contracts";
import { scrubTrace, type ScrubStats } from "@agentx/verifier";
import { revocationSettledAt, type RevocationReport } from "./run-scoped-accounts.js";
import type { buildEvidencePack } from "../core/proof/evidence-pack.js";

export interface MediaItem {
  scenarioId: string;
  kind: "video" | "trace";
  bytes: Uint8Array;
}

export type MediaProblem = "not_that_kind" | "over_cap" | "unsafe_content" | "duplicate" | "gate_refused";

export interface PreparedMedia {
  scenarioId: string;
  video?: ArtifactRef;
  trace?: ArtifactRef;
}

export interface PreparedMediaResult {
  rows: PreparedMedia[];
  /** The bytes to store, by the digest of exactly these bytes (a trace is the broker's re-scrubbed copy). */
  artifacts: Array<{ ref: ArtifactRef; data: Uint8Array }>;
  /** Fixed codes for the files left out; no scenario text, no error text. */
  problems: Array<{ scenarioId: string; kind: "video" | "trace"; problem: MediaProblem }>;
  /** What the broker's own scrub did to each trace it kept (counts only), so a reviewer can see that it was altered. */
  scrubbed: Array<{ scenarioId: string; stats: ScrubStats }>;
}

const sha256Of = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const hasMagic = (bytes: Uint8Array, hex: string) => hex.match(/../gu)!.every((pair, index) => bytes[index] === Number.parseInt(pair, 16));

/**
 * Holds each uploaded file to its kind and scrubs a trace again. `contains` is the run's credential scan in every spelling. One file of each kind a scenario.
 * `gate` is the FULL publication gate result and runs FIRST: bytes of a kind the gate refuses are not read, scrubbed or returned, so a withheld video is never written to the store at all
 * and there is nothing to delete afterwards. A caller that has no gate result cannot call this.
 */
export function prepareMediaArtifacts(items: readonly MediaItem[], options: { contains: (bytes: Uint8Array) => boolean; gate: Pick<MediaGateResult, "allowed">;
  /** Round secrets the broker knows beyond `contains` (the provisioners' returned secrets, every cookie and localStorage value): the scrub also learns the rest from the trace. WIRING: `contains` must hold the round's secrets. */
  secrets?: readonly string[];
  /** The account's own credentials alone: a snapshot that shows only those drops without dropping the screencast frames. Absent: every hit counts as a round secret (stricter). */
  accountContains?: (bytes: Uint8Array) => boolean }): PreparedMediaResult {
  const rows = new Map<string, PreparedMedia>();
  const artifacts = new Map<string, { ref: ArtifactRef; data: Uint8Array }>();
  const problems: PreparedMediaResult["problems"] = [];
  const scrubbed: PreparedMediaResult["scrubbed"] = [];
  for (const item of items) {
    const kind = item.kind === "video" ? "webm" : "trace_zip";
    const problem = (name: MediaProblem) => { problems.push({ scenarioId: item.scenarioId, kind: item.kind, problem: name }); };
    if (options.gate.allowed[item.kind] !== true) { problem("gate_refused"); continue; }
    const row = rows.get(item.scenarioId) ?? { scenarioId: item.scenarioId };
    if (row[item.kind] !== undefined) { problem("duplicate"); continue; }
    if (!(item.bytes instanceof Uint8Array) || !hasMagic(item.bytes, EVIDENCE_ARTIFACT_MAGIC[kind]!)) { problem("not_that_kind"); continue; }
    if (item.bytes.byteLength > EVIDENCE_ARTIFACT_MAX_BYTES[kind]) { problem("over_cap"); continue; }
    const result = item.kind === "trace" ? scrubTrace(item.bytes, options.contains, { ...(options.secrets === undefined ? {} : { secrets: options.secrets }), ...(options.accountContains === undefined ? {} : { accountContains: options.accountContains }) }) : undefined;
    const data = item.kind === "trace" ? (result?.zip ?? null) : options.contains(item.bytes) ? null : item.bytes;
    if (data === null) { problem("unsafe_content"); continue; }
    if (result) scrubbed.push({ scenarioId: item.scenarioId, stats: result.stats });
    if (data.byteLength > EVIDENCE_ARTIFACT_MAX_BYTES[kind]) { problem("over_cap"); continue; }
    const ref: ArtifactRef = { kind, sha256: sha256Of(data), bytes: data.byteLength, retentionClass: EVIDENCE_ARTIFACT_RETENTION[kind] };
    if (!artifacts.has(ref.sha256)) artifacts.set(ref.sha256, { ref, data });
    rows.set(item.scenarioId, { ...row, [item.kind]: ref });
  }
  return { rows: [...rows.values()], artifacts: [...artifacts.values()], problems, scrubbed };
}

/** Adds the prepared files to the pack's raw browser rows (a scenario with media but no strip gets a row with an empty strip). The pack builder decides what is kept. */
export function attachMedia(browser: NonNullable<EvidenceRaw["browser"]>, prepared: readonly PreparedMedia[]): NonNullable<EvidenceRaw["browser"]> {
  const byScenario = new Map(prepared.map((row) => [row.scenarioId, row] as const));
  const out = browser.map((row) => {
    const media = byScenario.get(row.scenarioId);
    byScenario.delete(row.scenarioId);
    return media === undefined ? row : { ...row, ...(media.video === undefined ? {} : { video: media.video }), ...(media.trace === undefined ? {} : { trace: media.trace }) };
  });
  for (const media of byScenario.values()) {
    out.push({ scenarioId: media.scenarioId, strip: { before: [], after: [] }, ...(media.video === undefined ? {} : { video: media.video }), ...(media.trace === undefined ? {} : { trace: media.trace }) });
  }
  return out;
}

/**
 * The `media` input of `buildEvidencePack` AND the gate result for `prepareMediaArtifacts`, from the approved environment and the round's REVOCATION REPORT, both from one publication-gate evaluation.
 * The proof is read with `revocationSettledAt(report, now)` and nothing else: a held report settles only once its hold has run out, a report taken at revoke time is not "confirmed" for ever, and
 * a missing report refuses every kind. A caller cannot hand in a boolean.
 */
export function publicationMediaFor(input: Omit<MediaGateInput, "revocationConfirmed"> & { revocation: RevocationReport | undefined; now: number }): { gate: MediaGateResult; media: NonNullable<Parameters<typeof buildEvidencePack>[0]["media"]> } {
  const { revocation, now, ...gateInput } = input;
  const settled = revocation !== undefined && revocationSettledAt(revocation, now);
  const gate = evaluatePublicationGate({ ...gateInput, revocationConfirmed: settled });
  return { gate, media: { companyAllows: { video: input.companyAllows.video, trace: input.companyAllows.trace }, revocationConfirmed: settled, tierAllowed: gate.tierAllowed, gate: { allowed: gate.allowed, reasons: gate.reasons } } };
}
