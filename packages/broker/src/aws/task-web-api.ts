// Spec 061 slice 2: the task page's JSON API under `/review/<task ID>/task/api/*`. Every request needs the review
// session; every POST also needs this origin, the CSRF header matching its cookie, a JSON body of at most 16 KB and a
// strict schema. Whoever acts is the session's caller, never anything in the body. Not yours and no such task answer
// the same 404, so the API never confirms a task exists.
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  CommentDocumentSchema, CommentTargetSchema, DECISION_COMMENTS_MAX, PAGE_API_BODY_MAX_BYTES, PAGE_NOTE_MAX_CHARS,
  TaskPeopleRoleRequestSchema, TaskPeopleTakeOwnershipRequestSchema,
  type TaskPeopleChangeResult, type TaskPeopleRoleRequest, type TaskPeopleTakeOwnershipRequest, type TaskPeopleView,
} from "@agentx/contracts";
import type { DeveloperTaskView } from "@agentx/contracts";
import { PROJECT_RECORD_NEEDS_ADMIN } from "./broker-shared.js";
import type { DeveloperCaller } from "./developer-routes.js";
import type { AdaptedHttpRequest } from "./lambda.js";
import type { PageCommentView } from "./plan-page/comments.js";
import type { PlanAnchor } from "./plan-page/render-plan.js";
import { CSRF_COOKIE, SESSION_COOKIE, csrfCookie, isCsrfToken, parseCookie, safeResponse, type WebResponse } from "./web-session.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const TASK_PAGE_API = new RegExp(`^/review/(${UUID})/task/api/(state|comments|comments/(${UUID})/(edit|delete)|suggestions|decision|retry|people|people/role|people/take-ownership|people/requests/(${UUID})(/confirm)?)$`, "i");
/** Any path under the task page's API, known or not: it is the API's to answer, never the PR feedback page's. */
export const TASK_PAGE_API_PREFIX = new RegExp(`^/review/(${UUID})/task/api(/|$)`, "i");

/** Where the task stands, for the open page's poll: no names and no text. */
export interface TaskPageState {
  revision: number;
  /** Whether the current document waits for its owner's decision. */
  waiting: boolean;
  /** The current step's name, as the progress strip spells it. */
  stage: string;
  documents: Array<{ anchor: PlanAnchor; version: number }>;
  /** Moves whenever a comment, reply or suggestion is written. */
  commentSeq: number;
  peopleRevision?: number;
  canRead: boolean;
  canComment: boolean;
  canSuggest: boolean;
  canDecide: boolean;
  canAsk: boolean;
  canManagePeople: boolean;
  canTakeOwnership: boolean;
  /** Read-only E2E projection loaded from the current server-owned CHECKS admission and evidence. */
  e2ePresentation?: DeveloperTaskView["e2ePresentation"];
}

const DecisionIdSchema = z.string().max(4);
const OptionIdSchema = z.string().max(31);

export const PageDecisionInputSchema = z.object({
  requestId: z.string().uuid(),
  expectedRevision: z.number().int().positive(),
  artifactDigest: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(["APPROVE", "REQUEST_CHANGES"]),
  answers: z.array(z.object({ decisionId: DecisionIdSchema, optionId: OptionIdSchema, opened: z.boolean() }).strict()).max(20),
  includedCommentIds: z.array(z.string().uuid()).max(DECISION_COMMENTS_MAX),
  selectedOptionalCheckIds: z.array(z.string().max(64)).max(20).optional(),
  note: z.string().trim().min(1).max(PAGE_NOTE_MAX_CHARS).optional(),
}).strict().superRefine((input, context) => {
  if (new Set(input.answers.map((answer) => answer.decisionId)).size !== input.answers.length) context.addIssue({ code: "custom", path: ["answers"], message: "each decision once" });
  if (new Set(input.includedCommentIds).size !== input.includedCommentIds.length) context.addIssue({ code: "custom", path: ["includedCommentIds"], message: "each comment once" });
});
export type PageDecisionInput = z.infer<typeof PageDecisionInputSchema>;

/** The owner's retry of a blocked browser and API round, from the page: the same re-approval the Slack button makes. Nothing else rides along. */
export const PageRetryInputSchema = z.object({ requestId: z.string().uuid(), expectedRevision: z.number().int().positive() }).strict();
export type PageRetryInput = z.infer<typeof PageRetryInputSchema>;

/** The text's length is checked by the comment store, so the page can say "Keep comments under 2,000 characters." */
const CommentTextSchema = z.string().max(PAGE_API_BODY_MAX_BYTES);

export const PageCommentInputSchema = z.object({
  requestId: z.string().uuid(),
  document: CommentDocumentSchema,
  version: z.number().int().positive(),
  target: CommentTargetSchema,
  parentId: z.string().uuid().optional(),
  text: CommentTextSchema,
  ask: z.boolean(),
}).strict();
export type PageCommentInput = z.infer<typeof PageCommentInputSchema>;
export const PageCommentEditSchema = z.object({ rev: z.number().int().positive(), text: CommentTextSchema }).strict();
export const PageCommentDeleteSchema = z.object({ rev: z.number().int().positive() }).strict();
export const PageSuggestionInputSchema = z.object({ document: CommentDocumentSchema, decisionId: DecisionIdSchema, optionId: OptionIdSchema.nullable() }).strict();
export type PageSuggestionInput = z.infer<typeof PageSuggestionInputSchema>;

export interface TaskWebApiDependencies {
  /** The canonical API origin (or issuer URL); only its origin is used. */
  origin: string;
  authenticateSession(sessionId: string): Promise<DeveloperCaller | undefined>;
  /** Must run the full access check on every call. */
  taskState(caller: DeveloperCaller, taskId: string): Promise<TaskPageState>;
  /** The comments, and the suggestions that still apply (names and "you" only), as the open page refreshes them. */
  listComments(caller: DeveloperCaller, taskId: string): Promise<{ comments: PageCommentView[]; suggestions?: unknown[] }>;
  createComment(caller: DeveloperCaller, taskId: string, input: PageCommentInput): Promise<{ comment: PageCommentView; duplicate?: boolean; askRefused?: string }>;
  editComment(caller: DeveloperCaller, taskId: string, input: { commentId: string; rev: number; text: string }): Promise<{ comment: PageCommentView }>;
  deleteComment(caller: DeveloperCaller, taskId: string, input: { commentId: string; rev: number }): Promise<{ comment: PageCommentView }>;
  setSuggestion(caller: DeveloperCaller, taskId: string, input: PageSuggestionInput): Promise<unknown>;
  /** Must refuse a caller who may not decide with an error carrying `pageReason: "owners_only"`. */
  decide(caller: DeveloperCaller, taskId: string, input: PageDecisionInput): Promise<{ revision: number }>;
  /** Retries a blocked application round (the owner only; any other block is refused) and answers the new revision. Without it, the retry path is not found. */
  retryApplicationRound?(caller: DeveloperCaller, taskId: string, input: PageRetryInput): Promise<{ revision: number }>;
  getPeople?(caller: DeveloperCaller, taskId: string): Promise<TaskPeopleView>;
  proposePeopleRole?(caller: DeveloperCaller, taskId: string, input: TaskPeopleRoleRequest): Promise<TaskPeopleChangeResult>;
  proposeOwnership?(caller: DeveloperCaller, taskId: string, input: TaskPeopleTakeOwnershipRequest): Promise<TaskPeopleChangeResult>;
  getPeopleRequest?(caller: DeveloperCaller, taskId: string, requestId: string): Promise<TaskPeopleChangeResult>;
  confirmPeopleRequest?(caller: DeveloperCaller, taskId: string, requestId: string): Promise<TaskPeopleChangeResult>;
}

const NOT_FOUND = { error: "not_found", message: "You don't have access to this task." };
const HIDDEN = new Set(["FORBIDDEN", "TASK_NOT_FOUND", "TASK_ACCESS_DENIED", "NOT_FOUND"]);
/** Messages the page may show as they are: written for it, in plain words. */
const PAGE_SAFE_MESSAGES = new Set(["Include at least one comment or write a note."]);
const TASK_CHANGED = "This task changed. Refresh the page and try again.";

const json = (statusCode: number, body: unknown): WebResponse => safeResponse(statusCode, body);
const invalid = (message?: string) => json(400, message === undefined ? { error: "invalid_request" } : { error: "invalid_request", message });

/** What a refused action answers: its status, a short code the script reads, and a sentence for the reader. */
function refusalResponse(error: unknown): WebResponse {
  const { code, pageReason, message } = (error ?? {}) as { code?: unknown; pageReason?: unknown; message?: unknown };
  // An AgentXError's message starts with its code ("IDEMPOTENCY_CONFLICT: …"); the reader sees only the sentence.
  const text = typeof message !== "string" ? TASK_CHANGED : typeof code === "string" && message.startsWith(`${code}: `) ? message.slice(code.length + 2) : message;
  switch (pageReason) {
    case "owners_only": return json(403, { error: "owners_only", message: "Only owners decide." });
    case "empty": case "too_long": return invalid(text);
    case "slow_down": return json(429, { error: "slow_down", message: text });
    case "thread_full": case "task_full": return json(409, { error: "full", message: text });
    case "not_yours": case "owners_answer": case "not_allowed": return json(403, { error: "not_allowed", message: text });
    case "not_here": case "closed": case "locked": case "changed": case "gone": case "comment_changed": return json(409, { error: "changed", message: text });
    default: break;
  }
  if (typeof code === "string" && HIDDEN.has(code)) return json(404, NOT_FOUND);
  // The decision's own refusals: who decided and when, or that a newer version is ready (written for the page).
  if (code === "IDEMPOTENCY_CONFLICT") return json(409, { error: "changed", message: text });
  if (code === "CONFIG_INVALID" && text === PROJECT_RECORD_NEEDS_ADMIN) return json(409, { error: "changed", message: text });
  if (code === "CONFIG_INVALID") return PAGE_SAFE_MESSAGES.has(text) ? invalid(text) : json(409, { error: "changed", message: TASK_CHANGED });
  if (code === "TASK_BUSY" || code === "WORKSPACE_BUSY") return json(409, { error: "busy", message: "AgentX is busy with this task. Try again in a minute." });
  return json(503, { error: "unavailable", message: "AgentX couldn't do that right now. Try again shortly." });
}

/** Whether the body is JSON by its declared type: `application/json`, with or without parameters. */
const isJson = (contentType: string | undefined) => contentType !== undefined && /^application\/json\s*(;|$)/i.test(contentType.trim());

export function createTaskWebApi(deps: TaskWebApiDependencies): (request: AdaptedHttpRequest, url: URL) => Promise<WebResponse> {
  const origin = new URL(deps.origin).origin;
  return async (request, url) => {
    const route = TASK_PAGE_API.exec(url.pathname);
    const prefix = TASK_PAGE_API_PREFIX.exec(url.pathname);
    if (prefix === null) return json(404, { error: "not_found" });
    const sessionId = parseCookie(request.headers, SESSION_COOKIE);
    const caller = sessionId === undefined ? undefined : await deps.authenticateSession(sessionId);
    if (caller === undefined) return json(401, { error: "sign_in_required" });
    if (route === null) return json(404, { error: "not_found" });
    const taskId = route[1]!.toLowerCase();
    const commentId = route[3]?.toLowerCase();
    const peopleRequestId = route[5]?.toLowerCase();
    // `comments/<ID>/edit` and `comments/<ID>/delete` are the comments endpoint, for that comment.
    const endpoint = commentId === undefined ? route[2]!.toLowerCase() : "comments";
    const action = route[4]?.toLowerCase();
    const peopleConfirm = route[6] !== undefined;
    const method = request.method.toUpperCase();
    // `state` is read, `comments` is read (GET) and written (POST), everything else is written.
    const allowed = endpoint === "state" || endpoint === "people" || (peopleRequestId !== undefined && !peopleConfirm)
      ? ["GET"] : endpoint === "comments" && commentId === undefined ? ["GET", "POST"] : ["POST"];
    if (!allowed.includes(method)) {
      const refused = json(405, { error: "method_not_allowed" });
      refused.headers.allow = allowed.join(", ");
      return refused;
    }
    try {
      if (method === "GET") {
        if (endpoint === "people") {
          if (deps.getPeople === undefined) return json(404, { error: "not_found" });
          return json(200, await deps.getPeople(caller, taskId));
        }
        if (peopleRequestId !== undefined) {
          if (deps.getPeopleRequest === undefined) return json(404, { error: "not_found" });
          return json(200, await deps.getPeopleRequest(caller, taskId, peopleRequestId));
        }
        if (endpoint === "comments") {
          const listed = await deps.listComments(caller, taskId);
          return json(200, { comments: listed.comments, suggestions: listed.suggestions ?? [] });
        }
        const state = await deps.taskState(caller, taskId);
        const current = parseCookie(request.headers, CSRF_COOKIE);
        const csrf = isCsrfToken(current) ? current : randomBytes(32).toString("base64url");
        const response = json(200, {
          revision: state.revision, waiting: state.waiting, stage: state.stage, documents: state.documents, commentSeq: state.commentSeq,
          ...(state.peopleRevision === undefined ? {} : { peopleRevision: state.peopleRevision }),
          canRead: state.canRead, canComment: state.canComment, canSuggest: state.canSuggest, canDecide: state.canDecide,
          canAsk: state.canAsk, canManagePeople: state.canManagePeople, canTakeOwnership: state.canTakeOwnership, csrf,
          ...(state.e2ePresentation === undefined ? {} : { e2ePresentation: state.e2ePresentation }),
        });
        response.headers["set-cookie"] = csrfCookie(csrf);
        return response;
      }
      const csrf = parseCookie(request.headers, CSRF_COOKIE);
      if (request.headers.origin !== origin || !isCsrfToken(csrf) || request.headers["x-agentx-csrf"] !== csrf) return json(403, { error: "request_refused" });
      if (!isJson(request.headers["content-type"])) return invalid("Send this as JSON.");
      const body = request.body ?? "";
      if (Buffer.byteLength(body, "utf8") > PAGE_API_BODY_MAX_BYTES) return invalid("That is too long to send.");
      let value: unknown;
      try {
        value = JSON.parse(body);
      } catch {
        return invalid();
      }
      if (endpoint === "people/role") {
        if (deps.proposePeopleRole === undefined) return json(404, { error: "not_found" });
        const parsed = TaskPeopleRoleRequestSchema.safeParse(value);
        if (!parsed.success) return invalid();
        const result = await deps.proposePeopleRole(caller, taskId, parsed.data);
        return json(result.status === "PENDING" ? 202 : 200, result);
      }
      if (endpoint === "people/take-ownership") {
        if (deps.proposeOwnership === undefined) return json(404, { error: "not_found" });
        const parsed = TaskPeopleTakeOwnershipRequestSchema.safeParse(value);
        if (!parsed.success) return invalid();
        const result = await deps.proposeOwnership(caller, taskId, parsed.data);
        return json(result.status === "PENDING" ? 202 : 200, result);
      }
      if (peopleRequestId !== undefined && peopleConfirm) {
        if (deps.getPeopleRequest === undefined || deps.confirmPeopleRequest === undefined) return json(404, { error: "not_found" });
        const parsed = z.object({ requestId: z.string().uuid() }).strict().safeParse(value);
        if (!parsed.success || parsed.data.requestId.toLowerCase() !== peopleRequestId) return invalid();
        const receipt = await deps.getPeopleRequest(caller, taskId, peopleRequestId);
        if (receipt.status === "COMMITTED") return json(200, receipt);
        const result = await deps.confirmPeopleRequest(caller, taskId, peopleRequestId);
        return json(result.status === "PENDING" ? 202 : 200, result);
      }
      if (endpoint === "comments" && commentId !== undefined) {
        if (action === "edit") {
          const parsed = PageCommentEditSchema.safeParse(value);
          if (!parsed.success) return invalid();
          return json(200, await deps.editComment(caller, taskId, { commentId, ...parsed.data }));
        }
        const parsed = PageCommentDeleteSchema.safeParse(value);
        if (!parsed.success) return invalid();
        return json(200, await deps.deleteComment(caller, taskId, { commentId, ...parsed.data }));
      }
      if (endpoint === "comments") {
        const parsed = PageCommentInputSchema.safeParse(value);
        if (!parsed.success) return invalid();
        const created = await deps.createComment(caller, taskId, parsed.data);
        return json(created.duplicate === true ? 200 : 201, created);
      }
      if (endpoint === "suggestions") {
        const parsed = PageSuggestionInputSchema.safeParse(value);
        if (!parsed.success) return invalid();
        await deps.setSuggestion(caller, taskId, parsed.data);
        return json(200, { ok: true });
      }
      if (endpoint === "retry") {
        if (deps.retryApplicationRound === undefined) return json(404, { error: "not_found" });
        const parsedRetry = PageRetryInputSchema.safeParse(value);
        if (!parsedRetry.success) return invalid();
        return json(200, await deps.retryApplicationRound(caller, taskId, parsedRetry.data));
      }
      const parsed = PageDecisionInputSchema.safeParse(value);
      if (!parsed.success) return invalid();
      return json(200, await deps.decide(caller, taskId, parsed.data));
    } catch (error) {
      return refusalResponse(error);
    }
  };
}
