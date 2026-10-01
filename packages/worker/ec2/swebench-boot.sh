#!/bin/bash
# Boots a SWE-bench eval instance (spec 043): reads the run's launch file, runs the worker image's
# SWE-bench mode once, and shuts the instance down, which terminates it.
#
# Runs once, as root, as the eval launch template's user data. The eval stack prepends
# AGENTX_ARTIFACT_BUCKET. The run ID comes from the instance's agentx-eval-run tag (instance metadata
# tags are on for eval instances), and everything else from s3://$AGENTX_ARTIFACT_BUCKET/evals/<run>/launch.json,
# which the broker wrote and validated. The run's callback capability never enters user data.
# Any failure shuts the instance down; the eval state machine then marks the run FAILED.
set -euo pipefail

readonly RUN_ROOT=/mnt/eval
readonly RUNNER_ENV_FILE=/etc/agentx/swebench.env
readonly RUNNER_CONTAINER=agentx-swebench
readonly DOCKER_SOCKET=/var/run/docker.sock

log() { printf 'agentx-swebench-boot: %s\n' "$*" >&2; }

# Whatever happens, the instance does not outlive the run.
trap 'log "shutting down"; shutdown -h now' EXIT

imds() {
  local token
  token=$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 300')
  curl -fsS -H "X-aws-ec2-metadata-token: $token" "http://169.254.169.254/latest/meta-data/$1"
}

# Reads one field of the launch file; the broker validated it against SwebenchLaunchSchema.
launch_field() {
  python3 -c 'import json, sys; value = json.load(open(sys.argv[1]))
for key in sys.argv[2].split("."): value = value.get(key, "") if isinstance(value, dict) else ""
print(value if isinstance(value, str) else json.dumps(value, separators=(",", ":")))' /etc/agentx/launch.json "$1"
}

main() {
  [[ -n "${AGENTX_ARTIFACT_BUCKET:-}" ]] || { log "AGENTX_ARTIFACT_BUCKET is not set"; exit 1; }
  local region instance_id run_id runner_image log_group docker_gid
  region=$(imds placement/region)
  instance_id=$(imds instance-id)
  run_id=$(imds tags/instance/agentx-eval-run)
  [[ "$run_id" =~ ^[0-9a-f-]{36}$ ]] || { log "invalid run ID tag"; exit 1; }
  log "run $run_id on $instance_id"

  install -d -m 0700 /etc/agentx
  aws s3 cp --region "$region" --only-show-errors "s3://$AGENTX_ARTIFACT_BUCKET/evals/$run_id/launch.json" /etc/agentx/launch.json
  chmod 0600 /etc/agentx/launch.json
  runner_image=$(launch_field runnerImage)
  log_group=$(launch_field logGroupName)
  [[ "$(launch_field run.runId)" == "$run_id" ]] || { log "the launch file names another run"; exit 1; }

  command -v docker >/dev/null || dnf install -y docker
  systemctl enable --now docker.service
  aws ecr get-login-password --region "$region" | docker login --username AWS --password-stdin "${runner_image%%/*}"
  docker pull "$runner_image"

  install -m 0600 /dev/null "$RUNNER_ENV_FILE"
  {
    printf 'AWS_REGION=%s\n' "$region"
    printf 'AGENTX_SWEBENCH_ROOT=%s\n' "$RUN_ROOT"
    printf 'AGENTX_SWEBENCH_RUN=%s\n' "$(launch_field run)"
    for name in PI_CACHE_RETENTION AGENTX_OPENROUTER_SECRET_ARN AGENTX_OPENROUTER_PROVIDERS; do
      value=$(launch_field "environment.$name")
      [[ -z "$value" ]] || printf '%s=%s\n' "$name" "$value"
    done
  } >"$RUNNER_ENV_FILE"

  install -d -m 0755 "$RUN_ROOT"
  docker_gid=$(stat -c %g "$DOCKER_SOCKET")
  # Root in the container: the task containers' files are root's, and the runner edits and diffs
  # them. The instance serves this one run. The run root is mounted at its own path, so the bind
  # mounts the runner asks the host's Docker for name the same files.
  log "starting the runner"
  docker run --rm --name "$RUNNER_CONTAINER" --network host --user 0:0 --group-add "$docker_gid" \
    --env-file "$RUNNER_ENV_FILE" \
    --volume "$RUN_ROOT:$RUN_ROOT" --volume "$DOCKER_SOCKET:$DOCKER_SOCKET" \
    --log-driver awslogs --log-opt "awslogs-region=$region" --log-opt "awslogs-group=$log_group" \
    --log-opt "awslogs-stream=$run_id/$instance_id" \
    "$runner_image" node packages/worker/dist/swebench-main.js \
    || log "the runner exited with status $?"
}

main "$@"
