import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import { RuntimeInstallChallengeSchema, RuntimeInstallManifestSchema } from "./runtime-installation.js";
import { ProjectSetupRunnerEnvironmentSchema, ProjectSetupRunnerToolchainSchema } from "./session.js";

/** The web/API application runtime profile and the one scope its qualification proves. */
export const WEB_API_RUNTIME_PROFILE_ID = "linux-arm64-web-api-v1" as const;
export const WEB_API_RUNTIME_SCOPE = "application-web-api/v1" as const;
/** The build command in `build-imds-denial-v1` exits with this code when the metadata service is unreachable. */
export const WEB_API_IMDS_DENIAL_EXIT_CODE = 7 as const;

/** What a probe must show for it to count as its expected failure; anything else is a different failure. */
type ExpectedFailureCause =
  | Readonly<{ kind: "assertion"; assertionKind: "csv" | "http-status" }>
  | Readonly<{ kind: "blocked-host"; host: string }>
  | Readonly<{ kind: "build-failed" }>;
type RequiredProbe = Readonly<{ probeId: string; kind: "web" | "api" | "build"; expectedOutcome: "PASS" | "EXPECTED_FAILURE"; cause: ExpectedFailureCause | null }>;

/** The exact probe set M1.1 requires, in the order a proposal carries it. The auth and tenant probes belong to M1.3. */
const requiredProbes: RequiredProbe[] = [
  { probeId: "web-csv-positive-v1", kind: "web", expectedOutcome: "PASS", cause: null },
  { probeId: "web-csv-negative-v1", kind: "web", expectedOutcome: "EXPECTED_FAILURE", cause: { kind: "assertion", assertionKind: "csv" } },
  { probeId: "web-egress-denial-v1", kind: "web", expectedOutcome: "EXPECTED_FAILURE", cause: { kind: "blocked-host", host: "probe.example.com" } },
  { probeId: "api-state-positive-v1", kind: "api", expectedOutcome: "PASS", cause: null },
  // The app, not the browser, makes this request, so the executor cannot record the blocked host; the dependency check fails instead.
  { probeId: "api-egress-denial-v1", kind: "api", expectedOutcome: "EXPECTED_FAILURE", cause: { kind: "assertion", assertionKind: "http-status" } },
  { probeId: "build-imds-denial-v1", kind: "build", expectedOutcome: "EXPECTED_FAILURE", cause: { kind: "build-failed" } },
];
export const WEB_API_REQUIRED_PROBES: readonly RequiredProbe[] = Object.freeze(requiredProbes.map((probe) => Object.freeze(probe)));
export const WEB_API_REQUIRED_PROBE_IDS = WEB_API_REQUIRED_PROBES.map((probe) => probe.probeId) as [string, ...string[]];
const probeIdSchema = z.enum(WEB_API_REQUIRED_PROBE_IDS);

const digest = z.string().regex(/^[a-f0-9]{64}$/);

/** The facts about one probe run that qualification judges. It is evidence, never a verdict. */
export const WebApiProbeObservationSchema = z.object({
  /** The real collector's verdict for the run; null when the run was unavailable and nothing was collected. */
  collectorStatus: z.enum(["PASS", "FAILED", "UNKNOWN"]).nullable(),
  runUnavailableReason: z.string().min(1).max(200).nullable(),
  /** The kinds of the assertions the collector found failed, in assertion order. */
  failedAssertionKinds: z.array(z.string().min(1).max(32)).max(16),
  /** The hosts the executor recorded as blocked in blocked-requests.json. */
  blockedHosts: z.array(z.string().min(1).max(253)).max(64),
  buildExitCode: z.number().int().min(0).max(255).nullable(),
  attempts: z.number().int().min(1).max(100),
  skipped: z.number().int().min(0).max(1000),
  flaky: z.number().int().min(0).max(1000),
  /** A digest of the retained run evidence the runner observed these facts from. */
  evidenceDigest: digest,
}).strict();
export type WebApiProbeObservation = z.infer<typeof WebApiProbeObservationSchema>;

export type WebApiProbeVerdict = Readonly<{ ok: true }> | Readonly<{ ok: false; reason: string }>;

const sameList = (left: readonly string[], right: readonly string[]) => left.length === right.length && left.every((item, index) => item === right[index]);

/**
 * The pure oracle for one probe. An expected failure counts only when it failed for its stated cause; a pass where a failure was
 * required, a failure for another cause, and anything skipped, flaky or retried each reject with a stable reason.
 */
export function evaluateWebApiProbeObservation(probeId: string, observationInput: unknown): WebApiProbeVerdict {
  const probe = WEB_API_REQUIRED_PROBES.find((item) => item.probeId === probeId);
  if (!probe) return { ok: false, reason: `unknown-probe:${probeId}` };
  const parsed = WebApiProbeObservationSchema.safeParse(observationInput);
  if (!parsed.success) return { ok: false, reason: `probe-observation-invalid:${probeId}` };
  const observation = parsed.data;
  if (observation.skipped > 0) return { ok: false, reason: `probe-skipped:${probeId}` };
  if (observation.flaky > 0) return { ok: false, reason: `probe-flaky:${probeId}` };
  if (observation.attempts !== 1) return { ok: false, reason: `probe-retried:${probeId}` };
  const passed = observation.collectorStatus === "PASS" && observation.runUnavailableReason === null;
  if (probe.expectedOutcome === "PASS") return passed ? { ok: true } : { ok: false, reason: `positive-probe-failed:${probeId}` };
  if (passed) return { ok: false, reason: `negative-probe-passed:${probeId}` };
  const cause = probe.cause!;
  const wrongCause = { ok: false as const, reason: `probe-wrong-cause:${probeId}` };
  if (cause.kind === "assertion") {
    return observation.collectorStatus === "FAILED" && observation.runUnavailableReason === null
      && sameList(observation.failedAssertionKinds, [cause.assertionKind]) ? { ok: true } : wrongCause;
  }
  if (cause.kind === "blocked-host") return observation.blockedHosts.includes(cause.host) ? { ok: true } : wrongCause;
  return observation.runUnavailableReason === "build-failed" && observation.collectorStatus === null
    && observation.buildExitCode === WEB_API_IMDS_DENIAL_EXIT_CODE ? { ok: true } : wrongCause;
}

const ProbeRecordSchema = z.object({
  probeId: probeIdSchema, kind: z.enum(["web", "api", "build"]), expectedOutcome: z.enum(["PASS", "EXPECTED_FAILURE"]),
  observedOutcome: z.enum(["PASS", "EXPECTED_FAILURE"]), assetDigest: digest, observation: WebApiProbeObservationSchema,
}).strict();

/**
 * The web/API qualification proposal. Its `state` is a label, not an authority: the schema re-judges every recorded observation
 * with the same pure oracle the qualifier used, so a proposal can only parse as READY when its evidence shows the required outcomes.
 */
export const WebApiRuntimeInstallProposalSchema = z.object({
  schemaVersion: z.literal("runtime-installation-proposal/v2"), state: z.literal("READY"),
  profileId: z.literal(WEB_API_RUNTIME_PROFILE_ID), scope: z.literal(WEB_API_RUNTIME_SCOPE),
  challenge: RuntimeInstallChallengeSchema, createdAt: z.string().datetime(), manifest: RuntimeInstallManifestSchema,
  runnerEnvironment: ProjectSetupRunnerEnvironmentSchema, runnerToolchain: ProjectSetupRunnerToolchainSchema,
  probes: z.array(ProbeRecordSchema).length(WEB_API_REQUIRED_PROBES.length),
}).strict().superRefine((proposal, context) => {
  if (proposal.challenge.profileId !== WEB_API_RUNTIME_PROFILE_ID) context.addIssue({ code: "custom", path: ["challenge", "profileId"], message: "challenge profile must be the web/API runtime profile" });
  if (Date.parse(proposal.createdAt) < Date.parse(proposal.challenge.issuedAt) || Date.parse(proposal.createdAt) >= Date.parse(proposal.challenge.expiresAt)) {
    context.addIssue({ code: "custom", path: ["createdAt"], message: "proposal must be created during its challenge window" });
  }
  if (proposal.runnerToolchain.platform !== "linux" || proposal.runnerToolchain.arch !== "arm64") context.addIssue({ code: "custom", path: ["runnerToolchain"], message: "web/API runtime qualifies only on a Linux ARM64 host" });
  if (proposal.runnerEnvironment.arch !== proposal.runnerToolchain.arch || !proposal.runnerEnvironment.os.toLowerCase().startsWith("linux ")
    || proposal.runnerEnvironment.runtime !== `node ${proposal.runnerToolchain.version}`) context.addIssue({ code: "custom", path: ["runnerEnvironment"], message: "runner environment must retain the observed OS release, architecture, and exact Node runtime" });
  WEB_API_REQUIRED_PROBES.forEach((required, index) => {
    const probe = proposal.probes[index];
    if (!probe) return;
    if (probe.probeId !== required.probeId || probe.kind !== required.kind || probe.expectedOutcome !== required.expectedOutcome || probe.observedOutcome !== required.expectedOutcome) {
      context.addIssue({ code: "custom", path: ["probes", index], message: `probe ${index} must be ${required.probeId} with its fixed expected outcome` });
      return;
    }
    const verdict = evaluateWebApiProbeObservation(probe.probeId, probe.observation);
    if (!verdict.ok) context.addIssue({ code: "custom", path: ["probes", index, "observation"], message: verdict.reason });
  });
});
export type WebApiRuntimeInstallProposal = z.infer<typeof WebApiRuntimeInstallProposalSchema>;

export function webApiRuntimeInstallProposalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(WebApiRuntimeInstallProposalSchema.parse(value))).digest("hex");
}

/** The fixed network policy this profile enforces: an internal per-run network, outside egress denied, metadata unreachable. */
export const WEB_API_NETWORK_POLICY = Object.freeze({
  schemaVersion: "e2e-web-api-network-policy/v1", appNetwork: "per-run-internal", outsideEgress: "denied", instanceMetadata: "unreachable",
});
export const WEB_API_NETWORK_POLICY_DIGEST = createHash("sha256").update(canonicalJson(WEB_API_NETWORK_POLICY)).digest("hex");
