#!/bin/bash
# Boots an AgentX EC2 worker (issue #81): mounts the workspace volume and runs the worker image.
#
# Runs once, as root, as the instance's user data. The provisioner prepends the configuration with
# ec2WorkerUserData (@agentx/contracts), which validates every value before it reaches this script.
# Any failure exits non-zero and leaves the worker stopped; the provisioner's health probe then
# times out and marks the session FAILED.
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
# The provisioner attaches the volume after the instance is running, so it may appear late.
readonly DEVICE_WAIT_SECONDS=${AGENTX_DEVICE_WAIT_SECONDS:-300}

log() { printf 'agentx-boot: %s\n' "$*" >&2; }
fail() { log "FAILED: $*"; exit 1; }

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

imds() {
  local token
  token=$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 300')
  curl -fsS -H "X-aws-ec2-metadata-token: $token" "http://169.254.169.254/latest/meta-data/$1"
}

# A Nitro instance exposes an EBS volume as an NVMe disk whose serial is the volume ID without its dash.
volume_device() {
  local serial=${AGENTX_VOLUME_ID//-/}
  lsblk --nodeps --noheadings --output NAME,SERIAL | awk -v serial="$serial" '$2 == serial { print "/dev/" $1; exit }'
}

wait_for_device() {
  local deadline=$((SECONDS + DEVICE_WAIT_SECONDS)) device
  while ((SECONDS < deadline)); do
    device=$(volume_device)
    if [[ -n "$device" && -b "$device" ]]; then
      printf '%s\n' "$device"
      return
    fi
    sleep 2
  done
  fail "volume $AGENTX_VOLUME_ID was not attached within ${DEVICE_WAIT_SECONDS}s"
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

ensure_docker() {
  command -v docker >/dev/null || dnf install -y docker
  install -d -m 0755 /etc/docker
  printf '{"data-root": "%s"}\n' "$DOCKER_DATA_ROOT" >/etc/docker/daemon.json
  systemctl enable docker.service
  systemctl restart docker.service
}

pull_worker_image() {
  local region=$1 registry=${AGENTX_WORKER_IMAGE%%/*}
  aws ecr get-login-password --region "$region" | docker login --username AWS --password-stdin "$registry"
  docker pull "$AGENTX_WORKER_IMAGE"
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
  require_configuration
  log "booting workspace $AGENTX_WORKSPACE_ID generation $AGENTX_SESSION_GENERATION"
  local region instance_id device
  region=$(imds placement/region)
  instance_id=$(imds instance-id)
  device=$(wait_for_device)
  prepare_filesystem "$device"
  mount_workspace "$device"
  ensure_docker
  pull_worker_image "$region"
  write_worker_environment "$region"
  write_worker_unit "$region" "$instance_id"
  systemctl daemon-reload
  systemctl enable --now "$WORKER_UNIT"
  log "worker started"
}

main "$@"
