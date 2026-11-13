// TE-F1c (M2, release 0.5.19; te-f1 design 2.1, 2.2, 7): the MODEL BRIDGE, the worker's side of a model call.
//
// The worker LISTENS on a per-run Unix socket (mode 0600) in the run's directory, mounted read-only into the helper (`e2e-model-proxy.ts`'s socket pattern, reversed). The helper parses untrusted HTTP from customer code, so the bridge
// never trusts what it sends: it parses the envelope strictly, checks the frame AGAIN with F1-a (`parseModelEgressFrame`), refuses a row it does not know, checks the MODE and the per-exec token, applies the per-task pre-caps (4 at
// once, 200 calls, the dollar cap), and only then hands the frame to `ModelEgress.forward(scope, frame)` ONE time. There is no retry: a retry after a fault can double-spend (the reasoning of `packages/broker/src/model-proxy/invoker.ts`).
//
// MODE CONTROL (design 2.2, D2). The round kind is the worker's own typed value, fixed when the bridge is made; it never comes from the helper or the sandbox, and a value that is not exactly one of the typed kinds is the WORKING
// round (fail closed). `replay` is always allowed. `real` and `record` (which forwards the first call per changed prompt) need a fresh or sealed round AND a live per-exec token: the worker issues a random token for an exec,
// puts it in the sandbox's base URL (`/p/<row>/x/<token>`), and drops it when the exec ends. TE-B1's fresh sandbox is not built: today the final checks run in the working sandbox, so real calls read "not run: real model checks
// need a fresh check sandbox"; the switch to real is the round kind alone ("one flag away").
//
// WHO CAN TALK TO THE SOCKET. The 0600 mode of the socket separates NOTHING in practice: the worker, the helper and the sandbox all run as uid 1000, so any of them could open it. The real control is that ONLY THE HELPER mounts the
// run directory the socket is in (model-helper-launch.ts: the helper's one mount; the sandbox never gets it), plus the per-exec token below, which the sandbox's own code never sees as a bridge credential (it sits in a base URL
// the helper reads). When this is wired, check with `docker inspect` that no sandbox mounts the run directory (DEFERRED TE-F1C-SOCKET-ACCESS).
//
// TOKENS carry their round. `issueToken(execId, roundKind, modes)` binds the round kind and the modes that exec may use (`real`, `record`) to the token, and every call is checked against ITS token, so one bridge can serve a working
// exec and a fresh-sandbox exec side by side and a token can never do more than the exec it was issued for (a `record` token does not allow `real`). A call with no token is read in the bridge's default round (`roundKind`, working when absent).
//
// Limits (design 7): request headers 16 KB, body 5 MB, response 10 MB in all, one stream chunk 1 MB (a bigger chunk from the port is split), header read 10 s, a call 10 minutes in all.
// The bridge logs fixed fields only (event, row, mode, status, class, refusal word). Never a body, a header value, a URL query, a token, or a provider's words; an error is never repeated.
import { randomBytes } from "node:crypto";
import { chmod, rm } from "node:fs/promises";
import http from "node:http";
import type net from "node:net";
import {
  MODEL_EGRESS_OVERRUN_SENTENCE, MODEL_EGRESS_REFUSAL_HEADER, classOfRefusal, familyErrorBody, parseModelEgressFrame, refusalResponse,
  type ModelEgress, type ModelEgressEvent, type ModelEgressFamily, type ModelEgressFrame, type ModelEgressRefusal, type ModelEgressRoundKind, type ModelEgressScope, type ModelEgressSettle, type RecordReplay, type RecordReplayServe,
} from "@agentx/contracts";
import { parseModelRoundKind, type ModelBridgeLedger, type LedgerVia } from "./model-bridge-ledger.js";
import { MODEL_BRIDGE_MODES, type ModelBridgeCutReason, type ModelBridgeMode } from "./model-helper-bridge-client.js";

export const MODEL_BRIDGE_LIMITS = {
  headersBytes: 16 * 1024,
  bodyBytes: 5 * 1024 * 1024,
  /** The envelope: the body as base64 (6.7 MB for 5 MB), the headers, and the rest. */
  envelopeBytes: 8 * 1024 * 1024,
  responseBytes: 10 * 1024 * 1024,
  chunkBytes: 1024 * 1024,
  headerReadMs: 10_000,
  totalMs: 10 * 60 * 1000,
  concurrent: 4,
  calls: 200,
  /** Connections open at once (the socket has one client, the helper; a few for its parallel calls). */
  connections: 16,
  /** A pause in a request body, or between the parts of a response the reader is not taking, longer than this ends the connection. Shorter than a whole header read. */
  bodyIdleMs: 5_000,
  writeStallMs: 10_000,
} as const;
export type ModelBridgeLimits = { -readonly [K in keyof typeof MODEL_BRIDGE_LIMITS]: number };

/** The modes that may forward a real call. `replay` forwards nothing and needs no token. */
export type ModelBridgeForwardMode = "real" | "record";
const FORWARD_MODES: readonly ModelBridgeForwardMode[] = ["real", "record"];

export const MODEL_FRESH_SANDBOX_SENTENCE = "not run: real model checks need a fresh check sandbox";
/** The rounds that may make a real call: the fresh unsealed check round (TE-B1, not built) and the sealed round. Never the working round. */
export const MODEL_REAL_ROUND_KINDS: readonly ModelEgressRoundKind[] = ["check_unsealed", "check_sealed"];

export interface ModelBridgeRecording {
  /** Mode `record`: the first call per changed prompt is forwarded and stored. Used only when a real call is allowed. */
  readonly record: RecordReplay;
  /** Mode `replay_only`: nothing is ever forwarded. */
  readonly replay: RecordReplay;
}

export interface ModelBridgeOptions {
  /** F1-a's port: the laptop adapter, or Cloud's. */
  readonly egress: ModelEgress;
  /** Opaque to the bridge: built by the same code that builds the recording scope, from the same task. */
  readonly egressScope: ModelEgressScope;
  /** The round a call with NO token is read in (the worker's own typed value; never from the helper or the sandbox). Default and fail-closed value: the working round. A call WITH a token is read in the round its token was issued for. */
  readonly roundKind?: unknown;
  /** The catalog row's family, or undefined for a row this task does not serve. */
  readonly familyOf: (row: string) => ModelEgressFamily | undefined;
  readonly ledger: ModelBridgeLedger;
  readonly now: () => number;
  /** The task's dollar cap in micro-dollars, for the pre-check and the words of a cap refusal. */
  readonly capMicros?: number;
  readonly recording?: ModelBridgeRecording;
  /** Randomness, injected for tests. Default: 16 random bytes as hex. */
  readonly randomToken?: () => string;
  readonly limits?: Partial<ModelBridgeLimits>;
  /** Fixed fields only. */
  readonly log?: (fields: Readonly<Record<string, string | number>>) => void;
}

export interface ModelBridgeStats {
  readonly calls: number;
  readonly inflight: number;
  readonly spentMicros: number;
  readonly overrun: boolean;
}

export interface ModelBridge {
  /** Listens on `socketPath` (created, then made mode 0600). The directory must exist. */
  listen(socketPath: string): Promise<void>;
  /**
   * A random token for one exec, for the `/x/<token>` segment of its base URL. It carries the exec's round kind (anything that is not exactly a typed kind is the working round) and the modes the exec may use: `real` and
   * `record` may forward a call, and a token allows only what it was issued for.
   */
  issueToken(execId: string, roundKind: unknown, modes: readonly ModelBridgeForwardMode[]): string;
  /** The exec ended: its tokens stop working. */
  dropToken(execId: string): void;
  stats(): ModelBridgeStats;
  /** Stops listening, ends every call, drops every token, removes the socket. */
  close(): Promise<void>;
}

const TOKEN = /^[A-Za-z0-9]{16,64}$/u;
/** Linear (a grouped pattern overflows the regex stack on a 7 MB body). The length rule makes it canonical. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;
const ENVELOPE_KEYS = ["row", "method", "path", "query", "headers", "bodyB64"].sort();
const DEFAULT_FAMILY: ModelEgressFamily = "openai_compatible";
const UNREACHABLE = "The provider could not be reached.";

interface Answered { readonly settle?: ModelEgressSettle; readonly cut?: ModelBridgeCutReason; readonly status?: number }

export function createModelBridge(options: ModelBridgeOptions): ModelBridge {
  const limits: ModelBridgeLimits = { ...MODEL_BRIDGE_LIMITS, ...Object.fromEntries(Object.entries(options.limits ?? {}).filter(([, value]) => typeof value === "number" && value > 0)) };
  // Anything that is not exactly a typed round kind is the working round.
  const defaultRound: ModelEgressRoundKind = parseModelRoundKind(options.roundKind) ?? "working";
  const makeToken = options.randomToken ?? ((): string => randomBytes(16).toString("hex"));
  const tokens = new Map<string, { readonly execId: string; readonly roundKind: ModelEgressRoundKind; readonly modes: ReadonlySet<ModelBridgeForwardMode> }>();
  const sockets = new Set<net.Socket>();
  const aborts = new Set<AbortController>();
  let server: http.Server | undefined;
  let socketPath: string | undefined;
  let callsStarted = 0;
  let inflight = 0;
  let spent = 0;
  let overrun = false;
  /** The largest settled cost of one real call so far: the unit of "about one estimate" for the near-cap gate. */
  let largestCost = 0;
  const settleWaiters: Array<() => void> = [];
  const log = (fields: Readonly<Record<string, string | number>>): void => {
    try { options.log?.(fields); } catch { /* a log sink that throws is not the call's problem */ }
  };

  // ---- events on the wire (NDJSON)
  const line = (event: Record<string, unknown>): string => `${JSON.stringify(event)}\n`;
  const headLine = (status: number, headers: ReadonlyArray<readonly [string, string]>): string => line({ t: "head", status, headers });
  const chunkLine = (bytes: Uint8Array): string => line({ t: "chunk", b: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64") });
  const settleLine = (settle: ModelEgressSettle): string => { const { kind: _kind, ...rest } = settle; void _kind; return line({ t: "settle", ...rest }); };

  function refusalLines(family: ModelEgressFamily, word: ModelEgressRefusal, extra: { capMicros?: number; overrun?: boolean } = {}): string[] {
    const answer = refusalResponse(family, word, extra);
    return [headLine(answer.status, answer.headers), chunkLine(answer.body), settleLine({ kind: "settle", status: answer.status, class: classOfRefusal(word), refusal: word, costMicros: 0, estimated: false })];
  }

  /** The bridge's own refusals are recorded in the ledger as `refused`. */
  function note(row: string, mode: string, status: number, cls: ModelEgressSettle["class"], refusal: ModelEgressRefusal | undefined, via: LedgerVia, execId?: string): void {
    const known = options.familyOf(row) !== undefined ? row : "unknown";
    options.ledger.record({ row: known, status, class: cls, ...(refusal === undefined ? {} : { refusal }), costMicros: 0, estimated: false, via, ...(execId === undefined ? {} : { execId }) });
    log({ event: refusal === undefined ? "answer" : "refused", row: known, mode, status, class: cls, ...(refusal === undefined ? {} : { refusal }) });
  }

  async function writeAll(response: http.ServerResponse, text: string): Promise<boolean> {
    if (response.destroyed || response.writableEnded) return false;
    if (response.write(text)) return true;
    // A reader that does not take what is written for this long is gone: the connection is closed and the call ends (the buffer never grows past one write).
    return new Promise<boolean>((resolve) => {
      const done = (): void => { clearTimeout(stall); response.off("drain", done); response.off("close", done); resolve(!response.destroyed); };
      const stall = setTimeout(() => { response.destroy(); }, limits.writeStallMs);
      response.once("drain", done);
      response.once("close", done);
    });
  }

  async function writeLines(response: http.ServerResponse, lines: readonly string[]): Promise<void> {
    for (const text of lines) if (!(await writeAll(response, text))) return;
  }

  /** Reads the request body up to `max` bytes; the body is never read past the limit, and a pause longer than the header-read limit ends it. */
  function readBody(request: http.IncomingMessage, max: number): Promise<{ ok: true; body: Buffer } | { ok: false; reason: "too_large" | "slow" | "gone" }> {
    return new Promise((resolve) => {
      const parts: Buffer[] = [];
      let size = 0;
      let timer: NodeJS.Timeout | undefined;
      const finish = (result: { ok: true; body: Buffer } | { ok: false; reason: "too_large" | "slow" | "gone" }): void => {
        if (timer !== undefined) clearTimeout(timer);
        request.off("data", onData);
        resolve(result);
      };
      const arm = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(() => { request.destroy(); finish({ ok: false, reason: "slow" }); }, limits.bodyIdleMs);
      };
      const declared = Number(request.headers["content-length"]);
      if (Number.isFinite(declared) && declared > max) return finish({ ok: false, reason: "too_large" });
      const onData = (part: Buffer): void => {
        size += part.length;
        // The bytes the connection has carried are bounded too (a request that pipelines more after its body).
        if (size > max || request.socket.bytesRead > max + limits.headersBytes) return finish({ ok: false, reason: "too_large" });
        parts.push(part);
        arm();
      };
      request.on("data", onData);
      request.once("end", () => finish({ ok: true, body: Buffer.concat(parts) }));
      request.once("error", () => finish({ ok: false, reason: "gone" }));
      request.once("close", () => finish({ ok: false, reason: "gone" }));
      arm();
    });
  }

  /** The frame, or the refusal word. Strict: exactly the six envelope keys, a canonical base64 body, then F1-a's own check. */
  function frameOf(text: string): { ok: true; frame: ModelEgressFrame } | { ok: false; refusal: "bad_request" | "too_large" } {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return { ok: false, refusal: "bad_request" }; }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false, refusal: "bad_request" };
    const keys = Object.keys(parsed).sort();
    if (keys.length !== ENVELOPE_KEYS.length || keys.some((key, index) => key !== ENVELOPE_KEYS[index])) return { ok: false, refusal: "bad_request" };
    const envelope = parsed as Record<string, unknown>;
    const encoded = envelope.bodyB64;
    if (typeof encoded !== "string" || encoded.length % 4 !== 0 || !BASE64.test(encoded)) return { ok: false, refusal: "bad_request" };
    const body = new Uint8Array(Buffer.from(encoded, "base64"));
    const checked = parseModelEgressFrame({ row: envelope.row, method: envelope.method, path: envelope.path, query: envelope.query, headers: envelope.headers, body });
    return checked.ok ? { ok: true, frame: checked.frame } : { ok: false, refusal: checked.refusal };
  }

  /** `limit` names the bridge's OWN count and concurrency limits: those are not a spend cap and never read as "not run". */
  type Block = { readonly by: "round" } | { readonly by: "token" } | { readonly by: "cap"; readonly overrun: boolean; readonly limit?: "calls" | "concurrent" };
  const tokenOf = (token: string | undefined): { readonly execId: string; readonly roundKind: ModelEgressRoundKind; readonly modes: ReadonlySet<ModelBridgeForwardMode> } | undefined => (token !== undefined && TOKEN.test(token) ? tokens.get(token) : undefined);
  /** Why this call may not be forwarded, if it may not. Checked in this order: the round (its token's, or the default one), the token and its modes, then the caps. */
  function blockedBy(token: string | undefined, mode: ModelBridgeForwardMode): Block | undefined {
    const held = tokenOf(token);
    if (!MODEL_REAL_ROUND_KINDS.includes(held?.roundKind ?? defaultRound)) return { by: "round" };
    if (held === undefined || !held.modes.has(mode)) return { by: "token" };
    if (overrun) return { by: "cap", overrun: true };
    if (options.capMicros !== undefined && spent >= options.capMicros) return { by: "cap", overrun: false };
    if (callsStarted >= limits.calls) return { by: "cap", overrun: false, limit: "calls" };
    if (inflight >= limits.concurrent) return { by: "cap", overrun: false, limit: "concurrent" };
    return undefined;
  }
  /**
   * Near the cap, calls go one at a time. Four calls in flight can each settle above its estimate, so with less than about four calls' worth of budget left the next call waits for the one in flight to SETTLE, and the task is
   * over its cap by at most one call (DECISIONS 165). The unit is the largest settled cost seen, so the very first calls of a task (nothing settled yet) can still run together: up to four may overrun then.
   */
  const NEAR_CAP_CALLS = 4;
  const nearCap = (): boolean => options.capMicros !== undefined && largestCost > 0 && options.capMicros - spent < NEAR_CAP_CALLS * largestCost;
  /**
   * Waits its turn near the cap, then decides and TAKES the slot in one synchronous step (no await between the check and the start: two waiters woken together must not both pass). Returns the block when the call may not be forwarded,
   * `"started"` when the slot is taken (the caller must `endForward()`), or `"aborted"` when the helper went away while it waited.
   */
  async function enter(token: string | undefined, mode: ModelBridgeForwardMode, signal: AbortSignal): Promise<Block | "started" | "aborted"> {
    for (;;) {
      if (signal.aborted) return "aborted";
      if (nearCap() && inflight > 0) {
        await new Promise<void>((resolve) => {
          settleWaiters.push(resolve);
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        continue;
      }
      const block = blockedBy(token, mode);
      if (block !== undefined) return block;
      inflight += 1;
      callsStarted += 1;
      return "started";
    }
  }

  /**
   * Writes the events of one answer with the limits applied, records the ledger row, and counts the spend. `forwarded` answers (the port's) hold a slot and count against the caps; a replay costs nothing.
   * Never throws; a fault from the port is a fixed answer, never retried and never quoted.
   */
  async function pump(response: http.ServerResponse, input: { row: string; family: ModelEgressFamily; mode: ModelBridgeMode; via: LedgerVia; events: AsyncIterable<ModelEgressEvent>; controller: AbortController; execId?: string; /** F8's `abandon()` for a forwarded stream: called whenever the answer did not run to its settle, so the one record slot is free again. */ abandon?: () => void }): Promise<void> {
    const { controller } = input;
    let cut: ModelBridgeCutReason | undefined;
    let head: number | undefined;
    let settle: ModelEgressSettle | undefined;
    let sent = 0;
    const timer = setTimeout(() => { cut ??= "time"; controller.abort(); }, limits.totalMs);
    const gone = (): void => { if (!response.writableEnded) { cut ??= "gone"; controller.abort(); } };
    response.once("close", gone);
    const aborted = new Promise<"aborted">((resolve) => { if (controller.signal.aborted) resolve("aborted"); else controller.signal.addEventListener("abort", () => resolve("aborted"), { once: true }); });
    const iterator = input.events[Symbol.asyncIterator]();
    try {
      for (;;) {
        let next: IteratorResult<ModelEgressEvent> | "aborted";
        try {
          next = await Promise.race([iterator.next(), aborted]);
        } catch {
          // ONE attempt: a fault is the end of the call. Before the head it is a 502 in the family's own shape; after it the stream is cut.
          if (head === undefined) {
            head = 502;
            const body = familyErrorBody(input.family, 502, UNREACHABLE, "rovara_unreachable");
            settle = { kind: "settle", status: 502, class: "provider_error", costMicros: 0, estimated: false };
            await writeLines(response, [headLine(502, [["content-type", "application/json"]]), chunkLine(body), settleLine(settle)]);
          } else cut ??= "fault";
          break;
        }
        if (next === "aborted") break;
        if (next.done === true) break;
        const event = next.value;
        if (event.kind === "head") {
          if (head !== undefined) continue;
          head = event.status;
          if (!(await writeAll(response, headLine(event.status, event.headers)))) { cut ??= "gone"; break; }
        } else if (event.kind === "chunk") {
          let at = 0;
          while (at < event.bytes.byteLength) {
            const piece = event.bytes.subarray(at, at + limits.chunkBytes);
            if (sent + piece.byteLength > limits.responseBytes) { cut ??= "response_too_large"; break; }
            sent += piece.byteLength;
            at += piece.byteLength;
            if (!(await writeAll(response, chunkLine(piece)))) { cut ??= "gone"; break; }
          }
          if (cut !== undefined) break;
        } else {
          settle = event;
          await writeAll(response, settleLine(event));
          break;
        }
      }
    } finally {
      clearTimeout(timer);
      response.off("close", gone);
      // The settle is the end of the answer: close the stream so F8's recording runs its end step (a recording is stored only when the settle arrived and the stream closed). Any other end must not wait on the port.
      if (cut !== undefined || settle === undefined) {
        try { input.abandon?.(); } catch { /* nothing to free */ }
        void Promise.resolve(iterator.return?.()).catch(() => undefined);
      } else await Promise.resolve(iterator.return?.()).catch(() => undefined);
      if (cut === undefined && settle === undefined && head !== undefined) cut = controller.signal.aborted ? "time" : "fault";
      if (cut !== undefined) await writeAll(response, line({ t: "cut", why: cut }));
      aborts.delete(controller);
    }
    // The ledger row: the port's own settle when there is one; a call that ended without it is a provider error that cost nothing here (the adapter keeps its reservation).
    const answered: Answered = { ...(settle === undefined ? {} : { settle }), ...(cut === undefined ? {} : { cut }), ...(head === undefined ? {} : { status: head }) };
    if (input.via === "real") {
      spent += answered.settle?.costMicros ?? 0;
      largestCost = Math.max(largestCost, answered.settle?.costMicros ?? 0);
      if (answered.settle?.overrun === true) overrun = true;
    }
    options.ledger.record({
      row: options.familyOf(input.row) !== undefined ? input.row : "unknown",
      status: answered.settle?.status ?? answered.status ?? 0,
      class: answered.settle?.class ?? "provider_error",
      ...(answered.settle?.refusal === undefined ? {} : { refusal: answered.settle.refusal }),
      ...(answered.settle?.inputTokens === undefined ? {} : { inputTokens: answered.settle.inputTokens }),
      ...(answered.settle?.outputTokens === undefined ? {} : { outputTokens: answered.settle.outputTokens }),
      costMicros: answered.settle?.costMicros ?? 0,
      estimated: answered.settle?.estimated ?? false,
      via: input.via,
      ...(input.execId === undefined ? {} : { execId: input.execId }),
    });
    log({ event: "call", row: options.familyOf(input.row) !== undefined ? input.row : "unknown", mode: input.mode, status: answered.settle?.status ?? answered.status ?? 0, class: answered.settle?.class ?? "provider_error", ...(answered.settle?.refusal === undefined ? {} : { refusal: answered.settle.refusal }), ...(cut === undefined ? {} : { reason: cut }) });
  }

  async function handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (request.method !== "POST" || request.url !== "/call") {
      response.writeHead(404, { connection: "close" }).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", connection: "close" });
    const refuse = async (family: ModelEgressFamily, word: ModelEgressRefusal, row = "unknown", mode = "unknown", extra: { capMicros?: number; overrun?: boolean } = {}, execId?: string): Promise<void> => {
      const answer = refusalResponse(family, word, extra);
      note(row, mode, answer.status, classOfRefusal(word), word, "refused", execId);
      await writeLines(response, refusalLines(family, word, extra));
      response.end();
    };
    const modeHeader = request.headers["x-rovara-mode"];
    const mode = (MODEL_BRIDGE_MODES as readonly unknown[]).includes(modeHeader) ? (modeHeader as ModelBridgeMode) : undefined;
    const read = await readBody(request, limits.envelopeBytes);
    if (!read.ok) {
      if (read.reason === "slow" || read.reason === "gone") { response.destroy(); return; }
      await refuse(DEFAULT_FAMILY, "too_large");
      request.destroy();
      return;
    }
    if (mode === undefined) return refuse(DEFAULT_FAMILY, "bad_request");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(read.body); } catch { return refuse(DEFAULT_FAMILY, "bad_request", "unknown", mode); }
    const framed = frameOf(text);
    if (!framed.ok) return refuse(DEFAULT_FAMILY, framed.refusal, "unknown", mode);
    const { frame } = framed;
    const family = options.familyOf(frame.row);
    if (family === undefined) return refuse(DEFAULT_FAMILY, "not_found", "unknown", mode);
    const fam: ModelEgressFamily = family;
    const md: ModelBridgeMode = mode;
    const tokenHeader = request.headers["x-rovara-token"];
    const token = typeof tokenHeader === "string" ? tokenHeader : undefined;
    const execId = tokenOf(token)?.execId;
    const controller = new AbortController();
    aborts.add(controller);
    // The helper went away while this call waited: nothing is left to answer.
    response.once("close", () => { if (!response.writableEnded) controller.abort(); });
    const finishWith = async (lines: readonly string[], via: LedgerVia, cls: ModelEgressSettle["class"], status: number): Promise<void> => {
      note(frame.row, mode, status, cls, undefined, via, execId);
      await writeLines(response, lines);
      response.end();
      aborts.delete(controller);
    };
    const notRun = (sentence: string, reason: string): string[] => [line({ t: "not_run", reason, sentence })];
    const refuseBlocked = async (block: Block): Promise<void> => {
      aborts.delete(controller);
      if (block.by === "round") return finishWith(notRun(MODEL_FRESH_SANDBOX_SENTENCE, "fresh_sandbox"), "refused", "refused", 0);
      if (block.by === "token") return refuse(family, "not_allowed", frame.row, mode, {}, execId);
      if (block.limit !== undefined) {
        // The bridge's own count and concurrency limits: a 429 in the family's cap shape (what a client already handles), but class `refused` in the ledger, so it is never read as the provider's or the budget's "not run".
        const status = 429;
        const message = block.limit === "calls" ? "The test model call limit for this task was reached." : "Too many test model calls are open at once.";
        note(frame.row, mode, status, "refused", "cap", "refused", execId);
        await writeLines(response, [headLine(status, [["content-type", "application/json"], [MODEL_EGRESS_REFUSAL_HEADER, "cap"]]), chunkLine(familyErrorBody(family, status, message, `rovara_${block.limit}`)), settleLine({ kind: "settle", status, class: "refused", refusal: "cap", costMicros: 0, estimated: false })]);
        response.end();
        return;
      }
      return refuse(family, "cap", frame.row, mode, { ...(options.capMicros === undefined ? {} : { capMicros: options.capMicros }), ...(block.overrun ? { overrun: true } : {}) }, execId);
    };
    const endForward = (): void => {
      inflight -= 1;
      for (const wake of settleWaiters.splice(0)) wake();
    };

    if (mode === "replay") {
      if (options.recording === undefined) return finishWith([line({ t: "scripted" })], "refused", "refused", 0);
      const served = await options.recording.replay.serve(frame, { signal: controller.signal });
      return answerRecording(served, false);
    }
    if (mode === "real") {
      const entered = await enter(token, "real", controller.signal);
      if (entered === "aborted") { aborts.delete(controller); response.end(); return; }
      if (entered !== "started") return refuseBlocked(entered);
      try {
        await pump(response, { row: frame.row, family, mode, via: "real", events: options.egress.forward(options.egressScope, frame, { signal: controller.signal }), controller, ...(execId === undefined ? {} : { execId }) });
      } finally {
        endForward();
        response.end();
      }
      return;
    }
    // record: forwards the first call per changed prompt when a real call is allowed, otherwise only replays.
    if (options.recording === undefined) return finishWith([line({ t: "scripted" })], "refused", "refused", 0);
    const entered = await enter(token, "record", controller.signal);
    if (entered === "aborted") { aborts.delete(controller); response.end(); return; }
    const block = entered === "started" ? undefined : entered;
    const served = await (block === undefined ? options.recording.record : options.recording.replay).serve(frame, { signal: controller.signal });
    return answerRecording(served, block === undefined, block);

    async function answerRecording(result: RecordReplayServe, slotHeld: boolean, block?: Block): Promise<void> {
      try {
        if (result.kind === "scripted") return await finishWith([line({ t: "scripted" })], "refused", "refused", 0);
        if (result.kind === "not_run") {
          // A miss where the call could not have been forwarded is the reason it could not: the round, the token or the cap.
          if (block !== undefined && result.reason === "no_recording") {
            if (slotHeld) { endForward(); slotHeld = false; }
            return await refuseBlocked(block);
          }
          return await finishWith(notRun(result.sentence, result.reason), "refused", "refused", 0);
        }
        if (result.via === "forwarded" && !slotHeld) {
          // The engine must not forward when the bridge said no; it did not get here unless a mode was mixed up. Never make the call.
          result.abandon();
          return await refuse(fam, "not_allowed", frame.row, md, {}, execId);
        }
        await pump(response, { row: frame.row, family: fam, mode: md, via: result.via === "forwarded" ? "real" : "replayed", events: result.events, controller, abandon: result.abandon, ...(execId === undefined ? {} : { execId }) });
        response.end();
      } finally {
        if (slotHeld) endForward();
        response.end();
      }
    }
  }

  const bridge: ModelBridge = {
    async listen(path) {
      if (server !== undefined) throw new Error("the model bridge is already listening");
      // A Unix socket path has a short limit (104 bytes on macOS, 108 on Linux); a longer one is cut by the system and names the wrong file.
      if (Buffer.byteLength(path) > 100) throw new Error("the model bridge socket path is too long");
      await rm(path, { force: true });
      const created = http.createServer({ maxHeaderSize: limits.headersBytes, keepAlive: false } as http.ServerOptions, (request, response) => {
        handle(request, response).catch(() => { try { response.destroy(); } catch { /* gone */ } });
      });
      created.maxConnections = limits.connections;
      created.requestTimeout = limits.totalMs;
      created.headersTimeout = limits.headerReadMs;
      created.keepAliveTimeout = 1;
      created.on("connection", (socket) => {
        sockets.add(socket);
        // The header read: a connection that has not sent a whole request head by then is closed.
        const timer = setTimeout(() => socket.destroy(), limits.headerReadMs);
        socket.once("close", () => { clearTimeout(timer); sockets.delete(socket); });
        (socket as net.Socket & { __headerTimer?: NodeJS.Timeout }).__headerTimer = timer;
      });
      created.on("request", (request) => {
        const timer = (request.socket as net.Socket & { __headerTimer?: NodeJS.Timeout }).__headerTimer;
        if (timer !== undefined) clearTimeout(timer);
      });
      created.on("clientError", (_error, socket) => { try { socket.end("HTTP/1.1 431 Request Header Fields Too Large\r\nconnection: close\r\ncontent-length: 0\r\n\r\n"); } catch { socket.destroy(); } });
      await new Promise<void>((resolve, reject) => { created.once("error", reject); created.listen(path, () => { created.off("error", reject); resolve(); }); });
      await chmod(path, 0o600);
      server = created;
      socketPath = path;
    },
    issueToken(execId, issuedRound, modes) {
      const token = makeToken();
      if (!TOKEN.test(token)) throw new Error("the model bridge token is not plain");
      // Anything that is not exactly a typed round kind is the working round; only the two forwarding modes exist.
      const allowed = new Set(FORWARD_MODES.filter((mode) => Array.isArray(modes) && modes.includes(mode)));
      tokens.set(token, { execId, roundKind: parseModelRoundKind(issuedRound) ?? "working", modes: allowed });
      return token;
    },
    dropToken(execId) {
      for (const [token, held] of tokens) if (held.execId === execId) tokens.delete(token);
    },
    stats: () => ({ calls: callsStarted, inflight, spentMicros: spent, overrun }),
    async close() {
      tokens.clear();
      for (const controller of aborts) controller.abort();
      for (const wake of settleWaiters.splice(0)) wake();
      aborts.clear();
      for (const socket of sockets) socket.destroy();
      const closing = server;
      server = undefined;
      if (closing !== undefined) await new Promise<void>((resolve) => closing.close(() => resolve()));
      if (socketPath !== undefined) await rm(socketPath, { force: true });
      socketPath = undefined;
    },
  };
  void MODEL_EGRESS_OVERRUN_SENTENCE;
  return bridge;
}
