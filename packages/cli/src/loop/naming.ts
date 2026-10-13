// rovara loop (#355): names derived from a work item, shared by the runtime (which says them on the issue)
// and the daemon (which uses them).

/** A tmux session name: tmux reads `.` and `:` as target syntax, so anything but letters, digits, `_` and `-` becomes `_`. */
export function tmuxSessionName(repo: string, issue: number): string {
  return `rovara-${repo.replace(/[^A-Za-z0-9_-]/g, "_")}-${issue}`;
}

/** The item's own branch. */
export function itemBranch(issue: number): string {
  return `rovara/${issue}`;
}

/** Where an item's documents live, in its worktree: docs/rovara/<issue>/<artifact>.md. */
export function artifactPath(issue: number, artifact: "requirements" | "design" | "plan"): string {
  return `docs/rovara/${issue}/${artifact}.md`;
}

/** Where the loop's own evidence goes, beside the documents. */
export function evidencePath(issue: number, name: string): string {
  return `docs/rovara/${issue}/evidence/${name}`;
}

/** Every comment the loop posts starts with this, so the poller never reads its own words as a command or a reply. */
export const LOOP_COMMENT_MARKER = "<!-- rovara-loop -->";

/** The MCP server's name, as the agent sees its tools (mcp__rovara-loop__loop_complete in Claude Code). */
export const LOOP_MCP_SERVER = "rovara-loop";
