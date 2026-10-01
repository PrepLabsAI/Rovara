// Issue #238: AWS CloudShell ships Node 20, but the CLI needs Node 22.19 or newer. The agentx
// executable checks the running Node first, before it loads the rest of the CLI (and so before
// any AWS SDK import or AWS call), and says plainly what to do.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse } from "acorn";
import { transform } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import {
  CLOUDSHELL_NODE_INSTALL_COMMAND,
  CLOUDSHELL_NODE_VERSION,
  NODE_ENGINE_RANGE,
  nodeVersionProblem,
  startCli,
} from "../../packages/cli/src/node-version.js";

const run = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("nodeVersionProblem", () => {
  it("refuses a Node below the floor with one plain message that names both versions", () => {
    const message = nodeVersionProblem("20.20.2", {});
    expect(message).toBe(
      "AgentX needs Node 22.19 or newer; this is Node 20.20.2. Install Node 22 from https://nodejs.org, then run agentx again.",
    );
  });

  it("in AWS CloudShell, prints the one-line Node 22 install and says it only touches this CloudShell", () => {
    const message = nodeVersionProblem("20.20.2", { AWS_EXECUTION_ENV: "CloudShell" });
    expect(message).toBe([
      "AgentX needs Node 22.19 or newer; this is Node 20.20.2. In AWS CloudShell, run this command, then run agentx again:",
      "",
      `  ${CLOUDSHELL_NODE_INSTALL_COMMAND}`,
      "",
      "It installs Node 22 in your own CloudShell home folder only; nothing else in your AWS account is affected.",
    ].join("\n"));
  });

  it("accepts the floor itself and anything newer", () => {
    for (const version of ["22.19.0", "22.19.1", "22.20.0", "22.23.3", "23.0.0", "24.1.0"]) {
      expect(nodeVersionProblem(version, { AWS_EXECUTION_ENV: "CloudShell" }), version).toBeUndefined();
    }
  });

  it("refuses every version below the floor, including the patch and minor just under it", () => {
    for (const version of ["22.18.9", "22.18.0", "22.0.0", "21.99.99", "20.20.2", "18.20.4", "16.0.0"]) {
      expect(nodeVersionProblem(version, {}), version).toContain(`this is Node ${version}.`);
    }
  });

  it("only uses the CloudShell wording when AWS_EXECUTION_ENV is exactly CloudShell", () => {
    expect(nodeVersionProblem("20.20.2", { AWS_EXECUTION_ENV: "AWS_Lambda_nodejs20.x" })).not.toContain("CloudShell");
    expect(nodeVersionProblem("20.20.2", {})).not.toContain(CLOUDSHELL_NODE_INSTALL_COMMAND);
  });
});

describe("startCli", () => {
  it("on Node below the floor, writes the message, returns exit code 1, and never loads the CLI", async () => {
    const writeError = vi.fn();
    const loadCli = vi.fn();
    const code = await startCli({ nodeVersion: "20.20.2", env: { AWS_EXECUTION_ENV: "CloudShell" }, writeError, loadCli });
    expect(code).toBe(1);
    expect(loadCli).not.toHaveBeenCalled();
    expect(writeError).toHaveBeenCalledTimes(1);
    expect(writeError).toHaveBeenCalledWith(`${nodeVersionProblem("20.20.2", { AWS_EXECUTION_ENV: "CloudShell" })}\n`);
  });

  it("on a supported Node, writes nothing and returns the CLI's own exit code", async () => {
    const writeError = vi.fn();
    const executeCli = vi.fn(async () => 7);
    const code = await startCli({ nodeVersion: "22.19.0", env: {}, writeError, loadCli: async () => ({ executeCli }) });
    expect(code).toBe(7);
    expect(executeCli).toHaveBeenCalledTimes(1);
    expect(writeError).not.toHaveBeenCalled();
  });
});

describe("the agentx executable (packages/cli/src/bin.ts)", () => {
  // Preloaded with `node --import`: this Node then reports itself as the Node 20 that AWS
  // CloudShell ships, so the real executable's check runs.
  const fakeNode20 = `data:text/javascript,${encodeURIComponent('Object.defineProperty(process, "versions", { value: { ...process.versions, node: "20.20.2" }, configurable: true });')}`;
  const bin = join(repoRoot, "packages", "cli", "src", "bin.ts");

  it("under Node 20 prints the plain message, exits non-zero, and runs no command", async () => {
    // `--version` would print the CLI's version if the rest of the CLI loaded.
    const result = await run(process.execPath, ["--import", "tsx", "--import", fakeNode20, bin, "--version"], {
      cwd: repoRoot,
      env: { ...process.env, AWS_EXECUTION_ENV: "CloudShell" },
    }).then(() => undefined, (error: { code?: number; stdout?: string; stderr?: string }) => error);
    expect(result, "the bin must fail under Node 20").toBeDefined();
    expect(result!.code).toBe(1);
    expect(result!.stdout).toBe("");
    expect(result!.stderr).toBe(`${nodeVersionProblem("20.20.2", { AWS_EXECUTION_ENV: "CloudShell" })}\n`);
  }, 60_000);

  it("on a supported Node runs the command and prints no Node message", async () => {
    const { stdout, stderr } = await run(process.execPath, ["--import", "tsx", bin, "--version"], { cwd: repoRoot, env: { ...process.env, AWS_EXECUTION_ENV: "CloudShell" } });
    expect(stdout.trim()).toBe("0.1.0");
    expect(stderr).not.toContain("AgentX needs Node");
  }, 60_000);

  it("is written in syntax an old Node can parse (ES2020), so the check runs before anything newer loads", async () => {
    for (const file of ["bin.ts", "node-version.ts"]) {
      const source = await readFile(join(repoRoot, "packages", "cli", "src", file), "utf8");
      // Strip the types only: esnext keeps every piece of syntax as written.
      const { code } = await transform(source, { loader: "ts", format: "esm", target: "esnext" });
      expect(() => parse(code, { ecmaVersion: 2020, sourceType: "module", allowHashBang: true }), file).not.toThrow();
    }
  });

  it("is the bin of the CLI package and of npm run agentx", async () => {
    const cliManifest = JSON.parse(await readFile(join(repoRoot, "packages", "cli", "package.json"), "utf8")) as { bin: Record<string, string> };
    expect(cliManifest.bin).toEqual({ agentx: "./dist/bin.js" });
    const rootManifest = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(rootManifest.scripts.agentx).toBe("node packages/cli/dist/bin.js");
  });
});

describe("the Node version floor and the CloudShell command have one source", () => {
  it("the floor matches the repository's own engines.node lower bound", async () => {
    const rootManifest = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as { engines: { node: string } };
    expect(rootManifest.engines.node.split(" ")[0]).toBe(NODE_ENGINE_RANGE);
  });

  it("the pinned CloudShell Node is a Node 22 at or above the floor", () => {
    expect(CLOUDSHELL_NODE_VERSION).toMatch(/^22\.\d+\.\d+$/);
    expect(nodeVersionProblem(CLOUDSHELL_NODE_VERSION, {})).toBeUndefined();
    expect(CLOUDSHELL_NODE_INSTALL_COMMAND).toContain(`V=v${CLOUDSHELL_NODE_VERSION} `);
  });

  it("the command checks the download against nodejs.org's SHASUMS256 and installs only under ~/.local/node22", () => {
    expect(CLOUDSHELL_NODE_INSTALL_COMMAND).toContain("https://nodejs.org/dist/$V/SHASUMS256.txt");
    expect(CLOUDSHELL_NODE_INSTALL_COMMAND).toContain("sha256sum -c -");
    expect(CLOUDSHELL_NODE_INSTALL_COMMAND).toContain("D=$HOME/.local/node22");
    expect(CLOUDSHELL_NODE_INSTALL_COMMAND).not.toMatch(/sudo|\/usr\/|\| *(ba)?sh\b/);
  });

  it("docs/install.md shows exactly the command the CLI prints, with how to remove it", async () => {
    const install = await readFile(join(repoRoot, "docs", "install.md"), "utf8");
    expect(install).toContain(`\`\`\`sh\n${CLOUDSHELL_NODE_INSTALL_COMMAND}\n\`\`\``);
    expect(install).toContain("This only affects your own CloudShell, in this region; nothing else in your AWS account uses it.");
    expect(install).toContain("rm -rf ~/.local/node22");
    expect(nodeVersionProblem("20.20.2", { AWS_EXECUTION_ENV: "CloudShell" })).toContain(`\n  ${CLOUDSHELL_NODE_INSTALL_COMMAND}\n`);
  });
});
