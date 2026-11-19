// The Kiro format. `requirements.md` (or `bugfix.md` for a bug), `design.md`, `tasks.md`; requirements are EARS lines.
//
// Facts from the Kiro specs pages: EARS is "WHEN [condition/event] THE SYSTEM SHALL [expected behavior]"; `bugfix.md` has three sections, "Current Behavior (Defect)", "Expected
// Behavior (Correct)" and "Unchanged Behavior (Regression Prevention)". The pages do not state the folder or the `tasks.md` layout: the folder is `.kiro/specs/<feature>/` (the project can change
// it with `pathTemplate`), and `tasks.md` is a numbered checkbox list with requirement references.
import { specDraftStatements, type SpecDraft, type SpecFile, type SpecRequirementRef } from "@agentx/contracts";
import { assertRenderedSpec, extractLabelledLines, resolveSpecFolder, type SpecRenderer, type SpecRenderInput } from "./renderer.js";

export const KIRO_BUGFIX_SECTIONS = ["Current Behavior (Defect)", "Expected Behavior (Correct)", "Unchanged Behavior (Regression Prevention)"] as const;

function requirementsMarkdown(draft: SpecDraft): string {
  const statements = specDraftStatements(draft);
  const out = ["# Requirements Document", "", "## Introduction", "", draft.summary === "" ? draft.title : draft.summary, "", "## Requirements", ""];
  draft.requirements.forEach((requirement, requirementIndex) => {
    out.push(`### Requirement ${String(requirementIndex + 1)}: ${requirement.title}`, "");
    if (requirement.userStory !== undefined) out.push(`**User Story:** ${requirement.userStory}`, "");
    out.push("#### Acceptance Criteria", "");
    for (const statement of statements.filter((entry) => entry.id.startsWith(`${String(requirementIndex + 1)}.`))) out.push(`- ${statement.id} ${statement.text}`);
    out.push("");
  });
  return `${out.join("\n").trimEnd()}\n`;
}

function bugfixMarkdown(draft: SpecDraft): string {
  const statements = specDraftStatements(draft);
  const section = (title: string, prefix: string) => {
    const own = statements.filter((entry) => entry.id.startsWith(`${prefix}.`));
    return ["", `### ${title}`, "", ...(own.length === 0 ? ["_None._"] : own.map((statement) => `- ${statement.id} ${statement.text}`))];
  };
  return `${[
    "# Bugfix Requirements Document", "", "## Introduction", "", draft.summary === "" ? draft.title : draft.summary, "", "## Bug Analysis",
    ...section(KIRO_BUGFIX_SECTIONS[0], "1"), ...section(KIRO_BUGFIX_SECTIONS[1], "2"), ...section(KIRO_BUGFIX_SECTIONS[2], "3"),
  ].join("\n")}\n`;
}

function designMarkdown(draft: SpecDraft): string {
  return `${["# Design Document", "", "## Overview", "", draft.summary === "" ? draft.title : draft.summary, ...(draft.design === "" ? [] : ["", "## Design", "", draft.design])].join("\n")}\n`;
}

function tasksMarkdown(draft: SpecDraft): string {
  const known = new Set(specDraftStatements(draft).map((entry) => entry.id));
  const lines = ["# Implementation Plan", ""];
  draft.tasks.forEach((task, index) => {
    lines.push(`- [ ] ${String(index + 1)}. ${task.title}`);
    const covers = task.covers.filter((id) => known.has(id));
    if (covers.length > 0) lines.push(`  - _Requirements: ${covers.join(", ")}_`);
  });
  if (draft.tasks.length === 0) lines.push("_No tasks were listed in the approved plan._");
  return `${lines.join("\n")}\n`;
}

export const kiroRenderer: SpecRenderer = {
  format: "kiro",
  label: "Kiro",
  defaultPathTemplate: ".kiro/specs/{slug}/",
  render(input: SpecRenderInput) {
    const folder = resolveSpecFolder(kiroRenderer, input);
    const { draft } = input;
    const files: SpecFile[] = [
      { path: `${folder}${draft.kind === "bugfix" ? "bugfix.md" : "requirements.md"}`, content: draft.kind === "bugfix" ? bugfixMarkdown(draft) : requirementsMarkdown(draft) },
      { path: `${folder}design.md`, content: designMarkdown(draft) },
      { path: `${folder}tasks.md`, content: tasksMarkdown(draft) },
    ];
    return assertRenderedSpec({ folder, files });
  },
  extractRequirements(files: readonly SpecFile[]): SpecRequirementRef[] {
    const own = files.filter((file) => /(?:^|\/)(?:requirements|bugfix)\.md$/u.test(file.path));
    return own.flatMap((file) => extractLabelledLines(file, { defectHeading: /current behavior|defect/iu }));
  },
};
