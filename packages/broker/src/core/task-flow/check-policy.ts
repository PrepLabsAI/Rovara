// the checks a workflow task is held to (Cloud's `taskWorkflowCheckPolicy`).
//
// Without an approved test environment they are the project's own readiness commands, plus the project's optional checks. With one they are the environment's checks, in its order, each with its kind,
// FOLLOWED BY any readiness command the environment does not already run, so approving an environment never silently drops a check the project had. The worker's selection plan relies on that order: the
// first checks are the environment's (`testEnvPlanFor` builds a plan only when the run's first commands are exactly them).
import { agentXError, developerTaskPolicy, type ProjectCommand, type ProjectDefinition, type TestEnvironmentBody, type WorkflowCheckPolicy } from "@agentx/contracts";

export function taskWorkflowCheckPolicy(project: ProjectDefinition, environment?: TestEnvironmentBody): WorkflowCheckPolicy {
  const label = (command: { executable: string; args: string[] }) => `${command.executable} ${command.args.join(" ")}`.trim().slice(0, 80);
  const same = (left: ProjectCommand, right: ProjectCommand) => left.cwd === right.cwd && left.executable === right.executable && JSON.stringify(left.args) === JSON.stringify(right.args);
  const owned = environment?.repos.flatMap((repo) => repo.checks) ?? [];
  const commands: Array<{ command: ProjectCommand; text: string; kind?: (typeof owned)[number]["kind"] }> = [
    ...owned.map((check) => ({ command: check.command, text: check.label, kind: check.kind })),
    ...project.readiness.filter((command) => !owned.some((check) => same(check.command, command))).map((command) => ({ command, text: label(command) })),
  ];
  const required = commands.map((entry, index) => ({ id: `required-${index + 1}`, label: entry.text.slice(0, 80), command: entry.command, ...(entry.kind === undefined ? {} : { kind: entry.kind }) }));
  const optional = developerTaskPolicy(project).optionalWorkflowChecks ?? [];
  if (required.length + optional.length > 64) throw agentXError("CONFIG_INVALID", "project workflow checks exceed the supported limit of 64");
  const ids = new Set(required.map((check) => check.id));
  if (optional.some((check) => ids.has(check.id))) throw agentXError("CONFIG_INVALID", "optional workflow check IDs cannot reuse required check IDs");
  return { required, optional, selectedOptionalIds: [], proposed: [] };
}
