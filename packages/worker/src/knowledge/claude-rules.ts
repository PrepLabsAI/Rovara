// Knowledge resolver (K1, C1): Claude Code rules, `.claude/rules/**/*.md`.
// `paths:` (a list, or a comma-separated string) scopes a rule to matching files; a rule with no `paths` is always on. Source: ACR 3.1.
import { asPatternList, parseFrontMatter } from "./frontmatter.js";
import type { KnowledgeFormatReader } from "./reader.js";

export const claudeRulesReader: KnowledgeFormatReader = {
  id: "claude_rules",
  discovery: { directories: [".claude/rules"] },
  accepts: (path) => path.startsWith(".claude/rules/") && path.endsWith(".md"),
  parse: (_path, text) => {
    const parsed = parseFrontMatter(text);
    if (!parsed.ok) return { ok: false, reason: "bad_front_matter" };
    const { data, body } = parsed;
    if (data.paths === undefined) return { ok: true, value: { activation: "always", body, imports: "claude" } };
    const patterns = asPatternList(data.paths, { splitCommas: true });
    if (patterns === undefined) return { ok: false, reason: "bad_front_matter" };
    return { ok: true, value: { activation: "fileMatch", patterns, body, imports: "claude" } };
  },
};
