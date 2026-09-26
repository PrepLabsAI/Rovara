import { z } from "zod";

/** Lowercase letters, digits and single hyphens; starts with a letter; at most 20 characters. */
export const ENVIRONMENT_NAME_PATTERN = /^[a-z](?:[a-z0-9-]{0,18}[a-z0-9])?$/;

export const EnvironmentNameSchema = z
  .string()
  .regex(ENVIRONMENT_NAME_PATTERN, "environment name must be lowercase letters, digits and hyphens, start with a letter, and be at most 20 characters")
  .refine((name) => !name.includes("--"), "environment name must not contain a doubled hyphen")
  .refine(
    (name) => name !== "connectors",
    'environment name must not be "connectors" (reserved: its connector-secret prefix agentx/connectors/connectors/ would fall under the legacy connector secrets grant agentx/connectors/*)',
  );

export const DEFAULT_ENVIRONMENT = "production";

export type StackPart = "foundation" | "identity" | "runtime" | "control-plane" | "slack";

/** In deploy order. */
export const STACK_PARTS: readonly StackPart[] = ["foundation", "identity", "runtime", "control-plane", "slack"];

function checked(env: string): string {
  const parsed = EnvironmentNameSchema.safeParse(env);
  if (!parsed.success) throw new Error(`invalid environment name ${JSON.stringify(env)}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  return parsed.data;
}

export function environmentStackName(env: string, part: StackPart): string {
  return `agentx-${checked(env)}-${part}`;
}

export function environmentSettingsPrefix(env: string): string {
  return `/agentx/${checked(env)}/`;
}

export function environmentConnectorSecretPrefix(env: string): string {
  return `agentx/${checked(env)}/connectors/`;
}
