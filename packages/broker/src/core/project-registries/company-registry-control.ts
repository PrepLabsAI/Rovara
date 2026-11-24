// The company's package token, WRITTEN (PRIVATE-PACKAGES P1b; route: core-host/package-registries-routes.ts). The rules, in the order they are checked:
//   1. the live role: only a company owner or admin saves or deletes (the host reads membership for this request; nothing is remembered). A member reads the status line only.
//   2. the body (strict; `requestId` + `expectedRevision` as every signed write has), the host (a fixed table), then a replay of the same `requestId` answers the status it already made.
//   3. the revision the person saw must still be the row's (else "changed since you loaded it"); a token being removed cannot be replaced until its recovery window is over.
//   4. SAVE-TIME VALIDATION, before anything is stored: the token's shape and, with one live call to GitHub, its scopes: read:packages required, only harmless reads beside it (token-check.ts). A refusal is audited (a reason code) and stores nothing.
//   5. the audit record (who, when, host, scopes: never the value) is written BEFORE the secret changes; an act whose record cannot be written is not done.
//   6. the secret: create or a new version of `companyRegistrySecretName`, through the company's own secret store (the company-tagged session in the hosted install). A removal schedules the secret's deletion
//      WITH the 7 day recovery window, so a wrong delete can be undone by hand.
//   7. the settings row, written with a fence on the revision it read. The row never holds the token.
// No function here returns the token or anything made from it. The token is read from the request body once, handed to the secret store and the GitHub probe, and dropped.
import {
  COMPANY_REGISTRY_AUDIT, COMPANY_REGISTRY_WORDS, CompanyRegistryDeleteBodySchema, CompanyRegistryPutBodySchema, PRIVATE_REGISTRY_HOSTS, AgentXError, agentXError, companyRegistrySecretName, isPrivateRegistryHost, when,
  type CompanyRegistryStatus, type DocumentStore, type JsonObject, type OrgId, type OrgRole, type PrivateRegistryHost, type StoredDocument,
} from "@agentx/contracts";
import { BEING_REMOVED_MESSAGE, type ConnectionSecrets } from "../../connections/org-secrets.js";
import { companyRegistryKey, companyRegistryStatus, effectiveState, parseCompanyRegistryRow, COMPANY_REGISTRY_ENTITY, type CompanyRegistryRow } from "./company-registry-store.js";
import { checkRegistryToken, type GithubScopeProbe } from "./token-check.js";

/**
 * What the control asks of the company's secret store (the adapter's `putRegistryToken`): the token goes in as a NEW VERSION of the one secret `companyRegistrySecretName` names (created when there is none,
 * ADOPTED when one already exists with no live row, restored first when it is scheduled for deletion), and a delete schedules the deletion with the recovery window. No read.
 */
export interface RegistrySecretStore extends Pick<ConnectionSecrets, "scheduleDelete"> {
  putRegistryToken(company: string, name: string, value: string, hooks: { beforeRestore(): Promise<void> }): Promise<{ versionId: string; created: boolean; restored: boolean }>;
}

export interface RegistryControlDeps {
  store: Pick<DocumentStore, "get" | "transact">;
  companyId: OrgId;
  env: string;
  /** The company's secret store: writes and deletes only (nothing here reads a token). */
  secrets: RegistrySecretStore;
  probe: GithubScopeProbe;
  now: () => number;
  /** The caller, and the live role membership says NOW. */
  personId: string;
  role: OrgRole;
  /** One audit record; throws when it could not be written. `requestId` names the event (a replay records once). */
  record(action: string, requestId: string, details: JsonObject): Promise<void>;
}

const W = COMPANY_REGISTRY_WORDS;

function requireAdmin(deps: Pick<RegistryControlDeps, "role">): void {
  if (deps.role !== "owner" && deps.role !== "admin") throw agentXError("FORBIDDEN", W.adminOnly);
}

function hostOf(value: string): PrivateRegistryHost {
  if (!isPrivateRegistryHost(value)) throw agentXError("CONFIG_INVALID", W.hostUnsupported);
  return value;
}

/** The raw row and its parse. A row that is there but is not this company's well-formed row is unreadable: the write refuses rather than replaces it on a guess. */
async function readRow(deps: RegistryControlDeps, host: PrivateRegistryHost): Promise<{ raw: StoredDocument | undefined; row: CompanyRegistryRow | undefined }> {
  let raw: StoredDocument | undefined;
  try { raw = await deps.store.get(companyRegistryKey(deps.companyId, host)); } catch { throw agentXError("RUNTIME_UNAVAILABLE", W.unavailable); }
  const row = parseCompanyRegistryRow(raw, deps.companyId, host);
  if (raw !== undefined && row === undefined) throw agentXError("RUNTIME_UNAVAILABLE", W.unavailable);
  return { raw, row };
}

async function recordOrRefuse(deps: RegistryControlDeps, action: string, requestId: string, details: JsonObject): Promise<void> {
  try { await deps.record(action, requestId, details); } catch { throw agentXError("AUDIT_UNAVAILABLE", W.auditUnavailable); }
}

async function writeRow(deps: RegistryControlDeps, host: PrivateRegistryHost, seen: StoredDocument | undefined, previous: CompanyRegistryRow | undefined, next: Record<string, unknown>): Promise<CompanyRegistryRow> {
  const key = companyRegistryKey(deps.companyId, host);
  const item = { ...key, entityType: COMPANY_REGISTRY_ENTITY, orgId: deps.companyId, host, revision: (previous?.revision ?? 0) + 1, ...Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)) };
  const condition = seen === undefined ? when.absent() : when.eq("revision", previous!.revision);
  let written: Awaited<ReturnType<DocumentStore["transact"]>>;
  try { written = await deps.store.transact([{ kind: "put", item: item, condition }]); } catch { throw agentXError("RUNTIME_UNAVAILABLE", W.unavailable); }
  if (!written.applied) throw agentXError("CHANGE_STALE", W.stale);
  const row = parseCompanyRegistryRow(item, deps.companyId, host);
  if (row === undefined) throw agentXError("RUNTIME_UNAVAILABLE", W.unavailable);
  return row;
}

function secretFailure(error: unknown): never {
  if (error instanceof Error && error.message === BEING_REMOVED_MESSAGE) throw agentXError("CONFIG_INVALID", W.beingRemoved);
  throw agentXError("RUNTIME_UNAVAILABLE", W.unavailable);
}

/** The status line of every supported host. Any live member reads it; it holds who and when, never a value. */
export async function companyRegistriesView(deps: Pick<RegistryControlDeps, "store" | "companyId" | "now">): Promise<{ registries: CompanyRegistryStatus[] }> {
  const registries: CompanyRegistryStatus[] = [];
  for (const host of Object.keys(PRIVATE_REGISTRY_HOSTS)) {
    if (!isPrivateRegistryHost(host)) continue;
    let raw: StoredDocument | undefined;
    try { raw = await deps.store.get(companyRegistryKey(deps.companyId, host)); } catch { throw agentXError("RUNTIME_UNAVAILABLE", W.unavailable); }
    registries.push(companyRegistryStatus(host, parseCompanyRegistryRow(raw, deps.companyId, host), deps.now()));
  }
  return { registries };
}

/** Sets or replaces the company's token for a host. Answers the host's status line. */
export async function putCompanyRegistryToken(deps: RegistryControlDeps, readBody: () => unknown): Promise<CompanyRegistryStatus> {
  requireAdmin(deps);
  const parsed = CompanyRegistryPutBodySchema.safeParse(readBody());
  if (!parsed.success) throw agentXError("CONFIG_INVALID", W.bodyInvalid);
  const body = parsed.data;
  const host = hostOf(body.host);
  const { raw, row } = await readRow(deps, host);
  if (row !== undefined && row.requestId === body.requestId) return companyRegistryStatus(host, row, deps.now());
  if (body.expectedRevision !== (row?.revision ?? 0)) throw agentXError("CHANGE_STALE", W.stale);
  const scopes = [...body.scopes].sort();
  const replacing = effectiveState(row, deps.now()) === "set";
  await validateOrRefuse(deps, host, body.token, body.requestId);
  await recordOrRefuse(deps, replacing ? COMPANY_REGISTRY_AUDIT.replace : COMPANY_REGISTRY_AUDIT.set, body.requestId, { host, scopes, by: deps.personId, role: deps.role });
  const written = await storeToken(deps, { host, token: body.token, scopes, requestId: body.requestId, replacing, raw, row });
  return companyRegistryStatus(host, written, deps.now());
}

/** Save-time validation: a refusal is audited with a reason code (never for "could not check") and stores nothing. */
async function validateOrRefuse(deps: RegistryControlDeps, host: PrivateRegistryHost, token: string, requestId: string): Promise<void> {
  const verdict = await checkRegistryToken({ host, token, probe: deps.probe });
  if (verdict.ok) return;
  if (verdict.reason !== "unchecked") await deps.record(COMPANY_REGISTRY_AUDIT.refused, requestId, { host, reason: verdict.reason, by: deps.personId }).catch(() => undefined);
  throw agentXError(verdict.reason === "unchecked" ? "RUNTIME_UNAVAILABLE" : "CONFIG_INVALID", verdict.message);
}

/**
 * The secret, then the fenced row. The secret is ADOPTED, never recreated or force-deleted: a first save whose row never landed left a secret with no row, and the next save writes a new version into it (audited);
 * a secret scheduled for deletion (a removal's window, or a delete whose row write failed) is restored first, audited BEFORE the restore. A save that lost its row's fence leaves its version unreferenced: the row names
 * the version in force, and the reader serves that one only.
 */
async function storeToken(deps: RegistryControlDeps, input: { host: PrivateRegistryHost; token: string; scopes: string[]; requestId: string; replacing: boolean; raw: StoredDocument | undefined; row: CompanyRegistryRow | undefined }): Promise<CompanyRegistryRow> {
  const name = companyRegistrySecretName(deps.env, deps.companyId, input.host);
  if (name === undefined) throw agentXError("RUNTIME_UNAVAILABLE", W.unavailable);
  const facts = { host: input.host, by: deps.personId, role: deps.role };
  let write: Awaited<ReturnType<RegistrySecretStore["putRegistryToken"]>>;
  try {
    write = await deps.secrets.putRegistryToken(deps.companyId, name, input.token, { beforeRestore: () => recordOrRefuse(deps, COMPANY_REGISTRY_AUDIT.restored, input.requestId, facts) });
  } catch (error) {
    if (error instanceof AgentXError) throw error;
    return secretFailure(error);
  }
  if (!write.created && !input.replacing) await deps.record(COMPANY_REGISTRY_AUDIT.adopted, input.requestId, facts).catch(() => undefined);
  return await writeRow(deps, input.host, input.raw, input.row, { state: "set", scopes: input.scopes, setAt: new Date(deps.now()).toISOString(), setBy: deps.personId, secretVersionId: write.versionId, requestId: input.requestId });
}

/** Deletes the company's token for a host: the secret waits its recovery window, and the row says so. Answers the host's status line. */
export async function deleteCompanyRegistryToken(deps: RegistryControlDeps, readBody: () => unknown): Promise<CompanyRegistryStatus> {
  requireAdmin(deps);
  const parsed = CompanyRegistryDeleteBodySchema.safeParse(readBody());
  if (!parsed.success) throw agentXError("CONFIG_INVALID", W.bodyInvalid);
  const body = parsed.data;
  const host = hostOf(body.host);
  const { raw, row } = await readRow(deps, host);
  if (row !== undefined && row.requestId === body.requestId) return companyRegistryStatus(host, row, deps.now());
  if (body.expectedRevision !== (row?.revision ?? 0)) throw agentXError("CHANGE_STALE", W.stale);
  if (row === undefined || effectiveState(row, deps.now()) !== "set") throw agentXError("NOT_FOUND", W.notSet);
  await recordOrRefuse(deps, COMPANY_REGISTRY_AUDIT.delete, body.requestId, { host, scopes: row.scopes, by: deps.personId, role: deps.role });
  const name = companyRegistrySecretName(deps.env, deps.companyId, host);
  if (name === undefined) throw agentXError("RUNTIME_UNAVAILABLE", W.unavailable);
  try { await deps.secrets.scheduleDelete(deps.companyId, name); } catch (error) { return secretFailure(error); }
  const at = new Date(deps.now()).toISOString();
  const written = await writeRow(deps, host, raw, row, { state: "being_removed", scopes: row.scopes, setAt: row.setAt, setBy: row.setBy, secretVersionId: row.secretVersionId, requestId: body.requestId, removedAt: at, removedBy: deps.personId });
  return companyRegistryStatus(host, written, deps.now());
}
