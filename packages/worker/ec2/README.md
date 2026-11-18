# EC2 worker boot behavior

`boot.sh` is compressed into EC2 user data, so its source stays small to preserve the required 4 KB
configuration reserve. The details below document its operational boundaries without adding bytes to
the executable bootstrap.

## Failure reporting and volume discovery

Boot failures start a best-effort transient `/ping` responder outside cloud-init. It returns
`503` with `{"status":"BootFailed","reason":...}` so the provisioner can stop the session; if the
responder cannot start, the probe timeout still fails the session.

Nitro exposes EBS volumes as NVMe disks. The boot script identifies the requested volume by its
serial through `lsblk`, sysfs, or `/dev/disk/by-id`, and rescans PCI at 20, 50, and 80 seconds when
the kernel has not surfaced the disk. The elapsed counter includes sleeps so tests that stub sleep
retain the same retry thresholds.

The script formats only a blank volume created for the current generation. A blank volume expected
to contain an existing workspace indicates data loss or an incorrect attachment, so boot refuses to
format it. The workspace is recorded in `/etc/fstab`; systemd's `RequiresMountsFor=/mnt/workspace`
keeps the worker from starting against the root volume after a reboot without the EBS mount.

## Worker container

The root-owned worker launcher reconstructs the optional runtime bind each time systemd starts the
container. The backing directories live on the workspace EBS volume, and the unit orders startup
after that mount. An invalid or unavailable runtime path withholds verifier mounts while allowing
ordinary worker operations to use `/tmp`.

The worker shares the host network to serve port 8080 and reach instance credentials through IMDS
with hop limit 1. It receives the host Docker socket to run project devcontainers. The worker runs
as the `node` user in its container and has root-equivalent host access through the mounted Docker
socket. The workspace is mounted at the same host and container path so Docker bind mounts refer to
the same files. The worker removes other containers before a push, so the boot unit must remain the
only container that this script starts.

## Task sandbox

A project without a devcontainer runs a task's commands in a sandbox container that the worker
starts from its own image, so the worker's environment file carries two lines:
`AGENTX_SANDBOX_IMAGE` (the image the worker was launched from, which is already on the host) and
`AGENTX_RUNTIME=ec2`. The second makes the worker refuse to run a task's commands in its own
process, whatever else is set (the worker image also sets `AGENTX_WORKER_PROCESS_SCOPE=container`,
which the worker reads as the same mark). The sandbox mounts the workspace at the same path as the
worker does, which is why the worker's own mount keeps the host and container paths equal. The
sandbox has no Docker socket, no extra group, no capabilities and `no-new-privileges`, and joins a
plain user-defined bridge network (`agentx-task`); with `WorkerSandboxEgress=gateway` its network is the internal one described under "Sandbox egress gateway" below.

## Notes moved out of boot.sh (user data limit)

boot.sh is EC2 user data and sits at its size budget (tests/contract/ec2-boot-config.test.ts keeps 1.5 KB free), so these notes, which were comments in it, live here (DEC 254zm made room for the test-services hook):

- The provisioner validates the prepended configuration and gzip-compresses this script (#229).
- Boot failures exit non-zero and report on /ping so the provisioner can stop the session (#211).
- The node user of environments/base/Dockerfile, which the worker container runs as.
- Docker's data root, on the workspace volume: it survives an idle stop (#121).
- The provisioner attaches the volume after the instance is running, so it may appear late.
- Where /sys and /dev/disk are; tests set it.
- Network steps try 5 times (2, 4, 8, 16 s waits plus jitter): at most 45 s per step.
- No try runs past this many seconds from boot start, so failures show within /ping's 10 minutes.
- The worker's port, which the provisioner probes; a failed boot answers there instead.
- Where fail records its reason, since it may run in a command substitution's subshell.
- The time limit for one network try: LIMIT seconds, or less when the boot deadline is closer.
- retry DESCRIPTION COMMAND... retries with bounded backoff, then fails with DESCRIPTION.
- Commands in an until condition must return their own failures under set -e.
- Reports any non-zero exit: fail's reason, or the step that stopped (set -e).
- A reason left by an earlier run of this script in the same boot is not this run's.
- Prints the value only once whole, so a failed try leaves nothing behind.
- Prints "NAME SERIAL" for each NVMe disk in sysfs, without the serial's padding.
- A failed try may leave stale mirror metadata (#211): dropped before the next try.
- A oneshot unit re-applies the rules after Docker rebuilds its chains.
- This optional preload is bounded; failure leaves ordinary worker service available.
- Optional until EXECUTOR_IMAGE is set; without it only end-to-end checks are withheld.
- The web/API runtime's browser executor; docker exec agentx-worker processes read it here too.
- Status objects also carry the executor image and /ping's features (test-deploy --check).
- The preload is optional but the qualification needs the executor image: pull it if missing.
- The instance ID is the one boot read from instance metadata.

## Test services on Code's workers (DEC 254zm)

A launch carries `AGENTX_TEST_SERVICES=1` only while the install's TestServiceImages setting is `mirrored` (the five starter copies were made and checked, `scripts/test-services-mirror.ts`). boot.sh then copies `test-services-stage.sh` out of the worker image it pulled by digest (no network, no capability) and runs it after the worker environment is written and before the worker starts. The stage never stops the boot: any failure leaves the worker without test services, and the worker launcher mounts the run directory into the worker only while it is mounted.

## Sandbox egress gateway (L4-NETG, DEC 254zzz77)

Agent code runs in containers on the worker host itself: task sandboxes on the `agentx-task` bridge, and the project's devcontainer on Docker's default bridge. Both are NATed out through the host's own network card and the worker security group lets TCP 443 reach any address, so with `WorkerSandboxEgress=bridge` (the default, today's behaviour) a sandbox can open HTTPS to any IP: a registry, an attacker's host, DNS-over-HTTPS by address (which skips the VPC DNS firewall). A subnet or VPC split cannot separate them from the host (they share its address), so with `agentx config set workerSandboxEgress gateway` the split is made on the host:

- A launch carries `AGENTX_SANDBOX_EGRESS=gateway`. boot.sh copies `sandbox-egress.sh` out of the worker image (by digest, no network, no capability) and runs it after the worker unit and the test-services stage, before the worker starts. Unlike the test-services stage, **any failure fails the boot** (the provisioner reports it on /ping): a worker never starts with sandboxes that could still reach the internet some other way. Set `gateway` only once the installed release carries the stage (a worker image without it fails the boot).
- `rovara-snet` (bridge `rvs0`, 172.28.250.0/24, `--internal`, no host address, no default route) is the only network task sandboxes, the setup run's sandbox, eval install boxes and devcontainers join. `rovara-xnet` (bridge `rvx0`, 172.28.251.0/24) is the gateway's way out. `rovara-egw` is the laptop's egress gateway program (contracts `egress-gateway-source.ts`, "host" mode) on both: the sandboxes' only name server (172.28.250.2) and a forwarder of HTTPS by TLS name (80 by Host) to public addresses it resolved itself, for the names the install's VPC resolver answers (the DNS firewall's allow lists apply, a blocked name is NXDOMAIN to the sandbox too), **except** the push-capable registries (contracts `sandbox-deny-domains.ts`, pinned by a test), which only the sandbox side loses.
- Walls (same shape as `wall_off_containers`, which is untouched): nothing leaves `rvs+`, the host's INPUT is dropped from `rvs+` and `rvx+`, and the gateway's way out loses the private ranges and the metadata range except the host's resolvers on port 53.
- The worker's environment gets `AGENTX_SANDBOX_EGRESS=gateway`, `AGENTX_SANDBOX_NETWORK=rovara-snet`, `AGENTX_SANDBOX_DNS=172.28.250.2`. With them the worker puts every sandbox on that network with `--dns` the gateway and refuses (RUNTIME_UNAVAILABLE) to start one without either; the devcontainer CLI runs through `devcontainer-docker.sh`, which adds `--network`, `--dns` and `--cap-drop NET_RAW` to `docker run` and `docker create`, and the worker's `walledNetwork` policy checks the started container.
- A unit (`rovara-sandbox-egress.service`, required by the worker unit) puts the walls and the gateway back after a reboot or a Docker restart, and the worker does not start if it cannot.
- Unchanged: the host's own Docker (image pulls from every registry), the worker container (`--network host`), the sealed `rvi*`/`rvb*` test-service and check networks, the IMDS drop, and Rovara's own services (the in-VPC functions, the Slack orchestrator, SWE-bench runners). **Not covered (residuals, stated in the PR):** the build steps of a dev container image (Dockerfile `RUN`, features' install scripts; the wrapper passes `build` through) and the end-to-end verifier's build commands on the `rvb*` bridges still reach the internet through the host; `docker0` and `agentx-task` stay as they were (nothing the worker starts for task code joins them in gateway mode, but they are not walled); names the install's VPC list allows and the gateway therefore forwards (S3 buckets of any account, `github.com` push, a project's own additions); SNI/Host fronting through a shared front end; the deny list matches names, not CNAME targets or addresses. A dev container made before the host was walled (Docker's data root survives on the workspace volume) is removed before `up` when it is not on the walled network (`ensureDevcontainer`).
- Rollback: `agentx config set workerSandboxEgress bridge`. Workers booted from then on are as before; a gateway-mode worker keeps its boot until it stops.
