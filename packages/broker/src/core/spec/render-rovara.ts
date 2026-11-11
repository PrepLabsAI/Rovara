// Rovara's own format, for teams with no spec habit: one `spec.md` (summary, requirements as EARS lines, design, tasks).
import { specDraftStatements, type SpecDraft, type SpecFile, type SpecRequirementRef } from "@agentx/contracts";
import { assertRenderedSpec, extractLabelledLines, resolveSpecFolder, type SpecRenderer, type SpecRenderInput } from "./renderer.js";

function markdown(draft: SpecDraft): string {
  const known = new Set(specDraftStatements(draft).map((entry) => entry.id));
  const lines = [`# Spec: ${draft.title}`, "", "## Summary", "", draft.summary === "" ? draft.title : draft.summary, "", "## Requirements", ""];
  const section = (title: string | undefined, prefix: string | undefined) => {
    if (title !== undefined) lines.push(`### ${title}`, "");
    for (const statement of specDraftStatements(draft).filter((entry) => prefix === undefined || entry.id.startsWith(`${prefix}.`))) lines.push(`- ${statement.id} ${statement.text}`);
    lines.push("");
  };
  if (draft.kind === "bugfix") { section("Current Behavior (Defect)", "1"); section("Expected Behavior (Correct)", "2"); section("Unchanged Behavior (Regression Prevention)", "3"); } else section(undefined, undefined);
  if (draft.design !== "") lines.push("## Design", "", draft.design, "");
  lines.push("## Tasks", "");
  draft.tasks.forEach((task, index) => {
    const covers = task.covers.filter((id) => known.has(id));
    lines.push(`- [ ] ${String(index + 1)}. ${task.title}${covers.length === 0 ? "" : ` (covers ${covers.join(", ")})`}`);
  });
  if (draft.tasks.length === 0) lines.push("_No tasks were listed in the approved plan._");
  return `${lines.join("\n").trimEnd()}\n`;
}

export const rovaraRenderer: SpecRenderer = {
  format: "rovara",
  label: "Rovara",
  defaultPathTemplate: "specs/{slug}/",
  render(input: SpecRenderInput) {
    const folder = resolveSpecFolder(rovaraRenderer, input);
    const files: SpecFile[] = [{ path: `${folder}spec.md`, content: markdown(input.draft) }];
    return assertRenderedSpec({ folder, files });
  },
  extractRequirements(files: readonly SpecFile[]): SpecRequirementRef[] {
    return files.filter((file) => /(?:^|\/)spec\.md$/u.test(file.path)).flatMap((file) => extractLabelledLines(file, { sectionHeadings: /^requirements$/iu, defectHeading: /current behavio|defect/iu }));
  },
};
