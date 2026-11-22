import { randomUUID } from "node:crypto";
import { agentXError, when, type TransactItem } from "@agentx/contracts";
import { checkNewTaskCreatorIdentity, type TaskPersonIdentityDependencies } from "./task-person-identity.js";
import { taskPeopleEntryOf } from "./task-person-rows.js";
import type { DeveloperTaskRecord } from "./task-records.js";

/** Internal core-start hook. Existing PEOPLE/PERSON rows, committed atomically with the server-built META. */
export async function prepareTaskPeopleStart(deps: TaskPersonIdentityDependencies, task: DeveloperTaskRecord): Promise<TransactItem[]> {
  const proof = await checkNewTaskCreatorIdentity(deps, task);
  if (!proof.eligible || !proof.channelMember || proof.identity.developerId !== task.developerId) {
    throw agentXError("TASK_ACCESS_DENIED", "task access could not be verified");
  }
  const personId = randomUUID();
  const createdAt = task.createdAt;
  const pk = `DEVTASK#${task.taskId}`;
  return [
    { kind: "put", item: { pk, sk: "PEOPLE", schemaVersion: 1, revision: 1, orphaned: false, people: [{ ...taskPeopleEntryOf(proof.identity, "owner") }] }, condition: when.absent() },
    { kind: "put", item: { pk, sk: `PERSON#${personId}`, schemaVersion: 1, personId, ...proof.identity, createdAt }, condition: when.absent() },
    { kind: "put", item: { pk, sk: `PERSON_SUBJECT#${task.developerId}`, schemaVersion: 1, personId, developerId: task.developerId, createdAt }, condition: when.absent() },
  ];
}
