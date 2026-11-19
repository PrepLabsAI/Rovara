// The trackers `rovara up` registers when the owner has signed in to them: Linear (an API key) and Jira (a site, an email and an API token). Each sign-in is read through the `secrets` socket when it is
// used, never kept: `{ env: "LINEAR_API_KEY" }` then `{ key: "linear" }` (an entry of `<state folder>/keys.json`), and `{ env: "JIRA_API_TOKEN" }` then `{ key: "jira" }`. The Jira site and email are not
// secrets: `JIRA_SITE_URL` (an https address on atlassian.net) and `JIRA_EMAIL`. A key that is the owner's own account is the owner's own account: Rovara's echo of what it writes is told apart by the notes it
// keeps of its own writes, not by the account. A tracker with no sign-in is not registered; a configured `tracker` plug-in of the same name is used instead (the caller leaves it alone).
import { IMPLICIT_COMPANY_ID, type SecretRef, type SecretStore, type Tracker } from "@agentx/contracts";
import { asSecretValue } from "../ports/index.js";
import { createLinearApiAccess } from "../plugins/tracker/linear/api.js";
import { linearTracker } from "../plugins/tracker/linear/index.js";
import { jiraSiteOf, jiraTracker } from "../plugins/tracker/jira/index.js";

export interface LocalTrackersInput {
  environment: NodeJS.ProcessEnv;
  secrets: SecretStore;
  companyId?: string | undefined;
  fetch?: typeof fetch | undefined;
}

export const LINEAR_KEY_REFS: readonly SecretRef[] = [{ env: "LINEAR_API_KEY" }, { key: "linear" }];
export const JIRA_TOKEN_REFS: readonly SecretRef[] = [{ env: "JIRA_API_TOKEN" }, { key: "jira" }];

/** The first sign-in the `secrets` socket has among `refs`, read now; undefined when there is none. A secrets adapter that fails is read as "none here": its words are never passed on. */
async function readFirst(secrets: SecretStore, companyId: string, refs: readonly SecretRef[]): Promise<string | undefined> {
  for (const ref of refs) {
    try {
      const value = asSecretValue(await secrets.read(companyId, ref));
      const text = value?.reveal();
      if (text !== undefined && text.trim() !== "") return text.trim();
    } catch {
      // Not readable from this source: the next one is tried.
    }
  }
  return undefined;
}

/** The trackers a laptop can sign in to, each only when it finds its sign-in. */
export async function createLocalTrackers(input: LocalTrackersInput): Promise<Tracker[]> {
  const companyId = input.companyId ?? IMPLICIT_COMPANY_ID;
  const found: Tracker[] = [];
  if (await readFirst(input.secrets, companyId, LINEAR_KEY_REFS) !== undefined) {
    found.push(linearTracker(createLinearApiAccess({ apiKey: () => readFirst(input.secrets, companyId, LINEAR_KEY_REFS), companyId, ...(input.fetch === undefined ? {} : { fetch: input.fetch }) })));
  }
  const site = jiraSiteOf(input.environment["JIRA_SITE_URL"]);
  const email = input.environment["JIRA_EMAIL"]?.trim();
  if (site !== undefined && email !== undefined && email !== "" && await readFirst(input.secrets, companyId, JIRA_TOKEN_REFS) !== undefined) {
    found.push(jiraTracker({ site, email, apiToken: () => readFirst(input.secrets, companyId, JIRA_TOKEN_REFS), ...(input.fetch === undefined ? {} : { fetch: input.fetch }) }));
  }
  return found;
}
