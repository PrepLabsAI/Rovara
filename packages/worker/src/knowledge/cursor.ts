// Knowledge resolver (K1, C1): Cursor rules, `.cursor/rules/**/*.mdc` (and `.md`).
// `alwaysApply: true` is always on; `globs` makes it a file-match rule; a `description` alone makes it an auto rule (the model decides);
// none of them makes it manual (named as `@rule`, or `#name` here). Source: ACR 3.5.
import { asPatternList, parseFrontMatter } from "./frontmatter.js";
import type { KnowledgeFormatReader } from "./reader.js";
import { ruleStem } from "./reader.js";

export const cursorReader: KnowledgeFormatReader = {
  id: "cursor_mdc",
  discovery: { directories: [".cursor/rules"] },
  accepts: (path) => path.startsWith(".cursor/rules/") && (path.endsWith(".mdc") || path.endsWith(".md")),
  parse: (path, text) => {
    const parsed = parseFrontMatter(text);
    if (!parsed.ok) return { ok: false, reason: "bad_front_matter" };
    const { data, body } = parsed;
    if (data.alwaysApply !== undefined && typeof data.alwaysApply !== "boolean") return { ok: false, reason: "bad_front_matter" };
    if (data.alwaysApply === true) return { ok: true, value: { activation: "always", body, imports: "none" } };
    if (data.globs !== undefined) {
      const patterns = asPatternList(data.globs, { splitCommas: true });
      if (patterns === undefined) return { ok: false, reason: "bad_front_matter" };
      return { ok: true, value: { activation: "fileMatch", patterns, body, imports: "none" } };
    }
    const description = typeof data.description === "string" && data.description.trim() !== "" ? data.description.trim() : undefined;
    if (description !== undefined) return { ok: true, value: { activation: "auto", name: ruleStem(path), description, body, imports: "none" } };
    return { ok: true, value: { activation: "manual", name: ruleStem(path), body, imports: "none" } };
  },
};
