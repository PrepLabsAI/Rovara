// Guard test 1 of the modular split (docs/modular/move-map.md): packages are reached only through their named entries.
//
// Every workspace package has one root entry and a short, written-out list of named sub-entries in its package.json `exports`. This test fails on:
//   - an import (or export-from, dynamic import, vi.mock, require) of a workspace package by a specifier that is not one of its entries
//     (`@rovara-code/core/dist/x.js`, `@rovara-code/core/aws/broker`, a name the package does not export);
//   - a relative import in a package's own files that leaves the package folder (`../../core/src/x.js`): the package would reach into another
//     package's source instead of its entry. Tests under tests/ are whitebox tests of the source and may import files by path; they still may not
//     import a workspace package by a name that is not an entry;
//   - an `exports` map with a wildcard, a target outside dist, or a target with no source file behind it (a typo that only shows after a build);
//   - packages whose versions differ, are not 0.x, or are not private (decision 154: built and versioned, never published to npm);
//   - a browser-safe entry of @rovara-code/contracts that reaches a Node built-in.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { browserChecker } from "../../scripts/browser-safe.js";
import { stamp } from "../../scripts/stamp-package-versions.js";

interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  publishConfig?: unknown;
  main?: string;
  bin?: unknown;
  files?: string[];
  exports?: string | Record<string, string | { types?: string; default?: string }>;
}
interface Workspace { directory: string; manifest: Manifest }

const root = process.cwd();
const workspaces: Workspace[] = [
  ...readdirSync(join(root, "packages"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => `packages/${entry.name}`),
  "infra",
].sort().map((directory) => ({ directory, manifest: JSON.parse(readFileSync(join(root, directory, "package.json"), "utf8")) as Manifest }));

/** The entries a package names, as `{ specifier: target }`; "." is the root entry. */
function namedEntries(manifest: Manifest): Map<string, string> {
  const entries = new Map<string, string>();
  const target = (value: string | { types?: string; default?: string } | undefined): string | undefined => (typeof value === "string" ? value : value?.default);
  if (manifest.exports === undefined) {
    if (manifest.main !== undefined) entries.set(manifest.name, manifest.main);
    return entries;
  }
  if (typeof manifest.exports === "string") return new Map([[manifest.name, manifest.exports]]);
  for (const [key, value] of Object.entries(manifest.exports)) {
    const resolved = target(value);
    if (resolved !== undefined) entries.set(key === "." ? manifest.name : `${manifest.name}${key.slice(1)}`, resolved);
  }
  return entries;
}

const SKIP = new Set(["node_modules", "dist", "cdk.out", ".release-synth", ".cache"]);
const CODE = /\.(?:ts|tsx|mts|js|mjs)$/;
function walk(directory: string): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name)) return [];
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory() ? walk(path) : CODE.test(entry.name) ? [path] : [];
  });
}

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\bvi\.(?:mock|doMock|importActual|importMock|unmock)\s*\(\s*|\brequire\s*\(\s*)["']([^"'\n]+)["']/g;
/** Every module specifier a file names in an import-like position. */
function specifiersOf(text: string): string[] {
  // Comment lines (`//`, `*`) are examples and prose, not imports; a specifier with a `${` in it is a template inside a test fixture.
  const code = text.split("\n").filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line)).join("\n");
  return [...code.matchAll(SPECIFIER)].map((match) => match[1]!).filter((specifier) => !specifier.includes("${"));
}

const names = workspaces.map((workspace) => workspace.manifest.name);
const entriesByPackage = new Map(workspaces.map((workspace) => [workspace.manifest.name, namedEntries(workspace.manifest)]));
const files = [...workspaces.flatMap((workspace) => (workspace.directory === "infra" ? walk("infra") : walk(workspace.directory))), ...walk("tests"), ...walk("scripts")]
  .filter((file, index, all) => all.indexOf(file) === index);

/** The workspace package a bare specifier belongs to, or null. */
function workspaceOf(specifier: string): string | null {
  return names.find((name) => specifier === name || specifier.startsWith(`${name}/`)) ?? null;
}

describe("packages are reached only through named entries", () => {
  it("finds the workspace packages it is meant to guard", () => {
    expect(names).toEqual(expect.arrayContaining(["@rovara-code/contracts", "@rovara-code/core", "@rovara-code/aws", "@rovara-code/worker", "@rovara-code/testing"]));
    expect(files.length).toBeGreaterThan(1000);
  });

  it("no file imports a workspace package by a name that is not one of its entries", () => {
    const violations: string[] = [];
    for (const file of files) {
      for (const specifier of specifiersOf(readFileSync(join(root, file), "utf8"))) {
        const owner = workspaceOf(specifier);
        if (owner !== null && !entriesByPackage.get(owner)!.has(specifier)) violations.push(`${file}: ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("no package file reaches into another package by a relative path", () => {
    const violations: string[] = [];
    for (const workspace of workspaces) {
      for (const file of files.filter((candidate) => candidate.startsWith(`${workspace.directory}/`))) {
        for (const specifier of specifiersOf(readFileSync(join(root, file), "utf8")).filter((value) => value.startsWith("."))) {
          const target = normalize(join(dirname(file), specifier));
          if (target.startsWith("..") || (!target.startsWith(`${workspace.directory}${sep}`) && target !== workspace.directory)) violations.push(`${file}: ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it.each(workspaces.map((workspace) => [workspace.manifest.name, workspace] as const))("%s has a plain list of named entries, each with a source file", (_name, workspace) => {
    const { manifest, directory } = workspace;
    if (typeof manifest.exports === "object") {
      for (const key of Object.keys(manifest.exports)) {
        expect(key, `${manifest.name} exports key ${key}`).toMatch(/^(\.|\.\/[a-z0-9][a-z0-9/-]*)$/);
      }
    }
    for (const [specifier, target] of namedEntries(manifest)) {
      if (directory === "infra") continue;
      expect(target, specifier).toMatch(/^\.\/dist\/.+\.js$/);
      expect(existsSync(join(root, directory, "src", `${target.slice("./dist/".length, -3)}.ts`)), `${specifier} -> ${target} has no source file`).toBe(true);
    }
  });

  it("all packages share one 0.x version, are private, and say nothing about publishing", () => {
    const versions = new Set(workspaces.map((workspace) => workspace.manifest.version));
    expect([...versions]).toHaveLength(1);
    expect([...versions][0]).toMatch(/^0\.\d+\.\d+$/);
    for (const { manifest } of workspaces) {
      expect(manifest.private, `${manifest.name} must stay private (decision 154)`).toBe(true);
      expect(manifest.publishConfig, `${manifest.name} must not carry publishConfig`).toBeUndefined();
    }
  });

  it("every workspace dependency on another workspace package is at the shared version", () => {
    const version = workspaces[0]!.manifest.version;
    for (const { directory } of workspaces) {
      const manifest = JSON.parse(readFileSync(join(root, directory, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      for (const [name, range] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
        if (names.includes(name)) expect(range, `${directory} depends on ${name}`).toBe(version);
      }
    }
  });

  it("every package ships its build and nothing else: dist, no source maps, no src", () => {
    for (const { manifest, directory } of workspaces) {
      if (directory === "infra") continue;
      expect(manifest.files, manifest.name).toEqual(expect.arrayContaining(["dist", "!dist/**/*.map"]));
      expect(manifest.files, manifest.name).not.toContain("src");
    }
  });

  it("core keeps the entries Cloud imports today", () => {
    const entries = entriesByPackage.get("@rovara-code/core")!;
    for (const name of ["", "/ports", "/channel", "/task-flow", "/cost", "/lessons/audit-sink", "/lessons/types"]) expect(entries.has(`@rovara-code/core${name}`), name).toBe(true);
  });

  it("the lessons package has the entries Cloud imports, and core's old lessons paths are only the two Cloud used (compatibility for one release)", () => {
    const lessons = entriesByPackage.get("@rovara-code/lessons")!;
    expect([...lessons.keys()].sort()).toEqual(["@rovara-code/lessons", "@rovara-code/lessons/audit-sink", "@rovara-code/lessons/types"]);
    const oldPaths = [...entriesByPackage.get("@rovara-code/core")!.keys()].filter((name) => name.startsWith("@rovara-code/core/lessons/")).sort();
    expect(oldPaths).toEqual(["@rovara-code/core/lessons/audit-sink", "@rovara-code/core/lessons/types"]);
  });

  it("stamping puts one version on a package and on its dependencies on other packages, and leaves the rest", () => {
    const stamped = stamp({ name: "@rovara-code/a", version: "0.1.0", dependencies: { "@rovara-code/b": "0.1.0", zod: "4.6.6" }, devDependencies: { vitest: "5.0.3", "@rovara-code/c": "0.1.0" } }, new Set(["@rovara-code/a", "@rovara-code/b", "@rovara-code/c"]), "0.1.0-ci.abc");
    expect(stamped).toEqual({ name: "@rovara-code/a", version: "0.1.0-ci.abc", dependencies: { "@rovara-code/b": "0.1.0-ci.abc", zod: "4.6.6" }, devDependencies: { vitest: "5.0.3", "@rovara-code/c": "0.1.0-ci.abc" } });
  });

  it("the browser-safe entry of @rovara-code/contracts reaches no Node built-in", () => {
    const contracts = workspaces.find((workspace) => workspace.manifest.name === "@rovara-code/contracts")!;
    expect(contracts.manifest.exports).toMatchObject({ "./browser": "./dist/browser.js" });
    const checker = browserChecker(join(root, contracts.directory, "src"));
    expect(checker.reason("browser.ts")).toBeNull();
    // and the checker does see a Node import: the root entry is not browser-safe.
    expect(checker.reason("index.ts")).not.toBeNull();
  });
});

describe("the entry checker itself", () => {
  // The fixture text is built from pieces so that this file does not itself contain an import-like use of a name that is not an entry.
  const CORE = "@rovara-code/core";
  it("reads import-like positions only", () => {
    const text = [
      `import { a } from "${CORE}/services";`,
      `export * from "@rovara-code/aws";`,
      `const m = await import("${CORE}/dist/x.js");`,
      `vi.mock("@rovara-code/testing/ports/queue-conformance", () => ({}));`,
      `const s = "${CORE}/not-an-import";`,
    ].join("\n");
    expect(specifiersOf(text)).toEqual([`${CORE}/services`, "@rovara-code/aws", `${CORE}/dist/x.js`, "@rovara-code/testing/ports/queue-conformance"]);
  });

  it("refuses a name that is not an entry and accepts one that is", () => {
    const entries = entriesByPackage.get(CORE)!;
    expect(entries.has(`${CORE}/dist/x.js`)).toBe(false);
    expect(entries.has(`${CORE}/aws/broker`)).toBe(false);
    expect(entries.has(`${CORE}/merge-tracking`)).toBe(true);
    expect(entries.has(CORE)).toBe(true);
    expect(workspaceOf(`${CORE}/x`)).toBe(CORE);
    expect(workspaceOf(`${CORE}x`)).toBeNull();
  });
});
