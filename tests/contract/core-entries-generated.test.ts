// The generated entries of `@rovara-code/core` (phase 2b, step 6; docs/modular/move-map.md): `src/host.ts` (`@rovara-code/core/host`) and `src/plugin-kit.ts`
// (`@rovara-code/core/plugin-kit`). scripts/generate-core-entries.ts writes both from the imports of `local/` and of the Slack and GitHub plug-ins. This test fails when a file
// differs from what the script writes now, which is the same as failing when `local/` imports a name `host.ts` does not have, or when `host.ts` exports a name nobody imports.
// To accept a change on purpose: `node scripts/generate-core-entries.ts`.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SOURCE, generateEntries } from "../../scripts/generate-core-entries.js";

const read = (file: string): string => readFileSync(join(DEFAULT_SOURCE, file), "utf8");
/** The names a generated entry exports, in file order (`type ` removed). */
const exportedNames = (text: string): string[] => [...text.matchAll(/export \{([^}]*)\} from/gu)].flatMap((match) => match[1]!.split(",").map((name) => name.trim().replace(/^type /u, "")).filter((name) => name !== ""));
const manifest = JSON.parse(readFileSync("packages/core/package.json", "utf8")) as { exports: Record<string, string> };

describe("the generated core entries are up to date", () => {
  const generated = generateEntries();

  it("host.ts is what the script writes from local's imports", () => {
    expect(read("host.ts"), "run: node scripts/generate-core-entries.ts").toBe(generated.host);
  });

  it("plugin-kit.ts is what the script writes from the plug-ins' imports", () => {
    expect(read("plugin-kit.ts"), "run: node scripts/generate-core-entries.ts").toBe(generated.pluginKit);
  });

  it("is written out: named exports only, no star export, one name once", () => {
    for (const text of [generated.host, generated.pluginKit]) {
      expect(text).not.toMatch(/export\s*\*/u);
      const names = exportedNames(text);
      expect(new Set(names).size, "a name appears twice").toBe(names.length);
    }
    expect(generated.hostNames).toBeGreaterThan(400);
    expect(generated.pluginKitNames).toBeGreaterThanOrEqual(10);
  });

  it("the entries are in core's exports", () => {
    expect(manifest.exports["./host"]).toBe("./dist/host.js");
    expect(manifest.exports["./plugin-kit"]).toBe("./dist/plugin-kit.js");
  });
});

describe("the generator", () => {
  const folders: string[] = [];
  afterEach(() => {
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  function tree(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "core-entries-"));
    folders.push(root);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return root;
  }

  it("exports exactly the names local imports from outside local/, as values or types", () => {
    const root = tree({
      "a.ts": "export const one = 1; export type Two = number; export const unused = 3;",
      "b/c.ts": "export const three = 3;",
      "local/x.ts": 'import { one, type Two } from "../a.js"; import type { Two as Again } from "../a.js"; import { three } from "../b/c.js"; import { inside } from "./y.js"; void [one, three, inside];',
      "local/y.ts": "export const inside = 1;",
    });
    const { host, hostNames } = generateEntries(root);
    expect(hostNames).toBe(3);
    expect(host).toContain('export { type Two, one } from "./a.js";');
    expect(host).toContain('export { three } from "./b/c.js";');
    expect(exportedNames(host)).toEqual(["Two", "one", "three"]);
  });

  it("drops a name that nobody imports any more and takes a new one", () => {
    const files = { "a.ts": "export const one = 1; export const two = 2;", "local/x.ts": 'import { one } from "../a.js"; void one;' };
    const first = generateEntries(tree(files)).host;
    const second = generateEntries(tree({ ...files, "local/x.ts": 'import { two } from "../a.js"; void two;' })).host;
    expect(exportedNames(first)).toEqual(["one"]);
    expect(exportedNames(second)).toEqual(["two"]);
  });

  it("names one file for a name that a barrel re-exports, and stops on two different things under one name", () => {
    const base = { "m.ts": "export const same = 1;", "index.ts": 'export { same } from "./m.js";', "local/x.ts": 'import { same } from "../index.js"; void same;', "local/y.ts": 'import { same } from "../m.js"; void same;' };
    expect(generateEntries(tree(base)).host).toContain('export { same } from "./m.js";');
    const clash = { ...base, "index.ts": "export const same = 2;" };
    expect(() => generateEntries(tree(clash))).toThrow(/not one re-exporting the other/u);
  });

  it("keeps a name that local already takes through ./host.js, and refuses one the entry does not have", () => {
    const files = { "a.ts": "export const one = 1;", "local/x.ts": 'import { one } from "../a.js"; void one;' };
    const root = tree(files);
    writeFileSync(join(root, "host.ts"), generateEntries(root).host);
    writeFileSync(join(root, "local/x.ts"), 'import { one } from "../host.js"; void one;');
    expect(generateEntries(root).host).toContain('export { one } from "./a.js";');
    writeFileSync(join(root, "local/x.ts"), 'import { missing } from "../host.js"; void missing;');
    expect(() => generateEntries(root)).toThrow(/does not export it/u);
  });

  it("builds the plug-in kit from the imports out of the plug-in folders, minus what moves with the plug-in", () => {
    const root = tree({
      "plugins/module-support.ts": "export const readPluginSettings = 1; export const secretReader = 2;",
      "github-job-log.ts": "export const logTail = 1;",
      "plugins/code-host/github/plugin.ts": 'import { readPluginSettings } from "../../module-support.js"; import { logTail } from "../../../github-job-log.js"; import { own } from "./own.js"; void [readPluginSettings, logTail, own];',
      "plugins/code-host/github/own.ts": "export const own = 1;",
    });
    const { pluginKit } = generateEntries(root);
    expect(exportedNames(pluginKit)).toEqual(["readPluginSettings", "secretReader"]);
  });
});
