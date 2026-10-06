// Signing in to the setup page, and handing that sign-in to the installer job.
//
// The page signs the admin in with the identity stack's own hosted sign-in and its one app client
// (the CLI's), whose callbacks include the page's while the install runs in the cloud (the identity
// stack's SetupPageUrl). So the token the page gets is one the control plane already accepts, and
// the job uses it for the steps that need an administrator (registering the first project, binding
// its channel), as `agentx init` on a computer uses the one its own browser sign-in gets.
//
// The page keeps no token in the browser: its cookie holds a random session id, and the table holds
// only that id's hash. The admin's token goes to the job sealed with the table's KMS key, and is
// deleted as the job reads it.
import { createHash, randomBytes } from "node:crypto";
import { DecryptCommand, EncryptCommand, type KMSClient } from "@aws-sdk/client-kms";
import { agentXError } from "@agentx/contracts";
import { tokenStoreKey, type LoginOptions } from "../../auth.js";
import type { StoredTokens } from "../../token-store.js";
import type { SetupStore, SetupSession } from "./setup-store.js";

/** Must match the identity stack's SETUP_CALLBACK_PATH (tests tie the two). */
export const SETUP_CALLBACK_PATH = "/auth/callback";
export const SETUP_LOGIN_PATH = "/auth/login";
export const SESSION_COOKIE = "rovara_setup";
const LOGIN_COOKIE = "rovara_login";
/** The group the identity stack makes for administrators (infra/lib/identity.ts ADMIN_GROUP). */
const ADMIN_GROUP = "agentx-admin";
const LOGIN_COOKIE_SECONDS = 10 * 60;

export interface SetupIdentity {
  /** The hosted sign-in's address, such as https://agentx-prod-123.auth.us-east-1.amazoncognito.com. */
  hostedUiDomain: string;
  clientId: string;
}

/** Seals the admin's token for the job; only the table's KMS key opens it. */
export interface TokenSeal {
  seal(plain: string): Promise<string>;
  open(sealed: string): Promise<string>;
}

export function kmsTokenSeal(input: { client: Pick<KMSClient, "send">; env: string; keyId?: string }): TokenSeal {
  // Bound to this install and this use: a sealed token from elsewhere does not open here.
  const context = { purpose: "agentx-setup-admin-token", env: input.env };
  return {
    async seal(plain) {
      if (input.keyId === undefined) throw new Error("sealing needs the table's KMS key id");
      const sealed = await input.client.send(new EncryptCommand({ KeyId: input.keyId, Plaintext: Buffer.from(plain, "utf8"), EncryptionContext: context }));
      return Buffer.from(sealed.CiphertextBlob ?? new Uint8Array()).toString("base64");
    },
    async open(sealed) {
      const opened = await input.client.send(new DecryptCommand({ CiphertextBlob: Buffer.from(sealed, "base64"), EncryptionContext: context }));
      return Buffer.from(opened.Plaintext ?? new Uint8Array()).toString("utf8");
    },
  };
}

const base64url = (bytes: Buffer) => bytes.toString("base64url");
export const hashSessionId = (id: string) => createHash("sha256").update(id).digest("hex");

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0) cookies[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return cookies;
}

const cookie = (name: string, value: string, path: string, maxAgeSeconds: number) =>
  `${name}=${value}; Path=${path}; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;

/** The signed-in admin behind this request's cookie, or undefined. */
export async function signedInSession(store: SetupStore, cookieHeader: string | undefined): Promise<SetupSession | undefined> {
  const id = parseCookies(cookieHeader)[SESSION_COOKIE];
  return id === undefined || id === "" ? undefined : store.getSession(hashSessionId(id));
}

/** GET /auth/login: off to the hosted sign-in, with PKCE, its state and verifier in a short cookie. */
export function startSignIn(input: { identity: SetupIdentity; origin: string }): { location: string; setCookie: string } {
  const state = base64url(randomBytes(24));
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const authorize = new URL("/oauth2/authorize", input.identity.hostedUiDomain);
  authorize.search = new URLSearchParams({
    response_type: "code", client_id: input.identity.clientId, redirect_uri: `${input.origin}${SETUP_CALLBACK_PATH}`,
    scope: "openid email profile", state, code_challenge: challenge, code_challenge_method: "S256",
  }).toString();
  return { location: authorize.toString(), setCookie: cookie(LOGIN_COOKIE, `${state}.${verifier}`, "/auth", LOGIN_COOKIE_SECONDS) };
}

/** The access token's claims. Read without checking its signature: the page has it straight from
 * the identity stack's own token endpoint, over TLS, in exchange for a code it asked for. */
function claims(token: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export type SignInOutcome =
  | { ok: true; setCookies: string[] }
  | { ok: false; status: number; reason: string };

/** GET /auth/callback: the code for tokens, an administrator only, then a page session and the
 * sealed token for the job. */
export async function finishSignIn(input: {
  identity: SetupIdentity; origin: string; query: Record<string, string | undefined>; cookieHeader: string | undefined;
  store: SetupStore; seal: TokenSeal; fetch: typeof fetch; now: () => number;
}): Promise<SignInOutcome> {
  const [state, verifier] = (parseCookies(input.cookieHeader)[LOGIN_COOKIE] ?? "").split(".");
  if (state === undefined || verifier === undefined || state === "" || state !== input.query.state || input.query.code === undefined) {
    return { ok: false, status: 400, reason: "This sign-in has expired or was started in another browser. Open the setup page again to sign in." };
  }
  const response = await input.fetch(new URL("/oauth2/token", input.identity.hostedUiDomain), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", client_id: input.identity.clientId, code: input.query.code,
      redirect_uri: `${input.origin}${SETUP_CALLBACK_PATH}`, code_verifier: verifier,
    }).toString(),
  });
  if (!response.ok) return { ok: false, status: 502, reason: "The sign-in service did not accept this sign-in. Open the setup page again to sign in." };
  const tokens = await response.json() as { access_token?: unknown; expires_in?: unknown };
  if (typeof tokens.access_token !== "string" || typeof tokens.expires_in !== "number") {
    return { ok: false, status: 502, reason: "The sign-in service answered without a sign-in. Open the setup page again to sign in." };
  }
  const access = claims(tokens.access_token);
  const groups = Array.isArray(access["cognito:groups"]) ? access["cognito:groups"] : [];
  if (!groups.includes(ADMIN_GROUP)) {
    return { ok: false, status: 403, reason: "This account is not an AgentX administrator, so it cannot set AgentX up." };
  }
  const expiresAt = input.now() + tokens.expires_in * 1000;
  const sessionId = base64url(randomBytes(32));
  await input.store.putSession(hashSessionId(sessionId), { username: typeof access.username === "string" ? access.username : "admin", expiresAt });
  await input.store.putAdminToken(await input.seal.seal(tokens.access_token), expiresAt);
  return {
    ok: true,
    setCookies: [cookie(SESSION_COOKIE, sessionId, "/", tokens.expires_in), cookie(LOGIN_COOKIE, "", "/auth", 0)],
  };
}

/** The job's `login` with --setup-table: the admin's sign-in from the setup page instead of a
 * browser on this machine, kept in the token store exactly as loginWithPkce keeps its own, so the
 * later steps reuse it. When the page has none waiting (the job took it earlier and restarted, or it
 * expired), it shows the page's own Sign in link and waits for the next. */
export function setupPageLogin(input: {
  store: SetupStore; seal: TokenSeal; signInUrl: string; sleep: (ms: number) => Promise<void>; now: () => number; pollMs?: number;
}): (options: LoginOptions) => Promise<StoredTokens> {
  return async (options) => {
    const deadline = input.now() + (options.timeoutMilliseconds ?? 10 * 60_000);
    let shown = false;
    for (;;) {
      const taken = await input.store.takeAdminToken();
      if (taken !== undefined) {
        const tokens = { accessToken: await input.seal.open(taken.sealed), expiresAt: taken.expiresAt };
        await options.tokenStore.set(tokenStoreKey(options), tokens);
        return tokens;
      }
      if (!shown) {
        shown = true;
        await options.openBrowser?.(input.signInUrl);
      }
      if (input.now() >= deadline) throw agentXError("AUTH_REQUIRED", "the admin did not sign in on the setup page in time");
      await input.sleep(input.pollMs ?? 2_000);
    }
  };
}
