// Port lane L7a: who a person is on the code host, and whether their approval counts. Cloud answers from the org's members (a GitHub account linked to each member, a role that is not
// an Auditor's). Code runs as one implicit company with one owner: no member is linked to a reviewer's account, so the default answers "nobody" and a project's code settings default to
// self-approval on (the owner approves with their own session, or a repository collaborator by comment; decision 45.3). A second reader, such as Cloud's members, plugs in here.
import type { OrgId } from "@agentx/contracts";
import type { MergeTask } from "./seams.js";

export interface MergePeople {
  /** The code-host account ids of the people who asked for the task, or "unlinked" when any of them has none (their approval cannot be told from a reviewer's). */
  requestersOf(orgId: OrgId, task: MergeTask): Promise<string[] | "unlinked">;
  /** Which of these code-host accounts are linked to a person who is in the company now and may approve. */
  linkedAmong(orgId: OrgId, hostUserIds: readonly string[]): Promise<Set<string>>;
  /** Which of these code-host accounts are linked to a person who is in the company but may not approve (the Auditor): their approval counts for nothing. */
  nonWritersAmong(orgId: OrgId, hostUserIds: readonly string[]): Promise<Set<string>>;
  /** The code-host account a person (who presses Merge) linked, or undefined. */
  hostAccountOf(orgId: OrgId, personId: string): Promise<string | undefined>;
}

/** Code's default: one owner, no linked accounts, nobody excluded. */
export const soleOwnerPeople: MergePeople = {
  requestersOf: async () => "unlinked",
  linkedAmong: async () => new Set(),
  nonWritersAmong: async () => new Set(),
  hostAccountOf: async () => undefined,
};
