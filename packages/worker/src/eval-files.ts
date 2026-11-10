// Lessons replay, the file arm (DECISIONS 50.5, 68): places the lessons file and its pointer in a replay copy's checkout before the agent starts, and keeps both out of the candidate. The broker sends these
// (`evalFiles`) for a replay copy only, built from the copy's frozen snapshot; nothing else in the worker writes them. The checkout is untrusted: a `.rovara` or agent file that is a link, or a path that leaves the checkout, is
// refused (the run fails, loudly: an arm that silently ran without its file would measure nothing).
//   - `.rovara/lessons.md` is written as given; `AGENTS.md` gets the one "Team lessons" pointer (created if absent, left alone if it already names the lessons file).
//   - Both paths are hidden from the candidate snapshot (`hideFromCandidate`, isolated-git.ts): the diff, the review and any commit of the copy never show them, tracked or not.
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { LESSON_FILE_PATH, agentXError, type EvalFilesPayload } from "@agentx/contracts";
import { hideFromCandidate } from "./isolated-git.js";

const AGENTS_FILE = "AGENTS.md";
const MAX_AGENTS_BYTES = 1_000_000;
const REFUSAL = "Rovara could not place the lessons file in this test copy's checkout, so it did not run";

async function kindOf(path: string): Promise<"missing" | "file" | "directory" | "other"> {
  try {
    const stat = await lstat(path);
    return stat.isSymbolicLink() ? "other" : stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

/** The agent file with the pointer added, or undefined when it already names the lessons file. */
export function agentsFileWithPointer(current: string | undefined, pointerLine: string): string | undefined {
  if (current !== undefined && current.includes(LESSON_FILE_PATH)) return undefined;
  const section = `## Team lessons\n\n${pointerLine}\n`;
  if (current === undefined || current.trim() === "") return `# Agent instructions\n\n${section}`;
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  return `${current.replace(/(?:\r?\n)*$/u, "")}${eol}${eol}${section.replace(/\n/gu, eol)}`;
}

export async function placeEvalFiles(files: EvalFilesPayload, repositories: ReadonlyArray<{ repositoryId: string; directory: string }>): Promise<void> {
  const repository = repositories.find((entry) => entry.repositoryId === files.repository);
  if (repository === undefined) throw agentXError("CONFIG_INVALID", REFUSAL);
  const root = await realpath(resolve(repository.directory)).catch(() => { throw agentXError("CONFIG_INVALID", REFUSAL); });
  // `.rovara` is a plain folder (made if absent) and the lessons file is a plain file or absent: a link at either is the checkout trying to send the write elsewhere.
  const folder = join(root, ".rovara");
  const folderKind = await kindOf(folder);
  if (folderKind === "other" || folderKind === "file") throw agentXError("CONFIG_INVALID", REFUSAL);
  if (folderKind === "missing") await mkdir(folder, { mode: 0o755 });
  const target = join(root, LESSON_FILE_PATH);
  if ((await kindOf(target)) === "other" || (await kindOf(target)) === "directory") throw agentXError("CONFIG_INVALID", REFUSAL);
  await writeFile(target, files.lessonsFile.content, { mode: 0o644 });
  hideFromCandidate(root, LESSON_FILE_PATH);

  const agents = join(root, AGENTS_FILE);
  const agentsKind = await kindOf(agents);
  if (agentsKind === "other" || agentsKind === "directory") throw agentXError("CONFIG_INVALID", REFUSAL);
  const current = agentsKind === "file" ? (await readFile(agents)).subarray(0, MAX_AGENTS_BYTES).toString("utf8") : undefined;
  const pointed = agentsFileWithPointer(current, files.pointerLine);
  if (pointed !== undefined) {
    await writeFile(agents, pointed, { mode: 0o644 });
    hideFromCandidate(root, AGENTS_FILE);
  }
}
