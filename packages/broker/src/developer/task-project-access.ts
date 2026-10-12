import {
  AgentXNameSchema,
  SlackChannelBindingSchema,
  developerTaskPolicy,
  type DeveloperTaskPolicy,
  type SlackChannelBinding,
} from "@agentx/contracts";
import type { TaskAuthorityAdmission } from "../aws/task-authority-admission.js";

export interface ProjectAuthorityRevision {
  pk?: string;
  sk?: string;
  revision: number;
  definition: { developerTasks?: unknown };
}

export interface ProjectDeveloperMembership { pk?: string; sk?: string; projectName: string; role?: string }
export interface ProjectChannelBinding extends SlackChannelBinding { pk?: string; sk?: string }
export interface ProjectAuthorityWitness {
  projectRevision: { pk: string; sk: string; revision: number; developerTasksPresent: boolean; developerTasks?: unknown };
  access: "granted" | "channel";
  membership?: { pk: string; sk: string; projectName: string; role: "developer" };
  binding?: { pk: string; sk: string; teamId: string; channelId: string; projectName: string; updatedAt: string };
}

export type ProjectAuthorityResult =
  | { kind: "allowed"; revision: number; policy: DeveloperTaskPolicy; access: "granted" | "channel"; channelIds: string[]; witness?: ProjectAuthorityWitness }
  | { kind: "needs-membership"; channelIds: string[] }
  | { kind: "denied"; reason: "project-access" | "tasks-disabled"; visibleChannelIds: string[] }
  | { kind: "not-found" }
  | { kind: "unavailable" };

export type BoundedProjectReadAdmission = Pick<TaskAuthorityAdmission, "assertOpen" | "admitStateRead" | "remainingStateReads">;

export interface ProjectAuthorityReader {
  /** Use the supplied signal for page one; count each later Query page before issue. */
  latestRevision(project: string, admission: BoundedProjectReadAdmission, abortSignal: AbortSignal): Promise<{ revision?: ProjectAuthorityRevision; complete: boolean }>;
  memberships(developerId: string, admission: BoundedProjectReadAdmission, abortSignal: AbortSignal): Promise<{ items: readonly ProjectDeveloperMembership[]; complete: boolean }>;
  bindings(teamId: string, admission: BoundedProjectReadAdmission, abortSignal: AbortSignal): Promise<{ items: readonly ProjectChannelBinding[]; complete: boolean }>;
}

/** Pure policy evaluation. It performs no I/O, logging, name lookup, or human error decoration. */
export function evaluateProjectAuthority(input: {
  project: string;
  developerId?: string;
  teamId?: string;
  revision?: ProjectAuthorityRevision;
  memberships: readonly ProjectDeveloperMembership[];
  bindings: readonly ProjectChannelBinding[];
  freshMemberOf?: readonly string[];
  slackUserId?: string;
}): ProjectAuthorityResult {
  if (!AgentXNameSchema.safeParse(input.project).success || input.revision === undefined) return { kind: "not-found" };
  const revisionKey = `REV#${String(input.revision.revision).padStart(12, "0")}`;
  if (!Number.isSafeInteger(input.revision.revision) || input.revision.revision < 0) return { kind: "unavailable" };
  if (input.developerId !== undefined && input.teamId !== undefined && (input.revision.pk !== `PROJECT#${input.project}` || input.revision.sk !== revisionKey)) return { kind: "unavailable" };
  if (input.developerId !== undefined && input.memberships.some((row) => row.projectName === input.project
    && (row.pk !== `MEMBER#${input.developerId}` || row.sk !== `PROJECT#${input.project}`))) return { kind: "unavailable" };
  if (input.teamId !== undefined && input.bindings.some((binding) => binding.projectName === input.project
    && (binding.pk !== `SLACK_BINDING#${input.teamId}` || binding.sk !== `CHANNEL#${binding.channelId}` || binding.teamId !== input.teamId))) return { kind: "unavailable" };

  const policy = developerTaskPolicy(input.revision.definition);
  const matchingBindings = input.bindings.filter((binding) => binding.projectName === input.project);
  const channelIds = [...new Set(matchingBindings.map((binding) => binding.channelId))].sort();
  const membership = input.memberships.find((row) => row.projectName === input.project && row.role === "developer");
  const developerGrant = membership !== undefined;

  let access: "granted" | "channel" | undefined;
  let binding: ProjectChannelBinding | undefined;
  if (developerGrant) access = "granted";
  else if (policy.channelMembersMayUse && input.slackUserId !== undefined && channelIds.length > 0) {
    if (input.freshMemberOf === undefined) return { kind: "needs-membership", channelIds };
    const memberOf = new Set(input.freshMemberOf);
    binding = matchingBindings.find((candidate) => memberOf.has(candidate.channelId));
    if (binding !== undefined) access = "channel";
  }

  if (access === undefined) return { kind: "denied", reason: "project-access", visibleChannelIds: channelIds };
  if (!policy.enabled) return { kind: "denied", reason: "tasks-disabled", visibleChannelIds: [] };
  const revision = input.revision;
  const projectRevision = input.developerId !== undefined && input.teamId !== undefined
    && input.revision.pk !== undefined && input.revision.sk !== undefined ? {
    pk: revision.pk!, sk: revision.sk!, revision: revision.revision,
    developerTasksPresent: Object.hasOwn(revision.definition, "developerTasks"),
    ...(Object.hasOwn(revision.definition, "developerTasks") ? { developerTasks: structuredClone(revision.definition.developerTasks) } : {}),
  } : undefined;
  const witness: ProjectAuthorityWitness | undefined = projectRevision === undefined ? undefined : {
    projectRevision, access,
    ...(access === "granted" && membership?.pk !== undefined && membership.sk !== undefined ? { membership: { pk: membership.pk, sk: membership.sk, projectName: membership.projectName, role: "developer" as const } } : {}),
    ...(access === "channel" && binding?.pk !== undefined && binding.sk !== undefined ? { binding: { pk: binding.pk, sk: binding.sk, teamId: binding.teamId, channelId: binding.channelId, projectName: binding.projectName, updatedAt: binding.updatedAt } } : {}),
  };
  if (witness !== undefined && ((access === "granted" && witness.membership === undefined) || (access === "channel" && witness.binding === undefined))) return { kind: "unavailable" };
  if (witness?.binding !== undefined && !SlackChannelBindingSchema.safeParse({
    teamId: witness.binding.teamId, channelId: witness.binding.channelId,
    projectName: witness.binding.projectName, updatedAt: witness.binding.updatedAt,
  }).success) return { kind: "unavailable" };
  return { kind: "allowed", revision: input.revision.revision, policy, access, channelIds, ...(witness === undefined ? {} : { witness }) };
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
      developerId: input.developerId,
      teamId: input.teamId,
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
