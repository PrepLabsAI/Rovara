// What the agent sees from a tier-0 lesson is RENDERED here, never stored text (owner direction after the fifth re-check).
// A tier-0 lesson is a structured fact: fixed template wording plus slots. The renderer is the only author of its title, description and body, and it fills a
// slot only with a value that passes the check for that slot:
//   - a word of the closed list (guards.ts FIXED_WORDS), or a word of an identifier that really occurs in the cited code at the cited commit (comments, strings
//     and anchor text never supply words), at most two such words per slot;
//   - a name or library: a whole identifier that occurs in the cited code, in a strict character set;
//   - a path or a scope path: a strict token that exists in the repository tree at the cited commit, and does not touch tests, CI, auth or secrets;
//   - a repository: one of the project\'s repositories.
// Anything that does not fit is not tier 0 and is held for a person. The rendered text is screened once more, as a last check.
import { foldForMatching } from "@agentx/contracts";
import { hasCommandOrUrl, hasEncodedBlob, hasEscalationWords, isPlainSlot, isPlainToken, parseDeclarative, requestsCapabilityChange, touchesRiskyPath, vocabularyOf } from "./guards.js";
import type { Lesson, LessonCitation } from "./types.js";

type Renderable = { type: Lesson["type"]; body: string; scope: Lesson["scope"]; citations: readonly LessonCitation[] };

/** What was verified against the repository at the cited commit. Built from the facts port; never from the lesson\'s own text. */
export interface VerifiedMaterial {
  /** Identifier tokens of the cited code lines (comments and string literals excluded). */
  identifiers: ReadonlySet<string>;
  /** Paths and path globs that exist in the tree (a glob: its literal directory prefix exists). */
  paths: ReadonlySet<string>;
  /** The project\'s repositories that the lesson names. */
  repos: ReadonlySet<string>;
}
export interface Tier0Text { title: string; description: ""; body: string }

/** A path, glob or repository name as it may appear in a scope: path characters only, bounded. Free text has spaces and never matches. */
export const STRICT_TOKEN = /^[A-Za-z0-9_./*@-]{1,100}$/u;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,59}$/u;
const VERSION = /^\d+(?:\.\d+){0,2}$/u;

/** Every path the renderer will want checked against the tree: scope paths, code-citation paths and the paths in the body. */
export function pathsToVerify(lesson: Pick<Renderable, "scope" | "citations" | "body">): string[] {
  const body = parseDeclarative(lesson.body);
  return [...new Set([...(lesson.scope.paths ?? []), ...lesson.citations.flatMap((c) => (c.kind === "code" ? [c.path] : [])), ...(body?.path === undefined ? [] : [body.path])])].filter((p) => STRICT_TOKEN.test(p));
}

/** The words an identifier is made of (camelCase and snake_case parts), lower-cased, with the whole token. */
export const identifierWords = (identifiers: Iterable<string>): Set<string> => vocabularyOf(...identifiers);

export function renderTier0(lesson: Renderable, m: VerifiedMaterial | undefined): Tier0Text | undefined {
  if (m === undefined || lesson.type !== "fact") return undefined;
  // The scope is part of what the agent sees (its label): one project repository, and verified paths only.
  const repos = lesson.scope.repos ?? [];
  if (repos.length !== 1 || !repos.every((r) => STRICT_TOKEN.test(r) && m.repos.has(r))) return undefined;
  if (!(lesson.scope.paths ?? []).every((p) => STRICT_TOKEN.test(p) && m.paths.has(p) && !touchesRiskyPath([p]))) return undefined;
  if (!(lesson.scope.languages ?? []).every((l) => /^[a-z][a-z0-9+#-]{0,19}$/u.test(l))) return undefined;

  const fact = parseDeclarative(lesson.body);
  if (fact === undefined) return undefined;
  if (!isPlainSlot(fact.thing, identifierWords(m.identifiers))) return undefined;
  const pathOk = (p: string | undefined): boolean => p === undefined || (STRICT_TOKEN.test(p) && isPlainToken(p, "path") && !/^[~/]/u.test(p) && m.paths.has(p) && !touchesRiskyPath([p]));
  const nameOk = (n: string | undefined): n is string => n !== undefined && IDENT.test(n) && m.identifiers.has(n);
  const thing = fact.thing.replace(/\s+/gu, " ").trim();

  let title: string;
  let body: string;
  if (fact.kind === "location") {
    if (!pathOk(fact.path) || fact.path === undefined) return undefined;
    title = `Location of ${thing}`;
    body = `The ${thing} is in ${fact.path}.`;
  } else if (fact.kind === "name") {
    if (!nameOk(fact.name)) return undefined;
    title = `Name of ${thing}`;
    body = `The ${thing} is called ${fact.name}.`;
  } else {
    if (!nameOk(fact.name) || !pathOk(fact.path) || (fact.version !== undefined && !VERSION.test(fact.version))) return undefined;
    title = `Library used by ${thing}`;
    body = `The ${thing} uses ${fact.name}${fact.version === undefined ? "" : ` ${fact.version}`}${fact.path === undefined ? "" : ` from ${fact.path}`}.`;
  }
  if (title.length > 80 || body.length > 600) return undefined;
  // The last check, on the final text: the same screens every other text goes through.
  const text = `${title}\n${body}`;
  const folded = foldForMatching(text);
  if (requestsCapabilityChange(text) || hasEscalationWords(text) || hasCommandOrUrl(text) || hasEncodedBlob(text) || /[<>{}`$|;\\]/u.test(folded)) return undefined;
  return { title, description: "", body };
}

/** The scope as shown to the agent: only strict path-like tokens ever appear, so free text in a stored scope cannot reach a prompt. */
export function safeScopeLabel(scope: Lesson["scope"]): string {
  const keep = (list: readonly string[] | undefined): string[] => (list ?? []).filter((s) => STRICT_TOKEN.test(s)).slice(0, 8);
  const parts = [...(keep(scope.repos).length > 0 ? [`repo ${keep(scope.repos).join(", ")}`] : []), ...(keep(scope.paths).length > 0 ? [keep(scope.paths).join(", ")] : [])];
  return parts.join(" ").slice(0, 200);
}
