// E5: citations in plans and reviews, and the facts that are fetched fresh when shown (design 3.6, "Plans and reviews cite sources", "Live facts").
//
// A stage records a citation for every source item it read, with the call that fetched it (kept here, on the server). A plan's claim cites an item by writing its
// label and reference in square brackets, `[Tracker ABC-123]`. Rovara matches each marker to what the stage really read:
//   - a marker that matches a recorded citation is verified;
//   - a marker that matches nothing is shown as "unverified" (the planner cannot cite what it did not read);
//   - the plan check replays each cited call and flags an item that is gone, or whose answer changed (apart from the live facts);
//   - status, assignee and priority are fetched fresh for the page, labelled with the time, and never stored: if the fetch fails the page says "unavailable".
// A review finding may cite a source, but a finding that cites a source and no code or test is advisory only: a ticket cannot block a change, and cannot
// excuse one either.
import { createHash } from "node:crypto";
import {
  CITATION_MARKER, CitationSchema, INDEX_EXPIRY_ATTRIBUTE, orgScoped,
  type Citation, type ContextSource, type DocumentStore, type JsonValue, type OrgId, type PlanCritique, type PlanClaim,
} from "@agentx/contracts";
import { checkArguments, contextWriteGate } from "./guards.js";
import { inertSentence, resolvePresentedTool, resultDigest } from "./present.js";
import type { CitationRecorder, ContextServerPort } from "./routes.js";
import { toolSchemaHash, annotationVerdict, nameSuggestsWrite } from "./settings.js";

export interface StoredCitation {
  citation: Citation;
  stage: string;
  operationId: string;
  replay: { tool: string; arguments: Record<string, unknown> };
  recordedAt: string;
}

/** Citations are kept as long as the text they point at could be shown. */
export const CITATION_RETENTION_SECONDS = 14 * 24 * 60 * 60;
/** A stored value as text: a field that is not text reads as empty. */
const text = (value: unknown): string => (typeof value === "string" ? value : "");

const partition = (orgId: OrgId, taskId: string): string => orgScoped(orgId, `CTXCIT#${taskId}`);
const sortKey = (stage: string, citation: Citation): string => `CIT#${stage}#${citation.sourceId}#${createHash("sha256").update(citation.itemRef).digest("hex").slice(0, 16)}`;

export interface CitationStore extends CitationRecorder {
  list(orgId: OrgId, taskId: string, options?: { stage?: string }): Promise<StoredCitation[]>;
}

export function documentCitationStore(deps: { store: DocumentStore; now: () => number }): CitationStore {
  return {
    async record({ orgId, taskId, operationId, stage, citation, replay }) {
      await deps.store.put({
        item: {
          pk: partition(orgId, taskId), sk: sortKey(stage, citation), citation: citation as unknown as JsonValue, stage, operationId, replay: replay as unknown as JsonValue, recordedAt: new Date(deps.now()).toISOString(),
          [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(deps.now() / 1_000) + CITATION_RETENTION_SECONDS,
        },
      });
    },
    async list(orgId, taskId, options = {}) {
      const found = await deps.store.query({ pk: partition(orgId, taskId), sk: { op: "beginsWith", prefix: options.stage === undefined ? "CIT#" : `CIT#${options.stage}#` }, limit: 200 });
      const out: StoredCitation[] = [];
      for (const item of found.items) {
        const citation = CitationSchema.safeParse(item.citation);
        const replay = item.replay as { tool?: unknown; arguments?: unknown } | undefined;
        // An item that does not parse is not served: a citation is never half-trusted.
        if (!citation.success || typeof replay?.tool !== "string" || typeof replay.arguments !== "object" || replay.arguments === null) continue;
        out.push({ citation: citation.data, stage: text(item.stage), operationId: text(item.operationId), replay: { tool: replay.tool, arguments: replay.arguments as Record<string, unknown> }, recordedAt: text(item.recordedAt) });
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Claims cite items
// ---------------------------------------------------------------------------------------------

const MARKER = CITATION_MARKER;

export interface ClaimCitations {
  claimId: string;
  /** Markers that match something the stage really read. */
  verified: StoredCitation[];
  /** Markers that match nothing. Shown as "unverified". */
  unverified: string[];
}

function flatten(claims: readonly PlanClaim[]): PlanClaim[] {
  return claims.flatMap((claim) => [claim, ...flatten(claim.children ?? [])]);
}

/** The citations of each claim of a plan, matched against what the planning stages read. A claim with no marker is left out. */
export function claimCitations(claims: readonly PlanClaim[], stored: readonly StoredCitation[], sources: readonly ContextSource[]): ClaimCitations[] {
  const labelOf = new Map(sources.map((source) => [source.label.toLowerCase(), source.sourceId]));
  const result: ClaimCitations[] = [];
  for (const claim of flatten(claims)) {
    const verified: StoredCitation[] = [];
    const unverified: string[] = [];
    for (const match of claim.text.matchAll(MARKER)) {
      const label = match[1]!.toLowerCase();
      const itemRef = match[2]!;
      const sourceId = labelOf.get(label);
      const found = sourceId === undefined ? undefined : stored.find((entry) => entry.citation.sourceId === sourceId && entry.citation.itemRef.toLowerCase() === itemRef.toLowerCase());
      if (found === undefined) unverified.push(`[${inertSentence(match[1]!, 60)} ${inertSentence(itemRef, 80)}]`);
      else if (!verified.includes(found)) verified.push(found);
    }
    if (verified.length > 0 || unverified.length > 0) result.push({ claimId: claim.id, verified, unverified: [...new Set(unverified)] });
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Asking a source again
// ---------------------------------------------------------------------------------------------

export interface ReplayDependencies {
  servers: ContextServerPort;
  /** The project's sources now. */
  sources(orgId: OrgId, project: string): Promise<readonly ContextSource[]>;
  now: () => number;
  callTimeoutMs?: number | undefined;
}

export type Replay =
  | { outcome: "ok"; structured: unknown; text: string; digest: string; fetchedAt: string; source: ContextSource }
  /** The source answered that the item is not there (an error answer, or an empty one). */
  | { outcome: "gone" }
  /** The source could not be asked: unreachable, turned off, changed, or the call would not be sent now. */
  | { outcome: "unavailable" };

/**
 * Asks the call that fetched an item again. It goes through the same checks as a stage's call (the tool is still the tool an admin ticked, it still reads only, the
 * arguments are still fine) and the same time limit, but it takes nothing from a stage's allowance: it is not a stage.
 */
export async function replayCitation(deps: ReplayDependencies, input: { orgId: OrgId; project: string; stored: StoredCitation }): Promise<Replay> {
  const sources = await deps.sources(input.orgId, input.project);
  const resolved = resolvePresentedTool(sources, input.stored.replay.tool);
  if (resolved === undefined) return { outcome: "unavailable" };
  const { source, tool: ticked } = resolved;
  let session;
  try {
    session = await deps.servers.open(input.orgId, source.server, AbortSignal.timeout(deps.callTimeoutMs ?? 10_000), source.tools.map((tool) => tool.upstreamName));
    const discovered = session.tools.find((entry) => entry.name === ticked.upstreamName);
    if (discovered === undefined || toolSchemaHash(discovered) !== ticked.schemaHash) return { outcome: "unavailable" };
    if (annotationVerdict(discovered) === "unsafe" || ((annotationVerdict(discovered) === "unannotated" || nameSuggestsWrite(discovered.name)) && ticked.attestedReadOnly !== true)) return { outcome: "unavailable" };
    if (contextWriteGate({ tool: discovered, attestedReadOnly: ticked.attestedReadOnly === true }).decision === "refuse") return { outcome: "unavailable" };
    const args = input.stored.replay.arguments;
    if (!checkArguments({ args, inputSchema: discovered.inputSchema, hosts: session.hosts, sendCodeSnippets: source.sendCodeSnippets }).ok) return { outcome: "unavailable" };
    const answer = await session.call(ticked.upstreamName, args, AbortSignal.timeout(deps.callTimeoutMs ?? 10_000));
    const text = (answer.content ?? []).filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text!).join("\n");
    if (answer.isError === true || (text.trim() === "" && answer.structuredContent === undefined)) return { outcome: "gone" };
    return { outcome: "ok", structured: answer.structuredContent, text, digest: resultDigest({ structuredContent: answer.structuredContent, text }, source.liveFacts), fetchedAt: new Date(deps.now()).toISOString(), source };
  } catch {
    return { outcome: "unavailable" };
  } finally {
    await session?.close().catch(() => undefined);
  }
}

export type CitationCheck = "unchanged" | "changed" | "gone" | "unavailable";

/** The plan check's re-fetch of each cited item (at most `limit`, so a plan with many citations is bounded). */
export async function recheckCitations(deps: ReplayDependencies, input: { orgId: OrgId; project: string; cited: readonly StoredCitation[]; limit?: number }): Promise<Array<{ stored: StoredCitation; check: CitationCheck }>> {
  const out: Array<{ stored: StoredCitation; check: CitationCheck }> = [];
  for (const stored of input.cited.slice(0, input.limit ?? 20)) {
    const replay = await replayCitation(deps, { orgId: input.orgId, project: input.project, stored });
    out.push({ stored, check: replay.outcome === "ok" ? (replay.digest === stored.citation.digest ? "unchanged" : "changed") : replay.outcome });
  }
  return out;
}

/**
 * What the plan check adds to its points: an item the plan rests on that is gone is blocking; one that changed, a marker that matches nothing, and a source that
 * could not be asked are notes. They are plain sentences from Rovara, with no text from the source.
 */
export function sourceCritiquePoints(input: { claims: readonly ClaimCitations[]; checks: ReadonlyArray<{ stored: StoredCitation; check: CitationCheck }>; sources: readonly ContextSource[] }): PlanCritique["points"] {
  const points: PlanCritique["points"] = [];
  const label = (sourceId: string): string => input.sources.find((source) => source.sourceId === sourceId)?.label ?? sourceId;
  const claimOf = (stored: StoredCitation): string | undefined => input.claims.find((claim) => claim.verified.includes(stored))?.claimId;
  let index = 0;
  const add = (severity: "blocking" | "note", text: string, claimId?: string): void => {
    index += 1;
    points.push({ id: `src${index}`, severity, text, ...(claimId === undefined ? {} : { claimId }) });
  };
  for (const { stored, check } of input.checks) {
    const where = `${label(stored.citation.sourceId)} ${inertSentence(stored.citation.itemRef, 80)}`;
    if (check === "gone") add("blocking", `The plan cites ${where}, which can no longer be found at its source. Check that the plan still holds.`, claimOf(stored));
    else if (check === "changed") add("note", `${where} changed at its source since the plan read it. Read it again and check the plan against it.`, claimOf(stored));
    else if (check === "unavailable") add("note", `${label(stored.citation.sourceId)} could not be asked again, so ${inertSentence(stored.citation.itemRef, 80)} was not re-checked.`, claimOf(stored));
  }
  for (const claim of input.claims) for (const marker of claim.unverified) add("note", `Claim ${claim.claimId} cites ${marker}, but no stage read that item.`, claim.claimId);
  return points.slice(0, 10);
}

// ---------------------------------------------------------------------------------------------
// Live facts
// ---------------------------------------------------------------------------------------------

export type LiveFacts = { status: "fresh"; facts: Record<string, string>; fetchedAt: string } | { status: "unavailable" };

function pick(structured: unknown, names: readonly string[]): Record<string, string> {
  const facts: Record<string, string> = {};
  const record: unknown = Array.isArray(structured) ? (structured as unknown[])[0] : structured;
  if (typeof record !== "object" || record === null) return facts;
  const lower = new Map(Object.entries(record as Record<string, unknown>).map(([key, value]) => [key.toLowerCase(), value]));
  for (const name of names) {
    const value = lower.get(name.toLowerCase());
    const text = typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : typeof value === "object" && value !== null && typeof (value as { name?: unknown }).name === "string" ? (value as { name: string }).name : undefined;
    if (text !== undefined) facts[name] = inertSentence(text, 80);
  }
  return facts;
}

/**
 * The source's live facts (status, assignee, priority…) for one cited item, fetched now for the page and handed back to be shown with the time. Nothing is stored. A
 * source with no live facts, or a fetch that fails, gives `unavailable`, which the page words as "status unavailable", never as an old value.
 */
export async function fetchLiveFacts(deps: ReplayDependencies, input: { orgId: OrgId; project: string; stored: StoredCitation }): Promise<LiveFacts> {
  const replay = await replayCitation(deps, input);
  if (replay.outcome !== "ok" || replay.source.liveFacts.length === 0) return { status: "unavailable" };
  const facts = pick(replay.structured, replay.source.liveFacts);
  return Object.keys(facts).length === 0 ? { status: "unavailable" } : { status: "fresh", facts, fetchedAt: replay.fetchedAt };
}

// ---------------------------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------------------------

export { SOURCE_ONLY_NOTE, downgradeSourceOnlyFindings } from "@agentx/contracts";

/** The call fetched for display: one cited item, with whatever the page shows about it. */
export async function readCitation(store: Pick<CitationStore, "list">, orgId: OrgId, taskId: string, sourceId: string, itemRef: string): Promise<StoredCitation | undefined> {
  return (await store.list(orgId, taskId)).find((entry) => entry.citation.sourceId === sourceId && entry.citation.itemRef === itemRef);
}

