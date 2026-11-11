// The Jira Tracker adapter for a laptop (a second adapter beside Linear; it brings its own client, `JiraApiOptions`). It reads Jira Cloud through the owner's own account (an email and an API token, the token a
// secret read when it is used) and calls only the owner's Atlassian site. What it does, ported from the hosted product's Jira writer and search:
//   - `askedFor`    open issues with the label (or assigned to the key's account), each with the change-log entry that made the act: the account is the NEWEST entry's author, only an `atlassian` account is a
//                   person, an `app` is a bot, and a service-desk customer or an account type Jira does not say is nobody (no actor, so the ticket waits). The account is `{ provider: "jira", tenant: <site host>,
//                   accountId }`, since a Jira account id is unique per site, and the entry's own id is the change that is claimed once;
//   - `comment`     one comment per key: the newest comments are read first, and one that carries the key's marker AND was written by the key's own account means an earlier try was posted, so it is not posted
//                   again. For a task only its owner can see the comment is internal (never shown to a service-desk customer);
//   - `setStatusByName`  the transition whose target (or name) is the status named;
//   - `readItem`    the issue as Jira has it now.
// Every key goes only to the owner's site, no redirect is followed, an answer is read to a cap, and no error carries the key or the text. A rate limit or a fault that may pass THROWS; a refusal (401/403,
// no such issue) is a `TrackerWriteRefusedError`, so a ticket that cannot be written never fails the task. Jira sends no webhook here: the adapter has no `events`.
import { createHash } from "node:crypto";
import {
  TrackerItemSchema, TrackerSearchError, TrackerWriteRefusedError, agentXError, HostScopeSchema,
  type HostScope, type NeutralStatus, type Tracker, type TrackerAskedItem, type TrackerAskedQuery, type TrackerCapabilities, type TrackerCommentOptions, type TrackerItem, type TrackerItemRef, type UntrustedText,
} from "@agentx/contracts";

export const JIRA_TRACKER_KIND = "jira";
/** The comment property that marks Rovara's update (its value is a hash of the update's key, nothing else). */
export const JIRA_MARKER_PROPERTY = "rovara.ticket-update";
export const JIRA_KEY = /^[A-Z][A-Z0-9_]{0,30}-[1-9][0-9]{0,9}$/u;
const ATLASSIAN_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.atlassian\.net$/u;
const JIRA_LABEL = /^[^"\\\p{Cc}]{1,100}$/u;
const TIMEOUT_MS = 10_000;
const RESPONSE_MAX_BYTES = 2_000_000;
const BODY_MAX_CHARS = 8_000;
const COMMENT_MAX_CHARS = 10_000;

/** The owner's Jira site as an origin (`https://acme.atlassian.net`), or undefined for any other address: a key is only ever sent to an Atlassian site, over https, with no sign-in data or port. */
export function jiraSiteOf(address: string | undefined): string | undefined {
  if (address === undefined) return undefined;
  try {
    const url = new URL(address);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && url.username === "" && url.password === "" && url.port === "" && ATLASSIAN_HOST.test(host) ? `https://${host}` : undefined;
  } catch {
    return undefined;
  }
}

export interface JiraApiOptions {
  /** The owner's Atlassian site (`https://acme.atlassian.net`). */
  site: string;
  /** The account's email, for basic sign-in. */
  email: string;
  /** The account's API token, read when it is used (`undefined`: none is set up). Never logged, never in an error. */
  apiToken(): Promise<string | undefined>;
  /** The token's account is a service account made for Rovara (its acts are Rovara's own, and start nothing). Default false: a laptop's token is the owner's. */
  ownAccountIsRovara?: boolean;
  fetch?: typeof fetch | undefined;
}

const rec = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const lower = (value: unknown): string => (typeof value === "string" ? value.toLowerCase() : "");
const cut = (text: string, max: number): string => [...text].slice(0, max).join("");
const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", "Jira could not be reached just now.");
const rateLimited = () => agentXError("TOO_MANY_REQUESTS", "Jira asked Rovara to slow down.");
const refused = (status: number): boolean => status === 401 || status === 403;

/** The plain text of a Jira description (Atlassian Document Format): its text nodes, a line per block, cut. */
export function adfText(node: unknown, depth = 0): string {
  if (depth > 20) return "";
  const value = rec(node);
  if (value["type"] === "text" && typeof value["text"] === "string") return value["text"];
  const inner = arr(value["content"]).map((child) => adfText(child, depth + 1)).join("");
  return value["type"] === "paragraph" || value["type"] === "heading" || value["type"] === "listItem" ? `${inner}\n` : inner;
}

/** Jira's change-log field for the new value (read by a variable key: the literal would read as Object's own method). */
const TO_STRING: string = "toString";

/** Whether an entry of a change log took the label off or put it on: a label is in a change's old text and not in its new one (removed), or the other way (added). Jira writes labels as words with spaces between. */
function labelChange(change: Record<string, unknown>, label: string): "added" | "removed" | undefined {
  const words = (text: unknown): string[] => (str(text) ?? "").split(" ").filter((word) => word !== "");
  const before = words(change["fromString"]).includes(label);
  const after = words(change[TO_STRING]).includes(label);
  return after && !before ? "added" : before && !after ? "removed" : undefined;
}

/**
 * Who made the act, from a COMPLETE Jira change log: the change that LAST touched the label (or the assignee), whatever order the answer came in (changes are ordered by their own time). It is credited only
 * when that last change put the label on, or set the assignee to `act.value` (or to the key's own account `me`, for a source watching assignment): a later removal, a tie, or a change whose time cannot be
 * read means the label that is on the issue now was put there by something not seen, so nobody is credited and the ticket waits for the owner. Only an `atlassian` account is a person; an `app` is a bot; a
 * service-desk `customer` or an account type Jira does not say is nobody. With `meIsRovara`, the key's own account is Rovara's own.
 */
export function jiraActOf(histories: readonly unknown[], act: { kind: "label" | "assignee"; value: string } | undefined, site: string, me?: string, meIsRovara = false): { actor?: TrackerAskedItem["actor"]; changeId?: string; at?: string } {
  const touches: Array<{ at: number; add: boolean; entry: Record<string, unknown> }> = [];
  for (const raw of histories) {
    const entry = rec(raw);
    let add = false;
    let touched = false;
    for (const item of arr(entry["items"])) {
      const c = rec(item);
      if (act?.kind === "label" && c["field"] === "labels") {
        const changed = labelChange(c, act.value);
        if (changed === undefined) continue;
        touched = true;
        add = changed === "added";
      } else if (c["field"] === "assignee") {
        const target = act?.kind === "assignee" ? act.value : me;
        if (target === undefined || (c["to"] !== target && c["from"] !== target)) continue;
        touched = true;
        add = c["to"] === target;
      }
    }
    if (!touched) continue;
    const at = Date.parse(str(entry["created"]) ?? "");
    // A change whose time cannot be read cannot be put in order: nothing is proved.
    if (!Number.isFinite(at)) return {};
    touches.push({ at, add, entry });
  }
  if (touches.length === 0) return {};
  const latest = Math.max(...touches.map((touch) => touch.at));
  const last = touches.filter((touch) => touch.at === latest);
  if (last.length !== 1 || !last[0]!.add) return {};
  const entry = last[0]!.entry;
  const author = rec(entry["author"]);
  const accountId = str(author["accountId"]);
  const at = new Date(latest).toISOString();
  if (author["accountType"] === "app") return { actor: { kind: "bot" }, at };
  if (author["accountType"] !== "atlassian" || accountId === undefined) return {};
  const id = typeof entry["id"] === "string" || typeof entry["id"] === "number" ? String(entry["id"]) : undefined;
  return { actor: accountId === me && meIsRovara ? { kind: "rovara" } : { kind: "person", account: { provider: JIRA_TRACKER_KIND, tenant: new URL(site).hostname, accountId } }, at, ...(id === undefined ? {} : { changeId: id }) };
}

/** The most pages (100 changes each) of one issue's change log read to see all of it. An issue with more is not read to the end, so nobody is credited for it. */
export const JIRA_CHANGELOG_PAGES_MAX = 10;

const NEUTRAL_OF_CATEGORY: Readonly<Record<string, NeutralStatus>> = { new: "open", indeterminate: "in_progress", done: "done" };

function checkedScope(scope: HostScope): void {
  if (!HostScopeSchema.safeParse(scope).success) throw agentXError("CONFIG_INVALID", "the plug-in call has no valid scope");
}

/** The issue key an item ref names; a ref of another tracker, or an id that is not a Jira key, is refused (the key is never taken from free text). */
function keyOf(ref: TrackerItemRef): string {
  if (ref.tracker !== JIRA_TRACKER_KIND) throw agentXError("CONFIG_INVALID", "the item belongs to another tracker");
  if (!JIRA_KEY.test(ref.id)) throw agentXError("CONFIG_INVALID", "the item id is not a Jira issue key");
  return ref.id;
}

export function jiraTracker(options: JiraApiOptions): Tracker {
  const site = jiraSiteOf(options.site);
  if (site === undefined) throw agentXError("CONFIG_INVALID", "the Jira site must be an https address on atlassian.net");
  const fetchImpl = options.fetch ?? fetch;
  const meIsRovara = options.ownAccountIsRovara === true;

  async function call(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<{ status: number; body: unknown }> {
    const token = await options.apiToken();
    if (token === undefined) throw new TrackerWriteRefusedError("not_connected");
    let response: Response;
    try {
      response = await fetchImpl(`${site}${path}`, {
        method: init.method ?? "GET",
        headers: { authorization: `Basic ${Buffer.from(`${options.email}:${token}`).toString("base64")}`, accept: "application/json", ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
        redirect: "error", signal: init.signal === undefined ? AbortSignal.timeout(TIMEOUT_MS) : AbortSignal.any([init.signal, AbortSignal.timeout(TIMEOUT_MS)]), ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch {
      // A network error can quote the request: only the fixed words are thrown.
      throw unavailable();
    }
    if (response.status === 429) throw rateLimited();
    if (response.status >= 500) throw unavailable();
    const text = await response.text().catch(() => { throw unavailable(); });
    if (Buffer.byteLength(text, "utf8") > RESPONSE_MAX_BYTES) throw unavailable();
    let body: unknown;
    try { body = text === "" ? undefined : JSON.parse(text); } catch { body = undefined; }
    return { status: response.status, body };
  }


  /**
   * The issue's whole change log, or undefined when it cannot be shown to be whole. The log that came with the search is used only when it says how many changes there are (`total`) and holds that many; any other
   * answer is read again, a page at a time, from the change log's own address, until its last page (at most `JIRA_CHANGELOG_PAGES_MAX`).
   */
  async function fullHistory(issue: Record<string, unknown>, key: string, signal: AbortSignal): Promise<unknown[] | undefined> {
    const embedded = rec(issue["changelog"]);
    const histories = arr(embedded["histories"]);
    if (typeof embedded["total"] === "number" && embedded["startAt"] === 0 && histories.length >= embedded["total"]) return histories;
    const all: unknown[] = [];
    for (let page = 0, startAt = 0; page < JIRA_CHANGELOG_PAGES_MAX; page += 1) {
      const answer = await call(`/rest/api/3/issue/${encodeURIComponent(key)}/changelog?startAt=${String(startAt)}&maxResults=100`, { signal });
      if (answer.status !== 200) return undefined;
      const body = rec(answer.body);
      const values = arr(body["values"]);
      all.push(...values);
      if (body["isLast"] === true) return all;
      if (values.length === 0) return undefined;
      startAt += values.length;
    }
    return undefined;
  }

  const capabilities: TrackerCapabilities = { startTasks: true, comment: true, status: true, link: false, events: "poll", intake: true };

  const tracker: Tracker = {
    kind: JIRA_TRACKER_KIND,
    capabilities,
    async readItem(ref: TrackerItemRef, scope: HostScope): Promise<TrackerItem> {
      checkedScope(scope);
      const key = keyOf(ref);
      const answer = await call(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,status,assignee,labels,updated`);
      if (answer.status === 404 || refused(answer.status)) throw agentXError("RUNTIME_UNAVAILABLE", "the tracker has no such item");
      if (answer.status !== 200) throw unavailable();
      const issue = rec(answer.body);
      const fields = rec(issue["fields"]);
      if (str(issue["key"]) !== key) throw agentXError("RUNTIME_UNAVAILABLE", "the tracker has no such item");
      const category = str(rec(rec(fields["status"])["statusCategory"])["key"]);
      return TrackerItemSchema.parse({
        ref: { tracker: JIRA_TRACKER_KIND, id: key, url: `${site}/browse/${key}` },
        title: cut(str(fields["summary"]) ?? key, 1_000), body: cut(adfText(fields["description"]), 65_536),
        status: (category !== undefined ? NEUTRAL_OF_CATEGORY[category] : undefined) ?? "open",
        ...(str(rec(fields["assignee"])["displayName"]) === undefined ? {} : { assignee: cut(str(rec(fields["assignee"])["displayName"])!, 200) }),
        labels: arr(fields["labels"]).filter((label): label is string => typeof label === "string" && label !== "").slice(0, 100).map((label) => cut(label, 200)),
        ...(str(fields["updated"]) === undefined || Number.isNaN(Date.parse(str(fields["updated"])!)) ? {} : { updatedAt: new Date(str(fields["updated"])!).toISOString() }),
      });
    },

    async comment(ref: TrackerItemRef, body: UntrustedText, scope: HostScope, commentOptions?: TrackerCommentOptions): Promise<void> {
      checkedScope(scope);
      const key = keyOf(ref);
      if (body.length === 0 || body.length > COMMENT_MAX_CHARS) throw agentXError("CONFIG_INVALID", "the comment is empty or too long");
      const path = `/rest/api/3/issue/${encodeURIComponent(key)}/comment`;
      // Each update carries a marker (a property holding a hash of its key). Before posting, the newest comments are read; one with the marker means an earlier try was posted (its answer was lost), so it
      // is not posted again.
      const marker = createHash("sha256").update(commentOptions?.key ?? `once:${key}:${body}`).digest("hex").slice(0, 32);
      const recent = await call(`${path}?orderBy=-created&maxResults=50&expand=properties`);
      if (refused(recent.status)) throw new TrackerWriteRefusedError("needs_write_access");
      if (recent.status === 404) throw new TrackerWriteRefusedError("not_found");
      if (recent.status !== 200) throw unavailable();
      // Only a comment the key's OWN account wrote counts, so someone else's comment carrying the marker cannot hold ours back.
      const me = await call("/rest/api/3/myself").then((answer) => (answer.status === 200 ? str(rec(answer.body)["accountId"]) : undefined));
      const already = me !== undefined && arr(rec(recent.body)["comments"]).some((comment) => rec(rec(comment)["author"])["accountId"] === me
        && arr(rec(comment)["properties"]).some((property) => rec(property)["key"] === JIRA_MARKER_PROPERTY && rec(rec(property)["value"])["id"] === marker));
      if (already) return;
      const paragraphs = body.split("\n").filter((line) => line !== "").map((line) => ({ type: "paragraph", content: [{ type: "text", text: line }] }));
      // For a task only its owner can see, the comment is internal, so a Jira Service Management customer never sees it (a plain Jira project ignores the property).
      const properties = [{ key: JIRA_MARKER_PROPERTY, value: { id: marker } }, ...(commentOptions?.requirePrivate === true ? [{ key: "sd.public.comment", value: { internal: true } }] : [])];
      const answer = await call(path, { method: "POST", body: { body: { type: "doc", version: 1, content: paragraphs }, properties } });
      if (refused(answer.status)) throw new TrackerWriteRefusedError("needs_write_access");
      if (answer.status === 404) throw new TrackerWriteRefusedError("not_found");
      if (answer.status !== 201 && answer.status !== 200) throw unavailable();
    },

    async setStatusByName(ref: TrackerItemRef, name: string, scope: HostScope): Promise<"moved" | "no_such_status"> {
      checkedScope(scope);
      const key = keyOf(ref);
      const path = `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`;
      const listed = await call(path);
      if (refused(listed.status)) throw new TrackerWriteRefusedError("needs_write_access");
      if (listed.status === 404) throw new TrackerWriteRefusedError("not_found");
      if (listed.status !== 200) throw unavailable();
      const wanted = name.toLowerCase();
      const transition = arr(rec(listed.body)["transitions"]).map(rec).find((entry) => lower(rec(entry["to"])["name"]) === wanted || lower(entry["name"]) === wanted);
      if (transition === undefined || typeof transition["id"] !== "string") return "no_such_status";
      const moved = await call(path, { method: "POST", body: { transition: { id: transition["id"] } } });
      if (refused(moved.status)) throw new TrackerWriteRefusedError("needs_write_access");
      if (moved.status === 404) throw new TrackerWriteRefusedError("not_found");
      if (moved.status !== 204 && moved.status !== 200) throw unavailable();
      return "moved";
    },

    async askedFor(query: TrackerAskedQuery, scope: HostScope): Promise<readonly TrackerAskedItem[]> {
      checkedScope(scope);
      const { label } = query.when;
      const clauses: string[] = [];
      let me: string | undefined;
      const search = async <T>(work: () => Promise<T>): Promise<T> => {
        try {
          return await work();
        } catch (error) {
          if (error instanceof TrackerSearchError) throw error;
          if (error instanceof TrackerWriteRefusedError) throw new TrackerSearchError(error.reason === "not_connected" ? "CONNECTION_MISSING" : "CONNECTION_REFUSED");
          if (error instanceof Error && (error as { code?: string }).code === "TOO_MANY_REQUESTS") throw new TrackerSearchError("RATE_LIMITED");
          throw new TrackerSearchError("SEARCH_FAILED");
        }
      };
      return search(async () => {
        if (label !== undefined) {
          if (!JIRA_LABEL.test(label)) throw new TrackerSearchError("SEARCH_FAILED");
          clauses.push(`labels = "${label}"`);
        }
        if (query.when.assignedToRovara === true) {
          const answer = await call("/rest/api/3/myself", { signal: query.signal });
          if (refused(answer.status)) throw new TrackerSearchError("CONNECTION_REFUSED");
          me = str(rec(answer.body)["accountId"]);
          clauses.push("assignee = currentUser()");
        }
        if (clauses.length === 0) return [];
        const jql = `(${clauses.join(" OR ")}) AND statusCategory != Done ORDER BY updated DESC`;
        const params = new URLSearchParams({ jql, maxResults: String(Math.min(query.limit, 50)), fields: "summary,description,labels,assignee,reporter", expand: "changelog" });
        const answer = await call(`/rest/api/3/search/jql?${params.toString()}`, { signal: query.signal });
        if (refused(answer.status)) throw new TrackerSearchError("CONNECTION_REFUSED");
        if (answer.status !== 200) throw new TrackerSearchError("SEARCH_FAILED");
        const items: TrackerAskedItem[] = [];
        for (const raw of arr(rec(answer.body)["issues"]).slice(0, query.limit)) {
          const issue = rec(raw);
          const key = str(issue["key"]);
          const fields = rec(issue["fields"]);
          if (key === undefined || !JIRA_KEY.test(key)) continue;
          // Who did it: the newest change that ADDED the label, or that assigned the issue to the key's own account.
          const found = await fullHistory(issue, key, query.signal).then((histories) => (histories === undefined ? {} : jiraActOf(histories, label === undefined ? undefined : { kind: "label", value: label }, site, me, meIsRovara)));
          const numeric = str(issue["id"]);
          items.push({
            ref: { tracker: JIRA_TRACKER_KIND, id: key, url: `${site}/browse/${key}` },
            title: cut(str(fields["summary"]) ?? key, 300), body: cut(adfText(fields["description"]), BODY_MAX_CHARS),
            ...(str(rec(fields["reporter"])["displayName"]) === undefined ? {} : { reporter: str(rec(fields["reporter"])["displayName"])! }),
            ...(found.actor === undefined ? {} : { actor: found.actor }),
            ...(found.at === undefined ? {} : { occurredAt: found.at }),
            // The change that made the label-add, as Jira's own change log says: claimed once per company by the engine, so a project watching the same label does not start it a second time as the person.
            ...(label === undefined || found.changeId === undefined ? {} : { change: { id: found.changeId, act: { kind: "label" as const, value: label } } }),
            ...(numeric === undefined ? {} : { alternateIds: [numeric] }),
          });
        }
        return items;
      });
    },
  };
  return tracker;
}
