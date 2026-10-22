import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { combineE2EVerdicts, type E2EVerdict } from "../../packages/broker/src/e2e/verdict.js";
import { applicationEvidenceLimits, expectedApplicationAssertionAssets, verifyApplicationE2EEvidence, type ApplicationEvidenceInput } from "../../packages/broker/src/e2e/application-evidence.js";
import { encodeE2EApplicationExecutionAdmission } from "../../packages/verifier/src/application-scenarios.js";
import { aggregateEvidenceEnvelope, createApplicationEvidenceFixture, groupEvidenceEnvelope, type ApplicationEvidenceFixture } from "../support/e2e-application-evidence-fixture.js";
import { canonicalJson } from "@agentx/contracts";
import { applicationIntentWithAccountRefs, applicationRoundIntent } from "../../packages/broker/src/e2e/application-plan-approval.js";
import { planFixture, webApiRow } from "../support/e2e-application-plan-fixtures.js";
import { shaCanonicalOf } from "../support/e2e-account-registry-fixtures.js";
import { disposeRealCandidates } from "../support/e2e-application-candidate.js";
import { builtWebAndApiAdmission } from "../support/e2e-web-and-api-admission.js";
import { collectApplicationGroupEvidence, type ObservedApiOutcome } from "../support/e2e-application-evidence-fixture.js";
import { e2eApplicationStateProbeManifestDigest, installedE2EApplicationStateProbeAsset } from "../../packages/verifier/src/application-state-probes.js";
import { createPortableApplicationChildFixture } from "../support/e2e-application-fixture.js";
import { e2eApplicationPrivateTransferMaxBytes } from "@agentx/verifier";

// The broker's side of an application round: it never reads the worker's verdict, but recompiles, recollects and requalifies from the uploaded
// raw evidence. Every group here is genuinely collected by the real collector from a real probe admission.

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const PASSING = { probe: "api-status-mismatch-v1", observed: { kind: "http-status", status: 503 } } as const;
const FAILING = { probe: "api-status-mismatch-v1", observed: { kind: "http-status", status: 200 } } as const;

type Round = Awaited<ReturnType<typeof roundOf>>;
async function roundOf(options: Parameters<typeof createApplicationEvidenceFixture>[0]) {
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
    receivedAt: new Map([[fixture.runId, actualOf(groupRun).collection.receivedAt]]), terminalStatus: "SUCCEEDED", ...overrides });
  return { fixture, admission, admissionBytes, admissionSha256, subject, groupRun, input };
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const withGroupRun = (round: Round, edit: (groupRun: Record<string, unknown>) => void, options: { aggregate?: boolean; receivedAt?: ReadonlyMap<string, string> } = {}): ApplicationEvidenceInput => {
  const groupRun = clone(round.groupRun);
  edit(groupRun);
  return round.input({ groupEvidence: new Map([[round.fixture.runId, groupEvidenceEnvelope({ admission: round.admission, admissionSha256: round.admissionSha256, groupRun })]]),
    aggregate: options.aggregate === false ? undefined : aggregateEvidenceEnvelope({ admission: round.admission, admissionSha256: round.admissionSha256, groupRuns: [groupRun] }),
    ...(options.receivedAt === undefined ? { receivedAt: new Map([[round.fixture.runId, actualOf(round.groupRun).collection.receivedAt]]) } : { receivedAt: options.receivedAt }) });
};
function actualOf(groupRun: Record<string, unknown>) { return groupRun.actual as { collection: { shards: Array<{ rawReport: { sha256: string; bytesBase64: string } }>; receivedAt: string }; collectionInputs: Record<string, unknown> }; }

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

  it("shows no group's result as passed or failed while the round is not complete: without the aggregate, or when the operation did not end successfully", async () => {
    for (const config of [PASSING, FAILING]) {
      const passing = config === PASSING;
      const round = await roundOf(config);
      expect(verifyApplicationE2EEvidence(round.input()).results[0]?.status).toBe(passing ? "passed" : "failed");
      // A failing group's FAILED stands once the aggregate is there, whatever became of the operation; what is shown stays unavailable until the round is complete.
      const incomplete: Array<[ApplicationEvidenceInput, E2EVerdict]> = [
        [round.input({ aggregate: undefined, terminalStatus: undefined }), "UNKNOWN"],
        [round.input({ terminalStatus: undefined }), passing ? "UNKNOWN" : "FAILED"],
        [round.input({ terminalStatus: "FAILED" }), passing ? "UNKNOWN" : "FAILED"],
      ];
      for (const [input, verdict] of incomplete) {
        const result = verifyApplicationE2EEvidence(input);
        expect(result.verdict).toBe(verdict);
        expect(result.results).toHaveLength(1);
        expect(result.results[0]).toMatchObject({ status: "unavailable", reason: "application-round-not-complete" });
      }
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

  it("refuses a group result whose group is not the admitted plan's group, even when the aggregate agrees with it", async () => {
    const round = await roundOf(PASSING);
    const result = verifyApplicationE2EEvidence(withGroupRun(round, (groupRun) => { groupRun.group = { ...(groupRun.group as Record<string, unknown>), mode: "hybrid" }; }));
    expect(result.verdict).toBe("UNKNOWN");
    expect(result.reason).toMatch(/not the admitted application group run/u);
  });

  it("refuses an admission that carries a portable projection and portable child groups, which Ruling BA verifies from their own admission", async () => {
    const portable = createPortableApplicationChildFixture();
    expect(portable.admission.portableProjection).not.toBeNull();
    const admissionBytes = Buffer.from(encodeE2EApplicationExecutionAdmission(portable.admission), "utf8");
    const admission = portable.admission;
    const subject = { taskId: admission.taskId, operationId: admission.operationId, operationFence: admission.operationFence, workflowRevision: admission.workflowRevision,
      candidateDigest: admission.candidateDigest, roundId: admission.round.roundId, groupRunIds: admission.groups.map((group) => group.outerBinding.runId), admissionSha256: sha(admissionBytes) };
    const result = verifyApplicationE2EEvidence({ admissionBytes, subject, aggregate: undefined, groupEvidence: new Map(), receivedAt: new Map(), terminalStatus: "SUCCEEDED" });
    expect(result.verdict).toBe("UNKNOWN");
    expect(result.reason).toMatch(/not application groups/u);
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

describe("the oracle's expectations are the broker's, never the worker's (Ruling BH)", () => {
  const envOf = (round: Round) => (round.fixture.compiled.runtimeBindings.get(round.fixture.compiled.group.runtimeProfileId)!).runnerEnvironment as Record<string, unknown>;
  const reasonOfGroup = (result: ReturnType<typeof verifyApplicationE2EEvidence>) => result.groups[0]?.reason ?? result.reason;
  const inputsOf = (groupRun: Record<string, unknown>) => actualOf(groupRun).collectionInputs;

  it("is UNKNOWN when the runner honestly reports another environment than the admitted runtime's, even if report and readback agree with each other", async () => {
    const baseline = await roundOf(PASSING);
    const other = await roundOf({ ...PASSING, environment: { ...envOf(baseline), os: "linux 9.9.9" } });
    expect(other.fixture.collected.qualification?.status, "the worker's own collection accepts its self-consistent environment").toBe("PASS");
    const result = verifyApplicationE2EEvidence(other.input());
    expect(result.verdict).toBe("UNKNOWN");
    expect(reasonOfGroup(result)).toMatch(/not the admitted runtime's environment/u);
  });

  it("is UNKNOWN when the runner honestly reports other limits than the configured ones", async () => {
    const other = await roundOf({ ...PASSING, limits: { maxAgentContextBytes: 1, maxLedgerBytes: 1, maxObservationBytes: 1, maxEventsPerStep: 1, maxModelTokensPerCall: 1 } });
    expect(other.fixture.collected.qualification?.status).toBe("PASS");
    const result = verifyApplicationE2EEvidence(other.input());
    expect(result.verdict).toBe("UNKNOWN");
    expect(reasonOfGroup(result)).toMatch(/limits/u);
  });

  it("takes usage from the raw reports, and refuses a readback whose usage says otherwise", async () => {
    const round = await roundOf(PASSING);
    const result = verifyApplicationE2EEvidence(withGroupRun(round, (groupRun) => { (inputsOf(groupRun).usage as Record<string, number>).modelTokens = 5; }));
    expect(result.verdict).toBe("UNKNOWN");
    expect(reasonOfGroup(result)).toMatch(/usage/u);
  });

  it("refuses model receipts for a run that never had a model route", async () => {
    const round = await roundOf(PASSING);
    const result = verifyApplicationE2EEvidence(withGroupRun(round, (groupRun) => { inputsOf(groupRun).governedModelReceipts = [{ caseId: "x", declaredStepIndex: 0, requestId: "r", receiptId: "m" }]; }));
    expect(result.verdict).toBe("UNKNOWN");
    expect(reasonOfGroup(result)).toMatch(/model receipt/u);
  });

  it("derives the supervisor receipts it expects from the run id and the close time", async () => {
    const round = await roundOf(PASSING);
    const swapped = verifyApplicationE2EEvidence(withGroupRun(round, (groupRun) => { inputsOf(groupRun).expectedSupervisorReceiptRefs = []; }));
    expect(swapped.verdict).toBe("UNKNOWN");
    expect(reasonOfGroup(swapped)).toMatch(/supervisor receipt/u);
    // A close time that is not the one the cleanup receipt was attested at derives other receipts.
    const moved = verifyApplicationE2EEvidence(withGroupRun(round, (groupRun) => {
      inputsOf(groupRun).ownedClosedAt = new Date(Date.parse(String(inputsOf(groupRun).ownedClosedAt)) + 1).toISOString();
    }));
    expect(moved.verdict).toBe("UNKNOWN");
    expect(reasonOfGroup(moved)).toMatch(/supervisor receipt/u);
  });

  it("bounds the close time by the round and by the broker's receipt", async () => {
    const round = await roundOf(PASSING);
    const closedAt = Date.parse(String(inputsOf(round.groupRun).ownedClosedAt));
    const beforeClose = verifyApplicationE2EEvidence(round.input({ receivedAt: new Map([[round.fixture.runId, new Date(closedAt - 1).toISOString()]]) }));
    expect(beforeClose.verdict).toBe("UNKNOWN");
    expect(reasonOfGroup(beforeClose)).toMatch(/close time is not between/u);
    // A receipt before the round was even admitted is refused for that reason, not only because it precedes the close.
    const beforeAdmission = verifyApplicationE2EEvidence(round.input({ receivedAt: new Map([[round.fixture.runId, new Date(Date.parse(round.admission.round.admittedAt) - 1).toISOString()]]) }));
    expect(beforeAdmission.verdict).toBe("UNKNOWN");
    expect(reasonOfGroup(beforeAdmission)).toMatch(/not received between the round's admission and/u);
    // A close time the worker claims after the broker's receipt (or before the admission) cannot be real.
    const afterReceipt = verifyApplicationE2EEvidence(withGroupRun(round, (groupRun) => { inputsOf(groupRun).ownedClosedAt = new Date(Date.parse(actualOf(round.groupRun).collection.receivedAt) + 1_000).toISOString(); }));
    expect(afterReceipt.verdict).toBe("UNKNOWN");
  });

  it("refuses observation bindings and assertion assets that are not the admitted ones", async () => {
    const round = await roundOf(PASSING);
    const account = verifyApplicationE2EEvidence(withGroupRun(round, (groupRun) => {
      ((inputsOf(groupRun).observationBindings as Array<{ accountRef: { revision: number } }>)[0]!).accountRef.revision = 99;
    }));
    expect(account.verdict).toBe("UNKNOWN");
    expect(reasonOfGroup(account)).toMatch(/observation binding/u);
    const state = await roundOf({ probe: "api-state-positive-v1", observed: { kind: "state", finalValue: { orders: "ready", version: 1 }, disposition: "ready" } });
    expect(verifyApplicationE2EEvidence(state.input()).verdict).toBe("PASS");
    const assets = verifyApplicationE2EEvidence(withGroupRun(state, (groupRun) => { inputsOf(groupRun).assertionAssets = []; }));
    expect(assets.verdict).toBe("UNKNOWN");
    expect(reasonOfGroup(assets)).toMatch(/assertion assets/u);
  });

  it("uses the broker's own receipt time and ignores the one the worker wrote into its collection", async () => {
    const round = await roundOf(PASSING);
    const closedAt = Date.parse(String(inputsOf(round.groupRun).ownedClosedAt));
    const inWindow = new Map([[round.fixture.runId, new Date(closedAt + 1_000).toISOString()]]);
    const outsideWindow = new Map([[round.fixture.runId, new Date(closedAt + 60_000).toISOString()]]);
    // Whatever the worker claims, a receipt inside the post-close window passes ...
    for (const claimed of [new Date(closedAt + 90_000).toISOString(), new Date(closedAt - 90_000).toISOString(), "not a time"]) {
      expect(verifyApplicationE2EEvidence(withGroupRun(round, (groupRun) => { actualOf(groupRun).collection.receivedAt = claimed; }, { receivedAt: inWindow })).verdict, claimed).toBe("PASS");
    }
    // ... and a broker receipt outside it fails even though the worker's own claim fits.
    const late = verifyApplicationE2EEvidence(round.input({ receivedAt: outsideWindow }));
    expect(late.verdict).toBe("UNKNOWN");
    expect(reasonOfGroup(late)).toMatch(/post-close/u);
    // No receipt time from the broker means no verdict at all.
    const missing = verifyApplicationE2EEvidence(round.input({ receivedAt: new Map() }));
    expect(missing.verdict).toBe("UNKNOWN");
    expect(reasonOfGroup(missing)).toMatch(/receipt time/u);
  });

  it("bounds what the worker's unavailable reason can put in front of the owner", async () => {
    const round = await roundOf(PASSING);
    const result = verifyApplicationE2EEvidence(withGroupRun(round, (groupRun) => { groupRun.actual = null; groupRun.unavailableReason = "x".repeat(5_000); }));
    expect(result.verdict).toBe("UNKNOWN");
    expect(result.groups[0]!.reason.length).toBeLessThanOrEqual(300);
    expect(result.groups[0]!.reason).toMatch(/^x+$/u);
  });
});

describe("the approved assertion assets are the installed ones, byte for byte (Ruling BH)", () => {
  const stateRound = (extra: Partial<Parameters<typeof createApplicationEvidenceFixture>[0]> = {}) => roundOf({ probe: "api-state-positive-v1",
    observed: { kind: "state", finalValue: { orders: "ready", version: 1 }, disposition: "ready" }, ...extra });
  const reasonOfGroup = (result: ReturnType<typeof verifyApplicationE2EEvidence>) => result.groups[0]?.reason ?? result.reason;

  it("passes the installed probe asset with its real manifest digest", async () => {
    expect(verifyApplicationE2EEvidence((await stateRound()).input()).verdict).toBe("PASS");
  });

  it("is UNKNOWN when the manifest digest is not the installed asset's, whatever the worker made it", async () => {
    const round = await stateRound();
    const result = verifyApplicationE2EEvidence(withGroupRun(round, (groupRun) => {
      ((actualOf(groupRun).collectionInputs.assertionAssets as Array<{ manifestDigest: string }>)[0]!).manifestDigest = "a".repeat(64);
    }));
    expect(result.verdict).toBe("UNKNOWN");
    expect(reasonOfGroup(result)).toMatch(/installed assertion assets/u);
  });

  it("is UNKNOWN when the runner honestly records a loosened probe schema, even though its own collection accepts it", async () => {
    const loosened = { type: "object", required: ["version"], properties: { version: { type: "integer" } } };
    const round = await stateRound({ stateProbeSchema: loosened,
      stateProbeManifestDigest: e2eApplicationStateProbeManifestDigest("api-state-positive/v1", sha(Buffer.from(canonicalJson(loosened)))) });
    expect(round.fixture.collected.qualification?.status, "the worker's own collection accepts a self-consistent loosened schema").toBe("PASS");
    const result = verifyApplicationE2EEvidence(round.input());
    expect(result.verdict).toBe("UNKNOWN");
    expect(reasonOfGroup(result)).toMatch(/installed assertion assets/u);
  });

  it("is UNKNOWN when the worker adds or drops an asset", async () => {
    const round = await stateRound();
    const extra = verifyApplicationE2EEvidence(withGroupRun(round, (groupRun) => {
      const assets = actualOf(groupRun).collectionInputs.assertionAssets as Array<Record<string, unknown>>;
      assets.push({ ...assets[0]!, assertionIndex: 1, kind: "json-schema", id: "orders-v1" });
    }));
    expect(extra.verdict).toBe("UNKNOWN");
    expect(reasonOfGroup(extra)).toMatch(/installed assertion assets/u);
    const dropped = verifyApplicationE2EEvidence(withGroupRun(round, (groupRun) => { actualOf(groupRun).collectionInputs.assertionAssets = []; }));
    expect(dropped.verdict).toBe("UNKNOWN");
    expect(reasonOfGroup(dropped)).toMatch(/installed assertion assets/u);
  });

  it("derives no asset for a JSON schema or a fixture root, since none are installed, and refuses the case", () => {
    const state = { kind: "state", probeId: "api-state-positive/v1", equals: {}, pollTimeoutMs: 1000 };
    const suiteFor = (assertion: Record<string, unknown>) => ({ expectedCases: [{ caseId: "case-1", scenarioId: "s" }], bundle: { scenarios: [{ scenarioId: "s", assertions: [assertion] }] } });
    const ok = expectedApplicationAssertionAssets(suiteFor(state) as never);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.assets).toEqual([{ caseId: "case-1", assertionIndex: 0, kind: "state-probe", id: "api-state-positive/v1",
      manifestDigest: installedE2EApplicationStateProbeAsset("api-state-positive/v1")!.manifestDigest, sha256: installedE2EApplicationStateProbeAsset("api-state-positive/v1")!.sha256,
      byteLength: installedE2EApplicationStateProbeAsset("api-state-positive/v1")!.byteLength }]);
    for (const assertion of [{ kind: "json", responseId: "r", schemaRef: "orders-v1", equals: {} }, { kind: "file", fixtureRootId: "root", relativePath: "a", sha256: "a".repeat(64) },
      { ...state, probeId: "unknown-probe/v1" }]) {
      const refused = expectedApplicationAssertionAssets(suiteFor(assertion) as never);
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.reason).toMatch(/not installed/u);
    }
  });
});

describe("how much evidence a group and the round may carry (Ruling BV)", () => {
  it("is 8 MiB for a group, never above the transfer bound of its own cases and shards, and 24 MiB for the whole aggregate", async () => {
    const round = await roundOf(PASSING);
    const limits = applicationEvidenceLimits(round.admission);
    expect([...limits.byGroup.keys()]).toEqual([round.fixture.runId]);
    expect(limits.byGroup.get(round.fixture.runId)).toBe(8 * 1024 * 1024);
    expect(limits.aggregate).toBe(8 * 1024 * 1024);
    const binding = round.admission.groups[0]!;
    expect(limits.byGroup.get(round.fixture.runId)!).toBeLessThanOrEqual(e2eApplicationPrivateTransferMaxBytes(binding.outerBinding.expectedCases.length, binding.protocol === "trusted-e2e-application/v1" ? binding.shards.length : 1));
    // Four groups would sum to 32 MiB; the aggregate as a whole stays at 24 MiB.
    const four = { groups: [0, 1, 2, 3].map((index) => ({ ...binding, outerBinding: { ...binding.outerBinding, runId: `00000000-0000-4000-8000-00000000000${index}` } })) };
    expect(applicationEvidenceLimits(four as never).aggregate).toBe(24 * 1024 * 1024);
  });
});

describe("combining the verdicts of the parts of a round (Ruling BA)", () => {
  const cases: Array<[E2EVerdict[], E2EVerdict]> = [
    [["PASS", "PASS"], "PASS"], [["PASS"], "PASS"], [["PASS", "UNKNOWN"], "UNKNOWN"], [["UNKNOWN", "UNKNOWN"], "UNKNOWN"],
    [["FAILED", "PASS"], "FAILED"], [["PASS", "FAILED"], "FAILED"], [["FAILED", "UNKNOWN"], "FAILED"], [["UNKNOWN", "FAILED", "PASS"], "FAILED"], [[], "UNKNOWN"],
  ];
  it.each(cases)("%j is %s", (verdicts, expected) => { expect(combineE2EVerdicts(verdicts)).toBe(expected); });
});

describe("holding an approved plan to its admission when approval pinned the test accounts (Task 3.1)", () => {
  it("compares parsed intents: a stored plan without the schema's defaulted keys is the admitted intent, with the pinned account ref in place of the plan's own", () => {
    const fx = planFixture({});
    const { portableOperationRefs: _portable, mockFixtureRefs: _mocks, unavailableTargetRefs: _unavailable, ...stored } = fx.intent;
    void _portable; void _mocks; void _unavailable;
    const pinned = [{ ...fx.accountRef, revision: 2, definitionDigest: "7".repeat(64) }];
    const admitted = applicationRoundIntent(applicationIntentWithAccountRefs(stored, pinned));
    expect(admitted.runtimeAccountRefs).toEqual(pinned);
    // The planner's stored form read back with its keys in another order (a table keeps none) is the same admitted intent: both sides go through the schema.
    const reread = Object.fromEntries(Object.entries(stored).reverse());
    expect(canonicalJson(applicationRoundIntent(applicationIntentWithAccountRefs(reread as never, pinned)))).toBe(canonicalJson(admitted));
    // And the members the schema defaults are written out as empty lists on the admitted side, never compared as the stored JSON spells them.
    expect(admitted.portableOperationRefs).toEqual([]);
    // Without a pin (an M1.2 record) the plan's own ref is what runs.
    expect(applicationRoundIntent(applicationIntentWithAccountRefs(stored, [])).runtimeAccountRefs).toEqual([fx.accountRef]);
    // A pin for another account of the application leaves this account's ref alone: the lookup is by application and profile.
    const other = [{ ...pinned[0]!, profileId: "orders-viewer" }];
    expect(applicationIntentWithAccountRefs(fx.intent, other).runtimeAccountRefs).toEqual([fx.accountRef]);
  });
});

describe("a round whose web and API groups come from one admission (Task 3.4)", () => {
  afterEach(disposeRealCandidates);
  /**
   * The admission the broker builds for an app's web and API scenarios, with the API group genuinely collected from raw evidence and the web group's run the way a worker uploads one it could
   * not collect (the collector the fixture drives is the API runtime's, so a collected web group is the Linux journey's to show).
   */
  async function webAndApiRound(observed: ObservedApiOutcome, options: { baseline?: boolean } = {}) {
    const built = await builtWebAndApiAdmission({}, { web: true, api: true }, options);
    const apiGroupId = built.groupOf("api")!;
    const webGroupId = built.groupOf("web")!;
    const api = await collectApplicationGroupEvidence({ admission: built.admission, validated: built.validated, groupId: apiGroupId, observed });
    const webBinding = built.admission.groups.find((group) => group.outerBinding.groupId === webGroupId)!.outerBinding;
    const webReason = "the browser group produced no result";
    const web = { kind: "application", group: built.validated.executionPlan.groups.find((group) => group.groupId === webGroupId), binding: webBinding,
      collection: { status: "UNKNOWN", reason: webReason }, unavailableReason: webReason, lifecycle: { cleanup: "confirmed", process: { exitCode: 1, timedOut: false, aborted: false } },
      actual: null, diagnostics: null, operatorEvidence: null } as Record<string, unknown>;
    const admissionBytes = Buffer.from(built.built.bytes);
    const admissionSha256 = sha(admissionBytes);
    const { admission } = built;
    const subject = { taskId: admission.taskId, operationId: admission.operationId, operationFence: admission.operationFence, workflowRevision: admission.workflowRevision,
      candidateDigest: admission.candidateDigest, roundId: admission.round.roundId, groupRunIds: admission.groups.map((group) => group.outerBinding.runId), admissionSha256 };
    const runs = [api.groupRun, web];
    const input: ApplicationEvidenceInput = { admissionBytes, subject,
      aggregate: aggregateEvidenceEnvelope({ admission, admissionSha256, groupRuns: runs }),
      groupEvidence: new Map(runs.map((run) => [(run.binding as { runId: string }).runId, groupEvidenceEnvelope({ admission, admissionSha256, groupRun: run })])),
      receivedAt: new Map([[api.runId, actualOf(api.groupRun).collection.receivedAt], [webBinding.runId, new Date().toISOString()]]), terminalStatus: "SUCCEEDED",
      ...(options.baseline === true ? { purpose: "baseline" as const } : {}) };
    return { built, api, apiGroupId, webGroupId, input, webReason };
  }

  it("fails the round when the API group fails, whatever the browser group did, and attributes each group's verdict to its own kind", async () => {
    const round = await webAndApiRound({ kind: "http-status", status: 503 });
    const result = verifyApplicationE2EEvidence(round.input);
    expect(result.verdict).toBe("FAILED");
    expect(result.groups.map((group) => [group.groupId, group.verdict]).sort()).toEqual([[round.apiGroupId, "FAILED"], [round.webGroupId, "UNKNOWN"]].sort());
    // The one result there is belongs to the API group's own case: it is not credited to the browser group.
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ status: "failed", binding: { groupId: round.apiGroupId } });
    expect(result.reason).toContain(round.apiGroupId);
  });

  it("is never PASS while the browser group has no result, even when the API group passes", async () => {
    const round = await webAndApiRound({ kind: "http-status", status: 200 });
    const result = verifyApplicationE2EEvidence(round.input);
    expect(result.groups.find((group) => group.groupId === round.apiGroupId)?.verdict).toBe("PASS");
    expect(result.groups.find((group) => group.groupId === round.webGroupId)?.verdict).toBe("UNKNOWN");
    expect(result.verdict).toBe("UNKNOWN");
    expect(result.reason).toContain(round.webGroupId);
  });

  it("reads the baseline round of a web and API plan group by group: one signed purpose for both groups, each judged on its own, a row for every approved scenario, and never as a candidate round", async () => {
    const round = await webAndApiRound({ kind: "http-status", status: 503 }, { baseline: true });
    expect(round.built.admission.baseline).toMatchObject({ purpose: "baseline", baseCommitSha: round.built.admission.candidateCommitSha, attempt: 1 });
    expect(round.built.admission.groups).toHaveLength(2);
    const result = verifyApplicationE2EEvidence(round.input);
    expect(result.groups.map((group) => [group.groupId, group.verdict]).sort()).toEqual([[round.apiGroupId, "FAILED"], [round.webGroupId, "UNKNOWN"]].sort());
    expect(result.display?.scenarios.map((row) => [row.scenarioId, row.kind]).sort()).toEqual([["owner-api-health", "api"], ["owner-export-page", "web"]]);
    expect(result.display?.scenarios.find((row) => row.scenarioId === "owner-api-health")).toMatchObject({ status: "FAILED", kind: "api" });
    // The same evidence asked for as a candidate's round is refused: a baseline is never a candidate's verdict, however many groups it has.
    const asCandidate = verifyApplicationE2EEvidence({ ...round.input, purpose: "candidate" });
    expect(asCandidate.verdict).toBe("UNKNOWN");
    expect(asCandidate.reason).toMatch(/baseline/i);
  });

  it("requalifies a group against the runtime row of its own kind: a profile whose API row reports another environment than its web row is judged by the API row for the API group", async () => {
    const apiEnvironment = { ci: true as const, trustNoticeShown: false as const, os: "linux 6.9.9", arch: "arm64", runtime: "node v22.23.2" };
    const rows = [webApiRow("web"), webApiRow("api", { runnerEnvironment: apiEnvironment, runnerEnvironmentDigest: shaCanonicalOf(apiEnvironment) })];
    const built = await builtWebAndApiAdmission({ registeredRuntimes: rows });
    const apiGroupId = built.groupOf("api")!;
    // The fixture's runner reports the environment of the admitted API row, as a real executor on that runtime does...
    const api = await collectApplicationGroupEvidence({ admission: built.admission, validated: built.validated, groupId: apiGroupId, observed: { kind: "http-status", status: 200 } });
    expect(api.collectionInputs.environment).toEqual(apiEnvironment);
    expect(api.compiled.runtimeKind).toBe("api");
    const admissionBytes = Buffer.from(built.built.bytes);
    const admissionSha256 = sha(admissionBytes);
    const { admission } = built;
    const webGroup = admission.groups.find((group) => group.outerBinding.groupId !== apiGroupId)!.outerBinding;
    const web = { kind: "application", group: built.validated.executionPlan.groups.find((group) => group.groupId === webGroup.groupId), binding: webGroup,
      collection: { status: "UNKNOWN", reason: "no result" }, unavailableReason: "no result", lifecycle: { cleanup: "confirmed", process: { exitCode: 1, timedOut: false, aborted: false } },
      actual: null, diagnostics: null, operatorEvidence: null } as Record<string, unknown>;
    const subject = { taskId: admission.taskId, operationId: admission.operationId, operationFence: admission.operationFence, workflowRevision: admission.workflowRevision,
      candidateDigest: admission.candidateDigest, roundId: admission.round.roundId, groupRunIds: admission.groups.map((group) => group.outerBinding.runId), admissionSha256 };
    const verify = (runs: Array<Record<string, unknown>>) => verifyApplicationE2EEvidence({ admissionBytes, subject, aggregate: aggregateEvidenceEnvelope({ admission, admissionSha256, groupRuns: runs }),
      groupEvidence: new Map(runs.map((run) => [(run.binding as { runId: string }).runId, groupEvidenceEnvelope({ admission, admissionSha256, groupRun: run })])),
      receivedAt: new Map([[api.runId, actualOf(api.groupRun).collection.receivedAt], [webGroup.runId, new Date().toISOString()]]), terminalStatus: "SUCCEEDED" });
    // ...so the broker's recollection, which looks the row up by profile and kind, finds that environment: the API group is PASS. Judged by the web row's environment it would be UNKNOWN.
    expect(verify([api.groupRun, web]).groups.find((group) => group.groupId === apiGroupId)).toMatchObject({ verdict: "PASS" });
    const claimingWebRowEnvironment = clone(api.groupRun);
    (actualOf(claimingWebRowEnvironment).collectionInputs as { environment: unknown }).environment = { ...apiEnvironment, os: "linux 6.8.0" };
    expect(verify([claimingWebRowEnvironment, web]).groups.find((group) => group.groupId === apiGroupId)?.verdict).toBe("UNKNOWN");
  });
});
