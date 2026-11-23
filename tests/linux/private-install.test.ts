// Private packages P2a, on REAL Docker: the install container's own claims. NOT RUN on a Mac; a recorded native PASS (linux-runtime CI job, ROVARA_DOCKER=1, passwordless sudo, the container firewall of boot.sh installed first) is required before merge (rule #15).
// Each claim is shown with a positive control, so a pass cannot be a test that never looked:
//   - T-TMPFS-1  the step refuses a folder that is not a tmpfs mountpoint of its own, and accepts one that is;
//   - T-SCRIPTS  a hostile root postinstall and a dependency's install script do NOT run under the container's command (a control without --ignore-scripts DOES run them);
//   - 4.1-4.3    `docker inspect` of the container (env, binds, labels, log driver) holds no canary, and the token folder is mounted read-only;
//   - T-NPMRC-1  a repository .npmrc with a ${NPM_TOKEN} auth line is overridden by the derived copy inside the container, and the host file is byte-equal;
//   - T-NET-1    on the `rvbp` bridge the host's own port, the metadata address and a private range are dropped by the boot firewall, while a public name resolves;
//   - T-CONC-1   a sandbox started DURING an install cannot see the token folder, the process or the environment.
//   - T-HOST-1   (npm and yarn 1, against a fake HTTPS registry answering as npm.pkg.github.com with a throwaway CA): the token reaches that host and no other (a second registry, the target of a tarball redirect); a control keyed to the second host shows it would be seen;
//   - T-OFFLINE-1 (same registry): after the install the repository's own `npm ci` / `yarn install --frozen-lockfile` in a sandbox with NO network and no token succeeds from the cache and runs the root postinstall; the control without the cache variables fails.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:net";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WEB_API_BUILD_IMAGE } from "../../packages/verifier/src/host/web-api-probe-runner.js";
import { assertSecureInstallTmpfs, InstallTmpfsRefused } from "../../packages/worker/src/install-secrets.js";
import { installContainerArgs, installNetworkAddresses, installNetworkCreateArgs, installNetworkName, installNetworkSlot, installRepositoryKey, type InstallContainerInput } from "../../packages/worker/src/private-install-container.js";
import { renderDerivedNpmrc, renderUserNpmrc, renderYarnrc } from "../../packages/worker/src/private-install-plan.js";
import { PACKAGE_CACHE_DIRECTORY, PACKAGE_CACHE_MARKER, packageCacheEnvironment } from "../../packages/worker/src/package-cache.js";
import { e2eSecretSpellings } from "../../packages/contracts/src/index.js";
import { taskSandboxRunArgs } from "../../packages/worker/src/task-sandbox.js";
import { ensureLocalImage } from "../support/ci-images.js";
import { assertFirewallInstalled, docker, listenOnAllAddresses, reachScript, sudo } from "../support/linux-network-walls.js";
import { APP_NODE_IMAGE } from "../support/linux-runtime.js";

const run = promisify(execFile);
/** Removes a tree the container made as uid 1000 (the runner cannot remove those itself). */
const removeTree = async (path: string): Promise<void> => { await run("sudo", ["-n", "rm", "-rf", path]).catch(() => rm(path, { recursive: true, force: true })); };
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
  async function fixture(files: Record<string, string>, extra: Partial<InstallContainerInput> = {}, options: { token?: string; npmrc?: (token: string) => string; yarnrc?: (token: string) => string } = {}) {
    const root = await realpath(await mkdtemp(join(tmpdir(), "rovara-pi-linux-")));
    cleanups.push(() => removeTree(root));
    const repository = join(root, "repo", "web");
    await mkdir(repository, { recursive: true });
    for (const [name, text] of Object.entries(files)) await writeFile(join(repository, name), text);
    for (const manager of ["npm", "yarn1"]) await mkdir(join(root, ".agentx-pkgcache", manager), { recursive: true });
    // The container runs as uid 1000 and the runner as another user: the tree stays the runner's (it keeps making files in it) and is open to the container by mode, never by changing who owns it. The container makes node_modules as 1000, so removing those goes through `removeTree` (sudo).
    await run("chmod", ["-R", "a+rwX", root]);
    const token = options.token ?? canary();
    const secrets = await mkdtemp(join(tmpdir(), "rovara-pi-secrets-"));
    cleanups.push(() => rm(secrets, { recursive: true, force: true }));
    await writeFile(join(secrets, "npmrc"), (options.npmrc ?? ((value: string) => renderUserNpmrc(["@acme"], value)))(token), { mode: 0o644 });
    await writeFile(join(secrets, "yarnrc"), (options.yarnrc ?? ((value: string) => renderYarnrc(["@acme"], value)))(token), { mode: 0o644 });
    await writeFile(join(secrets, "empty"), "", { mode: 0o644 });
    await chmod(secrets, 0o755);
    const input: InstallContainerInput = { operationId: "linux-op", repository: "web", workspace: "0123456789abcdef", image: APP_NODE_IMAGE, rootPath: root, repositoryDirectory: repository, manager: "npm", secretsDirectory: secrets, ...extra };
    const args = installContainerArgs(input);
    const swap = (flag: string, value: string): string[] => args.map((entry, index) => (args[index - 1] === flag ? value : entry));
    return { root, repository, secrets, token, input, args, swap };
  }
  /** The real arguments with the network replaced (the stand-in image has no `rvbp` network to join unless the test made it) and the init replaced by `env`. */
  const asRun = (args: readonly string[], network: string, command?: string[]): string[] => {
    // A name of its own per run: the production name is derived from the operation and the repository, so two runs of one fixture would clash.
    const name = `rovara-pi-run-${randomBytes(4).toString("hex")}`;
    const swapped = args.map((entry, index) => (args[index - 1] === "--network" ? network : args[index - 1] === "--entrypoint" ? "/usr/bin/env" : args[index - 1] === "--name" ? name : entry));
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
    // The lockfile is made by the same image, scripts off, with no network.
    const locked = await docker("run", "--rm", "--network", "none", "--user", "1000:1000", "--volume", `${repository}:${repository}`, "--workdir", repository, "--env", "HOME=/tmp", APP_NODE_IMAGE, "npm", "install", "--package-lock-only", "--ignore-scripts");
    expect(locked.code, locked.stderr).toBe(0);
    await run("git", ["-C", repository, "init", "--quiet"]);
    const done = await docker(...asRun(args, "none"));
    expect(done.code, done.stderr).toBe(0);
    for (const marker of ["ran-root", "ran-dep", "env-dump"]) await expect(stat(join(repository, marker))).rejects.toThrow();
    expect((await stat(join(repository, "node_modules", "dep"))).isDirectory()).toBe(true);
    // Control: the same tree, scripts on, DOES run them.
    await removeTree(join(repository, "node_modules"));
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

  // ---- a fake HTTPS registry answering as npm.pkg.github.com (T-HOST-1, T-OFFLINE-1)
  //
  // One container on a plain test bridge with three network aliases: `npm.pkg.github.com` (the supported host, which wants the token), `other-registry.test` (a second registry: a public-style package and a control package) and `tarballs.test`
  // (where a tarball redirect from the first host lands). It speaks TLS with a THROWAWAY CA made by openssl for this test only; the install container trusts that CA only through a test-added mount and NODE_EXTRA_CA_CERTS (the production arguments
  // are asserted by the unit tests and are not weakened). Every request is logged as {host, path, auth: none|token|other, tokenAnywhere}: never the header itself.
  const GITHUB = "npm.pkg.github.com";
  const SERVER = [
    'const https = require("https"), fs = require("fs");',
    "const token = process.env.FAKE_TOKEN;",
    'const serve = (res, file) => { const bytes = fs.readFileSync("/srv/data/" + file); res.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.length }); res.end(bytes); };',
    'https.createServer({ key: fs.readFileSync("/srv/tls/srv.key"), cert: fs.readFileSync("/srv/tls/srv.pem") }, (req, res) => {',
    '  const host = String(req.headers.host || "").split(":")[0];',
    '  const url = decodeURIComponent(req.url.split("?")[0]);',
    '  if (url === "/ping") { res.writeHead(200); res.end("ok"); return; }',
    '  const header = req.headers.authorization || "";',
    '  const auth = header === "" ? "none" : header === "Bearer " + token ? "token" : "other";',
    '  fs.appendFileSync("/log/requests.jsonl", JSON.stringify({ host, path: url, auth, tokenAnywhere: JSON.stringify(req.headers).includes(token) }) + "\\n");',
    `  if (host === "${GITHUB}" && url.startsWith("/download/")) {`,
    '    if (auth !== "token") { res.writeHead(401, { "content-type": "application/json" }); res.end(\'{"error":"unauthorized"}\'); return; }',
    '    if (url === "/download/@acme/priv/1.0.0/abc") return serve(res, "priv.tgz");',
    '    if (url === "/download/@acme/redirected/1.0.0/abc") { res.writeHead(302, { location: "https://tarballs.test/blob/redirected.tgz" }); res.end(); return; }',
    "  }",
    '  if (host === "tarballs.test" && url === "/blob/redirected.tgz") return serve(res, "redirected.tgz");',
    '  if (host === "other-registry.test" && url === "/leftpad/-/leftpad-1.0.0.tgz") return serve(res, "leftpad.tgz");',
    '  if (host === "other-registry.test" && url === "/@other/ctl/-/ctl-1.0.0.tgz") return serve(res, "ctl.tgz");',
    '  res.writeHead(404); res.end("not found");',
    "}).listen(443);",
  ].join("\n");

  interface Packed { name: string; integrity: string; sha1: string }
  interface RequestRow { host: string; path: string; auth: "none" | "token" | "other"; tokenAnywhere: boolean }
  interface FakeRegistry {
    network: string; token: string; caDirectory: string; packed: Record<"priv" | "redirected" | "leftpad" | "ctl", Packed>;
    requests(): Promise<RequestRow[]>;
    clearRequests(): Promise<void>;
  }

  async function pack(directory: string, key: string, name: string): Promise<Packed> {
    const source = join(directory, `src-${key}`, "package");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
    const file = join(directory, "data", `${key}.tgz`);
    await run("tar", ["czf", file, "-C", join(directory, `src-${key}`), "package"]);
    const bytes = await readFile(file);
    return { name, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`, sha1: createHash("sha1").update(bytes).digest("hex") };
  }

  async function startFakeRegistry(): Promise<FakeRegistry> {
    const directory = await mkdtemp(join(tmpdir(), "rovara-pi-registry-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    for (const folder of ["data", "tls", "log", "ca"]) await mkdir(join(directory, folder));
    // The throwaway CA, the server certificate for the three names, all made now and never committed.
    const tls = join(directory, "tls");
    const openssl = async (...args: string[]) => { await run("openssl", args, { cwd: tls }); };
    await openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "1", "-subj", "/CN=rovara-test-ca", "-addext", "basicConstraints=critical,CA:TRUE");
    await openssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "srv.key", "-out", "srv.csr", "-subj", `/CN=${GITHUB}`);
    await writeFile(join(tls, "ext.cnf"), `subjectAltName=DNS:${GITHUB},DNS:other-registry.test,DNS:tarballs.test\n`);
    await openssl("x509", "-req", "-in", "srv.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "srv.pem", "-days", "1", "-extfile", "ext.cnf");
    const caDirectory = join(directory, "ca");
    await writeFile(join(caDirectory, "ca.pem"), await readFile(join(tls, "ca.pem")));
    const packed = {
      priv: await pack(directory, "priv", "@acme/priv"), redirected: await pack(directory, "redirected", "@acme/redirected"),
      leftpad: await pack(directory, "leftpad", "leftpad"), ctl: await pack(directory, "ctl", "@other/ctl"),
    };
    await writeFile(join(directory, "server.js"), SERVER);
    const log = join(directory, "log", "requests.jsonl");
    await writeFile(log, "");
    // The container runs as uid 1000 and the CA's private key is not given to it: only the server's own key and certificate.
    await run("chmod", ["-R", "a+rX", directory]);
    await run("chmod", ["666", log]);
    await rm(join(tls, "ca.key"));
    const token = canary();
    const network = `rovara-pi-net-${randomBytes(4).toString("hex")}`;
    expect((await docker("network", "create", network)).code).toBe(0);
    cleanups.push(() => docker("network", "rm", network));
    const name = `rovara-pi-registry-${randomBytes(4).toString("hex")}`;
    const started = await docker("run", "--detach", "--name", name, "--network", network, "--network-alias", GITHUB, "--network-alias", "other-registry.test", "--network-alias", "tarballs.test",
      "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--sysctl", "net.ipv4.ip_unprivileged_port_start=0", "--env", `FAKE_TOKEN=${token}`,
      "--volume", `${directory}:/srv:ro`, "--volume", `${join(directory, "log")}:/log:rw`, APP_NODE_IMAGE, "node", "/srv/server.js");
    expect(started.code, started.stderr).toBe(0);
    cleanups.push(() => docker("rm", "--force", name));
    const probe = "require('https').get('https://" + GITHUB + "/ping',(r)=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))";
    let ready = false;
    for (let attempt = 0; attempt < 30 && !ready; attempt += 1) {
      ready = (await docker("run", "--rm", "--network", network, "--user", "1000:1000", "--env", "NODE_EXTRA_CA_CERTS=/ca/ca.pem", "--volume", `${caDirectory}:/ca:ro`, APP_NODE_IMAGE, "node", "-e", probe)).code === 0;
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    expect(ready, (await docker("logs", name)).stderr).toBe(true);
    return {
      network, token, caDirectory, packed,
      requests: async () => (await readFile(log, "utf8")).split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as RequestRow),
      clearRequests: async () => { await writeFile(log, ""); },
    };
  }

  // ---- fixtures for the two managers
  const dependency = (registry: FakeRegistry, key: keyof FakeRegistry["packed"]) => {
    const packed = registry.packed[key];
    const resolved: Record<typeof key, string> = {
      priv: `https://${GITHUB}/download/@acme/priv/1.0.0/abc`, redirected: `https://${GITHUB}/download/@acme/redirected/1.0.0/abc`,
      leftpad: "https://other-registry.test/leftpad/-/leftpad-1.0.0.tgz", ctl: "https://other-registry.test/@other/ctl/-/ctl-1.0.0.tgz",
    };
    return { ...packed, resolved: resolved[key] };
  };
  const POSTINSTALL = "node -e \"require('fs').writeFileSync('ran-postinstall','1')\"";
  function projectFiles(manager: "npm" | "yarn1", deps: Array<ReturnType<typeof dependency>>): Record<string, string> {
    const packageJson = JSON.stringify({ name: "app", version: "1.0.0", scripts: { postinstall: POSTINSTALL }, dependencies: Object.fromEntries(deps.map((dep) => [dep.name, "1.0.0"])) });
    if (manager === "npm") {
      const packages = Object.fromEntries(deps.map((dep) => [`node_modules/${dep.name}`, { version: "1.0.0", resolved: dep.resolved, integrity: dep.integrity }]));
      return { "package.json": packageJson, "package-lock.json": JSON.stringify({ name: "app", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "app", version: "1.0.0", dependencies: Object.fromEntries(deps.map((dep) => [dep.name, "1.0.0"])) }, ...packages } }, null, 2) };
    }
    const entries = deps.map((dep) => `"${dep.name}@1.0.0":\n  version "1.0.0"\n  resolved "${dep.resolved}#${dep.sha1}"\n  integrity ${dep.integrity}\n`);
    return { "package.json": packageJson, "yarn.lock": `# yarn lockfile v1\n\n\n${entries.join("\n")}` };
  }
  /** The install container's real arguments for `manager`, on the test network, with the throwaway CA trusted by an added mount and variable (the only change, and only here). */
  const installRun = (f: Awaited<ReturnType<typeof fixture>>, registry: FakeRegistry, manager: "npm" | "yarn1"): string[] => {
    const args = asRun(installContainerArgs({ ...f.input, manager }), registry.network);
    return [args[0]!, "--volume", `${registry.caDirectory}:/test-ca:ro`, "--env", "NODE_EXTRA_CA_CERTS=/test-ca/ca.pem", ...args.slice(1)];
  };
  const everyFileCarries = async (root: string, token: string): Promise<string[]> => {
    const forms = e2eSecretSpellings(token).filter((form) => form.length >= 6);
    const found: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile() && forms.some((form) => readFileSync(path).toString("latin1").includes(form))) found.push(path);
      }
    };
    await walk(root);
    return found;
  };

  describe.each(["npm", "yarn1"] as const)("with a fake HTTPS registry, %s", (manager) => {
    let registry: FakeRegistry;
    beforeAll(async () => { registry = await startFakeRegistry(); }, 300_000);

    it("T-HOST-1: the token goes to npm.pkg.github.com and to no other host (a second registry's package, a tarball redirect's target); a control that keys the token to the second host shows that host WOULD see it", async () => {
      await registry.clearRequests();
      const deps = [dependency(registry, "priv"), dependency(registry, "redirected"), dependency(registry, "leftpad")];
      const f = await fixture(projectFiles(manager, deps), { manager }, { token: registry.token });
      const installed = await docker(...installRun(f, registry, manager));
      expect(installed.code, `${installed.stdout}\n${installed.stderr}`).toBe(0);
      for (const name of ["@acme/priv", "@acme/redirected", "leftpad"]) expect((await stat(join(f.repository, "node_modules", name))).isDirectory(), name).toBe(true);
      const rows = await registry.requests();
      const own = rows.filter((row) => row.host === GITHUB);
      const elsewhere = rows.filter((row) => row.host !== GITHUB);
      // Positive controls: the supported host really was asked, with the token; the redirect really was followed; the second registry really was reached.
      expect(own.length).toBeGreaterThanOrEqual(2);
      expect(own.every((row) => row.auth === "token")).toBe(true);
      expect(elsewhere.map((row) => row.host).sort()).toEqual(["other-registry.test", "tarballs.test"]);
      // The guard: no other host saw an Authorization header, or the token anywhere in the request.
      expect(elsewhere.every((row) => row.auth === "none" && !row.tokenAnywhere), JSON.stringify(elsewhere)).toBe(true);

      // Control: the same token keyed to the second host (what a token line for the wrong host, or an unscoped one, would do) IS seen there, so the check above can fail.
      await registry.clearRequests();
      const control = await fixture(projectFiles(manager, [dependency(registry, "ctl")]), { manager }, {
        token: registry.token,
        npmrc: (value) => renderUserNpmrc(["@other"], value).replaceAll(GITHUB, "other-registry.test"),
        yarnrc: (value) => renderYarnrc(["@other"], value).replaceAll(GITHUB, "other-registry.test"),
      });
      const keyed = await docker(...installRun(control, registry, manager));
      expect(keyed.code, `${keyed.stdout}\n${keyed.stderr}`).toBe(0);
      const seen = (await registry.requests()).filter((row) => row.host === "other-registry.test");
      expect(seen.length).toBeGreaterThanOrEqual(1);
      expect(seen.every((row) => row.auth === "token")).toBe(true);
    }, 300_000);

    it("T-OFFLINE-1: after the install, the repository's own `install` in a sandbox with NO network and NO token succeeds from the cache and runs the root postinstall; without the cache variables it cannot", async () => {
      await registry.clearRequests();
      const deps = [dependency(registry, "priv"), dependency(registry, "redirected"), dependency(registry, "leftpad")];
      const f = await fixture(projectFiles(manager, deps), { manager }, { token: registry.token });
      const installed = await docker(...installRun(f, registry, manager));
      expect(installed.code, `${installed.stdout}\n${installed.stderr}`).toBe(0);
      // Scripts were off in the install container.
      await expect(stat(join(f.repository, "ran-postinstall"))).rejects.toThrow();
      // What the worker does once the scan is clean: the marker that turns the cache variables on for every sandbox command.
      await writeFile(join(f.root, PACKAGE_CACHE_DIRECTORY, PACKAGE_CACHE_MARKER), "installed\n");
      const cacheEnvironment = packageCacheEnvironment(f.root);
      expect(Object.keys(cacheEnvironment).sort()).toEqual(["YARN_CACHE_FOLDER", "npm_config_cache", "npm_config_prefer_offline"]);
      const command = manager === "npm" ? ["npm", "ci"] : ["yarn", "install", "--frozen-lockfile"];
      const sandbox = (environment: Record<string, string>, extra: string[] = []) => docker("run", "--rm", "--network", "none", "--user", "1000:1000", "--volume", `${f.root}:${f.root}`, "--workdir", f.repository, "--env", "HOME=/tmp",
        ...Object.entries(environment).flatMap(([name, value]) => ["--env", `${name}=${value}`]), APP_NODE_IMAGE, ...command, ...extra);

      // Control: the same command with no cache variables has nothing to install from and nowhere to download from.
      await removeTree(join(f.repository, "node_modules"));
      const without = await sandbox({ npm_config_fetch_retries: "0" }, manager === "npm" ? [] : ["--network-timeout", "3000"]);
      expect(without.code, "the control must fail without the cache").not.toBe(0);

      await removeTree(join(f.repository, "node_modules"));
      const requestsBefore = (await registry.requests()).length;
      const reinstalled = await sandbox(cacheEnvironment);
      expect(reinstalled.code, `${reinstalled.stdout}\n${reinstalled.stderr}`).toBe(0);
      expect((await stat(join(f.repository, "node_modules", "@acme", "priv"))).isDirectory()).toBe(true);
      // The scripts ran there, with no token anywhere.
      expect(await readFile(join(f.repository, "ran-postinstall"), "utf8")).toBe("1");
      expect(await everyFileCarries(f.root, registry.token)).toEqual([]);
      // And no request reached the registry from the sandbox: it has no network, and the registry's log did not grow.
      expect((await registry.requests()).length).toBe(requestsBefore);
    }, 400_000);
  });
});
