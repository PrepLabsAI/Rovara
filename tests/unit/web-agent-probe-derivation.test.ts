import { describe, expect, it } from "vitest";
import { WEB_API_AGENT_PROBE_IDS, WEB_API_AGENT_PROBE_ROUTE, evaluateWebApiProbeObservation, type WebApiProbeEvidence } from "../../packages/contracts/src/index.js";
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

describe("the agent probes' retained evidence", () => {

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

    it("says nothing for a collection the collector could not read: no cases, no receipts accounted for, no call recorded", () => {
      expect(facts(oracleWith({}), { status: "UNKNOWN", result: null })).toEqual({ routeId: "rovara-scripted/v1", receipts: 2, okReceipts: 2, verifiedReceipts: 0, downloads: 0, caseReasons: [], unmockedCalls: { sinkhole: 0, mocked: 0 } });
      expect(facts({ modelRoute: null, agentModel: null }, { status: "UNKNOWN", result: null })).toEqual({ routeId: null, receipts: 0, okReceipts: 0, verifiedReceipts: 0, downloads: 0, caseReasons: [], unmockedCalls: { sinkhole: 0, mocked: 0 } });
      expect(facts(oracleWith({}), { ...verdict, mockSummary: { unmockedCalls: { sinkhole: 1, mocked: 2 } } }).unmockedCalls).toEqual({ sinkhole: 1, mocked: 2 });
    });
  });
});
