// The secret of a connection and of a registered MCP server, on the `secrets` socket.
//
// The hosted product keeps each in its secret service under `agentx/<env>/org-connectors/<org>/<id>`, written through a role session tagged with the org. Code keeps the same NAMES (so a later switch
// needs no rename) and answers them from `ConnectionSecrets`: read, write and schedule-for-deletion of a named secret, which a laptop's adapter keeps in a file only its owner can read
// (`connections/local-secrets.ts`). The core never holds a secret in a record or an error: a record keeps whether a secret was saved and which VERSION of it is current, and the value
// is read at the moment it is used.
import { OrgIdSchema, agentXError, type OrgId } from "@agentx/contracts";

/** What a failed save is told when its secret is waiting to be deleted: only finishing the removal (and adding a new connection) gets past it. */
export const BEING_REMOVED_MESSAGE = "this connection is being removed; remove it again, then add a new one";
/** One path segment: the connection or hook id. No slash, no dot, so a name can never climb out of its company's path. */
const LEAF = /^[A-Za-z0-9_-]{1,128}$/;

export function orgConnectorSecretName(env: string, orgId: string, connectionId: string): string {
  return `agentx/${env}/org-connectors/${orgId}/${connectionId}`;
}

/** A registered MCP server's own token: under the connector path, beside the connection secrets of its company. */
export function orgMcpServerSecretName(env: string, orgId: string, serverId: string): string {
  return `agentx/${env}/org-connectors/${orgId}/${serverId}`;
}

/** Whether `leaf` can be the last segment of a company secret name. */
export function isSecretLeaf(leaf: string): boolean {
  return LEAF.test(leaf);
}

/**
 * The three things the stores do with a secret. `put` answers the id of the version it wrote, which the record keeps and a read names, so what is used is what its own save wrote.
 * Every method checks the company and the name against each other before touching anything.
 */
export interface ConnectionSecrets {
  /** The secret's value, or undefined when there is none (or, with `versionId`, when that version is not the current one). */
  read(orgId: string, name: string, versionId?: string): Promise<string | undefined>;
  put(orgId: string, name: string, value: string): Promise<string>;
  /** Removes the secret (a laptop has no recovery window; the hosted product schedules deletion). A secret that is not there is already gone. */
  scheduleDelete(orgId: string, name: string): Promise<void>;
}

/** The company and the name, checked against each other: a name must be under the company's own path. */
export function admitSecretName(env: string, orgId: string, name: string): OrgId {
  const parsed = OrgIdSchema.safeParse(orgId);
  if (!parsed.success) throw agentXError("FORBIDDEN", "that is not a company id");
  for (const prefix of [`agentx/${env}/org-connectors/${parsed.data}/`, `agentx/${env}/org-hooks/${parsed.data}/`]) {
    if (name.startsWith(prefix) && LEAF.test(name.slice(prefix.length))) return parsed.data;
  }
  throw agentXError("FORBIDDEN", "that secret does not belong to this company");
}
