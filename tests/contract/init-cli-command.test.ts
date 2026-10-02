// tests/contract/init-cli-command.test.ts
// Issue #222: a command on the page works as shown. The published package is named only when this
// CLI runs from it; a build from source is shown by its own path.
//
// Owner decision 2026-10-02 (#218, #235 follow-up): when the published package is what ran, the
// exact command also depends on how npm launched this very process: through npx (npm 7+'s `npm
// exec`, so `npm_command=exec`), or as the bare, directly-invoked installed command.
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cliCommandLine, currentCliInvocation } from "../../packages/cli/src/init/cli-command.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

/** A `node_modules/.bin/agentx` symlink to a published install's main.js, as both a global install and npx make. */
async function publishedBinLink(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agentx-cli-"));
  dirs.push(dir);
  const main = join(dir, "node_modules", "@charterarc", "agentx", "dist", "main.js");
  await mkdir(join(dir, "node_modules", "@charterarc", "agentx", "dist"), { recursive: true });
  await mkdir(join(dir, "node_modules", ".bin"), { recursive: true });
  await writeFile(main, "");
  const bin = join(dir, "node_modules", ".bin", "agentx");
  await symlink(main, bin);
  return bin;
}

describe("the command a person can run", () => {
  it("names the published package, at this version, through npx, when npm launched this process as npx", async () => {
    const bin = await publishedBinLink();
    const invocation = currentCliInvocation(bin, "1.2.3", { npm_command: "exec" });
    expect(invocation.published).toBe(true);
    expect(invocation.invokedViaNpx).toBe(true);
    expect(cliCommandLine(invocation, "login https://abc.example.com")).toBe("npx @charterarc/agentx@1.2.3 login https://abc.example.com");
  });

  it("names the installed command bare, same bin link, when npm did not launch this process as npx", async () => {
    const bin = await publishedBinLink();
    const invocation = currentCliInvocation(bin, "1.2.3", {});
    expect(invocation.published).toBe(true);
    expect(invocation.invokedViaNpx).toBe(false);
    expect(cliCommandLine(invocation, "login https://abc.example.com")).toBe("agentx login https://abc.example.com");
  });

  it("falls back to npx, the universally-working suggestion, when told nothing about how it ran", () => {
    // A persisted hint (built earlier, for a command shown again later) that never set
    // invokedViaNpx: the ready screen's own existing behavior, unchanged.
    expect(cliCommandLine({ published: true, version: "1.2.3", cliPath: "/x" }, "login https://abc.example.com")).toBe("npx @charterarc/agentx@1.2.3 login https://abc.example.com");
  });

  it("shows a build from source by its own path, quoted when it has a space", () => {
    expect(cliCommandLine({ published: false, cliPath: "/opt/agentx/dist/main.js" }, "--env staging doctor")).toBe("node /opt/agentx/dist/main.js --env staging doctor");
    expect(cliCommandLine({ published: false, cliPath: "/Users/a b/agentx/dist/main.js" }, "login https://x")).toBe('node "/Users/a b/agentx/dist/main.js" login https://x');
    expect(currentCliInvocation("/opt/agentx/packages/cli/dist/main.js", undefined).published).toBe(false);
  });
});
