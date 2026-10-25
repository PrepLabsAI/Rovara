import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { E2ERuntimeCapabilityDescriptorSchema, WEB_API_AGENT_PROBE_IDS, WEB_API_AGENT_PROBE_ROUTE, WEB_API_NETWORK_POLICY_DIGEST, WEB_API_QUALIFICATION_APP_TREE_DIGEST, WEB_API_REQUIRED_PROBES,
  WebApiProbeObservationSchema, canonicalJson, e2eRuntimeCapabilityDigest, evaluateWebApiProbeObservation, type WebApiProbeObservation } from "../../packages/contracts/src/index.js";
import { webApiRuntimeCapabilities } from "../../packages/broker/src/aws/e2e-feature-verifier-catalog.js";

// Task 4.5: the three scripted-model qualification probes as the oracle judges them. The observations here are written by hand (the committed run evidence they are derived from
// is exercised in install-qualification-web.test.ts and web-api-probe-derivation.test.ts), so each case changes exactly one fact.
const SCRIPTED = "web-agent-scripted-v1";
const WRONG_ACTION = "web-agent-wrong-action-v1";
const ISOLATION = "web-agent-app-isolation-v1";

const clean = { runUnavailableReason: null, blockedHosts: [] as string[], buildExitCode: null, attempts: 1, skipped: 0, flaky: 0, evidenceDigest: "a".repeat(64) };
const facts = (change: Partial<NonNullable<WebApiProbeObservation["agent"]>> = {}): NonNullable<WebApiProbeObservation["agent"]> => ({ routeId: "rovara-scripted/v1", receipts: 2, okReceipts: 2, verifiedReceipts: 2,
  downloads: 1, caseReasons: [], unmockedCalls: { sinkhole: 0, mocked: 0 }, ...change });
const passing = (change: Partial<NonNullable<WebApiProbeObservation["agent"]>> = {}): WebApiProbeObservation => ({ ...clean, collectorStatus: "PASS", failedAssertionKinds: [], agent: facts(change) });
const noDownload = (change: Partial<NonNullable<WebApiProbeObservation["agent"]>> = {}, top: Partial<WebApiProbeObservation> = {}): WebApiProbeObservation => ({ ...clean, collectorStatus: "UNKNOWN", failedAssertionKinds: [],
  agent: facts({ receipts: 1, okReceipts: 1, verifiedReceipts: 0, downloads: 0, caseReasons: ["agent-no-download"], ...change }), ...top });

describe("the three agent qualification probes (Task 4.5)", () => {
  it("requires fourteen probes: the eleven of M1.3 in their order, then the three agent probes, which are web probes", () => {
    expect(WEB_API_REQUIRED_PROBES).toHaveLength(14);
    expect(WEB_API_REQUIRED_PROBES.slice(11).map((probe) => [probe.probeId, probe.kind, probe.expectedOutcome])).toEqual([[SCRIPTED, "web", "PASS"], [WRONG_ACTION, "web", "EXPECTED_FAILURE"], [ISOLATION, "web", "PASS"]]);
    expect([...WEB_API_AGENT_PROBE_IDS]).toEqual([SCRIPTED, WRONG_ACTION, ISOLATION]);
    expect(WEB_API_AGENT_PROBE_ROUTE.routeId).toBe("rovara-scripted/v1");
  });

  it("moves no pinned M1.3 probe: every digest of the eleven is what it was before Task 4.5, and so is the qualification app", () => {
    const before: [string, string, string | null, string | null, string | null][] = [
  ["web-csv-positive-v1", "3fd4928bf1fd9db70994ea733caede591f5fdab1574e340b89f397d9000985e4", "a7cd24dfbb78f5760995b3d8ac1a977a422ccf7d5601cfbaaafd6e0f8201cf5e", "7469c1ac56ae5f5453d41d8c66a6f5e5be07a921530268e0976f22165b8652d8", null],
  ["web-csv-negative-v1", "91b591d3551262a6f8800e530ae502b9ed02e7066411194b0d9bfdc8aa079d14", "a7cd24dfbb78f5760995b3d8ac1a977a422ccf7d5601cfbaaafd6e0f8201cf5e", "7469c1ac56ae5f5453d41d8c66a6f5e5be07a921530268e0976f22165b8652d8", null],
  ["web-egress-denial-v1", "a7e28d356365d736b8b1251344df6ca89194ea78ebd2ea977790bc03d9cf9e19", "8f823b398850bad62569c6744e255576129fc2616edcb0be8aa616c2491e37e0", "3554e2486a31a410d70bba007270ee12160fb043a29f7c6587250ea6f99ad88f", null],
  ["api-state-positive-v1", "5fa681bbcf60bdcbee9804d8bfe9bbd56c60d6a35925b5f9e929c42d9773cbc7", "fd333864038602a5788fbca3324f27f3e2d38cee12b4c8de3b5a0385fc4097dc", "033b193aaa1ab0ed459770bf2a91141b33b5c247d6e23ec713630a0f95b74dc4", null],
  ["api-egress-denial-v1", "ccfebb5c1e33d3f5a5d80d99cb51d42b29f2c6bd02ad76f81a746684276ade47", "a9b22a914cd5d7df6aaa398715b171d0115001cf0b0a85ab804d72c1af823d25", "988fe2770742f42f9f9c147b84545811d46ad1c9e7e77d6737edb9ee718ce8e6", null],
  ["web-mock-origin-v1", "2db0bc780233991363864e2005919346c67e5dab966653dd1c81846032757d59", "3d0ed85074fc791112186c4624deb2a15f16ba8eda23c1ad9caad96261095cf9", "730b2a838689d74e7afba14485abdce51e63ad32e7266efb48e73fd62d6a7640", null],
  ["web-unmocked-call-v1", "2e575d450f022985921b166df12a9c585bdf64d4abe97cd7260c3e95b78acbcf", "3d0ed85074fc791112186c4624deb2a15f16ba8eda23c1ad9caad96261095cf9", "730b2a838689d74e7afba14485abdce51e63ad32e7266efb48e73fd62d6a7640", null],
  ["build-imds-denial-v1", "c6494ae44cf33f9824944dfe6606d82ac6c3a0240e355508d03785361adc23ac", null, null, "e8c2c552f1e011563ceeb18fc08bc03dd5e51a142a2e1e6e9327d8422ac4f6cd"],
  ["build-lateral-denial-v1", "6dea07ac3b128be2226c988534c1c5fbb6715939dc77dbd8302156307c33a755", null, null, "03b9465809bcef8d6bfeb409a89e68b618275e1ed3a19201018e9f9cd9e74c9e"],
  ["app-host-denial-v1", "4a7dffe2f7e1f24d934db7a8717929c577d6414ed8fb719e4d6dfa4de9597ce7", "fd333864038602a5788fbca3324f27f3e2d38cee12b4c8de3b5a0385fc4097dc", "033b193aaa1ab0ed459770bf2a91141b33b5c247d6e23ec713630a0f95b74dc4", null],
  ["chromium-sandbox-v1", "e27ceecc03c241669c31cd91dca1088a62d2e47cecadf9eca0b8e2abe44284de", "a7cd24dfbb78f5760995b3d8ac1a977a422ccf7d5601cfbaaafd6e0f8201cf5e", "7469c1ac56ae5f5453d41d8c66a6f5e5be07a921530268e0976f22165b8652d8", null],
    ];
    expect(WEB_API_REQUIRED_PROBES.slice(0, 11).map((probe) => [probe.probeId, probe.assetDigest, probe.scenarioDigest, probe.bundleDigest, probe.buildCommandDigest])).toEqual(before);
    expect(WEB_API_QUALIFICATION_APP_TREE_DIGEST).toBe("2e698a8666056c0875b61e180cbccfc1fcb6da60fc90f30f11f57615e6cac236");
    expect(WEB_API_NETWORK_POLICY_DIGEST).toBe("8b2b24cc6371206bb90d3cdeaa4515b0969d96d08390074202c33a124d85e515");
  });

  it("pins each agent probe's asset, scenario and bundle; the three run one scenario under one bundle", () => {
    const agent = WEB_API_REQUIRED_PROBES.slice(11);
    for (const probe of agent) expect([probe.probeId, probe.assetDigest, probe.scenarioDigest, probe.bundleDigest, probe.buildCommandDigest]).toEqual([probe.probeId, expect.stringMatching(/^[a-f0-9]{64}$/), expect.stringMatching(/^[a-f0-9]{64}$/), expect.stringMatching(/^[a-f0-9]{64}$/), null]);
    // The scripted and wrong-action probes run one scenario under one bundle; the isolation probe ends on the guard's page, so its scenario and bundle are its own.
    expect(agent[0]!.scenarioDigest).toBe(agent[1]!.scenarioDigest);
    expect(agent[0]!.bundleDigest).toBe(agent[1]!.bundleDigest);
    expect(agent[2]!.scenarioDigest).not.toBe(agent[0]!.scenarioDigest);
    expect(agent[2]!.bundleDigest).not.toBe(agent[0]!.bundleDigest);
    expect(new Set(WEB_API_REQUIRED_PROBES.map((probe) => probe.assetDigest)).size).toBe(14);
  });

  describe("web-agent-scripted-v1 and web-agent-app-isolation-v1 (PASS)", () => {
    it.each([SCRIPTED, ISOLATION])("accepts the run that passed with two ok receipts that are the report's, one download and the scripted route: %s", (probeId) => {
      expect(evaluateWebApiProbeObservation(probeId, passing())).toEqual({ ok: true });
    });
    const notClean: [string, WebApiProbeObservation][] = [
      ["no agent facts", { ...passing(), agent: undefined }],
      ["the collector did not pass", { ...passing(), collectorStatus: "UNKNOWN" }],
      ["a failed assertion", { ...passing(), collectorStatus: "FAILED", failedAssertionKinds: ["csv"] }],
      // The isolation probe's marker (the guard's in-request checks) is a visible assertion: without it the probe is not accepted.
      ["the guard's marker not visible (no in-request check ran)", { ...passing(), collectorStatus: "FAILED", failedAssertionKinds: ["visible"] }],
      ["a request the executor had blocked", { ...passing(), blockedHosts: ["probe.example.com"] }],
      ["the run was unavailable (the app did not start)", { ...passing(), collectorStatus: null, runUnavailableReason: "app-exited" }],
      ["another route", passing({ routeId: "rovara-e2e-default" })],
      ["no route", passing({ routeId: null })],
      ["a third receipt", passing({ receipts: 3, okReceipts: 3, verifiedReceipts: 3 })],
      ["one receipt", passing({ receipts: 1, okReceipts: 1, verifiedReceipts: 1 })],
      ["a receipt that is not ok", passing({ okReceipts: 1 })],
      ["a third receipt that is not ok (two ok ones are the report's)", passing({ receipts: 3, okReceipts: 2, verifiedReceipts: 2 })],
      ["a receipt the report does not account for", passing({ verifiedReceipts: 1 })],
      ["no download", passing({ downloads: 0 })],
      ["two downloads", passing({ downloads: 2 })],
      ["a case reason", passing({ caseReasons: ["agent-no-download"] })],
      ["a call to the sinkhole", passing({ unmockedCalls: { sinkhole: 1, mocked: 0 } })],
      ["a call no mock matched", passing({ unmockedCalls: { sinkhole: 0, mocked: 1 } })],
    ];
    it.each([SCRIPTED, ISOLATION])("rejects %s when anything but the exact expected outcome was observed", (probeId) => {
      for (const [label, observation] of notClean) expect(evaluateWebApiProbeObservation(probeId, observation), `${probeId}: ${label}`).toEqual({ ok: false, reason: `positive-probe-failed:${probeId}` });
    });
    it.each([["skipped", { skipped: 1 }, "probe-skipped"], ["flaky", { flaky: 1 }, "probe-flaky"], ["retried", { attempts: 2 }, "probe-retried"]])("rejects a probe that is %s", (_label, change, reason) => {
      for (const probeId of [SCRIPTED, WRONG_ACTION, ISOLATION]) expect(evaluateWebApiProbeObservation(probeId, { ...(probeId === WRONG_ACTION ? noDownload() : passing()), ...change })).toEqual({ ok: false, reason: `${reason}:${probeId}` });
    });
  });

  describe("web-agent-wrong-action-v1 (EXPECTED_FAILURE: UNKNOWN agent-no-download)", () => {
    it("accepts the run that was UNKNOWN for agent-no-download alone: one ok receipt, no download, no assertion failed", () => {
      expect(evaluateWebApiProbeObservation(WRONG_ACTION, noDownload())).toEqual({ ok: true });
    });
    it("rejects a pass: the wrong action must not be taken for the right one", () => {
      expect(evaluateWebApiProbeObservation(WRONG_ACTION, passing())).toEqual({ ok: false, reason: `negative-probe-passed:${WRONG_ACTION}` });
      expect(evaluateWebApiProbeObservation(WRONG_ACTION, passing({ receipts: 1, okReceipts: 1, verifiedReceipts: 1, downloads: 0 }))).toEqual({ ok: false, reason: `negative-probe-passed:${WRONG_ACTION}` });
    });
    const otherCause: [string, WebApiProbeObservation][] = [
      ["a failed csv assertion (the decoy file, a FAILED case)", { ...noDownload(), collectorStatus: "FAILED", failedAssertionKinds: ["csv"], agent: facts({ caseReasons: [], downloads: 1 }) }],
      ["UNKNOWN for another code: ambiguous-download", noDownload({ caseReasons: ["ambiguous-download"] })],
      ["UNKNOWN for another code: model-unavailable", noDownload({ caseReasons: ["model-unavailable"] })],
      ["UNKNOWN for another code: model-receipts-mismatch", noDownload({ caseReasons: ["model-receipts-mismatch"] })],
      ["UNKNOWN for another code: application-evidence-floor-unmet", noDownload({ caseReasons: ["application-evidence-floor-unmet"] })],
      ["agent-no-download and another reason", noDownload({ caseReasons: ["agent-no-download", "model-unavailable"] })],
      ["no case reason at all", noDownload({ caseReasons: [] })],
      ["the code twice", noDownload({ caseReasons: ["agent-no-download", "agent-no-download"] })],
      ["a failed assertion beside the code", noDownload({}, { failedAssertionKinds: ["csv"] })],
      ["a request the executor had blocked", noDownload({}, { blockedHosts: ["probe.example.com"] })],
      ["the run unavailable", noDownload({}, { collectorStatus: null, runUnavailableReason: "app-exited" })],
      ["a download", noDownload({ downloads: 1 })],
      ["extra receipts: two ok receipts", noDownload({ receipts: 2, okReceipts: 2 })],
      ["a receipt that is not ok", noDownload({ okReceipts: 0 })],
      ["a second receipt that is not ok", noDownload({ receipts: 2, okReceipts: 1 })],
      ["the case FAILED with no assertion named (not UNKNOWN)", noDownload({}, { collectorStatus: "FAILED" })],
      ["the collector said nothing (no status) with the run available", noDownload({}, { collectorStatus: null })],
      ["a receipt the report accounts for", noDownload({ verifiedReceipts: 1 })],
      ["no receipt at all", noDownload({ receipts: 0, okReceipts: 0 })],
      ["another route", noDownload({ routeId: "rovara-e2e-default" })],
      ["a call to the sinkhole", noDownload({ unmockedCalls: { sinkhole: 1, mocked: 0 } })],
      ["no agent facts", { ...noDownload(), agent: undefined }],
    ];
    it.each(otherCause)("rejects an expected failure that happened for another cause: %#", (_label, observation) => {
      expect(evaluateWebApiProbeObservation(WRONG_ACTION, observation), _label).toEqual({ ok: false, reason: `probe-wrong-cause:${WRONG_ACTION}` });
    });
  });

  it("holds the agent facts to a strict, bounded shape", () => {
    expect(WebApiProbeObservationSchema.safeParse(passing()).success).toBe(true);
    expect(WebApiProbeObservationSchema.safeParse({ ...passing(), agent: { ...facts(), extra: 1 } }).success).toBe(false);
    expect(WebApiProbeObservationSchema.safeParse({ ...passing(), agent: facts({ receipts: -1 }) }).success).toBe(false);
    expect(WebApiProbeObservationSchema.safeParse({ ...passing(), agent: facts({ caseReasons: Array.from({ length: 17 }, () => "x") }) }).success).toBe(false);
    expect(evaluateWebApiProbeObservation(SCRIPTED, { ...passing(), agent: { ...facts(), extra: 1 } })).toEqual({ ok: false, reason: `probe-observation-invalid:${SCRIPTED}` });
  });
});

describe("the web descriptor's agent capability (Task 4.5)", () => {
  const sha = "c".repeat(64);
  it("lists no agent step and no model channel by default, and its digest is the one it had before Task 4.5", () => {
    for (const [kind, digest] of [["web", "c0421ed65f80f83a469d2d8298f62212f54a728caabe0705cc2ce3bd4f345c89"], ["api", "568a4dbac337d3078a4911476bae689ce4c099a757c0112e5838080d294fedb0"]] as const) {
      const descriptor = webApiRuntimeCapabilities(kind, "a".repeat(64));
      expect(descriptor.supportedSteps).not.toContain("agent");
      expect(Object.keys(descriptor)).not.toContain("modelChannel");
      expect(e2eRuntimeCapabilityDigest(descriptor)).toBe(digest);
    }
  });

  it("lists agent and the model channel protocol on the web descriptor, and only there, when the agent probes were all accepted", () => {
    const web = webApiRuntimeCapabilities("web", sha, { agent: true });
    expect(web.supportedSteps).toEqual(["navigate", "fill", "click", "choose-file", "agent"]);
    expect(web).toMatchObject({ kind: "web", modelChannel: "rovara-e2e-model-channel/v1" });
    expect(e2eRuntimeCapabilityDigest(web)).not.toBe(e2eRuntimeCapabilityDigest(webApiRuntimeCapabilities("web", sha)));
    expect(() => webApiRuntimeCapabilities("api", sha, { agent: true })).toThrow(/web/);
    expect(webApiRuntimeCapabilities("web", sha, { agent: false })).toEqual(webApiRuntimeCapabilities("web", sha));
  });

  it("accepts a model channel only on a web descriptor that lists the agent step, and only the one protocol", () => {
    const web = webApiRuntimeCapabilities("web", sha, { agent: true });
    expect(E2ERuntimeCapabilityDescriptorSchema.safeParse(web).success).toBe(true);
    expect(E2ERuntimeCapabilityDescriptorSchema.safeParse({ ...web, modelChannel: "rovara-e2e-model-channel/v2" }).success).toBe(false);
    expect(E2ERuntimeCapabilityDescriptorSchema.safeParse({ ...web, supportedSteps: ["navigate", "fill", "click", "choose-file"] }).success).toBe(false);
    const api = webApiRuntimeCapabilities("api", sha);
    expect(E2ERuntimeCapabilityDescriptorSchema.safeParse({ ...api, modelChannel: "rovara-e2e-model-channel/v1" }).success).toBe(false);
    expect(createHash("sha256").update(canonicalJson(web)).digest("hex")).toMatch(/^[a-f0-9]{64}$/);
  });
});
