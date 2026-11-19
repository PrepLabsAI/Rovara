// E4: who may read a source's quoted text, and where that text is kept (design 3.6, "Where results go, and who sees quotes").
//
// A saved transcript never holds a source's text (worker/src/context-sources/transcript.ts). The text a stage read is kept here, per task and per source, for
// the task's lifetime only: every item expires after RESULT_RETENTION_SECONDS, and an item of a `live_only` source is deleted when the task ends. A person is
// shown a quote only when the source's rule lets them:
//   - `citations_only`: nobody sees the quote; everyone sees the title, the link and Rovara's one-line summary (labelled as Rovara's);
//   - `project_members`: any member of the project;
//   - `source_acl`:  only a person who passes a live check at the source with their own identity. Without a check, or when it fails, the answer is no.
// Slack's terms forbid keeping or showing its text: such a source is `citations_only` and `live_only` whatever was stored (QUOTE_FORBIDDEN_SYSTEMS).
//
// Replaces: the design's "KMS-encrypted S3 objects with a TTL". The text is kept in the broker's DynamoDB table (encrypted at rest by the table), as items with an
// expiry, because a 16 KiB-per-result, task-lifetime store needs no new bucket. The `ResultStore` port is the seam if a bucket is wanted later.
import { createHash } from "node:crypto";
import { INDEX_EXPIRY_ATTRIBUTE, isQuoteForbiddenSystem, stripHiddenCharacters, orgScoped, type Citation, type ContextSource, type DocumentStore, type OrgId, type QuoteVisibility } from "@agentx/contracts";
import type { ResultKeeper } from "./routes.js";

/** Kept text expires this long after it was read, whatever happens to the task (a task that is never closed must not keep source text for ever). */
export const RESULT_RETENTION_SECONDS = 14 * 24 * 60 * 60;
const KEPT_MAX_CHARS = 20_000;

export interface KeptResult {
  sourceId: string;
  itemRef: string;
  digest: string;
  text: string;
  retention: ContextSource["retention"];
  fetchedAt: string;
  operationId: string;
}

export interface ResultStore extends ResultKeeper {
  /** The text kept for a task, newest read of an item last. */
  list(orgId: OrgId, taskId: string): Promise<KeptResult[]>;
  /** Deletes what a task kept. With `onlyLiveOnly`, only the items of sources that are never kept past the task. Returns how many were deleted. */
  deleteForTask(orgId: OrgId, taskId: string, options: { onlyLiveOnly: boolean }): Promise<number>;
}

/** A stored value as text: a field that is not text reads as empty. */
const text = (value: unknown): string => (typeof value === "string" ? value : "");

const partition = (orgId: OrgId, taskId: string): string => orgScoped(orgId, `CTXRES#${taskId}`);
const sortKey = (sourceId: string, itemRef: string, digest: string): string => `RES#${sourceId}#${createHash("sha256").update(itemRef).digest("hex").slice(0, 16)}#${digest.slice(0, 12)}`;

export function documentResultStore(deps: { store: DocumentStore; now: () => number }): ResultStore {
  const list = async (orgId: OrgId, taskId: string, includeExpired = false): Promise<Array<KeptResult & { sk: string }>> => {
    const items: Array<KeptResult & { sk: string }> = [];
    let cursor: string | undefined;
    // A task keeps at most a few hundred items (the stage allowance bounds it), so a handful of pages is the bound.
    for (let page = 0; page < 10; page += 1) {
      const found = await deps.store.query({ pk: partition(orgId, taskId), sk: { op: "beginsWith", prefix: "RES#" }, ...(cursor === undefined ? {} : { cursor }) });
      for (const item of found.items) {
        // The store deletes an expired item some time after its expiry; until then it is still not served.
        const expires = item[INDEX_EXPIRY_ATTRIBUTE];
        if (!includeExpired && typeof expires === "number" && expires * 1_000 <= deps.now()) continue;
        if (typeof item.sourceId === "string" && typeof item.itemRef === "string" && typeof item.text === "string" && typeof item.sk === "string") {
          items.push({ sk: item.sk, sourceId: item.sourceId, itemRef: item.itemRef, digest: text(item.digest), text: item.text, retention: item.retention === "live_only" ? "live_only" : "team_record", fetchedAt: text(item.fetchedAt), operationId: text(item.operationId) });
        }
      }
      cursor = found.cursor;
      if (cursor === undefined) break;
    }
    return items;
  };
  return {
    async keep(input) {
      // Nothing is kept that nobody may read: a source that shows no quotes, or a system whose terms forbid keeping its text, whatever the source's setting says.
      if (input.quotes === "citations_only" || isQuoteForbiddenSystem(input.system)) return;
      const text = stripHiddenCharacters(input.text).text.slice(0, KEPT_MAX_CHARS);
      await deps.store.put({
        item: {
          pk: partition(input.orgId, input.taskId), sk: sortKey(input.sourceId, input.itemRef, input.digest),
          sourceId: input.sourceId, itemRef: input.itemRef, digest: input.digest, text, retention: input.retention, fetchedAt: input.fetchedAt, operationId: input.operationId,
          [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(deps.now() / 1_000) + RESULT_RETENTION_SECONDS,
        },
      });
    },
    async list(orgId, taskId) {
      return (await list(orgId, taskId)).map((item) => ({ sourceId: item.sourceId, itemRef: item.itemRef, digest: item.digest, text: item.text, retention: item.retention, fetchedAt: item.fetchedAt, operationId: item.operationId })).sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
    },
    async deleteForTask(orgId, taskId, options) {
      let deleted = 0;
      for (const item of await list(orgId, taskId, true)) {
        if (options.onlyLiveOnly && item.retention !== "live_only") continue;
        await deps.store.delete({ key: { pk: partition(orgId, taskId), sk: item.sk } });
        deleted += 1;
      }
      return deleted;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Who may see a quote
// ---------------------------------------------------------------------------------------------

export type QuoteDecision = { show: true } | { show: false; reason: "citations_only" | "not_a_member" | "no_access_at_source" | "no_live_check" };

export interface QuoteViewer {
  orgId: OrgId;
  developerId: string;
}

export interface QuoteDependencies {
  /** Whether the viewer is a member of the task's project now. */
  isProjectMember(viewer: QuoteViewer, project: string): Promise<boolean>;
  /**
   * A live check at the source with the viewer's own identity: may they see this item? Absent where the source has no per-person check. It throws or answers
   * `false` when they may not, or when it cannot tell.
   */
  liveAclCheck?: ((viewer: QuoteViewer, source: ContextSource, itemRef: string) => Promise<boolean>) | undefined;
}

/** Whether a viewer may read a quote of one item. Every unknown is a no. */
export async function decideQuote(deps: QuoteDependencies, input: { viewer: QuoteViewer; project: string; source: ContextSource; itemRef: string }): Promise<QuoteDecision> {
  const { source, viewer } = input;
  if (isQuoteForbiddenSystem(source.system)) return { show: false, reason: "citations_only" };
  const rule: QuoteVisibility = source.quotes;
  if (rule === "citations_only") return { show: false, reason: "citations_only" };
  const member = await deps.isProjectMember(viewer, input.project).then((answer) => answer, () => false);
  if (!member) return { show: false, reason: "not_a_member" };
  if (rule === "project_members") return { show: true };
  if (deps.liveAclCheck === undefined) return { show: false, reason: "no_live_check" };
  try {
    return await deps.liveAclCheck(viewer, source, input.itemRef) === true ? { show: true } : { show: false, reason: "no_access_at_source" };
  } catch {
    return { show: false, reason: "no_access_at_source" };
  }
}

export interface CitationView {
  citation: Citation;
  label: string;
  /** The quoted text, only when the viewer may read it. */
  quote?: string;
  /** Why there is no quote, for the page to word. */
  withheld?: Exclude<QuoteDecision, { show: true }>["reason"] | "expired";
}

/**
 * The citations of a task as one viewer sees them: always the title, link and source; the quote only when the source's rule lets this viewer. The kept text
 * is the newest read of the item. A quote that has expired (or was never kept) is withheld as `expired`.
 */
export async function citationViews(
  deps: QuoteDependencies & { results: Pick<ResultStore, "list"> },
  input: { viewer: QuoteViewer; orgId: OrgId; taskId: string; project: string; citations: readonly Citation[]; sources: readonly ContextSource[] },
): Promise<CitationView[]> {
  const kept = await deps.results.list(input.orgId, input.taskId).catch(() => [] as KeptResult[]);
  const views: CitationView[] = [];
  for (const citation of input.citations) {
    const source = input.sources.find((entry) => entry.sourceId === citation.sourceId);
    // A source an admin has since removed: the citation stays, with no quote.
    if (source === undefined) { views.push({ citation, label: citation.sourceId, withheld: "citations_only" }); continue; }
    const decision = await decideQuote(deps, { viewer: input.viewer, project: input.project, source, itemRef: citation.itemRef });
    if (!decision.show) { views.push({ citation, label: source.label, withheld: decision.reason }); continue; }
    const text = kept.filter((item) => item.sourceId === citation.sourceId && item.itemRef === citation.itemRef).at(-1)?.text;
    views.push(text === undefined ? { citation, label: source.label, withheld: "expired" } : { citation, label: source.label, quote: text });
  }
  return views;
}

/** Where the install says a task has ended: it hands the handler to this and gets back the function that takes it off again. */
export type TaskEndRegistrar = (handler: (event: { orgId: OrgId; taskId: string }) => Promise<void>) => () => void;

/** Deletes the `live_only` text of every task that ends. Called once when the install starts; returns the function that takes the handler off again. */
export function registerContextSourceCleanup(deps: { store: Pick<ResultStore, "deleteForTask">; onTaskEnd: TaskEndRegistrar; log?: (event: string, fields: Record<string, string | number>) => void }): () => void {
  return deps.onTaskEnd(async (event) => {
    try {
      const deleted = await deps.store.deleteForTask(event.orgId, event.taskId, { onlyLiveOnly: true });
      if (deleted > 0) deps.log?.("context_source.live_only_deleted", { taskId: event.taskId, deleted });
    } catch {
      // The items expire by themselves; a failed delete is told to the operator and never stops the task from ending.
      deps.log?.("context_source.live_only_delete_failed", { taskId: event.taskId });
    }
  });
}
