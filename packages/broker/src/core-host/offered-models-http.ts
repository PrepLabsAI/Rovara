// The HTTP reader of the models the gateway offers one company's agents (Cloud's `GET /v1/service/companies/<companyId>/offered-models`, docs/model-gateway-offered-models.md; the contract is
// `OfferedAgentModels`). The broker authenticates with a SERVICE token it signs with the install's task key (the key the agent route's task tokens use):
//
//   header  exactly { alg: "RS256", typ: "rovara-service+jwt", kid: <the task key's id> }
//   claims  exactly iss (the install's issuer), aud "rovara-model-gateway-offered-models", jti (a UUID), iat, nbf = iat - 30, exp = iat + 60, cid (the company)
//
// The company in the path is the company in the token, and it is always a checked company id (a path can never name another). A token is made fresh for every call, sent as a bearer token on a GET with
// no body, no query and no other credential. Anything but a 200 whose body is the contract, in time and within the size limit, is a failed read: nothing is offered (the caller fails closed), and the
// failure says fixed words only (never the gateway's answer, a URL, a token or a cause).
import { randomUUID } from "node:crypto";
import type { ReadableStreamDefaultReader } from "node:stream/web";
import { CORE_AGENT_MODEL_CHOICE_VARIABLE, OfferedAgentModelsSchema, OrgIdSchema, TASK_KEY_PURPOSE, type OfferedAgentModels, TASK_TOKEN_ALGORITHM, TASK_TOKEN_SIGNING_INPUT_MAX_BYTES } from "@agentx/contracts";
import type { TokenSigner } from "../developer/tokens.js";
import { readGatewayModelAccess, readGatewayUrl } from "./gateway-model-access.js";
import type { OfferedModelsReader } from "./gateway-model-selection.js";

export const OFFERED_MODELS_AUDIENCE = "rovara-model-gateway-offered-models";
export const SERVICE_TOKEN_TYP = "rovara-service+jwt";
export const SERVICE_TOKEN_LIFETIME_SECONDS = 60;
export const SERVICE_TOKEN_NOT_BEFORE_SKEW_SECONDS = 30;
/** The most of an answer that is read. The contract's largest list is a few KiB. */
export const OFFERED_MODELS_BODY_MAX_BYTES = 65_536;
/** The longest a read may take. */
export const OFFERED_MODELS_HTTP_TIMEOUT_MS = 4_000;
/** Cloud rejects a longer issuer in a service token. */
export const SERVICE_TOKEN_ISSUER_MAX_CHARS = 2_048;
/**
 * The switch that offers companies a model choice (default off; the stack parameter CoreAgentModelChoice, packed `mx`, contracts core-engine-infra.ts). Only the broker reads the offered list and signs;
 * the dispatcher reads the broker's short-lived validation on the company's existing policy row (ANSWER-3). It gets no signing rights.
 */
export { CORE_AGENT_MODEL_CHOICE_VARIABLE };
/** What the admin read says where the gateway is not set up (no gateway origin, or no company for the caller). */
export const CORE_OFFERED_MODELS_NOT_SET_UP = "the core engine's model gateway is not set up in this deployment";
/** The only thing a failed read says. */
export const OFFERED_MODELS_READ_FAILED = "the gateway's offered models could not be read";

const failed = (): Error => new Error(OFFERED_MODELS_READ_FAILED);
const base64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");

export interface OfferedModelsHttpInputs {
  /** The gateway's https origin (ROVARA_CORE_MODEL_GATEWAY_URL, already checked). */
  gatewayUrl: string;
  /** The install's sign-in issuer (DEVELOPER_TOKEN_ISSUER), whose JWKS publishes the task key. */
  issuer: string;
  /** The task key's signer (`taskKeySigner`: its public key carries purpose `task`). */
  signer: TokenSigner;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

/** A service token for one company and one gateway audience, signed with the task key. Throws (fixed words) for anything that is not exactly what the gateway accepts. Also signs the eval authority ask (DEC 253k). */
export async function signServiceToken(input: Pick<OfferedModelsHttpInputs, "issuer" | "signer" | "now">, companyId: string, audience: string = OFFERED_MODELS_AUDIENCE): Promise<string> {
  if (typeof input.issuer !== "string" || input.issuer.length > SERVICE_TOKEN_ISSUER_MAX_CHARS || Buffer.byteLength(input.issuer) > TASK_TOKEN_SIGNING_INPUT_MAX_BYTES) throw failed();
  // The purpose is stamped by `taskKeySigner` (the signer is the task key's, wrapped); Cloud's pinned key ids are what decide which key is the task key.
  const key = await input.signer.publicJwk();
  if (key.rovara_purpose !== TASK_KEY_PURPOSE || key.kty !== "RSA" || key.alg !== TASK_TOKEN_ALGORITHM || key.use !== "sig" || typeof key.kid !== "string" || !/^[A-Za-z0-9_-]{16}$/u.test(key.kid)) throw failed();
  const iat = Math.floor((input.now?.() ?? Date.now()) / 1000);
  const header = { alg: TASK_TOKEN_ALGORITHM, typ: SERVICE_TOKEN_TYP, kid: key.kid };
  const claims = { iss: input.issuer, aud: audience, jti: randomUUID(), iat, nbf: iat - SERVICE_TOKEN_NOT_BEFORE_SKEW_SECONDS, exp: iat + SERVICE_TOKEN_LIFETIME_SECONDS, cid: companyId };
  const signingInput = Buffer.from(`${base64url(header)}.${base64url(claims)}`);
  if (signingInput.byteLength > TASK_TOKEN_SIGNING_INPUT_MAX_BYTES) throw failed();
  const signature = await input.signer.sign(signingInput);
  return `${signingInput.toString()}.${signature.toString("base64url")}`;
}

/** Reads a body of at most `limit` bytes, or throws. */
export async function boundedText(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw failed();
  if (response.body === null) return "";
  const reader = response.body.getReader() as unknown as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) { await reader.cancel().catch(() => undefined); throw failed(); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function offeredModelsReader(input: OfferedModelsHttpInputs): OfferedModelsReader {
  const origin = input.gatewayUrl.replace(/\/+$/u, "");
  return {
    async offered(companyId) {
      // The company is checked before anything is signed or sent: the path and the token can only ever name a well-formed company id.
      const checked = OrgIdSchema.safeParse(companyId);
      if (!checked.success) throw failed();
      const company: string = checked.data;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      // The whole read (the signature, the request and the body) is held to one time; a fetch that ignores the abort is still given up on.
      const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(failed()); }, input.timeoutMs ?? OFFERED_MODELS_HTTP_TIMEOUT_MS); });
      const read = async (): Promise<unknown> => {
        const token = await signServiceToken(input, company);
        const response = await (input.fetch ?? fetch)(`${origin}/v1/service/companies/${company}/offered-models`, {
          method: "GET", redirect: "error", signal: controller.signal, headers: { accept: "application/json", authorization: `Bearer ${token}` },
        });
        if (response.status !== 200) { await response.body?.cancel().catch(() => undefined); throw failed(); }
        const parsed = OfferedAgentModelsSchema.safeParse(JSON.parse(await boundedText(response, OFFERED_MODELS_BODY_MAX_BYTES)));
        if (!parsed.success) throw failed();
        return parsed.data;
      };
      try { return await Promise.race([read(), deadline]); } catch { throw failed(); }
      finally { clearTimeout(timer); deadline.catch(() => undefined); }
    },
  };
}

/**
 * The reader of a deployment: only where the choice is switched on (ROVARA_CORE_AGENT_MODEL_CHOICE=on), the model gateway is configured (ROVARA_CORE_MODEL_GATEWAY_URL with its agent model, checked) and the install has a task-token signer and issuer. Otherwise
 * none, and nothing offers a choice. One reader serves every company of the deployment (the company is each call's argument).
 */
export function offeredModelsReaderFromEnvironment(env: NodeJS.ProcessEnv, taskTokens: (() => { signer: TokenSigner; issuer: string } | undefined) | undefined, fetchImpl?: typeof fetch): OfferedModelsReader | undefined {
  if (env[CORE_AGENT_MODEL_CHOICE_VARIABLE] !== "on") return undefined;
  const settings = readGatewayModelAccess(env);
  if (settings === undefined || "problem" in settings) return undefined;
  const tokens = taskTokens?.();
  if (tokens === undefined || typeof tokens.issuer !== "string" || tokens.issuer === "") return undefined;
  return offeredModelsReader({ gatewayUrl: settings.gatewayUrl, issuer: tokens.issuer, signer: tokens.signer, ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }) });
}

/**
 * DEC 254g: the admin read behind `GET /v1/admin/core/offered-models` (contracts CORE_OFFERED_MODELS_ADMIN_PATH), which `agentx config set coreEngine.agentModel` checks a model against
 * before any deploy. It needs only the gateway's origin (ROVARA_CORE_MODEL_GATEWAY_URL, checked) and the install's task-token signer and issuer, NOT the agent model or the choice switch:
 * the agent model is what is being chosen. Absent (no gateway origin, or one that is not an https origin): undefined, and the route answers "not set up". The company is the caller's
 * (the route resolves it from membership); every failure is the reader's fixed words.
 */
export function adminOfferedModelsFromEnvironment(env: NodeJS.ProcessEnv, taskTokens: () => { signer: TokenSigner; issuer: string } | undefined, fetchImpl?: typeof fetch):
  ((companyId: string) => Promise<OfferedAgentModels>) | undefined {
  const gatewayUrl = readGatewayUrl(env);
  if (typeof gatewayUrl !== "string") return undefined;
  return async (companyId) => {
    let tokens: { signer: TokenSigner; issuer: string } | undefined;
    try { tokens = taskTokens(); } catch { throw failed(); }
    if (tokens === undefined || typeof tokens.issuer !== "string" || tokens.issuer === "") throw failed();
    const answer = await offeredModelsReader({ gatewayUrl, issuer: tokens.issuer, signer: tokens.signer, ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }) }).offered(companyId);
    const parsed = OfferedAgentModelsSchema.safeParse(answer);
    if (!parsed.success) throw failed();
    return parsed.data;
  };
}
