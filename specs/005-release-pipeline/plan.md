# Implementation Plan: Production Release Pipeline

## Summary

Add a separately deployed `AgentXReleasePipeline` stack. It contains a CodePipeline V2 pipeline that runs on path-filtered pushes to `mainline` and a native ARM CodeBuild project that runs the existing `release:prod` command. Two new release flags make the command safe to run unattended. The first reuses the deployed worker digest when no worker image input has changed. The second refuses to create the production foundation.

## Technical Context

- TypeScript 5.9 / Node.js 22.23.2 monorepo; release tooling in `scripts/release-*.ts`
- AWS CDK 2.269 (`aws-cdk-lib`): CodePipeline V2 triggers with file-path filters, a `CODEBUILD_CLONE_REF` full-clone source, and `LinuxArmBuildImage`
- CodeBuild `amazonlinux-aarch64-standard:3.0` (Docker 28.5.2 with buildx 0.32.1; bundled Node 22.22.1; unpinned AWS CLI)
- Deployed production: `AgentXProductionFoundation`, `AgentXProductionRuntime`, and `AgentXControlPlane` in us-east-1, with the `agentx-worker-production` ECR repository
- Vitest contract tests and CDK assertions

## Constitution Check

- Remote coding workers gain no new permissions. The release project name cannot match the broker's `agentx-*` CodeBuild gate allow-list.
- Versions are pinned: Node.js comes from `.node-version` and is checksum-verified; the AWS CLI version is pinned; the base image is pinned by digest.
- Evidence rule: local tests, synthesis, and dry runs are reported as local validation only. Live pipeline behavior is verified only by real executions (tasks T013–T015).
- Production workspaces are EBS-backed and keyed by capacity provider and session ID. Runtime updates therefore do not reset them or require re-registration.

## Design

1. **Trigger.** V2 push filter on branch `mainline`, including:
   - `environments/**`, `infra/**`
   - `packages/broker/**`, `packages/contracts/**`, `packages/worker/**`
   - `packages/cli/package.json`
   - the root build files `{package.json,package-lock.json,tsconfig.json,tsconfig.base.json,.dockerignore}`

   Seven patterns, within the service limit of eight.
2. **Source.** `CodeStarConnectionsSourceAction` with `codeBuildCloneOutput`, so the build has Git history for change detection. The source action role and the build role both receive `codeconnections:UseConnection` and `codestar-connections:UseConnection`.
3. **Execution.**
   - `SUPERSEDED` mode, plus a CodeBuild concurrent-build limit of 1.
   - A dedicated artifact bucket with S3-managed encryption and 30-day expiry. No cross-account KMS key.
4. **Build.**
   - Environment: `arm1.medium`, privileged Docker, a local Docker layer cache, a 60-minute timeout, and build logs retained for 30 days.
   - Install phase: download Node.js and the AWS CLI into `/opt`, outside the source tree so the release's dirty-tree check still passes.
   - Build commands: `npm ci`, then `npm run release:prod -- --region "$AWS_REGION" --reuse-unchanged-worker --require-existing-foundation`.
5. **Reuse decision.** Implemented in `scripts/release-production.ts`. The reuse check:
   1. reads `WorkerImageUri` from `AgentXProductionRuntime`
   2. requires the image to be in the release repository
   3. reads the image's `release-<time>-<sha>` tag
   4. verifies that the commit exists locally
   5. runs `git diff --quiet <sha> HEAD -- <worker image inputs>`

   Any unknown result builds a new image.
6. **IAM.** The build role may:
   - assume `cdk-hnb659fds-*` bootstrap roles
   - push to and configure `agentx-worker-production`
   - describe the three production stacks
   - read `agentx_production_worker-*` runtimes and `agentx_production_capacity_*` capacity providers (any version suffix, so a renamed provider stays readable)
   - manage log retention under `/aws/bedrock-agentcore/runtimes/*`
7. **Base image.** Pull `public.ecr.aws/docker/library/node` with the same digest, verified on 2026-09-23 to contain `linux/arm64/v8`. Remove the `# syntax=docker/dockerfile:1.7` directive: it pulls a frontend image from Docker Hub, that image is not mirrored on ECR Public, and the Dockerfile uses only instructions the built-in parser supports.
8. **CI.** Change the `ci.yml` push trigger from `main` to `mainline`.

## Project Structure

- `infra/lib/release-pipeline.ts`: the pipeline stack and exported trigger and naming constants
- `infra/bin/agentx.ts`: registers `AgentXReleasePipeline` in `instances-ebs` mode
- `scripts/release-demo.ts`: shared argument parser accepts caller-declared extra flags
- `scripts/release-production.ts`: new flags, worker image inputs, and the reuse decision
- `environments/base/Dockerfile`: ECR Public base image
- `.github/workflows/ci.yml`: `mainline` trigger
- `tests/contract/release-command.test.ts`: flags, the reuse decision, Dockerfile coverage, and trigger coverage
- `tests/contract/infrastructure.test.ts`: pipeline, trigger, build environment, and IAM assertions
- `README.md`: operation and one-time setup

## Complexity Tracking

- The reuse decision uses AWS and Git state instead of relying only on the trigger filter. This keeps releases correct when an earlier worker release failed or was superseded.
