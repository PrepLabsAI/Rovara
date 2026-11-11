// The Docker socket guard's rules for test services (a part of the guard program in docker-socket-guard-source.ts, kept as text so the broker needs no build step and tests run the very same text).
//
// WITH `policy.services` UNSET NONE OF THIS IS REACHABLE: every hook in the main program tests `SVC !== null` first, and the guard answers every network call, every other image, every create that is not a task
// sandbox and every attach exactly as it did before (a test builds the guard both ways and compares). `policy.services` is set only when the owner turned test services on and the broker computed the list of
// catalog images this install may start (`local/test-services.ts`).
//
// What a worker with services may additionally do, and nothing else (the worker's own `docker` calls are in packages/worker/src/{run-network,service-helpers,check-sandbox,test-services-run}.ts; each rule below
// is the narrowest shape those calls need, REBUILT by the guard from the fields it understands, never passed on as it came):
//   1. make, inspect, list and remove NETWORKS of its own: only `rovara-svc-<12 hex>`, an internal bridge on the `172.30.<slot>.0/24` of one of its slots (gateway .1, ip range .128/25), the one bridge-name option
//      `rvi<8 hex>`, exactly the run's four labels (the family label must be the network's own name, the workspace label this worker's), never IPv6, attachable, ingress, config-only or a second range; the guard adds
//      the owner label. A network is the worker's only when it carries that owner label, has that name shape and is internal. A cap on how many exist at once.
//   2. `network connect` / `disconnect` of a container of its own (a sandbox or a service container) to or from one of those networks, with one fixed address in the run's own range (.2 to .47, never the gateway):
//      no alias, no link, no other endpoint setting.
//   3. create SERVICE CONTAINERS: containers whose name is `<run network>-<word>`, of one of five fixed profiles, each with a different list of what it may be (below). All of them: non-root unless stated, every
//      capability dropped, no-new-privileges, no privilege, no host namespace, no published or exposed port, no device, no link, no volume other than the bind mounts named below (each read-only, from the run's
//      own folder only), on exactly one network of the worker's own (or, for the resolver guard, the namespace of the worker's own check sandbox), the guard's owner/class/profile labels, a memory, process and CPU
//      limit that cannot be raised past the ceilings below, and at most `maxContainers` of them at once.
//        helper      image is one of the catalog images the broker pinned (`policy.services.images`, by full digest reference), the user is the catalog entry's non-root `uid:gid`.
//        program     image is the worker's own image; entrypoint is exactly the worker's node, and the first argument is a program file shipped in the worker image (`/opt/agentx/packages/worker/dist/<name>.js`):
//                    never `-e`, `--eval` or an option. Used for the health probe, the emulator's control call, the fake server and the name server (user 1000:1000).
//        check       the SEALED CHECK SANDBOX: the task sandbox profile (the same image, user, limits, labels, workspace mount and masks as `transformCreate`), on the run network alone with one address, no name
//                    server of its own, the fixed hostname `check`, and two more read-only mounts at exactly /etc/resolv.conf and /etc/hosts from the run's own folder.
//        resolver    the RESOLVER GUARD, the one container that is root with a capability: the worker's own PINNED image, entrypoint exactly /usr/sbin/iptables-nft, one of the two fixed commands (insert or verify
//                    the DROP of 127.0.0.11), user 0:0, CapDrop ALL and CapAdd exactly NET_ADMIN, a read-only root with one 1 MiB tmpfs at /run, 64 MiB, 32 processes, half a CPU, no mount, no environment, and the
//                    network namespace of the worker's own check sandbox (`container:<run network>-check`, which must exist, be the worker's and have the check profile). Anything else about it is refused.
//   4. a service container is the worker's own: start, stop, restart, wait, logs, inspect, remove (and `rm --volumes`), list (when the listing asks for the run's family label), and `exec`, which runs as the
//      container's own configured non-root user (the guard reads it from the daemon and forces it), never privileged; the resolver guard takes no exec at all.
//   5. `attach` (the hijacked stream `docker run` without --detach waits on) to a container of its own, rebuilt like an exec start, a body of none.
//   6. inspect an image that is in the list (or the pinned resolver guard image).
//   7. pause, unpause and read the stats of a container of its own (the sealed round freezes the working sandbox; the usage record reads memory).
//   8. BINDS ARE COPIES. A bind source comes from the run folder, which the worker can write, so a path there can be a link to anything (the Docker socket, the root, the owner's home) that the daemon would follow when it
//      starts the container. The guard never hands the daemon a path the worker could have changed: it opens the file itself (never following a link, a regular file only, size capped), checks the OPENED file is at
//      exactly the path named (on Linux through /proc/self/fd, so a link in any parent folder is caught too), copies the bytes into `policy.services.bindDirectory` (a folder only this guard writes, outside the run
//      folder, never mounted into the worker, content-addressed, mode 0644) and gives the daemon THAT copy. The files are written once, before the container is created, so a copy is what a mount would have shown.
//   9. USERS are fixed shapes: a catalog helper or a program runs as `uid:gid` with the same non-zero number for both, and never the Docker socket's group; an exec runs as the container's own such user.
// "Sealed" holds while the worker keeps to the sealed round's order (the working sandbox is taken off the run network and paused before the check sandbox starts): it is an integrity property of the worker's own
// code, not a boundary against a worker that is itself compromised. Run networks are bridges WITHOUT a host address (`inhibit_ipv4`, forced by the guard), so a container on one has no route to a service of the host
// or the VM; the guard does not rely on a Docker version to refuse the gateway.
// Everything is JavaScript with no template strings inside (this file is a template string itself).
export const DOCKER_SOCKET_GUARD_SERVICES_SOURCE = String.raw`
// ---- test services (policy.services; unset: nothing below is reachable)
const fs = require("fs");
const crypto = require("crypto");
const SVC = policy.services !== undefined && policy.services !== null && typeof policy.services === "object" ? policy.services : null;
const SERVICE_CLASS = "service";
const MEMORY_LABEL = "rovara.local.memory";
const INHIBIT_IPV4 = "com.docker.network.bridge.inhibit_ipv4";
const BIND_FILE_MAX = 4 * 1048576;
const BIND_FILES_MAX = 256;
const RUN_DIRECTORY_COPY = SVC === null || typeof SVC.bindDirectory !== "string" ? "" : SVC.bindDirectory.replace(/\/+$/, "");
const SOCKET_GROUP = SVC === null || SVC.socketGroup === undefined ? -1 : Number(SVC.socketGroup);
const PROFILE_LABEL = "rovara.local.profile";
const RUN_LABEL_KEYS = ["rovara.run-network", "rovara.run-network.created", "rovara.run-network.expires", "rovara.run-network.workspace"];
const RUN_NETWORK_NAME = /^rovara-svc-[0-9a-f]{12}$/;
const SERVICE_CONTAINER_NAME = /^(rovara-svc-[0-9a-f]{12})-([a-z0-9][a-z0-9-]{0,40})$/;
const RUN_SUBNET = /^172\.30\.([0-9]{1,3})\.0\/24$/;
const RUN_ADDRESS = /^172\.30\.([0-9]{1,3})\.([0-9]{1,3})$/;
const BRIDGE_NAME = /^rvi[0-9a-f]{8}$/;
const ALIAS_NAME = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/;
const PROGRAM_FILE = /^\/opt\/agentx\/packages\/worker\/dist\/[a-z0-9-]{1,60}\.js$/;
const NODE_BINARY = "/usr/local/bin/node";
const IPTABLES_BINARY = "/usr/sbin/iptables-nft";
const RESOLVER_COMMANDS = { "check-guard": ["-w", "5", "-I", "OUTPUT", "1", "-d", "127.0.0.11/32", "-j", "DROP"], "check-guard-check": ["-w", "5", "-C", "OUTPUT", "-d", "127.0.0.11/32", "-j", "DROP"] };
const PINNED_IMAGE = /^(?:[a-z0-9][a-z0-9._\/:-]{0,199}@sha256:[a-f0-9]{64}|sha256:[a-f0-9]{64})$/;
const CHECK_HOSTNAME = "check";
const MIB = 1048576;
const SVC_LIMITS = {
  networks: SVC === null ? 0 : Math.max(1, Math.min(32, SVC.maxNetworks || 4)),
  containers: SVC === null ? 0 : Math.max(1, Math.min(96, SVC.maxContainers || 48)),
  helperMemory: SVC === null ? 0 : Math.max(64, Math.min(16384, SVC.maxMemoryMiB || 3072)) * MIB,
  programMemory: 512 * MIB,
  // All the service containers of one worker together may be given this much memory: what the SVC says, never more than three quarters of what the machine has.
  totalMemory: SVC === null ? 0 : Math.min(Math.floor(MEMORY_CEILING * 0.75), (SVC.maxTotalMemoryMiB ? Math.max(256, Math.min(65536, SVC.maxTotalMemoryMiB)) : 65536) * MIB),
  nanoCpus: 4000000000,
  pids: 4096,
  binds: 12,
  tmpfs: 8,
  env: 500,
  aliases: 8,
};
const SLOT_FIRST = SVC === null ? 0 : (SVC.slots && SVC.slots.first) || 1;
const SLOT_LAST = SVC === null ? 0 : (SVC.slots && SVC.slots.last) || 253;
const SVC_IMAGES = SVC === null ? [] : (Array.isArray(SVC.images) ? SVC.images.filter(function (entry) { return typeof entry === "string" && entry.length > 0 && entry.length <= 400; }) : []);
const RUN_DIRECTORY = SVC === null || typeof SVC.runDirectory !== "string" ? "" : SVC.runDirectory.replace(/\/+$/, "");
const GUARD_IMAGE = SVC === null || typeof SVC.guardImage !== "string" ? "" : SVC.guardImage;

function asksForRunFamily(labelFilter) {
  return Object.keys(labelFilter).some(function (key) { return key === RUN_LABEL_KEYS[0] || key.indexOf(RUN_LABEL_KEYS[0] + "=") === 0 || key.indexOf(RUN_LABEL_KEYS[0] + ".") === 0; });
}
function serviceImageMayBeInspected(name) {
  return SVC_IMAGES.indexOf(name) !== -1 || (GUARD_IMAGE !== "" && name === GUARD_IMAGE);
}


// The one shape of a user a service container runs as: the same non-zero number for the user and the group, and never the Docker socket's group. Returns the sentence that refuses it, or undefined.
function serviceUserRefusal(user) {
  if (typeof user !== "string" || !/^[1-9][0-9]{0,4}:[1-9][0-9]{0,4}$/.test(user)) return "a service container runs as a non-root user and group of the same number";
  const parts = user.split(":");
  if (parts[0] !== parts[1]) return "a service container runs as a non-root user and group of the same number";
  if (Number(parts[1]) === SOCKET_GROUP) return "a service container never runs in the Docker socket's group";
  return undefined;
}
// What is never put in the environment of a service container: the variables that make a program load code of the caller's (a node option, a preload).
function serviceEnvRefusal(env, strict) {
  if (env === undefined || env === null) return undefined;
  for (let index = 0; index < env.length; index += 1) {
    const name = String(env[index]).split("=")[0].toUpperCase();
    if (/^(LD_|DYLD_)/.test(name)) return "a service container's environment never loads code: " + name.split("_")[0] + "_ variables are refused";
    if (strict && (/^NODE_/.test(name) || name === "BASH_ENV" || name === "ENV" || name === "PYTHONSTARTUP" || name === "PYTHONPATH")) return "a worker program's environment never loads code: " + name.split("_")[0] + " variables are refused";
  }
  return undefined;
}

// ---- networks
async function inspectRunNetwork(reference) {
  if (!RUN_NETWORK_NAME.test(reference)) return undefined;
  const answer = await ask("GET", "/networks/" + encodeURIComponent(reference));
  if (answer.status !== 200) return undefined;
  let parsed;
  try { parsed = JSON.parse(answer.body); } catch (error) { return undefined; }
  const labels = (parsed && parsed.Labels) || {};
  if (parsed.Name !== reference || labels[OWNER] !== policy.owner || parsed.Internal !== true || parsed.Driver !== "bridge" || typeof parsed.Id !== "string") return undefined;
  // A run network has no address on the host's side: a bridge that keeps one is a path from a container to every service of the host or the VM, so such a network is not the worker's to use.
  if (!parsed.Options || parsed.Options[INHIBIT_IPV4] !== "true") return undefined;
  const config = parsed.IPAM && Array.isArray(parsed.IPAM.Config) ? parsed.IPAM.Config : [];
  const subnet = config.length === 1 && config[0] && typeof config[0].Subnet === "string" ? config[0].Subnet : "";
  const match = RUN_SUBNET.exec(subnet);
  if (match === null) return undefined;
  return { id: parsed.Id, name: reference, slot: Number(match[1]), subnet: subnet };
}
function runLabelValues(labels, networkName) {
  if (labels === null || typeof labels !== "object" || Array.isArray(labels)) deny("labels are not valid");
  const keys = Object.keys(labels);
  RUN_LABEL_KEYS.forEach(function (key) { if (typeof labels[key] !== "string") deny("a service object carries the run's four labels"); });
  if (labels[RUN_LABEL_KEYS[0]] !== networkName) deny("the run label names another network");
  if (!/^[0-9]{1,16}$/.test(labels[RUN_LABEL_KEYS[1]]) || !/^[0-9]{1,16}$/.test(labels[RUN_LABEL_KEYS[2]])) deny("the run's times are not numbers");
  if (labels[RUN_LABEL_KEYS[3]] !== policy.workspaceKey) deny("the run label names another workspace");
  const out = {};
  RUN_LABEL_KEYS.forEach(function (key) { out[key] = labels[key]; });
  return { values: out, extra: keys.filter(function (key) { return RUN_LABEL_KEYS.indexOf(key) === -1; }) };
}
function transformNetworkCreate(text) {
  let body;
  try { body = JSON.parse(text); } catch (error) { deny("the body is not JSON"); }
  if (body === null || typeof body !== "object" || Array.isArray(body)) deny("the body is not an object");
  const used = ["Name", "Driver", "Internal", "IPAM", "Options", "Labels"];
  const zero = ["EnableIPv6", "Attachable", "Ingress", "ConfigOnly", "ConfigFrom", "CheckDuplicate", "Scope"];
  Object.keys(body).forEach(function (key) {
    if (used.indexOf(key) !== -1) return;
    if (zero.indexOf(key) === -1) deny("network setting " + key + " is not allowed");
    if (key === "CheckDuplicate" ? typeof body[key] !== "boolean" : !emptyish(body[key]) && !(key === "ConfigFrom" && body[key] && typeof body[key] === "object" && emptyish(body[key].Network))) deny("network setting " + key + " is not allowed");
  });
  if (typeof body.Name !== "string" || !RUN_NETWORK_NAME.test(body.Name)) deny("a run network is named rovara-svc- and twelve hex characters");
  if (body.Driver !== "bridge") deny("a run network is a plain bridge");
  if (body.Internal !== true) deny("a run network is internal");
  const ipam = body.IPAM;
  if (ipam === null || typeof ipam !== "object" || Array.isArray(ipam)) deny("a run network has one address range");
  Object.keys(ipam).forEach(function (key) {
    if (key === "Driver") { if (ipam.Driver !== undefined && ipam.Driver !== "" && ipam.Driver !== "default") deny("the address driver is fixed"); return; }
    if (key === "Options") { if (!emptyish(ipam.Options)) deny("address options are not allowed"); return; }
    if (key !== "Config") deny("address setting " + key + " is not allowed");
  });
  if (!Array.isArray(ipam.Config) || ipam.Config.length !== 1 || ipam.Config[0] === null || typeof ipam.Config[0] !== "object") deny("a run network has one address range");
  const range = ipam.Config[0];
  Object.keys(range).forEach(function (key) { if (key !== "Subnet" && key !== "IPRange" && key !== "Gateway" && key !== "AuxiliaryAddresses") deny("range setting " + key + " is not allowed"); });
  if (!emptyish(range.AuxiliaryAddresses)) deny("auxiliary addresses are not allowed");
  const subnet = RUN_SUBNET.exec(String(range.Subnet));
  if (subnet === null) deny("the range is a /24 of 172.30");
  const slot = Number(subnet[1]);
  if (!(slot >= SLOT_FIRST && slot <= SLOT_LAST)) deny("the range is outside this worker's slots");
  if (range.Gateway !== "172.30." + slot + ".1" || range.IPRange !== "172.30." + slot + ".128/25") deny("the gateway and the range of a run network are fixed");
  const options = body.Options === null || body.Options === undefined ? {} : body.Options;
  const optionKeys = typeof options === "object" && !Array.isArray(options) ? Object.keys(options) : ["?"];
  if (optionKeys.length !== 1 || optionKeys[0] !== "com.docker.network.bridge.name" || !BRIDGE_NAME.test(String(options["com.docker.network.bridge.name"]))) deny("a run network has the one bridge-name option");
  const labels = runLabelValues(body.Labels, body.Name);
  if (labels.extra.length > 0) deny("a run network carries the run's labels and no other");
  const out = {
    Name: body.Name, Driver: "bridge", Internal: true, EnableIPv6: false, Attachable: false, Ingress: false, CheckDuplicate: true,
    IPAM: { Driver: "default", Config: [{ Subnet: range.Subnet, IPRange: range.IPRange, Gateway: range.Gateway }] },
    // The guard adds the option that takes the bridge's own address away; the worker does not name it.
    Options: { "com.docker.network.bridge.name": options["com.docker.network.bridge.name"], "com.docker.network.bridge.inhibit_ipv4": "true" },
    Labels: Object.assign({}, labels.values),
  };
  out.Labels[OWNER] = policy.owner;
  return JSON.stringify(out);
}
// An address of the run's own range that a container may be given: .2 to .47 of the network's slot.
function runAddressIn(network, address) {
  const match = typeof address === "string" ? RUN_ADDRESS.exec(address) : null;
  if (match === null || Number(match[1]) !== network.slot) deny("an address must be in the run network's own range");
  const last = Number(match[2]);
  if (String(last) !== match[2] || last < 2 || last > 47) deny("an address must be one of the reserved ones, .2 to .47");
  return address;
}
async function countOwnedNetworks() {
  const filters = { label: {}, name: { "rovara-svc-": true } };
  filters.label[OWNER + "=" + policy.owner] = true;
  const answer = await ask("GET", "/networks?filters=" + encodeURIComponent(JSON.stringify(filters)));
  try { return JSON.parse(answer.body).filter(function (entry) { return RUN_NETWORK_NAME.test(String(entry.Name)); }).length; } catch (error) { return Infinity; }
}
async function countOwnedContainers() {
  const filters = { label: {} };
  filters.label[OWNER + "=" + policy.owner] = true;
  filters.label[SANDBOX + "=" + SERVICE_CLASS] = true;
  const answer = await ask("GET", "/containers/json?all=1&filters=" + encodeURIComponent(JSON.stringify(filters)));
  try { return JSON.parse(answer.body).length; } catch (error) { return Infinity; }
}
// How many service containers this worker has, and how much memory they are allowed in all (a container without the guard's memory label counts as a plain sandbox's default).
async function ownedServiceUsage() {
  const filters = { label: {} };
  filters.label[OWNER + "=" + policy.owner] = true;
  filters.label[SANDBOX + "=" + SERVICE_CLASS] = true;
  const answer = await ask("GET", "/containers/json?all=1&filters=" + encodeURIComponent(JSON.stringify(filters)));
  try {
    const rows = JSON.parse(answer.body);
    let memory = 0;
    rows.forEach(function (row) { const own = Number((row.Labels || {})[MEMORY_LABEL]); memory += Number.isFinite(own) && own > 0 ? own : DEFAULT_MEMORY; });
    return { count: rows.length, memory: memory };
  } catch (error) { return { count: Infinity, memory: Infinity }; }
}

async function serviceNetworkInspect(request, response, query, reference) {
  onlyQuery(query, ["verbose", "scope"]);
  const network = await inspectRunNetwork(reference);
  if (network === undefined) return send(response, 404, "no such run network of this worker");
  return forward(request, response, "/networks/" + network.id);
}
// Answers true when it served (or refused) the request, false when it is not a run-network request at all (the caller then refuses it as before).
async function serviceNetworkRoute(request, response, method, path, query) {
  if (method === "POST" && path === "/networks/create") {
    onlyQuery(query, []);
    const body = transformNetworkCreate(await readBody(request));
    const turn = createQueue;
    let release = function () {};
    createQueue = new Promise(function (resolve) { release = resolve; });
    await turn;
    try {
      if ((await countOwnedNetworks()) >= SVC_LIMITS.networks) {
        response.writeHead(429, { "content-type": "application/json" });
        response.end(JSON.stringify({ message: "rovara: too many run networks at once" }));
        return true;
      }
      await forward(request, response, "/networks/create", body);
      return true;
    } finally {
      release();
    }
  }
  if (method === "GET" && path === "/networks") {
    onlyQuery(query, ["filters"]);
    let filters = {};
    if (query.has("filters")) { try { filters = JSON.parse(query.get("filters")); } catch (error) { deny("filters are not valid"); } }
    if (filters === null || typeof filters !== "object" || Array.isArray(filters)) deny("filters are not valid");
    const asMap = function (value) {
      if (Array.isArray(value)) { const map = {}; value.forEach(function (entry) { map[String(entry)] = true; }); return map; }
      return value === undefined || value === null || typeof value !== "object" ? {} : value;
    };
    Object.keys(filters).forEach(function (key) { filters[key] = asMap(filters[key]); });
    filters.label = filters.label || {};
    filters.label[OWNER + "=" + policy.owner] = true;
    filters.name = filters.name || {};
    filters.name["rovara-svc-"] = true;
    query.set("filters", JSON.stringify(filters));
    await forward(request, response, rebuilt("/networks", query));
    return true;
  }
  let match = /^\/networks\/([^/]+)$/.exec(path);
  if (match !== null && method === "DELETE") {
    onlyQuery(query, []);
    const network = await inspectRunNetwork(decodeURIComponent(match[1]));
    if (network === undefined) { send(response, 404, "no such run network of this worker"); return true; }
    await forward(request, response, "/networks/" + network.id);
    return true;
  }
  match = /^\/networks\/([^/]+)\/(connect|disconnect)$/.exec(path);
  if (match !== null && method === "POST") {
    onlyQuery(query, []);
    const network = await inspectRunNetwork(decodeURIComponent(match[1]));
    if (network === undefined) { send(response, 404, "no such run network of this worker"); return true; }
    let body;
    try { body = JSON.parse(await readBody(request)); } catch (error) { deny("the body is not JSON"); }
    if (body === null || typeof body !== "object" || Array.isArray(body)) deny("the body is not an object");
    const used = match[2] === "connect" ? ["Container", "EndpointConfig"] : ["Container", "Force"];
    Object.keys(body).forEach(function (key) { if (used.indexOf(key) === -1) deny("network " + match[2] + " setting " + key + " is not allowed"); });
    if (typeof body.Container !== "string") deny("a container is named");
    const found = await ownedFound(body.Container);
    if (found === undefined) { send(response, 404, "no such container of this worker"); return true; }
    // Only the worker's own working sandbox and its service containers join a run network: a project's dev container (it keeps Docker's default capabilities) never does.
    if (found.class !== "sandbox" && found.class !== "service") deny("only a sandbox or a service container joins a run network");
    if (match[2] === "disconnect") {
      if (body.Force !== undefined && body.Force !== null && typeof body.Force !== "boolean") deny("Force is not valid");
      await forward(request, response, "/networks/" + network.id + "/disconnect", JSON.stringify({ Container: found.id, Force: body.Force === true }));
      return true;
    }
    const endpoint = body.EndpointConfig === undefined || body.EndpointConfig === null ? {} : body.EndpointConfig;
    if (typeof endpoint !== "object" || Array.isArray(endpoint)) deny("the endpoint is not valid");
    const zero = ["Links", "Aliases", "NetworkID", "EndpointID", "Gateway", "IPAddress", "IPPrefixLen", "IPv6Gateway", "GlobalIPv6Address", "GlobalIPv6PrefixLen", "MacAddress", "DriverOpts", "DNSNames", "GwPriority"];
    knownKeys(endpoint, ["IPAMConfig"], zero, "endpoint setting");
    const ipam = endpoint.IPAMConfig;
    if (ipam === null || ipam === undefined || typeof ipam !== "object" || Array.isArray(ipam)) deny("an address is given");
    knownKeys(ipam, ["IPv4Address"], ["IPv6Address", "LinkLocalIPs"], "address setting");
    const address = runAddressIn(network, ipam.IPv4Address);
    await forward(request, response, "/networks/" + network.id + "/connect", JSON.stringify({ Container: found.id, EndpointConfig: { IPAMConfig: { IPv4Address: address } } }));
    return true;
  }
  return false;
}

// pause and unpause (the sealed round freezes the working sandbox) and stats (the usage record's memory figure), for a container of this worker's: no body, no other option.
async function serviceContainerRoute(request, response, method, path, query) {
  const match = /^\/containers\/([^/]+)\/(pause|unpause|stats)$/.exec(path);
  if (match === null) return false;
  const verb = match[2];
  if (method !== (verb === "stats" ? "GET" : "POST")) deny("method not allowed");
  onlyQuery(query, verb === "stats" ? ["stream", "one-shot"] : []);
  const id = await ownedId(decodeURIComponent(match[1]));
  if (id === undefined) { send(response, 404, "no such container of this worker"); return true; }
  await forward(request, response, rebuilt("/containers/" + id + "/" + verb, query));
  return true;
}

// ---- service containers
const SVC_TOP_USED = ["Image", "Cmd", "Entrypoint", "Env", "User", "Labels", "HostConfig", "NetworkingConfig", "Tty", "OpenStdin", "AttachStdin", "AttachStdout", "AttachStderr", "StdinOnce", "StopSignal", "StopTimeout"];
const SVC_TOP_ZERO = ["Hostname", "Domainname", "WorkingDir", "Volumes", "ExposedPorts", "MacAddress", "Healthcheck", "NetworkDisabled", "OnBuild", "ArgsEscaped", "Shell"];
const SVC_HOST_USED = ["Binds", "Tmpfs", "NetworkMode", "CapDrop", "CapAdd", "SecurityOpt", "Privileged", "PidsLimit", "Memory", "MemorySwap", "MemoryReservation", "NanoCpus", "CpuShares", "ShmSize", "ReadonlyRootfs", "Init", "AutoRemove",
  "MemorySwappiness", "LogConfig", "RestartPolicy", "Ulimits", "CpusetCpus", "CgroupnsMode", "Isolation", "MaskedPaths", "ReadonlyPaths", "Sysctls"];
const SVC_HOST_ZERO = HOST_ZERO.filter(function (key) { return key !== "CapAdd" && key !== "Sysctls"; });
// A bind never lands on the system folders or the runtime folders (where a socket lives); a tmpfs is a fresh memory folder of the container's own, so only the kernel's folders are off limits to it.
const FORBIDDEN_BIND_TARGET_ROOTS = ["proc", "sys", "dev", "run", "var/run"];
const FORBIDDEN_TMPFS_TARGET_ROOTS = ["proc", "sys", "dev"];

function plainPath(value) {
  return typeof value === "string" && /^\/[A-Za-z0-9._\/-]{1,200}$/.test(value) && value.split("/").indexOf("..") === -1 && value.indexOf("//") === -1;
}
function underRoot(path, roots) {
  const clean = path.replace(/^\/+/, "");
  return roots.some(function (root) { return clean === root || clean.indexOf(root + "/") === 0; });
}
// A copy nobody has asked for in an hour is removed (a container made from it was started long ago: the daemon keeps what it mounted), so a worker that runs for weeks never fills the folder. Called before a new copy is made.
const COPY_KEEP_MS = 3600000;
function sweepCopies() {
  let names;
  try { names = fs.readdirSync(RUN_DIRECTORY_COPY); } catch (error) { return; }
  const now = Date.now();
  names.forEach(function (name) {
    try {
      const path = RUN_DIRECTORY_COPY + "/" + name;
      const found = fs.lstatSync(path);
      if (found.isFile() && now - found.mtimeMs > COPY_KEEP_MS) fs.unlinkSync(path);
    } catch (error) { /* gone already */ }
  });
}
// A file of the run folder, copied into the guard's own folder, and the path of the COPY. See rule 8 in the header. A path that is a link, that goes through a link, that is not a regular file, that has another name (a hard link, which could be a file from outside the run folder) or that is too big is refused.
// The file is read through the descriptor that was opened (never again by name), so a swap after the open changes nothing: what is copied is what was checked.
function copyOfRunFile(source) {
  if (RUN_DIRECTORY_COPY === "") deny("this worker has no folder for the copies of its run files");
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
  let descriptor;
  try { descriptor = fs.openSync(source, flags); } catch (error) { deny("a service mount is a plain file of the run's own folder"); }
  try {
    const found = fs.fstatSync(descriptor);
    if (!found.isFile() || found.nlink !== 1 || found.size > BIND_FILE_MAX) deny("a service mount is a plain file of the run's own folder");
    // The opened file must BE the path named: no link in the file or in any folder above it. Linux names the opened file in /proc; elsewhere (a test on another system) the real path must equal the path.
    let at;
    try { at = fs.readlinkSync("/proc/self/fd/" + descriptor); } catch (error) { at = undefined; }
    // The guard always runs in a Linux container, where /proc names the opened file, so a failed read there refuses the request (the realpath fallback can race a swap of a parent folder).
    if (at === undefined && process.platform === "linux") deny("a service mount is a plain file of the run's own folder");
    if (at === undefined) { try { at = fs.realpathSync(source); } catch (error) { at = undefined; } }
    if (at !== source) deny("a service mount is a plain file of the run's own folder");
    const chunks = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(65536);
      const read = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (read === 0) break;
      total += read;
      if (total > BIND_FILE_MAX) deny("a service mount is a plain file of the run's own folder");
      chunks.push(chunk.subarray(0, read));
    }
    const bytes = Buffer.concat(chunks);
    const name = crypto.createHash("sha256").update(bytes).digest("hex");
    const target = RUN_DIRECTORY_COPY + "/" + name;
    if (fs.existsSync(target)) {
      // Used again: it is young again.
      try { const now = new Date(); fs.utimesSync(target, now, now); } catch (error) { /* a copy that vanished is made again by the next call */ }
    } else {
      sweepCopies();
      if (fs.readdirSync(RUN_DIRECTORY_COPY).length >= BIND_FILES_MAX) deny("too many files copied for this worker's service mounts");
      const temporary = target + "." + crypto.randomBytes(6).toString("hex") + ".tmp";
      fs.writeFileSync(temporary, bytes, { mode: 420, flag: "wx" });
      fs.chmodSync(temporary, 420);
      fs.renameSync(temporary, target);
    }
    return target;
  } finally {
    try { fs.closeSync(descriptor); } catch (error) { /* closed */ }
  }
}
// The binds of a service container: each a read-only COPY of one plain file of the run's own folder, to a plain target outside the system folders.
function serviceBindPairs(binds, fixedTargets) {
  const list = binds === null || binds === undefined ? [] : binds;
  if (!stringList(list, SVC_LIMITS.binds)) deny("binds are not valid");
  if (RUN_DIRECTORY === "") deny("this worker has no run folder");
  return list.map(function (bind) {
    const parts = bind.split(":");
    if (parts.length !== 3 || parts[2] !== "ro") deny("a service mount is read-only");
    if (!plainPath(parts[0]) || parts[0].indexOf(RUN_DIRECTORY + "/") !== 0) deny("a service mount comes from the run's own folder");
    if (!plainPath(parts[1]) || underRoot(parts[1], FORBIDDEN_BIND_TARGET_ROOTS)) deny("a service mount goes to a plain place outside the system folders");
    if (fixedTargets !== undefined && fixedTargets.indexOf(parts[1]) === -1) deny("this container's mounts are fixed");
    return { original: bind, copy: copyOfRunFile(parts[0]) + ":" + parts[1] + ":ro" };
  });
}
function serviceBinds(binds, fixedTargets) {
  return serviceBindPairs(binds, fixedTargets).map(function (pair) { return pair.copy; });
}
function serviceTmpfs(tmpfs) {
  const value = tmpfs === null || tmpfs === undefined ? {} : tmpfs;
  if (typeof value !== "object" || Array.isArray(value)) deny("tmpfs is not valid");
  const out = {};
  const keys = Object.keys(value);
  if (keys.length > SVC_LIMITS.tmpfs) deny("too many tmpfs");
  keys.forEach(function (path) {
    if (!plainPath(path) || underRoot(path, FORBIDDEN_TMPFS_TARGET_ROOTS) || typeof value[path] !== "string" || !/^[a-z0-9=,_-]{0,100}$/.test(value[path])) deny("a tmpfs goes to a plain place outside the system folders");
    const size = /(?:^|,)(size=[0-9]{1,6}m)(?:,|$)/.exec(value[path]);
    // A size the guard cannot read would be dropped and the kernel's default (half the memory) used instead, so it is refused: the size is in whole megabytes, or absent.
    if (size === null && /(?:^|,)size=/.test(value[path])) deny("a tmpfs size is in whole megabytes (for example size=16m)");
    if (size !== null && Number(size[1].slice(5, -1)) > 1024) deny("a tmpfs is at most 1024m");
    const uid = /(?:^|,)(uid=[0-9]{1,5})(?:,|$)/.exec(value[path]);
    const gid = /(?:^|,)(gid=[0-9]{1,5})(?:,|$)/.exec(value[path]);
    out[path] = ["rw", "nosuid", "nodev", "noexec"].concat(size ? [size[1]] : [], uid ? [uid[1]] : [], gid ? [gid[1]] : []).join(",");
  });
  return out;
}
function serviceLog(config) {
  const type = config && config.Type;
  if (type === undefined || type === "" || type === null) return undefined;
  if (type === "none") return { Type: "none" };
  if (type !== "local") deny("only the default, local or no log driver is allowed");
  const out = { Type: "local", Config: {} };
  const options = config.Config === null || config.Config === undefined ? {} : config.Config;
  if (typeof options !== "object" || Array.isArray(options)) deny("log options are not valid");
  Object.keys(options).forEach(function (key) {
    if ((key !== "max-size" && key !== "max-file" && key !== "compress") || typeof options[key] !== "string" || !/^[a-z0-9]{1,8}$/.test(options[key])) deny("log option " + key + " is not allowed");
    out.Config[key] = options[key];
  });
  return out;
}
// required: the container is given one fixed address of the run's range (a helper, the name server, the check sandbox). A short-lived probe takes whatever the daemon gives it from the network's dynamic half.
function serviceEndpoint(netName, network, body, required) {
  const config = body.NetworkingConfig;
  if (config === null || typeof config !== "object" || Array.isArray(config)) deny("the endpoint is missing");
  Object.keys(config).forEach(function (key) { if (key !== "EndpointsConfig") deny("network setting " + key + " is not allowed"); });
  const endpoints = config.EndpointsConfig;
  if (endpoints === null || typeof endpoints !== "object" || Array.isArray(endpoints) || Object.keys(endpoints).length !== 1 || Object.keys(endpoints)[0] !== netName) deny("exactly one endpoint, on the run's network");
  const endpoint = endpoints[netName];
  if (endpoint === null || typeof endpoint !== "object" || Array.isArray(endpoint)) deny("the endpoint is not valid");
  knownKeys(endpoint, ["IPAMConfig", "Aliases"], ["Links", "NetworkID", "EndpointID", "Gateway", "IPAddress", "IPPrefixLen", "IPv6Gateway", "GlobalIPv6Address", "GlobalIPv6PrefixLen", "MacAddress", "DriverOpts", "DNSNames", "GwPriority"], "endpoint setting");
  const ipam = endpoint.IPAMConfig;
  let address;
  if (ipam === null || ipam === undefined) {
    if (required) deny("an address is given");
  } else {
    if (typeof ipam !== "object" || Array.isArray(ipam)) deny("an address is given");
    knownKeys(ipam, ["IPv4Address"], ["IPv6Address", "LinkLocalIPs"], "address setting");
    address = runAddressIn(network, ipam.IPv4Address);
  }
  const aliases = endpoint.Aliases === null || endpoint.Aliases === undefined ? [] : endpoint.Aliases;
  if (!Array.isArray(aliases) || aliases.length > SVC_LIMITS.aliases || !aliases.every(function (alias) { return typeof alias === "string" && ALIAS_NAME.test(alias); })) deny("an alias is a short lower-case name");
  const out = {};
  if (address !== undefined) out.IPAMConfig = { IPv4Address: address };
  if (aliases.length > 0) out.Aliases = aliases;
  return { address: address, endpoint: out };
}
function serviceLimits(host, ceiling) {
  const memory = numberOr(host.Memory, 0, "Memory");
  const swap = numberOr(host.MemorySwap, 0, "MemorySwap");
  if (memory <= 0 || memory > ceiling || memory > MEMORY_CEILING) deny("a service container has a memory limit within its ceiling");
  if (swap !== memory) deny("a service container's swap is its memory limit");
  const cpus = numberOr(host.NanoCpus, 0, "NanoCpus");
  if (cpus <= 0 || cpus > SVC_LIMITS.nanoCpus) deny("a service container has a CPU limit within its ceiling");
  const pids = host.PidsLimit;
  if (typeof pids !== "number" || !(pids > 0) || pids > SVC_LIMITS.pids) deny("a service container has a process limit within its ceiling");
  return { Memory: memory, MemorySwap: swap, NanoCpus: cpus, PidsLimit: pids };
}
function serviceSysctls(sysctls) {
  if (sysctls === null || sysctls === undefined) return { "net.ipv6.conf.all.disable_ipv6": "1" };
  if (typeof sysctls !== "object" || Array.isArray(sysctls)) deny("sysctls are not valid");
  const keys = Object.keys(sysctls);
  if (keys.length > 1 || (keys.length === 1 && (keys[0] !== "net.ipv4.ip_unprivileged_port_start" || !/^[0-9]{1,4}$/.test(String(sysctls[keys[0]])) || Number(sysctls[keys[0]]) < 1 || Number(sysctls[keys[0]]) > 1023))) deny("the one sysctl allowed is the first unprivileged port, between 1 and 1023");
  // IPv6 is off in every service container: the run networks are IPv4 only, and an address of another family must not be a way round the rules of the network.
  const out = { "net.ipv6.conf.all.disable_ipv6": "1" };
  keys.forEach(function (key) { out[key] = String(sysctls[key]); });
  return out;
}

// The body of one service container, rebuilt. profile is helper | program | resolver (the sealed check sandbox goes through transformCreate).
async function buildServiceBody(name, text) {
  let body;
  try { body = JSON.parse(text); } catch (error) { deny("the body is not JSON"); }
  if (body === null || typeof body !== "object" || Array.isArray(body)) deny("the body is not an object");
  const parts = SERVICE_CONTAINER_NAME.exec(name);
  const netName = parts[1];
  const suffix = parts[2];
  const network = await inspectRunNetwork(netName);
  if (network === undefined) deny("a service container joins a run network of this worker");
  knownKeys(body, SVC_TOP_USED, SVC_TOP_ZERO, "setting");
  const host = body.HostConfig;
  if (host === null || typeof host !== "object" || Array.isArray(host)) deny("host config is missing");
  knownKeys(host, SVC_HOST_USED, SVC_HOST_ZERO, "host setting");
  if (host.Privileged === true || (host.Privileged !== undefined && host.Privileged !== false && host.Privileged !== null)) deny("privileged mode is not allowed");
  if (!Array.isArray(host.CapDrop) || !host.CapDrop.some(function (cap) { return String(cap).toUpperCase() === "ALL"; })) deny("all capabilities must be dropped");
  if (!stringList(host.SecurityOpt, 8) || host.SecurityOpt.length === 0 || !host.SecurityOpt.every(function (entry) { return /^no-new-privileges(:true|=true)?$/.test(entry); })) deny("only no-new-privileges is allowed as a security option");
  if (host.MaskedPaths !== null && host.MaskedPaths !== undefined) deny("masked paths cannot be changed");
  if (host.ReadonlyPaths !== null && host.ReadonlyPaths !== undefined) deny("read-only paths cannot be changed");
  if (host.CgroupnsMode !== undefined && host.CgroupnsMode !== "" && host.CgroupnsMode !== "private") deny("the cgroup namespace cannot be changed");
  if (host.Isolation !== undefined && host.Isolation !== "" && host.Isolation !== "default") deny("isolation cannot be changed");
  const restart = host.RestartPolicy && host.RestartPolicy.Name;
  if (restart !== undefined && restart !== "" && restart !== "no") deny("a service container does not restart");
  if (host.CpusetCpus !== undefined && host.CpusetCpus !== null && host.CpusetCpus !== "") deny("cpuset is not allowed");
  if (host.Ulimits !== undefined && host.Ulimits !== null && !(Array.isArray(host.Ulimits) && host.Ulimits.length === 0)) deny("ulimits are not allowed");
  ["Tty", "OpenStdin", "AttachStdin", "AttachStdout", "AttachStderr", "StdinOnce"].forEach(function (key) { if (body[key] !== undefined && body[key] !== null && typeof body[key] !== "boolean") deny(key + " is not valid"); });
  if (body.Tty === true || body.OpenStdin === true || body.AttachStdin === true || body.StdinOnce === true) deny("a service container takes no input");
  if (body.StopSignal !== undefined && body.StopSignal !== null && (typeof body.StopSignal !== "string" || !/^[A-Za-z0-9]{0,16}$/.test(body.StopSignal))) deny("StopSignal is not valid");
  if (body.StopTimeout !== undefined && body.StopTimeout !== null && !(typeof body.StopTimeout === "number" && body.StopTimeout >= 0 && body.StopTimeout <= 600)) deny("StopTimeout is not valid");
  ["Cmd", "Entrypoint"].forEach(function (key) { if (body[key] !== undefined && body[key] !== null && !stringList(body[key], 256)) deny(key + " is not valid"); });
  if (body.Env !== undefined && body.Env !== null && !stringList(body.Env, SVC_LIMITS.env)) deny("Env is not valid");

  const labelInfo = runLabelValues(body.Labels === null || body.Labels === undefined ? {} : body.Labels, netName);
  if (labelInfo.extra.length > 0) deny("a service container carries the run's labels and no other");
  const labels = Object.assign({}, labelInfo.values);
  labels[OWNER] = policy.owner;
  labels[SANDBOX] = SERVICE_CLASS;

  let profile;
  const out = { Cmd: body.Cmd === undefined ? null : body.Cmd, Entrypoint: body.Entrypoint === undefined ? null : body.Entrypoint, Env: body.Env === undefined ? null : body.Env,
    Tty: false, OpenStdin: false, AttachStdin: false, StdinOnce: false, AttachStdout: body.AttachStdout === true, AttachStderr: body.AttachStderr === true };
  const hostOut = {
    CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"], Privileged: false,
    ReadonlyRootfs: booleanOr(host.ReadonlyRootfs, "ReadonlyRootfs"), Init: booleanOr(host.Init, "Init"), AutoRemove: booleanOr(host.AutoRemove, "AutoRemove"),
    MemoryReservation: numberOr(host.MemoryReservation, 0, "MemoryReservation"), CpuShares: numberOr(host.CpuShares, 0, "CpuShares"), ShmSize: numberOr(host.ShmSize, 0, "ShmSize"),
  };
  if (hostOut.CpuShares > 2048) deny("CpuShares is above the ceiling");
  if (hostOut.ShmSize > 256 * MIB) deny("ShmSize is above the ceiling");
  if (hostOut.MemoryReservation > 0 && host.Memory !== undefined && hostOut.MemoryReservation > host.Memory) deny("MemoryReservation is above the memory limit");
  if (typeof body.StopSignal === "string" && body.StopSignal !== "") out.StopSignal = body.StopSignal;
  if (typeof body.StopTimeout === "number") out.StopTimeout = body.StopTimeout;

  if (suffix === "check-guard" || suffix === "check-guard-check") {
    // ---- the resolver guard: the one root container with a capability. Everything is an exact match.
    profile = "resolver";
    if (GUARD_IMAGE === "" || !PINNED_IMAGE.test(GUARD_IMAGE) || body.Image !== GUARD_IMAGE) deny("the resolver guard runs the worker's own pinned image");
    if (body.User !== "0:0") deny("the resolver guard's user is fixed");
    if (!Array.isArray(body.Entrypoint) || body.Entrypoint.length !== 1 || body.Entrypoint[0] !== IPTABLES_BINARY) deny("the resolver guard's program is fixed");
    const wanted = RESOLVER_COMMANDS[suffix];
    if (!Array.isArray(body.Cmd) || body.Cmd.length !== wanted.length || body.Cmd.some(function (word, index) { return word !== wanted[index]; })) deny("the resolver guard's command is fixed");
    if (body.Env !== undefined && body.Env !== null && !(Array.isArray(body.Env) && body.Env.length === 0)) deny("the resolver guard takes no environment");
    // The docker CLI spells a capability with or without the CAP_ prefix; the daemon gets it spelled the one way.
    if (!Array.isArray(host.CapAdd) || host.CapAdd.length !== 1 || String(host.CapAdd[0]).toUpperCase().replace(/^CAP_/, "") !== "NET_ADMIN") deny("the resolver guard holds exactly NET_ADMIN");
    if (host.CapDrop.length !== 1 || String(host.CapDrop[0]).toUpperCase() !== "ALL") deny("the resolver guard drops everything else");
    if (host.ReadonlyRootfs !== true || host.AutoRemove !== true) deny("the resolver guard has a read-only root and is removed when it ends");
    if (host.Binds !== undefined && host.Binds !== null && !(Array.isArray(host.Binds) && host.Binds.length === 0)) deny("the resolver guard has no mount");
    if (host.Sysctls !== undefined && host.Sysctls !== null && Object.keys(host.Sysctls).length !== 0) deny("the resolver guard sets no sysctl");
    const tmpfs = host.Tmpfs === null || host.Tmpfs === undefined ? {} : host.Tmpfs;
    const tmpfsKeys = typeof tmpfs === "object" && !Array.isArray(tmpfs) ? Object.keys(tmpfs) : ["?"];
    if (tmpfsKeys.length !== 1 || tmpfsKeys[0] !== "/run" || tmpfs["/run"] !== "rw,noexec,nosuid,nodev,size=1m") deny("the resolver guard has one small tmpfs at /run");
    if (host.PidsLimit !== 32 || host.Memory !== 64 * MIB || host.MemorySwap !== 64 * MIB || host.NanoCpus !== 500000000) deny("the resolver guard's limits are fixed");
    const log = serviceLog(host.LogConfig);
    if (log !== undefined) deny("the resolver guard keeps the default log");
    const base = netName + "-check";
    if (host.NetworkMode !== "container:" + base) deny("the resolver guard joins the check sandbox's network and nothing else");
    const target = await ownedFound(base);
    if (target === undefined || target.profile !== "check" || target.name !== base) deny("the check sandbox is not this worker's");
    const empty = body.NetworkingConfig;
    if (empty !== undefined && empty !== null && !(typeof empty === "object" && !Array.isArray(empty) && (Object.keys(empty).length === 0 || (Object.keys(empty).length === 1 && empty.EndpointsConfig !== undefined && emptyish(empty.EndpointsConfig))))) deny("a resolver guard has no network settings of its own");
    out.Image = GUARD_IMAGE;
    out.User = "0:0";
    out.Entrypoint = [IPTABLES_BINARY];
    out.Cmd = wanted;
    out.Env = null;
    hostOut.CapDrop = ["ALL"]; hostOut.CapAdd = ["NET_ADMIN"]; hostOut.NetworkMode = host.NetworkMode; hostOut.Tmpfs = { "/run": "rw,noexec,nosuid,nodev,size=1m" };
    hostOut.PidsLimit = 32; hostOut.Memory = 64 * MIB; hostOut.MemorySwap = 64 * MIB; hostOut.NanoCpus = 500000000; hostOut.ReadonlyRootfs = true; hostOut.AutoRemove = true;
    hostOut.Binds = [];
    out.NetworkingConfig = {};
    labels[PROFILE_LABEL] = "resolver";
    labels[MEMORY_LABEL] = String(64 * MIB);
  } else {
    // ---- a helper from a catalog image, or a program of the worker's own image
    const fromWorker = body.Image === policy.image;
    if (fromWorker) {
      profile = "program";
      if (body.User !== policy.user) deny("a worker program runs as the sandbox user");
      const refusal = serviceUserRefusal(body.User) || serviceEnvRefusal(body.Env, true);
      if (refusal !== undefined) deny(refusal);
      if (!Array.isArray(body.Entrypoint) || body.Entrypoint.length !== 1 || body.Entrypoint[0] !== NODE_BINARY) deny("a worker program is started by the worker's own node");
      if (!Array.isArray(body.Cmd) || body.Cmd.length === 0 || !PROGRAM_FILE.test(body.Cmd[0])) deny("a worker program is a file shipped in the worker image");
      if (suffix !== "dns" && !/^[hp][0-9a-f]{10}(-c[0-9a-f]{8})?$/.test(suffix)) deny("a service container has one of the run's names");
      if (host.ReadonlyRootfs !== true) deny("a worker program has a read-only root");
    } else {
      profile = "helper";
      if (SVC_IMAGES.indexOf(body.Image) === -1) deny("only the catalog images this install pinned may be started");
      if (!/^[h][0-9a-f]{10}$/.test(suffix)) deny("a catalog helper has one of the run's names");
      const userRefusal = serviceUserRefusal(body.User) || serviceEnvRefusal(body.Env, false);
      if (userRefusal !== undefined) deny(userRefusal);
      if (body.Entrypoint !== undefined && body.Entrypoint !== null) deny("a catalog helper keeps its image's entrypoint");
    }
    if (host.CapAdd !== undefined && host.CapAdd !== null && !(Array.isArray(host.CapAdd) && host.CapAdd.length === 0)) deny("no capability may be added");
    if (host.NetworkMode !== netName) deny("a service container joins its own run network and no other");
    const ceiling = fromWorker ? SVC_LIMITS.programMemory : SVC_LIMITS.helperMemory;
    const limits = serviceLimits(host, ceiling);
    const sysctls = serviceSysctls(host.Sysctls);
    const binds = serviceBinds(host.Binds, undefined);
    const tmpfs = serviceTmpfs(host.Tmpfs);
    const log = serviceLog(host.LogConfig);
    const endpoint = serviceEndpoint(netName, network, body, !fromWorker || suffix === "dns");
    out.Image = body.Image;
    out.User = body.User;
    hostOut.NetworkMode = netName;
    hostOut.Binds = binds;
    hostOut.Tmpfs = tmpfs;
    hostOut.Memory = limits.Memory; hostOut.MemorySwap = limits.MemorySwap; hostOut.NanoCpus = limits.NanoCpus; hostOut.PidsLimit = limits.PidsLimit;
    hostOut.Sysctls = sysctls;
    if (log !== undefined) hostOut.LogConfig = log;
    out.NetworkingConfig = { EndpointsConfig: {} };
    out.NetworkingConfig.EndpointsConfig[netName] = endpoint.endpoint;
    labels[PROFILE_LABEL] = profile;
    labels[MEMORY_LABEL] = String(limits.Memory);
  }
  out.Labels = labels;
  out.HostConfig = hostOut;
  return JSON.stringify(out);
}

// The create of a service container (not the sealed check sandbox's alone: that one is a sandbox, so it is checked by transformCreate with a variant). One at a time, so the count is the count when this is made.
async function serviceCreate(request, response, query) {
  Array.from(query.keys()).forEach(function (key) { if (key !== "name") deny("create option " + key + " is not allowed"); });
  const name = query.get("name");
  const text = await readBody(request);
  const parts = SERVICE_CONTAINER_NAME.exec(name);
  let body;
  if (parts[2] === "check") {
    // The sealed check sandbox: the task sandbox profile on the run network, plus two read-only mounts.
    let parsed;
    try { parsed = JSON.parse(text); } catch (error) { deny("the body is not JSON"); }
    const network = await inspectRunNetwork(parts[1]);
    if (network === undefined) deny("a service container joins a run network of this worker");
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) deny("the body is not an object");
    const labelInfo = runLabelValues(parsed.Labels === null || parsed.Labels === undefined ? {} : parsed.Labels, parts[1]);
    const endpoint = serviceEndpoint(parts[1], network, parsed, true);
    if (endpoint.endpoint.Aliases !== undefined) deny("the check sandbox takes no alias");
    const pairs = serviceBindPairs((parsed.HostConfig || {}).Binds === undefined ? [] : (parsed.HostConfig.Binds || []).filter(function (bind) { return bind !== policy.workspaceDir + ":" + policy.workspaceDir && bind !== policy.workspaceDir + ":" + policy.workspaceDir + ":rw"; }), ["/etc/resolv.conf", "/etc/hosts"]);
    const variant = { name: name, network: parts[1], address: endpoint.address, hostname: CHECK_HOSTNAME, runLabels: labelInfo.values, readOnlyBinds: pairs.map(function (pair) { return pair.original; }), copies: pairs };
    body = transformCreate(query, text, variant);
  } else {
    body = await buildServiceBody(name, text);
  }
  const turn = createQueue;
  let release = function () {};
  createQueue = new Promise(function (resolve) { release = resolve; });
  await turn;
  try {
    const usage = await ownedServiceUsage();
    if (usage.count >= SVC_LIMITS.containers) {
      response.writeHead(429, { "content-type": "application/json" });
      return response.end(JSON.stringify({ message: "rovara: too many service containers at once" }));
    }
    let wanted = DEFAULT_MEMORY;
    try { wanted = Number(JSON.parse(body).HostConfig.Memory) || DEFAULT_MEMORY; } catch (error) { wanted = DEFAULT_MEMORY; }
    if (usage.memory + wanted > SVC_LIMITS.totalMemory) {
      response.writeHead(429, { "content-type": "application/json" });
      return response.end(JSON.stringify({ message: "rovara: the service containers together may not be given more memory" }));
    }
    const created = new URLSearchParams();
    created.set("name", name);
    return await forward(request, response, "/containers/create?" + created.toString(), body);
  } finally {
    release();
  }
}

// The hijacked stream of an attach, for a container of this worker's: the guard connects to the daemon itself with a request it built, and passes bytes on only after the daemon answered 101. Nothing may follow the headers.
function serviceAttach(request, socket, head, target, found, refuse) {
  const length = request.headers["content-length"] === undefined ? 0 : Number(request.headers["content-length"]);
  const queryOk = Array.from(target.searchParams.keys()).every(function (key) { return ["stream", "stdout", "stderr", "logs", "stdin", "detachKeys"].indexOf(key) !== -1; });
  if (request.method !== "POST" || !queryOk || request.headers["transfer-encoding"] !== undefined || length !== 0 || (head && head.length > 0) || (target.searchParams.get("stdin") !== null && target.searchParams.get("stdin") !== "0" && target.searchParams.get("stdin") !== "false")) {
    log("refused", { method: request.method, route: "attach", rule: "not an attach this guard serves" });
    return refuse("403 Forbidden", "this attach is not allowed");
  }
  {
    const query = new URLSearchParams();
    Array.from(target.searchParams.entries()).forEach(function (entry) { if (entry[0] !== "detachKeys") query.set(entry[0], entry[1]); });
    const upstream = net.connect({ path: policy.upstream });
    let answer = Buffer.alloc(0);
    upstream.on("error", function () { socket.destroy(); });
    socket.on("close", function () { upstream.destroy(); });
    upstream.on("close", function () { socket.destroy(); });
    upstream.on("connect", function () {
      upstream.write("POST /containers/" + found.id + "/attach" + (query.toString() === "" ? "" : "?" + query.toString()) + " HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 0\r\n\r\n");
    });
    upstream.on("data", function onAnswer(chunk) {
      answer = Buffer.concat([answer, chunk]);
      if (answer.length > 16384) return upstream.destroy();
      const end = answer.indexOf("\r\n\r\n");
      if (end === -1) return;
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
}

function servicesLibrary() {
  return { prepareCreate: buildServiceBody, transformNetworkCreate: transformNetworkCreate, inspectRunNetwork: inspectRunNetwork, serviceCreate: serviceCreate, SERVICE_CONTAINER_NAME: SERVICE_CONTAINER_NAME };
}
`;
