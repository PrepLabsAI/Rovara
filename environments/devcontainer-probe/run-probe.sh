#!/usr/bin/env bash
# Issue #55: does the AgentCore Instances runtime permit nested containers?
# Deploys a throwaway probe against a clone of the production capacity provider, runs it, tears it down.
#
#   ./run-probe.sh preflight   check tools and credentials
#   ./run-probe.sh up          clone capacity provider, build and push image, create runtime
#   ./run-probe.sh caps        fast phase: identity, capabilities, namespaces  <-- the decisive step
#   ./run-probe.sh full        start the slow phase (podman, devcontainer up) in the background
#   ./run-probe.sh results     read the slow phase log
#   ./run-probe.sh status      show what exists
#   ./run-probe.sh down        delete everything and verify nothing survives
#
# State lives in .probe-state next to this script, so steps resume in a new shell.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE="$HERE/.probe-state"
REGION="${AWS_REGION:-us-east-1}"
CP_NAME=agentx_devcontainer_probe
RT_NAME=agentx_devcontainer_probe
ECR_REPO=agentx-devcontainer-probe

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die()  { printf '\n\033[31merror: %s\033[0m\n' "$*" >&2; exit 1; }

save() { printf 'export %s=%q\n' "$1" "$2" >> "$STATE"; }
load() { [ -f "$STATE" ] && . "$STATE" || true; }

cmd_preflight() {
  say "Preflight"
  local missing=0
  for tool in aws jq docker uuidgen; do
    if command -v "$tool" >/dev/null; then info "$tool ok"; else info "$tool MISSING"; missing=1; fi
  done
  [ "$missing" -eq 0 ] || die "install the missing tools first"
  docker info >/dev/null 2>&1 || die "Docker is not running"
  info "docker daemon ok"
  local account
  account=$(aws sts get-caller-identity --query Account --output text 2>"$HERE/.sts-error.txt") || account=""
  if [ -z "$account" ] || [ "$account" = "None" ]; then
    info "$(tr -d '\n' < "$HERE/.sts-error.txt" 2>/dev/null | head -c 200)"
    rm -f "$HERE/.sts-error.txt"
    die "AWS credentials are not usable. Re-authenticate, then run this again."
  fi
  rm -f "$HERE/.sts-error.txt"
  info "account $account"
  info "region  $REGION"
  info "$(aws --version 2>&1 | head -1)"
}

cmd_up() {
  load
  [ -z "${PROBE_RT_ARN:-}" ] || die "a probe already exists; run ./run-probe.sh down first (or delete $STATE)"
  cmd_preflight

  say "Cloning the production capacity provider"
  local prod_cp_arn
  prod_cp_arn=$(aws cloudformation describe-stacks --region "$REGION" \
    --stack-name AgentXProductionFoundation \
    --query "Stacks[0].Outputs[?OutputKey=='CapacityProviderArn'].OutputValue" --output text)
  [ -n "$prod_cp_arn" ] && [ "$prod_cp_arn" != "None" ] || die "could not read CapacityProviderArn from AgentXProductionFoundation"
  info "production capacity provider ${prod_cp_arn##*/}"

  aws bedrock-agentcore-control get-capacity-provider --region "$REGION" \
    --capacity-provider-id "${prod_cp_arn##*/}" > "$HERE/.prod-cp.json"

  # Only the fields create accepts. Read-only fields from the GET would be rejected.
  jq --arg name "$CP_NAME" '{
        name: $name,
        permissionsConfiguration: .permissionsConfiguration,
        computeConfiguration: .computeConfiguration
      }' "$HERE/.prod-cp.json" > "$HERE/.probe-cp.json"

  info "instance types: $(jq -rc '.computeConfiguration.ec2Configuration.launchTemplateSource.launchParameters.instanceRequirements.allowedInstanceTypes // "unknown"' "$HERE/.probe-cp.json")"
  info "operating system: $(jq -r '.computeConfiguration.ec2Configuration.launchTemplateSource.launchParameters.operatingSystem // "unknown"' "$HERE/.probe-cp.json")"

  if ! aws bedrock-agentcore-control create-capacity-provider --region "$REGION" \
        --cli-input-json "file://$HERE/.probe-cp.json" > "$HERE/.probe-cp-created.json" 2> "$HERE/.probe-cp-error.txt"; then
    cat "$HERE/.probe-cp-error.txt" >&2
    die "create-capacity-provider was rejected. The request body is at $HERE/.probe-cp.json — a read-only field from the GET probably needs stripping."
  fi

  local cp_arn; cp_arn=$(jq -r '.capacityProviderArn' "$HERE/.probe-cp-created.json")
  save PROBE_CP_ARN "$cp_arn"
  save PROBE_CP_ID "${cp_arn##*/}"
  load
  info "created $PROBE_CP_ID"

  say "Waiting for the capacity provider to become READY"
  local deadline=$((SECONDS + 900)) status
  while :; do
    status=$(aws bedrock-agentcore-control get-capacity-provider --region "$REGION" \
      --capacity-provider-id "$PROBE_CP_ID" --query status --output text)
    case "$status" in
      READY) info "READY"; break ;;
      CREATE_FAILED) die "capacity provider entered CREATE_FAILED; check statusReason with get-capacity-provider" ;;
      *) [ "$SECONDS" -lt "$deadline" ] || die "still $status after 15 minutes"
         info "$status"; sleep 15 ;;
    esac
  done

  say "Building and pushing the arm64 probe image"
  local account registry repo
  account=$(aws sts get-caller-identity --query Account --output text)
  registry="$account.dkr.ecr.$REGION.amazonaws.com"
  repo="$registry/$ECR_REPO"
  aws ecr describe-repositories --region "$REGION" --repository-names "$ECR_REPO" >/dev/null 2>&1 \
    || aws ecr create-repository --region "$REGION" --repository-name "$ECR_REPO" >/dev/null
  aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$registry" >/dev/null
  docker build --platform linux/arm64 -t "$repo:probe" "$HERE"
  docker push "$repo:probe"
  save PROBE_REPO "$repo"
  load

  say "Creating the probe runtime"
  local role_arn
  role_arn=$(aws cloudformation describe-stacks --region "$REGION" \
    --stack-name AgentXProductionRuntime \
    --query "Stacks[0].Outputs[?OutputKey=='RuntimeExecutionRoleArn'].OutputValue" --output text)
  [ -n "$role_arn" ] && [ "$role_arn" != "None" ] || die "could not read RuntimeExecutionRoleArn from AgentXProductionRuntime"
  info "execution role ${role_arn##*/}"

  aws bedrock-agentcore-control create-agent-runtime --region "$REGION" \
    --agent-runtime-name "$RT_NAME" \
    --role-arn "$role_arn" \
    --agent-runtime-artifact "{\"containerConfiguration\":{\"containerUri\":\"$PROBE_REPO:probe\"}}" \
    --capacity-provider-configuration "{\"capacityProviderArn\":\"$PROBE_CP_ARN\"}" \
    --filesystem-configurations '[{"capacityProviderVolume":{"volumeName":"workspace","mountPath":"/mnt/workspace"}}]' \
    > "$HERE/.probe-rt.json"

  save PROBE_RT_ARN "$(jq -r '.agentRuntimeArn' "$HERE/.probe-rt.json")"
  save PROBE_RT_ID  "$(jq -r '.agentRuntimeId'  "$HERE/.probe-rt.json")"
  save SESSION      "devcontainer-probe-$(uuidgen)"
  load
  info "runtime $PROBE_RT_ID"
  info "session $SESSION"
  say "Ready. Next: ./run-probe.sh caps"
}

invoke() {
  load
  [ -n "${PROBE_RT_ARN:-}" ] || die "no probe deployed; run ./run-probe.sh up first"
  printf '{"phase":"%s"}' "$1" > "$HERE/.payload.json"
  if ! aws bedrock-agentcore invoke-agent-runtime --region "$REGION" \
        --agent-runtime-arn "$PROBE_RT_ARN" --runtime-session-id "$SESSION" \
        --qualifier DEFAULT --payload "fileb://$HERE/.payload.json" \
        "$HERE/.response.json" > "$HERE/.invoke-meta.json" 2> "$HERE/.invoke-error.txt"; then
    cat "$HERE/.invoke-error.txt" >&2
    die "invoke failed. The first call provisions an EC2 instance and pulls the image, so a timeout here is normal — just run the same command again."
  fi
  jq -r '.output // .log // .' "$HERE/.response.json" 2>/dev/null || cat "$HERE/.response.json"
}

cmd_caps() {
  say "Fast phase (first call also provisions the instance, so allow a few minutes)"
  invoke caps
  cat <<'EOF'

--------------------------------------------------------------------
Read two lines above: uid and cap_sys_admin.

  uid 0 + cap_sys_admin PRESENT   -> ./run-probe.sh full
  uid non-zero + unshare DENIED   -> nested containers are unavailable.
                                     Issue #55 is answered. Run ./run-probe.sh down
  anything else                   -> paste the output for a read
--------------------------------------------------------------------
EOF
}

cmd_full() {
  say "Starting the slow phase in the background"
  invoke start
  info "Give it several minutes. Production is 1 vCPU, so expect multiples of the 26s local baseline."
  info "Then: ./run-probe.sh results"
}

cmd_results() {
  say "Slow phase log"
  invoke results
  info "If it reports running: true, wait and run this again."
}

cmd_status() {
  load
  say "State"
  if [ -z "${PROBE_CP_ID:-}" ]; then info "nothing deployed"; return; fi
  info "capacity provider $PROBE_CP_ID"
  info "  status $(aws bedrock-agentcore-control get-capacity-provider --region "$REGION" \
      --capacity-provider-id "$PROBE_CP_ID" --query status --output text 2>/dev/null || echo gone)"
  info "runtime ${PROBE_RT_ID:-none}"
  info "session ${SESSION:-none}"
  aws ec2 describe-instances --region "$REGION" --include-managed-resources \
    --filters "Name=tag-key,Values=bedrock-agentcore:capacity-provider-id" \
    --query "Reservations[].Instances[?State.Name!='terminated'].[InstanceId,State.Name,InstanceType]" \
    --output table 2>/dev/null || true
}

cmd_down() {
  load
  say "Tearing down"
  # Runtimes must go before their capacity provider, or the delete is rejected.
  if [ -n "${PROBE_RT_ID:-}" ]; then
    aws bedrock-agentcore-control delete-agent-runtime --region "$REGION" \
      --agent-runtime-id "$PROBE_RT_ID" >/dev/null 2>&1 && info "runtime deleted" || info "runtime already gone"
  fi
  if [ -n "${PROBE_CP_ID:-}" ]; then
    aws bedrock-agentcore-control delete-capacity-provider --region "$REGION" \
      --capacity-provider-id "$PROBE_CP_ID" >/dev/null 2>&1 && info "capacity provider deleted (with its sessions and volumes)" || info "capacity provider already gone"
  fi
  aws ecr delete-repository --region "$REGION" --repository-name "$ECR_REPO" --force >/dev/null 2>&1 \
    && info "ECR repository deleted" || info "ECR repository already gone"

  say "Verifying (deletion is asynchronous; give it a minute)"
  sleep 45
  info "Any instance below tagged with ${PROBE_CP_ID:-the probe} should disappear shortly."
  aws ec2 describe-instances --region "$REGION" --include-managed-resources \
    --filters "Name=tag-key,Values=bedrock-agentcore:capacity-provider-id" \
    --query "Reservations[].Instances[?State.Name!='terminated'].[InstanceId,State.Name,Tags[?Key=='bedrock-agentcore:capacity-provider-id']|[0].Value]" \
    --output table 2>/dev/null || true
  rm -f "$HERE"/.probe-state "$HERE"/.prod-cp.json "$HERE"/.probe-cp*.json "$HERE"/.probe-rt.json \
        "$HERE"/.payload.json "$HERE"/.response.json "$HERE"/.invoke-*.json "$HERE"/.invoke-error.txt \
        "$HERE"/.probe-cp-error.txt
  info "local state cleared"
}

case "${1:-}" in
  preflight) cmd_preflight ;;
  up)        cmd_up ;;
  caps)      cmd_caps ;;
  full)      cmd_full ;;
  results)   cmd_results ;;
  status)    cmd_status ;;
  down)      cmd_down ;;
  *)         sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
esac
