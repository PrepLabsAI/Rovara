#!/bin/bash
# The docker program a gateway-mode EC2 worker hands the devcontainer CLI (`--docker-path`, packages/worker/src/devcontainer.ts `DEVCONTAINER_GATEWAY_DOCKER`). Lane L4-NETG (DEC 254zzz77).
#
# The CLI starts the project's dev container with `docker run` or `docker create`. On a gateway-mode worker that container must sit on the internal network whose only exit is the host's egress gateway, with the gateway as its
# only name server, and without NET_RAW (nothing on the shared bridge may forge packets). This wrapper adds these options to those two commands, in front of whatever the CLI asked for.
#
# THE IMAGE BUILD (lane L4-NETG2, DEC 254zzz90): `docker build` (also `image build`, `builder build`) runs the Dockerfile's RUN steps and the features' install.sh, which is repository-controlled code. The wrapper adds `--network <the internal network>` to it, so those steps
# have the same one way out, the gateway; the gateway is also the Docker daemon's default name server (sandbox-egress.sh), because a build has no `--dns` option. A build that names its own `--network`/`--net` is refused (the last one given would win). `buildx` is refused
# outright: BuildKit takes only default/none/host as a build network, so a buildx build could not be walled; the CLI then uses the classic builder, which does take a named network. A refused command exits 125 and runs nothing.
#
# THE CLASSIC BUILDER IS FORCED (batch b20 fix, #1105 against #1081): the worker image DOES carry the buildx plugin now (the saved-environment builder, packages/worker/src/saved-env/build.ts, runs its own pinned rootless builder with it, never through this
# wrapper), so "no plugin" no longer keeps a devcontainer build off BuildKit; this wrapper does. Every channel by which a build here could reach buildx or BuildKit is closed, and each is a test (tests/contract/devcontainer-docker-wrapper.test.ts):
#   - the environment: every BUILDX_* and BUILDKIT_* variable is removed from the environment of the docker it runs, and DOCKER_BUILDKIT is set to 0 (so `docker build` is the legacy builder even with the plugin installed, whatever the caller exported);
#   - a flag: the buildx-only options (--builder, --load, --push, --output/-o, --cache-to, --attest, --provenance, --sbom, --secret, --ssh, --allow, --build-context, --call, --check, --metadata-file, --no-cache-filter, --annotation) are refused;
#   - the docker config: a config.json with an `aliases` entry (what `docker buildx install` writes, making `docker build` run buildx) refuses every build;
#   - the subcommand: `docker buildx ...` is refused whatever the devcontainer CLI version asks for.
#
# Container removal also cleans its resolver file. Other commands pass through (pull, exec, inspect, volume, ps, start). The image pulls the CLI makes are the host's own (the host's Docker pulls with the host's network, not the build's). The worker's policy (devcontainer-policy.ts, `walledNetwork`) refuses a repository's own `--network` in runArgs and build.options, and after the start it checks
# the container is on that one network and dropped NET_RAW; a container this wrapper did not put there is removed and refused.
#
# FAIL CLOSED: without the network name and the name server in the environment (the worker's environment file, written by the boot's sandbox-egress stage) it runs nothing: it never falls back to the default bridge.
set -u
readonly REAL_DOCKER=/usr/local/bin/docker
network=${AGENTX_SANDBOX_NETWORK:-}
dns=${AGENTX_SANDBOX_DNS:-}
if [[ ! "$network" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ || ! "$dns" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
  echo "devcontainer-docker: the sandbox network or its name server is not set, so no dev container is started" >&2
  exit 125
fi
# Nothing that selects or configures buildx/BuildKit reaches the docker this runs, and the legacy builder is the only one `docker build` can be.
for variable in $(compgen -e); do [[ "$variable" == BUILDX_* || "$variable" == BUILDKIT_* ]] && unset "$variable"; done
export DOCKER_BUILDKIT=0
# The buildx-only options of a build (the legacy builder does not take them; refusing them here makes that explicit and fail closed).
no_buildx_option() {
  local arg
  for arg in "$@"; do
    [[ "$arg" =~ ^(--builder|--load|--push|--output|--cache-to|--attest|--provenance|--sbom|--secret|--ssh|--allow|--build-context|--call|--check|--metadata-file|--no-cache-filter|--annotation|-o)(=|$) ]] && { echo "devcontainer-docker: a buildx-only build option cannot be walled, so nothing was built" >&2; exit 125; }
  done
  return 0
}
# `docker buildx install` makes `docker build` run buildx by an alias in the docker config; a config with any alias builds nothing.
no_alias_config() {
  # Docker reads config.json with a decoder that ignores the case of field names and decodes \u escapes, so both are refused as well (a config of the worker's own never has either). With no HOME, docker uses the passwd home: that one is checked too.
  local config="${DOCKER_CONFIG:-${HOME:-$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6)}/.docker}/config.json"
  if [[ -e "$config" ]] && grep -qiE 'aliases|\\u' "$config" 2>/dev/null; then echo "devcontainer-docker: the docker configuration has an alias (buildx may be the default builder), so nothing was built" >&2; exit 125; fi
  return 0
}
# `--network`/`--net` anywhere in the arguments of a build: the options a repository's build.options can add.
no_network_option() { local arg; for arg in "$@"; do [[ "$arg" =~ ^--net(work)?(=|$) ]] && { echo "devcontainer-docker: a build may not name its own network, so nothing was built" >&2; exit 125; }; done; }
walled_build() { no_network_option "${@:2}"; no_buildx_option "${@:2}"; no_alias_config; exec "$REAL_DOCKER" "$1" --network "$network" "${@:2}"; }
# Runtime files live outside the workspace, in this worker's namespace. A container label keeps the exact source through restarts.
worker_directory() {
  local key
  key=$(node -e 'const p=require("path"),c=require("crypto");process.stdout.write(c.createHash("sha256").update(p.resolve(process.env.AGENTX_WORKSPACE_ROOT||"/mnt/workspace")).digest("hex").slice(0,16))') || return 1
  printf '/var/lib/rovara-egress/runs/%s' "$key"
}
walled() {
  local parent directory status
  parent=$(worker_directory) || exit 125
  (umask 077; mkdir -p "$parent") || exit 125
  directory=$(mktemp -d "$parent/devcontainer-XXXXXXXXXXXX") || exit 125
  if ! printf 'nameserver %s\noptions ndots:0 timeout:3 attempts:1\n' "$dns" >"$directory/resolv.conf" || ! chmod 0644 "$directory/resolv.conf"; then
    rm -f "$directory/resolv.conf"; rmdir "$directory"; exit 125
  fi
  "$REAL_DOCKER" "$1" --network "$network" --mount "type=bind,src=$directory/resolv.conf,dst=/etc/resolv.conf,readonly" --label "rovara.egress.resolver=$directory/resolv.conf" --cap-drop NET_RAW "${@:2}"
  status=$?
  # Includes automatic --rm cleanup. A failed daemon query keeps the file for the startup sweep; a failed run may still have created a container.
  local held
  held=$("$REAL_DOCKER" ps --all --quiet --filter "label=rovara.egress.resolver=$directory/resolv.conf") && [[ -z "$held" ]] && { rm -f "$directory/resolv.conf"; rmdir "$directory"; }
  return "$status"
}
remove_containers() {
  local parent name source status sources=()
  parent=$(worker_directory) || exit 125
  for name in "${@:2}"; do
    [[ "$name" == -* ]] && continue
    source=$("$REAL_DOCKER" inspect --format '{{ index .Config.Labels "rovara.egress.resolver" }}' "$name" 2>/dev/null) && sources+=("$source")
  done
  "$REAL_DOCKER" "$@"; status=$?
  # Only after successful container removal. No directory walk and no following a link, even for an unexpected label.
  if [[ $status == 0 ]]; then
    node -e 'const fs=require("fs"),p=require("path"),root=process.argv[1];for(const file of process.argv.slice(2)){if(!file.startsWith(root+"/")||!/^devcontainer-[A-Za-z0-9]{8,}\/resolv\.conf$/.test(file.slice(root.length+1)))continue;try{const dir=p.dirname(file),a=fs.lstatSync(dir),b=fs.lstatSync(file);if(!a.isDirectory()||!b.isFile()||a.isSymbolicLink()||b.isSymbolicLink()||a.uid!==process.getuid()||b.uid!==process.getuid())continue;fs.unlinkSync(file);fs.rmdirSync(dir)}catch{}}' "$parent" "${sources[@]}"
  fi
  return "$status"
}
case "${1:-}" in
  -*) echo "devcontainer-docker: a leading option (-H, --context, --config ...) could point docker elsewhere, so nothing was run" >&2; exit 125 ;;
  run | create) walled "$@" ;;
  rm) remove_containers "$@" ;;
  build) walled_build "$@" ;;
  buildx) echo "devcontainer-docker: buildx cannot build on the walled network, so nothing was built (the classic builder is used)" >&2; exit 125 ;;
  container)
    case "${2:-}" in
      run | create) shift; walled "$@" ;;
      rm) shift; remove_containers "$@" ;;
      *) exec "$REAL_DOCKER" "$@" ;;
    esac ;;
  image | builder)
    case "${2:-}" in
      build) shift; walled_build "$@" ;;
      *) exec "$REAL_DOCKER" "$@" ;;
    esac ;;
  *) exec "$REAL_DOCKER" "$@" ;;
esac
