// Knowledge resolver (K1, C1): GitHub Copilot instructions.
// `.github/copilot-instructions.md` is always on. `.github/instructions/**/*.instructions.md` carries `applyTo` (a comma-separated list of
// globs) and may carry `excludeAgent`: "code-review" leaves the file out of Plan check and Review, "cloud-agent" leaves it out of Build.
// A file with no `applyTo` is not applied by itself (Copilot offers it for manual attachment), so it is a manual rule. Source: ACR 3.6.
import { asPatternList, parseFrontMatter } from "./frontmatter.js";
import type { KnowledgeFormatReader } from "./reader.js";
import { ruleStem } from "./reader.js";
import type { KnowledgeStage } from "./model.js";

export const copilotRepoReader: KnowledgeFormatReader = {
  id: "copilot_repo",
  discovery: { rootFiles: [".github/copilot-instructions.md"] },
  accepts: (path) => path === ".github/copilot-instructions.md",
  parse: (_path, text) => ({ ok: true, value: { activation: "always", body: text, imports: "none" } }),
};

const EXCLUDED: Readonly<Record<string, readonly KnowledgeStage[]>> = {
  "code-review": ["plan_check", "review"],
  "cloud-agent": ["build"],
};

export const copilotInstructionsReader: KnowledgeFormatReader = {
  id: "copilot_instructions",
  discovery: { directories: [".github/instructions"] },
  accepts: (path) => path.startsWith(".github/instructions/") && path.endsWith(".instructions.md"),
  parse: (path, text) => {
    const parsed = parseFrontMatter(text);
    if (!parsed.ok) return { ok: false, reason: "bad_front_matter" };
    const { data, body } = parsed;
    let excludeStages: readonly KnowledgeStage[] | undefined;
    if (data.excludeAgent !== undefined) {
      const excluded = typeof data.excludeAgent === "string" ? EXCLUDED[data.excludeAgent] : undefined;
      if (excluded === undefined) return { ok: false, reason: "bad_front_matter" };
      excludeStages = excluded;
    }
    const extra = excludeStages === undefined ? {} : { excludeStages };
    if (data.applyTo !== undefined) {
      const patterns = asPatternList(data.applyTo, { splitCommas: true });
      if (patterns === undefined) return { ok: false, reason: "bad_front_matter" };
      return { ok: true, value: { activation: "fileMatch", patterns, body, imports: "none", ...extra } };
    }
    return { ok: true, value: { activation: "manual", name: ruleStem(path, [".instructions.md"]), body, imports: "none", ...extra } };
  },
};
