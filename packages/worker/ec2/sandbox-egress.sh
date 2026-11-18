# EC2 worker boot, sandbox-egress stage (lane L4-NETG, owner DEC 254zzz77). Code's boot.sh is at its user data limit, so this stage ships in the worker image at
# /opt/agentx/packages/worker/ec2/sandbox-egress.sh. boot.sh runs it only for a launch with AGENTX_SANDBOX_EGRESS=gateway (the install's WorkerSandboxEgress setting is `gateway`): it copies this file out of the worker image it
# pulled BY DIGEST (no network, no capability), sources it and calls sandbox_egress_main, after the worker environment and unit are written (and after the test-services stage, which restarts Docker) and BEFORE the worker starts.
# It runs in boot.sh's shell (log, fail, try_seconds, the constants are boot.sh's). Sourcing it defines functions and constants and runs nothing.
#
# WHY: agent code runs in containers ON the worker host: task sandboxes (the `agentx-task` bridge) and the project's devcontainer (Docker's default bridge). Both are NATed out through the host's own network card, and the worker
# security group lets TCP 443 reach any address, so a sandbox could reach any IP over HTTPS: a registry, an attacker's host, DNS-over-HTTPS (which skips the VPC DNS firewall). A subnet or VPC split cannot separate them from the host
# (they share its address); the split has to be on the host. This stage does that:
#   - rovara-snet (bridge rvs0, `--internal`, no host address): the ONLY network task sandboxes and devcontainers join. It has no default route: a packet to any address outside it is unreachable.
#   - rovara-xnet (bridge rvx0): the way out of the gateway alone.
#   - rovara-egw: the egress gateway (the laptop's program, "host" mode: contracts egress-gateway-source.ts). On both networks. It is the sandboxes' only name server and forwards HTTPS by the name in the TLS hello to PUBLIC
#     addresses it resolved itself, for the names the install's VPC resolver (the DNS firewall's allow lists) answers, EXCEPT the push-capable registries (contracts sandbox-deny-domains.ts), which only the sandbox side loses.
# BUILDS (lane L4-NETG2, DEC 254zzz90): the dev container's IMAGE BUILD (`docker build`: Dockerfile RUN, features' install.sh) and the verifier's contained E2E build commands run task-controlled code too. They now join rovara-snet as well:
#   - the wrapper (devcontainer-docker.sh) puts `--network rovara-snet` on `docker build` (the classic builder takes a named network; buildx cannot, so the wrapper refuses it) and the verifier puts `--network rovara-snet --dns <gateway>` on its build containers
#     (verifier docker-application-host.ts `buildEgress`). A `docker build` has no `--dns` option, so the DAEMON's default name server is the gateway (`"dns"` in /etc/docker/daemon.json, written and activated here): a build container on rovara-snet then asks the gateway.
#   - Docker's default bridge (docker0) and the old `agentx-task` bridge are walled: nothing forwarded from them, nothing to the host. What still runs on docker0 is trusted and needs no network (the saved-environment builder: `FROM scratch`, `--network none`).
# The HOST's own Docker, the worker container (`--network host`), the sealed rvi*/rvb* test-service and check networks, and Rovara's own services are unchanged: the host keeps registry access for its image pulls.
#
# FAIL CLOSED: unlike the test-services stage, any failure here FAILS THE BOOT (`fail`): the worker never starts with sandboxes that could still reach the internet some other way. After a reboot or a Docker restart a unit puts the
# walls and the gateway back before the worker starts and, if it cannot, the worker does not start either.
#
# What the worker is given (appended to its environment file): AGENTX_SANDBOX_EGRESS=gateway, AGENTX_SANDBOX_NETWORK=rovara-snet, AGENTX_SANDBOX_DNS=<the gateway's address on it>. With them the worker puts every sandbox and
# devcontainer on that network with that name server (task-sandbox.ts `gatewayEgressFor`), and refuses to start one without.

readonly SE_UNIT=rovara-sandbox-egress.service
readonly SE_RESTORE=/usr/local/libexec/rovara-sandbox-egress-restore
readonly SE_GATEWAY=rovara-egw
readonly SE_INNER_NET=rovara-snet
readonly SE_INNER_BRIDGE=rvs0
readonly SE_INNER_SUBNET=172.28.250.0/24
readonly SE_INNER_IP=172.28.250.2
readonly SE_OUTER_NET=rovara-xnet
readonly SE_OUTER_BRIDGE=rvx0
readonly SE_OUTER_SUBNET=172.28.251.0/24
readonly SE_OUTER_IP=172.28.251.2
readonly SE_NODE=/usr/local/bin/node
readonly SE_PROGRAM_BYTES_MIN=20000

readonly SE_FIREWALL=/usr/local/libexec/rovara-container-firewall
readonly SE_DAEMON_JSON=/etc/docker/daemon.json
readonly SE_TASK_NETWORK=agentx-task

# The gateway is the Docker DAEMON's default name server. A container with its own `--dns` is not affected; a container that has none (a `docker build` step, which has no such option) asks the gateway, which is reachable only from rovara-snet: on any other
# network (docker0, a stale bridge) a name lookup now fails, which is the point. Idempotent. Docker is restarted only when the file changes, then the container firewall is put back (a restart rebuilds Docker's chains).
se_daemon_dns_is() { grep -q "\"dns\": \[\"$SE_INNER_IP\"\]" "$SE_DAEMON_JSON" 2>/dev/null; }
se_daemon_dns() {
  local content
  se_daemon_dns_is && return 0
  grep -q '"dns"' "$SE_DAEMON_JSON" 2>/dev/null && return 1
  cp -p "$SE_DAEMON_JSON" "$SE_DAEMON_JSON.before-sandbox-egress" || return 1
  # The file is one JSON object (boot.sh and the test-services stage write it so); the key goes in right after the opening brace. Anything else is left alone and the boot fails.
  content=$(<"$SE_DAEMON_JSON")
  if [[ "${content//[[:space:]]/}" == "{}" ]]; then printf '{"dns": ["%s"]}\n' "$SE_INNER_IP" >"$SE_DAEMON_JSON"
  elif [[ "$content" == \{* ]]; then printf '%s\n' "{\"dns\": [\"$SE_INNER_IP\"], ${content:1}" >"$SE_DAEMON_JSON"
  else mv -f "$SE_DAEMON_JSON.before-sandbox-egress" "$SE_DAEMON_JSON"; return 1; fi
  if se_daemon_dns_is && systemctl restart docker.service && bash "$SE_FIREWALL" && se_docker_ready; then rm -f "$SE_DAEMON_JSON.before-sandbox-egress"; return 0; fi
  mv -f "$SE_DAEMON_JSON.before-sandbox-egress" "$SE_DAEMON_JSON"
  systemctl reset-failed docker.service 2>/dev/null || true
  systemctl restart docker.service
  return 1
}
se_docker_ready() { local i; for i in 1 2 3 4 5 6 7 8 9 10; do docker info >/dev/null 2>&1 && return 0; sleep 2; done; return 1; }

# The bridge interface of the old `agentx-task` network, when one is left from a bridge-mode session (the data root lives on the workspace volume): br-<first 12 characters of the network id>. Empty when there is none.
se_task_bridge() {
  local id
  id=$(docker network inspect --format '{{.Id}}' "$SE_TASK_NETWORK" 2>/dev/null) || return 0
  [[ "$id" =~ ^[a-f0-9]{12,} ]] && printf 'br-%s' "${id:0:12}"
  return 0
}

# One rule, once: -C finds it, else -I puts it at the top.
se_rule() { local tool=$1; shift; "$tool" -C "$@" 2>/dev/null || "$tool" -I "$@"; }

# The walls around the two networks (the same shape as the rvb*/rvi* walls of wall_off_containers, which this does not touch). Idempotent; also run by the restore unit after a reboot or a Docker restart.
#   rvs+  (sandboxes): nothing leaves the bridge (DROP anything forwarded to another interface), and nothing reaches a service of the host (INPUT).
#   docker0 and the old agentx-task bridge (gateway mode only, scope 4.2.2): nothing is forwarded from them and nothing reaches a service of the host. Task code no longer runs there: sandboxes and dev containers are on rvs0, builds too.
#   rvx+  (the gateway's way out): the private ranges and the metadata range are dropped, except the host's own resolvers on port 53 (the VPC resolver is a private address); the host's INPUT is dropped.
# The metadata address stays dropped for every container by wall_off_containers' own rule.
se_walls() {
  local range resolver proto bridge
  se_rule iptables DOCKER-USER -i rvs+ ! -o rvs+ -j DROP || return 1
  se_rule iptables INPUT -i rvs+ -j DROP || return 1
  for range in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 127.0.0.0/8; do
    se_rule iptables DOCKER-USER -i rvx+ -d "$range" -j DROP || return 1
  done
  for resolver in $(awk '$1=="nameserver"&&$2~/^[0-9.]+$/{print $2}' /etc/resolv.conf /run/systemd/resolve/resolv.conf 2>/dev/null); do
    for proto in udp tcp; do se_rule iptables DOCKER-USER -i rvx+ -d "$resolver" -p "$proto" --dport 53 -j RETURN || return 1; done
  done
  se_rule iptables INPUT -i rvx+ -j DROP || return 1
  for bridge in docker0 "$(se_task_bridge)"; do
    [[ -n "$bridge" ]] || continue
    se_rule iptables DOCKER-USER -i "$bridge" -j DROP || return 1
    se_rule iptables INPUT -i "$bridge" -j DROP || return 1
    ! command -v ip6tables >/dev/null || se_rule ip6tables INPUT -i "$bridge" -j DROP || echo "ip6tables $bridge rule failed" >&2
  done
  for bridge in rvs+ rvx+; do
    ! command -v ip6tables >/dev/null || se_rule ip6tables INPUT -i "$bridge" -j DROP || echo "ip6tables $bridge rule failed" >&2
  done
  iptables -C DOCKER-USER -d 169.254.169.254/32 -j DROP 2>/dev/null
}

# The network `$1` is as Rovara makes it: a bridge, the expected internal flag, host-address option, bridge name and subnet, and no IPv6.
se_network_is() {
  local name=$1 internal=$2 inhibit=$3 bridge=$4 subnet=$5 found
  found=$(docker network inspect --format '{{.Driver}}|{{.Internal}}|{{index .Options "com.docker.network.bridge.inhibit_ipv4"}}|{{index .Options "com.docker.network.bridge.name"}}|{{.EnableIPv6}}|{{range .IPAM.Config}}{{.Subnet}} {{end}}' "$name" 2>/dev/null) || return 1
  [[ "$found" == "bridge|$internal|$inhibit|$bridge|false|$subnet " ]]
}
# A network of this name is not trusted (the data root lives on the workspace volume, so one can be left from an earlier session): one that is not exactly as made here is removed and made again.
se_ensure_network() {
  local name=$1 internal=$2 inhibit=$3 bridge=$4 subnet=$5
  se_network_is "$name" "$internal" "$inhibit" "$bridge" "$subnet" && return 0
  docker network inspect "$name" >/dev/null 2>&1 && { docker network rm "$name" >/dev/null || return 1; }
  if [[ "$internal" == true ]]; then
    docker network create --driver bridge --ipv6=false --internal --subnet "$subnet" -o com.docker.network.bridge.inhibit_ipv4=true -o "com.docker.network.bridge.name=$bridge" "$name" >/dev/null || return 1
  else
    docker network create --driver bridge --ipv6=false --subnet "$subnet" -o "com.docker.network.bridge.name=$bridge" "$name" >/dev/null || return 1
  fi
  se_network_is "$name" "$internal" "$inhibit" "$bridge" "$subnet"
}

# The gateway program and the deny list come from the worker image's own contracts (the very text the laptop runs), read with no network and no capability. Only plain names reach the gateway's configuration.
se_image_node() {
  timeout --foreground --kill-after=10s "$(try_seconds 60)s" docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
    --workdir /opt/agentx --entrypoint node "$AGENTX_WORKER_IMAGE" --input-type=module -e "$1"
}
se_program() {
  se_image_node "import { EGRESS_GATEWAY_SOURCE as s } from '@agentx/contracts/egress-gateway-source'; process.stdout.write(s)"
}
se_denied_names() {
  se_image_node "import { SANDBOX_REGISTRY_DENY as d } from '@agentx/contracts'; process.stdout.write(d.join('\n'))"
}
# The gateway's configuration: host mode, its two networks, and the deny list (each name checked here too: lower-case letters, digits, dots, hyphens and a `*` label).
se_config() {
  local names=() name list=""
  # The list has no newline after its last name (`|| [[ -n $name ]]` keeps that last line).
  while IFS= read -r name || [[ -n "$name" ]]; do
    [[ "$name" =~ ^(\*\.)?[a-z0-9*]([a-z0-9*.-]{0,250}[a-z0-9*])?$ ]] || return 1
    names+=("$name")
  done < <(se_denied_names)
  ((${#names[@]} >= 10)) || return 1
  for name in "${names[@]}"; do list+="${list:+,}\"$name\""; done
  printf '{"mode":"host","sandboxDenied":[%s],"nets":{"sandbox":"%s","external":"%s"}}' "$list" "$SE_INNER_SUBNET" "$SE_OUTER_SUBNET"
}

# The gateway container: no capability (it binds 53, 80 and 443 only because the namespace's unprivileged port start is 53), read-only, bounded, no forwarding, restarted by Docker if it dies. Created on the outer network, joined to the
# inner one at a fixed address, then started (so the program finds both its addresses).
se_gateway() {
  local program config resolver dns=()
  # The gateway asks the host's own resolvers (the VPC resolver), by name: the daemon's default name server is the gateway itself, which would loop.
  # (Loopback stubs such as systemd-resolved's 127.0.0.53 are no use inside a container; the real resolver is in /run/systemd/resolve/resolv.conf.)
  for resolver in $(awk '$1=="nameserver"&&$2~/^[0-9.]+$/&&$2!~/^127\./{print $2}' /etc/resolv.conf /run/systemd/resolve/resolv.conf 2>/dev/null | sort -u); do dns+=(--dns "$resolver"); done
  ((${#dns[@]} > 0)) || return 1
  program=$(se_program) && ((${#program} >= SE_PROGRAM_BYTES_MIN)) && [[ "$program" == '"use strict";'* ]] || return 1
  config=$(se_config) || return 1
  docker rm --force "$SE_GATEWAY" >/dev/null 2>&1 || true
  docker create --name "$SE_GATEWAY" --label rovara.sandbox-egress=gateway --restart unless-stopped \
    --network "$SE_OUTER_NET" --ip "$SE_OUTER_IP" "${dns[@]}" --user 1000:1000 \
    --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m \
    --sysctl net.ipv4.ip_forward=0 --sysctl net.ipv4.ip_unprivileged_port_start=53 --pids-limit 512 --memory 512m \
    --env "ROVARA_GW_CONFIG=$config" --entrypoint "$SE_NODE" "$AGENTX_WORKER_IMAGE" -e "$program" >/dev/null || return 1
  docker network connect --ip "$SE_INNER_IP" "$SE_INNER_NET" "$SE_GATEWAY" || return 1
  docker start "$SE_GATEWAY" >/dev/null
}
# The gateway is running, on exactly its two networks.
se_gateway_running() {
  [[ $(docker inspect --format '{{.State.Running}}|{{range $n, $c := .NetworkSettings.Networks}}{{$n}} {{end}}' "$SE_GATEWAY" 2>/dev/null) == "true|$SE_INNER_NET $SE_OUTER_NET " ]]
}

# What a sandbox would see, tried from a container of the worker image on the inner network with the gateway as its only name server: (1) the gateway answers, and a registry name is NXDOMAIN (a dead gateway times out, a gateway
# without its deny list answers); (2) a connection to a public address by number has no route. Both must hold or the boot fails.
readonly SE_PROBE='
const dns = require("dns"), net = require("net");
const resolver = new dns.promises.Resolver({ timeout: 4000, tries: 2 });
resolver.setServers([process.argv[1]]);
const done = (ok, why) => { console.log(JSON.stringify({ ok, why })); process.exit(ok ? 0 : 1); };
resolver.resolve4("ghcr.io").then(() => done(false, "a registry name resolved"), (error) => {
  if (error.code !== "ENOTFOUND") return done(false, "the gateway did not answer: " + error.code);
  const socket = net.connect({ host: "1.1.1.1", port: 443, timeout: 4000 });
  socket.on("connect", () => done(false, "a raw address was reachable"));
  socket.on("timeout", () => done(true, "no route"));
  // Only a real no-route answer counts: a refusal (ECONNREFUSED) means something on that network answered.
  socket.on("error", (e) => (e.code === "ENETUNREACH" || e.code === "EHOSTUNREACH") ? done(true, "no route") : done(false, "unexpected: " + e.code));
});'
se_probe() {
  timeout --foreground --kill-after=10s "$(try_seconds 60)s" docker run --rm --network "$SE_INNER_NET" --dns "$SE_INNER_IP" --read-only --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 \
    --entrypoint "$SE_NODE" "$AGENTX_WORKER_IMAGE" -e "$SE_PROBE" "$SE_INNER_IP" >/dev/null
}

# After a reboot or a Docker restart: the walls and the gateway again, before the worker starts. Any miss exits non-zero, and the worker (which Requires this unit) does not start.
se_install_restore_unit() {
  { printf 'readonly SE_GATEWAY=%s SE_INNER_NET=%s SE_OUTER_NET=%s\n' "$SE_GATEWAY" "$SE_INNER_NET" "$SE_OUTER_NET"
    declare -f se_rule se_task_bridge se_walls se_gateway_running se_daemon_dns_is
    printf 'readonly SE_DAEMON_JSON=%s SE_INNER_IP=%s SE_TASK_NETWORK=%s\n' "$SE_DAEMON_JSON" "$SE_INNER_IP" "$SE_TASK_NETWORK"
    printf 'se_daemon_dns_is || exit 1\n'
    printf 'se_walls || exit 1\n'
    printf 'se_gateway_running || { docker start "$SE_GATEWAY" >/dev/null 2>&1; sleep 3; }\n'
    printf 'se_gateway_running || exit 1\n'
  } >"$SE_RESTORE" || return 1
  chmod 0700 "$SE_RESTORE" || return 1
  cat >"/etc/systemd/system/$SE_UNIT" <<UNIT || return 1
[Unit]
Description=Sandbox egress walls and gateway, before the worker
Requires=docker.service
After=docker.service $FIREWALL_UNIT
Before=$WORKER_UNIT
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash $SE_RESTORE
[Install]
WantedBy=multi-user.target
UNIT
  install -d -o root -g root -m 0755 "/etc/systemd/system/$WORKER_UNIT.d" || return 1
  printf '[Unit]\nRequires=%s\nAfter=%s\n' "$SE_UNIT" "$SE_UNIT" >"/etc/systemd/system/$WORKER_UNIT.d/30-sandbox-egress.conf" || return 1
  systemctl enable "$SE_UNIT" >/dev/null 2>&1
}

sandbox_egress_main() {
  BOOT_STEP="make the gateway the Docker name server"
  se_daemon_dns || fail "could not make the sandbox egress gateway the Docker daemon's default name server"
  BOOT_STEP="wall the sandbox network"
  se_walls || fail "could not wall the sandbox network off from the host and private networks"
  BOOT_STEP="make the sandbox networks"
  se_ensure_network "$SE_INNER_NET" true true "$SE_INNER_BRIDGE" "$SE_INNER_SUBNET" || fail "could not make the internal sandbox network"
  # A stale `agentx-task` network is removed when nothing holds it; if one does, the wall above (by its bridge) still holds.
  docker network rm "$SE_TASK_NETWORK" >/dev/null 2>&1 || true
  se_ensure_network "$SE_OUTER_NET" false "" "$SE_OUTER_BRIDGE" "$SE_OUTER_SUBNET" || fail "could not make the gateway's outer network"
  BOOT_STEP="start the sandbox egress gateway"
  se_gateway || fail "could not start the sandbox egress gateway"
  BOOT_STEP="check the sandbox egress gateway"
  se_gateway_running || fail "the sandbox egress gateway is not running on its two networks"
  se_probe || fail "the sandbox egress gateway did not pass its checks (a registry name must be refused and a raw address unreachable from a sandbox)"
  BOOT_STEP="hand the worker its sandbox network"
  printf 'AGENTX_SANDBOX_EGRESS=gateway\nAGENTX_SANDBOX_NETWORK=%s\nAGENTX_SANDBOX_DNS=%s\n' "$SE_INNER_NET" "$SE_INNER_IP" >>"$WORKER_ENV_FILE" || fail "could not write the worker's sandbox network settings"
  se_install_restore_unit || fail "could not install the sandbox egress restore unit"
  log "sandbox egress: gateway on $SE_INNER_NET ($SE_INNER_IP); sandboxes and dev containers have no other way out"
}
