import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WEB_API_QUALIFICATION_APP_MANIFEST_PREFIX, WEB_API_QUALIFICATION_APP_TREE_DIGEST, webApiQualificationAppTreeDigest } from "../../packages/contracts/src/index.js";
import { installedWebApiQualificationAppRoot, stageWebApiQualificationApp, verifyWebApiQualificationApp } from "../../packages/verifier/src/host/web-api-qualification-app.js";

const repoRoot = join(import.meta.dirname, "../..");
const sourceApp = join(repoRoot, "tests/fixtures/e2e-web-api-app");
const assetApp = installedWebApiQualificationAppRoot();
const dirs: string[] = [];
async function temp() { const dir = realpathSync(await mkdtemp(join(tmpdir(), "qualification-app-")));  dirs.push(dir); return dir; }
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function tree(root: string): Promise<[string, string][]> {
  const rows: [string, string][] = [];
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) rows.push([join(entry.parentPath, entry.name).slice(root.length + 1), createHash("sha256").update(await readFile(join(entry.parentPath, entry.name))).digest("hex")]);
  }
  return rows.sort(([a], [b]) => a.localeCompare(b));
}

describe("the installed qualification app", () => {
  it("is shipped under the verifier assets, which the installed-runtime manifest already hashes", () => {
    expect(assetApp.endsWith("packages/verifier/assets/qualification-app")).toBe(true);
    expect(WEB_API_QUALIFICATION_APP_MANIFEST_PREFIX).toBe("packages/verifier/assets/qualification-app/");
  });

  it("is byte-identical to the source fixture, defects included, and matches the pinned tree digest", async () => {
    const shipped = await tree(assetApp);
    expect(shipped).toEqual(await tree(sourceApp));
    expect(shipped.some(([path]) => path.startsWith("defects/"))).toBe(true);
    expect(webApiQualificationAppTreeDigest(shipped.map(([path, sha256]) => ({ path, sha256 })))).toBe(WEB_API_QUALIFICATION_APP_TREE_DIGEST);
    expect((await verifyWebApiQualificationApp(assetApp)).treeDigest).toBe(WEB_API_QUALIFICATION_APP_TREE_DIGEST);
  });

  it("refuses an app tree that is not the pinned one: changed, added, removed or linked files", async () => {
    const copy = join(await temp(), "app");
    await cp(assetApp, copy, { recursive: true });
    await writeFile(join(copy, "server.mjs"), `${await readFile(join(copy, "server.mjs"), "utf8")}\n// changed`);
    await expect(verifyWebApiQualificationApp(copy)).rejects.toThrow("qualification-app-digest-mismatch");
    const added = join(await temp(), "app");
    await cp(assetApp, added, { recursive: true });
    await writeFile(join(added, "extra.js"), "export {};\n");
    await expect(verifyWebApiQualificationApp(added)).rejects.toThrow("qualification-app-digest-mismatch");
    const removed = join(await temp(), "app");
    await cp(assetApp, removed, { recursive: true });
    await rm(join(removed, "defects/extra-order.json"));
    await expect(verifyWebApiQualificationApp(removed)).rejects.toThrow("qualification-app-digest-mismatch");
    await expect(verifyWebApiQualificationApp(join(await temp(), "absent"))).rejects.toThrow();
  });

  it("stages a verified copy for the Docker host and never stages a tampered one", async () => {
    const destination = join(await temp(), "candidate");
    await stageWebApiQualificationApp(assetApp, destination);
    expect(await tree(destination)).toEqual(await tree(assetApp));
    expect((await stat(join(destination, "server.mjs"))).mode & 0o444).toBe(0o444);
    const copy = join(await temp(), "app");
    await cp(assetApp, copy, { recursive: true });
    await writeFile(join(copy, "package.json"), "{}");
    const refused = join(await temp(), "candidate");
    await expect(stageWebApiQualificationApp(copy, refused)).rejects.toThrow("qualification-app-digest-mismatch");
    await expect(stat(refused)).rejects.toThrow();
  });

  it("digests the tree independently of the order the files are listed in", () => {
    const files = [{ path: "b.txt", sha256: "1".repeat(64) }, { path: "a/c.txt", sha256: "2".repeat(64) }];
    expect(webApiQualificationAppTreeDigest(files)).toBe(webApiQualificationAppTreeDigest([...files].reverse()));
    expect(webApiQualificationAppTreeDigest(files)).not.toBe(webApiQualificationAppTreeDigest([files[0]!, { ...files[1]!, path: "a/d.txt" }]));
  });
});
