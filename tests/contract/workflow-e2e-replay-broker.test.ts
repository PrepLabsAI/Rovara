import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, type E2EReplaySourceCase, type E2EReplayTrace } from "@agentx/contracts";
import { agentRunnable, downloadsOf, runAgentCase, type AgentRun } from "../support/agent-executor-run.js";
import { recordingsOf, runReplayCase, type ReplayRun } from "../support/agent-replay-run.js";
import { asLinuxRun, assembleAgentRun, assembleReplayRun, brokerRoundFor, type AssembledRun } from "../support/agent-collection.js";
import { FIXED_RUNTIME_AT, type OrdersM14Variant } from "../support/orders-m14-agent.js";
import { verifyApplicationE2EEvidence } from "../../packages/broker/src/e2e/application-evidence.js";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { readWorkflowE2EReplayRecord, recordWorkflowE2EReplay, replayResultOf, replaySourceCasesOf, replayStartItem, requestWorkflowE2EReplay, verifyReplayEvidence } from "../../packages/broker/src/aws/workflow-e2e-replay.js";

// M1.4 Task 4.6b: the broker's own verification of a replay. The real executor and Chromium replay the recording a verified round left; the broker re-collects the replay from its raw
// evidence, and records `{ status, reproduced, downloadSha256Match, reason? }` from that and from what the verified round showed, which the replay admission signs.
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const plan = { runtimeAt: FIXED_RUNTIME_AT };

describe.runIf(agentRunnable)("the broker verifies an audit replay (Task 4.6b)", () => {
  const cleanups: Array<AgentRun | ReplayRun> = [];
  let source: AgentRun; let traces: E2EReplayTrace[]; let sourceCases: E2EReplaySourceCase[]; let sourceBytesSha: string;
  const replays = {} as Record<"whole" | "stale" | "hidden" | "lf" | "changed", ReplayRun>;
  const start = async (name: keyof typeof replays, options: Partial<Parameters<typeof runReplayCase>[0]> = {}, recordings: E2EReplayTrace[] = traces) => {
    const run = await runReplayCase({ traces: recordings, plan, sourceCases, ...options }); cleanups.push(run); replays[name] = run;
  };
  beforeAll(async () => {
    source = await runAgentCase({ script: [{ kind: "tap", name: /Download orders/ }, { kind: "done" }], plan });
    cleanups.push(source);
    traces = await recordingsOf(source);
    sourceBytesSha = sha(readFileSync(join(source.out, "downloads", downloadsOf(source.out)[0]!)));
    const verified = brokerRoundFor(asLinuxRun(await assembleAgentRun(source))).verify();
    sourceCases = replaySourceCasesOf(verified);
    await start("whole");
    await start("stale", { renamed: true });
    const file = JSON.parse(Buffer.from(traces[0]!.traceBase64, "base64").toString("utf8")) as { trace: { actions: unknown[] } };
    file.trace.actions = [{ name: "type", summary: "The type action.", target: { role: "textbox", name: "Search" }, value: `hmac-sha256:${sha("a value the model chose")}` }];
    await start("hidden", {}, [{ ...traces[0]!, traceBase64: Buffer.from(JSON.stringify(file)).toString("base64"), binding: { ...traces[0]!.binding, traceSha256: sha(canonicalJson(file.trace)) } }]);
    await start("lf", { variant: "lf-csv" as OrdersM14Variant });
    await start("changed", { variant: "changed-csv" as OrdersM14Variant });
  }, 900_000);
  afterAll(async () => { await Promise.all(cleanups.splice(0).map((run) => run.cleanup())); });

  const roundOf = async (run: ReplayRun, edit?: (a: AssembledRun) => AssembledRun) => {
    const assembled = asLinuxRun(await assembleReplayRun(run));
    return brokerRoundFor(edit === undefined ? assembled : edit(assembled), { modelRouteDefinition: undefined });
  };
  const replayOf = async (run: ReplayRun, edit?: (a: AssembledRun) => AssembledRun) => {
    const round = await roundOf(run, edit);
    const { purpose: _purpose, ...input } = round.input as typeof round.input & { purpose?: string };
    void _purpose;
    return { round, verified: verifyReplayEvidence({ ...input, replay: { sourceCases } }) };
  };

  it("test 19: a source round whose stored evidence was edited is not verified, keeps no recording, and so gives the replay nothing to serve", async () => {
    const assembled = asLinuxRun(await assembleAgentRun(source));
    // Control: the unedited round is PASS and keeps its recording.
    const control = brokerRoundFor(assembled).verify();
    expect(control.verdict).toBe("PASS");
    expect(control.agentTraces).toHaveLength(1);
    // The stored ledger edited after the fact (one receipt of the model dropped from the inputs the worker packed): the broker's own re-collection no longer matches what was stored.
    const edited = brokerRoundFor(assembled, { editGroupRun: (groupRun) => {
      const actual = groupRun["actual"] as { collectionInputs: { agentModel?: { receipts: unknown[] } } };
      actual.collectionInputs.agentModel!.receipts = actual.collectionInputs.agentModel!.receipts.slice(1);
    } }).verify();
    expect(edited.verdict).not.toBe("PASS");
    expect(edited.agentTraces ?? []).toHaveLength(0);
    expect(replaySourceCasesOf(edited)).toEqual([]);
  });

  it("the verified source round: PASS, with the recording the replay will serve and the facts the replay is judged against", async () => {
    const verified = brokerRoundFor(asLinuxRun(await assembleAgentRun(source))).verify();
    expect(verified.verdict).toBe("PASS");
    expect(verified.agentTraces).toHaveLength(1);
    expect(sourceCases).toEqual([{ caseId: source.caseId, assertionOutcomes: ["passed"], csvSha256: sourceBytesSha }]);
  });

  it("test 9: a replay that ran whole reproduces: PASS, the CSV bytes match, and no reason is given", async () => {
    const { verified } = await replayOf(replays.whole);
    expect(verified?.replay).toEqual({ status: "PASS", reproduced: true, downloadSha256Match: true });
  });

  it("test 12: a stale replay is UNKNOWN replay-needs-model, not reproduced, and no download matched", async () => {
    const { verified } = await replayOf(replays.stale);
    expect(verified?.replay).toEqual({ status: "UNKNOWN", reproduced: false, downloadSha256Match: false, reason: "replay-needs-model" });
  });

  it("test 13: a recording that holds a value the model chose is UNKNOWN typed-value-not-replayable", async () => {
    const { verified } = await replayOf(replays.hidden);
    expect(verified?.replay).toEqual({ status: "UNKNOWN", reproduced: false, downloadSha256Match: false, reason: "typed-value-not-replayable" });
  });

  it("test 15: a replay whose report shows a model call is UNKNOWN replay-model-called, never reproduced", async () => {
    const { verified } = await replayOf(replays.whole, (a) => {
      const shards = a.actual.shards.map((shard) => {
        const report = JSON.parse(Buffer.from(shard.rawReportBytes).toString("utf8")) as { run: { usage: Record<string, number> } };
        report.run.usage["modelTokens"] = 3;
        const bytes = Buffer.from(JSON.stringify(report));
        return { ...shard, rawReportBytes: bytes, runProcess: { ...shard.runProcess, stdoutSha256: sha(bytes), stdoutBytes: bytes.byteLength } };
      });
      // The host's readback reports the tokens its raw report shows, as it would for a run that really made the call.
      return { ...a, actual: { ...a.actual, shards }, inputs: { ...a.inputs, usage: { ...a.inputs.usage, modelTokens: 3 } } };
    });
    expect(verified?.replay).toEqual({ status: "UNKNOWN", reproduced: false, downloadSha256Match: false, reason: "replay-model-called" });
  });

  it("a replay whose CSV holds the same rows in other bytes still passes its assertion but is not reproduced: the download differs", async () => {
    const { verified } = await replayOf(replays.lf);
    expect(verified?.replay).toEqual({ status: "PASS", reproduced: false, downloadSha256Match: false, reason: "replay-download-differs" });
  });

  it("a replay whose export changed so that the approved assertion fails is FAILED, not reproduced: the outcome differs from the source round's", async () => {
    const { verified } = await replayOf(replays.changed);
    expect(verified?.replay).toMatchObject({ status: "FAILED", reproduced: false, downloadSha256Match: false, reason: "replay-outcome-differs" });
  });

  it("is read only as the kind it was signed as: a replay is not a candidate round, a candidate round is not a replay", async () => {
    const replayRound = await roundOf(replays.whole);
    const asCandidate = verifyApplicationE2EEvidence({ ...replayRound.input, purpose: "candidate" });
    expect(asCandidate.verdict).toBe("UNKNOWN");
    expect(asCandidate.reason).toMatch(/audit replay/);
    const candidateRound = brokerRoundFor(asLinuxRun(await assembleAgentRun(source)));
    const asReplay = verifyApplicationE2EEvidence({ ...candidateRound.input, purpose: "replay" });
    expect(asReplay.verdict).toBe("UNKNOWN");
    expect(asReplay.reason).toMatch(/not a replay|purpose differs/);
    // Control: the same inputs read as what they were signed as are verified.
    expect(verifyApplicationE2EEvidence({ ...replayRound.input, purpose: "replay" }).verdict).toBe("PASS");
    expect(candidateRound.verify().verdict).toBe("PASS");
  });

  it("records the verified result only for the round that was started, conditionally: a record that moved on is left as it is, and the result is the verification's own", async () => {
    const { round, verified } = await replayOf(replays.whole);
    expect(verified).toBeDefined();
    const task = { taskId: "11111111-1111-4111-8111-111111111111" } as never;
    const source = "33333333-3333-4333-8333-333333333333";
    const admissionSha256 = round.input.subject.admissionSha256;
    const startedStore = async (overrides: Record<string, unknown> = {}) => {
      const db = new FakeDynamoDb(); const s = { db, documentClient: db as never, tableName: "state" };
      await requestWorkflowE2EReplay(s, task, { sourceRoundId: source, attempt: 1 });
      await db.send(new TransactWriteCommand({ TransactItems: [replayStartItem(s, task, { sourceRoundId: source, attempt: 1, operationId: round.input.subject.operationId, roundId: round.input.subject.roundId,
        admissionSha256, startedAt: "2026-10-22T10:00:00.000Z", deadlineAt: "2026-10-22T10:25:00.000Z", ...overrides })] }));
      return s;
    };
    const expected = { sourceRoundId: source, attempt: 1, operationId: round.input.subject.operationId, roundId: round.input.subject.roundId, admissionSha256 };
    const s = await startedStore();
    expect(await recordWorkflowE2EReplay(s, task, { verified: verified!, expected })).toBe(true);
    expect(await readWorkflowE2EReplayRecord(s, "11111111-1111-4111-8111-111111111111", { sourceRoundId: source, attempt: 1 })).toMatchObject({ state: "RECORDED",
      replay: { status: "PASS", reproduced: true, downloadSha256Match: true } });
    // A record that is no longer this round's is not written over: another operation, another admission.
    for (const edit of [{ operationId: "another-operation" }, { admissionSha256: "9".repeat(64) }]) {
      const moved = await startedStore(edit);
      expect(await recordWorkflowE2EReplay(moved, task, { verified: verified!, expected })).toBe(false);
      expect((await readWorkflowE2EReplayRecord(moved, "11111111-1111-4111-8111-111111111111", { sourceRoundId: source, attempt: 1 }))?.state).toBe("STARTED");
    }
    // A verification of another round is refused outright.
    await expect(recordWorkflowE2EReplay(s, task, { verified: verified!, expected: { ...expected, roundId: "another-round" } })).rejects.toThrow(/not of the round/);
  });

  it("verifies nothing for an admission it did not store: bytes that are not the content address give no result", async () => {
    const { round } = await replayOf(replays.whole);
    const { purpose: _purpose, ...input } = round.input as typeof round.input & { purpose?: string };
    void _purpose;
    const corrupted = verifyReplayEvidence({ ...input, admissionBytes: Buffer.from("{}"), replay: { sourceCases } });
    expect(corrupted).toBeUndefined();
  });

  it("the result of a verification is a function of that verification and the signed source cases: other source facts give other results", async () => {
    const round = await roundOf(replays.whole);
    const verification = verifyApplicationE2EEvidence({ ...round.input, purpose: "replay" });
    expect(replayResultOf(verification, sourceCases)).toEqual({ status: "PASS", reproduced: true, downloadSha256Match: true });
    expect(replayResultOf(verification, [{ ...sourceCases[0]!, csvSha256: sha("another file") }])).toMatchObject({ reproduced: false, downloadSha256Match: false, reason: "replay-download-differs" });
    expect(replayResultOf(verification, [{ ...sourceCases[0]!, assertionOutcomes: ["failed"] }])).toMatchObject({ reproduced: false, reason: "replay-outcome-differs" });
    expect(replayResultOf(verification, [{ ...sourceCases[0]!, caseId: "another-case" }])).toMatchObject({ reproduced: false });
    // A replay that is not PASS is never reproduced, whatever its cases look like.
    expect(replayResultOf({ ...verification, verdict: "UNKNOWN" }, sourceCases)).toMatchObject({ status: "UNKNOWN", reproduced: false, reason: "replay-unverified" });
    // No CSV in the source: nothing was compared, so the download is not a match, but the rest can still reproduce.
    expect(replayResultOf(verification, [{ ...sourceCases[0]!, csvSha256: null }])).toEqual({ status: "PASS", reproduced: true, downloadSha256Match: false });
  });
});
