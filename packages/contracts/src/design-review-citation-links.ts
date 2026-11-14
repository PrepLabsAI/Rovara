// Design review stage (DR11 UI): the browser-safe half of the citation rules. The task page shows a reviewer's code citation as a path, or as "not checked" when it matched nothing the reviewer was given, and builds
// a link only from `codeCitationLinkPath`. These functions moved here, unchanged, from design-review-citations.ts (which re-exports them) so the web entry takes no Node-only code. Pure.
import type { DesignCitation } from "./design-review.js";

/** The parts of a packet item that a citation is checked against. */
export interface CitablePacketItem {
  kind: string;
  ref: string;
  commitOrFetchedAt: string;
  digest: string;
}

/** The path rules of the code host's reader: relative, no empty, dot or dot-dot segment, no backslash, no hidden characters. */
export function plainPath(path: string): boolean {
  if (path.length === 0 || path.length > 512 || path.includes("\\") || /[\p{Cc}\p{Cf}"<>]/u.test(path)) return false;
  if (hasDotSegment(path)) return false;
  // A percent-encoded dot segment (`%2e%2e`, also encoded twice) is a dot segment to whoever decodes it later: refused too.
  let decoded = path;
  for (let round = 0; round < 3 && /%[0-9a-f]{2}/iu.test(decoded); round += 1) {
    try { decoded = decodeURIComponent(decoded); } catch { return false; }
    if (decoded.includes("\\") || /[\p{Cc}\p{Cf}]/u.test(decoded) || hasDotSegment(decoded)) return false;
  }
  return true;
}
const hasDotSegment = (path: string): boolean => path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");

/**
 * The path of a link to a code citation: each segment is URL-encoded on its own, so `%2e%2e` becomes `%252e%252e` and cannot be read back as `..`, and a `?` or `#` stays part of the name.
 * Undefined when the citation's path or commit is not plain (a link is never built from one). The card shows such a citation as "not checked" (`CODE_CITATION_UNCHECKED`) unless it matched a packet item.
 */
export function codeCitationLinkPath(citation: Extract<DesignCitation, { kind: "code" }>): string | undefined {
  if (!/^[a-f0-9]{7,40}$/u.test(citation.commit) || !plainPath(citation.path)) return undefined;
  return `${encodeURIComponent(citation.commit)}/${citation.path.split("/").map((segment) => encodeURIComponent(segment)).join("/")}`;
}

/** The words on the card after a code citation that did not match an item a reviewer was given: the path is the reviewer's claim about the pinned commit, not something Rovara looked up. */
export const CODE_CITATION_UNCHECKED = "path at the pinned commit, not checked";

/** Whether a code citation matches a repository file the reviewer was GIVEN (same repo, path and commit prefix), as opposed to a path at the pin that nobody opened. */
export function codeCitationInPacket(citation: Extract<DesignCitation, { kind: "code" }>, items: readonly CitablePacketItem[]): boolean {
  const ref = codeRefOf(citation);
  return items.some((item) => item.kind === "repo_file" && item.ref === ref && item.commitOrFetchedAt.startsWith(citation.commit));
}

function codeRefOf(citation: Extract<DesignCitation, { kind: "code" }>): string {
  return `${citation.repo}:${citation.path}`;
}

