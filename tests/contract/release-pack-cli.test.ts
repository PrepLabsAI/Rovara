import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ENTRY_SHEBANG_FILTER, packCli, parsePackCliArgs } from "../../scripts/release/pack-cli.js";

const run = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("publishable CLI package", () => {
  it("installs offline into an empty directory and runs", async () => {
    const out = await mkdtemp(join(tmpdir(), "agentx-pack-"));
    temporaryDirectories.push(out);
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
    expect(manifest.repository).toEqual({ type: "git", url: "git+https://github.com/PrepLabsAI/AgentX.git" });

    const packagedLicense = await readFile(join(out, "package", "LICENSE"), "utf8");
    expect(packagedLicense).toBe(await readFile(join(repoRoot, "LICENSE"), "utf8"));

    const project = await mkdtemp(join(tmpdir(), "agentx-install-"));
    temporaryDirectories.push(project);
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
    temporaryDirectories.push(out);
    const { tarball } = await packCli({ version: "0.0.1", out, name: "@example/agentx-cli" });
    const manifest = JSON.parse(await readFile(join(out, "package", "package.json"), "utf8")) as Record<string, unknown>;
    expect(manifest.name).toBe("@example/agentx-cli");
    expect(tarball).toBe(join(out, "example-agentx-cli-0.0.1.tgz"));
  }, 300_000);

  it("rebuilds cleanly when out/package already holds files from a previous run", async () => {
    const out = await mkdtemp(join(tmpdir(), "agentx-pack-rerun-"));
    temporaryDirectories.push(out);
    await packCli({ version: "1.0.0", out });
    // Simulate a leftover file from a prior, differently-configured run (e.g. an old package.json
    // written under a name this run doesn't use); rerunning must not leave it mixed into the
    // rebuilt package.
    await writeFile(join(out, "package", "stray-leftover.txt"), "stale", "utf8");
    await packCli({ version: "2.0.0", out });
    await expect(readFile(join(out, "package", "stray-leftover.txt"), "utf8")).rejects.toThrow(/ENOENT/);
    const manifest = JSON.parse(await readFile(join(out, "package", "package.json"), "utf8")) as Record<string, unknown>;
    expect(manifest.version).toBe("2.0.0");
  }, 300_000);
});

describe("ENTRY_SHEBANG_FILTER", () => {
  it("matches the entry file's path on both POSIX and Windows-style separators", () => {
    expect(ENTRY_SHEBANG_FILTER.test("/repo/packages/cli/src/main.ts")).toBe(true);
    expect(ENTRY_SHEBANG_FILTER.test("C:\\repo\\packages\\cli\\src\\main.ts")).toBe(true);
  });

  it("does not match a different file, on either separator style", () => {
    expect(ENTRY_SHEBANG_FILTER.test("/repo/packages/cli/src/other.ts")).toBe(false);
    expect(ENTRY_SHEBANG_FILTER.test("C:\\repo\\packages\\cli\\src\\other.ts")).toBe(false);
  });
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

  it("refuses a stray positional argument", () => {
    expect(() => parsePackCliArgs(["--version", "1.2.3", "--out", "/tmp/out", "extra"])).toThrow(/unexpected argument extra/);
    expect(() => parsePackCliArgs(["extra", "--version", "1.2.3", "--out", "/tmp/out"])).toThrow(/unexpected argument extra/);
  });
});
