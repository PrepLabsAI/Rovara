import { execFile } from "node:child_process";
import { mkdir, mkdtemp, symlink, writeFile, readdir, readlink, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ProjectDefinition } from "@rovara-code/contracts";
import { describe, expect, it } from "vitest";
import { prepareWorkspace, type RepositoryMaterializer } from "../../packages/worker/src/prepare.js";
import { defaultVenvLinkPolicy, type VenvLinkPolicy } from "../../packages/worker/src/workspace-links.js";

const run = promisify(execFile);
const UV_LINK = "/home/node/.local/share/uv/python/cpython-3.12.3-linux-aarch64-gnu/bin/python3.12";
// /usr/bin/bash exists on Linux and not on macOS: either way the preparation refuses it, as an escape or as a broken link.
const REFUSED = /workspace path escapes its root|broken symlink is not allowed in workspace/;
const policy: VenvLinkPolicy = defaultVenvLinkPolicy({}, "/home/node");

async function layOutVenv(venv: string, links: Record<string, string>): Promise<void> {
  await mkdir(join(venv, "bin"), { recursive: true });
  await writeFile(join(venv, "pyvenv.cfg"), "home = /usr/bin\n");
  for (const [name, target] of Object.entries(links)) {
    await mkdir(dirname(join(venv, name)), { recursive: true });
    await symlink(target, join(venv, name));
  }
}

const DEBIAN_VENV = { "bin/python3": "/usr/bin/python3", "bin/python": "python3", "bin/python3.12": "python3" };
const UV_VENV = { "bin/python": UV_LINK, "bin/python3": "python", "bin/python3.12": "python" };

async function fixture(name: string, files: (directory: string) => Promise<void> = async () => undefined): Promise<{ directory: string; commit: string }> {
  const directory = await mkdtemp(join(tmpdir(), `agentx-${name}-source-`));
  await run("git", ["init", "--quiet", "--initial-branch=main", directory]);
  await writeFile(join(directory, "README.md"), `# ${name}\n`);
  await files(directory);
  await run("git", ["-C", directory, "add", "-A"]);
  await run("git", ["-C", directory, "-c", "user.name=AgentX", "-c", "user.email=agentx@example.test", "commit", "--quiet", "-m", "fixture"]);
  const { stdout } = await run("git", ["-C", directory, "rev-parse", "HEAD"]);
  return { directory, commit: stdout.trim() };
}

function project(name: string, commit: string, setup: ProjectDefinition["setup"] = []): ProjectDefinition {
  void commit;
  return {
    name: "payments",
    revision: 1,
    repositories: [{ name, url: `http://127.0.0.1/${name}.git`, path: `repo/${name}`, defaultBranch: "main", credentialRef: `${name}-readwrite` }],
    setup,
    readiness: [],
    orchestratorInstructions: "Delegate all code changes to the remote worker.",
  };
}

const clone = (source: string): RepositoryMaterializer => async (_repository, destination) => {
  await run("git", ["clone", "--quiet", source, destination]);
};
const step = (cwd: string): ProjectDefinition["setup"][number] => ({ cwd, executable: "make-venv", args: [], timeoutSeconds: 2 });

describe("workspace preparation: virtual environment interpreter links", () => {
  it("accepts a venv made by a setup step (Debian-style and uv-style) and a resumed preparation of it", async () => {
    for (const links of [DEBIAN_VENV, UV_VENV]) {
      const root = await mkdtemp(join(tmpdir(), "agentx-venv-setup-"));
      const source = await fixture("pyapp");
      const options = {
        rootPath: root,
        project: project("pyapp", source.commit, [step("repo/pyapp")]),
        materializer: clone(source.directory),
        commandRunner: async () => {
          await layOutVenv(join(root, "repo/pyapp/.venv"), links);
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        venvLinkPolicy: policy,
      };
      await expect(prepareWorkspace(options)).resolves.toMatchObject({ complete: true, completedSetupSteps: [0] });
      // Resumed: the manifest is complete and the check at :287 runs again over the tree with the venv in it.
      await expect(prepareWorkspace({ ...options, commandRunner: async () => { throw new Error("must not run again"); } })).resolves.toMatchObject({ complete: true });
    }
  });

  it("accepts a venv with the default policy (no option), and a real python -m venv tree made by a setup step", async (context) => {
    const root = await mkdtemp(join(tmpdir(), "agentx-venv-real-"));
    const source = await fixture("realvenv");
    let hostPolicy: VenvLinkPolicy | undefined;
    const options = {
      rootPath: root,
      project: project("realvenv", source.commit, [step("repo/realvenv")]),
      materializer: clone(source.directory),
      commandRunner: async () => {
        const venv = join(root, "repo/realvenv/.venv");
        await run("python3", ["-m", "venv", "--without-pip", venv]);
        const dirs = new Set<string>(["/usr/bin", "/usr/local/bin"]);
        for (const name of await readdir(join(venv, "bin"))) {
          if (!(await lstat(join(venv, "bin", name))).isSymbolicLink()) continue;
          const text = await readlink(join(venv, "bin", name));
          if (text.startsWith("/")) dirs.add(dirname(text));
        }
        hostPolicy = { interpreterDirectories: [...dirs], managedPythonRoots: [] };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    // The default policy with the hand-made Debian layout:
    const debianRoot = await mkdtemp(join(tmpdir(), "agentx-venv-default-"));
    await expect(prepareWorkspace({
      ...options,
      rootPath: debianRoot,
      project: project("realvenv", source.commit, [step("repo/realvenv")]),
      commandRunner: async () => {
        await layOutVenv(join(debianRoot, "repo/realvenv/.venv"), DEBIAN_VENV);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    })).resolves.toMatchObject({ complete: true });
    try {
      await run("python3", ["--version"]);
    } catch {
      context.skip();
      return;
    }
    // The host's python may be anywhere; the first run finds out where, and the policy names it.
    await prepareWorkspace({ ...options, venvLinkPolicy: { interpreterDirectories: [], managedPythonRoots: [] } }).catch(() => undefined);
    expect(hostPolicy).toBeDefined();
    const second = await mkdtemp(join(tmpdir(), "agentx-venv-real2-"));
    await expect(prepareWorkspace({ ...options, rootPath: second, venvLinkPolicy: hostPolicy! })).resolves.toMatchObject({ complete: true });
  });

  it("accepts a venv that a repository holds (the repository step)", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentx-venv-repo-"));
    const source = await fixture("committed", async (directory) => { await layOutVenv(join(directory, ".venv"), DEBIAN_VENV); });
    await expect(prepareWorkspace({ rootPath: root, project: project("committed", source.commit), materializer: clone(source.directory), venvLinkPolicy: policy })).resolves.toMatchObject({ complete: true });
  });

  it("still refuses what is not a venv interpreter link, after a setup step", async () => {
    const cases: Array<[string, Record<string, string>, boolean, string | RegExp]> = [
      ["fake venv to /etc/passwd", { "bin/python3": "/etc/passwd" }, true, "workspace path escapes its root"],
      ["venv link to /usr/bin/bash", { "bin/python3": "/usr/bin/bash" }, true, REFUSED],
      ["non-bin link outside", { "lib/python3": "/usr/bin/python3" }, true, "workspace path escapes its root"],
      ["bin link without pyvenv.cfg", { "bin/python3": "/usr/bin/python3" }, false, "workspace path escapes its root"],
      ["venv link to a missing non-interpreter", { "bin/python3": "/nonexistent/place" }, true, "broken symlink is not allowed in workspace"],
    ];
    for (const [label, links, cfg, message] of cases) {
      const root = await mkdtemp(join(tmpdir(), "agentx-venv-bad-"));
      const source = await fixture("bad");
      await expect(prepareWorkspace({
        rootPath: root,
        project: project("bad", source.commit, [step("repo/bad")]),
        materializer: clone(source.directory),
        venvLinkPolicy: policy,
        commandRunner: async () => {
          await layOutVenv(join(root, "repo/bad/.venv"), links);
          if (!cfg) await run("rm", [join(root, "repo/bad/.venv/pyvenv.cfg")]);
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      }), label).rejects.toThrow(message);
    }
  });

  it("still refuses a bad link in a repository (the repository step) and one planted after the workspace was complete (the resumed preparation)", async () => {
    const source = await fixture("planted", async (directory) => { await layOutVenv(join(directory, ".venv"), { "bin/python3": "/etc/passwd" }); });
    await expect(prepareWorkspace({
      rootPath: await mkdtemp(join(tmpdir(), "agentx-venv-planted-")),
      project: project("planted", source.commit),
      materializer: clone(source.directory),
      venvLinkPolicy: policy,
    })).rejects.toThrow("workspace path escapes its root");

    const root = await mkdtemp(join(tmpdir(), "agentx-venv-resume-"));
    const clean = await fixture("resume");
    const options = { rootPath: root, project: project("resume", clean.commit), materializer: clone(clean.directory), venvLinkPolicy: policy };
    await expect(prepareWorkspace(options)).resolves.toMatchObject({ complete: true });
    await layOutVenv(join(root, "repo/resume/.venv"), { "bin/python3": "/usr/bin/bash" });
    await expect(prepareWorkspace(options)).rejects.toThrow(REFUSED);
  });
});
