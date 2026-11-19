import { isDeepStrictEqual } from "node:util";
import { orgOfProjectPk } from "@agentx/contracts";
import { grantsPkFor, namedCompany, revisionPkFor } from "./company-layout.js";
import { slackChannelBindingKeyMatches } from "./slack-company-layout.js";
import { mayUseProject, type ProjectAuthorityWitness, type ProjectUseRole } from "../developer/task-project-access.js";

export type TaskPersonProjectAuthorityWitness = ProjectAuthorityWitness & {
  taskId: string;
  developerId: string;
  project: string;
};

export type TaskPersonInviteStateCondition =
  | {
    kind: "project-revision";
    pk: string;
    sk: string;
    revision: number;
    developerTasksPresent: boolean;
    developerTasks?: unknown;
  }
  | { kind: "developer-grant"; pk: string; sk: string; projectName: string; role: ProjectUseRole }
  | { kind: "channel-binding"; pk: string; sk: string; teamId: string; channelId: string; projectName: string; updatedAt: string };

function projectRevisionCondition(witness: TaskPersonProjectAuthorityWitness, project: string): TaskPersonInviteStateCondition | undefined {
  const revision = witness.projectRevision;
  if (!Number.isSafeInteger(revision.revision) || revision.revision < 0
    || revision.pk !== revisionPkFor(orgOfProjectPk(revision.pk), project) || revision.sk !== `REV#${String(revision.revision).padStart(12, "0")}`
    || typeof revision.developerTasksPresent !== "boolean") return undefined;
  const hasValue = Object.hasOwn(revision, "developerTasks");
  if (revision.developerTasksPresent !== hasValue) return undefined;
  return {
    kind: "project-revision", pk: revision.pk, sk: revision.sk, revision: revision.revision,
    developerTasksPresent: revision.developerTasksPresent,
    ...(revision.developerTasksPresent ? { developerTasks: structuredClone(revision.developerTasks) } : {}),
  };
}

function positiveRowCondition(
  witness: TaskPersonProjectAuthorityWitness,
  project: string,
  teamId: string,
): TaskPersonInviteStateCondition | undefined {
  // R2-F1 review round 3: the company the witness's revision key names; a NAMED company's grant and binding keys are its own partition's.
  const company = orgOfProjectPk(witness.projectRevision.pk);
  if (witness.access === "granted") {
    const membership = witness.membership;
    if (membership === undefined || witness.binding !== undefined
      || membership.pk !== grantsPkFor(company, witness.developerId) || membership.sk !== `PROJECT#${project}`
      || membership.projectName !== project || !mayUseProject(membership.role)) return undefined;
    return { kind: "developer-grant", pk: membership.pk, sk: membership.sk, projectName: membership.projectName, role: membership.role };
  }
  const binding = witness.binding;
  if (binding === undefined || witness.membership !== undefined
    || !slackChannelBindingKeyMatches(binding, company, teamId, binding.channelId)
    || binding.teamId !== teamId || binding.projectName !== project || typeof binding.updatedAt !== "string"
    || binding.updatedAt.length === 0) return undefined;
  return {
    kind: "channel-binding", pk: binding.pk, sk: binding.sk, teamId: binding.teamId,
    channelId: binding.channelId, projectName: binding.projectName, updatedAt: binding.updatedAt,
  };
}

/** Derives the exact positive State predicates required alongside an invitation receipt CAS. */
export function taskPersonInviteStateConditions(input: {
  taskId: string;
  /** The task's company (taskCompanyId): the witnesses' revision must be of this company's own partition (a NAMED company) or the legacy rows (the built-in company). */
  companyId: string;
  project: string;
  teamId: string;
  actor: TaskPersonProjectAuthorityWitness;
  target: TaskPersonProjectAuthorityWitness;
}): readonly TaskPersonInviteStateCondition[] | undefined {
  const { taskId, project, teamId, actor, target } = input;
  // Review round 4: both witnesses' revisions name the task's own company (another company's same-named project never fences this task's invitation).
  const company = namedCompany(input.companyId);
  if (orgOfProjectPk(actor.projectRevision.pk) !== company || orgOfProjectPk(target.projectRevision.pk) !== company) return undefined;
  if (actor.taskId !== taskId || target.taskId !== taskId || actor.project !== project || target.project !== project
    || !/^[a-f0-9]{64}$/.test(actor.developerId) || !/^[a-f0-9]{64}$/.test(target.developerId)) return undefined;
  const actorRevision = projectRevisionCondition(actor, project);
  const targetRevision = projectRevisionCondition(target, project);
  const actorRow = positiveRowCondition(actor, project, teamId);
  const targetRow = positiveRowCondition(target, project, teamId);
  if (actorRevision === undefined || targetRevision === undefined || actorRow === undefined || targetRow === undefined
    || !isDeepStrictEqual(actorRevision, targetRevision)) return undefined;

  const conditions: TaskPersonInviteStateCondition[] = [];
  const keyed = new Map<string, TaskPersonInviteStateCondition>();
  for (const condition of [actorRevision, actorRow, targetRow]) {
    const key = `${condition.pk}\0${condition.sk}`;
    const previous = keyed.get(key);
    if (previous !== undefined) {
      if (!isDeepStrictEqual(previous, condition)) return undefined;
      continue;
    }
    keyed.set(key, condition);
    conditions.push(condition);
  }
  return conditions;
}
