// SH22/SH23 review A1 and A3: which links a saved environment may hold, decided on the real tree.
import { mkdir, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LINK_POLICY, inspectLink, rewriteWorkspaceLinks, type LinkPolicy } from "../../packages/worker/src/saved-env/links.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const scratch = async (): Promise<string> => { const dir = await mkdtemp(join(tmpdir(), "links-")); roots.push(dir); return dir; };
/** The link is made on the disk first (the shared venv rule reads the link itself), then judged. */
const ok = async (root: string, relative: string, target: string, policy?: LinkPolicy) => {
  const full = join(root, relative);
  await mkdir(join(full, ".."), { recursive: true });
  await rm(full, { force: true });
  await symlink(target === "" ? "x" : target, full);
  return (await inspectLink(root, relative, target, policy)).ok;
};

describe("relative links, walked on the real tree", () => {

  it("refuses a link that leaves the root", async () => {
    const root = await scratch();
    expect(await ok(root, "svc/a", "../../b")).toBe(false);
    expect(await ok(root, "a", "../b")).toBe(false);
    expect(await ok(root, "svc/a", "")).toBe(false);
    expect(await ok(root, "svc/a", "a\\b")).toBe(false);
  });

  it("a broken link is walked to the end: a missing part followed by enough .. to leave the root is refused; climbing back out of the missing part makes later components real again", async () => {
    const root = await scratch();
    await mkdir(join(root, "svc"), { recursive: true });
    await symlink(".", join(root, "svc", "dirlink"));
    expect(await ok(root, "svc/l1", "missing/../../../x")).toBe(false);
    expect(await ok(root, "svc/l2", "missing/x/y")).toBe(true);
    expect(await ok(root, "svc/l3", "missing/../b")).toBe(true);
    expect(await ok(root, "svc/l4", "missing/../dirlink/f")).toBe(false);
    expect(await ok(root, "svc/l5", "a/b/c/../../../../..")).toBe(false);
    expect(await ok(root, "svc/l6", "a/b/c/../../..")).toBe(true);
  });

});

describe("absolute links", () => {

  it("a link into the workspace mount is a relative link in disguise: the verdict carries the relative target, and a target above the seed is refused", async () => {
    const root = await scratch();
    const policy: LinkPolicy = { ...DEFAULT_LINK_POLICY, workspaceRoot: "/mnt/ws" };
    expect(await inspectLink(root, "svc/node_modules/alias", "/mnt/ws/svc/node_modules/dep/index.js", policy)).toEqual({ ok: true, rewriteTo: "dep/index.js" });
    expect(await inspectLink(root, "svc/node_modules/sib", "/mnt/ws/other/x", policy)).toEqual({ ok: true, rewriteTo: "../../other/x" });
    expect(await inspectLink(root, "svc/a", "/mnt/wsx/svc/b", policy)).toEqual({ ok: false });
    expect(await inspectLink(root, "svc/a", "/mnt/other/b", policy)).toEqual({ ok: false });
  });

  it("rewriteWorkspaceLinks rewrites untracked links and leaves tracked ones alone", async () => {
    const root = await scratch();
    await mkdir(join(root, "svc", "node_modules", "dep"), { recursive: true });
    await writeFile(join(root, "svc", "node_modules", "dep", "index.js"), "x");
    await symlink("/mnt/ws/svc/node_modules/dep/index.js", join(root, "svc", "node_modules", "alias"));
    await symlink("/mnt/ws/svc/node_modules/dep/index.js", join(root, "svc", "tracked-link"));
    const count = await rewriteWorkspaceLinks(root, { ...DEFAULT_LINK_POLICY, workspaceRoot: "/mnt/ws" }, new Set(["svc/tracked-link"]));
    expect(count).toBe(1);
    expect(await readlink(join(root, "svc", "node_modules", "alias"))).toBe("dep/index.js");
    expect(await readlink(join(root, "svc", "tracked-link"))).toBe("/mnt/ws/svc/node_modules/dep/index.js");
  });
});
