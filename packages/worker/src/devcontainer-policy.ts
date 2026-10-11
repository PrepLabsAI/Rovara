import { lstatSync, readlinkSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * What a project's dev container may ask Docker for (docker containment). The dev container config is in the
 * repository, so the agent can rewrite it during a task; its `runArgs`, `mounts` and the like reach the worker host's
 * Docker unchanged. A setting that would give the container the host (privileges, the host's process, IPC, network or
 * user namespaces, host devices, the Docker socket, host files outside the workspace) is refused, and so is
 * `initializeCommand`, which runs on the worker itself rather than in the container.
 *
 * Checked before `devcontainer up` (devcontainerConfigRefusal): devcontainer.json, and the full configuration the CLI
 * would use, with every feature's and the image's own `devcontainer.metadata` settings merged in. Checked again after
 * (containerProblems), on the container as Docker ran it. One added capability is allowed: SYS_PTRACE, which debuggers
 * need to trace the container's own processes.
 */

/** Docker's data root on an EC2 worker: a folder of the workspace volume (boot.sh), skipped by the worker's walks. */
export const DOCKER_DATA_DIRECTORY = ".docker";
/** The container problem a missing mask over the Docker data folder is reported as. */
export const DOCKER_DATA_VISIBLE = "the workspace's Docker data folder (.docker) visible inside it";

export interface DevcontainerPolicyContext {
  /** The AgentX workspace (canonical). */
  rootPath: string;
  /** The repository folder the dev container is for: `${localWorkspaceFolder}`. */
  workspaceFolder: string;
  /** The folder of devcontainer.json, which `build.context` and `build.dockerfile` are relative to. */
  configFolder?: string;
  /** How a host path is resolved before it is checked (hostPathResolver), so a link out of the workspace counts. */
  resolvePath?: (path: string) => string;
}

/** The one added capability allowed: tracing the container's own processes, which debuggers need. */
const ALLOWED_CAPABILITY = /^(?:CAP_)?SYS_PTRACE$/iu;
const onlyAllowedCapabilities = (value: unknown) =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string" && ALLOWED_CAPABILITY.test(entry));

/** A plain reason naming the first setting AgentX does not allow, or undefined. */
export function devcontainerConfigRefusal(config: unknown, context: DevcontainerPolicyContext): string | undefined {
  if (config === null || typeof config !== "object" || Array.isArray(config)) return undefined;
  const settings = config as Record<string, unknown>;
  if (settings.initializeCommand !== undefined) return "initializeCommand (it runs on the worker host)";
  if (settings.dockerComposeFile !== undefined) return "dockerComposeFile (Docker Compose dev containers)";
  if (settings.privileged !== undefined && settings.privileged !== false) return "privileged";
  if (settings.capAdd !== undefined && !onlyAllowedCapabilities(settings.capAdd)) return "capAdd";
  if (settings.securityOpt !== undefined && !(Array.isArray(settings.securityOpt) && settings.securityOpt.length === 0)) return "securityOpt";
  if (settings.mounts !== undefined) {
    if (!Array.isArray(settings.mounts)) return "mounts that are not a list";
    for (const mount of settings.mounts) {
      const reason = mountRefusal(mount, context, { allowRoot: false });
      if (reason !== undefined) return `mounts with ${reason}`;
    }
  }
  if (settings.workspaceMount !== undefined) {
    const reason = mountRefusal(settings.workspaceMount, context, { allowRoot: false });
    if (reason !== undefined) return `workspaceMount with ${reason}`;
  }
  if (settings.runArgs !== undefined) {
    if (!Array.isArray(settings.runArgs) || !settings.runArgs.every((arg) => typeof arg === "string")) return "runArgs that are not a list of strings";
    const reason = runArgsRefusal(settings.runArgs, context);
    if (reason !== undefined) return `runArgs ${reason}`;
  }
  const build = settings.build !== null && typeof settings.build === "object" && !Array.isArray(settings.build)
    ? settings.build as Record<string, unknown>
    : {};
  for (const [name, value] of [["build.dockerfile", build.dockerfile ?? settings.dockerFile], ["build.context", build.context ?? settings.context]] as const) {
    if (value === undefined) continue;
    const outside = buildPathRefusal(value, context);
    if (outside !== undefined) return `${name} outside the workspace (${outside})`;
  }
  if (build.options !== undefined) {
    if (!Array.isArray(build.options) || !build.options.every((arg) => typeof arg === "string")) return "build.options that are not a list of strings";
    const reason = buildOptionsRefusal(build.options);
    if (reason !== undefined) return `build.options ${reason}`;
  }
  return undefined;
}

/** A Dockerfile or build context path, relative to devcontainer.json's folder: allowed only inside the workspace. */
function buildPathRefusal(value: unknown, context: DevcontainerPolicyContext): string | undefined {
  if (typeof value !== "string") return String(value);
  const substituted = substituteLocal(value, context);
  if (substituted.includes("${")) return value;
  const folder = context.configFolder ?? join(context.workspaceFolder, ".devcontainer");
  const path = resolve(folder, substituted);
  const resolvePath = context.resolvePath ?? ((candidate: string) => resolve(candidate));
  return hostPathAllowed(resolvePath(path), resolvePath(resolve(context.rootPath)), { allowRoot: true }) ? undefined : path;
}

/**
 * `docker build` options that reach outside the build: the host's network or extra privileges, files written to or
 * read from the worker, or another build context.
 */
const BUILD_REFUSED = new Set(["--output", "--iidfile", "--metadata-file", "--allow", "--security-opt", "--secret", "--ssh", "--build-context", "--cache-to", "--file"]);
const BUILD_SHORT = new Map([["o", "--output"], ["f", "--file"]]);

function buildOptionsRefusal(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const name = equals === -1 ? arg : arg.slice(0, equals);
      if (BUILD_REFUSED.has(name)) return name;
      if (name === "--network" || name === "--net") {
        const given = equals === -1 ? args[++index] ?? "" : arg.slice(equals + 1);
        if (given === "host") return "--network=host";
        if (given.startsWith("container:")) return "--network=container:";
      }
    } else if (arg.startsWith("-") && arg.length > 1) {
      for (const flag of arg.slice(1)) {
        const refused = BUILD_SHORT.get(flag);
        if (refused !== undefined) return refused;
        if (flag !== "q") break;
      }
    }
  }
  return undefined;
}

function substituteLocal(value: string, context: DevcontainerPolicyContext): string {
  return value
    .replaceAll("${localWorkspaceFolder}", context.workspaceFolder)
    .replaceAll("${localWorkspaceFolderBasename}", basename(context.workspaceFolder));
}

/** Long `docker run` flags that hand the container part of the host whatever their value. */
const ALWAYS_REFUSED = new Set(["--pid", "--security-opt", "--device", "--device-cgroup-rule", "--volumes-from", "--gpus"]);
/** Long flags refused when their value is `host` (and, for these three, another container's namespace). */
const HOST_VALUE = new Map([["--ipc", true], ["--network", true], ["--net", true], ["--userns", false], ["--uts", false], ["--cgroupns", false]]);
/** `docker run` short flags without a value; every other short flag takes one. */
const SHORT_BOOLEAN = new Set(["d", "i", "t", "P"]);

function runArgsRefusal(args: readonly string[], context: DevcontainerPolicyContext): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const next = () => {
      index += 1;
      return args[index] ?? "";
    };
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const name = equals === -1 ? arg : arg.slice(0, equals);
      const value = () => (equals === -1 ? next() : arg.slice(equals + 1));
      if (name === "--privileged") {
        if (equals === -1 || arg.slice(equals + 1) !== "false") return "--privileged";
      } else if (ALWAYS_REFUSED.has(name)) {
        return name;
      } else if (name === "--cap-add") {
        if (!ALLOWED_CAPABILITY.test(value())) return "--cap-add";
      } else if (HOST_VALUE.has(name)) {
        const given = value();
        const label = name === "--net" ? "--network" : name;
        if (given === "host") return `${label}=host`;
        if (HOST_VALUE.get(name) === true && given.startsWith("container:")) return `${label}=container:`;
      } else if (name === "--volume") {
        const reason = volumeRefusal(value(), context);
        if (reason !== undefined) return reason;
      } else if (name === "--mount") {
        const reason = mountRefusal(value(), context, { allowRoot: false });
        if (reason !== undefined) return reason;
      }
    } else if (arg.startsWith("-") && arg.length > 1) {
      // A cluster of short flags, as Docker's flag parser reads it: boolean flags, then at most one that takes the
      // rest of the cluster, or the next argument, as its value.
      const cluster = arg.slice(1);
      for (let position = 0; position < cluster.length; position += 1) {
        const flag = cluster[position]!;
        if (SHORT_BOOLEAN.has(flag)) continue;
        const rest = cluster.slice(position + 1).replace(/^=/u, "");
        const given = rest !== "" ? rest : next();
        if (flag === "v") {
          const reason = volumeRefusal(given, context);
          if (reason !== undefined) return reason;
        }
        break;
      }
    }
  }
  return undefined;
}

/** `-v SOURCE:TARGET[:OPTIONS]`: a source that is a path is a bind mount; anything else names a volume. */
function volumeRefusal(spec: string, context: DevcontainerPolicyContext): string | undefined {
  // The source runs to the first colon outside a `${…}` variable.
  const source = /^(?:\$\{[^}]*\}|[^:])*/u.exec(spec)?.[0] ?? "";
  if (source.length === spec.length) return undefined;
  if (!/^[/.~]/u.test(source) && !source.includes("${")) return undefined;
  return bindRefusal(source, context, { allowRoot: false });
}

/** A `--mount` string (`type=bind,source=…,target=…`) or a devcontainer.json mount object. */
function mountRefusal(mount: unknown, context: DevcontainerPolicyContext, options: { allowRoot: boolean }): string | undefined {
  let fields: Record<string, string>;
  if (typeof mount === "string") {
    fields = {};
    for (const part of mount.split(",")) {
      const equals = part.indexOf("=");
      const key = (equals === -1 ? part : part.slice(0, equals)).trim().toLowerCase();
      if (key.startsWith("volume-opt") || key === "volume-driver") return "a volume with driver options";
      fields[key] = equals === -1 ? "true" : part.slice(equals + 1).trim();
    }
  } else if (mount !== null && typeof mount === "object" && !Array.isArray(mount)) {
    fields = Object.fromEntries(Object.entries(mount).map(([key, value]) => [key.toLowerCase(), String(value)]));
  } else {
    return "a mount AgentX cannot read";
  }
  const type = fields.type ?? "volume";
  const source = fields.source ?? fields.src;
  if (type === "volume") return source !== undefined && source.includes("/") ? `a volume named ${source}` : undefined;
  if (type === "tmpfs") return undefined;
  if (type !== "bind") return `a ${type} mount`;
  if (source === undefined) return "a bind mount without a source";
  return bindRefusal(source, context, options);
}

/**
 * A host path given to a bind mount: allowed only inside the workspace, never the workspace itself (AgentX mounts that
 * itself, with the Docker data folder hidden), and never in the Docker data folder.
 */
function bindRefusal(source: string, context: DevcontainerPolicyContext, options: { allowRoot: boolean }): string | undefined {
  const substituted = substituteLocal(source, context);
  if (substituted.includes("${") || !isAbsolute(substituted)) return `a bind mount of ${source}`;
  const resolvePath = context.resolvePath ?? ((path: string) => resolve(path));
  const path = resolvePath(resolve(substituted));
  const root = resolvePath(resolve(context.rootPath));
  // Shown as written (with the workspace folder filled in): a link is followed for the check only.
  return hostPathAllowed(path, root, options) ? undefined : `a bind mount of ${resolve(substituted)}`;
}

function hostPathAllowed(path: string, root: string, options: { allowRoot: boolean }): boolean {
  const fromRoot = relative(root, path);
  if (fromRoot === "") return options.allowRoot;
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) return false;
  const fromData = relative(join(root, DOCKER_DATA_DIRECTORY), path);
  return fromData.startsWith("..") || isAbsolute(fromData);
}

/** The parts of `docker inspect` that say what a container was given. */
export interface ContainerInspection {
  HostConfig?: {
    Privileged?: boolean;
    CapAdd?: readonly string[] | null;
    SecurityOpt?: readonly string[] | null;
    PidMode?: string;
    IpcMode?: string;
    NetworkMode?: string;
    UsernsMode?: string;
    UTSMode?: string;
    CgroupnsMode?: string;
    Devices?: readonly unknown[] | null;
    VolumesFrom?: readonly string[] | null;
    DeviceRequests?: readonly unknown[] | null;
  };
  Mounts?: ReadonlyArray<{ Type?: string; Source?: string; Destination?: string }> | null;
}

/**
 * What a started dev container was given that AgentX does not allow, as Docker reports it. Binds of the workspace
 * itself are AgentX's own; where the Docker data folder exists, each must have it hidden by a volume (or tmpfs) mounted
 * over the same place inside, since Docker's own data is not the project's.
 */
export function containerProblems(
  inspection: ContainerInspection,
  context: { rootPath: string; dockerDataPath?: string; resolvePath?: (path: string) => string },
): string[] {
  const host = inspection.HostConfig ?? {};
  const problems: string[] = [];
  const nonEmpty = (value: readonly unknown[] | null | undefined) => (value?.length ?? 0) > 0;
  if (host.Privileged === true) problems.push("privileged");
  if (nonEmpty(host.CapAdd) && !onlyAllowedCapabilities(host.CapAdd)) problems.push("--cap-add");
  if (nonEmpty(host.SecurityOpt)) problems.push("--security-opt");
  if (host.PidMode !== undefined && host.PidMode !== "" && host.PidMode !== "private") problems.push("--pid");
  for (const [mode, flag, containers] of [[host.IpcMode, "--ipc", true], [host.NetworkMode, "--network", true], [host.UsernsMode, "--userns", false], [host.UTSMode, "--uts", false], [host.CgroupnsMode, "--cgroupns", false]] as const) {
    if (mode === "host") problems.push(`${flag}=host`);
    else if (containers && mode?.startsWith("container:") === true) problems.push(`${flag}=container:`);
  }
  if (nonEmpty(host.Devices)) problems.push("--device");
  if (nonEmpty(host.DeviceRequests)) problems.push("--gpus");
  if (nonEmpty(host.VolumesFrom)) problems.push("--volumes-from");
  const resolvePath = context.resolvePath ?? ((path: string) => resolve(path));
  const root = resolvePath(resolve(context.rootPath));
  const mounts = inspection.Mounts ?? [];
  let dataVisible = false;
  for (const mount of mounts) {
    if (mount.Type !== "bind") continue;
    const source = mount.Source === undefined ? undefined : resolvePath(resolve(mount.Source));
    if (source === undefined || !hostPathAllowed(source, root, { allowRoot: true })) {
      problems.push(`a bind mount of ${mount.Source ?? "an unknown path"}`);
      continue;
    }
    if (context.dockerDataPath === undefined || mount.Destination === undefined) continue;
    const toData = relative(source, resolvePath(resolve(context.dockerDataPath)));
    if (toData.startsWith("..") || isAbsolute(toData)) continue;
    const hiddenAt = join(mount.Destination, toData);
    const hidden = mounts.some((other) => (other.Type === "volume" || other.Type === "tmpfs") && other.Destination === hiddenAt);
    if (!hidden) dataVisible = true;
  }
  if (dataVisible) problems.push(DOCKER_DATA_VISIBLE);
  return problems;
}

const MAX_LINK_HOPS = 40;

/**
 * Where a host path leads, as Docker would follow it: every component below the (canonical) workspace root is checked
 * with lstat, and a link is followed by its target, even when that target does not exist in the worker (it may on the
 * host). A path, or a link target, outside the workspace is returned as it is, without following anything there: the
 * worker's view of the filesystem outside the workspace is not the host's. Past the first missing component the rest
 * is appended as written, since nothing below a missing folder exists. A component that cannot be checked (any error
 * but "does not exist" or "not a folder", such as no permission) or too many links lead to `/`, which is refused.
 */
export function hostPathResolver(rootPath: string): (path: string) => string {
  const root = resolve(rootPath);
  const within = (path: string) => {
    const fromRoot = relative(root, path);
    return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
  };
  const parts = (path: string) => relative(root, path).split(sep).filter((part) => part !== "");
  return (input) => {
    const target = resolve(input);
    if (!within(target)) return target;
    let current = root;
    let pending = parts(target);
    let hops = 0;
    while (pending.length > 0) {
      const next = join(current, pending.shift()!);
      let isLink: boolean;
      try {
        isLink = lstatSync(next).isSymbolicLink();
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (code === "ENOENT" || code === "ENOTDIR") return join(next, ...pending);
        return "/";
      }
      if (!isLink) {
        current = next;
        continue;
      }
      hops += 1;
      if (hops > MAX_LINK_HOPS) return "/";
      let link: string;
      try {
        link = readlinkSync(next);
      } catch {
        return "/";
      }
      const linkTarget = resolve(current, link);
      if (!within(linkTarget)) return join(linkTarget, ...pending);
      current = root;
      pending = [...parts(linkTarget), ...pending];
    }
    return current;
  };
}

/** devcontainer.json: JSON with comments and trailing commas. */
export function parseJsonc(text: string): unknown {
  let output = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === "\"") {
      let end = index + 1;
      while (end < text.length && text[end] !== "\"") end += text[end] === "\\" ? 2 : 1;
      output += text.slice(index, end + 1);
      index = end + 1;
    } else if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
    } else if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
    } else if (char === ",") {
      // A comma followed only by whitespace and comments before a closing bracket is a trailing comma.
      let ahead = index + 1;
      for (;;) {
        while (ahead < text.length && /\s/u.test(text[ahead]!)) ahead += 1;
        if (text.startsWith("//", ahead)) {
          while (ahead < text.length && text[ahead] !== "\n") ahead += 1;
        } else if (text.startsWith("/*", ahead)) {
          const end = text.indexOf("*/", ahead + 2);
          ahead = end === -1 ? text.length : end + 2;
        } else {
          break;
        }
      }
      if (text[ahead] !== "}" && text[ahead] !== "]") output += char;
      index += 1;
    } else {
      output += char;
      index += 1;
    }
  }
  return JSON.parse(output) as unknown;
}
