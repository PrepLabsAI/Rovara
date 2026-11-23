// Private packages P2a, on REAL Docker: the install container's own claims. NOT RUN on a Mac; a recorded native PASS (linux-runtime CI job, ROVARA_DOCKER=1, passwordless sudo, the container firewall of boot.sh installed first) is required before merge (rule #15).
// Each claim is shown with a positive control, so a pass cannot be a test that never looked:
//   - T-TMPFS-1  the step refuses a folder that is not a tmpfs mountpoint of its own, and accepts one that is;
//   - T-SCRIPTS  a hostile root postinstall and a dependency's install script do NOT run under the container's command (a control without --ignore-scripts DOES run them);
//   - 4.1-4.3    `docker inspect` of the container (env, binds, labels, log driver) holds no canary, and the token folder is mounted read-only;
//   - T-NPMRC-1  a repository .npmrc with a ${NPM_TOKEN} auth line is overridden by the derived copy inside the container, and the host file is byte-equal;
//   - T-NET-1    on the `rvbp` bridge the host's own port, the metadata address and a private range are dropped by the boot firewall, while a public name resolves;
//   - T-CONC-1   a sandbox started DURING an install cannot see the token folder, the process or the environment.
// Not here (needs a fake HTTPS registry answering as npm.pkg.github.com): T-HOST-1 (the token goes only to its own host) and T-OFFLINE-1 (the sandbox's `npm ci` / `yarn install --frozen-lockfile` reinstall from the cache with the host blocked and run the
// root postinstall there). They are the first checks of the staging proof; the unit tests pin the cache variables and the file contents they depend on.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:net";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WEB_API_BUILD_IMAGE } from "../../packages/verifier/src/host/web-api-probe-runner.js";
import { assertSecureInstallTmpfs, InstallTmpfsRefused } from "../../packages/worker/src/install-secrets.js";
import { installContainerArgs, installNetworkAddresses, installNetworkCreateArgs, installNetworkName, installNetworkSlot, installRepositoryKey, type InstallContainerInput } from "../../packages/worker/src/private-install-container.js";
import { renderDerivedNpmrc, renderUserNpmrc, renderYarnrc } from "../../packages/worker/src/private-install-plan.js";
import { taskSandboxRunArgs } from "../../packages/worker/src/task-sandbox.js";
import { ensureLocalImage } from "../support/ci-images.js";
import { assertFirewallInstalled, docker, listenOnAllAddresses, reachScript, sudo } from "../support/linux-network-walls.js";
import { APP_NODE_IMAGE } from "../support/linux-runtime.js";

const run = promisify(execFile);
const canary = (): string => `ghp_${randomBytes(24).toString("base64url")}`;

describe.runIf(process.platform === "linux" && process.env.ROVARA_DOCKER === "1")("the private package install container", () => {
  let host: { port: number; server: Server };
  const cleanups: Array<() => Promise<unknown>> = [];
  beforeAll(async () => {
    await assertFirewallInstalled();
    await ensureLocalImage(APP_NODE_IMAGE, WEB_API_BUILD_IMAGE);
    host = await listenOnAllAddresses();
  }, 300_000);
  afterAll(async () => {
    host?.server.close();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
  }, 120_000);

  /** A workspace root with one repository, a token folder holding the canary's files, and the install container's real arguments, with the node image standing in for the worker image (no tini there: `env` is the entrypoint) and a network of the test's choosing. */
  async function fixture(files: Record<string, string>, extra: Partial<InstallContainerInput> = {}) {
    const root = await realpath(await mkdtemp(join(tmpdir(), "rovara-pi-linux-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const repository = join(root, "repo", "web");
    await mkdir(repository, { recursive: true });
    for (const [name, text] of Object.entries(files)) await writeFile(join(repository, name), text);
    for (const manager of ["npm", "yarn1"]) await mkdir(join(root, ".agentx-pkgcache", manager), { recursive: true });
    await run("chown", ["-R", "1000:1000", root]).catch(() => run("sudo", ["-n", "chown", "-R", "1000:1000", root]));
    const token = canary();
    const secrets = await mkdtemp(join(tmpdir(), "rovara-pi-secrets-"));
    cleanups.push(() => rm(secrets, { recursive: true, force: true }));
    await writeFile(join(secrets, "npmrc"), renderUserNpmrc(["@acme"], token), { mode: 0o644 });
    await writeFile(join(secrets, "yarnrc"), renderYarnrc(["@acme"], token), { mode: 0o644 });
    await writeFile(join(secrets, "empty"), "", { mode: 0o644 });
    await chmod(secrets, 0o755);
    const input: InstallContainerInput = { operationId: "linux-op", repository: "web", workspace: "0123456789abcdef", image: APP_NODE_IMAGE, rootPath: root, repositoryDirectory: repository, manager: "npm", secretsDirectory: secrets, ...extra };
    const args = installContainerArgs(input);
    const swap = (flag: string, value: string): string[] => args.map((entry, index) => (args[index - 1] === flag ? value : entry));
    return { root, repository, secrets, token, input, args, swap };
  }
  /** The real arguments with the network replaced (the stand-in image has no `rvbp` network to join unless the test made it) and the init replaced by `env`. */
  const asRun = (args: readonly string[], network: string, command?: string[]): string[] => {
    const swapped = args.map((entry, index) => (args[index - 1] === "--network" ? network : args[index - 1] === "--entrypoint" ? "/usr/bin/env" : entry));
    return command === undefined ? swapped : [...swapped.slice(0, swapped.indexOf("--") + 1), ...command];
  };

  it("T-TMPFS-1: a folder that is not a tmpfs mountpoint of its own is refused, and one that is, is accepted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rovara-pi-tmpfs-"));
    await chmod(directory, 0o700);
    await expect(assertSecureInstallTmpfs(directory)).rejects.toBeInstanceOf(InstallTmpfsRefused);
    const uid = process.getuid!();
    const mounted = await sudo("mount", "-t", "tmpfs", "-o", `size=1m,mode=0700,uid=${String(uid)},gid=${String(process.getgid!())},nosuid,nodev,noexec`, "tmpfs", directory);
    expect(mounted.code, mounted.stderr).toBe(0);
    try {
      await expect(assertSecureInstallTmpfs(directory)).resolves.toBeUndefined();
      await sudo("chmod", "0755", directory);
      await expect(assertSecureInstallTmpfs(directory)).rejects.toBeInstanceOf(InstallTmpfsRefused);
    } finally {
      await sudo("umount", directory);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("4.1-4.3: the container's config holds no canary, the token folder is read-only, the log driver is none, the root is read-only", async () => {
    const { args, token, secrets } = await fixture({ "package.json": "{}" });
    const created = await docker(...asRun(args, "bridge").map((entry, index) => (index === 0 ? "create" : entry)).filter((entry) => entry !== "--rm"));
    expect(created.code, created.stderr).toBe(0);
    const id = created.stdout.trim();
    cleanups.push(() => docker("rm", "--force", id));
    // Positive control: the file the container is given really carries the canary.
    expect(await readFile(join(secrets, "npmrc"), "utf8")).toContain(token);
    const inspected = (await docker("inspect", id)).stdout;
    expect(inspected).not.toContain(token);
    const [config] = JSON.parse(inspected) as Array<{ Config: { Env: string[]; Labels: Record<string, string> }; HostConfig: { Binds: string[]; LogConfig: { Type: string }; ReadonlyRootfs: boolean; CapDrop: string[]; Privileged: boolean } }>;
    expect(config!.HostConfig.LogConfig.Type).toBe("none");
    expect(config!.HostConfig.ReadonlyRootfs).toBe(true);
    expect(config!.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(config!.HostConfig.Privileged).toBe(false);
    expect(config!.HostConfig.Binds.filter((bind) => bind.includes(secrets))).toEqual([`${secrets}:/run/rovara-install:ro`]);
    expect(config!.Config.Env.some((entry) => /^(?:NODE_ENV|NODE_OPTIONS)=$/u.test(entry))).toBe(true);
  }, 120_000);

  it("T-SCRIPTS: a root postinstall and a dependency's install script do not run under the install command; a control without --ignore-scripts runs both", async () => {
    const { root, repository, args, input } = await fixture({
      "package.json": JSON.stringify({ name: "hostile", version: "1.0.0", scripts: { postinstall: "env > \"$INIT_CWD/env-dump\"; echo ran > \"$INIT_CWD/ran-root\"" }, devDependencies: { dep: "file:./dep-1.0.0.tgz" } }),
    });
    const dependency = join(root, "dep-src", "package");
    await mkdir(dependency, { recursive: true });
    await writeFile(join(dependency, "package.json"), JSON.stringify({ name: "dep", version: "1.0.0", scripts: { install: "echo ran > \"$INIT_CWD/ran-dep\"" } }));
    await run("tar", ["czf", join(repository, "dep-1.0.0.tgz"), "-C", join(root, "dep-src"), "package"]);
    await run("chown", ["-R", "1000:1000", repository]).catch(() => run("sudo", ["-n", "chown", "-R", "1000:1000", repository]));
    // The lockfile is made by the same image, scripts off, with no network.
    const locked = await docker("run", "--rm", "--network", "none", "--user", "1000:1000", "--volume", `${repository}:${repository}`, "--workdir", repository, "--env", "HOME=/tmp", APP_NODE_IMAGE, "npm", "install", "--package-lock-only", "--ignore-scripts");
    expect(locked.code, locked.stderr).toBe(0);
    await run("git", ["-C", repository, "init", "--quiet"]);
    const done = await docker(...asRun(args, "none"));
    expect(done.code, done.stderr).toBe(0);
    for (const marker of ["ran-root", "ran-dep", "env-dump"]) await expect(stat(join(repository, marker))).rejects.toThrow();
    expect((await stat(join(repository, "node_modules", "dep"))).isDirectory()).toBe(true);
    // Control: the same tree, scripts on, DOES run them.
    await rm(join(repository, "node_modules"), { recursive: true, force: true });
    const control = await docker("run", "--rm", "--network", "none", "--user", "1000:1000", "--volume", `${repository}:${repository}`, "--workdir", repository, "--env", "HOME=/tmp", APP_NODE_IMAGE, "npm", "ci");
    expect(control.code, control.stderr).toBe(0);
    expect((await stat(join(repository, "ran-dep"))).isFile()).toBe(true);
    expect((await stat(join(repository, "ran-root"))).isFile()).toBe(true);
    expect(input.manager).toBe("npm");
  }, 300_000);

  it("T-NPMRC-1: a repository .npmrc with a ${NPM_TOKEN} auth line is overridden by the derived copy inside the container; the host file is byte-equal", async () => {
    const original = "@acme:registry=https://npm.pkg.github.com/\n//npm.pkg.github.com/:_authToken=${NPM_TOKEN}\n";
    const { repository, secrets, token, input } = await fixture({ "package.json": "{}", ".npmrc": original }, { derivedNpmrc: true });
    const key = installRepositoryKey(input.operationId, input.repository);
    await writeFile(join(secrets, `${key}.npmrc`), renderDerivedNpmrc([], ["@acme"], token), { mode: 0o644 });
    const args = installContainerArgs({ ...input, derivedNpmrc: true });
    const printed = await docker(...asRun(args, "none", ["/usr/local/bin/npm", "config", "get", "//npm.pkg.github.com/:_authToken"]));
    expect(printed.code, printed.stderr).toBe(0);
    expect(printed.stdout.trim()).toBe(token);
    expect(await readFile(join(repository, ".npmrc"), "utf8")).toBe(original);
  }, 120_000);

  it("T-NET-1: on the rvbp bridge the host's port, the metadata address and a private range are dropped; a public name resolves. A control on a plain bridge reaches the host.", async () => {
    const operation = "linux-net-op";
    const addresses = installNetworkAddresses(installNetworkSlot(operation));
    const created = await docker(...installNetworkCreateArgs(operation, "0123456789abcdef", addresses));
    expect(created.code, created.stderr).toBe(0);
    cleanups.push(() => docker("network", "rm", installNetworkName(operation)));
    const inNetwork = (network: string, script: string) => docker("run", "--rm", "--pull=never", "--network", network, "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--user", "1000:1000", APP_NODE_IMAGE, "node", "-e", script);
    const control = await inNetwork("bridge", reachScript([["gateway", host.port]]));
    expect(control.stdout.trim(), `control: ${control.stderr}`).toBe('["open"]');
    const walled = await inNetwork(installNetworkName(operation), reachScript([["gateway", host.port], ["169.254.169.254", 80], ["10.0.0.1", 443], ["192.168.1.1", 443]]));
    expect(walled.code).toBe(7);
    expect(walled.stdout.trim()).toBe('["timeout","timeout","timeout","timeout"]');
    const dns = await inNetwork(installNetworkName(operation), "require('dns').promises.lookup('registry.npmjs.org').then(()=>process.exit(0),()=>process.exit(1))");
    expect(dns.code, dns.stderr).toBe(0);
  }, 180_000);

  it("T-CONC-1: a sandbox started during an install cannot see the token folder, the process or the environment", async () => {
    const { args, token, root } = await fixture({ "package.json": "{}" });
    const name = `rovara-pi-conc-${randomBytes(4).toString("hex")}`;
    const long = asRun(args, "none", ["/bin/sleep", "60"]).map((entry, index, all) => (all[index - 1] === "--name" ? name : entry));
    const started = await docker(...long.map((entry, index) => (index === 0 ? "run" : entry)).flatMap((entry) => (entry === "--rm" ? ["--rm", "--detach"] : [entry])));
    expect(started.code, started.stderr).toBe(0);
    cleanups.push(() => docker("rm", "--force", name));
    // Positive control: the install container sees its file.
    expect((await docker("exec", name, "cat", "/run/rovara-install/npmrc")).stdout).toContain(token);
    const sandbox = taskSandboxRunArgs({ name: `${name}-sandbox`, taskId: "conc", image: APP_NODE_IMAGE, rootPath: root, maskedPaths: [] }).map((entry, index, all) => (all[index - 1] === "--network" ? "none" : all[index - 1] === "--entrypoint" ? "/usr/bin/env" : entry));
    const sandboxStart = await docker(...sandbox.slice(0, sandbox.indexOf("--") + 1).concat(["sleep", "30"]));
    expect(sandboxStart.code, sandboxStart.stderr).toBe(0);
    cleanups.push(() => docker("rm", "--force", `${name}-sandbox`));
    const looked = await docker("exec", `${name}-sandbox`, "sh", "-c", "ls /run/rovara-install 2>&1; env; ps -eo args 2>&1 | cat");
    expect(looked.stdout).toMatch(/No such file or directory/u);
    expect(looked.stdout).not.toContain(token);
    expect(looked.stdout).not.toContain("sleep 60");
  }, 180_000);

  it.todo("T-HOST-1: the token is sent only to npm.pkg.github.com (a lockfile `resolved` on another host and a tarball redirect get no Authorization header) - needs a fake HTTPS registry answering as npm.pkg.github.com");
  it.todo("T-OFFLINE-1: after the step, the sandbox's `npm ci` and `yarn install --frozen-lockfile` succeed with npm.pkg.github.com blocked and run the root postinstall there - needs the same fake registry");
});
