import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { E2E_APPLICATION_AGGREGATE_EVIDENCE_MAX_BYTES, E2E_APPLICATION_GROUP_EVIDENCE_MAX_BYTES, E2EApplicationSelectionRecordSchema, E2EWorkflowEvidenceRefSchema, E2EWorkflowGroupEvidenceRefSchema, WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX } from "@agentx/contracts";
import { e2eApplicationPrivateTransferMaxBytes } from "@agentx/verifier";
import { developerTaskRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { getTaskDocumentView, retryApplicationRoundOnPage, startTaskWorkflowPublicationFromSystem } from "../../packages/broker/src/aws/developer-tasks.js";
import { disposeRealCandidates } from "../support/e2e-application-candidate.js";
import type { E2EApplicationReport } from "../../packages/verifier/src/application-report-schema.js";
import type { ApplicationGroupEvidence, ObservedApiOutcome } from "../support/e2e-application-evidence-fixture.js";
import { MAYA } from "../support/developer-task-broker.js";
import { apiRowKey, sha, startApplicationRound, type ApplicationRound } from "../support/e2e-application-round-harness.js";

// An application round on the real broker: the dispatch builds the admission, the worker's callbacks upload genuinely collected evidence, the broker
// verifies it independently of the worker at the result callback, and what it decides gates publication exactly as it does for portable rounds.

afterEach(async () => { vi.useRealTimers(); await disposeRealCandidates(); });

const PASS = { kind: "http-status", status: 200 } as const satisfies ObservedApiOutcome;
const FAIL = { kind: "http-status", status: 503 } as const satisfies ObservedApiOutcome;
type Outcome = ObservedApiOutcome | readonly ObservedApiOutcome[];
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const GROUP_CEILING_BYTES = 8 * 1024 * 1024;
const AGGREGATE_CEILING_BYTES = 24 * 1024 * 1024;
/** The portable bound the evidence references have always had; application evidence is held well below it. */
const PORTABLE_REF_MAX_BYTES = 24 * 1024 * 1024;

/** Collects every group of the round: `outcomes` holds, per group in admission order, what its targets observed. */
async function collectAll(round: ApplicationRound, outcomes: readonly Outcome[], reportEdit?: (report: E2EApplicationReport, shard: number, group: number) => void) {
  const groups: ApplicationGroupEvidence[] = [];
  for (const [index, groupId] of round.groupIds.entries()) groups.push(await round.collectGroup(groupId, outcomes[index]!, reportEdit === undefined ? undefined : (report, shard) => reportEdit(report, shard, index)));
  return groups;
}
/** What the worker does while the round runs: each group's evidence as it finishes, then the aggregate. Returns the aggregate's reference. */
async function uploadAll(round: ApplicationRound, groups: readonly ApplicationGroupEvidence[], tweak: (groupRun: Record<string, unknown>, index: number) => void = () => undefined) {
  round.markRunning();
  const runs: Record<string, unknown>[] = [];
  for (const [index, group] of groups.entries()) {
    const groupRun = clone(group.groupRun);
    tweak(groupRun, index);
    runs.push(groupRun);
    const uploaded = await round.upload(round.groupEnvelope(groupRun), { groupRunId: group.runId });
    expect(uploaded.response.status, JSON.stringify(uploaded.response.body)).toBe(200);
  }
  const aggregate = await round.upload(round.aggregateEnvelope(runs));
  expect(aggregate.response.status, JSON.stringify(aggregate.response.body)).toBe(200);
  return aggregate.response.body as { key: string; sha256: string };
}
async function runRound(round: ApplicationRound, outcomes: readonly Outcome[], options: { tweak?: Parameters<typeof uploadAll>[2] } = {}) {
  const groups = await collectAll(round, outcomes);
  const aggregate = await uploadAll(round, groups, options.tweak);
  await round.finishChecks(aggregate);
  return { groups, aggregate };
}
const e2eOf = (round: ApplicationRound) => round.workflowNow().e2e as { qualifiedRound?: { candidateDigest: string; roundId: string; groupRunIds: string[]; admissionSha256: string; evidenceSha256: string };
  failedRound?: { status: string; candidateDigest: string; roundId: string; groupRunIds: string[]; admissionSha256: string; evidenceSha256: string }; currentRoundId?: string; currentGroupRunIds: string[] };
const operations = (round: ApplicationRound) => round.operationRows(() => true);
// The broker module reads its environment when it loads, so it is imported only once the harness (which sets that environment up) has started.
const brokerModule = () => import("../../packages/broker/src/aws/broker.js");
const loadWorkflowE2EPresentation = async (...args: Parameters<Awaited<ReturnType<typeof brokerModule>>["loadWorkflowE2EPresentation"]>) => (await brokerModule()).loadWorkflowE2EPresentation(...args);
const loadWorkflowE2EPublicationChecks = async (...args: Parameters<Awaited<ReturnType<typeof brokerModule>>["loadWorkflowE2EPublicationChecks"]>) => (await brokerModule()).loadWorkflowE2EPublicationChecks(...args);
const presentationOf = (round: ApplicationRound) => loadWorkflowE2EPresentation(round.harness.brokerInput as never, round.taskNow() as never, operations(round), "owner");
const publicationChecksOf = (round: ApplicationRound) => loadWorkflowE2EPublicationChecks(round.harness.brokerInput as never, round.taskNow() as never, operations(round));
const blockedWith = (round: ApplicationRound, reason: RegExp) => {
  expect(round.workflowNow(), JSON.stringify(round.workflowNow())).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
  expect(round.workflowNow().blockReason).toMatch(reason);
  expect(e2eOf(round).qualifiedRound).toBeUndefined();
};

describe("uploading the evidence of an application round: group lookup, sizing and the broker's receipt", () => {

  it("refuses a group outside the admission, and an operation whose reference names other groups than the admission does", async () => {
    const round = await startApplicationRound({ applications: 4 });
    round.markRunning();
    const [first] = await collectAll(round, [PASS, PASS]);
    const foreign = randomUUID();
    const foreignInit = await round.evidenceCall({ stage: "init", groupRunId: foreign, totalBytes: 10, chunkCount: 1, sha256: "a".repeat(64) });
    expect(foreignInit.status).toBe(409);
    expect(JSON.stringify(foreignInit.body)).toMatch(/outside the immutable admission/);
    // The operation's own reference is replaced by one that names a run the admission does not hold: the admission is the authority, not the reference.
    const operation = round.operationNow();
    const swapped = [foreign, ...operation.workflowE2EAdmission.groupRunIds.slice(1)];
    round.harness.db.set({ ...operation, workflowE2EAdmission: { ...operation.workflowE2EAdmission, groupRunIds: swapped } });
    for (const groupRunId of [foreign, first!.runId]) {
      const refused = await round.evidenceCall({ stage: "init", groupRunId, totalBytes: 10, chunkCount: 1, sha256: "a".repeat(64) });
      expect(refused.status, groupRunId).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(refused.body)).toMatch(/no longer matches its operation/);
    }
    expect(round.uploadRow(foreign)).toBeUndefined();
  });

  it("refuses evidence whose plan group, run binding, candidate or round is not the admitted one", async () => {
    const round = await startApplicationRound({ applications: 4 });
    round.markRunning();
    const groups = await collectAll(round, [PASS, PASS]);
    const [one, other] = groups as [ApplicationGroupEvidence, ApplicationGroupEvidence];
    const refusals: Array<[string, Record<string, unknown>]> = [
      ["another group's plan group", { ...round.groupEnvelope(one.groupRun), groupRun: { ...one.groupRun, group: other.groupRun.group } }],
      ["another group's binding", { ...round.groupEnvelope(one.groupRun), groupRun: { ...one.groupRun, binding: other.groupRun.binding } }],
      ["a plan group that is not an admitted one", { ...round.groupEnvelope(one.groupRun), groupRun: { ...one.groupRun, group: { ...(one.groupRun.group as Record<string, unknown>), mode: "hybrid" } } }],
      ["an older candidate", { ...round.groupEnvelope(one.groupRun), candidateDigest: "e".repeat(64) }],
      ["another round", { ...round.groupEnvelope(one.groupRun), round: { ...round.admission.round, roundId: randomUUID() } }],
      ["another admission", { ...round.groupEnvelope(one.groupRun), admissionSha256: "f".repeat(64) }],
    ];
    for (const [label, envelope] of refusals) {
      const uploaded = await round.upload(envelope, { groupRunId: one.runId });
      expect(uploaded.stage, label).toBe("finalize");
      expect(uploaded.response.status, label).toBe(409);
      expect(JSON.stringify(uploaded.response.body), label).toMatch(/outside its exact admitted run binding/);
      expect(round.operationNow().workflowE2EGroupRunIds, label).toBeUndefined();
      // The refused upload is not a receipt of anything: the same group can still be sent properly afterwards.
      round.clearUpload(one.runId);
    }
    const proper = await round.upload(round.groupEnvelope(one.groupRun), { groupRunId: one.runId });
    expect(proper.response.status, JSON.stringify(proper.response.body)).toBe(200);
  });

  it("sizes an application upload from the admission's cases and shards: 8 MiB for a group, and the groups' sum (at most 24 MiB) for the aggregate", async () => {
    const round = await startApplicationRound({ applications: 4 });
    round.markRunning();
    expect(E2E_APPLICATION_GROUP_EVIDENCE_MAX_BYTES).toBe(GROUP_CEILING_BYTES);
    expect(E2E_APPLICATION_AGGREGATE_EVIDENCE_MAX_BYTES).toBe(AGGREGATE_CEILING_BYTES);
    const sized = round.applicationGroups.map((group) => ({ runId: group.outerBinding.runId,
      limit: Math.min(GROUP_CEILING_BYTES, e2eApplicationPrivateTransferMaxBytes(group.outerBinding.expectedCases.length, group.shards.length)) }));
    expect(sized.every((item) => item.limit === GROUP_CEILING_BYTES)).toBe(true);
    const init = (totalBytes: number, groupRunId?: string) => round.evidenceCall({ stage: "init", ...(groupRunId === undefined ? {} : { groupRunId }),
      totalBytes, chunkCount: Math.ceil(totalBytes / (64 * 1024)), sha256: "a".repeat(64) });
    for (const { runId, limit } of sized) {
      const over = await init(limit + 1, runId);
      expect(over.status, "one byte over the group's ceiling").toBe(400);
      expect(JSON.stringify(over.body)).toMatch(/exceeds its admission-derived transfer bound/);
      expect(round.uploadRow(runId)).toBeUndefined();
    }
    const aggregateLimit = Math.min(AGGREGATE_CEILING_BYTES, sized.reduce((total, item) => total + item.limit, 0));
    const overAggregate = await init(aggregateLimit + 1);
    expect(overAggregate.status).toBe(400);
    expect(JSON.stringify(overAggregate.body)).toMatch(/exceeds its admission-derived transfer bound/);
    expect((await init(sized[0]!.limit, sized[0]!.runId)).status).toBe(200);
    expect((await init(aggregateLimit)).status).toBe(200);
  });

  it("keeps the evidence references at the portable 24 MiB bound they have always had, which application evidence stays under", () => {
    const ref = (byteLength: number) => ({ groupRunId: randomUUID(), evidenceRef: { key: `workflow-e2e-group-evidence/sha256/${"a".repeat(64)}.json`, sha256: "a".repeat(64), byteLength } });
    expect(E2EWorkflowGroupEvidenceRefSchema.safeParse(ref(PORTABLE_REF_MAX_BYTES)).success).toBe(true);
    expect(E2EWorkflowGroupEvidenceRefSchema.safeParse(ref(PORTABLE_REF_MAX_BYTES + 1)).success).toBe(false);
    const aggregate = (byteLength: number) => ({ key: `workflow-e2e-evidence/sha256/${"b".repeat(64)}.json`, sha256: "b".repeat(64), byteLength });
    expect(E2EWorkflowEvidenceRefSchema.safeParse(aggregate(PORTABLE_REF_MAX_BYTES)).success).toBe(true);
    expect(E2EWorkflowEvidenceRefSchema.safeParse(aggregate(PORTABLE_REF_MAX_BYTES + 1)).success).toBe(false);
    expect(E2E_APPLICATION_GROUP_EVIDENCE_MAX_BYTES).toBeLessThan(PORTABLE_REF_MAX_BYTES);
    expect(E2E_APPLICATION_AGGREGATE_EVIDENCE_MAX_BYTES).toBeLessThanOrEqual(PORTABLE_REF_MAX_BYTES);
  });

  it("takes the aggregate only in its application shape and only once every admitted group was accepted on its own", async () => {
    const round = await startApplicationRound({ applications: 4 });
    round.markRunning();
    const groups = await collectAll(round, [PASS, PASS]);
    const runs = groups.map((group) => group.groupRun);
    // Before any group: nothing to aggregate.
    const early = await round.upload(round.aggregateEnvelope(runs));
    expect(early.response.status).toBe(409);
    expect(JSON.stringify(early.response.body)).toMatch(/missing one or more separately accepted admitted group results/);
    round.clearUpload();
    const [first, second] = groups as [ApplicationGroupEvidence, ApplicationGroupEvidence];
    expect((await round.upload(round.groupEnvelope(first.groupRun), { groupRunId: first.runId })).response.status).toBe(200);
    const partial = await round.upload(round.aggregateEnvelope(runs));
    expect(partial.response.status, "one group of two accepted").toBe(409);
    round.clearUpload();
    expect((await round.upload(round.groupEnvelope(second.groupRun), { groupRunId: second.runId })).response.status).toBe(200);
    // The portable shape (groupRuns at the top) is not an application aggregate, whatever it holds.
    const portableShape = { ...round.aggregateEnvelope(runs), groupRuns: runs };
    const portable = await round.upload(portableShape);
    expect(portable.response.status).toBe(409);
    round.clearUpload();
    const wrongKind = await round.upload({ ...round.aggregateEnvelope(runs), payload: { kind: "portable", groupRuns: runs } });
    expect(wrongKind.response.status).toBe(409);
    round.clearUpload();
    // An aggregate whose group run differs from the one accepted on its own.
    const altered = clone(runs);
    (altered[0]!.lifecycle as { cleanup: string }).cleanup = "pending";
    const different = await round.upload(round.aggregateEnvelope(altered));
    expect(different.response.status).toBe(409);
    expect(JSON.stringify(different.response.body)).toMatch(/differs from a separately accepted group result/);
    round.clearUpload();
    const proper = await round.upload(round.aggregateEnvelope(runs));
    expect(proper.response.status, JSON.stringify(proper.response.body)).toBe(200);
    expect(round.operationNow().workflowE2EEvidenceRef).toMatchObject({ sha256: proper.digest });
  });

  describe("the broker's receipt time of a group (the collector requires it within 30 s of the owned close)", () => {
    it("is the first upload start, recorded once: a retried init, however late, keeps it", async () => {
      const round = await startApplicationRound();
      round.markRunning();
      const [group] = await collectAll(round, [PASS]);
      const bytes = Buffer.from(JSON.stringify(round.groupEnvelope(group!.groupRun)), "utf8");
      const init = { stage: "init" as const, groupRunId: group!.runId, totalBytes: bytes.byteLength, chunkCount: Math.ceil(bytes.byteLength / 65_536), sha256: sha(bytes) };
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now());
      const startedAt = new Date().toISOString();
      const first = await round.evidenceCall(init);
      expect(first.status).toBe(200);
      expect(round.uploadRow(group!.runId)?.receivedAt).toBe(startedAt);
      vi.setSystemTime(Date.parse(startedAt) + 600_000);
      const retried = await round.evidenceCall(init);
      expect(retried.status).toBe(200);
      expect((retried.body as { uploadId: string }).uploadId).toBe((first.body as { uploadId: string }).uploadId);
      expect(round.uploadRow(group!.runId)?.receivedAt).toBe(startedAt);
    });

    it("is kept when the same completed group is initialized again later: the worker's retry finds the accepted upload", async () => {
      const round = await startApplicationRound();
      round.markRunning();
      const [group] = await collectAll(round, [PASS]);
      const uploaded = await round.upload(round.groupEnvelope(group!.groupRun), { groupRunId: group!.runId });
      expect(uploaded.response.status).toBe(200);
      const receivedAt = round.uploadRow(group!.runId)?.receivedAt;
      expect(typeof receivedAt).toBe("string");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 600_000);
      const again = await round.evidenceCall({ stage: "init", groupRunId: group!.runId, totalBytes: uploaded.bytes.byteLength, chunkCount: Math.ceil(uploaded.bytes.byteLength / 65_536), sha256: uploaded.digest });
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ complete: true, groupRunId: group!.runId });
      expect(round.uploadRow(group!.runId)?.receivedAt).toBe(receivedAt);
    });

  });
});

describe("verifying an application round at its result and gating publication on it", () => {

  it("makes a required scenario the runner skipped UNKNOWN, with publication STALE", async () => {
    const round = await startApplicationRound();
    const groups = await Promise.all([round.collectGroup(round.groupIds[0]!, PASS, (report) => {
      const row = report.run.results[0]!;
      row.status = "skipped"; row.skip = { cause: "explicit", reason: "skipped by the candidate" };
      row.attempts = []; row.selected = false;
      report.run.status = "passed"; report.run.exitCode = 0;
      report.run.summary = { discovered: 1, selected: 0, executed: 0, passed: 0, failed: 0, interrupted: 0, flaky: 0, skipped: 1 };
    })]);
    expect(groups[0].collected.qualification?.status).toBe("UNKNOWN");
    const aggregate = await uploadAll(round, groups);
    await round.finishChecks(aggregate);
    blockedWith(round, /incomplete or unknown/);
    expect(e2eOf(round).failedRound).toBeUndefined();
    expect((await presentationOf(round))?.shared.e2e.status).not.toBe("PASS");
    expect(await publicationChecksOf(round)).toBeUndefined();
    // A task that nevertheless reached the publication step is refused there too.
    await expectPublicationStale(round);
  });

  it("does not let group evidence without the round's aggregate be PASS: it shows as not passing and nothing is qualified", async () => {
    const round = await startApplicationRound();
    round.markRunning();
    const [group] = await collectAll(round, [PASS]);
    const uploaded = await round.upload(round.groupEnvelope(group!.groupRun), { groupRunId: group!.runId });
    expect(uploaded.response.status).toBe(200);
    expect((await presentationOf(round))?.shared.e2e.status).not.toBe("PASS");
    expect(await publicationChecksOf(round)).toBeUndefined();
    // The worker's result names no aggregate: the operation cannot be accepted as checked.
    await round.finishChecks();
    blockedWith(round, /private evidence is missing/);
  });

  it("does not qualify the evidence of an older candidate for a newer one", async () => {
    const round = await startApplicationRound();
    await runRound(round, [PASS]);
    expect(e2eOf(round).qualifiedRound).toBeDefined();
    const task = round.taskNow() as { workflow: { candidate: { digest: string; repositories: unknown[] } } };
    // After a send-back the task holds another candidate; the old round's evidence is for code that is gone.
    const newer = { ...task.workflow.candidate, digest: "d".repeat(64) };
    round.harness.db.set({ ...task, workflow: { ...task.workflow, candidate: newer } });
    expect(await publicationChecksOf(round)).toBeUndefined();
    expect((await presentationOf(round))?.shared.e2e.status).not.toBe("PASS");
  });

  /** The task is forced to the publication step with the round's evidence as it is, and publication is asked to start. */
  async function expectPublicationStale(round: ApplicationRound) {
    const task = round.taskNow() as { workflow: Record<string, unknown> & { revision: number; candidate: { digest: string } } };
    round.harness.db.set({ ...task, workflow: { ...task.workflow, stage: "PULL_REQUEST", state: "READY" } });
    const input = round.harness.brokerInput as { documentClient: never; tableName: string; developer: never };
    const deps = developerTaskRouteDependencies({ documentClient: input.documentClient, tableName: input.tableName, developer: input.developer, now: Date.now, tasks: round.harness.actions as never },
      { developerId: MAYA.developerId, sessionId: MAYA.sessionId, amr: MAYA.provider, name: MAYA.name });
    const withE2E = { ...deps,
      workflowE2EPresentation: (request: { task: unknown; operations: readonly unknown[]; actor: "owner" | "viewer" }) => loadWorkflowE2EPresentation(round.harness.brokerInput as never, request.task as never, request.operations, request.actor),
      workflowE2EPublicationChecks: (request: { task: unknown; operations: readonly unknown[] }) => loadWorkflowE2EPublicationChecks(round.harness.brokerInput as never, request.task as never, request.operations) };
    await expect(startTaskWorkflowPublicationFromSystem(withE2E as never, round.taskId, { workflowRevision: task.workflow.revision, candidateDigest: task.workflow.candidate.digest }, {})).resolves.toBe("STALE");
  }

  describe("two groups of the same kind, end to end (four API targets: a group holds at most three)", () => {
    const threeShards = (round: ApplicationRound) => round.applicationGroups.findIndex((group) => group.shards.length === 3);


    it("fails the round for a failing group even when its sibling is UNKNOWN (any FAILED wins), and is UNKNOWN when the failure is not there", async () => {
      const skip = (report: E2EApplicationReport) => {
        const row = report.run.results[0]!;
        row.status = "skipped"; row.skip = { cause: "explicit", reason: "skipped by the candidate" }; row.attempts = []; row.selected = false;
        report.run.status = "passed"; report.run.exitCode = 0;
        report.run.summary = { discovered: 1, selected: 0, executed: 0, passed: 0, failed: 0, interrupted: 0, flaky: 0, skipped: 1 };
      };
      const failed = await startApplicationRound({ applications: 4 });
      const three = threeShards(failed);
      const single = 1 - three;
      const groups = await Promise.all(failed.groupIds.map((groupId, index) => failed.collectGroup(groupId, index === single ? FAIL : [PASS, PASS, PASS], index === three ? (report, shard) => { if (shard === 0) skip(report); } : undefined)));
      expect(groups[three]!.collected.qualification?.status).toBe("UNKNOWN");
      expect(groups[single]!.collected.qualification?.status).toBe("FAILED");
      await failed.finishChecks(await uploadAll(failed, groups));
      expect(e2eOf(failed).failedRound).toBeDefined();
      const unknown = await startApplicationRound({ applications: 4 });
      const unknownGroups = await Promise.all(unknown.groupIds.map((groupId, index) => unknown.collectGroup(groupId, index === single ? PASS : [PASS, PASS, PASS], index === three ? (report, shard) => { if (shard === 0) skip(report); } : undefined)));
      await unknown.finishChecks(await uploadAll(unknown, unknownGroups));
      blockedWith(unknown, /incomplete or unknown/);
      expect(e2eOf(unknown).failedRound).toBeUndefined();
    });

  });
});

describe("current authority at verification (the runtime row, the creator, the source)", () => {
  /** Everything uploaded, the row changed, and only then the result: what a requalification during the round looks like. */
  async function requalifiedDuringRound(change: (row: Record<string, unknown>) => Record<string, unknown>, outcomes: readonly Outcome[] = [PASS]) {
    const round = await startApplicationRound();
    const groups = await collectAll(round, outcomes);
    const aggregate = await uploadAll(round, groups);
    round.harness.db.set(change(round.harness.db.get(apiRowKey.pk, apiRowKey.sk)!));
    await round.finishChecks(aggregate);
    return round;
  }

  describe("the task page's retry of a blocked round", () => {
    const maya = { developerId: MAYA.developerId, sessionId: MAYA.sessionId, amr: MAYA.provider, name: MAYA.name };
    const pageDeps = async (round: ApplicationRound) => {
      const input = round.harness.brokerInput as { documentClient: never; tableName: string; developer: never };
      const broker = await brokerModule();
      return developerTaskRouteDependencies({ documentClient: input.documentClient, tableName: input.tableName, developer: input.developer, now: Date.now, tasks: round.harness.actions as never,
        ...broker.workflowApplicationRouteDependencies(round.harness.brokerInput as never) }, maya);
    };
    const requalify = () => requalifiedDuringRound((row) => ({ ...row, generation: Number(row.generation) + 1, qualifiedAt: new Date(Date.now() - 1_000).toISOString() }));

    it("is offered to the owner for a block a retry fixes, and one press approves the plan again exactly as the Slack retry does, once", async () => {
      const round = await requalify();
      const deps = await pageDeps(round);
      expect((await getTaskDocumentView(deps, maya, round.taskId)).applicationRetry).toEqual({ canRetry: true });
      const revision = round.workflowNow().revision;
      const requestId = randomUUID();
      expect(await retryApplicationRoundOnPage(deps, maya, round.taskId, { requestId, expectedRevision: revision })).toEqual({ revision: revision + 1 });
      expect(round.workflowNow()).toMatchObject({ stage: "VERIFY", state: "WAITING" });
      const e2e = round.workflowNow().e2e as { applicationSelection: unknown; applicationReapprovals?: Array<{ requestId: string; actorId: string; previous: { selectionDigest: string }; current: { selectionDigest: string } }> };
      expect(E2EApplicationSelectionRecordSchema.parse(e2e.applicationSelection).runtimeRows[0]).toMatchObject({ generation: 5 });
      expect(e2e.applicationReapprovals).toHaveLength(1);
      expect(e2e.applicationReapprovals![0]).toMatchObject({ requestId });
      expect(e2e.applicationReapprovals![0]!.actorId).toMatch(/^[a-f0-9]{64}$/);
      expect(e2e.applicationReapprovals![0]!.current.selectionDigest).not.toBe(e2e.applicationReapprovals![0]!.previous.selectionDigest);
      // The same press again is the same retry, not a second re-approval.
      expect(await retryApplicationRoundOnPage(deps, maya, round.taskId, { requestId, expectedRevision: revision })).toEqual({ revision: revision + 1 });
      expect((round.workflowNow().e2e as { applicationReapprovals?: unknown[] }).applicationReapprovals).toHaveLength(1);
      expect((await getTaskDocumentView(deps, maya, round.taskId)).applicationRetry).toBeUndefined();
    });

    it("offers the runtime-unusable block too, and refuses a stale revision, another block and a task with no application block, changing nothing", async () => {
      const unusable = await requalifiedDuringRound((row) => ({ ...row, state: "REVOKED" }));
      expect(unusable.workflowNow().blockReason).toContain(WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX);
      expect((await getTaskDocumentView(await pageDeps(unusable), maya, unusable.taskId)).applicationRetry).toEqual({ canRetry: true });

      const round = await requalify();
      const deps = await pageDeps(round);
      const before = round.workflowNow();
      await expect(retryApplicationRoundOnPage(deps, maya, round.taskId, { requestId: randomUUID(), expectedRevision: before.revision - 1 })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      const task = round.taskNow() as { workflow: Record<string, unknown> };
      round.harness.db.set({ ...task, workflow: { ...task.workflow, blockReason: "AgentX ran none of this task's checks on the final code." } });
      expect((await getTaskDocumentView(deps, maya, round.taskId)).applicationRetry).toBeUndefined();
      await expect(retryApplicationRoundOnPage(deps, maya, round.taskId, { requestId: randomUUID(), expectedRevision: before.revision })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      expect(round.workflowNow()).toMatchObject({ stage: "VERIFY", state: "BLOCKED", revision: before.revision });
    });
  });

  it("names the field that moved when the generation did not: the expiry, or the qualification time", async () => {
    const expiry = await requalifiedDuringRound((row) => ({ ...row, expiresAt: new Date(Date.parse(String(row.expiresAt)) + 60_000).toISOString() }));
    blockedWith(expiry, /requalified during the round \(expiresAt now .+, .+ when admitted\)/);
    expect(expiry.workflowNow().blockReason).not.toMatch(/generation/);
    const qualified = await requalifiedDuringRound((row) => ({ ...row, qualifiedAt: new Date(Date.parse(String(row.qualifiedAt)) + 1_000).toISOString() }));
    blockedWith(qualified, /requalified during the round \(qualifiedAt now .+, .+ when admitted\)/);
    expect(qualified.workflowNow().blockReason).not.toMatch(/generation/);
  });

  it("fences the runtime row in the transaction that records the verdict: a requalification between verification and commit records nothing", async () => {
    const round = await startApplicationRound();
    const groups = await collectAll(round, [PASS]);
    const aggregate = await uploadAll(round, groups);
    const send = round.harness.db.send.bind(round.harness.db);
    let raced = false;
    round.harness.db.send = async (command) => {
      const items = (command as { input?: { TransactItems?: Array<{ ConditionCheck?: { Key?: { pk?: string; sk?: string } } }> } }).input?.TransactItems;
      if (!raced && command.constructor.name === "TransactWriteCommand" && items?.some((item) => item.ConditionCheck?.Key?.pk === apiRowKey.pk && item.ConditionCheck.Key.sk === apiRowKey.sk)) {
        raced = true;
        const row = round.harness.db.get(apiRowKey.pk, apiRowKey.sk)!;
        round.harness.db.set({ ...row, generation: Number(row.generation) + 1 });
      }
      return send(command);
    };
    try { await round.finishChecks(aggregate).catch(() => undefined); } finally { round.harness.db.send = send; }
    expect(raced, "the runtime row is among the checks of the verdict's transaction").toBe(true);
    expect(e2eOf(round).qualifiedRound).toBeUndefined();
    expect(round.workflowNow().stage).not.toBe("REVIEW");
  });

  it("holds the creator's access to the one the round was admitted under: a re-issued grant or a rebound channel during the round refuses", async () => {
    const round = await startApplicationRound();
    const proof = (round.admission as { creatorAuthority?: { kind: string; developerId: string; project: string } }).creatorAuthority;
    expect(proof, "the admission carries the creator's access as it was").toBeDefined();
    const aggregate = await uploadAll(round, await collectAll(round, [PASS]));
    if (proof!.kind === "direct-membership") {
      const key = { pk: `MEMBER#${proof!.developerId}`, sk: `PROJECT#${proof!.project}` };
      round.harness.db.set({ ...round.harness.db.get(key.pk, key.sk)!, grantId: randomUUID() });
    } else {
      const bound = (round.admission as { creatorAuthority?: { teamId: string; bindings: Array<{ channelId: string }> } }).creatorAuthority!;
      const key = { pk: `SLACK_BINDING#${bound.teamId}`, sk: `CHANNEL#${bound.bindings[0]!.channelId}` };
      round.harness.db.set({ ...round.harness.db.get(key.pk, key.sk)!, updatedAt: new Date(Date.now() + 5_000).toISOString() });
    }
    await round.finishChecks(aggregate);
    blockedWith(round, /creator-membership-proof-changed-or-unavailable/);
  });

  it("is UNKNOWN when the candidate's stored export is no longer there to hold the admission's source against", async () => {
    const round = await startApplicationRound();
    const groups = await collectAll(round, [PASS]);
    const aggregate = await uploadAll(round, groups);
    for (const key of [...round.harness.s3.objects.keys()]) if (key.startsWith("workflow-candidate-sources/")) round.harness.s3.objects.delete(key);
    await round.finishChecks(aggregate);
    blockedWith(round, /candidate-source-export-missing-or-ambiguous/);
  });

  it("is UNKNOWN when the approved plan no longer carries the selection the round was admitted under", async () => {
    const round = await startApplicationRound();
    const groups = await collectAll(round, [PASS]);
    const aggregate = await uploadAll(round, groups);
    const task = round.taskNow() as { workflow: { e2e: Record<string, unknown> } };
    const { applicationSelection: _selection, ...rest } = task.workflow.e2e;
    void _selection;
    round.harness.db.set({ ...task, workflow: { ...task.workflow, e2e: rest } });
    await round.finishChecks(aggregate);
    blockedWith(round, /no-recorded-application-selection/);
  });
});

describe("failures before authority is judged are worded as evidence, not as authority", () => {
  it("says the evidence is incomplete, not that an authority snapshot could not be fenced, when an accepted group's stored evidence is gone", async () => {
    const round = await startApplicationRound();
    const aggregate = await uploadAll(round, await collectAll(round, [PASS]));
    for (const key of [...round.harness.s3.objects.keys()]) if (key.startsWith("workflow-e2e-group-evidence/")) round.harness.s3.objects.delete(key);
    await round.finishChecks(aggregate);
    blockedWith(round, /incomplete or unknown \(accepted-group-evidence-integrity\)/);
    expect(round.workflowNow().blockReason).not.toMatch(/fenced/);
  });

  it("says why, in the reason the owner reads, for a group whose evidence the worker found too large", async () => {
    const round = await startApplicationRound();
    const groups = await collectAll(round, [PASS]);
    const aggregate = await uploadAll(round, groups, (groupRun) => {
      groupRun.collection = { status: "UNKNOWN", reason: "evidence too large" };
      groupRun.unavailableReason = "evidence too large"; groupRun.actual = null; groupRun.diagnostics = null;
    });
    await round.finishChecks(aggregate);
    blockedWith(round, /incomplete or unknown \(.*evidence too large/);
    expect(await publicationChecksOf(round)).toBeUndefined();
  });
});

describe("an application admission and a portable one never verify through each other's path (Ruling AX)", () => {
  it("never verifies a portable admission for a task whose approved plan is a v2 application plan, even with evidence recorded for it", async () => {
    const round = await startApplicationRound();
    round.markRunning();
    // A self-consistent portable-shaped admission and evidence object, content addressed and named by the operation, as a portable dispatch would have left them.
    const admissionText = JSON.stringify({ schemaVersion: "workflow-e2e-admission/v1", taskId: round.taskId, operationId: round.operationId, operationFence: round.operationNow().fence,
      workflowRevision: round.admissionRef.workflowRevision, candidateDigest: round.candidate.digest });
    const evidenceText = JSON.stringify({ schemaVersion: "workflow-e2e-evidence/v1", groupRuns: [] });
    const admissionSha = sha(admissionText); const evidenceSha = sha(evidenceText);
    const admissionKey = `workflow-e2e-admissions/sha256/${admissionSha}.json`;
    const evidenceKey = `workflow-e2e-evidence/sha256/${evidenceSha}.json`;
    round.harness.s3.objects.set(admissionKey, admissionText);
    round.harness.s3.objects.set(evidenceKey, evidenceText);
    const operation = round.operationNow();
    round.harness.db.set({ ...operation, workflowE2EAdmission: { ...operation.workflowE2EAdmission, admissionRef: { key: admissionKey, sha256: admissionSha, byteLength: Buffer.byteLength(admissionText) } },
      workflowE2EEvidenceRef: { key: evidenceKey, sha256: evidenceSha, byteLength: Buffer.byteLength(evidenceText) }, workflowE2EGroupRunIds: [], workflowE2EGroupEvidenceRefs: [] });
    await round.finishChecks({ key: evidenceKey, sha256: evidenceSha });
    blockedWith(round, /application-e2e-plan-needs-application-verification/);
    expect(e2eOf(round).failedRound).toBeUndefined();
    expect(await publicationChecksOf(round)).toBeUndefined();
  });

});
