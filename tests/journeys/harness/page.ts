// Journey 15's person at the task page: a browser with a review session cookie (the session row the sign-in service writes: a Slack or company sign-in, a 30 day review window), the CSRF
// cookie the page hands out, and the page's own JSON API calls. Requests go through the same broker front as every other journey (`world.handler`), nothing is read from a store.
import { randomUUID } from "node:crypto";
import { DEV_ISSUER, type Developer } from "../../support/developer-task-broker.js";
import type { JourneyWorld } from "./hosted-core.js";

export const PAGE_ORIGIN = new URL(DEV_ISSUER).origin;
const SESSION_COOKIE = "__Host-agentx_review_session";
const CSRF_COOKIE = "__Host-agentx_review_csrf";
export const DAY_SECONDS = 86_400;

export interface PageReply { status: number; headers: Record<string, string>; text: string; json(): Record<string, unknown> }

/** A review session as the sign-in service writes it: starts now, the page's fixed 30 days (override to write an ended or a revoked one). */
export function writeReviewSession(world: JourneyWorld, who: Developer, options: { reviewSeconds?: number; revokedAt?: string } = {}): string {
  const sessionId = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const ends = now + (options.reviewSeconds ?? 30 * DAY_SECONDS);
  world.harness.db.set({ pk: `SESSION#${sessionId}`, sk: "META", sessionId, developerId: who.developerId, amr: who.provider === "oidc" ? "oidc" : "slack", startedAt: new Date().toISOString(),
    endsAt: ends, reviewExpiresAt: ends, ...(options.revokedAt === undefined ? {} : { revokedAt: options.revokedAt, revokedReason: "admin" }) });
  return sessionId;
}

export function pageRequest(world: JourneyWorld, method: string, path: string, options: { sessionId?: string; csrf?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<PageReply> {
  const url = new URL(path, PAGE_ORIGIN);
  const cookies = [options.sessionId === undefined ? undefined : `${SESSION_COOKIE}=${options.sessionId}`, options.csrf === undefined ? undefined : `${CSRF_COOKIE}=${options.csrf}`].filter((cookie) => cookie !== undefined).join("; ");
  return world.handler({ version: "2.0", routeKey: "ANY /review/{proxy+}", rawPath: url.pathname, rawQueryString: url.search.replace(/^\?/u, ""),
    headers: { host: new URL(PAGE_ORIGIN).host, ...(cookies === "" ? {} : { cookie: cookies }), ...(options.headers ?? {}) },
    ...(options.body === undefined ? {} : { body: typeof options.body === "string" ? options.body : JSON.stringify(options.body) }), isBase64Encoded: false,
    requestContext: { requestId: randomUUID(), http: { method } } }).then((response) => {
    const reply = response as unknown as { statusCode: number; headers?: Record<string, string>; body: string };
    return { status: reply.statusCode, headers: reply.headers ?? {}, text: reply.body, json: () => JSON.parse(reply.body) as Record<string, unknown> };
  });
}

const csrfOf = (reply: PageReply): string | undefined => new RegExp(`${CSRF_COOKIE}=([^;]+)`, "u").exec(reply.headers["set-cookie"] ?? "")?.[1];

/** A person's browser on one task's page. `open` loads the page (the CSRF cookie comes with it for someone who may act); `api` is what the page's script sends. */
export function pageReader(world: JourneyWorld, taskId: string, sessionId: string) {
  let csrf: string | undefined;
  const base = `/review/${taskId}/task`;
  const reader = {
    sessionId,
    get csrf() { return csrf; },
    async open(search = ""): Promise<PageReply> {
      const reply = await pageRequest(world, "GET", `${base}${search}`, { sessionId, ...(csrf === undefined ? {} : { csrf }) });
      csrf = csrfOf(reply) ?? csrf;
      return reply;
    },
    /** GET /task/api/<endpoint>; `state` also hands out the CSRF cookie. */
    async read(endpoint: string): Promise<PageReply> {
      const reply = await pageRequest(world, "GET", `${base}/api/${endpoint}`, { sessionId, ...(csrf === undefined ? {} : { csrf }) });
      csrf = csrfOf(reply) ?? csrf;
      return reply;
    },
    /** A POST the way the page's script makes it: its cookies, the CSRF header and the page's own origin. `override` changes one of them to show a refusal. */
    async post(endpoint: string, body: unknown, override: { origin?: string | null; csrfHeader?: string | null; contentType?: string | null; cookieCsrf?: string | null } = {}): Promise<PageReply> {
      const origin = override.origin === undefined ? PAGE_ORIGIN : override.origin;
      const header = override.csrfHeader === undefined ? csrf : override.csrfHeader;
      const contentType = override.contentType === undefined ? "application/json" : override.contentType;
      const cookieCsrf = override.cookieCsrf === undefined ? csrf : override.cookieCsrf;
      return pageRequest(world, "POST", `${base}/api/${endpoint}`, { sessionId, ...(cookieCsrf === null || cookieCsrf === undefined ? {} : { csrf: cookieCsrf }),
        headers: { ...(origin === null ? {} : { origin }), ...(header === null || header === undefined ? {} : { "x-agentx-csrf": header }), ...(contentType === null ? {} : { "content-type": contentType }) }, body });
    },
  };
  return reader;
}
export type PageReader = ReturnType<typeof pageReader>;

/** The words of a page (no tags, scripts or styles). */
export const words = (html: string) => html.replace(/<head>[\s\S]*?<\/head>/u, "").replace(/<(style|script)[\s\S]*?<\/\1>/gu, "").replace(/<[^>]+>/gu, " ").replace(/&#39;/gu, "'").replace(/\s+/gu, " ").trim();

/** What a company removal writes on the person's membership (the sign-in service's `setRevoked`: `revokedAt` and `revokedBy` on the member row). Their sessions are NOT ended by it. */
export function removeFromCompany(world: JourneyWorld, who: Developer): void {
  const row = world.harness.db.get(`COMPANY_MEMBER#${who.developerId}`, "COMPANY");
  if (row === undefined) throw new Error("the person has no membership to remove");
  world.harness.db.set({ ...row, revokedAt: new Date().toISOString(), revokedBy: "operator" });
}

/** The comments stored on a task (one row each), for "nothing is stored" checks. */
export const storedComments = (world: JourneyWorld, taskId: string) => world.harness.db.find((row) => row.pk === `DEVTASK#${taskId}` && row.entityType === "TASK_COMMENT");
