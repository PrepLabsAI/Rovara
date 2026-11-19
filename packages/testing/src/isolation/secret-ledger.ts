// A secret store that serves many companies and keeps a ledger: every `read(companyId, ref)` is recorded, and a read made while a test says it is acting for company X by any other
// company fails at once. It is the harness the isolation kit uses for "secrets come only from the calling company": an adapter that reads company B's secret while serving company A trips it.
import { SecretValue, type SecretRef, type SecretStore } from "@agentx/contracts";

export interface SecretRead {
  readonly companyId: string;
  /** The reference's source kind and name, never a value. */
  readonly ref: string;
}

export interface CompanySecretStore extends SecretStore {
  /** Makes `ref` hold `value` for one company (`undefined` removes it). */
  set(companyId: string, ref: SecretRef, value: string | undefined): void;
  /** Every read, in order. */
  readonly reads: readonly SecretRead[];
  /** While `body` runs, a read for any company but `companyId` throws. Reads are still recorded. */
  actingFor<T>(companyId: string, body: () => Promise<T>): Promise<T>;
}

const refName = (ref: SecretRef): string => Object.entries(ref).map(([kind, name]) => `${kind}:${name}`).join(",");

export function createCompanySecretStore(): CompanySecretStore {
  const held = new Map<string, string>();
  const reads: SecretRead[] = [];
  let acting: string | undefined;
  const keyOf = (companyId: string, ref: SecretRef): string => `${companyId}\u0000${refName(ref)}`;
  return {
    reads,
    set(companyId, ref, value) {
      if (value === undefined) held.delete(keyOf(companyId, ref));
      else held.set(keyOf(companyId, ref), value);
    },
    async read(companyId, ref) {
      reads.push({ companyId, ref: refName(ref) });
      // A fixed sentence: it names neither company nor the reference.
      if (acting !== undefined && acting !== companyId) throw new Error("a secret was read for a company the call was not made for");
      const found = held.get(keyOf(companyId, ref));
      return found === undefined ? undefined : new SecretValue(found);
    },
    async actingFor(companyId, body) {
      const before = acting;
      acting = companyId;
      try {
        return await body();
      } finally {
        acting = before;
      }
    },
  };
}
