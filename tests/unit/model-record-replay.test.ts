// TE-F8: record-then-replay through F1-a's port on the fake adapter. Every test runs under the network tripwire (no socket to a non-loopback address), on both stores.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  NOT_RUN_SENTENCES, RECORDING_NOT_RECORDED_FAILED, RECORDING_NOT_RECORDED_INCOMPLETE, RECORDING_NOT_RECORDED_NO_CALL, RECORDING_NOT_RECORDED_UNSAVED, RECORDING_NOT_RECORDED_WITHHELD, RECORDING_NOT_RUN_INCOMPLETE,
  RECORDING_NOT_RUN_MISS, RECORDING_NOT_RUN_SCOPE, RECORDING_NOT_RUN_STORE, capSentence, detectPromptChanges, e2eSecretSpellings, recordingLimitSentence, type RecordingStore,
} from "@agentx/contracts";
import { installNetworkTripwire, type NetworkTripwire } from "../../packages/testing/src/ports/no-network.js";
import { COMPANY_A, OLD_SYSTEM_TEXT, SYSTEM_TEXT, USER_TEXT, T0, changedReport, chatFrame, drain, makeRig, messagesFrame, type Rig, type StoreKind } from "./model-record-support.js";

const MATCHING = (rig: Rig, over: Record<string, unknown> = {}) => chatFrame(rig.world, { system: SYSTEM_TEXT, ...over });
const calls = (rig: Rig): number => rig.world.provider.calls.length;
const SSE = [["content-type", "text/event-stream"]] as Array<[string, string]>;
const usageChunks = ["data: {\"choices\":[{\"delta\":{\"content\":\"Trains \"}}]}\n\n", "data: {\"choices\":[{\"delta\":{\"content\":\"run.\"}}]}\n\n", "data: {\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5}}\n\n", "data: [DONE]\n\n"];
const two = () => changedReport({ model: "fixture-large", oldModel: "fixture-small" });

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  tripwire.restore();
  expect(tripwire.attempts, "no socket to a non-loopback address").toEqual([]);
});

describe.each(["memory", "file"] as StoreKind[])("record and replay on the %s store", (kind) => {
  let rig: Rig;
  beforeEach(() => {
    rig = makeRig(kind, { report: two() });
  });
  afterEach(() => rig.cleanup());

  it("records the first call per changed prompt through the port and replays it byte-identical with its chunking, never forwarding again", async () => {
    rig.world.provider.script({ chunks: usageChunks, headers: SSE });
    const engine = rig.engine();
    const first = await engine.serve(MATCHING(rig));
    expect(first).toMatchObject({ kind: "stream", via: "forwarded" });
    const recorded = await drain(first);
    expect(recorded.events.filter((event) => event.kind === "chunk").length).toBeGreaterThan(1);
    expect(recorded.events.at(-1)).toMatchObject({ kind: "settle", class: "ok", estimated: false });
    expect(calls(rig)).toBe(1);
    expect(await rig.store.list(rig.scope)).toHaveLength(1);

    const again = await engine.serve(MATCHING(rig));
    expect(again).toMatchObject({ kind: "stream", via: "replayed" });
    const replayed = await drain(again);
    expect(calls(rig)).toBe(1);
    // Same head, same chunk boundaries, same bytes; the settle costs nothing.
    const shape = (events: typeof recorded.events) => events.map((event) => (event.kind === "chunk" ? ["chunk", [...event.bytes]] : event.kind === "head" ? ["head", event.status, event.headers] : ["settle", event.status, event.class]));
    expect(shape(replayed.events)).toEqual(shape(recorded.events));
    expect(replayed.events.at(-1)).toMatchObject({ kind: "settle", costMicros: 0, estimated: false });
    expect(replayed.events.at(-1)).not.toHaveProperty("overrun");
  });

  it("replays in a later round (a fresh engine, replay-only) and counts the replay", async () => {
    await drain(await rig.engine().serve(MATCHING(rig)));
    const later = rig.engine({ mode: "replay_only" });
    const served = await later.serve(MATCHING(rig));
    expect(served).toMatchObject({ kind: "stream", via: "replayed" });
    await drain(served);
    await drain(await later.serve(MATCHING(rig)));
    expect(calls(rig)).toBe(1);
    expect((await rig.store.list(rig.scope))[0]!.replayCount).toBe(2);
    const summary = await later.summary();
    expect(summary.items.find((item) => item.outcome === "replayed")).toMatchObject({ replays: 2 });
  });

  it("a miss in a replay-only round is 'not run: no recording for this request', and makes no call", async () => {
    const result = await rig.engine({ mode: "replay_only" }).serve(MATCHING(rig));
    expect(result).toEqual({ kind: "not_run", reason: "no_recording", sentence: RECORDING_NOT_RUN_MISS });
    expect(RECORDING_NOT_RUN_MISS).toBe("not run: no recording for this request");
    expect(calls(rig)).toBe(0);
  });

  it("a call matching no changed prompt stays scripted: no call, nothing stored (also in a replay-only round)", async () => {
    for (const mode of ["record", "replay_only"] as const) {
      const engine = rig.engine({ mode });
      expect(await engine.serve(chatFrame(rig.world, { system: "A system prompt nobody changed." }))).toEqual({ kind: "scripted" });
      expect(await engine.serve(chatFrame(rig.world, { system: OLD_SYSTEM_TEXT }))).toEqual({ kind: "scripted" });
      expect(await engine.serve({ not: "a frame" })).toEqual({ kind: "scripted" });
    }
    expect(calls(rig)).toBe(0);
    expect(await rig.store.list(rig.scope)).toEqual([]);
  });

  it("a second distinct call for an already recorded prompt is scripted, not a second real call", async () => {
    const engine = rig.engine();
    await drain(await engine.serve(MATCHING(rig)));
    expect(await engine.serve(MATCHING(rig, { user: "another question entirely" }))).toEqual({ kind: "scripted" });
    expect(calls(rig)).toBe(1);
  });

  it("an incomplete report records nothing and says why, for a call that would otherwise match", async () => {
    const incomplete = detectPromptChanges({ files: [{ path: "ai/app.py", before: "", after: "x".repeat(2 * 1024 * 1024), wholeFile: true }] }).report;
    const blocked = makeRig(kind, { report: incomplete });
    try {
      const result = await blocked.engine().serve(MATCHING(blocked));
      expect(result).toEqual({ kind: "not_run", reason: "plan", sentence: RECORDING_NOT_RUN_INCOMPLETE });
      expect(calls(blocked)).toBe(0);
      expect(await blocked.store.list(blocked.scope)).toEqual([]);
    } finally {
      blocked.cleanup();
    }
  });

  it("lists a changed prompt no call matched as 'not recorded: no call matched this changed prompt'", async () => {
    const engine = rig.engine();
    await drain(await engine.serve(MATCHING(rig)));
    const summary = await engine.summary();
    expect(summary.items).toHaveLength(2);
    expect(summary.items.map((item) => item.sentence).sort()).toEqual([RECORDING_NOT_RECORDED_NO_CALL, "recorded"]);
    expect(RECORDING_NOT_RECORDED_NO_CALL).toBe("not recorded: no call matched this changed prompt");
    expect(summary.counts).toMatchObject({ recorded: 1, notRecorded: 1, forwards: 1 });
  });

  describe("an answer that is not an answer is not stored", () => {
    const cases: Array<[string, Parameters<Rig["world"]["provider"]["script"]>[0], string]> = [
      ["a provider rate limit (429)", { status: 429, body: "{}" }, NOT_RUN_SENTENCES.rate_limit],
      ["a provider quota (429 with a quota code)", { status: 429, body: JSON.stringify({ error: { code: "insufficient_quota" } }) }, NOT_RUN_SENTENCES.quota],
      ["an overloaded provider (503)", { status: 503, body: "{}" }, NOT_RUN_SENTENCES.overloaded],
      ["a refused product key (401)", { status: 401, body: "{}" }, NOT_RUN_SENTENCES.key_refused],
      ["a provider error (500)", { status: 500, body: "{}" }, RECORDING_NOT_RECORDED_FAILED],
      ["a cut-off stream (settled on its reservation)", { chunks: ["data: {\"par"], headers: SSE, cutOff: true }, RECORDING_NOT_RECORDED_INCOMPLETE],
    ];
    it.each(cases)("%s", async (_name, behaviour, sentence) => {
      rig.world.provider.script(behaviour);
      const engine = rig.engine();
      const served = await engine.serve(MATCHING(rig));
      expect(served.kind).toBe("stream");
      await drain(served);
      expect(calls(rig)).toBe(1);
      expect(await rig.store.list(rig.scope)).toEqual([]);
      const item = (await engine.summary()).items.find((entry) => entry.sentence === sentence);
      expect(item, sentence).toBeDefined();
      expect(item!.outcome).toBe(sentence.startsWith("not run") ? "not_run" : "not_recorded");
      // The next call is not a replay of it: with the fault gone it records for real.
      await drain(await engine.serve(MATCHING(rig)));
      expect(calls(rig)).toBe(2);
      expect(await rig.store.list(rig.scope)).toHaveLength(1);
    });

    it("the budget (cap) refusal reads with F1-a's sentence, stores nothing", async () => {
      await rig.world.setCap(COMPANY_A, 1);
      const engine = rig.engine({ capMicros: 2_000_000 });
      await drain(await engine.serve(MATCHING(rig)));
      expect(rig.world.provider.calls).toHaveLength(0);
      expect(await rig.store.list(rig.scope)).toEqual([]);
      const item = (await engine.summary()).items.find((entry) => entry.outcome === "not_run");
      expect(item?.sentence).toBe(capSentence(2_000_000));
      expect(capSentence(2_000_000)).toBe("not run: test model budget reached ($2.00 per task)");
    });

    it("a withheld (key-echo) answer is not stored", async () => {
      rig.world.provider.script({ echoCredential: true });
      const engine = rig.engine();
      const body = (await drain(await engine.serve(MATCHING(rig)))).body;
      expect(body).toContain("withheld");
      expect(await rig.store.list(rig.scope)).toEqual([]);
      expect((await engine.summary()).items.some((item) => item.sentence === RECORDING_NOT_RECORDED_WITHHELD)).toBe(true);
    });

    it("a consumer that stops early leaves nothing stored (no settle, no recording)", async () => {
      const engine = rig.engine();
      const served = await engine.serve(MATCHING(rig));
      if (served.kind !== "stream") throw new Error("expected a stream");
      for await (const event of served.events) {
        if (event.kind === "head") break;
      }
      expect(await rig.store.list(rig.scope)).toEqual([]);
      expect((await engine.summary()).items.some((item) => item.sentence === RECORDING_NOT_RECORDED_FAILED)).toBe(true);
    });
  });

  describe("caps (DECISIONS 157, 165, 165a)", () => {
    const overrunning = { body: JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 10_000_000 } }) };

    it("over by at most one call: after a settle with overrun, no further real call, even when the adapter would serve it", async () => {
      // The defective adapter keeps serving a task after an overrun: the engine's own stop must hold.
      const defective = makeRig(kind, { report: two(), mutation: "no_overrun_block" });
      try {
        await defective.world.setCap(COMPANY_A, 1000);
        defective.world.provider.script(overrunning);
        const engine = defective.engine({ capMicros: 1000 });
        const first = await drain(await engine.serve(chatFrame(defective.world, { system: SYSTEM_TEXT, model: "fixture-small" })));
        expect(first.events.at(-1)).toMatchObject({ kind: "settle", overrun: true });
        expect(engine.overrun).toBe(true);
        // A different changed prompt (the model name) would be a second real call: the engine refuses it.
        const second = await engine.serve(chatFrame(defective.world, { user: "x", model: "fixture-large" }));
        expect(second).toEqual({ kind: "not_run", reason: "budget", sentence: capSentence(1000) });
        expect(calls(defective)).toBe(1);
        // A recorded answer still replays after the overrun: it costs nothing.
        expect((await engine.serve(chatFrame(defective.world, { system: SYSTEM_TEXT, model: "fixture-small" }))).kind === "stream").toBe(true);
        expect(calls(defective)).toBe(1);
      } finally {
        defective.cleanup();
      }
    });

    it("the per-task recording limit (data, default 20) stops further real calls", async () => {
      const engine = rig.engine({ maxRecordings: 1 });
      await drain(await engine.serve(chatFrame(rig.world, { system: SYSTEM_TEXT, model: "fixture-small" })));
      const second = await engine.serve(chatFrame(rig.world, { user: "x", model: "fixture-large" }));
      expect(second).toEqual({ kind: "not_run", reason: "limit", sentence: recordingLimitSentence(1) });
      expect(recordingLimitSentence(20)).toBe("not run: the recording limit for this task was reached (20)");
      expect(calls(rig)).toBe(1);
      expect(engine.forwards).toBe(1);
    });
  });

  describe("fail closed", () => {
    it.each([
      ["a scope that throws", () => { throw new Error("resolver failed"); }],
      ["no scope", () => undefined],
      ["a scope with an unsafe id", () => ({ companyId: "../other", taskId: "t" })],
    ])("%s: not run, no call, nothing stored", async (_name, scope) => {
      const engine = rig.engine({ scope: scope as never });
      expect(await engine.serve(MATCHING(rig))).toEqual({ kind: "not_run", reason: "scope", sentence: RECORDING_NOT_RUN_SCOPE });
      expect(calls(rig)).toBe(0);
      await expect(engine.endTask()).rejects.toThrow(/scope/u);
    });

    it("a store that cannot be read is not run, with no call", async () => {
      const broken: RecordingStore = { ...rig.store, list: () => Promise.reject(new Error("disk says: " + SYSTEM_TEXT)) };
      const result = await makeEngineOn(rig, broken).serve(MATCHING(rig));
      expect(result).toEqual({ kind: "not_run", reason: "store", sentence: RECORDING_NOT_RUN_STORE });
      expect(calls(rig)).toBe(0);
      expect(JSON.stringify(result)).not.toContain(SYSTEM_TEXT);
    });

    it("a store that cannot save still delivers the answer and reads 'not recorded: the recording could not be saved'", async () => {
      const failing: RecordingStore = { ...rig.store, put: () => Promise.reject(new Error("full")) };
      const engine = makeEngineOn(rig, failing);
      const served = await engine.serve(MATCHING(rig));
      expect((await drain(served)).events.at(-1)).toMatchObject({ kind: "settle", class: "ok" });
      expect((await engine.summary()).items.some((item) => item.sentence === RECORDING_NOT_RECORDED_UNSAVED)).toBe(true);
    });
  });

  describe("the product key and the labels", () => {
    it("a key the provider echoes reaches no stored file, no summary, no event and no error (all spellings), and the leak path really ran", async () => {
      const keys = rig.world.keysOf(COMPANY_A);
      rig.world.provider.script({ echoCredential: true });
      const engine = rig.engine();
      const seen: string[] = [];
      try {
        const served = await engine.serve(MATCHING(rig));
        const { events, body } = await drain(served);
        seen.push(body, JSON.stringify(events.map((event) => (event.kind === "head" ? event.headers : event.kind === "settle" ? event : []))));
      } catch (error) {
        seen.push(String(error));
      }
      await drain(await engine.serve(MATCHING(rig)));
      seen.push(JSON.stringify(await engine.summary()), ...rig.world.logs());
      // Positive control: the provider DID receive the key (so there was something to leak), and the adapter scrubbed it.
      expect(rig.world.provider.calls.some((call) => call.headers.some(([, value]) => keys.some((key) => value.includes(key))))).toBe(true);
      const forms = keys.flatMap((key) => e2eSecretSpellings(key));
      expect(forms.length).toBeGreaterThan(0);
      for (const text of [...seen, ...storedText(rig)]) for (const form of forms) expect(text.includes(form), "a spelling of the key").toBe(false);
    });

    it("labels a recording 'Recorded on <date>' with the day it was recorded, and never says Real", async () => {
      const engine = rig.engine();
      await drain(await engine.serve(MATCHING(rig)));
      rig.clock.now = T0 + 3 * 60 * 60 * 1000;
      await drain(await engine.serve(MATCHING(rig)));
      const summary = await engine.summary();
      expect(summary.label).toBe("Recorded on 13 Nov (this task)");
      expect(summary.recordedOn).toBe("2026-11-13");
      expect(summary.headline).toBe("Model answers for 2 changed prompts: Recorded on 13 Nov (this task), replayed 1 time, 1 not recorded");
      expect(JSON.stringify(summary)).not.toMatch(/\breal\b/iu);
    });

    it("the summary holds counts and hashes only: no prompt, no answer", async () => {
      const engine = rig.engine();
      const answer = await drain(await engine.serve(MATCHING(rig)));
      const text = JSON.stringify(await engine.summary());
      for (const secret of [SYSTEM_TEXT, USER_TEXT, answer.body, "Authorization"]) expect(text.includes(secret)).toBe(false);
      expect(text).not.toMatch(/Answer in one short/u);
      expect((await engine.summary()).items.every((item) => /^[a-f0-9]{64}$/u.test(item.id) && item.keys.every((key) => /^[a-f0-9]{64}$/u.test(key)))).toBe(true);
    });

    it("stores no request header, no request body and no provider account header", async () => {
      rig.world.provider.script({ headers: [["content-type", "application/json"], ["openai-organization", "org-secret-name"], ["set-cookie", "s=1"], ["x-request-id", "req-1"]] });
      await drain(await rig.engine().serve(chatFrame(rig.world, { system: SYSTEM_TEXT, headers: [["content-type", "application/json"], ["authorization", "Bearer client-supplied"], ["x-trace", "t-9"]] })));
      const entry = (await rig.store.get(rig.scope, (await rig.store.list(rig.scope))[0]!.key))!;
      expect(entry.answer.headers.map(([name]) => name).sort()).toEqual(["content-type", "x-request-id"]);
      const dump = [...storedText(rig), JSON.stringify(entry.answer.headers)].join("\n");
      for (const absent of [SYSTEM_TEXT, USER_TEXT, "client-supplied", "org-secret-name", "set-cookie", "x-trace"]) expect(dump.includes(absent), absent).toBe(false);
    });
  });

  describe("task end", () => {
    it("deletes every recording of the task, and no one else's", async () => {
      const engine = rig.engine();
      await drain(await engine.serve(MATCHING(rig)));
      const other = rig.engine({ taskId: "task-2" });
      await drain(await other.serve(MATCHING(rig)));
      expect(await engine.endTask()).toBe(1);
      expect(await rig.store.list(rig.scope)).toEqual([]);
      expect(await rig.store.list({ ...rig.scope, taskId: "task-2" })).toHaveLength(1);
      // Gone means gone: the next call is a miss.
      expect((await rig.engine({ mode: "replay_only" }).serve(MATCHING(rig))).kind).toBe("not_run");
    });
  });

  it("handles a 1 MB answer fast, on both record and replay, byte-identical", async () => {
    const big = "y".repeat(1024 * 1024);
    rig.world.provider.script({ body: JSON.stringify({ choices: [{ message: { content: big } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) });
    const engine = rig.engine();
    const started = performance.now();
    const recorded = await drain(await engine.serve(MATCHING(rig)));
    const replayed = await drain(await engine.serve(MATCHING(rig)));
    expect(performance.now() - started).toBeLessThan(5000);
    expect(replayed.body).toBe(recorded.body);
    expect(recorded.body.length).toBeGreaterThan(1024 * 1024);
  });

  it("works for the Anthropic shape with the system field, through that family's source", async () => {
    await drain(await rig.engine({ rowKey: "anthropic" }).serve(messagesFrame(rig.world, { system: SYSTEM_TEXT })));
    expect(calls(rig)).toBe(1);
    const replay = await rig.engine({ rowKey: "anthropic", mode: "replay_only" }).serve(messagesFrame(rig.world, { system: SYSTEM_TEXT }));
    expect(replay).toMatchObject({ kind: "stream", via: "replayed" });
    expect(calls(rig)).toBe(1);
  });
});

/** Every byte stored for a rig, as text: the files of a file store, or the entries of a memory store. */
function storedText(rig: Rig): string[] {
  const out: string[] = [];
  const walk = (path: string): void => {
    for (const name of readdirSync(path)) {
      const full = join(path, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(readFileSync(full, "utf8"));
    }
  };
  try {
    walk(rig.rootDir);
  } catch {
    // a memory store has no files
  }
  return out;
}

const makeEngineOn = (rig: Rig, store: RecordingStore) => rig.engine({ store });

