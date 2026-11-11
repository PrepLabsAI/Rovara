// The Spec Kit format. `specs/NNN-feature/` holding `spec.md`, `plan.md` and `tasks.md`. `NNN` is the next free three-digit number in the specs folder.
// Requirements are labelled FR-001, FR-002 ... in order; a bug's observed behaviour is DEF-001 ... and is not checked against the code.
import { specDraftStatements, type SpecDraft, type SpecFile, type SpecRequirementRef } from "@agentx/contracts";
import { assertRenderedSpec, extractLabelledLines, resolveSpecFolder, type SpecRenderer, type SpecRenderInput } from "./renderer.js";

/** The Spec Kit label of each canonical `n.m` statement id. */
function labels(draft: SpecDraft): Map<string, string> {
  const map = new Map<string, string>();
  let requirement = 0;
  let defect = 0;
  for (const statement of specDraftStatements(draft)) {
    if (statement.kind === "defect") { defect += 1; map.set(statement.id, `DEF-${String(defect).padStart(3, "0")}`); } else { requirement += 1; map.set(statement.id, `FR-${String(requirement).padStart(3, "0")}`); }
  }
  return map;
}

function specMarkdown(draft: SpecDraft): string {
  const named = labels(draft);
  const statements = specDraftStatements(draft);
  const lines = [`# ${draft.kind === "bugfix" ? "Bug Fix" : "Feature"} Specification: ${draft.title}`, "", "## Summary", "", draft.summary === "" ? draft.title : draft.summary, ""];
  if (draft.kind === "feature") {
    lines.push("## User Scenarios & Testing", "");
    for (const requirement of draft.requirements) if (requirement.userStory !== undefined) lines.push(`- ${requirement.userStory}`);
    lines.push("", "## Requirements", "", "### Functional Requirements", "");
    for (const statement of statements) lines.push(`- **${named.get(statement.id)!}**: ${statement.text}`);
  } else {
    lines.push("## Requirements", "");
    const section = (title: string, prefix: string) => {
      lines.push(`### ${title}`, "");
      const own = statements.filter((entry) => entry.id.startsWith(`${prefix}.`));
      if (own.length === 0) lines.push("_None._");
      for (const statement of own) lines.push(`- **${named.get(statement.id)!}**: ${statement.text}`);
      lines.push("");
    };
    section("Current Behavior (Defect)", "1");
    section("Expected Behavior (Correct)", "2");
    section("Unchanged Behavior (Regression Prevention)", "3");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function planMarkdown(draft: SpecDraft): string {
  return `${[`# Implementation Plan: ${draft.title}`, "", "## Summary", "", draft.summary === "" ? draft.title : draft.summary, ...(draft.design === "" ? [] : ["", "## Technical Context", "", draft.design])].join("\n")}\n`;
}

function tasksMarkdown(draft: SpecDraft): string {
  const named = labels(draft);
  const lines = [`# Tasks: ${draft.title}`, ""];
  draft.tasks.forEach((task, index) => {
    const covers = task.covers.map((id) => named.get(id)).filter((label): label is string => label !== undefined);
    lines.push(`- [ ] T${String(index + 1).padStart(3, "0")} ${task.title}${covers.length === 0 ? "" : ` [${covers.join(", ")}]`}`);
  });
  if (draft.tasks.length === 0) lines.push("_No tasks were listed in the approved plan._");
  return `${lines.join("\n")}\n`;
}

export const specKitRenderer: SpecRenderer = {
  format: "speckit",
  label: "Spec Kit",
  defaultPathTemplate: "specs/{n}-{slug}/",
  render(input: SpecRenderInput) {
    const folder = resolveSpecFolder(specKitRenderer, input);
    const files: SpecFile[] = [
      { path: `${folder}spec.md`, content: specMarkdown(input.draft) },
      { path: `${folder}plan.md`, content: planMarkdown(input.draft) },
      { path: `${folder}tasks.md`, content: tasksMarkdown(input.draft) },
    ];
    return assertRenderedSpec({ folder, files });
  },
  extractRequirements(files: readonly SpecFile[]): SpecRequirementRef[] {
    return files.filter((file) => /(?:^|\/)spec\.md$/u.test(file.path)).flatMap((file) => extractLabelledLines(file, { sectionHeadings: /^requirements$/iu, defectHeading: /current behavio|defect/iu }));
  },
};
