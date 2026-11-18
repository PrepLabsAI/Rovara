// The checkout's git remote, read by `agentx mcp` to find the repository: git is found only on absolute PATH entries (never the checkout itself), and a remote with credentials never leaves.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeGitPath } from "../../../packages/cli/src/mcp/serve.js";
import { safeRemote } from "../../../packages/mcp/src/knowledge-tools.js";

describe("safeGitPath", () => {
  it("keeps absolute entries only: an empty, relative or dot entry would run a git planted in the checkout", () => {
    expect(safeGitPath("/usr/bin:/opt/homebrew/bin")).toBe("/usr/bin:/opt/homebrew/bin");
    expect(safeGitPath(":/usr/bin:.:bin:../x:/a/../b:/usr/local/bin")).toBe("/usr/bin:/usr/local/bin");
    for (const none of [undefined, "", ":", ".", "bin:tools"]) expect(safeGitPath(none)).toBe("/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin");
  });
  it("positive control: an unsafe PATH really runs a planted git from the working directory, the safe one does not", () => {
    const dir = mkdtempSync(join(tmpdir(), "planted-git-"));
    writeFileSync(join(dir, "git"), "#!/bin/sh\necho PLANTED\n");
    chmodSync(join(dir, "git"), 0o755);
    const run = (path: string) => { try { return execFileSync("git", ["--version"], { cwd: dir, env: { PATH: path }, encoding: "utf8", timeout: 5_000 }); } catch { return "no git"; } };
    expect(run("")).toContain("PLANTED");
    expect(run(safeGitPath(""))).not.toContain("PLANTED");
  });
});

describe("safeRemote", () => {
  it("drops credentials, query and fragment; passes scp-style and plain addresses; refuses what it cannot clean", () => {
    expect(safeRemote("https://user:ghp_secret@github.com/acme/api.git?token=abc#x")).toBe("https://github.com/acme/api.git");
    expect(safeRemote("git@github.com:acme/api.git")).toBe("git@github.com:acme/api.git");
    expect(safeRemote("github.com/acme/api")).toBe("github.com/acme/api");
    // A URL that cannot be parsed but holds a token is never sent as it is.
    expect(safeRemote("https://u:ghp_x@host:99999/r")).toBeUndefined();
    expect(safeRemote("git@host:acme/api.git?access_token=abc")).toBeUndefined();
    expect(safeRemote("has space")).toBeUndefined();
  });
});
