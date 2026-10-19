import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installedExecutorSeccompProfilePath } from "../../packages/verifier/src/host/executor-seccomp.js";
import { executorContainerArgs } from "../../packages/verifier/src/host/executor-container.js";
import { executorSmokeDockerArgs, explainExecutorSmokeFailure, repoExecutorSeccompProfilePath } from "../../scripts/executor-smoke.js";
import { smokeTestExecutor, type Runner } from "../../scripts/release-common.js";

const dirs: string[] = [];
afterAll(async () => { await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))); });

/** A runner that records the docker command and answers with a canned result; nothing is executed. */
function recordingRunner(result: { status: number; stdout?: string; stderr?: string }) {
  const calls: { command: string; args: readonly string[] }[] = [];
  const runner = { capture(command: string, args: readonly string[]) { calls.push({ command, args }); return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }; } } as unknown as Runner;
  return { runner, calls };
}

describe("the executor image smoke command", () => {
  it("runs the executor the way the host does: sandbox profile, no capability, read-only, no network", () => {
    const args = executorSmokeDockerArgs("rovara-e2e-executor:ci");
    const optionValues = (name: string) => args.filter((value, index) => args[index - 1] === name);
    expect(args.slice(0, 2)).toEqual(["run", "--rm"]);
    expect(args).toEqual(expect.arrayContaining(["--init", "--network", "none", "--cap-drop=ALL", "--read-only", "--shm-size", "1g"]));
    expect(optionValues("--security-opt")).toEqual(["no-new-privileges", `seccomp=${repoExecutorSeccompProfilePath()}`]);
    expect(optionValues("--tmpfs")).toEqual(["/tmp:rw,exec,nosuid,nodev,size=512m"]);
    expect(args.slice(-3)).toEqual(["rovara-e2e-executor:ci", "node", "/opt/agentx/packages/verifier/dist/executor/smoke.js"]);
    expect(args.join(" ")).not.toMatch(/--privileged|--cap-add|seccomp=unconfined|--no-sandbox/);
  });

  it("carries the executor container's own sandbox and limit flags, from the one definition the Docker host builds its executor command from", () => {
    const args = executorSmokeDockerArgs("image");
    const shared = executorContainerArgs(repoExecutorSeccompProfilePath());
    // The shared flags appear in order and unchanged (the limits 2g/1024/2 included); only network, run-and-remove and the command are the smoke test's own.
    const start = args.indexOf(shared[0]!);
    expect(args.slice(start, start + shared.length)).toEqual(shared);
    expect(shared).toEqual(expect.arrayContaining(["--memory", "2g", "--pids-limit", "1024", "--cpus", "2"]));
    expect(args.slice(0, start)).toEqual(["run", "--rm", "--network", "none"]);
  });

  it("points at the pinned profile in this checkout, which is the one the worker image ships", () => {
    expect(repoExecutorSeccompProfilePath()).toBe(installedExecutorSeccompProfilePath());
  });

  it("refuses a profile whose digest differs from the pin, and one that is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "smoke-profile-")); dirs.push(dir);
    const changed = join(dir, "profile.json");
    await writeFile(changed, `${await readFile(repoExecutorSeccompProfilePath(), "utf8")} `);
    expect(() => executorSmokeDockerArgs("image", changed)).toThrow(/executor-seccomp-profile-digest-mismatch/);
    expect(() => executorSmokeDockerArgs("image", join(dir, "absent.json"))).toThrow(/executor-seccomp-profile-unreadable/);
  });
});

describe("the release path's executor smoke test", () => {
  // The release path echoes the smoke run's stderr for the operator; keep the test output pristine.
  beforeEach(() => { vi.spyOn(process.stderr, "write").mockImplementation(() => true); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("runs exactly that command through docker", async () => {
    const { runner, calls } = recordingRunner({ status: 0 });
    await smokeTestExecutor(runner, "executor:local");
    expect(calls).toEqual([{ command: "docker", args: executorSmokeDockerArgs("executor:local") }]);
  });

  it("explains a sandbox that could not start in this Docker VM, without any way around it", async () => {
    const stderr = "chromium smoke failed: chromium exited before it opened a debugging port: FATAL:zygote_host_impl_linux.cc: No usable sandbox!\n";
    const { runner } = recordingRunner({ status: 1, stderr });
    const error = await smokeTestExecutor(runner, "executor:local").then(() => null, (reason: unknown) => reason as Error);
    expect(error?.message).toMatch(/Chromium's sandbox could not start in this Docker VM/);
    expect(error?.message).toContain("kernel.apparmor_restrict_unprivileged_userns=0");
    expect(error?.message).toContain("colima ssh -- sudo sysctl -w");
    expect(error?.message).toMatch(/never runs Chromium with --no-sandbox/);
    expect(error?.message).not.toMatch(/(?:run|use|pass|add) --no-sandbox/);
  });

  it("matches on stdout as well as stderr", async () => {
    const { runner } = recordingRunner({ status: 1, stdout: "FATAL: No usable sandbox!\n", stderr: "" });
    await expect(smokeTestExecutor(runner, "executor:local")).rejects.toThrow(/Chromium's sandbox could not start in this Docker VM/);
  });

  it("does not blame the sandbox for an early exit alone: it says probably the sandbox, or another early crash", () => {
    const text = explainExecutorSmokeFailure("chromium smoke failed: chromium exited before it opened a debugging port: segfault")!;
    expect(text).toMatch(/probably its sandbox, or another early crash/);
    expect(text).not.toMatch(/sandbox could not start in this Docker VM/);
    expect(text).toContain("kernel.apparmor_restrict_unprivileged_userns=0");
  });

  it("keeps the plain failure for a smoke test that failed for another reason", async () => {
    const { runner } = recordingRunner({ status: 1, stderr: "chromium smoke failed: unexpected page text: nope\n" });
    await expect(smokeTestExecutor(runner, "executor:local")).rejects.toThrow("executor image smoke test failed");
  });

  it("recognises the sandbox failures Chromium and the smoke check report", () => {
    for (const text of ["No usable sandbox!", "Failed to move to new namespace: PID namespaces supported", "chromium exited before it opened a debugging port: x", "chromium is not sandboxed: renderer-has-no-extra-seccomp-filter"]) {
      expect(explainExecutorSmokeFailure(text), text).not.toBeNull();
    }
    expect(explainExecutorSmokeFailure("unexpected page text: nope")).toBeNull();
  });
});
