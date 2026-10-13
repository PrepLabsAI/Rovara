// rovara loop (#355): names derived from a work item, shared by the runtime (which says them on the issue)
// and the daemon (which uses them).

const tmuxSafe = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "_");

/**
 * A tmux session name: tmux reads `.` and `:` as target syntax, so anything but letters, digits, `_` and `-` becomes
 * `_`. An inner loop's (#358) adds the repository it changes.
 */
export function tmuxSessionName(repo: string, issue: number, target?: string): string {
  return `rovara-${tmuxSafe(repo)}-${issue}${target === undefined ? "" : `-${tmuxSafe(target)}`}`;
}

/**
 * The item's own branch. In another repository (#358), the issue's number means nothing there, so the branch names
 * the issue's repository too.
 */
export function itemBranch(issue: number, home?: string, target?: string): string {
  return target === undefined || target === home ? `rovara/${issue}` : `rovara/${(home ?? "").replace("/", "-")}-${issue}`;
}

/** #358: whether a work item works in another repository than its issue's. */
export function elsewhere(state: { repo: string; target?: string | undefined }): boolean {
  return state.target !== undefined && state.target !== state.repo;
}

/** Where an item's documents and evidence go in the repository it changes: docs/rovara/<issue>, or for another repository, docs/rovara/<owner>-<name>-<issue>. */
export function docsDir(state: { repo: string; issue: number; target?: string | undefined }): string {
  return elsewhere(state) ? `docs/rovara/${state.repo.replace("/", "-")}-${state.issue}` : `docs/rovara/${state.issue}`;
}

/** Where an item's documents live, in its worktree: docs/rovara/<issue>/<artifact>.md. */
export function artifactPath(issue: number, artifact: "requirements" | "design" | "plan"): string {
  return `docs/rovara/${issue}/${artifact}.md`;
}

/** Where the loop's own evidence goes, beside the documents (`dir`: an inner loop's, from docsDir). */
export function evidencePath(issue: number, name: string, dir = `docs/rovara/${issue}`): string {
  return `${dir}/evidence/${name}`;
}

/** Every comment the loop posts starts with this, so the poller never reads its own words as a command or a reply. */
export const LOOP_COMMENT_MARKER = "<!-- rovara-loop -->";

/** The MCP server's name, as the agent sees its tools (mcp__rovara-loop__loop_complete in Claude Code). */
export const LOOP_MCP_SERVER = "rovara-loop";
