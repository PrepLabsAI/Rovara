// Port lane L4: the Docker command line, as a seam. The adapter never builds a shell string: every call is `docker` plus an
// argument list, run without a shell.
import { execFile } from "node:child_process";

export interface DockerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface DockerRunner {
  run(args: readonly string[], options?: { timeoutMs?: number }): Promise<DockerResult>;
}

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export function createDockerRunner(environment: NodeJS.ProcessEnv = process.env): DockerRunner {
  return {
    run(args, options = {}) {
      return new Promise((resolve) => {
        execFile("docker", [...args], { env: environment, timeout: options.timeoutMs ?? 60_000, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true }, (error, stdout, stderr) => {
          if (error === null) return resolve({ exitCode: 0, stdout, stderr });
          const code = (error as NodeJS.ErrnoException & { code?: number | string }).code;
          // ENOENT: no docker program at all. A killed (timed out) call has no numeric code.
          resolve({ exitCode: typeof code === "number" ? code : -1, stdout, stderr: code === "ENOENT" ? "docker is not installed" : stderr || error.message });
        });
      });
    },
  };
}
