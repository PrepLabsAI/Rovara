import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { builtinFileCheckCommand } from "@agentx/contracts";
import { createProcessDockerCli } from "../../packages/verifier/src/host/docker-application-host.js";
import { planDryRunSandboxArgs, runPlanDryRun } from "../../packages/worker/src/plan-dry-run.js";
import { docker, listenOnAllAddresses, reachScript } from "../support/linux-network-walls.js";

// PLANDRYRUN with real Docker: the sandbox a planning worker runs model-written checks in. It runs only in the CI `linux-runtime` job (ROVARA_DOCKER=1, ROVARA_EXECUTOR_IMAGE, with the
// container firewall from boot.sh applied); elsewhere it skips. Every claim is shown against a control, so a pass is the sandbox and not a broken test.
const IMAGE = process.env.ROVARA_EXECUTOR_IMAGE ?? "rovara-e2e-executor:ci";
const SECRET = "PLANTED-WORKER-SECRET-4c1d9e";
const REPO = "orders";

describe.runIf(process.platform === "linux" && process.env.ROVARA_DOCKER === "1")("the plan dry-run sandbox, on real Docker", () => {
  const folders: string[] = [];
  let source: string;
  let listener: Awaited<ReturnType<typeof listenOnAllAddresses>>;
  const cli = createProcessDockerCli();
  let counter = 0;

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), "plan-dry-run-linux-"));
    folders.push(root);
    // The export as the worker writes it: world-readable files and folders, owned by the worker's user (not uid 1000 on a CI runner).
    source = join(root, "src");
    mkdirSync(join(source, "src"), { recursive: true });
    writeFileSync(join(source, "src/app.js"), "export const flag = 'BASE-TOKEN';\n", { mode: 0o644 });
    writeFileSync(join(source, "keep.txt"), "kept\n", { mode: 0o644 });
    // Writable to everyone on purpose: the only thing that stops the sandbox's user from writing is then the read-only mount, which the control below removes.
    chmodSync(source, 0o777);
    chmodSync(join(source, "keep.txt"), 0o666);
    listener = await listenOnAllAddresses();
  }, 120_000);
  afterAll(async () => {
    listener?.server.close();
    await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
  });

  /** The sandbox's own `docker run` arguments, for any command, with `extra` options placed before the image. */
  async function inSandbox(executable: string, args: string[], options: { cwd?: string; mutate?: (docker: string[]) => string[] } = {}): Promise<number> {
    counter += 1;
    const built = planDryRunSandboxArgs({ name: `rovara-plan-dry-linux-${process.pid}-${counter}`, runId: `pdr-linux-${process.pid}`, createdAt: Date.now(), image: IMAGE, source, repositoryPath: REPO,
      cwd: options.cwd ?? REPO, executable, args });
    const run = options.mutate === undefined ? built : options.mutate(built);
    return (await cli.run(run, { signal: new AbortController().signal, timeoutMs: 60_000 })).code;
  }
  const shell = (script: string, options?: Parameters<typeof inSandbox>[2]) => inSandbox("sh", ["-c", script], options);
  /** The same container with the one protection under test taken away: the control. */
  const without = (flag: string, replacement: string[] = []) => (run: string[]) => {
    const at = run.indexOf(flag);
    return [...run.slice(0, at), ...replacement, ...run.slice(at + (replacement.length === 0 ? 1 : 2))];
  };

  it("runs as an unprivileged user with no capabilities and no new privileges", async () => {
    expect(await shell('test "$(id -u)" = 1000')).toBe(0);
    expect(await shell("grep -q '^CapEff:[[:space:]]*0000000000000000' /proc/self/status")).toBe(0);
    expect(await shell("grep -q '^NoNewPrivs:[[:space:]]*1' /proc/self/status")).toBe(0);
    // Control: the check itself can fail.
    expect(await shell('test "$(id -u)" = 0')).not.toBe(0);
  }, 120_000);

  it("has no network: nothing is reachable, though the same connection from a container on the default bridge reaches the host", async () => {
    const script = reachScript([["gateway", listener.port]]);
    const control = await docker("run", "--rm", "--pull=never", "--cap-drop=ALL", "--user", "1000:1000", IMAGE, "node", "-e", script);
    expect(control.stdout.trim(), `control: ${control.stderr}`).toBe('["open"]');
    // No default route in a container without a network: a literal address is tried, and it must not connect.
    const connects = (host: string, port: number) => `require('net').connect({host:'${host}',port:${port},timeout:3000}).on('connect',()=>process.exit(0)).on('timeout',()=>process.exit(7)).on('error',()=>process.exit(8))`;
    expect(await inSandbox("node", ["-e", connects("10.0.0.1", listener.port)])).not.toBe(0);
    expect(await inSandbox("node", ["-e", connects("1.1.1.1", 443)])).not.toBe(0);
    const interfaces = await inSandbox("sh", ["-c", "test \"$(ls /sys/class/net | tr -d '\\n')\" = lo"]);
    expect(interfaces).toBe(0);
  }, 120_000);

  it("cannot write to the base export or to the image (a folder the user owns), only to its small /tmp", async () => {
    expect(await shell(`touch /work/${REPO}/new-file.txt`)).not.toBe(0);
    expect(existsSync(join(source, "new-file.txt"))).toBe(false);
    expect(await shell(`echo changed > /work/${REPO}/keep.txt`)).not.toBe(0);
    expect(await shell("touch /home/node/root-file")).not.toBe(0);
    expect(await shell("touch /tmp/ok-file")).toBe(0);
    // Controls: with the protections taken away the very same writes succeed, so the failures above are the sandbox.
    expect(await shell(`touch /work/${REPO}/new-file.txt`, { mutate: (run) => { const at = run.indexOf("-v"); return [...run.slice(0, at), "-v", `${source}:/work/${REPO}`, ...run.slice(at + 2)]; } })).toBe(0);
    expect(await shell("touch /home/node/root-file", { mutate: without("--read-only") })).toBe(0);
    execFileSync("rm", ["-f", join(source, "new-file.txt")]);
  }, 120_000);

  it("reads the export as uid 1000, from the checked folder, and sees nothing of the worker", async () => {
    expect(await shell("grep -q BASE-TOKEN src/app.js", { cwd: REPO })).toBe(0);
    expect(await shell("grep -q kept keep.txt", { cwd: REPO })).toBe(0);
    expect(await shell("test -f app.js && grep -q BASE-TOKEN app.js", { cwd: `${REPO}/src` })).toBe(0);
    expect(await shell('test "$(ls /work)" = orders')).toBe(0);
  }, 120_000);

  it("holds none of the worker's environment, no Docker socket and no Docker CLI", async () => {
    process.env.AWS_SECRET_ACCESS_KEY = SECRET;
    process.env.AGENTX_CALLBACK_TOKEN = SECRET;
    try {
      expect(await shell(`! env | grep -q ${SECRET} && ! env | grep -qE 'AWS_|AGENTX_|TOKEN|SECRET'`)).toBe(0);
      // Control: a variable passed on purpose is visible, so the grep above can see a secret.
      expect(await shell(`env | grep -q ${SECRET}`, { mutate: (run) => { const at = run.indexOf("--entrypoint"); return [...run.slice(0, at), "-e", "AWS_SECRET_ACCESS_KEY", ...run.slice(at)]; } })).toBe(0);
    } finally {
      delete process.env.AWS_SECRET_ACCESS_KEY;
      delete process.env.AGENTX_CALLBACK_TOKEN;
    }
    expect(await shell("! test -e /var/run/docker.sock && ! test -e /run/docker.sock && ! command -v docker")).toBe(0);
    // Control: the daemon's socket would be there if it had been mounted.
    expect(await shell("test -S /var/run/docker.sock", { mutate: (run) => { const at = run.indexOf("--entrypoint"); return [...run.slice(0, at), "-v", "/var/run/docker.sock:/var/run/docker.sock", ...run.slice(at)]; } })).toBe(0);
  }, 120_000);

  it("runs a plan's checks end to end: built-in and grep checks get their real classes, others are not tried, and the container and folder are gone after", async () => {
    const root = mkdtempSync(join(tmpdir(), "plan-dry-run-linux-e2e-"));
    folders.push(root);
    const repo = join(root, "ws", REPO);
    mkdirSync(join(repo, "src"), { recursive: true });
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "src/app.js"), "export const flag = 'BASE-TOKEN';\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    const baseCommitSha = git("rev-parse", "HEAD");
    const runRoot = join(root, "candidates", "web-api-runs");
    const check = (executable: string, args: string[], cwd = REPO) => ({ command: { cwd, executable, args, timeoutSeconds: 60 } });
    const builtin = (kind: "file-contains" | "file-not-contains", path: string, text: string) => ({ command: { ...builtinFileCheckCommand({ kind, cwd: REPO, path, text }), timeoutSeconds: 60 } });
    const report = await runPlanDryRun({
      planText: "plan", repositoryPath: REPO, repositories: [{ repositoryId: REPO, directory: repo, baseCommitSha }], signal: AbortSignal.timeout(110_000),
      config: { executorImage: IMAGE, runRoot },
      checks: [builtin("file-contains", "src/app.js", "BASE-TOKEN"), builtin("file-not-contains", "src/app.js", "BASE-TOKEN"), builtin("file-contains", "src/new.js", "x"),
        check("grep", ["-q", "BASE-TOKEN", "src/app.js"]), check("grep", ["-q", "x", "src/missing.js"]), check("grep", ["-q", "-E", "(", "src/app.js"]), check("npm", ["test"])],
    });
    expect(report.status).toBe("COMPLETE");
    if (report.status !== "COMPLETE") return;
    expect(report.checks.map((entry) => entry.class)).toEqual(["passed", "failed", "failed", "passed", "failed", "broken", "not-checked"]);
    const leftovers = await docker("ps", "-a", "--filter", "name=rovara-plan-dry-pdr-", "--format", "{{.Names}}");
    expect(leftovers.stdout.trim()).toBe("");
    expect(existsSync(join(root, "candidates", "plan-dry-runs")) ? execFileSync("ls", [join(root, "candidates", "plan-dry-runs")], { encoding: "utf8" }).trim() : "").toBe("");
  }, 180_000);
});
