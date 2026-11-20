import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executorSmokeDockerArgs, explainExecutorSmokeFailure, repoExecutorSeccompProfilePath } from "../../scripts/executor-smoke.js";

const dirs: string[] = [];
afterAll(async () => { await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))); });

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

  it("does not blame the sandbox for an early exit alone: it says probably the sandbox, or another early crash", () => {
    const text = explainExecutorSmokeFailure("chromium smoke failed: chromium exited before it opened a debugging port: segfault")!;
    expect(text).toMatch(/probably its sandbox, or another early crash/);
    expect(text).not.toMatch(/sandbox could not start in this Docker VM/);
    expect(text).toContain("kernel.apparmor_restrict_unprivileged_userns=0");
  });

  it("recognises the sandbox failures Chromium and the smoke check report", () => {
    for (const text of ["No usable sandbox!", "Failed to move to new namespace: PID namespaces supported", "chromium exited before it opened a debugging port: x", "chromium is not sandboxed: renderer-has-no-extra-seccomp-filter"]) {
      expect(explainExecutorSmokeFailure(text), text).not.toBeNull();
    }
    expect(explainExecutorSmokeFailure("unexpected page text: nope")).toBeNull();
  });
});
