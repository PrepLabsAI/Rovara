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
  it("accepts a link inside the tree, a dangling one, and one to a link as its LAST step (python -> python3 -> python3.12)", async () => {
    const root = await scratch();
    await mkdir(join(root, "svc", "dir"), { recursive: true });
    await writeFile(join(root, "svc", "dir", "f"), "x");
    await symlink("dir/f", join(root, "svc", "alias"));
    expect(await ok(root, "svc/l1", "dir/f")).toBe(true);
    expect(await ok(root, "svc/dir/up", "../dir/f")).toBe(true);
    expect(await ok(root, "svc/dangling", "not/there")).toBe(true);
    expect(await ok(root, "svc/l2", "alias")).toBe(true);
    expect(await ok(root, "svc/l3", ".")).toBe(true);
  });

  it("refuses a link that leaves the root", async () => {
    const root = await scratch();
    expect(await ok(root, "svc/a", "../../b")).toBe(false);
    expect(await ok(root, "a", "../b")).toBe(false);
    expect(await ok(root, "svc/a", "")).toBe(false);
    expect(await ok(root, "svc/a", "a\\b")).toBe(false);
  });

  it("refuses a path that goes THROUGH another link, however the text reads: a -> . and x -> a/a/a/a/../../../../..", async () => {
    const root = await scratch();
    await mkdir(join(root, "n"), { recursive: true });
    await symlink(".", join(root, "n", "a"));
    expect(await ok(root, "n/x", "a/a/a/a/../../../../..")).toBe(false);
    expect(await ok(root, "n/y", "a/f")).toBe(false);
    // lexically this is inside the tree; on the disk `a/..` is `n` ... and the walk does not pretend otherwise
    expect(await ok(root, "n/z", "a/../..")).toBe(false);
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

  it("refuses any link under a .git folder", async () => {
    const root = await scratch();
    expect(await ok(root, "svc/.git/refs/x", "../HEAD")).toBe(false);
    expect(await ok(root, "svc/node_modules/pkg/.git/x", "y")).toBe(false);
  });
});

describe("absolute links", () => {
  const venv = async (root: string, folder = "svc/.venv") => { await mkdir(join(root, folder, "bin"), { recursive: true }); await writeFile(join(root, folder, "pyvenv.cfg"), "home = /usr/bin\n"); return `${folder}/bin`; };

  it("refuses an absolute link by default", async () => {
    const root = await scratch();
    expect(await ok(root, "svc/a", "/etc/passwd")).toBe(false);
    expect(await ok(root, "svc/a", "/usr/bin/python3")).toBe(false);
  });

  it("accepts a virtual environment's interpreter: in bin/ beside a pyvenv.cfg, named python, python3 or python3.N, naming python3[.N] in an allowed interpreter folder", async () => {
    const root = await scratch();
    const bin = await venv(root);
    for (const name of ["python", "python3", "python3.12"]) {
      for (const target of ["/usr/bin/python3", "/usr/bin/python3.12", "/usr/local/bin/python3.11"]) expect(await ok(root, `${bin}/${name}`, target), `${name} -> ${target}`).toBe(true);
    }
  });

  it("accepts the links of a Linux Python 3.14 venv (lib64 -> lib at the root, the pi alias beside python), built here as synthetic links so the test needs no Linux (CI: Ubuntu 26.04)", async () => {
    const root = await scratch();
    const bin = await venv(root);
    const pi = "\u{1D70B}thon";
    await mkdir(join(root, "svc", ".venv", "lib"), { recursive: true });
    expect(await ok(root, `${bin}/python`, "/usr/bin/python3.14")).toBe(true);
    expect(await ok(root, `${bin}/python3`, "python")).toBe(true);
    expect(await ok(root, `${bin}/python3.14`, "python")).toBe(true);
    expect(await ok(root, `${bin}/${pi}`, "python")).toBe(true);
    expect(await ok(root, "svc/.venv/lib64", "lib")).toBe(true);
    // still not a way out: a lib64 that climbs out of the tree, and the alias pointing at a program that is not an interpreter, are refused
    expect(await ok(root, "svc/.venv/lib64", "../../../lib")).toBe(false);
    expect(await ok(root, `${bin}/${pi}`, "/usr/bin/sh")).toBe(false);
  });

  it("refuses it when any of those is not so: another name, another folder, no pyvenv.cfg, a path with .. or a double slash, an interpreter that is not python3[.N], a deeper folder", async () => {
    const root = await scratch();
    const bin = await venv(root);
    expect(await ok(root, `${bin}/sh`, "/usr/bin/python3")).toBe(false);
    expect(await ok(root, `${bin}/python`, "/usr/bin/sh")).toBe(false);
    expect(await ok(root, `${bin}/python`, "/usr/bin/python2")).toBe(false);
    expect(await ok(root, `${bin}/python`, "/etc/python3")).toBe(false);
    expect(await ok(root, `${bin}/python`, "/usr/bin/../../etc/python3")).toBe(false);
    expect(await ok(root, `${bin}/python`, "/usr//bin/python3")).toBe(false);
    expect(await ok(root, `${bin}/python`, "/usr/bin/evil/python3")).toBe(false);
    expect(await ok(root, `svc/.venv/python`, "/usr/bin/python3")).toBe(false);
    await mkdir(join(root, "svc", "plain", "bin"), { recursive: true });
    expect(await ok(root, "svc/plain/bin/python", "/usr/bin/python3")).toBe(false);
    // a pyvenv.cfg that is a link or a folder does not count
    await mkdir(join(root, "svc", "odd", "bin"), { recursive: true });
    await symlink("/etc/hostname", join(root, "svc", "odd", "pyvenv.cfg"));
    expect(await ok(root, "svc/odd/bin/python", "/usr/bin/python3")).toBe(false);
  });

  it("uv's managed-Python roots allow <root>/<folder>/bin/python3[.N] and only that", async () => {
    const root = await scratch();
    const bin = await venv(root);
    const policy: LinkPolicy = { interpreterDirectories: [], managedPythonRoots: ["/home/node/.local/share/uv/python"] };
    expect(await ok(root, `${bin}/python`, "/home/node/.local/share/uv/python/cpython-3.12.4-linux-aarch64-gnu/bin/python3.12", policy)).toBe(true);
    expect(await ok(root, `${bin}/python3`, "/home/node/.local/share/uv/python/cpython-3.12.4-linux-aarch64-gnu/lib/python3.12", policy)).toBe(false);
    expect(await ok(root, `${bin}/python3.9`, "/home/node/.local/share/uv/python-evil/x/bin/python3", policy)).toBe(false);
    expect(await ok(root, `${bin}/python3.10`, "/home/node/.local/share/uv/python/a/b/bin/python3", policy)).toBe(false);
    expect(await ok(root, `${bin}/python3.11`, "/usr/bin/python3", policy)).toBe(false);
  });

  it("the default policy is the shared worker one (workspace-links.ts): /usr/bin and /usr/local/bin, and uv's managed Pythons", () => {
    expect(DEFAULT_LINK_POLICY.interpreterDirectories).toEqual(["/usr/bin", "/usr/local/bin"]);
    expect(DEFAULT_LINK_POLICY.managedPythonRoots.every((entry) => entry.endsWith("/uv/python"))).toBe(true);
  });

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
