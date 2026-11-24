// R1 + L1 (6.1): which member of a company an outside account is (a Linear user today; Jira later), so a ticket's act can be placed as a member. One generic store keyed by provider, so a second
// tracker needs no new rows. GitHub's links stay on their own file (github-links.ts) until a later lane moves them.
//
// Two rows per link, written in ONE transaction, both under the company (so the company purge, which removes every `ORG#<company>#...` partition, removes them):
//   - by account: `ORG#<company>#ACCOUNT_LINK` / `ACCT#<provider>#<tenant>#<account id>` -> the person. Written only where none exists (first link wins): one outside account links to at most one
//     member per company; a second member never takes it over.
//   - by person:  `ORG#<company>#ACCOUNT_OF` / `PERSON#<person>#<provider>` -> the account. Written only where none exists: a person links at most one account per provider (unlink first to change it).
// Kept: the account id (the provider's stable subject), the tenant (the provider's workspace or site, never empty), the display text the provider showed (text only, never matched on) and when. Never an
// email, a token or a code. The audit rows (`ACCOUNT_LINK_AUDIT`) carry person ids and the provider only, never the account id or its display text.
//
// Reads are always under the asking company, and a row counts only when it names that company, provider, tenant, account and person; a copied or malformed row is nobody. The person is read live
// afterwards by the identity point (`getPrincipal`), so a removed member, or one now in another company, is nobody. The link's `linkedAt` is returned so a reader can refuse an act older than the
// link (a past act is not consent now).
//
// How a person proves the account is theirs is the writer's business (aws/linear-account-link-routes.ts: the provider's own sign-in, never a body or a header); nothing here proves anything.
import { OrgIdSchema, orgScoped, queryAll, when, type DocumentKey, type DocumentStore, type StoredDocument } from "@agentx/contracts";

export const ACCOUNT_LINK = "ACCOUNT_LINK";
export const ACCOUNT_OF = "ACCOUNT_OF";
export const ACCOUNT_LINK_AUDIT = "ACCOUNT_LINK_AUDIT";

/** The provider ids of the outside accounts a company's members can link (the identity port's `ExternalAccountRef.provider`). */
const PROVIDER = /^[a-z][a-z0-9_.:-]{0,63}$/u;
/** A workspace or site id and an account id: plain id characters, so each is safe in a key (no `#`, no whitespace). Never empty. */
const KEY_PART = /^[A-Za-z0-9_.:-]{1,100}$/u;
const PERSON_ID = /^[A-Za-z0-9_.-]{1,100}$/u;
/** The most links one company's list reads (past this the whole read is refused, never cut). */
export const ACCOUNT_LINKS_MAX = 1_000;

export const isLinkProvider = (value: unknown): value is string => typeof value === "string" && PROVIDER.test(value);
export const isLinkKeyPart = (value: unknown): value is string => typeof value === "string" && KEY_PART.test(value);
const isPersonId = (value: unknown): value is string => typeof value === "string" && PERSON_ID.test(value);

/** Display text as the provider showed it: bounded, no control characters; empty when it is not usable. */
export function cleanDisplay(value: unknown): string {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 100);
}

/** An outside account: the provider, its workspace or site, and its own id for the person. */
export interface LinkedAccountRef { provider: string; tenant: string; accountId: string }
/** One link as stored. `via: "self"` is the only way a link is made: the person proved the account with the provider's own sign-in. */
export interface AccountLink extends LinkedAccountRef { personId: string; display: string; via: "self"; linkedAt: string }

export const accountLinksPk = (companyId: string): string => orgScoped(OrgIdSchema.parse(companyId), ACCOUNT_LINK);
export const accountOfPk = (companyId: string): string => orgScoped(OrgIdSchema.parse(companyId), ACCOUNT_OF);
export const accountLinkAuditPk = (companyId: string): string => orgScoped(OrgIdSchema.parse(companyId), ACCOUNT_LINK_AUDIT);

export function accountLinkKey(companyId: string, account: LinkedAccountRef): DocumentKey {
  if (!isLinkProvider(account.provider) || !isLinkKeyPart(account.tenant) || !isLinkKeyPart(account.accountId)) throw new Error("the account link is not valid");
  return { pk: accountLinksPk(companyId), sk: `ACCT#${account.provider}#${account.tenant}#${account.accountId}` };
}
export function accountOfKey(companyId: string, personId: string, provider: string): DocumentKey {
  if (!isPersonId(personId) || !isLinkProvider(provider)) throw new Error("the account link is not valid");
  return { pk: accountOfPk(companyId), sk: `PERSON#${personId}#${provider}` };
}

/** Who did it and how, for the audit record of a link or an unlink: the actor's person id (never the outside account). `by: admin` is a company owner or admin removing someone else's link. */
export interface AccountLinkAudit { at: string; actor: string; by: "self" | "admin" }
function auditItem(companyId: string, action: "tracker.account_linked" | "tracker.account_unlinked", provider: string, personId: string, audit: AccountLinkAudit): StoredDocument {
  return {
    pk: accountLinkAuditPk(companyId), sk: `${audit.at}#${action}#${provider}#${personId}`, entityType: ACCOUNT_LINK_AUDIT, companyId, action, provider, personId, actor: audit.actor, by: audit.by, at: audit.at,
  };
}

/** A stored row as a link: every field plain and the row's own key the one its fields give (`keyOf`), else nobody. */
function linkOfRow(companyId: string, row: StoredDocument | undefined, entityType: string, keyOf: (link: AccountLink) => DocumentKey): AccountLink | undefined {
  if (row === undefined || row["entityType"] !== entityType || row["companyId"] !== companyId) return undefined;
  const { provider, tenant, accountId, personId, display, linkedAt } = row;
  if (!isLinkProvider(provider) || !isLinkKeyPart(tenant) || !isLinkKeyPart(accountId) || !isPersonId(personId) || row["via"] !== "self" || typeof linkedAt !== "string") return undefined;
  const link: AccountLink = { provider, tenant, accountId, personId, display: cleanDisplay(display), via: "self", linkedAt };
  const key = keyOf(link);
  return row["pk"] === key.pk && row["sk"] === key.sk ? link : undefined;
}
const byAccount = (companyId: string) => (link: AccountLink): DocumentKey => accountLinkKey(companyId, link);
const byPerson = (companyId: string) => (link: AccountLink): DocumentKey => accountOfKey(companyId, link.personId, link.provider);

/** The link an outside account holds in this company (the account's own row, read by its key), or undefined for anything else (no row, another company's row, a malformed row). */
export async function accountLinkOf(store: Pick<DocumentStore, "get">, companyId: string, account: LinkedAccountRef): Promise<AccountLink | undefined> {
  const company = OrgIdSchema.parse(companyId);
  if (!isLinkProvider(account.provider) || !isLinkKeyPart(account.tenant) || !isLinkKeyPart(account.accountId)) return undefined;
  const link = linkOfRow(company, await store.get(accountLinkKey(company, account)), ACCOUNT_LINK, byAccount(company));
  return link !== undefined && link.provider === account.provider && link.tenant === account.tenant && link.accountId === account.accountId ? link : undefined;
}

/** The link a person holds for one provider in this company (both rows must agree), or undefined. */
export async function personAccountLink(store: Pick<DocumentStore, "get">, companyId: string, personId: string, provider: string): Promise<AccountLink | undefined> {
  const company = OrgIdSchema.parse(companyId);
  if (!isPersonId(personId) || !isLinkProvider(provider)) return undefined;
  const link = linkOfRow(company, await store.get(accountOfKey(company, personId, provider)), ACCOUNT_OF, byPerson(company));
  if (link === undefined || link.personId !== personId || link.provider !== provider) return undefined;
  // The account's own row must name this person and say the same (a person row alone, left over or copied, is nobody).
  const held = await accountLinkOf(store, company, link);
  return held !== undefined && held.personId === personId && held.linkedAt === link.linkedAt ? held : undefined;
}

export type AccountLinkOutcome = "linked" | "same" | "taken" | "person_has_another";

/**
 * Links an outside account to a person. The caller has proved, with the provider's own sign-in in this request, that the account is the person's, that the person is a live member of
 * `companyId`, and that `tenant` is the workspace the company is connected to. `linked`: written now. `same`: this person already holds exactly this account. `taken`: another person of the company
 * holds the account (nothing changed). `person_has_another`: this person holds a different account for the provider (nothing changed; unlink first).
 */
export async function linkAccount(store: Pick<DocumentStore, "get" | "transact">, input: LinkedAccountRef & { companyId: string; personId: string; display: string; linkedAt: string; audit?: AccountLinkAudit }): Promise<AccountLinkOutcome> {
  const companyId = OrgIdSchema.parse(input.companyId);
  if (!isPersonId(input.personId)) throw new Error("the account link is not valid");
  const accountKey = accountLinkKey(companyId, input);
  const personKey = accountOfKey(companyId, input.personId, input.provider);
  const fields = { companyId, provider: input.provider, tenant: input.tenant, accountId: input.accountId, personId: input.personId, display: cleanDisplay(input.display), via: "self", linkedAt: input.linkedAt };
  const written = await store.transact([
    { kind: "put", item: { ...accountKey, entityType: ACCOUNT_LINK, ...fields }, condition: when.absent() },
    { kind: "put", item: { ...personKey, entityType: ACCOUNT_OF, ...fields }, condition: when.absent() },
    ...(input.audit === undefined ? [] : [{ kind: "put" as const, item: auditItem(companyId, "tracker.account_linked", input.provider, input.personId, input.audit) }]),
  ]);
  if (written.applied) return "linked";
  const holder = await accountLinkOf(store, companyId, input);
  if (holder !== undefined && holder.personId !== input.personId) return "taken";
  const held = await personAccountLink(store, companyId, input.personId, input.provider);
  if (held !== undefined) return held.tenant === input.tenant && held.accountId === input.accountId ? "same" : "person_has_another";
  // A half-written pair cannot come from this writer (one transaction); anything else is a fault for the caller to report, never a guess.
  throw new Error("the account link could not be written");
}

/**
 * Removes the person's link for one provider in this company: both rows, the account row only while it still names this person. `true`: there was a link. With `audit`, the removal and its audit
 * record are one transaction; the person erase and a disconnect's sweep pass none (they have their own records).
 */
export async function unlinkAccount(store: Pick<DocumentStore, "get" | "delete" | "transact">, companyId: string, personId: string, provider: string, options: { audit?: AccountLinkAudit } = {}): Promise<boolean> {
  const company = OrgIdSchema.parse(companyId);
  if (!isPersonId(personId) || !isLinkProvider(provider)) return false;
  const personKey = accountOfKey(company, personId, provider);
  const row = await store.get(personKey);
  if (row === undefined) return false;
  const tenant = row["tenant"]; const accountId = row["accountId"];
  const held = isLinkKeyPart(tenant) && isLinkKeyPart(accountId) ? await accountLinkOf(store, company, { provider, tenant, accountId }) : undefined;
  const accountKeyOfPerson = held !== undefined && held.personId === personId ? accountLinkKey(company, held) : undefined;
  const accountText = typeof accountId === "string" ? accountId : "";
  // Each delete only while the row still names this person and account, so a racing second unlink never removes a row another member has written since.
  const removals = [
    ...(accountKeyOfPerson === undefined ? [] : [{ kind: "delete" as const, key: accountKeyOfPerson, condition: when.eq("personId", personId) }]),
    { kind: "delete" as const, key: personKey, condition: when.eq("accountId", accountText) },
  ];
  if (options.audit !== undefined) {
    const removed = await store.transact([...removals, { kind: "put", item: auditItem(company, "tracker.account_unlinked", provider, personId, options.audit) }]);
    if (!removed.applied) throw new Error("the account link could not be removed");
    return true;
  }
  for (const removal of removals) await store.delete({ key: removal.key, condition: removal.condition });
  return true;
}

/** Every provider's link of one person in this company, removed (a member's removal and the person erase). No audit row: those have their own records. */
export async function unlinkPersonEverywhere(store: Pick<DocumentStore, "get" | "delete" | "transact" | "query">, companyId: string, personId: string): Promise<number> {
  const company = OrgIdSchema.parse(companyId);
  if (!isPersonId(personId)) return 0;
  const rows = await queryAll(store, { pk: accountOfPk(company), sk: { op: "beginsWith", prefix: `PERSON#${personId}#` } });
  let removed = 0;
  for (const row of rows) {
    const provider = row["provider"];
    if (isLinkProvider(provider) && await unlinkAccount(store, company, personId, provider)) removed += 1;
  }
  return removed;
}

/** The links of one provider in this company, newest first. At most ACCOUNT_LINKS_MAX: more refuses the whole read. A row that does not check out is left out. */
export async function listAccountLinks(store: Pick<DocumentStore, "query">, companyId: string, provider: string): Promise<AccountLink[]> {
  const company = OrgIdSchema.parse(companyId);
  if (!isLinkProvider(provider)) return [];
  const rows = await queryAll(store, { pk: accountLinksPk(company), sk: { op: "beginsWith", prefix: `ACCT#${provider}#` } });
  if (rows.length > ACCOUNT_LINKS_MAX) throw new Error("too many account links to list");
  const links: AccountLink[] = [];
  for (const row of rows) {
    const link = linkOfRow(company, row, ACCOUNT_LINK, byAccount(company));
    if (link !== undefined && link.provider === provider) links.push(link);
  }
  return links.sort((a, b) => (a.linkedAt < b.linkedAt ? 1 : a.linkedAt > b.linkedAt ? -1 : 0));
}

/**
 * Removes every link of one provider in this company (the company disconnected that provider's workspace: a stale link that revived on a later reconnect would be a hidden identity grant).
 * Returns how many people were unlinked. Rows are removed one person at a time, each conditionally; a failure part-way throws and a repeat finishes the rest.
 */
export async function unlinkProviderForCompany(store: Pick<DocumentStore, "get" | "delete" | "transact" | "query">, companyId: string, provider: string): Promise<number> {
  const company = OrgIdSchema.parse(companyId);
  if (!isLinkProvider(provider)) return 0;
  // Read raw (not through `listAccountLinks`): a row that does not check out is still removed.
  const rows = await queryAll(store, { pk: accountLinksPk(company), sk: { op: "beginsWith", prefix: `ACCT#${provider}#` } });
  let removed = 0;
  for (const row of rows) {
    const personId = row["personId"];
    if (isPersonId(personId) && await unlinkAccount(store, company, personId, provider)) { removed += 1; continue; }
    // An account row with no matching person row (cannot come from this writer): removed alone, by the key its own fields give.
    const { tenant, accountId } = row;
    if (isLinkKeyPart(tenant) && isLinkKeyPart(accountId)) await store.delete({ key: accountLinkKey(company, { provider, tenant, accountId }) });
  }
  return removed;
}
