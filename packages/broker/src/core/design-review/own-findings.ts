// Design review stage: findings the broker makes itself, with no model involved. A model can neither remove them nor soften them, and a reviewer's "no issues" changes nothing.
//   - A blocker for every approved requirement id that appears in no §3 subsection ("Each requirement id must appear in at least one §3 subsection").
//   - A major "too long: split the work" for a design over 24 KB.
// They carry `origin: "rovara"`: they name no reviewer and no raw finding, and cite the design section they are about. Pure and bounded.
import { DESIGN_FINDING_TEXT_MAX_CHARS, DESIGN_LOST_FINDING_ID_PREFIX, DESIGN_SECTIONS, DESIGN_TEXT_MAX_BYTES, DESIGN_REVIEW_FINDINGS_MAX, designFindingFingerprint, type DesignFinding, type DroppedFinding } from "@agentx/contracts";

/** At most this many requirements get a finding each; any more are listed in one finding, so a design that covers nothing cannot fill the card. */
export const OWN_FINDINGS_PER_REQUIREMENT_MAX = 12;
/** Requirement ids are short names the approved requirements use, such as R1 or REQ-7. Anything else is not matched by name. */
const REQUIREMENT_ID = /^[A-Za-z][A-Za-z0-9._-]{0,31}$/u;

const HEADING = /^\s{0,3}#{1,6}\s+(.*)$/u;
// "§3 Proposed design", "3. Proposed design", "3 - Proposed design". A subsection heading ("3.1 Interfaces", "§3.2") is not a new section.
const SECTION_HEADING = /^(?:§\s*)?([1-8])(?![0-9]|\.[0-9])(?:[\s.:)\-–—]|$)/u;

/** The numbers (1 to 8) of the section headings the design has outside code fences. A subsection heading ("### 3.1 Interfaces") does not count. */
export function designSectionNumbers(design: string): Set<number> {
  const found = new Set<number>();
  let fenced = false;
  for (const line of design.split(/\r?\n/u)) {
    if (/^\s{0,3}(```|~~~)/u.test(line)) { fenced = !fenced; continue; }
    const heading = fenced ? null : HEADING.exec(line);
    const section = heading === null ? null : SECTION_HEADING.exec(heading[1]!.replace(/^\*+\s*/u, ""));
    if (section !== null) found.add(Number(section[1]));
  }
  return found;
}

/** The text of the design's §3, from its heading to the next section heading. Undefined when there is no §3. Subsections ("### 3.1 ...") are part of it. */
export function designSectionThree(design: string): string | undefined {
  const lines = design.split(/\r?\n/u);
  let inside = false;
  let found = false;
  const kept: string[] = [];
  let fenced = false;
  for (const line of lines) {
    if (/^\s{0,3}(```|~~~)/u.test(line)) fenced = !fenced;
    const heading = fenced ? null : HEADING.exec(line);
    const section = heading === null ? null : SECTION_HEADING.exec(heading[1]!.replace(/^\*+\s*/u, ""));
    if (section !== null) {
      inside = section[1] === "3";
      found ||= inside;
      if (inside) continue;
    }
    if (inside) kept.push(line);
  }
  return found ? kept.join("\n") : undefined;
}

function mentions(text: string, id: string): boolean {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`, "u").test(text);
}

/** The ids, in the order given, that §3 never mentions. An id of an unexpected shape is never matched: it counts as missing (fail closed). */
export function requirementsMissingFromDesign(design: string, requirementIds: readonly string[]): string[] {
  const three = designSectionThree(design) ?? "";
  const seen = new Set<string>();
  const missing: string[] = [];
  for (const id of requirementIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (!REQUIREMENT_ID.test(id) || !mentions(three, id)) missing.push(id);
  }
  return missing;
}

function ownFinding(id: string, severity: DesignFinding["severity"], section: DesignFinding["section"], text: string): DesignFinding {
  const cut = Array.from(text).slice(0, DESIGN_FINDING_TEXT_MAX_CHARS).join("");
  return { id, severity, section, text: cut, citations: [{ kind: "design", section }], origin: "rovara", fromReviewers: [], rawIds: [], fingerprint: designFindingFingerprint({ section, text: cut }) };
}

/** Plain text for a finding: an id from the approved requirements, cleaned of anything that is not a name. */
function shownId(id: string): string {
  return REQUIREMENT_ID.test(id) ? id : "(a requirement with an unreadable id)";
}

export function ownDesignFindings(input: { design: string; requirementIds: readonly string[] }): DesignFinding[] {
  const findings: DesignFinding[] = [];
  const missing = requirementsMissingFromDesign(input.design, input.requirementIds);
  for (const id of missing.slice(0, OWN_FINDINGS_PER_REQUIREMENT_MAX)) {
    const shown = shownId(id);
    findings.push(ownFinding(`rovara-${REQUIREMENT_ID.test(id) ? id : `x${findings.length + 1}`}`.slice(0, 64), "blocker", "§3", `Requirement ${shown} appears in no §3 subsection, so nothing says how it will be built. Add a §3 subsection that covers it, or ask for the requirement to be removed.`));
  }
  const rest = missing.slice(OWN_FINDINGS_PER_REQUIREMENT_MAX);
  if (rest.length > 0) {
    const names = rest.slice(0, 10).map(shownId).join(", ");
    findings.push(ownFinding("rovara-requirements-more", "blocker", "§3", `${rest.length} more requirements appear in no §3 subsection: ${names}${rest.length > 10 ? ", and others" : ""}. Cover each in §3.`));
  }
  if (Buffer.byteLength(input.design, "utf8") > DESIGN_TEXT_MAX_BYTES) {
    findings.push(ownFinding("rovara-too-long", "major", "§1", `Too long: split the work. The design is over ${DESIGN_TEXT_MAX_BYTES / 1024} KB, more than a reviewer or an approver can check well. Split it into designs that can each be reviewed and built on their own.`));
  }
  return findings.slice(0, DESIGN_REVIEW_FINDINGS_MAX);
}

/**
 * A blocker no reader could show: a blocking finding of a reviewer that the reader dropped (a field was not valid, or no citation had an allowed shape; NOT one the citation check dropped for naming something the reviewer never saw, which counts for nothing), and findings whose severity could not be read (they may have been
 * blockers). Each becomes ONE finding of the broker's own, with fixed words and no model text, so it counts as an open blocker like any other: the approve_design card lists it, the approver needs a reason
 * to approve past it, and the Proof line counts it. A lost blocker is therefore never a clean review. One finding per section (so two never share a fingerprint), and one for the unreadable ones.
 */
export function lostBlockerFindings(input: { dropped: readonly DroppedFinding[]; unreadableMaybeBlockers: number }): DesignFinding[] {
  const findings: DesignFinding[] = [];
  for (const section of DESIGN_SECTIONS) {
    const count = input.dropped.filter((entry) => entry.severity === "blocker" && entry.section === section).length;
    if (count === 0) continue;
    const who = count === 1 ? "A reviewer's blocking finding" : `${String(count)} blocking findings from reviewers`;
    findings.push(ownFinding(`${DESIGN_LOST_FINDING_ID_PREFIX}${section.slice(1)}`, "blocker", section, `${who} about ${section} could not be read (a field was not valid, or no citation held), so it is not shown here. Have the design reviewed again before approving, or approve with a reason.`));
  }
  if (input.unreadableMaybeBlockers > 0) {
    const who = input.unreadableMaybeBlockers === 1 ? "A reviewer's finding" : `${String(input.unreadableMaybeBlockers)} findings from reviewers`;
    findings.push(ownFinding(`${DESIGN_LOST_FINDING_ID_PREFIX}unread`, "blocker", "§3", `${who} with no readable severity or section could not be read, and may have been a blocker. Have the design reviewed again before approving, or approve with a reason.`));
  }
  return findings;
}

const RANK: Record<DesignFinding["severity"], number> = { blocker: 0, major: 1, nit: 2 };

/**
 * The findings of a round: the broker's own first, then the reviewers' most serious first, at most 30 in all. When the list is too long the lowest severities of the reviewers' findings are left out
 * (`omitted` counts them); the broker's own findings are never cut. Ids stay unique: a reviewer finding whose id equals an own finding's is renumbered.
 */
export function withOwnFindings(reviewerFindings: readonly DesignFinding[], own: readonly DesignFinding[]): { findings: DesignFinding[]; omitted: number } {
  const room = Math.max(0, DESIGN_REVIEW_FINDINGS_MAX - own.length);
  // N6: a reviewer finding that says what an own finding says (the same fingerprint) is folded into it, not added beside it: two findings of one round may not share a fingerprint, and injected text could steer a reviewer into copying one.
  const ownPrints = new Set(own.map((finding) => finding.fingerprint));
  const ordered = reviewerFindings.filter((finding) => !ownPrints.has(finding.fingerprint)).map((finding, index) => ({ finding, index })).sort((a, b) => RANK[a.finding.severity] - RANK[b.finding.severity] || a.index - b.index).map(({ finding }) => finding);
  const used = new Set(own.map((finding) => finding.id));
  const kept = ordered.slice(0, room).map((finding) => {
    if (!used.has(finding.id)) { used.add(finding.id); return finding; }
    let n = 2;
    while (used.has(`${finding.id}-${n}`)) n += 1;
    const id = `${finding.id}-${n}`.slice(0, 64);
    used.add(id);
    return { ...finding, id };
  });
  return { findings: [...own, ...kept], omitted: ordered.length - kept.length };
}
