// TE-B1: the model helper's `real` backend over the worker's bridge socket. The helper wires it only when the worker named a bridge socket (`--bridge-socket`, mode real, a file directly in the helper's one mount); it
// passes the parsed frame and the per-run token to the bridge, answers the bridge's head, chunks and settle, and turns anything that is not a whole answer into "not run" or a fault, never a guess. End to end: a client of the
// sandbox -> the helper loop -> the real bridge on a Unix socket -> the stage's egress (a stub). No Docker, no network beyond loopback.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelEgress, ModelEgressEvent } from "@agentx/contracts";
import { ModelHelperArgsRefused, modelHelperArgs, parseModelHelperArgs, type ModelHelperServeArgs } from "../../packages/worker/src/model-helper-args.js";
import { MODEL_HELPER_BRIDGE_ANSWER_MAX_BYTES, MODEL_HELPER_BRIDGE_SOCKET, bridgeModelBackend } from "../../packages/worker/src/model-helper-bridge-backend.js";
import type { ModelBridgeCall, ModelBridgeClientEvent } from "../../packages/worker/src/model-helper-bridge-client.js";
import type { ModelBackendRequest } from "../../packages/worker/src/model-helper-http.js";
import { serveModelHelper } from "../../packages/worker/src/model-helper.js";
import { createModelBridge } from "../../packages/worker/src/model-bridge.js";
import { createModelBridgeLedger } from "../../packages/worker/src/model-bridge-ledger.js";
import { writeModelHelperRunFiles } from "../../packages/worker/src/model-helper-round.js";
import { EVAL_BRIDGE_SOCKET_NAME } from "../../packages/worker/src/verification/eval-bridged-exec.js";
import { request as httpRequest } from "../support/model-helper-world.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const enc = (text: string) => new TextEncoder().encode(text);

const REAL: ModelHelperServeArgs = {
  listen: "10.20.0.9", port: 8080, metaPort: undefined, caller: "10.20.0.4", mode: "real", rows: "/rovara/models/rows.json", replies: "/rovara/models/replies.json", digest: "a".repeat(64),
  ledger: "/rovara/ledger/model-ledger.jsonl", blockState: "by_name", projectId: undefined, recordEscapes: false, bridgeSocket: MODEL_HELPER_BRIDGE_SOCKET,
};

describe("--bridge-socket", () => {
  it("round-trips, and names the file the exec gives the socket in the helper's one mount", () => {
    expect(MODEL_HELPER_BRIDGE_SOCKET).toBe(`/rovara/models/${EVAL_BRIDGE_SOCKET_NAME}`);
    const argv = modelHelperArgs(REAL);
    expect(argv.slice(-2)).toEqual(["--bridge-socket", MODEL_HELPER_BRIDGE_SOCKET]);
    expect(parseModelHelperArgs(argv)).toEqual(REAL);
  });
  it("is refused with any mode but real, outside the helper's mount, in a subfolder, with .., on the run files, or twice", () => {
    for (const mode of ["scripted", "replay", "record"] as const) expect(() => modelHelperArgs({ ...REAL, mode }), mode).toThrow(ModelHelperArgsRefused);
    for (const bridgeSocket of ["/tmp/m", "/rovara/ledger/m", "/rovara/models/a/m", "/rovara/models/../ledger/m", "/rovara/models/", "/rovara/models/rows.json", "/rovara/models/replies.json", "m", "/rovara/modelsx/m"]) {
      expect(() => modelHelperArgs({ ...REAL, bridgeSocket }), bridgeSocket).toThrow(ModelHelperArgsRefused);
    }
    expect(() => parseModelHelperArgs([...modelHelperArgs(REAL), "--bridge-socket", MODEL_HELPER_BRIDGE_SOCKET])).toThrow(ModelHelperArgsRefused);
  });
  it("absent is exactly today's line (no flag, no backend)", () => {
    const { bridgeSocket: _drop, ...rest } = REAL; void _drop;
    expect(modelHelperArgs({ ...rest, mode: "scripted" })).not.toContain("--bridge-socket");
  });
});

const backendRequest = (over: Partial<ModelBackendRequest> = {}): ModelBackendRequest => ({
  mode: "real", rowId: "gemini", method: "POST", path: "/v1beta/models/m:generateContent", query: "", headers: { "content-type": "application/json" }, body: enc("{}"), token: "t".repeat(32), ...over,
});
const scripted = (events: readonly ModelBridgeClientEvent[], seen: ModelBridgeCall[] = []) => (input: ModelBridgeCall): AsyncIterable<ModelBridgeClientEvent> => {
  seen.push(input);
  return (async function* () { yield* events; })();
};
const settle: ModelBridgeClientEvent = { kind: "settle", status: 200, class: "ok", costMicros: 5, estimated: false };

describe("the bridge backend", () => {
  it("sends the parsed frame once in real mode with the run's token, and answers the bridge's head, body and settle", async () => {
    const seen: ModelBridgeCall[] = [];
    const answer = await bridgeModelBackend("/s", scripted([{ kind: "head", status: 200, headers: [["content-type", "application/json"], ["set-cookie", "x"], ["x-rovara-refusal", "cap"]] }, { kind: "chunk", bytes: enc("{\"a\":") }, { kind: "chunk", bytes: enc("1}") }, settle], seen)).serve(backendRequest(), new AbortController().signal);
    expect(answer).toEqual({ status: 200, headers: { "content-type": "application/json", "x-rovara-refusal": "cap" }, body: enc("{\"a\":1}") });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ socketPath: "/s", mode: "real", token: "t".repeat(32), frame: { row: "gemini", method: "POST", path: "/v1beta/models/m:generateContent", query: "", headers: [["content-type", "application/json"]] } });
  });
  it("a call with no token, or in another mode, is not run and never reaches the bridge", async () => {
    const seen: ModelBridgeCall[] = [];
    const backend = bridgeModelBackend("/s", scripted([settle], seen));
    expect(await backend.serve(backendRequest({ token: undefined }), new AbortController().signal)).toBeUndefined();
    expect(await backend.serve(backendRequest({ mode: "replay" }), new AbortController().signal)).toBeUndefined();
    expect(seen).toEqual([]);
  });
  it("a not_run or scripted answer is not run; a cut, a settle-less end, a body before the head, a second head or an oversize answer is a fault", async () => {
    const signal = new AbortController().signal;
    const head: ModelBridgeClientEvent = { kind: "head", status: 200, headers: [] };
    expect(await bridgeModelBackend("/s", scripted([{ kind: "not_run", reason: "fresh_sandbox", sentence: "x" }])).serve(backendRequest(), signal)).toBeUndefined();
    expect(await bridgeModelBackend("/s", scripted([{ kind: "scripted" }])).serve(backendRequest(), signal)).toBeUndefined();
    await expect(bridgeModelBackend("/s", scripted([head, { kind: "chunk", bytes: enc("x") }, { kind: "cut", why: "fault" }])).serve(backendRequest(), signal)).rejects.toThrow();
    // a cut is the end, even if a settle were to follow it
    await expect(bridgeModelBackend("/s", scripted([head, { kind: "chunk", bytes: enc("x") }, { kind: "cut", why: "time" }, settle])).serve(backendRequest(), signal)).rejects.toThrow();
    await expect(bridgeModelBackend("/s", scripted([head, { kind: "chunk", bytes: enc("x") }])).serve(backendRequest(), signal)).rejects.toThrow();
    await expect(bridgeModelBackend("/s", scripted([{ kind: "chunk", bytes: enc("x") }, head, settle])).serve(backendRequest(), signal)).rejects.toThrow();
    await expect(bridgeModelBackend("/s", scripted([head, head, settle])).serve(backendRequest(), signal)).rejects.toThrow();
    await expect(bridgeModelBackend("/s", scripted([head, { kind: "chunk", bytes: new Uint8Array(MODEL_HELPER_BRIDGE_ANSWER_MAX_BYTES + 1) }, settle])).serve(backendRequest(), signal)).rejects.toThrow();
    // a 2xx head whose settle is not ok (the provider failed after the head) is never a success with a partial body
    await expect(bridgeModelBackend("/s", scripted([head, { kind: "chunk", bytes: enc("{\"part") }, { kind: "settle", status: 502, class: "provider_error", costMicros: 0, estimated: false }])).serve(backendRequest(), signal)).rejects.toThrow();
    // a refusal (non-2xx head, non-ok settle) is passed on as the answer it is
    expect((await bridgeModelBackend("/s", scripted([{ kind: "head", status: 429, headers: [] }, { kind: "settle", status: 429, class: "rate_limit", costMicros: 0, estimated: false }])).serve(backendRequest(), signal))?.status).toBe(429);
    // the exact limit is an answer
    expect((await bridgeModelBackend("/s", scripted([head, { kind: "chunk", bytes: new Uint8Array(MODEL_HELPER_BRIDGE_ANSWER_MAX_BYTES) }, settle])).serve(backendRequest(), signal))?.body).toHaveLength(MODEL_HELPER_BRIDGE_ANSWER_MAX_BYTES);
  });
});

describe("end to end: the sandbox's client -> the helper (real mode) -> the bridge socket -> the stage's egress", () => {
  it("answers with the stage's answer when the token is the run's, and the stage sees the frame once; a forged token never reaches the stage", async () => {
    const parent = mkdtempSync(join(tmpdir(), "rbb-"));
    dirs.push(parent);
    const seen: unknown[] = [];
    const egress: ModelEgress = { capabilities: { schemes: [] }, async *forward(_scope, frame): AsyncGenerator<ModelEgressEvent> {
      seen.push(frame);
      yield { kind: "head", status: 200, headers: [["content-type", "application/json"]] };
      yield { kind: "chunk", bytes: enc("{\"candidates\":[]}") };
      yield { kind: "settle", status: 200, class: "ok", costMicros: 7, estimated: false };
    } };
    const bridge = createModelBridge({ egress, egressScope: {} as never, roundKind: "check_unsealed", familyOf: () => "gemini", ledger: createModelBridgeLedger({ now: () => 1 }), now: () => 1 });
    const socket = join(parent, "m");
    await bridge.listen(socket);
    const token = bridge.issueToken("run-1", "check_unsealed", ["real"]);
    const files = await writeModelHelperRunFiles({ parent, rows: [{ id: "gemini", family: "gemini" }], sets: [] });
    const args = parseModelHelperArgs(modelHelperArgs({ listen: "127.0.0.1", port: 0, metaPort: undefined, caller: "127.0.0.1", mode: "real", rows: files.rowsPath, replies: files.repliesPath, digest: files.digest, ledger: join(parent, "ledger.jsonl"), blockState: "by_name", projectId: undefined, recordEscapes: false }));
    const loop = await serveModelHelper(args, { backend: bridgeModelBackend(socket) });
    try {
      const base = `http://127.0.0.1:${String(loop.port)}/p/gemini`;
      const good = await httpRequest(`${base}/x/${token}/v1beta/models/gemini-x:generateContent`, { method: "POST", body: "{\"contents\":[]}", headers: { "content-type": "application/json" } });
      expect(good.status).toBe(200);
      expect(good.body).toBe("{\"candidates\":[]}");
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ row: "gemini", method: "POST", path: "/v1beta/models/gemini-x:generateContent" });
      const forged = await httpRequest(`${base}/x/${"f".repeat(32)}/v1beta/models/gemini-x:generateContent`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
      expect(forged.status).not.toBe(200);
      expect(seen).toHaveLength(1);
    } finally {
      await loop.close();
      await bridge.close();
    }
  });
});
