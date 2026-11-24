// The company's package token SETTINGS (PRIVATE-PACKAGES P1b): what the company set for each supported host, kept as one small row per (company, host) beside the token's secret. A row holds who set it, when,
// the npm scopes it serves and a revision (a signed write names the revision it saw); it NEVER holds the token, a length, a hash or a fragment of one. The token itself is the secret named by
// `companyRegistrySecretName`, in the company's secret store; the exchange (P1a) is the only reader of it.
//
//   Row   `ORG#<company>#PACKAGE_REGISTRIES` / `HOST#<hostKey>`   { entityType, orgId, host, state: set | being_removed, scopes, revision, setAt, setBy, secretVersionId, requestId, removedAt?, removedBy? }
//
// A row that is not exactly this company's well-formed row for this host reads as "not set" (fail closed: nothing is handed to a worker on a guess). A removed token's row stays for the recovery window (the
// secret waits 7 days to be deleted) so a new save is refused with the same sentence until the secret is really gone; after the window the row reads as not set.
import {
  COMPANY_REGISTRY_RECOVERY_DAYS, OrgIdSchema, PRIVATE_REGISTRY_HOSTS, RegistryScopeSchema, companyScoped, isPrivateRegistryHost,
  type CompanyRegistryEntry, type CompanyRegistryStatus, type DocumentKey, type DocumentStore, type PrivateRegistryHost, type StoredDocument,
} from "@agentx/contracts";
import type { ConnectionSecrets } from "../../connections/org-secrets.js";
import { companyRegistryTokenReader } from "./company-token-reader.js";
import type { CompanyRegistryStore } from "./mint.js";

export const COMPANY_REGISTRY_ENTITY = "COMPANY_PACKAGE_REGISTRY";
export const COMPANY_REGISTRY_RECOVERY_MS = COMPANY_REGISTRY_RECOVERY_DAYS * 24 * 60 * 60 * 1000;

export const companyRegistryKey = (companyId: string, host: PrivateRegistryHost): DocumentKey => ({ pk: companyScoped(OrgIdSchema.parse(companyId), "PACKAGE_REGISTRIES"), sk: `HOST#${PRIVATE_REGISTRY_HOSTS[host].key}` });

export interface CompanyRegistryRow {
  state: "set" | "being_removed";
  scopes: string[];
  revision: number;
  setAt: string;
  setBy: string;
  secretVersionId: string | undefined;
  requestId: string | undefined;
  removedAt: string | undefined;
  removedBy: string | undefined;
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/** This company's well-formed row for this host, or undefined for no row and for anything else (a foreign orgId, another key, a damaged field). */
export function parseCompanyRegistryRow(row: StoredDocument | undefined, companyId: string, host: PrivateRegistryHost): CompanyRegistryRow | undefined {
  if (row === undefined) return undefined;
  const key = companyRegistryKey(companyId, host);
  const scopes = row["scopes"];
  const revision = row["revision"];
  const state = row["state"];
  if (row["pk"] !== key.pk || row["sk"] !== key.sk || row["entityType"] !== COMPANY_REGISTRY_ENTITY || row["orgId"] !== companyId || row["host"] !== host) return undefined;
  if ((state !== "set" && state !== "being_removed") || typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) return undefined;
  if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every((scope) => typeof scope === "string" && RegistryScopeSchema.safeParse(scope).success)) return undefined;
  const setAt = text(row["setAt"]);
  const setBy = text(row["setBy"]);
  if (setAt === undefined || setBy === undefined) return undefined;
  return { state, scopes: [...(scopes as string[])], revision, setAt, setBy, secretVersionId: text(row["secretVersionId"]), requestId: text(row["requestId"]), removedAt: text(row["removedAt"]), removedBy: text(row["removedBy"]) };
}

/** The row now: a removal older than the recovery window is over, and reads as no row (the secret is gone). `revision` still counts on, for the next signed write. */
export function effectiveState(row: CompanyRegistryRow | undefined, now: number): "not_set" | "set" | "being_removed" {
  if (row === undefined) return "not_set";
  if (row.state === "set") return "set";
  const removed = row.removedAt === undefined ? Number.NaN : Date.parse(row.removedAt);
  return Number.isFinite(removed) && now < removed + COMPANY_REGISTRY_RECOVERY_MS ? "being_removed" : "not_set";
}

export async function readCompanyRegistryRow(store: Pick<DocumentStore, "get">, companyId: string, host: PrivateRegistryHost): Promise<CompanyRegistryRow | undefined> {
  return parseCompanyRegistryRow(await store.get(companyRegistryKey(companyId, host)), companyId, host);
}

/** One host's status line (the shape every route answer uses). Never a token. */
export function companyRegistryStatus(host: PrivateRegistryHost, row: CompanyRegistryRow | undefined, now: number): CompanyRegistryStatus {
  const state = effectiveState(row, now);
  if (row === undefined || state === "not_set") return { host, state: "not_set", revision: row?.revision ?? 0, scopes: [] };
  return { host, state, revision: row.revision, scopes: row.scopes, setAt: row.setAt, setBy: row.setBy, ...(state === "being_removed" && row.removedAt !== undefined ? { removedAt: row.removedAt } : {}) };
}

/** The entries the exchange and the prepare payload use: every host whose state is `set`, with its scopes. Names no token; an unreadable row is no entry. */
export function companyRegistryEntries(store: Pick<DocumentStore, "get">, now: () => number): CompanyRegistryStore["entries"] {
  return async (companyId) => {
    const entries: CompanyRegistryEntry[] = [];
    for (const host of Object.keys(PRIVATE_REGISTRY_HOSTS)) {
      if (!isPrivateRegistryHost(host)) continue;
      const row = await readCompanyRegistryRow(store, companyId, host);
      if (effectiveState(row, now()) === "set" && row !== undefined) entries.push({ host, scopes: row.scopes });
    }
    return entries;
  };
}

/** The company store P1a's dispatch and exchange read: the entries from the settings rows, the token from the company's secret at the version the row names (the ONE reader). */
export function companyRegistryStore(input: { env: string; store: Pick<DocumentStore, "get">; secrets: Pick<ConnectionSecrets, "read">; now?: () => number }): CompanyRegistryStore {
  const now = input.now ?? Date.now;
  const read = companyRegistryTokenReader({ env: input.env, secrets: input.secrets });
  return {
    entries: companyRegistryEntries(input.store, now),
    // The version the row names, and only while the row says `set`: a secret with no row (or a row being removed) is never served, and a version a losing save wrote is not the one in force.
    token: async (companyId, host) => {
      const row = await readCompanyRegistryRow(input.store, companyId, host);
      if (row === undefined || effectiveState(row, now()) !== "set" || row.secretVersionId === undefined) return undefined;
      return read(companyId, host, row.secretVersionId);
    },
  };
}
