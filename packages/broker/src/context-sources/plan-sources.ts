// E5: what the plan page shows under each claim that cites a source: the claim's markers matched to what the stages read (citations.ts), the quote only where
// this reader may see it (quotes.ts), what the plan check found, and the live facts fetched fresh for this page.
import type { Citation, ContextSource, OrgId, PlanClaim } from "@agentx/contracts";
import type { ClaimSourceView } from "../aws/plan-page/render-plan.js";
import { claimCitations, fetchLiveFacts, type CitationCheck, type CitationStore, type ReplayDependencies, type StoredCitation } from "./citations.js";
import { citationViews, type QuoteDependencies, type QuoteViewer, type ResultStore } from "./quotes.js";

/** The most items whose live facts are fetched for one page view; the rest show "status unavailable" rather than slowing the page. */
export const LIVE_FACTS_PER_PAGE = 10;

const LIVE_FACTS_CACHE_MS = 60_000;
const liveCache = new Map<string, { at: number; value: Awaited<ReturnType<typeof fetchLiveFacts>> }>();
/** For tests. */
export function clearLiveFactsCache(): void { liveCache.clear(); }

const keyOf = (citation: Pick<Citation, "sourceId" | "itemRef">): string => `${citation.sourceId}\u0000${citation.itemRef}`;

export async function buildClaimSources(
  deps: { citations: Pick<CitationStore, "list">; results: Pick<ResultStore, "list">; quotes: QuoteDependencies; replay: ReplayDependencies },
  input: {
    viewer: QuoteViewer; orgId: OrgId; taskId: string; project: string; claims: readonly PlanClaim[]; sources: readonly ContextSource[];
    /** What the plan check found for each item it re-fetched (keyed `sourceId`, a NUL, `itemRef`); an item not listed was not found to have changed. */
    flags?: ReadonlyMap<string, Exclude<CitationCheck, "unchanged" | "unavailable">> | undefined;
    /** Show live facts. Off for a page that is not being read by a person (an export). */
    liveFacts?: boolean | undefined;
  },
): Promise<Map<string, ClaimSourceView[]>> {
  const stored = await deps.citations.list(input.orgId, input.taskId);
  const cited = claimCitations(input.claims, stored, input.sources);
  const views = await citationViews({ ...deps.quotes, results: deps.results }, {
    viewer: input.viewer, orgId: input.orgId, taskId: input.taskId, project: input.project, citations: stored.map((entry) => entry.citation), sources: input.sources,
  });
  const viewOf = new Map(views.map((view) => [keyOf(view.citation), view]));
  const live = new Map<string, Awaited<ReturnType<typeof fetchLiveFacts>>>();
  // Live facts follow the quote rule: only someone who is a member of the project, and for a source of "people allowed at the source" only someone the
  // source's own check let through. A page view also asks the source at most once a minute for each item.
  const member = await deps.quotes.isProjectMember(input.viewer, input.project).then((answer) => answer, () => false);
  if (input.liveFacts !== false && member) {
    const wanted: StoredCitation[] = [];
    const allowed = (entry: StoredCitation): boolean => {
      const source = input.sources.find((candidate) => candidate.sourceId === entry.citation.sourceId);
      if (source === undefined || source.liveFacts.length === 0) return false;
      if (source.quotes !== "source_acl") return true;
      const view = viewOf.get(keyOf(entry.citation));
      return view !== undefined && (view.quote !== undefined || view.withheld === "expired");
    };
    for (const claim of cited) for (const entry of claim.verified) if (!wanted.includes(entry) && allowed(entry)) wanted.push(entry);
    await Promise.all(wanted.slice(0, LIVE_FACTS_PER_PAGE).map(async (entry) => {
      const cacheKey = `${input.orgId}|${input.taskId}|${keyOf(entry.citation)}`;
      const at = deps.replay.now();
      const cached = liveCache.get(cacheKey);
      if (cached !== undefined && at - cached.at < LIVE_FACTS_CACHE_MS) { live.set(keyOf(entry.citation), cached.value); return; }
      const value = await fetchLiveFacts(deps.replay, { orgId: input.orgId, project: input.project, stored: entry }).catch(() => ({ status: "unavailable" as const }));
      liveCache.set(cacheKey, { at, value });
      live.set(keyOf(entry.citation), value);
    }));
    for (const entry of wanted.slice(LIVE_FACTS_PER_PAGE)) live.set(keyOf(entry.citation), { status: "unavailable" });
  }
  const out = new Map<string, ClaimSourceView[]>();
  for (const claim of cited) {
    const items: ClaimSourceView[] = claim.verified.map((entry) => {
      const view = viewOf.get(keyOf(entry.citation));
      return {
        label: view?.label ?? entry.citation.sourceId, itemRef: entry.citation.itemRef, title: entry.citation.title, url: entry.citation.url, verified: true,
        flagged: input.flags?.get(keyOf(entry.citation)), outsider: entry.citation.standing === "outsider", quote: view?.quote, live: live.get(keyOf(entry.citation)),
      };
    });
    for (const marker of claim.unverified) items.push({ label: marker, itemRef: "", title: "", verified: false, outsider: false });
    out.set(claim.claimId, items);
  }
  return out;
}

export { keyOf as citationKey };
