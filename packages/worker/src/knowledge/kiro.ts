// Knowledge resolver (K1, C1): Kiro steering files, `.kiro/steering/*.md`.
// Source: kiro.dev/docs/steering (page dated 21 Oct 2026). Front matter must be the first thing in the file. `inclusion` is `always`
// (the default), `fileMatch` with `fileMatchPattern` (a string or a list), `manual` (named in a request as `#name`) or `auto` (needs `name`
// and `description`). File references are `#[[file:<path>]]`, `#[[file:<path>:<line>]]`, `#[[file:<path>:<start>-<end>]]` and
// `#[[folder:<path>]]` (imports.ts).
import { asPatternList, parseFrontMatter } from "./frontmatter.js";
import type { KnowledgeFormatReader } from "./reader.js";
import { ruleStem } from "./reader.js";

const INCLUSIONS = new Set(["always", "fileMatch", "manual", "auto"]);

export const kiroSteeringReader: KnowledgeFormatReader = {
  id: "kiro_steering",
  discovery: { directories: [".kiro/steering"], hookDirectories: [".kiro/hooks"], skillDirectories: [".kiro/skills"] },
  accepts: (path) => path.startsWith(".kiro/steering/") && path.endsWith(".md"),
  parse: (path, text) => {
    const parsed = parseFrontMatter(text);
    if (!parsed.ok) return { ok: false, reason: "bad_front_matter" };
    const { data, body } = parsed;
    const inclusion = data.inclusion === undefined ? "always" : data.inclusion;
    if (typeof inclusion !== "string" || !INCLUSIONS.has(inclusion)) return { ok: false, reason: "bad_front_matter" };
    const name = typeof data.name === "string" && data.name !== "" ? data.name : undefined;
    const description = typeof data.description === "string" && data.description !== "" ? data.description : undefined;
    if (inclusion === "fileMatch") {
      const patterns = asPatternList(data.fileMatchPattern, { splitCommas: false });
      if (patterns === undefined) return { ok: false, reason: "bad_front_matter" };
      return { ok: true, value: { activation: "fileMatch", patterns, body, imports: "kiro" } };
    }
    if (inclusion === "auto") {
      if (name === undefined || description === undefined) return { ok: false, reason: "bad_front_matter" };
      return { ok: true, value: { activation: "auto", name, description, body, imports: "kiro" } };
    }
    if (inclusion === "manual") return { ok: true, value: { activation: "manual", name: ruleStem(path), body, imports: "kiro" } };
    return { ok: true, value: { activation: "always", body, imports: "kiro" } };
  },
};
