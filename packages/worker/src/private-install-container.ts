// Private packages P2a: the install container's `docker run` arguments, built by ONE function and checked by an exact allow-list assertion (values included, as `assertSetupSandboxRunArgs` does for the sandbox),
// and the per-operation bridge it runs on.
//
// The container is the ONLY thing that ever holds the company's package token besides the host tmpfs file: a Rovara-owned container of the worker's own image, started beside (never inside) any sandbox, on a bridge of its
// own named `rvbp<slot>` (the boot firewall walls every `rvb*` bridge: private ranges, link-local with the metadata address, loopback and the host's own ports are dropped; the VPC resolvers' port 53 and the public internet stay open).
// It runs the IMAGE's npm or yarn 1 with scripts off, never the repository's. The token file is mounted read-only; the log driver is `none`; the root is read-only; nothing but fixed non-secret names is in its environment.
import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { agentXError } from "@agentx/contracts";
import { PACKAGE_CACHE_DIRECTORY, PACKAGE_CACHE_FOLDERS } from "./package-cache.js";
import { INSTALL_MOUNT_PATH, installCommand, type InstallManager } from "./private-install-plan.js";
import { SANDBOX_INIT, TASK_SANDBOX_USER, sandboxCpuLimit, sandboxMemoryLimit } from "./task-sandbox.js";

export const INSTALL_LABEL = "rovara.install";
export const INSTALL_WORKSPACE_LABEL = "rovara.install-workspace";
export const INSTALL_BRIDGE_PREFIX = "rvbp";
export const INSTALL_NETWORK_FIRST_OCTET = "172.30";
export const INSTALL_NETWORK_SLOTS = 253;
export const INSTALL_PIDS_LIMIT = "512";
export const INSTALL_HOME = "/home/rovara-install";
const TMPFS_OPTIONS = "rw,nosuid,nodev,size=1g,uid=1000,gid=1000,mode=0700";
const REFUSED = "AgentX refused to start the package install container: its options are not the install container's";

const hash = (...parts: string[]): string => createHash("sha256").update(parts.join("\0")).digest("hex");
/** Names, derived from the operation and the repository by hashing: no id or repository string reaches a docker option. */
export const installNetworkName = (operationId: string): string => `rovara-install-${hash("install-net", operationId).slice(0, 12)}`;
export const installContainerName = (operationId: string, repository: string): string => `rovara-install-${hash("install-run", operationId, repository).slice(0, 12)}`;
export const installRepositoryKey = (operationId: string, repository: string): string => hash("install-key", operationId, repository).slice(0, 12);

export function installNetworkAddresses(slot: number): { subnet: string; gateway: string; bridge: string } {
  if (!Number.isInteger(slot) || slot < 1 || slot > INSTALL_NETWORK_SLOTS) throw agentXError("CONFIG_INVALID", "not an install network slot");
  const base = `${INSTALL_NETWORK_FIRST_OCTET}.${String(slot)}`;
  return { subnet: `${base}.0/24`, gateway: `${base}.1`, bridge: `${INSTALL_BRIDGE_PREFIX}${String(slot)}` };
}

/** The slot an operation starts looking for a free /24 at; a collision is retried at the next. */
export const installNetworkSlot = (operationId: string, attempt = 0): number => (Number.parseInt(hash("install-slot", operationId).slice(0, 4), 16) + attempt) % INSTALL_NETWORK_SLOTS + 1;

/** `docker network create` for the operation's bridge: fixed /24, no inter-container traffic, no IPv6, a bridge name the boot firewall walls. */
export function installNetworkCreateArgs(operationId: string, workspace: string, addresses: ReturnType<typeof installNetworkAddresses>): string[] {
  return [
    "network", "create", "--driver", "bridge", "--subnet", addresses.subnet, "--gateway", addresses.gateway,
    "--opt", `com.docker.network.bridge.name=${addresses.bridge}`, "--opt", "com.docker.network.bridge.enable_icc=false",
    "--label", `${INSTALL_LABEL}=${hash("install-label", operationId).slice(0, 16)}`, "--label", `${INSTALL_WORKSPACE_LABEL}=${workspace}`,
    installNetworkName(operationId),
  ];
}

export interface InstallContainerInput {
  operationId: string;
  repository: string;
  /** The label value of the workspace (task-sandbox `workspaceKey`), so a sweep removes only this workspace's. */
  workspace: string;
  image: string;
  /** The canonical workspace root. */
  rootPath: string;
  /** Absolute path of the repository's folder (under `rootPath`). */
  repositoryDirectory: string;
  manager: InstallManager;
  /** The host path of this operation's token folder (under the tmpfs root). */
  secretsDirectory: string;
  /** Mount the derived `.npmrc` over the repository's (npm, only when the repository has one). */
  derivedNpmrc?: boolean;
  hostCpus?: number;
  hostMemoryBytes?: number;
}

const cacheDirectory = (rootPath: string, manager: InstallManager): string => join(resolve(rootPath), PACKAGE_CACHE_DIRECTORY, PACKAGE_CACHE_FOLDERS[manager]);

/** The fixed, non-secret environment of the container, per manager. `NODE_ENV` is emptied: the worker image sets it to `production`, which would make `npm ci` skip the dev dependencies. */
export function installEnvironment(rootPath: string, manager: InstallManager): string[] {
  const cache = cacheDirectory(rootPath, manager);
  return [
    `HOME=${INSTALL_HOME}`, "COREPACK_ENABLE_AUTO_PIN=0", "COREPACK_ENABLE_STRICT=0", "NODE_ENV=", "NODE_OPTIONS=", "YARN_IGNORE_PATH=1",
    `npm_config_globalconfig=${INSTALL_MOUNT_PATH}/empty`, `npm_config_userconfig=${INSTALL_MOUNT_PATH}/npmrc`,
    `npm_config_cache=${manager === "npm" ? cache : join(INSTALL_HOME, "npm-cache")}`, "npm_config_logs_max=0", `npm_config_logs_dir=${INSTALL_HOME}/_logs`, "npm_config_update_notifier=false",
    ...(manager === "yarn1" ? [`YARN_CACHE_FOLDER=${cache}`] : []),
  ];
}

/** The `docker run` arguments of one install container (foreground, attached, removed on exit). */
export function installContainerArgs(input: InstallContainerInput): string[] {
  const root = resolve(input.rootPath);
  const cache = cacheDirectory(root, input.manager);
  const cpus = input.hostCpus === undefined ? undefined : sandboxCpuLimit(input.hostCpus);
  const memory = input.hostMemoryBytes === undefined ? undefined : sandboxMemoryLimit(input.hostMemoryBytes);
  const key = installRepositoryKey(input.operationId, input.repository);
  return [
    "run", "--rm", "--name", installContainerName(input.operationId, input.repository),
    "--label", `${INSTALL_LABEL}=${hash("install-label", input.operationId).slice(0, 16)}`, "--label", `${INSTALL_WORKSPACE_LABEL}=${input.workspace}`,
    "--network", installNetworkName(input.operationId),
    "--user", TASK_SANDBOX_USER, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--pids-limit", INSTALL_PIDS_LIMIT,
    ...(cpus === undefined ? [] : ["--cpus", cpus]),
    ...(memory === undefined ? [] : ["--memory", memory, "--memory-swap", memory]),
    "--ulimit", "core=0", "--log-driver", "none",
    "--tmpfs", `${INSTALL_HOME}:${TMPFS_OPTIONS}`, "--tmpfs", `/tmp:${TMPFS_OPTIONS}`,
    "--volume", `${input.repositoryDirectory}:${input.repositoryDirectory}:rw`,
    "--volume", `${cache}:${cache}:rw`,
    "--volume", `${input.secretsDirectory}:${INSTALL_MOUNT_PATH}:ro`,
    ...(input.derivedNpmrc === true ? ["--volume", `${join(input.secretsDirectory, `${key}.npmrc`)}:${join(input.repositoryDirectory, ".npmrc")}:ro`] : []),
    ...installEnvironment(root, input.manager).flatMap((entry) => ["--env", entry]),
    "--workdir", input.repositoryDirectory, "--entrypoint", SANDBOX_INIT,
    input.image, "--", ...installCommand(input.manager),
  ];
}

const NAME = /^rovara-install-[0-9a-f]{12}$/u;
const FLAGS: ReadonlyMap<string, number> = new Map([
  ["--rm", 0], ["--read-only", 0], ["--name", 1], ["--label", 1], ["--network", 1], ["--user", 1], ["--cap-drop", 1], ["--security-opt", 1], ["--pids-limit", 1], ["--cpus", 1], ["--memory", 1], ["--memory-swap", 1],
  ["--ulimit", 1], ["--log-driver", 1], ["--tmpfs", 1], ["--volume", 1], ["--env", 1], ["--workdir", 1], ["--entrypoint", 1],
]);

type Seen = Map<string, string[]>;

/** The flags before the image, each of a known kind with its value; undefined when one is not known or has no value. `rest` is what follows them. */
function readFlags(args: readonly string[]): { seen: Seen; rest: string[] } | undefined {
  const seen: Seen = new Map();
  let index = 1;
  for (; index < args.length; index += 1) {
    const token = args[index] ?? "";
    if (!token.startsWith("-")) break;
    const arity = FLAGS.get(token);
    const value = arity === 0 ? "" : args[index + 1];
    if (arity === undefined || value === undefined) return undefined;
    index += arity;
    seen.set(token, [...(seen.get(token) ?? []), value]);
  }
  return { seen, rest: args.slice(index) };
}

const only = (seen: Seen, flag: string): string | undefined => (seen.get(flag)?.length === 1 ? seen.get(flag)![0] : undefined);
const sameSet = (seen: Seen, flag: string, values: readonly string[]): boolean => {
  const got = seen.get(flag) ?? [];
  return got.length === values.length && values.every((value) => got.includes(value));
};

/** The security shape: the name and network of this operation, the user, the read-only root, no capability, no new privileges, the limits, the init. */
function shapeIsRight(seen: Seen, expected: InstallContainerInput): boolean {
  const same = (flag: string, value: string): boolean => only(seen, flag) === value;
  return same("--name", installContainerName(expected.operationId, expected.repository)) && NAME.test(only(seen, "--name") ?? "") && same("--network", installNetworkName(expected.operationId))
    && same("--user", TASK_SANDBOX_USER) && seen.has("--rm") && seen.has("--read-only") && same("--cap-drop", "ALL") && same("--security-opt", "no-new-privileges")
    && same("--pids-limit", INSTALL_PIDS_LIMIT) && same("--ulimit", "core=0") && same("--log-driver", "none")
    && same("--workdir", expected.repositoryDirectory) && same("--entrypoint", SANDBOX_INIT);
}

/** The mounts, labels and environment: exactly the expected sets. */
function mountsAreRight(seen: Seen, expected: InstallContainerInput): boolean {
  const root = resolve(expected.rootPath);
  const cache = cacheDirectory(root, expected.manager);
  const key = installRepositoryKey(expected.operationId, expected.repository);
  const volumes = [`${expected.repositoryDirectory}:${expected.repositoryDirectory}:rw`, `${cache}:${cache}:rw`, `${expected.secretsDirectory}:${INSTALL_MOUNT_PATH}:ro`,
    ...(expected.derivedNpmrc === true ? [`${join(expected.secretsDirectory, `${key}.npmrc`)}:${join(expected.repositoryDirectory, ".npmrc")}:ro`] : [])];
  const label = hash("install-label", expected.operationId).slice(0, 16);
  return sameSet(seen, "--tmpfs", [`${INSTALL_HOME}:${TMPFS_OPTIONS}`, `/tmp:${TMPFS_OPTIONS}`]) && sameSet(seen, "--volume", volumes)
    && sameSet(seen, "--label", [`${INSTALL_LABEL}=${label}`, `${INSTALL_WORKSPACE_LABEL}=${expected.workspace}`]) && sameSet(seen, "--env", installEnvironment(root, expected.manager));
}

/** The optional limits: at most one of each, of the shape the sandbox's own limits have, memory and swap equal. */
function limitsAreRight(seen: Seen): boolean {
  const memory = seen.get("--memory") ?? [];
  const cpus = seen.get("--cpus") ?? [];
  return memory.length <= 1 && cpus.length <= 1 && memory.every((value) => /^[1-9][0-9]{2,6}m$/u.test(value)) && JSON.stringify(seen.get("--memory")) === JSON.stringify(seen.get("--memory-swap"))
    && cpus.every((value) => /^[1-9][0-9]{0,3}$/u.test(value));
}

/**
 * Whether `args` are exactly the install container's shape for `expected`, value by value. Anything else (an extra flag or env, a different network, the host network, a missing `--log-driver none` or `--read-only`, an extra mount, the Docker
 * socket, a changed command) throws RUNTIME_UNAVAILABLE with a fixed sentence (no argument is repeated: it could be a secret).
 */
export function assertInstallContainerArgs(args: readonly string[], expected: InstallContainerInput): void {
  const root = resolve(expected.rootPath);
  const read = isAbsolute(root) && root !== "/" && args[0] === "run" ? readFlags(args) : undefined;
  const tail = read?.rest ?? [];
  const sound = read !== undefined && tail[0] === expected.image && tail[1] === "--" && !args.some((argument) => argument.includes("docker.sock"))
    && JSON.stringify(tail.slice(2)) === JSON.stringify(installCommand(expected.manager));
  if (!sound || !shapeIsRight(read.seen, expected) || !mountsAreRight(read.seen, expected) || !limitsAreRight(read.seen)) throw agentXError("RUNTIME_UNAVAILABLE", REFUSED);
}
