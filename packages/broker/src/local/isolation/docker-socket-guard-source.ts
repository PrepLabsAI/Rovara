import { DOCKER_SOCKET_GUARD_SERVICES_SOURCE } from "./docker-socket-guard-services-source.js";

// Port lane L4b: the Docker socket guard of one local worker.
// This is the program that runs inside the helper container (`node -e`), kept as text so the broker needs no build step for it and
// tests can run the very same text. It uses only Node built-ins. Edit it here; there is no other copy.
export const DOCKER_SOCKET_GUARD_SOURCE = String.raw`"use strict";
// Rovara local Docker socket guard (lane L4b). One per worker. It is the only container that holds the host's Docker socket.
// The worker talks to it over TCP on its own internal network (DOCKER_HOST=tcp://...) and never sees the socket. It lets the
// worker do what the worker does on EC2 with the socket (start, run commands in, stop and remove the task sandboxes of its own
// workspace) and nothing else: every other call is refused, and a sandbox is created only from a body this file rebuilds
// to the rules below (the worker's image, the worker's workspace as the only mount, no privilege, no host namespace,
// the worker's own sandbox network and name server).
const http = require("http");
const net = require("net");

const policy = JSON.parse(process.env.ROVARA_SOCK_POLICY || "{}");
const OWNER = "rovara.local.owner";
const SANDBOX = "rovara.local.sandbox";
const DEVCONTAINER_LABEL = "rovara.local.devcontainer";
// A project's dev container (an image the project names, started by the worker through the dev container tool) is allowed only when the owner's policy lists registries to pull from. Without a list every
// image call but the worker's own is refused, as before.
const DEV = policy.devcontainer && Array.isArray(policy.devcontainer.registries) && policy.devcontainer.registries.length > 0 ? { registries: policy.devcontainer.registries.map(function (name) { return String(name).toLowerCase(); }) } : undefined;
// The empty volumes the worker mounts over its own folders of the workspace (devcontainer.ts maskVolume). The guard never makes a volume: it turns each into a read-only tmpfs over the same place.
const DEV_MASK = /^agentx-(?:docker-data-mask|mask-[a-z0-9_-]{1,40})-[a-f0-9]{8,32}$/;
const DEV_USER = /^[A-Za-z0-9_.:-]{0,64}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MAX_BODY = 262144;
let createQueue = Promise.resolve();
const execs = new Map(); // exec id -> container id, for the execs this worker made in its own sandboxes
let logged = 0;
let logWindow = Date.now();

const QUIET = process.env.ROVARA_SOCK_LIBRARY === "1"; // loaded as a library by the tests: say nothing
function log(event, fields) {
  if (QUIET) return;
  const now = Date.now();
  if (now - logWindow > 60000) { logWindow = now; logged = 0; }
  if (++logged > 40) return;
  process.stdout.write(JSON.stringify(Object.assign({ component: "docker-socket-guard", event: event }, fields || {})) + "\n");
}

// ---- asking the real daemon ourselves (ownership, counts)
function ask(method, path, body) {
  return new Promise(function (resolve, reject) {
    const headers = { host: "docker", connection: "close" };
    if (body !== undefined) { headers["content-type"] = "application/json"; headers["content-length"] = String(Buffer.byteLength(body)); }
    const request = http.request({ socketPath: policy.upstream, method: method, path: path, headers: headers, timeout: 30000, agent: false }, function (response) {
      const chunks = [];
      response.on("data", function (chunk) { chunks.push(chunk); });
      response.on("end", function () { resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }); });
    });
    request.on("timeout", function () { request.destroy(new Error("timeout")); });
    request.on("error", reject);
    request.end(body);
  });
}
// What this guard knows of a container of this worker, or undefined when it is not one. ONE lookup for every route, with the class from the labels the guard itself put on it (a worker cannot set a rovara. label):
//   class "sandbox"  a task sandbox (label sandbox=1);
//   class "dev"      a project's dev container (sandbox=1 and the dev container label): only where dev containers are on, but told apart ALWAYS, so a rule that fits a sandbox (the sandbox user) is never applied to it;
//   class "service"  a test service container (only with test services on), with its profile and its own configured user.
// Every route that takes a command, an attach or a network change asks for the class; none asks only for the id.
async function ownedFound(reference) {
  if (!NAME.test(reference)) return undefined;
  const answer = await ask("GET", "/containers/" + encodeURIComponent(reference) + "/json");
  if (answer.status !== 200) return undefined;
  let parsed;
  try { parsed = JSON.parse(answer.body); } catch (error) { return undefined; }
  const labels = (parsed && parsed.Config && parsed.Config.Labels) || {};
  if (labels[OWNER] !== policy.owner || typeof parsed.Id !== "string") return undefined;
  const name = String(parsed.Name || "").replace(/^\//, "");
  if (labels[SANDBOX] === "1") return { id: parsed.Id, class: labels[DEVCONTAINER_LABEL] === "1" ? "dev" : "sandbox", execUser: undefined, profile: "", name: name };
  if (SVC === null || labels[SANDBOX] !== SERVICE_CLASS) return undefined;
  const user = parsed.Config && typeof parsed.Config.User === "string" ? parsed.Config.User : "";
  return { id: parsed.Id, class: "service", execUser: user, profile: String(labels[PROFILE_LABEL] || ""), name: name };
}
async function ownedId(reference) {
  const found = await ownedFound(reference);
  return found === undefined ? undefined : found.id;
}

// ---- the rules for a sandbox
// A setting that says nothing: absent, empty, zero or false. An object is empty only when it has no keys, so {"x": ""} (a sysctl set to
// nothing, a volume at /data) is not. An array of numbers or strings is empty when each of them is (ConsoleSize is [0, 0]).
function emptyish(value) {
  if (value === null || value === undefined || value === "" || value === 0 || value === false) return true;
  if (Array.isArray(value)) return value.every(function (entry) { return entry === 0 || entry === "" || entry === false || entry === null; });
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}
function inside(path) {
  if (typeof path !== "string" || path.charAt(0) !== "/" || path.indexOf("\0") !== -1) return false;
  if (path.split("/").indexOf("..") !== -1) return false;
  const base = policy.workspaceDir;
  return path === base || path.indexOf(base + "/") === 0;
}
function stringList(value, limit) {
  return Array.isArray(value) && value.length <= limit && value.every(function (entry) { return typeof entry === "string" && entry.length <= 32768 && entry.indexOf("\0") === -1; });
}
class Refusal extends Error {}
function deny(rule) { throw new Refusal(rule); }

// The guard builds the body it forwards from nothing, copying only fields it understands under their exact names. Docker's JSON decoder
// matches names without regard to case and lets a later key win, so a body that is checked and then passed on as it came ("CapDrop":
// ["ALL"] followed by "capdrop":[]) is not the body that was checked. Every name must be exactly one Docker knows, in one of two lists:
// the ones the guard uses, and the ones it only allows empty (the docker CLI sends many at their zero value). Any other name is refused.
const HOST_ZERO = ["ContainerIDFile", "PortBindings", "VolumeDriver", "VolumesFrom", "ConsoleSize", "CapAdd", "Dns", "DnsOptions", "DnsSearch", "ExtraHosts", "GroupAdd", "IpcMode", "Cgroup", "Links", "OomScoreAdj", "PidMode",
  "PublishAllPorts", "UTSMode", "UsernsMode", "CgroupParent", "BlkioWeight", "BlkioWeightDevice", "BlkioDeviceReadBps", "BlkioDeviceWriteBps", "BlkioDeviceReadIOps", "BlkioDeviceWriteIOps", "CpuPeriod", "CpuQuota",
  "CpuRealtimePeriod", "CpuRealtimeRuntime", "CpusetMems", "Devices", "DeviceCgroupRules", "DeviceRequests", "CpuCount", "CpuPercent", "IOMaximumIOps", "IOMaximumBandwidth", "Sysctls", "Runtime", "Mounts", "StorageOpt", "Annotations", "OomKillDisable"];
const HOST_USED = ["Binds", "Tmpfs", "NetworkMode", "CapDrop", "SecurityOpt", "Privileged", "PidsLimit", "Memory", "MemorySwap", "MemoryReservation", "NanoCpus", "CpuShares", "ShmSize", "ReadonlyRootfs", "Init", "AutoRemove",
  "MemorySwappiness", "LogConfig", "RestartPolicy", "Ulimits", "CpusetCpus", "CgroupnsMode", "Isolation", "MaskedPaths", "ReadonlyPaths"];
const TOP_ZERO = ["Hostname", "Domainname", "Volumes", "ExposedPorts", "MacAddress", "Healthcheck", "NetworkDisabled", "OnBuild", "ArgsEscaped", "Shell"];
const TOP_USED = ["Image", "Cmd", "Entrypoint", "Env", "User", "WorkingDir", "Labels", "HostConfig", "NetworkingConfig", "Tty", "OpenStdin", "AttachStdin", "AttachStdout", "AttachStderr", "StdinOnce", "StopSignal", "StopTimeout"];
// What a sandbox gets when the worker names no limit: a sandbox is never unlimited.
const DEFAULT_MEMORY = 4294967296;
const DEFAULT_PIDS = 4096;
// The most memory a sandbox may be given: what the machine the daemon runs on has (this container reads the same /proc/meminfo).
const MEMORY_CEILING = require("os").totalmem();

function knownKeys(object, used, zero, what) {
  Object.keys(object).forEach(function (key) {
    if (used.indexOf(key) !== -1) return;
    if (zero.indexOf(key) === -1) deny(what + " " + key + " is not allowed");
    if (!emptyish(object[key])) deny(what + " " + key + " is not allowed");
  });
}
function numberOr(value, fallback, name) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !(value >= 0) || !isFinite(value)) deny(name + " is not valid");
  return value;
}
function booleanOr(value, name) {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") deny(name + " is not valid");
  return value;
}

// A dev container is held to the sandbox's rules except where it must differ, and each difference is a value the guard forces or checks, never one it copies:
//   - it keeps Docker's default capabilities (a dev container's own tools need them) minus MKNOD and NET_RAW; it can add only SYS_PTRACE, and its security option is always no-new-privileges (forced, so no
//     setuid file gains a process privileges inside it; no other option is accepted);
//   - it is on the sandbox network with the sandbox's name server whatever it asked, never another network;
//   - its mounts are the workspace folder at its own path, and the worker's mask volumes, which the guard turns into read-only empty tmpfs MOUNTS over the same folders (no volume is ever made; a mount, not a --tmpfs
//     setting, because Docker lists a mount of the started container and the worker checks that its folders are hidden by one).
const DEV_HOST_USED = HOST_USED.concat(["Mounts", "CapAdd"]);
const DEV_HOST_ZERO = HOST_ZERO.filter(function (name) { return name !== "Mounts" && name !== "CapAdd"; });
const MOUNT_KEYS = ["Type", "Source", "Target", "ReadOnly", "Consistency"];
const CONSISTENCY = ["", "default", "cached", "consistent", "delegated"];

// What a HostConfig is built for is one tagged value, never a flag that is tested for truthiness (a value that means one thing to one lane and another to the other would give a container the other's capabilities):
//   { kind: "sandbox" }                    a task sandbox: every capability dropped, the sandbox network and name server, the workspace as the only mount;
//   { kind: "check", variant: {...} }      the sealed check sandbox of a test run: the sandbox rules, on the run's own network, with the run's two read-only files (as the guard's copies) and no name server of its own choosing;
//   { kind: "devcontainer" }               a project's dev container, with the differences listed above.
// Anything else throws, so a caller that passes the wrong thing fails here and in its tests instead of loosening a rule.
function hostConfigMode(mode) {
  if (mode !== null && typeof mode === "object") {
    if (mode.kind === "sandbox" || mode.kind === "devcontainer") return mode;
    if (mode.kind === "check" && mode.variant !== null && typeof mode.variant === "object") return mode;
  }
  throw new Error("unknown host config mode");
}

// The HostConfig a sandbox, a check sandbox or a dev container gets, built from the checked parts of what the worker sent.
function buildHostConfig(host, mode) {
  hostConfigMode(mode);
  const dev = mode.kind === "devcontainer";
  const variant = mode.kind === "check" ? mode.variant : undefined;
  if (host === null || typeof host !== "object" || Array.isArray(host)) deny("host config is missing");
  knownKeys(host, dev ? DEV_HOST_USED : HOST_USED, dev ? DEV_HOST_ZERO : HOST_ZERO, "host setting");
  if (host.Privileged === true || (host.Privileged !== undefined && host.Privileged !== false && host.Privileged !== null)) deny("privileged mode is not allowed");
  if (dev) {
    if (host.NetworkMode !== undefined && host.NetworkMode !== null && host.NetworkMode !== "" && host.NetworkMode !== "default" && host.NetworkMode !== policy.network) deny("only the sandbox network is allowed");
  } else if (host.NetworkMode !== (variant ? variant.network : policy.network)) deny(variant ? "only the run's own network is allowed" : "only the sandbox network is allowed");
  let capDrop = ["ALL"];
  let capAdd = [];
  let securityOpt = ["no-new-privileges"];
  if (dev) {
    // What a dev container drops is its own to add to (a cap it drops is only less); MKNOD and NET_RAW are always dropped.
    const given = host.CapDrop === undefined || host.CapDrop === null ? [] : host.CapDrop;
    if (!stringList(given, 40) || !given.every(function (cap) { return /^(?:CAP_)?[A-Z_]{1,30}$/.test(cap); })) deny("CapDrop is not valid");
    capDrop = ["MKNOD", "NET_RAW"].concat(given.filter(function (cap) { return cap !== "MKNOD" && cap !== "NET_RAW"; }));
    const added = host.CapAdd === undefined || host.CapAdd === null ? [] : host.CapAdd;
    if (!stringList(added, 4) || !added.every(function (cap) { return /^(?:CAP_)?SYS_PTRACE$/i.test(cap); })) deny("only SYS_PTRACE may be added");
    capAdd = added;
    const opts = host.SecurityOpt === undefined || host.SecurityOpt === null ? [] : host.SecurityOpt;
    if (!stringList(opts, 8) || !opts.every(function (entry) { return /^no-new-privileges(:true|=true)?$/.test(entry); })) deny("only no-new-privileges is allowed as a security option");
    // Always forced: a dev container's processes cannot gain privileges by a setuid file (so no sudo inside it).
    securityOpt = ["no-new-privileges"];
  } else {
    if (!Array.isArray(host.CapDrop) || !host.CapDrop.some(function (cap) { return String(cap).toUpperCase() === "ALL"; })) deny("all capabilities must be dropped");
    if (!stringList(host.SecurityOpt, 8) || host.SecurityOpt.length === 0 || !host.SecurityOpt.every(function (entry) { return /^no-new-privileges(:true|=true)?$/.test(entry); })) deny("only no-new-privileges is allowed as a security option");
  }
  // Null (the default masks) is the only safe value: an empty list switches the masks off.
  if (host.MaskedPaths !== null && host.MaskedPaths !== undefined) deny("masked paths cannot be changed");
  if (host.ReadonlyPaths !== null && host.ReadonlyPaths !== undefined) deny("read-only paths cannot be changed");
  const binds = host.Binds === null || host.Binds === undefined ? [] : host.Binds;
  const mount = policy.workspaceDir + ":" + policy.workspaceDir;
  // The sealed check sandbox (a services variant) also gets two read-only files of the run's own folder at fixed targets; every other sandbox mounts the workspace and nothing else.
  const extraBinds = variant ? variant.readOnlyBinds : [];
  if (!stringList(binds, 4 + extraBinds.length) || !binds.every(function (bind) { return bind === mount || bind === mount + ":rw" || extraBinds.indexOf(bind) !== -1; })) deny("only the workspace folder may be mounted");
  const tmpfs = host.Tmpfs === null || host.Tmpfs === undefined ? {} : host.Tmpfs;
  if (typeof tmpfs !== "object" || Array.isArray(tmpfs)) deny("tmpfs is not valid");
  const masks = {};
  Object.keys(tmpfs).forEach(function (path) {
    if (!inside(path) || path === policy.workspaceDir || typeof tmpfs[path] !== "string" || !/^[a-z0-9=,_-]{0,100}$/.test(tmpfs[path])) deny("a tmpfs may only cover a folder inside the workspace");
    // Only the size and the mode of a mask are the worker's to choose; it is never executable, setuid or a device.
    const size = /(?:^|,)(size=[0-9]{1,12}[kmg]?)(?:,|$)/.exec(tmpfs[path]);
    const mode = /(?:^|,)(mode=[0-7]{3,4})(?:,|$)/.exec(tmpfs[path]);
    masks[path] = ["ro", "noexec", "nosuid", "nodev"].concat(size ? [size[1]] : [], mode ? [mode[1]] : []).join(",");
  });
  const mounts = [];
  const maskMounts = [];
  if (dev && host.Mounts !== undefined && host.Mounts !== null) {
    if (!Array.isArray(host.Mounts) || host.Mounts.length > 12) deny("mounts are not valid");
    let workspaceMounts = 0;
    host.Mounts.forEach(function (entry) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) deny("a mount is not valid");
      Object.keys(entry).forEach(function (key) { if (MOUNT_KEYS.indexOf(key) === -1) deny("mount setting " + key + " is not allowed"); });
      if (entry.ReadOnly !== undefined && entry.ReadOnly !== false) deny("a mount is read-write");
      if (entry.Consistency !== undefined && CONSISTENCY.indexOf(entry.Consistency) === -1) deny("mount consistency is not valid");
      if (entry.Type === "bind") {
        // Only the workspace folder, at its own path (the dev container tool mounts it so a path means the same file to the worker, the agent's tools and a command).
        if (entry.Source !== policy.workspaceDir || entry.Target !== policy.workspaceDir) deny("only the workspace folder may be mounted");
        workspaceMounts += 1;
        if (workspaceMounts > 1) deny("the workspace folder is mounted once");
        mounts.push({ Type: "bind", Source: policy.workspaceDir, Target: policy.workspaceDir, ReadOnly: false });
      } else if (entry.Type === "volume") {
        // The worker's mask volume over one of its own folders: not a volume, an empty read-only tmpfs over the same folder.
        if (typeof entry.Source !== "string" || !DEV_MASK.test(entry.Source) || !inside(entry.Target) || entry.Target === policy.workspaceDir) deny("only a mask over a folder of the workspace may be a volume");
        maskMounts.push(entry.Target);
      } else if (entry.Type === "tmpfs") {
        if (!inside(entry.Target) || entry.Target === policy.workspaceDir) deny("a tmpfs may only cover a folder inside the workspace");
        maskMounts.push(entry.Target);
      } else deny("mount type is not allowed");
    });
  }
  const memory = numberOr(host.Memory, 0, "Memory") || DEFAULT_MEMORY;
  const swap = numberOr(host.MemorySwap, 0, "MemorySwap");
  if (memory > MEMORY_CEILING || swap > 2 * MEMORY_CEILING) deny("the memory limit is higher than this machine has");
  const pids = host.PidsLimit === undefined || host.PidsLimit === null ? DEFAULT_PIDS : host.PidsLimit;
  if (typeof pids !== "number" || pids > 65536) deny("the process limit is not valid");
  if (host.CpusetCpus !== undefined && host.CpusetCpus !== null && (typeof host.CpusetCpus !== "string" || !/^[0-9,-]{0,64}$/.test(host.CpusetCpus))) deny("cpuset is not valid");
  const logType = host.LogConfig && host.LogConfig.Type;
  if (logType !== undefined && logType !== "" && logType !== "json-file" && logType !== "local") deny("only the default log driver is allowed");
  const restart = host.RestartPolicy && host.RestartPolicy.Name;
  if (restart !== undefined && restart !== "" && restart !== "no") deny("a sandbox does not restart");
  if (host.CgroupnsMode !== undefined && host.CgroupnsMode !== "" && host.CgroupnsMode !== "private") deny("the cgroup namespace cannot be changed");
  if (host.Isolation !== undefined && host.Isolation !== "" && host.Isolation !== "default") deny("isolation cannot be changed");
  if (host.MemorySwappiness !== undefined && host.MemorySwappiness !== null && !(typeof host.MemorySwappiness === "number" && host.MemorySwappiness >= -1 && host.MemorySwappiness <= 100)) deny("MemorySwappiness is not valid");
  let ulimits = [];
  if (host.Ulimits !== undefined && host.Ulimits !== null) {
    // Only the limits that cannot hurt the machine: open files, processes and core size (rtprio and memlock, for one, let a container starve the CPUs or lock memory).
    if (!(Array.isArray(host.Ulimits) && host.Ulimits.length <= 8 && host.Ulimits.every(function (entry) { return entry && typeof entry === "object" && (entry.Name === "nofile" || entry.Name === "nproc" || entry.Name === "core") && typeof entry.Soft === "number" && typeof entry.Hard === "number"; }))) deny("ulimits are not valid");
    ulimits = host.Ulimits.map(function (entry) { return { Name: entry.Name, Soft: entry.Soft, Hard: entry.Hard }; });
  }
  const built = {
    // The sealed check sandbox's two run files are mounted from the guard's COPIES of them (never from a path the worker could change); the workspace bind is as it was.
    Binds: binds.map(function (bind) { const pair = variant ? variant.copies.find(function (entry) { return entry.original === bind; }) : undefined; return pair === undefined ? bind : pair.copy; }),
    Tmpfs: masks,
    // The sealed check sandbox, like every service container, has no IPv6 (the run network has none to give it).
    ...(variant ? { Sysctls: { "net.ipv6.conf.all.disable_ipv6": "1" } } : {}),
    NetworkMode: variant ? variant.network : policy.network,
    // The sealed check sandbox has no name server of its own choosing: the run network's embedded one only.
    Dns: variant ? [] : policy.dns,
    // Forced, not only checked.
    CapDrop: capDrop,
    Privileged: false,
    PidsLimit: pids > 0 ? pids : DEFAULT_PIDS,
    Memory: memory,
    MemorySwap: swap >= memory ? swap : memory,
    MemoryReservation: numberOr(host.MemoryReservation, 0, "MemoryReservation"),
    NanoCpus: numberOr(host.NanoCpus, 0, "NanoCpus"),
    CpuShares: numberOr(host.CpuShares, 0, "CpuShares"),
    ShmSize: numberOr(host.ShmSize, 0, "ShmSize"),
    ReadonlyRootfs: booleanOr(host.ReadonlyRootfs, "ReadonlyRootfs"),
    Init: booleanOr(host.Init, "Init"),
    AutoRemove: booleanOr(host.AutoRemove, "AutoRemove"),
    Ulimits: ulimits,
    CpusetCpus: typeof host.CpusetCpus === "string" ? host.CpusetCpus : "",
  };
  if (dev) {
    // An empty read-only tmpfs over each folder the worker hides (Docker's tmpfs mounts are noexec, nosuid and nodev unless asked otherwise).
    built.Mounts = mounts.concat(Array.from(new Set(maskMounts)).map(function (target) { return { Type: "tmpfs", Target: target, ReadOnly: true, TmpfsOptions: { SizeBytes: 1048576 } }; }));
    built.CapAdd = capAdd;
    built.SecurityOpt = securityOpt;
  } else built.SecurityOpt = securityOpt;
  return built;
}

function transformCreate(query, text, variant) {
  let body;
  try { body = JSON.parse(text); } catch (error) { deny("the body is not JSON"); }
  if (body === null || typeof body !== "object" || Array.isArray(body)) deny("the body is not an object");
  Array.from(query.keys()).forEach(function (key) { if (key !== "name") deny("create option " + key + " is not allowed"); });
  const name = query.get("name");
  if (variant ? name !== variant.name : (name === null || !/^agentx-task-[A-Za-z0-9_.-]{1,100}$/.test(name))) deny("a sandbox name starts with agentx-task-");
  knownKeys(body, variant ? TOP_USED.concat(["Hostname"]) : TOP_USED, variant ? TOP_ZERO.filter(function (key) { return key !== "Hostname"; }) : TOP_ZERO, "setting");
  if (variant && body.Hostname !== undefined && body.Hostname !== "" && body.Hostname !== variant.hostname) deny("the hostname is fixed");
  if (body.Image !== policy.image) deny("only the worker's image may be started");
  if (body.User !== policy.user) deny("the sandbox user is fixed");
  if (body.WorkingDir !== undefined && body.WorkingDir !== "" && !inside(body.WorkingDir)) deny("the working folder must be inside the workspace");
  ["Cmd", "Entrypoint"].forEach(function (key) { if (body[key] !== undefined && body[key] !== null && !stringList(body[key], 256)) deny(key + " is not valid"); });
  if (body.Env !== undefined && body.Env !== null && !stringList(body.Env, 500)) deny("Env is not valid");
  const labels = body.Labels === null || body.Labels === undefined ? {} : body.Labels;
  if (typeof labels !== "object" || Array.isArray(labels)) deny("labels are not valid");
  if (labels["agentx.workspace"] !== policy.workspaceKey) deny("a sandbox carries its workspace's label");
  if (typeof labels["agentx.task"] !== "string" || labels["agentx.task"] === "") deny("a sandbox carries its task's label");
  const kept = {};
  Object.keys(labels).forEach(function (key) {
    // The run's own four labels pass through only for a services variant, and only as the variant already checked them.
    if (variant && variant.runLabels.hasOwnProperty(key)) { kept[key] = variant.runLabels[key]; return; }
    if (key.indexOf("rovara.") === 0) return;
    if (typeof labels[key] !== "string" || labels[key].length > 512) deny("labels are not valid");
    kept[key] = labels[key];
  });
  kept[OWNER] = policy.owner;
  kept[SANDBOX] = variant ? "service" : "1";
  if (variant) kept[PROFILE_LABEL] = "check";
  ["Tty", "OpenStdin", "AttachStdin", "AttachStdout", "AttachStderr", "StdinOnce"].forEach(function (key) { if (body[key] !== undefined && body[key] !== null && typeof body[key] !== "boolean") deny(key + " is not valid"); });
  if (body.StopSignal !== undefined && body.StopSignal !== null && (typeof body.StopSignal !== "string" || !/^[A-Za-z0-9]{0,16}$/.test(body.StopSignal))) deny("StopSignal is not valid");
  if (body.StopTimeout !== undefined && body.StopTimeout !== null && !(typeof body.StopTimeout === "number" && body.StopTimeout >= 0 && body.StopTimeout <= 600)) deny("StopTimeout is not valid");
  const out = {
    Image: policy.image,
    User: policy.user,
    Cmd: body.Cmd === undefined ? null : body.Cmd,
    Entrypoint: body.Entrypoint === undefined ? null : body.Entrypoint,
    Env: body.Env === undefined ? null : body.Env,
    WorkingDir: body.WorkingDir || "",
    Labels: kept,
    Tty: body.Tty === true,
    OpenStdin: body.OpenStdin === true,
    AttachStdin: body.AttachStdin === true,
    AttachStdout: body.AttachStdout === true,
    AttachStderr: body.AttachStderr === true,
    StdinOnce: body.StdinOnce === true,
    HostConfig: buildHostConfig(body.HostConfig, variant ? { kind: "check", variant: variant } : { kind: "sandbox" }),
    NetworkingConfig: { EndpointsConfig: {} },
  };
  if (variant && body.Hostname) out.Hostname = body.Hostname;
  if (typeof body.StopSignal === "string" && body.StopSignal !== "") out.StopSignal = body.StopSignal;
  if (typeof body.StopTimeout === "number") out.StopTimeout = body.StopTimeout;
  if (variant) out.NetworkingConfig.EndpointsConfig[variant.network] = { IPAMConfig: { IPv4Address: variant.address } };
  else out.NetworkingConfig.EndpointsConfig[policy.network] = {};
  return JSON.stringify(out);
}

// ---- a project's dev container (only when the owner's policy lists registries)
const IMAGE_PATH = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/;
const IMAGE_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const REGISTRY_HOST = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[0-9]{1,5})?$/;
// The reason an image reference may not be pulled or started, or undefined. The daemon (not the worker) makes the pull, so the registry is the one place a name could reach: it must be on the owner's list,
// a name and not an address, and the reference must be plain (a registry, a path, a tag or a digest, nothing else).
function imageRefusal(ref) {
  if (DEV === undefined) return "dev containers are not allowed on this install";
  if (typeof ref !== "string" || ref.length === 0 || ref.length > 255 || ref !== ref.trim() || /[\u0000-\u001f\u007f\\\s]/.test(ref)) return "the image name is not valid";
  const at = ref.indexOf("@");
  const before = at === -1 ? ref : ref.slice(0, at);
  if (at !== -1 && !IMAGE_DIGEST.test(ref.slice(at + 1))) return "the image digest is not valid";
  const slash = before.lastIndexOf("/");
  const colon = before.indexOf(":", slash + 1);
  const name = colon === -1 ? before : before.slice(0, colon);
  if (colon !== -1 && !IMAGE_TAG.test(before.slice(colon + 1))) return "the image tag is not valid";
  const parts = name.split("/");
  let registry = "docker.io";
  let path = name;
  if (parts.length > 1 && (parts[0].indexOf(".") !== -1 || parts[0].indexOf(":") !== -1 || parts[0] === "localhost")) { registry = parts[0].toLowerCase(); path = parts.slice(1).join("/"); }
  if (registry === "index.docker.io") registry = "docker.io";
  if (!REGISTRY_HOST.test(registry) || /^[0-9.]+(?::[0-9]+)?$/.test(registry) || registry.indexOf("[") !== -1 || registry === "localhost" || registry.indexOf("localhost:") === 0) return "the registry must be a name on the list";
  if (DEV.registries.indexOf(registry) === -1) return "that registry is not on the list of registries a dev container may pull from";
  if (!IMAGE_PATH.test(path) || path.length > 200) return "the image name is not valid";
  return undefined;
}

// A dev container is created from a body this builds from nothing, exactly as a sandbox is, with the differences listed at buildHostConfig.
function transformDevcontainerCreate(query, text) {
  let body;
  try { body = JSON.parse(text); } catch (error) { deny("the body is not JSON"); }
  if (body === null || typeof body !== "object" || Array.isArray(body)) deny("the body is not an object");
  Array.from(query.keys()).forEach(function (key) { if (key !== "name") deny("create option " + key + " is not allowed"); });
  const name = query.get("name");
  if (name !== null && !/^agentx-dev-[A-Za-z0-9_.-]{1,100}$/.test(name)) deny("a dev container name starts with agentx-dev-");
  knownKeys(body, TOP_USED, TOP_ZERO, "setting");
  const refusal = imageRefusal(body.Image);
  if (refusal !== undefined) deny(refusal);
  if (body.User !== undefined && body.User !== null && (typeof body.User !== "string" || !DEV_USER.test(body.User))) deny("the user is not valid");
  if (body.WorkingDir !== undefined && body.WorkingDir !== null && body.WorkingDir !== "" && (typeof body.WorkingDir !== "string" || body.WorkingDir.charAt(0) !== "/" || body.WorkingDir.length > 4096 || body.WorkingDir.indexOf("\0") !== -1)) deny("the working folder is not valid");
  ["Cmd", "Entrypoint"].forEach(function (key) { if (body[key] !== undefined && body[key] !== null && !stringList(body[key], 256)) deny(key + " is not valid"); });
  if (body.Env !== undefined && body.Env !== null && !stringList(body.Env, 500)) deny("Env is not valid");
  const labels = body.Labels === null || body.Labels === undefined ? {} : body.Labels;
  if (typeof labels !== "object" || Array.isArray(labels) || Object.keys(labels).length > 64) deny("labels are not valid");
  const kept = {};
  Object.keys(labels).forEach(function (key) {
    if (key.indexOf("rovara.") === 0) return;
    if (typeof labels[key] !== "string" || labels[key].length > 512 || key.length > 256) deny("labels are not valid");
    kept[key] = labels[key];
  });
  // The guard's own labels, which the worker cannot set or remove: whose it is, and that it is a sandbox of the guard's kind and a dev container.
  kept[OWNER] = policy.owner;
  kept[SANDBOX] = "1";
  kept[DEVCONTAINER_LABEL] = "1";
  kept["agentx.workspace"] = policy.workspaceKey;
  ["Tty", "OpenStdin", "AttachStdin", "AttachStdout", "AttachStderr", "StdinOnce"].forEach(function (key) { if (body[key] !== undefined && body[key] !== null && typeof body[key] !== "boolean") deny(key + " is not valid"); });
  if (body.StopSignal !== undefined && body.StopSignal !== null && (typeof body.StopSignal !== "string" || !/^[A-Za-z0-9]{0,16}$/.test(body.StopSignal))) deny("StopSignal is not valid");
  if (body.StopTimeout !== undefined && body.StopTimeout !== null && !(typeof body.StopTimeout === "number" && body.StopTimeout >= 0 && body.StopTimeout <= 600)) deny("StopTimeout is not valid");
  const out = {
    Image: body.Image,
    User: typeof body.User === "string" ? body.User : "",
    Cmd: body.Cmd === undefined ? null : body.Cmd,
    Entrypoint: body.Entrypoint === undefined ? null : body.Entrypoint,
    Env: body.Env === undefined ? null : body.Env,
    WorkingDir: body.WorkingDir || "",
    Labels: kept,
    Tty: body.Tty === true,
    OpenStdin: body.OpenStdin === true,
    AttachStdin: body.AttachStdin === true,
    AttachStdout: body.AttachStdout === true,
    AttachStderr: body.AttachStderr === true,
    StdinOnce: body.StdinOnce === true,
    HostConfig: buildHostConfig(body.HostConfig, { kind: "devcontainer" }),
    NetworkingConfig: { EndpointsConfig: {} },
  };
  if (typeof body.StopSignal === "string" && body.StopSignal !== "") out.StopSignal = body.StopSignal;
  if (typeof body.StopTimeout === "number") out.StopTimeout = body.StopTimeout;
  out.NetworkingConfig.EndpointsConfig[policy.network] = {};
  return JSON.stringify(out);
}

// The body of a command, rebuilt: never privileged, and only the fields below. "who" says whose command it is, as a tagged
// kind so that a new kind of container is a new branch here and never a boolean that quietly widens an old one:
//   { kind: "sandbox" }                         the worker's own sandbox: the sandbox's user whatever was asked;
//   { kind: "service", user: "<uid>:<gid>" }    a test service container: ITS OWN configured user, forced, which must be the one allowed shape (a non-zero number for both, never the socket's group);
//   { kind: "devcontainer" }                    a dev container: its own remote user, named plainly (root included, see the docs). Only this kind may name root.
// Any other value, and no value, is refused, so a caller that is not updated with a new kind fails closed.
function checkExecBody(text, who) {
  if (who === null || typeof who !== "object") deny("the kind of container for this command is not known");
  const dev = who.kind === "devcontainer";
  let fixedUser = policy.user;
  if (who.kind === "service") {
    const refusal = serviceUserRefusal(who.user);
    if (refusal !== undefined) deny(refusal);
    fixedUser = who.user;
  } else if (!dev && who.kind !== "sandbox") deny("the kind of container for this command is not known");
  let body;
  try { body = JSON.parse(text); } catch (error) { deny("the body is not JSON"); }
  if (body === null || typeof body !== "object" || Array.isArray(body)) deny("the body is not an object");
  const used = ["AttachStdin", "AttachStdout", "AttachStderr", "Cmd", "Env", "WorkingDir", "User", "Tty", "DetachKeys", "Privileged", "ConsoleSize"];
  Object.keys(body).forEach(function (key) {
    if (used.indexOf(key) === -1) deny("exec setting " + key + " is not allowed");
  });
  if (body.Privileged !== undefined && body.Privileged !== false && body.Privileged !== null) deny("privileged exec is not allowed");
  if (body.ConsoleSize !== undefined && !emptyish(body.ConsoleSize)) deny("exec setting ConsoleSize is not allowed");
  // A sandbox's command runs as the sandbox user and a service container's as its own user. A dev container's runs as its own remote user (the image's), named plainly; never privileged.
  if (dev) { if (body.User !== undefined && body.User !== null && (typeof body.User !== "string" || !DEV_USER.test(body.User))) deny("the command user is not valid"); }
  else if (body.User !== undefined && body.User !== "" && body.User !== fixedUser && body.User !== fixedUser.split(":")[0]) deny("a command runs as the sandbox user");
  if (!stringList(body.Cmd, 4096) || body.Cmd.length === 0) deny("Cmd is not valid");
  if (body.Env !== undefined && body.Env !== null && !stringList(body.Env, 500)) deny("Env is not valid");
  if (body.WorkingDir !== undefined && body.WorkingDir !== null && (typeof body.WorkingDir !== "string" || body.WorkingDir.length > 4096 || body.WorkingDir.indexOf("\0") !== -1)) deny("WorkingDir is not valid");
  if (body.DetachKeys !== undefined && body.DetachKeys !== null && (typeof body.DetachKeys !== "string" || !/^[A-Za-z0-9,@^\\[\]_-]{0,32}$/.test(body.DetachKeys))) deny("DetachKeys is not valid");
  ["AttachStdin", "AttachStdout", "AttachStderr", "Tty"].forEach(function (key) { if (body[key] !== undefined && body[key] !== null && typeof body[key] !== "boolean") deny(key + " is not valid"); });
  const out = { AttachStdin: body.AttachStdin === true, AttachStdout: body.AttachStdout === true, AttachStderr: body.AttachStderr === true, Tty: body.Tty === true, Cmd: body.Cmd, User: dev ? (typeof body.User === "string" ? body.User : "") : fixedUser, Privileged: false };
  if (Array.isArray(body.Env)) out.Env = body.Env;
  if (typeof body.WorkingDir === "string" && body.WorkingDir !== "") out.WorkingDir = body.WorkingDir;
  if (typeof body.DetachKeys === "string" && body.DetachKeys !== "") out.DetachKeys = body.DetachKeys;
  return JSON.stringify(out);
}

// The body that starts a command: the two fields Docker reads, rebuilt.
function checkExecStartBody(text) {
  let body = {};
  try { body = text === "" ? {} : JSON.parse(text); } catch (error) { deny("the body is not JSON"); }
  if (body === null || typeof body !== "object" || Array.isArray(body)) deny("the body is not an object");
  Object.keys(body).forEach(function (key) {
    if (key !== "Detach" && key !== "Tty" && key !== "ConsoleSize") deny("exec start option " + key + " is not allowed");
  });
  if (body.ConsoleSize !== undefined && !emptyish(body.ConsoleSize)) deny("exec start option ConsoleSize is not allowed");
  ["Detach", "Tty"].forEach(function (key) { if (body[key] !== undefined && body[key] !== null && typeof body[key] !== "boolean") deny(key + " is not valid"); });
  return { detach: body.Detach === true, tty: body.Tty === true };
}

// ---- the routes
function readBody(request) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let size = 0;
    request.on("data", function (chunk) {
      size += chunk.length;
      if (size > MAX_BODY) { request.destroy(); return reject(new Refusal("the body is too large")); }
      chunks.push(chunk);
    });
    request.on("end", function () { resolve(Buffer.concat(chunks).toString("utf8")); });
    request.on("error", reject);
  });
}
function send(response, status, message) {
  if (response.headersSent) return response.destroy();
  response.writeHead(status, { "content-type": "application/json", connection: "close" });
  response.end(JSON.stringify({ message: "rovara: " + message }));
}
// Every request the guard sends the daemon is its own: one request per connection (Connection: close, no shared agent), and a body only
// when the guard made it. A body the client sent on a route that takes none is refused: Node does not frame a piped body on a GET or a
// DELETE, so the bytes would reach the daemon as the NEXT request on the connection, one the guard never saw.
function forward(request, response, path, body, inspectAnswer) {
  if (body === undefined && (request.headers["transfer-encoding"] !== undefined || (request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0"))) {
    request.resume();
    deny("this request takes no body");
  }
  const finished = new Promise(function (resolve) { response.on("close", resolve); });
  const headers = {};
  Object.keys(request.headers).forEach(function (name) { if (name !== "host" && name !== "connection" && name !== "content-length" && name !== "transfer-encoding") headers[name] = request.headers[name]; });
  headers.host = "docker";
  headers.connection = "close";
  delete headers.upgrade;
  delete headers.expect;
  if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));
  const upstream = http.request({ socketPath: policy.upstream, method: request.method, path: path, headers: headers, agent: false }, function (answer) {
    if (inspectAnswer) {
      const chunks = [];
      answer.on("data", function (chunk) { chunks.push(chunk); });
      answer.on("end", function () {
        const text = Buffer.concat(chunks);
        try { inspectAnswer(answer.statusCode, text.toString("utf8")); } catch (error) { /* the answer is passed on regardless */ }
        response.writeHead(answer.statusCode, answer.headers);
        response.end(text);
      });
      return;
    }
    response.writeHead(answer.statusCode, answer.headers);
    // Docker sends the headers of a wait at once and the docker CLI waits for them before it starts the container.
    response.flushHeaders();
    answer.pipe(response);
  });
  upstream.on("error", function () { send(response, 502, "the Docker daemon does not answer"); });
  response.on("close", function () { upstream.destroy(); });
  upstream.end(body);
  request.resume();
  return finished;
}
function onlyQuery(query, names) {
  Array.from(query.keys()).forEach(function (key) { if (names.indexOf(key) === -1) deny("option " + key + " is not allowed"); });
}
function rebuilt(path, query) {
  const text = query.toString();
  return text === "" ? path : path + "?" + text;
}

async function route(request, response) {
  const target = new URL(request.url || "/", "http://docker");
  const path = target.pathname.replace(/^\/v[0-9]+(\.[0-9]+)?(?=\/)/, "");
  const query = target.searchParams;
  const method = request.method || "GET";
  let match;

  if ((method === "GET" || method === "HEAD") && path === "/_ping") return forward(request, response, "/_ping");
  if (method === "GET" && path === "/version") return forward(request, response, "/version");

  if (method === "GET" && path === "/containers/json") {
    onlyQuery(query, ["all", "limit", "size", "filters"]);
    let filters = {};
    if (query.has("filters")) {
      try { filters = JSON.parse(query.get("filters")); } catch (error) { deny("filters are not valid"); }
    }
    // Docker takes {"label":{"a=b":true}} (the old {"label":["a=b"]} form is refused by newer daemons); both are read, the map is sent.
    const asMap = function (value) {
      if (Array.isArray(value)) { const map = {}; value.forEach(function (entry) { map[String(entry)] = true; }); return map; }
      return value === undefined || value === null || typeof value !== "object" ? {} : value;
    };
    if (filters === null || typeof filters !== "object" || Array.isArray(filters)) deny("filters are not valid");
    Object.keys(filters).forEach(function (key) { filters[key] = asMap(filters[key]); });
    filters.label = filters.label || {};
    filters.label[OWNER + "=" + policy.owner] = true;
    // With test services on, a listing that asks for the run's own family label sees the run's service containers (and only those); every other listing sees the sandboxes, as before.
    filters.label[SANDBOX + "=" + (SVC !== null && asksForRunFamily(filters.label) ? SERVICE_CLASS : "1")] = true;
    query.set("filters", JSON.stringify(filters));
    return forward(request, response, rebuilt("/containers/json", query));
  }

  if (SVC !== null && method === "POST" && path === "/containers/create" && SERVICE_CONTAINER_NAME.test(query.get("name") || "")) return serviceCreate(request, response, query);

  if (method === "POST" && path === "/containers/create") {
    const text = await readBody(request);
    // A body that names an image other than the worker's is a dev container's (only when registries are listed); it gets its own rules, never the sandbox's.
    let image;
    try { image = JSON.parse(text).Image; } catch (error) { image = undefined; }
    const dev = DEV !== undefined && typeof image === "string" && image !== policy.image;
    const body = dev ? transformDevcontainerCreate(query, text) : transformCreate(query, text);
    // One create at a time, so the count below is the count when this one is made.
    const turn = createQueue;
    let release = function () {};
    createQueue = new Promise(function (resolve) { release = resolve; });
    await turn;
    try {
    const ownedLabels = {};
    ownedLabels[OWNER + "=" + policy.owner] = true;
    ownedLabels[SANDBOX + "=1"] = true;
    const owned = await ask("GET", "/containers/json?all=1&filters=" + encodeURIComponent(JSON.stringify({ label: ownedLabels })));
    let count = 0;
    try { count = JSON.parse(owned.body).length; } catch (error) { count = 0; }
    if (count >= (policy.maxSandboxes || 16)) {
      response.writeHead(429, { "content-type": "application/json" });
      return response.end(JSON.stringify({ message: "rovara: too many task sandboxes at once" }));
    }
    const created = new URLSearchParams();
    if (query.get("name") !== null) created.set("name", query.get("name"));
    return await forward(request, response, created.toString() === "" ? "/containers/create" : "/containers/create?" + created.toString(), body);
    } finally {
      release();
    }
  }

  match = /^\/containers\/([^/]+)\/(json|logs|start|stop|kill|restart|wait)$/.exec(path);
  if (match !== null) {
    const verb = match[2];
    const wants = (verb === "json" || verb === "logs") ? "GET" : "POST";
    if (method !== wants) deny("method not allowed");
    const allowedQuery = { json: ["size"], logs: ["follow", "stdout", "stderr", "since", "until", "timestamps", "tail"], start: ["detachKeys"], stop: ["t", "signal"], kill: ["signal"], restart: ["t", "signal"], wait: ["condition"] }[verb];
    onlyQuery(query, allowedQuery);
    const id = await ownedId(decodeURIComponent(match[1]));
    if (id === undefined) return send(response, 404, "no such sandbox of this worker");
    return forward(request, response, rebuilt("/containers/" + id + "/" + verb, query));
  }

  match = /^\/containers\/([^/]+)$/.exec(path);
  if (match !== null && method === "DELETE") {
    onlyQuery(query, ["force", "v"]);
    const id = await ownedId(decodeURIComponent(match[1]));
    if (id === undefined) return send(response, 404, "no such sandbox of this worker");
    return forward(request, response, rebuilt("/containers/" + id, query));
  }

  match = /^\/containers\/([^/]+)\/exec$/.exec(path);
  if (match !== null && method === "POST") {
    onlyQuery(query, []);
    const found = await ownedFound(decodeURIComponent(match[1]));
    if (found === undefined) return send(response, 404, "no such sandbox of this worker");
    const id = found.id;
    // A sandbox takes a command as the sandbox user, a dev container as its own remote user, a service container as its own configured non-root user (the guard forces it); the resolver guard, the one root container, takes none at all.
    let kind;
    if (found.class === "sandbox") kind = { kind: "sandbox" };
    // A dev container takes a command only where dev containers are on (as an attach does): a leftover one on an install that turned them off is not served.
    else if (found.class === "dev" && DEV !== undefined) kind = { kind: "devcontainer" };
    else if (found.class === "service" && found.profile !== "resolver") kind = { kind: "service", user: found.execUser };
    else deny("this container takes no command");
    const text = await readBody(request);
    return forward(request, response, "/containers/" + id + "/exec", checkExecBody(text, kind), function (status, answer) {
      if (status !== 201) return;
      const created = JSON.parse(answer);
      if (typeof created.Id === "string" && NAME.test(created.Id)) {
        execs.set(created.Id, id);
        if (execs.size > 2000) execs.delete(execs.keys().next().value);
      }
    });
  }

  match = /^\/exec\/([^/]+)\/(start|json|resize)$/.exec(path);
  if (match !== null) {
    const verb = match[2];
    if (method !== (verb === "json" ? "GET" : "POST")) deny("method not allowed");
    onlyQuery(query, verb === "resize" ? ["h", "w"] : []);
    const id = decodeURIComponent(match[1]);
    if (!execs.has(id)) return send(response, 404, "no such command of this worker");
    if (verb === "start") {
      const started = checkExecStartBody(await readBody(request));
      return forward(request, response, "/exec/" + id + "/start", JSON.stringify({ Detach: started.detach, Tty: started.tty }));
    }
    return forward(request, response, rebuilt("/exec/" + id + "/" + verb, query));
  }

  match = /^\/images\/(.+)\/json$/.exec(path);
  if (match !== null && method === "GET") {
    onlyQuery(query, []);
    let name;
    try { name = decodeURIComponent(match[1]); } catch (error) { deny("image name is not valid"); }
    if (name !== policy.image && !(SVC !== null && serviceImageMayBeInspected(name)) && imageRefusal(name) !== undefined) deny("only the worker's image, a test service's catalog image, or a dev container's image from a listed registry, may be inspected");
    return forward(request, response, "/images/" + encodeURIComponent(name) + "/json");
  }

  // Pulling the image a dev container names: the daemon pulls, so the reference is checked the same way (a listed registry, a plain name), and nothing but the reference and the platform is passed on.
  if (method === "POST" && path === "/images/create") {
    onlyQuery(query, ["fromImage", "tag", "platform"]);
    const from = query.get("fromImage");
    const tag = query.get("tag");
    if (from === null || (tag !== null && !/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,160}$/.test(tag))) deny("the image to pull is not valid");
    const reference = tag === null || tag === "" ? from : from + (IMAGE_DIGEST.test(tag) ? "@" : ":") + tag;
    const refusal = imageRefusal(reference);
    if (refusal !== undefined) deny(refusal);
    const platform = query.get("platform");
    if (platform !== null && !/^[a-z0-9/._-]{1,40}$/.test(platform)) deny("the platform is not valid");
    const pull = new URLSearchParams();
    pull.set("fromImage", from);
    if (tag !== null && tag !== "") pull.set("tag", tag);
    if (platform !== null && platform !== "") pull.set("platform", platform);
    return forward(request, response, "/images/create?" + pull.toString());
  }

  // The events of this worker's own containers only (the dev container tool waits for its container to start): the label filters are forced, so another container of the daemon is never named in an answer.
  if (method === "GET" && path === "/events" && DEV !== undefined) {
    onlyQuery(query, ["filters", "since", "until"]);
    let filters = {};
    if (query.has("filters")) {
      try { filters = JSON.parse(query.get("filters")); } catch (error) { deny("filters are not valid"); }
    }
    if (filters === null || typeof filters !== "object" || Array.isArray(filters)) deny("filters are not valid");
    const given = {};
    Object.keys(filters).forEach(function (key) { if (key === "event" || key === "type") given[key] = filters[key]; });
    given.type = { container: true };
    given.label = {};
    given.label[OWNER + "=" + policy.owner] = true;
    given.label[SANDBOX + "=1"] = true;
    ["since", "until"].forEach(function (key) { if (query.has(key) && !/^[0-9.]{1,32}$/.test(query.get(key))) deny(key + " is not valid"); });
    query.set("filters", JSON.stringify(given));
    return forward(request, response, rebuilt("/events", query));
  }

  match = /^\/networks\/([^/]+)$/.exec(path);
  if (match !== null && method === "GET") {
    if (SVC !== null && decodeURIComponent(match[1]) !== policy.network) return serviceNetworkInspect(request, response, query, decodeURIComponent(match[1]));
    onlyQuery(query, []);
    if (decodeURIComponent(match[1]) !== policy.network) deny("only the sandbox network may be inspected");
    return forward(request, response, "/networks/" + encodeURIComponent(policy.network));
  }
  if (SVC !== null) {
    if (await serviceNetworkRoute(request, response, method, path, query)) return;
  }

  if (SVC !== null && (await serviceContainerRoute(request, response, method, path, query))) return;

  deny("this request is not allowed");
}

function onRequest(request, response) {
  if (process.env.ROVARA_SOCK_DEBUG === "1") log("request", { method: request.method, url: String(request.url).slice(0, 200) });
  route(request, response).catch(function (error) {
    if (error instanceof Refusal) {
      log("refused", { method: request.method, route: String(request.url || "").split("?")[0].replace(/[^A-Za-z0-9/_.:-]/g, "?").slice(0, 80), rule: error.message });
      return send(response, 403, error.message);
    }
    log("error", { reason: String(error && error.message).slice(0, 80) });
    send(response, 502, "the request could not be handled");
  });
}

// An attach upgrade: ONE dispatcher that looks the container up once and hands it to the rule of its own class. A service container gets the service rule (no stdin) and only where test services are on; a sandbox or a dev
// container gets the dev container rule (the dev container tool attaches to the container it just made) and only where dev containers are on. A class is never handed to the other's rule, and with both on neither
// shadows the other.
function attachUpgrade(request, socket, head, target, reference, refuse) {
  let decoded = "";
  try { decoded = decodeURIComponent(reference); } catch (error) { decoded = ""; }
  socket.on("error", function () {});
  socket.pause();
  ownedFound(decoded).then(function (found) {
    if (found === undefined) return refuse("404 Not Found", "no such container of this worker");
    if (found.class === "service" && SVC !== null) return serviceAttach(request, socket, head, target, found, refuse);
    if ((found.class === "sandbox" || found.class === "dev") && DEV !== undefined) return devAttach(request, socket, head, target, found, refuse);
    log("refused", { method: request.method, route: "attach", rule: "no attach for this kind of container" });
    return refuse("403 Forbidden", "this attach is not allowed");
  }).catch(function () { refuse("502 Bad Gateway", "the request could not be handled"); });
}

// A dev container's docker run attaches to the container it just made (its output is the start-up line). Only the attach of an owned container, with the options below and no body; the guard sends the daemon a request
// of its own making and passes bytes on only after the daemon has answered 101.
function devAttach(request, socket, head, target, found, refuse) {
  const allowed = ["stream", "stdin", "stdout", "stderr", "logs", "detachKeys"];
  const bad = Array.from(target.searchParams.keys()).some(function (key) { return allowed.indexOf(key) === -1; });
  const length = request.headers["content-length"] === undefined ? 0 : Number(request.headers["content-length"]);
  if (request.method !== "POST" || bad || request.headers["transfer-encoding"] !== undefined || length !== 0 || (head && head.length > 0)) {
    log("refused", { method: request.method, route: "upgrade", rule: "not an attach of this worker" });
    return refuse("403 Forbidden", "this upgrade is not allowed");
  }
  const upstream = net.connect({ path: policy.upstream });
  let answer = Buffer.alloc(0);
  upstream.on("error", function () { socket.destroy(); });
  socket.on("close", function () { upstream.destroy(); });
  upstream.on("close", function () { socket.destroy(); });
  upstream.on("connect", function () {
    const query = new URLSearchParams();
    allowed.forEach(function (key) { if (target.searchParams.has(key)) query.set(key, target.searchParams.get(key)); });
    const text = query.toString();
    upstream.write("POST /containers/" + found.id + "/attach" + (text === "" ? "" : "?" + text) + " HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 0\r\n\r\n");
  });
  upstream.on("data", function onAnswer(chunk) {
    answer = Buffer.concat([answer, chunk]);
    if (answer.length > 16384) return upstream.destroy();
    if (answer.indexOf("\r\n\r\n") === -1) return;
    upstream.removeListener("data", onAnswer);
    upstream.pause();
    if (!/^HTTP\/1\.1 101 /.test(answer.subarray(0, 16).toString("latin1"))) {
      socket.end(answer);
      upstream.destroy();
      return;
    }
    socket.write(answer);
    socket.pipe(upstream);
    upstream.pipe(socket);
    socket.resume();
    upstream.resume();
  });
}

// A command's input and output travel over an upgraded connection (docker exec). Nothing the client sends reaches the daemon unread:
// the guard reads the start body itself, sends the daemon a request of its own making, and passes bytes on only after the daemon has
// answered 101. Any other answer is the end of the connection, so a request pipelined behind this one is never read by the daemon
// (the daemon keeps a connection open after an ordinary answer and would take the next request from it).
function onUpgrade(request, socket, head) {
  const refuse = function (status, text) {
    socket.end("HTTP/1.1 " + status + "\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n" + JSON.stringify({ message: "rovara: " + text }));
  };
  const target = new URL(request.url || "/", "http://docker");
  const path = target.pathname.replace(/^\/v[0-9]+(\.[0-9]+)?(?=\/)/, "");
  const attach = /^\/containers\/([^/]+)\/attach$/.exec(path);
  if (attach !== null && (SVC !== null || DEV !== undefined)) return attachUpgrade(request, socket, head, target, attach[1], refuse);
  const match = /^\/exec\/([^/]+)\/start$/.exec(path);
  let id = "";
  try { id = match === null ? "" : decodeURIComponent(match[1]); } catch (error) { id = ""; }
  if (request.method !== "POST" || match === null || target.search !== "" || !execs.has(id)) {
    log("refused", { method: request.method, route: "upgrade", rule: "not an exec of this worker" });
    return refuse("403 Forbidden", "this upgrade is not allowed");
  }
  const length = request.headers["content-length"] === undefined ? 0 : Number(request.headers["content-length"]);
  if (request.headers["transfer-encoding"] !== undefined || !Number.isInteger(length) || length < 0 || length > 4096) return refuse("400 Bad Request", "the start body is not valid");
  socket.on("error", function () {});
  let held = head && head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
  const begin = function () {
    socket.removeListener("data", onData);
    socket.pause();
    const early = held.subarray(length);
    let started;
    try { started = checkExecStartBody(held.subarray(0, length).toString("utf8")); } catch (error) {
      log("refused", { method: "POST", route: "upgrade", rule: error.message });
      return refuse("403 Forbidden", error.message);
    }
    // A detached start is not hijacked by the daemon; it takes the plain route.
    if (started.detach) return refuse("400 Bad Request", "a detached command is started without an upgrade");
    const body = JSON.stringify({ Detach: false, Tty: started.tty });
    const upstream = net.connect({ path: policy.upstream });
    let answer = Buffer.alloc(0);
    upstream.on("error", function () { socket.destroy(); });
    socket.on("close", function () { upstream.destroy(); });
    upstream.on("close", function () { socket.destroy(); });
    upstream.on("connect", function () {
      upstream.write("POST /exec/" + id + "/start HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: " + Buffer.byteLength(body) + "\r\n\r\n" + body);
    });
    upstream.on("data", function onAnswer(chunk) {
      answer = Buffer.concat([answer, chunk]);
      if (answer.length > 16384) return upstream.destroy();
      const end = answer.indexOf("\r\n\r\n");
      if (end === -1) return;
      upstream.removeListener("data", onAnswer);
      upstream.pause();
      if (!/^HTTP\/1\.1 101 /.test(answer.subarray(0, 16).toString("latin1"))) {
        // Not a hijack: what the daemon said is the whole answer.
        socket.end(answer);
        upstream.destroy();
        return;
      }
      socket.write(answer);
      if (early.length > 0) upstream.write(early);
      socket.pipe(upstream);
      upstream.pipe(socket);
      socket.resume();
      upstream.resume();
    });
  };
  const onData = function (chunk) {
    held = Buffer.concat([held, chunk]);
    if (held.length > 65536) return socket.destroy();
    if (held.length >= length) begin();
  };
  if (held.length >= length) begin();
  else socket.on("data", onData);
}

${DOCKER_SOCKET_GUARD_SERVICES_SOURCE}
function createServer() {
  const server = http.createServer({ maxHeaderSize: 16384 }, onRequest);
  server.on("upgrade", onUpgrade);
  server.on("clientError", function (error, socket) { socket.destroy(); });
  server.headersTimeout = 10000;
  return server;
}

function main() {
  const server = createServer();
  server.listen(policy.port || 2375, "0.0.0.0", function () { process.stdout.write(JSON.stringify({ component: "docker-socket-guard", event: "ready" }) + "\n"); });
  process.on("uncaughtException", function (error) { log("error", { reason: String(error && error.code) }); });
  process.on("SIGTERM", function () { process.exit(0); });
}

if (process.env.ROVARA_SOCK_LIBRARY === "1") {
  module.exports = { transformCreate: transformCreate, transformDevcontainerCreate: transformDevcontainerCreate, imageRefusal: imageRefusal, checkExecBody: checkExecBody, buildHostConfig: buildHostConfig, createServer: createServer, Refusal: Refusal, policy: policy, services: SVC === null ? null : servicesLibrary() };
} else {
  main();
}
`;
