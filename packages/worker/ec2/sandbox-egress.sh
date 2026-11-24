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
# Where the worker (never a sandbox: no sandbox mounts this folder, and it is not under the workspace) publishes the exact S3 hosts the project's allowed websites lifted from the sandbox S3 deny, at every prepare. Owned by the worker's user,
# read-only in the gateway. On the root volume, so a stop and start keeps it; the restore unit makes the folder again before the gateway starts. A missing or unreadable file means no lift (the S3 stays denied).
readonly SE_ALLOW_DIR=/var/lib/rovara-egress
readonly SE_ALLOW_FILE=/var/lib/rovara-egress/project-allow.json
readonly SE_PROGRAM_BYTES_MIN=20000

readonly SE_FIREWALL=/usr/local/libexec/rovara-container-firewall
readonly SE_DAEMON_JSON=/etc/docker/daemon.json
readonly SE_TASK_NETWORK=agentx-task
readonly SE_WORKER_DNS_FILE=/etc/agentx/worker-dns
# L4-NETG3 (DEC 254zzz105): the Docker DAEMON's own fetches during a build (ADD <url>, a FROM base image, dev container features) go through the gateway's daemon proxy, which listens on the gateway's OUTER address and answers only the host
# (the bridge's own address, the first of the subnet). The daemon is given it in a systemd drop-in (not in daemon.json, whose `proxies` would also be copied into every container's environment).
readonly SE_PROXY_PORT=3128
readonly SE_PROXY_PEER=172.28.251.1
readonly SE_DROPIN_DIR=/etc/systemd/system/docker.service.d
readonly SE_DROPIN=$SE_DROPIN_DIR/30-rovara-build-proxy.conf

# The host's own resolvers, one per line (the VPC resolver; systemd-resolved's loopback stub is no use inside a container).
se_host_resolvers() { awk '$1=="nameserver"&&$2~/^[0-9.]+$/&&$2!~/^127\./{print $2}' /etc/resolv.conf /run/systemd/resolve/resolv.conf 2>/dev/null | sort -u || true; }
# The worker container runs on the HOST network, so the daemon's default name server (the gateway) would be its only one, and the host has no route to it: the worker's launcher (boot.sh) gives it `--dns` for each line of this file.
se_worker_dns() {
  local resolvers
  resolvers=$(se_host_resolvers) && [[ -n "$resolvers" ]] || return 1
  # /etc/agentx is boot.sh's (write_worker_launcher makes it 0700 before this stage runs on a real worker): an existing one keeps its mode, and only a missing one (the stage run on its own, as the Linux CI test does) is made, the same 0700.
  [[ -d "${SE_WORKER_DNS_FILE%/*}" ]] || install -d -m 0700 "${SE_WORKER_DNS_FILE%/*}" || return 1
  install -m 0644 /dev/null "$SE_WORKER_DNS_FILE" && printf '%s\n' "$resolvers" >"$SE_WORKER_DNS_FILE"
}
# The gateway is the Docker DAEMON's default name server (a `docker build` step has no `--dns`): "dns" in daemon.json. And the daemon's own HTTP(S) fetches use the gateway's daemon proxy (HTTP_PROXY/HTTPS_PROXY in a systemd drop-in of
# docker.service). NO_PROXY keeps off the proxy: the proxy itself, loopback, the instance metadata address (the daemon's awslogs driver gets the instance role's credentials from it, and Go does not exempt link-local addresses; the launch template requires IMDSv2 with hop limit 1, so a build's ADD of it gets 401 anyway), and the CloudWatch Logs endpoint of the region (the awslogs driver of the worker container, which must not depend on the gateway). A container with its own `--dns` is not
# affected by the default name server; one with none asks the gateway, which is reachable only from rovara-snet: on any other network (docker0, a stale bridge) a name lookup now fails, which is the point.
# Idempotent. Docker is restarted only when either file changes, then the container firewall is put back (a restart rebuilds Docker's chains); on any failure both files are put back and Docker restarted on them.
se_daemon_dns_is() { grep -q "\"dns\": \[\"${SE_INNER_IP//./\\.}\"\]" "$SE_DAEMON_JSON" 2>/dev/null; }
# The drop-in's text for this host (needs the region from the worker's environment file), and whether the file on disk is exactly that (SE_DROPIN_WANT).
se_dropin_text() {
  local region
  region=$(sed -n 's/^AWS_REGION=//p' "$WORKER_ENV_FILE" 2>/dev/null | head -n 1)
  [[ "$region" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]$ ]] || return 1
  printf '[Service]\nEnvironment="HTTP_PROXY=http://%s:%s" "HTTPS_PROXY=http://%s:%s" "NO_PROXY=localhost,127.0.0.1,169.254.169.254,%s,logs.%s.amazonaws.com"\n' "$SE_OUTER_IP" "$SE_PROXY_PORT" "$SE_OUTER_IP" "$SE_PROXY_PORT" "$SE_OUTER_IP" "$region"
}
se_dropin_is() { [[ -n "${SE_DROPIN_WANT:-}" && -f "$SE_DROPIN" && "$(<"$SE_DROPIN")" == "$SE_DROPIN_WANT" ]]; }
se_daemon_rollback() {
  mv -f "$SE_DAEMON_JSON.before-sandbox-egress" "$SE_DAEMON_JSON" 2>/dev/null
  if [[ -f "$SE_DROPIN.before-sandbox-egress" ]]; then mv -f "$SE_DROPIN.before-sandbox-egress" "$SE_DROPIN"; else rm -f "$SE_DROPIN"; fi
  systemctl daemon-reload 2>/dev/null || true
  systemctl reset-failed docker.service 2>/dev/null || true
  timeout 120s systemctl restart docker.service
}

# WHY A STEP FAILED (EGRESS-BOOT-RACE): this stage used to answer any miss in the daemon change with one fixed sentence and nothing else, so a boot that failed here left no trace of which command, what it said, or what Docker was doing. se_run runs one command,
# and on a miss keeps the step's name (SE_FAILED_STEP, short, goes into the boot failure reason) and the command, its exit status and what it printed (SE_FAILED, goes to the boot log). se_diagnose then logs the state of Docker itself. Nothing here is secret: file texts are the
# daemon settings (data root, name server, proxy address, region), unit status and journal lines of docker.service.
SE_FAILED_STEP=""
SE_FAILED=""
se_run() {
  local step=$1 out status
  shift
  out=$("$@" 2>&1)
  status=$?
  if ((status == 0)); then
    # SE_RUN_LOG=1: the step's own lines are wanted in the boot log even when it worked (the container firewall's "setup isolation" line and ip6tables warnings).
    [[ -z "${SE_RUN_LOG:-}" || -z "$out" ]] || printf '%s\n' "$out" >&2
    return 0
  fi
  SE_FAILED_STEP="$step (exit $status)"
  SE_FAILED="$step: \`$*\` exit $status${out:+: $(printf '%s' "$out" | tail -n 5 | tr '\n' '|' | head -c 600)}"
  return "$status"
}
# One diagnostic command, its last lines in the boot log. Never fails (the caller is already on a failure path).
se_logtail() {
  local label=$1 lines=$2
  shift 2
  { "$@" 2>&1 || true; } | tail -n "$lines" | while IFS= read -r line; do log "sandbox egress diagnostic [$label]: $line"; done
  return 0
}
se_diagnose() {
  log "sandbox egress: the Docker daemon change failed at: ${SE_FAILED:-no step reported}"
  se_logtail "$SE_DAEMON_JSON" 8 cat "$SE_DAEMON_JSON"
  se_logtail "$SE_DROPIN" 8 cat "$SE_DROPIN"
  se_logtail "docker.service state" 12 systemctl show docker.service -p ActiveState -p SubState -p Result -p NRestarts -p ExecMainStatus -p StartLimitBurst -p StartLimitIntervalUSec
  se_logtail "systemctl status docker.service" 15 systemctl status docker.service --no-pager -l
  ! command -v journalctl >/dev/null || se_logtail "journalctl -u docker.service" 40 journalctl -u docker.service -n 40 --no-pager
  se_logtail "docker info" 3 timeout 15 docker info
  ! command -v iptables >/dev/null || se_logtail "iptables -S DOCKER-USER" 5 iptables -S DOCKER-USER
}

# BOUNDED WAITS (EGRESS-BOOT-RACE). `systemctl restart docker.service` returning does not mean Docker answers: the socket, and the chains Docker builds in iptables (DOCKER-USER, which the container firewall inserts into), appear a moment later,
# and the first command that needed them used to be the failure. Each wait polls at most SE_READY_ATTEMPTS times (default 40) with a growing pause (1s, 2s, then 3s), each probe capped at 15 s (or what is left of the boot time: try_seconds), and it stops
# at the BOOT DEADLINE (boot.sh's BOOT_DEADLINE, AGENTX_BOOT_DEADLINE_SECONDS, 480 s from the start of the boot) with a reason that says so. So the true bound is the smaller of 40 x 15 s + 114 s of pauses (about 12 minutes, only if every probe hangs) and the boot deadline.
# The probes are functions so the cap is worked out at each probe; a miss names its command (se_run only knows the function's name).
se_probe_docker_info() { local cap status=0; cap=$(try_seconds 15); timeout "${cap}s" docker info || { status=$?; echo "[timeout ${cap}s docker info exited $status]" >&2; return "$status"; }; }
se_probe_docker_chain() { local cap status=0; cap=$(try_seconds 15); timeout "${cap}s" iptables -n -L DOCKER-USER || { status=$?; echo "[timeout ${cap}s iptables -n -L DOCKER-USER exited $status]" >&2; return "$status"; }; }
se_wait() {
  local what=$1 attempt=1 pause
  shift
  until se_run "wait for $what" "$@"; do
    if [[ -n "${BOOT_DEADLINE:-}" ]] && ((SECONDS >= BOOT_DEADLINE)); then SE_FAILED_STEP="$what: out of boot time after $attempt tries"; SE_FAILED="$SE_FAILED_STEP: ${SE_FAILED#*: }"; return 1; fi
    ((attempt < ${SE_READY_ATTEMPTS:-40})) || { SE_FAILED_STEP="$what never became ready (${SE_READY_ATTEMPTS:-40} tries)"; SE_FAILED="$SE_FAILED_STEP: ${SE_FAILED#*: }"; return 1; }
    pause=$((attempt < 3 ? attempt : 3))
    sleep "$pause"
    attempt=$((attempt + 1))
  done
  SE_FAILED_STEP=""
  SE_FAILED=""
}
se_docker_ready() { se_wait "the Docker daemon (docker info)" se_probe_docker_info; }
# Docker's DOCKER-USER chain (made by the daemon as it starts) exists: the container firewall's first rule goes into it, and `set -e` there ends the script when the chain is not there yet.
se_docker_chain_ready() { command -v iptables >/dev/null || return 0; se_wait "Docker's DOCKER-USER firewall chain" se_probe_docker_chain; }
# The restart itself, at most SE_RESTART_ATTEMPTS times (default 2: one retry) and only after the command itself failed (never after one that worked, so a slow daemon is waited for, not restarted again). Before each try the unit's failed state is cleared:
# the restarts this boot already made (Docker install, test-services stage) count against systemd's start limit, and a refused restart ("Start request repeated too quickly") is the one failure a later try cannot fix without it.
se_restart_docker() {
  local attempt=1
  until systemctl reset-failed docker.service 2>/dev/null; se_run "restart docker.service" timeout --foreground --kill-after=10s "$(try_seconds 120)s" systemctl restart docker.service; do
    ((attempt < ${SE_RESTART_ATTEMPTS:-2})) || return 1
    sleep $((attempt * 5))
    attempt=$((attempt + 1))
  done
}
# Writes the drop-in and activates both files; only the restart and what follows it can race.
se_write_dropin() { printf '%s\n' "$SE_DROPIN_WANT" >"$SE_DROPIN" && chmod 0644 "$SE_DROPIN"; }
se_activate_daemon_config() {
  se_run "make the Docker drop-in folder" install -d -m 0755 "$SE_DROPIN_DIR" \
    && se_run "write the Docker drop-in" se_write_dropin \
    && se_run "check daemon.json holds the gateway name server" se_daemon_dns_is \
    && se_run "check the Docker drop-in text" se_dropin_is \
    && se_run "reload systemd" systemctl daemon-reload \
    && se_restart_docker \
    && se_docker_ready \
    && se_docker_chain_ready \
    && SE_RUN_LOG=1 se_run "put the container firewall back" bash "$SE_FIREWALL" \
    && se_run "put the test-services walls back" se_after_restart_walls \
    && se_docker_ready
}
se_daemon_config() {
  local content
  SE_FAILED_STEP=""
  SE_FAILED=""
  se_daemon_dns_is && se_dropin_is && return 0
  # A default name server of someone else's is never overwritten.
  if grep -q '"dns"' "$SE_DAEMON_JSON" 2>/dev/null && ! se_daemon_dns_is; then SE_FAILED_STEP="daemon.json already names another default name server"; return 1; fi
  cp -p "$SE_DAEMON_JSON" "$SE_DAEMON_JSON.before-sandbox-egress" || { SE_FAILED_STEP="keep a copy of daemon.json"; return 1; }
  rm -f "$SE_DROPIN.before-sandbox-egress"
  if [[ -f "$SE_DROPIN" ]]; then cp -p "$SE_DROPIN" "$SE_DROPIN.before-sandbox-egress" || { SE_FAILED_STEP="keep a copy of the Docker drop-in"; return 1; }; fi
  if ! se_daemon_dns_is; then
    # The file is one JSON object (boot.sh and the test-services stage write it so); the key goes in right after the opening brace. Anything else is left alone and the boot fails.
    content=$(<"$SE_DAEMON_JSON")
    if [[ "${content//[[:space:]]/}" == "{}" ]]; then printf '{"dns": ["%s"]}\n' "$SE_INNER_IP" >"$SE_DAEMON_JSON"
    elif [[ "$content" == \{* ]]; then printf '%s\n' "{\"dns\": [\"$SE_INNER_IP\"], ${content:1}" >"$SE_DAEMON_JSON"
    else rm -f "$SE_DAEMON_JSON.before-sandbox-egress" "$SE_DROPIN.before-sandbox-egress"; SE_FAILED_STEP="daemon.json is not one JSON object"; return 1; fi
  fi
  if se_activate_daemon_config; then
    rm -f "$SE_DAEMON_JSON.before-sandbox-egress" "$SE_DROPIN.before-sandbox-egress"
    return 0
  fi
  # The diagnostics are taken BEFORE the rollback restarts Docker on the old files, so they show the daemon as the failure left it.
  se_diagnose
  se_daemon_rollback || log "sandbox egress: Docker did not restart on the old settings either"
  return 1
}
# A Docker restart may rebuild Docker's chains. The test-services stage (boot.sh sources it, so its functions are defined here when it ran) walls the rvi bridges from each other and closes them on IPv6; put those back.
se_after_restart_walls() {
  declare -F ts_wall_run_networks >/dev/null || return 0
  ts_run_walls_present || ts_wall_run_networks || return 1
  ! declare -F ts_wall_ipv6 >/dev/null || ts_wall_ipv6 || true
}

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
  # Docker's ICC-off bridge rule blocks same-bridge IPv4 forwarding. Keep only the
  # sandbox services that the gateway provides, and only replies from it.
  for proto in udp tcp; do se_rule iptables DOCKER-USER -i rvs+ -o rvs+ -d "$SE_INNER_IP/32" -p "$proto" --dport 53 -j ACCEPT || return 1; done
  for port in 80 443; do se_rule iptables DOCKER-USER -i rvs+ -o rvs+ -d "$SE_INNER_IP/32" -p tcp --dport "$port" -j ACCEPT || return 1; done
  se_rule iptables DOCKER-USER -i rvs+ -o rvs+ -s "$SE_INNER_IP/32" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT || return 1
  se_rule iptables DOCKER-USER -i rvs+ ! -o rvs+ -j DROP || return 1
  se_rule iptables INPUT -i rvs+ -j DROP || return 1
  for range in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 127.0.0.0/8; do
    se_rule iptables DOCKER-USER -i rvx+ -d "$range" -j DROP || return 1
  done
  for resolver in $(awk '$1=="nameserver"&&$2~/^[0-9.]+$/{print $2}' /etc/resolv.conf /run/systemd/resolve/resolv.conf 2>/dev/null); do
    for proto in udp tcp; do se_rule iptables DOCKER-USER -i rvx+ -d "$resolver" -p "$proto" --dport 53 -j RETURN || return 1; done
  done
  se_rule iptables INPUT -i rvx+ -j DROP || return 1
  # The daemon proxy: the host connects to the gateway's outer address, and the gateway's answers (established connections only) must get back in; a NEW connection from rvx+ is still dropped above. Inserted after the DROP, so it sits above it.
  se_rule iptables INPUT -i rvx+ -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT || return 1
  for bridge in docker0 "$(se_task_bridge)"; do
    [[ -n "$bridge" ]] || continue
    se_rule iptables DOCKER-USER -i "$bridge" -j DROP || return 1
    se_rule iptables INPUT -i "$bridge" -j DROP || return 1
    ! command -v ip6tables >/dev/null || se_rule ip6tables INPUT -i "$bridge" -j DROP || echo "ip6tables $bridge rule failed" >&2
  done
  # Required even when Docker disabled IPv6 on the network: namespace sysctls must not open a peer path.
  se_rule ip6tables FORWARD -i rvs+ -j DROP || return 1
  se_rule ip6tables INPUT -i rvs+ -j DROP || return 1
  for bridge in rvx+; do
    ! command -v ip6tables >/dev/null || se_rule ip6tables INPUT -i "$bridge" -j DROP || echo "ip6tables $bridge rule failed" >&2
  done
  iptables -C DOCKER-USER -d 169.254.169.254/32 -j DROP 2>/dev/null
}

# The network `$1` is as Rovara makes it: a bridge, the expected internal flag, host-address option, bridge name and subnet, and no IPv6.
se_network_is() {
  local name=$1 internal=$2 inhibit=$3 bridge=$4 subnet=$5 found
  found=$(docker network inspect --format '{{.Driver}}|{{.Internal}}|{{index .Options "com.docker.network.bridge.inhibit_ipv4"}}|{{index .Options "com.docker.network.bridge.name"}}|{{.EnableIPv6}}|{{index .Options "com.docker.network.bridge.enable_icc"}}|{{range .IPAM.Config}}{{.Subnet}} {{end}}' "$name" 2>/dev/null) || return 1
  if [[ "$name" == "$SE_INNER_NET" ]]; then
    [[ "$found" == "bridge|$internal|$inhibit|$bridge|false|false|$subnet " ]]
  else
    [[ "$found" == "bridge|$internal|$inhibit|$bridge|false||$subnet " ]]
  fi
}
# A network of this name is not trusted (the data root lives on the workspace volume, so one can be left from an earlier session): one that is not exactly as made here is removed and made again.
se_ensure_network() {
  local name=$1 internal=$2 inhibit=$3 bridge=$4 subnet=$5
  se_network_is "$name" "$internal" "$inhibit" "$bridge" "$subnet" && return 0
  docker network inspect "$name" >/dev/null 2>&1 && { docker network rm "$name" >/dev/null || return 1; }
  if [[ "$internal" == true ]]; then
    docker network create --driver bridge --ipv6=false --internal --subnet "$subnet" -o com.docker.network.bridge.inhibit_ipv4=true -o com.docker.network.bridge.enable_icc=false -o "com.docker.network.bridge.name=$bridge" "$name" >/dev/null || return 1
  else
    docker network create --driver bridge --ipv6=false --subnet "$subnet" -o "com.docker.network.bridge.name=$bridge" "$name" >/dev/null || return 1
  fi
  se_network_is "$name" "$internal" "$inhibit" "$bridge" "$subnet"
}

# Ordinary/setup sandboxes start only the image's trusted sleeping init. Before
# repository exec, the worker resolves that endpoint's host ifindex and invokes
# se_port_isolation in a mount-free, NET_ADMIN-only helper on the host network.
# Also used on the host at restore. Never identify a port by learned ARP/FDB data.
se_port_isolation() {
  local index=$1 mode=$2 port found=""
  [[ "$index" =~ ^[1-9][0-9]{0,9}$ && ( "$mode" == on || "$mode" == off ) ]] || return 1
  for port in /sys/class/net/rvs0/brif/*; do
    [[ -f "/sys/class/net/${port##*/}/ifindex" && "$(cat "/sys/class/net/${port##*/}/ifindex")" == "$index" ]] || continue
    [[ -z "$found" ]] || return 1
    found=${port##*/}
  done
  [[ -n "$found" ]] || return 1
  bridge link set dev "$found" isolated "$mode" || return 1
  local want=1
  [[ "$mode" == on ]] || want=0
  [[ "$(cat "/sys/class/net/$found/brport/isolated")" == "$want" ]]
}
se_container_port_index() {
  local mac
  mac=$(docker inspect --format '{{(index .NetworkSettings.Networks "rovara-snet").MacAddress}}' "$1") || return 1
  [[ "$mac" =~ ^([0-9a-f]{2}:){5}[0-9a-f]{2}$ ]] || return 1
  docker exec "$1" /usr/local/bin/node -e 'const fs=require("fs");const root="/sys/class/net/";const names=fs.readdirSync(root).filter(n=>fs.readFileSync(root+n+"/address","utf8").trim()===process.argv[1]);if(names.length!==1)process.exit(1);process.stdout.write(fs.readFileSync(root+names[0]+"/iflink","utf8"));' "$mac"
}
se_restore_ports() {
  local gateway port index
  gateway=$(se_container_port_index "$SE_GATEWAY") || return 1
  se_port_isolation "$gateway" off || return 1
  for port in /sys/class/net/rvs0/brif/*; do
    [[ -f "/sys/class/net/${port##*/}/ifindex" ]] || return 1
    index=$(cat "/sys/class/net/${port##*/}/ifindex") || return 1
    [[ "$index" == "$gateway" ]] && continue
    se_port_isolation "$index" on || return 1
  done
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
se_denied_s3_names() {
  se_image_node "import { SANDBOX_S3_DENY as d } from '@agentx/contracts'; process.stdout.write(d.join('\n'))"
}
# Each name is checked here too (lower-case letters, digits, dots, hyphens and `*` labels), and a list that is too short to be the list refuses.
se_name_list() {
  local min=$1 name list="" count=0
  while IFS= read -r name || [[ -n "$name" ]]; do
    [[ "$name" =~ ^(\*\.)?[a-z0-9*]([a-z0-9*.-]{0,250}[a-z0-9*])?$ ]] || return 1
    list+="${list:+,}\"$name\""
    count=$((count + 1))
  done
  ((count >= min)) || return 1
  printf '%s' "$list"
}
# The gateway's configuration: host mode, its two networks, the hard deny list (registries), the S3 deny list (lifted host by host from the project file) and where that file is.
se_config() {
  local hard soft
  hard=$(se_denied_names | se_name_list 10) || return 1
  soft=$(se_denied_s3_names | se_name_list 10) || return 1
  printf '{"mode":"host","sandboxDenied":[%s],"sandboxDeniedS3":[%s],"projectAllowFile":"%s","proxy":{"port":%s,"peer":"%s/32"},"nets":{"sandbox":"%s","external":"%s"}}' "$hard" "$soft" "$SE_ALLOW_FILE" "$SE_PROXY_PORT" "$SE_PROXY_PEER" "$SE_INNER_SUBNET" "$SE_OUTER_SUBNET"
}
# The folder for the project file: the worker's user owns it (the worker container writes it), nothing else can.
se_allow_dir() { install -d -o 1000 -g 1000 -m 0700 "$SE_ALLOW_DIR"; }

# The gateway container: no capability (it binds 53, 80 and 443 only because the namespace's unprivileged port start is 53), read-only, bounded, no forwarding, restarted by Docker if it dies. Created on the outer network, joined to the
# inner one at a fixed address, then started (so the program finds both its addresses).
se_gateway() {
  local program config resolver dns=()
  # The gateway asks the host's own resolvers (the VPC resolver), by name: the daemon's default name server is the gateway itself, which would loop.
  # (Loopback stubs such as systemd-resolved's 127.0.0.53 are no use inside a container; the real resolver is in /run/systemd/resolve/resolv.conf.)
  for resolver in $(se_host_resolvers); do dns+=(--dns "$resolver"); done
  ((${#dns[@]} > 0)) || return 1
  program=$(se_program) && ((${#program} >= SE_PROGRAM_BYTES_MIN)) && [[ "$program" == '"use strict";'* ]] || return 1
  config=$(se_config) || return 1
  se_allow_dir || return 1
  docker rm --force "$SE_GATEWAY" >/dev/null 2>&1 || true
  docker create --name "$SE_GATEWAY" --label rovara.sandbox-egress=gateway --restart unless-stopped \
    --network "$SE_OUTER_NET" --ip "$SE_OUTER_IP" "${dns[@]}" --user 1000:1000 --volume "$SE_ALLOW_DIR:$SE_ALLOW_DIR:ro" \
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

# What a sandbox would see (including an allowed-name passing control), tried from a container of the worker image on the inner network with the gateway as its only name server: (1) the gateway answers, and a registry name is NXDOMAIN (a dead gateway times out, a gateway
# without its deny list answers); (2) a connection to a public address by number has no route. Both must hold or the boot fails.
readonly SE_PROBE='
const dns = require("dns"), net = require("net");
// Use getaddrinfo, like git/npm/pip, so a broken or missing mounted resolver fails boot.
const resolver = { resolve4: (name) => dns.promises.lookup(name, { family: 4 }) };
const done = (ok, why) => { console.log(JSON.stringify({ ok, why })); process.exit(ok ? 0 : 1); };
dns.promises.lookup("registry.npmjs.org", { family: 4 }).then((answer) => {
  if (answer.address !== process.argv[1]) return done(false, "an allowed name did not resolve to the gateway");
  resolver.resolve4("ghcr.io").then(() => done(false, "a registry name resolved"), (error) => {
  if (error.code !== "ENOTFOUND") return done(false, "the gateway did not answer: " + error.code);
  const socket = net.connect({ host: "1.1.1.1", port: 443, timeout: 4000 });
  socket.on("connect", () => done(false, "a raw address was reachable"));
  socket.on("timeout", () => done(true, "no route"));
  // Only a real no-route answer counts: a refusal (ECONNREFUSED) means something on that network answered.
  socket.on("error", (e) => (e.code === "ENETUNREACH" || e.code === "EHOSTUNREACH") ? done(true, "no route") : done(false, "unexpected: " + e.code));
  });
}, (error) => done(false, "the allowed-name control did not resolve: " + error.code));'
se_probe() {
  local directory status
  directory=$(mktemp -d "$SE_ALLOW_DIR/probe-XXXXXXXXXXXX") || return 1
  if ! printf 'nameserver %s\noptions ndots:0 timeout:3 attempts:1\n' "$SE_INNER_IP" >"$directory/resolv.conf" || ! chmod 0644 "$directory/resolv.conf"; then
    rm -f "$directory/resolv.conf"; rmdir "$directory"; return 1
  fi
  timeout --foreground --kill-after=10s "$(try_seconds 60)s" docker run --rm --network "$SE_INNER_NET" --mount "type=bind,src=$directory/resolv.conf,dst=/etc/resolv.conf,readonly" --read-only --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 \
    --entrypoint "$SE_NODE" "$AGENTX_WORKER_IMAGE" -e "$SE_PROBE" "$SE_INNER_IP" >/dev/null
  status=$?
  rm -f "$directory/resolv.conf"; rmdir "$directory"
  return "$status"
}

# The daemon proxy, asked from the HOST (as the daemon asks it): it must answer, and refuse a raw address, an S3 bucket and a port other than 443 (all refused before any name is looked up, so this needs no network). A dead proxy fails the connect.
se_proxy_ask() {
  local reply
  exec 3<>"/dev/tcp/$SE_OUTER_IP/$SE_PROXY_PORT" || return 1
  printf 'CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n' "$1" "$1" >&3
  IFS= read -r -t 10 reply <&3 || { exec 3<&- 3>&-; return 1; }
  exec 3<&- 3>&-
  printf '%s' "$reply"
}
se_proxy_probe() {
  local target reply
  for target in 1.1.1.1:443 probe-bucket.s3.us-west-2.amazonaws.com:443 registry-1.docker.io:22; do
    reply=$(se_proxy_ask "$target") || return 1
    [[ "$reply" == "HTTP/1.1 403"* ]] || return 1
  done
}

# After a reboot or a Docker restart: the walls and the gateway again, before the worker starts. Any miss exits non-zero, and the worker (which Requires this unit) does not start.
se_install_restore_unit() {
  { printf 'readonly SE_GATEWAY=%s SE_INNER_NET=%s SE_OUTER_NET=%s SE_INNER_IP=%s\n' "$SE_GATEWAY" "$SE_INNER_NET" "$SE_OUTER_NET" "$SE_INNER_IP"
    declare -f se_rule se_task_bridge se_walls se_gateway_running se_daemon_dns_is se_dropin_is se_allow_dir se_network_is se_port_isolation se_container_port_index se_restore_ports
    printf 'readonly SE_DAEMON_JSON=%s SE_TASK_NETWORK=%s SE_ALLOW_DIR=%s SE_DROPIN=%s\n' "$SE_DAEMON_JSON" "$SE_TASK_NETWORK" "$SE_ALLOW_DIR" "$SE_DROPIN"
    printf 'SE_DROPIN_WANT=%q\n' "$SE_DROPIN_WANT"
    printf 'se_daemon_dns_is || exit 1\n'
    printf 'se_dropin_is || exit 1\n'
    printf 'readonly SE_INNER_BRIDGE=%s SE_INNER_SUBNET=%s SE_OUTER_BRIDGE=%s SE_OUTER_SUBNET=%s\n' "$SE_INNER_BRIDGE" "$SE_INNER_SUBNET" "$SE_OUTER_BRIDGE" "$SE_OUTER_SUBNET"
    printf 'se_network_is "$SE_INNER_NET" true true "$SE_INNER_BRIDGE" "$SE_INNER_SUBNET" || exit 1\n'
    printf 'se_network_is "$SE_OUTER_NET" false "" "$SE_OUTER_BRIDGE" "$SE_OUTER_SUBNET" || exit 1\n'
    printf 'se_walls || exit 1\nse_allow_dir || exit 1\n'
    printf 'se_gateway_running || { docker start "$SE_GATEWAY" >/dev/null 2>&1; sleep 3; }\n'
    printf 'se_gateway_running || exit 1\nse_restore_ports || exit 1\n'
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
  SE_DROPIN_WANT=$(se_dropin_text) || fail "could not work out the Docker daemon's proxy settings (no region in the worker's environment)"
  se_daemon_config || fail "could not make the sandbox egress gateway the Docker daemon's default name server and proxy (${SE_FAILED_STEP:-no step reported})"
  BOOT_STEP="give the worker the host's resolvers"
  se_worker_dns || fail "could not give the worker container the host's name servers"
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
  se_restore_ports || fail "could not set and verify sandbox bridge port isolation"
  se_probe || fail "the sandbox egress gateway did not pass its checks (a registry name must be refused and a raw address unreachable from a sandbox)"
  BOOT_STEP="check the Docker daemon proxy"
  se_proxy_probe || fail "the sandbox egress gateway's daemon proxy did not answer, or did not refuse a raw address, an S3 bucket and a port other than 443"
  BOOT_STEP="hand the worker its sandbox network"
  printf 'AGENTX_SANDBOX_EGRESS=gateway\nAGENTX_SANDBOX_NETWORK=%s\nAGENTX_SANDBOX_DNS=%s\nAGENTX_DAEMON_PROXY=http://%s:%s\n' "$SE_INNER_NET" "$SE_INNER_IP" "$SE_OUTER_IP" "$SE_PROXY_PORT" >>"$WORKER_ENV_FILE" || fail "could not write the worker's sandbox network settings"
  se_install_restore_unit || fail "could not install the sandbox egress restore unit"
  log "sandbox egress: gateway on $SE_INNER_NET ($SE_INNER_IP); sandboxes and dev containers have no other way out"
}
