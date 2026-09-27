# Implementation Plan: EC2 Release Reach and Preflight

**Branch**: `feat/087-ec2-preflight` | **Date**: 2026-09-27 | **Spec**: [spec.md](spec.md)

- `scripts/ec2-preflight.ts`: `evaluateEc2Preflight` judges collected facts (pure, unit-tested);
  `gatherEc2Facts` collects them with read-only AWS calls from the foundation and control-plane outputs.
- `scripts/preflight.ts`: `--aws` runs the EC2 checks instead of the AgentCore ones, accepts `--env`, and exits
  non-zero on a failed check. The strict lint config's pre-existing type errors in this file are fixed on the way.
- Releases and AMIs: no code. The runtime stack already publishes the worker image to SSM on every release and the
  step Lambda reads it per launch; the launch template resolves the AMI per launch. Evidence is in #87.
- Removing `WorkerImageUri` from the AgentCore runtime stack moves to #88 with the runtime itself.

## Constitution Check

PASS. A read-only operator script; no deployed change. Requirements, plan, tasks and verification are here.
