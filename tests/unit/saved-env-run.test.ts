// SI-2 (saved images step 2): the rebuild as an ordinary SYSTEM RUN. The real system starter and the real rebuild start over the task-flow harness: the install flag and the company's consent are its gate (the
// project's upkeep switch is never read), a place of the project's monthly count is its cap, the audit record comes first, its machine time is attributed, its machine is admitted when the dispatcher starts it, and
// it is watched and closed like every preparation. Each guard has a test that fails if the guard is removed (the mutants are in MUTANTS.md).
import { describe, expect, it, vi } from "vitest";
import {
  INDEX_EXPIRY_ATTRIBUTE, SAVED_ENV_BUILD_WATCH_MS, SAVED_ENV_COMPANY_SLOTS, SAVED_ENV_INSTALL_SLOTS, SAVED_ENV_JOB_LEASE_MS, WORKER_INVOCATION_FEATURES, WORKSPACE_PROJECT_INDEX, change, projectMetaKey, projectPk, queryAll, systemOwnerIdOf,
  workspaceProjectIndexValue, type Admission, type AuditEvent, type OrgId,
} from "@agentx/contracts";
import { readAutomaticRunsUse, setAutomaticRunsCap } from "../../packages/broker/src/core/automatic-runs/cap.js";
import { closeSetupCheck, setupCheckRecordKey, startProjectSetupCheck } from "../../packages/broker/src/core/setup-agent/check.js";
import { createSystemStarter, type SystemStartInput, type SystemStartResult } from "../../packages/broker/src/core/system-runs/starter.js";
import { effectiveSystemRunsGate, systemRunsConsentKey } from "../../packages/broker/src/core/system-runs/consent.js";
import { readSystemRunUsage } from "../../packages/broker/src/core/system-runs/usage.js";
import { createHostedSystemRuns } from "../../packages/broker/src/core-host/system-runs.js";
import { parseCoreSwitch } from "../../packages/broker/src/core-host/flags.js";
import { workspaceKey, operationKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { legacyWorkspaceKey } from "../../packages/broker/src/core/task-flow/legacy-keys.js";
import { CHECK_STALLED_MESSAGE, PREPARATION_TIMEOUT_MS, prepareWatchKey } from "../../packages/broker/src/core/task-flow/prepare-watch.js";
import { stopWorkspaceAsAdministrator } from "../../packages/broker/src/core/task-flow/stop-request.js";
import type { OperationRecord, WorkspaceRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { checkRebuild, type RebuildJob } from "../../packages/broker/src/core/test-env/saved-env.js";
import { savedEnvLeaseContext } from "../../packages/broker/src/core/test-env/saved-env-operations.js";
import { savedEnvPushLoginCore, savedEnvResultCore } from "../../packages/broker/src/core/test-env/saved-env-lease.js";
import { createSavedEnvRebuildRun, savedEnvStartKey } from "../../packages/broker/src/core/test-env/saved-env-run.js";
import { startSavedEnvRebuild } from "../../packages/broker/src/core/test-env/saved-env-rebuild.js";
import { savedEnvRowKey } from "../../packages/broker/src/core/test-env/saved-env-store.js";
import { companySlotKey, installSlotKey, pickSlots, releaseSlots, slotClaimItems } from "../../packages/broker/src/core/test-env/saved-env-slots.js";
import { taskOwnerKey } from "../../packages/broker/src/developer/task-records.js";
import { BASE_IMAGE, COMPANY, HEAD, PROJECT, approve, environmentBody, savedWorld, type SavedWorld } from "../support/saved-env-harness.js";
import { newRequestId } from "../support/task-flow-harness.js";

// The real resume is replaced by a spy: the tests below look at whether a rebuild's close ever calls it (it must not), and that a project's own check's close still does.
const resumed = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("../../packages/broker/src/core/setup-agent/auto-resume.js", () => ({ resumeSetupPausedTasks: async (...args: unknown[]) => { resumed.calls.push(args); return 0; } }));

const ids = { orgId: COMPANY, projectId: PROJECT };
const ON = { ROVARA_SAVED_ENVIRONMENTS: "1" };
const OTHER_COMPANY: OrgId = "org_bbbbbbbbbbbbbbbbbbbb";
const PERSON = "ab".repeat(32);

interface World extends SavedWorld { starter: ReturnType<typeof createSystemStarter>; gate: { ceiling: boolean }; upkeepReads: { count: number }; job: RebuildJob; audit: AuditEvent[]; order: string[]; run: ReturnType<typeof createSavedEnvRebuildRun> }

/** A project with an approved environment and a QUEUED rebuild job (the older start, which `onQueued` would make, is left out so the job waits for the system starter). */
async function world(options: { consent?: boolean; ceiling?: boolean; admission?: Admission; queue?: boolean; inputs?: boolean; withRebuild?: boolean } = {}): Promise<World> {
  const w = savedWorld({ harness: { audit: "recording", machines: { startingChecks: 0, features: [...WORKER_INVOCATION_FEATURES] }, ...(options.admission === undefined ? {} : { admission: options.admission }) } });
  delete w.deps.onQueued;
  await w.h.registerProject();
  await approve(w.test, environmentBody());
  if (options.queue !== false) {
    const queued = await checkRebuild(w.deps, ids, "push");
    if (!queued.ok || !queued.queued) throw new Error(`not queued: ${JSON.stringify(queued)}`);
  }
  const gate = { ceiling: options.ceiling ?? true };
  if (options.consent !== false) await w.h.store.put({ item: { ...systemRunsConsentKey(COMPANY), entityType: "SYSTEM_RUNS_CONSENT", orgId: COMPANY, enabled: true } });
  const effective = effectiveSystemRunsGate({ ceiling: () => gate.ceiling, store: w.h.store, companyId: COMPANY });
  const upkeepReads = { count: 0 };
  const order: string[] = [];
  const job = (await w.deps.store.get(COMPANY, PROJECT))?.job as RebuildJob;
  // What the world looked like when the audit sink was asked to record the start: the audit record must come BEFORE the start record, the workspace and the slots exist.
  const record = w.h.deps.audit.record.bind(w.h.deps.audit);
  w.h.deps.audit.record = async (event) => {
    if (event.action === "system_run.requested") order.push(`at-audit:start=${(await w.h.store.get(savedEnvStartKey(COMPANY, job?.jobId ?? "none"))) === undefined ? "absent" : "present"}:slot=${(await w.h.store.get(companySlotKey(COMPANY, 0))) === undefined ? "absent" : "present"}`);
    await record(event);
  };
  const inputs = options.inputs === false ? async () => undefined : async () => ({ baseImageDigest: BASE_IMAGE, secretNames: [], detectorGlobs: [] });
  const run = createSavedEnvRebuildRun({ flow: w.h.deps, saved: w.deps, test: w.test, inputs, env: ON });
  const starter = createSystemStarter({ flow: w.h.deps, enabled: () => effective.enabled(), upkeepOn: async () => { upkeepReads.count += 1; return false; }, ...(options.withRebuild === false ? {} : { rebuild: run }) });
  return Object.assign(w, { starter, gate, upkeepReads, job, audit: w.h.audit, order, run });
}

const ask = (w: World, input: Partial<SystemStartInput> = {}): Promise<SystemStartResult> => w.starter.start({ project: PROJECT, kind: "saved_env_rebuild", reason: { code: "image_out_of_date", fact: "key_changed" }, requestId: newRequestId(), ...input });
const used = async (w: World): Promise<number> => (await readAutomaticRunsUse({ store: w.h.store, now: () => w.h.clock.now }, COMPANY, PROJECT)).used;
const requested = (w: World): AuditEvent[] => w.audit.filter((event) => event.action === "system_run.requested");
const queued = async (w: World): Promise<number> => {
  const queue = await w.h.queues.queue("task-dispatch");
  let total = 0;
  for (let round = 0; round < 20; round += 1) { const batch = await queue.receive(); if (batch.length === 0) break; total += batch.length; }
  return total;
};
const startRecord = (w: World) => w.h.store.get(savedEnvStartKey(COMPANY, w.job?.jobId ?? "no-job"));
const systemAudit = (w: World): AuditEvent[] => w.audit.filter((event) => event.action.startsWith("system_run."));
/** Nothing of a start exists: no start record, no slot, no audit record, no place of the month, no message, no usage row. */
async function expectNothingStarted(w: World): Promise<void> {
  expect(await startRecord(w)).toBeUndefined();
  for (let index = 0; index < SAVED_ENV_COMPANY_SLOTS; index += 1) expect(await w.h.store.get(companySlotKey(COMPANY, index))).toBeUndefined();
  for (let index = 0; index < SAVED_ENV_INSTALL_SLOTS; index += 1) expect(await w.h.store.get(installSlotKey(index))).toBeUndefined();
  expect(systemAudit(w)).toHaveLength(0);
  expect(await used(w)).toBe(0);
  expect(await queued(w)).toBe(0);
  expect((await readSystemRunUsage(w.h.deps, {})).runs).toBe(0);
}
const workspaceOf = async (w: World, id: string) => (await w.h.store.get(workspaceKey(COMPANY, id))) as unknown as WorkspaceRecord;
const operationOf = async (w: World, workspaceId: string, operationId: string) => (await w.h.store.get(operationKey(COMPANY, workspaceId, operationId))) as unknown as OperationRecord;

describe("the gate: the install flag and the company's consent, and nothing at project level", () => {
  it("the install flag off: refused, and nothing is read for the project or written", async () => {
    const w = await world({ ceiling: false });
    expect(await ask(w)).toEqual({ outcome: "refused", reason: "system_runs_off" });
    await expectNothingStarted(w);
  });

  it("the company's consent off: refused, and nothing is written (a ceiling alone gives no consent)", async () => {
    const w = await world({ consent: false });
    expect(await ask(w)).toEqual({ outcome: "refused", reason: "system_runs_off" });
    await expectNothingStarted(w);
  });

  it("CONSENT ON WITH UPKEEP OFF STARTS, and the store sees no read of the project's upkeep switch for this kind", async () => {
    const w = await world();
    expect(await ask(w)).toMatchObject({ outcome: "started", kind: "saved_env_rebuild", duplicate: false });
    expect(w.upkeepReads.count).toBe(0);
  });

  it("the same project's nightly check is still refused with upkeep off (the two locks stay for every other kind)", async () => {
    const w = await world();
    expect(await ask(w, { kind: "nightly_check", reason: { code: "nightly" } })).toEqual({ outcome: "refused", reason: "upkeep_off" });
    expect(w.upkeepReads.count).toBe(1);
    expect(systemAudit(w)).toHaveLength(0);
  });

  it("a starter with no rebuild start refuses the kind before anything is read or written (the kind stays inert until a deployment gives it one)", async () => {
    const w = await world({ withRebuild: false });
    expect(await ask(w)).toEqual({ outcome: "refused", reason: "kind_not_allowed" });
    expect(w.upkeepReads.count).toBe(0);
    await expectNothingStarted(w);
  });

  it("the hosted starter (createHostedSystemRuns) has no rebuild start in this release: the kind is refused and writes no usage row and no audit record", async () => {
    const w = await world();
    const hosted = createHostedSystemRuns({ flow: w.h.flow, companyId: COMPANY, flag: parseCoreSwitch("on").value, now: () => w.h.clock.now })!;
    expect(await hosted.starter.start({ project: PROJECT, kind: "saved_env_rebuild", reason: { code: "image_out_of_date" }, requestId: newRequestId() })).toEqual({ outcome: "refused", reason: "kind_not_allowed" });
    await expectNothingStarted(w);
  });
});

describe("a start", () => {
  it("makes a read-only pinned preparation as the system owner, watched, with its close record, its start record and its slots, and leaves the registry row and the project's setup mark alone", async () => {
    const w = await world();
    const rowBefore = await w.deps.store.get(COMPANY, PROJECT);
    const answer = await ask(w);
    expect(answer.outcome).toBe("started");
    const { workspaceId } = answer as { workspaceId: string };
    const workspace = await workspaceOf(w, workspaceId);
    const operationId = workspace.activeOperationId!;
    // The system owner, and in no list: no project index attributes, no task.
    expect(workspace.ownerKey).toBe(taskOwnerKey(systemOwnerIdOf(COMPANY, PROJECT), workspaceId));
    expect(workspace.ownerKey).not.toBe(taskOwnerKey(PERSON, workspaceId));
    expect(workspace).toMatchObject({ status: "PREPARING", projectName: PROJECT });
    expect((workspace as unknown as Record<string, unknown>)[WORKSPACE_PROJECT_INDEX.partitionKey]).toBeUndefined();
    expect((await w.h.store.queryIndex({ index: WORKSPACE_PROJECT_INDEX.name, partition: workspaceProjectIndexValue(COMPANY, PROJECT), limit: 50 })).items).toHaveLength(0);
    expect(await queryAll(w.h.store, { pk: `DEVTASK#${workspaceId}` })).toHaveLength(0);
    // The preparation: read only, pinned to the job's commits, the job in its payload, never the lease token, the two actions and the feature.
    const operation = await operationOf(w, workspaceId, operationId);
    const dispatch = operation.dispatch as unknown as { kind: string; requires: string[]; extraActions: string[]; payload: { readOnly: boolean; pins: unknown; savedEnvBuild: { jobId: string; commits: unknown } } };
    expect(dispatch).toMatchObject({ kind: "prepare", requires: ["prepare.savedEnvBuild.v1"], extraActions: ["saved-env-push-login", "saved-env-result"], payload: { readOnly: true, pins: [{ repository: "demo", commit: HEAD }], savedEnvBuild: { jobId: w.job.jobId, commits: { demo: HEAD } } } });
    expect(JSON.stringify(operation)).not.toContain(w.job.leaseToken);
    expect(await queued(w)).toBe(1);
    // Watched with the rebuild's own limit, which is shorter than the job's lease; the close record carries the purpose.
    const watch = await w.h.store.get(prepareWatchKey(COMPANY, workspace.createdAt, workspaceId));
    expect(watch).toMatchObject({ workspaceId, operationId, limitMs: SAVED_ENV_BUILD_WATCH_MS });
    expect(watch?.["taskId"]).toBeUndefined();
    expect(SAVED_ENV_BUILD_WATCH_MS).toBeLessThan(SAVED_ENV_JOB_LEASE_MS);
    expect(await w.h.store.get(setupCheckRecordKey(COMPANY, workspaceId))).toMatchObject({ entityType: "SETUP_CHECK", project: PROJECT, purpose: "saved_env_rebuild", candidate: false });
    // One start per job: the start record names the run and the request; the slots are held by the job id.
    expect(await startRecord(w)).toMatchObject({ entityType: "SAVED_ENV_START", orgId: COMPANY, project: PROJECT, jobId: w.job.jobId, workspaceId, operationId });
    expect(await w.h.store.get(companySlotKey(COMPANY, 0))).toMatchObject({ jobId: w.job.jobId, orgId: COMPANY, project: PROJECT, leaseUntil: new Date(w.h.clock.now + SAVED_ENV_JOB_LEASE_MS).toISOString() });
    expect(await w.h.store.get(installSlotKey(0))).toMatchObject({ jobId: w.job.jobId, orgId: COMPANY });
    // The project's setup state is never changed by a rebuild; the registry row is exactly as it was (a release that reads it strictly still can).
    expect((await w.h.store.get(projectMetaKey(COMPANY, PROJECT)))?.["setupCheck"]).toBeUndefined();
    expect(await w.deps.store.get(COMPANY, PROJECT)).toEqual(rowBefore);
  });

  it("M1: the place of the month is written as an IMAGE REBUILD (the claim row names the job), not as a nightly or a check", async () => {
    const w = await world();
    const requestId = newRequestId();
    expect((await ask(w, { requestId })).outcome).toBe("started");
    expect(await w.h.store.get({ pk: projectPk(COMPANY, PROJECT), sk: `AUTOMATIC_RUNS#RUN#${requestId}` })).toMatchObject({ entityType: "AUTOMATIC_RUN_CLAIM", job: "image_rebuild", project: PROJECT, requestId });
  });

  it("M2: the start record expires 30 days after the start and each slot row a day after its lease (the attribute itself is read, not the file's place in an allow-list)", async () => {
    const w = await world();
    expect((await ask(w)).outcome).toBe("started");
    const nowSeconds = Math.floor(w.h.clock.now / 1000);
    expect((await startRecord(w))?.[INDEX_EXPIRY_ATTRIBUTE]).toBe(nowSeconds + 30 * 86_400);
    const slotExpiry = nowSeconds + Math.floor(SAVED_ENV_JOB_LEASE_MS / 1000) + 86_400;
    expect((await w.h.store.get(companySlotKey(COMPANY, 0)))?.[INDEX_EXPIRY_ATTRIBUTE]).toBe(slotExpiry);
    expect((await w.h.store.get(installSlotKey(0)))?.[INDEX_EXPIRY_ATTRIBUTE]).toBe(slotExpiry);
  });

  it("S6: the rebuild's workspace, its pointer and its operation (which holds the approved environment) expire after 62 days, as long as the usage rows that meter it", async () => {
    const w = await world();
    const { workspaceId } = (await ask(w)) as { workspaceId: string };
    const operationId = (await workspaceOf(w, workspaceId)).activeOperationId!;
    const expiry = Math.floor(w.h.clock.now / 1000) + 62 * 86_400;
    expect((await w.h.store.get(workspaceKey(COMPANY, workspaceId)))?.[INDEX_EXPIRY_ATTRIBUTE]).toBe(expiry);
    expect((await w.h.store.get(operationKey(COMPANY, workspaceId, operationId)))?.[INDEX_EXPIRY_ATTRIBUTE]).toBe(expiry);
    expect((await w.h.store.get(legacyWorkspaceKey(workspaceId)))?.[INDEX_EXPIRY_ATTRIBUTE]).toBe(expiry);
  });

  it("writes the audit record FIRST, as the system owner, with the fixed reason; the machine time is attributed to the company as a rebuild", async () => {
    const w = await world();
    await ask(w);
    expect(w.order).toEqual(["at-audit:start=absent:slot=absent"]);
    expect(requested(w)).toHaveLength(1);
    expect(requested(w)[0]).toMatchObject({ actor: { type: "system", id: systemOwnerIdOf(COMPANY, PROJECT) }, subject: { type: "project", id: PROJECT }, details: { kind: "saved_env_rebuild", reason: "image_out_of_date", fact: "key_changed" } });
    const usage = await readSystemRunUsage(w.h.deps, {});
    expect(usage.byKind).toEqual({ saved_env_rebuild: { runs: 1, minutes: 0 } });
    expect(usage.byProject[PROJECT]!.runs).toBe(1);
  });

  it("starts nothing, takes no slot and gives its place of the month back, when the audit record cannot be written", async () => {
    const w = await world();
    w.h.deps.audit.record = async () => { throw new Error("the ledger is down"); };
    expect(await ask(w)).toEqual({ outcome: "refused", reason: "audit_unavailable" });
    expect(await startRecord(w)).toBeUndefined();
    expect(await w.h.store.get(companySlotKey(COMPANY, 0))).toBeUndefined();
    expect(await used(w)).toBe(0);
    expect(await queued(w)).toBe(0);
  });

  it("is held by the project's monthly count of automatic runs: the place is taken (counted as an image rebuild), and at the cap nothing starts and nothing is written", async () => {
    const w = await world();
    expect((await ask(w)).outcome).toBe("started");
    expect(await used(w)).toBe(1);
    const capped = await world();
    await setAutomaticRunsCap({ store: capped.h.store, now: () => capped.h.clock.now, companyId: COMPANY, audit: capped.h.deps.audit }, { orgId: COMPANY, project: PROJECT, changedBy: PERSON, cap: 0, requestId: "cap-request-0" });
    expect(await ask(capped)).toEqual({ outcome: "skipped", reason: "automatic_cap" });
    await expectNothingStarted(capped);
  });

  it("S4: waits while the project's own setup check runs (busy), and does so BEFORE the cap place is taken: no claim is ever written, nothing is audited", async () => {
    const w = await world();
    await w.h.store.put({ item: { ...projectMetaKey(COMPANY, PROJECT), entityType: "PROJECT_META" } });
    await startProjectSetupCheck(w.h.deps, { project: PROJECT, requestId: newRequestId(), startedBy: PERSON });
    const real = w.h.store.transact.bind(w.h.store);
    let claims = 0;
    w.h.store.transact = async (items) => { if (items.some((item) => item.kind === "put" && item.item["entityType"] === "AUTOMATIC_RUN_CLAIM")) claims += 1; return real(items); };
    const before = systemAudit(w).length;
    expect(await ask(w)).toEqual({ outcome: "skipped", reason: "busy" });
    expect(claims).toBe(0);
    expect(systemAudit(w)).toHaveLength(before);
    expect(await startRecord(w)).toBeUndefined();
    expect(await used(w)).toBe(0);
  });

  it("answers a repeat of the request id with the first start: one workspace, one slot pair, counted once, audited once, one usage row", async () => {
    const w = await world();
    const requestId = newRequestId();
    const first = await ask(w, { requestId });
    const again = await ask(w, { requestId });
    expect(first).toMatchObject({ outcome: "started", duplicate: false });
    expect(again).toMatchObject({ outcome: "started", duplicate: true, workspaceId: (first as { workspaceId: string }).workspaceId });
    expect(await used(w)).toBe(1);
    expect(new Set(requested(w).map((event) => event.eventId)).size).toBe(1);
    expect((await readSystemRunUsage(w.h.deps, {})).runs).toBe(1);
    expect(await queued(w)).toBe(1);
  });

  it("a start record that names another company is never taken as this company's start (and is not a repeat of this request either)", async () => {
    const w = await world();
    const requestId = newRequestId();
    await w.h.store.put({ item: { ...savedEnvStartKey(COMPANY, w.job.jobId), entityType: "SAVED_ENV_START", orgId: OTHER_COMPANY, project: PROJECT, jobId: w.job.jobId, workspaceId: "w-forged", operationId: "o-forged", requestId, createdAt: new Date(w.h.clock.now).toISOString() } });
    expect(await w.run.precheck(PROJECT, requestId)).toBe("already_started");
    expect(await w.run.start(PROJECT, requestId)).toEqual({ started: false, why: "already_started" });
    expect(await queued(w)).toBe(0);
  });

  it("the start record is put only while absent: another start's record that lands between the reads and the write refuses this one (the marker alone is not what holds)", async () => {
    const w = await world();
    const real = w.h.store.transact.bind(w.h.store);
    let landed = false;
    w.h.store.transact = async (items) => {
      if (!landed && items[0]?.kind === "check") { landed = true; await w.h.store.put({ item: { ...savedEnvStartKey(COMPANY, w.job.jobId), entityType: "SAVED_ENV_START", orgId: COMPANY, project: PROJECT, jobId: w.job.jobId, workspaceId: "w-other", operationId: "o-other", requestId: newRequestId(), createdAt: new Date(w.h.clock.now).toISOString() } }); }
      return real(items);
    };
    expect(await w.run.start(PROJECT, newRequestId())).toEqual({ started: false, why: "already_started" });
    expect(await queued(w)).toBe(0);
    expect(await w.h.store.get(companySlotKey(COMPANY, 0))).toBeUndefined();
  });

  it("S3a: two starts of one job with the SAME request id at once make one run, and the one that lost the start-record race answers it as a repeat (the first run's ids)", async () => {
    const w = await world();
    const requestId = newRequestId();
    const [a, b] = await Promise.all([w.run.start(PROJECT, requestId), w.run.start(PROJECT, requestId)]);
    expect(a.started && b.started).toBe(true);
    const answers = [a, b] as Array<Extract<typeof a, { started: true }>>;
    expect(answers.map((answer) => answer.duplicate).sort()).toEqual([false, true]);
    expect(answers[0]!.workspaceId).toBe(answers[1]!.workspaceId);
    expect(answers[0]!.operationId).toBe(answers[1]!.operationId);
    expect(await queued(w)).toBe(1);
  });

  it("S3b: a repeat of a request whose start was counted keeps its place of the month when the repeat's own start fails (only a place this call took is given back)", async () => {
    const w = await world();
    const requestId = newRequestId();
    expect((await ask(w, { requestId })).outcome).toBe("started");
    expect(await used(w)).toBe(1);
    const failing = createSystemStarter({ flow: w.h.deps, enabled: async () => true, upkeepOn: async () => false, rebuild: { precheck: async () => undefined, start: async () => { throw Object.assign(new Error("busy"), { code: "WORKSPACE_BUSY" }); } } });
    expect(await failing.start({ project: PROJECT, kind: "saved_env_rebuild", reason: { code: "image_out_of_date" }, requestId })).toEqual({ outcome: "skipped", reason: "busy" });
    expect(await used(w)).toBe(1);
  });

  it("ONE START PER JOB: a second request for the same job is busy (no cap place, no audit, no workspace); and the transaction itself refuses a second start when two run at once", async () => {
    const w = await world();
    expect((await ask(w)).outcome).toBe("started");
    const auditBefore = systemAudit(w).length;
    expect(await ask(w, { requestId: newRequestId() })).toEqual({ outcome: "skipped", reason: "busy" });
    expect(systemAudit(w)).toHaveLength(auditBefore);
    expect(await used(w)).toBe(1);
    expect(await queued(w)).toBe(1);
    // With the guards of the starter out of the way, two starts of one fresh job at once start one run: the start record is put only while absent.
    const race = await world();
    const [a, b] = await Promise.all([race.run.start(PROJECT, newRequestId()), race.run.start(PROJECT, newRequestId())]);
    expect([a.started, b.started].sort()).toEqual([false, true]);
    expect([a, b].find((answer) => !answer.started)).toEqual({ started: false, why: "already_started" });
    expect(await queued(race)).toBe(1);
  });
});

describe("the start's own guards (nothing queued, a moved approval, commits that do not match, no build inputs)", () => {
  it.each([
    ["nothing queued", async () => world({ queue: false }), "nothing_queued"],
    ["no build inputs", async () => world({ inputs: false }), "no_build_inputs"],
  ] as const)("%s: not started, a place of the month is never taken and nothing is audited", async (_name, make, why) => {
    const w = await make();
    expect(await ask(w)).toEqual({ outcome: "not_started", reason: why });
    await expectNothingStarted(w);
  });

  it("the approved environment moved since the job was queued: not started, nothing written", async () => {
    const w = await world();
    await approve(w.test, environmentBody({ roundBudgetMin: 40 }), 2);
    expect(await ask(w)).toEqual({ outcome: "not_started", reason: "approved_moved" });
    await expectNothingStarted(w);
  });

  it("the job's commits are not the project's repositories: not started, nothing written", async () => {
    const w = await world();
    await w.h.store.update({ key: savedEnvRowKey(COMPANY, PROJECT), ops: [change.set(["job", "commits"], { other: HEAD })] });
    expect(await ask(w)).toEqual({ outcome: "not_started", reason: "commits_mismatch" });
    await expectNothingStarted(w);
  });

  it("the job names a repository the project does not have (more commits than repositories): not started, nothing written", async () => {
    const w = await world();
    await w.h.store.update({ key: savedEnvRowKey(COMPANY, PROJECT), ops: [change.set(["job", "commits"], { demo: HEAD, extra: HEAD })] });
    expect(await ask(w)).toEqual({ outcome: "not_started", reason: "commits_mismatch" });
    await expectNothingStarted(w);
  });

  it("a job whose lease was already handed to a worker is not started again", async () => {
    const w = await world();
    await w.h.store.update({ key: savedEnvRowKey(COMPANY, PROJECT), ops: [change.set(["job", "dispatchedAt"], new Date(w.h.clock.now).toISOString())] });
    expect(await ask(w)).toEqual({ outcome: "not_started", reason: "nothing_queued" });
    await expectNothingStarted(w);
  });

  it("S1: the registry row is written again between the reads and the write (a push, a task or a poll bumps its version): the start is tried once more from the reads and the good job starts", async () => {
    const w = await world();
    const real = w.h.store.transact.bind(w.h.store);
    let bumps = 0;
    w.h.store.transact = async (items) => {
      if (bumps < 1 && items[0]?.kind === "check") { bumps += 1; await w.h.store.update({ key: savedEnvRowKey(COMPANY, PROJECT), ops: [change.add("version", 1)] }); }
      return real(items);
    };
    expect(await ask(w)).toMatchObject({ outcome: "started" });
    expect(bumps).toBe(1);
    expect(await queued(w)).toBe(1);
    expect(await used(w)).toBe(1);
    expect(systemAudit(w).map((event) => event.action)).toEqual(["system_run.requested"]);
  });

  it("S1: the row written again at both tries is \"not now\" (busy), never a refusal that ends the job: the place goes back and nothing is left", async () => {
    const w = await world();
    const real = w.h.store.transact.bind(w.h.store);
    w.h.store.transact = async (items) => {
      if (items[0]?.kind === "check") await w.h.store.update({ key: savedEnvRowKey(COMPANY, PROJECT), ops: [change.add("version", 1)] });
      return real(items);
    };
    expect(await ask(w)).toEqual({ outcome: "skipped", reason: "busy" });
    expect(systemAudit(w).map((event) => event.action)).toEqual(["system_run.requested", "system_run.not_started"]);
    expect(await used(w)).toBe(0);
    expect(await startRecord(w)).toBeUndefined();
    expect(await w.h.store.get(companySlotKey(COMPANY, 0))).toBeUndefined();
    expect(await queued(w)).toBe(0);
  });

  it("the job is handed to a worker between the reads and the write: the second look says nothing is queued, the place goes back and the audit says it did not start", async () => {
    const w = await world();
    const real = w.h.store.transact.bind(w.h.store);
    let moved = false;
    w.h.store.transact = async (items) => {
      if (!moved && items[0]?.kind === "check") { moved = true; await w.h.store.update({ key: savedEnvRowKey(COMPANY, PROJECT), ops: [change.add("version", 1), change.set(["job", "dispatchedAt"], new Date(w.h.clock.now).toISOString())] }); }
      return real(items);
    };
    expect(await ask(w)).toEqual({ outcome: "not_started", reason: "nothing_queued" });
    expect(systemAudit(w).map((event) => event.action)).toEqual(["system_run.requested", "system_run.not_started"]);
    expect(await used(w)).toBe(0);
    expect(await startRecord(w)).toBeUndefined();
    expect(await w.h.store.get(companySlotKey(COMPANY, 0))).toBeUndefined();
    expect(await queued(w)).toBe(0);
  });

  it("S7a: a job whose lease no longer covers the build's watch (2 h 45 min) is not started (its result would be refused as expired while its machine still ran); exactly enough lease left starts", async () => {
    const short = await world();
    short.h.clock.advance(15 * 60 + 1);
    expect(await ask(short)).toEqual({ outcome: "not_started", reason: "lease_too_short" });
    await expectNothingStarted(short);
    expect(await short.run.start(PROJECT, newRequestId())).toEqual({ started: false, why: "lease_too_short" });
    const enough = await world();
    enough.h.clock.advance(15 * 60);
    expect((await ask(enough)).outcome).toBe("started");
  });

  it("S7b: one job never gets two preparations while the older start is still wired: the older start's marker is checked and put in the same transaction, in both orders", async () => {
    const older = (w: World) => startSavedEnvRebuild({ flow: w.h.deps, saved: w.deps, test: w.test, inputs: async () => ({ baseImageDigest: BASE_IMAGE, secretNames: [], detectorGlobs: [] }), ownerFor: async () => "local-owner", env: ON }, ids);
    const first = await world();
    expect(await older(first)).toMatchObject({ started: true });
    expect(await ask(first)).toEqual({ outcome: "skipped", reason: "busy" });
    // The reads said so before a place of the month was taken or an audit record written.
    expect(systemAudit(first)).toHaveLength(0);
    expect(await first.run.start(PROJECT, newRequestId())).toEqual({ started: false, why: "already_started" });
    expect(await startRecord(first)).toBeUndefined();
    expect(await queued(first)).toBe(1);
    expect(await used(first)).toBe(0);
    const second = await world();
    expect((await ask(second)).outcome).toBe("started");
    expect(await older(second)).toEqual({ started: false, why: "already_started" });
    expect(await queued(second)).toBe(1);
  });

  it("S7c: a registry row, slot or record that cannot be read in the starter's reads fails CLOSED: busy, nothing written, nothing thrown", async () => {
    const w = await world();
    w.deps.store.get = async () => { throw new Error("unreadable"); };
    expect(await ask(w)).toEqual({ outcome: "skipped", reason: "busy" });
    await expectNothingStarted(w);
  });

  it("is off with the saved-environments switch off", async () => {
    const w = await world();
    const off = createSavedEnvRebuildRun({ flow: w.h.deps, saved: w.deps, test: w.test, inputs: async () => undefined, env: { ROVARA_SAVED_ENVIRONMENTS: "0" } });
    expect(await off.precheck(PROJECT, newRequestId())).toBe("disabled");
    expect(await off.start(PROJECT, newRequestId())).toEqual({ started: false, why: "disabled" });
  });
});

describe("the slots: two a company, four an install, held by the job id", () => {
  const holder = (jobId: string, project = "other") => ({ project, jobId, nowMs: Date.parse("2026-11-09T10:00:00.000Z") });
  const take = async (w: World, items: ReturnType<typeof slotClaimItems>): Promise<void> => { expect((await w.h.store.transact([...items])).applied).toBe(true); };

  it("the first free slot of each scope is taken; the next job takes the next one", async () => {
    const w = await world();
    const now = w.h.clock.now;
    await take(w, slotClaimItems(COMPANY, { company: 0, install: 0 }, { ...holder("job-a"), nowMs: now }));
    expect(await pickSlots(w.h.store, COMPANY, "job-b", now)).toEqual({ ok: true, company: 1, install: 1 });
    // The job that holds a slot is given its own again (a retry of the same job).
    expect(await pickSlots(w.h.store, COMPANY, "job-a", now)).toEqual({ ok: true, company: 0, install: 0 });
  });

  it("none free: the company's two slots held by live jobs answer busy, nothing is taken, no place of the month, no audit", async () => {
    const w = await world();
    for (let index = 0; index < SAVED_ENV_COMPANY_SLOTS; index += 1) await take(w, slotClaimItems(COMPANY, { company: index, install: index }, { ...holder(`job-${String(index)}`), nowMs: w.h.clock.now }));
    expect(await pickSlots(w.h.store, COMPANY, w.job.jobId, w.h.clock.now)).toEqual({ ok: false, full: "company" });
    expect(await ask(w)).toEqual({ outcome: "skipped", reason: "busy" });
    expect(await startRecord(w)).toBeUndefined();
    expect(systemAudit(w)).toHaveLength(0);
    expect(await used(w)).toBe(0);
    expect(await queued(w)).toBe(0);
  });

  it("none free: the install's four slots held by other companies' jobs answer busy", async () => {
    const w = await world();
    for (let index = 0; index < SAVED_ENV_INSTALL_SLOTS; index += 1) await take(w, [slotClaimItems(OTHER_COMPANY, { company: 0, install: index }, { ...holder(`other-${String(index)}`), nowMs: w.h.clock.now })[1]] as never);
    expect(await pickSlots(w.h.store, COMPANY, w.job.jobId, w.h.clock.now)).toEqual({ ok: false, full: "install" });
    expect(await ask(w)).toEqual({ outcome: "skipped", reason: "busy" });
    await expect(w.h.store.get(companySlotKey(COMPANY, 0))).resolves.toBeUndefined();
  });

  it("a slot whose lease has run out is free (a lost holder heals), and a take of a live one is refused by its own condition", async () => {
    const w = await world();
    const now = w.h.clock.now;
    await take(w, slotClaimItems(COMPANY, { company: 0, install: 0 }, { ...holder("job-old"), nowMs: now }));
    expect(await pickSlots(w.h.store, COMPANY, "job-new", now + 1)).toEqual({ ok: true, company: 1, install: 1 });
    expect(await pickSlots(w.h.store, COMPANY, "job-new", now + SAVED_ENV_JOB_LEASE_MS)).toEqual({ ok: true, company: 0, install: 0 });
    // The take itself holds on the same test: an expired slot, and a slot of the very same job, are taken over by the transaction.
    await take(w, slotClaimItems(COMPANY, { company: 0, install: 0 }, { ...holder("job-new"), nowMs: now + SAVED_ENV_JOB_LEASE_MS }));
    expect(await w.h.store.get(companySlotKey(COMPANY, 0))).toMatchObject({ jobId: "job-new" });
    await take(w, slotClaimItems(COMPANY, { company: 0, install: 0 }, { ...holder("job-new"), nowMs: now + SAVED_ENV_JOB_LEASE_MS + 10 }));
    // A take that read the slot as free but finds it held (another job got there first) fails the whole transaction.
    const refused = await w.h.store.transact([...slotClaimItems(COMPANY, { company: 0, install: 0 }, { ...holder("job-late"), nowMs: now + SAVED_ENV_JOB_LEASE_MS + 20 })]);
    expect(refused.applied).toBe(false);
    expect(await w.h.store.get(companySlotKey(COMPANY, 0))).toMatchObject({ jobId: "job-new" });
  });

  it("a lost race for a slot is tried once more with the slots then free", async () => {
    const w = await world();
    const real = w.h.store.transact.bind(w.h.store);
    let stolen = false;
    w.h.store.transact = async (items) => {
      if (!stolen && items[0]?.kind === "check") { stolen = true; await take(w, slotClaimItems(COMPANY, { company: 0, install: 0 }, { ...holder("job-thief"), nowMs: w.h.clock.now })); }
      return real(items);
    };
    expect(await ask(w)).toMatchObject({ outcome: "started" });
    expect(await w.h.store.get(companySlotKey(COMPANY, 0))).toMatchObject({ jobId: "job-thief" });
    expect(await w.h.store.get(companySlotKey(COMPANY, 1))).toMatchObject({ jobId: w.job.jobId });
    expect(await w.h.store.get(installSlotKey(1))).toMatchObject({ jobId: w.job.jobId });
    expect(await queued(w)).toBe(1);
  });

  it("a release deletes only the slots of its own job", async () => {
    const w = await world();
    const now = w.h.clock.now;
    await take(w, slotClaimItems(COMPANY, { company: 0, install: 0 }, { ...holder("job-a"), nowMs: now }));
    await take(w, slotClaimItems(COMPANY, { company: 1, install: 1 }, { ...holder("job-b"), nowMs: now }));
    expect(await releaseSlots(w.h.store, COMPANY, "job-a")).toBe(2);
    expect(await w.h.store.get(companySlotKey(COMPANY, 0))).toBeUndefined();
    expect(await w.h.store.get(installSlotKey(0))).toBeUndefined();
    expect(await w.h.store.get(companySlotKey(COMPANY, 1))).toMatchObject({ jobId: "job-b" });
    // Another company's job of the same id is not touched either.
    expect(await releaseSlots(w.h.store, OTHER_COMPANY, "job-b")).toBe(0);
    expect(await w.h.store.get(installSlotKey(1))).toMatchObject({ jobId: "job-b" });
  });
});

describe("what a rebuild's end does", () => {
  it("is watched for its own 2 h 45 min, not the default 50: nothing is ended at 60 minutes, everything is closed past the limit (workspace CLOSED, machine terminated, watch row gone)", async () => {
    const w = await world();
    const answer = (await ask(w)) as { workspaceId: string };
    const workspaceId = answer.workspaceId;
    for (let round = 0; round < 12; round += 1) {
      if ((await w.h.flow.dispatchOnce({ maxMessages: 10 })).received === 0) break;
      w.h.clock.advance(70);
    }
    const workspace = await workspaceOf(w, workspaceId);
    const operationId = workspace.activeOperationId!;
    const machineId = workspace.machine?.machineId;
    expect(machineId).toBeDefined();
    const created = Date.parse(workspace.createdAt);
    w.h.clock.advance(Math.floor((created + 60 * 60_000 - w.h.clock.now) / 1_000));
    expect(60 * 60_000).toBeGreaterThan(PREPARATION_TIMEOUT_MS);
    for (let sweep = 0; sweep < 2; sweep += 1) await w.h.flow.sweepRunsOnce();
    expect((await operationOf(w, workspaceId, operationId)).status).not.toBe("FAILED");
    expect(await workspaceOf(w, workspaceId)).toMatchObject({ status: "PREPARING" });
    w.h.clock.advance(Math.floor((created + SAVED_ENV_BUILD_WATCH_MS - w.h.clock.now) / 1_000) + 1);
    await w.h.flow.sweepRunsOnce();
    expect(await operationOf(w, workspaceId, operationId)).toMatchObject({ status: "FAILED" });
    expect((await operationOf(w, workspaceId, operationId)).error).not.toBe(CHECK_STALLED_MESSAGE);
    expect(await workspaceOf(w, workspaceId)).toMatchObject({ status: "CLOSED", closedFrom: "PREPARATION_FAILED", activeOperationId: null });
    expect((await w.h.machines.health(machineId!)).state).toBe("terminated");
    expect(await w.h.store.get(prepareWatchKey(COMPANY, workspace.createdAt, workspaceId))).toBeUndefined();
    // S2: the close gave both slots back (the end of a rebuild that timed out).
    expect(await w.h.store.get(companySlotKey(COMPANY, 0))).toBeUndefined();
    expect(await w.h.store.get(installSlotKey(0))).toBeUndefined();
    // The project's own setup state was never touched by it.
    expect((await w.h.store.get(projectMetaKey(COMPANY, PROJECT)))?.["setupCheck"]).toBeUndefined();
  });

  it("a rebuild's close never resumes the project's setup-paused tasks; the close of the project's own check still does", async () => {
    resumed.calls.length = 0;
    const w = await world();
    const { workspaceId } = (await ask(w)) as { workspaceId: string };
    await w.h.store.update({ key: workspaceKey(COMPANY, workspaceId), ops: [change.set("status", "READY"), change.set("activeOperationId", null)] });
    expect(await w.h.store.get(companySlotKey(COMPANY, 0))).toMatchObject({ jobId: w.job.jobId });
    expect(await closeSetupCheck(w.h.deps, workspaceId)).toBe(true);
    expect(await workspaceOf(w, workspaceId)).toMatchObject({ status: "CLOSED", closedFrom: "READY" });
    expect(resumed.calls).toHaveLength(0);
    // S2: and the close of a rebuild that succeeded gave its slots back; another job's slot is not touched by it.
    expect(await w.h.store.get(companySlotKey(COMPANY, 0))).toBeUndefined();
    expect(await w.h.store.get(installSlotKey(0))).toBeUndefined();
    // The control: the project's own check, closed READY, asks for the resume.
    await w.h.store.put({ item: { ...projectMetaKey(COMPANY, PROJECT), entityType: "PROJECT_META" } });
    const check = await startProjectSetupCheck(w.h.deps, { project: PROJECT, requestId: newRequestId(), startedBy: PERSON });
    await w.h.store.update({ key: workspaceKey(COMPANY, check.workspaceId), ops: [change.set("status", "READY"), change.set("activeOperationId", null)] });
    expect(await closeSetupCheck(w.h.deps, check.workspaceId)).toBe(true);
    expect(resumed.calls).toHaveLength(1);
  });

  it("MONEY: the machine of a rebuild is admitted when the dispatcher starts it, like any workspace's: a refusal ends the preparation with the admission's sentence, and no machine runs", async () => {
    const asked: Array<{ action: string; projectName: string | undefined; subject: unknown }> = [];
    const admission: Admission = {
      async admit(request) { asked.push({ action: request.action, projectName: request.projectName, subject: request.subject }); return request.action === "machine.start" ? { allowed: false, code: "machine_time_exceeded", message: "this company has used its machine time" } : { allowed: true }; },
      async stage() { return { decision: { allowed: true }, items: [] }; }, async settle() {}, async release() {},
    };
    const w = await world({ admission });
    const { workspaceId } = (await ask(w)) as { workspaceId: string };
    for (let round = 0; round < 6; round += 1) {
      if ((await w.h.flow.dispatchOnce({ maxMessages: 10 })).received === 0) break;
      w.h.clock.advance(70);
    }
    expect(asked).toEqual([{ action: "machine.start", projectName: PROJECT, subject: { type: "workspace", id: workspaceId } }]);
    const workspace = await workspaceOf(w, workspaceId);
    expect(workspace.machine).toBeUndefined();
    expect(await workspaceOf(w, workspaceId)).toMatchObject({ status: "CLOSED", closedFrom: "PREPARATION_FAILED" });
    // S2: a rebuild refused its machine gave its slots back at once, not after the lease.
    expect(await w.h.store.get(companySlotKey(COMPANY, 0))).toBeUndefined();
    expect(await w.h.store.get(installSlotKey(0))).toBeUndefined();
    expect((await operationOf(w, workspaceId, (await w.h.store.get(savedEnvStartKey(COMPANY, w.job.jobId)))!["operationId"] as string))).toMatchObject({ status: "FAILED", error: "this company has used its machine time" });
  });

  it("METER: a rebuild's minutes are counted up to its own watch limit (2 h 45 min), where a check's stop at two hours", async () => {
    const w = await world();
    const { workspaceId } = (await ask(w)) as { workspaceId: string };
    const created = Date.parse((await workspaceOf(w, workspaceId)).createdAt);
    await w.h.store.update({ key: workspaceKey(COMPANY, workspaceId), ops: [change.set("closedAt", new Date(created + 4 * 3_600_000).toISOString())] });
    expect((await readSystemRunUsage(w.h.deps, {})).byKind["saved_env_rebuild"]).toEqual({ runs: 1, minutes: 165 });
    await w.h.store.update({ key: workspaceKey(COMPANY, workspaceId), ops: [change.set("closedAt", new Date(created + 95 * 60_000).toISOString())] });
    expect((await readSystemRunUsage(w.h.deps, {})).minutes).toBe(95);
  });
});

describe("the worker's routes answer a system-owned rebuild workspace, and nothing else opens it", () => {
  it("the push login and the result are answered for the job's own live preparation, as the system owner, with the lease the job holds", async () => {
    const w = await world();
    const { workspaceId } = (await ask(w)) as { workspaceId: string };
    const operationId = (await workspaceOf(w, workspaceId)).activeOperationId!;
    const context = savedEnvLeaseContext({ companyId: COMPANY, deps: w.deps, store: w.h.store, inspectGrant: () => { throw new Error("not used"); } });
    const lease = { jobId: w.job.jobId, leaseToken: w.job.leaseToken };
    await expect(savedEnvPushLoginCore(context, { workspaceId, operationId, body: { ...lease, leaseToken: "x".repeat(24) } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const login = await savedEnvPushLoginCore(context, { workspaceId, operationId, body: lease });
    expect(login.login.repository).toContain("/");
    // The result route answers (it does not refuse the system-owned workspace); what it records is the registry's own rule, tested with the registry.
    const answer = await savedEnvResultCore(context, { workspaceId, operationId, body: { ...lease, result: { ok: false, reason: "not_proved" } } });
    expect(typeof answer.recorded).toBe("boolean");
    // Not for another operation of the same workspace's job.
    await expect(savedEnvPushLoginCore(context, { workspaceId, operationId: "00000000-0000-4000-8000-000000000000", body: lease })).rejects.toBeDefined();
  });

  it("no person can reach it: it is in no list, has no task, its owner is the project's system owner, and an administrator's stop still needs the project's own grant", async () => {
    const w = await world();
    const { workspaceId } = (await ask(w)) as { workspaceId: string };
    const workspace = await workspaceOf(w, workspaceId);
    expect(workspace.ownerKey).toBe(taskOwnerKey(systemOwnerIdOf(COMPANY, PROJECT), workspaceId));
    expect((await w.h.store.queryIndex({ index: WORKSPACE_PROJECT_INDEX.name, partition: workspaceProjectIndexValue(COMPANY, PROJECT), limit: 50 })).items).toHaveLength(0);
    expect(await queryAll(w.h.store, { pk: `DEVTASK#${workspaceId}` })).toHaveLength(0);
    const asked: string[] = [];
    const refuse = async (project: string): Promise<void> => { asked.push(project); throw new Error("no grant"); };
    await expect(stopWorkspaceAsAdministrator(w.h.deps, workspaceId, { id: "admin", companyOf: async () => COMPANY }, refuse)).rejects.toThrow("no grant");
    await expect(stopWorkspaceAsAdministrator(w.h.deps, workspaceId, { id: "admin", companyOf: async () => OTHER_COMPANY }, async () => undefined)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(asked).toEqual([PROJECT]);
    expect((await workspaceOf(w, workspaceId)).status).toBe("PREPARING");
  });
});

describe("the older start is unchanged for its own path (it is deleted with its triggers in the pass lane)", () => {
  it("still refuses a moved approval and starts a job with an owner, through the shared guards", async () => {
    const w = await world();
    const deps = { flow: w.h.deps, saved: w.deps, test: w.test, inputs: async () => ({ baseImageDigest: BASE_IMAGE, secretNames: [], detectorGlobs: [] }), ownerFor: async () => "local-owner", env: ON };
    expect(await startSavedEnvRebuild({ ...deps, ownerFor: async () => undefined }, ids)).toEqual({ started: false, why: "no_owner" });
    expect(await startSavedEnvRebuild(deps, ids)).toMatchObject({ started: true });
    expect(await startSavedEnvRebuild(deps, ids)).toEqual({ started: false, why: "already_started" });
  });
});
