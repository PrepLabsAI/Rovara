// Lead 4 L4-AG (DEC 254z-amend2, option A): hosted answers speak to the model gateway's "answers" purpose (Cloud L4-E, docs/model-gateway-spend-limits.md "The contract for callers").
//
//   POST <gateway>/v1/answers/messages   an Anthropic Messages request (the company's OWN connected provider account; Rovara never pays), `x-api-key` the call's answers token.
//
// THE TOKEN is minted exactly as a task token is (`mintTaskToken`: the install's KMS task key, purpose `task`, the install's sign-in issuer), fresh for EVERY call, with
//   stp = "rovara-answers-call"   the answers step: the gateway accepts it on the answers paths only, and accepts nothing else there (the fixed 401 both ways)
//   cid = the reservation's company   never a call's argument: `reserve` binds the company once, and `call` can only name a reservation
//   pid = the project, pay = that project, tid = `answer:<answer id>`, mdl = [the one model], no `per` (no person pays), no `src`, a fresh ws/op (an answer has no workspace or operation)
//
// WHO HOLDS THE MONEY. The gateway holds, calls and settles each call itself (the company's `answers_month` limit combined with the company's one monthly cap), so `reserve` here is only this adapter's own
// bookkeeping (one open reservation per answer, bound to its company and project, bounded in number and age) and `settle` closes it. Usage comes from the reply (its `usage` block, and the gateway's own cost
// figure when it sends one); a reply with no cost gives none, and the service's token ceiling stands in. No key is read, held or sent from Code, ever.
//
// WHAT THE GATEWAY REFUSES. `answers_paused` (403/422) with `x-rovara-answers-pause`: `no_provider` means the company has no usable connected account ("not set up"); `monthly_limit`, `no_budget` and
// `cost_too_high` (and any reason this code does not know) mean the month has no room ("paused"). A gateway without the answers purpose yet answers 404: "not set up", so a deployment that gets this code
// before Cloud L4-E is live shows the fixed outcome and nothing else. A 401, 429, 5xx, a redirect, a bad body and any thrown error are "unavailable". Nothing the gateway or the model sent is echoed.
import { randomUUID } from "node:crypto";
import { AGENTX_NAME_PATTERN, CORE_ANSWERS_MODEL_VARIABLE, CORE_CLAUDE_AGENT_MODEL, CORE_MODEL_GATEWAY_URL_VARIABLE, OrgIdSchema, isCoreAnswersModelId, type OrgId } from "@agentx/contracts";
import type { TokenSigner } from "../developer/tokens.js";
import { mintTaskToken, type TaskTokenDescriber } from "../core/model-gateway/token.js";
import { AnswersGatewayError, createGatewayAnswerModel, type AnswersGateway, type AnswersGatewayRefusal } from "../core/answers/gateway-model.js";
import type { AnswerModel } from "../core/answers/ports.js";
import { readGatewayModelAccess, readGatewayUrl } from "./gateway-model-access.js";

/** The step an answers token names (TC-1 `stp`; the gateway's `ANSWERS_STEP`). */
export const ANSWERS_STEP = "rovara-answers-call";
/** The one path this adapter ever calls. */
export const ANSWERS_MESSAGES_PATH = "/v1/answers/messages";
export const ANSWERS_PAUSE_HEADER = "x-rovara-answers-pause";
/** The gateway's own figure for what a call cost, in US dollars, when it gives one. */
export const ANSWERS_COST_HEADER = "x-rovara-cost-usd";
export const ANSWERS_CALL_FAILED = "The answers call did not complete.";
/** The most of a reply read (bytes): an answer turn is a short document. */
const REPLY_MAX_BYTES = 1_000_000;
const DEFAULT_TIMEOUT_MS = 120_000;
/** Open reservations at most, and for at most this long (an answer's own wall clock is far shorter): a reservation nobody settled is forgotten, never kept. */
const MAX_OPEN_RESERVATIONS = 256;
/** One company may hold at most this many of them, so one busy company cannot fill the pool for the others. */
const MAX_OPEN_PER_COMPANY = 32;
const RESERVATION_MAX_AGE_MS = 10 * 60_000;
const OUTPUT_TOKENS_MAX = 8_192;
const CEILING_CENTS_MAX = 10_000;
/** A gateway cost figure above this many dollars for one call is no figure at all. */
const COST_USD_MAX = 1_000;
const ANSWER_KEY = /^answer:a[0-9a-f]{31}$/u;
const PAUSE_STATUSES: readonly number[] = [403, 422];

/**
 * One answers token, minted exactly as the adapter below mints its own (`tokenFor`): the install's task key, purpose `task`, the answers step, this company and project, `answer:<id>` as its task, the one
 * model, no person, a fresh workspace and operation. Used by the answers adapter for every call, and by the Slack chat's model access (DEC 254zzz79 (3): the same route, so the company's answers month and the
 * combined company cap count the call). The company is the caller's to bind and is checked here.
 */
export async function mintAnswersCallToken(input: { signer: TokenSigner; issuer: string; companyId: OrgId; project: string; model: string; answerKey?: string; now?: () => number }): Promise<string> {
  if (!OrgIdSchema.safeParse(input.companyId).success || !AGENTX_NAME_PATTERN.test(input.project) || !CORE_CLAUDE_AGENT_MODEL.test(input.model)) throw new Error("not a valid answers token request");
  const key = input.answerKey ?? `answer:a${randomUUID().replace(/-/gu, "").slice(0, 31)}`;
  if (!ANSWER_KEY.test(key)) throw new Error("not a valid answers token request");
  const describer: TaskTokenDescriber = {
    describe: async () => ({ companyId: input.companyId, project: input.project, payer: { kind: "project", project: input.project }, taskId: key, step: ANSWERS_STEP, models: [input.model] }),
  };
  return (await mintTaskToken({ signer: input.signer, issuer: input.issuer, describer, ...(input.now === undefined ? {} : { now: input.now }) }, { workspaceId: randomUUID(), operationId: randomUUID(), fence: 0 })).token;
}

export interface HttpAnswersGatewayOptions {
  /** The gateway's https origin (checked: no path, credentials, query or fragment). */
  gatewayUrl: string;
  /** The install's sign-in issuer, whose JWKS publishes the task key. */
  issuer: string;
  /** The TASK key's signer (`taskKeySigner`: its public key carries purpose `task`). */
  signer: TokenSigner;
  /** The one Claude model every answers token names. */
  model: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

interface Open { companyId: OrgId; project: string; key: string; expiresAt: number }

const refused = (reason: AnswersGatewayRefusal): AnswersGatewayError => new AnswersGatewayError(reason);

async function boundedText(response: Response): Promise<string> {
  if (response.body === null) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > REPLY_MAX_BYTES) throw new Error(ANSWERS_CALL_FAILED);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const parse = (text: string): unknown => { try { return JSON.parse(text) as unknown; } catch { return undefined; } };
const whole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** The gateway as `AnswersGateway` for the hosted answers: every call is one POST to the answers path with a fresh answers token for the reservation's company. */
export function createHttpAnswersGateway(options: HttpAnswersGatewayOptions): AnswersGateway {
  const origin = readGatewayUrl({ [CORE_MODEL_GATEWAY_URL_VARIABLE]: options.gatewayUrl });
  if (typeof origin !== "string") throw new Error("the answers gateway address is not an https origin");
  if (!CORE_CLAUDE_AGENT_MODEL.test(options.model)) throw new Error("the answers model is not a Claude model id");
  const url = `${origin}${ANSWERS_MESSAGES_PATH}`;
  const send = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const open = new Map<string, Open>();

  const forget = (): void => {
    const at = now();
    for (const [id, reservation] of open) if (reservation.expiresAt <= at) open.delete(id);
  };

  /** The token of one call: a task token of the answers step, for exactly this reservation's company, project and answer. */
  async function tokenFor(reservation: Open): Promise<string> {
    return await mintAnswersCallToken({ signer: options.signer, issuer: options.issuer, companyId: reservation.companyId, project: reservation.project, model: options.model, answerKey: reservation.key, now });
  }

  return {
    async available({ companyId }) {
      // Whether the company has a connected key is the gateway's to say, on the first call (a missing key is then the fixed "not set up" outcome); here only a well-formed company can ask.
      return OrgIdSchema.safeParse(companyId).success;
    },

    async reserve(input) {
      const company = OrgIdSchema.safeParse(input.companyId);
      if (!company.success || typeof input.project !== "string" || !AGENTX_NAME_PATTERN.test(input.project) || typeof input.idempotencyKey !== "string" || !ANSWER_KEY.test(input.idempotencyKey)
        || !Number.isSafeInteger(input.ceilingCents) || input.ceilingCents < 1 || input.ceilingCents > CEILING_CENTS_MAX) throw refused("unavailable");
      forget();
      if (open.size >= MAX_OPEN_RESERVATIONS) throw refused("unavailable");
      let ofCompany = 0;
      for (const reservation of open.values()) {
        if (reservation.companyId !== company.data) continue;
        // One answer, one reservation.
        if (reservation.key === input.idempotencyKey) throw refused("unavailable");
        ofCompany += 1;
      }
      if (ofCompany >= MAX_OPEN_PER_COMPANY) throw refused("unavailable");
      const reservationId = randomUUID();
      open.set(reservationId, { companyId: company.data, project: input.project, key: input.idempotencyKey, expiresAt: now() + RESERVATION_MAX_AGE_MS });
      return { reservationId };
    },

    async call(input) {
      forget();
      const reservation = open.get(input.reservationId);
      if (reservation === undefined) throw refused("unavailable");
      // The answer's own ceiling is spent: no token is made and nothing is sent.
      if (!Number.isFinite(input.remainingCents) || input.remainingCents <= 0) throw refused("over_budget");
      if (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 1 || typeof input.system !== "string" || typeof input.transcript !== "string" || input.signal.aborted) throw refused("unavailable");
      let token: string;
      try { token = await tokenFor(reservation); } catch { throw refused("unavailable"); }
      const controller = new AbortController();
      const onAbort = (): void => controller.abort();
      input.signal.addEventListener("abort", onAbort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      // The whole call (request, reply and body) is held to one time; a fetch that ignores the abort is still given up on.
      const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error(ANSWERS_CALL_FAILED)); }, timeoutMs); });
      void deadline.catch(() => undefined);
      const exchange = async (): Promise<{ response: Response; text: string }> => {
        const response = await send(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": token, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model: options.model, max_tokens: Math.min(input.maxOutputTokens, OUTPUT_TOKENS_MAX), system: input.system, messages: [{ role: "user", content: input.transcript }] }),
          signal: controller.signal,
          // The token goes to the gateway only: a redirect is never followed (it would resend the key elsewhere), and is a failed call.
          redirect: "manual",
        });
        return { response, text: await boundedText(response) };
      };
      let got: { response: Response; text: string };
      try { got = await Promise.race([exchange(), deadline]); } catch { throw refused("unavailable"); } finally { clearTimeout(timer); input.signal.removeEventListener("abort", onAbort); }
      const { response, text } = got;
      const body = parse(text) as { error?: { type?: unknown }; content?: unknown; model?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown } } | undefined;
      if (!response.ok) {
        const type = body?.error?.type;
        if (type === "answers_paused" && PAUSE_STATUSES.includes(response.status)) throw refused(response.headers.get(ANSWERS_PAUSE_HEADER) === "no_provider" ? "not_set_up" : "paused");
        // A gateway that does not have the answers purpose yet answers "not found" for its path.
        if (response.status === 404 && type === "not_found") throw refused("not_set_up");
        throw refused("unavailable");
      }
      if (response.status !== 200) throw refused("unavailable");
      const blocks = Array.isArray(body?.content) ? body.content as Array<{ type?: unknown; text?: unknown }> : undefined;
      if (blocks === undefined || blocks.some((block) => block === null || typeof block !== "object")) throw refused("unavailable");
      const answer = blocks.filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text as string).join("");
      const tokens = whole(body?.usage?.input_tokens) && whole(body?.usage?.output_tokens) ? { input: body.usage.input_tokens, output: body.usage.output_tokens } : undefined;
      const usd = Number(response.headers.get(ANSWERS_COST_HEADER) ?? Number.NaN);
      const costCents = Number.isFinite(usd) && usd >= 0 && usd <= COST_USD_MAX ? Math.ceil(usd * 100) : undefined;
      return { text: answer, model: typeof body?.model === "string" && body.model.length <= 128 ? body.model : options.model, ...(tokens === undefined ? {} : { tokens }), ...(costCents === undefined ? {} : { costCents }) };
    },

    async settle({ reservationId }) {
      // The gateway settled every call as it ran; closing the reservation is all that is left.
      open.delete(reservationId);
    },
  };
}

/**
 * The model the hosted answers (and the hosted start-box classifier, which shares this wiring) run on (L4-AM, DEC 254zzn(2)): `ROVARA_CORE_ANSWERS_MODEL` when it is set, else the install's agent model (the
 * route's alias), exactly as before. Fail closed: a SET value that is not a well-formed Claude engine name is `undefined` (answers stay "not set up"), never a silent fall back to the agent model.
 * Only this wiring reads it: the task flow's own route (gateway-model-access.ts) is untouched, so a coding task keeps the agent model.
 */
export function hostedAnswersModelName(env: NodeJS.ProcessEnv, agentModel: string): string | undefined {
  const chosen = env[CORE_ANSWERS_MODEL_VARIABLE]?.trim() ?? "";
  if (chosen === "") return CORE_CLAUDE_AGENT_MODEL.test(agentModel) ? agentModel : undefined;
  return isCoreAnswersModelId(chosen) ? chosen : undefined;
}

/**
 * The deployment's hosted answers model for each company, or undefined (the fixed "answers are not set up here yet" outcome): the model gateway is configured and checked
 * (ROVARA_CORE_MODEL_GATEWAY_URL with its agent model), the install can sign task tokens, and the model that answers (ROVARA_CORE_ANSWERS_MODEL, else the agent model; L4-AM) is a Claude model (the answers purpose runs on the company's own Anthropic account; a
 * Bedrock-only model id cannot be served there). A broken setting is not a failure here: the task flow's own wiring refuses loudly, and answers stay "not set up". One gateway serves every company
 * (a reservation carries its company; the model returned for a company can open reservations for that company only).
 */
export function hostedAnswersModel(env: NodeJS.ProcessEnv, taskTokens: (() => { signer: TokenSigner; issuer: string } | undefined) | undefined, fetchImpl?: typeof fetch): ((companyId: OrgId) => AnswerModel | undefined) | undefined {
  const settings = readGatewayModelAccess(env);
  if (settings === undefined || "problem" in settings) return undefined;
  const model = hostedAnswersModelName(env, settings.route.alias);
  if (model === undefined) return undefined;
  let tokens: { signer: TokenSigner; issuer: string } | undefined;
  try { tokens = taskTokens?.(); } catch { return undefined; }
  if (tokens === undefined || typeof tokens.issuer !== "string" || tokens.issuer === "" || typeof tokens.signer?.sign !== "function" || typeof tokens.signer.publicJwk !== "function") return undefined;
  const gateway = createHttpAnswersGateway({ gatewayUrl: settings.gatewayUrl, issuer: tokens.issuer, signer: tokens.signer, model, ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }) });
  return (companyId) => (OrgIdSchema.safeParse(companyId).success ? createGatewayAnswerModel(gateway, companyId) : undefined);
}
