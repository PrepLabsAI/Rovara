// TE-F8: company B can never read company A's recordings. F1-a's two-company kit (`assertSurfacesIsolated`, `assertFailsClosed`) on both stores, with the same task id, the same request and the same source ids for both
// companies, plus the proof that the kit FAILS on a store that keys by task alone and on an engine that falls back to a company it saw before.
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryRecordingStore, type RecordingStore, type RecordReplay, type RecordReplayServe } from "@agentx/contracts";
import { COMPANY_A, COMPANY_B, assertFailsClosed, assertSurfacesIsolated, type FailClosedProbe, type IsolationCompany, type IsolationSurface } from "../../packages/testing/src/isolation/two-company.js";
import { SYSTEM_TEXT, T0, changedReport, chatFrame, drain, makeRig, type Rig, type StoreKind } from "./model-record-support.js";

const rigs: Rig[] = [];
afterEach(() => {
  for (const rig of rigs.splice(0)) rig.cleanup();
});

const answerBody = (marker: string): string => JSON.stringify({ choices: [{ message: { content: marker } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });

/** The surfaces of a recording store shared by two companies on one worker: they use the same task id and make the same request. */
function surfaces(rig: Rig, engineFor: (company: IsolationCompany, mode: "record" | "replay_only") => RecordReplay): IsolationSurface[] {
  const frame = (): Record<string, unknown> => chatFrame(rig.world, { system: SYSTEM_TEXT });
  return [
    {
      kind: "read",
      name: "a recording of one company is replayed to no other, though both use one task id, one request and one source id",
      async plant(me) {
        rig.world.provider.script({ body: answerBody(me.canary) });
        await drain(await engineFor(me, "record").serve(frame()));
      },
      async observe(as) {
        const own = await drain(await engineFor(as, "replay_only").serve(frame()));
        // The same read made straight on the store, with the caller's own company: the entry it finds is its own.
        const read = await rig.store.get({ companyId: as.orgId, taskId: "task-1" }, (await rig.store.list({ companyId: as.orgId, taskId: "task-1" }))[0]!.key);
        const direct = new TextDecoder().decode(read!.answer.chunks[0]);
        return { own: own.body, direct };
      },
    },
    {
      kind: "list",
      name: "the index of a company lists its own recordings only (hashes, never an answer)",
      expectOwn: false,
      async plant() {
        return { handle: undefined, markers: [] };
      },
      async observe(as) {
        const rows = await rig.store.list({ companyId: as.orgId, taskId: "task-1" });
        return { rows, count: rows.length };
      },
    },
  ];
}

function failClosed(rig: Rig): FailClosedProbe[] {
  const state: { mode: "ok" | "throws" | "undefined" } = { mode: "ok" };
  const engine = rig.engine({
    company: COMPANY_A,
    mode: "replay_only",
    scope: () => {
      if (state.mode === "throws") throw new Error("the company resolver failed");
      return state.mode === "undefined" ? undefined : { companyId: COMPANY_A.orgId, taskId: "task-1" };
    },
  });
  const frame = (): Record<string, unknown> => chatFrame(rig.world, { system: SYSTEM_TEXT });
  const asAnswer = async (served: RecordReplayServe): Promise<string> => {
    if (served.kind !== "stream") throw new Error(served.kind === "not_run" ? served.sentence : served.kind);
    return (await drain(served)).body;
  };
  return [
    {
      name: "a replay when the company cannot be read",
      async prepare() {
        state.mode = "ok";
        // Company A records through its own engine, then reads it back once with a working resolver, so a defective engine has a last good company to fall back to.
        rig.world.provider.script({ body: answerBody(COMPANY_A.canary) });
        if ((await rig.store.list({ companyId: COMPANY_A.orgId, taskId: "task-1" })).length === 0) await drain(await rig.engine({ company: COMPANY_A }).serve(frame()));
        await asAnswer(await engine.serve(frame()));
      },
      async attempt(mode) {
        state.mode = mode;
        return asAnswer(await engine.serve(frame()));
      },
    },
  ];
}

describe.each(["memory", "file"] as StoreKind[])("two companies on the %s store", (kind) => {
  const make = (store?: (now: () => number) => RecordingStore): Rig => {
    const rig = makeRig(kind, { report: changedReport(), ...(store === undefined ? {} : { store }) });
    rigs.push(rig);
    return rig;
  };
  const engineFor = (rig: Rig) => (company: IsolationCompany, mode: "record" | "replay_only"): RecordReplay => rig.engine({ company, mode });

  it("passes the kit: B never sees A's recording, A never sees B's, and each sees its own", async () => {
    const rig = make();
    await assertSurfacesIsolated(surfaces(rig, engineFor(rig)));
    // The leak path was live: both companies really recorded, under one task id.
    expect(await rig.store.list({ companyId: COMPANY_A.orgId, taskId: "task-1" })).toHaveLength(1);
    expect(await rig.store.list({ companyId: COMPANY_B.orgId, taskId: "task-1" })).toHaveLength(1);
    expect(rig.world.provider.calls).toHaveLength(2);
  });

  it("fails closed when the company resolver throws or answers nothing: no fall back to a default or last company", async () => {
    const rig = make();
    await assertFailsClosed(failClosed(rig));
  });

  it("the kit FAILS on a store that keys by task alone (company dropped from the key)", async () => {
    const rig = make((now) => {
      const inner = createMemoryRecordingStore({ now });
      const flat = (scope: { companyId: string; taskId: string }) => ({ companyId: "shared", taskId: scope.taskId });
      return { ...inner, get: (s, k) => inner.get(flat(s), k), put: (s, e) => inner.put(flat(s), e), list: (s) => inner.list(flat(s)), markReplayed: (s, k) => inner.markReplayed(flat(s), k), deleteTask: (s) => inner.deleteTask(flat(s)) };
    });
    await expect(assertSurfacesIsolated(surfaces(rig, engineFor(rig)))).rejects.toThrow(/company/u);
  });

  it("the kit FAILS on an engine that falls back to the last company it served when the resolver breaks", async () => {
    const rig = make();
    const defective: FailClosedProbe[] = (() => {
      const last = { companyId: COMPANY_A.orgId, taskId: "task-1" };
      const engine = rig.engine({ company: COMPANY_A, mode: "replay_only", scope: () => last /* fail open: the last good company, whatever the resolver says */ });
      return [{
        name: "fail-open",
        async prepare() {
          rig.world.provider.script({ body: answerBody(COMPANY_A.canary) });
          if ((await rig.store.list(last)).length === 0) await drain(await rig.engine({ company: COMPANY_A }).serve(chatFrame(rig.world, { system: SYSTEM_TEXT })));
        },
        async attempt() {
          const served = await engine.serve(chatFrame(rig.world, { system: SYSTEM_TEXT }));
          if (served.kind !== "stream") throw new Error("refused");
          return (await drain(served)).body;
        },
      }];
    })();
    await expect(assertFailsClosed(defective)).rejects.toThrow(/marker/u);
  });
});

describe("the same request by two companies is two recordings, two real calls, never one shared answer", () => {
  it("each company's first call goes through the port; neither replays the other's", async () => {
    const rig = makeRig("memory", { report: changedReport() });
    rigs.push(rig);
    rig.world.provider.script({ body: answerBody("answer-for-A") }, { body: answerBody("answer-for-B") });
    const a = await drain(await rig.engine({ company: COMPANY_A }).serve(chatFrame(rig.world, { system: SYSTEM_TEXT })));
    const b = await rig.engine({ company: COMPANY_B }).serve(chatFrame(rig.world, { system: SYSTEM_TEXT }));
    expect(b).toMatchObject({ kind: "stream", via: "forwarded" });
    const bBody = (await drain(b)).body;
    expect(a.body).toContain("answer-for-A");
    expect(bBody).toContain("answer-for-B");
    expect(bBody).not.toContain("answer-for-A");
    expect(T0).toBeGreaterThan(0);
  });
});
