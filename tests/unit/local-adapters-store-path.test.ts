// TE-D10a: where a configured SQLite store may live. A relative path is kept under the state folder (not the folder the process runs
// in), and a path inside a git work tree is refused, whatever GIT_* variables the process inherited and through symbolic links.
// Linux-safe: only git and Node are used.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PluginRegistryError } from "@agentx/contracts";
import { createAdapterRegistry, loadAdapters, parsePluginConfig, type ModuleImporter } from "../../packages/broker/src/ports/adapter-registry.js";
import { databasePath, STORE_PATH_IN_REPOSITORY_SENTENCE } from "../../packages/local-adapters/src/settings.js";
import * as queueModule from "../../packages/local-adapters/src/queue-plugin.js";
import * as storageModule from "../../packages/local-adapters/src/storage-plugin.js";
import type { SqliteDocumentStore, SqliteQueueService } from "../../packages/local-adapters/src/index.js";

const modules: Record<string, unknown> = { "@agentx/local-adapters/storage": storageModule, "@agentx/local-adapters/queue": queueModule };
const importer: ModuleImporter = async (specifier) => {
  if (!(specifier in modules)) throw new Error("no such module");
  return modules[specifier];
};

const folders: string[] = [];
const savedEnvironment = { ...process.env };
let root = "";
let stateDirectory = "";

/** A real `git init`, with the environment cleaned so the test does not depend on the machine's git settings. */
function gitInit(folder: string): void {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "no-such-git-config") };
  execFileSync("git", ["init", "--quiet", folder], { env, stdio: "ignore" });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "store-path-"));
  folders.push(root);
  stateDirectory = join(root, "home", ".rovara");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
});

afterEach(async () => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnvironment)) delete process.env[key];
  Object.assign(process.env, savedEnvironment);
  for (const file of cwdFiles.splice(0)) await rm(file, { force: true });
  for (const folder of folders.splice(0)) {
    await chmod(join(folder, "locked"), 0o700).catch(() => undefined);
    await rm(folder, { recursive: true, force: true });
  }
});

const SQLITE_FILE = Buffer.concat([Buffer.from("SQLite format 3\u0000", "latin1"), Buffer.alloc(84)]);
const cwdFiles: string[] = [];
/** A file in the folder the process runs in (where the old rule put a relative path), and the place the new rule gives the same value. Removed after the test. */
async function oldDatabase(content: Buffer | string): Promise<{ value: string; old: string; fresh: string }> {
  const value = `.te-d10a-old-${randomBytes(6).toString("hex")}.db`;
  const old = resolve(value);
  cwdFiles.push(old);
  await writeFile(old, content);
  return { value, old, fresh: join(stateDirectory, value) };
}

const refusedAsInsideRepository = (call: () => unknown): void => {
  let caught: unknown;
  try {
    call();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PluginRegistryError);
  expect((caught as PluginRegistryError).code).toBe("create_failed");
  expect((caught as PluginRegistryError).message).toContain(STORE_PATH_IN_REPOSITORY_SENTENCE);
};

describe("a store path inside a git work tree is refused", () => {

  it("follows symbolic links: a link into the tree does not escape, a link out of the tree does not count", async () => {
    const repository = join(root, "checkout");
    gitInit(repository);
    await mkdir(join(repository, "data"));
    const outside = join(root, "outside");
    await mkdir(outside);
    // A link outside the tree that points into it.
    await symlink(join(repository, "data"), join(root, "into-tree"));
    refusedAsInsideRepository(() => databasePath({ path: join(root, "into-tree", "state.db") }, { stateDirectory }));
    // A link inside the state folder that points into it (a relative path goes through it).
    await symlink(join(repository, "data"), join(stateDirectory, "linked"));
    refusedAsInsideRepository(() => databasePath({ path: "linked/state.db" }, { stateDirectory }));
    // The final name is itself a link into the tree, and the file is not there yet: where it leads cannot be known, so it is refused.
    await symlink(join(repository, "data", "later.db"), join(root, "dangling.db"));
    expect(() => databasePath({ path: join(root, "dangling.db") }, { stateDirectory })).toThrow(/could not be checked/);
    // A link inside the tree that points out of it is outside the tree.
    await symlink(outside, join(repository, "leaves"));
    expect(databasePath({ path: join(repository, "leaves", "state.db") }, { stateDirectory })).toBe(join(repository, "leaves", "state.db"));
  });

  it("fails closed on a folder it cannot read", async (context) => {
    if (process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0)) return context.skip();
    const locked = join(root, "locked");
    await mkdir(join(locked, "inner"), { recursive: true });
    await chmod(locked, 0o000);
    let caught: unknown;
    try {
      databasePath({ path: join(locked, "inner", "state.db") }, { stateDirectory });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("could not be checked");
  });
});

describe("the SQLite plug-ins", () => {
  async function load(point: "storage" | "queue", settings: Record<string, unknown>) {
    const registry = createAdapterRegistry();
    await loadAdapters(parsePluginConfig({ version: 1, plugins: [{ point, name: "sqlite", module: `@agentx/local-adapters/${point}`, settings }] }), { registry, importModule: importer, stateDirectory });
    return registry;
  }

  // Each plug-in on its own, with HOME pointed at a scratch folder: a plug-in that ignored the state folder would fall back to HOME/.rovara and leave the file there.
  for (const point of ["storage", "queue"] as const) {
    it(`${point}: opens a relative path under context.stateDirectory, not under HOME/.rovara or the working folder`, async () => {
      const home = join(root, "scratch-home");
      await mkdir(home, { recursive: true });
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      const registry = await load(point, point === "storage" ? { path: "plugin-only.db", sweepIntervalMs: 0 } : { path: "plugin-only.db" });
      await (registry.require(point) as SqliteDocumentStore | SqliteQueueService).close();
      expect((await readFile(join(stateDirectory, "plugin-only.db"))).length).toBeGreaterThan(0);
      await expect(readFile(join(home, ".rovara", "plugin-only.db"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(resolve("plugin-only.db"))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it(`${point}: refuses, through the registry, an old SQLite file where the old rule put the path, until the new file exists`, async () => {
      const { value, old, fresh } = await oldDatabase(SQLITE_FILE);
      await expect(load(point, { path: value })).rejects.toMatchObject({ code: "create_failed", message: expect.stringContaining(`Rovara's database moved: stop Rovara, then move ${old}`) as string });
      await expect(readFile(fresh)).rejects.toMatchObject({ code: "ENOENT" });
    });
  }
});

describe("the documented examples", () => {
  const files = ["docs/ports.md", "docs/local.md", "packages/local-adapters/src/storage-plugin.ts", "packages/local-adapters/src/queue-plugin.ts"];
  it("show no relative path that puts the database in the folder you are in", async () => {
    for (const file of files) {
      const text = await readFile(resolve(import.meta.dirname, "../..", file), "utf8");
      // A "path" setting that starts with .rovara/ or ./.rovara/ is a folder in the working directory, not the state folder.
      expect(text, file).not.toMatch(/"path"\s*:\s*"(?:\.\/)?\.rovara\//);
      expect(text, file).not.toMatch(/"path"\s*:\s*"(?:\.\.\/)+/);
    }
  });
  it("say that a relative path is kept in the state folder and that a repository is refused", async () => {
    const ports = await readFile(resolve(import.meta.dirname, "../../docs/ports.md"), "utf8");
    expect(ports).toMatch(/relative `path`[^\n]*state folder/i);
    expect(ports).toMatch(/inside a git (?:work tree|repository)/i);
  });
});
