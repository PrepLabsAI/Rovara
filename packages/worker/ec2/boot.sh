#!/bin/bash
# Boots an AgentX EC2 worker (issue #81): mounts the workspace volume and runs the worker image.
#
# Runs once, as root, as the instance's user data. The provisioner prepends the configuration with
# ec2WorkerUserData (@agentx/contracts), which validates every value before it reaches this script.
# Steps that use the network retry with exponential backoff (retry). Any failure exits non-zero,
# leaves the worker stopped and reports why on the worker's /ping port (report_boot_failure), so the
# provisioner's health probe fails the session at once (#211); the probe's 10 minute timeout stays
# the backstop for a boot that hangs or cannot report.
set -euo pipefail

readonly MOUNT_PATH=/mnt/workspace
readonly FILESYSTEM_LABEL=agentx-workspace
# The node user of environments/base/Dockerfile, which the worker container runs as.
readonly WORKER_UID=1000
readonly WORKER_GID=1000
readonly WORKER_ENV_FILE=/etc/agentx/worker.env
readonly WORKER_UNIT=agentx-worker.service
readonly WORKER_CONTAINER=agentx-worker
# Docker's data root, on the workspace volume so that a project's devcontainer images, containers
# and named volumes survive an idle stop (#121). The worker's walks skip it (DOCKER_DATA_DIRECTORY).
readonly DOCKER_DATA_ROOT=$MOUNT_PATH/.docker
readonly DOCKER_SOCKET=/var/run/docker.sock
# The provisioner attaches the volume after the instance is running, so it may appear late (#223).
readonly DEVICE_WAIT_SECONDS=${AGENTX_DEVICE_WAIT_SECONDS:-120}
# Where /sys and /dev/disk are read; the tests point it elsewhere.
readonly HOST_ROOT=${AGENTX_HOST_ROOT:-}
# Network steps try 5 times, waiting 2, 4, 8 and 16 seconds (each plus up to half again as jitter,
# at most 30 seconds before jitter): at most 45 seconds of waiting per step.
readonly RETRY_ATTEMPTS=5
readonly RETRY_BASE_SECONDS=2
readonly RETRY_MAX_SECONDS=30
# Every network try has a time limit, and no try runs or waits past this many seconds from the
# start of the boot, so a failure is reported well inside the provisioner's 10 minute /ping window.
readonly BOOT_DEADLINE=$((SECONDS + ${AGENTX_BOOT_DEADLINE_SECONDS:-480}))
# The worker's port, which the provisioner probes; a failed boot answers there instead.
readonly WORKER_PORT=8080
# Where fail records its reason, since it may run in a command substitution's subshell.
readonly FAILURE_FILE=/run/agentx-boot-failure

log() { printf 'agentx-boot: %s\n' "$*" >&2; }
fail() {
  log "FAILED: $*"
  printf '%s\n' "$*" >"$FAILURE_FILE" || true
  exit 1
}

# The time limit for one network try: LIMIT seconds, or less when the boot deadline is closer.
try_seconds() {
  local remaining=$((BOOT_DEADLINE - SECONDS))
  ((remaining > 1)) || remaining=1
  printf '%s\n' $(($1 < remaining ? $1 : remaining))
}

tries() { if (($1 == 1)); then printf '1 try'; else printf '%s tries' "$1"; fi; }

# retry DESCRIPTION COMMAND...: runs COMMAND until it succeeds, up to RETRY_ATTEMPTS times, with
# exponential backoff and jitter; then fails with "DESCRIPTION after N tries". DESCRIPTION is what
# the provisioner shows the user, so it says what could not be done in plain words, never a secret.
# set -e does not apply inside COMMAND (it runs as an until condition), so COMMAND must return its
# own failure: chain with && or a pipeline, as the helpers below do.
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

# Serves the failure on the worker's port: /ping answers 503 with {"status":"BootFailed","reason"}.
# It runs as a transient unit, outside cloud-init's, so it outlives this script; the provisioner
# terminates the instance once it reads the reason. The reason is read from FAILURE_FILE, since
# systemd would expand any $ in an argument. The unit is Type=notify and the server says READY once
# it listens, so systemd-run fails (and the console says so) when it cannot. Best effort: without
# it, the probe's timeout still fails the session.
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

# Reports any non-zero exit: fail's reason, or the step that stopped (set -e) without one.
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
# A reason left by an earlier run of this script in the same boot is not this run's.
rm -f "$FAILURE_FILE"
trap on_exit EXIT

require_configuration() {
  local name
  for name in AGENTX_WORKSPACE_ID AGENTX_SESSION_GENERATION AGENTX_VOLUME_ID AGENTX_EXPECT_NEW_VOLUME \
    AGENTX_WORKER_IMAGE AGENTX_INVOKE_PUBLIC_KEY AGENTX_CONTROL_PLANE_URL AGENTX_MODEL_PROVIDER \
    AGENTX_MODEL_ID PI_CACHE_RETENTION AGENTX_LOG_GROUP; do
    [[ -n "${!name:-}" ]] || fail "$name is not set"
  done
  [[ "$AGENTX_EXPECT_NEW_VOLUME" == true || "$AGENTX_EXPECT_NEW_VOLUME" == false ]] \
    || fail "AGENTX_EXPECT_NEW_VOLUME must be true or false"
}

# Prints the value only once it is whole, so a try that fails part-way leaves nothing behind.
imds_once() {
  local token value
  token=$(curl -fsS --connect-timeout 2 --max-time 5 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 300') \
    && value=$(curl -fsS --connect-timeout 2 --max-time 5 -H "X-aws-ec2-metadata-token: $token" "http://169.254.169.254/latest/meta-data/$1") \
    && printf '%s\n' "$value"
}

imds() { retry "could not read the instance's $1 from instance metadata" imds_once "$1"; }

# Prints "NAME SERIAL" for each NVMe disk in sysfs, without the serial's padding.
sysfs_disks() {
  local file name
  for file in "$HOST_ROOT"/sys/block/nvme*/device/serial; do
    [[ -e "$file" ]] || continue
    name=${file%/device/serial}
    printf '%s %s\n' "${name##*/}" "$(tr -d '[:space:]' <"$file")"
  done
}

# A Nitro instance exposes an EBS volume as an NVMe disk whose serial is the volume ID without its
# dash. lsblk, sysfs or the by-id link may each be the first to show it.
volume_device() {
  local serial=${AGENTX_VOLUME_ID//-/} device
  for device in $({ lsblk -dno NAME,SERIAL; sysfs_disks; } 2>/dev/null | awk -v s="$serial" '$2 == s { print "/dev/" $1 }') \
    "$(readlink -f "$HOST_ROOT/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_$serial")"; do
    if [[ -b "$device" ]]; then printf '%s\n' "$device"; return; fi
  done
}

# Rescans the PCI bus at 20, 50 and 80s in case the kernel missed the hot-add. The time waited is
# at least the sleeps, as the tests' sleep is instant.
wait_for_device() {
  local start=$SECONDS waited=0 rescans=0 device line
  until device=$(volume_device) && [[ -n "$device" ]]; do
    ((waited >= SECONDS - start)) || waited=$((SECONDS - start))
    if ((waited >= DEVICE_WAIT_SECONDS)); then
      lsblk -dno NAME,SERIAL,MODEL 2>&1 | while read -r line; do log "lsblk saw: $line"; done || true
      sysfs_disks | while read -r line; do log "sysfs saw: $line"; done || true
      fail "workspace disk $AGENTX_VOLUME_ID is attached in AWS but did not appear on this machine after ${DEVICE_WAIT_SECONDS}s (rescanned $rescans times)"
    elif ((rescans < 3 && waited >= 20 + 30 * rescans)); then
      rescans=$((rescans + 1))
      log "workspace disk $AGENTX_VOLUME_ID has not appeared after ${waited}s; rescanning the PCI bus ($rescans of 3)"
      { echo 1 >"$HOST_ROOT/sys/bus/pci/rescan" && timeout 15 udevadm settle --timeout=10; } || log "the PCI rescan failed"
    else
      sleep 2
      waited=$((waited + 2))
    fi
  done
  printf '%s\n' "$device"
}

# Formats only a volume that is blank and that this generation created. A blank volume that should
# already hold the workspace means data was lost or the wrong volume is attached: formatting it would
# hide that, so the boot fails instead.
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

# Mounts through fstab, so the worker unit's RequiresMountsFor keeps the container from ever starting
# on the root volume if the instance reboots without its workspace.
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

# A failed try may leave stale mirror metadata behind (a DNS failure did, #211), so it is dropped
# before the next try.
install_docker_package() {
  timeout "$(try_seconds 120)" dnf install -y docker && return 0
  dnf clean metadata >/dev/null 2>&1 || true
  return 1
}

ensure_docker() {
  command -v docker >/dev/null || retry "could not install Docker: package download failed" install_docker_package
  install -d -m 0755 /etc/docker
  printf '{"data-root": "%s"}\n' "$DOCKER_DATA_ROOT" >/etc/docker/daemon.json
  systemctl enable docker.service
  systemctl restart docker.service
}

# The password goes from the AWS CLI to Docker through a pipe, never through the log.
registry_login() {
  timeout "$(try_seconds 60)" aws ecr get-login-password --region "$1" \
    | timeout "$(try_seconds 60)" docker login --username AWS --password-stdin "$2"
}

pull_image_once() { timeout "$(try_seconds 300)" docker pull "$1"; }

pull_worker_image() {
  local region=$1 registry=${AGENTX_WORKER_IMAGE%%/*}
  retry "could not log in to the worker image registry" registry_login "$region" "$registry"
  retry "could not download the worker image" pull_image_once "$AGENTX_WORKER_IMAGE"
}

# Root-only, because the worker's environment is its configuration; none of it is secret today, but
# the file should not become world-readable if that changes.
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
PI_CACHE_RETENTION=$PI_CACHE_RETENTION
AGENTX_INVOKE_PUBLIC_KEY=$AGENTX_INVOKE_PUBLIC_KEY
AGENTX_WORKSPACE_ID=$AGENTX_WORKSPACE_ID
AGENTX_SESSION_GENERATION=$AGENTX_SESSION_GENERATION
EOF
}

# The container shares the host network, so the worker listens on the instance's port 8080 and
# reaches the instance role's credentials through IMDS with a hop limit of 1. It also gets the host's
# Docker socket, to run the project's devcontainer (#121): root on this instance, which serves only
# this workspace. The workspace is mounted at the same path as on the host, so the bind mounts the
# devcontainer CLI asks the host's Docker for name the same files.
write_worker_unit() {
  local region=$1 instance_id=$2 docker docker_gid
  docker=$(command -v docker)
  docker_gid=$(stat -c %g "$DOCKER_SOCKET")
  cat >"/etc/systemd/system/$WORKER_UNIT" <<EOF
[Unit]
Description=AgentX worker for workspace $AGENTX_WORKSPACE_ID generation $AGENTX_SESSION_GENERATION
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target
RequiresMountsFor=$MOUNT_PATH

[Service]
ExecStartPre=-$docker rm --force $WORKER_CONTAINER
ExecStart=$docker run --rm --name $WORKER_CONTAINER --network host --env-file $WORKER_ENV_FILE --volume $MOUNT_PATH:$MOUNT_PATH --volume $DOCKER_SOCKET:$DOCKER_SOCKET --group-add $docker_gid --log-driver awslogs --log-opt awslogs-region=$region --log-opt awslogs-group=$AGENTX_LOG_GROUP --log-opt awslogs-stream=$AGENTX_WORKSPACE_ID/$AGENTX_SESSION_GENERATION/$instance_id $AGENTX_WORKER_IMAGE
ExecStop=$docker stop $WORKER_CONTAINER
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
}

main() {
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
  BOOT_STEP="set up Docker"
  ensure_docker
  BOOT_STEP="download the worker image"
  pull_worker_image "$region"
  BOOT_STEP="start the worker"
  write_worker_environment "$region"
  write_worker_unit "$region" "$instance_id"
  systemctl daemon-reload
  systemctl enable --now "$WORKER_UNIT"
  log "worker started"
}

main "$@"
