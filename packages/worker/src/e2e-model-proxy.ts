import { createHash } from "node:crypto";
import { chmod, chown, lstat, mkdir, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  E2E_MODEL_CHANNEL_MAX_REQUEST_BYTES,
  E2EModelChannelRequestSchema,
  E2EModelChannelResponseSchema,
  E2EModelRouteBudgetsSchema,
  canonicalJson,
  type E2EModelChannelRequest,
  type E2EModelReceipt,
  type E2EModelRouteDefinition,
} from "@agentx/contracts";
import {
  E2E_BUDGET_EXHAUSTED_PREFIX,
  E2EPayloadRefusedError,
  assertE2EEnvironmentCannotRedirect,
  e2ePromptSha256,
  e2eReservedInputTokens,
  type E2EModelCallIdentity,
  type E2EModelChannelResult,
  type E2EModelGenerateOutcome,
  type GovernedE2EModelRoute,
} from "@agentx/model-runtime";
import { createE2ECredentialGuard, type E2ECredentialGuard, type E2ECredentialSet } from "./e2e-model-credential-guard.js";
import { isScriptedE2EModelAdmissible } from "./e2e-model-scripted.js";

/**
 * The per-run model proxy (M1.4 Task 4.1): the worker side of `rovara-e2e-model-channel/v1`.
 *
 * It listens on one Unix socket (mode 0600) that the worker mounts into the executor container only, and accepts
 * `POST /v1/generate` and nothing else. The AI browser-test agent in the executor never holds a provider, key or
 * endpoint: everything it asks of a model comes through here, and the proxy is the only holder of the governed route.
 *
 * Per request, in this order: count it against the step and group budgets, refuse it if another call is in flight,
 * validate it against the channel schema and the run's own position, scan it for credentials, reserve group tokens, then
 * make the one provider call through the route. Every request that reaches `POST /v1/generate` gets a receipt, written
 * here from the proxy's own state (never from anything the executor sent), with the worker's `callIndex`.
 *
 * `callIndex` is per step (0, 1, 2, ...); the step budget (maxActions + 4 calls) is per step and the group budgets
 * (calls, input tokens, agent steps) are for the proxy's whole life. A request the proxy counts but cannot serve
 * (refused, failed, re-sent) still costs budget, because it is a receipt. Only a `budget` refusal is not counted, so a
 * flood cannot make the proxy exceed a limit the broker checks (`checkE2EStepModelAccounting`, `checkE2EGroupModelBudget`).
 */

export interface E2EModelTranscript {
  receiptId: string;
  runId: string;
  caseId: string;
  stepIndex: number;
  callIndex: number;
  outcome: E2EModelReceipt["outcome"];
  /** The prompt as sent to the provider, redacted. Null when omitted. */
  prompt: string | null;
  /** The answer, redacted. Null when omitted or when there was none. */
  response: string | null;
  omitted?: "budget" | "unparseable";
  /** `usage-missing`: the provider reported no usage, so the reserved bound was counted. */
  note?: "usage-missing";
  /** SHA-256 of the payload actually sent to the provider (after shaping), so the stored record can be tied to what left the worker. */
  providerPayloadSha256?: string;
}

/** Where the proxy writes. Receipts go to the worker's evidence; transcripts are operator-only and never reach a page. */
export interface E2EModelEvidenceSink {
  writeReceipt(receipt: E2EModelReceipt): void | Promise<void>;
  writeTranscript(transcript: E2EModelTranscript): void | Promise<void>;
}

export interface E2EModelProxyOptions {
  socketPath: string;
  runId: string;
  route: GovernedE2EModelRoute;
  /** The group's budgets. They may only lower the route's own. Defaults to the route's. */
  budgets?: E2EModelRouteDefinition["budgets"];
  credentialSet: E2ECredentialSet;
  evidence: E2EModelEvidenceSink;
  /** Epoch ms: the run's deadline. */
  deadlineAt: number;
  now?: () => number;
  /** Closes the proxy (and unlinks the socket) when the run is aborted. */
  signal?: AbortSignal;
  /** The policy the run is under. A scripted route is admitted only under a qualification policy (or ROVARA_E2E_SCRIPTED_MODEL=1). */
  policyScope?: "standard" | "qualification";
  environment?: NodeJS.ProcessEnv;
  /** Owner of the socket, when the worker runs as root and the executor does not. */
  socketOwner?: { uid: number; gid: number };
  /** Bytes of transcript bodies kept for the group. Over it, bodies are omitted. Default 1 MiB. */
  transcriptBudgetBytes?: number;
}

export interface E2EModelReceiptSummary {
  runId: string;
  routeId: string;
  routeRevision: string;
  /** Every receipt, ordered by step (first seen) and call index. This list is what the collector reads (`governedModelReceipts`). */
  receipts: E2EModelReceipt[];
  /** Requests that could not be given a receipt because a step already held the 100 the schema can number. Anything but 0 fails the run closed. */
  droppedRequests: number;
  /** Requests that arrived before any `beginStep`. They have no step to take a receipt, so they are counted here; anything but 0 means the executor called out of turn and the collector should fail closed. */
  unscopedRequests: number;
  /** Input tokens charged to the group, unclamped (a receipt holds at most 64000). */
  chargedInputTokens: number;
  /** True when a call was charged more than its receipt can show, or the group's input token cap was passed. Fails the run closed. */
  overrun: boolean;
  /** Receipts or transcripts the evidence sink failed to write. Anything but 0 means the stored copy is incomplete. */
  evidenceErrors: number;
  transcriptBytes: number;
}

export interface E2EModelProxy {
  readonly socketPath: string;
  /** The run reached an agent step. Calls are attributed to it, and its deadline starts now. */
  beginStep(position: { caseId: string; stepIndex: number }): void;
  /**
   * Values learned during the run, such as `Set-Cookie` values after login. Later calls are scanned for them. A value
   * too short to scan for safely does not throw: it latches the proxy to refuse every later call.
   */
  addCredentialValues(values: Partial<E2ECredentialSet>): void;
  /** The step ended. A call that arrives after is refused. */
  endStep(): void;
  receipts(): E2EModelReceipt[];
  /** Stops accepting, aborts a call in flight, unlinks the socket, and returns the receipt list. Safe to call again. */
  close(): Promise<E2EModelReceiptSummary>;
}

const DEFAULT_TRANSCRIPT_BUDGET_BYTES = 1_048_576;
const MAX_CALL_INDEX = 99;
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

type Position = { caseId: string; stepIndex: number };
interface StepState { position: Position; counted: number; nextIndex: number; order: number }
type Budgets = E2EModelRouteDefinition["budgets"];

function effectiveBudgets(route: E2EModelRouteDefinition["budgets"], requested: Budgets | undefined): Budgets {
  if (requested === undefined) return route;
  const asked = E2EModelRouteBudgetsSchema.parse(requested);
  return Object.fromEntries(Object.entries(route).map(([key, value]) => [key, Math.min(value, asked[key as keyof Budgets])])) as Budgets;
}

async function prepareSocketPath(path: string): Promise<void> {
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (existing === undefined) return;
  if (!existing.isSocket()) throw new Error("the model socket path exists and is not a socket");
  await unlink(path);
}

type BodyRead = { kind: "ok"; bytes: Buffer } | { kind: "too-large" } | { kind: "failed" };

function readBody(req: IncomingMessage, limit: number): Promise<BodyRead> {
  return new Promise((resolve) => {
    const declared = Number(req.headers["content-length"]);
    let tooLarge = Number.isFinite(declared) && declared > limit;
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) { tooLarge = true; chunks.length = 0; return; }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on("end", () => resolve(tooLarge ? { kind: "too-large" } : { kind: "ok", bytes: Buffer.concat(chunks) }));
    req.on("error", () => resolve({ kind: "failed" }));
    req.on("aborted", () => resolve({ kind: "failed" }));
  });
}

function send(res: ServerResponse, status: number, body: unknown, closeAfter = false): void {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, { "content-type": "application/json", "content-length": payload.length, ...(closeAfter ? { connection: "close" } : {}) });
  res.end(payload);
}

export async function startE2EModelProxy(options: E2EModelProxyOptions): Promise<E2EModelProxy> {
  const { route, runId, evidence, socketPath } = options;
  const now = options.now ?? Date.now;
  const definition = route.definition;
  if (definition.provider === "rovara-scripted" && !isScriptedE2EModelAdmissible({ policyScope: options.policyScope ?? "standard", environment: options.environment ?? process.env })) {
    throw new Error("a scripted model route is admitted only under a qualification policy or with ROVARA_E2E_SCRIPTED_MODEL=1");
  }
  // A route on a real provider calls it through pi-ai, which reads the environment; refuse to start when that can redirect the call.
  if (definition.provider !== "rovara-scripted") assertE2EEnvironmentCannotRedirect(options.environment ?? process.env);
  const budgets = effectiveBudgets(definition.budgets, options.budgets);
  // The provider key the route's invoke holds is a secret the model must never see.
  let credentials: E2ECredentialSet = {
    passwords: [...options.credentialSet.passwords, ...route.secretValues], emails: [...options.credentialSet.emails], cookieValues: [...options.credentialSet.cookieValues],
  };
  let guard: E2ECredentialGuard = createE2ECredentialGuard(credentials);
  const transcriptBudget = options.transcriptBudgetBytes ?? DEFAULT_TRANSCRIPT_BUDGET_BYTES;
  const stepCallLimit = budgets.maxActionsPerStep + budgets.extraModelCallsPerStep;

  const lifetime = new AbortController();
  const steps = new Map<string, StepState>();
  const countedSteps = new Set<string>();
  const receipts: E2EModelReceipt[] = [];
  let current: { position: Position; startedMs: number } | null = null;
  let last: Position | null = null;
  let groupCounted = 0;
  let groupInputTokens = 0;
  let droppedRequests = 0;
  let unscopedRequests = 0;
  let chargedInputTokens = 0;
  let overrun = false;
  const credentialLatched = new Set<string>();
  let evidenceErrors = 0;
  let transcriptBytes = 0;
  let lastStartedMs = 0;
  let inFlight: Promise<void> | null = null;
  let closing = false;
  let closePromise: Promise<E2EModelReceiptSummary> | undefined;

  const stepKey = (position: Position) => `${position.caseId}\0${position.stepIndex}`;
  const stamp = () => { lastStartedMs = Math.max(lastStartedMs, now()); return lastStartedMs; };
  const stateFor = (position: Position): StepState => {
    let state = steps.get(stepKey(position));
    if (state === undefined) { state = { position, counted: 0, nextIndex: 0, order: steps.size }; steps.set(stepKey(position), state); }
    return state;
  };

  async function record(receipt: E2EModelReceipt, extra: { prompt: string | null; response: string | null; omitted?: E2EModelTranscript["omitted"]; note?: E2EModelTranscript["note"]; providerPayloadSha256?: string }): Promise<void> {
    receipts.push(receipt);
    try { await evidence.writeReceipt(receipt); } catch { evidenceErrors += 1; }
    let { prompt, response, omitted } = extra;
    const size = Buffer.byteLength(prompt ?? "", "utf8") + Buffer.byteLength(response ?? "", "utf8");
    if (omitted === undefined && transcriptBytes + size > transcriptBudget) { prompt = null; response = null; omitted = "budget"; }
    else transcriptBytes += size;
    const transcript: E2EModelTranscript = { receiptId: receipt.receiptId, runId: receipt.runId, caseId: receipt.caseId, stepIndex: receipt.stepIndex, callIndex: receipt.callIndex, outcome: receipt.outcome, prompt, response, ...(omitted === undefined ? {} : { omitted }), ...(extra.note === undefined ? {} : { note: extra.note }), ...(extra.providerPayloadSha256 === undefined ? {} : { providerPayloadSha256: extra.providerPayloadSha256 }) };
    try { await evidence.writeTranscript(transcript); } catch { evidenceErrors += 1; }
  }

  const answer = (outcome: E2EModelGenerateOutcome): { receiptId: string; result: E2EModelChannelResult } => ({ receiptId: outcome.receipt.receiptId, result: outcome.result });

  function counted(state: StepState): void {
    state.counted += 1;
    groupCounted += 1;
    countedSteps.add(stepKey(state.position));
  }

  /** Everything up to the provider call is synchronous, so two requests can never both pass the same budget check. */
  async function serve(body: BodyRead): Promise<{ status: number; body: unknown }> {
    const startedAt = stamp();
    const position = current?.position ?? last;
    if (position === null) {
      // No step has begun. There is no step to take a receipt, and an invented one would use up an agent step slot.
      unscopedRequests += 1;
      return { status: 200, body: { schemaVersion: "rovara-e2e-model-channel/v1", receiptId: "unscoped", result: { status: "error", code: "refused-protocol", message: "no agent step has begun" } } };
    }
    const state = stateFor(position);
    if (state.nextIndex > MAX_CALL_INDEX) {
      droppedRequests += 1;
      return { status: 429, body: { schemaVersion: "rovara-e2e-model-channel/v1", receiptId: "dropped", result: { status: "error", code: "budget", message: `${E2E_BUDGET_EXHAUSTED_PREFIX}: too many requests for one step` } } };
    }
    const identity: E2EModelCallIdentity = { runId, caseId: position.caseId, stepIndex: position.stepIndex, callIndex: state.nextIndex };
    state.nextIndex += 1;
    const rawDigest = body.kind === "ok" ? sha256(body.bytes) : sha256(`no-body:${body.kind}`);
    const declined = async (code: Parameters<GovernedE2EModelRoute["decline"]>[1], message: string, extra: { status?: number; promptSha256?: string; prompt?: string | null; omitted?: E2EModelTranscript["omitted"]; counts?: boolean } = {}) => {
      if (extra.counts !== false) counted(state);
      const outcome = route.decline(identity, code, message, { promptSha256: extra.promptSha256 ?? rawDigest, startedAt });
      await record(outcome.receipt, { prompt: extra.prompt ?? null, response: null, ...(extra.omitted === undefined ? {} : { omitted: extra.omitted }) });
      return { status: extra.status ?? 200, body: { schemaVersion: "rovara-e2e-model-channel/v1", ...answer(outcome) } };
    };
    const budgetMessage = (why: string) => `${E2E_BUDGET_EXHAUSTED_PREFIX}: ${why}`;

    if (state.counted >= stepCallLimit) return declined("budget", budgetMessage("the step's call limit is reached"), { counts: false });
    if (groupCounted >= budgets.maxModelCallsPerGroup) return declined("budget", budgetMessage("the group's call limit is reached"), { counts: false });
    if (!countedSteps.has(stepKey(position)) && countedSteps.size >= budgets.maxAgentStepsPerGroup) return declined("budget", budgetMessage("the group's agent step limit is reached"), { counts: false });
    if (inFlight !== null) return declined("refused-busy", "another model call is in flight");
    if (closing) return declined("refused-busy", "the model channel is closing");
    if (credentialLatched.has(stepKey(position)) || guard.unscannable) {
      return declined("refused-credential-match", "model-prompt-credential-match: an earlier call in this step carried a credential, or a reported credential cannot be scanned", { omitted: "unparseable" });
    }
    if (body.kind === "too-large") return declined("refused-protocol", `the request is over ${E2E_MODEL_CHANNEL_MAX_REQUEST_BYTES} bytes`, { status: 413, omitted: "unparseable" });
    if (body.kind === "failed") return declined("refused-protocol", "the request body could not be read", { omitted: "unparseable" });
    if (current === null) return declined("refused-protocol", "no agent step is running", { omitted: "unparseable" });

    let json: unknown;
    try { json = JSON.parse(body.bytes.toString("utf8")); } catch { return declined("refused-protocol", "the request is not JSON", { omitted: "unparseable" }); }
    const parsed = E2EModelChannelRequestSchema.safeParse(json);
    if (!parsed.success) return declined("refused-protocol", "the request is not a valid model channel request", { omitted: "unparseable" });
    const request: E2EModelChannelRequest = parsed.data;
    const promptSha256 = e2ePromptSha256(request.call);
    const redactedForEvidence = () => JSON.stringify(guard.scrubValue(request.call));
    if (request.runId !== runId || request.caseId !== identity.caseId || request.stepIndex !== identity.stepIndex || request.callIndex !== identity.callIndex) {
      return declined("refused-protocol", "the request does not match this run, step and call position", { promptSha256, prompt: redactedForEvidence() });
    }

    const inspection = guard.inspect(request.call);
    if (inspection.refuse) {
      credentialLatched.add(stepKey(position));
      return declined("refused-credential-match", "model-prompt-credential-match: the prompt carried a seeded credential or credential-shaped text", { promptSha256, prompt: redactedForEvidence() });
    }
    const promptBytes = Buffer.byteLength(canonicalJson(inspection.call), "utf8");
    const bound = e2eReservedInputTokens(promptBytes);
    if (bound > budgets.maxInputTokens) {
      return declined("refused-protocol", `the prompt could pass the per-call input token limit of ${budgets.maxInputTokens} (upper bound ${bound})`, { promptSha256, prompt: redactedForEvidence() });
    }
    if (groupInputTokens + bound > budgets.maxInputTokensPerGroup) {
      return declined("budget", budgetMessage("the group's input token limit would be passed"), { counts: false, promptSha256, prompt: redactedForEvidence() });
    }

    counted(state);
    const sent: E2EModelChannelRequest = { ...request, call: inspection.call };
    const stepDeadline = current.startedMs + budgets.stepDeadlineMs;
    let settle!: () => void;
    inFlight = new Promise<void>((resolve) => { settle = resolve; });
    try {
      let outcome: E2EModelGenerateOutcome;
      try {
        outcome = await route.generate(sent, {
          signal: lifetime.signal, deadlineAt: Math.min(options.deadlineAt, stepDeadline), startedAt,
          budgets: { callTimeoutMs: budgets.callTimeoutMs, maxOutputTokens: budgets.maxOutputTokens, maxPromptBytes: budgets.maxPromptBytes, maxInputTokens: budgets.maxInputTokens },
          // The last credential scan, on the payload exactly as it would be sent.
          inspectPayload: (payload) => { if (guard.containsSecret(payload)) throw new E2EPayloadRefusedError(); },
        });
      } catch {
        // The route failed inside. The request still gets a receipt, so call indexes stay contiguous.
        outcome = route.decline(identity, "provider-error", "the model route failed", { promptSha256, startedAt });
      }
      groupInputTokens += outcome.chargedInputTokens;
      chargedInputTokens += outcome.chargedInputTokens;
      if (outcome.chargedInputTokens > outcome.receipt.inputTokens || groupInputTokens > budgets.maxInputTokensPerGroup) overrun = true;
      await record(outcome.receipt, {
        prompt: JSON.stringify(guard.scrubValue(sent.call)), response: JSON.stringify(guard.scrubValue(outcome.result)),
        ...(outcome.usageMissing === true ? { note: "usage-missing" as const } : {}),
        ...(outcome.providerPayloadSha256 === undefined ? {} : { providerPayloadSha256: outcome.providerPayloadSha256 }),
      });
      if (outcome.receipt.outcome === "refused-credential-match") credentialLatched.add(stepKey(position));
      const body = { schemaVersion: "rovara-e2e-model-channel/v1", ...answer(outcome) };
      return { status: 200, body: E2EModelChannelResponseSchema.parse(body) };
    } finally {
      inFlight = null;
      settle();
    }
  }

  const server: Server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000, keepAliveTimeout: 1_000 }, (req, res) => {
    void (async () => {
      if (req.url !== "/v1/generate") { req.resume(); send(res, 404, { error: "not-found" }); return; }
      if (req.method !== "POST") { req.resume(); res.setHeader("allow", "POST"); send(res, 405, { error: "method-not-allowed" }); return; }
      if (closing && inFlight === null) { req.resume(); send(res, 503, { error: "closing" }, true); return; }
      const body = await readBody(req, E2E_MODEL_CHANNEL_MAX_REQUEST_BYTES);
      let reply: { status: number; body: unknown };
      try { reply = await serve(body); }
      catch { reply = { status: 500, body: { error: "internal" } }; }
      if (res.writableEnded || res.destroyed) return;
      send(res, reply.status, reply.body);
    })();
  });

  // The socket lives in a directory only its owner can use, so there is no window in which another user could reach it
  // between bind and chmod, and no change to the process umask (which every other file the worker creates would share).
  const directory = dirname(socketPath);
  const existed = await stat(directory).then(() => true, () => false);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!existed) await chmod(directory, 0o700);
  if (((await stat(directory)).mode & 0o077) !== 0) throw new Error("the model socket directory must be mode 0700");
  await prepareSocketPath(socketPath);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => { server.off("error", reject); resolve(); });
  });
  try {
    await chmod(socketPath, 0o600);
    if (((await stat(socketPath)).mode & 0o777) !== 0o600) throw new Error("the model socket is not mode 0600");
    if (options.socketOwner !== undefined) {
      await chown(directory, options.socketOwner.uid, options.socketOwner.gid);
      await chown(socketPath, options.socketOwner.uid, options.socketOwner.gid);
    }
  } catch (error) {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    await unlink(socketPath).catch(() => undefined);
    throw error;
  }

  const orderedReceipts = (): E2EModelReceipt[] => [...receipts].sort((left, right) => {
    const a = steps.get(stepKey({ caseId: left.caseId, stepIndex: left.stepIndex }))?.order ?? 0;
    const b = steps.get(stepKey({ caseId: right.caseId, stepIndex: right.stepIndex }))?.order ?? 0;
    return a - b || left.callIndex - right.callIndex;
  });

  async function doClose(): Promise<E2EModelReceiptSummary> {
    closing = true;
    lifetime.abort(new Error("the run ended"));
    const stopped = new Promise<void>((resolve) => { server.close(() => resolve()); });
    server.closeIdleConnections();
    try {
      await inFlight?.catch(() => undefined);
      // Let the last answer reach its client, then drop whatever is still connected.
      await new Promise<void>((resolve) => setImmediate(resolve));
      server.closeAllConnections();
      await stopped;
    } finally {
      await unlink(socketPath).catch(() => undefined);
    }
    return { runId, routeId: definition.routeId, routeRevision: route.routeRevision, receipts: orderedReceipts(), droppedRequests, unscopedRequests, chargedInputTokens, overrun, evidenceErrors, transcriptBytes };
  }

  const proxy: E2EModelProxy = {
    socketPath,
    beginStep(position) { current = { position: { caseId: position.caseId, stepIndex: position.stepIndex }, startedMs: now() }; last = current.position; },
    endStep() { current = null; },
    addCredentialValues(values) {
      credentials = {
        passwords: [...credentials.passwords, ...(values.passwords ?? [])],
        emails: [...credentials.emails, ...(values.emails ?? [])],
        cookieValues: [...credentials.cookieValues, ...(values.cookieValues ?? [])],
      };
      guard = createE2ECredentialGuard(credentials, { onUnscannable: "latch" });
    },
    receipts: orderedReceipts,
    close() { closePromise ??= doClose(); return closePromise; },
  };
  if (options.signal !== undefined) {
    if (options.signal.aborted) void proxy.close();
    else options.signal.addEventListener("abort", () => { void proxy.close(); }, { once: true });
  }
  return proxy;
}
