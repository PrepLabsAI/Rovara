#!/bin/bash
# Switch-on check for the worker sandbox egress gateway (L4-NETG, DEC 254zzz77 / 254zzz90). Run it AS ROOT ON ONE GATEWAY-MODE WORKER (for example through SSM Run Command), after the worker booted with
# `agentx config set workerSandboxEgress gateway`. It executes every check of the PR's switch-on list: from inside a sandbox, from inside a dev container (through the devcontainer wrapper), and on the host, and prints one line per
# check, `PASS`, `FAIL` or `SKIP`, then a summary. Exit status 0 only when nothing FAILed.
#
# READ-ONLY and secret-free: it starts throw-away containers (`--rm`, `--pull=never`, from the worker image already on the host), makes one container that it removes, reads no secret and prints none. Of the worker's environment file it prints only the
# three non-secret egress settings. It never writes to the workspace, the gateway, the firewall or the control plane, and makes no AWS call. Outbound traffic: HTTPS requests to public package registries and to the registries it is checking are refused.
#
# Run it on an IDLE worker (its throw-away containers take free addresses on the sandbox network). Usage: sudo bash worker-egress-check.sh        (WORKER_EGRESS_CHECK_QUICK=1 skips the package-install checks)
set -u
readonly ENV_FILE=${WORKER_EGRESS_ENV_FILE:-/etc/agentx/worker.env}
readonly IMAGE_FILE=${WORKER_EGRESS_IMAGE_FILE:-/etc/agentx/worker-image}
readonly WRAPPER=${WORKER_EGRESS_WRAPPER:-/opt/agentx/packages/worker/ec2/devcontainer-docker.sh}
readonly NET=rovara-snet
readonly GATEWAY=rovara-egw
readonly GATEWAY_OUTER_IP=172.28.251.2
readonly PROBE_NAME=rovara-egress-check-devcontainer

pass=0; fail=0; skip=0
report() { # status id description [detail]
  printf '%-5s %-5s %s%s\n' "$1" "$2" "$3" "${4:+  ($4)}"
  case "$1" in PASS) pass=$((pass + 1)) ;; FAIL) fail=$((fail + 1)) ;; *) skip=$((skip + 1)) ;; esac
}
expect() { # id description wanted-regex got
  if [[ "$4" =~ $3 ]]; then report PASS "$1" "$2" "$4"; else report FAIL "$1" "$2" "wanted /$3/, got: ${4:-nothing}"; fi
}

envvalue() { sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | head -n1; }
IMAGE=$(cat "$IMAGE_FILE" 2>/dev/null || true)
REGION=$(envvalue AWS_REGION)
CONTROL_PLANE=$(envvalue AGENTX_CONTROL_PLANE_URL)

cleanup() { docker rm --force "$PROBE_NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# ---- the probes: each prints ONE token. Node runs inside the container with a 6 s ceiling on every connection.
CONNECT='const n=require("net");const s=n.connect({host:process.argv[1],port:Number(process.argv[2]),timeout:5000});s.on("connect",()=>{console.log("open");process.exit(0)});s.on("timeout",()=>{console.log("timeout");process.exit(0)});s.on("error",e=>{console.log(e.code);process.exit(0)});'
LOOKUP='require("dns").lookup(process.argv[1],{family:4},(e,a)=>{console.log(e?e.code:a);process.exit(0)});'
FETCH='const h=require("https");const r=h.get(process.argv[1],{timeout:8000,rejectUnauthorized:false},res=>{console.log("status "+res.statusCode);res.resume();res.on("end",()=>process.exit(0))});r.on("timeout",()=>{console.log("timeout");process.exit(0)});r.on("error",e=>{console.log("error "+e.code);process.exit(0)});'
SNI='const t=require("tls");const s=t.connect({host:process.argv[1],port:443,servername:process.argv[2],rejectUnauthorized:false,timeout:5000});s.on("secureConnect",()=>{console.log("handshake");process.exit(0)});s.on("timeout",()=>{console.log("timeout");process.exit(0)});s.on("error",e=>{console.log("error "+e.code);process.exit(0)});'
UNREACHABLE='^(ENETUNREACH|EHOSTUNREACH|timeout)$'
NOT_RESOLVED='^ENOTFOUND$'

# in_sandbox <probe> <args...>: a sandbox's place, exactly as the worker starts one (internal network, the gateway as its only name server, no capability).
in_sandbox() {
  local probe=$1; shift
  timeout 60 docker run --rm --pull=never --network "$NET" --dns "$GATEWAY_IP" --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
    --entrypoint /usr/local/bin/node "$IMAGE" -e "$probe" "$@" 2>/dev/null | tail -n1
}
# in_devcontainer <probe> <args...>: the same, started through the devcontainer wrapper (which adds the network, the name server and --cap-drop NET_RAW).
in_devcontainer() {
  local probe=$1; shift
  AGENTX_SANDBOX_NETWORK=$NET AGENTX_SANDBOX_DNS=$GATEWAY_IP timeout 60 "$WRAPPER" run --rm --pull=never --user 1000:1000 --entrypoint /usr/local/bin/node "$IMAGE" -e "$probe" "$@" 2>/dev/null | tail -n1
}

echo "worker-egress-check: $(date -u +%Y-%m-%dT%H:%M:%SZ) host $(hostname)"

# ---- H: the host's own wiring
[[ -n "$IMAGE" ]] || { report FAIL H0 "the worker image is known" "no $IMAGE_FILE"; echo "SUMMARY pass=$pass fail=$fail skip=$skip"; exit 1; }
settings=$(grep -E '^AGENTX_SANDBOX_(EGRESS|NETWORK|DNS)=' "$ENV_FILE" 2>/dev/null | sort | paste -sd' ' -)
expect H1 "the worker was booted in gateway mode (egress, network and name server are set)" '^AGENTX_SANDBOX_DNS=172\.28\.250\.2 AGENTX_SANDBOX_EGRESS=gateway AGENTX_SANDBOX_NETWORK=rovara-snet$' "$settings"
GATEWAY_IP=$(envvalue AGENTX_SANDBOX_DNS)
[[ "$GATEWAY_IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || GATEWAY_IP=172.28.250.2
expect H2 "the sandbox network is an internal bridge with no host address and no IPv6" '^bridge\|true\|true\|false$' \
  "$(docker network inspect --format '{{.Driver}}|{{.Internal}}|{{index .Options "com.docker.network.bridge.inhibit_ipv4"}}|{{.EnableIPv6}}' "$NET" 2>&1 | tail -n1)"
expect H3 "the gateway is running, restarts with Docker, is read-only with every capability dropped, on exactly its two networks" '^true\|unless-stopped\|true\|\[ALL\]\|rovara-snet rovara-xnet $' \
  "$(docker inspect --format '{{.State.Running}}|{{.HostConfig.RestartPolicy.Name}}|{{.HostConfig.ReadonlyRootfs}}|{{.HostConfig.CapDrop}}|{{range $n, $c := .NetworkSettings.Networks}}{{$n}} {{end}}' "$GATEWAY" 2>&1 | tail -n1)"
for rule in "DOCKER-USER -i rvs+ ! -o rvs+ -j DROP" "INPUT -i rvs+ -j DROP" "INPUT -i rvx+ -j DROP" "DOCKER-USER -d 169.254.169.254/32 -j DROP"; do
  # shellcheck disable=SC2086
  if iptables -C $rule 2>/dev/null; then report PASS H4 "firewall rule present: $rule"; else report FAIL H4 "firewall rule present: $rule" "missing"; fi
done
if systemctl is-active --quiet rovara-sandbox-egress.service 2>/dev/null; then report PASS H5 "the restore unit rovara-sandbox-egress.service is active"; else report FAIL H5 "the restore unit rovara-sandbox-egress.service is active" "not active"; fi
ping_body=$(curl -s -m 5 http://127.0.0.1:8080/ping 2>/dev/null || true)
expect H6 "the worker answers /ping healthy" '"status":"Healthy"' "$(printf '%s' "$ping_body" | tr -d ' ' | head -c 300)"
expect H7 "the host reaches the control plane (the worker's callbacks and model calls go from the host, not a sandbox)" '^(200|204|301|302|400|401|403|404)$' "$(curl -s -m 8 -o /dev/null -w '%{http_code}' "${CONTROL_PLANE:-https://127.0.0.1:1}" 2>/dev/null || true)"
for site in ghcr.io registry-1.docker.io gcr.io; do
  expect H8 "the HOST still reaches $site (its image pulls are unchanged)" '^(200|301|302|307|401|403|404)$' "$(curl -s -m 10 -o /dev/null -w '%{http_code}' "https://$site/v2/" 2>/dev/null || true)"
done
expect H9 "the host's git works over HTTPS (read check; the worker's clone and push use this path)" '^[0-9a-f]{40}[[:space:]]+HEAD$' "$(timeout 30 git ls-remote https://github.com/git/git.git HEAD 2>/dev/null | head -n1)"

expect H10 "the project S3 lift is wired: the worker container mounts the allow folder read-write and the gateway read-only" '^rw\|ro$' \
  "$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/rovara-egress"}}{{if .RW}}rw{{else}}ro{{end}}{{end}}{{end}}' agentx-worker 2>/dev/null | head -n1)|$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/rovara-egress"}}{{if .RW}}rw{{else}}ro{{end}}{{end}}{{end}}' "$GATEWAY" 2>/dev/null | head -n1)"

# ---- S: from inside a sandbox
for target in "1.1.1.1 443" "8.8.8.8 443" "140.82.112.4 443"; do
  # shellcheck disable=SC2086
  set -- $target
  expect S1 "a raw-IP HTTPS connection to $1 fails (no route)" "$UNREACHABLE" "$(in_sandbox "$CONNECT" "$1" "$2")"
done
expect S2 "DNS-over-HTTPS by address fails (https://1.1.1.1/dns-query)" '^(error (ENETUNREACH|EHOSTUNREACH)|timeout)$' "$(in_sandbox "$FETCH" "https://1.1.1.1/dns-query?name=example.com&type=A")"
for name in ghcr.io registry-1.docker.io gcr.io us-docker.pkg.dev quay.io public.ecr.aws; do
  expect S3 "the registry name $name does not resolve" "$NOT_RESOLVED" "$(in_sandbox "$LOOKUP" "$name")"
done
expect S3 "an ECR registry endpoint does not resolve" "$NOT_RESOLVED" "$(in_sandbox "$LOOKUP" "123456789012.dkr.ecr.${REGION:-us-west-2}.amazonaws.com")"
expect S4 "https://ghcr.io/v2/ fails from a sandbox" '^error ' "$(in_sandbox "$FETCH" "https://ghcr.io/v2/")"
for name in ghcr.io registry-1.docker.io; do
  expect S5 "a TLS hello for $name sent straight to the gateway is refused (pointing a client at the gateway does not help)" '^error ' "$(in_sandbox "$SNI" "$GATEWAY_IP" "$name")"
done
expect S6 "S3 is denied to a sandbox (the path-style host s3.${REGION:-us-west-2}.amazonaws.com never resolves: a project cannot lift it)" "$NOT_RESOLVED" "$(in_sandbox "$LOOKUP" "s3.${REGION:-us-west-2}.amazonaws.com")"
expect S6 "an S3 bucket name does not resolve (a bucket nobody lifted)" "$NOT_RESOLVED" "$(in_sandbox "$LOOKUP" "rovara-egress-check-nobody.s3.${REGION:-us-west-2}.amazonaws.com")"
for name in registry.npmjs.org pypi.org github.com; do
  expect S7 "the allowed name $name resolves to the gateway" "^$GATEWAY_IP\$" "$(in_sandbox "$LOOKUP" "$name")"
done
expect S8 "an allowed site is reachable through the gateway (https://registry.npmjs.org/)" '^status [0-9]{3}$' "$(in_sandbox "$FETCH" "https://registry.npmjs.org/")"
expect S9 "the metadata address is unreachable" "$UNREACHABLE|^ECONNREFUSED$" "$(in_sandbox "$CONNECT" 169.254.169.254 80)"
expect S9 "a private address is unreachable (10.0.0.1:443)" "$UNREACHABLE|^ECONNREFUSED$" "$(in_sandbox "$CONNECT" 10.0.0.1 443)"
expect S9 "the gateway's outer address is unreachable ($GATEWAY_OUTER_IP:443)" "$UNREACHABLE|^ECONNREFUSED$" "$(in_sandbox "$CONNECT" "$GATEWAY_OUTER_IP" 443)"
if [[ "${WORKER_EGRESS_CHECK_QUICK:-}" == 1 ]]; then
  report SKIP S10 "package installs work (npm view, pip download)" "WORKER_EGRESS_CHECK_QUICK=1"
else
  npm_out=$(timeout 90 docker run --rm --pull=never --network "$NET" --dns "$GATEWAY_IP" --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m --env HOME=/tmp \
    --entrypoint npm "$IMAGE" view is-odd version --registry https://registry.npmjs.org/ 2>/dev/null | tail -n1)
  expect S10 "npm reaches its registry through the gateway (npm view is-odd version)" '^[0-9]+\.[0-9]+\.[0-9]+$' "$npm_out"
  pip_out=$(timeout 120 docker run --rm --pull=never --network "$NET" --dns "$GATEWAY_IP" --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m --env HOME=/tmp \
    --entrypoint sh "$IMAGE" -c 'python3 -m pip download --no-deps --quiet -d /tmp/pip six && ls /tmp/pip' 2>&1 | tail -n1)
  if [[ "$pip_out" == *"No module named pip"* || "$pip_out" == *"python3: not found"* ]]; then report SKIP S10 "pip reaches PyPI through the gateway (pip download six)" "no pip in the worker image"
  else expect S10 "pip reaches PyPI through the gateway (pip download six)" '^six-.*\.(whl|tar\.gz)$' "$pip_out"; fi
fi

# ---- D: from inside a dev container, through the wrapper
if [[ ! -x "$WRAPPER" ]]; then
  report FAIL D0 "the devcontainer wrapper is in the worker image" "$WRAPPER missing"
else
  docker rm --force "$PROBE_NAME" >/dev/null 2>&1 || true
  if AGENTX_SANDBOX_NETWORK=$NET AGENTX_SANDBOX_DNS=$GATEWAY_IP "$WRAPPER" create --name "$PROBE_NAME" --pull=never --entrypoint /usr/local/bin/node "$IMAGE" -e 'setTimeout(()=>{},1000)' >/dev/null 2>&1; then
    expect D1 "a dev container started through the wrapper is on the sandbox network alone, with the gateway as its only name server and NET_RAW dropped" "^$NET\\|\\[$GATEWAY_IP\\]\\|\\[NET_RAW\\]\\|$NET \$" \
      "$(docker inspect --format '{{.HostConfig.NetworkMode}}|{{.HostConfig.Dns}}|{{.HostConfig.CapDrop}}|{{range $n, $c := .NetworkSettings.Networks}}{{$n}} {{end}}' "$PROBE_NAME" 2>&1 | tail -n1)"
    docker rm --force "$PROBE_NAME" >/dev/null 2>&1 || true
  else
    report FAIL D1 "a dev container can be created through the wrapper" "create failed"
  fi
  expect D2 "a raw-IP HTTPS connection fails from a dev container" "$UNREACHABLE" "$(in_devcontainer "$CONNECT" 1.1.1.1 443)"
  expect D3 "ghcr.io does not resolve from a dev container" "$NOT_RESOLVED" "$(in_devcontainer "$LOOKUP" ghcr.io)"
  expect D3 "registry-1.docker.io does not resolve from a dev container" "$NOT_RESOLVED" "$(in_devcontainer "$LOOKUP" registry-1.docker.io)"
  expect D4 "an allowed name works from a dev container (registry.npmjs.org resolves to the gateway)" "^$GATEWAY_IP\$" "$(in_devcontainer "$LOOKUP" registry.npmjs.org)"
  refused=$(env -u AGENTX_SANDBOX_NETWORK -u AGENTX_SANDBOX_DNS "$WRAPPER" run --rm "$IMAGE" true >/dev/null 2>&1; echo $?)
  expect D5 "the wrapper starts nothing when its network settings are missing (fails closed)" '^125$' "$refused"
fi

# ---- not checkable from the host: said plainly so the controller does them
report SKIP X1 "model and gateway calls from a task, a normal task and a devcontainer task, test services start" "run one real task and watch it; this script starts none"
report SKIP X2 "the DNS firewall query log shows sandbox queries only via the gateway" "read it with staging-aws.sh; this script makes no AWS call"
report SKIP X3 "the restore unit after a real stop and start of the instance" "stop and start the instance once, then run this script again"

echo "SUMMARY pass=$pass fail=$fail skip=$skip"
if ((fail == 0)); then echo "RESULT PASS"; exit 0; fi
echo "RESULT FAIL"
exit 1
