# Implementation Plan: EC2 Worker Boot Script

**Branch**: `feat/081-ec2-boot-script` | **Date**: 2026-09-27 | **Spec**: [spec.md](spec.md)

The script is a real file, `packages/worker/ec2/boot.sh`, so it can be shellchecked and run. RunInstances
user data replaces a launch template's, so the provisioner renders user data per launch:
`ec2WorkerUserData(config, bootScript)` in `packages/contracts/src/session.ts` validates an
`Ec2WorkerBootConfig` and prepends it as single-quoted exports. How the script text reaches the
provisioning Lambda (for example an esbuild text loader) is #83's choice.

The worker runs under a systemd unit rather than a Docker restart policy, so `RequiresMountsFor` can
keep it from starting on an unmounted path. Region and instance ID come from IMDSv2. Docker is installed
with dnf only if the AMI lacks it.

Real-instance verification waits for #82's launch template. Until then the opt-in
`npm run test:boot-script` runs the script against real `mkfs.ext4`, `blkid` and `mount` on a loop device
in a privileged AL2023 arm64 container, shimming only `lsblk`, IMDS, `aws`, `docker` and `systemctl`.

## Constitution Check

PASS. No deployed resources change; requirements, plan, tasks and verification are recorded here.
