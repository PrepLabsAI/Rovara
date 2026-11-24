# EC2 worker boot, test-services stage (DEC 254zm). Code's boot.sh is at its user data limit, so this stage ships in the worker image at
# /opt/agentx/packages/worker/ec2/test-services-stage.sh. boot.sh runs it only for a launch with AGENTX_TEST_SERVICES=1 (the install's
# TestServiceImages setting is `mirrored`): it copies this file out of the worker image it pulled BY DIGEST (no network, no capability), sources it
# and calls test_services_stage_main, after the worker environment and unit are written and BEFORE the worker starts. It runs in boot.sh's shell
# (log, try_seconds, the constants are boot.sh's). Sourcing it defines functions and constants and runs nothing.
#
# FAIL SAFE: nothing here stops the boot. Any step that fails leaves the worker WITHOUT test services (no owner list, no run directory, so the
# worker's testServicesConfigFromEnvironment finds no configuration and /ping lists no test-services feature) and every other task runs as before;
# a step that needs test services then ends with the fixed "Test services not available here" words (broker task-flow/dispatch.ts). Never `fail`.
#
# What a worker that passes gets, the same rules the laptop proves:
#   - the install's copies of the starter images, pulled by root BY DIGEST from this account's ECR (the worker container never pulls and has no login);
#     the references and digests come from the worker image's own contracts (test-services-mirror-cli.js), so they are the digests the broker plans with;
#   - AGENTX_TEST_SERVICES_OWNER_IMAGES: the owner list of exactly the copies that arrived (the worker runs nothing else: listed digests only, and only
#     if the digest is on this host), AGENTX_WORKER_IMAGE (the sealed check's resolver guard runs from it), AGENTX_TEST_SERVICES_BOOT_FACTS;
#   - a 64 MiB tmpfs run directory at the same path on the host and in the worker (the launcher mounts it into the worker only while it is mounted);
#   - Docker's own networks kept out of 172.29/16 (setup runs) and 172.30/16 (run networks); two run bridges never route to each other; nothing on a
#     run or build bridge reaches the host over IPv6 (or test services are withheld); the metadata address stays blocked for containers;
#   - a unit that puts the walls and the run directory back after a reboot or a Docker restart, and withholds test services when it cannot.

readonly TS_RUN_DIR=/run/agentx-test-services
readonly TS_UNIT=rovara-test-services.service
readonly TS_RESTORE=/usr/local/libexec/rovara-test-services-restore
readonly TS_CLI=/opt/agentx/packages/worker/dist/test-services-mirror-cli.js
readonly TS_MAX_IMAGES=8
readonly TS_PULL_SECONDS=180
readonly TS_PULL_PARALLEL=3
TS_PREPULL=none
TS_COUNT=0
TS_LOGGED_OUT=false
TS_IPV6_REASON=""

ts_metadata_blocked() {
  iptables -S DOCKER-USER 2>/dev/null | grep -Eq -- '^-A DOCKER-USER -d 169\.254\.169\.254/32 -j (DROP|REJECT)$'
}
# Two different rvi bridges never talk: routed between bridges is "not bridged"; traffic inside one bridge is bridged and flows. At the top of DOCKER-USER.
ts_wall_run_networks() {
  local rule="DOCKER-USER -i rvi+ -o rvi+ -m physdev ! --physdev-is-bridged -j DROP"
  # shellcheck disable=SC2086
  iptables -C $rule 2>/dev/null || iptables -I $rule
}
ts_run_walls_present() {
  iptables -C DOCKER-USER -i rvi+ -o rvi+ -m physdev ! --physdev-is-bridged -j DROP 2>/dev/null
}
# IPv6 counts as off only when it is disabled for the interfaces that exist AND for those that will (a new bridge takes conf/default), or the kernel has none.
ts_ipv6_active() {
  [[ -e /proc/net/if_inet6 ]] || return 1
  [[ $(cat /proc/sys/net/ipv6/conf/all/disable_ipv6 2>/dev/null) != 1 || $(cat /proc/sys/net/ipv6/conf/default/disable_ipv6 2>/dev/null) != 1 ]]
}
ts_wall_ipv6() {
  local bridge
  TS_IPV6_REASON=""
  if command -v ip6tables >/dev/null && ip6tables -S INPUT >/dev/null 2>&1; then
    for bridge in rvb+ rvi+; do
      ip6tables -C INPUT -i "$bridge" -j DROP 2>/dev/null || ip6tables -I INPUT -i "$bridge" -j DROP || { TS_IPV6_REASON=rule-not-added; return 1; }
    done
  elif ts_ipv6_active; then
    TS_IPV6_REASON=ip6tables-unusable
    return 1
  fi
}
ts_mount_run_dir() {
  install -d -o "$WORKER_UID" -g "$WORKER_GID" -m 0700 "$TS_RUN_DIR" || return 1
  mountpoint -q "$TS_RUN_DIR" || mount -t tmpfs -o "size=64m,mode=0700,uid=$WORKER_UID,gid=$WORKER_GID,nosuid,nodev,noexec" tmpfs "$TS_RUN_DIR" || return 1
  mountpoint -q "$TS_RUN_DIR"
}
# Withheld: the run directory is not mounted (the launcher then gives the worker none, so it has no configuration) and worker.env says `all` (the worker's own
# fail-closed withhold). Sticky for the instance: a later success does not undo it; the next launch writes a new worker.env.
ts_withhold() {
  umount "$TS_RUN_DIR" 2>/dev/null || true
  grep -qx 'AGENTX_TEST_SERVICES_NOT_PULLED=all' "$WORKER_ENV_FILE" 2>/dev/null || printf 'AGENTX_TEST_SERVICES_NOT_PULLED=all\n' >>"$WORKER_ENV_FILE" || true
  log "TEST SERVICES WITHHELD on this worker ($1); every other task runs as before"
}

# Docker's own networks never take 172.29/16 (setup runs), 172.30/16 (run networks) or 10/8: /24s from 172.18-172.28 and 192.168/16 only. Docker is restarted
# before anything uses a network (only images were pulled), then the container firewall is put back (a restart rebuilds Docker's chains).
ts_address_pools() {
  local pools='[{"base":"172.18.0.0/15","size":24},{"base":"172.20.0.0/14","size":24},{"base":"172.24.0.0/14","size":24},{"base":"172.28.0.0/16","size":24},{"base":"192.168.0.0/16","size":24}]'
  # The old file is kept: if Docker does not come back with the new one, the old one is put back and Docker restarted on it (the worker still needs Docker), and the stage withholds.
  cp -p /etc/docker/daemon.json /etc/docker/daemon.json.before-test-services 2>/dev/null || return 1
  printf '{"data-root": "%s", "default-address-pools": %s}\n' "$DOCKER_DATA_ROOT" "$pools" >/etc/docker/daemon.json || { mv -f /etc/docker/daemon.json.before-test-services /etc/docker/daemon.json; return 1; }
  # EGRESS-BOOT-RACE: `systemctl restart` returning is not Docker answering, and the container firewall inserts into the DOCKER-USER chain the daemon builds as it starts; wait (bounded) for the daemon before the firewall.
  if timeout "$(try_seconds 120)s" systemctl restart docker.service && ts_docker_ready; then rm -f /etc/docker/daemon.json.before-test-services; bash /usr/local/libexec/rovara-container-firewall; return; fi
  mv -f /etc/docker/daemon.json.before-test-services /etc/docker/daemon.json
  # The failed restart may have tripped systemd's start limit; clear it so the restart on the original file is not refused.
  systemctl reset-failed docker.service 2>/dev/null || true
  timeout 120s systemctl restart docker.service && ts_docker_ready && bash /usr/local/libexec/rovara-container-firewall
  return 1
}
# Docker answers `docker info` (30 tries, 2 s apart; each probe capped at 15 s or what is left of the boot time), else 1; it never runs past the boot deadline (BOOT_DEADLINE).
ts_docker_ready() { local i; for i in $(seq 1 30); do timeout "$(try_seconds 15)s" docker info >/dev/null 2>&1 && return 0; ((SECONDS < BOOT_DEADLINE)) || return 1; sleep 2; done; return 1; }

# The install's copies, as the worker image names them. Fixed form only, at most TS_MAX_IMAGES; anything else is none.
ts_mirror_references() {
  local registry=$1 environment=$2 line count=0 pattern
  pattern="^${registry//./\\.}/agentx-${environment}--test-services/[a-z0-9]+-[0-9]{1,3}/[a-z0-9]+@sha256:[a-f0-9]{64}\$"
  timeout --foreground --kill-after=10s "$(try_seconds 60)s" docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
    --entrypoint node "$AGENTX_WORKER_IMAGE" "$TS_CLI" refs "$registry" "$environment" 2>/dev/null | while IFS= read -r line; do
    count=$((count + 1))
    ((count <= TS_MAX_IMAGES)) || break
    [[ "$line" =~ $pattern ]] && printf '%s\n' "$line"
  done
}

# Root pulls, by digest, with one ECR login that is removed after. Each pull is bounded on its own; a failed pull does not stop the others. Prints the references that
# arrived (it runs in a process substitution, so the caller counts them).
ts_pull() {
  local region=$1 registry=$2 reference results index=0 file
  shift 2
  ((BOOT_DEADLINE - SECONDS >= 30)) || { log "test services: too little boot time left to pull"; return 0; }
  { timeout --foreground --kill-after=10s "$(try_seconds 60)s" aws ecr get-login-password --region "$region" \
      | timeout --foreground --kill-after=10s "$(try_seconds 60)s" docker login --username AWS --password-stdin "$registry" >/dev/null 2>&1; } \
    || { log "test services: the registry login failed"; return 0; }
  results=$(mktemp -d) || return 0
  for reference in "$@"; do
    index=$((index + 1))
    ((BOOT_DEADLINE - SECONDS >= 20)) || break
    while (($(jobs -rp | wc -l) >= TS_PULL_PARALLEL)); do sleep 1; done
    (
      timeout --foreground --kill-after=10s "$(try_seconds "$TS_PULL_SECONDS")s" docker pull "$reference" >/dev/null 2>&1 \
        && docker image inspect "$reference" >/dev/null 2>&1 && printf '%s\n' "$reference" >"$results/$index.ok"
    ) &
  done
  wait
  for file in "$results"/*.ok; do [[ ! -e "$file" ]] || cat "$file"; done
  rm -rf "$results"
}

# Booleans, a count and a version number for the worker's start report (parseBootFacts); no name, path or secret.
ts_boot_facts() {
  local imds=false walls=false ip6=true reason="" version
  ts_metadata_blocked && imds=true
  ts_run_walls_present && walls=true
  [[ -z "$TS_IPV6_REASON" ]] || { ip6=false; reason=",\"ipv6DropsReason\":\"$TS_IPV6_REASON\""; }
  version=$(docker version --format '{{.Server.Version}}' 2>/dev/null | head -n1)
  [[ "$version" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){0,3}(-[a-z0-9.]{1,12})?$ ]] || version=0
  printf 'AGENTX_TEST_SERVICES_BOOT_FACTS={"metadataBlocked":%s,"runWalls":%s,"ipv6Drops":%s%s,"prepull":"%s","prepulled":%s,"loggedOut":%s,"dockerVersion":"%s"}\n' \
    "$imds" "$walls" "$ip6" "$reason" "$TS_PREPULL" "$TS_COUNT" "$TS_LOGGED_OUT" "$version" >>"$WORKER_ENV_FILE"
}

# After a reboot or a Docker restart: the walls and the run directory again, before the worker starts; anything missing withholds test services. Never fails the unit.
ts_install_restore_unit() {
  { printf 'WORKER_ENV_FILE=%s\nWORKER_UID=%s\nWORKER_GID=%s\nreadonly TS_RUN_DIR=%s\nlog() { printf "%%s\\n" "$*" >&2; }\n' "$WORKER_ENV_FILE" "$WORKER_UID" "$WORKER_GID" "$TS_RUN_DIR"
    declare -f ts_metadata_blocked ts_wall_run_networks ts_ipv6_active ts_wall_ipv6 ts_mount_run_dir ts_withhold
    printf 'if ts_metadata_blocked && ts_wall_run_networks && ts_wall_ipv6 && ts_mount_run_dir; then exit 0; fi\nts_withhold restore\nexit 0\n'
  } >"$TS_RESTORE" || return 1
  chmod 0700 "$TS_RESTORE" || return 1
  cat >"/etc/systemd/system/$TS_UNIT" <<UNIT || return 1
[Unit]
Description=Test services walls and run directory, before the worker
Requires=docker.service
After=docker.service $FIREWALL_UNIT
Before=$WORKER_UNIT
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash $TS_RESTORE
[Install]
WantedBy=multi-user.target
UNIT
  install -d -o root -g root -m 0755 "/etc/systemd/system/$WORKER_UNIT.d" || return 1
  printf '[Unit]\nWants=%s\nAfter=%s\n' "$TS_UNIT" "$TS_UNIT" >"/etc/systemd/system/$WORKER_UNIT.d/20-test-services.conf" || return 1
  systemctl enable "$TS_UNIT" >/dev/null 2>&1
}

test_services_stage_main() {
  local region=$1 registry=${AGENTX_WORKER_IMAGE%%/*} environment list references=() arrived=() line
  [[ "$registry" =~ ^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com$ ]] || { log "test services: the worker image is not in this account's ECR"; return 1; }
  [[ "${AGENTX_LOG_GROUP:-}" =~ ^/agentx/([a-z](-?[a-z0-9])*)/worker$ ]] || { log "test services: not a named environment"; return 1; }
  environment=${BASH_REMATCH[1]}
  ((${#environment} <= 20)) || return 1
  while IFS= read -r line; do references+=("$line"); done < <(ts_mirror_references "$registry" "$environment")
  ((${#references[@]} > 0)) || { log "test services: the worker image names no starter copies"; return 1; }
  ts_address_pools || { log "test services: Docker's address pools could not be set"; ts_withhold pools; return 1; }
  # The container firewall put the metadata block back with Docker's chains; if it is not there now, nothing is offered.
  ts_metadata_blocked || { ts_withhold metadata; return 1; }
  ts_wall_run_networks || { ts_withhold run-walls; return 1; }
  ts_wall_ipv6 || { ts_boot_facts; ts_withhold "$TS_IPV6_REASON"; return 1; }
  ts_mount_run_dir || { ts_withhold run-directory; return 1; }
  ts_install_restore_unit || { ts_withhold restore-unit; return 1; }
  while IFS= read -r line; do arrived+=("$line"); done < <(ts_pull "$region" "$registry" "${references[@]}")
  # ts_pull ran in a process substitution: its counters are recounted here from what it printed.
  TS_COUNT=${#arrived[@]}
  if ((TS_COUNT == 0)); then TS_PREPULL=failed; elif ((TS_COUNT < ${#references[@]})); then TS_PREPULL=partial; else TS_PREPULL=ok; fi
  # No ECR token stays on disk after the pulls (the worker has no login of its own and needs none).
  if docker logout "$registry" >/dev/null 2>&1; then TS_LOGGED_OUT=true; fi
  ((TS_COUNT > 0)) || { ts_boot_facts; ts_withhold images; return 1; }
  list=$(timeout --foreground --kill-after=10s "$(try_seconds 60)s" docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
    --entrypoint node "$AGENTX_WORKER_IMAGE" "$TS_CLI" list "$registry" "$environment" "${arrived[@]}" 2>/dev/null | head -c 65536 | head -n 1)
  [[ "$list" == '[{"reference":"'* && "$list" == *'}]' && "$list" != *"'"* ]] || { ts_boot_facts; ts_withhold owner-list; return 1; }
  { printf 'AGENTX_WORKER_IMAGE=%s\n' "$AGENTX_WORKER_IMAGE"; printf 'AGENTX_TEST_SERVICES_OWNER_IMAGES=%s\n' "$list"; } >>"$WORKER_ENV_FILE" || { ts_withhold environment; return 1; }
  ts_boot_facts || true
  log "test services: $TS_COUNT starter image(s) on this worker ($TS_PREPULL)"
}
