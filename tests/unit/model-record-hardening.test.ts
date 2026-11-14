// TE-F8 review fixes (Opus, 2026-11-13): headers kept in a recording, completeness of streams per family, task end vs in-flight work, one record at a time, company of the adapter, truncated reports, an adapter that throws late.
import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RECORDING_NOT_RECORDED_FAILED, RECORDING_NOT_RECORDED_INCOMPLETE, RECORDING_NOT_RUN_ENDED, RECORDING_NOT_RUN_SCOPE, answerIsComplete, capSentence, detectPromptChanges, e2eSecretSpellings, planRecording, recordedHeaders,
  recordingLimitSentence, type ModelEgress, type RecordingStore, type RecordReplayServe,
} from "@agentx/contracts";
import { installNetworkTripwire, type NetworkTripwire } from "../../packages/testing/src/ports/no-network.js";
import { COMPANY_A, COMPANY_B, SYSTEM_TEXT, changedReport, chatFrame, drain, geminiFrame, makeRig, messagesFrame, type Rig, type StoreKind } from "./model-record-support.js";
import { recordingCompanyDirName, recordingTaskDirName } from "../../packages/worker/src/model-record-store-task.js";
import { join } from "node:path";

const SSE: Array<[string, string]> = [["content-type", "text/event-stream"]];
const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const two = () => changedReport({ model: "fixture-large", oldModel: "fixture-small" });
const stream = (served: RecordReplayServe) => {
  if (served.kind !== "stream") throw new Error(`expected a stream, got ${served.kind}`);
  return served;
};

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  tripwire.restore();
  expect(tripwire.attempts).toEqual([]);
});

describe("M1: a recording keeps content-type and cache-control only", () => {
  it("recordedHeaders is an allow list of two, each once, with printable short values", () => {
    expect(recordedHeaders([["Content-Type", "application/json"], ["content-type", "x"], ["X-Request-Id", "r"], ["request-id", "r"], ["cache-control", "no-store"], ["retry-after", "3"], ["content-type", "bad\u0001"]])).toEqual([["content-type", "application/json"], ["cache-control", "no-store"]]);
    expect(recordedHeaders([["content-type", "x".repeat(300)]])).toEqual([]);
  });

  it.each(["memory", "file"] as StoreKind[])("a key echoed in x-request-id by a forgetful adapter is in no stored header and no replayed head (%s)", async (kind) => {
    const rig = makeRig(kind, { report: two(), mutation: "unfiltered_headers" });
    try {
      const key = rig.world.keysOf(COMPANY_A)[0]!;
      rig.world.provider.script({ headers: [["content-type", "application/json"], ["x-request-id", `echo-${key}`], ["request-id", `echo-${key}`], ["cache-control", "no-store"]] });
      const engine = rig.engine();
      await drain(await engine.serve(chatFrame(rig.world, { system: SYSTEM_TEXT })));
      const entry = (await rig.store.get(rig.scope, (await rig.store.list(rig.scope))[0]!.key))!;
      expect(entry.answer.headers).toEqual([["content-type", "application/json"], ["cache-control", "no-store"]]);
      const replayed = await drain(await engine.serve(chatFrame(rig.world, { system: SYSTEM_TEXT })));
      const head = replayed.events.find((event) => event.kind === "head");
      const text = JSON.stringify([entry.answer.headers, head]);
      for (const form of e2eSecretSpellings(key)) expect(text.includes(form)).toBe(false);
      expect(head).toMatchObject({ headers: [["content-type", "application/json"], ["cache-control", "no-store"]] });
    } finally {
      rig.cleanup();
    }
  });
});

describe("M2: a stream is recorded only when it shows its own end", () => {
  const openaiPart = 'data: {"choices":[{"delta":{"content":"Trains "}}]}\n\n';
  const openaiUsage = 'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n';
  const anthropicStart = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}\n\n';
  const anthropicDelta = 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n';
  const anthropicStop = 'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":5}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
  const geminiPart = 'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":1}}\n\n';
  const geminiLast = 'data: {"candidates":[{"content":{"parts":[{"text":"!"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5}}\n\n';

  it("answerIsComplete, family by family", () => {
    const yes = (family: string, text: string, stream = true) => answerIsComplete(family, stream, enc(text));
    expect(yes("openai_compatible", openaiPart + "data: [DONE]\n\n")).toBe(true);
    expect(yes("openai_compatible", openaiPart + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')).toBe(true);
    expect(yes("openai_compatible", openaiPart + openaiUsage)).toBe(false);
    expect(yes("openai_compatible", openaiPart + 'data: {"choices":[{"delta":{},"finish_reason":null}]}\n\n')).toBe(false);
    expect(yes("anthropic_messages", anthropicStart + anthropicDelta + anthropicStop)).toBe(true);
    expect(yes("anthropic_messages", anthropicStart + anthropicDelta)).toBe(false);
    expect(yes("gemini", geminiPart + geminiLast)).toBe(true);
    expect(yes("gemini", geminiPart)).toBe(false);
    expect(yes("gemini", `[${JSON.stringify({ candidates: [{ finishReason: "STOP" }] })}]`)).toBe(true);
    expect(yes("gemini", `[${JSON.stringify({ candidates: [{}] })},`)).toBe(false);
    expect(yes("vertex", geminiPart + geminiLast)).toBe(true);
    expect(yes("cohere", 'event: message-end\ndata: {"type":"message-end"}\n\n')).toBe(true);
    expect(yes("bedrock", openaiPart + "data: [DONE]\n\n")).toBe(false);
    // Not a stream: one whole JSON document, or not complete.
    expect(yes("openai_compatible", '{"choices":[]}', false)).toBe(true);
    expect(yes("openai_compatible", '{"choices":[', false)).toBe(false);
    expect(answerIsComplete("openai_compatible", true, new Uint8Array([0xff, 0xfe]))).toBe(false);
  });

  const probes: Array<[string, "openai" | "anthropic" | "gemini", (rig: Rig) => Record<string, unknown>, string[], string[]]> = [
    ["OpenAI-compatible", "openai", (rig: Rig) => chatFrame(rig.world, { system: SYSTEM_TEXT, stream: true }), [openaiPart, openaiUsage], [openaiPart, openaiUsage, "data: [DONE]\n\n"]],
    ["Anthropic", "anthropic", (rig: Rig) => messagesFrame(rig.world, { system: SYSTEM_TEXT, extra: { stream: true } }), [anthropicStart, anthropicDelta], [anthropicStart, anthropicDelta, anthropicStop]],
    ["Gemini", "gemini", (rig: Rig) => ({ ...geminiFrame(rig.world, { system: SYSTEM_TEXT }), path: "/v1beta/models/fixture-small:streamGenerateContent" }), [geminiPart], [geminiPart, geminiLast]],
  ];
  describe.each(probes)("%s", (_name, rowKey, frameOf, truncated, whole) => {
    it.each(["memory", "file"] as StoreKind[])("a stream that closes cleanly before its end (usage already sent) is not recorded; the whole stream is (%s)", async (kind) => {
      const rig = makeRig(kind, { report: two() });
      try {
        const frame = frameOf(rig);
        const engine = rig.engine({ rowKey });
        rig.world.provider.script({ chunks: truncated, headers: SSE });
        const first = await drain(await engine.serve(frame));
        expect(first.events.at(-1)).toMatchObject({ kind: "settle", class: "ok" });
        expect(await rig.store.list(rig.scope)).toEqual([]);
        expect((await engine.summary()).items.some((item) => item.sentence === RECORDING_NOT_RECORDED_INCOMPLETE)).toBe(true);
        rig.world.provider.script({ chunks: whole, headers: SSE });
        await drain(await engine.serve(frame));
        expect(await rig.store.list(rig.scope)).toHaveLength(1);
      } finally {
        rig.cleanup();
      }
    });
  });
});

describe.each(["memory", "file"] as StoreKind[])("M3: nothing survives endTask (%s)", (kind) => {
  let rig: Rig;
  beforeEach(() => {
    rig = makeRig(kind, { report: two() });
  });
  afterEach(() => rig.cleanup());

  it("endTask during an in-flight stream leaves no entry, and the answer is still delivered", async () => {
    const engine = rig.engine();
    const served = stream(await engine.serve(chatFrame(rig.world, { system: SYSTEM_TEXT })));
    const seen: string[] = [];
    let ending: Promise<number> | undefined;
    for await (const event of served.events) {
      seen.push(event.kind);
      if (event.kind === "head") ending = engine.endTask();
    }
    expect(seen).toEqual(["head", "chunk", "settle"]);
    await ending;
    expect(await rig.store.list(rig.scope)).toEqual([]);
    if (kind === "file") expect(existsSync(join(rig.rootDir, recordingCompanyDirName(rig.scope.companyId), recordingTaskDirName(rig.scope.taskId)))).toBe(false);
  });

  it("endTask while the put is in flight waits for it, then deletes: nothing is left", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const slow: RecordingStore = { ...rig.store, put: async (scope, entry) => { await gate; await rig.store.put(scope, entry); } };
    const engine = rig.engine({ store: slow });
    const served = stream(await engine.serve(chatFrame(rig.world, { system: SYSTEM_TEXT })));
    const draining = drain(served);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const ending = engine.endTask();
    await new Promise((resolve) => setTimeout(resolve, 20));
    open();
    await Promise.all([draining, ending]);
    expect(await rig.store.list(rig.scope)).toEqual([]);
  });

  it("after endTask a call is refused with the fixed words, no call is made, and a replay is not served", async () => {
    const engine = rig.engine();
    await drain(await engine.serve(chatFrame(rig.world, { system: SYSTEM_TEXT })));
    await engine.endTask();
    expect(await engine.serve(chatFrame(rig.world, { system: SYSTEM_TEXT }))).toEqual({ kind: "not_run", reason: "ended", sentence: RECORDING_NOT_RUN_ENDED });
    expect(rig.world.provider.calls).toHaveLength(1);
    expect(await rig.store.list(rig.scope)).toEqual([]);
  });
});

describe("M4: one record at a time, and the stop carries to the next round", () => {
  let rig: Rig;
  beforeEach(() => {
    rig = makeRig("memory", { report: two() });
  });
  afterEach(() => rig.cleanup());

  it("two concurrent calls for one prompt are exactly one real call; the second is a replay", async () => {
    const engine = rig.engine();
    const frame = chatFrame(rig.world, { system: SYSTEM_TEXT });
    const firstP = engine.serve(frame);
    const secondP = engine.serve(frame);
    const first = stream(await firstP);
    expect(first.via).toBe("forwarded");
    await drain(first);
    const second = stream(await secondP);
    expect(second.via).toBe("replayed");
    await drain(second);
    expect(rig.world.provider.calls).toHaveLength(1);
    expect(engine.forwards).toBe(1);
  });

  it("a forwarded stream that will not be read gives the slot back with abandon()", async () => {
    const engine = rig.engine();
    const frame = chatFrame(rig.world, { system: SYSTEM_TEXT });
    const first = stream(await engine.serve(frame));
    const secondP = engine.serve(frame);
    first.abandon();
    const second = stream(await secondP);
    expect(second.via).toBe("forwarded");
    await drain(first);
    expect(rig.world.provider.calls).toHaveLength(0);
    await drain(second);
    expect(rig.world.provider.calls).toHaveLength(1);
  });

  it("a new engine in a later round keeps the overrun stop and the count of real calls it is given", async () => {
    const overrunning = { body: JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 10_000_000 } }) };
    await rig.world.setCap(COMPANY_A, 1000);
    rig.world.provider.script(overrunning);
    const first = rig.engine({ capMicros: 1000 });
    await drain(await first.serve(chatFrame(rig.world, { system: SYSTEM_TEXT, model: "fixture-small" })));
    expect(first.taskState).toEqual({ overrun: true, forwards: 1 });
    const next = rig.engine({ capMicros: 1000, taskState: first.taskState });
    expect(await next.serve(chatFrame(rig.world, { user: "x", model: "fixture-large" }))).toEqual({ kind: "not_run", reason: "budget", sentence: capSentence(1000) });
    // The count of real calls carries too (a fresh store: only the given count can stop this call).
    const fresh = makeRig("memory", { report: two() });
    try {
      const counted = fresh.engine({ maxRecordings: 1, taskState: { forwards: 1 } });
      expect(await counted.serve(chatFrame(fresh.world, { user: "x", model: "fixture-large" }))).toEqual({ kind: "not_run", reason: "limit", sentence: recordingLimitSentence(1) });
      expect(counted.taskState.forwards).toBe(1);
    } finally {
      fresh.cleanup();
    }
  });
});

describe("L3: the adapter's company and the recording's company are one", () => {
  it("a call is refused when they differ, in either direction, with no call and nothing stored", async () => {
    const rig = makeRig("memory", { report: two() });
    try {
      const frame = chatFrame(rig.world, { system: SYSTEM_TEXT });
      const mismatched = rig.engine({ company: COMPANY_B, scope: () => ({ companyId: COMPANY_A.orgId, taskId: "task-1" }) });
      expect(await mismatched.serve(frame)).toEqual({ kind: "not_run", reason: "scope", sentence: RECORDING_NOT_RUN_SCOPE });
      const other = rig.engine({ company: COMPANY_A, scope: () => ({ companyId: COMPANY_B.orgId, taskId: "task-1" }) });
      expect(await other.serve(frame)).toEqual({ kind: "not_run", reason: "scope", sentence: RECORDING_NOT_RUN_SCOPE });
      const unreadable = rig.engine({ egressCompanyOf: () => { throw new Error("no"); } });
      expect(await unreadable.serve(frame)).toMatchObject({ kind: "not_run", reason: "scope" });
      expect(rig.world.provider.calls).toHaveLength(0);
      expect(await rig.store.list({ companyId: COMPANY_B.orgId, taskId: "task-1" })).toEqual([]);
    } finally {
      rig.cleanup();
    }
  });
});

describe("L4: a truncated report says so", () => {
  it("the headline names the items that were not listed", async () => {
    const files = Array.from({ length: 600 }, (_, i) => ({ path: `prompts/p${String(i).padStart(3, "0")}.txt`, before: "old", after: `new text ${String(i)}`, wholeFile: true }));
    const report = detectPromptChanges({ files }).report;
    expect(report.itemsTruncated).toBe(true);
    expect(planRecording(report)).toMatchObject({ status: "ready", itemsOmitted: true });
    const rig = makeRig("memory", { report });
    try {
      const summary = await rig.engine().summary();
      expect(summary.itemsOmitted).toBe(true);
      expect(summary.headline.endsWith("; some changed items not recorded (report truncated)")).toBe(true);
      const plain = await makeRig("memory", { report: two() }).engine().summary();
      expect(plain.headline).not.toContain("truncated");
    } finally {
      rig.cleanup();
    }
  });
});

describe("R1: an adapter that throws after it sent its settle", () => {
  it.each(["memory", "file"] as StoreKind[])("is an error with fixed words, and nothing is recorded (%s)", async (kind) => {
    const rig = makeRig(kind, { report: two() });
    try {
      const real = rig.world.adapter;
      const secret = "provider-text-" + ["not", "a", "key"].join("-");
      const late: ModelEgress = {
        capabilities: real.capabilities,
        async *forward(scope, frame, options) {
          yield* real.forward(scope, frame, options);
          throw new Error(secret);
        },
      };
      const engine = rig.engine({ egress: late });
      const served = stream(await engine.serve(chatFrame(rig.world, { system: SYSTEM_TEXT })));
      const seen: string[] = [];
      let failure = "";
      try {
        for await (const event of served.events) seen.push(event.kind);
      } catch (error) {
        failure = (error as Error).message;
      }
      expect(seen).toEqual(["head", "chunk", "settle"]);
      expect(failure).toBe("the model call failed");
      expect(failure).not.toContain(secret);
      expect(await rig.store.list(rig.scope)).toEqual([]);
      expect((await engine.summary()).items.some((item) => item.sentence === RECORDING_NOT_RECORDED_FAILED)).toBe(true);
    } finally {
      rig.cleanup();
    }
  });
});
