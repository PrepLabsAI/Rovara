import { OrgIdSchema, agentXError, type SecretRef, type SecretStore } from "@agentx/contracts";
import { LocalSecretError } from "../ports/secret-error.js";
import type { CompanyMembershipReader } from "../aws/company-check.js";
import type { ConnectionSecrets } from "./org-secrets.js";

async function companyFor(companies: CompanyMembershipReader, personId: string): Promise<string> {
  try {
    // No cache: removing a member takes effect on the very next operation.
    const company = OrgIdSchema.safeParse(await companies.companyOf(personId));
    if (company.success) return company.data;
  } catch { /* Membership service causes may contain private information. */ }
  throw new LocalSecretError("the person's company could not be confirmed");
}

export function createMemberSecretReader(options: { companies: CompanyMembershipReader; store: SecretStore }) {
  return { async readAs(personId: string, ref: SecretRef) {
    return options.store.read(await companyFor(options.companies, personId), ref);
  } };
}

/** The argument is only a consistency guard. Authority always comes from membership. */
export function memberBoundConnectionSecrets(options: { companies: CompanyMembershipReader; personId: string; inner: ConnectionSecrets }): ConnectionSecrets {
  return {
    async read(orgId, name, versionId) {
      const company = await companyFor(options.companies, options.personId);
      if (orgId !== company) return undefined;
      return options.inner.read(company, name, versionId);
    },
    async put(orgId, name, value) {
      const company = await companyFor(options.companies, options.personId);
      if (orgId !== company) throw agentXError("FORBIDDEN", "that secret does not belong to this company");
      return options.inner.put(company, name, value);
    },
    async scheduleDelete(orgId, name) {
      const company = await companyFor(options.companies, options.personId);
      if (orgId !== company) throw agentXError("FORBIDDEN", "that secret does not belong to this company");
      await options.inner.scheduleDelete(company, name);
    },
  };
}
