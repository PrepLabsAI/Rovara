// TE-F1c: the phase A record cache as the bridge uses it: TE-F8's key, engine and store, placed under the task's run directory, swept at task start, deleted at task end. The fake egress world answers; nothing leaves the machine
// (the network tripwire is installed for every test).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { e2eSecretSpellings, type ModelEgress, type ModelEgressEvent } from "@agentx/contracts";
import { installNetworkTripwire, type NetworkTripwire } from "../../packages/testing/src/ports/no-network.js";
import { fixtureEgressRows, fixtureKey } from "../../packages/testing/src/ports/model-egress-fixtures.js";
import { COMPANY_A, COMPANY_B, DAY_MS, SYSTEM_TEXT, T0, changedReport, chatFrame, planOf } from "./model-record-support.js";
import { fakeModelEgressWorld } from "../../packages/testing/src/ports/model-egress-world.js";
import { createModelBridge, MODEL_FRESH_SANDBOX_SENTENCE, type ModelBridge } from "../../packages/worker/src/model-bridge.js";
import { createModelBridgeLedger } from "../../packages/worker/src/model-bridge-ledger.js";
import { callModelBridge, collectModelBridge } from "../../packages/worker/src/model-helper-bridge-client.js";
import { openTaskRecordCache, type TaskRecordCache } from "../../packages/worker/src/model-record-cache.js";

const egressCompanyOf = (scope: unknown): string | undefined => (scope as { company?: string } | undefined)?.company;
const FAMILIES = new Map(Object.values(fixtureEgressRows()).map((row) => [row.id, row.family] as const));
const familyOf = (row: string) => FAMILIES.get(row);

let base: string;
let tripwire: NetworkTripwire;
const closers: Array<() => Promise<unknown>> = [];
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "c-"));
  tripwire = installNetworkTripwire();
});
afterEach(async () => {
  tripwire.restore();
  for (const close of closers.splice(0).reverse()) await close();
  rmSync(base, { recursive: true, force: true });
  expect(tripwire.attempts).toEqual([]);
});

interface Task { readonly cache: TaskRecordCache; readonly world: ReturnType<typeof fakeModelEgressWorld>; readonly clock: { now: number }; readonly runDir: string; readonly helperDir: string }
async function openTask(over: { runDir?: string; company?: typeof COMPANY_A; clock?: { now: number }; taskId?: string; world?: ReturnType<typeof fakeModelEgressWorld>; egress?: ModelEgress } = {}): Promise<Task> {
  const runDir = over.runDir ?? join(base, "r");
  const helperDir = join(runDir, "models");
  mkdirSync(helperDir, { recursive: true, mode: 0o700 });
  const world = over.world ?? fakeModelEgressWorld();
  const company = over.company ?? COMPANY_A;
  const clock = over.clock ?? { now: T0 };
  const cache = await openTaskRecordCache({
    runDir, helperDir, scope: { companyId: company.orgId, taskId: over.taskId ?? "task-1" }, egress: over.egress ?? world.adapter, egressScope: world.scope(company, "openai"), egressCompanyOf,
    plan: planOf(changedReport()), clock: () => clock.now, familyOf,
  });
  return { cache, world, clock, runDir, helperDir };
}

interface Round { readonly bridge: ModelBridge; readonly socket: string; readonly ledger: ReturnType<typeof createModelBridgeLedger>; token(execId: string, modes?: readonly ("real" | "record")[]): string }
async function openRound(task: Task, roundKind: string, name: string): Promise<Round> {
  const ledger = createModelBridgeLedger({ now: () => task.clock.now });
  const bridge = createModelBridge({ egress: task.world.adapter, egressScope: task.world.scope(COMPANY_A, "openai"), roundKind, familyOf, ledger, now: () => task.clock.now, recording: task.cache.recording, randomToken: () => `${name}`.padEnd(32, "a") });
  const socket = join(task.helperDir, `${name.slice(0, 4)}.sock`);
  await bridge.listen(socket);
  closers.push(() => bridge.close());
  return { bridge, socket, ledger, token: (execId, modes = ["real", "record"]) => bridge.issueToken(execId, roundKind, modes) };
}
const send = (round: Round, mode: "record" | "replay", token: string | undefined, frame: Record<string, unknown>) => collectModelBridge({ socketPath: round.socket, mode, ...(token === undefined ? {} : { token }), frame: frame });
const filesUnder = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true, recursive: true }).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name)) : []);

describe("placement", () => {
  it("keeps the recordings in the run directory, beside the helper's directory and never inside it", async () => {
    const task = await openTask();
    expect(task.cache.root).toBe(join(task.runDir, "model-record"));
    await expect(openTaskRecordCache({ runDir: task.runDir, helperDir: join(task.runDir, "model-record", "models"), scope: { companyId: "c", taskId: "t" }, egress: task.world.adapter, egressScope: task.world.scope(COMPANY_A, "openai"), plan: planOf(changedReport()), clock: () => T0, egressCompanyOf })).rejects.toThrow(/helper/u);
    await expect(openTaskRecordCache({ runDir: task.runDir, helperDir: task.runDir, scope: { companyId: "c", taskId: "t" }, egress: task.world.adapter, egressScope: task.world.scope(COMPANY_A, "openai"), plan: planOf(changedReport()), clock: () => T0, egressCompanyOf })).rejects.toThrow(/helper/u);
    await expect(openTaskRecordCache({ runDir: "relative/run", helperDir: "relative/run/models", scope: { companyId: "c", taskId: "t" }, egress: task.world.adapter, egressScope: task.world.scope(COMPANY_A, "openai"), plan: planOf(changedReport()), clock: () => T0, egressCompanyOf })).rejects.toThrow(/absolute/u);
  });
});

describe("record, then replay through the bridge", () => {
  it("a fresh round records the first call per changed prompt (one real call) and replays the second from the cache; files are 0600 and hold no credential", async () => {
    const task = await openTask();
    const fresh = await openRound(task, "check_unsealed", "freshround");
    const token = fresh.token("exec-1");
    const credential = `Bearer-${fixtureKey("cache-credential")}`;
    const first = await send(fresh, "record", token, chatFrame(task.world, { system: SYSTEM_TEXT, headers: [["content-type", "application/json"], ["authorization", credential]] }));
    expect(first.status).toBe(200);
    expect(task.world.provider.calls).toHaveLength(1);
    const second = await send(fresh, "record", token, chatFrame(task.world, { system: SYSTEM_TEXT, headers: [["content-type", "application/json"], ["authorization", `${credential}-other`]] }));
    expect(second.body).toBe(first.body);
    // The cache key leaves the credential out: a different credential is the same request, so it is a replay and nothing is forwarded.
    expect(task.world.provider.calls).toHaveLength(1);
    expect(second.settle).toMatchObject({ costMicros: 0, class: "ok" });
    expect(fresh.ledger.rows().map((row) => row.via)).toEqual(["real", "replayed"]);
    expect(fresh.ledger.summary().calls).toBe(1);
    const files = filesUnder(task.cache.root);
    expect(files).toHaveLength(1);
    for (const file of files) {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      const text = readFileSync(file, "utf8");
      for (const spelling of e2eSecretSpellings(credential)) expect(text.includes(spelling)).toBe(false);
    }
    expect(statSync(task.cache.root).mode & 0o777).toBe(0o700);
    // Counts and hashes only.
    expect(JSON.stringify(await task.cache.summary())).not.toContain(SYSTEM_TEXT);
  });
  it("a later round of the same task replays what an earlier round recorded; in the working round a miss is the fresh-sandbox sentence and nothing is forwarded", async () => {
    const task = await openTask();
    const fresh = await openRound(task, "check_unsealed", "freshround");
    await send(fresh, "record", fresh.token("e1"), chatFrame(task.world, { system: SYSTEM_TEXT }));
    expect(task.world.provider.calls).toHaveLength(1);
    const working = await openRound(task, "working", "workinground");
    const hit = await send(working, "record", working.token("e2"), chatFrame(task.world, { system: SYSTEM_TEXT }));
    expect(hit.status).toBe(200);
    expect(task.world.provider.calls).toHaveLength(1);
    const miss = await send(working, "record", working.token("e2"), chatFrame(task.world, { system: SYSTEM_TEXT, user: "a different question" }));
    expect(miss.notRun).toBe(MODEL_FRESH_SANDBOX_SENTENCE);
    expect(task.world.provider.calls).toHaveLength(1);
    // replay mode never forwards, in any round
    const replayMiss = await send(fresh, "replay", undefined, chatFrame(task.world, { system: SYSTEM_TEXT, user: "yet another" }));
    expect(replayMiss.notRun).toMatch(/no recording for this request/u);
    expect(task.world.provider.calls).toHaveLength(1);
  });
  it("a call that matches no changed prompt is answered from the scripted replies, with no real call", async () => {
    const task = await openTask();
    const fresh = await openRound(task, "check_unsealed", "freshround");
    const answer = await send(fresh, "record", fresh.token("e"), chatFrame(task.world, { system: "A system prompt nobody changed" }));
    expect(answer.scripted).toBe(true);
    expect(task.world.provider.calls).toHaveLength(0);
  });
  it("a token issued for real only does not let a record call forward, and one issued for record does", async () => {
    const task = await openTask();
    const fresh = await openRound(task, "check_unsealed", "freshround");
    const realOnly = await send(fresh, "record", fresh.token("e1", ["real"]), chatFrame(task.world, { system: SYSTEM_TEXT }));
    expect(realOnly.status).toBe(403);
    expect(task.world.provider.calls).toHaveLength(0);
    const recordOnly = await send(fresh, "record", fresh.token("e2", ["record"]), chatFrame(task.world, { system: SYSTEM_TEXT }));
    expect(recordOnly.status).toBe(200);
    expect(task.world.provider.calls).toHaveLength(1);
  });
  it("record mode in a fresh round with no live token never forwards", async () => {
    const task = await openTask();
    const fresh = await openRound(task, "check_unsealed", "freshround");
    const answer = await send(fresh, "record", undefined, chatFrame(task.world, { system: SYSTEM_TEXT }));
    expect(answer.status).toBe(403);
    expect(task.world.provider.calls).toHaveLength(0);
  });
});

describe("F8's task rules", () => {
  it("a record stream the helper walks away from frees the one record slot (abandon): the next call forwards", async () => {
    const world = fakeModelEgressWorld();
    let stall = true;
    const egress: ModelEgress = {
      capabilities: world.adapter.capabilities,
      forward(scope, frame, options) {
        if (!stall) return world.adapter.forward(scope, frame, options);
        stall = false;
        return (async function* (): AsyncGenerator<ModelEgressEvent> {
          yield { kind: "head", status: 200, headers: [] };
          await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve()));
        })();
      },
    };
    const task = await openTask({ world, egress });
    const fresh = await openRound(task, "check_unsealed", "freshround");
    const token = fresh.token("e");
    const controller = new AbortController();
    await (async () => { for await (const event of callModelBridge({ socketPath: fresh.socket, mode: "record", token, frame: chatFrame(world, { system: SYSTEM_TEXT }), signal: controller.signal })) if (event.kind === "head") controller.abort(); })().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const second = await send(fresh, "record", token, chatFrame(world, { system: SYSTEM_TEXT }));
    expect(second.status).toBe(200);
    expect(world.provider.calls).toHaveLength(1);
    expect(task.cache.state().forwards).toBe(2);
  });
  it("hands out the task state for a rebuilt cache, and a rebuilt cache starts from it", async () => {
    const task = await openTask();
    const fresh = await openRound(task, "check_unsealed", "freshround");
    await send(fresh, "record", fresh.token("e"), chatFrame(task.world, { system: SYSTEM_TEXT }));
    expect(task.cache.state()).toEqual({ overrun: false, forwards: 1 });
    const again = await openTaskRecordCache({ runDir: task.runDir, helperDir: task.helperDir, scope: { companyId: COMPANY_A.orgId, taskId: "task-1" }, egress: task.world.adapter, egressScope: task.world.scope(COMPANY_A, "openai"), egressCompanyOf, plan: planOf(changedReport()), clock: () => T0, taskState: { overrun: true, forwards: 5 } });
    expect(again.state()).toEqual({ overrun: true, forwards: 5 });
  });
  it("after the task's real end, a call is not run and forwards nothing", async () => {
    const task = await openTask();
    const fresh = await openRound(task, "check_unsealed", "freshround");
    const token = fresh.token("e");
    await task.cache.end();
    const answer = await send(fresh, "record", token, chatFrame(task.world, { system: SYSTEM_TEXT }));
    expect(answer.notRun).toBeDefined();
    expect(task.world.provider.calls).toHaveLength(0);
    expect(existsSync(task.cache.root)).toBe(false);
  });
  it("a port scope that names another company than the task's is refused: nothing is forwarded", async () => {
    const world = fakeModelEgressWorld();
    const runDir = join(base, "r");
    const helperDir = join(runDir, "models");
    mkdirSync(helperDir, { recursive: true, mode: 0o700 });
    const cache = await openTaskRecordCache({ runDir, helperDir, scope: { companyId: COMPANY_A.orgId, taskId: "task-1" }, egress: world.adapter, egressScope: world.scope(COMPANY_B, "openai"), egressCompanyOf, plan: planOf(changedReport()), clock: () => T0, familyOf });
    const task: Task = { cache, world, clock: { now: T0 }, runDir, helperDir };
    const fresh = await openRound(task, "check_unsealed", "freshround");
    const answer = await send(fresh, "record", fresh.token("e"), chatFrame(world, { system: SYSTEM_TEXT }));
    expect(answer.status).not.toBe(200);
    expect(world.provider.calls).toHaveLength(0);
  });
});

describe("two companies", () => {
  it("company B's cache over the same directory never replays company A's recording", async () => {
    const a = await openTask();
    const round = await openRound(a, "check_unsealed", "freshround");
    await send(round, "record", round.token("e"), chatFrame(a.world, { system: SYSTEM_TEXT }));
    expect(filesUnder(a.cache.root)).toHaveLength(1);
    const b = await openTask({ company: COMPANY_B, taskId: "task-1" });
    const bridge = createModelBridge({ egress: b.world.adapter, egressScope: b.world.scope(COMPANY_B, "openai"), roundKind: "working", familyOf, ledger: createModelBridgeLedger({ now: () => T0 }), now: () => T0, recording: b.cache.recording });
    const socket = join(b.helperDir, "b.sock");
    await bridge.listen(socket);
    closers.push(() => bridge.close());
    const miss = await collectModelBridge({ socketPath: socket, mode: "replay", frame: chatFrame(b.world, { system: SYSTEM_TEXT }) });
    expect(miss.notRun).toMatch(/no recording/u);
  });
});

describe("task start and task end", () => {
  it("the sweep at task start removes what a crash left behind (an expired recording and an old temp file)", async () => {
    const task = await openTask();
    const round = await openRound(task, "check_unsealed", "freshround");
    await send(round, "record", round.token("e"), chatFrame(task.world, { system: SYSTEM_TEXT }));
    const [file] = filesUnder(task.cache.root);
    const stray = `${file}.0123456789abcdef.tmp`;
    writeFileSync(stray, "x", { mode: 0o600 });
    const old = new Date(T0 - 10 * 60_000);
    utimesSync(stray, old, old);
    // The crash: no end(). A new task start, two days later.
    await round.bridge.close();
    const later = await openTask({ clock: { now: T0 + 2 * DAY_MS }, taskId: "task-1" });
    expect(filesUnder(later.cache.root)).toEqual([]);
  });
  it("end() deletes every recording and the cache directory, once", async () => {
    const task = await openTask();
    const round = await openRound(task, "check_unsealed", "freshround");
    await send(round, "record", round.token("e"), chatFrame(task.world, { system: SYSTEM_TEXT }));
    expect(filesUnder(task.cache.root)).toHaveLength(1);
    expect(await task.cache.end()).toBe(1);
    expect(existsSync(task.cache.root)).toBe(false);
    expect(await task.cache.end()).toBe(0);
  });
  it("is deleted with the run directory (nothing is kept anywhere else)", async () => {
    const task = await openTask();
    const round = await openRound(task, "check_unsealed", "freshround");
    await send(round, "record", round.token("e"), chatFrame(task.world, { system: SYSTEM_TEXT }));
    await round.bridge.close();
    rmSync(task.runDir, { recursive: true, force: true });
    expect(filesUnder(base).filter((file) => file.endsWith(".rec"))).toEqual([]);
  });
});
void ((): ModelEgressEvent | undefined => undefined);
