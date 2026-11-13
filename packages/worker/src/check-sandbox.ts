// The sealed check sandbox (test services, TS16; design test-services.md 4.0.2, 4.0.3 and 12, owner Q3). DEPLOYMENT CODE: nothing here has been run against Docker (this build starts no Docker); the Linux checks
// TS-L1 to TS-L3 and TS-L6 (scripts/linux-check-test-services.sh) AND the sealed-sandbox checks listed below MUST pass on linux-runtime or a staging worker before the `tx` switch is turned on. Nothing calls this module yet:
// the ServiceRunner (TS17) takes `checkSandboxPlan()` and starts the two containers it describes, only when `tx` is on.
//
// What it builds, as pure data (no process is started here):
//   - the sealed check sandbox's `docker run` arguments: attached to the run's services network ONLY (`--network rovara-svc-...` with the fixed address .4, never the default bridge, never the working-egress network, no
//     published port, no extra network, no `--dns`), with the sandbox hardening of task sandboxes (it IS `taskSandboxRunArgs`: non-root user, no capability, no-new-privileges, pids/cpu/memory limits, the workspace as the only
//     mount) plus two read-only mounts that the run owns: a /etc/resolv.conf that names the DNS helper at .2 alone, and a /etc/hosts with the run's helper names and addresses. This copies the E2E host
//     (docker-application-host.ts, "Docker 25 does not forward the queries of a container that is only on internal networks"): libc never consults 127.0.0.11 for a name that is not in the hosts file (the resolver itself still exists: see DOCKER'S EMBEDDED RESOLVER below);
//   - the contents of those two files, and the path they are written to (`writeCheckSandboxFiles`);
//   - the DNS helper's `docker run` arguments: the same container hardening as the setup run's helper (setup-network.ts `helperRunArgs`), on the services network at .2, running the SEALED mode of the name server
//     (sealed-dns-helper.ts -> `SealedDnsHelper` in setup-dns-watch.ts): a static table, the sinkhole for every other name, no upstream, served addresses .3 and .4 only;
//   - a reader for the helper's record of unknown names (`readSealedDnsRecord`).
//
// WHY THE SANDBOX CANNOT REACH ANYTHING BUT THE RUN: the services network is `--internal` and its bridge is named `rvi*`, which the boot firewall walls (boot.sh `wall_off_containers`); the sandbox is on that network and no other, and
// its only name server is the sealed helper, which has no upstream and answers every unknown name with the sinkhole. `checkSandboxArgProblems` re-checks the sandbox's own arguments against an ALLOW-LIST of flags (every flag
// the task sandbox emits plus the run's additions; anything else, in any spelling, is a problem) and `checkSandboxRunArgs` throws if a future change to the task sandbox's arguments would add a second network, a published
// port, a DNS option, an added capability, an extra mount or a docker socket.
//
// THE WORKING SANDBOX (.3) IS A RELAY OUT, SO IT IS DETACHED (review H1, owner decision): the working sandbox is dual-homed (the internet-facing `agentx-task` network plus this services network), so a background process left in
// it (a `socat`, a `nc` listener) would hand the check sandbox at .4 a way out. For the whole check round the working sandbox is therefore NOT on the services network: `detachWorkingSandbox` runs `docker network disconnect` and
// verifies with an inspect that the services network is gone from the container's networks; `startCheckSandbox` refuses to start the check sandbox without that proof (and looks again itself); `reattachWorkingSandbox` connects it
// back at .3 after the round. The plan says so (`mustDetachWorking: true`). Only the worker's `docker` calls do this, so the TS17 ServiceRunner MUST start the check sandbox through `startCheckSandbox`, never with `plan.sandboxRunArgs` directly.
//
// FOR TS17: run the round through `withDetachedWorking(docker, plan, round)`; it is the only supported way. It detaches the working sandbox, runs the round, REMOVES the check sandbox, and reattaches the working sandbox in a
// `finally` (also when the round fails). The working sandbox's real container name is `agentx-task-<id>-<uuid>` (task-sandbox.ts), so pass it EXPLICITLY as `CheckSandboxInput.workingSandboxName`; never rely on the
// default `<network>-work`, which no container has. The lower-level `detachWorkingSandbox`, `startCheckSandbox` and `reattachWorkingSandbox` stay exported for tests and for `withDetachedWorking` only.
//
// DOCKER'S EMBEDDED RESOLVER (127.0.0.11, TS-SEAL-5; owner decision 2026-11-05: accept residual (a) and build (b)). Docker starts its embedded resolver for every container on a user-defined network, `--internal` ones included:
// a listener on 127.0.0.11 on a random port inside the container's own network namespace, and two nat OUTPUT rules that send 127.0.0.11:53 (udp and tcp) to it. A bind-mounted /etc/resolv.conf only changes what libc
// reads, and `--dns` only changes where the resolver forwards to; Docker has no per-container switch. So the sealed sandbox HAS a resolver at 127.0.0.11, and a program that queries it directly (not through libc and the
// resolv.conf) is neither sinkholed nor recorded by the sealed DNS helper.
//   WHAT IT CANNOT DO (the residual that stays true even without the guard): it cannot send anything out. The services network is `--internal`; a daemon with the CVE-2024-29018 fix never forwards the queries of a container
//   that is only on internal networks from the host's namespace; and anything the sandbox itself sent would meet the rvi* wall (boot.sh) with no route out. What it CAN do is answer the names of the containers on the networks
//   the sandbox is on (here: the run's own helpers, the DNS helper and the sinkhole: the same names the run's /etc/hosts already gives it), and their reverse lookups. So the floor under the guard, which is what
//   L3.embedded-resolver judges, is only that a PUBLIC or unknown name gets no address through 127.0.0.11; an answer for the run's own container names is allowed there. (With the guard in place the sealed sandbox gets
//   no answer at all, which L3.embedded-resolver-blocked proves; the floor is what would still hold if the guard ever regressed.)
//   WHAT THE GUARD DOES (`resolverGuardRunArgs`, run by `startCheckSandbox` between the sandbox's start and its return, so before the first command): two short-lived helper containers, one after the other, each with
//   `--cap-drop ALL --cap-add NET_ADMIN` and nothing else, joined to the check sandbox's network namespace (`--network container:<check sandbox>`). The first runs `/usr/sbin/iptables-nft -I OUTPUT 1 -d 127.0.0.11/32 -j DROP`,
//   the second the same with `-C` (exit 0 only if the rule is there). Each is `--rm`. The sandbox itself never has NET_ADMIN. If any step fails, the check sandbox is removed and the round fails closed (RUNTIME_UNAVAILABLE);
//   nothing runs without the rule. A dropped packet gives the caller a timeout (TCP) or EPERM (UDP send); the sealed DNS helper at .2 is a different destination and is not touched.
//   THE GUARD'S IMAGE IS THE WORKER'S OWN, NEVER THE SANDBOX'S (`CheckSandboxInput.guardImage`, from AGENTX_WORKER_IMAGE in the worker's configuration, test-services-run.ts). The guard runs as root with NET_ADMIN and its
//   exit code is the proof the rule is there, so it must never run an image that someone else controls: today the sandbox image IS the worker image, but a devcontainer or saved-environment sandbox would be a customer's
//   image, whose `iptables-nft` or shell could exit 0 and leave no rule. Hence also: the binary is called by absolute path as the entrypoint (no shell, nothing looked up on a PATH), and the image must be pinned
//   (`name@sha256:<64 hex>`, which AGENTX_WORKER_IMAGE always is in production: session.ts requires an ECR image pinned by digest; or a bare `sha256:<64 hex>` image id, which the Linux CI driver passes). A tag is refused.
//   WHY A FILTER-TABLE DROP ON THE ADDRESS ALONE CATCHES DOCKER'S DNAT: for a packet this container sends, the kernel runs the hooks in the order raw, mangle, NAT (DNAT, `OUTPUT` chain of the nat table), filter. The nat
//   rule only rewrites the PORT (127.0.0.11:53 becomes 127.0.0.11:<random>); the address stays 127.0.0.11. So the filter OUTPUT chain, which comes after the nat hook, sees `-d 127.0.0.11` whether the program sent to port 53 (and was
//   rewritten) or straight to the random port. The rule therefore must NOT name a port (a `--dport 53` rule would never match a rewritten packet). It also matches TCP, UDP and anything else sent to that address.
//   IPv6: Docker's embedded resolver listens on the IPv4 address only, and a v4-mapped destination goes through the IPv4 hooks, so no ip6tables rule is needed.
//   WHY IPTABLES-NFT AND THE WORKER'S OWN IMAGE: the image carries the `iptables` package (environments/base/Dockerfile) and `iptables-nft` talks netlink, so NET_ADMIN is enough (the legacy backend would also need NET_RAW).
//   The sandbox gains nothing from the binary: it has no capability.
//   WHAT STAYS: the guard is one more privileged (NET_ADMIN) container in the round. It runs a fixed command, is short-lived, has no network of its own (it shares the sandbox's), no mount and no secret.
//
// NOT HERE (other tasks): the run's connection variables (`--env-file` on a worker tmpfs, per `docker exec`, TS15/TS17); the test-account proxy and its name (TS27); starting the helpers and the sinkhole (TS14/TS17); the
// sinkhole's own record of calls (name, port, count: the fake server image in record-only mode, TS23); the boot firewall's IPv6 INPUT rule (boot.sh, review L4: see DEFERRED-CHECKS).
//
// MUST RUN BEFORE `tx` IS ON (linux-runtime or a staging worker; these are the live part of TS-L3, which scripts/linux-check-test-services.sh still reports PENDING, one item each):
//   1. `--ip` .4 is accepted on the internal /24 although the network's `--ip-range` is the upper half (the sandbox and the helpers take fixed low addresses);
//   2. a bind mount over /etc/resolv.conf and over /etc/hosts of a container that has no `--dns` and sits only on the internal network is honoured (read-only, as the sandbox's user cannot change it);
//   3. from inside the sealed sandbox: a name in the table resolves to its helper and a connection to it works; an unknown name resolves to the sinkhole and a connection to it reaches the sinkhole (and is counted);
//      a public address, 8.8.8.8 port 53, the gateway .1 on every port, another run's helper, the metadata address and the host's resolver all fail; there is no default route out of the run;
//   4. the DNS helper binds .2:53 as uid 1000 (`net.ipv4.ip_unprivileged_port_start=53`, no capability) and answers .4 only: a query from the helper's neighbours (.3 and .16 and up) gets no answer;
//   5. the helper makes no outbound connection of its own (tcpdump on its interface while the sandbox asks unknown names).
// The reviewer's TS-L3 list (each is a PENDING item in scripts/linux-check-test-services.sh):
//   a. Docker's embedded resolver (127.0.0.11) and its DNAT rules: SEE "DOCKER'S EMBEDDED RESOLVER" below. The sandbox DOES have them (it did not: that claim was false, TS-SEAL-5), and the round closes them with the
//      resolver guard before any command runs. L3.embedded-resolver now judges only what the residual allows (a public or unknown name gets no address through 127.0.0.11); L3.embedded-resolver-blocked proves the guard
//      (a direct lookup, UDP and TCP, by the DNAT'd port and by port 53, gets nothing from the sealed sandbox, and the same lookups DO get an answer from an unguarded container on the same network);
//   b. the .3 relay: with a listener in .3, a connection from .4 to .3 fails (the working sandbox is detached for the round; `docker network inspect` shows only .2, the helpers and .4);
//   c. IPv6: no router advertisement configures an address or a route, the sandbox has no global IPv6 address, and the ip6tables rule on the host's INPUT chain drops the run bridge (L4, boot.sh);
//   d. no default route, 8.8.8.8, the metadata address and the gateway: `ip route` shows only the run's /24; connections to 8.8.8.8, 169.254.169.254 and .1 fail;
//   e. another run: its helpers and sandboxes cannot be reached from this one;
//   f. multicast and broadcast: nothing leaves the bridge to anything but the run;
//   g. run files not writable through the workspace: the directory of resolv.conf and hosts is outside the workspace (or under a masked path), so the sandbox cannot change them through its read-write workspace mount;
//   h. spoofing: a packet from .4 with the source address .3 or .2 gets no answer from the helper, and a bound-address trick (IP_FREEBIND) cannot make the helper count a name for a caller it does not serve
//      (a spoofed source on the same bridge can only add a name to the record blindly: it never receives the answer).
import { isIP } from "node:net";
import { realpathSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { agentXError } from "@rovara-code/contracts";
import { RUN_NETWORK_CREATED_LABEL, RUN_NETWORK_EXPIRES_LABEL, RUN_NETWORK_LABEL, RUN_NETWORK_WORKSPACE_LABEL, runNetworkAddresses, runNetworkHelperIp, type ServicesNetwork } from "./run-network.js";
import { SEALED_DNS_TABLE_MAX } from "./setup-dns-watch.js";
import type { DockerCli } from "./swebench/containers.js";
import { MASK_OPTIONS, SANDBOX_FILE_OPS_NODE, SANDBOX_INIT, TASK_SANDBOX_LABEL, TASK_SANDBOX_NETWORK, TASK_SANDBOX_PIDS_LIMIT, TASK_SANDBOX_USER, TASK_SANDBOX_WORKSPACE_LABEL, taskSandboxRunArgs } from "./task-sandbox.js";

/** Where the image keeps the sealed helper's program (environments/base/Dockerfile copies the worker's dist). */
export const SEALED_DNS_HELPER_ENTRY = "/opt/agentx/packages/worker/dist/sealed-dns-helper.js";
/** Where the helper writes the unknown names it was asked; the worker reads it with one fixed `docker exec <helper> cat`. */
export const SEALED_DNS_STATE_FILE = "/state/unknown.json";
/** The name the sinkhole (the fake server image in record-only mode) has in the run's hosts file and in the sealed table. */
export const SINKHOLE_ALIAS = "sinkhole";
/** The check sandbox's host name inside the container, so a program that looks up its own name finds .4 in the hosts file. */
export const CHECK_SANDBOX_HOSTNAME = "check";
/** The reserved names no dependency may take (the name server, the sandboxes, the proxy, the sinkhole, the loopback name). */
export const RESERVED_RUN_ALIASES: ReadonlySet<string> = new Set([SINKHOLE_ALIAS, CHECK_SANDBOX_HOSTNAME, "localhost", "dns", "dns-helper", "working", "proxy", "test-account-proxy", "gateway", "aws-metadata"]);
/** The most unknown names the worker reads back from the helper's file. */
export const SEALED_DNS_RECORD_NAMES_MAX = 200;
/** The sealed helper's container limits (copied from the setup run's helper). */
const DNS_HELPER_PIDS = "64";
const DNS_HELPER_MEMORY = "128m";
const DNS_HELPER_CPUS = "0.5";
const DOCKER_CALL_TIMEOUT_MS = 60_000;
const SEALED_HELPER_NAME = /^rovara-svc-[0-9a-f]{12}-dns$/u;
const ALIAS = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/u;
const SERVICES_NETWORK_NAME = /^rovara-svc-[0-9a-f]{12}$/u;
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const SAFE_HOST_PATH = /^\/[A-Za-z0-9_./-]{1,500}$/u;
/** The service helpers of a slot: 32 addresses, .16 to .47 (run-network.ts). */
const HELPER_COUNT = 32;

/** The part of a started services network (`ServicesNetwork`, run-network.ts) this module reads. */
export type CheckSandboxNetwork = Pick<ServicesNetwork, "name" | "slot" | "subnet" | "dnsHelperIp" | "workingSandboxIp" | "checkSandboxIp" | "labelArgs">;

/** A name on the run's services network and the address it has: a dependency's alias and the helper's address. */
export interface RunHostEntry {
  alias: string;
  address: string;
}

export interface CheckSandboxInput {
  /** The run's started services network. */
  net: CheckSandboxNetwork;
  /** The operation the sandbox serves (labels the container like every task sandbox). */
  taskId: string;
  /** The worker's own image: it is the sandbox image and carries the sealed helper's program. */
  image: string;
  /**
   * The image the resolver guard (a root container with NET_ADMIN) runs from: the WORKER's own image, taken from the worker's configuration (AGENTX_WORKER_IMAGE), never from `image` or anything about the sandbox. Pinned
   * (`name@sha256:...` or an image id `sha256:...`); a tag is refused. See "THE GUARD'S IMAGE" in the header.
   */
  guardImage: string;
  /** The workspace root, mounted at its own path as in every task sandbox. */
  rootPath: string;
  /** Folders of the workspace volume that are the worker's, not the project's (workspace-state.ts). */
  maskedPaths: readonly string[];
  hostCpus?: number;
  hostMemoryBytes?: number;
  /** A directory the run owns on the worker, where `resolv.conf` and `hosts` are written (`writeCheckSandboxFiles`). An absolute path of plain characters. */
  filesDir: string;
  /** The run's dependencies: each alias and the address of the helper that serves it (.16 to .47 of the run's network). */
  helpers: readonly RunHostEntry[];
  /** The sinkhole's address: one of the helper addresses (.16 to .47). */
  sinkholeIp: string;
  /** The working sandbox's container name (.3), which the round detaches from the services network (`detachWorkingSandbox`). Default: `<network name>-work`. */
  workingSandboxName?: string;
}

export interface CheckSandboxPlan {
  /** The sandbox container's name (derived from the network's, a hash). */
  sandboxName: string;
  /** The DNS helper container's name. */
  dnsHelperName: string;
  /** The sandbox's attachment: the run's services network and the fixed address .4 (nothing else). The ServiceRunner takes this as its parameter. */
  network: { name: string; ip: string };
  /** The run's names: the dependencies and the sinkhole. This is the hosts file's list and the DNS helper's static table. */
  names: readonly RunHostEntry[];
  /** The content of the sandbox's /etc/resolv.conf: the DNS helper at .2 alone. */
  resolvConf: string;
  /** The content of the sandbox's /etc/hosts. */
  hosts: string;
  resolvConfPath: string;
  hostsPath: string;
  /** `docker run` arguments of the sealed check sandbox. */
  sandboxRunArgs: string[];
  /** `docker run` arguments of the DNS helper in sealed mode. */
  dnsHelperRunArgs: string[];
  /** The image the guard runs from (`CheckSandboxInput.guardImage`): the worker's own, whatever `image` is. */
  guardImage: string;
  /**
   * `docker run` arguments of the resolver guard: two short-lived NET_ADMIN helpers that close Docker's embedded resolver (127.0.0.11) inside the check sandbox (`insert`) and read the rule back (`verify`).
   * `startCheckSandbox` runs them, in that order, before it returns.
   */
  resolverGuardArgs: { insert: string[]; verify: string[] };
  /** The working sandbox's container name and its address on the services network (.3), for `detachWorkingSandbox` and `reattachWorkingSandbox`. */
  workingSandboxName: string;
  workingSandboxIp: string;
  /** What `startCheckSandbox` checks `sandboxRunArgs` against once more (checkSandboxArgProblems). */
  rootPath: string;
  image: string;
  maskedPaths: readonly string[];
  /** True always: the working sandbox is a relay out (it is also on the internet-facing network), so it must be off the services network before the check sandbox starts (`startCheckSandbox` enforces it). */
  mustDetachWorking: true;
}

function assertAlias(alias: string): void {
  if (!ALIAS.test(alias) || RESERVED_RUN_ALIASES.has(alias)) throw agentXError("CONFIG_INVALID", "not a name a test service may have on the run network");
}

/** True when `address` is one of the service helper addresses of this slot (.16 to .47). */
function isHelperAddress(slot: number, address: string): boolean {
  for (let index = 0; index < HELPER_COUNT; index += 1) if (runNetworkHelperIp(slot, index) === address) return true;
  return false;
}

/**
 * The run's names for the hosts file and the DNS table: every dependency alias (validated: strict regex, not reserved, once) at its helper's address (.16 to .47 of THIS run's slot), and the sinkhole.
 * Throws CONFIG_INVALID on anything else, so no repository-controlled string reaches a file or a docker argument unchecked.
 */
export function checkSandboxNames(net: Pick<CheckSandboxNetwork, "slot">, helpers: readonly RunHostEntry[], sinkholeIp: string): RunHostEntry[] {
  if (!isHelperAddress(net.slot, sinkholeIp)) throw agentXError("CONFIG_INVALID", "the sinkhole is one of the run's helper addresses");
  if (helpers.length + 1 > SEALED_DNS_TABLE_MAX) throw agentXError("CONFIG_INVALID", "too many test services for one run");
  const seen = new Set<string>();
  const names: RunHostEntry[] = [];
  for (const helper of helpers) {
    assertAlias(helper.alias);
    if (seen.has(helper.alias)) throw agentXError("CONFIG_INVALID", "a name is given to two test services");
    if (!isHelperAddress(net.slot, helper.address)) throw agentXError("CONFIG_INVALID", "a test service is not at one of the run's helper addresses");
    if (helper.address === sinkholeIp) throw agentXError("CONFIG_INVALID", "a test service cannot be at the sinkhole's address");
    seen.add(helper.alias);
    names.push({ alias: helper.alias, address: helper.address });
  }
  names.push({ alias: SINKHOLE_ALIAS, address: sinkholeIp });
  return names;
}

/** The sandbox's /etc/resolv.conf: the DNS helper alone, no search domain (the E2E host's file). */
export function checkSandboxResolvConf(dnsHelperIp: string): string {
  if (isIP(dnsHelperIp) !== 4) throw agentXError("CONFIG_INVALID", "the DNS helper's address is an IPv4 address");
  return `nameserver ${dnsHelperIp}\noptions ndots:0 timeout:2 attempts:2\n`;
}

/** The sandbox's /etc/hosts: loopback, the sandbox itself, and the run's names. */
export function checkSandboxHostsFile(checkSandboxIp: string, names: readonly RunHostEntry[]): string {
  if (isIP(checkSandboxIp) !== 4) throw agentXError("CONFIG_INVALID", "the check sandbox's address is an IPv4 address");
  const lines = ["127.0.0.1 localhost", "::1 localhost ip6-localhost ip6-loopback", `${checkSandboxIp} ${CHECK_SANDBOX_HOSTNAME}`, ...names.map((entry) => `${entry.address} ${entry.alias}`)];
  return `${lines.join("\n")}\n`;
}

/** Why a flag that people commonly try is refused (the allow-list below refuses every other flag too, with a general reason). */
const FORBIDDEN_FLAGS: ReadonlyMap<string, string> = new Map([
  ["--publish", "publishes a port"], ["-p", "publishes a port"], ["--publish-all", "publishes ports"], ["-P", "publishes ports"], ["--expose", "exposes a port"],
  ["--net", "names a network"], ["--link", "links a container"], ["--dns", "names a DNS server"], ["--dns-search", "names a search domain"], ["--dns-option", "sets a resolver option"],
  ["--add-host", "adds a host entry (the hosts file is the run's own)"], ["--privileged", "is privileged"], ["--cap-add", "adds a capability"], ["--device", "adds a device"],
  ["--pid", "shares a process namespace"], ["--ipc", "shares an IPC namespace"], ["--uts", "shares a UTS namespace"], ["--userns", "changes the user namespace"], ["--network-alias", "gives the sandbox an alias"],
  ["--mac-address", "sets a MAC address"], ["--ip6", "sets an IPv6 address"], ["--sysctl", "sets a kernel parameter"], ["--cgroupns", "changes the cgroup namespace"],
  ["-v", "adds a mount"], ["--mount", "adds a mount"], ["--volumes-from", "takes another container's mounts"], ["--runtime", "changes the container runtime"], ["--group-add", "adds a group"],
  ["--cgroup-parent", "changes the cgroup"], ["--gpus", "adds a GPU"], ["--env", "sets an environment variable"], ["-e", "sets an environment variable"], ["--env-file", "sets environment variables"],
]);
/** The flags the sealed sandbox may carry: exactly what `taskSandboxRunArgs` emits plus the run's additions (--hostname, the run labels, the two read-only mounts). Everything else is refused. */
const ALLOWED_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--name", "--label", "--network", "--ip", "--user", "--cpus", "--memory", "--memory-swap", "--pids-limit", "--cap-drop", "--security-opt", "--volume", "--tmpfs", "--workdir", "--entrypoint", "--hostname",
]);
const ALLOWED_BOOLEAN_FLAGS: ReadonlySet<string> = new Set(["--detach"]);
const ALLOWED_LABEL_KEYS: ReadonlySet<string> = new Set([TASK_SANDBOX_LABEL, TASK_SANDBOX_WORKSPACE_LABEL, RUN_NETWORK_LABEL, RUN_NETWORK_CREATED_LABEL, RUN_NETWORK_EXPIRES_LABEL, RUN_NETWORK_WORKSPACE_LABEL]);
const FORBIDDEN_MOUNT_SUBSTRINGS: readonly string[] = ["docker.sock", "/var/run", "/run/docker"];
const LIMIT_VALUE = /^[0-9]+(?:\.[0-9]+)?[bkmg]?$/iu;

/** What the sealed sandbox's arguments are checked against: the run's files and workspace, the image, and the masked folders (each gets the task sandbox's empty tmpfs). */
export interface CheckSandboxArgPaths {
  resolvConfPath: string;
  hostsPath: string;
  rootPath: string;
  image: string;
  maskedPaths: readonly string[];
}

/**
 * What is wrong with `args` as the arguments of the sealed check sandbox: an empty list when they are sound. An ALLOW-LIST over the arguments up to the image: every flag must be one the task sandbox emits plus the
 * run's additions, in any spelling (`--flag=value` is read as `--flag value`; an attached short form such as `-p8080:80` is read as `-p`, which is not allowed). Single-valued flags occur once with exactly the expected
 * value (the run's network, .4, 1000:1000, ALL, no-new-privileges, the three mounts, the workspace as the working directory, the init entrypoint), the masked folders are exactly the expected tmpfs mounts, and after the
 * image comes exactly `-- sleep infinity`.
 */
export function checkSandboxArgProblems(args: readonly string[], net: Pick<CheckSandboxNetwork, "name" | "checkSandboxIp">, paths: CheckSandboxArgPaths): string[] {
  const problems: string[] = [];
  const values = new Map<string, string[]>();
  let booleans = 0;
  let imageAt = -1;
  if (args[0] !== "run") problems.push("is not a docker run command");
  let at = 1;
  while (at < args.length) {
    const token = args[at]!;
    at += 1;
    if (!token.startsWith("-")) { imageAt = at - 1; break; }
    let name: string;
    let inline: string | undefined;
    if (token.startsWith("--")) {
      const equals = token.indexOf("=");
      name = equals < 0 ? token : token.slice(0, equals);
      inline = equals < 0 ? undefined : token.slice(equals + 1);
    } else {
      name = token.slice(0, 2);
      inline = token.length > 2 ? token.slice(2) : undefined;
    }
    if (ALLOWED_BOOLEAN_FLAGS.has(name)) {
      if (inline !== undefined) problems.push(`carries ${name} with a value`);
      booleans += 1;
    } else if (ALLOWED_VALUE_FLAGS.has(name)) {
      let value = inline;
      if (value === undefined) { value = args[at]; at += 1; }
      if (value === undefined) problems.push(`${name} has no value`);
      else values.set(name, [...(values.get(name) ?? []), value]);
    } else {
      const reason = FORBIDDEN_FLAGS.get(name);
      problems.push(reason === undefined ? `carries ${name}, which is not a flag of the sealed check sandbox` : `carries ${name}, which ${reason}`);
      // Skip the flag's value, if it has one, so it is not taken for the image.
      if (inline === undefined && args[at] !== undefined && !args[at]!.startsWith("-")) at += 1;
    }
  }
  const before = imageAt < 0 ? args : args.slice(0, imageAt);
  if (booleans !== 1) problems.push("does not run detached exactly once");
  if (imageAt < 0) problems.push("has no image");
  else {
    if (args[imageAt] !== paths.image) problems.push("runs another image");
    const tail = args.slice(imageAt + 1);
    if (tail.length !== 3 || tail[0] !== "--" || tail[1] !== "sleep" || tail[2] !== "infinity") problems.push("has something after the image other than `-- sleep infinity`");
  }
  const of = (flag: string): string[] => values.get(flag) ?? [];
  const exactly = (flag: string, expected: string, message: string): void => {
    const found = of(flag);
    if (found.length === 0) problems.push(`lacks ${flag}`);
    if (found.length !== 1 || found[0] !== expected) problems.push(message);
  };
  const networks = of("--network");
  if (networks.length !== 1 || networks[0] !== net.name) problems.push("not attached to the run's services network alone");
  if (networks.some((network) => network === TASK_SANDBOX_NETWORK || network === "bridge" || network === "host" || network === "none" || network.startsWith("container:"))) problems.push("attached to a network with a route out");
  const ips = of("--ip");
  if (ips.length !== 1 || ips[0] !== net.checkSandboxIp) problems.push("not at the fixed check sandbox address");
  exactly("--user", TASK_SANDBOX_USER, `does not run as exactly one --user ${TASK_SANDBOX_USER}`);
  exactly("--cap-drop", "ALL", "does not drop every capability");
  exactly("--security-opt", "no-new-privileges", "does not hold exactly no-new-privileges as its security option");
  exactly("--pids-limit", TASK_SANDBOX_PIDS_LIMIT, "does not hold exactly the task sandbox's pids limit");
  exactly("--name", `${net.name}-check`, "does not have the run's check sandbox name");
  exactly("--hostname", CHECK_SANDBOX_HOSTNAME, "does not have the check sandbox's host name");
  exactly("--workdir", paths.rootPath, "does not work in the workspace");
  exactly("--entrypoint", SANDBOX_INIT, "does not use the task sandbox's init as its entrypoint");
  for (const flag of ["--cpus", "--memory", "--memory-swap"]) {
    const found = of(flag);
    if (found.length > 1 || found.some((value) => !LIMIT_VALUE.test(value))) problems.push(`has a ${flag} that is not one plain limit`);
  }
  if (of("--memory").length !== of("--memory-swap").length || (of("--memory")[0] !== undefined && of("--memory")[0] !== of("--memory-swap")[0])) problems.push("does not hold memory and swap at one limit");
  const volumes = of("--volume");
  const expected = [`${paths.rootPath}:${paths.rootPath}`, `${paths.resolvConfPath}:/etc/resolv.conf:ro`, `${paths.hostsPath}:/etc/hosts:ro`];
  if (volumes.length !== 3 || !expected.every((volume) => volumes.filter((found) => found === volume).length === 1)) problems.push("does not hold exactly the workspace, resolv.conf and hosts mounts");
  const wantedMasks = paths.maskedPaths.map((path) => `${path}:${MASK_OPTIONS}`).sort();
  const masks = [...of("--tmpfs")].sort();
  if (masks.length !== wantedMasks.length || masks.some((mask, index) => mask !== wantedMasks[index])) problems.push("does not hold exactly the task sandbox's masked folders as its tmpfs mounts");
  const labelKeys = of("--label").map((label) => label.split("=")[0]!);
  if (labelKeys.some((key) => !ALLOWED_LABEL_KEYS.has(key)) || new Set(labelKeys).size !== labelKeys.length) problems.push("carries a label that is not one of the task sandbox's or the run's, or one twice");
  if (before.some((arg) => FORBIDDEN_MOUNT_SUBSTRINGS.some((part) => arg.includes(part)))) problems.push("mounts a docker socket path");
  return problems;
}

function assertHostPath(path: string): void {
  if (!SAFE_HOST_PATH.test(path) || path.split("/").some((part) => part === ".." || part === ".")) throw agentXError("CONFIG_INVALID", "not a plain absolute path for a run file");
}

/**
 * `path` with the symbolic links of its parent directories resolved where they exist: the real path of the longest existing ancestor, followed by the rest as written. A path that does not exist yet (a run's files
 * directory before it is made) still has its existing ancestors resolved, so a link above it cannot hide where it really is.
 */
function realish(path: string): string {
  const resolved = posix.resolve(path);
  let ancestor = resolved;
  const rest: string[] = [];
  for (;;) {
    try {
      return posix.join(realpathSync(ancestor), ...rest);
    } catch {
      const parent = posix.dirname(ancestor);
      if (parent === ancestor) return resolved;
      rest.unshift(posix.basename(ancestor));
      ancestor = parent;
    }
  }
}

function isUnder(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder === "/" ? "/" : `${folder}/`);
}

/**
 * The sandbox's workspace mount is read-write, so a run file under it could be changed by the sandbox's own user (resolv.conf, hosts). A run file must therefore be outside the workspace root, or under one of the masked
 * folders (the sandbox sees an empty read-only tmpfs there). Hardened: the root must be an absolute path; every masked folder must be strictly under the root (a masked folder elsewhere would exempt a path that the
 * sandbox can still write); and the comparison uses real paths, so a symbolic link in a parent directory cannot move a file into or out of the workspace unseen. Reads the file system to resolve links (no write).
 */
function assertFilesOutsideWorkspace(paths: readonly string[], rootPath: string, maskedPaths: readonly string[]): void {
  if (!posix.isAbsolute(rootPath)) throw agentXError("CONFIG_INVALID", "the workspace root is an absolute path");
  const root = realish(rootPath);
  const masks = maskedPaths.map((masked) => {
    if (!posix.isAbsolute(masked)) throw agentXError("CONFIG_INVALID", "a masked folder is an absolute path");
    const lexical = posix.resolve(masked);
    const real = realish(masked);
    if (lexical === posix.resolve(rootPath) || !isUnder(lexical, posix.resolve(rootPath)) || real === root || !isUnder(real, root)) throw agentXError("CONFIG_INVALID", "a masked folder is strictly inside the workspace root");
    return real;
  });
  for (const path of paths) {
    const real = realish(path);
    if ((isUnder(real, root) || isUnder(posix.resolve(path), posix.resolve(rootPath))) && !masks.some((mask) => isUnder(real, mask))) {
      throw agentXError("CONFIG_INVALID", "a run file is inside the workspace, where the sandbox could change it");
    }
  }
}

/** The four run-network labels must all be there (TS-RN-3 rule 1): a container without them is invisible to the sweep. */
function assertAllLabels(labelArgs: readonly string[]): void {
  const keys = labelArgs.flatMap((arg, index) => (labelArgs[index - 1] === "--label" ? [arg.split("=")[0]!] : []));
  for (const key of [RUN_NETWORK_LABEL, RUN_NETWORK_CREATED_LABEL, RUN_NETWORK_EXPIRES_LABEL, RUN_NETWORK_WORKSPACE_LABEL]) {
    if (!keys.includes(key)) throw agentXError("CONFIG_INVALID", "the run's network labels are incomplete");
  }
}

/** The network must be exactly the address plan of its slot (run-network.ts): a hand-made object with another address is refused. */
function assertNetwork(net: CheckSandboxNetwork): void {
  if (!SERVICES_NETWORK_NAME.test(net.name)) throw agentXError("CONFIG_INVALID", "not a run services network");
  const plan = runNetworkAddresses(net.slot);
  if (net.subnet !== plan.subnet || net.dnsHelperIp !== plan.dnsHelperIp || net.workingSandboxIp !== plan.workingSandboxIp || net.checkSandboxIp !== plan.checkSandboxIp) {
    throw agentXError("CONFIG_INVALID", "the run network does not have the addresses of its slot");
  }
  assertAllLabels(net.labelArgs());
}

/** The arguments of the sealed check sandbox. Throws when the result would not pass `checkSandboxArgProblems`. */
export function checkSandboxRunArgs(input: CheckSandboxInput, files: { resolvConfPath: string; hostsPath: string }): string[] {
  assertNetwork(input.net);
  assertHostPath(files.resolvConfPath);
  assertHostPath(files.hostsPath);
  if (files.resolvConfPath === files.hostsPath) throw agentXError("CONFIG_INVALID", "the run's two files have two paths");
  assertFilesOutsideWorkspace([files.resolvConfPath, files.hostsPath], input.rootPath, input.maskedPaths);
  const base = taskSandboxRunArgs({
    name: `${input.net.name}-check`, taskId: input.taskId, image: input.image, rootPath: input.rootPath, maskedPaths: input.maskedPaths,
    ...(input.hostCpus === undefined ? {} : { hostCpus: input.hostCpus }), ...(input.hostMemoryBytes === undefined ? {} : { hostMemoryBytes: input.hostMemoryBytes }),
    network: { name: input.net.name, ip: input.net.checkSandboxIp },
  });
  // The run's own arguments go in front of the entrypoint. The tail of a task sandbox's arguments is fixed (`--entrypoint tini <image> -- sleep infinity`); if it ever changes, this refuses instead of guessing.
  const tail = base.slice(-6);
  if (tail[0] !== "--entrypoint" || tail[2] !== input.image || tail[3] !== "--") throw agentXError("CONFIG_INVALID", "the task sandbox's arguments changed shape");
  const args = [
    ...base.slice(0, -6), "--hostname", CHECK_SANDBOX_HOSTNAME, ...input.net.labelArgs(),
    "--volume", `${files.resolvConfPath}:/etc/resolv.conf:ro`, "--volume", `${files.hostsPath}:/etc/hosts:ro`, ...tail,
  ];
  const problems = checkSandboxArgProblems(args, input.net, { ...files, rootPath: input.rootPath, image: input.image, maskedPaths: input.maskedPaths });
  if (problems.length > 0) throw agentXError("CONFIG_INVALID", `the sealed check sandbox's arguments are unsound: ${problems.join("; ")}`);
  return args;
}

/** The `docker run` arguments of the DNS helper in sealed mode: the setup helper's hardening, the services network at .2, all four labels, serving .4 only (the working sandbox at .3 is off this network for the round and is not served). */
export function sealedDnsHelperRunArgs(input: { net: CheckSandboxNetwork; image: string; helpers: readonly RunHostEntry[]; sinkholeIp: string }): string[] {
  assertNetwork(input.net);
  const { net } = input;
  const names = checkSandboxNames(net, input.helpers, input.sinkholeIp);
  return [
    "run", "--detach", "--pull=never", "--name", `${net.name}-dns`, ...net.labelArgs(),
    "--network", net.name, "--ip", net.dnsHelperIp,
    "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only",
    "--sysctl", "net.ipv4.ip_unprivileged_port_start=53",
    "--pids-limit", DNS_HELPER_PIDS, "--memory", DNS_HELPER_MEMORY, "--memory-swap", DNS_HELPER_MEMORY, "--cpus", DNS_HELPER_CPUS,
    "--tmpfs", "/state:rw,noexec,nosuid,size=1m,uid=1000,gid=1000",
    "--entrypoint", SANDBOX_FILE_OPS_NODE,
    input.image, SEALED_DNS_HELPER_ENTRY, "--listen", net.dnsHelperIp, "--source", net.checkSandboxIp, "--sinkhole", input.sinkholeIp,
    ...names.flatMap((entry) => ["--host", `${entry.alias}=${entry.address}`]), "--state", SEALED_DNS_STATE_FILE,
  ];
}

// ---- The resolver guard: Docker's embedded resolver (127.0.0.11) is closed inside the check sandbox before any command runs (TS-SEAL-5, option b) ----

/** Docker's embedded resolver address, which every container on a user-defined network has in its own namespace. */
export const EMBEDDED_RESOLVER_ADDRESS = "127.0.0.11";
/** The guard's program, by absolute path, as the container's entrypoint: no shell, no PATH lookup. The `iptables` package of the worker image (environments/base/Dockerfile) provides it. */
export const RESOLVER_GUARD_BINARY = "/usr/sbin/iptables-nft";
/**
 * The rule: the address alone (no protocol, no port: Docker's nat rule has already rewritten the port when the filter chain sees the packet, see the header), first in the filter OUTPUT chain. `-w 5` waits up to 5 s for the
 * lock a concurrent iptables holds. `insert` puts the rule in; `verify` (`-C`) exits 0 only if that very rule is there.
 */
export const RESOLVER_GUARD_STEPS: Readonly<Record<"insert" | "verify", readonly string[]>> = {
  insert: ["-w", "5", "-I", "OUTPUT", "1", "-d", `${EMBEDDED_RESOLVER_ADDRESS}/32`, "-j", "DROP"],
  verify: ["-w", "5", "-C", "OUTPUT", "-d", `${EMBEDDED_RESOLVER_ADDRESS}/32`, "-j", "DROP"],
};
export type ResolverGuardStep = keyof typeof RESOLVER_GUARD_STEPS;
const RESOLVER_GUARD_LABEL_KEYS: ReadonlySet<string> = new Set([RUN_NETWORK_LABEL, RUN_NETWORK_CREATED_LABEL, RUN_NETWORK_EXPIRES_LABEL, RUN_NETWORK_WORKSPACE_LABEL]);
/** A pinned image: `name@sha256:<64 hex>` (what AGENTX_WORKER_IMAGE is in production) or a bare image id `sha256:<64 hex>` (the Linux CI driver). Never a tag. */
const PINNED_IMAGE = /^(?:[a-z0-9][a-z0-9._/:-]{0,199}@sha256:[a-f0-9]{64}|sha256:[a-f0-9]{64})$/u;

/** True when `image` is a pinned image reference (a digest or an image id). */
export function isPinnedImage(image: string): boolean {
  return PINNED_IMAGE.test(image);
}

/** The name of one of the guard's two containers: the check sandbox's, plus `-guard` (insert) or `-guard-check` (verify). */
export function resolverGuardName(sandboxName: string, step: ResolverGuardStep = "insert"): string {
  if (!CONTAINER_NAME.test(sandboxName)) throw agentXError("CONFIG_INVALID", "not a plan of a sealed check sandbox");
  return step === "insert" ? `${sandboxName}-guard` : `${sandboxName}-guard-check`;
}

/** The part of the guard's arguments after the labels: fixed, and the only place where the NET_ADMIN capability is added anywhere in the sealed round. */
function resolverGuardTail(sandboxName: string, image: string, step: ResolverGuardStep): string[] {
  return [
    "--network", `container:${sandboxName}`,
    "--user", "0:0", "--cap-drop", "ALL", "--cap-add", "NET_ADMIN", "--security-opt", "no-new-privileges", "--read-only",
    "--tmpfs", "/run:rw,noexec,nosuid,nodev,size=1m",
    "--pids-limit", "32", "--memory", "64m", "--memory-swap", "64m", "--cpus", "0.5",
    "--entrypoint", RESOLVER_GUARD_BINARY, image, ...RESOLVER_GUARD_STEPS[step],
  ];
}

/**
 * The `docker run` arguments of one step of the resolver guard: a foreground, `--rm` container of the WORKER's own image (`guardImage`, pinned), in the check sandbox's network namespace (`container:<name>`), root with
 * every capability dropped but NET_ADMIN, a read-only root (only /run is writable, for iptables' lock file), no mount, no published port, all four run labels (so a sweep finds a guard that outlived its worker). The
 * check sandbox is named by its fixed name (`<network>-check`), so these arguments can be made with the plan, before the sandbox exists.
 */
export function resolverGuardRunArgs(input: { net: CheckSandboxNetwork; guardImage: string; step: ResolverGuardStep }): string[] {
  assertNetwork(input.net);
  const sandboxName = `${input.net.name}-check`;
  const args = ["run", "--rm", "--pull=never", "--name", resolverGuardName(sandboxName, input.step), ...input.net.labelArgs(), ...resolverGuardTail(sandboxName, input.guardImage, input.step)];
  const problems = resolverGuardArgProblems(args, { sandboxName, image: input.guardImage, step: input.step });
  if (problems.length > 0) throw agentXError("CONFIG_INVALID", `the resolver guard's arguments are unsound: ${problems.join("; ")}`);
  return args;
}

/**
 * What is wrong with `args` as the arguments of the resolver guard's `step` for the sandbox `sandboxName` and the guard image `image`: empty when sound. The arguments are an exact match: the fixed head, then exactly the
 * run's own four labels (each once, a plain value), then the fixed tail. `image` itself must be pinned. Anything else (another network, a mount, a second capability, a changed command or image) is a problem. This is the
 * one place that allows NET_ADMIN.
 */
export function resolverGuardArgProblems(args: readonly string[], expected: { sandboxName: string; image: string; step: ResolverGuardStep }): string[] {
  const head = ["run", "--rm", "--pull=never", "--name", `${expected.sandboxName}${expected.step === "insert" ? "-guard" : "-guard-check"}`];
  const problems: string[] = [];
  if (!PINNED_IMAGE.test(expected.image)) problems.push("does not run a pinned image (name@sha256:... or an image id)");
  if (args.length < head.length || head.some((token, index) => args[index] !== token)) problems.push("does not start with the guard's fixed head");
  let at = head.length;
  const seen = new Set<string>();
  while (args[at] === "--label") {
    const label = args[at + 1] ?? "";
    const key = label.split("=")[0]!;
    if (!RESOLVER_GUARD_LABEL_KEYS.has(key) || seen.has(key) || !/^[A-Za-z0-9._-]+=[A-Za-z0-9._-]*$/u.test(label)) problems.push("carries a label that is not one of the run's, or one twice");
    seen.add(key);
    at += 2;
  }
  if (seen.size !== RESOLVER_GUARD_LABEL_KEYS.size) problems.push("does not carry all four run labels");
  const tail = resolverGuardTail(expected.sandboxName, expected.image, expected.step);
  const rest = args.slice(at);
  if (rest.length !== tail.length || tail.some((token, index) => rest[index] !== token)) problems.push("is not exactly the guard's fixed command (network, user, capability, limits, image and program)");
  return problems;
}

/** Best-effort removal of a container by name: the caller decides what a leftover means. */
async function removeQuietly(docker: DockerCli, name: string): Promise<void> {
  await docker.run(["rm", "--force", name], { timeoutMs: DOCKER_CALL_TIMEOUT_MS }).catch(() => undefined);
}

/** True when a container of this name still exists (or when that cannot be told: an unreadable look counts as a leftover). */
async function containerLeft(docker: DockerCli, name: string): Promise<boolean> {
  const left = await docker.run(["container", "inspect", "--format", "{{.Id}}", name], { timeoutMs: DOCKER_CALL_TIMEOUT_MS }).catch(() => undefined);
  return left === undefined || left.exitCode === 0;
}

/**
 * Everything the ServiceRunner needs to attach the sealed check sandbox to a run's services network: the names, the two files' content and paths, and the two containers' `docker run` arguments. Pure: it starts nothing
 * and writes nothing (`writeCheckSandboxFiles` writes the two files). Throws CONFIG_INVALID on any name, address, path or network that is not sound.
 */
export function checkSandboxPlan(input: CheckSandboxInput): CheckSandboxPlan {
  assertNetwork(input.net);
  assertHostPath(input.filesDir);
  const names = checkSandboxNames(input.net, input.helpers, input.sinkholeIp);
  assertFilesOutsideWorkspace([input.filesDir], input.rootPath, input.maskedPaths);
  const workingSandboxName = input.workingSandboxName ?? `${input.net.name}-work`;
  if (!CONTAINER_NAME.test(workingSandboxName) || workingSandboxName === `${input.net.name}-check` || workingSandboxName === `${input.net.name}-dns`) throw agentXError("CONFIG_INVALID", "not a name for the working sandbox");
  const resolvConfPath = join(input.filesDir, "resolv.conf");
  const hostsPath = join(input.filesDir, "hosts");
  return {
    sandboxName: `${input.net.name}-check`, dnsHelperName: `${input.net.name}-dns`,
    network: { name: input.net.name, ip: input.net.checkSandboxIp },
    names, resolvConf: checkSandboxResolvConf(input.net.dnsHelperIp), hosts: checkSandboxHostsFile(input.net.checkSandboxIp, names),
    resolvConfPath, hostsPath,
    sandboxRunArgs: checkSandboxRunArgs(input, { resolvConfPath, hostsPath }),
    dnsHelperRunArgs: sealedDnsHelperRunArgs({ net: input.net, image: input.image, helpers: input.helpers, sinkholeIp: input.sinkholeIp }),
    guardImage: input.guardImage,
    resolverGuardArgs: { insert: resolverGuardRunArgs({ net: input.net, guardImage: input.guardImage, step: "insert" }), verify: resolverGuardRunArgs({ net: input.net, guardImage: input.guardImage, step: "verify" }) },
    rootPath: input.rootPath, image: input.image, maskedPaths: [...input.maskedPaths],
    workingSandboxName, workingSandboxIp: input.net.workingSandboxIp, mustDetachWorking: true,
  };
}

/** Writes the two files of a plan into its run-owned directory, which must already exist: new files only (an existing one is an error), mode 0644 so the sandbox's user can read and cannot change them. */
export async function writeCheckSandboxFiles(plan: Pick<CheckSandboxPlan, "resolvConf" | "hosts" | "resolvConfPath" | "hostsPath">): Promise<void> {
  for (const [path, content] of [[plan.resolvConfPath, plan.resolvConf], [plan.hostsPath, plan.hosts]] as const) {
    await writeFile(path, content, { flag: "wx", mode: 0o644 });
    await chmod(path, 0o644);
  }
}

export interface SealedDnsRecord {
  /** The unknown names the run asked for, in the order first seen, each with the number of address lookups. */
  unknown: { name: string; queries: number }[];
  /** Unknown names not kept because the helper's record was full. */
  dropped: number;
  /** Address lookups of unknown names whose text was not a plain name. */
  unrecorded: number;
}

const RECORD_NAME = /^[a-z0-9_.-]{1,64}$/u;

/** The helper's record from its file's text. Anything that is not exactly the expected shape gives an empty record: never a throw, never a name that is not a plain name. */
export function parseSealedDnsRecord(text: string): SealedDnsRecord {
  const empty: SealedDnsRecord = { unknown: [], dropped: 0, unrecorded: 0 };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return empty; }
  if (typeof parsed !== "object" || parsed === null) return empty;
  const record = parsed as { unknown?: unknown; dropped?: unknown; unrecorded?: unknown };
  const count = (value: unknown): number => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0);
  const unknown = Array.isArray(record.unknown)
    ? record.unknown.flatMap((item: unknown) => {
      const row = item as { name?: unknown; queries?: unknown } | null;
      return typeof row === "object" && row !== null && typeof row.name === "string" && RECORD_NAME.test(row.name) && count(row.queries) > 0 ? [{ name: row.name, queries: count(row.queries) }] : [];
    }).slice(0, SEALED_DNS_RECORD_NAMES_MAX)
    : [];
  return { unknown, dropped: count(record.dropped), unrecorded: count(record.unrecorded) };
}

/** Reads the sealed helper's record with one fixed `docker exec <helper> cat /state/unknown.json`. A failed read gives an empty record. */
export async function readSealedDnsRecord(docker: DockerCli, dnsHelperName: string): Promise<SealedDnsRecord> {
  if (!SEALED_HELPER_NAME.test(dnsHelperName)) throw agentXError("CONFIG_INVALID", "not a sealed DNS helper's name");
  const read = await docker.run(["exec", dnsHelperName, "cat", SEALED_DNS_STATE_FILE], { timeoutMs: DOCKER_CALL_TIMEOUT_MS }).catch(() => ({ exitCode: -1, stdout: "", stderr: "" }));
  return read.exitCode === 0 ? parseSealedDnsRecord(read.stdout) : { unknown: [], dropped: 0, unrecorded: 0 };
}

/** How long the sealed DNS helper may take to listen after its `docker run` returned. Its node loads the worker's modules under a 0.5 CPU limit, which takes seconds on a busy worker. */
export const SEALED_DNS_READY_TIMEOUT_MS = 30_000;
const SEALED_DNS_READY_POLL_MS = 250;

/**
 * Waits until the sealed DNS helper LISTENS. `docker run --detach` returns when the container has started, not when its program has bound .2:53: until then the helper's address answers a query with "port unreachable",
 * so a lookup in a check sandbox started at once fails at once (EAI_AGAIN) instead of reaching the sinkhole, and nothing is recorded. The helper's program writes its state file only AFTER it has bound UDP and TCP
 * (sealed-dns-helper.ts `main`: `await helper.start()`, then the first flush), so the file being readable through the same fixed `docker exec <helper> cat` is the proof it listens. A helper that exited (the exec fails)
 * or never binds within `timeoutMs` throws RUNTIME_UNAVAILABLE: the round must not start without its name server. The caller starts the check sandbox only after this returns.
 */
export async function waitForSealedDnsHelper(
  docker: DockerCli, dnsHelperName: string,
  options: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<void> {
  if (!SEALED_HELPER_NAME.test(dnsHelperName)) throw agentXError("CONFIG_INVALID", "not a sealed DNS helper's name");
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => { setTimeout(done, ms); }));
  const deadline = now() + (options.timeoutMs ?? SEALED_DNS_READY_TIMEOUT_MS);
  for (;;) {
    if (options.signal?.aborted === true) throw agentXError("RUNTIME_UNAVAILABLE", "the sealed DNS helper's start was cancelled");
    const read = await docker.run(["exec", dnsHelperName, "cat", SEALED_DNS_STATE_FILE], { timeoutMs: DOCKER_CALL_TIMEOUT_MS }).catch(() => undefined);
    if (read !== undefined && read.exitCode === 0) return;
    if (now() >= deadline) throw agentXError("RUNTIME_UNAVAILABLE", "the sealed DNS helper is not listening, so the sealed round did not start");
    await sleep(options.pollMs ?? SEALED_DNS_READY_POLL_MS);
  }
}

// ---- The working sandbox is off the services network for the whole check round (review H1) ----

/** What `detachWorkingSandbox` proved: the working sandbox was not on the services network when it looked. Only that function makes one. */
export interface WorkingSandboxDetached {
  readonly network: string;
  readonly container: string;
}
const DETACH_PROOFS = new WeakSet<object>();

type PlanForWorking = Pick<CheckSandboxPlan, "network" | "workingSandboxName" | "workingSandboxIp" | "sandboxName">;

function assertWorkingPlan(plan: PlanForWorking): void {
  if (!SERVICES_NETWORK_NAME.test(plan.network.name) || !CONTAINER_NAME.test(plan.workingSandboxName) || plan.workingSandboxName === plan.sandboxName) {
    throw agentXError("CONFIG_INVALID", "not a plan of a sealed check sandbox");
  }
}

/** The names of the networks the container is on now, from one `docker inspect`. A failed or unreadable inspect throws: a relay that cannot be looked at is treated as a relay. */
async function networksOf(docker: DockerCli, container: string): Promise<string[]> {
  const inspected = await docker.run(["inspect", "--format", "{{json .NetworkSettings.Networks}}", container], { timeoutMs: DOCKER_CALL_TIMEOUT_MS }).catch(() => undefined);
  if (inspected === undefined || inspected.exitCode !== 0) throw agentXError("RUNTIME_UNAVAILABLE", "the working sandbox's networks could not be read");
  let parsed: unknown;
  try { parsed = JSON.parse(inspected.stdout.trim()); } catch { throw agentXError("RUNTIME_UNAVAILABLE", "the working sandbox's networks could not be read"); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw agentXError("RUNTIME_UNAVAILABLE", "the working sandbox's networks could not be read");
  return Object.keys(parsed);
}

/**
 * Takes the working sandbox (.3, also on the internet-facing network) off the run's services network and checks with an inspect that it is gone. The disconnect's own exit code does not decide: a container that was
 * already off the network passes, and a disconnect that failed while the container is still on the network throws. TS17 calls this before it starts the check sandbox, and `reattachWorkingSandbox` after the round.
 */
export async function detachWorkingSandbox(docker: DockerCli, plan: PlanForWorking): Promise<WorkingSandboxDetached> {
  assertWorkingPlan(plan);
  await docker.run(["network", "disconnect", plan.network.name, plan.workingSandboxName], { timeoutMs: DOCKER_CALL_TIMEOUT_MS }).catch(() => undefined);
  if ((await networksOf(docker, plan.workingSandboxName)).includes(plan.network.name)) throw agentXError("RUNTIME_UNAVAILABLE", "the working sandbox is still on the run's services network");
  const proof: WorkingSandboxDetached = { network: plan.network.name, container: plan.workingSandboxName };
  DETACH_PROOFS.add(proof);
  return proof;
}

/**
 * Connects the working sandbox back to the services network at .3 after the round. Idempotent: when it is already on the network this does nothing (and a connect that docker refuses because the endpoint already exists
 * passes if a look afterwards shows it connected). Throws when docker refuses and it is not connected.
 */
export async function reattachWorkingSandbox(docker: DockerCli, plan: PlanForWorking): Promise<void> {
  assertWorkingPlan(plan);
  const already = await networksOf(docker, plan.workingSandboxName).then((networks) => networks.includes(plan.network.name), () => false);
  if (already) return;
  const connected = await docker.run(["network", "connect", "--ip", plan.workingSandboxIp, plan.network.name, plan.workingSandboxName], { timeoutMs: DOCKER_CALL_TIMEOUT_MS }).catch(() => undefined);
  if (connected !== undefined && connected.exitCode === 0) return;
  if (await networksOf(docker, plan.workingSandboxName).then((networks) => networks.includes(plan.network.name), () => false)) return;
  throw agentXError("RUNTIME_UNAVAILABLE", "the working sandbox could not be attached to the run's services network again");
}

/**
 * Starts the sealed check sandbox, and only when the working sandbox is known to be off the services network: the caller must hold the proof `detachWorkingSandbox` returned for THIS plan, and the container's networks
 * are read once more here. Returns the container id. The plan's `sandboxRunArgs` must not be run by any other path.
 */
export async function startCheckSandbox(docker: DockerCli, plan: CheckSandboxPlan, detached: WorkingSandboxDetached, options: { signal?: AbortSignal } = {}): Promise<string> {
  assertWorkingPlan(plan);
  if (!DETACH_PROOFS.has(detached) || detached.network !== plan.network.name || detached.container !== plan.workingSandboxName) {
    throw agentXError("RUNTIME_UNAVAILABLE", "the check sandbox does not start before the working sandbox is detached from the services network");
  }
  // The plan is plain data, so its arguments are checked once more here, against the plan's own network, workspace and image: a hand-built or edited plan is refused.
  const problems = checkSandboxArgProblems(plan.sandboxRunArgs, { name: plan.network.name, checkSandboxIp: plan.network.ip }, {
    resolvConfPath: plan.resolvConfPath, hostsPath: plan.hostsPath, rootPath: plan.rootPath, image: plan.image, maskedPaths: plan.maskedPaths,
  });
  if (problems.length > 0) throw agentXError("CONFIG_INVALID", `the sealed check sandbox's arguments are unsound: ${problems.join("; ")}`);
  // The resolver guard's arguments are checked before anything starts, for the same reason: the plan is data. The guard's image is the plan's `guardImage` (the worker's own), checked on its own; it is not `plan.image`.
  for (const step of ["insert", "verify"] as const) {
    const guardProblems = resolverGuardArgProblems(plan.resolverGuardArgs[step], { sandboxName: plan.sandboxName, image: plan.guardImage, step });
    if (guardProblems.length > 0) throw agentXError("CONFIG_INVALID", `the sealed check sandbox's resolver guard is unsound: ${guardProblems.join("; ")}`);
  }
  if ((await networksOf(docker, plan.workingSandboxName)).includes(plan.network.name)) throw agentXError("RUNTIME_UNAVAILABLE", "the working sandbox is on the run's services network again");
  const started = await docker.run(plan.sandboxRunArgs, { timeoutMs: DOCKER_CALL_TIMEOUT_MS }).catch(() => undefined);
  if (started === undefined || started.exitCode !== 0) throw agentXError("RUNTIME_UNAVAILABLE", "the check sandbox could not be started");
  // Docker's embedded resolver (127.0.0.11) is closed inside the sandbox BEFORE this function returns, so before any command can run in it. The sandbox's own entrypoint is `tini -- sleep infinity`; commands only ever come later,
  // through `docker exec`. Any failure (the helper cannot start, the rule cannot be set or read back, a timeout) removes the sandbox and fails the round: no round runs without the rule.
  let closed = options.signal?.aborted !== true;
  for (const step of ["insert", "verify"] as const) {
    if (!closed) break;
    const guard = await docker.run(plan.resolverGuardArgs[step], { timeoutMs: DOCKER_CALL_TIMEOUT_MS, ...(options.signal === undefined ? {} : { signal: options.signal }) }).catch(() => undefined);
    closed = guard !== undefined && guard.exitCode === 0;
  }
  if (!closed) {
    const guards = [resolverGuardName(plan.sandboxName, "insert"), resolverGuardName(plan.sandboxName, "verify")];
    for (const name of guards) await removeQuietly(docker, name);
    await removeQuietly(docker, plan.sandboxName);
    const leftovers: string[] = [];
    for (const name of guards) if (await containerLeft(docker, name)) leftovers.push(name);
    const sandboxLeft = await containerLeft(docker, plan.sandboxName);
    throw agentXError("RUNTIME_UNAVAILABLE", [
      "the check sandbox's embedded resolver could not be closed, so the sealed round did not start",
      ...(leftovers.length === 0 ? [] : ["a resolver guard container could not be removed"]),
      ...(sandboxLeft ? ["the check sandbox itself could not be removed and is still running without the rule"] : []),
    ].join(", and "));
  }
  return started.stdout.trim();
}

/** The working sandbox's own network for the working phase (not a round's), and its address there. */
export interface WorkingPhaseNetwork { name: string; ip: string }

function assertWorkingPhaseNetwork(plan: Pick<CheckSandboxPlan, "network">, to: WorkingPhaseNetwork): void {
  if (!SERVICES_NETWORK_NAME.test(to.name) || to.name === plan.network.name || to.name === "bridge" || to.name === "host" || to.name === "none" || !/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(to.ip)) {
    throw agentXError("CONFIG_INVALID", "the working sandbox goes back to its working phase network, never to a round's network");
  }
}

/** After a round: the working sandbox is on its working-phase network (it never left it, so normally this only looks). Connects it at its address when it is not. Never touches the round's network. */
async function ensureOnWorkingPhaseNetwork(docker: DockerCli, plan: PlanForWorking, to: WorkingPhaseNetwork): Promise<void> {
  assertWorkingPhaseNetwork(plan, to);
  if (await networksOf(docker, plan.workingSandboxName).then((networks) => networks.includes(to.name), () => false)) return;
  const connected = await docker.run(["network", "connect", "--ip", to.ip, to.name, plan.workingSandboxName], { timeoutMs: DOCKER_CALL_TIMEOUT_MS }).catch(() => undefined);
  if (connected !== undefined && connected.exitCode === 0) return;
  if (await networksOf(docker, plan.workingSandboxName).then((networks) => networks.includes(to.name), () => false)) return;
  throw agentXError("RUNTIME_UNAVAILABLE", "the working sandbox could not be attached to its working phase network again");
}

/**
 * One check round: detaches the working sandbox, runs `round` (which starts the check sandbox with `start()` and does its work), then REMOVES the check sandbox and reattaches the working sandbox in a `finally`, whether
 * the round succeeded, failed or was cancelled. This is the only supported way for TS17 to use the sealed sandbox. If the check sandbox cannot be removed (it still exists after `docker rm --force`), the working sandbox
 * is NOT reattached (a relay beside a live check sandbox would break the seal) and the call throws. The round's own error wins over a clean-up error.
 */
export async function withDetachedWorking<T>(
  docker: DockerCli, plan: CheckSandboxPlan, round: (start: () => Promise<string>) => Promise<T>,
  options: { returnTo?: WorkingPhaseNetwork | "none"; pauseWorking?: boolean; signal?: AbortSignal } = {},
): Promise<T> {
  // `returnTo` is the network the working sandbox belongs on once the round is over (its working-phase network), or "none" when it has no services network at all (a run with no working phase). With it, the working
  // sandbox is NEVER connected to this round's network, not even for a moment: the round's own network is only ever looked at. Without it (the single-network design of the first version) it is reattached to the round's
  // network at .3, as before.
  if (options.returnTo !== undefined && options.returnTo !== "none") assertWorkingPhaseNetwork(plan, options.returnTo);
  const detached = await detachWorkingSandbox(docker, plan);
  // `pauseWorking`: the working sandbox is FROZEN (`docker pause`) from before the check sandbox starts until the check sandbox is gone. The two share the workspace volume, so a process the agent or a seed left running in the
  // working sandbox could otherwise relay workspace files to the internet during a sealed round. A pause that fails stops the round (fail closed); a sandbox that could not be removed stays paused.
  let paused = false;
  let outcome: { value: T } | { error: unknown };
  try {
    if (options.pauseWorking === true) {
      const frozen = await docker.run(["pause", plan.workingSandboxName], { timeoutMs: DOCKER_CALL_TIMEOUT_MS }).catch(() => undefined);
      if (frozen === undefined || frozen.exitCode !== 0) throw agentXError("RUNTIME_UNAVAILABLE", "the working sandbox could not be paused, so the sealed round did not start");
      paused = true;
    }
    outcome = { value: await round(() => startCheckSandbox(docker, plan, detached, options.signal === undefined ? {} : { signal: options.signal })) };
  } catch (error) {
    outcome = { error };
  }
  let cleanup: unknown;
  try {
    await removeCheckSandbox(docker, plan);
    if (options.returnTo === undefined) await reattachWorkingSandbox(docker, plan);
    else if (options.returnTo !== "none") await ensureOnWorkingPhaseNetwork(docker, plan, options.returnTo);
    if (paused) await unpauseWorkingSandbox(docker, plan);
  } catch (error) {
    cleanup = error;
  }
  if ("error" in outcome) throw outcome.error as Error;
  if (cleanup !== undefined) throw cleanup as Error;
  return outcome.value;
}

/** `docker unpause`, once more if it fails; a sandbox that stays frozen is an error (loud: the task cannot go on). */
async function unpauseWorkingSandbox(docker: DockerCli, plan: Pick<CheckSandboxPlan, "workingSandboxName">): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = await docker.run(["unpause", plan.workingSandboxName], { timeoutMs: DOCKER_CALL_TIMEOUT_MS }).catch(() => undefined);
    if (result !== undefined && result.exitCode === 0) return;
  }
  throw agentXError("RUNTIME_UNAVAILABLE", "the working sandbox could not be unpaused after the sealed round");
}

/** Removes the check sandbox (`docker rm --force`); a container that does not exist is fine, one that still exists after the attempt is an error. */
async function removeCheckSandbox(docker: DockerCli, plan: Pick<CheckSandboxPlan, "sandboxName">): Promise<void> {
  if (!CONTAINER_NAME.test(plan.sandboxName)) throw agentXError("CONFIG_INVALID", "not a plan of a sealed check sandbox");
  await docker.run(["rm", "--force", plan.sandboxName], { timeoutMs: DOCKER_CALL_TIMEOUT_MS }).catch(() => undefined);
  const left = await docker.run(["container", "inspect", "--format", "{{.Id}}", plan.sandboxName], { timeoutMs: DOCKER_CALL_TIMEOUT_MS }).catch(() => undefined);
  if (left === undefined || left.exitCode === 0) throw agentXError("RUNTIME_UNAVAILABLE", "the check sandbox could not be removed, so the working sandbox stays detached");
}
