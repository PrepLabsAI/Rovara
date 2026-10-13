// rovara loop (#355, #359): the agent, run interactively in a named tmux session, so the developer can watch it and
// answer it (`tmux attach`). Claude Code starts in its default permission mode, and Codex in its workspace-write
// sandbox, unless the repository's config passes other arguments. The loop's tools reach each session through its own
// configuration (Claude Code's --mcp-config file, Codex's -c overrides), so nothing is written into the developer's
// agent settings.
import { run, type Exec } from "./exec.js";
import { LOOP_MCP_SERVER } from "./naming.js";

export type HarnessName = "claude-code" | "codex";

export interface SessionStart {
  harness: HarnessName;
  tmux: string;
  /**
   * Claude Code's session ID: chosen by the loop for a new session, so it can be resumed by it later. Codex chooses
   * its own; a Codex session is resumed as the latest one in its worktree, which is the item's alone.
   */
  id: string | undefined;
  cwd: string;
  /** The loop's MCP server: how to run it, and (Claude Code) the file that says so. */
  mcp: { command: string; args: readonly string[]; configPath: string };
  /** Codex: directories it may also write, besides the worktree (the repository's git directory, so it can commit). */
  writable: readonly string[];
  args: readonly string[];
  prompt: string;
  resume: boolean;
}

/** A TOML value for a Codex `-c key=value` override: a JSON string or array of strings is valid TOML. */
const toml = (value: string | readonly string[]) => JSON.stringify(value);

/** The command that starts (or resumes) the agent, run by tmux in the worktree. */
export function agentCommand(session: SessionStart): string[] {
  if (session.harness === "codex") {
    return [
      "codex", ...(session.resume ? ["resume", "--last"] : []),
      "--sandbox", "workspace-write", "--cd", session.cwd, ...session.writable.flatMap((dir) => ["--add-dir", dir]),
      "-c", `mcp_servers.${LOOP_MCP_SERVER}.command=${toml(session.mcp.command)}`, "-c", `mcp_servers.${LOOP_MCP_SERVER}.args=${toml(session.mcp.args)}`,
      ...session.args, "--", session.prompt,
    ];
  }
  // --mcp-config takes several values, so `--` ends the options: the prompt is never read as another config.
  return [
    "claude", ...(session.resume ? ["--resume", session.id ?? ""] : ["--session-id", session.id ?? ""]),
    ...session.args, "--mcp-config", session.mcp.configPath, "--", session.prompt,
  ];
}

export class AgentHarness {
  constructor(private readonly exec: Exec) {}

  async alive(tmux: string): Promise<boolean> {
    return (await this.exec("tmux", ["has-session", "-t", `=${tmux}`])).code === 0;
  }

  async start(session: SessionStart): Promise<void> {
    await run(this.exec, "tmux", ["new-session", "-d", "-s", session.tmux, "-c", session.cwd, "-x", "220", "-y", "50", ...agentCommand(session)]);
  }

  /** Types `text` into the session as one bracketed paste, then presses Enter, so a multi-line message is sent whole. */
  async deliver(tmux: string, text: string): Promise<void> {
    const buffer = `${tmux}-message`;
    await run(this.exec, "tmux", ["load-buffer", "-b", buffer, "-"], { input: text });
    await run(this.exec, "tmux", ["paste-buffer", "-d", "-p", "-b", buffer, "-t", `=${tmux}:`]);
    await run(this.exec, "tmux", ["send-keys", "-t", `=${tmux}:`, "Enter"]);
  }

  /**
   * Whether the agent is showing a permission prompt: Claude Code asks before commands and, in its default mode, edits;
   * Codex asks before a command its sandbox would not allow. Read from the screen, so a person who only watches the
   * issue can be told the agent is waiting for them.
   */
  async waitingForApproval(tmux: string): Promise<boolean> {
    const screen = await this.exec("tmux", ["capture-pane", "-p", "-t", `=${tmux}:`]);
    return screen.code === 0 && /Do you want to (?:proceed|make this edit|create)|This command requires approval|Would you like to (?:run the following command|make the following edits)/u.test(screen.stdout);
  }

  async stop(tmux: string): Promise<void> {
    // Already gone is stopped.
    await this.exec("tmux", ["kill-session", "-t", `=${tmux}`]);
  }
}
