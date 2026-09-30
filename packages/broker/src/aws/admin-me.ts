// Spec 025 A12 (Q3): who the signed-in admin is. The admin's access token (Cognito's in particular)
// often carries no email, so the issuer's userinfo endpoint is asked, with the admin's own token.
// Only a verified email counts. The token is never logged, and only a hash of it is kept as a key.
import { createHash } from "node:crypto";
import { redactAndCap, type AdminMeResponse, type SlackUserByEmailRequest, type SlackUserByEmailResponse } from "@agentx/contracts";
import type { AuthenticatedIdentity } from "../auth.js";

export interface AdminMeDependencies {
  issuer: string;
  fetch: typeof fetch;
  slackUserByEmail?: (request: SlackUserByEmailRequest) => Promise<SlackUserByEmailResponse>;
  cacheMs?: number;
  timeoutMs?: number;
}
type Profile = { name?: string; email?: string };

const verified = (value: unknown) => value === true || value === "true";
const text = (value: unknown, max: number) => (typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, max) : undefined);
/** A16: a display name is text from the identity provider, so it is redacted and capped as channel names are. */
const displayName = (value: unknown) => {
  const found = text(value, 1_000);
  return found === undefined ? undefined : redactAndCap(found, 200).text;
};
const claimsOf = (claims: Record<string, unknown>) => ({ name: displayName(claims.name), email: verified(claims.email_verified) ? text(claims.email, 254) : undefined });
/** The token's name first, then userinfo's, then the email. */
const profileFrom = (name: string | undefined, email: string | undefined): Profile => {
  // T11: an email shown as the name is redacted and capped like any other name.
  const shown = name ?? (email === undefined ? undefined : redactAndCap(email, 200).text);
  return { ...(shown === undefined ? {} : { name: shown }), ...(email === undefined ? {} : { email }) };
};

export function adminIdentityReader(deps: AdminMeDependencies & { now(): number; log(entry: Record<string, unknown>): void }) {
  const cacheMs = deps.cacheMs ?? 300_000;
  const timeoutMs = deps.timeoutMs ?? 3_000;
  const profiles = new Map<string, { at: number; profile: Profile }>();
  let userinfoEndpoint: { at: number; url: Promise<string | undefined> } | undefined;

  /** Logs `event` with the HTTP status or the error's name only: never the URL, headers or body. */
  const getJson = async (event: string, url: string, headers: Record<string, string> = {}): Promise<Record<string, unknown> | undefined> => {
    try {
      const response = await deps.fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
      if (!response.ok) {
        deps.log({ event, status: response.status });
        return undefined;
      }
      const body: unknown = await response.json();
      return typeof body === "object" && body !== null ? body as Record<string, unknown> : undefined;
    } catch (error) {
      deps.log({ event, error: error instanceof Error ? error.name : "unknown" });
      return undefined;
    }
  };
  const endpoint = (): Promise<string | undefined> => {
    // A document is kept for the cache time, so an issuer that adds userinfo later is found again.
    if (userinfoEndpoint !== undefined && deps.now() - userinfoEndpoint.at < cacheMs) return userinfoEndpoint.url;
    const entry = {
      at: deps.now(),
      url: getJson("admin.discovery_failed", `${deps.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`).then((document) => {
        // A failed discovery is never kept: the next call tries again.
        if (document === undefined && userinfoEndpoint === entry) userinfoEndpoint = undefined;
        const value = document?.userinfo_endpoint;
        return typeof value === "string" && value.startsWith("https://") ? value : undefined;
      }),
    };
    userinfoEndpoint = entry;
    return entry.url;
  };

  async function profile(identity: AuthenticatedIdentity, authorization: string | undefined): Promise<Profile> {
    const claims = claimsOf(identity.claims);
    const own = profileFrom(claims.name, claims.email);
    // Defense in depth: only a token from the admin issuer is ever sent to its userinfo endpoint.
    if (identity.issuer !== deps.issuer) return own;
    if (own.email !== undefined || authorization === undefined || !/^Bearer \S+$/.test(authorization)) return own;
    const key = createHash("sha256").update(authorization).digest("hex");
    const cached = profiles.get(key);
    if (cached !== undefined && deps.now() - cached.at < cacheMs) return cached.profile;
    const url = await endpoint();
    if (url === undefined) return own;
    const answer = await getJson("admin.userinfo_failed", url, { authorization });
    // userinfo's sub must be the token's own; a mismatch is ignored rather than trusted, and never kept.
    if (answer === undefined || answer.sub !== identity.subject) return own;
    const info = claimsOf(answer);
    const found = profileFrom(claims.name ?? info.name, info.email);
    const oldest = profiles.size >= 500 ? profiles.keys().next().value : undefined;
    if (oldest !== undefined) profiles.delete(oldest);
    profiles.set(key, { at: deps.now(), profile: found });
    return found;
  }

  async function me(identity: AuthenticatedIdentity, authorization: string | undefined): Promise<AdminMeResponse> {
    const found = await profile(identity, authorization);
    const base = { issuer: identity.issuer, subject: identity.subject, ...found };
    if (found.email === undefined) return { ...base, slack: { linked: false, reason: "no_email" } };
    if (deps.slackUserByEmail === undefined) return { ...base, slack: { linked: false, reason: "not_set_up" } };
    let answer: SlackUserByEmailResponse;
    try {
      answer = await deps.slackUserByEmail({ kind: "slack-user-by-email", email: found.email });
    } catch (error) {
      // A thrown lookup is an unavailable one: the answer still says who the admin is.
      deps.log({ event: "admin.slack_user_lookup_failed", error: error instanceof Error ? error.name : "unknown" });
      answer = { ok: false, error: "slack_unavailable" };
    }
    if (!answer.ok) return { ...base, slack: { linked: false, reason: "slack_unavailable" } };
    return { ...base, slack: answer.userId === undefined ? { linked: false, reason: "no_match" } : { linked: true, userId: answer.userId } };
  }

  return { profile, me };
}
