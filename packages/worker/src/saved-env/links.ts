// Setup and test health SH22/SH23 (review A1, A3): which symbolic links a saved environment may hold.
//
// A link in an image is whatever the Prove run (or the dependency installers it ran) made. It is copied as a link and never followed, but a task later OPENS paths through the workspace, so a link must
// point at something that is part of the seed or at a known interpreter, and the check must be made on the real tree, not on the text of the target:
//   - the link's target is walked component by component from the link's own folder. A `..` that leaves the root, or an INTERMEDIATE component that is itself a symbolic link, is refused (`a -> .` with
//     `x -> a/a/a/a/../../../../..` reads as inside the root lexically and is not). The LAST component may be a link (`python -> python3 -> python3.12` in a virtual environment); that link is checked on its
//     own turn;
//   - an ABSOLUTE target is refused, with two exceptions that apply at build only to what the build can prove:
//       1. a target that lies inside the workspace mount (where the sandbox had the workspace) is rewritten to the equivalent RELATIVE link (`rewriteWorkspaceLinks`), then checked as a relative link;
//       2. a Python virtual environment's interpreter link, decided by the ONE rule every preparation uses (`../workspace-links.ts`, `isVenvInterpreterLink`): a link in a `bin` folder beside a `pyvenv.cfg`,
//          named python / python3 / python3.N, pointing at an interpreter in the base image's folders (`/usr/bin`, `/usr/local/bin`) or in uv's managed-Python roots;
//   - NO link at all under a `.git` folder (a link there can redirect history).
// Nothing here follows a link, runs a command or reads a file's content.
import { lstat, readlink, readdir, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { defaultVenvLinkPolicy, isVenvInterpreterLink, type VenvLinkPolicy } from "../workspace-links.js";

/** The shared virtual environment rule (`../workspace-links.ts`: interpreter folders and uv's managed-Python roots) plus, at build, where the sandbox had the workspace mounted. */
export type LinkPolicy = VenvLinkPolicy & {
  /** Where the sandbox had the workspace mounted: an absolute target inside it is a relative link in disguise. Absent: no rewriting. */
  workspaceRoot?: string;
};

/** The worker's default policy (`defaultVenvLinkPolicy`): /usr/bin, /usr/local/bin and uv's managed Pythons. */
export const DEFAULT_LINK_POLICY: LinkPolicy = defaultVenvLinkPolicy();

export type LinkVerdict = { ok: true; rewriteTo?: string } | { ok: false };

const exists = (file: string) => lstat(file).then((info) => info, () => undefined);

/**
 * Whether the link at `relative` (POSIX, inside `root`) with the text `target` is acceptable. The caller read `target` from the link and never follows it. For a link that is an absolute target inside the
 * workspace mount, the verdict carries `rewriteTo`, the relative target to write instead (build only: pass `policy.workspaceRoot`).
 */
export async function inspectLink(root: string, relative: string, target: string, policy: LinkPolicy = DEFAULT_LINK_POLICY): Promise<LinkVerdict> {
  const parts = relative.split("/");
  if (parts.includes(".git")) return { ok: false };
  if (target === "" || target.length > 4_096 || target.includes("\\") || target.includes("\u0000")) return { ok: false };
  let rewriteTo: string | undefined;
  let relativeTarget = target;
  if (path.posix.isAbsolute(target)) {
    const mount = policy.workspaceRoot;
    const normalized = path.posix.normalize(target);
    if (mount !== undefined && (normalized === mount || normalized.startsWith(mount.endsWith("/") ? mount : `${mount}/`))) {
      relativeTarget = path.posix.relative(path.posix.dirname(path.posix.join(mount, relative)), normalized) || ".";
      rewriteTo = relativeTarget;
    } else {
      return (await isVenvInterpreterLink(path.join(root, relative), policy)) ? { ok: true } : { ok: false };
    }
  }
  // Walk the target from the link's own folder, on the real tree. Below a component that does not exist (or is not a folder) nothing can be a link, but the rest of the path is still normalised: a broken link
  // whose target climbs out of the root after the missing part is refused (`missing/../../..`).
  let current = path.posix.dirname(relative);
  if (current === ".") current = "";
  const components = relativeTarget.split("/").filter((component) => component !== "" && component !== ".");
  let real = true;
  /** The first component that was not there (or not a folder): below it nothing is looked up; once the walk climbs above it, looking up starts again. */
  let missingPath = "";
  for (let index = 0; index < components.length; index += 1) {
    const component = components[index]!;
    const last = index === components.length - 1;
    if (component === "..") {
      if (current === "") return { ok: false };
      current = path.posix.dirname(current) === "." ? "" : path.posix.dirname(current);
      if (!real && current !== missingPath && !current.startsWith(`${missingPath}/`)) real = true;
      continue;
    }
    const next = current === "" ? component : `${current}/${component}`;
    if (real) {
      const info = await exists(path.join(root, next));
      if (info === undefined || (!info.isDirectory() && !info.isSymbolicLink() && !last)) { real = false; missingPath = next; }
      else if (info.isSymbolicLink() && !last) return { ok: false };
    }
    current = next;
  }
  return rewriteTo === undefined ? { ok: true } : { ok: true, rewriteTo };
}

/**
 * Rewrites, in place, every link of the staged tree whose target is an absolute path inside the workspace mount to the equivalent relative link (so the seed works wherever it is later placed). Links in `skip`
 * (tracked links: committed content) are left alone. A link that cannot be rewritten safely is left as it is for the check to refuse. Returns how many were rewritten.
 */
export async function rewriteWorkspaceLinks(root: string, policy: LinkPolicy, skip: ReadonlySet<string>): Promise<number> {
  if (policy.workspaceRoot === undefined) return 0;
  let rewritten = 0;
  const stack = [""];
  while (stack.length > 0) {
    const directory = stack.pop()!;
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      const relative = directory === "" ? entry.name : `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        if (skip.has(relative)) continue;
        const target = await readlink(path.join(root, relative));
        const verdict = await inspectLink(root, relative, target, policy);
        if (verdict.ok && verdict.rewriteTo !== undefined) {
          await rm(path.join(root, relative));
          await symlink(verdict.rewriteTo, path.join(root, relative));
          rewritten += 1;
        }
      } else if (entry.isDirectory()) stack.push(relative);
    }
  }
  return rewritten;
}
