// F3 cut 1: the shape of the Code API package. It must stay a leaf that a browser can load and a client can build on its own from a checkout of this folder (plan 2.1, 2.4, 5.3).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import { describe, expect, it } from "vitest";
import * as codeApi from "@preplabsai/rovara-code-api";
import { bundledPackageDirectories } from "../../scripts/release/pack-cli.js";

const PACKAGE = resolve("packages/code-api");
const sources = (): string[] => readdirSync(join(PACKAGE, "src")).filter((file) => file.endsWith(".ts")).sort();
const importsOf = (source: string): string[] => [...source.matchAll(/^\s*(?:import|export)\s+(?:type\s+)?(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/gmu)].map((match) => match[1]!);

describe("the Code API package", () => {
  const manifest = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8")) as Record<string, unknown>;

  it("is named for the plan, has zod as its only peer, no dependencies and no install script", () => {
    expect(manifest.name).toBe("@preplabsai/rovara-code-api");
    expect(manifest.type).toBe("module");
    expect(manifest.sideEffects).toBe(false);
    expect(manifest.peerDependencies).toEqual({ zod: "^4.6.6" });
    expect(manifest.devDependencies).toEqual({ zod: "4.6.6" });
    expect(manifest.dependencies).toBeUndefined();
    expect(Object.keys((manifest.scripts as Record<string, string> | undefined) ?? {}).filter((name) => /^(pre|post)?(install|prepare|publish)/u.test(name))).toEqual([]);
    expect(Object.keys(manifest.exports as object)).toEqual([".", "./errors"]);
  });

  it("imports only zod and its own files, and no node: module", () => {
    const found = sources().flatMap((file) => importsOf(readFileSync(join(PACKAGE, "src", file), "utf8")).map((specifier) => `${file} ${specifier}`));
    expect(found.filter((entry) => !/ (zod|\.\/[a-z-]+\.js)$/u.test(entry))).toEqual([]);
    for (const file of sources()) expect(readFileSync(join(PACKAGE, "src", file), "utf8"), file).not.toMatch(/\bBuffer\b|\bprocess\.(?:env|argv|cwd|exit|platform|stdout|stderr)|\brequire\(|["']node:/u);
  });

  it("has a self-contained tsconfig and states the skew rule in its README", () => {
    const config = JSON.parse(readFileSync(join(PACKAGE, "tsconfig.json"), "utf8")) as { extends?: string; references?: unknown; compilerOptions: { types: string[]; outDir: string; rootDir: string } };
    expect(config.extends).toBeUndefined();
    expect(config.references).toBeUndefined();
    expect(config.compilerOptions).toMatchObject({ types: [], outDir: "dist", rootDir: "src" });
    const readme = readFileSync(join(PACKAGE, "README.md"), "utf8");
    for (const line of ["Additions go Code first", "Removals and narrowings go Cloud first", "CODE_API_MIN_CLIENT", "Cloud's pin must not be above the live Code's CODE_API_VERSION"]) expect(readme).toContain(line);
  });

  it("bundles for a browser with no node: module and no built-in left over", () => {
    const result = buildSync({ entryPoints: [join(PACKAGE, "src/index.ts")], bundle: true, platform: "browser", format: "esm", write: false, metafile: true, logLevel: "silent", external: ["zod"], tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } } });
    expect(Object.keys(result.metafile.inputs).filter((input) => input.startsWith("node:") || input.includes("node_modules"))).toEqual([]);
    expect(result.outputFiles.map((file) => file.text).join("")).not.toMatch(/node:/u);
  });

  it("builds on its own: copied out of the repository and compiled with the repository's TypeScript, the way a client's fetch script does", async () => {
    const work = mkdtempSync(join(tmpdir(), "code-api-build-"));
    try {
      cpSync(PACKAGE, join(work, "pkg"), { recursive: true, filter: (path) => !/(^|\/)(dist|node_modules|[^/]*\.tsbuildinfo)(\/|$)/u.test(path) });
      symlinkSync(resolve("node_modules"), join(work, "pkg", "node_modules"));
      execFileSync(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "-p", join(work, "pkg", "tsconfig.json")], { cwd: join(work, "pkg"), stdio: "pipe" });
      for (const file of ["index.js", "index.d.ts", "errors.js", "routes.js", "scopes.js", "version.js"]) expect(existsSync(join(work, "pkg", "dist", file)), file).toBe(true);
      writeFileSync(join(work, "pkg", "package.json"), JSON.stringify({ ...manifest, version: "1.2.0" }));
      const built = await import(pathToFileURL(join(work, "pkg", "dist", "index.js")).href) as typeof codeApi;
      const here = codeApi;
      expect(built.ROUTES).toEqual(here.ROUTES);
      expect(built.AgentXErrorCodeSchema.options).toEqual(here.AgentXErrorCodeSchema.options);
      expect([built.CODE_API_VERSION, built.CODE_API_MIN_CLIENT]).toEqual([here.CODE_API_VERSION, here.CODE_API_MIN_CLIENT]);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 120_000);

  it("is a workspace package, not a third-party one, to the CLI's notices scan (it is bundled from packages/, never node_modules)", () => {
    const result = buildSync({ stdin: { contents: 'export { ROUTES } from "@preplabsai/rovara-code-api"; export { agentXError } from "@preplabsai/rovara-code-api/errors";', resolveDir: resolve("packages/contracts/src"), loader: "ts" }, bundle: true, platform: "node", format: "esm", write: false, metafile: true, logLevel: "silent", external: ["zod"] });
    const inputs = Object.keys(result.metafile.inputs);
    expect(inputs.filter((input) => input.startsWith("packages/code-api/"))).not.toEqual([]);
    expect(inputs.filter((input) => input.includes("node_modules"))).toEqual([]);
    expect([...bundledPackageDirectories(result.metafile, resolve(".")).values()]).toEqual([]);
  });
});
