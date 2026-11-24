// The ONE reader of a company's stored package token (decision 5 of the Opus plan check: `read(` of a `pkgreg_` name has exactly one caller, this one, called only by the exchange).
//   - It reads through the COMPANY's secret store (`ConnectionSecrets`: the company-tagged session in the hosted install, a file only the owner can read on a laptop), NOT through the generic `secrets` point,
//     whose hosted prefix is another name. The store checks the name against the company before it touches anything (`admitSecretName`); IAM fences it again by the session's company tag.
//   - The name is `companyRegistrySecretName(env, company, host)`: built from the company of the run and the fixed host table, nothing a worker, a project or a browser sent.
//   - The value is the token itself (one line), or one small JSON object `{"token": "...", "username": "..."}`. Anything else is "not saved", never a guess.
//   - Nothing the store says (an error, the name, the value) leaves this file; the caller turns every failure into one fixed sentence. Read at every use; never kept.
import { companyRegistrySecretName, type PrivateRegistryHost } from "@agentx/contracts";
import { z } from "zod";
import type { ConnectionSecrets } from "../../connections/org-secrets.js";
import type { CompanyRegistryStore, StoredRegistryCredential } from "./mint.js";

const StoredJsonSchema = z.object({ token: z.string(), username: z.string().optional() }).strict();

/** The value as a credential, or undefined when it is not one. Never throws and never quotes the value. */
export function parseStoredRegistryValue(raw: string | undefined): StoredRegistryCredential | undefined {
  const text = raw?.trim();
  if (text === undefined || text === "") return undefined;
  if (!text.startsWith("{")) return { token: text };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return undefined; }
  const object = StoredJsonSchema.safeParse(parsed);
  return object.success ? { token: object.data.token.trim(), ...(object.data.username === undefined ? {} : { username: object.data.username }) } : undefined;
}

export function companyRegistryTokenReader(input: { env: string; secrets: Pick<ConnectionSecrets, "read"> }): CompanyRegistryStore["token"] {
  return async (companyId: string, host: PrivateRegistryHost) => {
    const name = companyRegistrySecretName(input.env, companyId, host);
    if (name === undefined) return undefined;
    return parseStoredRegistryValue(await input.secrets.read(companyId, name));
  };
}
