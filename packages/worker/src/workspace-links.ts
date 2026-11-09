import { lstat, readlink } from "node:fs/promises";
import { homedir } from "node:os";
import { posix } from "node:path";

/**
 * The one symlink a prepared workspace may hold that points outside it: a Python virtual environment's interpreter link (`.venv/bin/python3 -> /usr/bin/python3`).
 * `python -m venv`, `uv venv` and `uv sync`, virtualenv, poetry in-project, pipenv in-project and tox all make these.
 *
 * Everything is decided from the link's text and its place in the tree. The target is never followed, and need not exist for this process: the task sandbox's
 * filesystem can differ from the worker's. Any other link that leaves the workspace, or does not resolve, stays refused by the caller as before.
 * (feat/saved-env-build's saved-env/links.ts `isVenvInterpreterLink` is to switch to this module.)
 */

/**
 * python, pythonw, python3 and python3.N (N one or two digits, `t` for a free-threaded build), and `\u{1D70B}thon` (a mathematical italic pi before "thon"): Python 3.14's `python -m venv` makes that alias beside
 * `python`, and Ubuntu 26.04 ships 3.14, so a real venv holds it (CI run 41544375128 failed on exactly that link).
 */
const LINK_NAME = /^(?:python(?:w|3(?:\.\d{1,2}t?)?)?|\u{1D70B}thon)$/u;
/** A target is python, python3, python3.N or the pi alias only. */
const TARGET_NAME = /^(?:python(?:3(?:\.\d{1,2}t?)?)?|\u{1D70B}thon)$/u;
/** One folder of uv's managed Pythons, for example cpython-3.12.3-linux-aarch64-gnu. */
const MANAGED_FOLDER = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const MAX_CHAIN = 8;

export type VenvLinkPolicy = Readonly<{
  /** Folders (absolute) an interpreter link may point into, exactly: /usr/bin/python3 is allowed, /usr/bin/x/python3 is not. */
  interpreterDirectories: readonly string[];
  /** uv's managed-Python roots (absolute). A target may be `<root>/<folder>/bin/python3.N`. */
  managedPythonRoots: readonly string[];
}>;

function absolutePaths(values: readonly string[]): string[] {
  return values
    .filter((value) => posix.isAbsolute(value) && !value.includes("\0"))
    .map((value) => posix.normalize(value).replace(/(?<=.)\/+$/, ""));
}

/**
 * The default policy: /usr/bin and /usr/local/bin, and uv's managed Pythons under the worker user's home (the sandbox runs as the same user in the base image,
 * so its home is the worker's) and under `UV_PYTHON_INSTALL_DIR` when that is set. Configurable: AGENTX_VENV_INTERPRETER_DIRS and AGENTX_VENV_MANAGED_PYTHON_ROOTS,
 * each a colon-separated list of absolute folders, replace the default of their own part.
 */
export function defaultVenvLinkPolicy(env: Readonly<Record<string, string | undefined>> = process.env, home: string = safeHome()): VenvLinkPolicy {
  const list = (value: string | undefined): string[] | undefined => value === undefined || value.trim() === "" ? undefined : absolutePaths(value.split(":"));
  const dataHome = env.XDG_DATA_HOME !== undefined && posix.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : posix.join(home, ".local", "share");
  return {
    interpreterDirectories: list(env.AGENTX_VENV_INTERPRETER_DIRS) ?? ["/usr/bin", "/usr/local/bin"],
    managedPythonRoots: list(env.AGENTX_VENV_MANAGED_PYTHON_ROOTS) ?? absolutePaths([
      posix.join(dataHome, "uv", "python"),
      ...(env.UV_PYTHON_INSTALL_DIR === undefined ? [] : [env.UV_PYTHON_INSTALL_DIR]),
    ]),
  };
}

function safeHome(): string {
  try { return homedir(); } catch { return "/home/node"; }
}

/** Whether `target` (a link's text) is an absolute, already normalised path to an interpreter in an allowed folder. Path text only. */
export function isAllowedInterpreterTarget(target: string, policy: VenvLinkPolicy): boolean {
  if (!posix.isAbsolute(target) || target.includes("\0") || target.endsWith("/") || posix.normalize(target) !== target) return false;
  if (!TARGET_NAME.test(posix.basename(target))) return false;
  const directory = posix.dirname(target);
  if (policy.interpreterDirectories.includes(directory)) return true;
  // <root>/<folder>/bin/<name>
  if (posix.basename(directory) !== "bin") return false;
  const folderPath = posix.dirname(directory);
  return policy.managedPythonRoots.some((root) => posix.dirname(folderPath) === root && MANAGED_FOLDER.test(posix.basename(folderPath)));
}

/**
 * Whether the symlink at `linkPath` (a path inside the workspace, in a folder the caller walked without following links) is a virtual environment's interpreter link.
 * True only for: a link in a `bin` folder whose parent holds a `pyvenv.cfg` file, named python / pythonw / python3 / python3.N, whose text is either an allowed
 * interpreter (see `isAllowedInterpreterTarget`) or the bare name of a sibling link in the same folder whose chain ends at one. Reads link text only.
 */
export async function isVenvInterpreterLink(linkPath: string, policy: VenvLinkPolicy = defaultVenvLinkPolicy()): Promise<boolean> {
  const directory = posix.dirname(linkPath);
  if (posix.basename(directory) !== "bin") return false;
  try {
    const config = await lstat(posix.join(posix.dirname(directory), "pyvenv.cfg"));
    if (!config.isFile()) return false;
  } catch {
    return false;
  }
  let name = posix.basename(linkPath);
  for (let step = 0; step < MAX_CHAIN; step += 1) {
    if (!LINK_NAME.test(name)) return false;
    let text: string;
    try {
      const metadata = await lstat(posix.join(directory, name));
      if (!metadata.isSymbolicLink()) return false;
      text = await readlink(posix.join(directory, name));
    } catch {
      return false;
    }
    if (isAllowedInterpreterTarget(text, policy)) return true;
    // A sibling: a bare name, so it stays in this folder.
    if (text.includes("/") || text.includes("\0") || text === name) return false;
    name = text;
  }
  return false;
}
