// TEST SUPPORT: an in-memory secret store for connections (the `ConnectionSecrets` the stores take) that keeps each company's secrets apart and checks a name against its company as the real
// stores do, and a memory document store with the task flow's indexes.
import { INDEX_EXPIRY_ATTRIBUTE, type OrgId } from "@rovara-code/contracts";
import { TASK_FLOW_INDEXES } from "../../packages/core/src/core/task-flow/flow.js";
import { admitSecretName, type ConnectionSecrets } from "../../packages/core/src/connections/org-secrets.js";
import { MemoryDocumentStore } from "../../packages/core/src/ports/memory-document-store.js";

export const memoryStore = (): MemoryDocumentStore => new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES, ttlAttribute: INDEX_EXPIRY_ATTRIBUTE });

export class InMemoryConnectionSecrets implements ConnectionSecrets {
  readonly #versions = new Map<string, Array<{ id: string; value: string }>>();
  /** Every call, as `put <name>`, `read <name>` and `delete <name>`: a test checks what was and was not touched. */
  readonly calls: string[] = [];
  #counter = 0;
  constructor(private readonly env: string) {}

  /** The names of the secrets held now (never their values). */
  names(): string[] { return [...this.#versions.keys()].sort(); }

  async read(orgId: string, name: string, versionId?: string): Promise<string | undefined> {
    admitSecretName(this.env, orgId, name);
    this.calls.push(`read ${name}`);
    const versions = this.#versions.get(name);
    if (versions === undefined || versions.length === 0) return undefined;
    return versionId === undefined ? versions.at(-1)!.value : versions.find((entry) => entry.id === versionId)?.value;
  }

  async put(orgId: string, name: string, value: string): Promise<string> {
    admitSecretName(this.env, orgId, name);
    this.calls.push(`put ${name}`);
    this.#counter += 1;
    const id = `v${String(this.#counter)}`;
    this.#versions.set(name, [...(this.#versions.get(name) ?? []), { id, value }]);
    return id;
  }

  async scheduleDelete(orgId: string, name: string): Promise<void> {
    admitSecretName(this.env, orgId, name);
    this.calls.push(`delete ${name}`);
    this.#versions.delete(name);
  }
}

export type { OrgId };
