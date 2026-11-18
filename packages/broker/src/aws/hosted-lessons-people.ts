// Lead 4 L4-LPPL: the lessons' people port (`HostedLessonPeople`) on a deployed install, built from Code's OWN hosted records, for one company at a time. Lessons, the team record and the lessons API
// were undefined on hosted until this was passed to `createBrokerCoreRoot` (`lessonsPeople`).
//
// Every answer is read live from the install's records when asked (strongly consistent reads, nothing kept between calls), is bound to the company the port was built for, and fails closed:
//   - a question that names another company throws (`OtherCompanyError`), it is never answered from this company's people;
//   - a person is on a roster only while their membership is live in THIS company (`COMPANY_MEMBER#`, never a token claim); a removed person drops out on the next read;
//   - who may approve: the company's live owners and admins, and (for a project) the live members whose grant on THAT project is `administrator` (a maintainer). The same two readers the setup approval
//     and the upkeep recipients use, so the answer matches what the rest of the broker already says about a person's standing;
//   - the roster of a project is every live company member for whom `onProjectRoster` says yes, found from the company's member list (bounded: a company over the cap, a page that cannot be read or
//     a person whose rows cannot be read THROWS, never a shorter list);
//   - names are the one display helper's (`profileDisplayName`, DN1) and only for a person who is or was in THIS company; an unreadable record names nobody;
//   - erase: the person's receipt in the company's own core store.
// Not stored anywhere new, no cache, no model. Nothing here writes.
//
// `membershipVersion` is a generation id, not a counter: a hash of the two lists, so it differs whenever who may approve differs (compare for equality only). `lastEligibleLossAtMs` is the newest time the
// company's member records say an owner or admin was removed or demoted (a removed PROJECT maintainer leaves no record, so that loss is not seen: the sole-owner cool-off cannot count it).
import { createHash } from "node:crypto";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { OrgIdSchema, type DocumentStore, type OrgId } from "@agentx/contracts";
import { personErasedKey, isErasablePersonId } from "../core/people/erase.js";
import { CompanySignInStore } from "../developer/company-membership.js";
import { OtherCompanyError, type HostedApprovers, type HostedLessonPeople } from "../lessons/hosted-people.js";
import { MERGE_HOPS_MAX } from "./install-company.js";
import { hostedDisplayNameOf, membershipWithRoleFromDynamo, personStandingFromDynamo, projectGrantRoleFromDynamo } from "./core-engine-root.js";

type DynamoSender = { send(command: unknown): Promise<unknown> };

/** Members read from the company's list: 5 pages of 100. A company with more is not served (the call throws: a roster that is not complete is not given). */
export const HOSTED_PEOPLE_MEMBERS_MAX = 500;
const PAGE = 100;
/** How many people's rows are read at once. */
const READ_PARALLEL = 8;
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const PERSON_ID = /^[a-f0-9]{64}$/u;

export interface HostedLessonsPeopleBase {
  documentClient: DynamoSender;
  stateTableName: string;
  /** The sign-in table. Undefined or empty: the install has no company layer, and every answer throws. */
  signInTableName: string | undefined;
  now: () => number;
}

/** What one company's port needs from the core: its store (the person erase receipts live there), asked for only when an erase is read. */
export interface HostedLessonsPeopleContext {
  store: () => Promise<Pick<DocumentStore, "get">>;
}

const incomplete = (): never => { throw new Error("the company's people could not be listed completely"); };
const unreadable = (): never => { throw new Error("the company's people could not be read"); };

/** Runs `work` over `items` with at most READ_PARALLEL in flight; the first failure rejects the whole call (no partial answer). */
async function mapLimited<T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(READ_PARALLEL, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      out[index] = await work(items[index]!);
    }
  });
  await Promise.all(lanes);
  return out;
}

const msOf = (iso: string | undefined): number | undefined => {
  if (iso === undefined) return undefined;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? at : unreadable();
};

/** The port factory for a deployment: `(companyId, context) => HostedLessonPeople`, for `BrokerCoreRootInputs.lessonsPeople`. Building a port reads nothing. */
export function createHostedLessonsPeople(base: HostedLessonsPeopleBase): (companyId: OrgId, context: HostedLessonsPeopleContext) => HostedLessonPeople {
  return (companyIdInput, context) => {
    const company = OrgIdSchema.parse(companyIdInput);
    const table = base.signInTableName;
    const same = (companyId: string): OrgId => {
      if (companyId !== company) throw new OtherCompanyError();
      return company;
    };
    const withTable = <T>(use: (signIn: string) => T): T => {
      if (table === undefined || table === "") return unreadable();
      return use(table);
    };
    const membershipOf = (personId: string) => withTable((signIn) => membershipWithRoleFromDynamo(base.documentClient, signIn)(personId));
    const grantOf = projectGrantRoleFromDynamo(base.documentClient, base.stateTableName);
    const checkedProject = (project: string): string => {
      if (typeof project !== "string" || !PROJECT_NAME.test(project)) return unreadable();
      return project;
    };

    /** The company's member list (the sign-in table's mirror, company-checked row by row), every page, up to the cap. A list that is longer or cannot be read throws. */
    async function listedMembers() {
      return await withTable(async (signIn) => {
        const store = new CompanySignInStore({ documentClient: base.documentClient, tableName: signIn, now: base.now });
        const seen = new Map<string, Awaited<ReturnType<CompanySignInStore["listMembers"]>>["members"][number]>();
        let cursor: string | undefined;
        for (let page = 0; page < HOSTED_PEOPLE_MEMBERS_MAX / PAGE; page += 1) {
          const answer = await store.listMembers(company, cursor, PAGE);
          for (const member of answer.members) {
            if (member.companyId !== company || !PERSON_ID.test(member.personId)) return unreadable();
            seen.set(member.personId, member);
          }
          if (!answer.more) return [...seen.values()];
          cursor = answer.cursor;
        }
        return incomplete();
      });
    }

    async function onProjectRoster(companyId: string, project: string, personId: string): Promise<boolean> {
      same(companyId);
      // A name that is not a project's can have nobody on its roster; asked of nobody's data, not an error.
      if (typeof project !== "string" || !PROJECT_NAME.test(project)) return false;
      const membership = await membershipOf(personId);
      if (membership === undefined || membership.companyId !== company) return false;
      if (membership.role === "owner" || membership.role === "admin") return true;
      return (await grantOf(personId, project)) !== undefined;
    }

    return {
      async approvers(companyId, project): Promise<HostedApprovers> {
        same(companyId);
        const scope = project === undefined ? undefined : checkedProject(project);
        const rows = await listedMembers();
        const answers = await mapLimited(rows, async (row) => {
          const live = await membershipOf(row.personId);
          if (live === undefined || live.companyId !== company) return { row, owner: false, eligible: false };
          const admin = live.role === "owner" || live.role === "admin";
          const maintainer = !admin && scope !== undefined && (await grantOf(row.personId, scope)) === "administrator";
          return { row, owner: live.role === "owner", eligible: admin || maintainer };
        });
        const ownerIds = answers.filter((answer) => answer.owner).map((answer) => answer.row.personId).sort();
        const eligibleIds = answers.filter((answer) => answer.eligible).map((answer) => answer.row.personId).sort();
        // The newest loss the member records show: an owner or admin who was removed, or a plain member whose role was changed (to member: a demotion, there is no lower role to come from).
        let loss: number | undefined;
        const lost = (at: number | undefined): void => { if (at !== undefined && (loss === undefined || at > loss)) loss = at; };
        for (const { row } of answers) {
          if (row.revokedAt !== undefined && (row.role === "owner" || row.role === "admin")) lost(msOf(row.revokedAt));
          if (row.role === "member") lost(msOf(row.updatedAt));
        }
        const generation = createHash("sha256").update(JSON.stringify([company, scope ?? null, ownerIds, eligibleIds])).digest().readUIntBE(0, 6);
        return { complete: true, membershipVersion: generation, ownerIds, eligibleIds, lastEligibleLossAtMs: loss === undefined ? null : Math.min(loss, base.now()) };
      },

      onProjectRoster,

      async projectMembers(companyId, project) {
        same(companyId);
        const scope = checkedProject(project);
        const rows = await listedMembers();
        const on = await mapLimited(rows, async (row) => ({ id: row.personId, on: await onProjectRoster(company, scope, row.personId) }));
        return on.filter((answer) => answer.on).map((answer) => answer.id).sort();
      },

      async linkedAccounts(companyId) {
        same(companyId);
        // No outside account is linked on this install's records yet: a person reads only places nothing restricts (`hosted-people.ts`), never more.
        return [];
      },

      async displayName(companyId, personId) {
        same(companyId);
        const standing = await withTable((signIn) => personStandingFromDynamo(base.documentClient, signIn)(company, personId));
        // Never in THIS company (another company's person, or nobody): no name. A former member is named (their record, if still readable), as the port says.
        if (standing === "unknown") return undefined;
        return await withTable((signIn) => hostedDisplayNameOf(base.documentClient, signIn)(personId));
      },

      async isErased(companyId, personId) {
        same(companyId);
        // An id no erase could have been made for names nobody, so it reads as erased (never named, nothing learned from it).
        if (!isErasablePersonId(personId)) return true;
        return (await (await context.store()).get(personErasedKey(company, personId))) !== undefined;
      },

      async resolveMember(companyId, personId) {
        same(companyId);
        if (typeof personId !== "string" || personId === "" || /[#\s]/u.test(personId)) return personId;
        const signIn = withTable((name) => name);
        const read = async (id: string): Promise<Record<string, unknown> | undefined> => {
          const response = await base.documentClient.send(new GetCommand({ TableName: signIn, Key: { pk: `DEVELOPER#${id}`, sk: "META" }, ConsistentRead: true })) as { Item?: Record<string, unknown> };
          return response?.Item;
        };
        const seen = new Set<string>([personId]);
        let current = personId;
        let record = await read(current);
        // An id with no sign-in record was never merged (a system id, a person who never signed in): it stands for itself.
        if (record === undefined) return personId;
        for (let hop = 0; hop <= MERGE_HOPS_MAX; hop += 1) {
          const next = record["mergedInto"];
          if (next === undefined) break;
          if (typeof next !== "string" || !PERSON_ID.test(next) || seen.has(next) || hop === MERGE_HOPS_MAX) return unreadable();
          seen.add(next);
          current = next;
          const found = await read(current);
          if (found === undefined) return unreadable();
          record = found;
        }
        if (current === personId) return personId;
        // The survivor must be one of THIS company's people (current or former): a merge never carries a person into another company's lessons.
        if ((await personStandingFromDynamo(base.documentClient, signIn)(company, current)) === "unknown") return unreadable();
        return current;
      },
    };
  };
}
