import { EnvironmentNameSchema, assertCognitoDomainSafe } from "./environments.js";

/** A valid environment name no real environment can use (EnvironmentNameSchema refuses "qqenv"). */
export const ENVIRONMENT_PLACEHOLDER = "qqenv-placeholderqq";
/** Turns a published template (synthesized for the placeholder) into the template for env. */
export function renderTemplate(text: string, env: string): string {
  const parsed = EnvironmentNameSchema.safeParse(env);
  if (!parsed.success) throw new Error(`invalid environment name ${JSON.stringify(env)}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  // The published templates are synthesized once for the placeholder, so IdentityStack's own
  // synth-time check never runs against the real environment name; catch it here instead, before
  // a deploy that would otherwise fail on the Cognito side.
  if (text.includes("AWS::Cognito::UserPoolDomain")) assertCognitoDomainSafe(parsed.data);
  const rendered = text.replaceAll(ENVIRONMENT_PLACEHOLDER, parsed.data);
  if (rendered.includes("qqenv")) throw new Error("rendered template still contains the environment placeholder");
  return rendered;
}
