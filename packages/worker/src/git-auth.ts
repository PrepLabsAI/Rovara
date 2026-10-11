import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gitHardenedEnvironment } from "./git.js";

const execFileAsync = promisify(execFile);

export interface GitCredential {
  username?: string;
  password?: string;
  token?: string;
}

/** How a credentialed Git command is run; a seam for tests, which see its environment. */
export type CredentialedGitRunner = (
  args: readonly string[],
  options: { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv; cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

const runGit: CredentialedGitRunner = (args, options) =>
  execFileAsync("git", [...args], { ...options, encoding: "utf8" });

/**
 * Runs Git with a repository credential. The password is never put in any process's environment: it is written to a
 * file only this user can read, in a directory made for this call, and the askpass helper Git starts prints it from
 * there. So no process Git starts (its remote helper, a proxy or SSH command) inherits it. The directory is removed
 * when the command ends.
 */
export async function runGitWithCredential(input: {
  directory: string;
  args: readonly string[];
  credential?: GitCredential;
  timeout?: number;
  maxBuffer?: number;
  cwd?: string;
  run?: CredentialedGitRunner;
}): Promise<{ stdout: string; stderr: string }> {
  assertNonForceGitArguments(input.args);
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
    const environment = await gitHardenedEnvironment(input.directory, {}, { network: true });
    environment.GIT_TERMINAL_PROMPT = "0";
    if (askPassDirectory && username && password) {
      const askPassPath = join(askPassDirectory, "askpass.sh");
      const passwordPath = join(askPassDirectory, "password");
      await writeFile(passwordPath, `${password}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await writeFile(
        askPassPath,
        "#!/bin/sh\ncase \"$1\" in\n  *Username*) printf '%s\\n' \"$AGENTX_GIT_USERNAME\" ;;\n  *Password*) cat -- \"$AGENTX_GIT_PASSWORD_FILE\" ;;\n  *) exit 1 ;;\nesac\n",
        { encoding: "utf8", mode: 0o700, flag: "wx" },
      );
      Object.assign(environment, {
        GIT_ASKPASS: askPassPath,
        AGENTX_GIT_USERNAME: username,
        AGENTX_GIT_PASSWORD_FILE: passwordPath,
      });
    }
    return await (input.run ?? runGit)(input.args, {
      timeout: input.timeout ?? 300_000,
      maxBuffer: input.maxBuffer ?? 1_048_576,
      env: environment,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    });
  } finally {
    if (askPassDirectory) await rm(askPassDirectory, { recursive: true, force: true });
  }
}

/**
 * Pushes one commit, by its ID, to `url`'s `branch` from a bare repository AgentX makes for this push alone, whose
 * object store borrows the workspace's (objects/info/alternates). The credentialed command never reads the workspace's
 * own `.git/config`, hooks or attributes, so nothing the agent or a project command wrote there (a push URL, an
 * `insteadOf` rewrite, a hook, a transport), whenever it was written, can redirect the push or see the token. Objects
 * are content-addressed and the remote checks each one it receives, so the borrowed store cannot change what the
 * commit holds. The temporary repository is removed when the push ends.
 */
export async function pushCommitFromIsolatedRepository(input: {
  objectsDirectory: string;
  url: string;
  commit: string;
  branch: string;
  credential?: GitCredential;
  timeout?: number;
  maxBuffer?: number;
  run?: CredentialedGitRunner;
}): Promise<{ stdout: string; stderr: string }> {
  assertCredentialFreeRemote(input.url);
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(input.commit)) throw new Error("the commit to push must be a full object ID");
  if (!/^[A-Za-z0-9._/-]{1,255}$/u.test(input.branch) || input.branch.includes("..") || input.branch.startsWith("-")) {
    throw new Error("the branch to push is not a valid branch name");
  }
  const temporary = await mkdtemp(join(tmpdir(), "agentx-push-"));
  try {
    const gitDirectory = join(temporary, "repository.git");
    // No template: the repository starts with no hooks, and only the config Git itself writes.
    await execFileAsync("git", ["init", "--bare", "--quiet", "--template=", gitDirectory], {
      cwd: temporary, encoding: "utf8", timeout: 60_000, env: await gitHardenedEnvironment(gitDirectory),
    });
    await mkdir(join(gitDirectory, "objects", "info"), { recursive: true });
    await writeFile(join(gitDirectory, "objects", "info", "alternates"), `${input.objectsDirectory}\n`, { encoding: "utf8", mode: 0o600 });
    return await runGitWithCredential({
      directory: gitDirectory,
      args: ["--git-dir", gitDirectory, "push", "--porcelain", input.url, `${input.commit}:refs/heads/${input.branch}`],
      cwd: temporary,
      ...(input.credential === undefined ? {} : { credential: input.credential }),
      ...(input.timeout === undefined ? {} : { timeout: input.timeout }),
      ...(input.maxBuffer === undefined ? {} : { maxBuffer: input.maxBuffer }),
      ...(input.run === undefined ? {} : { run: input.run }),
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export function assertNonForceGitArguments(args: readonly string[]): void {
  const pushIndex = args.indexOf("push");
  if (pushIndex < 0) return;
  const forceArgument = args.slice(pushIndex + 1).some((argument) =>
    argument === "-f" ||
    argument === "--force" ||
    argument.startsWith("--force=") ||
    argument === "--force-with-lease" ||
    argument.startsWith("--force-with-lease=") ||
    argument.startsWith("+") ||
    argument.includes(":+refs/"),
  );
  if (forceArgument) throw new Error("force push is forbidden");
}

export function assertCredentialFreeRemote(value: string): void {
  const url = new URL(value);
  if (url.username || url.password) {
    throw new Error("repository remote URL must not contain credentials");
  }
}
