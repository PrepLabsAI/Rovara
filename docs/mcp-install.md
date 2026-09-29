# Use AgentX from Claude Code, Codex or Cursor

AgentX runs a small MCP server on your computer. Your AI tool uses it to hand AgentX a coding task
on a project you may use, check on it, continue it, and open a pull request. You need Node 22 and
the URL of your company's AgentX (ask your AgentX admin).

Sign in once, in any terminal:

```
npx @charterarc/agentx login https://agentx.example.com
```

Your browser opens. Sign in with Slack or with your company's sign-in. The terminal then shows who
you are and which projects you can use. You sign in again only when the sign-in ends (at most 7
days). If your computer has no browser, add `--no-browser` and open the link it prints.

Your sign-in is kept in your computer's own password store (the macOS keychain, or the Secret
Service on Linux). The setup below never writes a token into your AI tool's settings: the entry
only runs `npx -y @charterarc/agentx mcp`.

`mcp install` writes the version of AgentX you ran it with into the entry (for example
`@charterarc/agentx@0.4.0`), so your AI tool keeps using that version until you run it again. If
your admin gave you an environment name, put `--env <name>` before `mcp install`, for example
`npx @charterarc/agentx --env staging mcp install --client codex`. The entry then passes the same
`--env` to the server. You can run `mcp install` again at any time: it replaces the agentx entry
and never adds a second one.

Run `mcp install` as yourself, never with `sudo`: it sets up the AI tool for the user who runs it,
so under `sudo` it would change root's settings instead of yours.

## Claude Code

Install:

```
claude mcp add --scope user agentx -- npx -y @charterarc/agentx mcp
```

or let AgentX run that for you, with the version you have: `npx @charterarc/agentx mcp install --client claude-code`.
It removes any agentx entry you added for your user before, then adds the new one. If the add
fails, your old entry is already gone, so it prints the exact command to run yourself.

Claude Code also has local and project entries (`--scope local` and `--scope project`, the second
kept in a project's `.mcp.json`). An agentx entry there wins over your user entry in that folder, so
if AgentX behaves oddly in one project, check `claude mcp list` there and remove the extra entry.

Manual setup: the command above is the whole setup. To see the exact command without running it,
use `npx @charterarc/agentx mcp install --client claude-code --print`.

Remove it: `claude mcp remove --scope user agentx`.

## Codex

Install:

```
npx @charterarc/agentx mcp install --client codex
```

It adds this to `~/.codex/config.toml`, keeps every other entry, and saves the old file as
`config.toml.agentx-backup`. If the file is not valid TOML, or already defines agentx in a
different way, it changes nothing and shows you the entry to add yourself. If the file is a
symbolic link (from a dotfiles folder, say), it changes the file the link points at and saves the
backup beside the link. Manual setup: add it
yourself:

```
[mcp_servers.agentx]
command = "npx"
args = ["-y", "@charterarc/agentx", "mcp"]
```

To see the exact entry without changing anything, use
`npx @charterarc/agentx mcp install --client codex --print`. If you keep Codex's settings
somewhere other than `~/.codex` (with `CODEX_HOME`), `mcp install` follows it and edits the
`config.toml` there. Run it in a terminal where `CODEX_HOME` is set the same way it is for Codex.

Remove it: delete the `[mcp_servers.agentx]` table from `~/.codex/config.toml`.

## Cursor

Install:

```
npx @charterarc/agentx mcp install --client cursor
```

It adds this to `~/.cursor/mcp.json`, keeps every other server, and saves the old file as
`mcp.json.agentx-backup`. If the file is not plain JSON (for example, it has comments), it changes
nothing and shows you the entry to add yourself. Manual setup: add it yourself:

```
{
  "mcpServers": {
    "agentx": { "command": "npx", "args": ["-y", "@charterarc/agentx", "mcp"] }
  }
}
```

To see the exact entry without changing anything, use
`npx @charterarc/agentx mcp install --client cursor --print`.

Remove it: delete the `agentx` entry under `"mcpServers"` in `~/.cursor/mcp.json`.

## Your first task

Start a new session of your AI tool and ask, for example:

> Have AgentX fix the flaky retry test in payments-api and tell me when it is done.

Your AI tool writes the instructions and calls `agentx_start_task`. AgentX answers at once with a
task ID and works in a private workspace of its own; you keep working. Ask "how is my AgentX task
doing?" to check on it, "continue it and add a test for the timeout" to send more instructions,
and "open a pull request" when it is ready. For a small task, ask your tool to wait: it can wait up
to 10 minutes.

If you write your own MCP client, a wait longer than a minute needs your client to accept progress
updates. AgentX sends one while it waits, but only when the call includes a progress token. With the
MCP TypeScript SDK, pass `onprogress` and `resetTimeoutOnProgress: true` in the call's options;
otherwise the SDK gives up after its default of 60 seconds while AgentX is still waiting. Claude Code,
Codex and Cursor handle this themselves.

Tasks from your AI tool are private: only you see them, and every action is recorded for your
admins. Each task keeps a workspace until you close it ("close my AgentX task"), and open tasks
count against the same limit as your Slack threads (3 at a time unless your admin changed it).

## When something goes wrong

Every AgentX error says what to do next. The common ones:

- `SIGN_IN_REQUIRED`: run `npx @charterarc/agentx login <your AgentX URL>`.
- `PROJECT_ACCESS_DENIED`: join one of the project's Slack channels, or ask an admin.
- `WORKSPACE_LIMIT`: close a task you no longer need.
- `UPGRADE_REQUIRED`: run `npx -y @charterarc/agentx@latest mcp install --client <your tool>`.
