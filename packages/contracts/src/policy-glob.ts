/** Customer globs are a bounded finite-state machine, never a regular expression or a backtracking search. */
export const POLICY_PATTERN_MAX = 256;
export const POLICY_PATH_MAX = 512;
const HIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/u;

export function validPolicyPath(value: unknown, max = POLICY_PATH_MAX): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || HIDDEN.test(value)) return false;
  if (value.startsWith("/") || value.includes("\\") || /^[A-Za-z]:/u.test(value)) return false;
  return !value.split("/").some((part) => part === ".." || part === "." || part === "");
}

type Token = { kind: "literal"; text: string } | { kind: "one" | "star" | "all" | "dirs" | "dir_tail" };
export interface PolicyGlobResult { matched: boolean; steps: number; reason?: "invalid_pattern" | "invalid_path" }

/**
 * A forward-only NFA: a star retains its state; epsilon edges only move forward.
 * A double star followed by a slash has an entry and tail, so it accepts zero directories but never half a directory.
 * At most 257 states and two visits/state/character: steps <= 1024*(pattern units + path units + 1).
 * Thus work is linear in input bytes under the fixed pattern cap, even for alternating stars.
 * `steps` counts compilation, consumed characters, and active closure/transition visits only.
 */
export function matchPolicyGlob(pattern: unknown, path: unknown): PolicyGlobResult {
  if (!validPolicyPath(pattern, POLICY_PATTERN_MAX)) return { matched: false, steps: 0, reason: "invalid_pattern" };
  if (!validPolicyPath(path)) return { matched: false, steps: 0, reason: "invalid_path" };
  const tokens: Token[] = [];
  let steps = 0;
  const points = Array.from(pattern);
  for (let i = 0; i < points.length; i += 1) {
    steps += 1;
    const text = points[i]!;
    if (text === "*" && points[i + 1] === "*") {
      while (points[i + 1] === "*") { i += 1; steps += 1; }
      if (points[i + 1] === "/") { tokens.push({ kind: "dirs" }, { kind: "dir_tail" }); i += 1; }
      else tokens.push({ kind: "all" });
    } else if (text === "*") tokens.push({ kind: "star" });
    else if (text === "?") tokens.push({ kind: "one" });
    else tokens.push({ kind: "literal", text });
  }
  const close = (states: Set<number>): void => {
    // Set iteration visits newly added forward epsilon states once, without scanning dead states.
    for (const i of states) {
      steps += 1;
      if (i === tokens.length) continue;
      const kind = tokens[i]!.kind;
      if (kind === "star" || kind === "all") states.add(i + 1);
      if (kind === "dirs") { states.add(i + 1); states.add(i + 2); }
    }
  };
  let states = new Set([0]); close(states);
  // Limits count UTF-16 units; matching counts Unicode characters. Unpaired surrogates are refused.
  for (const character of path) {
    steps += 1;
    const next = new Set<number>();
    for (const i of states) {
      steps += 1;
      if (i === tokens.length) continue;
      const token = tokens[i]!;
      if (token.kind === "literal" && token.text === character || token.kind === "one" && character !== "/") next.add(i + 1);
      if (token.kind === "star" && character !== "/" || token.kind === "all") next.add(i);
      if (token.kind === "dir_tail") { next.add(i); if (character === "/") next.add(i + 1); }
    }
    if (next.size === 0) return { matched: false, steps };
    close(next); states = next;
  }
  return { matched: states.has(tokens.length), steps };
}
