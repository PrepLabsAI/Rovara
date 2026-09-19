import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gitSafeEnvironment } from "./git.js";

const execFileAsync = promisify(execFile);

export interface GitCredential {
  username?: string;
  password?: string;
  token?: string;
}

export async function runGitWithCredential(input: {
  directory: string;
  args: readonly string[];
  credential?: GitCredential;
  timeout?: number;
  maxBuffer?: number;
}): Promise<{ stdout: string; stderr: string }> {
  const credential = input.credential ?? {};
  const username = credential.username ?? (credential.token === undefined ? undefined : "x-access-token");
  const password = credential.password ?? credential.token;
  if ((username === undefined) !== (password === undefined)) {
    throw new Error("repository credential must include both username and password");
  }

  const askPassDirectory = username === undefined
    ? undefined
    : await mkdtemp(join(tmpdir(), "agentx-git-askpass-"));
  try {
    const environment = gitSafeEnvironment(input.directory);
    environment.GIT_TERMINAL_PROMPT = "0";
    if (askPassDirectory && username && password) {
      const askPassPath = join(askPassDirectory, "askpass.sh");
      await writeFile(
        askPassPath,
        "#!/bin/sh\ncase \"$1\" in\n  *Username*) printf '%s\\n' \"$AGENTX_GIT_USERNAME\" ;;\n  *Password*) printf '%s\\n' \"$AGENTX_GIT_PASSWORD\" ;;\n  *) exit 1 ;;\nesac\n",
        { encoding: "utf8", mode: 0o700, flag: "wx" },
      );
      Object.assign(environment, {
        GIT_ASKPASS: askPassPath,
        AGENTX_GIT_USERNAME: username,
        AGENTX_GIT_PASSWORD: password,
      });
    }
    return await execFileAsync("git", [...input.args], {
      timeout: input.timeout ?? 300_000,
      maxBuffer: input.maxBuffer ?? 1_048_576,
      encoding: "utf8",
      env: environment,
    });
  } finally {
    if (askPassDirectory) await rm(askPassDirectory, { recursive: true, force: true });
  }
}

export function assertCredentialFreeRemote(value: string): void {
  const url = new URL(value);
  if (url.username || url.password) {
    throw new Error("repository remote URL must not contain credentials");
  }
}
