/** Case-insensitive repository path rules. Folder rules include every descendant, at any depth. */
export const AI_INSTRUCTION_PATH_RULES = {
  files: ["AGENTS.md", "AGENTS.override.md", "AGENT.md", "CLAUDE.md", "CLAUDE.local.md", "GEMINI.md", "WARP.md", "SKILL.md", ".cursorrules", ".windsurfrules", ".clinerules", ".goosehints"],
  paths: [".github/copilot-instructions.md"],
  folders: [".cursor", ".claude", ".windsurf", ".clinerules", ".continue", ".agents", ".codex", ".openhands", ".kilocode", ".amazonq", ".kiro", ".gemini", ".roo", ".cline", ".trae", ".junie", ".rovara", ".github/instructions", ".github/prompts", ".github/chatmodes"],
} as const;
const filenames = new Set(AI_INSTRUCTION_PATH_RULES.files.map(name => name.toLowerCase()));
const folders = new Set<string>(AI_INSTRUCTION_PATH_RULES.folders);
const paths = new Set<string>(AI_INSTRUCTION_PATH_RULES.paths);

/** Git paths use slashes. One leading ./ is accepted; backslashes are ordinary filename characters, never separators. Empty segments and traversal are rejected. */
export function isAiInstructionPath(path: string): boolean {
  const parts = (path.startsWith("./") ? path.slice(2) : path).toLowerCase().split("/");
  if (parts.some(part => part === "" || part === "." || part === "..")) return false;
  if (filenames.has(parts.at(-1)!)) return true;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (folders.has(parts[i]!)) return true;
    const pair = `${parts[i]!}/${parts[i + 1]!}`;
    if (i === parts.length - 2 && paths.has(pair)) return true;
    if (i < parts.length - 2 && folders.has(pair)) return true;
  }
  return false;
}
