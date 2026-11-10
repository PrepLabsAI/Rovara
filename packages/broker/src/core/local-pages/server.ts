// Lane L8: the local review pages' HTTP server (owner decision 45.8). Small server-rendered pages for what is too long or too visual for a terminal or an
// editor: a plan with line comments, a design review with its mockups, the lessons, and the proof report. It binds 127.0.0.1 only, on a port the
// system picks (or the caller names), serves no script, keeps no cookie, and asks nothing of a request before `guard.ts` has passed it.
//
// A page write is one verified form: the session token is in the path, the form token binds the exact content shown, and an approval is not
// decided here. The server builds an `ApprovalProof` from the page session (`local-session`) and hands it, with the action, to the task flow, whose
// `Approvers` seam decides. The proof is good for the one request, revision and digest the form names.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { LOCAL_SESSION_METHOD } from "../../ports/policy-defaults.js";
import type { ApprovalProof } from "@agentx/contracts";
import { FailureLimiter, FormTokens, LocalPageSessions, refuseRequest, type FormBinding } from "./guard.js";
import { pagePolicy } from "./html.js";
import { renderDesignReview, renderIndex, renderLessons, renderPlanPage, renderProof, type PageContext } from "./pages.js";
import type { ApprovalOffer, LocalActionResult, LocalPageActions, LocalPageData } from "./views.js";

export interface LocalPagesServer {
  /** `http://127.0.0.1:<port>`. */
  origin: string;
  port: number;
  sessions: LocalPageSessions;
  /** The address of a page in the owner's session, opened on the first call and reused until it ends (`fresh` opens another). The token is in the address: a person's terminal only, never an MCP result, a file or a pull request, since whoever holds it can approve. */
  link(path?: string, options?: { ttlMs?: number; label?: string; fresh?: boolean }): string;
  /** The same, for a session that already exists. */
  linkIn(token: string, path?: string): string;
  /**
   * An address for a browser to be opened on, that holds no session: `<origin>/s/once/<code>`. The code is good for ONE request within `ttlMs` (30 s by default); that request is
   * answered with a redirect to the real address. So the address that sits in the process list while the browser starts is spent by the time anyone reads it.
   */
  onceLink(path?: string, options?: { ttlMs?: number; label?: string }): string;
  close(): Promise<void>;
}

export interface LocalPagesOptions {
  data: LocalPageData;
  actions: LocalPageActions;
  port?: number;
  now?: () => number;
  /** For tests: the session store, so a test can mint a known token. */
  sessions?: LocalPageSessions;
}

/** The longest body a form may send (a comment or a note is at most 4,000 characters; this leaves room for the fields). */
export const MAX_BODY_BYTES = 32 * 1024;
const TEXT_MAX = 4000;
const TASK_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ID = "[A-Za-z0-9_-]{1,100}";
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** The sentences a page shows after a write. The address carries a code, never text. */
const NOTICES: Record<string, string> = {
  approved: "Approved.",
  changes: "Your changes were sent.",
  rejected: "Rejected.",
  commented: "Comment added.",
  retried: "Rovara is running that step again.",
  attached: "That thread is attached. A writer's comment there can decide this plan.",
  answered: "Your answers were sent.",
  lesson: "Lesson updated.",
  stale: "It changed while you were looking. Read it again, then decide.",
  refused: "That was not accepted.",
  invalid: "That was not understood.",
  missing: "That is no longer there.",
  form: "That form has expired or was already used. Read the page again.",
};

type Route = { method: "GET" | "POST"; pattern: RegExp; handle: (request: Req, match: RegExpExecArray) => Promise<Reply> };
interface Req { session: { id: string; token: string }; url: URL; form: URLSearchParams | undefined; base: string; origin: string }
type Reply = { status: number; type: string; body: string | Uint8Array; headers?: Record<string, string> };

const html = (body: string, status = 200): Reply => ({ status, type: "text/html; charset=utf-8", body });
const redirect = (location: string): Reply => ({ status: 303, type: "text/plain; charset=utf-8", body: "", headers: { location } });
const notFound = (): Reply => ({ status: 404, type: "text/plain; charset=utf-8", body: "not found\n" });

function noticeOf(url: URL): string | undefined {
  const code = url.searchParams.get("n");
  return code === null || !Object.hasOwn(NOTICES, code) ? undefined : NOTICES[code];
}

const outcomeCode = (result: LocalActionResult, success: string): string => (result.ok ? success : result.reason === "stale" ? "stale" : result.reason === "not_found" ? "missing" : result.reason === "invalid" ? "invalid" : "refused");

export async function createLocalPagesServer(options: LocalPagesOptions): Promise<LocalPagesServer> {
  const now = options.now ?? Date.now;
  const sessions = options.sessions ?? new LocalPageSessions(now);
  const forms = new FormTokens(randomBytes(32), now);
  // Single-use codes for `onceLink`: only a hash is kept, and at most a few at a time.
  const onceCodes = new Map<string, { path: string; label: string | undefined; expires: number }>();
  const limiter = new FailureLimiter(60, 60_000, now);
  let origin = "";
  let ownerToken: string | undefined;

  const contextFor = (request: Req): PageContext => {
    const notice = noticeOf(request.url);
    return {
      base: request.base, nonce: randomBytes(16).toString("base64url"), sessionId: request.session.id,
      formToken: (binding) => forms.issue({ ...binding, sessionId: request.session.id }),
      ...(notice === undefined ? {} : { notice }),
    };
  };
  const page = (request: Req, draw: (context: PageContext) => string | Promise<string>): Promise<Reply> =>
    Promise.resolve(contextFor(request)).then(async (context) => ({ ...html(await draw(context)), headers: { "content-security-policy": pagePolicy(context.nonce) } }));

  /** The proof an approval form carries: the page session is the evidence that the local owner is here. */
  const proofFor = (request: Req, offer: ApprovalOffer): ApprovalProof => ({
    proofId: randomUUID(), method: LOCAL_SESSION_METHOD, requestId: offer.requestId, revision: offer.revision, artifactDigest: offer.artifactDigest,
    // Not the session's secret: a token signed over this session and exactly this request, revision and digest.
    token: sessions.issueProof(request.session.id, { requestId: offer.requestId, revision: offer.revision, artifactDigest: offer.artifactDigest }),
  });

  /** The values a write form named, and whether its form token binds them. Every value a write uses comes from here, never from the form unchecked. */
  const verified = (request: Req, binding: Omit<FormBinding, "sessionId">): boolean => {
    const given = request.form?.get("ft") ?? undefined;
    // A form answers once: a second click on the same form, or a replay, finds its token used.
    return forms.verify(given, { ...binding, sessionId: request.session.id }) && forms.consume(given as string);
  };
  const text = (request: Req, name: string): string => {
    const value = request.form?.get(name) ?? "";
    return [...value].length > TEXT_MAX ? [...value].slice(0, TEXT_MAX).join("") : value;
  };
  const offerOf = (request: Req, kind: "plan" | "design"): ApprovalOffer | undefined => {
    const revision = Number(request.form?.get("revision"));
    const requestId = request.form?.get("requestId") ?? "";
    const artifactDigest = request.form?.get("digest") ?? "";
    if (!Number.isSafeInteger(revision) || revision < 0 || requestId === "" || requestId.length > 200 || artifactDigest === "" || artifactDigest.length > 200) return undefined;
    return { requestId, revision, artifactDigest, kind };
  };

  const routes: Route[] = [
    { method: "GET", pattern: /^\/$/, handle: async (request) => page(request, async (context) => renderIndex(context, await options.data.listPending())) },
    { method: "GET", pattern: new RegExp(`^/plan/(${TASK_ID})$`), handle: async (request, match) => {
      const taskId = match[1] ?? "";
      const view = await options.data.getPlanPage(taskId);
      return view === undefined ? notFound() : page(request, (context) => renderPlanPage(context, view));
    } },
    { method: "POST", pattern: new RegExp(`^/plan/(${TASK_ID})/decide$`), handle: async (request, match) => {
      const taskId = match[1] ?? "";
      const offer = offerOf(request, "plan");
      const decision = request.form?.get("decision");
      if (offer === undefined || (decision !== "approve" && decision !== "changes")) return redirect(`${request.base}/plan/${taskId}?n=invalid`);
      if (!verified(request, { action: "plan.decide", taskId, requestId: offer.requestId, revision: offer.revision, artifactDigest: offer.artifactDigest })) return redirect(`${request.base}/plan/${taskId}?n=form`);
      const note = text(request, "note").trim();
      if (decision === "changes" && note === "") return redirect(`${request.base}/plan/${taskId}?n=invalid`);
      const result = await options.actions.decidePlan({ taskId, decision, ...(note === "" ? {} : { note }), approval: offer, proof: proofFor(request, offer) });
      return redirect(`${request.base}/plan/${taskId}?n=${outcomeCode(result, decision === "approve" ? "approved" : "changes")}`);
    } },
    { method: "POST", pattern: new RegExp(`^/plan/(${TASK_ID})/retry$`), handle: async (request, match) => {
      const taskId = match[1] ?? "";
      const revision = Number(request.form?.get("revision"));
      if (!Number.isSafeInteger(revision) || options.actions.retry === undefined) return redirect(`${request.base}/plan/${taskId}?n=invalid`);
      if (!verified(request, { action: "task.retry", taskId, revision })) return redirect(`${request.base}/plan/${taskId}?n=form`);
      const result = await options.actions.retry({ taskId, revision });
      return redirect(`${request.base}/plan/${taskId}?n=${outcomeCode(result, "retried")}`);
    } },
    { method: "POST", pattern: new RegExp(`^/plan/(${TASK_ID})/thread$`), handle: async (request, match) => {
      const taskId = match[1] ?? "";
      const revision = Number(request.form?.get("revision"));
      const number = Number(request.form?.get("number"));
      const repository = (request.form?.get("repository") ?? "").trim();
      if (!Number.isSafeInteger(revision) || !Number.isSafeInteger(number) || number < 1 || !/^[A-Za-z0-9_.-]{1,100}$/u.test(repository) || options.actions.attachThread === undefined) return redirect(`${request.base}/plan/${taskId}?n=invalid`);
      if (!verified(request, { action: "task.thread", taskId, revision })) return redirect(`${request.base}/plan/${taskId}?n=form`);
      const result = await options.actions.attachThread({ taskId, revision, repository, number });
      return redirect(`${request.base}/plan/${taskId}?n=${outcomeCode(result, "attached")}`);
    } },
    { method: "POST", pattern: new RegExp(`^/plan/(${TASK_ID})/answers$`), handle: async (request, match) => {
      const taskId = match[1] ?? "";
      const revision = Number(request.form?.get("revision"));
      const round = Number(request.form?.get("round"));
      if (!Number.isSafeInteger(revision) || !Number.isSafeInteger(round) || options.actions.answerQuestions === undefined) return redirect(`${request.base}/plan/${taskId}?n=invalid`);
      if (!verified(request, { action: "task.answers", taskId, revision })) return redirect(`${request.base}/plan/${taskId}?n=form`);
      // One answer for each question the form carried: a chosen option, or the person's own words (the workflow checks them against the questions it asked).
      const answers: Array<{ questionId: string; optionId?: string; text?: string }> = [];
      for (const name of [...(request.form?.keys() ?? [])].filter((key) => key.startsWith("text-") || key.startsWith("option-"))) {
        const questionId = name.slice(name.indexOf("-") + 1);
        if (!/^[A-Za-z0-9_-]{1,40}$/u.test(questionId) || answers.some((answer) => answer.questionId === questionId)) continue;
        const optionId = request.form?.get(`option-${questionId}`) ?? "";
        const words = text(request, `text-${questionId}`).trim();
        if (optionId === "" && words === "") continue;
        answers.push({ questionId, ...(optionId === "" ? {} : { optionId }), ...(words === "" ? {} : { text: words }) });
      }
      const result = await options.actions.answerQuestions({ taskId, revision, round, answers });
      return redirect(`${request.base}/plan/${taskId}?n=${outcomeCode(result, "answered")}`);
    } },
    { method: "POST", pattern: new RegExp(`^/plan/(${TASK_ID})/comment$`), handle: async (request, match) => {
      const taskId = match[1] ?? "";
      const revision = Number(request.form?.get("revision"));
      if (!Number.isSafeInteger(revision)) return redirect(`${request.base}/plan/${taskId}?n=invalid`);
      if (!verified(request, { action: "plan.comment", taskId, revision })) return redirect(`${request.base}/plan/${taskId}?n=form`);
      const target = (request.form?.get("target") ?? "").trim();
      const body = text(request, "text").trim();
      if (body === "" || !/^(|[0-9]{1,3}(\.[0-9]{1,3}){0,2}|[A-Za-z0-9_-]{1,40})$/.test(target)) return redirect(`${request.base}/plan/${taskId}?n=invalid`);
      const result = await options.actions.addComment({ taskId, target, text: body, revision });
      return redirect(`${request.base}/plan/${taskId}?n=${outcomeCode(result, "commented")}#comments`);
    } },
    { method: "GET", pattern: new RegExp(`^/design/(${TASK_ID})$`), handle: async (request, match) => {
      const view = await options.data.getDesignReview(match[1] ?? "");
      return view === undefined ? notFound() : page(request, (context) => renderDesignReview(context, view));
    } },
    { method: "GET", pattern: new RegExp(`^/design/(${TASK_ID})/mockup/(${ID})$`), handle: async (request, match) => {
      const view = await options.data.getDesignReview(match[1] ?? "");
      // Only a mockup the review names is served, whatever the id: the data source is not asked for arbitrary files.
      const mockup = view?.mockups.find((candidate) => candidate.id === match[2]);
      if (view === undefined || mockup === undefined) return notFound();
      const image = await options.data.readMockup(view.taskId, mockup.id);
      if (image === undefined || !ALLOWED_IMAGE_TYPES.has(image.contentType) || image.bytes.byteLength > MAX_IMAGE_BYTES) return notFound();
      return { status: 200, type: image.contentType, body: image.bytes, headers: { "content-security-policy": "default-src 'none'; sandbox", "content-disposition": "inline" } };
    } },
    { method: "POST", pattern: new RegExp(`^/design/(${TASK_ID})/decide$`), handle: async (request, match) => {
      const taskId = match[1] ?? "";
      const offer = offerOf(request, "design");
      const decision = request.form?.get("decision");
      if (offer === undefined || (decision !== "approve" && decision !== "reject")) return redirect(`${request.base}/design/${taskId}?n=invalid`);
      if (!verified(request, { action: "design.decide", taskId, requestId: offer.requestId, revision: offer.revision, artifactDigest: offer.artifactDigest })) return redirect(`${request.base}/design/${taskId}?n=form`);
      const note = text(request, "note").trim();
      if (decision === "reject" && note === "") return redirect(`${request.base}/design/${taskId}?n=invalid`);
      const result = await options.actions.decideDesign({ taskId, decision, ...(note === "" ? {} : { note }), approval: offer, proof: proofFor(request, offer) });
      return redirect(`${request.base}/design/${taskId}?n=${outcomeCode(result, decision === "approve" ? "approved" : "rejected")}`);
    } },
    { method: "GET", pattern: /^\/lessons$/, handle: async (request) => page(request, async (context) => renderLessons(context, await options.data.listLessons())) },
    { method: "POST", pattern: /^\/lessons\/act$/, handle: async (request) => {
      const lessonId = request.form?.get("lessonId") ?? "";
      const action = request.form?.get("action");
      if (!new RegExp(`^${ID}$`).test(lessonId) || (action !== "approve" && action !== "retire" && action !== "wrong")) return redirect(`${request.base}/lessons?n=invalid`);
      // The form is good only for the lesson as it was drawn: its state is part of what the token binds.
      const lesson = (await options.data.listLessons()).find((candidate) => candidate.id === lessonId);
      if (lesson === undefined) return redirect(`${request.base}/lessons?n=missing`);
      if (!verified(request, { action: "lesson.act", subject: `${lessonId}:${action}:${lesson.status}` })) return redirect(`${request.base}/lessons?n=form`);
      const result = await options.actions.lessonAction({ lessonId, action });
      return redirect(`${request.base}/lessons?n=${outcomeCode(result, "lesson")}`);
    } },
    { method: "GET", pattern: new RegExp(`^/proof/(${TASK_ID})$`), handle: async (request, match) => {
      const view = await options.data.getProofReport(match[1] ?? "");
      return view === undefined ? notFound() : page(request, (context) => renderProof(context, view));
    } },
  ];

  const send = (response: ServerResponse, reply: Reply, head: boolean): void => {
    const body = typeof reply.body === "string" ? Buffer.from(reply.body, "utf8") : Buffer.from(reply.body);
    response.writeHead(reply.status, {
      "cache-control": "no-store", pragma: "no-cache", "referrer-policy": "same-origin", "x-content-type-options": "nosniff", "x-frame-options": "DENY",
      "x-robots-tag": "noindex, nofollow", "cross-origin-resource-policy": "same-origin", "cross-origin-opener-policy": "same-origin",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'", ...reply.headers,
      "content-type": reply.type, "content-length": body.byteLength,
    });
    response.end(head ? undefined : body);
  };

  const readForm = async (request: IncomingMessage): Promise<URLSearchParams | undefined> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += (chunk as Buffer).byteLength;
      if (size > MAX_BODY_BYTES) return undefined;
      chunks.push(chunk as Buffer);
    }
    return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  };

  const header = (request: IncomingMessage, name: string): string | undefined => {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const head = request.method === "HEAD";
    const refusal = refuseRequest({
      method: request.method, host: header(request, "host"), origin: header(request, "origin"), referer: header(request, "referer"),
      secFetchSite: header(request, "sec-fetch-site"), remoteAddress: request.socket.remoteAddress, contentType: header(request, "content-type"), expectedOrigin: origin,
    });
    if (refusal !== undefined) return send(response, { status: refusal.status, type: "text/plain; charset=utf-8", body: "refused\n" }, head);
    let url: URL;
    try {
      url = new URL(request.url ?? "/", origin);
    } catch {
      return send(response, notFound(), head);
    }
    // /s/once/<code>: a single-use code (onceLink) is spent by the first GET and answered with a redirect to the owner's real page address. HEAD, POST and a spent, expired or unknown code are
    // answered like a path that does not exist.
    const once = /^\/s\/once\/([A-Za-z0-9_-]{32,64})$/.exec(url.pathname);
    if (once !== null) {
      const key = createHash("sha256").update(once[1] as string).digest("hex");
      const entry = request.method === "GET" ? onceCodes.get(key) : undefined;
      if (entry !== undefined) onceCodes.delete(key);
      if (entry === undefined || entry.expires <= now()) {
        if (limiter.failed()) return send(response, { status: 429, type: "text/plain; charset=utf-8", body: "slow down\n" }, head);
        return send(response, notFound(), head);
      }
      return send(response, redirect(ownerLink(entry.path, { label: entry.label })), head);
    }
    // /s/<token>/<rest>. A wrong token is answered like a path that does not exist.
    const match = /^\/s\/([A-Za-z0-9_-]{43})(\/.*)?$/.exec(url.pathname);
    const session = sessions.find(match?.[1]);
    if (match === null || session === undefined) {
      if (limiter.failed()) return send(response, { status: 429, type: "text/plain; charset=utf-8", body: "slow down\n" }, head);
      return send(response, notFound(), head);
    }
    const token = match[1] as string;
    const rest = match[2] === undefined || match[2] === "" ? "/" : match[2];
    const method = request.method === "POST" ? "POST" : "GET";
    const route = routes.find((candidate) => candidate.method === method && candidate.pattern.test(rest));
    if (route === undefined) return send(response, notFound(), head);
    let form: URLSearchParams | undefined;
    if (method === "POST") {
      form = await readForm(request);
      if (form === undefined) return send(response, { status: 413, type: "text/plain; charset=utf-8", body: "too large\n" }, head);
    }
    // The route sees the path without the token, so its patterns and task ids read the same wherever the session lives.
    const inner = new URL(rest + url.search, origin);
    const reply = await route.handle({ session: { id: session.id, token }, url: inner, form, base: `/s/${token}`, origin }, route.pattern.exec(rest) as RegExpExecArray);
    send(response, reply, head);
  };

  const server: Server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) send(response, { status: 500, type: "text/plain; charset=utf-8", body: "the page could not be drawn\n" }, false);
      else response.end();
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 50;
  server.keepAliveTimeout = 5_000;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(options.port ?? 0, "127.0.0.1", () => { server.removeListener("error", onError); resolve(); });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the local pages did not bind a TCP port");
  origin = `http://127.0.0.1:${address.port}`;

  const linkIn = (token: string, path = "/"): string => `${origin}/s/${token}${path.startsWith("/") ? path : `/${path}`}`;
  const ownerLink = (path = "/", sessionOptions: { ttlMs?: number; label?: string | undefined; fresh?: boolean } = {}): string => {
    // One session serves the owner's links until it ends, so opening a second link does not push the first tab's session out of the cap.
    const mintOptions = { ...(sessionOptions.ttlMs === undefined ? {} : { ttlMs: sessionOptions.ttlMs }), ...(sessionOptions.label === undefined ? {} : { label: sessionOptions.label }) };
    if (sessionOptions.fresh !== true && (ownerToken === undefined || !sessions.isValidSecret(ownerToken))) ownerToken = sessions.mint(mintOptions).token;
    return linkIn(sessionOptions.fresh === true ? sessions.mint(mintOptions).token : (ownerToken as string), path);
  };
  return {
    origin, port: address.port, sessions,
    link: (path = "/", sessionOptions = {}) => ownerLink(path, sessionOptions),
    onceLink: (path = "/", onceOptions = {}) => {
      const code = randomBytes(24).toString("base64url");
      const at = now();
      for (const [key, entry] of onceCodes) if (entry.expires <= at) onceCodes.delete(key);
      // A few at a time: opening more than that in 30 seconds drops the oldest.
      while (onceCodes.size >= 8) onceCodes.delete(onceCodes.keys().next().value as string);
      onceCodes.set(createHash("sha256").update(code).digest("hex"), { path: path.startsWith("/") ? path : `/${path}`, label: onceOptions.label, expires: at + (onceOptions.ttlMs ?? 30_000) });
      return `${origin}/s/once/${code}`;
    },
    linkIn,
    async close() {
      sessions.revokeAll();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

