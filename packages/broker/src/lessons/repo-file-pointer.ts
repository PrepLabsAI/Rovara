// The one pointer line that tells a local agent (Claude Code, Codex, Cursor, Copilot) to read `.rovara/lessons.md`.
// The first pull request adds it once; Rovara never edits a pointer again (a missing one shows in the status, with "add it back" and "don't ask again"). Pure.
//
//   AGENTS.md and the Copilot file: a sentence under a "Team lessons" heading.   CLAUDE.md: Claude Code's import line, `@.rovara/lessons.md` (a missing file is harmless: an import of a path that is not there is skipped).
//   AGENTS.md is created only when the repository has no agent instructions file at all. A symbolic link is never written to (its target is where the pointer belongs).
// Not done here, on purpose: Cursor rules (`@file` inside a rule) and Kiro steering (`#[[file:...]]`). Their syntax was not checked against the tools' docs in this lane, so nothing is written for them (see the lane report).
import { LESSON_FILE_PATH, LESSON_FILE_POINTER_PATHS } from "@agentx/contracts";

export type PointerPath = (typeof LESSON_FILE_POINTER_PATHS)[number];
export const POINTER_SENTENCE = `Before you change code in this repository, read \`${LESSON_FILE_PATH}\`: it holds lessons this team has already learned from its own reviews and commits.`;
export const CLAUDE_IMPORT = `@${LESSON_FILE_PATH}`;

/** Whether an agent file already names the lessons file (any pointer, Rovara's or the team's). */
export const mentionsLessonsFile = (text: string): boolean => text.includes(LESSON_FILE_PATH);

/**
 * The agent files to add the pointer to. `found` is what exists at the default branch head (symbolic links are not in it); `ticked` is the person's choice, if they made one. A ticked file that does not exist is created;
 * with no choice, the files found, or AGENTS.md (created) when there are none and nothing in `links` stands in for it.
 */
export function pointerTargets(found: readonly PointerPath[], ticked: readonly PointerPath[] | undefined, links: readonly PointerPath[] = []): PointerPath[] {
  const allowed = new Set<string>(LESSON_FILE_POINTER_PATHS);
  const chosen = ticked !== undefined ? ticked.filter((path) => allowed.has(path)) : found.length > 0 ? [...found] : links.length > 0 ? [] : ["AGENTS.md" as PointerPath];
  return [...new Set(chosen)].filter((path) => !links.includes(path)).sort((a, b) => LESSON_FILE_POINTER_PATHS.indexOf(a) - LESSON_FILE_POINTER_PATHS.indexOf(b));
}

/** The file with the pointer added, or undefined when it already names the lessons file. `current` undefined creates the file. */
export function withPointer(path: PointerPath, current: string | undefined): string | undefined {
  if (current !== undefined && mentionsLessonsFile(current)) return undefined;
  const pointer = path === "CLAUDE.md" ? `${CLAUDE_IMPORT}\n` : `## Team lessons\n\n${POINTER_SENTENCE}\n`;
  if (current === undefined || current.trim() === "") return path === "CLAUDE.md" ? pointer : `# Agent instructions\n\n${pointer}`;
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const body = current.replace(/(?:\r?\n)*$/u, "");
  return `${body}${eol}${eol}${pointer.replace(/\n/gu, eol)}`;
}
