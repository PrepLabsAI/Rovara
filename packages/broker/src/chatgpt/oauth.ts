// Sign in with ChatGPT (#337, #338): OpenAI's side of a connection, as the spike of 2026-10-11
// found it works. The dynamic client ("dynamic_agent_client") lets OpenAI issue a client ID per
// connection, returned with the callback and needed for every refresh; the consent screen names us
// through agent_name_hint. Only the local callback is accepted, so the code always reaches us second
// hand (a pasted address, or the CLI's own listener), and is exchanged here with the PKCE verifier
// only the control plane holds.
import { createHash, randomBytes } from "node:crypto";
import { CHATGPT_AGENT_NAME, CHATGPT_CALLBACK_URL, agentXError } from "@agentx/contracts";

export const CHATGPT_AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize";
export const CHATGPT_TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
export const CHATGPT_RESOURCE = "https://api.openai.com/v1";
export const CHATGPT_SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const DIRECT_SCOPE = "chatgpt.tokens.use.direct";

const base64url = (bytes: Buffer) => bytes.toString("base64url");

export interface ChatGptAuthorization { url: string; state: string; verifier: string }

/** A new connection's authorize address. `hostId` names this Rovara install to OpenAI (a stable
 * `urn:uuid:`), so a person's connected apps list shows one entry per install. */
export function chatGptAuthorization(hostId: string): ChatGptAuthorization {
  const state = base64url(randomBytes(24));
  const verifier = base64url(randomBytes(32));
  const url = new URL(CHATGPT_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: "dynamic_agent_client", agent_name_hint: CHATGPT_AGENT_NAME, ext_agent_host_id: hostId,
    response_type: "code", redirect_uri: CHATGPT_CALLBACK_URL, resource: CHATGPT_RESOURCE, scope: CHATGPT_SCOPE, state,
    code_challenge: base64url(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256", nonce: base64url(randomBytes(16)),
  }).toString();
  return { url: url.toString(), state, verifier };
}

/** A stable `urn:uuid:` for this install, from something that names it uniquely (its connection key's ARN). */
export function chatGptHostId(installSeed: string): string {
  const hex = createHash("sha256").update(`rovara:${installSeed}`).digest("hex");
  // Shaped as a version-4 UUID, which is what OpenAI checks for.
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface ChatGptCallback { code: string; state: string; clientId: string }

/** The address the browser ended on after OpenAI's consent: the code, the state and the client ID
 * OpenAI issued. Anything else is refused without echoing what was pasted. */
export function parseChatGptCallback(pasted: string): ChatGptCallback {
  let url: URL;
  try {
    url = new URL(pasted.trim());
  } catch {
    throw agentXError("CONFIG_INVALID", "that is not the address the browser ended on; copy the whole address that starts with http://127.0.0.1:1455/");
  }
  const expected = new URL(CHATGPT_CALLBACK_URL);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname) {
    throw agentXError("CONFIG_INVALID", "that is not the address the browser ended on; copy the whole address that starts with http://127.0.0.1:1455/auth/callback");
  }
  const error = url.searchParams.get("error");
  if (error !== null) throw agentXError("CONFIG_INVALID", /^[a-z_]{1,40}$/.test(error) ? `ChatGPT did not connect (${error})` : "ChatGPT did not connect");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const clientId = url.searchParams.get("client_id");
  if (!code || !state || !clientId) throw agentXError("CONFIG_INVALID", "that address has no sign-in code; copy it again after pressing Allow on OpenAI's page");
  return { code, state, clientId };
}

export interface ChatGptTokens { access: string; refresh: string; expiresAt: number; email?: string }

async function tokenRequest(fetchImplementation: typeof fetch, fields: Record<string, string>, what: string): Promise<Record<string, unknown>> {
  const response = await fetchImplementation(CHATGPT_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(fields).toString(),
  });
  let body: unknown;
  try { body = await response.json(); } catch { body = undefined; }
  const fieldsOf = (body !== null && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (!response.ok) {
    // OpenAI's error word only: a description can carry request details.
    const reason = typeof fieldsOf.error === "string" && /^[a-z_]{1,60}$/.test(fieldsOf.error) ? fieldsOf.error : `HTTP ${response.status}`;
    throw agentXError(response.status === 400 || response.status === 401 ? "AUTH_REQUIRED" : "RUNTIME_UNAVAILABLE", `ChatGPT ${what} failed (${reason})`);
  }
  return fieldsOf;
}

function tokensFrom(body: Record<string, unknown>, now: number, what: string): ChatGptTokens {
  const { access_token: access, refresh_token: refresh, expires_in: expiresIn, scope } = body;
  if (typeof access !== "string" || typeof refresh !== "string" || typeof expiresIn !== "number" || expiresIn <= 0) {
    throw agentXError("RUNTIME_UNAVAILABLE", `ChatGPT ${what} answered without tokens`);
  }
  if (typeof scope === "string" && !scope.split(/\s+/).includes(DIRECT_SCOPE)) {
    throw agentXError("FORBIDDEN", "ChatGPT did not grant Rovara the use of your plan; connect again and allow it");
  }
  const idToken = typeof body.id_token === "string" ? body.id_token : undefined;
  let email: string | undefined;
  if (idToken !== undefined) {
    try {
      const claims = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8")) as { email?: unknown };
      if (typeof claims.email === "string") email = claims.email;
    } catch { /* the email is a nicety */ }
  }
  return { access, refresh, expiresAt: now + expiresIn * 1000, ...(email === undefined ? {} : { email }) };
}

export async function exchangeChatGptCode(input: { fetch: typeof fetch; now: number; code: string; verifier: string; clientId: string }): Promise<ChatGptTokens> {
  const body = await tokenRequest(input.fetch, {
    grant_type: "authorization_code", client_id: input.clientId, code: input.code, code_verifier: input.verifier,
    redirect_uri: CHATGPT_CALLBACK_URL, resource: CHATGPT_RESOURCE,
  }, "sign-in");
  return tokensFrom(body, input.now, "sign-in");
}

/** OpenAI rotates the refresh token: the caller must keep the new one. */
export async function refreshChatGptTokens(input: { fetch: typeof fetch; now: number; clientId: string; refresh: string }): Promise<ChatGptTokens> {
  const body = await tokenRequest(input.fetch, {
    grant_type: "refresh_token", client_id: input.clientId, refresh_token: input.refresh, resource: CHATGPT_RESOURCE,
  }, "token refresh");
  return tokensFrom(body, input.now, "token refresh");
}

/** The models this person's plan may use. OpenAI answers a Codex-style catalog ({ models: [{ slug }] });
 * an OpenAI-style one ({ data: [{ id }] }) is read too. A refusal means the plan is not eligible. */
export async function chatGptModels(input: { fetch: typeof fetch; access: string }): Promise<string[]> {
  const response = await input.fetch(`${CHATGPT_RESOURCE}/models`, { headers: { authorization: `Bearer ${input.access}` } });
  if (response.status === 401 || response.status === 403) {
    throw agentXError("FORBIDDEN", "this ChatGPT account cannot be used by Rovara; Sign in with ChatGPT needs a ChatGPT Plus or Pro plan");
  }
  if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `ChatGPT's model list failed (HTTP ${response.status})`);
  const body = await response.json() as { models?: Array<{ slug?: unknown }>; data?: Array<{ id?: unknown }> };
  const ids = [...(body.models ?? []).map((model) => model.slug), ...(body.data ?? []).map((model) => model.id)];
  const models = [...new Set(ids.filter((id): id is string => typeof id === "string" && /^[A-Za-z0-9._:-]{1,80}$/.test(id)))];
  if (models.length === 0) throw agentXError("FORBIDDEN", "this ChatGPT plan offers Rovara no models; Sign in with ChatGPT needs a ChatGPT Plus or Pro plan");
  return models;
}
