// The Linear adapter's own client for a laptop: the owner's Linear API key (a secret read when it is used), and the five things Rovara asks Linear (read an issue, what is asked for now, post a comment,
// move an issue, who the key is). It calls Linear's fixed GraphQL address and nothing else. Rules, each fail closed (ported from the hosted product's Linear writer and search):
//   - the key goes only in the `authorization` header to Linear, no redirect is followed, an answer is read to a cap, and no error carries the key, the request or the text;
//   - a comment's id is made from the company and a stable key the caller gives (`linearCommentIdFor`), and Linear accepts the id the client chooses, so the same post again is the same comment: a lost answer
//     is found by that id and counted as posted, never written twice. The comment is written only when the issue's own link is in the ticket's workspace;
//   - a rate limit (HTTP 429 or a RATELIMITED answer) is waited out as Linear says (`Retry-After`), a bounded number of times and for a bounded time, then it is a TOO_MANY_REQUESTS fault;
//   - who asked comes from Linear's own history of the issue (the newest entry that added the label, or assigned the issue to the key's account), never from the ticket's text. A key that is Rovara's own
//     service account (`ownAccountIsRovara`) makes its acts Rovara's own, which start nothing; a laptop's key is the owner's own account, so its acts are the owner's and Rovara's echo is told apart by the
//     notes Rovara keeps of what it writes.
import { createHash } from "node:crypto";
import { z } from "zod";
import { TrackerSearchError, TrackerWriteRefusedError, TrackerParentSchema, agentXError, type TrackerAskedItem } from "@agentx/contracts";
import { normalizeIssueKey } from "./webhook.js";
import type { LinearCommentRead, LinearIssueRead, LinearReplyPort, LinearStateType, LinearTrackerAccess } from "./index.js";

export const LINEAR_GRAPHQL = "https://api.linear.app/graphql";
/** The most characters one comment holds. */
export const LINEAR_COMMENT_MAX_CHARS = 10_000;
const TIMEOUT_MS = 10_000;
const RESPONSE_MAX_BYTES = 2_000_000;
const BODY_MAX_CHARS = 8_000;
export const LINEAR_RATE_ATTEMPTS = 3;
export const LINEAR_RATE_WAIT_MAX_MS = 8_000;
export const LINEAR_RATE_WAIT_TOTAL_MS = 15_000;
const RATE_WAIT_DEFAULT_MS = 1_000;
const WORKSPACE_KEY = /^[a-z0-9][a-z0-9-]{0,62}$/u;

/** The id Linear is given for a comment: a version 4 UUID made from the company and the caller's stable key, so the same post always has the same id, in every process. */
export function linearCommentIdFor(companyId: string, commentKey: string): string {
  const bytes = createHash("sha256").update(`rovara-linear-comment\0${companyId}\0${commentKey}`, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The workspace url key in an issue's link on linear.app (`https://linear.app/acme/issue/ENG-1/...`), or undefined. */
export function workspaceOfIssueUrl(link: string): string | undefined {
  try {
    const url = new URL(link);
    if (url.protocol !== "https:" || url.hostname !== "linear.app" || url.username !== "" || url.password !== "" || url.port !== "") return undefined;
    const parts = url.pathname.split("/").filter((part) => part !== "");
    return parts[1] === "issue" && WORKSPACE_KEY.test(parts[0]!.toLowerCase()) ? parts[0]!.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

const Envelope = z.object({ data: z.unknown().optional(), errors: z.array(z.unknown()).optional() }).passthrough();
const rec = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const cut = (text: string, max: number): string => [...text].slice(0, max).join("");
const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", "Linear could not be reached just now.");
const rateLimited = () => agentXError("TOO_MANY_REQUESTS", "Linear asked Rovara to slow down.");
const errorCodes = (errors: unknown[]): string[] => errors.map((entry) => str(rec(rec(entry)["extensions"])["code"]) ?? "");
const isRateLimitAnswer = (errors: unknown[]): boolean => errorCodes(errors).includes("RATELIMITED");
const isNotFoundAnswer = (errors: unknown[]): boolean => errors.length > 0 && errors.every((entry) => rec(rec(entry)["extensions"])["code"] === "NOT_FOUND" || /^entity not found\b/iu.test(str(rec(entry)["message"]) ?? ""));
const isPermissionAnswer = (errors: unknown[]): boolean => errors.some((entry) => /forbidden|permission|authentication/iu.test(`${str(rec(rec(entry)["extensions"])["code"]) ?? ""} ${str(rec(entry)["type"]) ?? ""}`));
function waitOf(header: string | null): number {
  if (header === null) return RATE_WAIT_DEFAULT_MS;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(ms) && ms > 0 ? Math.min(Math.ceil(ms), LINEAR_RATE_WAIT_MAX_MS) : RATE_WAIT_DEFAULT_MS;
}

export interface LinearApiOptions {
  /** The owner's Linear API key, read when it is used (`undefined`: none is set up). Never logged, never in an error. */
  apiKey(): Promise<string | undefined>;
  /** The company a call speaks for: part of a comment's id, so two companies never share one. */
  companyId: string;
  /** The key's own account is a service account made for Rovara (its acts are Rovara's own). Default false: a laptop's key is the owner's. */
  ownAccountIsRovara?: boolean;
  fetch?: typeof fetch | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

/** Comments fetched per page, and the most pages one call walks to reach a page (a deeper page is not there). */
export const LINEAR_COMMENTS_PER_PAGE = 100;
export const LINEAR_COMMENT_PAGES_MAX = 5;
/** The cursors kept for the next page of a read in progress (a handful of tickets at a time). */
const COMMENT_CURSORS_MAX = 20;
const COMMENTS_QUERY = `query($id: String!, $first: Int!, $after: String, $filter: CommentFilter) { viewer { id } issue(id: $id) { identifier url comments(first: $first, after: $after, filter: $filter) { pageInfo { hasNextPage endCursor } nodes { id body createdAt updatedAt user { id } botActor { id } } } } }`;
const STATE_TYPES: readonly string[] = ["triage", "backlog", "unstarted", "started", "completed", "canceled"];
const ASKED_QUERY = `query($filter: IssueFilter!, $first: Int!) { viewer { id } issues(first: $first, filter: $filter) { nodes { id identifier title description url project { id name url } parent { id identifier title url }
creator { displayName } labels { nodes { id name } } history(first: 25) { pageInfo { hasNextPage endCursor } nodes { id createdAt actor { id } botActor { id } addedLabelIds removedLabelIds toAssigneeId fromAssigneeId } } } } }`;
const HISTORY_PAGE_QUERY = `query($id: String!, $after: String) { issue(id: $id) { history(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { id createdAt actor { id } botActor { id } addedLabelIds removedLabelIds toAssigneeId fromAssigneeId } } } }`;
/** One issue by id, with who made each change to its labels and assignee (R1 + L1 6.2b: the hosted doorbell reads exactly the issue a delivery names). */
const ISSUE_ASKED_QUERY = `query($id: String!) { viewer { id } issue(id: $id) { id identifier title description url team { id } project { id name url } parent { id identifier title url }
creator { displayName } assignee { id } labels { nodes { id name } } history(first: 25) { pageInfo { hasNextPage endCursor } nodes { id createdAt actor { id } botActor { id } addedLabelIds removedLabelIds toAssigneeId fromAssigneeId } } } }`;
/** The most further pages of one issue's history read to see all of it (100 entries each). An issue with more is not read to the end, so nobody is credited for it. */
export const LINEAR_HISTORY_PAGES_MAX = 5;

/**
 * Who made the act that asks, from an issue's WHOLE history: the entry that last changed the label (or the assignee), whatever order the answer came in (entries are ordered by their own `createdAt`).
 * It is credited only when that last change is an ADD of the label (or the assignment to the key's account): a later removal, a tie, or an entry whose time cannot be read means the label that is on the
 * issue now was put there by something not seen, so nobody is credited and the ticket waits for the owner. `hasMore` (the history was not read to its end) is the same.
 */
export function linearActOf(entries: readonly unknown[], hasMore: boolean, act: { labelIds: ReadonlySet<string>; assignedTo?: string | undefined }): { kind: "bot" | "account"; accountId?: string; at: string; /** Linear's id of the history entry (the change), when it gave one. */ entryId?: string } | undefined {
  if (hasMore) return undefined;
  const touches: Array<{ at: number; add: boolean; entry: Record<string, unknown> }> = [];
  for (const raw of entries) {
    const entry = rec(raw);
    const added = arr(entry["addedLabelIds"]).some((id) => act.labelIds.has(str(id) ?? ""));
    const removed = arr(entry["removedLabelIds"]).some((id) => act.labelIds.has(str(id) ?? ""));
    const assigned = act.assignedTo !== undefined && entry["toAssigneeId"] === act.assignedTo;
    const unassigned = act.assignedTo !== undefined && entry["fromAssigneeId"] === act.assignedTo && entry["toAssigneeId"] !== act.assignedTo;
    if (!added && !removed && !assigned && !unassigned) continue;
    const at = Date.parse(str(entry["createdAt"]) ?? "");
    // A change whose time cannot be read cannot be put in order: nothing is proved.
    if (!Number.isFinite(at)) return undefined;
    touches.push({ at, add: (added || assigned) && !removed && !unassigned, entry });
  }
  if (touches.length === 0) return undefined;
  const latest = Math.max(...touches.map((touch) => touch.at));
  const last = touches.filter((touch) => touch.at === latest);
  // Two changes at the same moment, one of them not an add: nothing is proved.
  if (last.length !== 1 || !last[0]!.add) return undefined;
  const entry = last[0]!.entry;
  const at = new Date(latest).toISOString();
  const entryId = str(entry["id"]);
  const withId = entryId === undefined ? {} : { entryId };
  if (str(rec(entry["botActor"])["id"]) !== undefined) return { kind: "bot", at, ...withId };
  const accountId = str(rec(entry["actor"])["id"]);
  return accountId === undefined ? undefined : { kind: "account", accountId, at, ...withId };
}

/** One workflow status of a Linear team: its type (the broad stage) and its position among the team's statuses. */
export interface LinearWorkflowState { id?: string; name: string; type: string | undefined; position: number | undefined }
const workflowStateOf = (node: Record<string, unknown>): LinearWorkflowState | undefined => {
  const name = str(node["name"]);
  if (name === undefined) return undefined;
  const id = str(node["id"]);
  const type = str(node["type"]);
  return { ...(id === undefined ? {} : { id }), name, type: type !== undefined && STATE_TYPES.includes(type) ? type : undefined, position: typeof node["position"] === "number" && Number.isFinite(node["position"]) ? node["position"] : undefined };
};
/** How far along a state type is (the order Linear's board reads left to right; a finished state is the end). */
const STATE_TYPE_RANK: Readonly<Record<string, number>> = { triage: 0, backlog: 1, unstarted: 2, started: 3, completed: 4, canceled: 4 };
/**
 * Whether moving from `from` to `to` goes forward: by the type's rank, then by the status's position inside the same type ("In Progress" and "In Review" are both `started`). Never out of `completed` or `canceled`.
 * Anything not known (a state with no type or no position) is not forward: fail closed, nothing is written into the customer's workflow on a guess.
 */
export function isForward(from: LinearWorkflowState | undefined, to: LinearWorkflowState): boolean {
  if (from?.type === undefined || to.type === undefined || from.type === "completed" || from.type === "canceled") return false;
  const [now, next] = [STATE_TYPE_RANK[from.type], STATE_TYPE_RANK[to.type]];
  if (now === undefined || next === undefined) return false;
  if (next !== now) return next > now;
  return from.position !== undefined && to.position !== undefined && to.position > from.position;
}

/** What Rovara asks Linear, over the owner's API key: the shape `linearTracker` takes as access. */
export function createLinearApiAccess(options: LinearApiOptions): Required<Pick<LinearTrackerAccess, "reply" | "readIssue" | "asked" | "askedIssue" | "moveIssue" | "listComments">> {
  const fetchImpl = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const ownIsRovara = options.ownAccountIsRovara === true;

  async function call(query: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<{ data: Record<string, unknown> } | { errors: unknown[] }> {
    const key = await options.apiKey();
    if (key === undefined) throw new TrackerWriteRefusedError("not_connected");
    let waited = 0;
    for (let attempt = 1; ; attempt += 1) {
      let text: string;
      let status: number;
      let retryAfter: string | null;
      try {
        const response = await fetchImpl(LINEAR_GRAPHQL, {
          method: "POST", headers: { authorization: key, "content-type": "application/json" }, redirect: "error",
          signal: signal === undefined ? AbortSignal.timeout(TIMEOUT_MS) : AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]), body: JSON.stringify({ query, variables }),
        });
        status = response.status;
        retryAfter = response.headers?.get("retry-after") ?? null;
        text = await response.text();
      } catch {
        // A network error can quote the request: only the fixed words are thrown.
        throw unavailable();
      }
      if (Buffer.byteLength(text, "utf8") > RESPONSE_MAX_BYTES) throw unavailable();
      let envelope: z.infer<typeof Envelope> | undefined;
      try { envelope = Envelope.parse(JSON.parse(text)); } catch { envelope = undefined; }
      if (status === 429 || (envelope?.errors !== undefined && isRateLimitAnswer(envelope.errors))) {
        const wait = waitOf(retryAfter);
        if (attempt >= LINEAR_RATE_ATTEMPTS || waited + wait > LINEAR_RATE_WAIT_TOTAL_MS) throw rateLimited();
        waited += wait;
        await sleep(wait);
        continue;
      }
      if (status === 401 || status === 403) throw new TrackerWriteRefusedError("needs_write_access");
      if (status < 200 || status >= 300 || envelope === undefined) throw unavailable();
      if (envelope.errors !== undefined && envelope.errors.length > 0) return { errors: envelope.errors };
      return { data: rec(envelope.data) };
    }
  }

  const issueOf = async (key: string): Promise<{ id: string; identifier: string; url: string; teamStates: LinearWorkflowState[]; stateName: string; state: LinearWorkflowState | undefined } | undefined> => {
    const read = await call("query($id: String!) { issue(id: $id) { id identifier url state { name type position } team { states(first: 100) { nodes { id name type position } } } } }", { id: key });
    if ("errors" in read) {
      if (isNotFoundAnswer(read.errors)) return undefined;
      if (isPermissionAnswer(read.errors)) throw new TrackerWriteRefusedError("needs_write_access");
      throw unavailable();
    }
    const issue = rec(read.data["issue"]);
    const id = str(issue["id"]);
    const identifier = str(issue["identifier"]);
    const url = str(issue["url"]);
    if (id === undefined || identifier === undefined || url === undefined) return undefined;
    const current = rec(issue["state"]);
    return {
      id, identifier, url, stateName: str(current["name"]) ?? "", state: workflowStateOf(current),
      teamStates: arr(rec(rec(issue["team"])["states"])["nodes"]).map(rec).flatMap((node) => { const state = workflowStateOf(node); return state === undefined ? [] : [state]; }),
    };
  };

  /** A comment as Linear has it: whether it exists, which issue it is on, and (for a reply) its parent. Used to refuse an id that is not on the issue named. */
  const commentOn = async (id: string): Promise<{ issue: string | undefined; parent: string | undefined } | undefined> => {
    const read = await call("query($id: String!) { comment(id: $id) { id issue { identifier } parent { id } } }", { id });
    if ("errors" in read) {
      if (isNotFoundAnswer(read.errors)) return undefined;
      throw unavailable();
    }
    const found = rec(read.data["comment"]);
    if (str(found["id"]) !== id) return undefined;
    return { issue: normalizeIssueKey(str(rec(found["issue"])["identifier"])), parent: str(rec(found["parent"])["id"]) };
  };

  const reply: LinearReplyPort["reply"] = async ({ orgId, issueKey, text, commentKey, workspace, parentId }) => {
    const key = normalizeIssueKey(issueKey);
    const body = text.trim();
    if (key === undefined || body === "") throw agentXError("CONFIG_INVALID", "A comment needs an issue and some words.");
    if (workspace !== undefined && !WORKSPACE_KEY.test(workspace)) throw agentXError("CONFIG_INVALID", "A comment needs a valid workspace.");
    const words = cut(body, LINEAR_COMMENT_MAX_CHARS);
    const commentId = linearCommentIdFor(orgId, commentKey ?? `once:${createHash("sha256").update(`${key}\0${words}`, "utf8").digest("hex")}`);
    const issue = await issueOf(key);
    // An answer for another issue than the one asked about is no answer; and the issue's own link says which workspace it is in.
    if (issue === undefined || normalizeIssueKey(issue.identifier) !== key || (workspace !== undefined && workspaceOfIssueUrl(issue.url) !== workspace)) throw new TrackerWriteRefusedError("not_found");
    // A reply goes in the thread of a comment that is on THIS issue, never another's.
    if (parentId !== undefined) {
      const parent = await commentOn(parentId);
      if (parent === undefined || parent.issue !== key || parent.parent !== undefined) throw new TrackerWriteRefusedError("not_found");
    }
    const created = await call("mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }", { input: { id: commentId, issueId: issue.id, body: words, ...(parentId === undefined ? {} : { parentId }) } });
    if (!("errors" in created) && rec(created.data["commentCreate"])["success"] === true) return { commentId };
    if ("errors" in created && isPermissionAnswer(created.errors)) throw new TrackerWriteRefusedError("needs_write_access");
    // Linear refused or the answer was lost: if a comment with this very id is on this very issue, it is posted (the same post again is the same comment).
    const existing = await call("query($id: String!) { comment(id: $id) { id issue { identifier } } }", { id: commentId });
    const found = "errors" in existing ? undefined : rec(existing.data["comment"]);
    if (found !== undefined && str(found["id"]) === commentId && normalizeIssueKey(str(rec(found["issue"])["identifier"])) === key) return { commentId };
    throw unavailable();
  };

  const edit: NonNullable<LinearReplyPort["edit"]> = async ({ issueKey, commentId, text, workspace }) => {
    const key = normalizeIssueKey(issueKey);
    const body = text.trim();
    if (key === undefined || body === "") throw agentXError("CONFIG_INVALID", "A comment needs an issue and some words.");
    if (workspace !== undefined && !WORKSPACE_KEY.test(workspace)) throw agentXError("CONFIG_INVALID", "A comment needs a valid workspace.");
    const issue = await issueOf(key);
    if (issue === undefined || normalizeIssueKey(issue.identifier) !== key || (workspace !== undefined && workspaceOfIssueUrl(issue.url) !== workspace)) throw new TrackerWriteRefusedError("not_found");
    // Only a comment that is on this very issue is rewritten (Linear lets the key edit its own comments only, and this says which issue they are on).
    const found = await commentOn(commentId);
    if (found === undefined || found.issue !== key) throw new TrackerWriteRefusedError("not_found");
    const written = await call("mutation($id: String!, $input: CommentUpdateInput!) { commentUpdate(id: $id, input: $input) { success } }", { id: commentId, input: { body: cut(body, LINEAR_COMMENT_MAX_CHARS) } });
    if (!("errors" in written) && rec(written.data["commentUpdate"])["success"] === true) return;
    if ("errors" in written && isPermissionAnswer(written.errors)) throw new TrackerWriteRefusedError("needs_write_access");
    throw unavailable();
  };

  const readIssue: NonNullable<LinearTrackerAccess["readIssue"]> = async (_orgId, key) => {
    const answer = await call("query($id: String!) { issue(id: $id) { identifier title description url updatedAt state { type } assignee { displayName } labels { nodes { name } } project { id name url } parent { id identifier title url } } }", { id: key });
    if ("errors" in answer) {
      if (isNotFoundAnswer(answer.errors)) return undefined;
      throw unavailable();
    }
    const issue = rec(answer.data["issue"]);
    const identifier = str(issue["identifier"]);
    const url = str(issue["url"]);
    if (identifier === undefined || url === undefined) return undefined;
    const type = str(rec(issue["state"])["type"]);
    const read: LinearIssueRead = {
      key: identifier, title: str(issue["title"]) ?? identifier, description: str(issue["description"]) ?? "", stateType: (type !== undefined && STATE_TYPES.includes(type) ? type : "unstarted") as LinearStateType, url,
      labels: arr(rec(issue["labels"])["nodes"]).map((node) => str(rec(node)["name"])).filter((name): name is string => name !== undefined),
      ...(str(rec(issue["assignee"])["displayName"]) === undefined ? {} : { assignee: str(rec(issue["assignee"])["displayName"])! }),
      ...(str(issue["updatedAt"]) === undefined ? {} : { updatedAt: str(issue["updatedAt"])! }),
      ...(str(rec(issue["project"])["id"]) !== undefined ? { project: { id: str(rec(issue["project"])["id"])!, name: cut(str(rec(issue["project"])["name"]) ?? "", 200), ...(str(rec(issue["project"])["url"]) === undefined ? {} : { url: str(rec(issue["project"])["url"])! }) } } : {}),
      ...(str(rec(issue["parent"])["id"]) !== undefined ? { parent: { id: str(rec(issue["parent"])["id"])!, title: cut(str(rec(issue["parent"])["title"]) ?? "", 200), ...(str(rec(issue["parent"])["url"]) === undefined ? {} : { url: str(rec(issue["parent"])["url"])! }) } } : {}),
    };
    return read;
  };

  /**
   * One page of an issue's comments (L4-SRC-TK, fetch only): at most `LINEAR_COMMENTS_PER_PAGE`, those created after `since` when it is given. A page past the first is reached by walking Linear's cursors, so pages are honest
   * and numbered from 1. An author is `isBot` for an app actor (`botActor`), for a comment with no user, and, when the key is Rovara's own account, for that account (the viewer). An issue that is not found has no comments.
   */
  const commentCursors = new Map<string, { page: number; after: string }>();
  const listComments: NonNullable<LinearTrackerAccess["listComments"]> = async (_orgId, key, query) => {
    const issueKey = normalizeIssueKey(key);
    if (issueKey === undefined) return undefined;
    // A caller that reads page after page (the lessons' ticket source does) costs one request per page, not one more each time: the cursor that ends a page is remembered for the next page of the same read.
    const wanted = query.page ?? 1;
    const memoKey = `${issueKey}\0${query.since ?? ""}`;
    const known = commentCursors.get(memoKey);
    let page = known !== undefined && known.page <= wanted ? known.page : 1;
    let after: string | null = known !== undefined && known.page <= wanted ? known.after : null;
    for (; page <= LINEAR_COMMENT_PAGES_MAX; page += 1) {
      const answer = await call(COMMENTS_QUERY, { id: issueKey, first: LINEAR_COMMENTS_PER_PAGE, after, filter: query.since === undefined ? null : { createdAt: { gt: query.since } } });
      if ("errors" in answer) {
        if (isNotFoundAnswer(answer.errors)) return undefined;
        if (isPermissionAnswer(answer.errors)) throw new TrackerWriteRefusedError("needs_write_access");
        throw unavailable();
      }
      const issue = rec(answer.data["issue"]);
      // An answer for another issue than the one asked about is no answer.
      if (normalizeIssueKey(str(issue["identifier"])) !== issueKey) return undefined;
      // The issue key repeats across workspaces: when the caller names the workspace the ticket is in, an issue of another workspace is no answer.
      if (query.workspace !== undefined && workspaceOfIssueUrl(str(issue["url"]) ?? "") !== query.workspace) return undefined;
      const connection = rec(issue["comments"]);
      const more = rec(connection["pageInfo"])["hasNextPage"] === true;
      const cursor = str(rec(connection["pageInfo"])["endCursor"]);
      if (page < wanted) {
        // Walking to the page asked for: a connection that says there is more but gives no cursor cannot be walked (the page is not there).
        if (!more || cursor === undefined) return { comments: [] };
        after = cursor;
        continue;
      }
      const viewer = ownIsRovara ? str(rec(answer.data["viewer"])["id"]) : undefined;
      const comments: LinearCommentRead[] = [];
      for (const raw of arr(connection["nodes"]).slice(0, LINEAR_COMMENTS_PER_PAGE)) {
        const node = rec(raw);
        const id = str(node["id"]);
        const createdAt = str(node["createdAt"]);
        const updatedAt = str(node["updatedAt"]) ?? createdAt;
        if (id === undefined || createdAt === undefined || updatedAt === undefined) continue;
        const accountId = str(rec(node["user"])["id"]);
        const isBot = str(rec(node["botActor"])["id"]) !== undefined || accountId === undefined || (viewer !== undefined && accountId === viewer);
        comments.push({ id, ...(accountId === undefined ? {} : { accountId }), isBot, body: cut(str(node["body"]) ?? "", LINEAR_COMMENT_MAX_CHARS), createdAt, updatedAt });
      }
      if (more && cursor !== undefined) {
        if (commentCursors.size >= COMMENT_CURSORS_MAX) commentCursors.delete(commentCursors.keys().next().value!);
        commentCursors.set(memoKey, { page: page + 1, after: cursor });
      }
      return { comments, ...(more ? { nextPage: page + 1 } : {}) };
    }
    return { comments: [] };
  };

  /** An issue's history in full (the first page came with it; the rest is read, a few pages at most): `more` is true when it was not read to its end, and then nobody is credited. */
  const historyOf = async (issue: Record<string, unknown>, fallbackId: string, signal: AbortSignal): Promise<{ entries: unknown[]; more: boolean }> => {
    let entries = arr(rec(issue["history"])["nodes"]);
    let more = rec(rec(issue["history"])["pageInfo"])["hasNextPage"] !== false;
    let after = str(rec(rec(issue["history"])["pageInfo"])["endCursor"]);
    for (let page = 0; more && page < LINEAR_HISTORY_PAGES_MAX; page += 1) {
      const next = await call(HISTORY_PAGE_QUERY, { id: str(issue["id"]) ?? fallbackId, after: after ?? null }, signal).catch(() => undefined);
      const history = next === undefined || "errors" in next ? undefined : rec(rec(next.data["issue"])["history"]);
      if (history === undefined) break;
      entries = [...entries, ...arr(history["nodes"])];
      more = rec(history["pageInfo"])["hasNextPage"] === true;
      after = str(rec(history["pageInfo"])["endCursor"]);
      if (!more) break;
    }
    return { entries, more };
  };
  const parentOf = (issue: Record<string, unknown>): { parent?: TrackerAskedItem["parent"] } => {
    const project = rec(issue["project"]), parentIssue = rec(issue["parent"]);
    const raw = str(project["id"]) === undefined
      ? { kind: "parent_issue", id: str(parentIssue["id"]), title: cut(str(parentIssue["title"]) ?? "", 200), url: str(parentIssue["url"]) }
      : { kind: "project", id: str(project["id"]), title: cut(str(project["name"]) ?? "", 200), url: str(project["url"]) };
    const parsed = TrackerParentSchema.safeParse(raw);
    return parsed.success ? { parent: parsed.data } : {};
  };
  const actorOf = (found: ReturnType<typeof linearActOf>, viewer: string | undefined, tenant: string): TrackerAskedItem["actor"] =>
    found === undefined ? undefined : found.kind === "bot" ? { kind: "bot" } : found.accountId === viewer && ownIsRovara ? { kind: "rovara" } : { kind: "person", account: { provider: "linear", tenant, accountId: found.accountId! } };

  const asked: NonNullable<LinearTrackerAccess["asked"]> = async ({ label, assignedToRovara, limit, signal }) => {
    const wanted: unknown[] = [];
    const open = { state: { type: { nin: ["completed", "canceled"] } } };
    if (label !== undefined) wanted.push({ labels: { name: { eqIgnoreCase: label } } });
    // "Assigned to Rovara" is "assigned to the key's own account": its id is read with the issues (the viewer), so the filter asks for it by that id.
    let viewerId: string | undefined;
    if (assignedToRovara === true) {
      const me = await call("query { viewer { id } }", {}, signal);
      viewerId = "errors" in me ? undefined : str(rec(me.data["viewer"])["id"]);
      if (viewerId === undefined) throw new TrackerSearchError("CONNECTION_REFUSED");
      wanted.push({ assignee: { id: { eq: viewerId } } });
    }
    if (wanted.length === 0) return [];
    const answer = await call(ASKED_QUERY, { first: Math.min(limit, 50), filter: { ...open, or: wanted } }, signal).catch((error: unknown) => {
      if (error instanceof TrackerWriteRefusedError) throw new TrackerSearchError(error.reason === "not_connected" ? "CONNECTION_MISSING" : "CONNECTION_REFUSED");
      if (error instanceof Error && (error as { code?: string }).code === "TOO_MANY_REQUESTS") throw new TrackerSearchError("RATE_LIMITED");
      throw new TrackerSearchError("SEARCH_FAILED");
    });
    if ("errors" in answer) throw new TrackerSearchError(isRateLimitAnswer(answer.errors) ? "RATE_LIMITED" : isPermissionAnswer(answer.errors) ? "CONNECTION_REFUSED" : "SEARCH_FAILED");
    const viewer = str(rec(answer.data["viewer"])["id"]) ?? viewerId;
    const items: TrackerAskedItem[] = [];
    for (const raw of arr(rec(answer.data["issues"])["nodes"]).slice(0, limit)) {
      const issue = rec(raw);
      const identifier = str(issue["identifier"]);
      const url = str(issue["url"]);
      if (identifier === undefined || url === undefined || normalizeIssueKey(identifier) === undefined) continue;
      const labelIds = new Set(arr(rec(issue["labels"])["nodes"]).filter((node) => label !== undefined && str(rec(node)["name"])?.toLowerCase() === label.toLowerCase()).flatMap((node) => str(rec(node)["id"]) ?? []));
      // Who did it: the entry that LAST changed the label (or the assignment), from the issue's whole history. A history cut short (more than a few pages), a newer removal or a tie credits nobody.
      const { entries, more } = await historyOf(issue, identifier, signal);
      const found = linearActOf(entries, more, { labelIds, ...(assignedToRovara === true && viewer !== undefined ? { assignedTo: viewer } : {}) });
      const actor = actorOf(found, viewer, "");
      items.push({
        ref: { tracker: "linear", id: normalizeIssueKey(identifier)!, url },
        title: cut(str(issue["title"]) ?? identifier, 300), body: cut(str(issue["description"]) ?? "", BODY_MAX_CHARS),
        ...(str(rec(issue["creator"])["displayName"]) === undefined ? {} : { reporter: str(rec(issue["creator"])["displayName"])! }),
        ...(actor === undefined ? {} : { actor }),
        ...(found === undefined ? {} : { occurredAt: found.at }),
        ...parentOf(issue),
      });
    }
    return items;
  };

  /**
   * One issue by id for the hosted doorbell (R1 + L1 6.2b): its team as LINEAR says (never a delivery body's word), and, when it asks for work NOW (it carries `label`, or it is assigned to this token's own account), the item with who
   * made the latest such act, when, and the history entry (the change) that was. An act whose history was not read to its end, or was undone, credits nobody and carries no change. `workspace` is the connected workspace's id, stamped on the
   * actor's account (the link rows are per workspace). Undefined: no such issue.
   */
  const askedIssue: NonNullable<LinearTrackerAccess["askedIssue"]> = async ({ issueId, label, workspace, signal }) => {
    const answer = await call(ISSUE_ASKED_QUERY, { id: issueId }, signal).catch((error: unknown) => {
      if (error instanceof TrackerWriteRefusedError) throw new TrackerSearchError(error.reason === "not_connected" ? "CONNECTION_MISSING" : "CONNECTION_REFUSED");
      if (error instanceof Error && (error as { code?: string }).code === "TOO_MANY_REQUESTS") throw new TrackerSearchError("RATE_LIMITED");
      throw new TrackerSearchError("SEARCH_FAILED");
    });
    if ("errors" in answer) {
      if (isNotFoundAnswer(answer.errors)) return undefined;
      throw new TrackerSearchError(isRateLimitAnswer(answer.errors) ? "RATE_LIMITED" : isPermissionAnswer(answer.errors) ? "CONNECTION_REFUSED" : "SEARCH_FAILED");
    }
    const issue = rec(answer.data["issue"]);
    const identifier = str(issue["identifier"]);
    const url = str(issue["url"]);
    const teamId = str(rec(issue["team"])["id"]);
    if (identifier === undefined || url === undefined || teamId === undefined || normalizeIssueKey(identifier) === undefined) return undefined;
    const viewer = str(rec(answer.data["viewer"])["id"]);
    const labelIds = new Set(arr(rec(issue["labels"])["nodes"]).filter((node) => str(rec(node)["name"])?.toLowerCase() === label.toLowerCase()).flatMap((node) => str(rec(node)["id"]) ?? []));
    const assigned = viewer !== undefined && str(rec(issue["assignee"])["id"]) === viewer;
    if (labelIds.size === 0 && !assigned) return { teamId, item: undefined };
    const { entries, more } = await historyOf(issue, identifier, signal);
    // Each kind of act on its own (a later removal of one does not hide the other), then the latest of the two that still stand.
    const byLabel = labelIds.size === 0 ? undefined : linearActOf(entries, more, { labelIds });
    const byAssignment = !assigned ? undefined : linearActOf(entries, more, { labelIds: new Set(), assignedTo: viewer });
    const chosen = [byLabel === undefined ? undefined : { found: byLabel, act: { kind: "label" as const, value: label } }, byAssignment === undefined ? undefined : { found: byAssignment, act: { kind: "assignee" as const, value: "rovara" } }]
      .flatMap((entry) => (entry === undefined ? [] : [entry])).sort((a, b) => Date.parse(b.found.at) - Date.parse(a.found.at))[0];
    const actor = actorOf(chosen?.found, viewer, workspace);
    const reporter = str(rec(issue["creator"])["displayName"]);
    return { teamId, item: {
      ref: { tracker: "linear", id: normalizeIssueKey(identifier)!, url }, title: cut(str(issue["title"]) ?? identifier, 300), body: cut(str(issue["description"]) ?? "", BODY_MAX_CHARS),
      ...(reporter === undefined ? {} : { reporter }), ...(actor === undefined ? {} : { actor }),
      ...(chosen === undefined ? {} : { occurredAt: chosen.found.at }),
      ...(chosen?.found.entryId === undefined ? {} : { change: { id: chosen.found.entryId, act: chosen.act } }),
      ...parentOf(issue),
    } };
  };

  const moveIssue: NonNullable<LinearTrackerAccess["moveIssue"]> = async (key, statusName, workspace) => {
    const issue = await issueOf(key);
    // An issue of another workspace than the ticket's own is no issue (the company reconnected to another workspace, where the same key is an unrelated issue): refused, nothing moved.
    if (issue === undefined || (workspace !== undefined && workspaceOfIssueUrl(issue.url) !== workspace)) throw new TrackerWriteRefusedError("not_found");
    if (issue.stateName.toLowerCase() === statusName.toLowerCase()) return "moved";
    const target = issue.teamStates.find((node) => node.name.toLowerCase() === statusName.toLowerCase());
    if (target === undefined) return "no_such_status";
    // Forward only: a ticket is never moved out of a finished state, and never back to an earlier one (a person who moved it further, or a merge that already closed it, is left as they put it).
    if (!isForward(issue.state, target)) return "not_forward";
    const written = await call("mutation($id: String!, $state: String!) { issueUpdate(id: $id, input: { stateId: $state }) { success } }", { id: issue.id, state: target.id });
    if (!("errors" in written) && rec(written.data["issueUpdate"])["success"] === true) return "moved";
    // A permission answer is Linear refusing the write; anything else may pass.
    if ("errors" in written && isPermissionAnswer(written.errors)) throw new TrackerWriteRefusedError("needs_write_access");
    throw unavailable();
  };

  return { reply: { reply, edit }, readIssue, asked, askedIssue, moveIssue, listComments };
}
