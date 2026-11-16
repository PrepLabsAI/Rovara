// TE-H1 browser evidence, slice 3: the saved sign-in of a project whose app sits behind a login. A recipe (browser-evidence.ts) holds only the NAME of the saved sign-in (`be-<project>-signin`); the values (a user name and a
// password of a TEST account) live in the company's secret store, under the company's own path, exactly where a connection's key lives (`ConnectionSecrets`: on a laptop a file only its owner can read). This module is the one
// place that writes, reads or removes them, and what it guarantees:
//   - the secret's name is built here from the company and the project and from nothing a caller sends: `agentx/<env>/org-connectors/<company>/be-<project>-signin`. A reference that is not exactly the project's own
//     (another project's, a connection's, a registered server's) is refused before the store is asked, so a recipe can never make the run read another secret into a login form;
//   - the company is part of the name and is checked again by the store (`admitSecretName`): company A's project of the same name is another secret, and company B reads nothing of A's;
//   - a value is read at the moment a run needs it and is never kept here, never put in a record, a payload, an error, a log line or a return value other than the one that asked for it;
//   - the values are plain single lines of 4 to 200 characters (`BrowserEvidenceSignInValuesSchema`), written as one small JSON document; a document that does not parse as exactly that is "not saved", never a guess.
// Nothing here knows a browser, a page or a task.
import { BrowserEvidenceSignInValuesSchema, agentXError, browserEvidenceSignInRef, isBrowserEvidenceSignInRefOf, type BrowserEvidenceSignInValues } from "@agentx/contracts";
import type { ConnectionSecrets } from "../../connections/org-secrets.js";

/** The fixed sentences a refusal says. Never a value, a path or the store's own words. */
export const SIGN_IN_WORDS = {
  invalid: "The sign-in is a user name and a password, each 4 to 200 characters on one line.",
  badProject: "That is not a project name.",
  notYours: "That sign-in does not belong to this project.",
} as const;

export interface BrowserEvidenceSignIn {
  /** The project's saved sign-in, or undefined when none is saved, it does not read as a sign-in, or `ref` is not this project's own reference. Never throws for a missing secret. */
  read(orgId: string, project: string, ref: string): Promise<BrowserEvidenceSignInValues | undefined>;
  /** Whether a usable sign-in is saved (it reads as one). Says nothing of its values. */
  has(orgId: string, project: string): Promise<boolean>;
  /** Saves the values as the project's sign-in, replacing an earlier one. Throws an `AgentXError` with a fixed sentence for values that are not valid. */
  save(orgId: string, project: string, values: unknown): Promise<void>;
  /** Removes the project's saved sign-in. Nothing saved is already removed. */
  clear(orgId: string, project: string): Promise<void>;
}

export function browserEvidenceSignInSecretName(env: string, orgId: string, project: string): string | undefined {
  const ref = browserEvidenceSignInRef(project);
  return ref === undefined ? undefined : `agentx/${env}/org-connectors/${orgId}/${ref}`;
}

export function createBrowserEvidenceSignIn(options: { secrets: ConnectionSecrets; env: string }): BrowserEvidenceSignIn {
  const { secrets, env } = options;
  const nameOf = (orgId: string, project: string): string => {
    const name = browserEvidenceSignInSecretName(env, orgId, project);
    if (name === undefined) throw agentXError("CONFIG_INVALID", SIGN_IN_WORDS.badProject);
    return name;
  };
  const parse = (text: string | undefined): BrowserEvidenceSignInValues | undefined => {
    if (text === undefined) return undefined;
    try {
      const parsed = BrowserEvidenceSignInValuesSchema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : undefined;
    } catch { return undefined; }
  };
  return {
    async read(orgId, project, ref) {
      // The reference is the recipe's; the project is the task's own. They must be the same project's, or nothing is read.
      if (!isBrowserEvidenceSignInRefOf(project, ref)) return undefined;
      return parse(await secrets.read(orgId, nameOf(orgId, project)));
    },
    async has(orgId, project) { return parse(await secrets.read(orgId, nameOf(orgId, project))) !== undefined; },
    async save(orgId, project, values) {
      const name = nameOf(orgId, project);
      const checked = BrowserEvidenceSignInValuesSchema.safeParse(values);
      if (!checked.success) throw agentXError("CONFIG_INVALID", SIGN_IN_WORDS.invalid);
      await secrets.put(orgId, name, JSON.stringify({ username: checked.data.username, password: checked.data.password }));
    },
    async clear(orgId, project) { await secrets.scheduleDelete(orgId, nameOf(orgId, project)); },
  };
}
