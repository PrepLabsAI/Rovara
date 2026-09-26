import { EnvironmentNameSchema } from "./environments.js";

/** A valid environment name no real environment can use (EnvironmentNameSchema refuses "qqenv"). */
export const ENVIRONMENT_PLACEHOLDER = "qqenv-placeholderqq";
/** The same name as naming.ts writes it where hyphens are not allowed (AgentCore names). */
export const ENVIRONMENT_PLACEHOLDER_UNDERSCORED = "qqenv_placeholderqq";

/** Turns a published template (synthesized for the placeholder) into the template for env. */
export function renderTemplate(text: string, env: string): string {
  const parsed = EnvironmentNameSchema.safeParse(env);
  if (!parsed.success) throw new Error(`invalid environment name ${JSON.stringify(env)}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  const rendered = text
    .replaceAll(ENVIRONMENT_PLACEHOLDER, parsed.data)
    .replaceAll(ENVIRONMENT_PLACEHOLDER_UNDERSCORED, parsed.data.replaceAll("-", "_"));
  if (rendered.includes("qqenv")) throw new Error("rendered template still contains the environment placeholder");
  return rendered;
}
