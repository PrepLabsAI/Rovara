// The team-template format. The team keeps a folder in the meta repo with one file per section of its own spec; Rovara writes the same files and the same headings,
// and puts the approved plan's content under the headings that ask for it. Every heading, its level, its order and the text under headings Rovara has nothing for are kept as the team wrote them.
import { agentXError, SPEC_FILES_MAX, nextFenceState, specDraftStatements, specStripHidden, type SpecDraft, type SpecFile, type SpecRequirementRef } from "@agentx/contracts";
import { assertRenderedSpec, extractLabelledLines, resolveSpecFolder, type SpecRenderer, type SpecRenderInput } from "./renderer.js";

type Slot = "requirements" | "tasks" | "design" | "summary";
/** In this order: "Implementation plan" is the tasks, "Design" the design, and so on. The first heading of a file set that matches a slot gets it; later matches keep the team's text. */
const SLOT_PATTERNS: ReadonlyArray<[Slot, RegExp]> = [
  ["requirements", /requirement|acceptance|user stor|criteria|expected behavio/iu],
  ["tasks", /\btasks?\b|implementation|work breakdown|steps|checklist/iu],
  ["design", /design|architecture|approach|technical|solution/iu],
  ["summary", /summary|overview|background|context|problem|goal|introduction|description|motivation/iu],
];

export function slotOfHeading(title: string): Slot | undefined {
  return SLOT_PATTERNS.find(([, pattern]) => pattern.test(title))?.[0];
}

interface Heading { index: number; level: number; title: string }

function headingsOf(lines: readonly string[]): Heading[] {
  const out: Heading[] = [];
  let fence: ReturnType<typeof nextFenceState>;
  lines.forEach((line, index) => {
    const wasOpen = fence !== undefined;
    fence = nextFenceState(fence, line);
    if (wasOpen || fence !== undefined) return;
    if (/^ {0,3}(?:`{3,}|~{3,})/u.test(line)) return;
    const match = /^(#{1,6})\s+(.*?)\s*#*\s*$/u.exec(line);
    if (match !== null) out.push({ index, level: match[1]!.length, title: match[2] ?? "" });
  });
  return out;
}

function requirementsBlock(draft: SpecDraft): string[] {
  const statements = specDraftStatements(draft);
  if (draft.kind === "feature") return statements.map((statement) => `- ${statement.id} ${statement.text}`);
  const out: string[] = [];
  for (const [prefix, title] of [["1", "Current Behavior (Defect)"], ["2", "Expected Behavior (Correct)"], ["3", "Unchanged Behavior (Regression Prevention)"]] as const) {
    out.push(`**${title}**`, "");
    const own = statements.filter((entry) => entry.id.startsWith(`${prefix}.`));
    if (own.length === 0) out.push("_None._");
    for (const statement of own) out.push(`- ${statement.id} ${statement.text}`);
    out.push("");
  }
  return out;
}

function tasksBlock(draft: SpecDraft): string[] {
  const known = new Set(specDraftStatements(draft).map((entry) => entry.id));
  if (draft.tasks.length === 0) return ["_No tasks were listed in the approved plan._"];
  return draft.tasks.map((task, index) => {
    const covers = task.covers.filter((id) => known.has(id));
    return `- [ ] ${String(index + 1)}. ${task.title}${covers.length === 0 ? "" : ` (covers ${covers.join(", ")})`}`;
  });
}

function blockFor(slot: Slot, draft: SpecDraft): string[] {
  if (slot === "requirements") return requirementsBlock(draft);
  if (slot === "tasks") return tasksBlock(draft);
  if (slot === "design") return draft.design === "" ? ["_No design notes in the approved plan._"] : draft.design.split("\n");
  return [draft.summary === "" ? draft.title : draft.summary];
}

/** Fills one template file. `claimed` is the set of slots earlier files already filled. */
function fillFile(file: SpecFile, draft: SpecDraft, claimed: Set<Slot>): string {
  const lines = specStripHidden(file.content).split("\n");
  const headings = headingsOf(lines);
  const out: string[] = [];
  let cursor = 0;
  for (const [position, heading] of headings.entries()) {
    const slot = slotOfHeading(heading.title);
    const next = headings[position + 1]?.index ?? lines.length;
    out.push(...lines.slice(cursor, heading.index + 1));
    cursor = heading.index + 1;
    if (slot === undefined || claimed.has(slot)) continue;
    claimed.add(slot);
    out.push("", ...blockFor(slot, draft), "");
    cursor = next;
  }
  out.push(...lines.slice(cursor));
  return `${out.join("\n").replace(/\n{3,}/gu, "\n\n").trimEnd()}\n`;
}

export const teamTemplateRenderer: SpecRenderer = {
  format: "team_template",
  label: "Team template",
  defaultPathTemplate: "specs/{slug}/",
  render(input: SpecRenderInput) {
    const template = input.template ?? [];
    if (template.length === 0 || template.length > SPEC_FILES_MAX) throw agentXError("CONFIG_INVALID", "the team's spec template is missing or has too many files");
    const folder = resolveSpecFolder(teamTemplateRenderer, input);
    const claimed = new Set<Slot>();
    const files: SpecFile[] = template.map((file) => ({ path: `${folder}${file.path}`, content: fillFile(file, input.draft, claimed) }));
    // A template with no heading for the requirements still gets them: a spec nothing can be checked against is not a spec. They are added to the first file under a heading of their own.
    if (!claimed.has("requirements")) {
      const first = files[0]!;
      files[0] = { path: first.path, content: `${first.content.trimEnd()}\n\n## Requirements\n\n${requirementsBlock(input.draft).join("\n")}\n` };
    }
    return assertRenderedSpec({ folder, files });
  },
  extractRequirements(files: readonly SpecFile[]): SpecRequirementRef[] {
    return files.flatMap((file) => extractLabelledLines(file, { defectHeading: /current behavio|defect/iu }));
  },
};
