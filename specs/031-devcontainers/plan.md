# Implementation Plan: Run the Project's Devcontainer on EC2 Workers

**Branch**: `feat/121-devcontainers` | **Date**: 2026-09-27 | **Spec**: [spec.md](spec.md)

- `packages/contracts/src/project.ts`: `DevcontainerDefinitionSchema` on the project definition; the definition
  check refuses an unregistered repository.
- `packages/broker/src/aws/broker.ts`: registration refuses a devcontainer on a non-`ec2-ebs` binding.
- `packages/worker/src/devcontainer.ts`: the `devcontainer` CLI behind a `DevcontainerCli` seam.
  - `ensureDevcontainer` runs `up` with `--mount type=bind,source=<root>,target=<root>`.
  - `runDevcontainerCommand` runs a project command in its directory.
  - `devcontainerBashOperations` is pi's `BashOperations`: the command runs in its own process group, whose ID
    it records, and a timeout or abort kills that group inside the container with bash, because dash's `kill`
    refuses a negative process group.
- `packages/worker/src/prepare.ts`: starts the devcontainer before `setup`, records it in the manifest, runs
  `setup` and `readiness` through it, and skips `.docker` in the symlink walk.
- `packages/worker/src/run-task.ts` and `pi-session.ts`: start the devcontainer before each task, and replace
  pi's `bash` tool with one built on the devcontainer operations.
- `environments/base/Dockerfile`: a `tools` stage downloads the Docker CLI 29.8.1 and Compose v5.5.1 by
  checksum; `@devcontainers/cli` 0.89.0 is a worker dependency.
- `packages/worker/ec2/boot.sh`: Docker's data root on the volume, and the socket plus its group for the worker.
- `scripts/release-demo.ts`: the worker smoke test checks the three tools.

## Constitution Check

PASS. The Docker socket makes the worker root on its single-workspace instance. It gains nothing it lacked:
the agent's shell already ran as the worker's user, with host networking and the instance role through IMDS.
Projects without a devcontainer behave as before, apart from Docker's data root moving to the volume.
