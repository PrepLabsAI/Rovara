import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gitHardenedEnvironment } from "./git.js";
import { makeWorkerScratch } from "./worker-scratch.js";

const execFileAsync = promisify(execFile);

export interface GitCredential {
  username?: string;
  password?: string;
  token?: string;
  /** An ssh key (P8): git talks to `url` (ssh://) wherever it was told to use `forUrl` (the registered https address), pinned to `knownHosts`. */
  ssh?: { privateKey: string; url: string; knownHosts: string; forUrl: string };
}

let sshProgram = "ssh";
/** Test seam: the program git runs as ssh, so a test can stand in a local "server". Returns the undo. */
export function useSshProgramForTests(program: string): () => void {
  const previous = sshProgram;
  sshProgram = program;
  return () => {
    sshProgram = previous;
  };
}

const shellQuote = (value: string): string => `'${value.replace(/'/gu, "'\\''")}'`;

/**
 * The ssh the credentialed git command runs: only this key, only the pinned host keys (an unknown or changed host is refused, never asked about), no agent, no config file, no
 * forwarding, no proxy, no multiplexing, no password. It is a string for GIT_SSH_COMMAND, which names files and holds no secret.
 */
function sshCommand(keyPath: string, knownHostsPath: string): string {
  const options = [
    "-F", "/dev/null", "-i", keyPath,
    "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${knownHostsPath}`, "-o", "GlobalKnownHostsFile=/dev/null",
    "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no", "-o", "ForwardAgent=no", "-o", "ForwardX11=no",
    "-o", "ClearAllForwardings=yes", "-o", "ProxyCommand=none", "-o", "ProxyJump=none", "-o", "PermitLocalCommand=no",
    "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ConnectTimeout=30",
  ];
  return [sshProgram, ...options].map(shellQuote).join(" ");
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
  /** Extra variables for the Git process (such as GIT_OBJECT_DIRECTORY for a throwaway repository), under the hardening. */
  environment?: Readonly<Record<string, string>>;
}): Promise<{ stdout: string; stderr: string }> {
  assertNonForceGitArguments(input.args);
  const credential = input.credential ?? {};
  const username = credential.username ?? (credential.token === undefined ? undefined : "x-access-token");
  const password = credential.password ?? credential.token;
  if ((username === undefined) !== (password === undefined)) {
    throw new Error("repository credential must include both username and password");
  }
  // An ssh key is the whole credential: next to a password it would be two ways in, and which one git used would depend on the server.
  if (credential.ssh !== undefined && username !== undefined) throw new Error("repository credential must be an ssh key or a password, not both");

  const askPassDirectory = username === undefined && credential.ssh === undefined
    ? undefined
    : await makeWorkerScratch("agentx-git-askpass-");
  try {
    const environment = await gitHardenedEnvironment(input.directory, { ...input.environment }, { network: true });
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
    if (askPassDirectory && credential.ssh) {
      const keyPath = join(askPassDirectory, "key");
      const knownHostsPath = join(askPassDirectory, "known_hosts");
      await writeFile(keyPath, credential.ssh.privateKey.endsWith("\n") ? credential.ssh.privateKey : `${credential.ssh.privateKey}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await writeFile(knownHostsPath, `${credential.ssh.knownHosts.trim()}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      environment.GIT_SSH_COMMAND = sshCommand(keyPath, knownHostsPath);
      // No agent, no askpass: the key above is the only way in.
      delete environment.SSH_AUTH_SOCK;
      delete environment.SSH_ASKPASS;
      // The registered https address is the one every caller passes; the ssh address is used in its place for this command alone, so the clone's remote stays the https one.
      const count = Number(environment.GIT_CONFIG_COUNT ?? "0");
      const extra: ReadonlyArray<readonly [string, string]> = [["protocol.ssh.allow", "always"], [`url.${credential.ssh.url}.insteadOf`, credential.ssh.forUrl]];
      extra.forEach(([key, value], offset) => {
        environment[`GIT_CONFIG_KEY_${count + offset}`] = key;
        environment[`GIT_CONFIG_VALUE_${count + offset}`] = value;
      });
      environment.GIT_CONFIG_COUNT = String(count + extra.length);
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
  const temporary = await makeWorkerScratch("agentx-push-");
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
