// Cloud -> gateway service calls (PRODUCT-VERTEX-CLOUD-CONNECT). Only the gateway's serving role may assume the Vertex federation
// role, so Cloud's settings route cannot run the Vertex connection test itself. It asks the gateway: "test this Vertex federation
// setup for this company". The gateway mints a token for the company and checks that the customer's pool REFUSES a canary
// company (VertexTokens.probe), and answers only the probe's fixed result. Cloud then seals the record in its own store
// transaction, as for every other key (ProductKeyStore.connect / rotate with vertexCheck): the gateway stays read-only on keys.
//
// Authentication: an HMAC from the product key store's KMS HMAC key (ProductKeysMacKey). Cloud's settings role may only
// GenerateMac; the gateway's serving role may only VerifyMac; the key never leaves KMS. The MAC covers a fixed purpose (apart
// from the key fingerprints the same key makes: product-seal.ts uses PRODUCT_KEY_PURPOSE), the path, the time and the body's
// SHA-256, so a call can't be moved to another path, company or credential. A call is taken for SERVICE_CALL_SKEW_MS either side
// of the gateway's clock. A replay inside that window only re-runs the same test (no state changes on the gateway).
//
// Every failure is one fixed word: nothing from the request or from KMS/Google is echoed or logged.
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { COMPANY, record } from "./model-gateway-token.js";
import type { BedrockCheck, VertexCheck } from "./product-keys.js";
import { BEDROCK_EXTERNAL_ID, BEDROCK_MODEL_CHECKS, bedrockConnectionIds, parseBedrockConnect, type BedrockConnection, type BedrockModelCheck } from "./bedrock-byo.js";
import type { BedrockProbe } from "./bedrock-byo-sessions.js";
import { parseVertexConnect, type VertexCredential } from "./product-vertex-credential.js";
import type { ProbeResult } from "./product-vertex-token.js";

export const SERVICE_CALL_PURPOSE = "rovara-gateway-service-call/v1";
export const VERTEX_CHECK_PATH = "/v1/service/vertex-check";
export const SERVICE_CALL_AT_HEADER = "x-rovara-call-at";
export const SERVICE_CALL_MAC_HEADER = "x-rovara-call-mac";
export const SERVICE_CALL_SKEW_MS = 60_000;
export const SERVICE_CALL_BODY_MAX = 4_096;
/** Cloud's wait for the gateway's answer (the probe makes up to four Google/AWS calls of 5 s each). */
export const SERVICE_CALL_TIMEOUT_MS = 25_000;
/**
 * Per serving task, before any KMS call: this path is on the public load balancer and each check costs a KMS VerifyMac (and,
 * when signed, a probe at Google), so anonymous traffic must not turn into unbounded paid calls or eat the account's KMS rate.
 * At most SERVICE_CALL_OPEN checks at once and SERVICE_CALL_PER_MINUTE started per minute; over either: 429, nothing called.
 * A person connects Vertex rarely (admin only), so this never limits real use.
 */
export const SERVICE_CALL_OPEN = 2;
export const SERVICE_CALL_PER_MINUTE = 30;
/**
 * Per company, inside the Bedrock check (after the signature names the company): one probe at a time and at most
 * BEDROCK_CHECK_COMPANY_PER_MINUTE started per minute, whatever Cloud's own limits are, so one company's connects, re-checks or a script
 * can't use up the task-wide SERVICE_CALL_* room or the customer's AWS account for other companies. Over either: 429 and nothing is probed
 * (Cloud reads it as "unavailable: nothing was saved, try again" for that company only). Connect, rotate and Check again all pass through here.
 */
export const BEDROCK_CHECK_COMPANY_PER_MINUTE = 6;
const RESULTS: readonly ProbeResult[] = ["ok", "too_open", "refused", "unavailable"];

export interface MacSigner { generateMac(input: { KeyId: string; Message: Uint8Array }): Promise<{ Mac?: Uint8Array }> }
export interface MacVerifier { verifyMac(input: { KeyId: string; Message: Uint8Array; Mac: Uint8Array }): Promise<boolean> }

/** What the MAC covers: sha256 of [purpose, path, time, sha256(body)]. 32 bytes, under KMS's 4,096-byte message limit. */
export function serviceCallMessage(path: string, at: number, body: Buffer): Uint8Array {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return createHash("sha256").update(JSON.stringify([SERVICE_CALL_PURPOSE, path, at, bodyHash])).digest();
}

/** The body of a Vertex check: the install, the company, and the federation setup the customer typed. */
export interface VertexCheckBody { iss: string; cid: string; credential: Extract<VertexCredential, { scheme: "federation" }> }

export interface GatewayVertexCheckOptions {
  /** The gateway's address (https://host, no path). */
  address: string;
  /** The Code install's token issuer the key rows are bound to (the gateway refuses another). */
  issuer: string;
  kms: MacSigner;
  macKeyId: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * Cloud's side: the store's VertexCheck, answered by the gateway. Only a federation setup is sent (a key file never leaves Cloud
 * this way); anything the gateway does not answer with one of the four results is "unavailable" (nothing is saved).
 */
export function gatewayVertexCheck(options: GatewayVertexCheckOptions): VertexCheck {
  const send = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  return async (cid, credential) => {
    if (credential.scheme !== "federation" || !COMPANY.test(cid)) return "unavailable";
    try {
      const body = Buffer.from(JSON.stringify({ iss: options.issuer, cid, credential: { scheme: "federation", projectId: credential.projectId, location: credential.location, audience: credential.audience, ...(credential.serviceAccount === undefined ? {} : { serviceAccount: credential.serviceAccount }) } } satisfies VertexCheckBody));
      const at = now();
      const signed = await options.kms.generateMac({ KeyId: options.macKeyId, Message: serviceCallMessage(VERTEX_CHECK_PATH, at, body) });
      if (signed.Mac === undefined || signed.Mac.length !== 32) return "unavailable";
      const answer = await send(new URL(VERTEX_CHECK_PATH, options.address), {
        method: "POST", body, redirect: "error", signal: AbortSignal.timeout(SERVICE_CALL_TIMEOUT_MS),
        headers: { "content-type": "application/json", [SERVICE_CALL_AT_HEADER]: String(at), [SERVICE_CALL_MAC_HEADER]: Buffer.from(signed.Mac).toString("base64url") },
      });
      if (answer.status !== 200) return "unavailable";
      const text = await answer.text();
      if (text.length > 256) return "unavailable";
      const result = record(JSON.parse(text) as unknown)?.result;
      return RESULTS.find((r) => r === result) ?? "unavailable";
    } catch { return "unavailable"; }
  };
}

export interface VertexCheckHandlerOptions {
  /** This gateway's one Code install (its token issuer). */
  issuer: string;
  kms: MacVerifier;
  macKeyId: string;
  vertex: { probe(cid: string, credential: VertexCredential, signal?: AbortSignal): Promise<ProbeResult> };
  now?: () => number;
}

const ANSWERS = {
  busy: { status: 429, body: { error: { type: "busy", message: "too many service calls; try again later" } } },
  notAllowed: { status: 405, body: { error: { type: "not_found", message: "not found" } } },
  tooLarge: { status: 413, body: { error: { type: "invalid_request", message: "the request is too large" } } },
  refused: { status: 401, body: { error: { type: "unauthorized", message: "the service call is not signed" } } },
  invalid: { status: 400, body: { error: { type: "invalid_request", message: "the service call is not valid" } } },
  unavailable: { status: 503, body: { error: { type: "unavailable", message: "model access unavailable" } } },
} as const;

/** Reads at most `max` bytes; undefined when the body is longer. */
async function readBody(req: AsyncIterable<Uint8Array>, max: number): Promise<Buffer | undefined> {
  const parts: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) return undefined;
    parts.push(Buffer.from(chunk));
  }
  return Buffer.concat(parts);
}

type ServiceRequest = { method: string; headers: Readonly<Record<string, string | string[] | undefined>>; body: AsyncIterable<Uint8Array> };
type ServiceAnswer = { status: number; body: unknown };
/**
 * A service call Cloud signed for `path`, read and checked: the method, the size, the time, the MAC (KMS VerifyMac), then a JSON
 * object naming this gateway's issuer and a company. Anything else is the fixed answer. Shared by every service path.
 */
async function signedCall(options: { issuer: string; kms: MacVerifier; macKeyId: string; now?: () => number }, path: string, request: ServiceRequest): Promise<{ input: Record<string, unknown>; cid: string } | ServiceAnswer> {
  if (request.method !== "POST") return ANSWERS.notAllowed;
  const body = await readBody(request.body, SERVICE_CALL_BODY_MAX);
  if (body === undefined) return ANSWERS.tooLarge;
  const atText = request.headers[SERVICE_CALL_AT_HEADER]; const macText = request.headers[SERVICE_CALL_MAC_HEADER];
  if (typeof atText !== "string" || !/^[0-9]{1,16}$/u.test(atText) || typeof macText !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(macText)) return ANSWERS.refused;
  const at = Number(atText);
  if (Math.abs((options.now ?? Date.now)() - at) > SERVICE_CALL_SKEW_MS) return ANSWERS.refused;
  let valid: boolean;
  try { valid = await options.kms.verifyMac({ KeyId: options.macKeyId, Message: serviceCallMessage(path, at, body), Mac: new Uint8Array(Buffer.from(macText, "base64url")) }); }
  catch (error) { return (error as { name?: unknown } | null)?.name === "KMSInvalidMacException" ? ANSWERS.refused : ANSWERS.unavailable; }
  if (valid !== true) return ANSWERS.refused;
  let parsed: unknown;
  try { parsed = JSON.parse(body.toString("utf8")) as unknown; } catch { return ANSWERS.invalid; }
  const input = record(parsed);
  if (input === undefined || input.iss !== options.issuer || typeof input.cid !== "string" || !COMPANY.test(input.cid)) return ANSWERS.invalid;
  return { input, cid: input.cid };
}

/** The gateway's answer to one Vertex check: status and JSON body. Exported for tests; the server writes it. */
export async function answerVertexCheck(options: VertexCheckHandlerOptions, request: { method: string; headers: Readonly<Record<string, string | string[] | undefined>>; body: AsyncIterable<Uint8Array> }, signal?: AbortSignal): Promise<{ status: number; body: unknown }> {
  if (request.method !== "POST") return ANSWERS.notAllowed;
  const body = await readBody(request.body, SERVICE_CALL_BODY_MAX);
  if (body === undefined) return ANSWERS.tooLarge;
  const atText = request.headers[SERVICE_CALL_AT_HEADER]; const macText = request.headers[SERVICE_CALL_MAC_HEADER];
  if (typeof atText !== "string" || !/^[0-9]{1,16}$/u.test(atText) || typeof macText !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(macText)) return ANSWERS.refused;
  const at = Number(atText);
  if (Math.abs((options.now ?? Date.now)() - at) > SERVICE_CALL_SKEW_MS) return ANSWERS.refused;
  let valid: boolean;
  try { valid = await options.kms.verifyMac({ KeyId: options.macKeyId, Message: serviceCallMessage(VERTEX_CHECK_PATH, at, body), Mac: new Uint8Array(Buffer.from(macText, "base64url")) }); }
  catch (error) { return (error as { name?: unknown } | null)?.name === "KMSInvalidMacException" ? ANSWERS.refused : ANSWERS.unavailable; }
  if (valid !== true) return ANSWERS.refused;
  // Signed by Cloud: now the body's shape, exactly.
  let parsed: unknown;
  try { parsed = JSON.parse(body.toString("utf8")) as unknown; } catch { return ANSWERS.invalid; }
  const input = record(parsed);
  if (input === undefined || Object.keys(input).length !== 3 || input.iss !== options.issuer || typeof input.cid !== "string" || !COMPANY.test(input.cid)) return ANSWERS.invalid;
  const fields = record(input.credential);
  const credential = fields === undefined || fields.scheme !== "federation" ? undefined : parseVertexConnect(JSON.stringify(fields));
  if (credential === undefined) return ANSWERS.invalid;
  const result = await options.vertex.probe(input.cid, credential, signal).catch((): ProbeResult => "unavailable");
  return { status: 200, body: { result: RESULTS.includes(result) ? result : "unavailable" } };
}

/** The HTTP handler the serving process mounts at VERTEX_CHECK_PATH (process.ts), only when Vertex and the MAC key are configured. */
export function createVertexCheckHandler(options: VertexCheckHandlerOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return serviceHandler(options.now ?? Date.now, (request, signal) => answerVertexCheck(options, request, signal));
}

// ---- Bring your own Bedrock (DEC 238) -----------------------------------------------------------------------------------------
// Only the gateway's serving role may assume the Bedrock broker and make the company's external id (its own KMS HMAC key), so
// Cloud's settings route asks the gateway for both, signed as the Vertex check is:
//   POST /v1/service/bedrock-setup  {iss, cid}              -> {externalId, brokerRoleArn}: what the company's AWS admin fills in
//   POST /v1/service/bedrock-check  {iss, cid, connection}  -> {result, models}: the connection test (BedrockSessions.probe)
// Each MAC covers its own path, so a signed setup call can't be replayed as a check or for another company. The gateway stays
// read-only on keys: Cloud seals the connection in its own store transaction (ProductKeyStore.connect / rotate, bedrockCheck).
export const BEDROCK_SETUP_PATH = "/v1/service/bedrock-setup";
export const BEDROCK_CHECK_PATH = "/v1/service/bedrock-check";
const PROBE_RESULTS = ["ok", "too_open", "refused", "unavailable"] as const;
export interface BedrockSetup { externalId: string; brokerRoleArn: string }
export interface BedrockServiceOptions {
  issuer: string; kms: MacVerifier; macKeyId: string; now?: () => number;
  brokerRoleArn: string;
  externalIds: { of(iss: string, cid: string): Promise<string> };
  bedrock: { probe(cid: string, connection: BedrockConnection, signal?: AbortSignal): Promise<BedrockProbe> };
}
export async function answerBedrockSetup(options: BedrockServiceOptions, request: ServiceRequest): Promise<ServiceAnswer> {
  const call = await signedCall(options, BEDROCK_SETUP_PATH, request);
  if ("status" in call) return call;
  if (Object.keys(call.input).length !== 2) return ANSWERS.invalid;
  let externalId: string;
  try { externalId = await options.externalIds.of(options.issuer, call.cid); } catch { return ANSWERS.unavailable; }
  if (!BEDROCK_EXTERNAL_ID.test(externalId)) return ANSWERS.unavailable;
  return { status: 200, body: { externalId, brokerRoleArn: options.brokerRoleArn } };
}
const companyChecks = new WeakMap<object, Map<string, { open: boolean; started: number[] }>>();
/** Takes this company's place in the check (false: over its limit); `release` frees it. */
function takeCompanyCheck(options: BedrockServiceOptions, cid: string): (() => void) | undefined {
  const now = (options.now ?? Date.now)();
  const all = companyChecks.get(options) ?? new Map<string, { open: boolean; started: number[] }>(); companyChecks.set(options, all);
  const mine = all.get(cid) ?? { open: false, started: [] }; all.set(cid, mine);
  mine.started = mine.started.filter((at) => now - at < 60_000);
  if (mine.open || mine.started.length >= BEDROCK_CHECK_COMPANY_PER_MINUTE) return undefined;
  mine.open = true; mine.started.push(now);
  // A company with nothing running and nothing started this minute holds no row.
  return () => { mine.open = false; if (all.size > MAX_COMPANY_ROWS) for (const [id, row] of all) if (!row.open && row.started.every((at) => (options.now ?? Date.now)() - at >= 60_000)) all.delete(id); };
}
const MAX_COMPANY_ROWS = 1_000;
export async function answerBedrockCheck(options: BedrockServiceOptions, request: ServiceRequest, signal?: AbortSignal): Promise<ServiceAnswer> {
  const call = await signedCall(options, BEDROCK_CHECK_PATH, request);
  if ("status" in call) return call;
  if (Object.keys(call.input).length !== 3) return ANSWERS.invalid;
  const fields = record(call.input.connection);
  const connection = fields === undefined ? undefined : parseBedrockConnect(JSON.stringify(fields));
  if (connection === undefined) return ANSWERS.invalid;
  const release = takeCompanyCheck(options, call.cid);
  if (release === undefined) return ANSWERS.busy;
  const probe = await options.bedrock.probe(call.cid, connection, signal).catch((): BedrockProbe => ({ result: "unavailable" })).finally(release);
  const result = PROBE_RESULTS.find((r) => r === probe.result) ?? "unavailable";
  return { status: 200, body: { result, ...(result === "ok" && probe.models !== undefined ? { models: probe.models } : {}) } };
}
/** The handlers the serving process mounts at BEDROCK_SETUP_PATH and BEDROCK_CHECK_PATH (process.ts), only when BYO Bedrock is configured. */
export function createBedrockServiceHandlers(options: BedrockServiceOptions): Record<typeof BEDROCK_SETUP_PATH | typeof BEDROCK_CHECK_PATH, (req: IncomingMessage, res: ServerResponse) => Promise<void>> {
  const now = options.now ?? Date.now;
  return {
    [BEDROCK_SETUP_PATH]: serviceHandler(now, (request) => answerBedrockSetup(options, request)),
    [BEDROCK_CHECK_PATH]: serviceHandler(now, (request, signal) => answerBedrockCheck(options, request, signal)),
  };
}

async function signedPost(options: GatewayVertexCheckOptions, path: string, payload: Record<string, unknown>): Promise<unknown> {
  const send = options.fetch ?? fetch;
  const body = Buffer.from(JSON.stringify(payload));
  const at = (options.now ?? Date.now)();
  const signed = await options.kms.generateMac({ KeyId: options.macKeyId, Message: serviceCallMessage(path, at, body) });
  if (signed.Mac === undefined || signed.Mac.length !== 32) throw new Error("unavailable");
  const answer = await send(new URL(path, options.address), {
    method: "POST", body, redirect: "error", signal: AbortSignal.timeout(SERVICE_CALL_TIMEOUT_MS),
    headers: { "content-type": "application/json", [SERVICE_CALL_AT_HEADER]: String(at), [SERVICE_CALL_MAC_HEADER]: Buffer.from(signed.Mac).toString("base64url") },
  });
  if (answer.status !== 200) throw new Error("unavailable");
  const text = await answer.text();
  if (text.length > 4096) throw new Error("unavailable");
  return JSON.parse(text) as unknown;
}
/** Cloud's side: the company's external id and Rovara's broker role, from the gateway. Undefined when it can't answer. */
export function gatewayBedrockSetup(options: GatewayVertexCheckOptions): (cid: string) => Promise<BedrockSetup | undefined> {
  return async (cid) => {
    if (!COMPANY.test(cid)) return undefined;
    try {
      const answer = record(await signedPost(options, BEDROCK_SETUP_PATH, { iss: options.issuer, cid }));
      if (answer === undefined || typeof answer.externalId !== "string" || !BEDROCK_EXTERNAL_ID.test(answer.externalId) || typeof answer.brokerRoleArn !== "string" || !/^arn:aws:iam::[0-9]{12}:role\/RovaraBedrockBroker-[a-z0-9-]{1,32}$/u.test(answer.brokerRoleArn)) return undefined;
      return { externalId: answer.externalId, brokerRoleArn: answer.brokerRoleArn };
    } catch { return undefined; }
  };
}
/** Cloud's side: the store's BedrockCheck, answered by the gateway. Anything but a well-formed answer is "unavailable" (nothing saved). */
export function gatewayBedrockCheck(options: GatewayVertexCheckOptions): BedrockCheck {
  return async (cid, connection) => {
    if (!COMPANY.test(cid)) return { result: "unavailable" };
    try {
      const answer = record(await signedPost(options, BEDROCK_CHECK_PATH, { iss: options.issuer, cid, connection: { scheme: "assume_role", roleArn: connection.roleArn, region: connection.region, models: connection.models, allowGlobal: connection.allowGlobal, ...(connection.productModels === undefined ? {} : { productModels: connection.productModels }) } }));
      const result = PROBE_RESULTS.find((r) => r === answer?.result) ?? "unavailable";
      if (result !== "ok") return { result };
      const models = record(answer?.models);
      const out: Record<string, BedrockModelCheck> = {};
      // The agents' picks and the product models: every id the connection names, so the store reads each one's own answer.
      for (const id of bedrockConnectionIds(connection)) { const state = models?.[id]; out[id] = BEDROCK_MODEL_CHECKS.find((c) => c === state) ?? "unavailable"; }
      return { result, models: out };
    } catch { return { result: "unavailable" }; }
  };
}

/** One rate-limited service endpoint: at most SERVICE_CALL_OPEN at once and SERVICE_CALL_PER_MINUTE per minute, per path. */
function serviceHandler(now: () => number, answerOf: (request: ServiceRequest, signal: AbortSignal) => Promise<ServiceAnswer>): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const limit = serviceCallLimiter(now);
  return async (req, res) => {
    const controller = new AbortController(); const abort = () => controller.abort();
    res.once("close", abort);
    const release = limit.take();
    try {
      const answer = release === undefined ? ANSWERS.busy : await answerOf({ method: req.method ?? "", headers: req.headers, body: req }, controller.signal);
      if (release === undefined) req.resume();
      if (res.headersSent || res.destroyed) return;
      res.writeHead(answer.status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(answer.body));
    } finally { release?.(); res.off("close", abort); }
  };
}

/** SERVICE_CALL_OPEN at once and SERVICE_CALL_PER_MINUTE started per rolling minute. take(): a release function, or undefined when over. */
export function serviceCallLimiter(now: () => number, open = SERVICE_CALL_OPEN, perMinute = SERVICE_CALL_PER_MINUTE): { take(): (() => void) | undefined } {
  let running = 0; const started: number[] = [];
  return {
    take() {
      const at = now();
      while (started.length > 0 && started[0]! <= at - 60_000) started.shift();
      if (running >= open || started.length >= perMinute) return undefined;
      running++; started.push(at);
      let done = false;
      return () => { if (!done) { done = true; running--; } };
    },
  };
}
