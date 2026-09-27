# Feature Specification: EC2 Worker Boot Script

**Feature Branch**: `feat/081-ec2-boot-script`  
**Created**: 2026-09-27  
**Status**: Approved  
**Input**: Issue #81, part of the EC2 worker design in issue #76; builds on specs 018 and 019

## User Scenario

### A fresh instance becomes a workspace's worker (Priority: P1)

The provisioner launches an instance and attaches the workspace's EBS volume. The instance mounts the
volume at `/mnt/workspace` and runs the pinned worker image, which answers `/ping` on port 8080. A
volume that should already hold a workspace is never formatted.

**Independent Test**: Run the rendered user data in a privileged Amazon Linux 2023 arm64 container with
a loop device standing in for the volume.

## Requirements

- **FR-001**: User data MUST carry `workspaceId`, `generation`, `volumeId`, `expectNewVolume`, the worker
  image digest and the KMS public key, plus the deployment settings the worker needs (control plane URL,
  model provider and ID, prompt-cache retention, log group). Every value MUST be validated to contain no
  shell metacharacters before it is rendered.
- **FR-002**: The script MUST wait for the NVMe device whose serial is the volume ID, and fail if it
  never appears.
- **FR-003**: It MUST format ext4 only when the volume has no signature **and** `expectNewVolume` is true.
  A blank volume that is not expected to be new MUST fail the boot. A volume with any signature other
  than ext4 MUST fail the boot.
- **FR-004**: It MUST mount at `/mnt/workspace`, owned by the worker user (UID 1000), through fstab, so
  that the worker's systemd unit (`RequiresMountsFor`) never starts on the root volume after a reboot.
- **FR-005**: It MUST pull the image by digest from ECR with the instance role and run it on the host
  network with `/mnt/workspace` mounted at the same path.
- **FR-006**: Container logs MUST go to CloudWatch Logs, stream `<workspaceId>/<generation>/<instanceId>`.
- **FR-007**: The worker MUST receive all three invoke-auth variables from spec 019.
- **FR-008**: Exposing the host Docker socket is out of scope.

## Success Criteria

- **SC-001**: On arm64: a new volume is formatted, mounted and the worker started; an existing volume is
  mounted with its data intact; a blank volume expected to hold data fails without being formatted.
- **SC-002**: A foreign filesystem and a volume that is never attached both fail the boot.
- **SC-003**: The renderer exports exactly the variables the script requires.
- **SC-004**: Typecheck, lint, shellcheck and the complete suite pass.
