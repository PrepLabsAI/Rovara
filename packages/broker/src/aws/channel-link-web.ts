import { randomBytes } from "node:crypto";
import type { ChannelLink } from "@agentx/contracts";
import type { DeveloperCaller } from "./developer-routes.js";
import type { AdaptedHttpRequest } from "./lambda.js";
import { CSRF_COOKIE, CSRF_MAX_AGE_SECONDS, SESSION_COOKIE, escapeHtml as escape, parseCookie, safeResponse, signInLocation, type WebResponse } from "./web-session.js";

/**
 * Spec 062 FR-031: the page a `link_required` event links to. The person signs in with their Rovara login, sees which
 * channel and (masked) user ID they are about to link, and confirms. The confirmation names both so that a link code
 * someone else sent them, to link the sender's number to their account, is recognisable and refused.
 */
export const CHANNEL_LINK_PAGE = /^\/review\/link\/([A-Za-z0-9_-]{32})(\/confirm)?$/;

export interface ChannelLinkWebDependencies {
  /** Canonical API origin. */
  origin: string;
  authenticateSession(sessionId: string): Promise<DeveloperCaller | undefined>;
  preview(code: string): Promise<{ channel: string; maskedUserId: string } | undefined>;
  redeem(developerId: string, code: string): Promise<ChannelLink>;
}

const isCsrf = (value: string | undefined): value is string => value !== undefined && /^[A-Za-z0-9_-]{32,64}$/.test(value);

function page(title: string, body: string, nonce: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style nonce="${nonce}">:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{max-width:36rem;margin:0 auto;padding:clamp(1rem,4vw,2.5rem);line-height:1.55}button{font:inherit;padding:.65rem 1rem;border-radius:.35rem;cursor:pointer}button:focus{outline:3px solid #478cff;outline-offset:2px}.warning{border-left:4px solid #d08700;padding:.25rem .9rem}</style></head><body><main><h1>${escape(title)}</h1>${body}</main></body></html>`;
}

function html(statusCode: number, title: string, body: string): WebResponse {
  const nonce = randomBytes(18).toString("base64url");
  return safeResponse(statusCode, page(title, body, nonce), nonce);
}

const expired = () => html(404, "This link has expired", "<p>This link has expired or was already used. Send Rovara another message from the app you want to link to get a new one.</p>");

export function createChannelLinkWeb(deps: ChannelLinkWebDependencies) {
  const origin = new URL(deps.origin).origin;
  return async (request: AdaptedHttpRequest, url: URL): Promise<WebResponse> => {
    const route = CHANNEL_LINK_PAGE.exec(url.pathname);
    if (route === null) return safeResponse(404, { error: "not_found" });
    const code = route[1]!;
    const confirming = route[2] !== undefined;
    if (confirming ? request.method !== "POST" : request.method !== "GET") return safeResponse(405, { error: "method_not_allowed" });

    const sessionId = parseCookie(request.headers, SESSION_COOKIE);
    const caller = sessionId === undefined ? undefined : await deps.authenticateSession(sessionId);
    if (caller === undefined) {
      if (confirming) return safeResponse(401, { error: "sign_in_required" });
      return { ...safeResponse(302, ""), headers: { ...safeResponse(302, "").headers, location: signInLocation(`/review/link/${code}`) } };
    }

    if (confirming) {
      const csrfCookie = parseCookie(request.headers, CSRF_COOKIE);
      const form = new URLSearchParams(request.body ?? "");
      if (request.headers.origin !== origin || !isCsrf(csrfCookie) || form.get("csrf") !== csrfCookie) return safeResponse(403, { error: "request_refused" });
      try {
        const link = await deps.redeem(caller.developerId, code);
        return html(200, "Linked", `<p>Your <strong>${escape(link.actor.channel)}</strong> account is linked to ${escape(caller.name)}. Go back and send your message again.</p>`);
      } catch (error) {
        const code = (error as { code?: string })?.code;
        if (code === "NOT_FOUND") return expired();
        if (code === "CHANGE_STALE") return html(409, "Already linked", "<p>That account is already linked to a Rovara login. Remove the old link first, or ask an administrator.</p>");
        return html(503, "Linking is unavailable", "<p>Try again in a moment.</p>");
      }
    }

    const preview = await deps.preview(code);
    if (preview === undefined) return expired();
    const currentCsrf = parseCookie(request.headers, CSRF_COOKIE);
    const csrf = isCsrf(currentCsrf) ? currentCsrf : randomBytes(32).toString("base64url");
    const response = html(200, "Link your account", `<p>Link <strong>${escape(preview.channel)}</strong> user <strong>${escape(preview.maskedUserId)}</strong> to your Rovara login, <strong>${escape(caller.name)}</strong>?</p>`
      + `<p>Rovara will then run what that ${escape(preview.channel)} user asks as you, in the projects you can use.</p>`
      + `<p class="warning">Only confirm if <strong>you</strong> just messaged Rovara from that ${escape(preview.channel)} account and it sent you this link. If someone else sent it to you, close this page.</p>`
      + `<form method="post" action="/review/link/${escape(code)}/confirm"><input type="hidden" name="csrf" value="${escape(csrf)}"><button type="submit">Link this account</button></form>`);
    if (!isCsrf(currentCsrf)) response.headers["set-cookie"] = `${CSRF_COOKIE}=${csrf}; Secure; SameSite=Lax; Path=/; Max-Age=${CSRF_MAX_AGE_SECONDS}`;
    return response;
  };
}
