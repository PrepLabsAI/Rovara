// The words of the weekly pull request and of the status lines (the lessons page and `lessons repo status`).
// Pure. Every sentence is fixed wording chosen by a code; the only free text is a lesson title (an eligible lesson's, or a removed block's own first words), always inside a code span so a mention or a link in it does nothing.
// The removals come FIRST, each with its reason, then edits, then new lessons.
import { LESSON_FILE_PROBLEM_TEXT, type LessonsRepoFileRow } from "@agentx/contracts";
import { REMOVAL_REASON_TEXT, type RepoFilePlan } from "./repo-file-plan.js";
import { additionsPaused, type RepoFileState } from "./repo-file-state.js";

const SECTION_MAX = 100;
const BODY_MAX = 60_000;
const plural = (count: number, one: string, many: string): string => `${String(count)} ${count === 1 ? one : many}`;
const code = (text: string): string => `\`${text.replace(/`/gu, "'")}\``;

/** Shown while a Rovara pull request the team pushed to is still open: only removals are proposed meanwhile. */
export const TEAM_PR_LINE = "Your team is working on an earlier Rovara pull request, so this one proposes removals only";

/** The line shown when new lessons are paused after three pull requests nobody merged. */
export function pausedLine(removalsWaiting: number): string {
  return `Rovara has paused new lessons until a lessons PR is merged; ${plural(removalsWaiting, "removal is", "removals are")} waiting`;
}

export function prTitle(plan: Pick<RepoFilePlan, "removals" | "edits" | "adds">): string {
  const parts = [
    ...(plan.removals.length === 0 ? [] : [plural(plan.removals.length, "removal", "removals")]),
    ...(plan.edits.length === 0 ? [] : [plural(plan.edits.length, "edit", "edits")]),
    ...(plan.adds.length === 0 ? [] : [plural(plan.adds.length, "new lesson", "new lessons")]),
  ];
  return `Rovara: weekly lessons update${parts.length === 0 ? "" : ` (${parts.join(", ")})`}`;
}

function list(heading: string, lines: readonly string[]): string[] {
  if (lines.length === 0) return [];
  const shown = lines.slice(0, SECTION_MAX);
  return ["", `### ${heading} (${String(lines.length)})`, "", ...shown, ...(lines.length > SECTION_MAX ? [`- and ${String(lines.length - SECTION_MAX)} more`] : [])];
}

export function prBody(plan: RepoFilePlan, context: { pointerFiles: readonly string[]; unmerged: number }): string {
  const removals = plan.removals.map((r) => `- ${code(r.id)} ${code(r.title)}: ${REMOVAL_REASON_TEXT[r.reason]}.${r.edited === true ? " Your team edited this lesson; it is proposed for removal anyway." : ""}`);
  const edits = plan.edits.map((e) => `- ${code(e.id)} ${code(e.title)}${e.moved ? " (moves to another section)" : ""}`);
  const adds = plan.adds.map((a) => `- ${code(a.id)} ${code(a.title)}`);
  const lines = [
    "Rovara's weekly update to `.rovara/lessons.md`: lessons this team's own reviews and commits taught, proposed for you to merge. Nothing changes until a person merges this pull request.",
    "",
    `This pull request has ${plural(plan.removals.length, "removal", "removals")}, ${plural(plan.edits.length, "edit", "edits")} and ${plural(plan.adds.length, "new lesson", "new lessons")}.`,
    ...(plan.pausedBy === "unmerged" ? ["", `${pausedLine(plan.removals.length)}.`] : plan.pausedBy === "team_pr" ? ["", TEAM_PR_LINE] : []),
    ...list("Proposed removals", removals),
    ...list("Proposed edits", edits),
    ...list("Proposed new lessons", adds),
    ...(context.pointerFiles.length === 0 ? [] : ["", `This first pull request also adds one pointer line to ${context.pointerFiles.map(code).join(", ")} so local agents read the file. Rovara does not edit those files again.`, "You may want to list `.rovara/lessons.md` (the file only, not the folder) in CODEOWNERS."]),
    ...(plan.held.length === 0 ? [] : ["", `${plural(plan.held.length, "lesson your team edited is", "lessons your team edited are")} left exactly as you wrote them.`]),
    "",
    "Only lessons learned entirely from this repository's own reviews and commits, with no names, are proposed. A merged lesson stays in git history even if it is removed later. Rovara changes this file only through a pull request like this one.",
  ];
  const body = lines.join("\n");
  return body.length <= BODY_MAX ? body : `${body.slice(0, BODY_MAX)}\n\n(shortened)`;
}

/** The fixed lines that say how a repository's file is doing. Shared by the Lessons tab, the API and the CLI. */
export function noticesOf(state: RepoFileState): string[] {
  const notices: string[] = [];
  if (state.fileDeleted) notices.push("The lessons file was deleted, so Rovara stopped proposing. Resume to start again.");
  if (state.problem !== undefined) notices.push(LESSON_FILE_PROBLEM_TEXT[state.problem]);
  const waiting = state.open?.removals ?? 0;
  if (additionsPaused(state) && !state.fileDeleted) notices.push(pausedLine(waiting));
  else if (waiting > 0) notices.push(`${plural(waiting, "removal", "removals")} waiting in your lessons PR`);
  if (state.theirs.length > 0) notices.push(TEAM_PR_LINE.replace("this one proposes removals only", "new lessons wait for it"));
  if (state.held.length > 0) notices.push(`${plural(state.held.length, "lesson your team edited is", "lessons your team edited are")} left as written`);
  if (state.pointerMissing) notices.push("Pointer missing: no agent file names .rovara/lessons.md");
  return notices;
}

export function rowOf(state: RepoFileState): LessonsRepoFileRow {
  return {
    repo: state.name, enabled: state.enabled, fileDeleted: state.fileDeleted, unmerged: state.unmerged, additionsPaused: additionsPaused(state), removalsWaiting: state.open?.removals ?? 0, held: state.held.length,
    pointer: state.pointerDeclined ? "declined" : state.pointerMissing ? "missing" : state.pointerProposed ? "added" : "not_yet",
    ...(state.open === undefined ? {} : { pr: { number: state.open.number, url: state.open.url, removals: state.open.removals, edits: state.open.edits, adds: state.open.adds, openedAt: state.open.openedAt } }),
    ...(state.lastPassAt === undefined ? {} : { lastPassAt: state.lastPassAt }),
    ...(state.problem === undefined ? {} : { problem: state.problem }),
    notices: noticesOf(state),
  };
}
