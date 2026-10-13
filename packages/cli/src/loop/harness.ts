// rovara loop (#355): Claude Code, run interactively in a named tmux session, so the developer can watch it
// and answer it (`tmux attach`). It starts in Claude Code's default permission mode unless the repository's
// config passes other arguments. The loop's tools reach it through its own --mcp-config file, so nothing is
// written into the developer's Claude Code settings.
import { run, type Exec } from "./exec.js";

export interface SessionStart {
  tmux: string;
  /** Claude Code's session ID: chosen by the loop for a new session, so it can be resumed by it later. */
  id: string;
  cwd: string;
  mcpConfigPath: string;
  args: readonly string[];
  prompt: string;
  resume: boolean;
}

export class ClaudeCodeHarness {
  constructor(private readonly exec: Exec) {}

  async alive(tmux: string): Promise<boolean> {
    return (await this.exec("tmux", ["has-session", "-t", `=${tmux}`])).code === 0;
  }

  async start(session: SessionStart): Promise<void> {
    // --mcp-config takes several values, so `--` ends the options: the prompt is never read as another config.
    const claude = [
      "claude", ...(session.resume ? ["--resume", session.id] : ["--session-id", session.id]),
      ...session.args, "--mcp-config", session.mcpConfigPath, "--", session.prompt,
    ];
    await run(this.exec, "tmux", ["new-session", "-d", "-s", session.tmux, "-c", session.cwd, "-x", "220", "-y", "50", ...claude]);
  }

  /** Types `text` into the session as one bracketed paste, then presses Enter, so a multi-line message is sent whole. */
  async deliver(tmux: string, text: string): Promise<void> {
    const buffer = `${tmux}-message`;
    await run(this.exec, "tmux", ["load-buffer", "-b", buffer, "-"], { input: text });
    await run(this.exec, "tmux", ["paste-buffer", "-d", "-p", "-b", buffer, "-t", `=${tmux}:`]);
    await run(this.exec, "tmux", ["send-keys", "-t", `=${tmux}:`, "Enter"]);
  }

  async stop(tmux: string): Promise<void> {
    // Already gone is stopped.
    await this.exec("tmux", ["kill-session", "-t", `=${tmux}`]);
  }
}
