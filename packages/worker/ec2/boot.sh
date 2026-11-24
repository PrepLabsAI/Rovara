#!/bin/bash
set -euo pipefail

readonly MOUNT_PATH=/mnt/workspace
readonly RUNTIME_SOURCE=$MOUNT_PATH/.agentx-runtime
readonly RUNTIME_ROOT=/mnt/agentx-runtime
readonly CANDIDATE_SCRATCH_ROOT=$RUNTIME_ROOT/candidates
readonly EVIDENCE_ROOT=$RUNTIME_ROOT/evidence
readonly CONTAINED_STATE_ROOT=$RUNTIME_ROOT/state
readonly CONTAINED_TMP_ROOT=$RUNTIME_ROOT/tmp
readonly CONTAINED_IMAGE=node@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9
CONTAINED_RUNTIME_AVAILABLE_BOOT=false
readonly FILESYSTEM_LABEL=agentx-workspace
readonly WORKER_UID=1000
readonly WORKER_GID=1000
readonly WORKER_ENV_FILE=/etc/agentx/worker.env
readonly WORKER_UNIT=agentx-worker.service
readonly WORKER_CONTAINER=agentx-worker
readonly DOCKER_DATA_ROOT=$MOUNT_PATH/.docker
readonly DOCKER_SOCKET=/var/run/docker.sock
readonly DEVICE_WAIT_SECONDS=${AGENTX_DEVICE_WAIT_SECONDS:-120}
readonly HOST_ROOT=${AGENTX_HOST_ROOT:-}
readonly RETRY_ATTEMPTS=5
readonly RETRY_BASE_SECONDS=2
readonly RETRY_MAX_SECONDS=30
readonly BOOT_DEADLINE=$((SECONDS + ${AGENTX_BOOT_DEADLINE_SECONDS:-480}))
readonly WORKER_PORT=8080
readonly FAILURE_FILE=/run/agentx-boot-failure

log() { printf 'agentx-boot: %s\n' "$*" >&2; }
fail() {
  log "FAILED: $*"
  printf '%s\n' "$*" >"$FAILURE_FILE" || true
  exit 1
}

try_seconds() {
  local remaining=$((BOOT_DEADLINE - SECONDS))
  ((remaining > 1)) || remaining=1
  printf '%s\n' $(($1 < remaining ? $1 : remaining))
}

tries() { if (($1 == 1)); then printf '1 try'; else printf '%s tries' "$1"; fi; }

retry() {
  local description=$1 attempt=1 delay wait
  shift
  until "$@"; do
    ((attempt < RETRY_ATTEMPTS)) || fail "$description after $(tries "$attempt")"
    delay=$((RETRY_BASE_SECONDS << (attempt - 1)))
    ((delay <= RETRY_MAX_SECONDS)) || delay=$RETRY_MAX_SECONDS
    wait=$((delay + RANDOM % (delay / 2 + 1)))
    ((SECONDS + wait < BOOT_DEADLINE)) || fail "$description after $(tries "$attempt"), out of time"
    log "$description (try $attempt of $RETRY_ATTEMPTS); retrying in ${wait}s"
    sleep "$wait"
    attempt=$((attempt + 1))
  done
}

report_boot_failure() {
  systemd-run --unit=agentx-boot-failure --collect --property=Type=notify python3 -c '
import http.server, json, os, socket, sys
try:
    reason = open(sys.argv[2]).read().strip()
except OSError:
    reason = ""
body = json.dumps({"status": "BootFailed", "reason": reason[:300] or "the boot failed without a reason"}, separators=(",", ":")).encode()
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(503 if self.path == "/ping" else 404)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *args):
        pass
server = http.server.ThreadingHTTPServer(("0.0.0.0", int(sys.argv[1])), Handler)
notify = os.environ.get("NOTIFY_SOCKET", "")
if notify:
    ready = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
    ready.connect("\0" + notify[1:] if notify.startswith("@") else notify)
    ready.sendall(b"READY=1")
    ready.close()
server.serve_forever()
' "$WORKER_PORT" "$FAILURE_FILE" >/dev/null 2>&1 || log "could not start the boot failure report on port $WORKER_PORT"
}

BOOT_STEP="start"
on_exit() {
  local status=$? reason
  ((status != 0)) || return 0
  reason=$(cat "$FAILURE_FILE" 2>/dev/null || true)
  if [[ -z "$reason" ]]; then
    reason="the boot stopped while trying to $BOOT_STEP (exit status $status)"
    log "FAILED: $reason"
    printf '%s\n' "$reason" >"$FAILURE_FILE" || true
  fi
  report_boot_failure
}
rm -f "$FAILURE_FILE"
trap on_exit EXIT

require_configuration() {
  local name
  for name in AGENTX_WORKSPACE_ID AGENTX_SESSION_GENERATION AGENTX_VOLUME_ID AGENTX_EXPECT_NEW_VOLUME \
    AGENTX_WORKER_IMAGE AGENTX_INVOKE_PUBLIC_KEY AGENTX_CONTROL_PLANE_URL AGENTX_MODEL_PROVIDER \
    AGENTX_MODEL_ID PI_CACHE_RETENTION AGENTX_LOG_GROUP; do
    [[ -n "${!name:-}" ]] || fail "$name is not set"
  done
  [[ "$AGENTX_WORKER_IMAGE" =~ ^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$ ]] || fail "worker image must be pinned by ECR digest"
  [[ "$AGENTX_EXPECT_NEW_VOLUME" == true || "$AGENTX_EXPECT_NEW_VOLUME" == false ]] \
    || fail "AGENTX_EXPECT_NEW_VOLUME must be true or false"
}

imds_once() {
  local token value
  token=$(curl -fsS --connect-timeout 2 --max-time 5 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 300') \
    && value=$(curl -fsS --connect-timeout 2 --max-time 5 -H "X-aws-ec2-metadata-token: $token" "http://169.254.169.254/latest/meta-data/$1") \
    && printf '%s\n' "$value"
}

imds() { retry "could not read the instance's $1 from instance metadata" imds_once "$1"; }

sysfs_disks() {
  local file name
  for file in "$HOST_ROOT"/sys/block/nvme*/device/serial; do
    [[ -e "$file" ]] || continue
    name=${file%/device/serial}
    printf '%s %s\n' "${name##*/}" "$(tr -d '[:space:]' <"$file")"
  done
}

volume_device() {
  local serial=${AGENTX_VOLUME_ID//-/} device
  for device in $({ lsblk -dno NAME,SERIAL; sysfs_disks; } 2>/dev/null | awk -v s="$serial" '$2 == s { print "/dev/" $1 }') \
    "$(readlink -f "$HOST_ROOT/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_$serial")"; do
    if [[ -b "$device" ]]; then printf '%s\n' "$device"; return; fi
  done
}

wait_for_device() {
  local start=$SECONDS waited=0 tries=0 rescans=0 device line
  until device=$(volume_device) && [[ -n "$device" ]]; do
    ((waited >= SECONDS - start)) || waited=$((SECONDS - start))
    if ((waited >= DEVICE_WAIT_SECONDS)); then
      lsblk -dno NAME,SERIAL,MODEL 2>&1 | while read -r line; do log "lsblk saw: $line"; done || true
      sysfs_disks | while read -r line; do log "sysfs saw: $line"; done || true
      fail "workspace disk $AGENTX_VOLUME_ID is attached in AWS but did not appear on this machine after ${waited}s (rescanned $rescans times)"
    elif ((tries < 3 && waited >= 20 + 30 * tries)); then
      tries=$((tries + 1))
      log "workspace disk $AGENTX_VOLUME_ID has not appeared after ${waited}s; rescanning the PCI bus ($tries of 3)"
      if echo 1 >"$HOST_ROOT/sys/bus/pci/rescan"; then rescans=$((rescans + 1)); else log "could not rescan the PCI bus"; fi
      timeout 15 udevadm settle --timeout=10 || true
    else
      sleep 2
      waited=$((waited + 2))
    fi
  done
  printf '%s\n' "$device"
}

prepare_filesystem() {
  local device=$1 signatures type
  signatures=$(blkid --probe --output export "$device" || true)
  type=$(sed -n 's/^TYPE=//p' <<<"$signatures")
  if [[ -z "$signatures" ]]; then
    [[ "$AGENTX_EXPECT_NEW_VOLUME" == true ]] \
      || fail "volume $AGENTX_VOLUME_ID should hold a workspace but has no filesystem; refusing to format it"
    log "formatting new volume $AGENTX_VOLUME_ID ($device) as ext4"
    mkfs.ext4 -q -L "$FILESYSTEM_LABEL" "$device"
  elif [[ "$type" != ext4 ]]; then
    fail "volume $AGENTX_VOLUME_ID has an unexpected signature (${type:-no filesystem type}); refusing to mount it"
  else
    log "volume $AGENTX_VOLUME_ID ($device) already has an ext4 filesystem"
  fi
}

mount_workspace() {
  local device=$1 uuid
  uuid=$(blkid --probe --output value --match-tag UUID "$device")
  [[ -n "$uuid" ]] || fail "volume $AGENTX_VOLUME_ID has no filesystem UUID"
  mkdir -p "$MOUNT_PATH"
  sed -i "\\#[[:space:]]${MOUNT_PATH}[[:space:]]#d" /etc/fstab
  printf 'UUID=%s %s ext4 defaults,noatime,nofail 0 2\n' "$uuid" "$MOUNT_PATH" >>/etc/fstab
  mountpoint -q "$MOUNT_PATH" || mount "$MOUNT_PATH"
  chown "$WORKER_UID:$WORKER_GID" "$MOUNT_PATH"
  log "mounted $AGENTX_VOLUME_ID at $MOUNT_PATH"
}

readonly CLOSE_HELPER_SHA256=35eee60fc2ac9de8976bcdfca1554272a1431640c4a1e57f4bedb0d4c9fae82c
readonly HOST_RUN=/run/agentx-close-retention-host
readonly RESTORE_UNIT=agentx-close-retention-restore.service
quiesce_workspace_containers() {
  local running
  running=$(docker ps --quiet) || fail "could not quiesce old worker"
  [[ -z "$running" ]] || timeout "$(try_seconds 60)" docker stop --time 10 $running || fail "could not quiesce old worker"
}
initialize_close_retention() {
  umask 077
  local helper_tmp
  quiesce_workspace_containers
  python3 - "$HOST_RUN" <<'HOST'
import os,stat,sys
p=sys.argv[1]
for q in ('/run',p):
    if not os.path.lexists(q): os.mkdir(q,0o700)
    s=os.lstat(q)
    if not stat.S_ISDIR(s.st_mode) or s.st_uid!=0 or s.st_gid!=0 or s.st_mode&0o022: raise ValueError('untrusted host runtime')
if stat.S_IMODE(os.lstat(p).st_mode)!=0o700: raise ValueError('host runtime mode')
HOST
  if ! mountpoint -q "$HOST_RUN"; then mount -t tmpfs -o nodev,nosuid,mode=0700,uid=0,gid=0 tmpfs "$HOST_RUN"; fi
  [[ $(findmnt -n -o FSTYPE,TARGET --target "$HOST_RUN") == "tmpfs $HOST_RUN" ]] || fail "untrusted host runtime mount"
  local opts
  opts=$(findmnt -n -o OPTIONS --target "$HOST_RUN")
  [[ ",$opts," == *,nodev,* && ",$opts," == *,nosuid,* && $(stat -c %u:%g:%a "$HOST_RUN") == 0:0:700 ]] || fail "unsafe host runtime mount"
  helper_tmp=$(mktemp "$HOST_RUN/helper.XXXXXX")
  if ! timeout "$(try_seconds 60)" docker run --rm --pull=never --network none --read-only --cap-drop ALL --security-opt no-new-privileges --entrypoint /bin/cat "$AGENTX_WORKER_IMAGE" /opt/agentx/packages/worker/ec2/close-retention.sh >"$helper_tmp"; then
    rm -f "$helper_tmp"; fail "retention helper extraction failed"
  fi
  if ! python3 - "$helper_tmp" "$CLOSE_HELPER_SHA256" <<'CHECK'
import hashlib,os,stat,sys
fd=os.open(sys.argv[1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
with os.fdopen(fd,'rb') as f:
    s=os.fstat(f.fileno()); b=f.read(262145)
    if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1 or (s.st_uid,s.st_gid,stat.S_IMODE(s.st_mode))!=(0,0,0o600) or not 0<len(b)<=262144 or hashlib.sha256(b).hexdigest()!=sys.argv[2]: raise ValueError('helper provenance mismatch')
CHECK
  then rm -f "$helper_tmp"; fail "retention helper provenance failed"; fi
  chmod 0500 "$helper_tmp"; mv -fT "$helper_tmp" "$HOST_RUN/helper.sh"
  /bin/bash "$HOST_RUN/helper.sh" install "$AGENTX_WORKSPACE_ID" "$AGENTX_SESSION_GENERATION" "$1" "$AGENTX_VOLUME_ID" || fail "retained layout requires explicit recovery"
}

runtime_unavailable() { log "verifier unavailable; setup smoke withheld"; }

prepare_contained_runtime_directories() {
  local path
  [[ ! -L "$RUNTIME_SOURCE" ]] || { runtime_unavailable; return 0; }
  if [[ ! -e "$RUNTIME_SOURCE" ]]; then
    [[ "$AGENTX_EXPECT_NEW_VOLUME" == true ]] || { runtime_unavailable; return 0; }
    install -d -o root -g root -m 0755 "$RUNTIME_SOURCE"
    for path in candidates evidence state tmp; do
      install -d -o "$WORKER_UID" -g "$WORKER_GID" -m 0700 "$RUNTIME_SOURCE/$path"
    done
  fi
  [[ -d "$RUNTIME_SOURCE" && $(stat -c %u:%g:%a "$RUNTIME_SOURCE") == 0:0:755 ]] || { runtime_unavailable; return 0; }
  for path in candidates evidence state tmp; do
    [[ -d "$RUNTIME_SOURCE/$path" && ! -L "$RUNTIME_SOURCE/$path" && $(stat -c %u:%g:%a "$RUNTIME_SOURCE/$path") == "$WORKER_UID:$WORKER_GID:700" ]] || { runtime_unavailable; return 0; }
  done
  [[ ! -L "$RUNTIME_ROOT" ]] || { runtime_unavailable; return 0; }
  install -d -o root -g root -m 0755 "$RUNTIME_ROOT"
  mount --bind "$RUNTIME_SOURCE" "$RUNTIME_ROOT" && mountpoint -q "$RUNTIME_ROOT" || { runtime_unavailable; return 0; }
  CONTAINED_RUNTIME_AVAILABLE_BOOT=true
}

install_docker_package() {
  timeout "$(try_seconds 120)" dnf install -y docker && return 0
  dnf clean metadata >/dev/null 2>&1 || true
  return 1
}

ensure_docker() {
  [ -f /etc/dnf/dnf.conf ] && { grep -q ^exclude= /etc/dnf/dnf.conf || echo 'exclude=kernel*' >>/etc/dnf/dnf.conf; }
  command -v docker >/dev/null || retry "could not install Docker: package download failed" install_docker_package
  install -d -m 0755 /etc/docker
  printf '{"data-root": "%s"}\n' "$DOCKER_DATA_ROOT" >/etc/docker/daemon.json
  systemctl enable docker.service
  systemctl restart docker.service
  wall_off_containers
}

# Untrusted containers (rvb*, rvi*) cannot reach IMDS, the host or private ranges; only VPC DNS stays open.
readonly FIREWALL_UNIT=rovara-container-firewall.service
wall_off_containers() {
  install -d -o root -g root -m 0755 /usr/local/libexec
  cat >/usr/local/libexec/rovara-container-firewall <<'FIREWALL'
set -e
f() { local c=$1; shift; $c -C "$@" 2>/dev/null || $c -I "$@"; }
for d in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 127.0.0.0/8; do f iptables DOCKER-USER -i rvb+ -d $d -j DROP; done
f iptables DOCKER-USER -i rvi+ ! -o rvi+ -j DROP
for r in $(awk '$1=="nameserver"&&$2~/^[0-9.]+$/{print $2}' /etc/resolv.conf /run/systemd/resolve/resolv.conf 2>/dev/null); do
  for p in udp tcp; do f iptables DOCKER-USER -i rvb+ -d $r -p $p --dport 53 -j RETURN; done
done
# Setup DNS rules precede rvb+; failed setup removes all five.
S=("-i rvbs+ -o rvbs+ -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN" "-i rvbs+ -o rvbs+ -m physdev --physdev-is-bridged -d 172.29.0.0/16 -p udp --dport 53 -j RETURN" "-i rvbs+ -o rvbs+ -m physdev --physdev-is-bridged -d 172.29.0.0/16 -p tcp --dport 53 -j RETURN" "-i rvbs+ -s 172.29.0.3/255.255.0.255 -p udp --dport 53 ! -o rvbs+ -j DROP" "-i rvbs+ -s 172.29.0.3/255.255.0.255 -p tcp --dport 53 ! -o rvbs+ -j DROP")
x() { for r in "${S[@]}"; do while iptables -C DOCKER-USER $r 2>/dev/null; do iptables -D DOCKER-USER $r || return; done; done; }
y() {
  modprobe -a br_netfilter xt_conntrack xt_physdev 2>/dev/null
  [[ -e ${BRIDGE_NF:-/proc/sys/net/bridge/bridge-nf-call-iptables} ]] || return
  n=0; for r in "${S[@]}"; do iptables -C DOCKER-USER $r 2>/dev/null && ((n++)); done
  ((n == 5)) && iptables -S DOCKER-USER | awk '/ -i rvb\+ /{b=1} / -i rvbs\+ /&&b{x=1} END{exit x}' && return
  x || return
  for i in 4 3 2 1 0; do iptables -I DOCKER-USER ${S[i]} || return; done
}
F=${SETUP_ISOLATION_FILE:-/etc/agentx/setup-isolation}; s=unavailable
if y; then s=ready; else x || :; fi
install -d -m 0700 "${F%/*}" && echo $s >"$F.t" && chmod 0644 "$F.t" && mv -f "$F.t" "$F" || rm -f "$F"
echo "setup isolation: $s" >&2
f iptables DOCKER-USER -d 169.254.169.254/32 -j DROP
for i in rvb+ rvi+; do f iptables INPUT -i $i -j DROP; ! command -v ip6tables >/dev/null || f ip6tables INPUT -i $i -j DROP || echo "ip6tables $i rule failed" >&2; done
FIREWALL
  cat >"/etc/systemd/system/$FIREWALL_UNIT" <<EOF
[Unit]
Description=Wall untrusted containers off from the host and private networks
Requires=docker.service
After=docker.service network-online.target systemd-resolved.service
Wants=network-online.target
Before=$WORKER_UNIT
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash /usr/local/libexec/rovara-container-firewall
[Install]
WantedBy=multi-user.target
EOF
  systemctl enable "$FIREWALL_UNIT" && bash /usr/local/libexec/rovara-container-firewall || fail "could not wall containers off from the host and private networks"
}

# Pipe the registry password.
registry_login() {
  timeout "$(try_seconds 60)" aws ecr get-login-password --region "$1" \
    | timeout "$(try_seconds 60)" docker login --username AWS --password-stdin "$2"
}

pull_image_once() { timeout "$(try_seconds 300)" docker pull "$1"; }

pull_worker_image() {
  local region=$1 registry=${AGENTX_WORKER_IMAGE%%/*}
  retry "could not log in to the worker image registry" registry_login "$region" "$registry"
  retry "could not download the worker image" pull_image_once "$AGENTX_WORKER_IMAGE"
  docker image inspect --format '{{json .RepoDigests}}' "$AGENTX_WORKER_IMAGE" | python3 -c 'import json,sys; v=json.load(sys.stdin); sys.exit(0 if type(v) is list and all(type(x) is str for x in v) and sys.argv[1] in v else 1)' "$AGENTX_WORKER_IMAGE" || fail "worker image digest mismatch"
}

pull_contained_image() {
  local attempt
  for ((attempt=1; attempt<=RETRY_ATTEMPTS && SECONDS<BOOT_DEADLINE; attempt++)); do
    timeout "$(try_seconds 300)" docker pull "$CONTAINED_IMAGE" && return 0
    ((attempt<RETRY_ATTEMPTS && SECONDS<BOOT_DEADLINE)) && sleep "$((1 << (attempt - 1)))"
  done
  log "optional verifier image unavailable; worker continues"
  return 1
}

pull_executor_image() {
  [[ -n "${EXECUTOR_IMAGE:-}" ]] || return 0
  local attempt
  for ((attempt=1; attempt<=RETRY_ATTEMPTS && SECONDS<BOOT_DEADLINE; attempt++)); do
    timeout "$(try_seconds 300)" docker pull "$EXECUTOR_IMAGE" && return 0
    ((attempt<RETRY_ATTEMPTS && SECONDS<BOOT_DEADLINE)) && sleep "$((1 << (attempt - 1)))"
  done
  log "optional executor image unavailable; worker continues"
  return 1
}

# Root-only environment.
write_worker_environment() {
  local region=$1
  install -d -m 0700 "$(dirname "$WORKER_ENV_FILE")"
  install -m 0600 /dev/null "$WORKER_ENV_FILE"
  cat >"$WORKER_ENV_FILE" <<EOF
AWS_REGION=$region
AGENTX_WORKSPACE_ROOT=$MOUNT_PATH
AGENTX_CONTROL_PLANE_URL=$AGENTX_CONTROL_PLANE_URL
AGENTX_MODEL_PROVIDER=$AGENTX_MODEL_PROVIDER
AGENTX_MODEL_ID=$AGENTX_MODEL_ID
AGENTX_OPENROUTER_SECRET_ARN=${AGENTX_OPENROUTER_SECRET_ARN:-}
AGENTX_OPENROUTER_PROVIDERS=${AGENTX_OPENROUTER_PROVIDERS:-}
AGENTX_ANTHROPIC_SECRET_ARN=${AGENTX_ANTHROPIC_SECRET_ARN:-}
AGENTX_OPENAI_SECRET_ARN=${AGENTX_OPENAI_SECRET_ARN:-}
AGENTX_MODEL_FALLBACK=${AGENTX_MODEL_FALLBACK:-}
PI_CACHE_RETENTION=$PI_CACHE_RETENTION
AGENTX_INVOKE_PUBLIC_KEY=$AGENTX_INVOKE_PUBLIC_KEY
AGENTX_WORKSPACE_ID=$AGENTX_WORKSPACE_ID
AGENTX_SESSION_GENERATION=$AGENTX_SESSION_GENERATION
AGENTX_SANDBOX_IMAGE=$AGENTX_WORKER_IMAGE
AGENTX_RUNTIME=ec2
EOF

  printf 'TMPDIR=/tmp\n' >>"$WORKER_ENV_FILE"
  [[ -z "${AGENTX_SAVED_ENV_BUILDER_IMAGE:-}" ]] || printf 'AGENTX_SAVED_ENV_BUILDER_IMAGE=%s\n' "$AGENTX_SAVED_ENV_BUILDER_IMAGE" >>"$WORKER_ENV_FILE"
  [[ -z "${EXECUTOR_IMAGE:-}" ]] || printf 'EXECUTOR_IMAGE=%s\n' "$EXECUTOR_IMAGE" >>"$WORKER_ENV_FILE"
}

write_worker_launcher() {
  local docker=$1 instance_id=$2
  install -d -m 0700 /etc/agentx
  install -d -o root -g root -m 0755 /usr/local/libexec
  printf '%s\n' "$AGENTX_WORKER_IMAGE" >/etc/agentx/worker-image
  chmod 0600 /etc/agentx/worker-image
  printf '%s\n' "$docker" >/etc/agentx/docker-path
  chmod 0600 /etc/agentx/docker-path
  cat >/usr/local/libexec/agentx-worker-start <<'LAUNCHER'
#!/bin/bash
set -u
readonly MOUNT_PATH=/mnt/workspace
readonly RUNTIME_SOURCE=/mnt/workspace/.agentx-runtime
readonly RUNTIME_ROOT=/mnt/agentx-runtime
readonly WORKER_ENV_FILE=/etc/agentx/worker.env
readonly WORKER_CONTAINER=agentx-worker
readonly DOCKER_SOCKET=/var/run/docker.sock
readonly WORKER_UID=1000
readonly WORKER_GID=1000
log() { printf 'agentx-worker-start: %s\n' "$*" >&2; }
docker=$(cat /etc/agentx/docker-path 2>/dev/null || true)
worker_image=$(cat /etc/agentx/worker-image 2>/dev/null || true)
[[ "$docker" == /* && -x "$docker" ]] || { log 'Docker CLI unavailable'; exit 1; }
[[ "$worker_image" =~ ^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$ ]] || { log 'worker image identity is invalid'; exit 1; }
docker_gid=$(stat -c %g "$DOCKER_SOCKET") || { log 'Docker socket unavailable'; exit 1; }
runtime_ready=false
if [[ -d "$RUNTIME_SOURCE" && ! -L "$RUNTIME_SOURCE" && $(stat -c %u:%g:%a "$RUNTIME_SOURCE" 2>/dev/null) == 0:0:755 ]]; then
  runtime_children_valid=true
  for path in candidates evidence state tmp; do
    child="$RUNTIME_SOURCE/$path"
    if [[ ! -d "$child" || -L "$child" || $(stat -c %u:%g:%a "$child" 2>/dev/null) != 1000:1000:700 ]]; then
      runtime_children_valid=false
      break
    fi
  done
  if [[ "$runtime_children_valid" == true && ! -L "$RUNTIME_ROOT" ]]; then
    if [[ ! -e "$RUNTIME_ROOT" ]]; then install -d -o root -g root -m 0755 "$RUNTIME_ROOT" 2>/dev/null || true; fi
    if [[ -d "$RUNTIME_ROOT" && $(stat -c %u:%g:%a "$RUNTIME_ROOT" 2>/dev/null) == 0:0:755 ]]; then
      if mountpoint -q "$RUNTIME_ROOT"; then
        source_id=$(stat -c %d:%i "$RUNTIME_SOURCE" 2>/dev/null || true)
        active_id=$(stat -c %d:%i "$RUNTIME_ROOT" 2>/dev/null || true)
        [[ -n "$source_id" && "$source_id" == "$active_id" ]] && runtime_ready=true
      elif mount --bind "$RUNTIME_SOURCE" "$RUNTIME_ROOT" 2>/dev/null && mountpoint -q "$RUNTIME_ROOT"; then
        source_id=$(stat -c %d:%i "$RUNTIME_SOURCE" 2>/dev/null || true)
        active_id=$(stat -c %d:%i "$RUNTIME_ROOT" 2>/dev/null || true)
        [[ -n "$source_id" && "$source_id" == "$active_id" ]] && runtime_ready=true
      fi
    fi
  fi
fi
args=(run --rm --name "$WORKER_CONTAINER" --network host --env-file "$WORKER_ENV_FILE")
f=/run/agentx-close-retention-host/worker-mounts
[[ ! -L ${f%/*} && $(stat -c %u:%g:%a "${f%/*}") == 0:0:700 && -f "$f" && ! -L "$f" && $(stat -c %u:%g:%a:%h "$f") == 0:0:444:1 ]] || exit 1
. "$f" || exit 1
if [[ "$runtime_ready" == true ]]; then
  args+=(--volume "$RUNTIME_ROOT:$RUNTIME_ROOT" --env CONTAINED_FOUNDATION_EVIDENCE_DIR="$RUNTIME_ROOT/evidence" --env TMPDIR="$RUNTIME_ROOT/tmp")
else
  log 'verifier unavailable; worker continues with /tmp'
  args+=(--env TMPDIR=/tmp)
fi
t=/run/agentx-test-services; ! mountpoint -q $t || args+=(--volume $t:$t --env AGENTX_TEST_SERVICES_RUN_DIR=$t)
t=/var/lib/rovara-egress; [[ ! -d $t ]] || args+=(--volume $t:$t)
# Use the host resolvers for the host-network worker; keep the image last.
while read -r r; do args+=(--dns "$r"); done < <(cat /etc/agentx/worker-dns 2>/dev/null)
f=/etc/agentx/setup-isolation; [[ -f $f && ! -L $f && $(stat -c %u:%a $f) == 0:644 && $(<$f) == ready ]] && s=ready || s=unavailable
args+=(--env AGENTX_SETUP_ISOLATION=$s)
args+=(--volume "$DOCKER_SOCKET:$DOCKER_SOCKET" --group-add "$docker_gid" --log-driver awslogs --log-opt awslogs-region="$(sed -n 's/^AWS_REGION=//p' "$WORKER_ENV_FILE")" --log-opt awslogs-group="$(cat /etc/agentx/log-group)" --log-opt awslogs-stream="$(sed -n 's/^AGENTX_WORKSPACE_ID=//p' "$WORKER_ENV_FILE")/$(sed -n 's/^AGENTX_SESSION_GENERATION=//p' "$WORKER_ENV_FILE")/$(cat /etc/agentx/instance-id)" "$worker_image")
exec "$docker" "${args[@]}"
LAUNCHER
  chmod 0755 /usr/local/libexec/agentx-worker-start
  printf '%s\n' "$AGENTX_LOG_GROUP" >/etc/agentx/log-group
  printf '%s\n' "$instance_id" >/etc/agentx/instance-id
  chmod 0600 /etc/agentx/log-group /etc/agentx/instance-id
}

write_worker_unit() {
  local region=$1 instance_id=$2 docker
  docker=$(command -v docker)
  write_worker_launcher "$docker" "$instance_id"
  {
    printf '#!/bin/bash\nset -euo pipefail\nreadonly HOST_RUN=%q CLOSE_HELPER_SHA256=%q\nBOOT_DEADLINE=$((SECONDS+480))\n' "$HOST_RUN" "$CLOSE_HELPER_SHA256"
    printf 'AGENTX_WORKER_IMAGE=%q AGENTX_WORKSPACE_ID=%q AGENTX_SESSION_GENERATION=%q AGENTX_VOLUME_ID=%q\n' "$AGENTX_WORKER_IMAGE" "$AGENTX_WORKSPACE_ID" "$AGENTX_SESSION_GENERATION" "$AGENTX_VOLUME_ID"
    declare -f log fail try_seconds tries retry registry_login pull_image_once pull_worker_image quiesce_workspace_containers initialize_close_retention
    printf 'RETRY_ATTEMPTS=5 RETRY_BASE_SECONDS=2 RETRY_MAX_SECONDS=30 FAILURE_FILE=/run/agentx-boot-failure\npull_worker_image %q\ninitialize_close_retention %q\n' "$region" "$instance_id"
  } >/usr/local/libexec/agentx-retention-restore
  chmod 0700 /usr/local/libexec/agentx-retention-restore
  cat >"/etc/systemd/system/$RESTORE_UNIT" <<EOF
[Unit]
Requires=docker.service
After=docker.service
Before=$WORKER_UNIT ${SE_UNIT:-rovara-sandbox-egress.service} ${TS_UNIT:-rovara-test-services.service}
RequiresMountsFor=$MOUNT_PATH
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash /usr/local/libexec/agentx-retention-restore
EOF
  cat >"/etc/systemd/system/$WORKER_UNIT" <<EOF
[Unit]
Description=AgentX worker for workspace $AGENTX_WORKSPACE_ID generation $AGENTX_SESSION_GENERATION
Requires=docker.service $FIREWALL_UNIT $RESTORE_UNIT
After=docker.service $FIREWALL_UNIT $RESTORE_UNIT network-online.target
Wants=network-online.target
RequiresMountsFor=$MOUNT_PATH

[Service]
ExecStartPre=-$docker rm --force $WORKER_CONTAINER
ExecStart=/usr/local/libexec/agentx-worker-start
ExecStop=$docker stop $WORKER_CONTAINER
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
}

# DEC 254zm: the test-services stage is in the worker image pulled by digest; it never stops the boot.
test_services_stage() {
  local f=/run/agentx-ts-stage.sh
  timeout "$(try_seconds 60)" docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --entrypoint cat "$AGENTX_WORKER_IMAGE" /opt/agentx/packages/worker/ec2/test-services-stage.sh >"$f" && . "$f" && test_services_stage_main "$1"
}

# Digest-image gateway stage; a failure stops boot.
sandbox_egress_stage() {
  local f=/run/agentx-se-stage.sh
  timeout "$(try_seconds 60)" docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --entrypoint cat "$AGENTX_WORKER_IMAGE" /opt/agentx/packages/worker/ec2/sandbox-egress.sh >"$f" && . "$f" && sandbox_egress_main
}

# Qualification runs in its own unit.
write_e2e_qualification_script() {
  install -d -o root -g root -m 0755 /usr/local/libexec
  cat >/usr/local/libexec/agentx-e2e-qualification <<'QUALIFICATION'
set -uo pipefail
umask 077
readonly REGION=${1:-} BUCKET=${2:-} ROLE_ID=${3:-} INSTANCE_ID=${4:-} PROFILE=${5:-} EXECUTOR=${6:-}
readonly EVIDENCE_HOST=${AGENTX_HOST_ROOT:-}/mnt/workspace/.agentx-runtime/evidence
readonly EVIDENCE_CONTAINER=/mnt/agentx-runtime/evidence
readonly CHALLENGE_NAME=runtime-install-challenge.json
readonly PROPOSAL_NAME=runtime-install-proposal.json
readonly FAILURE_NAME=runtime-install-failure.json
readonly CHALLENGE_MAX_BYTES=65536
readonly PROPOSAL_MAX_BYTES=5242880
readonly POLL=${AGENTX_E2E_QUALIFICATION_POLL_SECONDS:-10}
readonly HEALTHY_WAIT=${AGENTX_E2E_QUALIFICATION_HEALTHY_WAIT_SECONDS:-900}
readonly CHALLENGE_WAIT=${AGENTX_E2E_QUALIFICATION_CHALLENGE_WAIT_SECONDS:-1800}
readonly QUALIFY_SECONDS=${AGENTX_E2E_QUALIFICATION_QUALIFY_SECONDS:-2700}
readonly PULL_SECONDS=${AGENTX_E2E_QUALIFICATION_PULL_SECONDS:-300}
log() { printf 'agentx-e2e-qualification: %s\n' "$*" >&2; }
refuse() { log "refused: $1"; exit 2; }
[[ "$ROLE_ID" =~ ^AROA[A-Z0-9]{12,}$ ]] || refuse "the role ID must be the worker role's unique ID (AROA...)"
[[ "$INSTANCE_ID" =~ ^i-[0-9a-f]{8,17}$ ]] || refuse "the instance ID is not valid"
[[ "$EXECUTOR" =~ ^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]] || refuse "the executor image must be an ECR image pinned by digest"
[[ "$PROFILE" == linux-arm64-web-api-v1 ]] || refuse "the profile must be linux-arm64-web-api-v1"
[[ "$BUCKET" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || refuse "the bucket name is not valid"
[[ "$REGION" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]$ ]] || refuse "the region is not valid"
readonly PREFIX="e2e-runtime/$ROLE_ID:$INSTANCE_ID/"
STAGE=$(mktemp -d) || exit 1
readonly STAGE
EXTRA=",\"executorImage\":\"$EXECUTOR\""
upload() { aws s3api put-object --bucket "$BUCKET" --key "$PREFIX$1" --body "$2" --server-side-encryption AES256 --region "$REGION" --no-cli-pager >/dev/null; }
publish_status() {
  printf '{"state":"%s","reason":"%s","finishedAt":"%s"%s}\n' "$1" "$2" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$EXTRA" >"$STAGE/status.json" && upload status.json "$STAGE/status.json"
}
add_failure() {
  local f="$EVIDENCE_HOST/$FAILURE_NAME" c
  [[ -f "$f" ]] || return 0
  c=$(dd if="$f" iflag=nofollow bs=16384 count=1 2>/dev/null | grep -oE '"[a-z0-9-]{1,48}(:[a-z0-9-]{1,48})?"[],}]' | head -n 16 | tr -d '],}' | paste -sd, -)
  EXTRA+=",\"failure\":{\"codes\":[$c]}"
}
fail_with() {
  log "failed: $1"
  publish_status FAILED "$1" || log "could not upload the failure status"
  exit 1
}
deadline=$((SECONDS + HEALTHY_WAIT))
until PING=$(curl -fsS --connect-timeout 2 --max-time 3 http://127.0.0.1:8080/ping 2>/dev/null); do
  ((SECONDS < deadline)) || fail_with worker-not-healthy
  sleep "$POLL"
done
features=$(tr -d ' \n\r\t' <<<"$PING" | grep -oE '"invocationFeatures":\[("[A-Za-z0-9.]+"(,"[A-Za-z0-9.]+")*)?\]' | head -n1) && [[ -n "$features" ]] && EXTRA+=",$features"
if ! docker image inspect "$EXECUTOR" >/dev/null 2>&1; then
  log "the executor image is not on this host; pulling it"
  { timeout --foreground --kill-after=10s "${PULL_SECONDS}s" aws ecr get-login-password --region "$REGION" \
      | timeout --foreground --kill-after=10s "${PULL_SECONDS}s" docker login --username AWS --password-stdin "${EXECUTOR%%/*}" >/dev/null 2>&1 \
      && timeout --foreground --kill-after=10s "${PULL_SECONDS}s" docker pull "$EXECUTOR" >/dev/null 2>&1; } \
    || log "the executor image could not be pulled"
  docker image inspect "$EXECUTOR" >/dev/null 2>&1 || fail_with executor-image-unavailable
fi
printf '{"state":"READY","reason":"worker-healthy","finishedAt":"%s"%s}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$EXTRA" >"$STAGE/ready.json" && upload ready.json "$STAGE/ready.json" || fail_with ready-upload-failed
fetched="$STAGE/challenge.json"
deadline=$((SECONDS + CHALLENGE_WAIT))
until aws s3api get-object --bucket "$BUCKET" --key "${PREFIX}challenge.json" --region "$REGION" --no-cli-pager "$fetched" >/dev/null 2>&1; do
  ((SECONDS < deadline)) || fail_with challenge-unavailable
  sleep "$POLL"
done
size=$(wc -c <"$fetched" | tr -d '[:space:]')
((size > 0 && size <= CHALLENGE_MAX_BYTES)) || fail_with challenge-size-rejected
[[ -d "$EVIDENCE_HOST" && ! -L "$EVIDENCE_HOST" ]] || fail_with evidence-directory-unavailable
chown 1000:1000 "$fetched" && chmod 0600 "$fetched" && mv -fT "$fetched" "$EVIDENCE_HOST/$CHALLENGE_NAME" || fail_with challenge-install-failed
rm -f "$EVIDENCE_HOST/$PROPOSAL_NAME" "$EVIDENCE_HOST/$FAILURE_NAME"
timeout --foreground --kill-after=10s "${QUALIFY_SECONDS}s" docker exec --user node agentx-worker /usr/local/bin/node /opt/agentx/packages/verifier/dist/install-qualification-cli.js --profile "$PROFILE" --challenge-file "$EVIDENCE_CONTAINER/$CHALLENGE_NAME" --evidence-root "$EVIDENCE_CONTAINER" --out "$EVIDENCE_CONTAINER/$PROPOSAL_NAME" --failure-out "$EVIDENCE_CONTAINER/$FAILURE_NAME" >"$STAGE/qualifier.log" 2>&1
status=$?
tail -c 2000 "$STAGE/qualifier.log" | while IFS= read -r line; do log "qualifier: $line"; done
((status == 0)) || { add_failure; fail_with "qualification-failed-exit-$status"; }
proposal="$STAGE/proposal"
dd if="$EVIDENCE_HOST/$PROPOSAL_NAME" iflag=nofollow of="$proposal" bs=1M count=6 2>/dev/null || fail_with proposal-missing
size=$(wc -c <"$proposal" | tr -d '[:space:]')
((size > 0)) || fail_with proposal-missing
((size <= PROPOSAL_MAX_BYTES)) || fail_with proposal-too-large
upload proposal.json "$proposal" || fail_with proposal-upload-failed
publish_status SUCCEEDED qualified || { log "could not upload the success status"; exit 1; }
log "qualified; the proposal and status are under the prefix"
timeout --foreground --kill-after=10s 7d docker exec --user node agentx-worker /usr/local/bin/node /opt/agentx/packages/worker/dist/e2e-model-canary-cli.js --bucket "$BUCKET" --prefix "$PREFIX" 2>&1 | while read l; do log "$l"; done
QUALIFICATION
}

start_e2e_qualification() {
  local region=$1 instance_id=$2
  [[ -n "${AGENTX_E2E_QUALIFICATION_ROLE_ID:-}" && -n "${AGENTX_E2E_QUALIFICATION_PROFILE:-}" ]] || return 0
  write_e2e_qualification_script
  systemd-run --unit=agentx-e2e-qualification --collect --no-block \
    /bin/bash /usr/local/libexec/agentx-e2e-qualification "$region" "${AGENTX_E2E_QUALIFICATION_BUCKET:-}" "$AGENTX_E2E_QUALIFICATION_ROLE_ID" "$instance_id" "$AGENTX_E2E_QUALIFICATION_PROFILE" "${EXECUTOR_IMAGE:-}" \
    >/dev/null 2>&1 || log "could not start the E2E qualification"
}

main() {
  for unit in "$WORKER_UNIT" agentx-close-retention.service "$RESTORE_UNIT" "${SE_UNIT:-rovara-sandbox-egress.service}" "${TS_UNIT:-rovara-test-services.service}"; do
    if systemctl is-active --quiet "$unit"; then systemctl stop "$unit" || fail "could not quiesce old worker"; fi
  done
  BOOT_STEP="read the boot configuration"
  require_configuration
  log "booting workspace $AGENTX_WORKSPACE_ID generation $AGENTX_SESSION_GENERATION"
  local region instance_id device
  BOOT_STEP="read instance metadata"
  region=$(imds placement/region)
  instance_id=$(imds instance-id)
  BOOT_STEP="find the workspace volume"
  device=$(wait_for_device)
  BOOT_STEP="prepare the workspace volume"
  prepare_filesystem "$device"
  mount_workspace "$device"
  prepare_contained_runtime_directories
  BOOT_STEP="set up Docker"
  ensure_docker
  BOOT_STEP="download the worker image"
  pull_worker_image "$region"
  if [[ "$CONTAINED_RUNTIME_AVAILABLE_BOOT" == true ]]; then pull_contained_image || true; fi
  pull_executor_image || true
  BOOT_STEP="start the worker"
  write_worker_environment "$region"
  write_worker_unit "$region" "$instance_id"
  [[ ${AGENTX_TEST_SERVICES:-} != 1 ]] || test_services_stage "$region" || log "no test services on this worker (not fatal)"
  if [[ ${AGENTX_SANDBOX_EGRESS:-} == gateway ]]; then BOOT_STEP="set up the sandbox egress gateway"; sandbox_egress_stage || fail "could not set up the sandbox egress gateway"; fi
  systemctl daemon-reload
  systemctl enable --now "$WORKER_UNIT"
  log "worker started"
  start_e2e_qualification "$region" "$instance_id" || log "the E2E qualification did not start"
}

main "$@"
