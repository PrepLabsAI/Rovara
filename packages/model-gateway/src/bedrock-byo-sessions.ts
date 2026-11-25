// The customer's Bedrock role, assumed per company (DEC 238 slice 1; bedrock-byo.ts says what the role trusts).
//
//   1. AssumeRole on Rovara's Bedrock broker role with the gateway task role's credentials, RoleSessionName = the company id.
//   2. AssumeRole on the customer's role with the broker session, ExternalId = the company's derived external id and
//      RoleSessionName = the company id. Both come from the company the route found from the VERIFIED task token (or the
//      signed Cloud call): never from the request, never from stored customer data.
// Role chaining caps each session at one hour, so sessions are cached until 5 minutes before they expire (about 55 minutes):
// broker sessions per company, customer sessions per key-store row (install, company, owner, source, version) and never shared
// across companies. A refusal is never cached.
//
// The connection test (probe), at connect and rotate time, caches nothing (and only STS's AccessDenied counts as a refusal):
//   - the real company must get a session (else "refused");
//   - two canaries must be REFUSED: the real session name with a canary external id, and a canary session name with the real
//     external id. If either gets a session the role trusts more than this company: "too_open", and nothing is saved;
//   - then each chosen model gets one check that generates nothing: an InvokeModel with max_tokens 0 (verified live: AWS answers a
//     Claude profile with HTTP 200, an empty Messages response, stop_reason "max_tokens", 0 output tokens; about 8 input tokens are
//     billed). A Messages response of any stop reason, or a ValidationException, means "ready"; AccessDeniedException with Bedrock's model-access words "not_enabled"; any other
//     AccessDenied "refused" (the role's policy does not allow that model); an unknown model "not_found"; a throttle "no_quota"
//     (a model whose quota in the account is 0 throttles even this check).
//   - AWS not answering (5xx, a failed or timed-out call, a 2xx that is not the expected answer, any other status) is asked once
//     more, and if it is still so the model is "no_answer": a fact about AWS's answer, never a state of the model.
// The whole test has one time budget (PROBE_BUDGET_MS, inside Cloud's 25 s wait): the second ask is made only when a whole
// model-check timeout is left, and no ask waits longer than what is left.
// Results are fixed words; no AWS text and no credential leaves this module. The only thing logged per check is the company id
// (org_*, never an account id), the HTTP status and Bedrock's error type (one word), the model id and the attempt (event bedrock_model_check).
import { randomBytes } from "node:crypto";
import { signRequest, type AwsCredentials, type CredentialSource } from "./aws.js";
import { BEDROCK_BYO_ROLE_ARN, bedrockConnectionIds, type BedrockConnection, type BedrockModelCheck } from "./bedrock-byo.js";
import { bedrockFamily, bedrockProductPath, createBedrockProductTransport } from "./product-bedrock.js";
import { COMPANY } from "./model-gateway-token.js";
import type { ProductKeyRow } from "./product-seal.js";
import type { TokenHttp } from "./product-vertex-token.js";
import type { ProviderResponse, ProviderTransport } from "./provider.js";

export const BEDROCK_SESSION_MARGIN_MS = 5 * 60_000;
const SESSION_SECONDS = 3600;
const STS_ANSWER_MAX_BYTES = 64 * 1024;
const MAX_CACHED = 5_000;
const MODEL_CHECK_TIMEOUT_MS = 5_000;
/** All of one probe, so the retry can't take it past Cloud's wait of 25 s (service-call.ts SERVICE_CALL_TIMEOUT_MS). */
export const PROBE_BUDGET_MS = 22_000;
const MODEL_CHECK_BODY_BYTES = 8 * 1024;
const BROKER_ROLE = /^arn:aws:iam::[0-9]{12}:role\/RovaraBedrockBroker-[a-z0-9-]{1,32}$/u;
const AWS_REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
/** Bedrock's words for "this account has no access to the model yet" (a Marketplace agreement or model access). Read only to classify. */
export const BEDROCK_MODEL_ACCESS_WORDS = /aws-marketplace|Model access is denied|don't have access to the model|do not have access to the model|is not available for this account|model access/iu;
/** The error types the transport puts first on a failed answer (createBedrockProductTransport) that mean "no room": a throttle, or a quota used up. */
const QUOTA_ERROR_TYPES = /^(?:ThrottlingException|ServiceQuotaExceededException)\b/u;
/** Bedrock's words for a model id or profile it does not serve here. */
const UNKNOWN_MODEL_WORDS = /model identifier is invalid|on-demand throughput|inference profile|could not be found|not found/iu;

export type AssumeResult = { ok: true; credentials: AwsCredentials } | { ok: false; reason: "refused" | "unavailable" };
/** One log line per model check (see BedrockSessionsOptions.log). Values are numbers, booleans and short fixed words, never AWS text. */
export type BedrockCheckLog = (line: { event: string } & Record<string, string | number | boolean>) => void;
export interface BedrockProbe { result: "ok" | "too_open" | "refused" | "unavailable"; models?: Record<string, BedrockModelCheck> }
/** What the agent route needs (BedrockSessions implements it). */
export interface BedrockSessionSource {
  credentials(row: ProductKeyRow, connection: BedrockConnection, signal?: AbortSignal): Promise<AssumeResult>;
  forget(row: ProductKeyRow): void;
}
export interface BedrockSessionsOptions {
  http: TokenHttp;
  /** The gateway task role's own credentials: used only to assume the broker. */
  aws: CredentialSource;
  /** Rovara's broker role (fixed name, retained). Only the serving role may assume it, with an `org_*` session name. */
  brokerRoleArn: string;
  /** The gateway's own Region (its regional STS endpoint). */
  awsRegion: string;
  /** This gateway's one Code install: the external id is derived for it and the company. */
  issuer: string;
  externalIds: { of(iss: string, cid: string): Promise<string> };
  now?: () => number;
  /** The canary company (tests); default: a random, well-formed company id other than the real one. */
  canaryCompany?: () => string;
  /** The Bedrock transport for the model check (tests); default: bedrock-transport.ts on the customer's session. */
  bedrock?: (region: string, credentials: CredentialSource) => ProviderTransport;
  /** Where the model checks' status lines go (default: one JSON line on stdout, as the gateway's own log). */
  log?: BedrockCheckLog | undefined;
}
/** Bedrock's error type, the one word the transport puts first on a failed answer; anything else (AWS's own words) is not logged. */
const LOGGABLE_ERROR_TYPE = /^[A-Za-z][A-Za-z0-9]{0,63}$/u;
const stdoutLog = (now: () => number): BedrockCheckLog => (line) => {
  try { process.stdout.write(`${JSON.stringify({ ...line, time: new Date(now()).toISOString() })}\n`); } catch { /* Logging never stops a check. */ }
};
/** Whether a 2xx body is the answer its family gives to the check: a Claude Messages response (type "message", any stop reason: only Haiku 4.5's "max_tokens" was seen live), Converse's stop reason, an embedding. */
function expectedAnswer(family: "claude" | "embedding" | "converse", text: string): boolean {
  let value: unknown;
  try { value = JSON.parse(text) as unknown; } catch { return false; }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const answer = value as Record<string, unknown>;
  if (family === "claude") return answer.type === "message" && Array.isArray(answer.content);
  if (family === "embedding") return Array.isArray(answer.embedding);
  return typeof answer.stopReason === "string";
}
/** What one ask of Bedrock found. `again`: AWS did not answer in a way worth keeping (5xx, a failed call), so one more ask is made. */
interface CheckAnswer { state: BedrockModelCheck; again: boolean; status: number; errorType: string; error?: string }
const UNAVAILABLE: AssumeResult = { ok: false, reason: "unavailable" };
const REFUSED: AssumeResult = { ok: false, reason: "refused" };
const form = (fields: Record<string, string>): Buffer => Buffer.from(new URLSearchParams(fields).toString());
function xmlOnce(text: string, tag: string): string | undefined {
  const all = [...text.matchAll(new RegExp(`<${tag}>([^<]{1,8192})</${tag}>`, "gu"))];
  return all.length === 1 ? all[0]![1] : undefined;
}
function evict<K, V>(map: Map<K, V>): void { while (map.size >= MAX_CACHED) { const first = map.keys().next(); if (first.done === true) return; map.delete(first.value); } }
const rowKey = (row: ProductKeyRow) => JSON.stringify([row.iss, row.cid, row.owner, row.sourceId, row.versionId]);

export class BedrockSessions implements BedrockSessionSource {
  readonly #options: BedrockSessionsOptions;
  readonly #now: () => number;
  readonly #stsHost: string;
  readonly #log: BedrockCheckLog;
  readonly #brokers = new Map<string, AwsCredentials>();
  readonly #customers = new Map<string, { roleArn: string; credentials: AwsCredentials }>();
  readonly #pending = new Map<string, Promise<AssumeResult>>();
  constructor(options: BedrockSessionsOptions) {
    if (!BROKER_ROLE.test(options.brokerRoleArn) || !AWS_REGION.test(options.awsRegion) || typeof options.issuer !== "string" || options.issuer.length === 0) throw new Error("invalid bedrock session options");
    this.#options = options; this.#now = options.now ?? Date.now; this.#log = options.log ?? stdoutLog(this.#now); this.#stsHost = `sts.${options.awsRegion}.amazonaws.com`;
  }

  /** The customer role's session for this key-store row, assumed as the row's company. Cached per row; refusals never are. */
  async credentials(row: ProductKeyRow, connection: BedrockConnection, signal?: AbortSignal): Promise<AssumeResult> {
    if (!COMPANY.test(row.cid) || row.iss !== this.#options.issuer || !BEDROCK_BYO_ROLE_ARN.test(connection.roleArn)) return UNAVAILABLE;
    const key = rowKey(row);
    const cached = this.#customers.get(key);
    if (cached !== undefined && cached.roleArn === connection.roleArn && this.#fresh(cached.credentials)) return { ok: true, credentials: cached.credentials };
    const running = this.#pending.get(key);
    if (running !== undefined) return running;
    const assuming = (async (): Promise<AssumeResult> => {
      try {
        // Shared by every concurrent caller of this row, so no one caller's abort stops it (each STS call has its own bound).
        const result = await this.#customer(row.cid, connection.roleArn, undefined);
        if (result.ok && this.#fresh(result.credentials)) { evict(this.#customers); this.#customers.set(key, { roleArn: connection.roleArn, credentials: result.credentials }); }
        return result;
      } catch { return UNAVAILABLE; } finally { this.#pending.delete(key); }
    })();
    this.#pending.set(key, assuming);
    void signal;
    return assuming;
  }
  forget(row: ProductKeyRow): void { this.#customers.delete(rowKey(row)); }

  /** The connection test for this company, before a connection is saved. Nothing is cached. */
  async probe(cid: string, connection: BedrockConnection, signal?: AbortSignal): Promise<BedrockProbe> {
    if (!COMPANY.test(cid) || !BEDROCK_BYO_ROLE_ARN.test(connection.roleArn)) return { result: "unavailable" };
    const started = this.#now();
    try {
      // One broker session, the real company's, for every assume of the test (the broker trusts any org_* name; the CUSTOMER's
      // role is what must refuse the canaries).
      const broker = await this.#broker(cid, signal, false);
      if (broker === undefined) return { result: "unavailable" };
      const externalId = await this.#options.externalIds.of(this.#options.issuer, cid);
      const real = await this.#assume(broker, connection.roleArn, cid, externalId, signal);
      if (!real.ok) return { result: real.reason };
      let canary = this.#options.canaryCompany?.() ?? `org_${[...randomBytes(20)].map((b) => "0123456789abcdefghijklmnopqrstuvwxyz"[b % 36]).join("")}`;
      if (canary === cid || !COMPANY.test(canary)) canary = `org_${"0".repeat(19)}${cid.endsWith("0") ? "1" : "0"}`;
      const canaryExternalId = await this.#options.externalIds.of(this.#options.issuer, canary);
      for (const [sessionName, id] of [[cid, canaryExternalId], [canary, externalId]] as const) {
        const other = await this.#assume(broker, connection.roleArn, sessionName, id, signal);
        if (other.ok) return { result: "too_open" };
        // Only STS's AccessDenied counts as refused: a throttle or any other error proves nothing, so the test fails closed.
        if (other.reason !== "refused") return { result: "unavailable" };
      }
      // The models in parallel, each bounded, and all of them inside one budget so the whole test stays inside Cloud's wait.
      const ids = bedrockConnectionIds(connection);
      const deadline = started + PROBE_BUDGET_MS;
      const states = await Promise.all(ids.map((id) => this.#modelCheck({ cid, region: connection.region, credentials: real.credentials, id, deadline }, signal)));
      return { result: "ok", models: Object.fromEntries(ids.map((id, i) => [id, states[i]!])) };
    } catch { return { result: "unavailable" }; }
  }

  #fresh(credentials: AwsCredentials): boolean { return (credentials.expiresAt ?? 0) - BEDROCK_SESSION_MARGIN_MS > this.#now(); }

  /** Broker, then customer role, as `cid`. */
  async #customer(cid: string, roleArn: string, signal: AbortSignal | undefined): Promise<AssumeResult> {
    const broker = await this.#broker(cid, signal, true);
    if (broker === undefined) return UNAVAILABLE;
    let externalId: string;
    try { externalId = await this.#options.externalIds.of(this.#options.issuer, cid); } catch { return UNAVAILABLE; }
    return this.#assume(broker, roleArn, cid, externalId, signal);
  }
  /** The broker session for this company (cached per company unless `cache` is false). Undefined when it can't be had. */
  async #broker(cid: string, signal: AbortSignal | undefined, cache: boolean): Promise<AwsCredentials | undefined> {
    const known = cache ? this.#brokers.get(cid) : undefined;
    if (known !== undefined && this.#fresh(known)) return known;
    let base: AwsCredentials;
    try { base = await this.#options.aws(); } catch { return undefined; }
    const got = await this.#assume(base, this.#options.brokerRoleArn, cid, undefined, signal);
    if (!got.ok) return undefined;
    if (cache && this.#fresh(got.credentials)) { evict(this.#brokers); this.#brokers.set(cid, got.credentials); }
    return got.credentials;
  }
  async #assume(with_: AwsCredentials, roleArn: string, sessionName: string, externalId: string | undefined, signal?: AbortSignal): Promise<AssumeResult> {
    if (!COMPANY.test(sessionName)) return UNAVAILABLE;
    const body = form({ Action: "AssumeRole", Version: "2011-06-15", RoleArn: roleArn, RoleSessionName: sessionName, DurationSeconds: String(SESSION_SECONDS), ...(externalId === undefined ? {} : { ExternalId: externalId }) });
    const headers = signRequest({ method: "POST", host: this.#stsHost, region: this.#options.awsRegion, service: "sts", headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" }, body, credentials: with_, now: new Date(this.#now()) });
    let answer: { status: number; body: Buffer };
    try { answer = await this.#options.http({ host: this.#stsHost, path: "/", method: "POST", headers, body, ...(signal === undefined ? {} : { signal }) }); } catch { return UNAVAILABLE; }
    if (answer.body.byteLength > STS_ANSWER_MAX_BYTES) return UNAVAILABLE;
    const text = answer.body.toString("utf8");
    // Refused ONLY when STS says AccessDenied (403: the trust policy refused). A throttle, an expired token or any other error
    // (STS answers most of them as 400) is unavailable: never shown as a refusal, never read as a canary refused.
    if (answer.status !== 200) return answer.status === 403 && xmlOnce(text, "Code") === "AccessDenied" ? REFUSED : UNAVAILABLE;
    const accessKeyId = xmlOnce(text, "AccessKeyId"); const secretAccessKey = xmlOnce(text, "SecretAccessKey"); const sessionToken = xmlOnce(text, "SessionToken"); const expiration = xmlOnce(text, "Expiration");
    const expiresAt = expiration === undefined ? NaN : Date.parse(expiration);
    if (accessKeyId === undefined || secretAccessKey === undefined || sessionToken === undefined || !Number.isFinite(expiresAt) || !/^[A-Z0-9]{16,128}$/u.test(accessKeyId)) return UNAVAILABLE;
    return { ok: true, credentials: { accessKeyId, secretAccessKey, sessionToken, expiresAt } };
  }
  /** One InvokeModel with max_tokens 0 (nothing generated). Asked once more when AWS did not answer and the probe's budget allows. */
  async #modelCheck(target: { cid: string; region: string; credentials: AwsCredentials; id: string; deadline: number }, signal?: AbortSignal): Promise<BedrockModelCheck> {
    // Each family's own check, one that generates nothing: Claude's Anthropic body with max_tokens 0, a Titan embedding with no
    // text, any other model's Converse with maxTokens 0.
    const { id } = target;
    const family = bedrockFamily(id);
    if (family === undefined) return "not_found";
    let path: string;
    try { path = bedrockProductPath(id, family === "converse" ? "converse" : "invoke"); } catch { return "not_found"; }
    const transport = (this.#options.bedrock ?? ((r, c) => createBedrockProductTransport({ region: r, credentials: c, now: this.#now })))(target.region, async () => target.credentials);
    const body = Buffer.from(JSON.stringify(family === "claude" ? { anthropic_version: "bedrock-2023-05-31", max_tokens: 0, messages: [{ role: "user", content: "." }] }
      : family === "embedding" ? { inputText: "" } : { messages: [{ role: "user", content: [{ text: "." }] }], inferenceConfig: { maxTokens: 0 } }));
    const ask = (): Promise<CheckAnswer> => this.#ask(transport, family, path, body, Math.max(1, Math.min(MODEL_CHECK_TIMEOUT_MS, target.deadline - this.#now())), signal);
    let seen = await ask();
    // One more ask on a 5xx or a failed or timed-out call (the check changes nothing), unless the caller itself gave up or a whole
    // ask no longer fits in the probe's budget.
    const again = seen.again && signal?.aborted !== true && target.deadline - this.#now() >= MODEL_CHECK_TIMEOUT_MS;
    if (again) { this.#logCheck(target, 1, seen, "retry"); seen = await ask(); }
    this.#logCheck(target, again ? 2 : 1, seen, seen.state);
    return seen.state;
  }
  #logCheck(target: { cid: string; id: string }, attempt: number, seen: CheckAnswer, state: string): void {
    // A logger that throws never changes a check's answer.
    try { this.#log({ event: "bedrock_model_check", company: target.cid, model: target.id, attempt, status: seen.status, errorType: seen.errorType, ...(seen.error === undefined ? {} : { error: seen.error }), state }); } catch { /* Logging never stops a check. */ }
  }
  async #ask(transport: ProviderTransport, family: "claude" | "embedding" | "converse", path: string, body: Buffer, timeoutMs: number, signal?: AbortSignal): Promise<CheckAnswer> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const bound = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    try {
      const answer = await transport({ body, headers: { "content-type": "application/json" }, key: "rovara-bedrock-check", signal: bound, path });
      const words = await readWords(answer);
      const first = words.split("\n", 1)[0] ?? "";
      return { ...classifyAnswer(family, answer.status, words), status: answer.status, errorType: answer.status >= 300 && LOGGABLE_ERROR_TYPE.test(first) ? first : "none" };
    } catch (error) {
      return { state: "no_answer", again: true, status: 0, errorType: "none", error: error instanceof Error && /^[A-Za-z]{1,40}$/u.test(error.name) ? error.name : "Error" };
    }
  }
}
/** The first bytes of an answer's body (bounded), then the answer is dropped. */
async function readWords(answer: ProviderResponse): Promise<string> {
  const read: Buffer[] = []; let size = 0;
  try { for await (const part of answer.body) { read.push(Buffer.from(part)); size += part.byteLength; if (size >= MODEL_CHECK_BODY_BYTES) break; } } catch { /* Classified from the status alone. */ }
  answer.cancel?.();
  return Buffer.concat(read).subarray(0, MODEL_CHECK_BODY_BYTES).toString("utf8");
}
/** What an answer says about the model; `again` when AWS itself failed (5xx), so one more ask is made. */
function classifyAnswer(family: "claude" | "embedding" | "converse", status: number, words: string): { state: BedrockModelCheck; again: boolean } {
  const done = (state: BedrockModelCheck, again = false) => ({ state, again });
  // A real answer to the check: only the answer this family gives to it is a working model; any other 2xx proves nothing.
  if (status >= 200 && status < 300) return done(expectedAnswer(family, words) ? "ready" : "no_answer");
  // A throttle (or Bedrock's quota error, which the transport names first) on the check: the model has no room in this account right now. Checked before 400's "ready".
  if (status === 429 || QUOTA_ERROR_TYPES.test(words)) return done("no_quota");
  if (status === 400) return done(UNKNOWN_MODEL_WORDS.test(words) ? "not_found" : "ready");
  if (status === 404) return done("not_found");
  if (status === 403) return done(BEDROCK_MODEL_ACCESS_WORDS.test(words) ? "not_enabled" : "refused");
  // AWS failed (5xx): asked once more. Any other status is not an answer about the model either.
  return done("no_answer", status >= 500);
}
