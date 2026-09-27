# Devcontainer nested-container probe (issue #55)

Throwaway probe answering one question: does the AgentCore Instances runtime permit nested
containers, so that a project's own `devcontainer.json` could define the coding environment?

Everything here is disposable, but kept: it is the artifact backing the result below.

## Result: nested containers are unavailable (2026-09-27)

Run against a clone of the production capacity provider. **#55 is closed on the merits.**

```
uid                          0 (root)
CapEff                       0000000000000000
Seccomp                      2
cap_sys_admin                absent
unshare -Ur                  DENIED
unshare -m                   DENIED
/dev/fuse                    (absent)
containerd.sock              (absent)
docker.sock                  (absent)
```

Root with an **empty effective capability set**. All three prerequisites for a nested container
fail independently: no user namespace (the kernel permits them — `max_user_namespaces` is
2147483647 — but seccomp filter mode blocks the syscall), no mount namespace (needs
`CAP_SYS_ADMIN`), and no layered filesystem (no `/dev/fuse`, and `vfs` still needs a mount
namespace). No fallback survives.

The root + `CAP_SYS_ADMIN` + writable-containerd-socket combination reported for AgentCore microVMs
is **microVM-specific** and does not apply to the Instances compute type.

Also measured: workspace volume 19 GiB free of 20, root filesystem 30 of 38 GiB, 1 vCPU,
3.7 GiB RAM — confirming `volumeSizeGiB ?? 20` and `m6g.medium` from
`infra/lib/production-foundation.ts`.

Re-run this if AWS ever loosens the runtime sandbox; that is the only way we would notice.

## What it reports

| Phase | Cost | Reports |
|---|---|---|
| `caps` | seconds, synchronous | uid, effective capabilities, user namespaces, `/dev/fuse`, subuid/subgid, cgroup version, workspace filesystem and free space, memory, CPUs |
| `start` | minutes, background | launches the full suite, writing to `/mnt/workspace/.probe/full.log` |
| `results` | seconds | returns that log and whether it finished |

The full suite adds: podman version and chosen storage driver, a timed `podman run`, a timed
`devcontainer up` against a fixture with an `image:` plus one feature, `devcontainer exec` to
confirm both toolchains, and image-store size against remaining free space.

`probe.sh` never exits non-zero. A refused capability is a result, not an error.

## Validated locally before deploying

Built `--platform linux/arm64` and run under Docker on 2026-09-25:

- The capability decoder discriminates: `cap_sys_admin absent` unprivileged, `PRESENT` under
  `--privileged`. It decodes bit 21 of `CapEff` rather than grepping `capsh --print`, whose
  bounding-set line matches the name even when the effective set does not hold it.
- Under `--privileged`, the full suite passes: podman 4.3.1, `overlay` driver, `podman run` in 1s,
  `devcontainer up` in 26s, `devcontainer exec` returning Python 3.12.14 and Node v24.21.0.

So a failure against AgentCore is a finding about AgentCore, not about this script.

Two things to read correctly in the output:

- Podman logs `level=error msg="The storage 'driver' option must be set ..."`. Expected. The driver
  is deliberately left unset so podman picks one and the probe can report the real choice,
  including a fallback to `vfs`. Podman proceeds normally.
- Local timings came from 4 vCPUs. Production is `m6g.medium` (1 vCPU, 4 GiB), so expect the
  `devcontainer up` figure to be several times larger.

## Running it

Requires `AGENTX_REGION=us-east-1` and credentials that can create an ECR repository, a capacity
provider, and an agent runtime. Deploy steps are run by a human, not by an agent.

### 1. Clone the production capacity provider

Read the live configuration rather than re-deriving it, so subnets, security group, operator role,
instance type and AMI match production exactly.

```sh
PROD_CP_ARN=$(aws cloudformation describe-stacks --region us-east-1 \
  --stack-name AgentXProductionFoundation \
  --query "Stacks[0].Outputs[?OutputKey=='CapacityProviderArn'].OutputValue" --output text)

aws bedrock-agentcore-control get-capacity-provider --region us-east-1 \
  --capacity-provider-id "${PROD_CP_ARN##*/}" > /tmp/prod-cp.json
```

Build the probe capacity provider from that file, changing only the name. A duplicate keeps the
experiment fully isolated: `delete-capacity-provider` then tears down the probe's instance, volume
and sessions in one call, and no association is left on the production capacity provider that would
have to be removed before it could ever be deleted.

```sh
jq '{
  name: "agentx_devcontainer_probe",
  permissionsConfiguration: .permissionsConfiguration,
  computeConfiguration: .computeConfiguration
}' /tmp/prod-cp.json > /tmp/probe-cp.json

aws bedrock-agentcore-control create-capacity-provider --region us-east-1 \
  --cli-input-json file:///tmp/probe-cp.json
```

Poll `get-capacity-provider` until the status is `READY`.

### 2. Build and push the probe image

`linux/arm64`, matching `AGENTX_PRODUCTION_OPERATING_SYSTEM`.

```sh
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REPO="$ACCOUNT.dkr.ecr.us-east-1.amazonaws.com/agentx-devcontainer-probe"

aws ecr create-repository --region us-east-1 --repository-name agentx-devcontainer-probe
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin "${REPO%/*}"

docker build --platform linux/arm64 -t "$REPO:probe" environments/devcontainer-probe
docker push "$REPO:probe"
```

### 3. Create the probe runtime

Mount the capacity provider's `workspace` volume at `/mnt/workspace`, matching production.

```sh
aws bedrock-agentcore-control create-agent-runtime --region us-east-1 \
  --agent-runtime-name agentx_devcontainer_probe \
  --role-arn "$(aws cloudformation describe-stacks --region us-east-1 \
      --stack-name AgentXProductionRuntime \
      --query "Stacks[0].Outputs[?OutputKey=='RuntimeExecutionRoleArn'].OutputValue" --output text)" \
  --agent-runtime-artifact "{\"containerConfiguration\":{\"containerUri\":\"$REPO:probe\"}}" \
  --capacity-provider-configuration "{\"capacityProviderArn\":\"<probe capacity provider arn>\"}" \
  --filesystem-configurations '[{"capacityProviderVolume":{"volumeName":"workspace","mountPath":"/mnt/workspace"}}]'
```

### 4. Invoke, in three steps

`runtimeSessionId` must be at least 33 characters. Use a fresh one so the probe gets its own instance.

```sh
SESSION="devcontainer-probe-$(uuidgen)"
ARN="<probe runtime arn>"

inv() { echo "{\"phase\":\"$1\"}" > /tmp/p.json
        aws bedrock-agentcore invoke-agent-runtime --region us-east-1 \
          --agent-runtime-arn "$ARN" --runtime-session-id "$SESSION" \
          --qualifier DEFAULT --payload fileb:///tmp/p.json /tmp/out.json >/dev/null
        jq -r '.output // .log // .' /tmp/out.json; }

inv caps      # first call also provisions the instance, so it is the slow one
inv start
sleep 300
inv results
```

The first invocation includes EC2 provisioning and an image pull, so it takes minutes. If `results`
reports `running: true`, wait and call it again.

### 5. Tear down

```sh
aws bedrock-agentcore-control delete-agent-runtime --region us-east-1 --agent-runtime-id <id>
aws bedrock-agentcore-control delete-capacity-provider --region us-east-1 \
  --capacity-provider-id agentx_devcontainer_probe-<suffix>
aws ecr delete-repository --region us-east-1 --repository-name agentx-devcontainer-probe --force
```

Deleting the capacity provider removes its sessions, instances and EBS volumes. Confirm nothing is
left behind:

```sh
aws ec2 describe-instances --region us-east-1 --include-managed-resources \
  --filters "Name=tag-key,Values=bedrock-agentcore:capacity-provider-id" \
  --query 'Reservations[].Instances[?State.Name!=`terminated`].[InstanceId,State.Name]'
```

Cost while running is one `m6g.medium` plus a 20 GiB gp3 volume — cents per hour, but it does not
stop on its own until the capacity provider's `maxLifetime` expires.

## Reading the result

| Outcome | Meaning |
|---|---|
| `unshare -Ur DENIED` and `uid` non-zero | Dead. No path to nested containers. |
| `uid 0` and `cap_sys_admin PRESENT`, driver `overlay` | Best case. Rootful podman, real performance. |
| driver `fuse-overlayfs` | Works, ~10–30% slower I/O. Acceptable. |
| driver `vfs` | Treat as a fail. Check `store_size_after` before believing otherwise. |
| `devcontainer_up ok` under ~3 min | Viable interactive loop. |
| `containerd.sock` writable | Recorded only. #55 states we do not build on the host runtime socket. |

### Sizing, independent of the verdict

The local run needed **1.7 GB** of image store for one `python:3.12-slim` devcontainer with a single
feature. The production workspace volume defaults to 20 GiB (`volumeSizeGiB ?? 20`,
`infra/lib/production-foundation.ts:102`) and already holds the repository checkout, dependencies and
caches. Real devcontainers are larger than the fixture, and a `vfs` fallback multiplies this. If the
spike passes, raising `volumeSizeGiB` is part of the work, not an afterthought.
