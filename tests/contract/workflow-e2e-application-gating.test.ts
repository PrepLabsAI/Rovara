import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { combineE2EVerdicts, type E2EVerdict } from "../../packages/broker/src/e2e/verdict.js";
import { verifyApplicationE2EEvidence, type ApplicationEvidenceInput } from "../../packages/broker/src/e2e/application-evidence.js";
import { encodeE2EApplicationExecutionAdmission } from "../../packages/verifier/src/application-scenarios.js";
import { aggregateEvidenceEnvelope, createApplicationEvidenceFixture, groupEvidenceEnvelope, type ApplicationEvidenceFixture,
  type ObservedApiOutcome } from "../support/e2e-application-evidence-fixture.js";
import type { E2EApplicationReport } from "../../packages/verifier/src/application-report-schema.js";

// The broker's side of an application round: it never reads the worker's verdict, but recompiles, recollects and requalifies from the uploaded
// raw evidence. Every group here is genuinely collected by the real collector from a real probe admission.

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const PASSING = { probe: "api-egress-denial-v1", observed: { kind: "http-status", status: 200 } } as const;
const FAILING = { probe: "api-status-mismatch-v1", observed: { kind: "http-status", status: 200 } } as const;

type Round = Awaited<ReturnType<typeof roundOf>>;
async function roundOf(options: { probe: Parameters<typeof createApplicationEvidenceFixture>[0]["probe"]; observed: ObservedApiOutcome;
  reportEdit?: (report: E2EApplicationReport) => void }) {
  const fixture: ApplicationEvidenceFixture = await createApplicationEvidenceFixture(options);
  const admissionBytes = Buffer.from(encodeE2EApplicationExecutionAdmission(fixture.admission), "utf8");
  const admissionSha256 = sha(admissionBytes);
  const admission = fixture.admission;
  const subject = { taskId: admission.taskId, operationId: admission.operationId, operationFence: admission.operationFence, workflowRevision: admission.workflowRevision,
    candidateDigest: admission.candidateDigest, roundId: admission.round.roundId, groupRunIds: admission.groups.map((group) => group.outerBinding.runId), admissionSha256 };
  const groupRun = fixture.groupRun;
  const input = (overrides: Partial<ApplicationEvidenceInput> = {}): ApplicationEvidenceInput => ({ admissionBytes, subject,
    aggregate: aggregateEvidenceEnvelope({ admission, admissionSha256, groupRuns: [groupRun] }),
    groupEvidence: new Map([[fixture.runId, groupEvidenceEnvelope({ admission, admissionSha256, groupRun })]]),
    receivedNotAfter: new Date(Date.now() + 60_000).toISOString(), terminalStatus: "SUCCEEDED", ...overrides });
  return { fixture, admission, admissionBytes, admissionSha256, subject, groupRun, input };
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const withGroupRun = (round: Round, edit: (groupRun: Record<string, unknown>) => void, options: { aggregate?: boolean } = {}): ApplicationEvidenceInput => {
  const groupRun = clone(round.groupRun);
  edit(groupRun);
  return round.input({ groupEvidence: new Map([[round.fixture.runId, groupEvidenceEnvelope({ admission: round.admission, admissionSha256: round.admissionSha256, groupRun })]]),
    aggregate: options.aggregate === false ? undefined : aggregateEvidenceEnvelope({ admission: round.admission, admissionSha256: round.admissionSha256, groupRuns: [groupRun] }) });
};
const actualOf = (groupRun: Record<string, unknown>) => groupRun.actual as { collection: { shards: Array<{ rawReport: { sha256: string; bytesBase64: string } }>; receivedAt: string } };

describe("verifying an application round's evidence", () => {
  it("passes a round whose every group the broker re-collects as passing, and promotes its own projection", async () => {
    const round = await roundOf(PASSING);
    const result = verifyApplicationE2EEvidence(round.input());
    expect(result).toMatchObject({ verdict: "PASS", groups: [{ runId: round.fixture.runId, verdict: "PASS" }] });
    expect(result.plan?.digest).toBe(round.admission.executionPlan.digest);
    expect(result.round).toEqual(round.admission.round);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ producer: "broker-independent-e2e-verifier", qualification: "trusted", status: "passed", cleanup: "confirmed" });
  });

  it("fails a round whose observed value differs from the approved assertion, and never reads the worker's claim", async () => {
    const round = await roundOf(FAILING);
    expect(round.groupRun).toMatchObject({ collection: { status: "FAILED" } });
    expect(verifyApplicationE2EEvidence(round.input({ terminalStatus: "FAILED" }))).toMatchObject({ verdict: "FAILED", groups: [{ verdict: "FAILED" }] });
    // Claiming PASS (or anything else) over genuine failing evidence changes nothing.
    for (const claim of ["PASS", "UNKNOWN"]) {
      const claimed = withGroupRun(round, (groupRun) => { groupRun.collection = { status: claim, reason: "claimed" }; groupRun.unavailableReason = null; });
      expect(verifyApplicationE2EEvidence({ ...claimed, terminalStatus: "FAILED" }).verdict).toBe("FAILED");
    }
    // And a worker that claims UNKNOWN or FAILED over genuinely passing evidence does not change a pass either.
    const passing = await roundOf(PASSING);
    for (const claim of ["FAILED", "UNKNOWN"]) {
      const claimed = withGroupRun(passing, (groupRun) => { groupRun.collection = { status: claim, reason: "claimed" }; });
      expect(verifyApplicationE2EEvidence(claimed).verdict).toBe("PASS");
    }
  });

  it("fails a state assertion whose poll timed out on a well-formed 2xx answer of another value (Ruling W), and passes the same probe once it is ready", async () => {
    const timedOut = await roundOf({ probe: "api-state-positive-v1", observed: { kind: "state", finalValue: { orders: "loading", version: 1 }, disposition: "timed-out" } });
    expect(timedOut.fixture.collected.qualification).toMatchObject({ status: "FAILED" });
    expect(verifyApplicationE2EEvidence(timedOut.input({ terminalStatus: "FAILED" }))).toMatchObject({ verdict: "FAILED" });
    const ready = await roundOf({ probe: "api-state-positive-v1", observed: { kind: "state", finalValue: { orders: "ready", version: 1 }, disposition: "ready" } });
    expect(verifyApplicationE2EEvidence(ready.input()).verdict).toBe("PASS");
  });

  it("never turns a required scenario that the runner skipped into a pass", async () => {
    const round = await roundOf({ ...PASSING, reportEdit: (report) => {
      const row = report.run.results[0]!;
      row.status = "skipped"; row.skip = { cause: "explicit", reason: "skipped by the candidate" };
      row.attempts = []; row.selected = false;
      report.run.status = "passed"; report.run.exitCode = 0;
      report.run.summary = { discovered: 1, selected: 0, executed: 0, passed: 0, failed: 0, interrupted: 0, flaky: 0, skipped: 1 };
    } });
    expect(round.fixture.collected.qualification?.status).toBe("UNKNOWN");
    const result = verifyApplicationE2EEvidence(round.input());
    expect(result.verdict).toBe("UNKNOWN");
    expect(result.groups[0]).toMatchObject({ verdict: "UNKNOWN" });
    expect(result.verdict).not.toBe("PASS");
  });

  it("is UNKNOWN, not PASS, when the worker's claimed pass rests on a report whose digest or bytes were tampered", async () => {
    const round = await roundOf(PASSING);
    expect(round.groupRun).toMatchObject({ collection: { status: "PASS" } });
    for (const [label, tamper] of [
      ["the report digest", (groupRun: Record<string, unknown>) => { actualOf(groupRun).collection.shards[0]!.rawReport.sha256 = "0".repeat(64); }],
      ["the report bytes", (groupRun: Record<string, unknown>) => {
        const report = actualOf(groupRun).collection.shards[0]!.rawReport;
        const text = Buffer.from(report.bytesBase64, "base64").toString("utf8").replace('"passed"', '"failed"');
        report.bytesBase64 = Buffer.from(text, "utf8").toString("base64");
      }],
    ] as const) {
      const tampered = withGroupRun(round, tamper);
      const result = verifyApplicationE2EEvidence(tampered);
      expect(result.verdict, label).toBe("UNKNOWN");
      expect(result.groups[0]?.verdict, label).toBe("UNKNOWN");
    }
  });

  it("makes group evidence uploaded without the round's aggregate non-authoritative: UNKNOWN at most, whatever its groups hold", async () => {
    for (const config of [PASSING, FAILING]) {
      const round = await roundOf(config);
      const result = verifyApplicationE2EEvidence(round.input({ aggregate: undefined, terminalStatus: undefined }));
      expect(result.verdict).toBe("UNKNOWN");
      expect(result.reason).toMatch(/aggregate/u);
      // The groups are still re-collected, for display.
      expect(result.groups).toHaveLength(1);
    }
  });

  it("is UNKNOWN when an aggregate holds a group that was never accepted on its own, or differs from the one that was", async () => {
    const round = await roundOf(PASSING);
    expect(verifyApplicationE2EEvidence(round.input({ groupEvidence: new Map() })).verdict).toBe("UNKNOWN");
    const different = clone(round.groupRun);
    (different.lifecycle as { cleanup: string }).cleanup = "failed";
    const aggregate = aggregateEvidenceEnvelope({ admission: round.admission, admissionSha256: round.admissionSha256, groupRuns: [different] });
    const result = verifyApplicationE2EEvidence(round.input({ aggregate }));
    expect(result.verdict).toBe("UNKNOWN");
    expect(result.reason).toMatch(/aggregate differs/u);
  });

  it("rejects evidence for an older candidate, another operation, round or admission", async () => {
    const round = await roundOf(PASSING);
    const older = "e".repeat(64);
    const notTheSignedOperation = /does not match the signed CHECKS operation/u;
    for (const subject of [{ ...round.subject, candidateDigest: older }, { ...round.subject, operationId: "00000000-0000-4000-8000-000000000099" },
      { ...round.subject, operationFence: round.subject.operationFence + 1 }, { ...round.subject, workflowRevision: round.subject.workflowRevision + 1 },
      { ...round.subject, taskId: "00000000-0000-4000-8000-000000000094" }, { ...round.subject, roundId: "00000000-0000-4000-8000-000000000098" },
      { ...round.subject, groupRunIds: ["00000000-0000-4000-8000-000000000097"] }]) {
      // With no aggregate and no group evidence the only thing that can refuse is the admission's own binding to the signed operation.
      const bare = verifyApplicationE2EEvidence(round.input({ subject, aggregate: undefined, groupEvidence: new Map() }));
      expect(bare.verdict).toBe("UNKNOWN");
      expect(bare.reason).toMatch(notTheSignedOperation);
      expect(verifyApplicationE2EEvidence(round.input({ subject })).verdict).toBe("UNKNOWN");
    }
    const wrongAddress = verifyApplicationE2EEvidence(round.input({ subject: { ...round.subject, admissionSha256: "f".repeat(64) } }));
    expect(wrongAddress.verdict).toBe("UNKNOWN");
    expect(wrongAddress.reason).toMatch(/content address/u);
    // The evidence itself names another candidate (an older round's upload): both the group envelope and the aggregate are refused.
    const olderGroup = { ...groupEvidenceEnvelope({ admission: round.admission, admissionSha256: round.admissionSha256, groupRun: round.groupRun }), candidateDigest: older };
    expect(verifyApplicationE2EEvidence(round.input({ groupEvidence: new Map([[round.fixture.runId, olderGroup]]) })).verdict).toBe("UNKNOWN");
    const olderAggregate = { ...aggregateEvidenceEnvelope({ admission: round.admission, admissionSha256: round.admissionSha256, groupRuns: [round.groupRun] }), candidateDigest: older };
    expect(verifyApplicationE2EEvidence(round.input({ aggregate: olderAggregate })).verdict).toBe("UNKNOWN");
  });

  it("rejects an admission whose bytes are not the stored, signed ones", async () => {
    const round = await roundOf(PASSING);
    expect(verifyApplicationE2EEvidence(round.input({ admissionBytes: Buffer.from(`${Buffer.from(round.admissionBytes).toString("utf8")} `) })).verdict).toBe("UNKNOWN");
    expect(verifyApplicationE2EEvidence(round.input({ admissionBytes: Buffer.from("not an admission") })).verdict).toBe("UNKNOWN");
  });

  it("is UNKNOWN for evidence of a group, run or round outside the admission", async () => {
    const round = await roundOf(PASSING);
    const foreign = new Map(round.input().groupEvidence);
    foreign.set("00000000-0000-4000-8000-000000000096", {});
    expect(verifyApplicationE2EEvidence(round.input({ groupEvidence: foreign })).verdict).toBe("UNKNOWN");
    const otherRun = withGroupRun(round, (groupRun) => { (groupRun.binding as { runId: string }).runId = "00000000-0000-4000-8000-000000000095"; });
    expect(verifyApplicationE2EEvidence(otherRun).verdict).toBe("UNKNOWN");
    const aggregate = aggregateEvidenceEnvelope({ admission: round.admission, admissionSha256: round.admissionSha256, groupRuns: [round.groupRun] });
    expect(verifyApplicationE2EEvidence(round.input({ aggregate: { ...aggregate, groupRuns: [round.groupRun] } })).verdict).toBe("UNKNOWN");
    expect(verifyApplicationE2EEvidence(round.input({ aggregate: { ...aggregate, payload: { kind: "portable", groupRuns: [round.groupRun] } } })).verdict).toBe("UNKNOWN");
    expect(verifyApplicationE2EEvidence(round.input({ aggregate: { ...aggregate, payload: { kind: "application", groupRuns: [round.groupRun, round.groupRun] } } })).verdict).toBe("UNKNOWN");
  });

  it("needs a successful terminal operation, a clean lifecycle and a receipt inside the round to pass", async () => {
    const round = await roundOf(PASSING);
    expect(verifyApplicationE2EEvidence(round.input({ terminalStatus: "FAILED" })).verdict).toBe("UNKNOWN");
    expect(verifyApplicationE2EEvidence(round.input({ terminalStatus: undefined })).verdict).toBe("UNKNOWN");
    for (const [label, edit] of [
      ["cleanup not confirmed", (groupRun: Record<string, unknown>) => { (groupRun.lifecycle as { cleanup: string }).cleanup = "pending"; }],
      ["a non-zero exit code", (groupRun: Record<string, unknown>) => { (groupRun.lifecycle as { process: { exitCode: number } }).process.exitCode = 1; }],
      ["a timed-out process", (groupRun: Record<string, unknown>) => { (groupRun.lifecycle as { process: { timedOut: boolean } }).process.timedOut = true; }],
      ["an aborted process", (groupRun: Record<string, unknown>) => { (groupRun.lifecycle as { process: { aborted: boolean } }).process.aborted = true; }],
      ["an unavailable reason beside a readback", (groupRun: Record<string, unknown>) => { groupRun.unavailableReason = "deadline-exceeded"; }],
    ] as const) {
      const result = verifyApplicationE2EEvidence(withGroupRun(round, edit));
      expect(result.verdict, label).toBe("UNKNOWN");
      expect(result.results[0]?.status, label).toBe("unavailable");
    }
    // Received after the broker's own receipt, or before the round was admitted: not this round's evidence.
    const collectedAt = Date.parse(actualOf(round.groupRun).collection.receivedAt);
    expect(verifyApplicationE2EEvidence(round.input({ receivedNotAfter: new Date(collectedAt - 1).toISOString() })).verdict).toBe("UNKNOWN");
    expect(verifyApplicationE2EEvidence(round.input({ receivedNotAfter: new Date(collectedAt).toISOString() })).verdict).toBe("PASS");
  });

  it("is UNKNOWN for a group with no readback, whatever the worker reports it as", async () => {
    const round = await roundOf(PASSING);
    for (const reason of ["deadline-exceeded", "application build failed"]) {
      const unavailable = withGroupRun(round, (groupRun) => {
        groupRun.actual = null; groupRun.unavailableReason = reason; groupRun.collection = { status: "PASS", reason: "claimed" };
      });
      const result = verifyApplicationE2EEvidence(unavailable);
      expect(result).toMatchObject({ verdict: "UNKNOWN", groups: [{ verdict: "UNKNOWN", reason }] });
      expect(JSON.stringify(result)).not.toContain('"PASS"');
    }
    const noReason = withGroupRun(round, (groupRun) => { groupRun.actual = null; groupRun.unavailableReason = null; });
    expect(verifyApplicationE2EEvidence(noReason).verdict).toBe("UNKNOWN");
  });

  it("derives the owned-resource inventory from the run id, never from the worker", async () => {
    const round = await roundOf(PASSING);
    const edited = withGroupRun(round, (groupRun) => {
      (groupRun.actual as { collectionInputs: { ownedResourceInventoryDigest: string } }).collectionInputs.ownedResourceInventoryDigest = "a".repeat(64);
    });
    const result = verifyApplicationE2EEvidence(edited);
    expect(result.verdict).toBe("UNKNOWN");
    expect(result.groups[0]?.reason).toMatch(/inventory/u);
  });
});

describe("combining the verdicts of the parts of a round (Ruling BA)", () => {
  const cases: Array<[E2EVerdict[], E2EVerdict]> = [
    [["PASS", "PASS"], "PASS"], [["PASS"], "PASS"], [["PASS", "UNKNOWN"], "UNKNOWN"], [["UNKNOWN", "UNKNOWN"], "UNKNOWN"],
    [["FAILED", "PASS"], "FAILED"], [["PASS", "FAILED"], "FAILED"], [["FAILED", "UNKNOWN"], "FAILED"], [["UNKNOWN", "FAILED", "PASS"], "FAILED"], [[], "UNKNOWN"],
  ];
  it.each(cases)("%j is %s", (verdicts, expected) => { expect(combineE2EVerdicts(verdicts)).toBe(expected); });
});
