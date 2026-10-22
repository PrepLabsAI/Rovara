import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import { RuntimeInstallChallengeSchema, RuntimeInstallManifestSchema, runtimeInstallChallengeDigest, type RuntimeInstallChallenge } from "./runtime-installation.js";
import { ProjectSetupRunnerEnvironmentSchema, ProjectSetupRunnerToolchainSchema } from "./session.js";

/** How long a web/API challenge lives: eleven probe runs, including two builds, take far longer than the five minutes a P0 challenge gets. */
export const WEB_API_CHALLENGE_LIFETIME_MS = 60 * 60_000;

/** The web/API application runtime profile and the one scope its qualification proves. */
export const WEB_API_RUNTIME_PROFILE_ID = "linux-arm64-web-api-v1" as const;
export const WEB_API_RUNTIME_SCOPE = "application-web-api/v1" as const;
/** The build commands of `build-imds-denial-v1` and `build-lateral-denial-v1` exit with this code when what they try to reach is unreachable. */
export const WEB_API_IMDS_DENIAL_EXIT_CODE = 7 as const;

/**
 * The route the three agent qualification probes (M1.4 Task 4.5) run under: the scripted double `rovara-scripted/v1`, which answers from a script, never reaches a provider and never
 * spends. A test keeps the revision equal to the one derived from the scripted route's definition, and the limits equal to those the broker derives from its budgets.
 */
export const WEB_API_AGENT_PROBE_ROUTE = Object.freeze({ routeId: "rovara-scripted/v1", routeRevision: "r1-51628bfc25fa" });
export const WEB_API_AGENT_PROBE_LIMITS = Object.freeze({ runTimeoutMs: 1_200_000, startupTimeoutMs: 10_000, preparationTimeoutMs: 10_000, caseTimeoutMs: 300_000, maxActionsPerCase: 54,
  maxModelRequests: 40, maxInputTokens: 400_000, maxOutputTokens: 40_960, maxSpendUsd: null });
/** The goal of the one AI-navigated step every agent probe runs, and its bound on actions. The scripted double is keyed by this goal's digest; the probe assets pin it too. */
export const WEB_API_AGENT_PROBE_GOAL = "Export the orders as a CSV file";
export const WEB_API_AGENT_PROBE_MAX_ACTIONS = 4;
/**
 * The page the isolation probe's guard serves itself, and the marker it carries once the guard has checked an earlier request before answering it. The probe's last step loads the page
 * and asserts the marker is visible, after the AI-navigated step (which runs with the model channel open), so the probe passes only if the guard's in-request checks ran.
 */
export const WEB_API_AGENT_GUARD_PAGE_PATH = "/__rovara-guard";
export const WEB_API_AGENT_GUARD_MARKER_TESTID = "guard-in-request-checks";

/** What a probe must show for it to count as its expected failure; anything else is a different failure. */
type ExpectedFailureCause =
  | Readonly<{ kind: "assertion"; assertionKind: "csv" | "http-status" }>
  | Readonly<{ kind: "blocked-host"; host: string }>
  | Readonly<{ kind: "build-failed" }>
  /** The case is UNKNOWN with this one code as its only reason, the run available, no assertion failed, and the pinned receipts and downloads (Task 4.5). */
  | Readonly<{ kind: "agent-unknown"; code: string }>
  /**
   * The case is UNKNOWN because the app called an origin no approved mock matched: here, exactly one call, to the sinkhole. `failedAssertionKinds` is the exact list of assertion kinds that
   * must also have failed: none for the probe whose every assertion holds, and `http-status` for the API egress probe, whose failed assertion proves that the IP literal it dialed was blocked.
   */
  | Readonly<{ kind: "unmocked-external-call"; /** The reason the run must give; for a web probe it is the `expectedReason` of the installed asset, and a test keeps the two equal. */ reason: string;
    failedAssertionKinds: readonly string[] }>;
/**
 * What an agent probe's run must show of the AI navigation, beyond the collector's verdict: the scripted route, how many model calls were made (every one `ok`), how many of
 * them the report accounts for (the receipts of a case that is not blocked), how many downloads were captured, and the only reasons a case may give for not passing.
 */
type AgentPin = Readonly<{ receipts: number; verifiedReceipts: number; downloads: number; caseReasons: readonly string[] }>;
type RequiredProbe = Readonly<{ probeId: string; /** sha256 of the installed probe asset file; a test keeps it equal to the shipped bytes. */ assetDigest: string; kind: "web" | "api" | "build"; expectedOutcome: "PASS" | "EXPECTED_FAILURE"; cause: ExpectedFailureCause | null;
  /** sha256 of the canonical scenario the probe runs through the real collector; null for the build probe. A test recomputes it from the production plan builder. */
  scenarioDigest: string | null;
  /** The digest of the whole scenario bundle the probe is admitted under (deterministic for the pinned app); null for the build probe. */
  bundleDigest: string | null;
  /** sha256 of the canonical build command the probe runs; null unless the probe is a build probe. A test recomputes it from the installed probe asset. */
  buildCommandDigest: string | null;
  /** True when the probe's retained evidence must carry the executor's Chromium sandbox attestation, and the registrar re-judges it. */
  chromiumSandbox?: true;
  /** Present on the agent probes (Task 4.5): the observation then also carries the agent facts, and the pinned ones are what the oracle holds them to. */
  agent?: AgentPin;
  /** Present on the probes that exercise an external-origin mock: the observation then also carries the mock consumptions and unmocked calls the collector derived. */
  mock?: true }>;

/** Where each probe's asset sits in the installed-runtime manifest, which therefore proves the installed bytes. */
export const webApiProbeAssetManifestPath = (probeId: string) => `packages/verifier/assets/application-runtime-v1/probes/${probeId}.json`;

/** The exact probe set M1.1 requires, in the order a proposal carries it. The auth and tenant probes belong to M1.3. */
const requiredProbes: RequiredProbe[] = [
  { probeId: "web-csv-positive-v1", assetDigest: "3fd4928bf1fd9db70994ea733caede591f5fdab1574e340b89f397d9000985e4", kind: "web", expectedOutcome: "PASS", cause: null, bundleDigest: "7469c1ac56ae5f5453d41d8c66a6f5e5be07a921530268e0976f22165b8652d8", scenarioDigest: "a7cd24dfbb78f5760995b3d8ac1a977a422ccf7d5601cfbaaafd6e0f8201cf5e", buildCommandDigest: null },
  { probeId: "web-csv-negative-v1", assetDigest: "91b591d3551262a6f8800e530ae502b9ed02e7066411194b0d9bfdc8aa079d14", kind: "web", expectedOutcome: "EXPECTED_FAILURE", cause: { kind: "assertion", assertionKind: "csv" }, bundleDigest: "7469c1ac56ae5f5453d41d8c66a6f5e5be07a921530268e0976f22165b8652d8", scenarioDigest: "a7cd24dfbb78f5760995b3d8ac1a977a422ccf7d5601cfbaaafd6e0f8201cf5e", buildCommandDigest: null },
  { probeId: "web-egress-denial-v1", assetDigest: "a7e28d356365d736b8b1251344df6ca89194ea78ebd2ea977790bc03d9cf9e19", kind: "web", expectedOutcome: "EXPECTED_FAILURE", cause: { kind: "blocked-host", host: "probe.example.com" }, bundleDigest: "3554e2486a31a410d70bba007270ee12160fb043a29f7c6587250ea6f99ad88f", scenarioDigest: "8f823b398850bad62569c6744e255576129fc2616edcb0be8aa616c2491e37e0", buildCommandDigest: null },
  { probeId: "api-state-positive-v1", assetDigest: "5fa681bbcf60bdcbee9804d8bfe9bbd56c60d6a35925b5f9e929c42d9773cbc7", kind: "api", expectedOutcome: "PASS", cause: null, bundleDigest: "033b193aaa1ab0ed459770bf2a91141b33b5c247d6e23ec713630a0f95b74dc4", scenarioDigest: "fd333864038602a5788fbca3324f27f3e2d38cee12b4c8de3b5a0385fc4097dc", buildCommandDigest: null },
  // The app, not the browser, makes these requests, so the executor cannot record a blocked host. It asks for an inventory by a name nothing in the run serves, which the app's resolver sends to
  // the sinkhole (UNKNOWN `unmocked-external-call`, one recorded call), and it dials an IP literal, which only the wall can stop: the failed `http-status` assertion on that call is the proof.
  { probeId: "api-egress-denial-v1", assetDigest: "ccfebb5c1e33d3f5a5d80d99cb51d42b29f2c6bd02ad76f81a746684276ade47", kind: "api", expectedOutcome: "EXPECTED_FAILURE", cause: { kind: "unmocked-external-call", reason: "unmocked-external-call", failedAssertionKinds: ["http-status"] }, bundleDigest: "988fe2770742f42f9f9c147b84545811d46ad1c9e7e77d6737edb9ee718ce8e6", scenarioDigest: "a9b22a914cd5d7df6aaa398715b171d0115001cf0b0a85ab804d72c1af823d25", buildCommandDigest: null, mock: true },
  // M1.3: the app reads its inventory from an approved in-network mock of the declared origin. The probe passes only when the collector shows exactly one `success` consumption and no unmocked call.
  { probeId: "web-mock-origin-v1", assetDigest: "2db0bc780233991363864e2005919346c67e5dab966653dd1c81846032757d59", kind: "web", expectedOutcome: "PASS", cause: null, bundleDigest: "730b2a838689d74e7afba14485abdce51e63ad32e7266efb48e73fd62d6a7640", scenarioDigest: "3d0ed85074fc791112186c4624deb2a15f16ba8eda23c1ad9caad96261095cf9", buildCommandDigest: null, mock: true },
  // M1.3: the app calls its inventory origin, which has no approved mock, so the call lands in the sinkhole. The case is UNKNOWN (never PASS, never FAILED) with exactly one recorded sinkhole call.
  { probeId: "web-unmocked-call-v1", assetDigest: "2e575d450f022985921b166df12a9c585bdf64d4abe97cd7260c3e95b78acbcf", kind: "web", expectedOutcome: "EXPECTED_FAILURE", cause: { kind: "unmocked-external-call", reason: "unmocked-external-call", failedAssertionKinds: [] }, bundleDigest: "730b2a838689d74e7afba14485abdce51e63ad32e7266efb48e73fd62d6a7640", scenarioDigest: "3d0ed85074fc791112186c4624deb2a15f16ba8eda23c1ad9caad96261095cf9", buildCommandDigest: null, mock: true },
  { probeId: "build-imds-denial-v1", assetDigest: "c6494ae44cf33f9824944dfe6606d82ac6c3a0240e355508d03785361adc23ac", kind: "build", expectedOutcome: "EXPECTED_FAILURE", cause: { kind: "build-failed" }, bundleDigest: null, scenarioDigest: null, buildCommandDigest: "e8c2c552f1e011563ceeb18fc08bc03dd5e51a142a2e1e6e9327d8422ac4f6cd" },
  // The build container may reach the internet and nothing else: the gateway (the host) and a private address both time out, which a firewall DROP does and a missing rule does not.
  { probeId: "build-lateral-denial-v1", assetDigest: "6dea07ac3b128be2226c988534c1c5fbb6715939dc77dbd8302156307c33a755", kind: "build", expectedOutcome: "EXPECTED_FAILURE", cause: { kind: "build-failed" }, bundleDigest: null, scenarioDigest: null, buildCommandDigest: "03b9465809bcef8d6bfeb409a89e68b618275e1ed3a19201018e9f9cd9e74c9e" },
  // The app starts behind a guard that connects to the host on the run's internal bridge and starts only when that times out, so it passes only on a firewalled runner.
  { probeId: "app-host-denial-v1", assetDigest: "4a7dffe2f7e1f24d934db7a8717929c577d6414ed8fb719e4d6dfa4de9597ce7", kind: "api", expectedOutcome: "PASS", cause: null, bundleDigest: "033b193aaa1ab0ed459770bf2a91141b33b5c247d6e23ec713630a0f95b74dc4", scenarioDigest: "fd333864038602a5788fbca3324f27f3e2d38cee12b4c8de3b5a0385fc4097dc", buildCommandDigest: null },
  // The executor's own Chromium runs with its sandbox on: the retained evidence carries what the kernel showed about the renderers (a seccomp filter, a PID namespace and a user
  // namespace of their own), and the executor refuses to run a case in a browser that does not show it, so a `--no-sandbox` runner fails this probe. It runs the CSV scenario.
  { probeId: "chromium-sandbox-v1", assetDigest: "e27ceecc03c241669c31cd91dca1088a62d2e47cecadf9eca0b8e2abe44284de", kind: "web", expectedOutcome: "PASS", cause: null, bundleDigest: "7469c1ac56ae5f5453d41d8c66a6f5e5be07a921530268e0976f22165b8652d8", scenarioDigest: "a7cd24dfbb78f5760995b3d8ac1a977a422ccf7d5601cfbaaafd6e0f8201cf5e", buildCommandDigest: null, chromiumSandbox: true },
  // M1.4 Task 4.5: three scripted-model probes of AI navigation. All run the CSV export as an agent step ("Export the orders as a CSV file") against the same app, under the scripted
  // route, so the scripted and wrong-action probes share one scenario and one bundle (the isolation probe adds the guard's page as a last step). The scripted double taps the button the goal does not name, or concludes without acting.
  { probeId: "web-agent-scripted-v1", assetDigest: "a3d89fd815a62edde8d7158fffe5005714dde457700a815beb7e162eac516a89", kind: "web", expectedOutcome: "PASS", cause: null, bundleDigest: "16b5bc8973ef966ff24c43ff50ee034d359bd986bc267a71613f028d5f3899e4", scenarioDigest: "a855f45a9439b1a4af9850f2363cd7051d2ad19fad6dc1962f79d682c6c934ad",
    buildCommandDigest: null, agent: { receipts: 2, verifiedReceipts: 2, downloads: 1, caseReasons: [] } },
  // The double concludes at once without acting: no download, so the case is UNKNOWN `agent-no-download`. A different cause, even a different UNKNOWN, is not this probe's outcome.
  { probeId: "web-agent-wrong-action-v1", assetDigest: "43fd4060986488dc59f3c0da6e55f04550ad078236dd937c64e03abef86fc295", kind: "web", expectedOutcome: "EXPECTED_FAILURE", cause: { kind: "agent-unknown", code: "agent-no-download" },
    bundleDigest: "16b5bc8973ef966ff24c43ff50ee034d359bd986bc267a71613f028d5f3899e4", scenarioDigest: "a855f45a9439b1a4af9850f2363cd7051d2ad19fad6dc1962f79d682c6c934ad", buildCommandDigest: null, agent: { receipts: 1, verifiedReceipts: 0, downloads: 0, caseReasons: ["agent-no-download"] } },
  // The app starts behind a guard that looks for the model socket and tries `model-proxy:8080` and the gateway on 8080, and starts only if every attempt fails. The host starts the app before it
  // opens the model channel, so the guard goes on checking for the app's whole life: on a short interval (a socket mounted later ends the app) and before it answers each request. The last
  // step of the case loads the guard's own page, after the AI-navigated step, and asserts the marker the guard puts there once an earlier request was checked: the probe passes only if the
  // app started, stayed up while the executor drove it with the channel open, and the in-request checks ran. The `model-proxy` leg proves the name leads nowhere but the run's sinkhole.
  { probeId: "web-agent-app-isolation-v1", assetDigest: "f383a9b102cd3d88d5377cbe4902b21b5a11ae1a960d7c93ba162fb2707bad4d", kind: "web", expectedOutcome: "PASS", cause: null, bundleDigest: "33716f10c5b021ec2845cc4e1fd8ab9d097ab897a066f2e8f23338d958dfd572", scenarioDigest: "efa380e5702e62cbbbd35acaff53f0a5766114368fa65183513485a43389d506",
    buildCommandDigest: null, agent: { receipts: 2, verifiedReceipts: 2, downloads: 1, caseReasons: [] } },
];
export const WEB_API_REQUIRED_PROBES: readonly RequiredProbe[] = Object.freeze(requiredProbes.map((probe) => Object.freeze(probe)));
export const WEB_API_REQUIRED_PROBE_IDS = WEB_API_REQUIRED_PROBES.map((probe) => probe.probeId) as [string, ...string[]];
/** The probes M1.3 qualified runners with, in order: a qualification record from before the agent probes carries exactly these. */
export const WEB_API_BASE_PROBE_COUNT = 11;
/** The agent probes of Task 4.5. A runtime descriptor lists the `agent` step only for a qualification that holds all three. */
export const WEB_API_AGENT_PROBE_IDS = Object.freeze(WEB_API_REQUIRED_PROBES.filter((probe) => probe.agent !== undefined).map((probe) => probe.probeId));
const probeIdSchema = z.enum(WEB_API_REQUIRED_PROBE_IDS);

const digest = z.string().regex(/^[a-f0-9]{64}$/);

/** Where the qualification app (the fixture every probe runs against) sits in the installed-runtime manifest, which therefore proves its installed bytes. */
export const WEB_API_QUALIFICATION_APP_MANIFEST_PREFIX = "packages/verifier/assets/qualification-app/" as const;
/** The digest of the installed qualification app tree; a test keeps it equal to the shipped files. */
export const WEB_API_QUALIFICATION_APP_TREE_DIGEST = "2e698a8666056c0875b61e180cbccfc1fcb6da60fc90f30f11f57615e6cac236";
/** The digest of a file tree given as app-relative paths and file digests, independent of listing order. */
export function webApiQualificationAppTreeDigest(files: readonly Readonly<{ path: string; sha256: string }>[]): string {
  const sorted = files.map((file) => ({ path: file.path, sha256: file.sha256 })).sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return createHash("sha256").update(canonicalJson({ schemaVersion: "web-api-qualification-app-tree/v1", files: sorted })).digest("hex");
}

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
  /** Only on the probes that pin `mock`: how many times each fixture variant was served to the app, as the collector verified them. */
  mockConsumptions: z.object({ success: z.number().int().min(0).max(1000), refusal: z.number().int().min(0).max(1000), invalidData: z.number().int().min(0).max(1000) }).strict().optional(),
  /** Only on the probes that pin `mock`: the calls no approved mock matched, split into calls to the sinkhole (no mock exists for the origin) and calls a mock refused. */
  unmockedCalls: z.object({ sinkhole: z.number().int().min(0).max(100_000), mocked: z.number().int().min(0).max(100_000) }).strict().optional(),
  /** Only on the probes that pin `mock`: the reason the verified result gave for the run (for example `unmocked-external-call`). */
  runReason: z.string().min(1).max(500).optional(),
  /**
   * Only on the agent probes: what the collector verified of the AI navigation, derived from the retained oracle and collection. `routeId` is the route the receipts were made under,
   * `receipts` all the worker's receipts for the group and `okReceipts` those that answered; `verifiedReceipts` are the receipts the report accounts for in a case that is not
   * blocked; `downloads` the csv assertions whose download was captured; `caseReasons` the reason of every case that did not pass; `unmockedCalls` what no approved mock matched.
   */
  agent: z.object({
    routeId: z.string().min(1).max(120).nullable(), receipts: z.number().int().min(0).max(300), okReceipts: z.number().int().min(0).max(300), verifiedReceipts: z.number().int().min(0).max(300),
    downloads: z.number().int().min(0).max(64), caseReasons: z.array(z.string().min(1).max(200)).max(16),
    unmockedCalls: z.object({ sinkhole: z.number().int().min(0).max(100_000), mocked: z.number().int().min(0).max(100_000) }).strict(),
  }).strict().optional(),
  attempts: z.number().int().min(1).max(100),
  skipped: z.number().int().min(0).max(1000),
  flaky: z.number().int().min(0).max(1000),
  /** A digest of the retained run evidence the runner observed these facts from. */
  evidenceDigest: digest,
}).strict();
export type WebApiProbeObservation = z.infer<typeof WebApiProbeObservationSchema>;

/** The whole canonical proposal, evidence included, may not exceed this: the proposal schema refuses a larger one (`probe-evidence-oversized`), so the registrar writes nothing for it. */
export const WEB_API_PROBE_PROPOSAL_MAX_BYTES = 5 * 1024 * 1024;

/**
 * The run id of one probe, derived from the challenge it answers: a UUID taken from the challenge digest (which covers the
 * challenge id and secret) and the probe id. The qualifier runs the probe under exactly this id and the registrar requires the retained
 * evidence to carry it, so a run recorded for another challenge cannot stand in for this one.
 */
export function webApiProbeRunId(challenge: RuntimeInstallChallenge, probeId: string): string {
  const bytes = createHash("sha256").update(`web-api-probe-run/v1\0${runtimeInstallChallengeDigest(challenge)}\0${probeId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const jsonObject = z.record(z.string(), z.unknown());
const runIdSchema = z.string().uuid();
/**
 * The retained bytes one probe's observation is derived from, embedded in the proposal like P0 embeds its report bytes. The registrar re-derives the
 * observation from this and nothing else. `collected` is a run the real collector read: the scenario bundle that ran, the collector's wire
 * collection (every raw report and proof byte, base64) and its oracle, and, for web probes, the executor's blocked-requests file (and, for the sandbox probe, its Chromium sandbox attestation). `unavailable`
 * is a run that produced nothing to collect, with the host's structured build result when the build is what stopped it.
 */
export const WebApiProbeEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("collected"), runId: runIdSchema, scenarioBundle: jsonObject, collection: jsonObject, oracle: jsonObject,
    blockedRequestsBase64: z.string().max(262_144).regex(/^[A-Za-z0-9+/]*={0,2}$/).nullable(),
    /** The executor's `chromium-sandbox.json`, for the probe that pins it (`chromiumSandbox`); absent for every other probe. */
    chromiumSandboxBase64: z.string().max(65_536).regex(/^[A-Za-z0-9+/]*={0,2}$/).nullable().optional() }).strict(),
  z.object({ kind: z.literal("unavailable"), runId: runIdSchema, reason: z.string().min(1).max(200),
    // Command 0 is the source copy, which has no recipe command; every recipe command (1 and up) is named.
    build: z.object({ commandIndex: z.number().int().min(0).max(64), exitCode: z.number().int().min(0).max(255).nullable(), command: jsonObject.nullable() }).strict()
      .refine((build) => (build.commandIndex === 0) === (build.command === null), { message: "build command index 0 is the source copy and has no command; recipe commands are named" }).nullable() }).strict(),
]);
export type WebApiProbeEvidence = z.infer<typeof WebApiProbeEvidenceSchema>;
/** What a probe runner returns: the observed facts and the evidence they were derived from. */
export type WebApiProbeRun = Readonly<{ observation: WebApiProbeObservation; evidence: WebApiProbeEvidence }>;

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
  const consumptions = observation.mockConsumptions; const unmocked = observation.unmockedCalls;
  const noConsumption = consumptions !== undefined && consumptions.success === 0 && consumptions.refusal === 0 && consumptions.invalidData === 0;
  const agentPin = probe.agent;
  const agentFacts = observation.agent;
  // An agent probe shows exactly the pinned AI navigation: the scripted route, every receipt ok, the receipts and downloads and case reasons pinned, and no call that no mock matched.
  const agentAsPinned = agentPin !== undefined && agentFacts !== undefined && observation.blockedHosts.length === 0 && agentFacts.routeId === WEB_API_AGENT_PROBE_ROUTE.routeId
    && agentFacts.receipts === agentPin.receipts && agentFacts.okReceipts === agentPin.receipts && agentFacts.verifiedReceipts === agentPin.verifiedReceipts
    && agentFacts.downloads === agentPin.downloads && sameList(agentFacts.caseReasons, agentPin.caseReasons)
    && agentFacts.unmockedCalls.sinkhole === 0 && agentFacts.unmockedCalls.mocked === 0;
  if (probe.expectedOutcome === "PASS") {
    if (agentPin !== undefined) return passed && observation.failedAssertionKinds.length === 0 && agentAsPinned ? { ok: true } : { ok: false, reason: `positive-probe-failed:${probeId}` };
    // A mock probe passes only on exactly one `success` consumption and not one call that no mock matched.
    const mocked = probe.mock !== true || (consumptions !== undefined && consumptions.success === 1 && consumptions.refusal === 0 && consumptions.invalidData === 0
      && unmocked !== undefined && unmocked.sinkhole === 0 && unmocked.mocked === 0);
    return passed && mocked ? { ok: true } : { ok: false, reason: `positive-probe-failed:${probeId}` };
  }
  if (passed) return { ok: false, reason: `negative-probe-passed:${probeId}` };
  const cause = probe.cause!;
  const wrongCause = { ok: false as const, reason: `probe-wrong-cause:${probeId}` };
  if (cause.kind === "unmocked-external-call") {
    // UNKNOWN for the pinned reason, with the run itself available, exactly the pinned assertions failed (none, or a different list, is a different cause), one call recorded in the sinkhole and nothing else served or refused.
    return observation.collectorStatus === "UNKNOWN" && observation.runUnavailableReason === null && sameList(observation.failedAssertionKinds, cause.failedAssertionKinds) && observation.runReason === cause.reason
      && unmocked !== undefined && unmocked.sinkhole === 1 && unmocked.mocked === 0 && noConsumption ? { ok: true } : wrongCause;
  }
  if (cause.kind === "agent-unknown") {
    return observation.collectorStatus === "UNKNOWN" && observation.runUnavailableReason === null && observation.failedAssertionKinds.length === 0 && agentAsPinned
      && sameList(agentFacts?.caseReasons ?? [], [cause.code]) ? { ok: true } : wrongCause;
  }
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
  observedOutcome: z.enum(["PASS", "EXPECTED_FAILURE"]), assetDigest: digest, observation: WebApiProbeObservationSchema, evidence: WebApiProbeEvidenceSchema,
}).strict();

/**
 * The web/API qualification proposal. Each probe record carries the retained evidence its observation was derived from; this schema checks
 * its shape, the pinned assets and the size bound, and the registrar re-derives every observation from the evidence and checks that it
 * binds to the challenge (`assertRunBoundProbeEvidence`). Its `state` is a label, not an authority: the schema re-judges every recorded observation
 * with the same pure oracle the qualifier used, so a proposal can only parse as READY when its evidence shows the required outcomes.
 */
export const WebApiRuntimeInstallProposalSchema = z.object({
  schemaVersion: z.literal("runtime-installation-proposal/v2"), state: z.literal("READY"),
  profileId: z.literal(WEB_API_RUNTIME_PROFILE_ID), scope: z.literal(WEB_API_RUNTIME_SCOPE),
  challenge: RuntimeInstallChallengeSchema, createdAt: z.string().datetime(), manifest: RuntimeInstallManifestSchema,
  runnerEnvironment: ProjectSetupRunnerEnvironmentSchema, runnerToolchain: ProjectSetupRunnerToolchainSchema,
  // A record from before the agent probes (M1.3 and M1.4 up to Task 4.4) carries the eleven base probes and no more; a record of Task 4.5 or later carries all fourteen. Nothing between.
  probes: z.array(ProbeRecordSchema).min(WEB_API_BASE_PROBE_COUNT).max(WEB_API_REQUIRED_PROBES.length),
}).strict().superRefine((proposal, context) => {
  if (proposal.probes.length !== WEB_API_BASE_PROBE_COUNT && proposal.probes.length !== WEB_API_REQUIRED_PROBES.length) {
    context.addIssue({ code: "custom", path: ["probes"], message: `a qualification holds the ${WEB_API_BASE_PROBE_COUNT} base probes or all ${WEB_API_REQUIRED_PROBES.length}, never part of the agent probes` });
  }
  if (proposal.challenge.profileId !== WEB_API_RUNTIME_PROFILE_ID) context.addIssue({ code: "custom", path: ["challenge", "profileId"], message: "challenge profile must be the web/API runtime profile" });
  if (Date.parse(proposal.createdAt) < Date.parse(proposal.challenge.issuedAt) || Date.parse(proposal.createdAt) >= Date.parse(proposal.challenge.expiresAt)) {
    context.addIssue({ code: "custom", path: ["createdAt"], message: "proposal must be created during its challenge window" });
  }
  if (proposal.runnerToolchain.platform !== "linux" || proposal.runnerToolchain.arch !== "arm64") context.addIssue({ code: "custom", path: ["runnerToolchain"], message: "web/API runtime qualifies only on a Linux ARM64 host" });
  if (proposal.runnerEnvironment.arch !== proposal.runnerToolchain.arch || !proposal.runnerEnvironment.os.toLowerCase().startsWith("linux ")
    || proposal.runnerEnvironment.runtime !== `node ${proposal.runnerToolchain.version}`) context.addIssue({ code: "custom", path: ["runnerEnvironment"], message: "runner environment must retain the observed OS release, architecture, and exact Node runtime" });
  const installedApp = proposal.manifest.entries.filter((entry) => entry.path.startsWith(WEB_API_QUALIFICATION_APP_MANIFEST_PREFIX))
    .map((entry) => ({ path: entry.path.slice(WEB_API_QUALIFICATION_APP_MANIFEST_PREFIX.length), sha256: entry.sha256 }));
  if (installedApp.length === 0 || webApiQualificationAppTreeDigest(installedApp) !== WEB_API_QUALIFICATION_APP_TREE_DIGEST) {
    context.addIssue({ code: "custom", path: ["manifest", "entries"], message: "qualification-app-not-installed-as-pinned" });
  }
  if (Buffer.byteLength(canonicalJson(proposal)) > WEB_API_PROBE_PROPOSAL_MAX_BYTES) context.addIssue({ code: "custom", path: ["probes"], message: "probe-evidence-oversized" });
  WEB_API_REQUIRED_PROBES.forEach((required, index) => {
    const probe = proposal.probes[index];
    if (!probe) return;
    if (probe.probeId !== required.probeId || probe.kind !== required.kind || probe.expectedOutcome !== required.expectedOutcome || probe.observedOutcome !== required.expectedOutcome) {
      context.addIssue({ code: "custom", path: ["probes", index], message: `probe ${index} must be ${required.probeId} with its fixed expected outcome` });
      return;
    }
    // A tampered or substituted probe asset must never qualify: the recorded digest is the pinned one, and so is the installed file's.
    if (probe.assetDigest !== required.assetDigest) context.addIssue({ code: "custom", path: ["probes", index, "assetDigest"], message: `probe-asset-digest-mismatch:${required.probeId}` });
    const installed = proposal.manifest.entries.find((entry) => entry.path === webApiProbeAssetManifestPath(required.probeId));
    if (installed?.sha256 !== required.assetDigest) context.addIssue({ code: "custom", path: ["manifest", "entries"], message: `probe-asset-not-installed-as-pinned:${required.probeId}` });
    const verdict = evaluateWebApiProbeObservation(probe.probeId, probe.observation);
    if (!verdict.ok) context.addIssue({ code: "custom", path: ["probes", index, "observation"], message: verdict.reason });
  });
});
export type WebApiRuntimeInstallProposal = z.infer<typeof WebApiRuntimeInstallProposalSchema>;

/**
 * Whether a qualification proposal holds all three agent probes, each accepted (the schema re-judges every recorded observation, so a parsed proposal that has them has them
 * accepted). Only then may the web runtime descriptor list the `agent` step; a record from before Task 4.5 does not, and stays valid without it.
 */
export function webApiProposalQualifiesAgent(proposal: Pick<WebApiRuntimeInstallProposal, "probes">): boolean {
  const held = new Set(proposal.probes.map((probe) => probe.probeId));
  return WEB_API_AGENT_PROBE_IDS.every((probeId) => held.has(probeId));
}

export function webApiRuntimeInstallProposalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(WebApiRuntimeInstallProposalSchema.parse(value))).digest("hex");
}

/**
 * The fixed network policy this profile enforces: an internal per-run network for app and executor, outside egress denied, metadata unreachable, and every
 * untrusted container walled off from the host and private ranges (builds keep the internet). v2 added the last two; its digest differs from v1's, so a
 * runner registered before the walls existed no longer matches the capabilities the planner requires and has to be requalified.
 */
export const WEB_API_NETWORK_POLICY = Object.freeze({
  schemaVersion: "e2e-web-api-network-policy/v2", appNetwork: "per-run-internal", outsideEgress: "denied", instanceMetadata: "unreachable",
  buildNetwork: "per-run-internet-only", hostAccess: "denied", privateRanges: "denied",
});
export const WEB_API_NETWORK_POLICY_DIGEST = createHash("sha256").update(canonicalJson(WEB_API_NETWORK_POLICY)).digest("hex");
