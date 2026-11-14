// Knowledge resolver (K1, C1): a small glob matcher for the patterns rule files carry (`fileMatchPattern`, `globs`, `applyTo`, `paths`).
//
// A rule file is written by whoever can push to a repository, so its patterns are untrusted input. This matcher never builds a regular
// expression from a pattern: a pattern is split into path segments, `**` is matched by a memoised walk, and a segment is matched by the
// iterative two-pointer algorithm, so no pattern can make a match take more than (pattern segments x path segments x segment lengths).
// Patterns and paths are also bounded, and a pattern that is too long or has too many braces matches nothing (fail closed).

export const MAX_GLOB_PATTERN_LENGTH = 256;
export const MAX_GLOB_ALTERNATIVES = 32;
const MAX_PATH_SEGMENTS = 64;

/** One `{a,b}` group expanded, left to right; nested groups are expanded too. `undefined` when the result would be too large. */
export function expandBraces(pattern: string): string[] | undefined {
  const open = pattern.indexOf("{");
  if (open < 0) return [pattern];
  let depth = 0;
  let close = -1;
  const commas: number[] = [];
  for (let index = open; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "\\") { index += 1; continue; }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) { close = index; break; }
    } else if (char === "," && depth === 1) commas.push(index);
  }
  // An unbalanced or comma-less group is literal text, as most glob libraries treat it.
  if (close < 0 || commas.length === 0) {
    const rest = expandBraces(pattern.slice(open + 1));
    return rest === undefined ? undefined : rest.map((tail) => `${pattern.slice(0, open + 1)}${tail}`);
  }
  const head = pattern.slice(0, open);
  const tail = pattern.slice(close + 1);
  const bounds = [open, ...commas, close];
  const results: string[] = [];
  for (let index = 0; index < bounds.length - 1; index += 1) {
    const choice = pattern.slice(bounds[index]! + 1, bounds[index + 1]);
    const expanded = expandBraces(`${head}${choice}${tail}`);
    if (expanded === undefined) return undefined;
    results.push(...expanded);
    if (results.length > MAX_GLOB_ALTERNATIVES) return undefined;
  }
  return results;
}

/** Whether one path segment matches one pattern segment (`*`, `?`, `[a-z]`, `[!a-z]`, `\x`), iteratively. */
function matchSegment(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let starP = -1;
  let starT = 0;
  while (t < text.length) {
    const char = pattern[p];
    if (char === "*") { starP = p; starT = t; p += 1; continue; }
    if (char !== undefined) {
      const step = matchOne(pattern, p, text[t] as string);
      if (step > 0) { p += step; t += 1; continue; }
    }
    if (starP >= 0) { starT += 1; t = starT; p = starP + 1; continue; }
    return false;
  }
  while (pattern[p] === "*") p += 1;
  return p === pattern.length;
}

/** How many pattern characters match `char` at `p` (`?`, a class, an escape or a literal), or 0 when they do not. */
function matchOne(pattern: string, p: number, char: string): number {
  const current = pattern[p]!;
  if (current === "?") return 1;
  if (current === "\\" && p + 1 < pattern.length) return pattern[p + 1] === char ? 2 : 0;
  if (current === "[") {
    const close = pattern.indexOf("]", p + 2);
    if (close < 0) return char === "[" ? 1 : 0;
    let body = pattern.slice(p + 1, close);
    const negate = body.startsWith("!") || body.startsWith("^");
    if (negate) body = body.slice(1);
    let hit = false;
    for (let index = 0; index < body.length; index += 1) {
      if (body[index + 1] === "-" && index + 2 < body.length) {
        if (char >= body[index]! && char <= body[index + 2]!) hit = true;
        index += 2;
      } else if (body[index] === char) hit = true;
    }
    return hit !== negate ? close - p + 1 : 0;
  }
  return current === char ? 1 : 0;
}

function matchSegments(patternSegments: readonly string[], pathSegments: readonly string[]): boolean {
  const memo = new Map<number, boolean>();
  const width = pathSegments.length + 1;
  const walk = (pi: number, ti: number): boolean => {
    const key = pi * width + ti;
    const known = memo.get(key);
    if (known !== undefined) return known;
    let result: boolean;
    if (pi === patternSegments.length) result = ti === pathSegments.length;
    else if (patternSegments[pi] === "**") {
      // `**` matches zero or more whole segments; a trailing `**` also matches everything below.
      result = walk(pi + 1, ti) || (ti < pathSegments.length && walk(pi, ti + 1));
    } else result = ti < pathSegments.length && matchSegment(patternSegments[pi]!, pathSegments[ti]!) && walk(pi + 1, ti + 1);
    memo.set(key, result);
    return result;
  };
  return walk(0, 0);
}

/**
 * Whether `path` (repository-relative, `/`-separated) matches `pattern`. A pattern with no `/` matches the file name at any depth (the
 * convention of Cursor's `*.tsx` and Copilot's `*.ts`); a leading `./` or `/` is dropped; a pattern ending in `/` means everything below.
 * Too long a pattern, too many alternatives or too deep a path matches nothing.
 */
export function matchesGlob(pattern: string, path: string): boolean {
  const trimmed = pattern.trim();
  if (trimmed === "" || trimmed.length > MAX_GLOB_PATTERN_LENGTH) return false;
  const alternatives = expandBraces(trimmed);
  if (alternatives === undefined) return false;
  const pathSegments = path.split("/").filter((segment) => segment !== "");
  if (pathSegments.length === 0 || pathSegments.length > MAX_PATH_SEGMENTS) return false;
  for (const alternative of alternatives) {
    let rooted = alternative.replace(/^\.\//u, "");
    let segments: string[];
    if (rooted.endsWith("/")) rooted = `${rooted}**`;
    if (!rooted.includes("/")) segments = ["**", rooted];
    else segments = rooted.replace(/^\//u, "").split("/").filter((segment) => segment !== "");
    if (segments.length > MAX_PATH_SEGMENTS) continue;
    if (matchSegments(segments, pathSegments)) return true;
  }
  return false;
}

/** The first of `patterns` that `path` matches, for the manifest's "matched: <path>" line. */
export function firstMatchingPattern(patterns: readonly string[], path: string): string | undefined {
  return patterns.find((pattern) => matchesGlob(pattern, path));
}

/** `text` as a literal in a pattern: every character the matcher reads as syntax is escaped. */
export function escapeGlob(text: string): string {
  return text.replace(/[\\*?[\]{}!^,]/gu, "\\$&");
}
