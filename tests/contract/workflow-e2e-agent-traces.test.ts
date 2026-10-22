import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { E2E_AGENT_TRACE_FILE_MAX_BYTES, canonicalJson, E2E_AGENT_TRACE_SUMMARY, reviewCapturedE2EAgentTrace } from "@agentx/contracts";
import { agentRunnable, runAgentCase, type AgentRun } from "../support/agent-executor-run.js";
import { AGENT_GOAL } from "../support/orders-m14-agent.js";
import { asLinuxRun, assembleAgentRun, brokerRoundFor, collectAssembled, firstCase } from "../support/agent-collection.js";
import { agentTraceGroupOf, buildE2EAgentModelEvidence } from "../../packages/verifier/src/host/agent-model-evidence.js";
import { agentInstructionDigest, mapAgentTraceToStep, reviewAgentTraceFile, selectAgentTraceUploads, verifiedAgentCaseLedger, type E2EAgentTraceCase } from "../../packages/verifier/src/application-agent-traces.js";
import { agentCaseDirectoryName } from "../../packages/verifier/src/executor/agent-ledger.js";
import { verifyApplicationE2EEvidence, type ApplicationEvidenceInput } from "../../packages/broker/src/e2e/application-evidence.js";

// Task 4.6a (CAPTURE46) end to end on this machine: the real executor and a real Chromium leave the recording of a passed AI navigation step; the host reviews it against the ledger and
// uploads it with the group's evidence; the broker reviews it again against the ledger it verified, and hands it on only for a round it decided is PASS.
type Name = "ok" | "decoy" | "outage" | "no-download" | "twin";
const SCRIPTS = {
  ok: [{ kind: "tap", name: /Download orders/ }, { kind: "done" }],
  decoy: [{ kind: "tap", name: /Download invoices/ }, { kind: "done" }],
  outage: [{ kind: "fail", message: "provider down" }],
  "no-download": [{ kind: "done" }],
  // Two steps with one goal in one case (the scripted model answers each from its first turn, so both export).
  twin: [{ kind: "tap", name: /Download orders/ }, { kind: "done" }],
} as const;
const twinBefore = [{ kind: "navigate" as const, path: "/" }, { kind: "agent" as const, goal: AGENT_GOAL, maxActions: 4 }];

type Json = Record<string, unknown>;
type TraceAction = Record<string, unknown> & { target: Record<string, unknown> };
type TraceBody = { actions: TraceAction[]; endAnchors?: Json[]; endPath?: string } & Json;
/** The group's model evidence inside an uploaded group run, for the tests that edit it after the fact. */
const modelEvidenceOf = (groupRun: Json): Json => ((groupRun["actual"] as { collectionInputs: { agentModel: Json } }).collectionInputs).agentModel;
const uploadsOf = (groupRun: Json): Json[] => modelEvidenceOf(groupRun)["traces"] as Json[];

const traceFiles = (run: AgentRun) => { const dir = join(run.out, "agent", "traces"); return existsSync(dir) ? readdirSync(dir).sort() : []; };
const reportSteps = (run: AgentRun) => (JSON.parse(readFileSync(join(run.out, "report.json"), "utf8")) as { run: { results: Array<{ attempts: Array<{ steps: Array<{ kind: string; label: string; status: string }> }> }> } })
  .run.results[0]!.attempts[0]!.steps.map((step) => `${step.kind}:${step.label}:${step.status}`);
const SEAL = "assertion:approved assertions held:passed";

describe.runIf(agentRunnable)("the recording of a passed AI navigation step (Task 4.6a)", () => {
  const runs: AgentRun[] = [];
  const byName = {} as Record<Name, AgentRun>;
  beforeAll(async () => {
    for (const name of Object.keys(SCRIPTS) as Name[]) {
      const run = await runAgentCase({ script: SCRIPTS[name], ...(name === "twin" ? { plan: { before: twinBefore } } : {}) });
      runs.push(run); byName[name] = run;
    }
  }, 900_000);
  afterAll(async () => { await Promise.all(runs.splice(0).map((run) => run.cleanup())); });
  const readBack = async (name: Name) => asLinuxRun(await assembleAgentRun(byName[name]));

  it("1/3. a passed case leaves exactly one cleaned recording, the seal step comes after the agent step, and the collector's verdict is still PASS", async () => {
    const run = byName.ok;
    expect(run.result.exitCode).toBe(0);
    expect(traceFiles(run)).toHaveLength(1);
    const steps = reportSteps(run);
    expect(steps.filter((step) => step === SEAL)).toHaveLength(1);
    expect(steps.indexOf(SEAL)).toBeGreaterThan(steps.findIndex((step) => step.startsWith("agent:")));
    const a = await readBack("ok");
    expect(firstCase(collectAssembled(a))?.status).toBe("passed");
    expect(a.agentModel.traces).toHaveLength(1);
  });

  it("2. a decoy (CSV mismatch), an outage, no download and a stopped agent record no seal, leave no recording and upload none; the verdict is the one the checks decide", async () => {
    for (const name of ["decoy", "outage", "no-download"] as const) {
      const run = byName[name];
      expect(traceFiles(run), name).toEqual([]);
      expect(reportSteps(run), name).not.toContain(SEAL);
      const a = await readBack(name);
      expect(a.agentModel.traces, name).toBeUndefined();
    }
    // The decoy still fails on the CSV alone and the outage is still UNKNOWN.
    expect(firstCase(collectAssembled(await readBack("decoy")))?.status).toBe("failed");
    expect(firstCase(collectAssembled(await readBack("outage")))?.status).toBe("unavailable");
  });

  it("4. the uploaded recording holds a fixed summary and targets of role, name and testId only, and no credential reaches any uploaded object", async () => {
    const a = await readBack("ok");
    const [upload] = a.agentModel.traces!;
    const bytes = Buffer.from(upload!.traceBase64, "base64");
    expect(bytes.byteLength).toBeLessThanOrEqual(E2E_AGENT_TRACE_FILE_MAX_BYTES);
    const file = JSON.parse(bytes.toString("utf8")) as { schemaVersion: string; keyHash: string; trace: { summary: string; actions: Array<{ summary: string; target: Record<string, unknown> }>; endAnchors?: Array<Record<string, unknown>> } };
    expect(file.schemaVersion).toBe("rovara-agent-trace-file/v1");
    expect(file.keyHash).toBe(upload!.keyHash);
    expect(file.trace.summary).toBe(E2E_AGENT_TRACE_SUMMARY);
    expect(file.trace.actions).toHaveLength(1);
    expect(Object.keys(file.trace.actions[0]!.target).sort()).toEqual(["name", "role", "testId"]);
    expect(file.trace.actions[0]!.summary).toBe("The tap action.");
    // The anchors are the candidate's own screen text: "Orders exported", within the owner's bound.
    expect(file.trace.endAnchors).toEqual([{ text: "Orders exported", testId: "orders-export-status" }]);
    // Positive control: the scan below runs over the recording and over everything the group uploads.
    const everything = JSON.stringify({ traces: a.agentModel.traces, inputs: { ...a.inputs, agentModel: { ...a.agentModel, valueKey: "" } } });
    expect(everything).toContain(upload!.traceBase64);
    for (const account of a.run.fixture.plan.accounts) {
      for (const secret of [account.password, account.email, account.email.split("@")[0]!, Buffer.from(account.password).toString("base64"), Buffer.from(account.password).toString("base64url"),
        Buffer.from(account.password).toString("hex"), encodeURIComponent(account.password), JSON.stringify(account.password).slice(1, -1)]) {
        expect(everything, secret.slice(0, 6)).not.toContain(secret);
        expect(bytes.toString("utf8")).not.toContain(secret);
      }
    }
  });

  it("5. the testId and the instruction digest map the recording to its case and step, including two steps with one goal (callIndex); an unmappable one is dropped", async () => {
    const a = await readBack("ok");
    const group = agentTraceGroupOf(a.resolved.suite, a.resolved.binding.runId);
    expect(group.cases).toHaveLength(1);
    expect(group.cases[0]!.steps).toEqual([{ stepIndex: 1, goal: AGENT_GOAL }]);
    const caseId = group.cases[0]!.caseId;
    const [upload] = a.agentModel.traces!;
    expect(upload).toMatchObject({ caseDirectory: agentCaseDirectoryName(caseId), stepIndex: 1 });
    const file = JSON.parse(Buffer.from(upload!.traceBase64, "base64").toString("utf8")) as { trace: { recordedFor: { testId: string; instructionDigest: string; callIndex: number } } };
    // Pinned against a real trace: e2e's instruction digest is the SHA-256 of the normalised goal, and the test id ends with the case id.
    expect(file.trace.recordedFor.instructionDigest).toBe(agentInstructionDigest(AGENT_GOAL));
    expect(file.trace.recordedFor.testId.endsWith(`::${caseId}`)).toBe(true);
    expect(file.trace.recordedFor.callIndex).toBe(0);
    const cases: E2EAgentTraceCase[] = [{ caseId, steps: group.cases[0]!.steps, ledger: null }];
    expect(mapAgentTraceToStep(file.trace, cases)).toEqual({ caseId, stepIndex: 1 });
    expect(mapAgentTraceToStep({ ...file.trace, recordedFor: { ...file.trace.recordedFor, testId: "x::case-other" } }, cases)).toBeUndefined();
    expect(mapAgentTraceToStep({ ...file.trace, recordedFor: { ...file.trace.recordedFor, instructionDigest: "0".repeat(64) } }, cases)).toBeUndefined();
    expect(mapAgentTraceToStep({ ...file.trace, recordedFor: { ...file.trace.recordedFor, callIndex: 1 } }, cases)).toBeUndefined();
    expect(mapAgentTraceToStep({ ...file.trace, recordedFor: undefined }, cases)).toBeUndefined();
    expect(mapAgentTraceToStep({ ...file.trace, recordedFor: { ...file.trace.recordedFor, callIndex: -1 } }, cases)).toBeUndefined();
    // Two steps of one goal in one case are told apart by callIndex: the second recording of the same goal is the step after the first with that goal.
    const twice: E2EAgentTraceCase[] = [{ caseId, steps: [{ stepIndex: 1, goal: AGENT_GOAL }, { stepIndex: 3, goal: "Another goal" }, { stepIndex: 4, goal: `  ${AGENT_GOAL}\r\n` }], ledger: null }];
    expect(mapAgentTraceToStep(file.trace, twice)).toEqual({ caseId, stepIndex: 1 });
    expect(mapAgentTraceToStep({ ...file.trace, recordedFor: { ...file.trace.recordedFor, callIndex: 1 } }, twice)).toEqual({ caseId, stepIndex: 4 });
    expect(mapAgentTraceToStep({ ...file.trace, recordedFor: { ...file.trace.recordedFor, callIndex: 2 } }, twice)).toBeUndefined();
    // In a real case with two steps of the goal, e2e records the second only if the page changed again (here the second tap changes nothing: its write is "no-change"), so the case
    // leaves one recording, and it maps to the first step.
    const twin = await readBack("twin");
    expect(twin.run.result.exitCode).toBe(0);
    expect(reportSteps(byName.twin).filter((step) => step === SEAL)).toHaveLength(1);
    const twinGroup = agentTraceGroupOf(twin.resolved.suite, twin.resolved.binding.runId);
    expect(twinGroup.cases[0]!.steps.map((step) => step.stepIndex)).toEqual([1, 2]);
    expect(twin.agentModel.traces?.map((item) => item.stepIndex)).toEqual([1]);
    const verdict = brokerRoundFor(twin).verify();
    expect(verdict.verdict).toBe("PASS");
    expect(verdict.agentTraces?.map((item) => item.stepIndex)).toEqual([1]);
  });

  it("6. the host drops a recording that disagrees with the ledger by one action, kind, target or value, and the verdict is unchanged", async () => {
    const a = await readBack("ok");
    const files = a.snapshot.executorEvidence.agent!.traces;
    expect(files).toHaveLength(1);
    const original = JSON.parse(Buffer.from(files[0]!.bytes).toString("utf8")) as { trace: TraceBody };
    const edits: Array<[string, (trace: TraceBody) => void]> = [
      ["an extra action", (trace) => { trace.actions.push({ ...trace.actions[0]! }); }],
      ["no action", (trace) => { trace.actions.length = 0; }],
      ["another kind", (trace) => { trace.actions[0]!["name"] = "type"; trace.actions[0]!["value"] = "orders"; }],
      ["another target name", (trace) => { trace.actions[0]!.target["name"] = "Download invoices"; }],
      ["another test id", (trace) => { trace.actions[0]!.target["testId"] = "download-invoices"; }],
      // Task 4.6a fix round 1 (Q4 and the strict shape): a trace that is not the cleaned shape is not uploaded, however well it matches the ledger.
      ["a selector on a target", (trace) => { trace.actions[0]!.target["selector"] = "main > button"; }],
      ["a prose summary", (trace) => { trace["summary"] = "The model said the export worked."; }],
      ["a query in the end path", (trace) => { trace.endPath = "/orders?token=abc"; }],
      ["a target name past 120 characters", (trace) => { trace.actions[0]!.target["name"] = "n".repeat(121); }],
      ["a field the cleaner does not produce", (trace) => { trace["modelNotes"] = "x"; }],
      ["an anchor input value that is text the model chose", (trace) => { trace.endAnchors![0]!["value"] = "typed by the model"; }],
      ["seventeen anchors", (trace) => { trace.endAnchors = Array.from({ length: 9 }, () => ({ text: "x" })); trace["goneAnchors"] = Array.from({ length: 8 }, () => ({ text: "y" })); }],
    ];
    const group = agentTraceGroupOf(a.resolved.suite, a.resolved.binding.runId);
    for (const [name, edit] of edits) {
      const copy = JSON.parse(JSON.stringify(original)) as typeof original;
      edit(copy.trace);
      const evidence = buildE2EAgentModelEvidence({ closed: byName.ok.closed, valueKey: byName.ok.valueKey, group,
        agent: { ...a.snapshot.executorEvidence.agent!, traces: [{ name: files[0]!.name, bytes: Buffer.from(JSON.stringify(copy)) }] } });
      expect(evidence.traces, name).toBeUndefined();
      // The verdict inputs are otherwise identical, and the collector still says PASS.
      expect({ ...evidence, traces: undefined }).toEqual({ ...a.agentModel, traces: undefined });
      expect(firstCase(collectAssembled(a, { ...a.inputs, agentModel: evidence }))?.status, name).toBe("passed");
    }
    // Positive control: the untouched file is kept by the same call.
    const kept = buildE2EAgentModelEvidence({ closed: byName.ok.closed, valueKey: byName.ok.valueKey, group, agent: a.snapshot.executorEvidence.agent! });
    expect(kept.traces).toHaveLength(1);
    // A file that is not the shape (bytes over the ceiling, not JSON, another schema version) is dropped as well.
    for (const bytes of [Buffer.alloc(E2E_AGENT_TRACE_FILE_MAX_BYTES + 1, 0x20), Buffer.from("not json"), Buffer.from(JSON.stringify({ ...original, schemaVersion: "other", keyHash: "a".repeat(64) }))]) {
      expect(buildE2EAgentModelEvidence({ closed: byName.ok.closed, valueKey: byName.ok.valueKey, group, agent: { ...a.snapshot.executorEvidence.agent!, traces: [{ name: files[0]!.name, bytes }] } }).traces).toBeUndefined();
    }
    // A host with no group to map to uploads none, and the group's own run id is part of the ledger check.
    expect(buildE2EAgentModelEvidence({ closed: byName.ok.closed, valueKey: byName.ok.valueKey, agent: a.snapshot.executorEvidence.agent! }).traces).toBeUndefined();
    expect(buildE2EAgentModelEvidence({ closed: byName.ok.closed, valueKey: byName.ok.valueKey, group: { ...group, runId: "11111111-1111-4111-8111-111111111111" }, agent: a.snapshot.executorEvidence.agent! }).traces).toBeUndefined();
    expect(buildE2EAgentModelEvidence({ closed: byName.ok.closed, valueKey: "cd".repeat(32), group, agent: a.snapshot.executorEvidence.agent! }).traces).toBeUndefined();
  });

  it("6b. two recordings for one step, or more than three, are never uploaded past the cap, and the review's binding is the ledger's and the trace's digest", async () => {
    const a = await readBack("ok");
    const group = agentTraceGroupOf(a.resolved.suite, a.resolved.binding.runId);
    const file = a.snapshot.executorEvidence.agent!.traces[0]!;
    const twice = buildE2EAgentModelEvidence({ closed: byName.ok.closed, valueKey: byName.ok.valueKey, group, agent: { ...a.snapshot.executorEvidence.agent!, traces: [file, { name: "trace-0000000000000000.json", bytes: Buffer.from(file.bytes) }] } });
    expect(twice.traces).toBeUndefined();
    const [upload] = a.agentModel.traces!;
    const ledger = verifiedAgentCaseLedger({ ledgerBytes: a.snapshot.executorEvidence.agent!.ledgers[0]!.bytes, valueKey: byName.ok.valueKey, runId: a.resolved.binding.runId, caseId: group.cases[0]!.caseId, steps: group.cases[0]!.steps })!;
    const parsed = JSON.parse(Buffer.from(upload!.traceBase64, "base64").toString("utf8")) as { trace: unknown };
    expect(reviewCapturedE2EAgentTrace({ stepIndex: 1, trace: parsed.trace, ledger, valueKey: byName.ok.valueKey, credentialScanHit: false })).toEqual({ keep: true, binding: upload!.binding });
    expect(upload!.binding.actionCount).toBe(1);
    const review = reviewAgentTraceFile({ bytes: Buffer.from(upload!.traceBase64, "base64"), cases: [{ ...group.cases[0]!, ledger }], valueKey: byName.ok.valueKey,
      expect: { caseDirectory: upload!.caseDirectory, stepIndex: 1, keyHash: upload!.keyHash } });
    expect(review).toMatchObject({ keep: true, binding: upload!.binding });
    expect(reviewAgentTraceFile({ bytes: Buffer.from(upload!.traceBase64, "base64"), cases: [{ ...group.cases[0]!, ledger }], valueKey: byName.ok.valueKey,
      expect: { caseDirectory: upload!.caseDirectory, stepIndex: 2, keyHash: upload!.keyHash } })).toEqual({ keep: false, reason: "trace-step-mismatch" });
    expect(selectAgentTraceUploads({ files: [{ bytes: Buffer.from(upload!.traceBase64, "base64") }], cases: [{ ...group.cases[0]!, ledger: null }], valueKey: byName.ok.valueKey })).toEqual([]);
  });

  it("7. the broker hands on the recording only for a PASS round: empty for FAILED and UNKNOWN, and for a PASS whose recording was edited, claimed for another step, or not the binding", async () => {
    const a = await readBack("ok");
    const pass = brokerRoundFor(a).verify();
    expect(pass.verdict).toBe("PASS");
    expect(pass.agentTraces).toHaveLength(1);
    const [trace] = pass.agentTraces!;
    const upload = a.agentModel.traces![0]!;
    expect(trace).toMatchObject({ runId: a.resolved.binding.runId, stepIndex: 1, keyHash: upload.keyHash, binding: upload.binding });
    expect(Buffer.from(trace!.bytes).toString("base64")).toBe(upload.traceBase64);
    expect(trace!.binding.traceSha256).toBe(upload.binding.traceSha256);
    // Not PASS: no list at all.
    for (const name of ["decoy", "outage", "no-download"] as const) {
      const verdict = brokerRoundFor(await readBack(name)).verify();
      expect(verdict.verdict, name).not.toBe("PASS");
      expect(verdict.agentTraces, name).toBeUndefined();
    }
    // A PASS group whose operation did not end well is not a PASS round either.
    const failedOperation = brokerRoundFor(a, { terminalStatus: "FAILED" }).verify();
    expect(failedOperation.verdict).toBe("UNKNOWN");
    expect(failedOperation.agentTraces).toBeUndefined();
    // Edited, claimed for another step or key, or a binding that is not the review's: the recording is left out and the verdict stays PASS.
    const edit = (change: (traces: Json[]) => void) => brokerRoundFor(a, { editGroupRun: (groupRun) => change(uploadsOf(groupRun)) }).verify();
    const reencode = (traces: Json[], change: (file: { trace: TraceBody }) => void) => {
      const file = JSON.parse(Buffer.from(traces[0]!["traceBase64"] as string, "base64").toString("utf8")) as { trace: TraceBody };
      change(file);
      traces[0]!["traceBase64"] = Buffer.from(JSON.stringify(file)).toString("base64");
    };
    // An edit that also re-binds: the binding claims the edited trace's own digest, so only the broker's review of the file itself can refuse it.
    const rebound = (traces: Json[], change: (file: { trace: TraceBody }) => void) => {
      reencode(traces, (file) => {
        change(file);
        traces[0]!["binding"] = { ...(traces[0]!["binding"] as Json), traceSha256: createHash("sha256").update(canonicalJson(file.trace), "utf8").digest("hex") };
      });
    };
    const edits: Array<[string, (traces: Json[]) => void]> = [
      ["a target edited after upload", (traces) => reencode(traces, (file) => { file.trace.actions[0]!.target["name"] = "Download invoices"; })],
      ["an action added", (traces) => reencode(traces, (file) => { file.trace.actions.push({ ...file.trace.actions[0]! }); })],
      ["another step", (traces) => { traces[0]!["stepIndex"] = 2; }],
      ["another case directory", (traces) => { traces[0]!["caseDirectory"] = "0".repeat(16); }],
      ["another key hash", (traces) => { traces[0]!["keyHash"] = "0".repeat(64); }],
      ["a binding that is not the review's", (traces) => { traces[0]!["binding"] = { ...(traces[0]!["binding"] as Json), traceSha256: "0".repeat(64) }; }],
      ["a ledger digest that is not the verified ledger's", (traces) => { traces[0]!["binding"] = { ...(traces[0]!["binding"] as Json), ledgerSha256: "0".repeat(64) }; }],
      ["bytes that are not canonical base64", (traces) => { traces[0]!["traceBase64"] = `${traces[0]!["traceBase64"] as string}\n`; }],
      ["bytes over the ceiling", (traces) => { traces[0]!["traceBase64"] = Buffer.alloc(E2E_AGENT_TRACE_FILE_MAX_BYTES + 1, 0x20).toString("base64"); }],
      ["a duplicate", (traces) => { traces.push({ ...traces[0]! }); }],
      // The broker holds the file to the cleaned shape and to Q4 itself, whatever the host's review made of it.
      ["a selector on a target", (traces) => rebound(traces, (file) => { file.trace.actions[0]!.target["selector"] = "main > button"; })],
      ["a prose summary", (traces) => rebound(traces, (file) => { file.trace["summary"] = "The model said the export worked."; })],
      ["a query in the end path", (traces) => rebound(traces, (file) => { file.trace.endPath = "/orders?token=abc"; })],
      ["an anchor input value that is text the model chose", (traces) => rebound(traces, (file) => { file.trace.endAnchors![0]!["value"] = "typed by the model"; })],
      ["a field the cleaner does not produce", (traces) => rebound(traces, (file) => { file.trace["modelNotes"] = "x"; })],
    ];
    for (const [name, change] of edits) {
      const verdict = edit(change);
      expect(verdict.verdict, name).toBe("PASS");
      expect(verdict.agentTraces, name).toEqual([]);
    }
  });

  it("7b. a ledger the broker cannot verify, or evidence whose recording was cut off, leaves the verdict to the checks and the list empty", async () => {
    const a = await readBack("ok");
    // The recording alone is not enough: with another run's key the ledger does not verify, so the group is not a PASS at all (and so has no list).
    const wrongKey = brokerRoundFor(a, { editGroupRun: (groupRun) => { modelEvidenceOf(groupRun)["valueKey"] = "cd".repeat(32); } }).verify();
    expect(wrongKey.verdict).toBe("UNKNOWN");
    expect(wrongKey.agentTraces).toBeUndefined();
    // The schema bound: four recordings are not accepted.
    const four = brokerRoundFor(a, { editGroupRun: (groupRun) => { const traces = uploadsOf(groupRun); for (let i = 0; i < 3; i += 1) traces.push({ ...traces[0] }); } }).verify();
    expect(four.verdict).toBe("UNKNOWN");
    expect(four.agentTraces).toBeUndefined();
  });

  it("8. stored data: a group without `traces` verifies exactly as before (PASS, nothing handed on), and a round with no AI navigation step is unchanged", async () => {
    const a = await readBack("ok");
    const withTraces = brokerRoundFor(a).verify();
    const stripped = brokerRoundFor(a, { editGroupRun: (groupRun) => { delete modelEvidenceOf(groupRun)["traces"]; } }).verify();
    expect(stripped.verdict).toBe("PASS");
    expect(stripped.agentTraces).toEqual([]);
    expect({ ...stripped, agentTraces: undefined }).toEqual({ ...withTraces, agentTraces: undefined });
    // The evidence the code before Task 4.4a stored (no agentModel at all): the same verdicts, and a PASS round has an empty list.
    const fixture = (name: "passing" | "failing"): ApplicationEvidenceInput => {
      const stored = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures", `application-evidence-before-task-4-4a-${name}.json`), "utf8")) as { admissionText: string; subject: ApplicationEvidenceInput["subject"];
        aggregate: unknown; groupEvidence: Record<string, unknown>; receivedAt: Record<string, string> };
      return { admissionBytes: Buffer.from(stored.admissionText, "utf8"), subject: stored.subject, aggregate: stored.aggregate, groupEvidence: new Map(Object.entries(stored.groupEvidence)),
        receivedAt: new Map(Object.entries(stored.receivedAt)), terminalStatus: "SUCCEEDED" };
    };
    const passing = verifyApplicationE2EEvidence(fixture("passing"));
    expect(passing.verdict).toBe("PASS");
    expect(passing.agentTraces).toEqual([]);
    const failing = verifyApplicationE2EEvidence(fixture("failing"));
    expect(failing.verdict).toBe("FAILED");
    expect(failing.agentTraces).toBeUndefined();
  });
});
