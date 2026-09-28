// The admin's session with the control plane: a stored token when it is still good, otherwise a
// browser sign-in (PKCE on 127.0.0.1:8765). Either way the admin route must accept it, so a later
// step never fails on a bare 403. Your own OIDC provider's token must also carry the admin claim
// (FR-021); the control plane is what verifies it, this only explains a refusal.
import { AgentXError, agentXError } from "@agentx/contracts";
import { ADMIN_LISTENER_MESSAGES, tokenStoreKey } from "../auth.js";
import { listCredentials } from "../admin/credential.js";
import type { EnvironmentSettings } from "../environments/settings.js";
import type { AdminSession, SetupServices } from "./services.js";

export const ADMIN_GROUP = "agentx-admin";
const EXPIRY_MARGIN_MS = 60_000;

export function userPoolId(settings: Pick<EnvironmentSettings, "identity">): string {
  const id = settings.identity.issuer.split("/").at(-1) ?? "";
  if (!/^[a-z]{2}(-[a-z]+)+-\d_[A-Za-z0-9]+$/.test(id)) {
    throw agentXError("CONFIG_INVALID", `the issuer ${settings.identity.issuer} does not end in a Cognito user pool id; check /agentx/<env>/settings`);
  }
  return id;
}

/** The admin claim values in an access token, without verifying it (the control plane verifies). */
export function tokenClaimValues(accessToken: string, claim: string): string[] {
  const payload = accessToken.split(".")[1];
  if (payload === undefined) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return []; }
  const value = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>)[claim] : undefined;
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

const NOT_ADMIN = "you signed in as someone who is not an AgentX administrator; sign out of the AgentX sign-in page in your browser, then run agentx init again and sign in as the admin user";
/** The first Cognito sign-in waits for the temporary-password email and a new password. */
const SIGN_IN_TIMEOUT_MS = 600_000;

export async function openAdminSession(input: {
  settings: EnvironmentSettings; services: Pick<SetupServices, "tokenStore" | "login" | "fetch">;
  /** Absent with --no-browser: then nothing is opened and only the address is printed. */
  openBrowser?: (url: string) => Promise<unknown>; write: (line: string) => void; now: () => number;
  /** Your own OIDC: the claim and values that mark an administrator (FR-021). */
  adminClaim?: { claim: string; values: readonly string[] };
}): Promise<AdminSession> {
  const { settings, services, openBrowser } = input;
  const auth = { issuer: settings.identity.issuer, clientId: settings.identity.clientId, audience: settings.identity.audience };
  const storeKey = tokenStoreKey(auth);

  const signIn = async (): Promise<string> => {
    input.write(openBrowser === undefined
      ? "Open this address in your browser and sign in as the admin user:"
      : "A browser opens the AgentX sign-in page. Sign in as the admin user; if no browser opens, open the address below.");
    try {
      // Always pass openBrowser, so loginWithPkce never falls back to the system browser: with
      // --no-browser the address is printed and nothing is opened (F12).
      return (await services.login({
        ...auth, tokenStore: services.tokenStore, fetchImplementation: services.fetch, callbackPort: 8765, timeoutMilliseconds: SIGN_IN_TIMEOUT_MS,
        openBrowser: async (url: string) => {
          input.write(url);
          if (openBrowser !== undefined) await openBrowser(url);
        },
      })).accessToken;
    } catch (error) {
      // Not AUTH_REQUIRED, which init follows with advice to refresh the AWS session.
      if (error instanceof AgentXError && error.code === "AUTH_REQUIRED" && error.message === `AUTH_REQUIRED: ${ADMIN_LISTENER_MESSAGES.timedOut}`) {
        throw agentXError("OPERATION_INTERRUPTED", `the AgentX sign-in did not finish within ${SIGN_IN_TIMEOUT_MS / 60_000} minutes; run agentx init again and finish signing in as the admin user in the browser`);
      }
      throw error;
    }
  };

  /** Why the control plane will not take this token as an administrator's, or undefined when it will. */
  const refusal = async (accessToken: string): Promise<AgentXError | undefined> => {
    const adminClaim = input.adminClaim;
    if (adminClaim !== undefined) {
      const values = tokenClaimValues(accessToken, adminClaim.claim);
      if (!values.some((value) => adminClaim.values.includes(value))) {
        return agentXError("FORBIDDEN", `your sign-in token's "${adminClaim.claim}" claim has none of ${adminClaim.values.join(", ")} (it has ${values.join(", ") || "no values"}); add yourself to one of them in your identity provider, then run agentx init again`);
      }
    }
    try {
      await listCredentials({ controlPlaneUrl: settings.controlPlaneUrl, accessToken }, services.fetch);
      return undefined;
    } catch (error) {
      // The broker answers a non-administrator with code FORBIDDEN, which adminResponseBody keeps (F11).
      if (error instanceof AgentXError && error.code === "FORBIDDEN") return agentXError("FORBIDDEN", NOT_ADMIN);
      throw error;
    }
  };

  const stored = await services.tokenStore.get(storeKey);
  if (stored !== undefined && stored.expiresAt - EXPIRY_MARGIN_MS > input.now()) {
    if ((await refusal(stored.accessToken)) === undefined) return { controlPlaneUrl: settings.controlPlaneUrl, accessToken: stored.accessToken };
    // A stored token may predate the fix the refusal asks for (a new group, a claim), so it is
    // forgotten and replaced by one fresh sign-in before anything is refused.
    await services.tokenStore.delete(storeKey);
  }
  const accessToken = await signIn();
  const refused = await refusal(accessToken);
  if (refused !== undefined) {
    // loginWithPkce already saved the token; keeping it would make the rerun the advice asks for
    // reuse the refused token until it expires.
    await services.tokenStore.delete(storeKey);
    throw refused;
  }
  return { controlPlaneUrl: settings.controlPlaneUrl, accessToken };
}
