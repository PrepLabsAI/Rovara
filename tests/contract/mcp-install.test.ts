import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCliProgram, executeCli } from "../../packages/cli/src/main.js";
import { codexToml, cursorJson, installMcp, mcpEntry, runCommand } from "../../packages/cli/src/mcp/install.js";

const entry = mcpEntry("0.4.0", undefined);
const tomlBlock = '[mcp_servers.agentx]\ncommand = "npx"\nargs = ["-y", "@charterarc/agentx@0.4.0", "mcp"]\n';
const home = () => mkdtemp(join(tmpdir(), "agentx-install-"));
const codexFile = (dir: string) => join(dir, ".codex", "config.toml");
const cursorFile = (dir: string) => join(dir, ".cursor", "mcp.json");

async function withCodexConfig(text: string): Promise<string> {
  const dir = await home();
  await mkdir(join(dir, ".codex"));
  await writeFile(codexFile(dir), text);
  return dir;
}

describe("the server entry (FR-043, R26)", () => {
  it("runs the installed CLI's version, or latest for a CLI built from source, and names --env only when given", () => {
    expect(mcpEntry("0.4.0", undefined)).toEqual({ command: "npx", args: ["-y", "@charterarc/agentx@0.4.0", "mcp"] });
    expect(mcpEntry(undefined, undefined).args).toEqual(["-y", "@charterarc/agentx@latest", "mcp"]);
    expect(mcpEntry("0.4.0", "staging").args).toEqual(["-y", "@charterarc/agentx@0.4.0", "--env", "staging", "mcp"]);
  });
});

describe("Codex's config.toml", () => {
  it("adds the table to an empty or missing file", () => {
    expect(codexToml(undefined, entry)).toEqual({ action: "added", text: '[mcp_servers.agentx]\ncommand = "npx"\nargs = ["-y", "@charterarc/agentx@0.4.0", "mcp"]\n' });
  });

  it("appends after other entries, leaving them as they are", () => {
    const existing = 'model = "o4"\n\n[mcp_servers.linear]\ncommand = "linear-mcp"\n';
    expect(codexToml(existing, entry).text).toBe(`${existing}\n[mcp_servers.agentx]\ncommand = "npx"\nargs = ["-y", "@charterarc/agentx@0.4.0", "mcp"]\n`);
  });

  it("replaces the agentx table and its sub-tables and keeps every other byte (Review Focus 5)", () => {
    const before = [
      "# servers", "[mcp_servers.linear]", 'command = "linear"', "",
      "[mcp_servers.agentx]", 'command = "npx"', 'args = ["-y", "@charterarc/agentx@0.1.0", "mcp"]', "",
      "[mcp_servers.agentx.env]", 'FOO = "bar"', "",
      "# keep this comment", "[mcp_servers.github]", 'command = "gh"', "",
    ].join("\n");
    const after = [
      "# servers", "[mcp_servers.linear]", 'command = "linear"', "",
      "[mcp_servers.agentx]", 'command = "npx"', 'args = ["-y", "@charterarc/agentx@0.4.0", "mcp"]', "",
      "# keep this comment", "[mcp_servers.github]", 'command = "gh"', "",
    ].join("\n");
    expect(codexToml(before, entry)).toEqual({ action: "replaced", text: after });
  });

  it.each([
    '[mcp_servers."agentx"]\ncommand = "x"\n',
    'mcp_servers.agentx = { command = "x" }\n',
    '[mcp_servers]\nagentx = { command = "x" }\n',
    '[[mcp_servers.agentx]]\ncommand = "x"\n',
    '[mcp_servers.agentx]\ncommand = "x"\n\n[mcp_servers."agentx".env]\nFOO = "bar"\n',
  ])("refuses a file that defines agentx another way, and shows the entry to add by hand: %j", (existing) => {
    expect(() => codexToml(existing, entry)).toThrow(/by hand[\s\S]*\[mcp_servers\.agentx\]/);
  });

  it("refuses a file that is not valid TOML, and shows the entry to add by hand", () => {
    expect(() => codexToml('[mcp_servers.linear\ncommand = "linear-mcp"\n', entry)).toThrow(/not valid TOML[\s\S]*by hand[\s\S]*\[mcp_servers\.agentx\]/);
    expect(() => codexToml('model = "o4"\nmodel = "o5"\n', entry)).toThrow(/not valid TOML/);
  });

  it("keeps dates and times, which the edit check compares by value", () => {
    const existing = 'when = 2026-01-01\nat = 2026-01-01T10:30:00Z\nlocal = 2026-01-01T10:30:00\nclock = 10:30:00\n\n[mcp_servers.linear]\ncommand = "linear-mcp"\n';
    expect(codexToml(existing, entry)).toEqual({ action: "added", text: `${existing}\n${tomlBlock}` });
  });

  it("says a file that defines agentx another way cannot be edited safely", () => {
    expect(() => codexToml('[[mcp_servers.agentx]]\ncommand = "x"\n', entry)).toThrow("~/.codex/config.toml defines agentx in a form this command cannot edit safely");
  });

  it("keeps Windows line endings", () => {
    const existing = '[mcp_servers.linear]\r\ncommand = "linear-mcp"\r\n';
    expect(codexToml(existing, entry).text).toBe(`${existing}\r\n[mcp_servers.agentx]\r\ncommand = "npx"\r\nargs = ["-y", "@charterarc/agentx@0.4.0", "mcp"]\r\n`);
  });

  it("gives back the same text when the entry is already current", () => {
    const once = codexToml('[mcp_servers.linear]\ncommand = "linear-mcp"\n', entry).text;
    expect(codexToml(once, entry)).toEqual({ action: "replaced", text: once });
  });
});

describe("Cursor's mcp.json", () => {
  it("adds or replaces mcpServers.agentx and keeps every other server and key", () => {
    const existing = JSON.stringify({ mcpServers: { linear: { command: "linear-mcp" }, agentx: { command: "old" } }, other: true });
    const result = cursorJson(existing, entry);
    expect(result.action).toBe("replaced");
    expect(JSON.parse(result.text)).toEqual({ mcpServers: { linear: { command: "linear-mcp" }, agentx: entry }, other: true });
    expect(cursorJson(undefined, entry)).toMatchObject({ action: "added" });
  });

  it("refuses a file that is not plain JSON", () => {
    expect(() => cursorJson('{ // comment\n "mcpServers": {} }', entry)).toThrow(/not plain JSON/);
    expect(() => cursorJson("[]", entry)).toThrow(/not a JSON object/);
    expect(() => cursorJson('{ "mcpServers": [] }', entry)).toThrow(/mcpServers that is not an object/);
  });

  it("keeps the file's own indentation", () => {
    const tabs = '{\n\t"mcpServers": {\n\t\t"linear": { "command": "linear-mcp" }\n\t}\n}\n';
    expect(cursorJson(tabs, entry).text).toBe(`${JSON.stringify({ mcpServers: { linear: { command: "linear-mcp" }, agentx: entry } }, null, "\t")}\n`);
    const four = '{\n    "mcpServers": {}\n}';
    expect(cursorJson(four, entry).text).toBe(`${JSON.stringify({ mcpServers: { agentx: entry } }, null, 4)}\n`);
  });
});

describe("installMcp (US7 scenarios 1 and 2)", () => {
  it("writes Codex's file, keeps a copy of the old one, and says what changed", async () => {
    const dir = await withCodexConfig('[mcp_servers.linear]\ncommand = "linear-mcp"\n');
    const text = await installMcp("codex", { print: false }, { home: dir, run: vi.fn(), version: "0.4.0" });
    expect(await readFile(codexFile(dir), "utf8")).toContain('[mcp_servers.agentx]\ncommand = "npx"');
    expect(await readFile(`${codexFile(dir)}.agentx-backup`, "utf8")).toBe('[mcp_servers.linear]\ncommand = "linear-mcp"\n');
    expect(text).toContain(codexFile(dir));
    expect(text).toContain("Added the agentx entry");
  });

  it("writes Cursor's file when it does not exist yet", async () => {
    const dir = await home();
    await installMcp("cursor", { print: false }, { home: dir, run: vi.fn(), version: "0.4.0" });
    expect(JSON.parse(await readFile(cursorFile(dir), "utf8"))).toEqual({ mcpServers: { agentx: entry } });
  });

  it("names --env in the entry when given", async () => {
    const dir = await home();
    await installMcp("codex", { print: false, env: "staging" }, { home: dir, run: vi.fn(), version: "0.4.0" });
    expect(await readFile(codexFile(dir), "utf8")).toContain('args = ["-y", "@charterarc/agentx@0.4.0", "--env", "staging", "mcp"]');
  });

  it("runs again without duplicating the entry, and keeps the first backup", async () => {
    const original = '[mcp_servers.linear]\ncommand = "linear-mcp"\n';
    const dir = await withCodexConfig(original);
    await installMcp("codex", { print: false }, { home: dir, run: vi.fn(), version: "0.4.0" });
    const first = await readFile(codexFile(dir), "utf8");
    const again = await installMcp("codex", { print: false }, { home: dir, run: vi.fn(), version: "0.4.0" });
    expect(again).toContain("already up to date");
    expect(await readFile(codexFile(dir), "utf8")).toBe(first);
    expect(await readFile(`${codexFile(dir)}.agentx-backup`, "utf8")).toBe(original);

    const upgraded = await installMcp("codex", { print: false }, { home: dir, run: vi.fn(), version: "0.5.0" });
    expect(upgraded).toContain("Replaced the agentx entry");
    const text = await readFile(codexFile(dir), "utf8");
    expect(text.match(/\[mcp_servers\.agentx\]/g)).toHaveLength(1);
    expect(text).toContain("@charterarc/agentx@0.5.0");
    expect(text).toContain('[mcp_servers.linear]\ncommand = "linear-mcp"\n');
  });

  it("keeps the file's permissions, on the new file and the backup", async () => {
    const dir = await withCodexConfig('[mcp_servers.linear]\ncommand = "linear-mcp"\n');
    await chmod(codexFile(dir), 0o600);
    await installMcp("codex", { print: false }, { home: dir, run: vi.fn(), version: "0.4.0" });
    expect((await stat(codexFile(dir))).mode & 0o777).toBe(0o600);
    expect((await stat(`${codexFile(dir)}.agentx-backup`)).mode & 0o777).toBe(0o600);
    expect((await readdir(join(dir, ".codex"))).sort()).toEqual(["config.toml", "config.toml.agentx-backup"]);
  });

  it("writes through a symbolic link and keeps the link", async () => {
    const dir = await home();
    await mkdir(join(dir, "dotfiles"));
    await mkdir(join(dir, ".cursor"));
    const target = join(dir, "dotfiles", "mcp.json");
    await writeFile(target, '{ "mcpServers": { "linear": { "command": "linear-mcp" } } }\n');
    await symlink(target, cursorFile(dir));
    await installMcp("cursor", { print: false }, { home: dir, run: vi.fn(), version: "0.4.0" });
    expect((await lstat(cursorFile(dir))).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ mcpServers: { linear: { command: "linear-mcp" }, agentx: entry } });
    // The backup goes beside the link, never into the folder the link points at (a dotfiles checkout, say).
    expect(await readFile(`${cursorFile(dir)}.agentx-backup`, "utf8")).toBe('{ "mcpServers": { "linear": { "command": "linear-mcp" } } }\n');
    expect(await readdir(join(dir, "dotfiles"))).toEqual(["mcp.json"]);
  });

  it("refuses a link that points at a missing file, and writes nothing", async () => {
    const dir = await home();
    await mkdir(join(dir, ".codex"));
    await symlink(join(dir, "dotfiles", "config.toml"), codexFile(dir));
    await expect(installMcp("codex", { print: false }, { home: dir, run: vi.fn(), version: "0.4.0" })).rejects.toThrow(/the link points at a missing file;[\s\S]*by hand[\s\S]*\[mcp_servers\.agentx\]/);
    expect(await readdir(join(dir, ".codex"))).toEqual(["config.toml"]);
    expect((await lstat(codexFile(dir))).isSymbolicLink()).toBe(true);
  });

  it("follows CODEX_HOME, and names the real file in what it says", async () => {
    const dir = await home();
    const codexHome = join(dir, "elsewhere");
    const text = await installMcp("codex", { print: false }, { home: dir, codexHome, run: vi.fn(), version: "0.4.0" });
    expect(await readFile(join(codexHome, "config.toml"), "utf8")).toContain("[mcp_servers.agentx]");
    expect(text).toContain(join(codexHome, "config.toml"));
    await expect(readFile(codexFile(dir), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(join(codexHome, "config.toml"), "[mcp_servers.linear\n");
    await expect(installMcp("codex", { print: false }, { home: dir, codexHome, run: vi.fn(), version: "0.4.0" })).rejects.toThrow(`${join(codexHome, "config.toml")} is not valid TOML`);
  });

  it.each([
    ["not valid TOML", 'TOKEN = "fake-secret-123"\n[mcp_servers.linear\n'],
    ["refused", 'TOKEN = "fake-secret-123"\n[[mcp_servers.agentx]]\ncommand = "x"\n'],
  ])("never repeats the file's contents in its error (%s)", async (_name, text) => {
    const dir = await withCodexConfig(text);
    const error: unknown = await installMcp("codex", { print: false }, { home: dir, run: vi.fn(), version: "0.4.0" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/by hand/);
    expect((error as Error).message).not.toContain("fake-secret-123");
    expect((error as Error).message).not.toContain("TOKEN");
  });

  it.each([
    ["codex", ".codex", "config.toml", "[mcp_servers.linear\n"],
    ["cursor", ".cursor", "mcp.json", "{ \"mcpServers\": { \n"],
  ] as const)("leaves a %s file that does not parse exactly as it was", async (kind, folder, name, broken) => {
    const dir = await home();
    await mkdir(join(dir, folder));
    await writeFile(join(dir, folder, name), broken);
    await expect(installMcp(kind, { print: false }, { home: dir, run: vi.fn(), version: "0.4.0" })).rejects.toThrow(/by hand/);
    expect(await readFile(join(dir, folder, name), "utf8")).toBe(broken);
    expect(await readdir(join(dir, folder))).toEqual([name]);
  });

  it("runs claude mcp remove, then add, at user scope", async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const text = await installMcp("claude-code", { print: false }, { home: await home(), run, version: "0.4.0" });
    expect(run.mock.calls).toEqual([
      ["claude", ["mcp", "remove", "--scope", "user", "agentx"]],
      ["claude", ["mcp", "add", "--scope", "user", "agentx", "--", "npx", "-y", "@charterarc/agentx@0.4.0", "mcp"]],
    ]);
    expect(text).toContain("claude mcp add --scope user agentx -- npx -y @charterarc/agentx@0.4.0 mcp");
  });

  it("says what failed when claude mcp add fails, and the command to run by hand", async () => {
    const run = vi.fn(async (_command: string, args: readonly string[]) => (args[1] === "add" ? { code: 1, stdout: "", stderr: "something broke\n" } : { code: 1, stdout: "", stderr: "not found" }));
    await expect(installMcp("claude-code", { print: false }, { home: await home(), run, version: "0.4.0" })).rejects.toThrow(/claude mcp add failed \(something broke\)[\s\S]*claude mcp add --scope user agentx -- npx/);
  });

  it("says the previous entry was removed, and the exact command to add it back, when add fails after remove (final review M4)", async () => {
    const run = vi.fn(async (_command: string, args: readonly string[]) => (args[1] === "add" ? { code: 1, stdout: "", stderr: "something broke\n" } : { code: 0, stdout: "Removed agentx", stderr: "" }));
    const error: unknown = await installMcp("claude-code", { print: false }, { home: await home(), run, version: "0.4.0" }).catch((caught: unknown) => caught);
    expect((error as Error).message).toContain("claude mcp add failed (something broke)");
    expect((error as Error).message).toContain("the previous agentx entry was removed; add it back with:\n  claude mcp add --scope user agentx -- npx -y @charterarc/agentx@0.4.0 mcp");
  });

  it("does not say an entry was removed when there was none to remove", async () => {
    const run = vi.fn(async (_command: string, args: readonly string[]) => (args[1] === "add" ? { code: 1, stdout: "", stderr: "something broke\n" } : { code: 1, stdout: "", stderr: "not found" }));
    const error: unknown = await installMcp("claude-code", { print: false }, { home: await home(), run, version: "0.4.0" }).catch((caught: unknown) => caught);
    expect((error as Error).message).not.toContain("removed");
  });

  it("prints the command to run when Claude Code is not installed", async () => {
    const run = vi.fn(async () => { throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }); });
    await expect(installMcp("claude-code", { print: false }, { home: await home(), run, version: "0.4.0" })).rejects.toThrow(/claude mcp add --scope user agentx -- npx -y @charterarc\/agentx@0\.4\.0 mcp/);
  });

  it("with --print, only prints the entry and changes nothing", async () => {
    const dir = await home();
    const run = vi.fn();
    const text = await installMcp("codex", { print: true }, { home: dir, run, version: "0.4.0" });
    expect(text).toContain("[mcp_servers.agentx]");
    await expect(readFile(codexFile(dir), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(run).not.toHaveBeenCalled();
    expect(await installMcp("claude-code", { print: true }, { home: dir, run, version: "0.4.0" })).toBe("claude mcp add --scope user agentx -- npx -y @charterarc/agentx@0.4.0 mcp\n");
    expect(run).not.toHaveBeenCalled();
  });
});

describe("runCommand", () => {
  it("gives the exit code and output, and rejects with ENOENT when the command is missing", async () => {
    await expect(runCommand(process.execPath, ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"])).resolves.toEqual({ code: 3, stdout: "out", stderr: "err" });
    await expect(runCommand("agentx-no-such-command-for-tests", [])).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("agentx mcp install", () => {
  const cli = async (argv: string[], dir: string, runCommand = vi.fn()) => {
    let stdout = "";
    let stderr = "";
    const code = await executeCli(argv, {
      environments: { home: dir },
      stdout: { write: (text: string) => (stdout += text) },
      stderr: { write: (text: string) => (stderr += text) },
      runCommand,
    });
    return { code, stdout, stderr };
  };

  it("prints the entry for the chosen client, with --env when typed, and latest for a CLI built from source", async () => {
    const dir = await home();
    const printed = await cli(["--env", "staging", "mcp", "install", "--client", "codex", "--print"], dir);
    expect(printed).toMatchObject({ code: 0, stderr: "" });
    expect(printed.stdout).toBe('[mcp_servers.agentx]\ncommand = "npx"\nargs = ["-y", "@charterarc/agentx@latest", "--env", "staging", "mcp"]\n');
    await expect(readFile(codexFile(dir), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes Cursor's file and passes Claude Code's commands to the runner", async () => {
    const dir = await home();
    expect((await cli(["mcp", "install", "--client", "cursor"], dir)).code).toBe(0);
    expect(JSON.parse(await readFile(cursorFile(dir), "utf8"))).toEqual({ mcpServers: { agentx: mcpEntry(undefined, undefined) } });
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    expect((await cli(["mcp", "install", "--client", "claude-code"], dir, run)).code).toBe(0);
    expect(run).toHaveBeenCalledWith("claude", ["mcp", "add", "--scope", "user", "agentx", "--", "npx", "-y", "@charterarc/agentx@latest", "mcp"]);
  });

  it("writes Codex's file under CODEX_HOME when it is set, and under ~/.codex when it is empty", async () => {
    const dir = await home();
    const codexHome = join(dir, "codex-settings");
    vi.stubEnv("CODEX_HOME", codexHome);
    try {
      expect((await cli(["mcp", "install", "--client", "codex"], dir)).code).toBe(0);
      expect(await readFile(join(codexHome, "config.toml"), "utf8")).toContain("[mcp_servers.agentx]");
      vi.stubEnv("CODEX_HOME", "");
      expect((await cli(["mcp", "install", "--client", "codex"], dir)).code).toBe(0);
      expect(await readFile(codexFile(dir), "utf8")).toContain("[mcp_servers.agentx]");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("needs a known --client", () => {
    const install = createCliProgram().commands.find((command) => command.name() === "mcp")?.commands.find((command) => command.name() === "install");
    const client = install?.options.find((option) => option.long === "--client");
    expect(client).toMatchObject({ mandatory: true, argChoices: ["claude-code", "codex", "cursor"] });
    expect(install?.options.find((option) => option.long === "--print")?.defaultValue).toBe(false);
  });
});

describe("the install guide (FR-047)", () => {
  it("covers install, manual setup, sign-in, a first task and removal for each client, in plain words", async () => {
    const guide = await readFile("docs/mcp-install.md", "utf8");
    for (const client of ["Claude Code", "Codex", "Cursor"]) expect(guide).toContain(`## ${client}`);
    for (const text of [
      "claude mcp add --scope user agentx -- npx -y @charterarc/agentx mcp",
      "npx @charterarc/agentx mcp install --client codex",
      "npx @charterarc/agentx mcp install --client cursor",
      "[mcp_servers.agentx]",
      "\"mcpServers\"",
      "npx @charterarc/agentx login",
      "claude mcp remove --scope user agentx",
      "agentx_start_task",
    ]) expect(guide).toContain(text);
    expect(guide).not.toContain("—");
  });
});
