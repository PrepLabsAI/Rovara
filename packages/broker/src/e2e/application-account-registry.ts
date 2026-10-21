import {
  E2E_SYNTHETIC_ACCOUNT_RENEWAL_DAYS, E2EApplicationAccountDefinitionSchema, E2EApplicationAccountLatestSchema, E2EApplicationProjectContractSchema,
  createE2ESyntheticAccountDefinition, deriveE2EApplicationRuntimeAccountRef, e2eApplicationAccountDefinitionDigest, e2eSyntheticAccountContractDigest,
  resolveE2ELatestAccountRef, validateE2EApplicationAccountBinding,
  type E2EApplicationAccountDefinition, type E2EApplicationAccountLatest, type E2EApplicationProjectContract, type E2ERuntimeAccountRef,
} from "@agentx/contracts";

/**
 * The versioned registry of an application's test accounts (Task 3.1, owner decision D5), in the broker's one table under the project's partition:
 *
 * - `sk = E2E_ACCOUNT#<applicationId>#<profileId>#REV#<n>` holds the `E2EApplicationAccountDefinition` of revision n, written once and never changed;
 * - `sk = E2E_ACCOUNT_LATEST#<applicationId>#<profileId>` holds `{ revision, definitionDigest }`, the account's newest revision, moved only from the previous revision.
 *   It also records which setup approval wrote it (`setupApprovedAt`, `setupProposalSha256`), so that registering an older setup can never roll an account back.
 *
 * The definitions are written when a project's setup is registered (the step that makes an approved setup effective), in the transaction that stores the project revision.
 * Everything here is pure: it names the rows, parses what was read, and decides what a registration has to write. The reads and writes are `aws/e2e-account-registry.ts`.
 * Every lookup is keyed by (applicationId, profileId) and must find exactly one account: an application can have an owner and a viewer, and the first of them is never
 * the answer for the second.
 */
export type E2EAccountRegistryEntry = {
  definition: E2EApplicationAccountDefinition; latest: E2EApplicationAccountLatest;
  /** When the setup approval that wrote this revision was given (an ISO instant); absent on a row written before it was recorded. */
  setupApprovedAt?: string;
  /** Older revisions of the account, newest first: what a task pinned to an older project revision (an older contract) is still held to. */
  earlier?: readonly E2EApplicationAccountDefinition[];
};

/**
 * `account-not-registered` and `account-ambiguous`: the lookup did not find exactly one account. `accounts-changed-reapprove`: the account is registered but is not the
 * current one (a newer revision, an expired definition, or one the approved contract does not stand behind); the owner approves the checks again. `setup-superseded`: a
 * registration tried to replace an account's definition with one from an older setup approval than the one that wrote it.
 */
export type E2EAccountRegistryErrorCode = "account-not-registered" | "account-ambiguous" | "accounts-changed-reapprove" | "setup-superseded";
export class E2EAccountRegistryError extends Error {
  constructor(readonly code: E2EAccountRegistryErrorCode, message: string) {
    super(message);
    this.name = "E2EAccountRegistryError";
  }
}

const keyPart = (value: string, label: string): string => {
  if (value.includes("#") || value.trim() === "") throw new Error(`${label} cannot be part of an account registry key`);
  return value;
};
const accountSuffix = (applicationId: string, profileId: string) => `${keyPart(applicationId, "application id")}#${keyPart(profileId, "account profile id")}`;
export function e2eAccountDefinitionKey(projectId: string, applicationId: string, profileId: string, revision: number): { pk: string; sk: string } {
  return { pk: `PROJECT#${projectId}`, sk: `E2E_ACCOUNT#${accountSuffix(applicationId, profileId)}#REV#${revision}` };
}
export function e2eAccountLatestKey(projectId: string, applicationId: string, profileId: string): { pk: string; sk: string } {
  return { pk: `PROJECT#${projectId}`, sk: `E2E_ACCOUNT_LATEST#${accountSuffix(applicationId, profileId)}` };
}
/** The sort-key prefix shared by every revision of one account. */
export function e2eAccountRevisionPrefix(projectId: string, applicationId: string, profileId: string): { pk: string; prefix: string } {
  return { pk: `PROJECT#${projectId}`, prefix: `E2E_ACCOUNT#${accountSuffix(applicationId, profileId)}#REV#` };
}

export function accountDefinitionRow(projectId: string, definition: E2EApplicationAccountDefinition): Record<string, unknown> {
  return { ...e2eAccountDefinitionKey(projectId, definition.applicationId, definition.profileId, definition.revision), entityType: "E2E_ACCOUNT", ...definition };
}
export function accountLatestRow(projectId: string, applicationId: string, profileId: string, latest: E2EApplicationAccountLatest,
  setup?: { approvedAt: string; proposalSha256: string }): Record<string, unknown> {
  return { ...e2eAccountLatestKey(projectId, applicationId, profileId), entityType: "E2E_ACCOUNT_LATEST", ...latest,
    ...(setup === undefined ? {} : { setupApprovedAt: setup.approvedAt, setupProposalSha256: setup.proposalSha256 }) };
}

/** A registry row that cannot be read: specific about which account, and repaired by registering the project's setup again (which writes the next revision over it). */
export function unreadableAccountMessage(applicationId: string, profileId: string): string {
  return `accounts-changed-reapprove: the registered record of account profile ${profileId} of application ${applicationId} cannot be read; an administrator must register the project's setup again to repair it`;
}
const unreadable = (applicationId: string, profileId: string) => new E2EAccountRegistryError("accounts-changed-reapprove", unreadableAccountMessage(applicationId, profileId));
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** One revision's definition row, parsed and held to its key; undefined when it is missing or is not that account's row. */
export function parseAccountDefinitionRow(projectId: string, applicationId: string, profileId: string, revision: number, row: unknown): E2EApplicationAccountDefinition | undefined {
  if (!isRecord(row)) return undefined;
  const { pk, sk, entityType, ...body } = row;
  const definition = E2EApplicationAccountDefinitionSchema.safeParse(body);
  if (!definition.success || entityType !== "E2E_ACCOUNT" || definition.data.applicationId !== applicationId || definition.data.profileId !== profileId || definition.data.revision !== revision) return undefined;
  const expected = e2eAccountDefinitionKey(projectId, applicationId, profileId, revision);
  return pk === expected.pk && sk === expected.sk ? definition.data : undefined;
}

/**
 * An account's two rows, parsed and held to their keys: a row is only the account it is keyed as. `definitionRow` is the row at the revision the pointer names.
 * A row that cannot be read throws an `accounts-changed-reapprove` error that names the account.
 */
export function parseAccountEntry(projectId: string, applicationId: string, profileId: string, latestRow: unknown, definitionRow: unknown): E2EAccountRegistryEntry {
  if (!isRecord(latestRow)) throw unreadable(applicationId, profileId);
  const { pk: latestPk, sk: latestSk, entityType: latestType, setupApprovedAt, setupProposalSha256, ...latestBody } = latestRow;
  const latest = E2EApplicationAccountLatestSchema.safeParse(latestBody);
  const expectedLatest = e2eAccountLatestKey(projectId, applicationId, profileId);
  if (!latest.success || latestType !== "E2E_ACCOUNT_LATEST" || latestPk !== expectedLatest.pk || latestSk !== expectedLatest.sk
    || (setupApprovedAt !== undefined && (typeof setupApprovedAt !== "string" || Number.isNaN(Date.parse(setupApprovedAt))))
    || (setupProposalSha256 !== undefined && typeof setupProposalSha256 !== "string")) throw unreadable(applicationId, profileId);
  const definition = parseAccountDefinitionRow(projectId, applicationId, profileId, latest.data.revision, definitionRow);
  if (definition === undefined) throw unreadable(applicationId, profileId);
  return { definition, latest: latest.data, ...(typeof setupApprovedAt === "string" ? { setupApprovedAt } : {}) };
}

/** Every account of a project in the rows read from its partition (a test's view of the table; the broker reads the accounts a plan names, by key). */
export function accountRegistryEntriesFromRows(projectId: string, rows: readonly Record<string, unknown>[]): E2EAccountRegistryEntry[] {
  const prefix = "E2E_ACCOUNT_LATEST#";
  return rows.flatMap((row) => {
    if (row.pk !== `PROJECT#${projectId}` || typeof row.sk !== "string" || !row.sk.startsWith(prefix)) return [];
    const [applicationId, profileId] = row.sk.slice(prefix.length).split("#");
    if (applicationId === undefined || profileId === undefined) return [];
    const definition = rows.find((item) => item.pk === row.pk && item.sk === e2eAccountDefinitionKey(projectId, applicationId, profileId, Number(row.revision)).sk);
    return [parseAccountEntry(projectId, applicationId, profileId, row, definition)];
  });
}

/** The one account of (applicationId, profileId): none or more than one is a refusal that names the account. */
export function pickAccountEntry(entries: readonly E2EAccountRegistryEntry[], applicationId: string, profileId: string): E2EAccountRegistryEntry {
  const matches = entries.filter((entry) => entry.definition.applicationId === applicationId && entry.definition.profileId === profileId);
  if (matches.length === 0) throw new E2EAccountRegistryError("account-not-registered", `no account definition is registered for account profile ${profileId} of application ${applicationId}`);
  if (matches.length > 1) throw new E2EAccountRegistryError("account-ambiguous", `more than one account definition is registered for account profile ${profileId} of application ${applicationId}`);
  return matches[0]!;
}

/** The definition behind a ref: the entry's latest, or an older revision of the same account. */
export function definitionOfAccountRef(entry: E2EAccountRegistryEntry, ref: Pick<E2ERuntimeAccountRef, "revision">): E2EApplicationAccountDefinition | undefined {
  return entry.definition.revision === ref.revision ? entry.definition : entry.earlier?.find((definition) => definition.revision === ref.revision);
}

/**
 * The ref of an account's current definition for this contract, held to the approved contract and to its expiry at `now` (milliseconds): the account's latest revision,
 * or, when the latest was registered for a different contract (a newer setup than the one the caller's project revision is pinned to), the newest older revision that
 * this contract still stands behind. A definition that is not current (expired, not the revision the pointer names, or not what the contract says: its digest, tenant,
 * role or scope) is `accounts-changed-reapprove`.
 */
export function latestAccountRef(input: { contract: E2EApplicationProjectContract; entries: readonly E2EAccountRegistryEntry[]; applicationId: string; profileId: string; now: number }): E2ERuntimeAccountRef {
  const entry = pickAccountEntry(input.entries, input.applicationId, input.profileId);
  const what = `account profile ${input.profileId} of application ${input.applicationId}`;
  try {
    return resolveE2ELatestAccountRef({ contract: input.contract, definition: entry.definition, latest: entry.latest, now: input.now });
  } catch (error) {
    // An older revision of the same account that this contract stands behind: a task pinned to an older project revision keeps its own line of definitions.
    for (const definition of entry.earlier ?? []) {
      try {
        return validateE2EApplicationAccountBinding({ contract: input.contract, definition, expectedRef: deriveE2EApplicationRuntimeAccountRef(definition), now: new Date(input.now).toISOString() });
      } catch { /* not this one */ }
    }
    const otherSetup = ((): boolean => {
      try { return entry.definition.contractDigest !== e2eSyntheticAccountContractDigest(input.contract, input.profileId); } catch { return false; }
    })();
    const why = Date.parse(entry.definition.expiresAt) <= input.now ? `its definition expired at ${entry.definition.expiresAt}`
      : otherSetup ? "it was registered for a newer setup than this project revision's, and no earlier definition of it fits; start the task again on the current project revision"
        : error instanceof Error ? error.message : "it cannot be read";
    throw new E2EAccountRegistryError("accounts-changed-reapprove", `accounts-changed-reapprove: ${what} is not usable as registered (${why})`);
  }
}

export type E2EAccountRegistryWrite = {
  definition: E2EApplicationAccountDefinition; latest: E2EApplicationAccountLatest; previousRevision: number | null;
  /** The setup approval that wrote this revision (never older than the one that wrote the revision it replaces). */
  setupApprovedAt?: string;
  /** An unreadable pointer is replaced outright: the new revision's definition row is what serializes concurrent repairs. */
  repair?: true;
};

/**
 * What registering a setup writes for one application: for each `synthetic-test` profile of the approved contract, revision n+1 when the definition the contract implies is
 * not the one the pointer names, or when that definition has `E2E_SYNTHETIC_ACCOUNT_RENEWAL_DAYS` or fewer left (or has expired); revision 1 for an account with none;
 * nothing otherwise. The expiry is not part of "changed": registering the same contract again with time to spare never writes. `repairs` names accounts whose rows cannot
 * be read, with the revision to write over them.
 *
 * A change from a setup approved *earlier* than the one that wrote the account's current definition is refused (`setup-superseded`): registering an older setup can never roll an
 * account back. Renewing the same definition is allowed from any setup.
 */
export function planSyntheticAccountWrites(input: { contract: E2EApplicationProjectContract; applicationId: string; prior: readonly E2EAccountRegistryEntry[]; now: number;
  setup?: { approvedAt: string }; repairs?: readonly { applicationId: string; profileId: string; nextRevision: number }[] }): E2EAccountRegistryWrite[] {
  const contract = E2EApplicationProjectContractSchema.parse(input.contract);
  const renewalMs = E2E_SYNTHETIC_ACCOUNT_RENEWAL_DAYS * 86_400_000;
  return contract.accountProfiles.filter((profile) => profile.scope === "synthetic-test").flatMap((profile) => {
    const make = (revision: number, previousRevision: number | null, previousApprovedAt: string | undefined, repair: boolean): E2EAccountRegistryWrite[] => {
      const definition = createE2ESyntheticAccountDefinition({ contract, applicationId: input.applicationId, profileId: profile.profileId, revision, now: input.now });
      const approvedAt = [previousApprovedAt, input.setup?.approvedAt].filter((value): value is string => value !== undefined).sort().at(-1);
      return [{ definition, latest: { revision, definitionDigest: e2eApplicationAccountDefinitionDigest(definition) }, previousRevision,
        ...(approvedAt === undefined ? {} : { setupApprovedAt: approvedAt }), ...(repair ? { repair: true as const } : {}) }];
    };
    const repair = input.repairs?.find((item) => item.applicationId === input.applicationId && item.profileId === profile.profileId);
    if (repair !== undefined) return make(repair.nextRevision, null, undefined, true);
    const prior = input.prior.filter((entry) => entry.definition.applicationId === input.applicationId && entry.definition.profileId === profile.profileId);
    if (prior.length > 1) throw new E2EAccountRegistryError("account-ambiguous", `more than one account definition is registered for account profile ${profile.profileId} of application ${input.applicationId}`);
    const previous = prior[0];
    if (previous === undefined) return make(1, null, undefined, false);
    const implied = { ...createE2ESyntheticAccountDefinition({ contract, applicationId: input.applicationId, profileId: profile.profileId, revision: previous.definition.revision, now: input.now }),
      expiresAt: previous.definition.expiresAt };
    const sameDefinition = previous.latest.revision === previous.definition.revision && previous.latest.definitionDigest === e2eApplicationAccountDefinitionDigest(implied);
    if (sameDefinition && Date.parse(previous.definition.expiresAt) - input.now > renewalMs) return [];
    if (!sameDefinition && previous.setupApprovedAt !== undefined && input.setup !== undefined && previous.setupApprovedAt > input.setup.approvedAt) {
      throw new E2EAccountRegistryError("setup-superseded", `a newer approved setup (approved ${previous.setupApprovedAt}) has already registered account profile ${profile.profileId} of application ${input.applicationId}; `
        + "this setup was approved earlier (" + input.setup.approvedAt + "), so registering it would roll the account back: register the newer setup instead");
    }
    return make(previous.latest.revision + 1, previous.latest.revision, previous.setupApprovedAt, false);
  });
}
