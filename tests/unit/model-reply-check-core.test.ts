import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkReplySetAgainstReal, ReplyCheckReportSchema, type ReplyProbe } from "../../packages/contracts/src/model-reply-check.js";
import { modelReplyEntrySha256, type ModelReplySet, type ModelReplyResponse } from "../../packages/contracts/src/model-reply-set.js";
import { createFakeEgress, createFakeProvider, fakeScope, type FakeBehaviour } from "../../packages/testing/src/ports/model-egress-fake.js";
import { fixtureEgressRows, fixtureKey, FIXTURE_VERTEX_CONNECTION } from "../../packages/testing/src/ports/model-egress-fixtures.js";
import { installNetworkTripwire } from "../../packages/testing/src/ports/no-network.js";
import type { ModelEgress, ModelEgressScope } from "../../packages/contracts/src/ports/model-egress.js";

const enc = (s: string) => new TextEncoder().encode(s);
const today = "2026-11-13";
type Family = ModelReplySet["family"];
const cases: { family: Family; row: "openai" | "anthropic" | "gemini" | "cohere" | "vertex"; path: string; body: Record<string, unknown>; answer: Record<string, unknown> }[] = [
  { family: "openai_compatible", row: "openai", path: "/v1/chat/completions", body: { model: "fixture-small", messages: [{ role: "user", content: "hello" }] }, answer: { choices: [{ message: { content: "answer" }, finish_reason: "stop" }] } },
  { family: "anthropic_messages", row: "anthropic", path: "/v1/messages", body: { model: "fixture-small", messages: [{ role: "user", content: "hello" }], max_tokens: 32 }, answer: { content: [{ type: "text", text: "answer" }], stop_reason: "end_turn" } },
  { family: "gemini", row: "gemini", path: "/v1beta/models/fixture-small:generateContent", body: { contents: [{ parts: [{ text: "hello" }] }] }, answer: { candidates: [{ content: { parts: [{ text: "answer" }] }, finishReason: "STOP" }] } },
  { family: "cohere", row: "cohere", path: "/v2/chat", body: { model: "fixture-small", messages: [{ role: "user", content: "hello" }] }, answer: { message: { content: [{ type: "text", text: "answer" }] }, finish_reason: "COMPLETE" } },
  { family: "vertex", row: "vertex", path: "/v1/projects/fixture-project-1/locations/us-central1/publishers/google/models/fixture-small:generateContent", body: { contents: [{ parts: [{ text: "hello" }] }] }, answer: { candidates: [{ content: { parts: [{ text: "answer" }] }, finishReason: "STOP" }] } },
];
export function checkWorld(index = 0, response: ModelReplyResponse = { text: "scripted", finish: "stop" }) {
  const c = cases[index]!;
  const row = fixtureEgressRows()[c.row];
  const set: ModelReplySet = { version: 1, family: c.family, replies: [{ id: "reply-a", match: { promptContains: "hello" }, response, provenance: "task_made" }] };
  const probe: ReplyProbe = { replyId: "reply-a", entrySha256: modelReplyEntrySha256(set.replies[0]!), family: c.family, rowId: row.id,
    frame: { row: row.id, method: "POST", path: c.path, query: "", headers: [], body: enc(JSON.stringify(c.body)) } };
  const provider = createFakeProvider([row]);
  const fake = createFakeEgress({ rows: [row], sources: [{ company: "a", id: "source", row, connection: FIXTURE_VERTEX_CONNECTION, key: fixtureKey("check"), capMicros: 1_000_000 }], provider });
  // The fake package imports the built contracts; source tests use the same opaque port brand from src.
  const args = { set, probes: [probe], egress: fake.adapter as unknown as ModelEgress, scope: fakeScope("a", "source") as unknown as ModelEgressScope, today };
  return { c, row, set, probe, provider, fake, args, answer: c.answer };
}
let tripwire: ReturnType<typeof installNetworkTripwire>;
beforeEach(() => { tripwire = installNetworkTripwire(); });
afterEach(() => { tripwire.restore(); expect(tripwire.attempts).toEqual([]); });

describe("reply health through the real egress core and fake transport", () => {
  for (const [index, c] of cases.entries()) {
    it(`${c.family}: fits without comparing text, never edits provenance`, async () => {
      const w = checkWorld(index); const before = JSON.stringify(w.set);
      w.provider.script({ body: JSON.stringify(w.answer) });
      const report = await checkReplySetAgainstReal(w.args);
      expect(report.items[0]).toEqual({ replyId: "reply-a", entrySha256: w.probe.entrySha256, verdict: "still_fits", reasons: [] });
      expect(report.counts).toEqual({ still_fits: 1, drifted: 0, not_run: 0 });
      expect(ReplyCheckReportSchema.safeParse(report).success).toBe(true);
      expect(w.provider.calls).toHaveLength(1); expect(JSON.stringify(w.set)).toBe(before);
    });
    it(`${c.family}: JSON object key/type and finish drift`, async () => {
      const w = checkWorld(index, { text: '{"ok":true}', finish: "length" });
      w.provider.script({ body: JSON.stringify(w.answer) });
      expect((await checkReplySetAgainstReal(w.args)).items[0]).toMatchObject({ verdict: "drifted", reasons: ["finish_changed", "text_json_shape_changed"] });
    });
    for (const [reason, behaviour] of Object.entries({ rate_limit: { status: 429 }, quota: { status: 429, body: '{"error":{"code":"insufficient_quota"}}' }, overloaded: { status: 503 }, key_refused: { status: 401 }, provider_error: { fault: true } } satisfies Record<string, FakeBehaviour>)) {
      it(`${c.family}: ${reason} is not drift and never retries`, async () => {
        const w = checkWorld(index); w.provider.script(behaviour);
        const report = await checkReplySetAgainstReal(w.args);
        expect(report.items[0]).toMatchObject({ verdict: "not_run", reasons: [reason] });
        expect(report.counts.drifted).toBe(0); expect(w.provider.calls).toHaveLength(1);
      });
    }
    it(`${c.family}: cap is not drift`, async () => {
      const w = checkWorld(index); w.fake.setCap("a", 0);
      expect((await checkReplySetAgainstReal(w.args)).items[0]).toMatchObject({ verdict: "not_run", reasons: ["cap"] });
      expect(w.provider.calls).toHaveLength(0);
    });
    it(`${c.family}: malformed answer fails closed`, async () => {
      const w = checkWorld(index); w.provider.script({ body: '{}' });
      expect((await checkReplySetAgainstReal(w.args)).items[0]).toMatchObject({ verdict: "not_run", reasons: ["answer_unreadable"] });
    });
  }
  it("no probe, stale hash, wrong reply, wrong family and wrong prompt never call", async () => {
    for (const edit of ["missing", "hash", "id", "family", "prompt", "sequence", "row"] as const) {
      const w = checkWorld();
      if (edit === "missing") w.args.probes = [];
      if (edit === "hash") w.probe.entrySha256 = "0".repeat(64);
      if (edit === "id") w.probe.replyId = "reply-other";
      if (edit === "family") w.probe.family = "cohere";
      if (edit === "prompt") w.probe.frame.body = enc('{"model":"fixture-small","messages":[{"content":"different"}]}');
      if (edit === "row") w.probe.rowId = "other";
      if (edit === "sequence") { w.set.replies[0]!.match.sequence = 2; w.probe.entrySha256 = modelReplyEntrySha256(w.set.replies[0]!); }
      const report = await checkReplySetAgainstReal(w.args);
      expect(report.items[0]).toMatchObject({ verdict: "not_run", reasons: [edit === "missing" || edit === "id" ? "no_probe" : "probe_does_not_match_reply"] });
      expect(w.provider.calls).toHaveLength(0);
    }
  });
  it("streaming probes are explicitly deferred", async () => {
    const w = checkWorld(); w.probe.frame.body = enc(JSON.stringify({ ...w.c.body, stream: true }));
    expect((await checkReplySetAgainstReal(w.args)).items[0]?.reasons).toEqual(["streaming_probe_later"]);
    expect(w.provider.calls).toHaveLength(0);
  });
  it("unsupported operation is unreadable without spending", async () => {
    const w = checkWorld(); w.probe.frame.path = "/v1/responses";
    expect((await checkReplySetAgainstReal(w.args)).items[0]?.reasons).toEqual(["answer_unreadable"]);
    expect(w.provider.calls).toHaveLength(0);
  });
  it("maxProbes and overrun stop before another forward, even if adapter could answer", async () => {
    for (const overrun of [false, true]) {
      const w = checkWorld(); w.set.replies.push({ ...w.set.replies[0]!, id: "reply-b" });
      w.args.probes.push({ ...w.probe, replyId: "reply-b", entrySha256: modelReplyEntrySha256(w.set.replies[1]!) });
      let forwards = 0;
      const egress: ModelEgress = { capabilities: { schemes: [] }, async *forward() { forwards++; yield { kind: "head", status: 200, headers: [] }; yield { kind: "chunk", bytes: enc(JSON.stringify(w.answer)) }; yield { kind: "settle", status: 200, class: "ok", costMicros: 0, estimated: false, overrun }; } };
      const report = await checkReplySetAgainstReal({ ...w.args, egress, limits: { maxProbes: overrun ? 50 : 1 } });
      expect(report.items.map((i) => i.verdict)).toEqual(["still_fits", "not_run"]);
      expect(report.items[1]?.reasons).toEqual(["run_cap_reached"]); expect(forwards).toBe(1);
    }
  });
  it("default cap is 50 and invalid caps fail closed", async () => {
    const w = checkWorld();
    w.set.replies = Array.from({ length: 51 }, (_, i) => ({ ...w.set.replies[0]!, id: `reply-${String(i).padStart(2, "0")}` }));
    w.args.probes = w.set.replies.map((r) => ({ ...w.probe, replyId: r.id, entrySha256: modelReplyEntrySha256(r) }));
    w.provider.script(...w.args.probes.map(() => ({ body: JSON.stringify(w.answer) })));
    expect((await checkReplySetAgainstReal(w.args)).counts).toEqual({ still_fits: 50, drifted: 0, not_run: 1 });
    expect(w.provider.calls).toHaveLength(50);
    for (const maxProbes of [-1, Infinity, NaN, 1.5, 0]) {
      const report = await checkReplySetAgainstReal({ ...w.args, limits: { maxProbes } });
      expect(report.counts.still_fits).toBe(0);
    }
  });
  it("safe label and supplied date, no clock; rejects unsafe model echoes", async () => {
    for (const model of ["fixture-small", "bad <model>"]) {
      const w = checkWorld(); w.probe.frame.body = enc(JSON.stringify({ ...w.c.body, model }));
      w.provider.script({ body: JSON.stringify(w.answer) });
      expect((await checkReplySetAgainstReal(w.args)).label).toBe(`scripted replies checked against real ${model === "fixture-small" ? model : "the model"} on ${today}`);
    }
  });
  it("shuffled probes and set order have the same report; duplicates are refused", async () => {
    const run = async (reverse: boolean) => {
      const w = checkWorld(); w.set.replies.push({ ...w.set.replies[0]!, id: "reply-b" });
      w.args.probes.push({ ...w.probe, replyId: "reply-b", entrySha256: modelReplyEntrySha256(w.set.replies[1]!) });
      if (reverse) { w.args.probes.reverse(); w.set.replies.reverse(); }
      w.provider.script({ body: JSON.stringify(w.answer) }, { body: JSON.stringify(w.answer) });
      return checkReplySetAgainstReal(w.args);
    };
    expect(await run(false)).toEqual(await run(true));
    const w = checkWorld(); w.args.probes.push(w.probe);
    expect((await checkReplySetAgainstReal(w.args)).items[0]?.reasons).toEqual(["probe_does_not_match_reply"]);
  });
  it("proto keys and depth above 16 are unreadable", async () => {
    for (const body of ['{"__proto__":{},"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}', JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], extra: Array.from({ length: 17 }).reduce<unknown>((v) => ({ x: v }), 0) })]) {
      const w = checkWorld(); w.provider.script({ body });
      expect((await checkReplySetAgainstReal(w.args)).items[0]?.reasons).toEqual(["answer_unreadable"]);
    }
  });
  it("bounded 1 MiB answer completes without echoing", async () => {
    const w = checkWorld(); w.provider.script({ body: JSON.stringify({ choices: [{ message: { content: "x".repeat(1024 * 1024) }, finish_reason: "stop" }] }) });
    const start = performance.now(); const report = await checkReplySetAgainstReal(w.args);
    expect(report.items[0]?.reasons).toEqual(["answer_unreadable"]); expect(performance.now() - start).toBeLessThan(2000);
  });
  it("runtime canaries never reach reports or thrown errors, including hostile getters", async () => {
    const canary = ["canary", String(Math.floor(Math.random() * 1e9))].join("-");
    const w = checkWorld(0, { text: canary, finish: "stop", toolCalls: [{ name: "tool", args: { secret: canary } }] });
    w.probe.frame.body = enc(JSON.stringify({ model: "fixture-small", messages: [{ content: `hello ${canary}` }], tools: [{ type: "function", function: { name: "tool", parameters: { type: "object" } } }] }));
    w.provider.script({ body: JSON.stringify({ choices: [{ message: { content: canary, tool_calls: [{ function: { name: "tool", arguments: JSON.stringify({ secret: canary }) } }] }, finish_reason: "tool_calls" }] }) });
    const report = await checkReplySetAgainstReal(w.args);
    expect(w.provider.calls).toHaveLength(1); expect(JSON.stringify(report)).not.toContain(canary);
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- hostile inputs may throw raw customer text; the checker must contain it.
    const hostile = Object.defineProperty({}, "set", { get() { throw canary; } });
    await expect(checkReplySetAgainstReal(hostile as never)).resolves.toBeDefined();
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- deliberately exercise a non-Error dependency fault.
    const egress: ModelEgress = { capabilities: { schemes: [] }, forward() { throw canary; } };
    expect(JSON.stringify(await checkReplySetAgainstReal({ ...w.args, egress }))).not.toContain(canary);
  });
  it("strict report parsing refuses extra text, inconsistent counts and mixed reasons", async () => {
    const w = checkWorld(); const r = await checkReplySetAgainstReal({ ...w.args, probes: [] });
    expect(ReplyCheckReportSchema.safeParse({ ...r, prompt: "leak" }).success).toBe(false);
    expect(ReplyCheckReportSchema.safeParse({ ...r, counts: { still_fits: 1, drifted: 0, not_run: 0 } }).success).toBe(false);
    expect(ReplyCheckReportSchema.safeParse({ ...r, items: [{ ...r.items[0], verdict: "drifted" }] }).success).toBe(false);
  });
});

describe("tool and declared shapes", () => {
  it("compares tool name sets and nested argument types, ignoring values", async () => {
    for (const [name, args, reasons] of [
      ["tool", { inner: { count: 5 } }, []],
      ["other", { inner: { count: 5 } }, ["tool_names_changed"]],
      ["tool", { inner: { count: "5" } }, ["tool_args_shape_changed"]],
    ] as const) {
      const w = checkWorld(0, { text: "", finish: "tool_calls", toolCalls: [{ name: "tool", args: { inner: { count: 1 } } }] });
      w.provider.script({ body: JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }] }) });
      expect((await checkReplySetAgainstReal(w.args)).items[0]?.reasons).toEqual(reasons);
    }
  });
  it("validates declared JSON types, required keys and enums; unsupported keywords are ignored", async () => {
    for (const text of ['{"ok":true}', '{"ok":"yes"}', '{}', '{"ok":false}']) {
      const w = checkWorld(0, { text: '{"ok":true}', finish: "stop" });
      w.probe.frame.body = enc(JSON.stringify({ ...w.c.body, response_format: { type: "json_schema", json_schema: { schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean", enum: [true], unsupportedKeyword: "ignored" } }, additionalProperties: false } } } }));
      w.provider.script({ body: JSON.stringify({ choices: [{ message: { content: text }, finish_reason: "stop" }] }) });
      const report = await checkReplySetAgainstReal(w.args);
      expect(report.items[0]?.reasons.includes("declared_shape_failed")).toBe(text !== '{"ok":true}');
    }
  });
  it("validates declared JSON constraints independently, including nested array items", async () => {
    const cases: { schema: unknown; text: string; fits: boolean }[] = [
      { schema: { type: "object", properties: { ok: { type: "boolean" } } }, text: '{"ok":"yes"}', fits: false },
      { schema: { required: ["ok"] }, text: '{}', fits: false },
      { schema: { properties: { ok: { enum: [true] } } }, text: '{"ok":false}', fits: false },
      { schema: { properties: { ok: { type: "array", items: { type: "integer" } } } }, text: '{"ok":[1,2.5]}', fits: false },
      { schema: { properties: { ok: { type: "array", items: { type: "integer" } } } }, text: '{"ok":[1,2]}', fits: true },
      { schema: { additionalProperties: false, unsupportedKeyword: "ignored" }, text: '{"extra":true}', fits: true },
    ];
    for (const c of cases) {
      const w = checkWorld(0, { text: c.text, finish: "stop" });
      w.probe.frame.body = enc(JSON.stringify({ ...w.c.body, response_format: { type: "json_schema", json_schema: { schema: c.schema } } }));
      w.provider.script({ body: JSON.stringify({ choices: [{ message: { content: c.text }, finish_reason: "stop" }] }) });
      expect((await checkReplySetAgainstReal(w.args)).items[0]?.reasons).toEqual(c.fits ? [] : ["declared_shape_failed"]);
    }
  });
  it("Anthropic input_schema and Gemini functionDeclarations are validated", async () => {
    for (const index of [1, 2]) {
      const w = checkWorld(index, { text: "", finish: "tool_calls", toolCalls: [{ name: "tool", args: { ok: false } }] });
      const schema = { type: "object", required: ["ok"], properties: { ok: { type: "boolean", enum: [true] } } };
      w.probe.frame.body = enc(JSON.stringify({ ...w.c.body, tools: index === 1 ? [{ name: "tool", input_schema: schema }] : [{ functionDeclarations: [{ name: "tool", parameters: schema }] }] }));
      const body = index === 1 ? { content: [{ type: "tool_use", name: "tool", input: { ok: false } }], stop_reason: "tool_use" } : { candidates: [{ content: { parts: [{ functionCall: { name: "tool", args: { ok: false } } }] }, finishReason: "STOP" }] };
      w.provider.script({ body: JSON.stringify(body) });
      expect((await checkReplySetAgainstReal(w.args)).items[0]?.reasons).toEqual(["declared_shape_failed"]);
    }
  });
  it("Gemini responseSchema uses uppercase types", async () => {
    const w = checkWorld(2, { text: '{"ok":false}', finish: "stop" });
    w.probe.frame.body = enc(JSON.stringify({ ...w.c.body, generationConfig: { responseSchema: { type: "OBJECT", required: ["ok"], properties: { ok: { type: "BOOLEAN", enum: [true] } } } } }));
    w.provider.script({ body: JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":false}' }] }, finishReason: "STOP" }] }) });
    expect((await checkReplySetAgainstReal(w.args)).items[0]?.reasons).toEqual(["declared_shape_failed"]);
  });
});

describe("malformed boundaries", () => {
  it("invalid date, set, missing settle and out-of-order events cannot pass", async () => {
    const w = checkWorld();
    for (const date of ["2026-02-30", "2026-11-13\n@all", "", "2026-13-01"]) {
      expect((await checkReplySetAgainstReal({ ...w.args, today: date })).counts.still_fits).toBe(0);
    }
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    for (const set of [null, undefined, cycle, { ...w.set, replies: Array.from({ length: 2001 }, () => w.set.replies[0]) }]) await expect(checkReplySetAgainstReal({ ...w.args, set } as never)).resolves.toBeDefined();
    for (const reversed of [false, true]) {
      const egress: ModelEgress = { capabilities: { schemes: [] }, async *forward() {
        if (reversed) yield { kind: "settle", status: 200, class: "ok", costMicros: 0, estimated: false };
        yield { kind: "head", status: 200, headers: [] }; yield { kind: "chunk", bytes: enc(JSON.stringify(w.answer)) };
      } };
      expect((await checkReplySetAgainstReal({ ...w.args, egress })).items[0]).toMatchObject({ verdict: "not_run", reasons: ["answer_unreadable"] });
    }
    expect(w.provider.calls).toHaveLength(0);
  });
  it("request and embedded tool JSON refuse prototype keys and oversized depth", async () => {
    const w = checkWorld(); w.probe.frame.body = enc('{"__proto__":{},"messages":[{"content":"hello"}]}');
    expect((await checkReplySetAgainstReal(w.args)).items[0]?.reasons).toEqual(["probe_does_not_match_reply"]);
    expect(w.provider.calls).toHaveLength(0);
    const x = checkWorld(); x.provider.script({ body: JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ function: { name: "tool", arguments: '{"__proto__":{}}' } }] }, finish_reason: "tool_calls" }] }) });
    expect((await checkReplySetAgainstReal(x.args)).items[0]?.reasons).toEqual(["answer_unreadable"]);
  });
});

describe("JSON embedded in answer text", () => {
  it("refuses object text that exceeds the JSON depth limit or contains a prototype key", async () => {
    const nested = JSON.stringify(Array.from({ length: 18 }).reduce<unknown>((v) => ({ x: v }), 0));
    for (const text of ['{"__proto__":{}}', nested]) {
      const w = checkWorld();
      w.provider.script({ body: JSON.stringify({ choices: [{ message: { content: text }, finish_reason: "stop" }] }) });
      expect((await checkReplySetAgainstReal(w.args)).items[0]?.reasons).toEqual(["answer_unreadable"]);
    }
  });
});

describe("declared tool selection", () => {
  it("a tool absent from the request's declarations cannot satisfy its declared shape", async () => {
    const w = checkWorld(0, { text: "", finish: "tool_calls", toolCalls: [{ name: "other", args: {} }] });
    w.probe.frame.body = enc(JSON.stringify({ ...w.c.body, tools: [{ type: "function", function: { name: "declared", parameters: { type: "object" } } }] }));
    w.provider.script({ body: JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ function: { name: "other", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }) });
    expect((await checkReplySetAgainstReal(w.args)).items[0]?.reasons).toEqual(["declared_shape_failed"]);
  });
});

describe("per-family tool drift", () => {
  for (const [index, c] of cases.entries()) it(`${c.family}: tool names and argument types are compared`, async () => {
    for (const changedName of [false, true]) {
      const name = changedName ? "other" : "tool"; const args = { count: "wrong-type" };
      const w = checkWorld(index, { text: "", finish: "tool_calls", toolCalls: [{ name: "tool", args: { count: 1 } }] });
      let body: unknown;
      if (c.family === "openai_compatible") body = { choices: [{ message: { content: "", tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }] };
      else if (c.family === "anthropic_messages") body = { content: [{ type: "tool_use", name, input: args }], stop_reason: "tool_use" };
      else if (c.family === "cohere") body = { message: { content: [], tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "TOOL_CALL" };
      else body = { candidates: [{ content: { parts: [{ functionCall: { name, args } }] }, finishReason: "STOP" }] };
      w.provider.script({ body: JSON.stringify(body) });
      expect((await checkReplySetAgainstReal(w.args)).items[0]?.reasons).toEqual([changedName ? "tool_names_changed" : "tool_args_shape_changed"]);
    }
  });
});

describe("probe selection facts", () => {
  it("matches model, operation, prompt hash and sequence as the first call", async () => {
    // SHA-256 of UTF-8 hello, independent of the selection implementation.
    const promptSha256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    for (const wrong of ["none", "model", "operation", "hash"] as const) {
      const w = checkWorld();
      w.set.replies[0]!.match = { model: wrong === "model" ? "other-model" : "fixture-small", operation: wrong === "operation" ? "responses" : "chat_completions", promptSha256: wrong === "hash" ? "0".repeat(64) : promptSha256, sequence: 1 };
      w.probe.entrySha256 = modelReplyEntrySha256(w.set.replies[0]!);
      w.provider.script({ body: JSON.stringify(w.answer) });
      const report = await checkReplySetAgainstReal(w.args);
      expect(report.items[0]?.verdict).toBe(wrong === "none" ? "still_fits" : "not_run");
      expect(w.provider.calls).toHaveLength(wrong === "none" ? 1 : 0);
    }
  });
});

describe("fault accounting", () => {
  it("halts on an unsettled transport fault without claiming the run cap was reached", async () => {
    const w = checkWorld(); w.set.replies.push({ ...w.set.replies[0]!, id: "reply-b" });
    w.args.probes.push({ ...w.probe, replyId: "reply-b", entrySha256: modelReplyEntrySha256(w.set.replies[1]!) });
    let forwards = 0;
    const egress: ModelEgress = { capabilities: { schemes: [] }, forward() { forwards++; throw new Error("fault"); } };
    expect((await checkReplySetAgainstReal({ ...w.args, egress })).items.map((i) => i.reasons)).toEqual([["provider_error"], ["provider_error"]]);
    expect(forwards).toBe(1);
  });
});
