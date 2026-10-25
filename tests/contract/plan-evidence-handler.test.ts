// Spec 061 (slice 1.1, task 5): the PlanEvidence job reads a stored plan's cited code in the background, with retries.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { WorkflowSnapshot } from "@agentx/contracts";
import { getTaskDocumentView } from "../../packages/broker/src/aws/developer-tasks.js";
import { runPlanEvidenceJob, type PlanEvidenceRunDependencies } from "../../packages/broker/src/aws/plan-evidence-handler.js";
import { PLAN_EVIDENCE_EVENT_SOURCE, planEvidenceDueKey } from "../../packages/broker/src/developer/plan-evidence-jobs.js";
import { MAYA, createSingleAnswerPlanBroker } from "../support/developer-task-broker.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";

const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
const FILE = ["one", "two", "three", "four", "five"].join("\n") + "\n";
const MINUTE = 60_000;

/** A deployment with the PlanEvidence function: the broker queues a job row (the job is run by the test). */
const jobBroker = () => createSingleAnswerPlanBroker({ brokerExtra: { startPlanEvidenceJob: async () => undefined } });
type Harness = Awaited<ReturnType<typeof createSingleAnswerPlanBroker>>;
type Row = { pk: string; sk: string; attempts: number; nextAttemptAt: number; dispatchDueSk: string; taskId: string; artifactId: string; artifactSha256: string };
type GetFile = PlanEvidenceRunDependencies["github"]["getFileAtCommit"];

const operations = (harness: Harness, workspaceId: string) => harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");
const taskRecord = (harness: Harness, taskId: string) => harness.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { workflow: WorkflowSnapshot; ownerKey: string; developerId: string };
const rows = (harness: Harness) => harness.db.find((item) => item.pk === "PLAN_EVIDENCE") as unknown as Row[];
const citing = (...paths: string[]) => planDocument({
  claims: paths.map((path, at) => ({ id: String(at + 1), text: `Claim ${at + 1}.`, evidence: [{ kind: "code" as const, path, startLine: 2, endLine: 3 }] })),
  decisions: [],
});

async function plannedTask(harness: Harness, paths = ["repo/demo/src/charge.ts"]) {
  const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Retry failed payments", client: "test-client", workflow: true, workflowPath: "QUICK" });
  const taskId = String((started.body.task as { taskId: string }).taskId);
  const workspaceId = String(taskRecord(harness, taskId).workspaceId);
  await harness.finish(workspaceId, String(operations(harness, workspaceId).find((item) => item.kind === "prepare")?.id), "SUCCEEDED", PREPARED);
  const active = operations(harness, workspaceId).find((item) => item.workflowMode === "PLAN" && item.status === "ACCEPTED")!;
  await harness.artifact(workspaceId, String(active.id), "plan.md", planAnswer(citing(...paths)));
  await harness.finish(workspaceId, String(active.id), "SUCCEEDED", { result: { workflowMode: "PLAN" } });
  const artifact = taskRecord(harness, taskId).workflow.artifacts.at(-1)!;
  return { taskId, workspaceId, artifact };
}

/** A clock the test moves; the job reads time only through it. */
const clock = (start = Date.now()) => { const state = { t: start }; return { state, now: () => state.t }; };

function jobDeps(harness: Harness, getFileAtCommit: GetFile, now: () => number = Date.now, extra: Partial<PlanEvidenceRunDependencies> = {}): PlanEvidenceRunDependencies {
  return { documentClient: harness.db as never, s3: harness.s3, tableName: "state", bucketName: "artifacts", github: { getFileAtCommit }, now, log: () => undefined, ...extra };
}
const pointerOf = (harness: Harness, taskId: string, artifactId: string) => harness.db.get(`DEVTASK#${taskId}`, `PLAN_EVIDENCE#${artifactId}`) as { objectKey: string; sha256: string } | undefined;
const bundleOf = (harness: Harness, taskId: string, artifactId: string) => JSON.parse(String(harness.s3.objects.get(pointerOf(harness, taskId, artifactId)!.objectKey))) as { excerpts: Array<Record<string, unknown>> };
const down: GetFile = async () => { throw new Error("GitHub is down"); };

describe("the PlanEvidence job", () => {
  it("reads the cited code at the task's base commit, attaches it beside the plan and deletes its row", async () => {
    const harness = await jobBroker();
    const { taskId, artifact } = await plannedTask(harness);
    expect(rows(harness)).toHaveLength(1);
    const getFileAtCommit = vi.fn<GetFile>(async () => FILE);
    const outcome = await runPlanEvidenceJob(jobDeps(harness, getFileAtCommit), { taskId, artifactId: artifact.id });
    expect(outcome).toBe("attached");
    expect(getFileAtCommit).toHaveBeenCalledWith("https://github.com/example/demo.git", "src/charge.ts", "e".repeat(40), { untilLine: 3, timeoutMs: 30_000 });
    expect(bundleOf(harness, taskId, artifact.id).excerpts).toEqual([expect.objectContaining({ claimId: "1", status: "ok", commit: "e".repeat(40), lines: ["two", "three"] })]);
    expect(pointerOf(harness, taskId, artifact.id)!.objectKey).toMatch(new RegExp(`^private/${taskRecord(harness, taskId).ownerKey}/.+/plan-documents/${artifact.id}\\.evidence\\.[0-9a-f]{64}\\.json$`));
    expect(rows(harness)).toEqual([]);
    // The plan itself is untouched: same revision, same digest.
    expect(taskRecord(harness, taskId).workflow.artifacts.at(-1)).toEqual(artifact);
    // The page shows the code.
    const view = await getTaskDocumentView(
      { documentClient: harness.db, tableName: "state", actions: harness.actions, checkAccess: async () => ({ revision: 1, policy: {} as never, access: "granted" as const, channelIds: [] }), projectChannelIds: async () => [], now: () => Date.now() },
      { developerId: taskRecord(harness, taskId).developerId } as never, taskId);
    expect(view.documents[0]).toMatchObject({ evidence: { excerpts: [{ status: "ok", lines: ["two", "three"] }] } });
  });

  it("schedules the next attempt after a GitHub failure: 1, 2, 4 then 8 minutes, moving the row's index key with it", async () => {
    const harness = await jobBroker();
    const { taskId, artifact } = await plannedTask(harness);
    const time = clock(rows(harness)[0]!.nextAttemptAt + 1_000);
    const event = { taskId, artifactId: artifact.id };
    for (const [attempts, minutes] of [[1, 1], [2, 2], [3, 4], [4, 8]] as const) {
      expect(await runPlanEvidenceJob(jobDeps(harness, down, time.now), event)).toBe("retry");
      const [row] = rows(harness);
      expect(row).toMatchObject({ attempts, nextAttemptAt: time.state.t + minutes * MINUTE, dispatchDueSk: `${planEvidenceDueKey(time.state.t + minutes * MINUTE)}#${taskId}#${artifact.id}` });
      expect(pointerOf(harness, taskId, artifact.id)).toBeUndefined();
      time.state.t = row!.nextAttemptAt;
    }
  });

  it("attaches a final bundle on the fifth attempt, unresolved places unavailable, and deletes the row", async () => {
    const harness = await jobBroker();
    const { taskId, artifact } = await plannedTask(harness, ["repo/demo/src/charge.ts", "repo/demo/src/missing.ts"]);
    // The first file is read on the last attempt; the second is not in the repository at all.
    const reads: string[] = [];
    const getFile: GetFile = async (_url, path) => { reads.push(path); if (path === "src/missing.ts") return undefined; throw new Error("GitHub is down"); };
    const row = rows(harness)[0]!;
    harness.db.set({ ...row, attempts: 4, nextAttemptAt: row.nextAttemptAt - 1 });
    expect(await runPlanEvidenceJob(jobDeps(harness, getFile), { taskId, artifactId: artifact.id })).toBe("attached");
    expect(bundleOf(harness, taskId, artifact.id).excerpts).toEqual([
      expect.objectContaining({ claimId: "1", status: "unavailable" }),
      expect.objectContaining({ claimId: "2", status: "not_found", commit: "e".repeat(40) }),
    ]);
    expect(rows(harness)).toEqual([]);
  });

  it("counts a thrown error as an attempt", async () => {
    const harness = await jobBroker();
    const { taskId, artifact } = await plannedTask(harness);
    const failing = { send: async (command: { constructor: { name: string } }) => { if (command.constructor.name === "PutObjectCommand") throw Object.assign(new Error("no space"), { name: "InternalServerError" }); return harness.s3.send(command as never); } };
    const time = clock(rows(harness)[0]!.nextAttemptAt + 1_000);
    expect(await runPlanEvidenceJob(jobDeps(harness, async () => FILE, time.now, { s3: failing }), { taskId, artifactId: artifact.id })).toBe("retry");
    expect(rows(harness)[0]).toMatchObject({ attempts: 1, nextAttemptAt: time.state.t + MINUTE });
    expect(pointerOf(harness, taskId, artifact.id)).toBeUndefined();
  });

  const allUnavailable = (harness: Harness, taskId: string, artifactId: string) => expect(bundleOf(harness, taskId, artifactId).excerpts).toEqual([expect.objectContaining({ claimId: "1", status: "unavailable" })]);

  it("attaches a bundle of unavailable places and deletes the row when the fifth run throws, and never runs a sixth", async () => {
    // The fifth run cannot even read the project.
    const harness = await jobBroker();
    const { taskId, artifact } = await plannedTask(harness);
    const getFile = vi.fn<GetFile>(async () => FILE);
    harness.db.set({ ...rows(harness)[0]!, attempts: 4 });
    harness.db.delete("PROJECT#payments", "REV#000000000001");
    expect(await runPlanEvidenceJob(jobDeps(harness, getFile), { taskId, artifactId: artifact.id })).toBe("attached");
    allUnavailable(harness, taskId, artifact.id);
    expect(rows(harness)).toEqual([]);
    expect(getFile).not.toHaveBeenCalled();
    expect(await runPlanEvidenceJob(jobDeps(harness, getFile), { taskId, artifactId: artifact.id })).toBe("no_job");

    // The fifth run reads the code but its attach fails once: the final bundle still goes in, with nothing resolved.
    const second = await jobBroker();
    const later = await plannedTask(second);
    let failures = 1;
    const flaky = { send: async (command: { constructor: { name: string } }) => { if (command.constructor.name === "PutObjectCommand" && failures-- > 0) throw new Error("no space"); return second.s3.send(command as never); } };
    second.db.set({ ...rows(second)[0]!, attempts: 4 });
    expect(await runPlanEvidenceJob(jobDeps(second, async () => FILE, Date.now, { s3: flaky }), { taskId: later.taskId, artifactId: later.artifact.id })).toBe("attached");
    allUnavailable(second, later.taskId, later.artifact.id);
    expect(rows(second)).toEqual([]);
  });

  it("finishes a row found at the fifth attempt (its run was cut off) without resolving, once it is due", async () => {
    const harness = await jobBroker();
    const { taskId, artifact } = await plannedTask(harness);
    const getFile = vi.fn<GetFile>(async () => FILE);
    const time = clock(rows(harness)[0]!.nextAttemptAt + 1_000);
    // Still inside the cut-off run's lease: left alone.
    harness.db.set({ ...rows(harness)[0]!, attempts: 5, nextAttemptAt: time.state.t + 100_000 });
    expect(await runPlanEvidenceJob(jobDeps(harness, getFile, time.now), { taskId, artifactId: artifact.id })).toBe("busy");
    expect(rows(harness)).toHaveLength(1);
    harness.db.set({ ...rows(harness)[0]!, attempts: 5, nextAttemptAt: time.state.t - 1 });
    expect(await runPlanEvidenceJob(jobDeps(harness, getFile, time.now), { taskId, artifactId: artifact.id })).toBe("attached");
    expect(getFile).not.toHaveBeenCalled();
    allUnavailable(harness, taskId, artifact.id);
    expect(rows(harness)).toEqual([]);
  });

  it("gives up with no bundle only when even the unavailable bundle cannot be saved, and still deletes the row", async () => {
    const harness = await jobBroker();
    const { taskId, artifact } = await plannedTask(harness);
    const broken = { send: async () => { throw new Error("S3 is down"); } };
    harness.db.set({ ...rows(harness)[0]!, attempts: 5, nextAttemptAt: 0 });
    expect(await runPlanEvidenceJob(jobDeps(harness, async () => FILE, Date.now, { s3: broken }), { taskId, artifactId: artifact.id })).toBe("gave_up");
    expect(rows(harness)).toEqual([]);
    expect(pointerOf(harness, taskId, artifact.id)).toBeUndefined();
  });

  it("never reads GitHub a sixth time: however many times the row is run, it reads at most five", async () => {
    const harness = await jobBroker();
    const { taskId, artifact } = await plannedTask(harness);
    const getFile = vi.fn<GetFile>(down);
    const time = clock(rows(harness)[0]!.nextAttemptAt + 1_000);
    for (let run = 0; run < 8; run += 1) {
      await runPlanEvidenceJob(jobDeps(harness, getFile, time.now), { taskId, artifactId: artifact.id });
      time.state.t += 10 * MINUTE;
    }
    expect(getFile).toHaveBeenCalledTimes(5);
    expect(rows(harness)).toEqual([]);
    allUnavailable(harness, taskId, artifact.id);
  });

  it("does not run a row that is not due or that another run holds, and two concurrent invocations read once", async () => {
    const harness = await jobBroker();
    const { taskId, artifact } = await plannedTask(harness);
    const event = { taskId, artifactId: artifact.id };
    const time = clock(rows(harness)[0]!.nextAttemptAt + 1_000);
    expect(await runPlanEvidenceJob(jobDeps(harness, down, time.now), event)).toBe("retry");
    // Waiting out its backoff: nothing is read.
    const untouched = vi.fn<GetFile>(async () => FILE);
    expect(await runPlanEvidenceJob(jobDeps(harness, untouched, time.now), event)).toBe("busy");
    expect(untouched).not.toHaveBeenCalled();
    expect(rows(harness)[0]).toMatchObject({ attempts: 1 });
    // Due again: two invocations race; one reads and attaches, the other finds the row held.
    time.state.t = rows(harness)[0]!.nextAttemptAt;
    const getFileAtCommit = vi.fn<GetFile>(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); return FILE; });
    const outcomes = await Promise.all([runPlanEvidenceJob(jobDeps(harness, getFileAtCommit, time.now), event), runPlanEvidenceJob(jobDeps(harness, getFileAtCommit, time.now), event)]);
    expect([...outcomes].sort()).toEqual(["attached", "busy"]);
    expect(getFileAtCommit).toHaveBeenCalledTimes(1);
    expect(rows(harness)).toEqual([]);
  });

  it("holds a running row for longer than the Lambda can run, so the sweep leaves it alone", async () => {
    const harness = await jobBroker();
    const { taskId, artifact } = await plannedTask(harness);
    const time = clock(rows(harness)[0]!.nextAttemptAt + 1_000);
    let during: Row | undefined;
    await runPlanEvidenceJob(jobDeps(harness, async () => { during = rows(harness)[0]; return FILE; }, time.now), { taskId, artifactId: artifact.id });
    expect(during).toMatchObject({ attempts: 1 });
    expect(during!.nextAttemptAt).toBeGreaterThan(time.state.t + 150_000);
    expect(during!.dispatchDueSk.startsWith(planEvidenceDueKey(during!.nextAttemptAt))).toBe(true);
  });

  it("gives each file read what is left of the 120 second limit, and at most 30 seconds", async () => {
    const harness = await jobBroker();
    const paths = ["a", "b", "c", "d", "e"].map((name) => `repo/demo/src/${name}.ts`);
    const { taskId, artifact } = await plannedTask(harness, paths);
    const time = clock(rows(harness)[0]!.nextAttemptAt + 1_000);
    const timeouts: number[] = [];
    await runPlanEvidenceJob(jobDeps(harness, async (_url, _path, _commit, options) => {
      timeouts.push(options.timeoutMs ?? -1);
      // The first read takes 100 seconds, so the rest have 20 seconds left.
      if (timeouts.length === 1) time.state.t += 100_000;
      return FILE;
    }, time.now), { taskId, artifactId: artifact.id });
    expect(timeouts[0]).toBe(30_000);
    expect(timeouts.slice(1)).toEqual([20_000, 20_000, 20_000, 20_000]);
  });

  it("deletes the row and attaches nothing for a closed task, a missing or replaced plan, or evidence already attached", async () => {
    const attached = vi.fn<GetFile>(async () => FILE);
    const cases: Array<[string, (harness: Harness, taskId: string, artifactId: string) => void]> = [
      ["closed", (harness, taskId) => harness.db.set({ ...taskRecord(harness, taskId), closedAt: new Date().toISOString() })],
      ["artifact gone", (harness, taskId) => harness.db.set({ ...taskRecord(harness, taskId), workflow: { ...taskRecord(harness, taskId).workflow, artifacts: [] } })],
      ["plan replaced", (harness, taskId) => harness.db.set({ ...taskRecord(harness, taskId), workflow: { ...taskRecord(harness, taskId).workflow, artifacts: taskRecord(harness, taskId).workflow.artifacts.map((entry) => ({ ...entry, sha256: "0".repeat(64) })) } })],
      ["task gone", (harness, taskId) => harness.db.delete(`DEVTASK#${taskId}`, "META")],
    ];
    for (const [label, change] of cases) {
      const harness = await jobBroker();
      const { taskId, artifact } = await plannedTask(harness);
      change(harness, taskId, artifact.id);
      expect(await runPlanEvidenceJob(jobDeps(harness, attached), { taskId, artifactId: artifact.id }), label).toBe("skipped");
      expect(rows(harness), label).toEqual([]);
      expect(pointerOf(harness, taskId, artifact.id), label).toBeUndefined();
    }
    expect(attached).not.toHaveBeenCalled();
    // Evidence attached before (by an earlier run): the row goes and nothing is read.
    const harness = await jobBroker();
    const { taskId, artifact } = await plannedTask(harness);
    expect(await runPlanEvidenceJob(jobDeps(harness, async () => FILE), { taskId, artifactId: artifact.id })).toBe("attached");
    harness.db.set({ pk: "PLAN_EVIDENCE", sk: `${taskId}#${artifact.id}`, taskId, artifactId: artifact.id, artifactSha256: artifact.sha256, attempts: 0, nextAttemptAt: 0, dispatchDuePk: "PLAN_EVIDENCE", dispatchDueSk: "0" });
    expect(await runPlanEvidenceJob(jobDeps(harness, attached), { taskId, artifactId: artifact.id })).toBe("already");
    expect(rows(harness)).toEqual([]);
    expect(attached).not.toHaveBeenCalled();
    expect(await runPlanEvidenceJob(jobDeps(harness, attached), { taskId, artifactId: artifact.id })).toBe("no_job");
  });

  it("logs a retry with the error's name and no plan text", async () => {
    const harness = await jobBroker();
    const { taskId, artifact } = await plannedTask(harness);
    const lines: Array<Record<string, unknown>> = [];
    await runPlanEvidenceJob(jobDeps(harness, down, Date.now, { log: (entry) => lines.push(entry) }), { taskId, artifactId: artifact.id });
    expect(lines).toEqual([{ event: "plan_evidence.retry", taskId, artifactId: artifact.id, attempt: 1, reason: "unavailable" }]);
  });
});

describe("a deployment with no PlanEvidence function", () => {
  it("queues no job row and reads the cited code inside the plan callback, attaching it through the same pointer", async () => {
    const getFileAtCommit = vi.fn(async () => FILE);
    const harness = await createSingleAnswerPlanBroker({ brokerExtra: { githubPullRequests: { getFileAtCommit } } });
    const { taskId, artifact } = await plannedTask(harness);
    expect(rows(harness)).toEqual([]);
    expect(getFileAtCommit).toHaveBeenCalledWith("https://github.com/example/demo.git", "src/charge.ts", "e".repeat(40), { untilLine: 3 });
    expect(taskRecord(harness, taskId).workflow).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
    expect(taskRecord(harness, taskId).workflow.artifacts.at(-1)).toEqual(artifact);
    expect(artifact).not.toHaveProperty("evidence");
    expect(bundleOf(harness, taskId, artifact.id).excerpts).toEqual([expect.objectContaining({ claimId: "1", status: "ok", lines: ["two", "three"] })]);
    // The page reads it as it reads a job's bundle.
    const view = await getTaskDocumentView(
      { documentClient: harness.db, tableName: "state", actions: harness.actions, checkAccess: async () => ({ revision: 1, policy: {} as never, access: "granted" as const, channelIds: [] }), projectChannelIds: async () => [], now: () => Date.now() },
      { developerId: taskRecord(harness, taskId).developerId } as never, taskId);
    expect(view.documents[0]).toMatchObject({ evidence: { excerpts: [{ status: "ok", lines: ["two", "three"] }] } });
  });

  it("stores the plan with its places unavailable when GitHub cannot be read, and still leaves no job row", async () => {
    const harness = await createSingleAnswerPlanBroker({ brokerExtra: { githubPullRequests: { getFileAtCommit: down } } });
    const { taskId, artifact } = await plannedTask(harness);
    expect(taskRecord(harness, taskId).workflow).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
    expect(rows(harness)).toEqual([]);
    expect(bundleOf(harness, taskId, artifact.id).excerpts).toEqual([expect.objectContaining({ claimId: "1", status: "unavailable" })]);
  });

  it("reads nothing in the callback when the evidence job is configured", async () => {
    const getFileAtCommit = vi.fn(async () => FILE);
    const harness = await createSingleAnswerPlanBroker({ brokerExtra: { startPlanEvidenceJob: async () => undefined, githubPullRequests: { getFileAtCommit } } });
    const { taskId, artifact } = await plannedTask(harness);
    expect(getFileAtCommit).not.toHaveBeenCalled();
    expect(pointerOf(harness, taskId, artifact.id)).toBeUndefined();
    expect(rows(harness)).toHaveLength(1);
  });
});

describe("starting the PlanEvidence job from the broker", () => {
  it("starts the job once, with the task and artifact, right after the plan commits; no job for a plan that cites no code", async () => {
    const start = vi.fn(async () => undefined);
    const harness = await createSingleAnswerPlanBroker({ brokerExtra: { startPlanEvidenceJob: start } });
    const { taskId, artifact } = await plannedTask(harness);
    expect(start.mock.calls).toEqual([[{ source: PLAN_EVIDENCE_EVENT_SOURCE, taskId, artifactId: artifact.id }]]);
    const none = vi.fn(async () => undefined);
    const quiet = await createSingleAnswerPlanBroker({ brokerExtra: { startPlanEvidenceJob: none } });
    const started = await quiet.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Retry failed payments", client: "test-client", workflow: true, workflowPath: "QUICK" });
    const quietTask = String((started.body.task as { taskId: string }).taskId);
    const workspaceId = String(taskRecord(quiet, quietTask).workspaceId);
    await quiet.finish(workspaceId, String(operations(quiet, workspaceId).find((item) => item.kind === "prepare")?.id), "SUCCEEDED", PREPARED);
    const active = operations(quiet, workspaceId).find((item) => item.workflowMode === "PLAN" && item.status === "ACCEPTED")!;
    await quiet.artifact(workspaceId, String(active.id), "plan.md", planAnswer(planDocument({ claims: [{ id: "1", text: "A claim." }], decisions: [] })));
    await quiet.finish(workspaceId, String(active.id), "SUCCEEDED", { result: { workflowMode: "PLAN" } });
    expect(taskRecord(quiet, quietTask).workflow).toMatchObject({ stage: "PLAN_REVIEW" });
    expect(none).not.toHaveBeenCalled();
  });

  it("still stores the plan when the job cannot be started, and the recovery sweep starts the row later", async () => {
    const start = vi.fn<() => Promise<void>>(async () => { throw new Error("lambda unavailable"); });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const harness = await createSingleAnswerPlanBroker({ brokerExtra: { startPlanEvidenceJob: start } });
      const { taskId, artifact } = await plannedTask(harness);
      expect(taskRecord(harness, taskId).workflow).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
      expect(rows(harness)).toHaveLength(1);
      expect(log.mock.calls.some(([line]) => String(line).includes("plan_evidence.start_failed"))).toBe(true);
      start.mockReset();
      start.mockImplementation(async () => undefined);
      const answer = await harness.handler({ source: "agentx.workflow-dispatch-recovery" });
      expect(answer.statusCode).toBe(200);
      expect(JSON.parse(answer.body)).toMatchObject({ attempted: 0, dispatched: 0, planEvidence: { attempted: 1, started: 1 } });
      expect(start.mock.calls).toEqual([[{ source: PLAN_EVIDENCE_EVENT_SOURCE, taskId, artifactId: artifact.id }]]);
    } finally {
      log.mockRestore();
    }
  });

  it("sweeps due rows only: a row waiting out a backoff or held by a running job is left alone, and at most 25 are started", async () => {
    const start = vi.fn(async () => undefined);
    const harness = await createSingleAnswerPlanBroker({ brokerExtra: { startPlanEvidenceJob: start } });
    const row = (n: number, at: number) => ({ pk: "PLAN_EVIDENCE", sk: `t${n}#a${n}`, entityType: "PLAN_EVIDENCE", taskId: `t${n}`, artifactId: `a${n}`, artifactSha256: "b".repeat(64), attempts: 0,
      nextAttemptAt: at, dispatchDuePk: "PLAN_EVIDENCE", dispatchDueSk: `${planEvidenceDueKey(at)}#t${n}#a${n}` });
    const now = Date.now();
    harness.db.set(row(1, now - 5_000));
    harness.db.set(row(2, now + 60_000));
    harness.db.set(row(3, now + 180_000));
    const sweep = async () => JSON.parse((await harness.handler({ source: "agentx.workflow-dispatch-recovery" })).body) as { planEvidence: { attempted: number; started: number } };
    expect(await sweep()).toMatchObject({ planEvidence: { attempted: 1, started: 1 } });
    expect(start.mock.calls).toEqual([[{ source: PLAN_EVIDENCE_EVENT_SOURCE, taskId: "t1", artifactId: "a1" }]]);
    // Dispatch rows share the index under their own partition and are never read as evidence rows.
    start.mockClear();
    for (let n = 10; n < 45; n += 1) harness.db.set(row(n, now - 10_000 + n));
    expect((await sweep()).planEvidence).toEqual({ attempted: 25, started: 25 });
    expect(start).toHaveBeenCalledTimes(25);
  });
});
