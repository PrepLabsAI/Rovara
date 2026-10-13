# Ordered work

An approved coding plan can contain several pieces that need to happen in order. For example:
add a setting, build the code that reads it, then add the page that uses it.

AgentX proposes these pieces in the coding plan. Review their names, scope and dependencies on the
task page before approving. Slack and MCP use the same plan and Owner checks. A small request can
continue with an ordinary coding plan without a work breakdown.

The first phase supports one repository, up to eight required pieces and one final pull request.
AgentX does one piece at a time. It records the result before starting the next dependent piece.
After all pieces are implemented, the normal checks and code/security reviews run against the
combined change. A human still reviews and merges the final PR.

If a piece fails, its result is unknown or the task is cancelled, the sequence pauses. Later pieces
do not start automatically. A current Owner can retry when the retained code and plan still match.
Completed pieces are kept on retry. If all pieces were already saved, AgentX runs the selected
checks again against that retained code before the normal review. The page shows the current
attempt and its retained pieces; sending work back to coding starts a new attempt.
If the plan changes, review and approve the complete new plan before more work begins.

## Enabling the feature

Named deployments provide the CloudFormation parameter `WorkflowDependenciesEnabled`, with a
default of `false`. The broker reads it as `AGENTX_WORKFLOW_DEPENDENCIES_ENABLED`. Enable it only
in the environment approved for the trial, after installing a compatible broker and worker.
The worker must advertise `task.workflowDependencies`; AgentX refuses an incompatible worker.

Preserve the deployment's existing parameter values during an upgrade. This feature does not
enable People role changes or automatic invitations, alter model settings, or grant merge or
deployment authority.

Production activation requires candidate-bound runtime acceptance and a qualified recovery plan.
Passing local tests or enabling a TEST environment does not meet that production gate.

## Recovery

Turning the feature off stops new graph approvals and retries. It retains the plan, decisions,
progress and permission enforcement. An already accepted operation's callbacks must still be
recorded correctly; disabling admission is not an instruction to erase history.

An older broker may reject graph records or fail to enforce their constraints. The feature switch
alone does not establish safe rollback. Before replacing graph-aware software, stop new admissions,
pause or cancel affected tasks through the current broker, wait for operations to stop and preserve
their recorded checkpoints. Keep the reviewed graph-aware broker and worker available for recovery
with the feature off. Do not deploy an older broker over graph-bearing state without qualification.

Older-version compatibility and any change to the minimum rollback release require a separate
release decision. Parallel work, cross-repository work and a PR per piece are outside this phase.
