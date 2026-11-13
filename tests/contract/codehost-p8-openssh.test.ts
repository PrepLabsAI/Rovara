// Enterprise foundations P8: real OpenSSH host-key pinning. A throwaway sshd on 127.0.0.1 (this user, a port the OS picked, keys made here and thrown away) serves a bare repository; the
// worker's credentialed git clones from it with the pinned host key, and refuses the same server when the pinned key is another one. Skipped, with the reason, where sshd, ssh or git
// cannot be run (no sshd binary, the sandbox refuses it, or it does not start): the stand-in-ssh tests in codehost-p8-credential-kinds.test.ts cover the rest everywhere.
import { execFile as execFileCallback, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SshCredentialMaterialSchema } from "@rovara-code/contracts";
import { runGitWithCredential } from "../../packages/worker/src/git-auth.js";

const execFile = promisify(execFileCallback);
const SSHD = ["/usr/sbin/sshd", "/usr/local/sbin/sshd", "/opt/homebrew/sbin/sshd"].find((path) => existsSync(path));
const HTTPS = "https://git.example.invalid/acme/app.git";

let skipReason: string | undefined = SSHD === undefined ? "no sshd binary on this machine" : undefined;
let root = "";
let server: ChildProcess | undefined;
let port = 0;
let bare = "";
let head = "";
let hostKeyLine = "";
let clientKey = "";

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const { port: chosen } = probe.address() as { port: number }; probe.close(() => resolve(chosen)); });
});
const canConnect = (to: number): Promise<boolean> => new Promise((resolve) => {
  import("node:net").then(({ connect }) => {
    const socket = connect(to, "127.0.0.1");
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  }, () => resolve(false));
});

beforeAll(async () => {
  if (skipReason !== undefined) return;
  try {
    root = await mkdtemp(join(tmpdir(), "agentx-p8-sshd-"));
    const keygen = async (name: string) => { await execFile("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "p8-test", "-f", join(root, name)]); };
    await keygen("host");
    await keygen("client");
    await keygen("other-host");
    clientKey = await readFile(join(root, "client"), "utf8");
    await writeFile(join(root, "authorized_keys"), await readFile(join(root, "client.pub"), "utf8"), { mode: 0o600 });
    port = await freePort();
    await writeFile(join(root, "sshd_config"), [
      `Port ${String(port)}`, "ListenAddress 127.0.0.1", `HostKey ${join(root, "host")}`, `AuthorizedKeysFile ${join(root, "authorized_keys")}`, `PidFile ${join(root, "sshd.pid")}`,
      "UsePAM no", "PasswordAuthentication no", "KbdInteractiveAuthentication no", "PubkeyAuthentication yes", "StrictModes no", "LogLevel ERROR",
    ].join("\n"));
    const work = join(root, "work");
    await mkdir(work, { recursive: true });
    const git = (...args: string[]) => execFile("git", ["-C", work, "-c", "user.email=a@example.invalid", "-c", "user.name=A", "-c", "init.defaultBranch=main", ...args]);
    await git("init", "--quiet");
    await writeFile(join(work, "README.md"), "hello\n");
    await git("add", ".");
    await git("commit", "--quiet", "-m", "first");
    bare = join(root, "app.git");
    await execFile("git", ["clone", "--quiet", "--bare", work, bare]);
    head = (await git("rev-parse", "HEAD")).stdout.trim();
    const hostPublic = (await readFile(join(root, "host.pub"), "utf8")).split(" ").slice(0, 2).join(" ");
    hostKeyLine = `[127.0.0.1]:${String(port)} ${hostPublic}`;
    server = spawn(SSHD!, ["-D", "-e", "-f", join(root, "sshd_config")], { stdio: "ignore" });
    let exited = false;
    server.once("exit", () => { exited = true; });
    for (let attempt = 0; attempt < 50 && !exited && !(await canConnect(port)); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    if (exited || !(await canConnect(port))) skipReason = "sshd did not start here (not permitted for this user or sandbox)";
  } catch (error) {
    skipReason = `could not set up a local sshd: ${error instanceof Error ? error.message.split("\n")[0] : "unknown error"}`;
  }
}, 60_000);

afterAll(async () => {
  server?.kill();
  if (root !== "") await rm(root, { recursive: true, force: true });
});

describe("OpenSSH pins the host key the credential carries", () => {
  const credentialFor = (knownHosts: string) => {
    const material = { privateKey: clientKey, url: `ssh://${userInfo().username}@127.0.0.1:${String(port)}${bare}`, knownHosts };
    // The same rules the broker and the worker apply to it before git runs.
    expect(SshCredentialMaterialSchema.safeParse(material).success).toBe(true);
    return { ssh: { ...material, forUrl: HTTPS } };
  };
  const cloneInto = async (name: string, knownHosts: string) => {
    const destination = join(root, name, "app");
    await mkdir(join(root, name), { recursive: true });
    return { destination, run: () => runGitWithCredential({ directory: destination, args: ["clone", "--quiet", "--no-checkout", "--", HTTPS, destination], credential: credentialFor(knownHosts), timeout: 30_000 }) };
  };

  it("clones when the pinned key is the server's, with the clone's remote still the registered https address", async (context) => {
    if (skipReason !== undefined) context.skip();
    vi.stubEnv("HOME", join(root, "home"));
    const { destination, run } = await cloneInto("good", hostKeyLine);
    await run();
    expect((await execFile("git", ["-C", destination, "rev-parse", "origin/main"])).stdout.trim()).toBe(head);
    expect((await execFile("git", ["-C", destination, "remote", "get-url", "origin"])).stdout.trim()).toBe(HTTPS);
    vi.unstubAllEnvs();
  }, 60_000);

  it("refuses the same server when the pinned key is another one: nothing is cloned and the failure is the host key's", async (context) => {
    if (skipReason !== undefined) context.skip();
    vi.stubEnv("HOME", join(root, "home"));
    const otherPublic = (await readFile(join(root, "other-host.pub"), "utf8")).split(" ").slice(0, 2).join(" ");
    const { destination, run } = await cloneInto("wrong", `[127.0.0.1]:${String(port)} ${otherPublic}`);
    const failure = await run().then(() => undefined, (error: Error & { stderr?: string }) => error);
    expect(failure).toBeDefined();
    expect(`${failure?.message ?? ""}${failure?.stderr ?? ""}`).toMatch(/host key verification failed|REMOTE HOST IDENTIFICATION/i);
    expect(existsSync(join(destination, ".git"))).toBe(false);
    vi.unstubAllEnvs();
  }, 60_000);
});
