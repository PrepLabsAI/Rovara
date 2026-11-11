// The nightly fire: the schedule on the scheduler port, and every decision a fire makes (one run per slot, per day and per gap; fixed skip reasons; admission; claims given back).
import { describe, expect, it } from "vitest";
import { agentXError, testEnvDigest, type DueSchedule } from "@agentx/contracts";
import {
  NIGHTLY_FIRE_MAX_AGE_MS, NIGHTLY_MIN_GAP_MS, NIGHTLY_RUN_MAX_MS, deleteNightlySchedule, handleNightlyFire, nightlyScheduleName, nightlySlotId, putNightlySchedule, recordNightlyResult,
  syncNightlySchedule, validateNightlyCron, type NightlyRunPort,
} from "../../packages/broker/src/core/test-env/nightly.js";
import { readLatestNight } from "../../packages/broker/src/core/test-env/night-status.js";
import { admitNightly } from "../../packages/broker/src/core/test-env/nightly-run.js";
import { createFakeScheduler } from "../../packages/broker/src/ports/fake-scheduler.js";
import { createAllowAllAdmission } from "../../packages/broker/src/ports/policy-defaults.js";
import { HEAD1, HEAD2, ORG, PROJECT, SCHEDULED, T0, approveForTest, body, nightlyWorld, result, rows } from "../support/nightly-world.js";

describe("the schedule", () => {
  it("is one schedule per project on the scheduler port, at the environment's own UTC time, with the project as its target", async () => {
    const scheduler = createFakeScheduler();
    await putNightlySchedule({ scheduler }, { orgId: ORG, project: PROJECT, cronUtc: "0  6 * * *", enabled: true });
    expect(scheduler.all()).toEqual([{
      companyId: ORG, scheduleId: nightlyScheduleName(ORG, PROJECT), when: { kind: "cron", cron: "0 6 * * *", timezone: "UTC" }, enabled: true,
      target: { kind: "nightly", ref: { project: PROJECT } }, maxLateSeconds: 3_600, description: "Rovara nightly test baseline",
    }]);
  });

  it("is replaced by a second put, turned off without being removed, and removed again without an error", async () => {
    const scheduler = createFakeScheduler();
    await syncNightlySchedule({ scheduler }, { orgId: ORG, project: PROJECT, nightly: { enabled: true, cronUtc: "0 6 * * *" } });
    await syncNightlySchedule({ scheduler }, { orgId: ORG, project: PROJECT, nightly: { enabled: true, cronUtc: "30 2 * * 1-5" } });
    expect(scheduler.all()).toHaveLength(1);
    expect(scheduler.all()[0]?.when).toEqual({ kind: "cron", cron: "30 2 * * 1-5", timezone: "UTC" });
    await putNightlySchedule({ scheduler }, { orgId: ORG, project: PROJECT, cronUtc: "30 2 * * 1-5", enabled: false });
    expect(scheduler.all()[0]?.enabled).toBe(false);
    await deleteNightlySchedule({ scheduler }, { orgId: ORG, project: PROJECT });
    await deleteNightlySchedule({ scheduler }, { orgId: ORG, project: PROJECT });
    expect(scheduler.all()).toEqual([]);
  });

  it("refuses a cron that is not five fields, uses a name, or sets both day fields, before anything reaches the scheduler", async () => {
    const scheduler = createFakeScheduler();
    for (const cron of ["0 6 * *", "0 6 * * * *", "0 6 * * MON", "0 6 15 * 1", ""]) {
      expect(() => validateNightlyCron(cron), cron).toThrow(/cron|day of the month/u);
      await expect(putNightlySchedule({ scheduler }, { orgId: ORG, project: PROJECT, cronUtc: cron, enabled: true })).rejects.toThrow();
    }
    expect(scheduler.all()).toEqual([]);
  });

  it("names a schedule per company and project, stably, in a form every scheduler accepts", () => {
    expect(nightlyScheduleName(ORG, PROJECT)).toBe(nightlyScheduleName(ORG, PROJECT));
    expect(nightlyScheduleName(ORG, PROJECT)).not.toBe(nightlyScheduleName(ORG, "other"));
    expect(nightlyScheduleName(ORG, PROJECT)).not.toBe(nightlyScheduleName("org_bbbbbbbbbbbbbbbbbbbb", PROJECT));
    expect(nightlyScheduleName(ORG, PROJECT)).toMatch(/^[A-Za-z0-9_-]{1,64}$/u);
  });
});

describe("a fire", () => {
  it("starts one run for the branch head, once per slot", async () => {
    const h = await nightlyWorld();
    const first = await handleNightlyFire(h.deps, h.due());
    expect(first).toEqual({ outcome: "started", slotId: nightlySlotId(ORG, PROJECT, SCHEDULED) });
    expect(h.started).toEqual([{ orgId: ORG, project: PROJECT, branch: "main", headSha: HEAD1, envRevision: 1, slotId: nightlySlotId(ORG, PROJECT, SCHEDULED), payer: { kind: "project", project: PROJECT }, source: "nightly_baseline" }]);
    expect(await handleNightlyFire(h.deps, h.due())).toEqual({ outcome: "skipped", reason: "already_handled" });
    expect(h.started).toHaveLength(1);
  });

  it("is idempotent per slot even when the same slot arrives again later", async () => {
    const h = await nightlyWorld();
    await handleNightlyFire(h.deps, h.due());
    h.clock.now += 1_000;
    expect(await handleNightlyFire(h.deps, { ...h.due(), attempt: 2 })).toEqual({ outcome: "skipped", reason: "already_handled" });
    expect(h.started).toHaveLength(1);
  });

  it("two fires at the same moment start one run", async () => {
    const h = await nightlyWorld();
    const both = await Promise.all([handleNightlyFire(h.deps, h.due()), handleNightlyFire(h.deps, h.due())]);
    expect(both.filter((one) => one.outcome === "started")).toHaveLength(1);
    expect(h.started).toHaveLength(1);
  });

  it("skips, with a fixed reason, when the head cannot be read, nightly is off, or there is no environment", async () => {
    const h = await nightlyWorld();
    h.heads.throws = true;
    expect(await handleNightlyFire(h.deps, h.due())).toEqual({ outcome: "skipped", reason: "head_unreadable" });
    h.heads.throws = false;
    h.heads.value = "not-a-sha";
    expect(await handleNightlyFire(h.deps, h.due())).toEqual({ outcome: "skipped", reason: "head_unreadable" });
    h.heads.value = undefined;
    expect(await handleNightlyFire(h.deps, h.due())).toEqual({ outcome: "skipped", reason: "head_unreadable" });
    expect(h.started).toHaveLength(0);
    const off = await nightlyWorld({ enabled: false });
    expect(await handleNightlyFire(off.deps, off.due())).toEqual({ outcome: "skipped", reason: "nightly_off" });
    const none = await nightlyWorld();
    expect(await handleNightlyFire(none.deps, none.due(SCHEDULED, "other-project"))).toEqual({ outcome: "skipped", reason: "environment_missing" });
  });

  it("skips a stale fire and a fire from the future, and refuses what is not a nightly's", async () => {
    const h = await nightlyWorld();
    expect(await handleNightlyFire(h.deps, h.due(new Date(T0 - NIGHTLY_FIRE_MAX_AGE_MS - 1_000).toISOString()))).toEqual({ outcome: "skipped", reason: "stale_fire" });
    expect(await handleNightlyFire(h.deps, h.due(new Date(T0 + 3_600_000).toISOString()))).toEqual({ outcome: "skipped", reason: "stale_fire" });
    // The edge of freshness: exactly the window is still run.
    expect((await handleNightlyFire(h.deps, h.due(new Date(T0 - NIGHTLY_FIRE_MAX_AGE_MS).toISOString()))).outcome).toBe("started");
    const other: DueSchedule = { ...h.due(), target: { kind: "chain", ref: { project: PROJECT } } };
    await expect(handleNightlyFire(h.deps, other)).rejects.toThrow(/not a nightly fire/u);
    await expect(handleNightlyFire(h.deps, { ...h.due(), target: { kind: "nightly", ref: {} } })).rejects.toThrow(/not a nightly fire/u);
    await expect(handleNightlyFire(h.deps, { ...h.due(), companyId: "not-a-company" })).rejects.toThrow(/not a nightly fire/u);
  });

  it("skips when nothing merged since the last recorded run, and runs again when the head moves", async () => {
    const h = await nightlyWorld();
    const started = await handleNightlyFire(h.deps, h.due());
    if (started.outcome !== "started") throw new Error("not started");
    const data = result(started.slotId);
    await recordNightlyResult(h.deps, h.mapStore, { orgId: ORG, project: PROJECT, result: data.result, coverageMap: data.coverageMap });
    h.clock.now += 24 * 3_600_000;
    const next = new Date(h.clock.now - 1_000).toISOString();
    expect(await handleNightlyFire(h.deps, h.due(next))).toEqual({ outcome: "skipped", reason: "no_merges" });
    h.heads.value = HEAD2;
    expect((await handleNightlyFire(h.deps, h.due(next))).outcome).toBe("started");
  });

  it("does not start a second run while one is in flight, but does once it is long over", async () => {
    const h = await nightlyWorld();
    await handleNightlyFire(h.deps, h.due());
    h.clock.now += 3_600_000;
    expect(await handleNightlyFire(h.deps, h.due(new Date(h.clock.now - 1_000).toISOString()))).toEqual({ outcome: "skipped", reason: "still_running" });
    expect(h.started).toHaveLength(1);
    // Exactly at the longest run time it is still in flight; after it, the lock is stale and the next night runs.
    h.clock.now = T0 + NIGHTLY_RUN_MAX_MS;
    expect(await handleNightlyFire(h.deps, h.due(new Date(h.clock.now - 1_000).toISOString()))).toEqual({ outcome: "skipped", reason: "still_running" });
    h.clock.now = T0 + NIGHTLY_RUN_MAX_MS + 24 * 3_600_000;
    expect((await handleNightlyFire(h.deps, h.due(new Date(h.clock.now - 1_000).toISOString()))).outcome).toBe("started");
  });

  it("charges the night to the project before anything is claimed, as 'nightly baseline'", async () => {
    const h = await nightlyWorld();
    await handleNightlyFire(h.deps, h.due());
    expect(h.admitted).toEqual([{ orgId: ORG, project: PROJECT, purpose: "nightly_baseline" }]);
  });

  it("is skipped, not retried and not started, when the project's budget has no room; it starts when there is room again", async () => {
    const h = await nightlyWorld();
    h.admitError.value = agentXError("PROJECT_BUDGET_EXCEEDED", "The project's monthly AI budget is used up.");
    expect(await handleNightlyFire(h.deps, h.due())).toEqual({ outcome: "skipped", reason: "budget" });
    expect(h.started).toHaveLength(0);
    expect(await rows(h.store, "TESTENV#NIGHTLY#")).toEqual([]);
    h.admitError.value = undefined;
    expect((await handleNightlyFire(h.deps, h.due())).outcome).toBe("started");
  });

  it("a fault that is not a budget refusal is thrown for the scheduler to retry, with nothing claimed", async () => {
    const h = await nightlyWorld();
    h.admitError.value = new Error("ledger unavailable");
    await expect(handleNightlyFire(h.deps, h.due())).rejects.toThrow("ledger unavailable");
    expect(await rows(h.store, "TESTENV#NIGHTLY#")).toEqual([]);
  });

  it("asks the Admission seam: a refusal reads as a skipped night, an allow lets it run", async () => {
    const h = await nightlyWorld();
    const asked: unknown[] = [];
    const refusing = { admit: async (request: unknown) => { asked.push(request); return { allowed: false as const, code: "budget_exhausted", message: "The budget is used up." }; } };
    h.deps.runs.admit = (input) => admitNightly(refusing, () => T0)({ orgId: input.orgId, project: input.project });
    expect(await handleNightlyFire(h.deps, h.due())).toEqual({ outcome: "skipped", reason: "budget" });
    expect(asked).toEqual([{ companyId: ORG, idempotencyKey: `nightly.run:${ORG}:${PROJECT}:2026-11-05`, action: "nightly.run", projectName: PROJECT, subject: { type: "project", id: PROJECT } }]);
    h.deps.runs.admit = (input) => admitNightly(createAllowAllAdmission(), () => T0)({ orgId: input.orgId, project: input.project });
    expect((await handleNightlyFire(h.deps, h.due())).outcome).toBe("started");
  });

  it("starts at most one run per project per day, however often the cron fires and however often the head moves", async () => {
    const h = await nightlyWorld({ cronUtc: "* * * * *" });
    const first = await handleNightlyFire(h.deps, h.due());
    if (first.outcome !== "started") throw new Error("not started");
    const data = result(first.slotId);
    await recordNightlyResult(h.deps, h.mapStore, { orgId: ORG, project: PROJECT, result: data.result, coverageMap: data.coverageMap });
    h.heads.value = HEAD2;
    for (let minute = 1; minute <= 5; minute += 1) {
      h.clock.now = T0 + minute * 60_000;
      expect(await handleNightlyFire(h.deps, h.due(new Date(h.clock.now - 1_000).toISOString()))).toEqual({ outcome: "skipped", reason: "ran_recently" });
    }
    expect(h.started).toHaveLength(1);
    h.clock.now = T0 + NIGHTLY_MIN_GAP_MS + 60_000;
    expect((await handleNightlyFire(h.deps, h.due(new Date(h.clock.now - 1_000).toISOString()))).outcome).toBe("started");
  });

  it("the gap holds across midnight: a run that finished at 22:40 UTC is not followed by one at 06:00 the next day, but is after the gap", async () => {
    const h = await nightlyWorld();
    h.clock.now = Date.UTC(2026, 10, 5, 22, 0, 5);
    const first = await handleNightlyFire(h.deps, h.due(new Date(h.clock.now - 5_000).toISOString()));
    if (first.outcome !== "started") throw new Error("not started");
    const finished = Date.UTC(2026, 10, 5, 22, 40, 0);
    const data = result(first.slotId, { startedAt: new Date(h.clock.now).toISOString(), finishedAt: new Date(finished).toISOString(), durationMs: finished - h.clock.now });
    h.clock.now = finished;
    await recordNightlyResult(h.deps, h.mapStore, { orgId: ORG, project: PROJECT, result: data.result, coverageMap: data.coverageMap });
    h.heads.value = HEAD2;
    h.clock.now = Date.UTC(2026, 10, 6, 6, 0, 5);
    expect(await handleNightlyFire(h.deps, h.due(new Date(h.clock.now - 5_000).toISOString()))).toEqual({ outcome: "skipped", reason: "ran_recently" });
    expect(h.started).toHaveLength(1);
    expect(h.admitted).toHaveLength(1);
    h.clock.now = Date.UTC(2026, 10, 6, 18, 41, 0);
    expect((await handleNightlyFire(h.deps, h.due(new Date(h.clock.now - 5_000).toISOString()))).outcome).toBe("started");
  });

  it("the day's claim is made in the store, so two fires that raced past the other checks start one run", async () => {
    const h = await nightlyWorld();
    await h.store.put({ item: { pk: `ORG#${ORG}#PROJECT#${PROJECT}`, sk: `TESTENV#NIGHTLY#DAY#${new Date(T0).toISOString().slice(0, 10)}`, slotId: "f".repeat(64) } });
    expect(await handleNightlyFire(h.deps, h.due())).toEqual({ outcome: "skipped", reason: "ran_recently" });
    expect(h.started).toHaveLength(0);
    // What the fire claimed before it met the day's claim is given back.
    expect(await rows(h.store, "TESTENV#NIGHTLY#ACTIVE")).toEqual([]);
    expect(await rows(h.store, "TESTENV#NIGHTLY#SLOT#")).toEqual([]);
  });

  it("the slot is claimed before anything starts, and the claim row names the slot", async () => {
    const h = await nightlyWorld();
    h.deps.runs.startRun = async () => {
      const claim = await h.store.get({ pk: `ORG#${ORG}#PROJECT#${PROJECT}`, sk: `TESTENV#NIGHTLY#SLOT#${nightlySlotId(ORG, PROJECT, SCHEDULED)}` });
      expect(claim?.["slotId"]).toBe(nightlySlotId(ORG, PROJECT, SCHEDULED));
      const lock = await h.store.get({ pk: `ORG#${ORG}#PROJECT#${PROJECT}`, sk: "TESTENV#NIGHTLY#ACTIVE" });
      expect(lock?.["slotId"]).toBe(nightlySlotId(ORG, PROJECT, SCHEDULED));
      h.started.push({});
    };
    expect((await handleNightlyFire(h.deps, h.due())).outcome).toBe("started");
    expect(h.started).toHaveLength(1);
  });

  it("throws, and lets the scheduler deliver the slot again, when the run cannot be started", async () => {
    const h = await nightlyWorld();
    h.startFails.value = true;
    await expect(handleNightlyFire(h.deps, h.due())).rejects.toThrow("no capacity");
    expect(await rows(h.store, "TESTENV#NIGHTLY#")).toEqual([]);
    h.startFails.value = false;
    expect((await handleNightlyFire(h.deps, h.due())).outcome).toBe("started");
    expect(h.started).toHaveLength(1);
  });

  it("gives every claim back when the night cannot run today, so the next fire is not shut out", async () => {
    const h = await nightlyWorld();
    h.startSkips.value = { skipped: "workspace_limit" };
    expect(await handleNightlyFire(h.deps, h.due())).toEqual({ outcome: "skipped", reason: "workspace_limit" });
    expect(await rows(h.store, "TESTENV#NIGHTLY#")).toEqual([]);
    h.startSkips.value = undefined;
    expect((await handleNightlyFire(h.deps, h.due())).outcome).toBe("started");
  });

  it("skips when the nightly branch is not the repository's default, or the default cannot be read, or the project uses registries; nothing is charged or claimed", async () => {
    const h = await nightlyWorld();
    const runs: NightlyRunPort = { ...h.deps.runs, defaultBranchOf: async () => "develop" };
    expect(await handleNightlyFire({ ...h.deps, runs }, h.due())).toEqual({ outcome: "skipped", reason: "branch_not_default" });
    expect(await handleNightlyFire({ ...h.deps, runs: { ...runs, defaultBranchOf: async () => undefined } }, h.due())).toEqual({ outcome: "skipped", reason: "head_unreadable" });
    expect(await handleNightlyFire({ ...h.deps, runs: { ...h.deps.runs, defaultBranchOf: async () => "main", usesRegistries: async () => true } }, h.due())).toEqual({ outcome: "skipped", reason: "registries_unsupported" });
    expect(await handleNightlyFire({ ...h.deps, runs: { ...h.deps.runs, defaultBranchOf: async () => "main", usesRegistries: async () => undefined } }, h.due())).toEqual({ outcome: "skipped", reason: "head_unreadable" });
    expect(h.admitted).toEqual([]);
    expect(h.started).toEqual([]);
    expect(await rows(h.store, "TESTENV#NIGHTLY#")).toEqual([]);
  });

  it("an environment with services is skipped before any charge, with a neutral note that is never 'needs repair'", async () => {
    const h = await nightlyWorld();
    const service = { name: "scorer", kind: "sagemaker_runtime", match: { endpointName: "scorer" }, mode: "mock", mock: { fixtureSetRef: "a".repeat(64), schemaRef: "b".repeat(64), unmatched: "fail" } };
    await approveForTest(h.store, body({}, { services: [service] }), 2);
    expect(await handleNightlyFire(h.deps, h.due())).toEqual({ outcome: "skipped", reason: "services_unsupported" });
    expect(h.admitted).toEqual([]);
    expect(h.started).toEqual([]);
    expect(await readLatestNight(h.deps, ORG, PROJECT)).toMatchObject({ status: "unavailable", reason: "services_unsupported", words: "Nightly not available: this setup's services can't be started by nightly runs yet." });
  });
});

describe("the approved environment a fire reads", () => {
  it("is the newest revision, and a later approval changes the next fire", async () => {
    const h = await nightlyWorld();
    await approveForTest(h.store, body({ enabled: false }), 2);
    expect(testEnvDigest(body({ enabled: false }))).not.toBe(testEnvDigest(body()));
    expect(await handleNightlyFire(h.deps, h.due())).toEqual({ outcome: "skipped", reason: "nightly_off" });
  });
});
