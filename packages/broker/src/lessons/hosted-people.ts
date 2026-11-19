// The people side of lessons on an install that serves many people in many companies (the core engine on a deployed install). A laptop has one person and fills these seams with that person
// (`directory.ts`, `access-port.ts#createLocalAccessCheck`, `task-audience.ts#localLessonAudiencePort`); a deployed install fills them here from ONE port the deployment gives (`HostedLessonPeople`), read live
// on every call, with the company always the one the lessons runtime was built for:
//   - a question about any other company is refused (throws), never answered from this company's people;
//   - who may approve a lesson: the project's approvers as the port lists them now (a list it cannot complete is "incomplete", which the approval rules treat as "no");
//   - who a reader is: their person id and the outside accounts they linked (for a restricted place);
//   - who may read a task's lessons: the project roster (asked one person at a time) plus the task's own person. Core tasks are project-wide (there is no private task in the core), so a task's
//     audience is its project's roster; a task whose record is missing, of another company, or of another project than asked is unknown (its lessons are withheld);
//   - which places a reader may read: only places nothing restricts. A place a lesson is restricted to because its words came from the project's own repository is converted to project-wide before
//     this check (`project-repo-audience.ts`); every other restricted place (a chat channel, a tracker, another project's repository) has no access record on this install yet, so it is denied.
//     That is fail closed: such lessons are kept but never loaded or shown until a record of that place's readers exists.
// Names: a person's display name for a "Lessons used" line; an erased person, or one whose record cannot be read, is never named.
import type { OrgId } from "@agentx/contracts";
import type { AccessCheckPort, TaskVisibilityPort } from "./access-port.js";
import type { AttributionReader } from "./people.js";
import type { ApproverDirectory } from "./ports.js";
import type { Tier0Authority, Tier0Group } from "./sole-owner-switch.js";
import { withLessonAudiences, type LessonAudiencePort, type LessonTaskAudience } from "./task-audience.js";
import type { IdentitySet } from "./types.js";

/** Who approves in a project (or, with no project, company-wide settings): the lists as they are now. */
export interface HostedApprovers {
  /** False when the port could not list every eligible person: the approval rules then refuse. */
  complete: boolean;
  /** Bumped by every change to who may approve (the approval's writes are fenced on it). */
  membershipVersion: number;
  /** The company's owners (live now). NOT a recipient list: a notice to "the people who can decide" goes to `eligibleIds`, which also holds the company's non-owner admins and the project's maintainers. */
  ownerIds: string[];
  /** Who may approve a lesson here (maintainers and company owners or admins), live now. The one list notices to deciders are sent to. */
  eligibleIds: string[];
  /** When an eligible person last lost that right (ms), or null. */
  lastEligibleLossAtMs: number | null;
}

/** The one port a deployment gives. Every call names the company; the port reads that company's own records and never a token claim. Any method may throw: the caller then fails closed. */
export interface HostedLessonPeople {
  approvers(companyId: OrgId, project: string | undefined): Promise<HostedApprovers>;
  /** Whether the person is on the project's roster now (a company owner or admin, or a person with a role on the project). */
  onProjectRoster(companyId: OrgId, project: string, personId: string): Promise<boolean>;
  /**
   * Everyone on the project's roster now (a company owner or admin, or a person with a role on the project), with whether the list is complete. Optional: a port that gives it makes the names a unit that leaves Rovara must not
   * hold cover the whole roster; one that does not is covered by the project's approvers (`approvers`) and the people the units name.
   */
  projectMembers?(companyId: OrgId, project: string): Promise<{ complete: boolean; ids: string[] }>;
  /** The outside accounts the person linked (a code host's account ids). */
  linkedAccounts(companyId: OrgId, personId: string): Promise<readonly string[]>;
  /** The display name of a person who is or was in the company; undefined for someone who never was. */
  displayName(companyId: OrgId, personId: string): Promise<string | undefined>;
  isErased(companyId: OrgId, personId: string): Promise<boolean>;
  /** The member an id that was merged into another stands for (the end of the chain). Absent: ids compare as they are. */
  resolveMember?(companyId: OrgId, personId: string): Promise<string>;
}

/** What a task is, as lessons need it: its company, project and person. Undefined when there is no such task. */
export type HostedTaskReader = (taskId: string) => Promise<{ companyId: string; project: string; developerId: string } | undefined>;

export interface HostedLessonParts {
  directory: ApproverDirectory;
  tier0Authority: Tier0Authority;
  audiences: LessonAudiencePort;
  access: AccessCheckPort;
  names: AttributionReader;
}

/** Thrown for a question about another company: a programming error or an attack, never an answer. */
export class OtherCompanyError extends Error {
  constructor() { super("lessons were asked about another company"); this.name = "OtherCompanyError"; }
}

export function createHostedLessonParts(input: { companyId: OrgId; people: HostedLessonPeople; readTask: HostedTaskReader; taskVisibility?: (base: TaskVisibilityPort) => TaskVisibilityPort }): HostedLessonParts {
  const { companyId, people } = input;
  const same = (workspaceId: string): OrgId => {
    if (workspaceId !== companyId) throw new OtherCompanyError();
    return companyId;
  };
  const group = async (workspaceId: string, project: string | undefined): Promise<Tier0Group> => {
    const listed = await people.approvers(same(workspaceId), project);
    return { complete: listed.complete === true, membershipVersion: listed.membershipVersion, ownerIds: [...listed.ownerIds], eligibleIds: [...listed.eligibleIds], lastEligibleLossAtMs: listed.lastEligibleLossAtMs };
  };

  const directory: ApproverDirectory = {
    async eligibility(workspaceId, project) { return await group(workspaceId, project); },
    async identity(workspaceId, developerId): Promise<IdentitySet> {
      const company = same(workspaceId);
      // An account list that cannot be read leaves the person with no outside accounts: they then read only places nothing restricts (never more).
      let principals: readonly string[];
      try { principals = await people.linkedAccounts(company, developerId); } catch { principals = []; }
      return { principals: [...principals], groups: [], developerId };
    },
    ...(people.resolveMember === undefined ? {} : { resolveMember: async (workspaceId: string, developerId: string) => await people.resolveMember!(same(workspaceId), developerId) }),
  };

  const tier0Authority: Tier0Authority = {
    async eligibility(scope) { return await group(scope.workspaceId, scope.kind === "project" ? scope.project : undefined); },
  };

  const audiences: LessonAudiencePort = {
    async read(orgId, taskIds, options) {
      const out = new Map<string, LessonTaskAudience | undefined>();
      if (orgId !== companyId) return out;
      for (const taskId of new Set(taskIds)) {
        if (options?.signal?.aborted === true) break;
        try {
          const task = await input.readTask(taskId);
          if (task === undefined || task.companyId !== companyId) { out.set(taskId, undefined); continue; }
          const project = task.project;
          const memo = options?.memo;
          const onRoster = (person: string): Promise<boolean> => {
            const key = JSON.stringify([project, person]);
            let answer = memo?.get(key);
            if (answer === undefined) {
              answer = people.onProjectRoster(companyId, project, person);
              memo?.set(key, answer);
            }
            return answer;
          };
          out.set(taskId, { project, denied: new Set(), extras: new Set([task.developerId]), orgWide: false, otherProjects: new Set(), onRoster });
        } catch { out.set(taskId, undefined); }
      }
      return out;
    },
  };

  // The live visibility of a task is its project's (every core task is project-wide), and only for a task of this company.
  const baseVisibility: TaskVisibilityPort = {
    async read(orgId, taskIds) {
      const out = new Map<string, { kind: "shared" } | undefined>();
      for (const taskId of new Set(taskIds)) {
        if (orgId !== companyId) { out.set(taskId, undefined); continue; }
        try {
          const task = await input.readTask(taskId);
          out.set(taskId, task !== undefined && task.companyId === companyId ? { kind: "shared" } : undefined);
        } catch { out.set(taskId, undefined); }
      }
      return out;
    },
  };
  const withAudiences = withLessonAudiences(baseVisibility, audiences);
  const taskVisibility = input.taskVisibility === undefined ? withAudiences : input.taskVisibility(withAudiences);

  const access: AccessCheckPort = {
    taskVisibility,
    async mayRead(orgId, _viewer, places) {
      same(orgId);
      // No access record of any restricted place exists on this install: only places nothing restricts may be read, by anyone.
      return places.map((place) => place.restrictedScopes.length === 0);
    },
  };

  const names: AttributionReader = {
    async memberName(orgId, developerId) { return await people.displayName(same(orgId), developerId); },
    async isErased(orgId, developerId) { return await people.isErased(same(orgId), developerId); },
  };

  return { directory, tier0Authority, audiences, access, names };
}
