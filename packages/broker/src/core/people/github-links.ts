// L4-GH: which member of a company a GitHub account is, so the hosted identity point can place the author of a commit or a review (human-edit learning, merge approvers).
//
// Two rows per link, written in ONE transaction, both under the company (so the company purge, which removes every `ORG#<company>#...` partition, removes them):
//   - by account: `ORG#<company>#GITHUB_ACCOUNT_LINK` / `USER#<GitHub's numeric user id>` -> the person. Written only where none exists, so one GitHub account links to at most one member
//     per company (first link wins); a second member never takes it over.
//   - by person:  `ORG#<company>#GITHUB_ACCOUNT_OF` / `PERSON#<person>` -> the account. Written only where none exists, so a person links at most one GitHub account (unlink first to change it).
// Only the numeric id (GitHub's stable subject; a login can be renamed and reused) and the login (display text only, never matched on) are kept. Never a token, an email or a name.
//
// Reads are always under the asking company, and a row counts only when it names that company, that id and that person; a copied or malformed row is nobody. The person is read live afterwards
// by the identity point (`getPrincipal`), so a removed member, or one now in another company, is nobody.
//
// How a person proves the account is theirs is the writer's business (aws/github-account-link-routes.ts: a GitHub user authorization, never a body or a header); nothing here proves anything.
import { OrgIdSchema, orgScoped, when, type DocumentKey, type DocumentStore, type OrgId, type StoredDocument } from "@agentx/contracts";

/** The provider id GitHub accounts carry in the identity port (`ExternalAccountRef.provider`); the tenant is always empty text. */
export const GITHUB_LINK_PROVIDER = "github";

/** GitHub's numeric user id as text: digits, no leading zero. */
const GITHUB_USER_ID = /^[1-9][0-9]{0,15}$/u;
/** A person id as a key part (as the person erase takes it). */
const PERSON_ID = /^[A-Za-z0-9_.-]{1,100}$/u;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;

export const GITHUB_ACCOUNT_LINK = "GITHUB_ACCOUNT_LINK";
export const GITHUB_ACCOUNT_OF = "GITHUB_ACCOUNT_OF";

export const isGithubUserId = (value: unknown): value is string => typeof value === "string" && GITHUB_USER_ID.test(value);
const isPersonId = (value: unknown): value is string => typeof value === "string" && PERSON_ID.test(value);
export const isGithubLogin = (value: unknown): value is string => typeof value === "string" && LOGIN.test(value);

export const githubAccountsPk = (companyId: string): string => orgScoped(OrgIdSchema.parse(companyId), GITHUB_ACCOUNT_LINK);
export const githubPeoplePk = (companyId: string): string => orgScoped(OrgIdSchema.parse(companyId), GITHUB_ACCOUNT_OF);
export function githubAccountKey(companyId: string, githubUserId: string): DocumentKey {
  if (!isGithubUserId(githubUserId)) throw new Error("the GitHub account id is not valid");
  return { pk: githubAccountsPk(companyId), sk: `USER#${githubUserId}` };
}
export function githubPersonKey(companyId: string, personId: string): DocumentKey {
  if (!isPersonId(personId)) throw new Error("the person id is not valid");
  return { pk: githubPeoplePk(companyId), sk: `PERSON#${personId}` };
}

/** What a person's link says about it. */
export interface GithubLink { accountId: string; login: string; linkedAt: string }

/** The person a GitHub account is linked to in this company, or undefined for anything else (no row, another company's row, a malformed row). */
export async function linkedGithubPerson(store: Pick<DocumentStore, "get">, companyId: OrgId, githubUserId: string): Promise<string | undefined> {
  if (!isGithubUserId(githubUserId)) return undefined;
  const key = githubAccountKey(companyId, githubUserId);
  const row = await store.get(key);
  if (row === undefined || row["pk"] !== key.pk || row["sk"] !== key.sk || row["entityType"] !== GITHUB_ACCOUNT_LINK) return undefined;
  if (row["companyId"] !== companyId || row["githubUserId"] !== githubUserId) return undefined;
  const personId = row["personId"];
  return isPersonId(personId) ? personId : undefined;
}

/** The GitHub account a person linked in this company (both rows must agree), or undefined. */
export async function githubLinkOf(store: Pick<DocumentStore, "get">, companyId: OrgId, personId: string): Promise<GithubLink | undefined> {
  if (!isPersonId(personId)) return undefined;
  const key = githubPersonKey(companyId, personId);
  const row = await store.get(key);
  if (row === undefined || row["pk"] !== key.pk || row["sk"] !== key.sk || row["entityType"] !== GITHUB_ACCOUNT_OF) return undefined;
  if (row["companyId"] !== companyId || row["personId"] !== personId) return undefined;
  const accountId = row["githubUserId"];
  if (!isGithubUserId(accountId)) return undefined;
  // The account's own row must name this person (a person row alone, left over or copied, is nobody).
  if (await linkedGithubPerson(store, companyId, accountId) !== personId) return undefined;
  const login = row["login"];
  const linkedAt = row["linkedAt"];
  return { accountId, login: isGithubLogin(login) ? login : "", linkedAt: typeof linkedAt === "string" ? linkedAt : "" };
}

/** Who did it and when, for the company's audit record of a link or an unlink: the person's id and the act only (never the GitHub id or login, so an erase leaves no GitHub identity behind). */
export interface GithubLinkAudit { at: string; actor: string }
export const GITHUB_LINK_AUDIT = "GITHUB_LINK_AUDIT";
export const githubAuditPk = (companyId: string): string => orgScoped(OrgIdSchema.parse(companyId), GITHUB_LINK_AUDIT);
function auditItem(companyId: string, action: "linked" | "unlinked", audit: GithubLinkAudit, personId: string): StoredDocument {
  return { pk: githubAuditPk(companyId), sk: `${audit.at}#${action}#${personId}`, entityType: GITHUB_LINK_AUDIT, companyId, action, personId, actor: audit.actor, at: audit.at };
}

export type GithubLinkOutcome = "linked" | "same" | "taken" | "person_has_another";

/**
 * Links a GitHub account to a person (the caller has already proved, with a GitHub user authorization in this request, that the account is the person's, and that the person is a live member of
 * `companyId`). `linked`: written now. `same`: this person already holds exactly this account. `taken`: another person of the company holds the account (nothing changed).
 * `person_has_another`: this person holds a different account (nothing changed; unlink first).
 */
export async function linkGithubAccount(store: Pick<DocumentStore, "get" | "transact">, input: { companyId: string; githubUserId: string; login: string; personId: string; linkedAt: string; audit?: GithubLinkAudit }): Promise<GithubLinkOutcome> {
  const companyId = OrgIdSchema.parse(input.companyId);
  if (!isGithubUserId(input.githubUserId) || !isGithubLogin(input.login) || !isPersonId(input.personId)) throw new Error("the GitHub account link is not valid");
  const accountKey = githubAccountKey(companyId, input.githubUserId);
  const personKey = githubPersonKey(companyId, input.personId);
  const account: StoredDocument = { ...accountKey, entityType: GITHUB_ACCOUNT_LINK, companyId, githubUserId: input.githubUserId, login: input.login, personId: input.personId, linkedAt: input.linkedAt };
  const person: StoredDocument = { ...personKey, entityType: GITHUB_ACCOUNT_OF, companyId, personId: input.personId, githubUserId: input.githubUserId, login: input.login, linkedAt: input.linkedAt };
  const written = await store.transact([
    { kind: "put", item: account, condition: when.absent() }, { kind: "put", item: person, condition: when.absent() },
    ...(input.audit === undefined ? [] : [{ kind: "put" as const, item: auditItem(companyId, "linked", input.audit, input.personId) }]),
  ]);
  if (written.applied) return "linked";
  const holder = await linkedGithubPerson(store, companyId, input.githubUserId);
  if (holder !== undefined && holder !== input.personId) return "taken";
  const held = await githubLinkOf(store, companyId, input.personId);
  if (held !== undefined) return held.accountId === input.githubUserId ? "same" : "person_has_another";
  // A half-written pair cannot come from this writer (one transaction); anything else is a fault for the caller to report, never a guess.
  throw new Error("the GitHub account link could not be written");
}

/**
 * Removes the person's link in this company: both rows, the account row only while it still names this person. `true`: there was a link. With `audit`, the removal and its audit record are one
 * transaction (a person unlinking themselves); the person erase passes none (the erase has its own record).
 */
export async function unlinkGithubAccount(store: Pick<DocumentStore, "get" | "delete" | "transact">, companyId: string, personId: string, options: { audit?: GithubLinkAudit } = {}): Promise<boolean> {
  const company = OrgIdSchema.parse(companyId);
  if (!isPersonId(personId)) return false;
  const personKey = githubPersonKey(company, personId);
  const row = await store.get(personKey);
  if (row === undefined) return false;
  const accountId = row["githubUserId"];
  const accountHeld = isGithubUserId(accountId) && await linkedGithubPerson(store, company, accountId) === personId;
  if (options.audit !== undefined) {
    const removed = await store.transact([
      ...(accountHeld ? [{ kind: "delete" as const, key: githubAccountKey(company, accountId) }] : []),
      { kind: "delete", key: personKey },
      { kind: "put", item: auditItem(company, "unlinked", options.audit, personId) },
    ]);
    if (!removed.applied) throw new Error("the GitHub account link could not be removed");
    return true;
  }
  if (accountHeld) await store.delete({ key: githubAccountKey(company, accountId) });
  await store.delete({ key: personKey });
  return true;
}

/** The identity port's reader over these rows: the hosted identity point resolves a GitHub account to a person id, and a person to their account. */
export interface GithubLinkReader {
  personOf(companyId: OrgId, githubUserId: string): Promise<string | undefined>;
  accountOf(companyId: OrgId, personId: string): Promise<string | undefined>;
}

export function githubLinkReaderOver(store: Pick<DocumentStore, "get">): GithubLinkReader {
  return {
    personOf: (companyId, githubUserId) => linkedGithubPerson(store, companyId, githubUserId),
    accountOf: async (companyId, personId) => (await githubLinkOf(store, companyId, personId))?.accountId,
  };
}
