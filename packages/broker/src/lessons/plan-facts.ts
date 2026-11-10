// What the lesson loader is told about a task besides its title (review: the dispatch passed `files: []` and no plan summary, so path scopes never filtered and similarity had
// nothing to read). From the task's latest plan document, by its own structure: a short summary (the title and the top-level claims) and the files it names (the code it cites, and the files its claims
// name in words). Pure and bounded. A path that is absolute, climbs out of the repository or is not a plain relative path is left out: this feeds a glob match, nothing else.
import type { PlanClaim, PlanDocument } from "@agentx/contracts";
import { cleanLessonText } from "@agentx/contracts";

export const PLAN_FACTS_SUMMARY_MAX = 600;
export const PLAN_FACTS_MAX_FILES = 30;
const PATH_MAX = 200;
const EXTENSIONS = "[cm]?[jt]sx?|py|go|rs|java|kt|rb|php|cs|swift|json|ya?ml|toml|md|sql|css|scss|html|sh|tf|proto|graphql|xml|ini|gradle|cpp|hpp";
/** A name with a known extension at the start of a word or after a path: `src/charge.ts`, `./run.sh`. The middle of a link is not one (a name must start a word, and `://` precedes it). */
const FILE_IN_WORDS = new RegExp(`(?<![\\w@/.:-])((?:\\.{1,2}/)?(?:[\\w@.-]+/)*[\\w@-][\\w@.-]*\\.(?:${EXTENSIONS}))(?![\\w-])`, "gu");

const plainRelative = (path: string): string | undefined => {
  const clean = path.replace(/^\.\//u, "");
  if (clean === "" || clean.length > PATH_MAX || clean.startsWith("/") || clean.split("/").some((part) => part === ".." || part === "." || part === "") || /[\p{Cc}\p{Cf}\s*?[\]{}]/u.test(clean)) return undefined;
  return clean;
};

function claimsDepthFirst(claims: readonly PlanClaim[]): PlanClaim[] {
  return claims.flatMap((claim) => [claim, ...claimsDepthFirst(claim.children ?? [])]);
}

export interface PlanLoadFacts { summary: string; files: string[] }

export function planLoadFacts(plan: PlanDocument): PlanLoadFacts {
  const summary = cleanLessonText([plan.title, ...plan.claims.map((claim) => claim.text)].join("\n"), PLAN_FACTS_SUMMARY_MAX);
  const files = new Set<string>();
  const add = (path: string): void => { const clean = plainRelative(path); if (clean !== undefined && files.size < PLAN_FACTS_MAX_FILES) files.add(clean); };
  for (const claim of claimsDepthFirst(plan.claims)) {
    for (const item of claim.evidence ?? []) if (item.kind === "code") add(item.path);
    for (const match of claim.text.matchAll(FILE_IN_WORDS)) add(match[1]!);
  }
  return { summary, files: [...files] };
}
