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
plain user-defined bridge network (`agentx-task`); its network walls are a separate step.

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

The GCP stand-in pack (L4-E8I, off by default): when the install's TestServicesGcpPack setting names a group, the launch also carries `ROVARA_TEST_SERVICES_GCP_PACK` (for example `mirrored:pulled`) and the stage pulls the pack's images beside the starters: the mirrored ones (Spanner, fake-gcs-server, BigQuery) from this account's ECR, and Google's SDK emulators image BY DIGEST from `gcr.io` or `us-docker.pkg.dev` (anonymous, HTTPS, by root on the host; never copied into our ECR). The egress those two names need is VPC-wide while the `pulled` group is on (one DNS firewall allow list), not worker-only; the sealed run networks are unaffected. The pull is the host's, like every other pull: it changes no firewall rule, network or address pool, and the sealed run networks stay without a route out. A pack image that fails to arrive is left out of the owner list and never costs the starters.
