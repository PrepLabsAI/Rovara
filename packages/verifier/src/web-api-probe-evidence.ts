import { createHash } from "node:crypto";
import { ChromiumSandboxAttestationSchema, E2EScenarioBundleSchema, WEB_API_REQUIRED_PROBES, WebApiProbeEvidenceSchema, WebApiProbeObservationSchema, canonicalJson, evaluateChromiumSandbox, webApiProbeRunId,
  type RuntimeInstallChallenge, type WebApiProbeEvidence, type WebApiProbeObservation } from "@agentx/contracts";
import { parseE2EApplicationReport } from "./application-report-schema.js";
import { E2EApplicationCollectionOracleSchema, E2EApplicationCollectionSchema, qualifyE2EApplicationCollection } from "./application-result-adapter.js";

type RequiredProbe = (typeof WEB_API_REQUIRED_PROBES)[number];
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

export type WebApiProbeDerivation = Readonly<{ ok: true; observation: WebApiProbeObservation } | { ok: false; reason: string }>;
const mismatch = (probeId: string): WebApiProbeDerivation => ({ ok: false, reason: `probe-evidence-mismatch:${probeId}` });

/** The hosts the executor recorded as blocked, read from its blocked-requests file once the file is shown to belong to this run's shards. */
function blockedHostsOf(base64: string | null, expected: { runId: string; groupId: string; upstreamRunIds: readonly string[] }): string[] | null {
  if (base64 === null) return [];
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(base64, "base64"))) as {
      schemaVersion?: unknown; runId?: unknown; groupId?: unknown; shards?: unknown; blocked?: unknown };
    const shards = Array.isArray(value.shards) ? value.shards as { upstreamRunId?: unknown }[] : null;
    if (value.schemaVersion !== "e2e-executor-blocked-requests/v1" || value.runId !== expected.runId || value.groupId !== expected.groupId || shards === null
      || canonicalJson(shards.map((shard) => shard.upstreamRunId)) !== canonicalJson([...expected.upstreamRunIds]) || !Array.isArray(value.blocked)) return null;
    const hosts = (value.blocked as { host?: unknown }[]).map((item) => item.host);
    return hosts.every((host): host is string => typeof host === "string" && host.length > 0 && host.length <= 253) ? [...new Set(hosts)] : null;
  } catch { return null; }
}

/**
 * The executor's Chromium sandbox attestation, accepted only when it names this run and group and its raw facts, judged by the same pure evaluator the
 * executor used, show every renderer behind its own seccomp filter, PID namespace and user namespace. Null means the bytes cannot stand as that evidence.
 */
function sandboxedAttestation(base64: string | null | undefined, expected: { runId: string; groupId: string }): boolean {
  if (base64 === null || base64 === undefined) return false;
  try {
    const parsed = ChromiumSandboxAttestationSchema.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(base64, "base64"))));
    return parsed.success && parsed.data.runId === expected.runId && parsed.data.groupId === expected.groupId && evaluateChromiumSandbox(parsed.data).sandboxed;
  } catch { return false; }
}

/**
 * Derives what one probe run showed from its retained evidence alone. This is the only place an observation comes from: the production runner
 * calls it to produce the observation it reports, and the registrar calls it again on the embedded bytes, so a recorded observation can be
 * nothing but what the bytes say. It is pure (no Docker, no browser, no files), so the broker may run it.
 *
 * `probe-evidence-unbound` means the evidence is not a run of this challenge's probe; `probe-evidence-mismatch` means it cannot be re-derived
 * (not the pinned scenario, collector bytes that do not hold together, a blocked-requests file of another run).
 */
export function deriveWebApiProbeObservation(input: Readonly<{ challenge: RuntimeInstallChallenge; probeId: string; evidence: unknown;
  /** Test seam: the pinned probe table to check against. Production never passes it, so the pins in contracts always apply. */
  pins?: readonly RequiredProbe[] }>): WebApiProbeDerivation {
  const required = (input.pins ?? WEB_API_REQUIRED_PROBES).find((probe) => probe.probeId === input.probeId);
  if (!required) return { ok: false, reason: `unknown-probe:${input.probeId}` };
  const parsed = WebApiProbeEvidenceSchema.safeParse(input.evidence);
  if (!parsed.success) return mismatch(required.probeId);
  const evidence: WebApiProbeEvidence = parsed.data;
  if (evidence.runId !== webApiProbeRunId(input.challenge, required.probeId)) return { ok: false, reason: `probe-evidence-unbound:${required.probeId}` };
  const evidenceDigest = sha(canonicalJson(evidence));
  const clean = { attempts: 1, skipped: 0, flaky: 0 } as const;

  if (evidence.kind === "unavailable") {
    // The build probe must show the build command it pinned; a different command's failure says nothing about the metadata service.
    if (required.buildCommandDigest !== null && evidence.reason === "build-failed"
      && (evidence.build === null || evidence.build.command === null || sha(canonicalJson(evidence.build.command)) !== required.buildCommandDigest)) return mismatch(required.probeId);
    return { ok: true, observation: WebApiProbeObservationSchema.parse({ collectorStatus: null, runUnavailableReason: evidence.reason, failedAssertionKinds: [], blockedHosts: [],
      buildExitCode: evidence.reason === "build-failed" ? evidence.build?.exitCode ?? null : null, ...clean, evidenceDigest }) };
  }

  if (required.scenarioDigest === null) return mismatch(required.probeId);
  const bundle = E2EScenarioBundleSchema.safeParse(evidence.scenarioBundle);
  const oracle = E2EApplicationCollectionOracleSchema.safeParse(evidence.oracle);
  const collection = E2EApplicationCollectionSchema.safeParse(evidence.collection);
  if (!bundle.success || !oracle.success || !collection.success) return mismatch(required.probeId);
  const scenario = bundle.data.scenarios[0];
  if (bundle.data.scenarios.length !== 1 || !scenario || sha(canonicalJson(scenario)) !== required.scenarioDigest
    || bundle.data.bundleDigest !== required.bundleDigest || oracle.data.binding.bundleDigest !== bundle.data.bundleDigest) return mismatch(required.probeId);
  if (oracle.data.binding.runId !== evidence.runId) return { ok: false, reason: `probe-evidence-unbound:${required.probeId}` };

  // The sandbox attestation belongs to exactly the probe that pins it: required there, and never carried by another probe's evidence.
  if (required.chromiumSandbox === true ? !sandboxedAttestation(evidence.chromiumSandboxBase64, { runId: evidence.runId, groupId: oracle.data.groupId })
    : evidence.chromiumSandboxBase64 !== undefined) return mismatch(required.probeId);

  const qualification = qualifyE2EApplicationCollection(oracle.data, collection.data);
  const hosts = blockedHostsOf(evidence.blockedRequestsBase64, { runId: evidence.runId, groupId: oracle.data.groupId,
    upstreamRunIds: collection.data.shards.map((shard) => shard.runStart.runId) });
  if (hosts === null) return mismatch(required.probeId);
  const failedAssertionKinds = (qualification.result?.cases ?? []).flatMap((verdict) => verdict.assertionReceipts
    .filter((receipt) => receipt.status === "failed").map((receipt) => scenario.assertions[receipt.assertionIndex]?.kind ?? "unknown"));
  const reports = collection.data.shards.map((shard) => parseE2EApplicationReport(Buffer.from(shard.rawReport.bytesBase64, "base64")));
  const parsedReports = reports.flatMap((report) => (report.kind === "parsed" ? [report.report.run] : []));
  return { ok: true, observation: WebApiProbeObservationSchema.parse({ collectorStatus: qualification.status, runUnavailableReason: null, failedAssertionKinds, blockedHosts: hosts, buildExitCode: null,
    attempts: Math.max(1, ...parsedReports.flatMap((run) => run.results.map((result) => result.attempts.length))),
    skipped: parsedReports.reduce((total, run) => total + run.summary.skipped, 0), flaky: parsedReports.reduce((total, run) => total + run.summary.flaky, 0), evidenceDigest }) };
}

/** The registrar's check for one probe record: its evidence derives, and derives to exactly the observation the record claims. */
export function verifyWebApiProbeRecord(input: Readonly<{ challenge: RuntimeInstallChallenge; probeId: string; observation: unknown; evidence: unknown; pins?: readonly RequiredProbe[] }>): Readonly<{ ok: true } | { ok: false; reason: string }> {
  const derived = deriveWebApiProbeObservation(input);
  if (!derived.ok) return derived;
  return canonicalJson(derived.observation) === canonicalJson(input.observation) ? { ok: true } : mismatch(input.probeId);
}
