// Design review stage: which sections of the APPROVED design cover a requirement, for the Proof table's "design §3.2" links.
// PURE. The only inputs are the claim ids of the approved plan and the approved design's text with the digest the approval named. The text must hash to that digest; anything else gives no links.
// A link is a `§3.N` subsection that EXISTS in that text as a heading and that mentions the requirement in its own prose (outside code fences). Nothing is guessed, filled in from a parent or
// taken from a finding or a model: a claim no subsection names gets no link, and the row reads as it did before.
import { createHash } from "node:crypto";
import { nextFenceState } from "@agentx/contracts";

/** A claim has at most this many design links on its row (the table is public and bounded). */
export const PROOF_DESIGN_LINKS_PER_CLAIM_MAX = 3;
/** A design has at most this many §3 subsections that count. */
export const DESIGN_SUBSECTIONS_MAX = 40;

export interface DesignSubsection {
  /** `§3.2`: the id findings and the Proof table use. */
  id: string;
  /** The prose under the heading, outside code fences, up to the next heading of the same or a higher level. */
  prose: string;
}

/** The SHA-256 of a design's text, as the artifact digest is taken. */
export const designTextDigest = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

// "### 3.2 Title", "## §3.2 Title", "#### 3.2. Title", "### 3.2: Title". A heading whose number is not exactly 3.<n> (3, 3.2.1, 33.1, 4.2) is not a §3 subsection.
const SUBSECTION_HEADING = /^ {0,3}(#{1,6})\s+(?:§\s*)?3\.([1-9]\d?)(?![\d.]*\d)(?:[\s.:)–—-]|$)/u;
const ANY_HEADING = /^ {0,3}(#{1,6})\s+\S/u;

/** The §3 subsections of a design, in the order they appear. A repeated number keeps its first heading only. */
export function designSubsections(text: string): DesignSubsection[] {
  const found: Array<DesignSubsection & { level: number; lines: string[] }> = [];
  let open: (typeof found)[number] | undefined;
  let fence: ReturnType<typeof nextFenceState>;
  for (const line of text.replace(/\r\n?/gu, "\n").split("\n")) {
    const inside = fence !== undefined;
    fence = nextFenceState(fence, line);
    if (inside || fence !== undefined) continue;
    const heading = ANY_HEADING.exec(line);
    if (heading !== null) {
      const level = heading[1]!.length;
      if (open !== undefined && level <= open.level) open = undefined;
      const sub = SUBSECTION_HEADING.exec(line);
      if (sub !== null) {
        const id = `§3.${sub[2]!}`;
        if (found.length < DESIGN_SUBSECTIONS_MAX && !found.some((entry) => entry.id === id)) {
          open = { id, level: sub[1]!.length, prose: "", lines: [] };
          found.push(open);
        } else open = undefined;
      }
      continue;
    }
    if (/^ {0,3}(?:`{3,}|~{3,})/u.test(line)) continue;
    open?.lines.push(line);
  }
  return found.map(({ id, lines }) => ({ id, prose: lines.join("\n") }));
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * Whether `prose` names the requirement. A requirement id of the form `R1` or `4.2` is written `R1` / `R4.2` in a design (the template's "R1..Rn"); any other id is written as it is. The token must stand alone:
 * `R1` is not found in `R1.2`, `R10` or `AR1`, and a bare number is never taken as a requirement (it would match section numbers).
 */
export function proseNamesRequirement(prose: string, claimId: string): boolean {
  const numeric = /^\d+(?:\.\d+)*$/u.test(claimId);
  const spelled = numeric ? `R${claimId}` : claimId;
  if (spelled === "" || spelled.length > 64) return false;
  return new RegExp(`(?<![A-Za-z0-9_.-])${escapeRegExp(spelled)}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`, "u").test(prose);
}

export interface ApprovedDesignText {
  /** The digest the approval named. */
  digest: string;
  /** The design's text. It must hash to `digest`. */
  text: string;
}

/** The approved design's text as the broker may use it: only when it hashes to the digest the approval named. */
export function verifiedDesignText(approved: ApprovedDesignText | undefined): string | undefined {
  if (approved === undefined || !/^[a-f0-9]{64}$/u.test(approved.digest)) return undefined;
  return designTextDigest(approved.text) === approved.digest ? approved.text : undefined;
}

/**
 * For each claim id, the `§3.N` subsections of the approved design that name it (at most three, in design order). A claim no existing subsection names is absent from the map. A design that does not
 * hash to the approved digest gives an empty map.
 */
export function designLinksByClaim(claimIds: readonly string[], approved: ApprovedDesignText | undefined): Map<string, string[]> {
  const links = new Map<string, string[]>();
  const text = verifiedDesignText(approved);
  if (text === undefined) return links;
  const subsections = designSubsections(text);
  for (const claimId of claimIds) {
    const covering = subsections.filter((section) => proseNamesRequirement(section.prose, claimId)).map((section) => section.id).slice(0, PROOF_DESIGN_LINKS_PER_CLAIM_MAX);
    if (covering.length > 0) links.set(claimId, covering);
  }
  return links;
}
