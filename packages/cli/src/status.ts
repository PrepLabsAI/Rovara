import type { ConnectedWorkspace } from "./connect.js";

export function formatWorkspaceStatus(workspace: ConnectedWorkspace): string {
  const readiness =
    workspace.status === "READY"
      ? "Ready for coding tasks"
      : workspace.status === "PREPARATION_FAILED"
        ? "Preparation failed; this workspace cannot accept coding tasks"
        : workspace.status === "PREPARING"
          ? "Preparation is still running; this workspace cannot accept coding tasks"
          : workspace.status === "BUSY"
            ? "A coding task currently owns the workspace writer lease"
            : `Workspace lifecycle state: ${workspace.status}`;
  return [
    `Project: ${workspace.projectName} (revision ${workspace.projectRevision})`,
    `Workspace: ${workspace.id}`,
    `Storage mode: ${workspace.deploymentMode}`,
    `Status: ${workspace.status}`,
    readiness,
  ].join("\n");
}
