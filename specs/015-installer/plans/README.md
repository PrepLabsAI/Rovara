# Spec 015 phases

Spec 015 is too large for one plan. It is built in five phases. Each phase has its own plan, branch
and PR, and leaves mainline releasable. Each phase's plan is written when the previous phase merges,
so it can build on what actually landed.

| Phase | Plan | What it delivers | Spec |
|---|---|---|---|
| 15a | [phase-15a-environments.md](phase-15a-environments.md) | Named environments: every account-wide name carries the environment; the legacy deployment's templates are unchanged. Settings in SSM with a lock; the per-environment local cache; `agentx env list`, `env use` and `env adopt`. | FR-001 to FR-006, FR-002's secrets, FR-047's tag |
| 15b | [phase-15b-release-artifacts.md](phase-15b-release-artifacts.md) | The identity stack (Cognito). Templates synthesized with no bootstrap, code packages with checksums, images on ECR Public by digest, the npm CLI, the release workflow, and the check that templates equal the CDK synthesis. Starts with the live proof that AgentCore Runtime can start from an ECR pull-through cache image. | FR-008, FR-010 (proof), FR-012, FR-021 |
| 15c1 | [phase-15c1-install-access.md](phase-15c1-install-access.md) | The access stack (artifact bucket, ECR pull-through rule, CloudFormation service role, operator role), permission boundaries on every environment role, pull-through permissions for the worker and Slack service, and the pure deploy parameter model. | FR-010, FR-022 to FR-025, FR-018 step 2 wiring |
| 15c2 | [phase-15c2-deploy-engines.md](phase-15c2-deploy-engines.md) | The templates and cdk engines behind one deployer interface: packages and rendered templates to the artifact bucket, change sets through the service role, install and upgrade order, output wiring, engine mismatch refusal, the CDK bootstrap check, and `agentx init --export`. | FR-007, FR-009, FR-011, FR-013, FR-026 |
| 15d | phase-15d-init.md | `agentx init`: prerequisites, questions and flags, cost estimate, the step runner with progress in SSM and resume, the GitHub App and Slack app manifest flows, the admin user, `project add` and `channel add`, `connector add` guides, alerts, the budget, `alerts test`, and the end-to-end check. | FR-015 to FR-020, FR-027 to FR-041, FR-045 to FR-047 |
| 15e | phase-15e-day-two.md | `agentx upgrade`, `config`, `doctor` and `destroy`; the install, day-2, teardown and move guides; the release test workflow in a throwaway account; the SC-001 manual check. | FR-042 to FR-044, FR-048 to FR-055, SC-001 to SC-006 |

The order follows dependencies: every later phase reads and writes the settings and names from
15a; the engines in 15c deploy the artifacts from 15b; `init` in 15d drives the engines; day-2
commands in 15e operate what `init` built.

The riskiest assumption, that AgentCore Runtime can start from a pull-through cache image, is
proved at the start of 15b, before any engine work depends on it.
