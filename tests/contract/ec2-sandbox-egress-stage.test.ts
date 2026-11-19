// Lane L4-NETG (DEC 254zzz77): the EC2 worker's sandbox-egress stage (packages/worker/ec2/sandbox-egress.sh) and boot.sh's hook, run in bash with a STATEFUL fake Docker, a fake iptables with a rules file and fake systemd
// commands. Every path the stage writes as root is replaced by a temporary one; every line that decides something runs as written. The real-Docker half (an internal network really has no route, the gateway really answers)
// is tests/linux/worker-sandbox-egress.test.ts, which CI runs.
import { execFile, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSocket } from "node:dgram";
import { describe, expect, it } from "vitest";
import { EGRESS_GATEWAY_SOURCE } from "../../packages/contracts/src/egress-gateway-source.js";
import { SANDBOX_REGISTRY_DENY, SANDBOX_S3_DENY } from "../../packages/contracts/src/sandbox-deny-domains.js";
import { EC2_USER_DATA_MAX_BYTES, ec2WorkerBootScript, ec2WorkerUserData, type Ec2WorkerBootConfig } from "../../packages/contracts/src/session.js";

const stage = readFileSync(new URL("../../packages/worker/ec2/sandbox-egress.sh", import.meta.url), "utf8");
const bootScript = readFileSync(new URL("../../packages/worker/ec2/boot.sh", import.meta.url), "utf8");
const WORKER_IMAGE = `111122223333.dkr.ecr.us-west-2.amazonaws.com/agentx-staging/worker@sha256:${"a".repeat(64)}`;

interface Host { dir: string; daemon: string; firewall: string; envFile: string; calls: string; rules: string; rules6: string; units: string; restore: string; resolv: string; state: string; failure: string }
interface Options {
  failRuleInsert?: boolean; noMetadataBlock?: boolean; failInnerCreate?: boolean; failOuterCreate?: boolean; emptyProgram?: boolean; fewNames?: boolean; badName?: boolean; fewS3?: boolean; badS3?: boolean;
  failCreate?: boolean; failConnect?: boolean; failStart?: boolean; ghostNetworks?: boolean; failProbe?: boolean; innerNotInternal?: boolean; innerExistsRight?: boolean;
  // L4-NETG2: the Docker daemon's name server, the container firewall script, and the old agentx-task bridge.
  otherDaemonDns?: boolean; failDockerRestart?: boolean; failFirewall?: boolean; dockerNotReady?: boolean; staleTaskNetwork?: boolean; taskNetworkHeld?: boolean; loopbackResolver?: boolean; dnsAlreadySet?: boolean; emptyDaemonJson?: boolean; notJsonDaemon?: boolean; noResolvers?: boolean;
}
const DAEMON_BEFORE = '{"data-root": "/mnt/workspace/.docker", "default-address-pools": [{"base":"172.28.0.0/16","size":24}]}\n';
const TASK_NETWORK_ID = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/** A fake host. The fake Docker keeps its networks and the gateway as files under `state`, so a later call sees what an earlier one did. */
function host(options: Options = {}): Host {
  const dir = mkdtempSync(join(tmpdir(), "se-stage-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const h: Host = { dir, daemon: join(dir, "daemon.json"), firewall: join(dir, "firewall.sh"), envFile: join(dir, "worker.env"), calls: join(dir, "calls.log"), rules: join(dir, "rules"), rules6: join(dir, "rules6"), units: join(dir, "systemd"), restore: join(dir, "restore.sh"), resolv: join(dir, "resolv.conf"), state: join(dir, "state"), failure: join(dir, "failure") };
  mkdirSync(h.units);
  mkdirSync(join(dir, "agentx"));
  mkdirSync(join(h.state, "nets"), { recursive: true });
  writeFileSync(h.envFile, "AWS_REGION=us-west-2\nAGENTX_SANDBOX_IMAGE=x\n");
  writeFileSync(h.rules, options.noMetadataBlock === true ? "" : "DOCKER-USER -d 169.254.169.254/32 -j DROP\n");
  writeFileSync(h.rules6, "");
  writeFileSync(h.resolv, options.noResolvers === true ? "nameserver 127.0.0.53\n" : `${options.loopbackResolver === true ? "nameserver 127.0.0.53\n" : ""}nameserver 10.42.0.2\nnameserver 169.254.169.253\n`);
  writeFileSync(h.daemon, options.emptyDaemonJson === true ? "{}\n" : options.notJsonDaemon === true ? "[]\n" : options.otherDaemonDns === true ? '{"dns": ["8.8.8.8"], "data-root": "/x"}\n' : options.dnsAlreadySet === true ? '{"dns": ["172.28.250.2"], "data-root": "/x"}\n' : DAEMON_BEFORE);
  writeFileSync(h.firewall, `#!/bin/bash\necho "firewall run" >>"${h.calls}"\n${options.failFirewall === true ? "exit 1" : "exit 0"}\n`);
  chmodSync(h.firewall, 0o755);
  if (options.staleTaskNetwork === true) writeFileSync(join(h.state, "nets", "agentx-task"), TASK_NETWORK_ID);
  if (options.taskNetworkHeld === true) writeFileSync(join(h.state, "held"), "");
  writeFileSync(join(dir, "program"), options.emptyProgram === true ? "" : EGRESS_GATEWAY_SOURCE);
  writeFileSync(join(dir, "s3names"), (options.fewS3 === true ? SANDBOX_S3_DENY.slice(0, 2) : options.badS3 === true ? [...SANDBOX_S3_DENY, "bad name"] : SANDBOX_S3_DENY).join("\n"));
  writeFileSync(join(dir, "names"), `${(options.fewNames === true ? SANDBOX_REGISTRY_DENY.slice(0, 3) : options.badName === true ? [...SANDBOX_REGISTRY_DENY, "bad name"] : SANDBOX_REGISTRY_DENY).join("\n")}`);
  if (options.innerExistsRight === true) writeFileSync(join(h.state, "nets", "rovara-snet"), "bridge|true|true|rvs0|false|172.28.250.0/24 ");
  if (options.innerNotInternal === true) writeFileSync(join(h.state, "nets", "rovara-snet"), "bridge|false||rvs0|false|172.28.250.0/24 ");
  const fake = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/bash\nprintf '%s %s\\n' "${name}" "$*" >>"${h.calls}"\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  const table = (file: string, failInsert: boolean) => `case "$1" in
  -C) shift; grep -qxF -- "$*" "${file}" ;;
  -I) shift; ${failInsert ? "exit 1" : `{ printf '%s\\n' "$*"; cat "${file}"; } >"${file}.new"; mv "${file}.new" "${file}"`} ;;
  *) exit 1 ;;
esac`;
  fake("iptables", table(h.rules, options.failRuleInsert === true));
  fake("ip6tables", table(h.rules6, false));
  fake("timeout", 'while [[ "$1" == -* ]]; do shift; done; shift; exec "$@"');
  fake("install", 'dir=0; for last; do [[ "$last" == -d ]] && dir=1; done; [[ "$dir" == 1 ]] && mkdir -p "$last"; exit 0');
  // A restart of Docker on the new file (the one with the gateway as name server) fails; on the old file it works.
  fake("systemctl", options.failDockerRestart === true ? `[[ "$*" == "restart docker.service" ]] && grep -q '"dns"' "${h.daemon}" && exit 1\nexit 0` : "exit 0");
  fake("sleep", "exit 0");
  fake("docker", `S="${h.state}"
case "$1" in
  network)
    case "$2" in
      inspect) f="$S/nets/\${@: -1}"; [[ -e "$f" ]] && cat "$f" || exit 1 ;;
      rm) [[ "$3" == agentx-task && -e "$S/held" ]] && exit 1; rm -f "$S/nets/$3" ;;
      create)
        shift 2; internal=false; inhibit=""; bridge=""; subnet=""
        while (($#)); do case "$1" in --internal) internal=true ;; --subnet) subnet=$2; shift ;; -o) case "$2" in com.docker.network.bridge.inhibit_ipv4=*) inhibit=\${2#*=} ;; com.docker.network.bridge.name=*) bridge=\${2#*=} ;; esac; shift ;; esac; name=$1; shift; done
        ${options.failInnerCreate === true ? '[[ "$name" == rovara-snet ]] && exit 1' : ":"}
        ${options.failOuterCreate === true ? '[[ "$name" == rovara-xnet ]] && exit 1' : ":"}
        printf 'bridge|%s|%s|%s|false|%s ' "$internal" "$inhibit" "$bridge" "$subnet" >"$S/nets/$name" ;;
      connect) ${options.failConnect === true ? "exit 1" : `echo "$5" >>"$S/gw.nets"; for a; do :; done`} ;;
      *) exit 1 ;;
    esac ;;
  info) ${options.dockerNotReady === true ? "exit 1" : "exit 0"} ;;
  rm) rm -f "$S/gw" "$S/gw.nets" "$S/gw.running" ;;
  create) ${options.failCreate === true ? "exit 1" : `for ((i=1;i<=$#;i++)); do [[ "\${!i}" == --network ]] && { j=$((i+1)); echo "\${!j}" >"$S/gw.nets"; }; done; : >"$S/gw"`} ;;
  start) ${options.failStart === true ? "exit 1" : `: >"$S/gw.running"`} ;;
  inspect) [[ -e "$S/gw.running" ]] || { printf 'false|'; exit 0; }
           ${options.ghostNetworks === true ? "printf 'true|rovara-xnet '" : `printf 'true|'; sort "$S/gw.nets" | tr '\\n' ' '`} ;;
  run)
    case " $* " in
      *" --input-type=module "*) case "$*" in *EGRESS_GATEWAY_SOURCE*) cat "${join(dir, "program")}" ;; *SANDBOX_S3_DENY*) cat "${join(dir, "s3names")}" ;; *) cat "${join(dir, "names")}" ;; esac ;;
      *" --network rovara-snet "*) ${options.failProbe === true ? "exit 1" : "exit 0"} ;;
      *) exit 1 ;;
    esac ;;
  *) exit 1 ;;
esac`);
  return h;
}

/** The stage's text with the root-owned paths moved into the fake host. */
function stageFor(h: Host): string {
  return stage
    .split("/usr/local/libexec/rovara-sandbox-egress-restore").join(h.restore)
    .split("/etc/agentx").join(join(h.dir, "agentx"))
    .split("/usr/local/libexec/rovara-container-firewall").join(h.firewall)
    .split("/etc/docker/daemon.json").join(h.daemon)
    .split("/etc/systemd/system").join(h.units)
    .split("/var/lib/rovara-egress").join(join(h.dir, "egress-allow"))
    .split("/etc/resolv.conf").join(h.resolv)
    .split("/run/systemd/resolve/resolv.conf").join(`${h.resolv}.none`);
}

function harness(h: Host, body: string): string {
  return `set -uo pipefail
log() { printf 'agentx-boot: %s\\n' "$*" >&2; }
fail() { log "FAILED: $*"; printf '%s\\n' "$*" >"${h.failure}"; exit 1; }
try_seconds() { printf '%s\\n' "$1"; }
BOOT_STEP=start; WORKER_ENV_FILE=${h.envFile}; WORKER_UNIT=agentx-worker.service; FIREWALL_UNIT=rovara-container-firewall.service
${stageFor(h)}
${body}`;
}
function runStage(h: Host, withTestServices = false): { status: number | null; stderr: string; failure: string } {
  // The test-services stage's functions, as boot.sh leaves them defined (it sources the stage inside a function): the rvi wall is missing after the Docker restart unless the stage puts it back.
  const functions = withTestServices ? `ts_run_walls_present() { return 1; }\nts_wall_run_networks() { echo "ts-wall-run-networks" >>"${h.calls}"; }\nts_wall_ipv6() { echo "ts-wall-ipv6" >>"${h.calls}"; }\n` : "";
  const ran = spawnSync("bash", ["-c", harness(h, `${functions}sandbox_egress_main`)], { encoding: "utf8", env: { PATH: `${join(h.dir, "bin")}:${process.env.PATH ?? ""}`, AGENTX_WORKER_IMAGE: WORKER_IMAGE } });
  return { status: ran.status, stderr: ran.stderr, failure: existsSync(h.failure) ? readFileSync(h.failure, "utf8").trim() : "" };
}
const envLines = (h: Host): string[] => readFileSync(h.envFile, "utf8").split("\n").filter((line) => line !== "");
const calls = (h: Host): string[] => (existsSync(h.calls) ? readFileSync(h.calls, "utf8").split("\n").filter((line) => line !== "") : []);
const rules = (h: Host): string[] => readFileSync(h.rules, "utf8").split("\n").filter(Boolean);
const NO_SANDBOX_ENV = ["AWS_REGION=us-west-2", "AGENTX_SANDBOX_IMAGE=x"];

describe("the sandbox-egress stage on a worker (gateway mode)", () => {
  it("walls the two bridges, makes the internal network and the outer one, runs the hardened gateway on both, checks it from a sandbox's place, and hands the worker the network and name server", () => {
    const h = host();
    const result = runStage(h);
    expect(result.status, result.stderr).toBe(0);
    const log = calls(h);
    // The networks: the sandbox one is internal with no host address and a fixed bridge name; the outer one is a plain bridge. Neither has IPv6.
    const innerCreate = log.find((line) => line.startsWith("docker network create") && line.endsWith(" rovara-snet"))!;
    expect(innerCreate).toBe("docker network create --driver bridge --ipv6=false --internal --subnet 172.28.250.0/24 -o com.docker.network.bridge.inhibit_ipv4=true -o com.docker.network.bridge.name=rvs0 rovara-snet");
    const outerCreate = log.find((line) => line.startsWith("docker network create") && line.endsWith(" rovara-xnet"))!;
    expect(outerCreate).toBe("docker network create --driver bridge --ipv6=false --subnet 172.28.251.0/24 -o com.docker.network.bridge.name=rvx0 rovara-xnet");
    expect(outerCreate).not.toContain("--internal");
    // The gateway: created on the OUTER network at a fixed address, joined to the inner one at a fixed address, then started; nothing but its two networks.
    const create = log.find((line) => line.startsWith("docker create"))!;
    expect(create).toContain(`--name rovara-egw --label rovara.sandbox-egress=gateway --restart unless-stopped --network rovara-xnet --ip 172.28.251.2 --dns 10.42.0.2 --dns 169.254.169.253 --user 1000:1000 --volume ${join(h.dir, "egress-allow")}:${join(h.dir, "egress-allow")}:ro --cap-drop ALL --security-opt no-new-privileges --read-only`);
    expect(create).toContain("--sysctl net.ipv4.ip_forward=0");
    expect(create).toContain("--pids-limit 512 --memory 512m");
    expect(create).not.toMatch(/--network host|--privileged|--cap-add|docker\.sock|--publish|-p /u);
    const config = JSON.parse(/ROVARA_GW_CONFIG=(\{.*?\}\}) --entrypoint/u.exec(create)![1]!) as { mode: string; sandboxDenied: string[]; nets: Record<string, string> };
    expect(config).toEqual({ mode: "host", sandboxDenied: [...SANDBOX_REGISTRY_DENY], sandboxDeniedS3: [...SANDBOX_S3_DENY], projectAllowFile: join(h.dir, "egress-allow", "project-allow.json"), nets: { sandbox: "172.28.250.0/24", external: "172.28.251.0/24" } });
    expect(create).toContain(`--entrypoint /usr/local/bin/node ${WORKER_IMAGE} -e "use strict";`);
    const connect = log.indexOf("docker network connect --ip 172.28.250.2 rovara-snet rovara-egw");
    expect(connect).toBeGreaterThan(log.findIndex((line) => line.startsWith("docker create")));
    expect(connect).toBeLessThan(log.indexOf("docker start rovara-egw"));
    // The check: a container of the worker image on the inner network with the gateway as its name server, no capability, read-only.
    const probe = log.find((line) => line.startsWith("docker run") && line.includes("--network rovara-snet"))!;
    expect(probe).toContain("--dns 172.28.250.2 --read-only --cap-drop ALL --security-opt no-new-privileges --user 1000:1000");
    expect(log.indexOf(probe)).toBeGreaterThan(log.indexOf("docker start rovara-egw"));
    // The program and the deny list are read from the digest-pinned worker image with no network, no capability and a read-only root.
    for (const line of log.filter((entry) => entry.startsWith("docker run") && entry.includes("--input-type=module"))) expect(line).toContain(`--rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --workdir /opt/agentx --entrypoint node ${WORKER_IMAGE} --input-type=module -e`);
    // The worker's environment: exactly the three lines, and only after the checks passed.
    expect(envLines(h)).toEqual([...NO_SANDBOX_ENV, "AGENTX_SANDBOX_EGRESS=gateway", "AGENTX_SANDBOX_NETWORK=rovara-snet", "AGENTX_SANDBOX_DNS=172.28.250.2"]);
    // The project's S3 lift: a folder only the worker's user owns, mounted read-only into the gateway and nowhere else.
    expect(create).toContain(`--volume ${join(h.dir, "egress-allow")}:${join(h.dir, "egress-allow")}:ro`);
    expect(log.some((line) => line.startsWith("install -d -o 1000 -g 1000 -m 0700") && line.endsWith("egress-allow"))).toBe(true);
  });

  it("installs the walls: nothing leaves the sandbox bridge, the host is unreachable from both bridges, the gateway's way out loses the private ranges but keeps the host's resolvers' port 53", () => {
    const h = host();
    expect(runStage(h).status).toBe(0);
    const installed = rules(h);
    expect(installed).toContain("DOCKER-USER -i rvs+ ! -o rvs+ -j DROP");
    expect(installed).toContain("INPUT -i rvs+ -j DROP");
    expect(installed).toContain("INPUT -i rvx+ -j DROP");
    for (const range of ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16", "127.0.0.0/8"]) expect(installed).toContain(`DOCKER-USER -i rvx+ -d ${range} -j DROP`);
    const opened = installed.filter((rule) => rule.endsWith("-j RETURN"));
    expect(opened.sort()).toEqual([
      "DOCKER-USER -i rvx+ -d 10.42.0.2 -p tcp --dport 53 -j RETURN", "DOCKER-USER -i rvx+ -d 10.42.0.2 -p udp --dport 53 -j RETURN",
      "DOCKER-USER -i rvx+ -d 169.254.169.253 -p tcp --dport 53 -j RETURN", "DOCKER-USER -i rvx+ -d 169.254.169.253 -p udp --dport 53 -j RETURN",
    ]);
    // The resolver exceptions sit above the range drops, and nothing is opened for the sandbox side (rvs+).
    const index = (rule: string): number => installed.indexOf(rule);
    for (const rule of opened) for (const range of ["10.0.0.0/8", "169.254.0.0/16"]) expect(index(rule)).toBeLessThan(index(`DOCKER-USER -i rvx+ -d ${range} -j DROP`));
    expect(installed.some((rule) => rule.includes("rvs+") && rule.endsWith("RETURN") || rule.includes("rvs+") && rule.endsWith("ACCEPT"))).toBe(false);
    expect(readFileSync(h.rules6, "utf8").split("\n")).toEqual(expect.arrayContaining(["INPUT -i rvs+ -j DROP", "INPUT -i rvx+ -j DROP"]));
    // The metadata block (wall_off_containers') is untouched and still on top for every container.
    expect(installed).toContain("DOCKER-USER -d 169.254.169.254/32 -j DROP");
  });

  it.each([
    ["a firewall rule cannot be added", { failRuleInsert: true }, "could not wall the sandbox network"],
    ["the metadata block is not in place", { noMetadataBlock: true }, "could not wall the sandbox network"],
    ["the internal network cannot be made", { failInnerCreate: true }, "could not make the internal sandbox network"],
    ["the outer network cannot be made", { failOuterCreate: true }, "could not make the gateway's outer network"],
    ["the worker image gives no gateway program", { emptyProgram: true }, "could not start the sandbox egress gateway"],
    ["the worker image gives a deny list that is too short to be the list", { fewNames: true }, "could not start the sandbox egress gateway"],
    ["the worker image gives a deny name that is not a plain name", { badName: true }, "could not start the sandbox egress gateway"],
    ["the worker image gives an S3 deny list that is too short to be the list", { fewS3: true }, "could not start the sandbox egress gateway"],
    ["the worker image gives an S3 deny name that is not a plain name", { badS3: true }, "could not start the sandbox egress gateway"],
    ["the gateway cannot be created", { failCreate: true }, "could not start the sandbox egress gateway"],
    ["the gateway cannot join the sandbox network", { failConnect: true }, "could not start the sandbox egress gateway"],
    ["the gateway cannot be started", { failStart: true }, "could not start the sandbox egress gateway"],
    ["the gateway is not on both networks", { ghostNetworks: true }, "is not running on its two networks"],
    ["a sandbox's place cannot reach the gateway, or reaches a registry or a raw address", { failProbe: true }, "did not pass its checks"],
    ["Docker already has another default name server (it is never overwritten)", { otherDaemonDns: true }, "default name server"],
    ["the host has no non-loopback name server to give the worker", { noResolvers: true }, "host's name servers"],
    ["daemon.json is not a JSON object", { notJsonDaemon: true }, "default name server"],
    ["Docker does not restart on the new daemon file", { failDockerRestart: true }, "default name server"],
    ["the container firewall cannot be put back after the restart", { failFirewall: true }, "default name server"],
    ["Docker does not come back after the restart", { dockerNotReady: true }, "default name server"],
  ] as const)("FAILS THE BOOT (fail closed) when %s: a reason, no sandbox settings for the worker, no restore unit", (_name, options: Options, message) => {
    const h = host(options);
    const result = runStage(h);
    expect(result.status).not.toBe(0);
    expect(result.failure).toContain(message);
    expect(envLines(h)).toEqual(NO_SANDBOX_ENV);
    expect(existsSync(join(h.units, "rovara-sandbox-egress.service"))).toBe(false);
    expect(existsSync(h.restore)).toBe(false);
  });

  it("never falls back: no failure leaves the worker an environment that names the open bridge, and the stage never touches `agentx-task` or the default bridge", () => {
    for (const options of [{ failStart: true }, { failProbe: true }, { failInnerCreate: true }] as const) {
      const h = host(options);
      runStage(h);
      expect(envLines(h).join("\n")).not.toMatch(/agentx-task|bridge/u);
      // (The stage looks at `agentx-task` only to remove and wall it, never to use it.)
      expect(calls(h).join("\n")).not.toMatch(/--network agentx-task|--network bridge|--network default/u);
    }
  });

  // ---- Lane L4-NETG2 (DEC 254zzz90): builds through the gateway, docker0 and agentx-task walled ----
  it("makes the gateway the Docker daemon's default name server (one key added to daemon.json, Docker restarted once, the container firewall put back) BEFORE any wall or network, so a build container on the sandbox network asks the gateway", () => {
    const h = host();
    expect(runStage(h).status).toBe(0);
    expect(readFileSync(h.daemon, "utf8")).toBe(`{"dns": ["172.28.250.2"], ${DAEMON_BEFORE.slice(1)}`);
    expect((JSON.parse(readFileSync(h.daemon, "utf8")) as { dns: string[] }).dns).toEqual(["172.28.250.2"]);
    expect(existsSync(`${h.daemon}.before-sandbox-egress`)).toBe(false);
    const log = calls(h);
    const restart = log.indexOf("systemctl restart docker.service");
    expect(log.filter((line) => line === "systemctl restart docker.service")).toHaveLength(1);
    expect(restart).toBeGreaterThan(-1);
    expect(log[restart + 1]).toBe("firewall run");
    expect(restart).toBeLessThan(log.findIndex((line) => line.startsWith("docker network create")));
    expect(restart).toBeLessThan(log.findIndex((line) => line.startsWith("docker create")));
  });

  // H1 of REVIEW-1: the worker container runs on the HOST network and inherits the daemon's default name server unless it is given its own.
  it("gives the worker container the host's resolvers (never the loopback stub, never the gateway) in the file its launcher reads, so a host-network worker still resolves names", () => {
    const h = host({ loopbackResolver: true });
    expect(runStage(h).status).toBe(0);
    expect(readFileSync(join(h.dir, "agentx", "worker-dns"), "utf8")).toBe("10.42.0.2\n169.254.169.253\n");
  });

  it("probes the default name server too: a second check from a container with no --dns of its own (as a docker build step is) that must also see the registry name refused", () => {
    const h = host();
    expect(runStage(h).status).toBe(0);
    const probes = calls(h).filter((line) => line.startsWith("docker run") && line.includes("--network rovara-snet"));
    expect(probes).toHaveLength(2);
    expect(probes[0]).toContain("--dns 172.28.250.2");
    expect(probes[1]).not.toContain("--dns");
    // (the probe script spans lines in the call log, so its last argument is on a later line; the fake `timeout` and the fake `docker` each log the call)
    expect(calls(h).filter((line) => line.endsWith(" default"))).toHaveLength(2);
    // The second one failing fails the boot (a daemon that was not restarted on the new file).
    const failing = host();
    writeFileSync(join(failing.dir, "bin", "docker"), readFileSync(join(failing.dir, "bin", "docker"), "utf8").replace('*" --network rovara-snet "*) exit 0 ;;', '*" --network rovara-snet "*) case "$*" in *" default") exit 1 ;; *) exit 0 ;; esac ;;'));
    const result = runStage(failing);
    expect(result.status).not.toBe(0);
    expect(result.failure).toContain("did not pass its checks");
  });

  it("the worker's launcher (boot.sh) gives the worker container --dns for each line of that file, before it execs docker, and nothing when the file is absent (bridge mode)", () => {
    const launcher = bootScript.slice(bootScript.indexOf("<<'LAUNCHER'"), bootScript.indexOf("\nLAUNCHER\n"));
    const line = launcher.split("\n").find((entry) => entry.startsWith("while read -r r; do args+=(--dns"))!;
    expect(line).toBeDefined();
    // Before the line that adds the pinned worker image, which must stay the last docker argument (tests/contract/worker-image.test.ts).
    expect(launcher.indexOf(line)).toBeLessThan(launcher.indexOf('"$worker_image")'));
    const dir = mkdtempSync(join(tmpdir(), "se-launcher-"));
    const file = join(dir, "worker-dns");
    writeFileSync(file, "10.42.0.2\n169.254.169.253\n");
    const run = (path: string) => spawnSync("bash", ["-c", `args=(run --network host)\n${line.split("/etc/agentx/worker-dns").join(path)}\nprintf '%s\\n' "\${args[@]}"`], { encoding: "utf8" }).stdout.trim().split("\n");
    expect(run(file)).toEqual(["run", "--network", "host", "--dns", "10.42.0.2", "--dns", "169.254.169.253"]);
    expect(run(join(dir, "absent"))).toEqual(["run", "--network", "host"]);
  });

  it("after the Docker restart it puts the test-services stage's rvi walls back when that stage ran (its functions are defined), and does nothing about them when it did not", () => {
    const withStage = host();
    expect(runStage(withStage, true).status).toBe(0);
    const log = calls(withStage);
    expect(log).toContain("ts-wall-run-networks");
    expect(log.indexOf("ts-wall-run-networks")).toBeGreaterThan(log.indexOf("systemctl restart docker.service"));
    const without = host();
    expect(runStage(without).status).toBe(0);
    expect(calls(without)).not.toContain("ts-wall-run-networks");
  });

  it("an empty daemon.json object gets the key without a trailing comma", () => {
    const h = host({ emptyDaemonJson: true });
    expect(runStage(h).status).toBe(0);
    expect(JSON.parse(readFileSync(h.daemon, "utf8"))).toEqual({ dns: ["172.28.250.2"] });
  });

  it("does not restart Docker again when the gateway is already its name server (a second boot step or a rerun)", () => {
    const h = host({ dnsAlreadySet: true });
    expect(runStage(h).status).toBe(0);
    expect(calls(h)).not.toContain("systemctl restart docker.service");
    expect(readFileSync(h.daemon, "utf8")).toBe('{"dns": ["172.28.250.2"], "data-root": "/x"}\n');
  });

  it("puts the old daemon.json back (and restarts Docker on it) when Docker will not run on the new one, then fails the boot", () => {
    const h = host({ failDockerRestart: true });
    expect(runStage(h).status).not.toBe(0);
    expect(readFileSync(h.daemon, "utf8")).toBe(DAEMON_BEFORE);
    expect(calls(h).filter((line) => line === "systemctl restart docker.service")).toHaveLength(2);
    expect(envLines(h)).toEqual(NO_SANDBOX_ENV);
  });

  it("walls docker0 and a left-over agentx-task bridge: nothing is forwarded from them and the host's own services are closed to them", () => {
    const h = host();
    expect(runStage(h).status).toBe(0);
    const installed = rules(h);
    expect(installed).toContain("DOCKER-USER -i docker0 -j DROP");
    expect(installed).toContain("INPUT -i docker0 -j DROP");
    expect(readFileSync(h.rules6, "utf8").split("\n")).toContain("INPUT -i docker0 -j DROP");
    // Nothing is opened for docker0, and no agentx-task bridge rule appears when there is no such network.
    expect(installed.filter((rule) => rule.includes("docker0")).sort()).toEqual(["DOCKER-USER -i docker0 -j DROP", "INPUT -i docker0 -j DROP"]);
    expect(installed.some((rule) => /-i br-/u.test(rule))).toBe(false);
    expect(calls(h)).toContain("docker network rm agentx-task");
  });

  it("walls a left-over agentx-task network by its bridge (br-<first 12 of its id>) when it cannot be removed, and removes it when it can", () => {
    const held = host({ staleTaskNetwork: true, taskNetworkHeld: true });
    expect(runStage(held).status).toBe(0);
    expect(rules(held)).toEqual(expect.arrayContaining(["DOCKER-USER -i br-0123456789ab -j DROP", "INPUT -i br-0123456789ab -j DROP"]));
    expect(existsSync(join(held.state, "nets", "agentx-task"))).toBe(true);
    const free = host({ staleTaskNetwork: true });
    expect(runStage(free).status).toBe(0);
    // Walled first, then removed (a rule for a bridge that is gone is harmless; a network that stays is never open).
    expect(rules(free)).toContain("DOCKER-USER -i br-0123456789ab -j DROP");
    expect(existsSync(join(free.state, "nets", "agentx-task"))).toBe(false);
  });

  it("the gateway container asks the HOST's own resolvers by name (never its own address, which is the daemon default now), without loopback stubs", () => {
    const h = host({ loopbackResolver: true });
    expect(runStage(h).status).toBe(0);
    const create = calls(h).find((line) => line.startsWith("docker create"))!;
    expect(create).toContain("--ip 172.28.251.2 --dns 10.42.0.2 --dns 169.254.169.253 --user 1000:1000");
    expect(create).not.toContain("127.0.0.53");
    expect(create).not.toContain("--dns 172.28.250.2");
  });

  it("the stage never makes a way out for builds: no docker0 or agentx-task rule opens anything, and no rule mentions a build bridge as open", () => {
    const h = host();
    expect(runStage(h).status).toBe(0);
    for (const rule of rules(h)) if (/docker0|br-/u.test(rule)) expect(rule).toMatch(/-j DROP$/u);
  });

  it("takes an internal network that is exactly as made, and removes and makes again one that is not (a network of this name from an earlier session is not trusted)", () => {
    const right = host({ innerExistsRight: true });
    expect(runStage(right).status).toBe(0);
    expect(calls(right).some((line) => line.startsWith("docker network create") && line.endsWith(" rovara-snet"))).toBe(false);
    expect(calls(right).some((line) => line === "docker network rm rovara-snet")).toBe(false);
    const wrong = host({ innerNotInternal: true });
    expect(runStage(wrong).status).toBe(0);
    const log = calls(wrong);
    expect(log.indexOf("docker network rm rovara-snet")).toBeGreaterThan(-1);
    expect(log.indexOf("docker network rm rovara-snet")).toBeLessThan(log.findIndex((line) => line.startsWith("docker network create") && line.endsWith(" rovara-snet")));
    expect(readFileSync(join(wrong.state, "nets", "rovara-snet"), "utf8")).toBe("bridge|true|true|rvs0|false|172.28.250.0/24 ");
  });

  it("is idempotent for the walls: a second run adds no rule", () => {
    const h = host();
    expect(runStage(h).status).toBe(0);
    const first = rules(h);
    expect(runStage(h).status).toBe(0);
    expect(rules(h)).toEqual(first);
  });

  it("installs a unit that runs before the worker, which Requires it: a worker never starts without the walls and the gateway", () => {
    const h = host();
    expect(runStage(h).status).toBe(0);
    const unit = readFileSync(join(h.units, "rovara-sandbox-egress.service"), "utf8");
    expect(unit).toContain("Before=agentx-worker.service");
    expect(unit).toContain("Requires=docker.service");
    expect(unit).toContain("After=docker.service rovara-container-firewall.service");
    expect(readFileSync(join(h.units, "agentx-worker.service.d", "30-sandbox-egress.conf"), "utf8")).toBe("[Unit]\nRequires=rovara-sandbox-egress.service\nAfter=rovara-sandbox-egress.service\n");
  });

  it("the restore script puts the walls back after a reboot or a Docker restart, starts the gateway if it is down, and FAILS (so the worker does not start) when it cannot", () => {
    const h = host();
    expect(runStage(h).status).toBe(0);
    const restore = readFileSync(h.restore, "utf8");
    const env = { PATH: `${join(h.dir, "bin")}:${process.env.PATH ?? ""}` };
    const run = () => spawnSync("bash", ["-c", restore], { encoding: "utf8", env });
    // Docker restarted: the chains are rebuilt (only the metadata block is back) and the gateway is stopped.
    writeFileSync(h.rules, "DOCKER-USER -d 169.254.169.254/32 -j DROP\n");
    spawnSync("rm", ["-f", join(h.state, "gw.running")]);
    expect(run().status).toBe(0);
    expect(rules(h)).toContain("DOCKER-USER -i rvs+ ! -o rvs+ -j DROP");
    expect(existsSync(join(h.state, "gw.running"))).toBe(true);
    expect(rules(h)).toEqual(expect.arrayContaining(["DOCKER-USER -i docker0 -j DROP", "INPUT -i docker0 -j DROP"]));
    // The gateway is no longer Docker's name server (the file was replaced): the unit fails, so the worker does not start with builds that could resolve elsewhere.
    const daemonNow = readFileSync(h.daemon, "utf8");
    writeFileSync(h.daemon, '{"data-root": "/x"}\n');
    expect(run().status).not.toBe(0);
    writeFileSync(h.daemon, daemonNow);
    expect(run().status).toBe(0);
    // The gateway cannot be started: the unit fails.
    spawnSync("rm", ["-f", join(h.state, "gw.running")]);
    writeFileSync(join(h.dir, "bin", "docker"), "#!/bin/bash\nexit 1\n");
    expect(run().status).not.toBe(0);
    // A rule cannot be added: the unit fails.
    writeFileSync(join(h.dir, "bin", "iptables"), "#!/bin/bash\nexit 1\n");
    expect(run().status).not.toBe(0);
  });
});

describe("the snippets the stage runs", () => {
  const snippet = (name: string): string => {
    const body = stage.slice(stage.indexOf(`\n${name}() {`), stage.indexOf("\n}\n", stage.indexOf(`\n${name}() {`)));
    return /se_image_node "(.*)"/u.exec(body)![1]!.replace(/\\n/gu, "\\n");
  };
  const here = new URL("../..", import.meta.url).pathname;
  const node = (code: string) => spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: here, encoding: "utf8", maxBuffer: 10_000_000 });

  it("the program snippet prints exactly the contracts' gateway program, and the names snippet exactly the deny list (needs the contracts built, as the worker image has them)", () => {
    const program = node(snippet("se_program"));
    expect(program.status, program.stderr).toBe(0);
    expect(program.stdout).toBe(EGRESS_GATEWAY_SOURCE);
    const names = node(snippet("se_denied_names"));
    expect(names.status, names.stderr).toBe(0);
    expect(names.stdout).toBe(SANDBOX_REGISTRY_DENY.join("\n"));
    const s3 = node(snippet("se_denied_s3_names"));
    expect(s3.status, s3.stderr).toBe(0);
    expect(s3.stdout).toBe(SANDBOX_S3_DENY.join("\n"));
    expect(program.stdout.length).toBeGreaterThan(20_000);
  });

  const probe = /readonly SE_PROBE='([\s\S]*?)'\nse_probe/u.exec(stage)![1]!;

  it("the stage and the wrapper are valid bash, and the probe is valid JavaScript", () => {
    expect(spawnSync("bash", ["-n"], { input: stage, encoding: "utf8" }).status).toBe(0);
    expect(spawnSync("bash", ["-n", new URL("../../packages/worker/ec2/devcontainer-docker.sh", import.meta.url).pathname], { encoding: "utf8" }).status).toBe(0);
    expect(spawnSync(process.execPath, ["--check", "-"], { input: probe, encoding: "utf8" }).status).toBe(0);
  });

  it("the probe passes only when a registry name is NXDOMAIN AND a raw address has no route; it fails when the name resolves, when a raw address connects, and when nothing answers", async () => {
    // A name server on a loopback port that answers every question with `rcode` (and an A record when 0), and the probe run against it; `net.connect` is replaced (through a preload file) so the test never touches a network.
    const dir = mkdtempSync(join(tmpdir(), "se-probe-"));
    const preloadFile = join(dir, "preload.cjs");
    const run = async (input: { rcode: number; reach: "no route" | "open" | "refused" }, withServer = true) => {
      const server = createSocket("udp4");
      server.on("message", (message, remote) => {
        const reply = Buffer.from(message);
        reply.writeUInt16BE(0x8180 | input.rcode, 2);
        if (input.rcode === 0) reply.writeUInt16BE(1, 6);
        const answer = input.rcode === 0 ? Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 30, 0, 4, 1, 2, 3, 4]) : Buffer.alloc(0);
        server.send(Buffer.concat([reply, answer]), remote.port, remote.address);
      });
      await new Promise<void>((resolve) => server.bind(0, "127.0.0.1", resolve));
      const port = server.address().port;
      if (!withServer) server.close();
      writeFileSync(preloadFile, `const net=require("net");const events=require("events");net.connect=()=>{const s=new events.EventEmitter();setImmediate(()=>s.emit(${input.reach === "open" ? '"connect"' : input.reach === "refused" ? '"error", Object.assign(new Error("refused"), {code:"ECONNREFUSED"})' : '"error", Object.assign(new Error("unreachable"), {code:"ENETUNREACH"})'}));return s;};`);
      // Asynchronous: the name server above lives in this process, so a blocking spawn would stop it from answering.
      const ran = await new Promise<{ status: number | null; out: string }>((resolve) => {
        execFile(process.execPath, ["-r", preloadFile, "-e", probe, `127.0.0.1:${String(port)}`], { encoding: "utf8", timeout: 30_000 }, (error, stdout) => resolve({ status: error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : null, out: stdout }));
      });
      if (withServer) server.close();
      return ran;
    };
    expect(await run({ rcode: 3, reach: "no route" })).toMatchObject({ status: 0 });
    expect((await run({ rcode: 3, reach: "no route" })).out).toContain('"ok":true');
    expect(await run({ rcode: 0, reach: "no route" })).toMatchObject({ status: 1 });
    expect((await run({ rcode: 0, reach: "no route" })).out).toContain("a registry name resolved");
    expect(await run({ rcode: 3, reach: "open" })).toMatchObject({ status: 1 });
    expect((await run({ rcode: 3, reach: "open" })).out).toContain("a raw address was reachable");
    expect(await run({ rcode: 3, reach: "no route" }, false)).toMatchObject({ status: 1 });
    // A refusal is not "no route": something on that network answered.
    expect(await run({ rcode: 3, reach: "refused" })).toMatchObject({ status: 1 });
  }, 60_000);
});

describe("boot.sh's sandbox-egress hook and the boot configuration", () => {
  const config: Ec2WorkerBootConfig = {
    workspaceId: "11111111-2222-4333-8444-555555555555", generation: 2, volumeId: "vol-0123456789abcdef0", expectNewVolume: false, workerImage: WORKER_IMAGE, invokePublicKey: "QUJD",
    controlPlaneUrl: "https://abc.execute-api.us-west-2.amazonaws.com", modelProvider: "amazon-bedrock", modelId: "m", promptCacheRetention: "long", logGroupName: "/agentx/staging/worker",
  };

  it("renders AGENTX_SANDBOX_EGRESS='gateway' only for the gateway setting; `bridge` adds nothing, so its user data is byte-identical to before", () => {
    expect(ec2WorkerBootScript({ ...config, sandboxEgress: "gateway" }, bootScript)).toContain("export AGENTX_SANDBOX_EGRESS='gateway'");
    expect(ec2WorkerBootScript(config, bootScript)).not.toContain("export AGENTX_SANDBOX_EGRESS");
    expect(ec2WorkerUserData(config, bootScript)).toBe(ec2WorkerUserData({ ...config }, bootScript));
    // The only difference the gateway makes to the script is that one line.
    const withGateway = ec2WorkerBootScript({ ...config, sandboxEgress: "gateway" }, bootScript).split("\n");
    const without = ec2WorkerBootScript(config, bootScript).split("\n");
    expect(withGateway.filter((line) => !without.includes(line))).toEqual(["export AGENTX_SANDBOX_EGRESS='gateway'"]);
    expect(without.filter((line) => !withGateway.includes(line))).toEqual([]);
  });

  it("refuses any value but `gateway` in the boot configuration (a stack value of `bridge` is the absence of the variable, never a value)", () => {
    for (const bad of ["bridge", "Gateway", "1", "", "gateway; rm -rf /"]) expect(() => ec2WorkerBootScript({ ...config, sandboxEgress: bad as never }, bootScript), bad).toThrow();
  });

  it("keeps the user data under EC2's limit with the gateway on", () => {
    const sized = ec2WorkerUserData({ ...config, sandboxEgress: "gateway", testServices: true }, bootScript);
    expect(Buffer.from(sized, "base64").length).toBeLessThan(EC2_USER_DATA_MAX_BYTES - 1_000);
  });

  it("runs the stage only for exactly `gateway`, after the test-services stage (which restarts Docker) and the worker unit, before the worker starts, and a failure FAILS the boot", () => {
    expect(bootScript).toContain('if [[ ${AGENTX_SANDBOX_EGRESS:-} == gateway ]]; then BOOT_STEP="set up the sandbox egress gateway"; sandbox_egress_stage || fail "could not set up the sandbox egress gateway"; fi');
    const hook = bootScript.indexOf("sandbox_egress_stage || fail");
    expect(bootScript.indexOf('[[ ${AGENTX_TEST_SERVICES:-} != 1 ]] || test_services_stage "$region"')).toBeLessThan(hook);
    expect(bootScript.indexOf('write_worker_unit "$region" "$instance_id"\n')).toBeLessThan(hook);
    expect(hook).toBeLessThan(bootScript.indexOf('systemctl enable --now "$WORKER_UNIT"'));
  });

  it("copies the stage out of the digest-pinned worker image with no network, no capability and a read-only root, and sources it only when the copy worked", () => {
    const start = bootScript.indexOf("\nsandbox_egress_stage() {");
    const body = bootScript.slice(start, bootScript.indexOf("\n}\n", start));
    expect(body).toContain('docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --entrypoint cat "$AGENTX_WORKER_IMAGE" /opt/agentx/packages/worker/ec2/sandbox-egress.sh >"$f" && . "$f" && sandbox_egress_main');
    const dir = mkdtempSync(join(tmpdir(), "se-hook-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "docker"), "#!/bin/bash\nexit 1\n");
    writeFileSync(join(bin, "timeout"), '#!/bin/bash\nshift; exec "$@"\n');
    chmodSync(join(bin, "docker"), 0o755);
    chmodSync(join(bin, "timeout"), 0o755);
    const program = `try_seconds() { printf '%s\\n' "$1"; }\nsandbox_egress_main() { echo SOURCED; }\n${body.split("/run/agentx-se-stage.sh").join(join(dir, "stage.sh"))}\n}\nsandbox_egress_stage`;
    const ran = spawnSync("bash", ["-c", program], { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH ?? ""}` , AGENTX_WORKER_IMAGE: WORKER_IMAGE } });
    expect(ran.status).not.toBe(0);
    expect(ran.stdout).not.toContain("SOURCED");
  });

  it("ships in the worker image beside the other stages (the build copies packages/worker whole), and the devcontainer wrapper is executable", () => {
    expect(readFileSync(new URL("../../environments/base/Dockerfile", import.meta.url), "utf8")).toContain("COPY --from=build /opt/agentx/packages/worker ./packages/worker");
    expect(readFileSync(new URL("../../.dockerignore", import.meta.url), "utf8")).not.toMatch(/ec2|\.sh/u);
    expect(spawnSync("test", ["-x", new URL("../../packages/worker/ec2/devcontainer-docker.sh", import.meta.url).pathname]).status).toBe(0);
  });
});
