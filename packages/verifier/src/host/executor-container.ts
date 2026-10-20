/**
 * The executor container's own sandbox and resource flags: every capability dropped, no new privileges, the pinned seccomp profile (Chromium's own sandbox
 * needs it), tini as PID 1, a read-only root with a `/tmp` tmpfs and a shared-memory size, and the memory, process and CPU limits. The Docker host starts the
 * executor with exactly these, and the executor image's smoke test (scripts/executor-smoke.ts, used by the release path, test-deploy and CI) runs with the
 * same ones, so what is tested is how the executor really runs. `seccompProfile` is a path the Docker CLI reads on the machine that runs it.
 */
export function executorContainerArgs(seccompProfile: string): string[] {
  return ["--cap-drop=ALL", "--security-opt", "no-new-privileges", "--security-opt", `seccomp=${seccompProfile}`,
    "--init", "--read-only", "--shm-size", "1g", "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=512m",
    "--memory", "2g", "--memory-swap", "2g", "--pids-limit", "1024", "--cpus", "2"];
}
