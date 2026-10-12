import {
  AgentXNameSchema,
  developerTaskPolicy,
  type DeveloperTaskPolicy,
  type SlackChannelBinding,
} from "@agentx/contracts";
import type { TaskAuthorityAdmission } from "../aws/task-authority-admission.js";

export interface ProjectAuthorityRevision {
  revision: number;
  definition: { developerTasks?: unknown };
}

export interface ProjectDeveloperMembership { projectName: string; role?: string }

export type ProjectAuthorityResult =
  | { kind: "allowed"; revision: number; policy: DeveloperTaskPolicy; access: "granted" | "channel"; channelIds: string[] }
  | { kind: "needs-membership"; channelIds: string[] }
  | { kind: "denied"; reason: "project-access" | "tasks-disabled"; visibleChannelIds: string[] }
  | { kind: "not-found" }
  | { kind: "unavailable" };

export type BoundedProjectReadAdmission = Pick<TaskAuthorityAdmission, "assertOpen" | "admitStateRead" | "remainingStateReads">;

export interface ProjectAuthorityReader {
  /** Use the supplied signal for page one; count each later Query page before issue. */
  latestRevision(project: string, admission: BoundedProjectReadAdmission, abortSignal: AbortSignal): Promise<{ revision?: ProjectAuthorityRevision; complete: boolean }>;
  memberships(developerId: string, admission: BoundedProjectReadAdmission, abortSignal: AbortSignal): Promise<{ items: readonly ProjectDeveloperMembership[]; complete: boolean }>;
  bindings(teamId: string, admission: BoundedProjectReadAdmission, abortSignal: AbortSignal): Promise<{ items: readonly SlackChannelBinding[]; complete: boolean }>;
}

/** Pure policy evaluation. It performs no I/O, logging, name lookup, or human error decoration. */
export function evaluateProjectAuthority(input: {
  project: string;
  revision?: ProjectAuthorityRevision;
  memberships: readonly ProjectDeveloperMembership[];
  bindings: readonly SlackChannelBinding[];
  freshMemberOf?: readonly string[];
  slackUserId?: string;
}): ProjectAuthorityResult {
  if (!AgentXNameSchema.safeParse(input.project).success || input.revision === undefined) return { kind: "not-found" };
  if (!Number.isSafeInteger(input.revision.revision) || input.revision.revision < 0) return { kind: "unavailable" };

  const policy = developerTaskPolicy(input.revision.definition);
  const channelIds = [...new Set(input.bindings
    .filter((binding) => binding.projectName === input.project)
    .map((binding) => binding.channelId))].sort();
  const developerGrant = input.memberships.some((row) => row.projectName === input.project && row.role === "developer");

  let access: "granted" | "channel" | undefined;
  if (developerGrant) access = "granted";
  else if (policy.channelMembersMayUse && input.slackUserId !== undefined && channelIds.length > 0) {
    if (input.freshMemberOf === undefined) return { kind: "needs-membership", channelIds };
    const memberOf = new Set(input.freshMemberOf);
    if (channelIds.some((channelId) => memberOf.has(channelId))) access = "channel";
  }

  if (access === undefined) return { kind: "denied", reason: "project-access", visibleChannelIds: channelIds };
  if (!policy.enabled) return { kind: "denied", reason: "tasks-disabled", visibleChannelIds: [] };
  return { kind: "allowed", revision: input.revision.revision, policy, access, channelIds };
}

/** Reads the bounded authority snapshot and refuses partial results as unavailable. */
export async function readProjectAuthority(
  reader: ProjectAuthorityReader,
  input: {
    project: string;
    developerId: string;
    teamId: string;
    slackUserId?: string;
    freshMemberOf?: readonly string[];
    admission: BoundedProjectReadAdmission;
  },
): Promise<ProjectAuthorityResult> {
  if (!AgentXNameSchema.safeParse(input.project).success) return { kind: "not-found" };
  try {
    input.admission.assertOpen();
    const latest = await reader.latestRevision(input.project, input.admission, input.admission.admitStateRead());
    input.admission.assertOpen();
    if (!latest.complete) return { kind: "unavailable" };
    if (latest.revision === undefined) return { kind: "not-found" };

    const memberships = await reader.memberships(input.developerId, input.admission, input.admission.admitStateRead());
    input.admission.assertOpen();
    if (!memberships.complete) return { kind: "unavailable" };

    const bindings = await reader.bindings(input.teamId, input.admission, input.admission.admitStateRead());
    input.admission.assertOpen();
    if (!bindings.complete) return { kind: "unavailable" };

    return evaluateProjectAuthority({
      project: input.project,
      revision: latest.revision,
      memberships: memberships.items,
      bindings: bindings.items,
      ...(input.freshMemberOf === undefined ? {} : { freshMemberOf: input.freshMemberOf }),
      ...(input.slackUserId === undefined ? {} : { slackUserId: input.slackUserId }),
    });
  } catch {
    return { kind: "unavailable" };
  }
}
