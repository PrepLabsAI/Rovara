// TE-B1 (the fresh eval check sandbox): the model helper's `real` backend over the worker's bridge socket. The helper program wires it ONLY when the worker started it with `--bridge-socket` (model-helper-args.ts), which
// the fresh eval sandbox does (verification/eval-bridged-exec.ts `createFreshEvalSandbox`); every other helper (scripted, the laptop child, the working sandbox's) has no backend and answers real calls "not run".
//
// The helper's ONE outbound path: the bridge's Unix socket in the helper's own read-only mount (`/rovara/models`, the folder only the helper mounts: TE-F1C-SOCKET-ACCESS). It opens nothing on any network: the client it
// calls (`callModelBridge`, model-helper-bridge-client.ts) sends to a socket PATH and nothing else (tests/unit/worker-model-helper-import-graph.test.ts pins that this is the one outbound call in the program's graph).
//
// What it sends: the frame the helper already parsed (the row from `/p/<row>`, the method, the API's own path, the query, the headers with every credential header dropped, the body), in `real` mode, with the per-exec token from
// `/x/<token>`. The bridge checks all of it again (round, token, row, frame); the helper decides nothing. What it answers: the bridge's head, chunks and settle as one buffered answer; a `not_run` or `scripted` answer, a
// call with no token, or another mode is "not run" (undefined, the loop's fixed sentence); a cut answer, an answer with no settle or one over the size limit is a fault (the loop's fixed 502). Never retried.
import type { ModelBackend, ModelBackendAnswer } from "./model-helper-http.js";
import { MODEL_HELPER_RUN_DIR } from "./model-helper-args.js";
import { callModelBridge, type ModelBridgeCall, type ModelBridgeClientEvent } from "./model-helper-bridge-client.js";

/** The bridge's socket inside the helper: the one file name the worker's exec gives it (`EVAL_BRIDGE_SOCKET_NAME`) in the helper's one mount. */
export const MODEL_HELPER_BRIDGE_SOCKET = `${MODEL_HELPER_RUN_DIR}/m`;
/** The most bytes one buffered answer may carry: the bridge's own response limit (10 MB). */
export const MODEL_HELPER_BRIDGE_ANSWER_MAX_BYTES = 10 * 1024 * 1024;
/** The answer headers passed on to the sandbox's client: the content type and the refusal word, nothing else (the loop adds its own). */
const PASSED_HEADERS: ReadonlySet<string> = new Set(["content-type", "x-rovara-refusal"]);

/** The bridge backend for the helper's `real` mode. `call` is a test seam (default: the real client on `socketPath`). */
export function bridgeModelBackend(socketPath: string, call: (input: ModelBridgeCall) => AsyncIterable<ModelBridgeClientEvent> = callModelBridge): ModelBackend {
  return {
    async serve(request, signal): Promise<ModelBackendAnswer | undefined> {
      if (request.mode !== "real" || request.token === undefined) return undefined;
      const frame = {
        row: request.rowId, method: request.method, path: request.path, query: request.query,
        headers: Object.entries(request.headers).map(([name, value]) => [name, value] as const), body: new Uint8Array(request.body),
      };
      let status: number | undefined;
      const headers: Record<string, string> = {};
      const parts: Uint8Array[] = [];
      let size = 0;
      let settled = false;
      for await (const event of call({ socketPath, mode: "real", token: request.token, frame, signal })) {
        if (event.kind === "not_run" || event.kind === "scripted") return undefined;
        if (event.kind === "cut") throw new Error("the model bridge cut the answer");
        if (event.kind === "head") {
          if (status !== undefined) throw new Error("the model bridge sent a second head");
          status = event.status;
          for (const [name, value] of event.headers) if (PASSED_HEADERS.has(name.toLowerCase())) headers[name.toLowerCase()] = value;
        } else if (event.kind === "chunk") {
          if (status === undefined) throw new Error("the model bridge sent a body before its head");
          size += event.bytes.byteLength;
          if (size > MODEL_HELPER_BRIDGE_ANSWER_MAX_BYTES) throw new Error("the model bridge answer is too large");
          parts.push(event.bytes);
        } else {
          settled = true;
          break;
        }
      }
      // An answer that ended without its settle is not an answer (the stage could not account for it).
      if (status === undefined || !settled) throw new Error("the model bridge answer was not whole");
      const body = new Uint8Array(size);
      let at = 0;
      for (const part of parts) { body.set(part, at); at += part.byteLength; }
      return { status, headers, body };
    },
  };
}
