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
- **Builds (L4-NETG2, DEC 254zzz90).** A dev container's image build (`docker build`: Dockerfile `RUN`, features' `install.sh`) and the verifier's contained end-to-end build commands (`npm ci`, the recipe's build) run repository-controlled code too, so they join `rovara-snet` as well:
  - `devcontainer-docker.sh` adds `--network rovara-snet` to `docker build` (also `image build` and `builder build`) and refuses a build that names its own `--network`/`--net`. It refuses `buildx` outright (BuildKit takes only default/none/host, so it could not be walled): the devcontainer CLI then uses the classic builder, which does take a named network. A build has no `--dns` option, so the stage makes the gateway the Docker daemon's default name server (`"dns": ["172.28.250.2"]` added to `/etc/docker/daemon.json`, Docker restarted once, the container firewall put back); the gateway itself is created with the host's own resolvers as `--dns`. **A daemon-wide default reaches every container that has no `--dns` of its own**, so the stage also writes the host's non-loopback resolvers to `/etc/agentx/worker-dns` and the worker's launcher (boot.sh) gives the host-network worker container `--dns` for each of them (without it the worker, which has no route to the gateway, could not resolve any name); the boot probe checks the registry name is refused from a container with no `--dns` too, so a daemon that was not restarted on the new file fails the boot. Containers started by the worker for trusted work carry their own `--dns` (sealed networks) or have no network.
  - The verifier's `buildEgress` (set from the worker's `AGENTX_SANDBOX_NETWORK`/`AGENTX_SANDBOX_DNS` in gateway mode, for candidate code) puts the build containers on that network with `--dns` the gateway, instead of the run's own `rvb*` bridge (not made then). The source copy still has `--network none`. A gateway-mode worker that lost either value offers no application checks. The install qualification's probe builds and the model driving test's builds are Rovara's own pinned fixtures, never candidate code: they keep their `rvb*` bridge (so the qualification's lateral-denial probe still tests the wall it was written for) and are given the host's resolvers as `--dns` (`buildDnsFromEnvironment`, read from the worker container's resolv.conf), because the daemon's default name server is now the gateway, which that bridge cannot reach.
  - Registry pulls for `FROM` lines and features' OCI artifacts are the host Docker's and the devcontainer CLI's own (host network), not the build's, so they keep working; a `RUN` step reaches only the names the install's DNS list allows, never a push-capable registry, never a raw address.
  - `docker0` and the old `agentx-task` bridge are walled in gateway mode (`DOCKER-USER -i <bridge> -j DROP`, `INPUT -i <bridge> -j DROP`, also ip6tables INPUT; `agentx-task` is removed if nothing holds it, else walled by its `br-<id>` name). The saved-environment builder (trusted, `FROM scratch`, `--network none`) and the host's own Docker pulls (host network) are unaffected. The restore unit also checks the daemon default name server and re-applies these walls.
- Unchanged: the host's own Docker (image pulls from every registry), the worker container (`--network host`), the sealed `rvi*` test-service and check networks and the `rvb*` setup-run bridges, the IMDS drop, and Rovara's own services (the in-VPC functions, the Slack orchestrator, SWE-bench runners). **Residuals (stated in the PR):** names the install's VPC list allows and the gateway therefore forwards (S3 is now denied to sandboxes except bucket hosts a project lifted through its allowed websites; a lifted bucket host is region-wide S3 for that project by Host-header fronting, the lift is customer-approved with no Rovara staff step, and for the install region the VPC list already allows `*.s3.<region>`; `github.com` push; a project's own additions); SNI/Host fronting through a shared front end; the deny list matches names, not CNAME targets or addresses; ICC between containers on `rvs0` (a build and a sandbox of the same workspace); build `RUN` containers keep root and NET_RAW (a classic build cannot drop capabilities), so a build step can forge packets on `rvs0` toward the gateway and the same workspace's sandboxes, though nothing can leave the bridge; **the Docker daemon's own fetches during a build are on the HOST network, outside the walled `RUN` containers**: `ADD <url>` (a GET), a `FROM` registry address, and the devcontainer CLI's feature downloads (tarball URLs and OCI references to any host, fetched by the host-network worker container) can reach any address the worker security group allows (443 to anywhere, including private VPC addresses) and, from the host network, the host's own loopback and the host-side addresses of local Docker bridges of the same workspace (GET only); the instance metadata service needs a token and `ADD` sends none. All of these can carry workspace data in a URL. In gateway mode the install qualification's build probes exercise the trusted `rvb*` path, not the `rovara-snet` path candidates use (the boot probe covers that one), so a qualification PASS says nothing about candidate builds. Closing it means refusing remote `ADD` and a `FROM` outside an allow list before the build (devcontainer-policy reads the Dockerfile); it is recorded in the deferred-checks register (DEFERRED-CHECKS.md, 2026-11-18 L4-NETG2 row); the owner has NOT yet decided: this PR does not close it. The worker image carries the buildx plugin (the saved-environment builder's own pinned rootless builder uses it, never through the wrapper), so the WRAPPER keeps every devcontainer build on the classic builder, the only one that takes the walled network: it sets `DOCKER_BUILDKIT=0`, removes every `BUILDX_*`/`BUILDKIT_*` variable, refuses the buildx-only options, a docker config with an `aliases` entry (`docker buildx install`) and every `docker buildx ...` command, and a test per channel (plus a scan that only `saved-env/build.ts` names buildx) fails if one opens; a build that reached BuildKit would fail on the named network, never run unwalled. A dev container made before the host was walled (Docker's data root survives on the workspace volume) is removed before `up` when it is not on the walled network (`ensureDevcontainer`).
- Rollback: `agentx config set workerSandboxEgress bridge`. Workers booted from then on are as before; a gateway-mode worker keeps its boot until it stops.
