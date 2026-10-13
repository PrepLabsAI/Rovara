import { isDeepStrictEqual } from "node:util";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  SlackTeamIdSchema,
  agentXError,
  type TaskPersonProofRequest,
  type TaskPersonProofResponse,
} from "@agentx/contracts";
import {
  checkTaskPersonIdentity,
  type ProjectAccessSubject,
  type TaskPersonIdentityDependencies,
} from "../developer/task-person-identity.js";
import type { ProjectAuthorityReader, ProjectAuthorityWitness } from "../developer/task-project-access.js";
import { readProjectAuthority } from "../developer/task-project-access.js";
import type { DeveloperTaskRecord } from "../developer/task-records.js";
import { taskOwnerKey } from "../developer/task-records.js";
import { META, type DeveloperRecord } from "../developer/store.js";
import type { TaskAuthorityAdmission } from "./task-authority-admission.js";

export const TASK_PERSON_DEVELOPER_RECORD_ATTRIBUTES = [
  "pk", "sk", "developerId", "provider", "issuer", "subject", "slackUserId", "revoked", "displayName",
] as const;

export type TaskPersonDeveloperRecordProjection = { pk: string; sk: string } & Pick<DeveloperRecord,
  "developerId" | "provider" | "issuer" | "subject" | "slackUserId" | "revoked" | "displayName">;

export interface TaskPersonRuntimePorts {
  /** Reads only a task-partition META, PERSON_SUBJECT#<developerId>, or PERSON#<UUID> row. */
  readTaskRecord(input: { taskId: string; sortKey: string; abortSignal: AbortSignal }): Promise<Record<string, unknown> | undefined>;
  /** Strong DEVELOPER#<developerId>/META read with the exact projected fields named here. */
  readDeveloperRecord(input: {
    developerId: string;
    consistentRead: true;
    projection: typeof TASK_PERSON_DEVELOPER_RECORD_ATTRIBUTES;
    abortSignal: AbortSignal;
  }): Promise<TaskPersonDeveloperRecordProjection | undefined>;
  /** Exact PROJECT#revision, MEMBER#developerId, and SLACK_BINDING#teamId query adapter. */
  projectAuthorityReader: ProjectAuthorityReader;
  /** Dedicated fresh proof capability with measured usage; no mixed Identity fallback is accepted. */
  taskPersonProof(
    request: TaskPersonProofRequest,
    admission: TaskAuthorityAdmission,
  ): Promise<{ result: TaskPersonProofResponse; slackCallsUsed: number }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const unavailable = () => agentXError("SLACK_UNAVAILABLE", "task person identity proof is unavailable");
const refused = () => agentXError("PROJECT_ACCESS_DENIED", "task person identity could not be verified");

function projectedDeveloperRecord(record: TaskPersonDeveloperRecordProjection | undefined, developerId: string): DeveloperRecord | undefined {
  if (record === undefined) return undefined;
  if (record.pk !== `DEVELOPER#${developerId}` || record.sk !== META || record.developerId !== developerId) return undefined;
  // Keep the runtime value limited even when an injected adapter returns a structurally wider row.
  return {
    pk: record.pk, sk: record.sk, developerId: record.developerId,
    ...(record.provider === undefined ? {} : { provider: record.provider }),
    ...(record.issuer === undefined ? {} : { issuer: record.issuer }),
    ...(record.subject === undefined ? {} : { subject: record.subject }),
    ...(record.slackUserId === undefined ? {} : { slackUserId: record.slackUserId }),
    ...(record.revoked === undefined ? {} : { revoked: record.revoked }),
    ...(record.displayName === undefined ? {} : { displayName: record.displayName }),
  } as unknown as DeveloperRecord;
}

function identityDocumentClient(input: {
  taskId: string;
  developerId: string;
  stateTableName: string;
  admission: TaskAuthorityAdmission;
  ports: TaskPersonRuntimePorts;
}): TaskPersonIdentityDependencies["documentClient"] {
  const linkedPersonIds = new Set<string>();
  return {
    async send(command: unknown): Promise<unknown> {
      if (!(command instanceof GetCommand)) throw unavailable();
      const query = command.input;
      if (query.ConsistentRead !== true || query.TableName !== input.stateTableName) throw unavailable();
      const key = query.Key as { pk?: unknown; sk?: unknown } | undefined;
      if (key?.pk !== `DEVTASK#${input.taskId}` || typeof key.sk !== "string") throw unavailable();
      const isSubject = key.sk === `PERSON_SUBJECT#${input.developerId}`;
      const personId = key.sk.startsWith("PERSON#") ? key.sk.slice("PERSON#".length) : undefined;
      const allowed = key.sk === "META" || isSubject
        || (personId !== undefined && linkedPersonIds.has(personId));
      if (!allowed) throw unavailable();
      const abortSignal = input.admission.admitStateRead();
      const item = await input.ports.readTaskRecord({ taskId: input.taskId, sortKey: key.sk, abortSignal });
      input.admission.assertOpen();
      if (isSubject && item !== undefined && item.pk === key.pk && item.sk === key.sk
        && item.developerId === input.developerId && typeof item.personId === "string" && UUID.test(item.personId)) {
        linkedPersonIds.add(item.personId);
      }
      return item === undefined ? {} : { Item: item };
    },
  };
}

function identityDependencies(input: {
  task: DeveloperTaskRecord;
  developerId: string;
    stateTableName: string;
  slackTeamId: string;
  now(): number;
  uuid(): string;
  trustedCaller?: TaskPersonIdentityDependencies["trustedCaller"];
  admission: TaskAuthorityAdmission;
  ports: TaskPersonRuntimePorts;
  onProjectAuthority(witness: ProjectAuthorityWitness): void;
}): TaskPersonIdentityDependencies {
  const { task, developerId, slackTeamId, admission, ports } = input;
  const readBindings = async (project: string): Promise<readonly string[]> => {
    admission.assertOpen();
    const result = await ports.projectAuthorityReader.bindings(slackTeamId, admission, admission.admitStateRead());
    admission.assertOpen();
    if (!result.complete) throw unavailable();
    return result.items.filter((binding) => binding.projectName === project).map((binding) => binding.channelId).sort();
  };
  return {
    documentClient: identityDocumentClient({ taskId: task.taskId, developerId, stateTableName: input.stateTableName, admission, ports }),
    tableName: input.stateTableName,
    slackTeamId,
    now: () => input.now(),
    uuid: () => input.uuid(),
    taskPersonProof: async (request) => {
      admission.assertOpen();
      if (admission.remainingSlackCalls() <= 0) throw unavailable();
      const measured = await ports.taskPersonProof(request, admission);
      admission.recordSlackUsage(measured.slackCallsUsed);
      admission.assertOpen();
      if (measured.slackCallsUsed === 0
        && (measured.result.ok || (!measured.result.ok && measured.result.error === "ineligible"))) throw unavailable();
      return measured.result;
    },
    developerRecord: async (targetDeveloperId) => {
      if (targetDeveloperId !== developerId) throw unavailable();
      const record = await ports.readDeveloperRecord({
        developerId: targetDeveloperId,
        consistentRead: true,
        projection: TASK_PERSON_DEVELOPER_RECORD_ATTRIBUTES,
        abortSignal: admission.admitStateRead(),
      });
      admission.assertOpen();
      return projectedDeveloperRecord(record, targetDeveloperId);
    },
    projectChannelIds: readBindings,
    targetProjectAccess: async (subject: ProjectAccessSubject, project: string, freshMemberOf: readonly string[]) => {
      const result = await readProjectAuthority(ports.projectAuthorityReader, {
        project,
        developerId: subject.developerId,
        teamId: slackTeamId,
        freshMemberOf,
        ...(subject.slackUserId === undefined ? {} : { slackUserId: subject.slackUserId }),
        admission,
      });
      if (result.kind === "allowed") {
        if (result.witness === undefined) throw unavailable();
        input.onProjectAuthority(result.witness);
        return;
      }
      if (result.kind === "denied" && result.reason === "project-access") throw refused();
      if (result.kind === "not-found") throw agentXError("PROJECT_NOT_FOUND", "task person project was not found");
      if (result.kind === "denied" && result.reason === "tasks-disabled") throw agentXError("PROJECT_TASKS_DISABLED", "task person project tasks are disabled");
      throw unavailable();
    },
    ...(input.trustedCaller === undefined ? {} : { trustedCaller: input.trustedCaller }),
  };
}

export type CheckTaskPerson = (task: DeveloperTaskRecord, developerId: string) => ReturnType<typeof checkTaskPersonIdentity>;
export type TaskPersonStateAuthorityWitness = ProjectAuthorityWitness & { taskId: string; developerId: string; project: string };
export interface TaskPersonRuntime {
  checkTaskPerson: CheckTaskPerson;
  stateAuthorityWitnessForOwnerActor(task: DeveloperTaskRecord, ownerActorId: string): Promise<TaskPersonStateAuthorityWitness | undefined>;
  stateAuthorityWitnessForEligiblePerson(task: DeveloperTaskRecord, developerId: string): Promise<TaskPersonStateAuthorityWitness | undefined>;
}

/** Creates a guard-local checker. Its injected ports expose only the bounded People read set. */
export function createTaskPersonRuntime(input: {
  admission: TaskAuthorityAdmission;
  ports: TaskPersonRuntimePorts;
  stateTableName: string;
  slackTeamId: string;
  now(): number;
  uuid(): string;
  trustedCaller?: TaskPersonIdentityDependencies["trustedCaller"];
  checkIdentity?: typeof checkTaskPersonIdentity;
}): TaskPersonRuntime {
  const checkIdentity = input.checkIdentity ?? checkTaskPersonIdentity;
  const witnesses = new Map<string, TaskPersonStateAuthorityWitness & { eligible: true; channelMember: boolean }>();
  const witnessKey = (taskId: string, developerId: string) => `${taskId}\0${developerId}`;
  const currentWitness = async (task: DeveloperTaskRecord, developerId: string, witness: TaskPersonStateAuthorityWitness | undefined): Promise<TaskPersonStateAuthorityWitness | undefined> => {
    if (witness === undefined || witness.taskId !== task.taskId || witness.developerId !== developerId || witness.project !== task.project) return undefined;
    input.admission.assertOpen();
    const latest = await input.ports.projectAuthorityReader.latestRevision(task.project, input.admission, input.admission.admitStateRead());
    input.admission.assertOpen();
    const revision = latest.revision;
    const validRevision = revision !== undefined && Number.isSafeInteger(revision.revision) && revision.revision >= 0
      && typeof revision.definition === "object" && revision.definition !== null && !Array.isArray(revision.definition);
    const samePolicy = latest.complete && validRevision && revision !== undefined
      && revision.pk === witness.projectRevision.pk && revision.sk === witness.projectRevision.sk
      && revision.revision === witness.projectRevision.revision
      && Object.hasOwn(revision.definition, "developerTasks") === witness.projectRevision.developerTasksPresent
      && (!witness.projectRevision.developerTasksPresent || isDeepStrictEqual(revision.definition.developerTasks, witness.projectRevision.developerTasks));
    return samePolicy ? witness : undefined;
  };
  return {
    async checkTaskPerson(task, developerId) {
      witnesses.delete(witnessKey(task.taskId, developerId));
      input.admission.admitIdentity(developerId);
      input.admission.assertOpen();
      if (!UUID.test(task.taskId) || !SlackTeamIdSchema.safeParse(input.slackTeamId).success) throw refused();
      let projectWitness: ProjectAuthorityWitness | undefined;
      const dependencies = identityDependencies({
        task, developerId, stateTableName: input.stateTableName, slackTeamId: input.slackTeamId,
        now: () => input.now(), uuid: () => input.uuid(),
        ...(input.trustedCaller === undefined ? {} : { trustedCaller: input.trustedCaller }),
        admission: input.admission,
        ports: input.ports,
        onProjectAuthority(witness) { projectWitness = witness; },
      });
      const result = await checkIdentity(dependencies, task, developerId);
      input.admission.assertOpen();
      if (result.eligible && result.identity.developerId === developerId && projectWitness !== undefined) witnesses.set(witnessKey(task.taskId, developerId), {
        ...projectWitness, taskId: task.taskId, developerId, project: task.project, eligible: true, channelMember: result.channelMember,
      });
      return result;
    },
    async stateAuthorityWitnessForOwnerActor(task, ownerActorId) {
      const witness = [...witnesses.values()].find((candidate) => candidate.taskId === task.taskId
        && candidate.project === task.project && candidate.channelMember
        && taskOwnerKey(candidate.developerId, task.taskId) === ownerActorId);
      return currentWitness(task, witness?.developerId ?? "", witness);
    },
    async stateAuthorityWitnessForEligiblePerson(task, developerId) {
      const witness = witnesses.get(witnessKey(task.taskId, developerId));
      if (witness?.eligible !== true) return undefined;
      return currentWitness(task, developerId, witness);
    },
  };
}
