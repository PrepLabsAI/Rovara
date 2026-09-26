import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { packCli, parsePackCliArgs } from "../../scripts/release/pack-cli.js";

const run = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("publishable CLI package", () => {
  it("installs offline into an empty directory and runs", async () => {
    const out = await mkdtemp(join(tmpdir(), "agentx-pack-"));
    const { tarball } = await packCli({ version: "1.2.3", out });
    const manifest = JSON.parse(await readFile(join(out, "package", "package.json"), "utf8")) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      name: "@charterarc/agentx",
      version: "1.2.3",
      bin: { agentx: "bin/agentx.mjs" },
      license: "FSL-1.1-ALv2",
    });
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.files).toEqual(["bin", "README.md", "LICENSE"]);
    expect(manifest.description).toBe("AgentX installer and administration CLI");

    const packagedLicense = await readFile(join(out, "package", "LICENSE"), "utf8");
    expect(packagedLicense).toBe(await readFile(join(repoRoot, "LICENSE"), "utf8"));

    const project = await mkdtemp(join(tmpdir(), "agentx-install-"));
    await run("npm", ["init", "-y"], { cwd: project });
    await run("npm", ["install", "--offline", "--no-audit", "--no-fund", tarball], { cwd: project });
    const bin = join(project, "node_modules", ".bin", "agentx");
    expect((await run(bin, ["--version"])).stdout.trim()).toBe("1.2.3");
    const help = (await run(bin, ["--help"])).stdout;
    expect(help).toContain("env");
    expect(help).toContain("admin");

    // The owners' license ruling (FSL-1.1-ALv2) travels with the installed package, not just the
    // staged one packCli wrote before running `npm pack`.
    const installedLicense = await readFile(join(project, "node_modules", "@charterarc", "agentx", "LICENSE"), "utf8");
    expect(installedLicense).toBe(await readFile(join(repoRoot, "LICENSE"), "utf8"));
  }, 300_000);

  it("honors a custom package name", async () => {
    const out = await mkdtemp(join(tmpdir(), "agentx-pack-name-"));
    const { tarball } = await packCli({ version: "0.0.1", out, name: "@example/agentx-cli" });
    const manifest = JSON.parse(await readFile(join(out, "package", "package.json"), "utf8")) as Record<string, unknown>;
    expect(manifest.name).toBe("@example/agentx-cli");
    expect(tarball).toBe(join(out, "example-agentx-cli-0.0.1.tgz"));
  }, 300_000);
});

describe("parsePackCliArgs", () => {
  it("parses --version and --out, --name optional", () => {
    expect(parsePackCliArgs(["--version", "1.2.3", "--out", "/tmp/out"])).toEqual({ version: "1.2.3", out: "/tmp/out" });
    expect(parsePackCliArgs(["--version", "1.2.3", "--out", "/tmp/out", "--name", "@x/y"])).toEqual({
      version: "1.2.3",
      out: "/tmp/out",
      name: "@x/y",
    });
  });

  it("requires --version and --out", () => {
    expect(() => parsePackCliArgs(["--out", "/tmp/out"])).toThrow(/--version is required/);
    expect(() => parsePackCliArgs(["--version", "1.2.3"])).toThrow(/--out is required/);
  });

  it("refuses an unknown flag", () => {
    expect(() => parsePackCliArgs(["--version", "1.2.3", "--out", "/tmp/out", "--bogus"])).toThrow(/unknown option --bogus/);
  });
});
