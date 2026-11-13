// The ready-made module a plug-in config names for AWS Secrets Manager: `"module": "@rovara-code/core/plugins/secrets-aws"`.
import { secretsManagerSecretsPlugin } from "./plugin.js";

export const plugin = secretsManagerSecretsPlugin();
export default plugin;
