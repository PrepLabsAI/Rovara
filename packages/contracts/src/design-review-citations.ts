// Design review stage, DR5 (design-review-stage.md 3.12 items 5 and 6): every citation a reviewer gives must point at something THAT reviewer was given.
// A reviewer writes its citations in its answer, so a hostile or mistaken answer can name a source it never saw or a digest it made up. This is the check. It is pure and lives in contracts so the
// broker applies it to the answer it reads itself (never trusting the worker) and the worker can run the same function for early feedback. The broker's copy of the path is
// `broker/src/design-review/citations.ts`.
//
// What counts as in the packet:
//   - `kind: "design"`: a section of the design, which every reviewer was given. Always valid.
//   - `kind: "source"`: the ref AND the digest must both equal one packet item's (any kind: the design and requirements are items too). A right ref with a wrong digest is a forged citation.
//   - `kind: "code"`: either a repository file item of the packet (same repo and path, same commit; the citation may give the commit as a prefix of 7 or more characters), or a place in a repository
//     the round pinned (`baseCommits`) at that pinned commit (or a prefix of 7 or more characters of it) with a plain relative path. The second rule is what lets the codebase reviewer cite files it opened itself.
//     The worker's list of files read is NOT used as proof: it is the worker's word. A path at the pin is not proven to exist; the anchor is not checked here.
// The same check runs on the planner's resolve evidence and question evidence (`checkResolveCitations`), against every item the round's reviewers were given and the same pins.
// A citation that fails is dropped. A finding left with no citation is dropped too and recorded as dropped, with its severity, so the card can say that a blocker was lost rather than hide it.
import type { DesignCitation, DesignQuestion, ReviewerRole } from "./design-review.js";
import { codeCitationInPacket, plainPath, type CitablePacketItem } from "./design-review-citation-links.js";
// The browser-safe part of the citation rules (link path, "not checked" words, the packet match) lives in design-review-citation-links.ts; it is re-exported here so the Node entry keeps one place to import from.
export { CODE_CITATION_UNCHECKED, codeCitationInPacket, codeCitationLinkPath, type CitablePacketItem } from "./design-review-citation-links.js";
import type { DesignResolutionDraft, RawDesignFinding } from "./design-review-block.js";

/** `over_limit`: a well-formed citation left out because the finding already holds five (design and code citations are kept before source items). Set by the reader, never by the packet check. */
export const CITATION_DROP_REASONS = ["source_not_in_packet", "source_digest_mismatch", "code_not_allowed", "over_limit"] as const;
export type CitationDropReason = (typeof CITATION_DROP_REASONS)[number];

export interface DroppedCitation {
  rawId: string;
  role: ReviewerRole;
  reason: CitationDropReason;
  citation: DesignCitation;
}
export interface DroppedFinding {
  rawId: string;
  role: ReviewerRole;
  severity: RawDesignFinding["severity"];
  section: RawDesignFinding["section"];
  reason: "no_valid_citation";
}

/** The packets of a round: each reviewer's items, by role. A role that is missing here has no packet, and none of its source or code citations is accepted. */
export type ReviewerPackets = ReadonlyMap<ReviewerRole, readonly CitablePacketItem[]> | Partial<Record<ReviewerRole, readonly CitablePacketItem[]>>;

function itemsOf(packets: ReviewerPackets, role: ReviewerRole): readonly CitablePacketItem[] {
  const found: readonly CitablePacketItem[] | undefined = packets instanceof Map ? (packets as ReadonlyMap<ReviewerRole, readonly CitablePacketItem[]>).get(role) : (packets as Partial<Record<ReviewerRole, readonly CitablePacketItem[]>>)[role];
  return found ?? [];
}

/** The pinned base commit of each repository the round may read, by the name section 8 uses. */
export type PinnedCommits = Readonly<Record<string, string>>;

/** Why a citation is not acceptable for this packet, or undefined when it is. */
export function citationProblem(citation: DesignCitation, items: readonly CitablePacketItem[], pins: PinnedCommits = {}): CitationDropReason | undefined {
  if (citation.kind === "design") return undefined;
  if (citation.kind === "source") {
    const sameRef = items.filter((item) => item.ref === citation.ref);
    if (sameRef.length === 0) return "source_not_in_packet";
    return sameRef.some((item) => item.digest === citation.digest) ? undefined : "source_digest_mismatch";
  }
  // The schema already holds the commit to 7 to 64 lowercase hex characters; it is checked again here for a citation that did not come through the schema (a pin is 40 at most).
  if (!/^[a-f0-9]{7,40}$/u.test(citation.commit)) return "code_not_allowed";
  if (codeCitationInPacket(citation, items)) return undefined;
  const pin = Object.hasOwn(pins, citation.repo) ? pins[citation.repo] : undefined;
  return pin !== undefined && pin.startsWith(citation.commit) && plainPath(citation.path) ? undefined : "code_not_allowed";
}

export interface CitationFilterResult {
  /** The reviewers' findings with only acceptable citations, in the order given. A finding with none left is not here. */
  findings: RawDesignFinding[];
  droppedCitations: DroppedCitation[];
  droppedFindings: DroppedFinding[];
}

/** Keeps each finding's citations that match the packet of the reviewer that wrote it, and drops the findings that are left with none. */
export function filterReviewerCitations(raw: readonly RawDesignFinding[], packets: ReviewerPackets, pins: PinnedCommits = {}): CitationFilterResult {
  const findings: RawDesignFinding[] = [];
  const droppedCitations: DroppedCitation[] = [];
  const droppedFindings: DroppedFinding[] = [];
  for (const finding of raw) {
    const items = itemsOf(packets, finding.role);
    const kept: DesignCitation[] = [];
    for (const citation of finding.citations) {
      const problem = citationProblem(citation, items, pins);
      if (problem === undefined) kept.push(citation);
      else droppedCitations.push({ rawId: finding.rawId, role: finding.role, reason: problem, citation });
    }
    if (kept.length === 0) droppedFindings.push({ rawId: finding.rawId, role: finding.role, severity: finding.severity, section: finding.section, reason: "no_valid_citation" });
    else findings.push({ ...finding, citations: kept });
  }
  return { findings, droppedCitations, droppedFindings };
}

export interface ResolveCitationResult {
  resolutions: DesignResolutionDraft[];
  questions: DesignQuestion[];
  droppedCitations: number;
  /** Findings the planner "contested" whose evidence is left with no design or code citation after the check. The caller refuses those contests (a source alone cannot argue a finding away). */
  uncontestable: string[];
}

/**
 * The planner's resolve evidence and question evidence, checked like a reviewer's citations. `items` is every item any reviewer of the round was given (the planner reads the same design and sources);
 * `pins` are the round's pinned commits. A failing citation is dropped; the planner's text is kept.
 */
export function checkResolveCitations(input: { resolutions: readonly DesignResolutionDraft[]; questions: readonly DesignQuestion[]; items: readonly CitablePacketItem[]; pins?: PinnedCommits }): ResolveCitationResult {
  let dropped = 0;
  const keep = (citations: readonly DesignCitation[]): DesignCitation[] => citations.filter((citation) => {
    const ok = citationProblem(citation, input.items, input.pins) === undefined;
    if (!ok) dropped += 1;
    return ok;
  });
  const uncontestable: string[] = [];
  const resolutions = input.resolutions.map((resolution): DesignResolutionDraft => {
    if (resolution.evidence === undefined) return resolution;
    const rest: DesignResolutionDraft = { findingId: resolution.findingId, action: resolution.action, note: resolution.note, ...(resolution.questionId === undefined ? {} : { questionId: resolution.questionId }) };
    const kept = keep(resolution.evidence);
    if (resolution.action === "contested" && !kept.some((citation) => citation.kind !== "source")) uncontestable.push(resolution.findingId);
    return kept.length === 0 ? rest : { ...rest, evidence: kept };
  });
  const questions = input.questions.map((question): DesignQuestion => ({ ...question, evidence: keep(question.evidence) }));
  return { resolutions, questions, droppedCitations: dropped, uncontestable };
}
