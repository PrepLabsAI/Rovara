import { z } from "zod";
import { agentXError } from "./errors.js";
import { AgentXNameSchema } from "./project.js";

const accountPattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const bindingSchema = z.object({
  credentialRef: AgentXNameSchema,
  account: z.string().regex(accountPattern),
  appId: z.string().regex(/^[1-9][0-9]{0,19}$/),
  installationId: z.string().regex(/^[1-9][0-9]{0,19}$/),
  privateKeySecretArn: z.string().max(2048).regex(
    /^arn:aws(?:-cn|-us-gov)?:secretsmanager:[a-z]{2}(?:-[a-z]+)+-[0-9]:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+-[A-Za-z0-9]{6}$/,
  ),
  repositories: z.array(z.string().max(512)).min(1).max(32),
}).strict();

export type GitHubAppBinding = z.infer<typeof bindingSchema>;

/** Match the raw spelling first: URL() alone silently normalizes unsafe aliases. */
export function canonicalGitHubRepository(value: string): string {
  const match = typeof value === "string" && !/\s/.test(value)
    ? /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]{1,104})$/i.exec(value)
    : null;
  // Keep transport-suffix handling identical to GitHubAppCredentialProvider.
  const repository = match?.[2]?.replace(/\.git$/, "");
  if (!match || !repository || repository.length > 100 || repository === "." || repository === "..") {
    throw agentXError("CONFIG_INVALID", "invalid GitHub repository identity");
  }
  return `https://github.com/${match[1]!.toLowerCase()}/${repository.toLowerCase()}.git`;
}

export function parseAdditionalGitHubAppBindings(value: unknown, legacyCredentialRef: string): GitHubAppBinding[] {
  try {
    const bindings = z.array(bindingSchema).max(32).parse(value);
    const refs = new Set([legacyCredentialRef]);
    const repositories = new Set<string>();
    return bindings.map((binding) => {
      if (refs.has(binding.credentialRef)) throw new Error();
      refs.add(binding.credentialRef);
      return { ...binding, repositories: binding.repositories.map((url) => {
        const repository = canonicalGitHubRepository(url);
        if (repository.split("/")[3] !== binding.account.toLowerCase() || repositories.has(repository)) {
          throw new Error();
        }
        repositories.add(repository);
        return repository;
      }) };
    });
  } catch {
    throw agentXError("CONFIG_INVALID", "invalid GitHub App binding configuration");
  }
}
