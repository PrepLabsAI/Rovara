import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { E2EAgentActionLedgerSchema, e2eAgentValueKeyId } from "@agentx/contracts";
import { scriptedE2ERouteDefinition } from "../../packages/model-runtime/src/e2e-route-derive.js";
import { agentRunnable, runAgentCase, type AgentRun } from "../support/agent-executor-run.js";
import { assembleAgentRun, collectAssembled, firstCase } from "../support/agent-collection.js";
import { agentCaseDirectoryName } from "../../packages/verifier/src/executor/evidence-paths.js";
import type { E2EAgentModelEvidence } from "../../packages/verifier/src/application-agent-result.js";
import { E2EApplicationCollectionOracleSchema, qualifyE2EApplicationCollection } from "../../packages/verifier/src/application-result-adapter.js";

// Task 4.4a: the real collector over real agent runs (the real executor and Chromium, the worker's proxy and the scripted model), read back the way the Docker host reads them, with the
// worker's receipts and the executor's ledgers that the host now carries. The pure function is tests/contract/workflow-e2e-agent-results.test.ts; the broker's side is
// tests/contract/workflow-e2e-agent-evidence.test.ts. These need the built verifier and a Chromium, and run where the 4.3b agent tests run.
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type Scenario = "ok" | "decoy" | "no-download" | "double" | "outage";
const SCRIPTS = {
  ok: [{ kind: "tap", name: /Download orders/ }, { kind: "done" }],
  decoy: [{ kind: "tap", name: /Download invoices/ }, { kind: "done" }],
  "no-download": [{ kind: "done" }],
  double: [{ kind: "tap", name: /Download orders/ }, { kind: "tap", name: /Download invoices/ }, { kind: "done" }],
  outage: [{ kind: "fail", message: "provider down" }],
} as const;

describe.runIf(agentRunnable)("the collector over real agent runs", () => {
  const runs: AgentRun[] = [];
  const byName = {} as Record<Scenario, AgentRun>;
  beforeAll(async () => {
    for (const name of Object.keys(SCRIPTS) as Scenario[]) {
      const run = await runAgentCase({ script: SCRIPTS[name] });
      runs.push(run); byName[name] = run;
    }
  }, 600_000);
  afterAll(async () => { await Promise.all(runs.splice(0).map((run) => run.cleanup())); });
  // The host reads a run back right after it closes it, and the collector wants the collection received within 30 s of that: each test reads its run back when it needs it.
  const readBack = (name: Scenario) => assembleAgentRun(byName[name]);

  it("R1: the report's agent step carries a cache of mode 'missed' with no replayed action, the seal step makes the runner write the recording (Task 4.6a), and the collector accepts that shape", async () => {
    const a = await readBack("ok");
    const report = JSON.parse(Buffer.from(a.actual.shards[0]!.rawReportBytes).toString("utf8")) as { run: { results: Array<{ attempts: Array<{ steps: Array<{ kind: string; cache?: Record<string, unknown> }> }> }> } };
    const cache = report.run.results[0]!.attempts[0]!.steps.find((step) => step.kind === "agent")!.cache!;
    expect(cache).toMatchObject({ mode: "missed", reason: "no-entry", replayedActions: 0, totalActions: 0 });
    expect(cache["entry"]).toMatch(/^[a-f0-9]{64}$/);
    // Before Task 4.6a nothing was ever written (the write was "unconfirmed"): the approved assertions open first, so none verified after the agent step. The seal step does.
    expect(cache["write"]).toBe("saved");
    expect(collectAssembled(a).unavailableReason).toBeNull();
  });

  it("1. the renamed export: the collector passes the case, and the verified receipt ids are the two receipts of the step, sorted", async () => {
    const a = await readBack("ok");
    const collected = collectAssembled(a);
    expect(collected.unavailableReason, collected.unavailableReason ?? "").toBeNull();
    expect(collected.qualification!.status).toBe("PASS");
    expect(firstCase(collected)).toMatchObject({ status: "passed", reason: "structural-application-observations-complete" });
    expect(a.run.receipts.map((receipt) => receipt.outcome)).toEqual(["ok", "ok"]);
    expect(collected.qualification!.result!.modelReceiptIds).toEqual(a.run.receipts.map((receipt) => receipt.receiptId).sort());
    // What the host carries: both receipts, the ledger of the case, a transcript record per receipt, a clean channel.
    expect(a.agentModel.receipts).toHaveLength(2);
    expect(a.agentModel.ledgers.map((ledger) => ledger.caseDirectory)).toEqual([agentCaseDirectoryName(a.run.caseId)]);
    expect(a.agentModel.transcriptDigests.map((digest) => digest.receiptId)).toEqual(a.agentModel.receipts.map((receipt) => receipt.receiptId));
    expect(a.agentModel.channel).toEqual({ droppedRequests: 0, unscopedRequests: 0, overrun: false, evidenceErrors: 0 });
    // The transcript digests the host computed are the receipts' own: the worker's record is one story.
    for (const [index, digest] of a.agentModel.transcriptDigests.entries()) {
      expect(digest).toMatchObject({ promptSha256: a.agentModel.receipts[index]!.promptSha256, responseSha256: a.agentModel.receipts[index]!.responseSha256, omitted: null });
    }
  });

  it("2. the decoy: a wrong click that leaves the CSV different is FAILED on the assertion alone (decision D3), not UNKNOWN", async () => {
    const collected = collectAssembled(await readBack("decoy"));
    expect(collected.unavailableReason, collected.unavailableReason ?? "").toBeNull();
    expect(collected.qualification!.status).toBe("FAILED");
    expect(firstCase(collected)).toMatchObject({ status: "failed", reason: "observed-application-assertion-failure" });
  });

  it("3. a model that finished without acting leaves no download: UNKNOWN agent-no-download on the case, never a pass", async () => {
    const collected = collectAssembled(await readBack("no-download"));
    expect(collected.qualification?.result, collected.unavailableReason ?? "").not.toBeNull();
    expect(collected.qualification!.status).toBe("UNKNOWN");
    expect(firstCase(collected)).toMatchObject({ status: "unavailable", reason: "agent-no-download" });
  });

  it("9. two downloads: UNKNOWN ambiguous-download", async () => {
    const collected = collectAssembled(await readBack("double"));
    expect(collected.qualification?.result, collected.unavailableReason ?? "").not.toBeNull();
    expect(collected.qualification!.status).toBe("UNKNOWN");
    expect(firstCase(collected)).toMatchObject({ status: "unavailable", reason: "ambiguous-download" });
  });

  it("6. a provider outage: the executor records the stopped step, and the collector says model-unavailable (it can no longer pass or fail)", async () => {
    const a = await readBack("outage");
    // The executor leaves a capture for the case whose agent step did not conclude, so the collector can say why.
    expect(a.actual.applicationCaptures).toHaveLength(1);
    expect(a.actual.applicationCaptures[0]!.steps.map((step) => [step.kind, step.outcome])).toEqual([["navigate", "completed"], ["agent", "unavailable"]]);
    const collected = collectAssembled(a);
    expect(collected.qualification?.result, collected.unavailableReason ?? "").not.toBeNull();
    expect(collected.qualification!.status).toBe("UNKNOWN");
    expect(firstCase(collected)).toMatchObject({ status: "unavailable", reason: "model-unavailable" });
    expect(collected.qualification!.result!.modelReceiptIds).toEqual([]);
    // AGENTCODES: the codes the case matched ride on the qualification (for the worker's log), and a clean case has none.
    expect(collected.qualification!.agentCodes).toEqual([{ caseId: a.run.caseId, codes: ["model-unavailable"] }]);
    expect(collectAssembled(await readBack("ok")).qualification!.agentCodes).toBeUndefined();
  });

  it("AGENTSTRAY: a transcript record that no receipt names, and a second ledger for one case, make the group UNKNOWN with the mismatch code", async () => {
    const a = await readBack("ok");
    expect(collectAssembled(a).qualification!.status).toBe("PASS");
    const stray = { receiptId: "no-such-receipt", promptSha256: null, responseSha256: null, omitted: "budget" as const };
    const withStray = collectAssembled(a, { ...a.inputs, agentModel: { ...a.agentModel, transcriptDigests: [...a.agentModel.transcriptDigests, stray] } });
    expect(withStray.qualification?.status ?? "UNKNOWN").toBe("UNKNOWN");
    expect(withStray.unavailableReason).toMatch(/^model-receipts-mismatch: a transcript record names no model receipt of the group/);
    // An identical second ledger for the case used to be read as its first; now it is refused.
    const withTwin = collectAssembled(a, { ...a.inputs, agentModel: { ...a.agentModel, ledgers: [...a.agentModel.ledgers, { ...a.agentModel.ledgers[0]! }] } });
    expect(withTwin.qualification?.status ?? "UNKNOWN").toBe("UNKNOWN");
    expect(withTwin.unavailableReason).toMatch(/^model-receipts-mismatch: two action ledgers came for one case/);
  });

  it("AGENTZODKEY: a collection the schema refuses because of a key the executor chose is UNKNOWN under a fixed code and our own path, never under the key's name", async () => {
    const a = await readBack("ok");
    const collected = collectAssembled(a);
    expect(collected.qualification!.status).toBe("PASS");
    const key = "hunter2-executor-key";
    const collection = JSON.parse(JSON.stringify(collected.collection)) as { shards: Array<Record<string, unknown>>; applicationCaptures: Array<Record<string, unknown>> };
    collection.shards[0]![key] = 1;
    const refused = qualifyE2EApplicationCollection(collected.oracle!, collection as never);
    expect(refused.status).toBe("UNKNOWN");
    expect(refused.reason).toMatch(/^schema-error: unrecognized_keys at shards\.\[\]$/);
    expect(JSON.stringify(refused)).not.toContain(key);
    // A key under a record, and one in a capture, in the same way.
    const record = JSON.parse(JSON.stringify(collected.collection)) as { shards: Array<{ fixedAssetDigests: Record<string, unknown> }> };
    record.shards[0]!.fixedAssetDigests[key] = "not-a-digest";
    expect(JSON.stringify(qualifyE2EApplicationCollection(collected.oracle!, record as never))).not.toContain(key);
    const capture = JSON.parse(JSON.stringify(collected.collection)) as { applicationCaptures: Array<Record<string, unknown>> };
    capture.applicationCaptures[0]![key] = true;
    const inCapture = qualifyE2EApplicationCollection(collected.oracle!, capture as never);
    expect(inCapture.status).toBe("UNKNOWN");
    expect(JSON.stringify(inCapture)).not.toContain(key);
  });

  it("21. a group with an agent step and no model evidence is UNKNOWN with the mismatch code, never a pass", async () => {
    const a = await readBack("ok");
    const withoutAgent = Object.fromEntries(Object.entries(a.inputs).filter(([key]) => key !== "agentModel")) as typeof a.inputs;
    const collected = collectAssembled(a, withoutAgent);
    expect(collected.qualification?.status ?? "UNKNOWN").toBe("UNKNOWN");
    expect(collected.unavailableReason ?? "").toMatch(/^model-receipts-mismatch:/);
    expect(collectAssembled(a, { ...a.inputs, agentModel: null }).unavailableReason ?? "").toMatch(/^model-receipts-mismatch:/);
  });

  it("23. receipts edited after the fact do not requalify: a flipped outcome, a forged ledger receipt id, a ledger under another key, a missing ledger", async () => {
    const a = await readBack("ok");
    const agentModel = a.agentModel;
    const asReceipts = (edit: (receipts: E2EAgentModelEvidence["receipts"]) => E2EAgentModelEvidence["receipts"]) => collectAssembled(a, { ...a.inputs, agentModel: { ...agentModel, receipts: edit(agentModel.receipts) } });
    // An ok receipt turned into a provider error: the report counts two calls and the receipts one.
    const flipped = asReceipts((receipts) => receipts.map((receipt, index) => (index === 1 ? { ...receipt, outcome: "provider-error" as const, responseSha256: null } : receipt)));
    expect(flipped.qualification?.status ?? "UNKNOWN").toBe("UNKNOWN");
    expect(flipped.unavailableReason ?? "").toMatch(/^model-receipts-mismatch:/);
    // A receipt dropped from the worker's list: the report counts calls the receipts do not show.
    expect(asReceipts((receipts) => receipts.slice(0, 1)).qualification?.status ?? "UNKNOWN").toBe("UNKNOWN");
    // The ledger, edited and re-addressed (the worker can do that), now names a receipt the worker never wrote.
    const ledger = E2EAgentActionLedgerSchema.parse(JSON.parse(Buffer.from(agentModel.ledgers[0]!.bytesBase64, "base64").toString("utf8")));
    const tamper = (edit: (value: typeof ledger) => unknown) => {
      const bytes = Buffer.from(JSON.stringify(edit(JSON.parse(JSON.stringify(ledger)) as typeof ledger)));
      return collectAssembled(a, { ...a.inputs, agentModel: { ...agentModel, ledgers: [{ ...agentModel.ledgers[0]!, bytesBase64: bytes.toString("base64"), sha256: sha(bytes) }] } });
    };
    const forged = tamper((value) => { value.steps[0]!.receiptIds.push("rcpt-never-written"); return value; });
    expect(forged.qualification?.result?.cases[0]?.reason).toBe("model-receipts-mismatch");
    expect(forged.qualification!.status).toBe("UNKNOWN");
    expect(tamper((value) => ({ ...value, valueKeyId: e2eAgentValueKeyId("cd".repeat(32)) })).qualification?.result?.cases[0]?.reason).toBe("model-receipts-mismatch");
    // A ledger whose bytes are not the digest it is filed under, and no ledger at all.
    const badDigest = collectAssembled(a, { ...a.inputs, agentModel: { ...agentModel, ledgers: [{ ...agentModel.ledgers[0]!, sha256: "0".repeat(64) }] } });
    expect(badDigest.qualification?.result?.cases[0]?.reason).toBe("model-receipts-mismatch");
    const none = collectAssembled(a, { ...a.inputs, agentModel: { ...agentModel, ledgers: [] } });
    expect(none.qualification?.result?.cases[0]?.reason).toBe("model-receipts-mismatch");
    // None of them is a pass.
    for (const result of [forged, badDigest, none]) expect(result.qualification!.status).not.toBe("PASS");
  });

  it("19. a deterministic case beside an AI-navigated one keeps its verdict, and receipts attributed to it fail the group with the mismatch code", async () => {
    const run = await runAgentCase({ script: SCRIPTS.ok, plan: { withDeterministicCase: true } });
    runs.push(run);
    const a = await assembleAgentRun(run);
    const [agentCase, plainCase] = run.fixture.compiled.expectedCases;
    expect([agentCase!.scenarioId, plainCase!.scenarioId]).toEqual(["agent-export", "plain-identity"]);
    const collected = collectAssembled(a);
    expect(collected.unavailableReason, collected.unavailableReason ?? "").toBeNull();
    expect(collected.qualification!.status).toBe("PASS");
    const byCase = new Map(collected.qualification!.result!.cases.map((item) => [item.caseId, item]));
    expect(byCase.get(plainCase!.caseId)).toMatchObject({ status: "passed", reason: "structural-application-observations-complete" });
    expect(byCase.get(agentCase!.caseId)).toMatchObject({ status: "passed", reason: "structural-application-observations-complete" });
    // Only the AI-navigated case's receipts are the result's.
    expect(collected.qualification!.result!.modelReceiptIds).toEqual(run.receipts.map((receipt) => receipt.receiptId).sort());
    expect(a.agentModel.ledgers.map((ledger) => ledger.caseDirectory)).toEqual([agentCaseDirectoryName(agentCase!.caseId)]);
    // A receipt attributed to the deterministic case: the group is UNKNOWN, not a pass and not a failure.
    const moved = collectAssembled(a, { ...a.inputs, agentModel: { ...a.agentModel, receipts: a.agentModel.receipts.map((receipt, index) => (index === 0 ? { ...receipt, caseId: plainCase!.caseId } : receipt)) } });
    expect(moved.qualification?.status ?? "UNKNOWN").toBe("UNKNOWN");
    expect(moved.unavailableReason).toMatch(/^model-receipts-mismatch: a model receipt is attributed to a case with no AI navigation step/);
    // A ledger filed for the deterministic case is never read for it: the agent case still has its own.
    const extraLedger = collectAssembled(a, { ...a.inputs, agentModel: { ...a.agentModel, ledgers: [...a.agentModel.ledgers, { ...a.agentModel.ledgers[0]!, caseDirectory: agentCaseDirectoryName(plainCase!.caseId) }] } });
    expect(extraLedger.qualification!.status).toBe("PASS");
  });

  it("an AI-navigated case whose receipts do not agree is UNKNOWN even when its CSV assertion failed: a model it cannot account for never moves a case to FAILED (decision D3 holds for a clean agent part only)", async () => {
    const a = await readBack("decoy");
    expect(collectAssembled(a).qualification!.status).toBe("FAILED");
    const dirty = collectAssembled(a, { ...a.inputs, agentModel: { ...a.agentModel, channel: { ...a.agentModel.channel, unscopedRequests: 1 } } });
    expect(dirty.qualification!.status).toBe("UNKNOWN");
    expect(firstCase(dirty)).toMatchObject({ status: "unavailable", reason: "model-receipts-mismatch" });
    const forged = collectAssembled(a, { ...a.inputs, agentModel: { ...a.agentModel, receipts: a.agentModel.receipts.slice(0, 1) } });
    expect(forged.qualification?.status ?? "UNKNOWN").toBe("UNKNOWN");
  });

  it("the route the worker served must be the admitted revision: another definition in the evidence is refused by the worker's own collector too", async () => {
    const a = await readBack("ok");
    // The same route id as the admission names, at another revision.
    const collected = collectAssembled(a, { ...a.inputs, agentModel: { ...a.agentModel, route: scriptedE2ERouteDefinition({ revision: 2 }) } });
    expect(collected.qualification).toBeNull();
    expect(collected.unavailableReason).toMatch(/^model-receipts-mismatch: the model evidence is not for a group with AI navigation steps under the admitted route/);
  });

  it("a channel that failed to close makes the evidence say so: UNKNOWN, with the mismatch code on the case", async () => {
    const a = await readBack("ok");
    const faulty = collectAssembled(a, { ...a.inputs, agentModel: { ...a.agentModel, route: null, receipts: [], channel: { droppedRequests: 0, unscopedRequests: 0, overrun: false, evidenceErrors: 1 } } });
    expect(faulty.qualification!.status).toBe("UNKNOWN");
  });

  it("the report's account of each step is held to the receipts: a worker that reports more calls than receipts cannot pass", async () => {
    const a = await readBack("ok");
    const withDropped = collectAssembled(a, { ...a.inputs, agentModel: { ...a.agentModel, channel: { ...a.agentModel.channel, droppedRequests: 1 } } });
    expect(withDropped.qualification!.status).toBe("UNKNOWN");
    expect(withDropped.qualification!.result!.cases[0]!.reason).toBe("model-receipts-mismatch");
  });
  it("AGENTSCOPE: the scope of the round decides whether scripted receipts count, never the scope the route's own definition claims", async () => {
    const a = await readBack("ok");
    // The evidence's route says `qualification` (the scripted double's own definition), as a registry row that claimed it would.
    expect(a.agentModel.route!.scope).toBe("qualification");
    // As a qualification round (the runner's) the run passes.
    const asQualification = collectAssembled(a, a.inputs, "qualification");
    expect(asQualification.qualification!.status).toBe("PASS");
    // As a customer round (no scope given, or standard) the same bytes are not accepted: the receipts are the scripted double's.
    for (const scope of [null, "standard"] as const) {
      const asCustomer = collectAssembled(a, a.inputs, scope);
      expect(asCustomer.qualification!.status).toBe("UNKNOWN");
      expect(firstCase(asCustomer)).toMatchObject({ status: "unavailable", reason: "model-receipts-mismatch" });
    }
    // Stored data: an oracle written before the field existed has none, still parses, and is read as a customer round (fail closed).
    expect(asQualification.oracle!.roundScope).toBe("qualification");
    const { roundScope: _gone, ...legacyOracle } = asQualification.oracle!;
    void _gone;
    expect(E2EApplicationCollectionOracleSchema.parse(legacyOracle).roundScope).toBeUndefined();
    expect(qualifyE2EApplicationCollection(E2EApplicationCollectionOracleSchema.parse(legacyOracle), asQualification.collection!).status).toBe("UNKNOWN");
  });
});
