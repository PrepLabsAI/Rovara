// Lane L6a, task flow core: who may start work and who may act on a task.
import { agentXError, type Principal } from "@agentx/contracts";
import type { TaskAccess } from "./deps.js";

/** The role Code's identity adapter gives the machine's owner. */
export const OWNER_ROLE = "owner";

/**
 * Code's rule: the owner of the install may start work on any project, and may act on any task; anyone else may act only on their own task.
 * A principal that is not the owner is refused a start (fail closed): Code has no other members until an identity adapter brings them
 * with a role of its own, and then a project-role `TaskAccess` replaces this one.
 */
export function createOwnerTaskAccess(): TaskAccess {
  const isOwner = (principal: Principal): boolean => principal.roles.includes(OWNER_ROLE);
  return {
    async checkStart(principal, project) {
      void project;
      return isOwner(principal) ? { allowed: true } : { allowed: false, code: "FORBIDDEN", message: "only the owner of this install can start work" };
    },
    async canAct(principal, task) {
      return isOwner(principal) || principal.personId === task.developerId;
    },
    async checkStep() {
      // The person a task runs for was authorized at its start, and the owner of an install does not lose the right.
      return { allowed: true };
    },
  };
}

/** The error for a task the principal may not see: the same as one that does not exist. */
export const taskNotFound = () => agentXError("TASK_NOT_FOUND", "no such task");
