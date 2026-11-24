// Lead 2 L2-4 (DEC 254o c), rewritten for R1 + L1 (6.1): which member of a company a Linear account is, for the hosted tracker intake. A ticket starts a task only from a MEMBER's act
// (core/intake/engine.ts): the Linear account that labelled or created the ticket must be linked to a member of the company, or the ticket waits for a project admin to say "Start".
//
// The links are the generic account-link rows (core/people/account-links.ts), written only by the member's own sign-in at Linear (linear-account-link-routes.ts): a member links THEMSELVES, never
// by email, name or display text, and nobody else can link them. This file only READS them:
//   - A link counts only while the company is CONNECTED to the very workspace the link was made in (the row's key names it): after a disconnect, or a connect to another workspace, every old
//     link is nobody (fail closed; the disconnect also deletes the rows, so a later reconnect revives nothing).
//   - The workspace is never empty: an account that arrives without one is stamped with the connected workspace (`hostedLinearResolver`) before the lookup, and the lookup itself refuses an
//     empty or other workspace.
//   - The person is read live afterwards (the hosted identity's `getPrincipal`): a removed member, or one now in another company, is nobody.
import { OrgIdSchema, type DocumentStore, type ExternalAccountRef, type OrgId, type Principal } from "@agentx/contracts";
import { accountLinkOf, isLinkKeyPart } from "../core/people/account-links.js";
import type { LinearConnections } from "./linear-connections.js";

/** The provider id Linear accounts carry in the identity port and in the link rows. */
export const LINEAR_LINK_PROVIDER = "linear";

/**
 * The identity port's `resolveExternalAccount` for Linear accounts on a hosted install: the company's CONNECTED workspace now, the link row under the company in THAT workspace, then the person read
 * live. Any other provider, a tenant that is empty or names another workspace, or a company that is not connected: nobody.
 */
export function linearAccountResolver(deps: {
  store: Pick<DocumentStore, "get">;
  connections: Pick<LinearConnections, "connection">;
  principalOf: (companyId: OrgId, personId: string) => Promise<Principal | undefined>;
}): (companyId: string, account: ExternalAccountRef) => Promise<Principal | undefined> {
  return async (companyId, account) => {
    const company = OrgIdSchema.safeParse(companyId);
    if (!company.success || account.provider !== LINEAR_LINK_PROVIDER) return undefined;
    const connection = await deps.connections.connection(company.data);
    if (connection === undefined || connection.status !== "connected") return undefined;
    if (!isLinkKeyPart(account.tenant) || account.tenant !== connection.organizationId) return undefined;
    const link = await accountLinkOf(deps.store, company.data, { provider: LINEAR_LINK_PROVIDER, tenant: connection.organizationId, accountId: account.accountId });
    if (link === undefined) return undefined;
    const person = await deps.principalOf(company.data, link.personId);
    return person !== undefined && person.companyId === company.data && person.personId === link.personId ? person : undefined;
  };
}

/**
 * The resolver the hosted intake uses. The Linear adapter's accounts carry no workspace of their own (every Linear account this install sees came through the company's own connected
 * workspace), so an empty tenant is stamped with the connected workspace before the strict lookup above; a tenant that is given must match it. (6.2 stamps at the source and removes this wrapper.)
 */
export function hostedLinearResolver(deps: Parameters<typeof linearAccountResolver>[0]): (companyId: string, account: ExternalAccountRef) => Promise<Principal | undefined> {
  const strict = linearAccountResolver(deps);
  return async (companyId, account) => {
    if (account.provider !== LINEAR_LINK_PROVIDER || account.tenant !== "") return strict(companyId, account);
    const company = OrgIdSchema.safeParse(companyId);
    if (!company.success) return undefined;
    const connection = await deps.connections.connection(company.data);
    if (connection === undefined || connection.status !== "connected") return undefined;
    return strict(companyId, { ...account, tenant: connection.organizationId });
  };
}
