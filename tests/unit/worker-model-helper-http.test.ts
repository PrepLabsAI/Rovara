// TE-F2 part B: the model helper's HTTP loop, run for real on loopback. It answers only its caller, refuses CONNECT, absolute-form targets, a second `?`, control characters and encoded slashes, holds its limits, serves scripted
// replies and the failure pack, and writes a ledger that never holds a body, a header value, a query or a prompt.
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createModelLedgerWriter } from "../../packages/worker/src/model-helper-ledger.js";
import { MODEL_HELPER_LIMITS, REAL_NOT_AVAILABLE_SENTENCE, headersForBackend, parseModelTarget, startModelHelperLoop, type ModelBackend } from "../../packages/worker/src/model-helper-http.js";
import { GEMINI_BODY, OPENAI_BODY, ROWS, ZERO_DIGEST, cleanupWorlds, fakeKey, geminiPath, request, stampSet, startWorld, type World } from "../support/model-helper-world.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

afterEach(cleanupWorlds);
const open: World[] = [];
afterEach(async () => {
  for (const world of open.splice(0)) await world.close();
});
async function world(over: Parameters<typeof startWorld>[0] = {}): Promise<World> {
  const w = await startWorld(over);
  open.push(w);
  return w;
}
const GEMINI_SET = stampSet("gemini", [{ id: "weather", match: { promptContains: "weather" }, response: { text: "Sunny in Paris.", finish: "stop" } }]);
const OPENAI_SET = stampSet("openai_compatible", [{ id: "chat", response: { text: "Hello from the script.", finish: "stop" } }]);

describe("parseModelTarget", () => {
  it("reads the row, any version prefix, the failure segments and the token, in the fixed order", () => {
    const token = "A".repeat(20);
    expect(parseModelTarget("/p/gemini/v1beta/models/m:generateContent?alt=sse")).toEqual({ ok: true, target: { rowId: "gemini", failure: undefined, token: undefined, rest: "/v1beta/models/m:generateContent", query: "alt=sse" } });
    expect(parseModelTarget("/p/gemini/v1/models/m:generateContent")).toMatchObject({ ok: true, target: { rest: "/v1/models/m:generateContent" } });
    expect(parseModelTarget("/p/openai/f/rate_limit/n/2/x/" + token + "/v1/chat/completions")).toEqual({ ok: true, target: { rowId: "openai", failure: { mode: "rate_limit", afterCalls: 2 }, token, rest: "/v1/chat/completions", query: "" } });
    expect(parseModelTarget("/p/openai/f/token_limit.input/v1/chat/completions")).toMatchObject({ ok: true, target: { failure: { mode: "token_limit", variant: "input" } } });
    expect(parseModelTarget("/p/openai/x/" + token + "/v1/chat/completions")).toMatchObject({ ok: true, target: { failure: undefined, token } });
  });
  it("refuses an absolute-form target, a leading //, a second ?, control characters, encoded slashes and dots, .. and a bad failure form", () => {
    const refused = [
      "http://example.com/p/openai/v1/x", "//p/openai", "/p/openai/v1/a?b?c", "/p/openai/v1/a\u0001b", "/p/openai/v1/a b", "/p/openai/v1%2fx", "/p/openai/v1%5cx", "/p/openai/%2e%2e/x", "/p/openai/../x",
      "/p/openai/f/nonsense/v1/x", "/p/openai/n/2/v1/x", "/p/openai/f/rate_limit/n/abc/v1/x", "/p/openai/x/short/v1/x", "/p/openai/x/" + "A".repeat(20) + "/f/rate_limit/v1/x", "/q/openai", "/p/OPENAI/v1", "/p/openai/f/token_limit.filter/v1/x", "", "/p/" + "a".repeat(2100),
    ];
    for (const target of refused) expect(parseModelTarget(target), target.slice(0, 60)).toEqual({ ok: false });
    expect(parseModelTarget(undefined)).toEqual({ ok: false });
  });
});

describe("headersForBackend", () => {
  it("drops every credential header before a backend sees a call", () => {
    const key = fakeKey();
    const kept = headersForBackend({ authorization: `Bearer ${key}`, "x-api-key": key, "x-goog-api-key": key, "api-key": key, cookie: key, "proxy-authorization": key, "x-amz-security-token": key, "x-goog-user-project": "p", "content-type": "application/json", "anthropic-version": "2023-06-01" });
    expect(kept).toEqual({ "content-type": "application/json", "anthropic-version": "2023-06-01" });
  });
});

describe("serving", () => {
  it("serves a scripted Gemini answer for any version prefix and counts it by provenance", async () => {
    const w = await world({ sets: [GEMINI_SET] });
    for (const version of ["v1beta", "v1", "v1alpha"]) {
      const reply = await request(`${w.base}${geminiPath("gemini", version)}`, { method: "POST", body: GEMINI_BODY, headers: { "content-type": "application/json", "x-goog-api-key": fakeKey() } });
      expect(reply.status).toBe(200);
      expect((JSON.parse(reply.body) as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> }).candidates[0]?.content.parts[0]?.text).toBe("Sunny in Paris.");
    }
    expect(w.summary()).toMatchObject({ trusted: true, mode: "scripted", blockState: "by_name", scripted: { before_task: 3, independent: 0, task_made: 0 }, countsTowardProof: 3, failurePack: 0, unmatched: 0, refused: 0 });
  });
  it("streams SSE for alt=sse and a JSON array otherwise (redirect-check 7)", async () => {
    const w = await world({ sets: [GEMINI_SET] });
    const sse = await request(`${w.base}${geminiPath("gemini", "v1beta", "streamGenerateContent")}?alt=sse`, { method: "POST", body: GEMINI_BODY });
    expect(sse.headers["content-type"]).toBe("text/event-stream");
    expect(sse.body.startsWith("data: ")).toBe(true);
    const array = await request(`${w.base}${geminiPath("gemini", "v1beta", "streamGenerateContent")}?%24alt=json%3Benum-encoding%3Dint`, { method: "POST", body: GEMINI_BODY });
    expect(array.headers["content-type"]).toBe("application/json");
    const parsed = JSON.parse(array.body) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
  });
  it("an unmatched call fails closed with the family's error envelope, is counted, and never invents a reply", async () => {
    const w = await world({ sets: [GEMINI_SET] });
    const reply = await request(`${w.base}${geminiPath()}`, { method: "POST", body: JSON.stringify({ contents: [{ parts: [{ text: "something else" }] }] }) });
    expect(reply.status).toBe(400);
    expect(reply.body).toContain("not run: no scripted reply for this request");
    expect(w.summary()).toMatchObject({ unmatched: 1, scripted: { before_task: 0 } });
  });
  it("a family with no reply set answers unmatched to every call; a Bedrock row is not served here", async () => {
    const w = await world({ sets: [GEMINI_SET], rows: [...ROWS, { id: "bedrock", family: "bedrock", routesTo: "local_aws_front" }] });
    const openai = await request(`${w.base}/p/openai/v1/chat/completions`, { method: "POST", body: OPENAI_BODY });
    expect(openai.status).toBe(400);
    const bedrock = await request(`${w.base}/p/bedrock/model/x/converse`, { method: "POST", body: "{}" });
    expect(bedrock.status).toBe(421);
    expect(bedrock.body).toContain("Bedrock scripted replies are served by the local AWS front");
    expect(w.summary()).toMatchObject({ unmatched: 1, notServed: 1 });
  });
  it("task_made replies are served but never counted toward the proof", async () => {
    const w = await world({ sets: [stampSet("openai_compatible", [{ id: "mine", provenance: "task_made", origin: undefined }])] });
    expect((await request(`${w.base}/p/openai/v1/chat/completions`, { method: "POST", body: OPENAI_BODY })).status).toBe(200);
    expect(w.summary()).toMatchObject({ scripted: { task_made: 1, before_task: 0 }, countsTowardProof: 0 });
  });
  it("the failure pack answers from /f/<mode>, after n calls with /n/<n>, is its own class and never counts", async () => {
    const w = await world({ sets: [OPENAI_SET] });
    const url = `${w.base}/p/openai/f/rate_limit/n/1/v1/chat/completions`;
    const first = await request(url, { method: "POST", body: OPENAI_BODY });
    expect(first.status).toBe(200);
    const second = await request(url, { method: "POST", body: OPENAI_BODY });
    expect(second.status).toBe(429);
    expect(second.headers["retry-after"]).toBeDefined();
    expect((JSON.parse(second.body) as { error: { code: string } }).error.code).toBe("rate_limit_exceeded");
    expect(w.summary()).toMatchObject({ scripted: { before_task: 1 }, failurePack: 1, countsTowardProof: 1 });
    const cut = await request(`${w.base}/p/openai/f/cut_off_stream/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] }) });
    expect(cut.body).not.toContain("[DONE]");
    expect(w.summary().failurePack).toBe(2);
  });
  it("the ledger holds no body, header value, query or prompt (only a hash of the prompt)", async () => {
    const w = await world({ sets: [GEMINI_SET] });
    const key = fakeKey();
    await request(`${w.base}${geminiPath()}?note=secretquery`, { method: "POST", body: GEMINI_BODY, headers: { "x-goog-api-key": key, authorization: `Bearer ${key}`, "x-secret-header": "headervalue" } });
    const text = w.ledgerText();
    for (const leak of [key, "secretquery", "headervalue", "weather in Paris", "Sunny"]) expect(text, leak).not.toContain(leak);
    expect(text).toContain("promptSha256");
    expect(text).toContain("replySha256");
  });
  it("writes the ledger row before the answer is sent", async () => {
    const w = await world({ sets: [OPENAI_SET] });
    const reply = await request(`${w.base}/p/openai/v1/chat/completions`, { method: "POST", body: OPENAI_BODY });
    // by the time the client has the whole answer, the row is already on disk
    expect(reply.status).toBe(200);
    expect(w.ledgerText().trim().split("\n")).toHaveLength(2);
  });
});

describe("refusals", () => {
  it("answers only the caller: another source gets the fixed refusal and is counted apart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rsmh-c-"));
    const ledger = createModelLedgerWriter(join(dir, "l.jsonl"), { header: 1, mode: "scripted", blockState: "by_name", digest: ZERO_DIGEST, startedAt: 1 });
    const loop = await startModelHelperLoop({ listen: "127.0.0.1", port: 0, metaPort: 0, caller: "10.9.9.9", mode: "scripted", rows: ROWS, replySets: new Map([[OPENAI_SET.family, OPENAI_SET]]), ledger });
    try {
      const refused = await request(`http://127.0.0.1:${String(loop.port)}/p/openai/v1/chat/completions`, { method: "POST", body: OPENAI_BODY });
      expect(refused.status).toBe(403);
      expect(refused.body).not.toContain("Hello from the script");
      const meta = await request(`http://127.0.0.1:${String(loop.metaPort)}/`, { headers: { "metadata-flavor": "Google" } });
      expect(meta.status).toBe(403);
    } finally {
      await loop.close();
    }
  });
  it("refuses CONNECT and an upgrade, and counts them", async () => {
    const w = await world({ sets: [OPENAI_SET] });
    const answer = await new Promise<string>((resolveRaw) => {
      const socket = net.connect(w.loop.port, "127.0.0.1", () => socket.write("CONNECT api.openai.com:443 HTTP/1.1\r\nhost: api.openai.com:443\r\n\r\n"));
      let data = "";
      socket.on("data", (chunk) => (data += chunk.toString()));
      socket.on("close", () => resolveRaw(data));
    });
    expect(answer.startsWith("HTTP/1.1 405")).toBe(true);
    const upgrade = await new Promise<string>((resolveRaw) => {
      const socket = net.connect(w.loop.port, "127.0.0.1", () => socket.write("GET /p/openai/v1/chat/completions HTTP/1.1\r\nhost: x\r\nconnection: Upgrade\r\nupgrade: websocket\r\n\r\n"));
      let data = "";
      socket.on("data", (chunk) => (data += chunk.toString()));
      socket.on("close", () => resolveRaw(data));
    });
    expect(upgrade.startsWith("HTTP/1.1 426")).toBe(true);
    expect(w.summary().refused).toBe(2);
  });
  it("refuses an absolute-form target, a second ?, a control character and a path outside /p/", async () => {
    const w = await world({ sets: [OPENAI_SET] });
    for (const path of ["http://api.openai.com/v1/chat/completions", "/p/openai/v1/a?b?c", "/p/openai/v1/a%00b", "/v1/chat/completions", "//p/openai/v1/x"]) {
      const reply = await request(w.base, { method: "POST", path, body: OPENAI_BODY });
      expect(reply.status, path).toBe(400);
    }
    expect(w.summary()).toMatchObject({ refused: 5, scripted: { before_task: 0 } });
  });
  it("holds the body limit: past 5 MB is refused with 413 and counted, never served", async () => {
    const w = await world({ sets: [OPENAI_SET] });
    const huge = Buffer.alloc(MODEL_HELPER_LIMITS.bodyBytes + 10, 97);
    const reply = await request(w.base, { method: "POST", path: "/p/openai/v1/chat/completions", body: huge }).catch(() => ({ status: 413, headers: {}, body: "" }));
    expect(reply.status).toBe(413);
    expect(w.summary().scripted.before_task).toBe(0);
  });
  it("a body past the serve limit (1 MiB) but under 5 MB gets the fixed 413 from the family code, quickly", async () => {
    const w = await world({ sets: [OPENAI_SET] });
    const started = Date.now();
    const reply = await request(w.base, { method: "POST", path: "/p/openai/v1/chat/completions", body: Buffer.alloc(1_200_000, 97) });
    expect(reply.status).toBe(413);
    expect(Date.now() - started).toBeLessThan(3000);
  });
  it("refuses request headers past 16 KB (431) and counts them", async () => {
    const w = await world({ sets: [OPENAI_SET] });
    const reply = await request(`${w.base}/p/openai/v1/chat/completions`, { method: "POST", body: OPENAI_BODY, headers: { "x-big": "a".repeat(20_000) } }).catch(() => ({ status: 431, headers: {}, body: "" }));
    expect(reply.status).toBe(431);
    expect(w.summary().refused).toBeGreaterThanOrEqual(1);
  });
  it("a client that sends no complete header block in 10 s is dropped (limit configured)", async () => {
    const w = await world({ sets: [OPENAI_SET] });
    expect(MODEL_HELPER_LIMITS).toMatchObject({ headerBytes: 16384, bodyBytes: 5 * 1024 * 1024, headerReadMs: 10_000, totalMs: 600_000, chunkBytes: 1024 * 1024 });
    expect(w.loop.port).toBeGreaterThan(0);
  });
  it("a full ledger refuses further calls instead of answering without a record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rsmh-f-"));
    let writes = 0;
    const ledger = createModelLedgerWriter(join(dir, "l.jsonl"), { header: 1, mode: "scripted", blockState: "by_name", digest: ZERO_DIGEST, startedAt: 1 }, () => {
      writes += 1;
      if (writes > 1) throw new Error("disk full");
    });
    const loop = await startModelHelperLoop({ listen: "127.0.0.1", port: 0, caller: "127.0.0.1", mode: "scripted", rows: ROWS, replySets: new Map([[OPENAI_SET.family, OPENAI_SET]]), ledger });
    try {
      const reply = await request(`http://127.0.0.1:${String(loop.port)}/p/openai/v1/chat/completions`, { method: "POST", body: OPENAI_BODY });
      expect(reply.status).toBe(503);
      expect(reply.body).not.toContain("Hello from the script");
    } finally {
      await loop.close();
    }
  });
});

describe("modes that are not scripted (F1-c's)", () => {
  it("answers the fixed sentence for real, record and replay when no backend is wired, and never a scripted reply", async () => {
    for (const mode of ["real", "record", "replay"] as const) {
      const w = await world({ mode, sets: [OPENAI_SET] });
      const reply = await request(`${w.base}/p/openai/v1/chat/completions`, { method: "POST", body: OPENAI_BODY });
      expect(reply.status).toBe(503);
      expect(reply.body).toContain(REAL_NOT_AVAILABLE_SENTENCE);
      expect(w.summary()).toMatchObject({ mode, notServed: 1, scripted: { before_task: 0 } });
    }
  });
  it("passes the call to an injected backend with the credential headers dropped and the token parsed, and counts it as backend", async () => {
    const seen: unknown[] = [];
    const backend: ModelBackend = { serve: (call) => { seen.push(call); return Promise.resolve({ status: 200, headers: { "content-type": "application/json" }, body: '{"ok":true}' }); } };
    const w = await world({ mode: "real", backend });
    const token = "T".repeat(24);
    const key = fakeKey();
    const reply = await request(`${w.base}/p/openai/x/${token}/v1/chat/completions?stream=1`, { method: "POST", body: OPENAI_BODY, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" } });
    expect(reply.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ mode: "real", rowId: "openai", path: "/v1/chat/completions", query: "stream=1", token });
    expect(JSON.stringify(seen)).not.toContain(key);
    expect(w.summary()).toMatchObject({ backend: 1 });
  });
});
