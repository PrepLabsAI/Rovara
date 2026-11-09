import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readlink, writeFile, symlink, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  defaultVenvLinkPolicy,
  isAllowedInterpreterTarget,
  isVenvInterpreterLink,
  type VenvLinkPolicy,
} from "../../packages/worker/src/workspace-links.js";

const run = promisify(execFile);
const policy: VenvLinkPolicy = defaultVenvLinkPolicy({}, "/home/node");
const UV_ROOT = "/home/node/.local/share/uv/python";

async function makeVenv(links: Record<string, string>, options: { cfg?: boolean; folder?: string } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentx-venv-links-"));
  const venv = join(root, options.folder ?? ".venv");
  await mkdir(join(venv, "bin"), { recursive: true });
  if (options.cfg !== false) await writeFile(join(venv, "pyvenv.cfg"), "home = /usr/bin\nversion = 3.12.3\n");
  for (const [name, target] of Object.entries(links)) {
    await mkdir(dirname(join(venv, name)), { recursive: true });
    await symlink(target, join(venv, name));
  }
  return venv;
}

describe("workspace links: virtual environment interpreter links", () => {
  it("accepts every symlink of a real python -m venv tree (the interpreter folder named by policy; the target is not followed)", async (context) => {
    const root = await mkdtemp(join(tmpdir(), "agentx-real-venv-"));
    try {
      await run("python3", ["-m", "venv", "--without-pip", join(root, ".venv")]);
    } catch {
      context.skip();
      return;
    }
    const bin = join(root, ".venv", "bin");
    const links: string[] = [];
    for (const name of await readdir(bin)) if ((await lstat(join(bin, name))).isSymbolicLink()) links.push(name);
    expect(links.length).toBeGreaterThan(0);
    // The test host's own python can live anywhere (Homebrew, pyenv): its folders are the policy here, as an operator would configure them.
    const dirs = new Set<string>(["/usr/bin", "/usr/local/bin"]);
    for (const name of links) {
      const text = await readlink(join(bin, name));
      if (text.startsWith("/")) dirs.add(dirname(text));
    }
    const hostPolicy: VenvLinkPolicy = { interpreterDirectories: [...dirs], managedPythonRoots: [] };
    for (const name of links) expect(await isVenvInterpreterLink(join(bin, name), hostPolicy), name).toBe(true);
    // The same tree under a policy that does not name the host's folder is refused: the rule is the policy, not "any venv".
    const strict: VenvLinkPolicy = { interpreterDirectories: ["/nonexistent-interpreters"], managedPythonRoots: [] };
    for (const name of links) expect(await isVenvInterpreterLink(join(bin, name), strict), name).toBe(false);
  });

  it("accepts a Debian-style venv (python3 -> /usr/bin/python3, python and python3.N siblings) without the target existing", async () => {
    const venv = await makeVenv({ "bin/python3": "/usr/bin/python3", "bin/python": "python3", "bin/python3.12": "python3" });
    for (const name of ["python3", "python", "python3.12"]) expect(await isVenvInterpreterLink(join(venv, "bin", name), policy), name).toBe(true);
    const local = await makeVenv({ "bin/python": "/usr/local/bin/python3.11", "bin/python3": "python", "bin/pythonw": "/usr/local/bin/python" });
    for (const name of ["python3", "python", "pythonw"]) expect(await isVenvInterpreterLink(join(local, "bin", name), policy), name).toBe(true);
  });

  it("accepts a Python 3.14 venv, which also holds the pi alias (U+1D70B then thon) beside python (CI: Ubuntu 26.04)", async () => {
    const pi = "\u{1D70B}thon";
    const venv = await makeVenv({ "bin/python": "/usr/bin/python3.14", "bin/python3": "python", "bin/python3.14": "python", [`bin/${pi}`]: "python" });
    for (const name of ["python", "python3", "python3.14", pi]) expect(await isVenvInterpreterLink(join(venv, "bin", name), policy), name).toBe(true);
    // The alias is a name, not a way out: it still has to end at an allowed interpreter, and look-alike names are not it.
    const loose = await makeVenv({ [`bin/${pi}`]: "/tmp/evil/python3", "bin/python": "/usr/bin/python3" });
    expect(await isVenvInterpreterLink(join(loose, "bin", pi), policy)).toBe(false);
    const alike = await makeVenv({ "bin/\u03c0thon": "/usr/bin/python3", [`bin/${pi}3`]: "/usr/bin/python3", [`bin/x${pi}`]: "/usr/bin/python3" });
    for (const name of ["\u03c0thon", `${pi}3`, `x${pi}`]) expect(await isVenvInterpreterLink(join(alike, "bin", name), policy), name).toBe(false);
    expect(isAllowedInterpreterTarget(`/usr/bin/${pi}`, policy)).toBe(true);
  });

  it("accepts a uv-style venv whose interpreter is a uv-managed Python under the sandbox user's home", async () => {
    const managed = `${UV_ROOT}/cpython-3.12.3-linux-aarch64-gnu/bin/python3.12`;
    const venv = await makeVenv({ "bin/python": managed, "bin/python3": "python", "bin/python3.12": "python" });
    for (const name of ["python", "python3", "python3.12"]) expect(await isVenvInterpreterLink(join(venv, "bin", name), policy), name).toBe(true);
    // The folders are configurable.
    const elsewhere = defaultVenvLinkPolicy({ UV_PYTHON_INSTALL_DIR: "/opt/uv-pythons" }, "/home/other");
    expect(isAllowedInterpreterTarget("/opt/uv-pythons/cpython-3.13.1-linux-x86_64-gnu/bin/python3.13", elsewhere)).toBe(true);
    expect(isAllowedInterpreterTarget("/home/other/.local/share/uv/python/cpython-3.13.1-linux-x86_64-gnu/bin/python3", elsewhere)).toBe(true);
    expect(isAllowedInterpreterTarget(`${UV_ROOT}/cpython-3.12.3-linux-aarch64-gnu/bin/python3.12`, elsewhere)).toBe(false);
    const configured = defaultVenvLinkPolicy({ AGENTX_VENV_INTERPRETER_DIRS: "/opt/py/bin", AGENTX_VENV_MANAGED_PYTHON_ROOTS: "/srv/uv" }, "/home/node");
    expect(configured).toEqual({ interpreterDirectories: ["/opt/py/bin"], managedPythonRoots: ["/srv/uv"] });
    expect(isAllowedInterpreterTarget("/usr/bin/python3", configured)).toBe(false);
    expect(isAllowedInterpreterTarget("/opt/py/bin/python3", configured)).toBe(true);
  });

  it("refuses a planted venv whose interpreter link points at /etc/passwd, and one that points at /usr/bin/bash", async () => {
    const passwd = await makeVenv({ "bin/python3": "/etc/passwd", "bin/python": "python3" });
    expect(await isVenvInterpreterLink(join(passwd, "bin", "python3"), policy)).toBe(false);
    expect(await isVenvInterpreterLink(join(passwd, "bin", "python"), policy)).toBe(false);
    const bash = await makeVenv({ "bin/python3": "/usr/bin/bash", "bin/python": "/usr/bin/bash" });
    expect(await isVenvInterpreterLink(join(bash, "bin", "python3"), policy)).toBe(false);
    expect(await isVenvInterpreterLink(join(bash, "bin", "python"), policy)).toBe(false);
  });

  it("refuses a link outside a bin folder, a bin folder without pyvenv.cfg, and a pyvenv.cfg that is not a plain file", async () => {
    const notBin = await makeVenv({ "lib/python3": "/usr/bin/python3", "python3": "/usr/bin/python3", "bin/sub/python3": "/usr/bin/python3" });
    for (const name of ["lib/python3", "python3", "bin/sub/python3"]) expect(await isVenvInterpreterLink(join(notBin, name), policy), name).toBe(false);
    const noConfig = await makeVenv({ "bin/python3": "/usr/bin/python3" }, { cfg: false });
    expect(await isVenvInterpreterLink(join(noConfig, "bin", "python3"), policy)).toBe(false);
    const linkConfig = await makeVenv({ "bin/python3": "/usr/bin/python3", "pyvenv.cfg": "/etc/hostname" }, { cfg: false });
    expect(await isVenvInterpreterLink(join(linkConfig, "bin", "python3"), policy)).toBe(false);
    const dirConfig = await makeVenv({ "bin/python3": "/usr/bin/python3" }, { cfg: false });
    await mkdir(join(dirConfig, "pyvenv.cfg"));
    expect(await isVenvInterpreterLink(join(dirConfig, "bin", "python3"), policy)).toBe(false);
  });

  it("keeps the name and target sets tight", async () => {
    const names: Array<[string, string, boolean]> = [
      ["python", "/usr/bin/python3", true],
      ["python3", "/usr/bin/python3", true],
      ["python3.12", "/usr/bin/python3.12", true],
      ["pythonw", "/usr/bin/python3", true],
      ["python3.13t", "/usr/bin/python3.13t", true],
      ["pip", "/usr/bin/python3", false],
      ["activate", "/usr/bin/python3", false],
      ["python3.x", "/usr/bin/python3", false],
      ["python2", "/usr/bin/python3", false],
      ["python3.123", "/usr/bin/python3", false],
      ["python.exe", "/usr/bin/python3", false],
      ["python3-config", "/usr/bin/python3", false],
      ["python3", "/usr/bin/python3-config", false],
      ["python3", "/usr/bin/pip", false],
      ["python3", "/usr/bin/python2", false],
      ["python3", "/usr/bin/../bin/python3", false],
      ["python3", "/usr//bin/python3", false],
      ["python3", "/usr/bin/sub/python3", false],
      ["python3", "/usr/lib/python3", false],
      ["python3", "/tmp/python3", false],
      ["python3", "/home/node/.local/share/uv/python/python3", false],
      ["python3", `${UV_ROOT}/cpython-3.12.3-linux-aarch64-gnu/lib/python3`, false],
      ["python3", `${UV_ROOT}/a/b/bin/python3`, false],
      ["python3", `${UV_ROOT}/../evil/bin/python3`, false],
      ["python3", "../../../usr/bin/python3", false],
      ["python3", "usr/bin/python3", false],
      ["python3", "../python3", false],
      ["python3", "/", false],
    ];
    for (const [name, target, expected] of names) {
      const venv = await makeVenv({ [`bin/${name}`]: target });
      expect(await isVenvInterpreterLink(join(venv, "bin", name), policy), `${name} -> ${target}`).toBe(expected);
    }
  });

  it("judges the target text exactly (a trailing slash is not stripped)", () => {
    expect(isAllowedInterpreterTarget("/usr/bin/python3", policy)).toBe(true);
    expect(isAllowedInterpreterTarget("/usr/bin/python3/", policy)).toBe(false);
    expect(isAllowedInterpreterTarget("/usr/bin/python3\0", policy)).toBe(false);
  });

  it("follows a sibling chain only inside the same bin folder and only to an allowed interpreter", async () => {
    const endsOutside = await makeVenv({ "bin/python3": "python", "bin/python": "python3.12", "bin/python3.12": "/etc/passwd" });
    for (const name of ["python3", "python", "python3.12"]) expect(await isVenvInterpreterLink(join(endsOutside, "bin", name), policy), name).toBe(false);
    const cycle = await makeVenv({ "bin/python3": "python", "bin/python": "python3" });
    expect(await isVenvInterpreterLink(join(cycle, "bin", "python3"), policy)).toBe(false);
    const toPlainFile = await makeVenv({ "bin/python3": "helper" });
    await writeFile(join(toPlainFile, "bin", "helper"), "#!/bin/sh\n");
    expect(await isVenvInterpreterLink(join(toPlainFile, "bin", "python3"), policy)).toBe(false);
    const toNonInterpreterName = await makeVenv({ "bin/python3": "pip", "bin/pip": "/usr/bin/python3" });
    expect(await isVenvInterpreterLink(join(toNonInterpreterName, "bin", "python3"), policy)).toBe(false);
    const upward = await makeVenv({ "bin/python3": "../bin/python", "bin/python": "/usr/bin/python3" });
    expect(await isVenvInterpreterLink(join(upward, "bin", "python3"), policy)).toBe(false);
    const missingSibling = await makeVenv({ "bin/python3": "python" });
    expect(await isVenvInterpreterLink(join(missingSibling, "bin", "python3"), policy)).toBe(false);
  });
});
