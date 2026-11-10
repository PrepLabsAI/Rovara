// Port lane L2: the GitHub code host as a plug-in module. A config entry names a small module that exports `githubCodeHostPlugin({ createProvider })`
// as `plugin`; `createProvider` is where the install says how it reaches GitHub (a GitHub App, a personal token, `gh`): see `provider.ts`.
// The module checks that the client has every method the adapter needs, so a client from an older tree is refused when the process starts.
import { z } from "zod";
import { PluginRegistryError, type PluginContext, type PluginModule } from "@agentx/contracts";
import { contextSecretReader, readPluginSettings, SecretSourceSchema } from "../../module-support.js";
import { githubCodeHost, GITHUB_HOST_KIND } from "./index.js";
import { missingGitHubProviderMethods, type GitHubCodeHostProvider } from "./provider.js";

const GitHubCodeHostSettingsSchema = z.object({
  /** The credential reference the client was set up with. */
  credentialRef: z.string().min(1).max(200),
  /** Where the webhook signing secret is read from. Absent: the adapter accepts no webhook delivery. */
  webhookSecret: SecretSourceSchema.optional(),
  /** Item C2: this connection is the default GitHub connection (used by a repository that names no code host). At most one connection may say so. */
  default: z.boolean().optional(),
}).strict();

export interface GitHubCodeHostPluginOptions {
  /** Item C2: the connection's name, default `github`. A second connection (`github-company`) is a second module with its own name and its own `createProvider`. */
  name?: string;
  createProvider(context: PluginContext): GitHubCodeHostProvider | Promise<GitHubCodeHostProvider>;
}

export function githubCodeHostPlugin(options: GitHubCodeHostPluginOptions): PluginModule<"code-host"> {
  const name = options.name ?? GITHUB_HOST_KIND;
  return {
    point: "code-host",
    name,
    async create(context) {
      const settings = readPluginSettings(GitHubCodeHostSettingsSchema, context.settings, `code-host/${name}`);
      const provider = await options.createProvider(context);
      const missing = missingGitHubProviderMethods(provider);
      if (missing.length > 0) throw new PluginRegistryError("create_failed", `the GitHub client lacks methods the adapter needs: ${missing.join(", ")}`);
      return githubCodeHost(provider, {
        name,
        ...(settings.default === true ? { isDefault: true } : {}),
        credentialRef: settings.credentialRef,
        now: () => context.now().getTime(),
        ...(settings.webhookSecret === undefined ? {} : { webhookSecret: contextSecretReader(context, settings.webhookSecret) }),
      });
    },
  };
}
