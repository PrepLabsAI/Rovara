// Spec 025 A12 (Q3): who the signed-in admin is. The admin's access token (Cognito's in particular)
// often carries no email, so the issuer's userinfo endpoint is asked, with the admin's own token.
// Only a verified email counts. The token is never logged, and only a hash of it is kept as a key.
import { createHash } from "node:crypto";
import type { AdminMeResponse, SlackUserByEmailRequest, SlackUserByEmailResponse } from "@agentx/contracts";
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
const profileOf = (claims: Record<string, unknown>): Profile => {
  const email = verified(claims.email_verified) ? text(claims.email, 254) : undefined;
  const name = text(claims.name, 200) ?? email;
  return { ...(name === undefined ? {} : { name }), ...(email === undefined ? {} : { email }) };
};

export function adminIdentityReader(deps: AdminMeDependencies & { now(): number; log(entry: Record<string, unknown>): void }) {
  const cacheMs = deps.cacheMs ?? 300_000;
  const timeoutMs = deps.timeoutMs ?? 3_000;
  const profiles = new Map<string, { at: number; profile: Profile }>();
  let userinfoEndpoint: Promise<string | undefined> | undefined;

  const getJson = async (url: string, headers: Record<string, string> = {}): Promise<Record<string, unknown> | undefined> => {
    try {
      const response = await deps.fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
      if (!response.ok) return undefined;
      const body: unknown = await response.json();
      return typeof body === "object" && body !== null ? body as Record<string, unknown> : undefined;
    } catch (error) {
      deps.log({ event: "admin.userinfo_failed", error: error instanceof Error ? error.name : "unknown" });
      return undefined;
    }
  };
  const endpoint = (): Promise<string | undefined> => {
    userinfoEndpoint ??= getJson(`${deps.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`).then((document) => {
      const value = document?.userinfo_endpoint;
      const found = typeof value === "string" && value.startsWith("https://") ? value : undefined;
      // A failed discovery is tried again next time; a document without the endpoint is kept.
      if (document === undefined) userinfoEndpoint = undefined;
      return found;
    });
    return userinfoEndpoint;
  };

  async function profile(identity: AuthenticatedIdentity, authorization: string | undefined): Promise<Profile> {
    const own = profileOf(identity.claims);
    if (own.email !== undefined || authorization === undefined || !/^Bearer \S+$/.test(authorization)) return own;
    const key = createHash("sha256").update(authorization).digest("hex");
    const cached = profiles.get(key);
    if (cached !== undefined && deps.now() - cached.at < cacheMs) return cached.profile;
    const url = await endpoint();
    if (url === undefined) return own;
    const claims = await getJson(url, { authorization });
    // userinfo's sub must be the token's own; a mismatch is ignored rather than trusted.
    if (claims === undefined || claims.sub !== identity.subject) return own;
    const found = { ...own, ...profileOf(claims) };
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
