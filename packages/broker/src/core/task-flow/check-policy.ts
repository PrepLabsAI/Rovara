// Lane L6a, task flow core: the checks a workflow task is held to (Cloud's `taskWorkflowCheckPolicy`, without the test environment, which a
// later lane brings): the project's readiness commands, plus the project's optional checks.
import { agentXError, developerTaskPolicy, type ProjectDefinition, type WorkflowCheckPolicy } from "@agentx/contracts";

export function taskWorkflowCheckPolicy(project: ProjectDefinition): WorkflowCheckPolicy {
  const label = (command: { executable: string; args: string[] }) => `${command.executable} ${command.args.join(" ")}`.trim().slice(0, 80);
  const required = project.readiness.map((command, index) => ({ id: `required-${index + 1}`, label: label(command), command }));
  const optional = developerTaskPolicy(project).optionalWorkflowChecks ?? [];
  if (required.length + optional.length > 64) throw agentXError("CONFIG_INVALID", "project workflow checks exceed the supported limit of 64");
  const ids = new Set(required.map((check) => check.id));
  if (optional.some((check) => ids.has(check.id))) throw agentXError("CONFIG_INVALID", "optional workflow check IDs cannot reuse required check IDs");
  return { required, optional, selectedOptionalIds: [], proposed: [] };
}
