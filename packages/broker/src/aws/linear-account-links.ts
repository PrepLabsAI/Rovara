// Lead 2 L2-4 (DEC 254o c), rewritten for R1 + L1 (6.1): which member of a company a Linear account is, for the hosted tracker intake. A ticket starts a task only from a MEMBER's act
// (core/intake/engine.ts): the Linear account that labelled or created the ticket must be linked to a member of the company, or the ticket waits for a project admin to say "Start".
//
// The links are the generic account-link rows (core/people/account-links.ts), written only by the member's own sign-in at Linear (linear-account-link-routes.ts): a member links THEMSELVES, never
// by email, name or display text, and nobody else can link them. This file only READS them:
//   - A link counts only while the company is CONNECTED to the very workspace the link was made in (the row's key names it): after a disconnect, or a connect to another workspace, every old
//     link is nobody (fail closed; the disconnect also deletes the rows, so a later reconnect revives nothing).
//   - The workspace is never empty: the Linear adapter stamps the connected workspace on every account it returns (`askedIssue`), and the lookup refuses an empty or other workspace.
//   - The person is read live afterwards (the hosted identity's `getPrincipal`): a removed member, or one now in another company, is nobody.
import { OrgIdSchema, type DocumentStore, type ExternalAccountRef, type OrgId, type Principal } from "@agentx/contracts";
import { accountLinkOf, isLinkKeyPart } from "../core/people/account-links.js";
import type { LinearConnections } from "./linear-connections.js";

/** The provider id Linear accounts carry in the identity port and in the link rows. */
export const LINEAR_LINK_PROVIDER = "linear";

export interface LinkedLinearPerson { principal: Principal; linkedAt: string }

/**
 * Which member a Linear account is, and when they linked it (R1 + L1 6.2b: an act older than the link is not the member's consent). The company's CONNECTED workspace now, the link row under the company in THAT
 * workspace, then the person read live. Any other provider, a tenant that is empty or names another workspace (the adapter stamps the connected workspace on every account it returns, so a missing one is a bug, not a
 * default), or a company that is not connected: nobody.
 */
export function linearLinkResolver(deps: {
  store: Pick<DocumentStore, "get">;
  connections: Pick<LinearConnections, "connection">;
  principalOf: (companyId: OrgId, personId: string) => Promise<Principal | undefined>;
}): (companyId: string, account: ExternalAccountRef) => Promise<LinkedLinearPerson | undefined> {
  return async (companyId, account) => {
    const company = OrgIdSchema.safeParse(companyId);
    if (!company.success || account.provider !== LINEAR_LINK_PROVIDER) return undefined;
    const connection = await deps.connections.connection(company.data);
    if (connection === undefined || connection.status !== "connected") return undefined;
    if (!isLinkKeyPart(account.tenant) || account.tenant !== connection.organizationId) return undefined;
    const link = await accountLinkOf(deps.store, company.data, { provider: LINEAR_LINK_PROVIDER, tenant: connection.organizationId, accountId: account.accountId });
    if (link === undefined) return undefined;
    const person = await deps.principalOf(company.data, link.personId);
    return person !== undefined && person.companyId === company.data && person.personId === link.personId ? { principal: person, linkedAt: link.linkedAt } : undefined;
  };
}

/** The identity port's `resolveExternalAccount` for Linear accounts: `linearLinkResolver`'s person, without the time. */
export function linearAccountResolver(deps: Parameters<typeof linearLinkResolver>[0]): (companyId: string, account: ExternalAccountRef) => Promise<Principal | undefined> {
  const resolve = linearLinkResolver(deps);
  return async (companyId, account) => (await resolve(companyId, account))?.principal;
}

/**
 * Which member a COMMENT's author is, for the lessons' ticket-comment source only. A ticket's comments are read through the company's own token, so their authors are accounts of the connected workspace, but the comment
 * shape carries no workspace; it is stamped here, in the one place that reads comments, and the strict lookup does the rest. (The intake's accounts are stamped at the source, by `askedIssue`.)
 */
export function linearCommentAuthorResolver(deps: Parameters<typeof linearLinkResolver>[0]): (companyId: string, account: ExternalAccountRef) => Promise<Principal | undefined> {
  const strict = linearAccountResolver(deps);
  return async (companyId, account) => {
    const company = OrgIdSchema.safeParse(companyId);
    if (!company.success || account.provider !== LINEAR_LINK_PROVIDER || account.tenant !== "") return undefined;
    const connection = await deps.connections.connection(company.data);
    return connection === undefined || connection.status !== "connected" ? undefined : strict(companyId, { ...account, tenant: connection.organizationId });
  };
}
