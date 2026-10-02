// tests/contract/init-cli-command.test.ts
// Issue #222: a command on the page works as shown. The published package is named only when this
// CLI runs from it; a build from source is shown by its own path.
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cliCommandLine, currentCliInvocation } from "../../packages/cli/src/init/cli-command.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("the command a person can run", () => {
  it("names the published package, at this version, when the CLI runs from it, even through npx's bin link", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentx-cli-")); dirs.push(dir);
    const main = join(dir, "node_modules", "@charterarc", "agentx", "dist", "main.js");
    await mkdir(join(dir, "node_modules", "@charterarc", "agentx", "dist"), { recursive: true });
    await mkdir(join(dir, "node_modules", ".bin"), { recursive: true });
    await writeFile(main, "");
    await symlink(main, join(dir, "node_modules", ".bin", "agentx"));
    const invocation = currentCliInvocation(join(dir, "node_modules", ".bin", "agentx"), "1.2.3");
    expect(invocation.published).toBe(true);
    expect(cliCommandLine(invocation, "login https://abc.example.com")).toBe("npx @charterarc/agentx@1.2.3 login https://abc.example.com");
  });

  it("shows a build from source by its own path, quoted when it has a space", () => {
    expect(cliCommandLine({ published: false, cliPath: "/opt/agentx/dist/main.js" }, "--env staging doctor")).toBe("node /opt/agentx/dist/main.js --env staging doctor");
    expect(cliCommandLine({ published: false, cliPath: "/Users/a b/agentx/dist/main.js" }, "login https://x")).toBe('node "/Users/a b/agentx/dist/main.js" login https://x');
    expect(currentCliInvocation("/opt/agentx/packages/cli/dist/main.js", undefined).published).toBe(false);
  });
});
