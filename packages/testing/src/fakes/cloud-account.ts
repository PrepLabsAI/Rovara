import { randomUUID } from "node:crypto";
import {
  assertCloudAccountCredentials, CloudAccountPurposeSchema, CloudAccountRefusedError, ExternalAccountRefSchema, OrgIdSchema,
  type CloudAccountPurpose, type ExternalAccountRef,
} from "@agentx/contracts";
import type { CloudAccountIssuance, CloudAccountWorld } from "../ports/cloud-account-conformance.js";

function assertCompany(companyId: string): void {
  if (!OrgIdSchema.safeParse(companyId).success) throw new CloudAccountRefusedError();
}

function accountKey(companyId: string, ref: ExternalAccountRef): string {
  assertCompany(companyId);
  const parsed = ExternalAccountRefSchema.safeParse(ref);
  if (!parsed.success) throw new CloudAccountRefusedError();
  return JSON.stringify([companyId, parsed.data.provider, parsed.data.tenant, parsed.data.accountId]);
}

function assertPurpose(purpose: CloudAccountPurpose): void {
  if (!CloudAccountPurposeSchema.safeParse(purpose).success) throw new CloudAccountRefusedError();
}

/** Offline only. Holds provider fixture callbacks, never persists or caches issued credentials. Do not register in production. */
export function createFakeCloudAccountWorld(): CloudAccountWorld {
  const grants = new Map<string, Map<CloudAccountPurpose, () => unknown>>();
  const connectionProbes = new Map<string, () => Promise<void>>();
  const externalIds = new Map<string, string>();
  const issuances: CloudAccountIssuance[] = [];
  let nowSeconds = 0;
  return {
    port: {
      async credentialsFor(companyId, ref, purpose) {
        try {
          const key = accountKey(companyId, ref);
          assertPurpose(purpose);
          const issue = grants.get(key)?.get(purpose);
          if (issue === undefined) throw new CloudAccountRefusedError();
          const value = await issue();
          assertCloudAccountCredentials(value, nowSeconds);
          if (value.provider !== ref.provider) throw new CloudAccountRefusedError();
          issuances.push({ companyId, purpose });
          return value;
        } catch {
          throw new CloudAccountRefusedError();
        }
      },
      async testConnection(companyId, ref) {
        try {
          const key = accountKey(companyId, ref);
          if (!grants.has(key)) throw new CloudAccountRefusedError();
          await connectionProbes.get(key)?.();
        } catch {
          throw new CloudAccountRefusedError();
        }
      },
      async externalIdFor(companyId) {
        assertCompany(companyId);
        let id = externalIds.get(companyId);
        if (id === undefined) {
          id = randomUUID();
          externalIds.set(companyId, id);
        }
        return id;
      },
    },
    grant(companyId, ref, purpose, issue) {
      const key = accountKey(companyId, ref);
      assertPurpose(purpose);
      const held = grants.get(key) ?? new Map<CloudAccountPurpose, () => unknown>();
      held.set(purpose, issue);
      grants.set(key, held);
    },
    setConnectionProbe(companyId, ref, probe) { connectionProbes.set(accountKey(companyId, ref), probe); },
    disconnect(companyId, ref) {
      const key = accountKey(companyId, ref);
      grants.delete(key);
      connectionProbes.delete(key);
    },
    setNow(seconds) { nowSeconds = seconds; },
    get issuances() { return issuances.map((entry) => ({ ...entry })); },
  };
}
