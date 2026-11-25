/**
 * The AWS-side names and the AI source-kind switch the model gateway's stacks are built with, as Rovara Cloud wrote them
 * (Rovara Cloud's packages/contracts: resource-prefix.ts, environments.ts, model-sources.ts at 7d999ade3). The gateway moved
 * into Code (#1478) without moving its resources: its stacks keep the `rovara-cloud-<env>-gateway*` names, the `/rovara-cloud/<env>/`
 * settings and IAM path and the `RovaraCloud` metric namespace, so these values must not change. Code's own contracts name Code's
 * resources under `agentx`; the two are kept apart on purpose.
 */
export const RESOURCE_PREFIX = "rovara-cloud";

/** The tag key every resource of an environment carries, valued with the environment's name. */
export const ENVIRONMENT_TAG_KEY = `${RESOURCE_PREFIX}:env`;

/** The root of an environment's CloudWatch metric namespace (`RovaraCloud/<env>`). */
export const METRICS_NAMESPACE_ROOT = "RovaraCloud";

/** Lowercase letters, digits and single hyphens; starts with a letter; at most 14 characters (Cloud's environment names). */
const ENVIRONMENT_NAME_PATTERN = /^[a-z](?:[a-z0-9-]{0,12}[a-z0-9])?$/u;

function checked(env: string): string {
  if (!ENVIRONMENT_NAME_PATTERN.test(env)) throw new Error(`invalid environment name ${JSON.stringify(env)}: environment name must be lowercase letters, digits and hyphens, start with a letter, and be at most 14 characters`);
  if (env.includes("--")) throw new Error(`invalid environment name ${JSON.stringify(env)}: environment name must not contain a doubled hyphen`);
  if (env === "connectors") throw new Error(`invalid environment name ${JSON.stringify(env)}: environment name must not be "connectors"`);
  if (env !== "qqenv-phldrqq" && env.includes("qqenv")) throw new Error(`invalid environment name ${JSON.stringify(env)}: environment name must not contain "qqenv" (reserved for published templates)`);
  return env;
}

/** `/rovara-cloud/<env>/`: an environment's settings prefix and IAM path. Throws for a name Cloud would refuse. */
export function environmentSettingsPrefix(env: string): string {
  return `/${RESOURCE_PREFIX}/${checked(env)}/`;
}

/** The kinds a company can add as its own AI source. */
export const CUSTOM_SOURCE_KINDS = ["anthropic", "openai", "openrouter", "bedrock", "endpoint"] as const;
export type CustomSourceKind = (typeof CUSTOM_SOURCE_KINDS)[number];

/**
 * An install's switched-on kinds from its setting: comma-separated supported kinds, no spaces, no repeats. Absent or empty: none.
 * Anything else throws with fixed words (a broken setting is refused as a whole, and the value is never repeated).
 */
export function parseSourceKindsSwitch(value: string | undefined): CustomSourceKind[] {
  if (value === undefined || value === "") return [];
  const kinds = value.split(",");
  if (kinds.length > CUSTOM_SOURCE_KINDS.length || new Set(kinds).size !== kinds.length || !kinds.every((kind) => (CUSTOM_SOURCE_KINDS as readonly string[]).includes(kind))) throw new Error("invalid AI source kinds");
  return kinds as CustomSourceKind[];
}

/** Rovara-cloud#308: the company AI source kinds production may switch on, each only after its real-key check passed. */
export const PRODUCTION_SOURCE_KINDS: readonly CustomSourceKind[] = ["openai"];
/** Whether production may carry this setting: every kind it names is one of PRODUCTION_SOURCE_KINDS. */
export function productionSourceKindsAllowed(value: string | undefined): boolean {
  return parseSourceKindsSwitch(value).every((kind) => PRODUCTION_SOURCE_KINDS.includes(kind));
}
/** The fixed refusal for a production deploy naming a kind production may not switch on. */
export const PRODUCTION_SOURCE_KINDS_REFUSAL = `production may switch on only these company AI sources: ${PRODUCTION_SOURCE_KINDS.join(", ")}; the others are for named test environments until a Cloud release carries them`;
