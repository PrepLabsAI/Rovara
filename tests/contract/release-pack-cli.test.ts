import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse } from "acorn";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { NODE_ENGINE_RANGE, nodeVersionProblem } from "../../packages/cli/src/node-version.js";
import { ENTRY_SHEBANG_FILTER, packCli, parsePackCliArgs, thirdPartyNotices } from "../../scripts/release/pack-cli.js";

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
    expect(manifest.files).toEqual(["bin", "README.md", "LICENSE", "THIRD_PARTY_NOTICES"]);
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
    // Issue #238: under the Node 20 that AWS CloudShell ships, the installed executable stops with
    // the plain message before the bundled CLI (and its AWS SDK) loads, and runs no command.
    const fakeNode20 = `data:text/javascript,${encodeURIComponent('Object.defineProperty(process, "versions", { value: { ...process.versions, node: "20.20.2" }, configurable: true });')}`;
    const old = await run(bin, ["--version"], { env: { ...process.env, NODE_OPTIONS: `--import ${fakeNode20}`, AWS_EXECUTION_ENV: "CloudShell" } })
      .then(() => undefined, (error: { code?: number; stdout?: string; stderr?: string }) => error);
    expect(old, "the installed executable must fail under Node 20").toBeDefined();
    expect(old!.code).toBe(1);
    expect(old!.stdout).toBe("");
    expect(old!.stderr).toBe(`${nodeVersionProblem("20.20.2", { AWS_EXECUTION_ENV: "CloudShell" })}\n`);
    // The executable is a small entry an old Node can parse; the CLI itself is the one bundle next to it.
    const entry = await readFile(join(project, "node_modules", "@charterarc", "agentx", "bin", "agentx.mjs"), "utf8");
    expect(() => parse(entry, { ecmaVersion: 2020, sourceType: "module", allowHashBang: true })).not.toThrow();
    expect(entry).toContain("./agentx-cli.mjs");
    expect(entry.length).toBeLessThan(20_000);
    expect(manifest.engines).toEqual({ node: NODE_ENGINE_RANGE });
    expect(help).toContain("env");
    expect(help).toContain("admin");

    // FR-060: the install page is inside the installed package's one CLI bundle
    // (bin/agentx-cli.mjs, which bin/agentx.mjs loads), and init's help names both ways to ask.
    const initHelp = (await run(bin, ["init", "--help"])).stdout;
    expect(initHelp).toContain("--ui");
    expect(initHelp).toContain("--no-ui");
    expect(initHelp).toContain("the default in an interactive terminal that can open a browser");
    const bundle = await readFile(join(project, "node_modules", "@charterarc", "agentx", "bin", "agentx-cli.mjs"), "utf8");
    expect(bundle).toContain("<title>Install AgentX</title>");
    expect(bundle).toContain("x-agentx-wizard-token");
    expect(bundle).toContain("renderPanelCards(state);");

    // The owners' license ruling (FSL-1.1-ALv2) travels with the installed package, not just the
    // staged one packCli wrote before running `npm pack`.
    const installedLicense = await readFile(join(project, "node_modules", "@charterarc", "agentx", "LICENSE"), "utf8");
    expect(installedLicense).toBe(await readFile(join(repoRoot, "LICENSE"), "utf8"));
    // The bundled packages' notices travel with the installed package too (MIT and BSD require them).
    const installedNotices = await readFile(join(project, "node_modules", "@charterarc", "agentx", "THIRD_PARTY_NOTICES"), "utf8");
    expect(installedNotices).toBe(await readFile(join(out, "package", "THIRD_PARTY_NOTICES"), "utf8"));
  }, 300_000);

  it("names every bundled node_modules package in THIRD_PARTY_NOTICES, with its version, license and license text", async () => {
    const out = await mkdtemp(join(tmpdir(), "agentx-pack-notices-"));
    temporaryDirectories.push(out);
    const { bundledPackages } = await packCli({ version: "1.2.3", out });
    const notices = await readFile(join(out, "package", "THIRD_PARTY_NOTICES"), "utf8");
    const names = bundledPackages.map((entry) => entry.name);
    expect(names).toEqual(expect.arrayContaining(["@modelcontextprotocol/sdk", "smol-toml", "zod", "commander"]));
    expect(names.some((name) => name.startsWith("@agentx/"))).toBe(false);
    // A nested copy of another version is its own entry; the same version is listed once.
    const versions = bundledPackages.map((entry) => `${entry.name}@${entry.version}`);
    expect(new Set(versions).size).toBe(versions.length);
    for (const entry of bundledPackages) {
      const installed = JSON.parse(await readFile(join(repoRoot, "node_modules", entry.name, "package.json"), "utf8").catch(() => "{}")) as { version?: string; license?: string };
      if (installed.version === entry.version) expect(entry.license, entry.name).toBe(installed.license);
      expect(notices, entry.name).toContain(`${entry.name}@${entry.version}\nLicense: ${entry.license}\n`);
    }
    // Each package's own LICENSE text, not only its name.
    const smolLicense = await readFile(join(repoRoot, "node_modules", "smol-toml", "LICENSE"), "utf8");
    expect(notices).toContain(smolLicense.trim());
    // Every package esbuild bundles from node_modules is named, found here from esbuild's own
    // metafile for the same entry point: none is missing.
    const { metafile } = await build({
      entryPoints: [join(repoRoot, "packages/cli/src/main.ts")], bundle: true, platform: "node", format: "esm", target: "node22",
      write: false, metafile: true, logLevel: "silent", define: { __AGENTX_VERSION__: JSON.stringify("1.2.3") },
    });
    const expected = new Set(Object.keys(metafile.inputs).flatMap((input) => {
      const match = /.*node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input.split("\\").join("/"));
      return match === null ? [] : [match[1]!];
    }));
    expect(expected.size).toBeGreaterThan(3);
    for (const name of expected) expect(names, name).toContain(name);
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

describe("thirdPartyNotices", () => {
  it("orders packages by code point, the same on every machine's locale", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentx-notices-order-"));
    temporaryDirectories.push(root);
    for (const name of ["alpha", "Zeta", "_under"]) {
      await mkdir(join(root, "node_modules", name), { recursive: true });
      await writeFile(join(root, "node_modules", name, "package.json"), JSON.stringify({ name, version: "1.0.0", license: "MIT" }));
      await writeFile(join(root, "node_modules", name, "LICENSE"), `license of ${name}`);
    }
    const metafile = { inputs: Object.fromEntries(["alpha", "Zeta", "_under"].map((name) => [`node_modules/${name}/index.js`, { bytes: 1, imports: [] }])), outputs: {} };
    const { packages } = await thirdPartyNotices(metafile, root);
    // Code points: "Z" (0x5A) < "_" (0x5F) < "a" (0x61); a locale-aware compare puts "_under" or "alpha" first.
    expect(packages.map((entry) => entry.name)).toEqual(["Zeta", "_under", "alpha"]);
  });
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
