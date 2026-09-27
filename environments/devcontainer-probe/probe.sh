#!/usr/bin/env bash
# Issue #55 probe. Never exits non-zero: a refused capability is a result, not an error.
set +e

PHASE="${1:-caps}"
PROBE_ROOT="${PROBE_ROOT:-/mnt/workspace/.probe}"
GRAPH_ROOT="$PROBE_ROOT/storage"
RUN_ROOT=/run/podman
FIXTURE="$PROBE_ROOT/fixture"

section() { printf '\n== %s ==\n' "$1"; }
has_capability() {
  local mask="$1" bit="$2"
  if [ -z "$mask" ]; then echo "unknown"; return; fi
  if (( (0x$mask >> bit) & 1 )); then echo "PRESENT"; else echo "absent"; fi
}

report()  { printf '%-28s %s\n' "$1" "$2"; }

identity_and_capabilities() {
  section "identity and capabilities"
  report "uid" "$(id -u) ($(id -un 2>/dev/null || echo unknown))"
  local effective
  effective=$(grep -E '^CapEff' /proc/self/status | awk '{print $2}')
  report "CapEff" "$effective"
  report "Seccomp" "$(grep -E '^Seccomp:' /proc/self/status | awk '{print $2}')"
  # Decode the effective mask directly. capsh --print also prints a bounding set, so grepping its
  # output for a capability name reports present when only the bounding set holds it.
  report "cap_sys_admin" "$(has_capability "$effective" 21)"
  report "cap_net_admin" "$(has_capability "$effective" 12)"
  report "cap_mknod" "$(has_capability "$effective" 27)"
  report "capsh_current" "$(capsh --print 2>/dev/null | sed -n 's/^Current: //p' | head -1)"
}

namespaces_and_mounts() {
  section "namespaces and mount support"
  report "max_user_namespaces" "$(cat /proc/sys/user/max_user_namespaces 2>&1)"
  if unshare -Ur true 2>/dev/null; then report "unshare -Ur" "ok"; else report "unshare -Ur" "DENIED"; fi
  if unshare -m true 2>/dev/null; then report "unshare -m" "ok"; else report "unshare -m" "DENIED"; fi
  report "/dev/fuse" "$(ls -l /dev/fuse 2>&1 | head -1)"
  report "subuid" "$(cat /etc/subuid 2>&1 | tr '\n' ' ')"
  report "subgid" "$(cat /etc/subgid 2>&1 | tr '\n' ' ')"
  report "cgroup_version" "$(stat -fc %T /sys/fs/cgroup 2>&1)"
  # Recorded for completeness only. Issue #55 states we must not build on the host runtime socket.
  report "containerd.sock" "$(ls -l /run/containerd/containerd.sock 2>&1 | head -1)"
  report "docker.sock" "$(ls -l /var/run/docker.sock 2>&1 | head -1)"
}

workspace_capacity() {
  section "workspace volume"
  report "mount_fstype" "$(stat -fc %T "$AGENTX_WORKSPACE_ROOT" 2>&1)"
  report "free_space" "$(df -h "$AGENTX_WORKSPACE_ROOT" 2>&1 | awk 'NR==2 {print $4 " free of " $2}')"
  report "root_free_space" "$(df -h / 2>&1 | awk 'NR==2 {print $4 " free of " $2}')"
  report "mem_total" "$(awk '/MemTotal/ {printf "%.1f GiB", $2/1048576}' /proc/meminfo)"
  report "nproc" "$(nproc)"
}

configure_storage() {
  mkdir -p "$GRAPH_ROOT" "$RUN_ROOT" "$FIXTURE/.devcontainer"
  # Only the paths are pinned. The driver is left unset so podman selects one and the probe can
  # report which it chose, including a fallback to vfs.
  cat > "$CONTAINERS_STORAGE_CONF" <<CONF
[storage]
graphroot = "$GRAPH_ROOT"
runroot = "$RUN_ROOT"
CONF
}

container_runtime() {
  section "podman"
  configure_storage
  report "podman_version" "$(podman --version 2>&1)"
  report "graph_driver" "$(podman info --format '{{.Store.GraphDriverName}}' 2>&1 | tail -1)"
  report "graph_root" "$(podman info --format '{{.Store.GraphRoot}}' 2>&1 | tail -1)"
  report "rootless" "$(podman info --format '{{.Host.Security.Rootless}}' 2>&1 | tail -1)"
  local driver
  driver=$(podman info --format '{{.Store.GraphDriverName}}' 2>/dev/null | tail -1)
  if [ "$driver" = "vfs" ]; then
    report "driver_verdict" "vfs: every layer is a full copy. Treat as a fail; check store_size below."
  fi

  # Pinned to ECR Public: podman defaults to docker.io, whose rate limits environments/base/Dockerfile
  # already documents as a problem from shared CI addresses.
  section "podman run"
  local started ended
  started=$(date +%s)
  if out=$(podman run --rm public.ecr.aws/docker/library/alpine:3 echo container-ok 2>&1); then
    ended=$(date +%s)
    report "podman_run" "ok in $((ended - started))s: $(echo "$out" | tail -1)"
  else
    report "podman_run" "FAILED: $(echo "$out" | tail -5 | tr '\n' ' ')"
  fi
  report "store_size" "$(du -sh "$GRAPH_ROOT" 2>&1 | awk '{print $1}')"
}

devcontainer_up() {
  section "devcontainer up"
  cat > "$FIXTURE/.devcontainer/devcontainer.json" <<'JSON'
{
  "image": "public.ecr.aws/docker/library/python:3.12-slim",
  "features": { "ghcr.io/devcontainers/features/node:1": {} },
  "postCreateCommand": "python --version && node --version"
}
JSON
  local started ended
  started=$(date +%s)
  if out=$(devcontainer up --docker-path podman --workspace-folder "$FIXTURE" 2>&1); then
    ended=$(date +%s)
    report "devcontainer_up" "ok in $((ended - started))s"
    report "exec_python" "$(devcontainer exec --docker-path podman --workspace-folder "$FIXTURE" python --version 2>&1 | tail -1)"
    report "exec_node" "$(devcontainer exec --docker-path podman --workspace-folder "$FIXTURE" node --version 2>&1 | tail -1)"
  else
    report "devcontainer_up" "FAILED after $(( $(date +%s) - started ))s"
    printf '%s\n' "$out" | tail -30
  fi
  report "store_size_after" "$(du -sh "$GRAPH_ROOT" 2>&1 | awk '{print $1}')"
  report "free_space_after" "$(df -h "$AGENTX_WORKSPACE_ROOT" 2>&1 | awk 'NR==2 {print $4}')"
}

printf 'probe phase=%s at %s\n' "$PHASE" "$(date -Is)"
case "$PHASE" in
  caps)
    identity_and_capabilities
    namespaces_and_mounts
    workspace_capacity
    ;;
  full)
    identity_and_capabilities
    namespaces_and_mounts
    workspace_capacity
    container_runtime
    devcontainer_up
    ;;
  *)
    echo "unknown phase: $PHASE"
    ;;
esac
printf '\nprobe phase=%s complete at %s\n' "$PHASE" "$(date -Is)"
