// A registered project revision's record, read the same way by the broker and the plan evidence job.
import { agentXError } from "@agentx/contracts";
import { getItem, type StateTable } from "./cancellation.js";
import type { RegisteredProjectRecord } from "./broker.js";

export function projectKey(name: string, revision: number) {
  return { pk: `PROJECT#${name}`, sk: `REV#${String(revision).padStart(12, "0")}` };
}

export async function requireProject(dependencies: StateTable, projectName: string, revision: number): Promise<RegisteredProjectRecord> {
  const project = await getItem<RegisteredProjectRecord>(dependencies, projectKey(projectName, revision));
  if (!project) throw agentXError("NOT_FOUND", "registered project revision not found");
  return project;
}
