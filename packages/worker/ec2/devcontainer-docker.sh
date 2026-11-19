#!/bin/bash
# The docker program a gateway-mode EC2 worker hands the devcontainer CLI (`--docker-path`, packages/worker/src/devcontainer.ts `DEVCONTAINER_GATEWAY_DOCKER`). Lane L4-NETG (DEC 254zzz77).
#
# The CLI starts the project's dev container with `docker run` or `docker create`. On a gateway-mode worker that container must sit on the internal network whose only exit is the host's egress gateway, with the gateway as its
# only name server, and without NET_RAW (nothing on the shared bridge may forge packets). This wrapper adds exactly those three options to those two commands, in front of whatever the CLI asked for.
#
# THE IMAGE BUILD (lane L4-NETG2, DEC 254zzz90): `docker build` (also `image build`, `builder build`) runs the Dockerfile's RUN steps and the features' install.sh, which is repository-controlled code. The wrapper adds `--network <the internal network>` to it, so those steps
# have the same one way out, the gateway; the gateway is also the Docker daemon's default name server (sandbox-egress.sh), because a build has no `--dns` option. A build that names its own `--network`/`--net` is refused (the last one given would win). `buildx` is refused
# outright: BuildKit takes only default/none/host as a build network, so a buildx build could not be walled; the CLI then finds no buildx and uses the classic builder, which does take a named network. A refused command exits 125 and runs nothing.
#
# Every other command passes through unchanged (pull, exec, inspect, rm, volume, ps, start). The image pulls the CLI makes are the host's own (the host's Docker pulls with the host's network, not the build's). The worker's policy (devcontainer-policy.ts, `walledNetwork`) refuses a repository's own `--network` in runArgs and build.options, and after the start it checks
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
# `--network`/`--net` anywhere in the arguments of a build: the options a repository's build.options can add.
no_network_option() { local arg; for arg in "$@"; do [[ "$arg" =~ ^--net(work)?(=|$) ]] && { echo "devcontainer-docker: a build may not name its own network, so nothing was built" >&2; exit 125; }; done; }
walled_build() { no_network_option "${@:2}"; exec "$REAL_DOCKER" "$1" --network "$network" "${@:2}"; }
walled() { exec "$REAL_DOCKER" "$1" --network "$network" --dns "$dns" --cap-drop NET_RAW "${@:2}"; }
case "${1:-}" in
  -*) echo "devcontainer-docker: a leading option (-H, --context, --config ...) could point docker elsewhere, so nothing was run" >&2; exit 125 ;;
  run | create) walled "$@" ;;
  build) walled_build "$@" ;;
  buildx) echo "devcontainer-docker: buildx cannot build on the walled network, so nothing was built (the classic builder is used)" >&2; exit 125 ;;
  container)
    case "${2:-}" in
      run | create) shift; walled "$@" ;;
      *) exec "$REAL_DOCKER" "$@" ;;
    esac ;;
  image | builder)
    case "${2:-}" in
      build) shift; walled_build "$@" ;;
      *) exec "$REAL_DOCKER" "$@" ;;
    esac ;;
  *) exec "$REAL_DOCKER" "$@" ;;
esac
