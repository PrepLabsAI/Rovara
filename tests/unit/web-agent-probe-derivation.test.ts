import { describe, expect, it } from "vitest";
import { WEB_API_AGENT_PROBE_IDS, WEB_API_AGENT_PROBE_ROUTE, canonicalJson, evaluateWebApiProbeObservation, type WebApiProbeEvidence } from "../../packages/contracts/src/index.js";
import { deriveWebApiProbeObservation, verifyWebApiProbeRecord, webApiAgentFacts } from "../../packages/verifier/src/web-api-probe-evidence.js";
import { fixtureEvidence, webApiChallenge, WEB_API_FIXTURE_NOW } from "../support/web-api-qualification.js";

// Task 4.5: what the three agent probes' retained evidence shows, read the way the registrar reads it. The evidence is a real run of each probe (the production runner around the real
// executor, real Chromium, the worker's real model proxy answering from the scripted double), committed under tests/fixtures/web-api-probe-evidence.
const challenge = webApiChallenge(WEB_API_FIXTURE_NOW);
const [SCRIPTED, WRONG_ACTION, ISOLATION] = WEB_API_AGENT_PROBE_IDS as readonly [string, string, string];
type Receipt = { outcome: string; receiptId: string; caseId: string };
type Collected = Extract<WebApiProbeEvidence, { kind: "collected" }> & { oracle: { modelRoute: { routeId: string; routeRevision: string } | null;
  agentModel: { route: { provider: string; routeId: string } | null; receipts: Receipt[]; ledgers: unknown[]; transcriptDigests: unknown[] } } };
const collected = (probeId: string) => structuredClone(fixtureEvidence(probeId)) as Collected;
const derive = (probeId: string, evidence: unknown) => deriveWebApiProbeObservation({ challenge, probeId, evidence });
const observationOf = (probeId: string, evidence: unknown) => { const derived = derive(probeId, evidence); if (!derived.ok) throw new Error(derived.reason); return derived.observation; };
const judged = (probeId: string, evidence: unknown) => evaluateWebApiProbeObservation(probeId, observationOf(probeId, evidence));
const unmocked = { sinkhole: 0, mocked: 0 };

describe("the agent probes' retained evidence", () => {
  it("shows the scripted run: two ok receipts that are the report's, one download, the scripted route, and the isolation run shows the same", () => {
    for (const probeId of [SCRIPTED, ISOLATION]) {
      expect(observationOf(probeId, fixtureEvidence(probeId))).toMatchObject({ collectorStatus: "PASS", runUnavailableReason: null, failedAssertionKinds: [], blockedHosts: [], attempts: 1, skipped: 0, flaky: 0,
        agent: { routeId: "rovara-scripted/v1", receipts: 2, okReceipts: 2, verifiedReceipts: 2, downloads: 1, caseReasons: [], unmockedCalls: unmocked } });
      expect(judged(probeId, fixtureEvidence(probeId))).toEqual({ ok: true });
    }
  });

  it("shows the wrong action: UNKNOWN for agent-no-download alone, one ok receipt the report does not account for, no download, no failed assertion", () => {
    expect(observationOf(WRONG_ACTION, fixtureEvidence(WRONG_ACTION))).toMatchObject({ collectorStatus: "UNKNOWN", runUnavailableReason: null, failedAssertionKinds: [],
      agent: { routeId: "rovara-scripted/v1", receipts: 1, okReceipts: 1, verifiedReceipts: 0, downloads: 0, caseReasons: ["agent-no-download"], unmockedCalls: unmocked } });
    expect(judged(WRONG_ACTION, fixtureEvidence(WRONG_ACTION))).toEqual({ ok: true });
  });

  it("verifies each record: the evidence derives to exactly the observation the record claims", () => {
    for (const probeId of WEB_API_AGENT_PROBE_IDS) {
      expect(verifyWebApiProbeRecord({ challenge, probeId, observation: observationOf(probeId, fixtureEvidence(probeId)), evidence: fixtureEvidence(probeId) })).toEqual({ ok: true });
    }
  });

  it("pins stored evidence: the retained oracles (written before the oracle had a round scope) verify, and the qualification verifier reads them as qualification rounds whatever scope they carry (Task FU2)", () => {
    for (const probeId of WEB_API_AGENT_PROBE_IDS) {
      const evidence = collected(probeId);
      expect(evidence.oracle).not.toHaveProperty("roundScope");
      const claimsStandard = structuredClone(evidence);
      (claimsStandard.oracle as Record<string, unknown>).roundScope = "standard";
      expect(observationOf(probeId, claimsStandard).agent).toEqual(observationOf(probeId, evidence).agent);
    }
  });

  it("does not let the evidence of one agent probe stand for another: the run id is derived from the probe", () => {
    for (const probeId of WEB_API_AGENT_PROBE_IDS) {
      for (const other of WEB_API_AGENT_PROBE_IDS.filter((item) => item !== probeId)) {
        expect(derive(other, fixtureEvidence(probeId)), `${probeId} as ${other}`).toEqual({ ok: false, reason: `probe-evidence-unbound:${other}` });
      }
    }
  });

  it("does not let a probe that is not an agent probe show agent facts, and an agent probe cannot be derived from the evidence of a run with no model", () => {
    expect(observationOf("web-csv-positive-v1", fixtureEvidence("web-csv-positive-v1"))).not.toHaveProperty("agent");
    const noModel = { ...collected("web-csv-positive-v1"), runId: collected(SCRIPTED).runId };
    expect(derive(SCRIPTED, noModel)).toEqual({ ok: false, reason: `probe-evidence-mismatch:${SCRIPTED}` });
  });

  describe("evidence edited after the run no longer qualifies (the worker's own claim is not believed)", () => {
    const edits: [string, string, (evidence: Collected) => void][] = [
      ["a receipt dropped", SCRIPTED, (e) => { e.oracle.agentModel.receipts.pop(); }],
      ["a receipt flipped to a provider error", SCRIPTED, (e) => { e.oracle.agentModel.receipts[0]!.outcome = "provider-error"; }],
      ["a receipt forged for the wrong-action run (a second call the report does not have)", WRONG_ACTION, (e) => { e.oracle.agentModel.receipts.push({ ...e.oracle.agentModel.receipts[0]!, receiptId: "forged" }); }],
      ["the action ledgers withdrawn", SCRIPTED, (e) => { e.oracle.agentModel.ledgers = []; }],
      ["the transcript digests withdrawn", ISOLATION, (e) => { e.oracle.agentModel.transcriptDigests = []; }],
      ["the admitted route replaced by another revision", SCRIPTED, (e) => { e.oracle.modelRoute = { routeId: "rovara-scripted/v1", routeRevision: "r2-000000000000" }; }],
      ["the admitted route replaced by another id", SCRIPTED, (e) => { e.oracle.modelRoute = { routeId: "rovara-e2e-default", routeRevision: e.oracle.modelRoute!.routeRevision }; }],
      ["the served route changed to a provider that spends", ISOLATION, (e) => { e.oracle.agentModel.route!.provider = "amazon-bedrock"; }],
      ["the served route withdrawn", WRONG_ACTION, (e) => { e.oracle.agentModel.route = null; }],
    ];
    it.each(edits)("%s: %s", (_label, probeId, edit) => {
      // Positive control: the same evidence unedited is judged ok.
      expect(judged(probeId, fixtureEvidence(probeId))).toEqual({ ok: true });
      const evidence = collected(probeId);
      edit(evidence);
      const derived = derive(probeId, evidence);
      // Either the bytes can no longer be read as a run of the probe, or they show an outcome the oracle does not accept; never the expected outcome.
      if (derived.ok) {
        expect(evaluateWebApiProbeObservation(probeId, derived.observation).ok).toBe(false);
        expect(verifyWebApiProbeRecord({ challenge, probeId, observation: observationOf(probeId, fixtureEvidence(probeId)), evidence })).toMatchObject({ ok: false });
      } else expect(derived.ok).toBe(false);
    });
  });

  it("holds the observation to the evidence: a claimed pass of the wrong-action run, or a claimed download, is refused", () => {
    const real = observationOf(WRONG_ACTION, fixtureEvidence(WRONG_ACTION));
    const claimed = { ...real, collectorStatus: "PASS" as const, agent: { ...real.agent!, caseReasons: [], verifiedReceipts: 1, downloads: 1 } };
    expect(verifyWebApiProbeRecord({ challenge, probeId: WRONG_ACTION, observation: claimed, evidence: fixtureEvidence(WRONG_ACTION) })).toEqual({ ok: false, reason: `probe-evidence-mismatch:${WRONG_ACTION}` });
    expect(canonicalJson(claimed)).not.toBe(canonicalJson(real));
  });

  describe("the agent facts, read from a collector oracle and verdict (each fact on its own)", () => {
    const route = { routeId: "rovara-scripted/v1", revision: 1, scope: "qualification", provider: "rovara-scripted", region: null, modelId: "rovara-scripted-v1", inferenceProfileArn: null, secretArn: null,
      openRouter: null, budgets: { maxActionsPerStep: 8, extraModelCallsPerStep: 4, callTimeoutMs: 30000, maxOutputTokens: 1024, maxInputTokens: 32000, maxPromptBytes: 262144, stepDeadlineMs: 90000,
        maxAgentStepsPerGroup: 3, maxModelCallsPerGroup: 40, maxInputTokensPerGroup: 400000, maxInputTokensPerProjectDay: 2000000, maxCallsPerProjectDay: 400 },
      promptProtocol: "e2e-0.20.0-act/v1", sampling: "provider-default", thinking: "off", effort: null, vision: false };
    const oracleWith = (change: { modelRoute?: unknown; served?: unknown; receipts?: Array<{ outcome: string }> }) => ({
      modelRoute: "modelRoute" in change ? change.modelRoute : { ...WEB_API_AGENT_PROBE_ROUTE },
      agentModel: { route: "served" in change ? change.served : route, receipts: change.receipts ?? [{ outcome: "ok" }, { outcome: "ok" }] } });
    const verdict = { status: "UNKNOWN", mockSummary: undefined, result: { modelReceiptIds: ["a"], cases: [{ status: "passed", reason: "structural-application-observations-complete", assertionReceipts: [{ assertionIndex: 0, status: "passed" }] }] } };
    const scenario = { assertions: [{ kind: "csv" }] };
    const facts = (oracle: unknown, qualification: unknown = verdict) => webApiAgentFacts(oracle as never, qualification as never, scenario);

    it("reports the scripted route only when the admitted route, the served route and the pinned revision are one", () => {
      expect(facts(oracleWith({})).routeId).toBe("rovara-scripted/v1");
      expect(facts(oracleWith({ modelRoute: { routeId: "rovara-scripted/v1", routeRevision: "r2-000000000000" } })).routeId).toBeNull();
      expect(facts(oracleWith({ modelRoute: { routeId: "rovara-e2e-default", routeRevision: WEB_API_AGENT_PROBE_ROUTE.routeRevision } })).routeId).toBeNull();
      expect(facts(oracleWith({ modelRoute: null })).routeId).toBeNull();
      expect(facts(oracleWith({ served: null })).routeId).toBeNull();
      expect(facts(oracleWith({ served: { ...route, revision: 2 } })).routeId).toBeNull();
      expect(facts(oracleWith({ served: { ...route, routeId: "rovara-e2e-default" } })).routeId).toBeNull();
    });

    it("counts the worker's receipts, those that answered, and those the report accounts for, each apart", () => {
      expect(facts(oracleWith({ receipts: [{ outcome: "ok" }, { outcome: "provider-error" }, { outcome: "ok" }] }))).toMatchObject({ receipts: 3, okReceipts: 2, verifiedReceipts: 1 });
      expect(facts(oracleWith({ receipts: [] }), { ...verdict, result: { ...verdict.result, modelReceiptIds: [] } })).toMatchObject({ receipts: 0, okReceipts: 0, verifiedReceipts: 0 });
    });

    it("counts a download only for a csv assertion that observed something, and names the reason of every case that did not pass", () => {
      const blocked = { ...verdict, result: { modelReceiptIds: [], cases: [{ status: "unavailable", reason: "agent-no-download", assertionReceipts: [{ assertionIndex: 0, status: "unavailable" }] }] } };
      expect(facts(oracleWith({}), blocked)).toMatchObject({ downloads: 0, caseReasons: ["agent-no-download"], verifiedReceipts: 0 });
      expect(facts(oracleWith({}))).toMatchObject({ downloads: 1, caseReasons: [] });
      const failedCsv = { ...verdict, result: { ...verdict.result, cases: [{ status: "failed", reason: "observed-application-assertion-failure", assertionReceipts: [{ assertionIndex: 0, status: "failed" }] }] } };
      expect(facts(oracleWith({}), failedCsv)).toMatchObject({ downloads: 1, caseReasons: ["observed-application-assertion-failure"] });
      // An assertion that is not a csv one is no download, whatever it saw.
      expect(webApiAgentFacts(oracleWith({}) as never, verdict as never, { assertions: [{ kind: "text" }] }).downloads).toBe(0);
    });

    it("says nothing for a collection the collector could not read: no cases, no receipts accounted for, no call recorded", () => {
      expect(facts(oracleWith({}), { status: "UNKNOWN", result: null })).toEqual({ routeId: "rovara-scripted/v1", receipts: 2, okReceipts: 2, verifiedReceipts: 0, downloads: 0, caseReasons: [], unmockedCalls: { sinkhole: 0, mocked: 0 } });
      expect(facts({ modelRoute: null, agentModel: null }, { status: "UNKNOWN", result: null })).toEqual({ routeId: null, receipts: 0, okReceipts: 0, verifiedReceipts: 0, downloads: 0, caseReasons: [], unmockedCalls: { sinkhole: 0, mocked: 0 } });
      expect(facts(oracleWith({}), { ...verdict, mockSummary: { unmockedCalls: { sinkhole: 1, mocked: 2 } } }).unmockedCalls).toEqual({ sinkhole: 1, mocked: 2 });
    });
  });
});
