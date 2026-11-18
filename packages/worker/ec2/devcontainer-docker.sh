#!/bin/bash
# The docker program a gateway-mode EC2 worker hands the devcontainer CLI (`--docker-path`, packages/worker/src/devcontainer.ts `DEVCONTAINER_GATEWAY_DOCKER`). Lane L4-NETG (DEC 254zzz77).
#
# The CLI starts the project's dev container with `docker run` or `docker create`. On a gateway-mode worker that container must sit on the internal network whose only exit is the host's egress gateway, with the gateway as its
# only name server, and without NET_RAW (nothing on the shared bridge may forge packets). This wrapper adds exactly those three options to those two commands, in front of whatever the CLI asked for, and passes every other
# command through unchanged (build, pull, exec, inspect, rm, volume). The worker's policy (devcontainer-policy.ts, `walledNetwork`) refuses a repository's own `--network` in runArgs and build.options, and after the start it checks
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
walled() { exec "$REAL_DOCKER" "$1" --network "$network" --dns "$dns" --cap-drop NET_RAW "${@:2}"; }
case "${1:-}" in
  run | create) walled "$@" ;;
  container)
    case "${2:-}" in
      run | create) shift; walled "$@" ;;
      *) exec "$REAL_DOCKER" "$@" ;;
    esac ;;
  *) exec "$REAL_DOCKER" "$@" ;;
esac
