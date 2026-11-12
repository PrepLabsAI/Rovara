// Convergence lane A3 (owner decision 72, O2): the Secrets Manager `secrets` module. Opt-in: with no `secrets` entry in the config, Code keeps its own adapter (environment, files, keys.json).
// Config entry (one identity is required, as for Bedrock):
//   { "point": "secrets", "name": "aws-secrets-manager", "module": "@agentx/broker/plugins/secrets-aws",
//     "settings": { "region": "us-west-2", "profile": "rovara-secrets", "namePrefix": "rovara/" } }
// A reference is then `{ "awsSecret": "github" }` (reads `rovara/github`). The identity needs secretsmanager:GetSecretValue on `<prefix>*` (and kms:Decrypt on a customer key, if the secrets use one).
// A HOSTED (many-company) setup must set both `namePrefix` (its environment's own path, `agentx/<env>/`, so no reference reaches another environment's secrets) and `companyPaths`
// (`["org-connectors", "org-hooks"]`, so a company's secret is read only for that company), and give `clientFor` a per-company session; without `companyPaths` the adapter reads any name
// under the prefix for any company. A one-owner laptop install needs neither.
// A configured `secrets` plug-in is the source of truth (docs/ports.md): Code's model keys and GitHub token ask `{ "env" }` and `{ "key" }`, which this adapter does not know, so name those
// sources in the adapters that read them, or keep Code's own `secrets` adapter.
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { z } from "zod";
import type { PluginModule } from "@agentx/contracts";
import type { AwsCredentialLoaders } from "../../model-provider/bedrock/credentials.js";
import { readPluginSettings } from "../../module-support.js";
import { AwsIdentitySettingsShape, ONE_AWS_IDENTITY, awsCredentialsFor, hasOneAwsIdentity } from "../../aws-identity.js";
import { createSecretsManagerSecretStore, SecretsManagerSecretError, type SecretsManagerClientLike } from "@rovara/aws-adapters/secrets-manager";
import { LocalSecretError } from "../../../ports/secret-error.js";

export const AWS_SECRETS_MANAGER_NAME = "aws-secrets-manager";

export const SecretsManagerSettingsSchema = z.object({
  ...AwsIdentitySettingsShape,
  namePrefix: z.string().max(256).regex(/^(?:[A-Za-z0-9_+=.@-]+\/)*$/u, "parts of plain characters, each ending with /"),
  companyPaths: z.array(z.string().regex(/^[A-Za-z0-9_+=@-][A-Za-z0-9_+=.@-]*$/u, "one plain part of a secret name")).max(16).optional(),
}).strict().refine(hasOneAwsIdentity, ONE_AWS_IDENTITY);

export interface SecretsManagerPluginOptions {
  /** Replaces the client (tests, or a deployment with its own per-company sessions). The settings must still name an identity. */
  clientFor?: (companyId: string) => SecretsManagerClientLike | Promise<SecretsManagerClientLike>;
  loaders?: AwsCredentialLoaders;
}

export function secretsManagerSecretsPlugin(options: SecretsManagerPluginOptions = {}): PluginModule<"secrets"> {
  return {
    point: "secrets",
    name: AWS_SECRETS_MANAGER_NAME,
    create(context) {
      const settings = readPluginSettings(SecretsManagerSettingsSchema, context.settings, `secrets/${AWS_SECRETS_MANAGER_NAME}`);
      let client: SecretsManagerClient | undefined;
      const clientFor = options.clientFor ?? (() => {
        client ??= new SecretsManagerClient({
          region: settings.region,
          credentials: awsCredentialsFor(settings, { sessionName: "rovara-secrets", ...(options.loaders === undefined ? {} : { loaders: options.loaders }) }),
        });
        return client;
      });
      const store = createSecretsManagerSecretStore({ namePrefix: settings.namePrefix, clientFor, ...(settings.companyPaths === undefined ? {} : { companyPaths: settings.companyPaths }) });
      return {
        // The adapter's refusals are fixed sentences; they are shown as Code's own (`LocalSecretError`), which callers show as they are.
        read: async (companyId, ref) => {
          try { return await store.read(companyId, ref); } catch (error) {
            throw error instanceof SecretsManagerSecretError ? new LocalSecretError(error.message) : new LocalSecretError("the secrets service could not be reached");
          }
        },
        close: () => { client?.destroy(); },
      };
    },
  };
}
