import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import { Ec2RuntimeBindingSchema, ProjectSetupRunnerEnvironmentSchema, ProjectSetupRunnerToolchainSchema } from "./session.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const RUNTIME_IMAGE = "node@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9";
const FIXED_PROBE_RECEIPTS = [
  { probeId: "source-interface-positive/v1", caseId: "case-a9eb53e1895372a6148bf5bb92aca811df9d7e7d72c6e4bf0e0341de7033e229", assertionDigest: "1c28b3d0f687398bf7abcd40fc79ebe1f273a5ce368899259e8ee0e56e09929a" },
  { probeId: "process-response-positive/v1", caseId: "case-e1a9e129a98030e665eb13a5dbbc2c643624b1bfb893d2611baaed6688b9b9a7", assertionDigest: "e1278b28ba1f5605a24c8c8c0eff3e43940ae92ec531934d897490453d85959a" },
  { probeId: "process-response-negative/v1", caseId: "case-e014583b1e51edfe14e5d0cb2df6bde986cd7583c6b51eb913e0891cfc2d0fbe", assertionDigest: "72bffdef0f4bf7965fa6b62dac5d04643587adac796f31c18fa399cb9f5d38af" },
] as const;
const FIXED_PACKET_IDENTITIES = [
  { sourceDigest: "3b5ad26d381ff4ea28b41019954b23771a598d838aeb4008cdae41c87bc09a79", sourceBytes: 782 },
  { sourceDigest: "d364565e3e56fec557da690e15fbc385fccd215096deff75b92dcfb7229e3a4a", sourceBytes: 2021 },
  { sourceDigest: "d364565e3e56fec557da690e15fbc385fccd215096deff75b92dcfb7229e3a4a", sourceBytes: 2021 },
] as const;
const catalogId = z.string().trim().min(1).max(160);
const profile = z.enum(["darwin-arm64-colima-v1", "linux-arm64-docker-v1"]);
const privateIpv4Url = z.string().url().max(512).superRefine((value, context) => {
  let url: URL;
  try { url = new URL(value); } catch { context.addIssue({ code: "custom", message: "endpoint must be a private IPv4 HTTP URL" }); return; }
  const octets = url.hostname.split(".").map(Number);
  const [a, b] = octets;
  const privateAddress = (a === 10 && Number.isInteger(b)) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168);
  if (url.protocol !== "http:" || isIP(url.hostname) !== 4 || octets.length !== 4 || !privateAddress || url.port !== "8080" || url.pathname !== "/" || url.username || url.password || url.search || url.hash) context.addIssue({ code: "custom", message: "endpoint must be a private IPv4 HTTP worker URL on port 8080 without credentials, path, query, or fragment" });
});

/** Broker-minted, single-use capability for one exact host/profile/catalog installation attempt. */
export const RuntimeInstallChallengeSchema = z.object({
  schemaVersion: z.literal("runtime-install-challenge/v1"), challengeId: z.string().uuid(), challengeSecret: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
  issuedAt: z.string().datetime(), expiresAt: z.string().datetime(), issuedByOwnerKey: z.string().trim().min(1).max(256), issuedBySubject: z.string().trim().min(1).max(256), binding: Ec2RuntimeBindingSchema,
  setupCatalogId: catalogId, featureCatalogId: catalogId, profileId: profile, endpoint: privateIpv4Url,
  generation: z.number().int().positive(), transportCorrelationId: z.string().uuid(),
  probeCorrelations: z.object({ sourceInterface: z.string().uuid(), featurePositive: z.string().uuid(), featureNegative: z.string().uuid() }).strict(),
}).strict().superRefine((challenge, context) => {
  if (challenge.setupCatalogId === challenge.featureCatalogId) context.addIssue({ code: "custom", path: ["featureCatalogId"], message: "setup and feature catalogs must be distinct" });
  const probeIds = Object.values(challenge.probeCorrelations);
  if (new Set(probeIds).size !== probeIds.length || probeIds.includes(challenge.transportCorrelationId)) context.addIssue({ code: "custom", path: ["probeCorrelations"], message: "challenge probe identities must be distinct from each other and the transport identity" });
  if (Date.parse(challenge.issuedAt) >= Date.parse(challenge.expiresAt)) context.addIssue({ code: "custom", path: ["expiresAt"], message: "challenge expiry must follow issuance" });
});
export type RuntimeInstallChallenge = z.infer<typeof RuntimeInstallChallengeSchema>;

export const RuntimeInstallProbeIdSchema = z.enum([
  "source-interface-positive/v1",
  "process-response-positive/v1",
  "process-response-negative/v1",
]);
const RuntimeInstallByteCaptureSchema = z.object({
  bytesBase64: z.string().max(900_000), sha256: digest,
}).strict().superRefine((capture, context) => {
  const bytes = Buffer.from(capture.bytesBase64, "base64");
  if (bytes.toString("base64") !== capture.bytesBase64 || createHash("sha256").update(bytes).digest("hex") !== capture.sha256) {
    context.addIssue({ code: "custom", path: ["sha256"], message: "execution evidence digest must identify its original canonical bytes" });
  }
});
const RuntimeInstallCaptureSchema = z.object({
  name: z.string().regex(/^(?:source-interface-positive|process-response-positive|process-response-negative)-(?:request|response)\.json$|^(?:source-interface-positive|process-response-positive|process-response-negative)-stderr\.bin$/),
  bytesBase64: z.string().max(128 * 1024), sha256: digest,
}).strict().superRefine((capture, context) => {
  const bytes = Buffer.from(capture.bytesBase64, "base64");
  if ((bytes.byteLength === 0 && !capture.name.endsWith("-stderr.bin")) || bytes.toString("base64") !== capture.bytesBase64) context.addIssue({ code: "custom", path: ["bytesBase64"], message: "capture must be canonical base64 and required protocol frames must be non-empty" });
  else if (createHash("sha256").update(bytes).digest("hex") !== capture.sha256) context.addIssue({ code: "custom", path: ["sha256"], message: "capture digest does not identify the original bounded bytes" });
});
const RuntimeInstallProbeSchema = z.object({
  probeId: RuntimeInstallProbeIdSchema, requestCorrelationId: z.string().uuid(),
  expectedOutcome: z.enum(["PASS", "EXPECTED_FAILURE"]), observedOutcome: z.enum(["PASS", "EXPECTED_FAILURE"]), candidateExitCode: z.literal(0),
  cleanup: z.object({ candidateContainers: z.literal(0), bridgeListening: z.literal(false), scratchRemoved: z.literal(true), sentinelRemoved: z.literal(true) }).strict(),
  containmentReceipt: RuntimeInstallByteCaptureSchema, assertionReceipt: RuntimeInstallByteCaptureSchema,
  captures: z.array(RuntimeInstallCaptureSchema).length(3),
}).strict().superRefine((probe, context) => {
  const negative = probe.probeId === "process-response-negative/v1";
  const expected = negative ? "EXPECTED_FAILURE" : "PASS";
  if (probe.expectedOutcome !== expected || probe.observedOutcome !== expected || probe.candidateExitCode !== 0) context.addIssue({ code: "custom", path: ["observedOutcome"], message: "probe outcome or candidate process status differs from the fixed oracle" });
  const prefix = probe.probeId.slice(0, -3);
  const names = [`${prefix}-request.json`, `${prefix}-response.json`, `${prefix}-stderr.bin`];
  if (probe.captures[0]?.name !== names[0] || probe.captures[1]?.name !== names[1] || probe.captures[2]?.name !== names[2]) context.addIssue({ code: "custom", path: ["captures"], message: "probe must retain its exact original request, response, and stderr capture identities" });
  // A digest proves only byte identity. Parse the original bounded frames and bind them to the
  // immutable fixture oracle so a caller cannot mint PASS labels around unrelated captures.
  const request = probe.captures[0] ? parseCanonicalJsonCapture(probe.captures[0].bytesBase64) : undefined;
  const response = probe.captures[1] ? parseCanonicalJsonCapture(probe.captures[1].bytesBase64) : undefined;
  if (!request || !response || !isRecord(request) || !isRecord(response)
    || Object.keys(request).sort().join(",") !== "input,wireId"
    || Object.keys(response).sort().join(",") !== "output,wireId"
    || typeof request.wireId !== "string" || !/^[a-f0-9]{48}$/.test(request.wireId)
    || response.wireId !== request.wireId) {
    context.addIssue({ code: "custom", path: ["captures"], message: "raw request and response must be a correlated original candidate protocol frame pair" });
    return;
  }
  const probeIndex = FIXED_PROBE_RECEIPTS.findIndex((item) => item.probeId === probe.probeId);
  const expectedReceipt = FIXED_PROBE_RECEIPTS[probeIndex];
  const expectedOutput = probe.probeId === "source-interface-positive/v1"
    ? { protocol: "registered-module-export-inventory/v1", exports: [{ name: "listRows", kind: "callable" }, { name: "otherRows", kind: "callable" }] }
    : { rows: [1] };
  if (canonicalJson(response.output) !== canonicalJson(expectedOutput)) context.addIssue({ code: "custom", path: ["captures"], message: "original candidate response frame differs from the fixed installed qualification fixture oracle" });
  try {
    const assertion = JSON.parse(Buffer.from(probe.assertionReceipt.bytesBase64, "base64").toString("utf8")) as Record<string, unknown>;
    const expectedAssertionOutcome = negative ? "failed" : "passed";
    if (!expectedReceipt || Object.keys(assertion).sort().join(",") !== "assertionDigest,assertionIndex,caseId,outcome,responseSha256"
      || assertion.caseId !== expectedReceipt.caseId || assertion.outcome !== expectedAssertionOutcome || assertion.assertionIndex !== 0
      || assertion.assertionDigest !== expectedReceipt.assertionDigest || assertion.responseSha256 !== probe.captures[1]?.sha256) {
      context.addIssue({ code: "custom", path: ["assertionReceipt"], message: "original independent assertion receipt does not bind the fixed probe response and expected outcome" });
    }
  } catch { context.addIssue({ code: "custom", path: ["assertionReceipt"], message: "original independent assertion receipt is not valid JSON" }); }
  try {
    const evidence = JSON.parse(Buffer.from(probe.containmentReceipt.bytesBase64, "base64").toString("utf8")) as Record<string, unknown>;
    const receipt = isRecord(evidence.receipt) ? evidence.receipt : {};
    const capture = isRecord(evidence.capture) ? evidence.capture : {};
    const owner = isRecord(receipt.owner) ? receipt.owner : {};
    const labels = isRecord(owner.labels) ? owner.labels : {};
    const requestBytes = Buffer.from(probe.captures[0]?.bytesBase64 ?? "", "base64");
    const responseBytes = Buffer.from(probe.captures[1]?.bytesBase64 ?? "", "base64");
    const stderrBytes = Buffer.from(probe.captures[2]?.bytesBase64 ?? "", "base64");
    if (Object.keys(evidence).sort().join(",") !== "capture,profileId,receipt"
      || (evidence.profileId !== "darwin-arm64-colima-v1" && evidence.profileId !== "linux-arm64-docker-v1")
      || receipt.scope !== "contained-candidate-process-response/v1" || receipt.adapterVersion !== 1
      || typeof receipt.plannedName !== "string" || !/^agentx-contained-[a-f0-9]{20}$/.test(receipt.plannedName)
      || typeof receipt.recordRef !== "string" || !/^[a-f0-9]{32}$/.test(receipt.recordRef)
      || typeof receipt.containerId !== "string" || !/^[a-f0-9]{64}$/.test(receipt.containerId)
      || receipt.image !== RUNTIME_IMAGE || receipt.sourceDigest !== FIXED_PACKET_IDENTITIES[probeIndex]?.sourceDigest
      || receipt.sourceBytes !== FIXED_PACKET_IDENTITIES[probeIndex]?.sourceBytes
      || receipt.entry !== "__agentx_adapter__/entry.mjs" || receipt.exportName !== "default"
      || typeof receipt.endpoint !== "string" || (evidence.profileId === "linux-arm64-docker-v1" ? receipt.endpoint !== "unix:///var/run/docker.sock" : !/^unix:\/\/\/Users\/[^/]+\/\.colima\/default\/docker\.sock$/.test(receipt.endpoint))
      || Object.keys(labels).sort().join(",") !== "agentx.nonce,agentx.owner,agentx.source"
      || owner.nonce !== labels["agentx.nonce"] || typeof owner.nonce !== "string" || !/^[a-f0-9]{48}$/.test(owner.nonce)
      || labels["agentx.owner"] !== "contained-candidate-v1" || labels["agentx.source"] !== receipt.sourceDigest
      || receipt.exitCode !== 0 || receipt.requestWritten !== true || receipt.overflow !== false || receipt.aborted !== false || receipt.timedOut !== false || receipt.cleanup !== "confirmed"
      || !Number.isSafeInteger(receipt.stdoutBytes) || !Number.isSafeInteger(receipt.stderrBytes) || receipt.aggregateBytes !== (receipt.stdoutBytes as number) + (receipt.stderrBytes as number)
      || receipt.stdoutBytes !== capture.stdoutBytes || receipt.stderrBytes !== capture.stderrBytes
      || typeof capture.requestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(capture.requestSha256)
      || typeof capture.stdoutSha256 !== "string" || !/^[a-f0-9]{64}$/.test(capture.stdoutSha256)
      || typeof capture.stderrSha256 !== "string" || !/^[a-f0-9]{64}$/.test(capture.stderrSha256)
      || capture.requestBytes !== requestBytes.byteLength || capture.requestSha256 !== createHash("sha256").update(requestBytes).digest("hex")
      || capture.stdoutBytes !== responseBytes.byteLength || capture.stdoutSha256 !== createHash("sha256").update(responseBytes).digest("hex")
      || capture.stderrBytes !== stderrBytes.byteLength || capture.stderrSha256 !== createHash("sha256").update(stderrBytes).digest("hex")) {
      context.addIssue({ code: "custom", path: ["containmentReceipt"], message: "original owned-container receipt lacks confirmed cleanup and immutable container/source identity" });
    }
  } catch { context.addIssue({ code: "custom", path: ["containmentReceipt"], message: "original owned-container receipt is not valid JSON" }); }
});

function parseCanonicalJsonCapture(base64: string): unknown {
  try {
    const bytes = Buffer.from(base64, "base64");
    const text = bytes.toString("utf8");
    const value: unknown = JSON.parse(text);
    // The pinned candidate protocol serializes original frames with JSON.stringify
    // (wireId first); preserve that framing instead of requiring broker key order.
    return JSON.stringify(value) === text || `${JSON.stringify(value)}\n` === text ? value : undefined;
  } catch { return undefined; }
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

const RuntimeInstallManifestEntrySchema = z.object({ path: z.string().min(1).max(512), sha256: digest }).strict();
const RuntimeInstallManifestSchema = z.object({
  schemaVersion: z.literal("installed-runtime-manifest/v1"), entries: z.array(RuntimeInstallManifestEntrySchema).min(2).max(4096), sha256: digest,
}).strict().superRefine((manifest, context) => {
  const paths = manifest.entries.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length || paths.some((path) => path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => part === "" || part === "." || part === ".."))) {
    context.addIssue({ code: "custom", path: ["entries"], message: "installed manifest paths must be unique normalized relative paths" });
  }
  const entries = [...manifest.entries].sort((left, right) => left.path.localeCompare(right.path));
  if (canonicalJson(entries) !== canonicalJson(manifest.entries)) context.addIssue({ code: "custom", path: ["entries"], message: "installed manifest entries must be sorted by path" });
  const body = { schemaVersion: manifest.schemaVersion, entries: manifest.entries };
  if (createHash("sha256").update(canonicalJson(body)).digest("hex") !== manifest.sha256) context.addIssue({ code: "custom", path: ["sha256"], message: "installed manifest digest does not identify its entries" });
  if (!paths.some((path) => path.startsWith("packages/verifier/dist/")) || !paths.some((path) => path.startsWith("packages/verifier/assets/"))) context.addIssue({ code: "custom", path: ["entries"], message: "manifest must include installed verifier code and immutable qualification assets" });
});

const RuntimeInstallExecutionSchema = z.object({
  launchConfigDigest: digest,
  list: z.object({ stdout: RuntimeInstallByteCaptureSchema, stderr: RuntimeInstallByteCaptureSchema, exitCode: z.literal(0) }).strict(),
  run: z.object({ stdout: RuntimeInstallByteCaptureSchema, stderr: RuntimeInstallByteCaptureSchema, runStartCapture: RuntimeInstallByteCaptureSchema, launchId: z.string().uuid(),
    exitCode: z.literal(1), signal: z.null(), timedOut: z.literal(false), aborted: z.literal(false) }).strict(),
  workerCleanup: z.object({ confirmed: z.literal(true), serverListening: z.literal(false), socketPresent: z.literal(false), aliasEntryPresent: z.literal(false), privateSentinelPresent: z.literal(false) }).strict(),
}).strict().superRefine((execution, context) => {
  const reportBytes = Buffer.from(execution.run.stdout.bytesBase64, "base64");
  const listBytes = Buffer.from(execution.list.stdout.bytesBase64, "base64");
  const runStartBytes = Buffer.from(execution.run.runStartCapture.bytesBase64, "base64");
  let report: unknown;
  let list: unknown;
  let runStart: unknown;
  const runStartText = runStartBytes.toString("utf8");
  try { report = JSON.parse(reportBytes.toString("utf8")); list = JSON.parse(listBytes.toString("utf8")); runStart = JSON.parse(runStartText.trim()); }
  catch { context.addIssue({ code: "custom", path: ["run", "stdout"], message: "original pinned CLI report or first-party run-start capture is invalid JSON" }); return; }
  if (!isRecord(report) || !isRecord(report.run) || !isRecord(report.run.summary) || !Array.isArray(report.run.results)
    || !isRecord(runStart) || runStart.schemaVersion !== "e2e-run-start-capture/v1" || typeof runStart.runId !== "string"
    || Object.keys(runStart).sort().join(",") !== "at,challenge,runId,schemaVersion,seq"
    || runStart.runId !== report.run.id || runStart.challenge !== execution.run.launchId
    || !Number.isSafeInteger(runStart.seq) || (runStart.seq as number) < 1 || typeof runStart.at !== "string" || !Number.isFinite(Date.parse(runStart.at))
    || runStartText.split("\n").filter((line) => line.length > 0).length !== 1 || !runStartText.endsWith("\n")) {
    context.addIssue({ code: "custom", path: ["run", "runStartCapture"], message: "run-start UUID must equal the report and launch identity must equal the original CLI launch id" });
    return;
  }
  const rows = report.run.results as unknown[];
  const summary = report.run.summary;
  const expectedStatuses = ["passed", "passed", "failed"];
  const expectedCaseIds = [
    "case-a9eb53e1895372a6148bf5bb92aca811df9d7e7d72c6e4bf0e0341de7033e229",
    "case-e1a9e129a98030e665eb13a5dbbc2c643624b1bfb893d2611baaed6688b9b9a7",
    "case-e014583b1e51edfe14e5d0cb2df6bde986cd7583c6b51eb913e0891cfc2d0fbe",
  ];
  if (rows.length !== 3 || summary.discovered !== 3 || summary.selected !== 3 || summary.executed !== 3 || summary.passed !== 2 || summary.failed !== 1
    || rows.some((row, index) => !isRecord(row) || row.status !== expectedStatuses[index] || row.kind !== "test" || row.selected !== true || row.repeat !== 0
      || !Array.isArray(row.attempts) || row.attempts.length !== 1 || !isRecord(row.attempts[0])
      || row.attempts[0].index !== 0 || row.attempts[0].status !== expectedStatuses[index] || row.attempts[0].cleanup !== "complete"
      || !Array.isArray(row.attempts[0].steps) || row.attempts[0].steps.length !== 0
      || !Array.isArray(row.attempts[0].secondaryErrors) || row.attempts[0].secondaryErrors.length !== 0
      || (index === 2 ? !isRecord(row.attempts[0].error) || row.attempts[0].error.category !== "test" : row.attempts[0].error !== undefined)
      || !Array.isArray(row.titlePath) || row.titlePath.at(-1) !== expectedCaseIds[index]
      || typeof row.testId !== "string" || row.testId !== `.agentx/e2e/generated-contract.test.ts::${expectedCaseIds[index]}`
      || row.agent !== "default" || row.targetId !== "contract-web-1" || typeof row.id !== "string"
      || createHash("sha256").update(canonicalJson({ testId: row.testId, targetId: row.targetId, agent: row.agent })).digest("hex") !== row.id)) {
    context.addIssue({ code: "custom", path: ["run", "stdout"], message: "report must contain exactly two clean positive cases and the one fixed expected negative case" });
  }
  const listPairs = isRecord(list) && Array.isArray(list.pairs) ? list.pairs : [];
  if (listPairs.length !== 3 || !Array.isArray(rows) || rows.some((row, index) => !isRecord(row) || !isRecord(listPairs[index])
    || listPairs[index].id !== row.id || listPairs[index].disposition !== "run" || listPairs[index].title !== (row.titlePath as unknown[] | undefined)?.at(-1)
    || listPairs[index].target !== row.targetId || listPairs[index].agent !== row.agent)) {
    context.addIssue({ code: "custom", path: ["list", "stdout"], message: "original CLI list output must identify exactly the same three ordered report cases" });
  }
  if (report.run.status !== "failed" || report.run.exitCode !== 1 || !Array.isArray(report.run.errors) || report.run.errors.length !== 0) {
    context.addIssue({ code: "custom", path: ["run", "stdout"], message: "pinned CLI report must preserve only the intentional fixed negative test failure" });
  }
});

/** Operator proposal is evidence only. It deliberately has no caller-controlled READY or catalog-record field. */
export const RuntimeInstallationProposalSchema = z.object({
  schemaVersion: z.literal("runtime-installation-proposal/v1"), challenge: RuntimeInstallChallengeSchema,
  createdAt: z.string().datetime(), manifest: RuntimeInstallManifestSchema,
  runnerEnvironment: ProjectSetupRunnerEnvironmentSchema, runnerToolchain: ProjectSetupRunnerToolchainSchema,
  execution: RuntimeInstallExecutionSchema,
  probes: z.array(RuntimeInstallProbeSchema).length(3),
}).strict().superRefine((proposal, context) => {
  const expectedIds = RuntimeInstallProbeIdSchema.options;
  if (expectedIds.some((id, index) => proposal.probes[index]?.probeId !== id)) context.addIssue({ code: "custom", path: ["probes"], message: "proposal must contain the fixed setup-positive, feature-positive, feature-negative probe sequence" });
  if (Date.parse(proposal.createdAt) < Date.parse(proposal.challenge.issuedAt) || Date.parse(proposal.createdAt) >= Date.parse(proposal.challenge.expiresAt)) context.addIssue({ code: "custom", path: ["createdAt"], message: "proposal must be created during its challenge window" });
  if (proposal.runnerToolchain.version !== "v22.23.2" || proposal.runnerToolchain.arch !== proposal.challenge.profileId.split("-")[1] || proposal.runnerToolchain.platform !== (proposal.challenge.profileId.startsWith("linux-") ? "linux" : "darwin")) context.addIssue({ code: "custom", path: ["runnerToolchain"], message: "runner toolchain must match the challenge's fixed runtime profile" });
  if (proposal.runnerEnvironment.arch !== proposal.runnerToolchain.arch || !proposal.runnerEnvironment.os.toLowerCase().startsWith(`${proposal.runnerToolchain.platform} `)) context.addIssue({ code: "custom", path: ["runnerEnvironment"], message: "runner environment must retain the observed OS platform and release" });
  try {
    const report = JSON.parse(Buffer.from(proposal.execution.run.stdout.bytesBase64, "base64").toString("utf8")) as Record<string, unknown>;
    const run = isRecord(report.run) ? report.run : {};
    const runner = isRecord(run.runner) ? run.runner : {};
    const environment = isRecord(run.environment) ? run.environment : {};
    const project = isRecord(run.project) ? run.project : {};
    if (runner.name !== "e2e" || runner.version !== "0.20.0" || project.id !== "rovara-contract-p0"
      || project.configDigest !== proposal.execution.launchConfigDigest
      || canonicalJson(environment) !== canonicalJson(proposal.runnerEnvironment)) context.addIssue({ code: "custom", path: ["execution", "run", "stdout"], message: "full pinned runner, project, and observed environment identities must match the proposal" });
    const runStartedAt = typeof run.startedAt === "string" ? Date.parse(run.startedAt) : Number.NaN;
    const runFinishedAt = typeof run.finishedAt === "string" ? Date.parse(run.finishedAt) : Number.NaN;
    if (!Number.isFinite(runStartedAt) || !Number.isFinite(runFinishedAt)
      || runStartedAt < Date.parse(proposal.challenge.issuedAt) || runFinishedAt < runStartedAt
      || runFinishedAt > Date.parse(proposal.createdAt)) context.addIssue({ code: "custom", path: ["execution", "run", "stdout"], message: "observed report chronology must fall within this fresh challenge and proposal window" });
    const runStartCapture = JSON.parse(Buffer.from(proposal.execution.run.runStartCapture.bytesBase64, "base64").toString("utf8").trim()) as Record<string, unknown>;
    const capturedAt = typeof runStartCapture.at === "string" ? Date.parse(runStartCapture.at) : Number.NaN;
    if (!Number.isFinite(capturedAt) || capturedAt < Date.parse(proposal.challenge.issuedAt)
      || capturedAt > runStartedAt + 60_000 || capturedAt > runFinishedAt || capturedAt > Date.parse(proposal.createdAt)) context.addIssue({ code: "custom", path: ["execution", "run", "runStartCapture"], message: "first-party run-start capture chronology must be inside this challenge and near the observed report start" });
  } catch { /* execution schema reports invalid JSON */ }
  const challengeDigest = runtimeInstallChallengeDigest(proposal.challenge);
  const expectedCorrelations = [proposal.challenge.probeCorrelations.sourceInterface, proposal.challenge.probeCorrelations.featurePositive, proposal.challenge.probeCorrelations.featureNegative];
  proposal.probes.forEach((probe, index) => {
    if (probe.requestCorrelationId !== expectedCorrelations[index]) context.addIssue({ code: "custom", path: ["probes", index, "requestCorrelationId"], message: "probe logical request identity must be fresh and challenge-bound" });
    const request = parseCanonicalJsonCapture(probe.captures[0]?.bytesBase64 ?? "");
    if (!isRecord(request)) return;
    const expectedProbe = index === 0 ? "source-interface" : index === 1 ? "positive" : "negative";
    const expectedInput = { qualificationChallengeId: proposal.challenge.challengeId, qualificationChallengeDigest: challengeDigest,
      qualificationRequestId: expectedCorrelations[index], qualificationProbe: expectedProbe };
    if (canonicalJson(request.input) !== canonicalJson(expectedInput)) context.addIssue({ code: "custom", path: ["probes", index, "captures", 0], message: "original candidate request frame is replayed or does not bind this fresh challenge and logical request identity" });
  });
  for (const probe of proposal.probes) {
    try {
      const evidence = JSON.parse(Buffer.from(probe.containmentReceipt.bytesBase64, "base64").toString("utf8")) as Record<string, unknown>;
      const receipt = isRecord(evidence.receipt) ? evidence.receipt : {};
      const endpointOkay = proposal.challenge.profileId === "linux-arm64-docker-v1"
        ? receipt.endpoint === "unix:///var/run/docker.sock"
        : typeof receipt.endpoint === "string" && /^unix:\/\/\/Users\/[^/]+\/\.colima\/default\/docker\.sock$/.test(receipt.endpoint);
      if (evidence.profileId !== proposal.challenge.profileId || !endpointOkay) context.addIssue({ code: "custom", path: ["probes"], message: "actual candidate receipt must use the challenge-bound runtime profile and socket" });
    } catch { /* probe-level validation reports malformed receipt bytes */ }
  }
});
export type RuntimeInstallationProposal = z.infer<typeof RuntimeInstallationProposalSchema>;

export function runtimeInstallationProposalSha256(value: unknown): string {
  const proposal = RuntimeInstallationProposalSchema.parse(value);
  return createHash("sha256").update(canonicalJson(proposal)).digest("hex");
}

export function runtimeInstallChallengeDigest(challengeInput: unknown): string {
  const challenge = RuntimeInstallChallengeSchema.parse(challengeInput);
  return createHash("sha256").update(canonicalJson(challenge)).digest("hex");
}
