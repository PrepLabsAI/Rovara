// Lead 2 L2-4 (DEC 254o c): which member of a company a Linear account is, for the hosted tracker intake. A ticket starts a task only from a MEMBER's act (core/intake/engine.ts):
// the Linear account that labelled or created the ticket must be linked to a member of the company, or the ticket waits for a project admin to say "Start".
//
//   - One row per Linear user per company: `ORG#<company>#LINEAR_ACCOUNT` / `USER#<linear user id>`, naming the person and the Linear workspace (organization id) the link was made in.
//     It is read only under the company asking, so company B's links are never read for company A's tickets.
//   - A link counts only while the company is CONNECTED to that same Linear workspace: after a disconnect, or a reconnect to another workspace, every old link is nobody (fail closed).
//   - The person is read live afterwards (the hosted identity's `getPrincipal`): a removed member, or one now in another company, is nobody.
//   - First link wins: a link is written only where none exists (conditional), so a second person can never take over a Linear account that is already someone's.
//   - Never by email, name or display text: only the stable Linear user id the signed delivery names, against a row written after the member proved the account is theirs.
//     How a member proves it is an owner product call (briefs/guided-onboarding-build-20261117.md, Questions (L2-4)); until that route lands no row is written in production and
//     every person's ticket waits (`unlinked`), which is the engine's safe default.
import { OrgIdSchema, orgScoped, when, type DocumentStore, type ExternalAccountRef, type OrgId, type Principal } from "@agentx/contracts";
import type { LinearConnections } from "./linear-connections.js";

/** A Linear user id as Linear sends it (a UUID; held to plain id characters so it is safe in a key). */
const LINEAR_USER_ID = /^[A-Za-z0-9-]{1,100}$/u;
const PERSON_ID = /^[^#\s]{1,256}$/u;

export const LINEAR_ACCOUNT_LINK = "LINEAR_ACCOUNT_LINK";
export const linearAccountsPk = (companyId: string) => orgScoped(OrgIdSchema.parse(companyId), "LINEAR_ACCOUNT");
export const linearAccountLinkKey = (companyId: string, linearUserId: string) => ({ pk: linearAccountsPk(companyId), sk: `USER#${linearUserId}` });

/**
 * Writes a link (first wins). `linked`: written now; `same`: this person already holds it; `taken`: another person holds it (nothing changed). The caller has checked that `organizationId` is the
 * company's connected workspace and that the person proved the Linear account is theirs.
 */
export async function linkLinearAccount(store: Pick<DocumentStore, "get" | "put">, input: {
  companyId: string; organizationId: string; linearUserId: string; personId: string; linkedAt: string;
}): Promise<"linked" | "same" | "taken"> {
  const companyId = OrgIdSchema.parse(input.companyId);
  if (!LINEAR_USER_ID.test(input.linearUserId) || !LINEAR_USER_ID.test(input.organizationId) || !PERSON_ID.test(input.personId)) throw new Error("the Linear account link is not valid");
  const key = linearAccountLinkKey(companyId, input.linearUserId);
  const written = await store.put({
    item: { ...key, entityType: LINEAR_ACCOUNT_LINK, companyId, organizationId: input.organizationId, linearUserId: input.linearUserId, personId: input.personId, linkedAt: input.linkedAt },
    condition: when.notExists("pk"),
  });
  if (written.applied) return "linked";
  const held = await store.get(key);
  return held?.["personId"] === input.personId && held["companyId"] === companyId && held["organizationId"] === input.organizationId ? "same" : "taken";
}

/** The person a Linear user is linked to in this company, for this Linear workspace; undefined for anything else (another company's row, another workspace, a malformed row). */
export async function linkedLinearPerson(store: Pick<DocumentStore, "get">, companyId: OrgId, organizationId: string, linearUserId: string): Promise<string | undefined> {
  if (!LINEAR_USER_ID.test(linearUserId)) return undefined;
  const key = linearAccountLinkKey(companyId, linearUserId);
  const row = await store.get(key);
  if (row === undefined || row["pk"] !== key.pk || row["sk"] !== key.sk || row["entityType"] !== LINEAR_ACCOUNT_LINK) return undefined;
  if (row["companyId"] !== companyId || row["organizationId"] !== organizationId || row["linearUserId"] !== linearUserId) return undefined;
  const personId = row["personId"];
  return typeof personId === "string" && PERSON_ID.test(personId) ? personId : undefined;
}

/**
 * The identity port's `resolveExternalAccount` for Linear accounts on a hosted install: the company's CONNECTED workspace now, the link row under the company, then the person read live.
 * Any other provider, a tenant that names another workspace, or a company that is not connected: nobody.
 */
export function linearAccountResolver(deps: {
  store: Pick<DocumentStore, "get">;
  connections: Pick<LinearConnections, "connection">;
  principalOf: (companyId: OrgId, personId: string) => Promise<Principal | undefined>;
}): (companyId: string, account: ExternalAccountRef) => Promise<Principal | undefined> {
  return async (companyId, account) => {
    const company = OrgIdSchema.safeParse(companyId);
    if (!company.success || account.provider !== "linear") return undefined;
    const connection = await deps.connections.connection(company.data);
    if (connection === undefined || connection.status !== "connected") return undefined;
    if (account.tenant !== "" && account.tenant !== connection.organizationId) return undefined;
    const personId = await linkedLinearPerson(deps.store, company.data, connection.organizationId, account.accountId);
    if (personId === undefined) return undefined;
    const person = await deps.principalOf(company.data, personId);
    return person !== undefined && person.companyId === company.data && person.personId === personId ? person : undefined;
  };
}
