import { isDeepStrictEqual } from "node:util";
import type { ProjectAuthorityWitness } from "../developer/task-project-access.js";

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
  | { kind: "developer-grant"; pk: string; sk: string; projectName: string; role: "developer" }
  | { kind: "channel-binding"; pk: string; sk: string; teamId: string; channelId: string; projectName: string; updatedAt: string };

function projectRevisionCondition(witness: TaskPersonProjectAuthorityWitness, project: string): TaskPersonInviteStateCondition | undefined {
  const revision = witness.projectRevision;
  if (!Number.isSafeInteger(revision.revision) || revision.revision < 0
    || revision.pk !== `PROJECT#${project}` || revision.sk !== `REV#${String(revision.revision).padStart(12, "0")}`
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
  if (witness.access === "granted") {
    const membership = witness.membership;
    if (membership === undefined || witness.binding !== undefined
      || membership.pk !== `MEMBER#${witness.developerId}` || membership.sk !== `PROJECT#${project}`
      || membership.projectName !== project || membership.role !== "developer") return undefined;
    return { kind: "developer-grant", pk: membership.pk, sk: membership.sk, projectName: membership.projectName, role: membership.role };
  }
  const binding = witness.binding;
  if (binding === undefined || witness.membership !== undefined
    || binding.pk !== `SLACK_BINDING#${teamId}` || binding.sk !== `CHANNEL#${binding.channelId}`
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
  project: string;
  teamId: string;
  actor: TaskPersonProjectAuthorityWitness;
  target: TaskPersonProjectAuthorityWitness;
}): readonly TaskPersonInviteStateCondition[] | undefined {
  const { taskId, project, teamId, actor, target } = input;
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
