// The broker's environment, put back together (ENV-ROOM; core switch-on blocker, 2026-11-15).
//
// Lambda holds all of a function's environment variables, keys and values together, to 4 KB, and a named environment's broker was over it. So the control plane does not give
// the broker what it can build or derive (packages/contracts/src/broker-environment.ts says which is which):
//  - the names CloudFormation generated come in one variable, AGENTX_NAMES (`code=value` pairs, decodeBrokerList), and a queue, a key, a state machine, a function or a role
//    arrives as its bare name or id;
//  - the health route's dead-letter queues are names too, and the broker lists them as `{ label: URL }` (HEALTH_DEAD_LETTER_QUEUES);
//  - the settings that are constrained parameters (flags, limits, epoch seconds, the Slack team) come in one variable, AGENTX_SETTINGS;
//  - what the environment's name decides is derived from AGENTX_ENV by the functions the infrastructure uses (DERIVED_BROKER_VARIABLES).
// `hydrateBrokerEnvironment` runs once, before anything else in the broker reads its environment (broker-environment-init.ts is broker.ts's first import), and sets each of these
// under the variable the broker's code has always read, so no reader changes and none is missed. URLs and ARNs are built from the region Lambda gives every function (AWS_REGION)
// and the account (AGENTX_ACCOUNT_ID).
//
// Nothing here calls AWS (since ENV-ROOM 2 the names may come from an SSM parameter, which broker-handler.ts reads into AGENTX_NAMES before this runs). A variable that is already set is never replaced, and an environment without AGENTX_NAMES or AGENTX_SETTINGS (the legacy install, which passes everything
// whole, and every test that sets the variables itself) is left exactly as it is. Anything that cannot be read throws, in fixed words that name the variable and code but never a
// value, so a broker that cannot name what it needs does not start.
import {
  BROKER_ACCOUNT_VARIABLE, BROKER_NAMES, BROKER_NAMES_PARAMETER_VARIABLE, BROKER_NAMES_VARIABLE, BROKER_SETTINGS, BROKER_SETTINGS_VARIABLE, BROKER_SETTING_VALUE, BROKER_SWITCH_FLAG_VALUES, DERIVED_BROKER_VARIABLES, EnvironmentNameSchema,
  LEGACY_INSTALL_LAYOUT, PUBLIC_API_URL_VARIABLE, decodeBrokerList, environmentRolePath, type BrokerNameSpec, type BrokerSettingSpec,
} from "@agentx/contracts";

export type MutableEnvironment = Record<string, string | undefined>;

/** The partition a region belongs to. */
export function awsPartitionOf(region: string): string {
  if (region.startsWith("cn-")) return "aws-cn";
  if (region.startsWith("us-gov-")) return "aws-us-gov";
  if (region.startsWith("us-isob-")) return "aws-iso-b";
  if (region.startsWith("us-iso-")) return "aws-iso";
  return "aws";
}

interface Scope { partition: string; region: string; account: string }

const ACCOUNT = /^[0-9]{12}$/u;
const REGION = /^[a-z]{2}(?:-[a-z]+)+-[0-9]{1,2}$/u;

/** The region and the account, which build a URL or an ARN from a name; a name that needs them and cannot have them is an error. */
function requiredScope(env: MutableEnvironment, needed: string): Scope {
  const region = env.AWS_REGION;
  if (region === undefined || !REGION.test(region)) throw new Error(`AWS_REGION is required to build ${needed}`);
  // The hosts built here (`sqs.<region>.amazonaws.com`, `execute-api...`) are the aws and aws-cn partitions' only: refuse an ISO partition rather than build a wrong URL.
  if (/^[a-z]{2}-iso[a-z]*-/u.test(region)) throw new Error(`AWS_REGION is in a partition the broker cannot build ${needed} for`);
  const account = env[BROKER_ACCOUNT_VARIABLE];
  if (account === undefined || !ACCOUNT.test(account)) throw new Error(`${BROKER_ACCOUNT_VARIABLE} (12 digits) is required to build ${needed}`);
  return { partition: awsPartitionOf(region), region, account };
}

const suffix = ({ partition }: Scope): string => (partition === "aws-cn" ? ".cn" : "");
const queueUrl = (scope: Scope, name: string): string => `https://sqs.${scope.region}.amazonaws.com${suffix(scope)}/${scope.account}/${name}`;

const isSet = (value: string | undefined): value is string => value !== undefined && value !== "";
/** What CloudFormation gives a resource for a name or an id: no slash, no space, nothing a URL or an ARN would read differently. */
const NAME = /^[A-Za-z0-9._-]{1,255}$/u;

/** The environment's name, checked: a role's path and every derived value are built from it. */
function environmentName(env: MutableEnvironment, needed: string): string {
  const parsed = EnvironmentNameSchema.safeParse(env.AGENTX_ENV);
  if (!parsed.success) throw new Error(`AGENTX_ENV (a valid environment name) is required to build ${needed}`);
  return parsed.data;
}

function build(spec: BrokerNameSpec, value: string, env: MutableEnvironment): string {
  const needed = `${spec.variable} from ${BROKER_NAMES_VARIABLE}.${spec.code}`;
  switch (spec.kind) {
    case "name": return value;
    case "queueUrl":
    case "deadLetterQueue": return queueUrl(requiredScope(env, needed), value);
    case "apiIssuer": {
      // CODE-PUBLIC-URL: an install with a public address (hydrateBrokerSettings set it from the packed setting, which runs first) has its address as its issuer, not the API's own host.
      const origin = env[PUBLIC_API_URL_VARIABLE];
      if (isSet(origin)) return `${origin}/v1/auth`;
      const scope = requiredScope(env, needed);
      return `https://${value}.execute-api.${scope.region}.amazonaws.com${suffix(scope)}/v1/auth`;
    }
    case "kmsKeyArn": {
      const scope = requiredScope(env, needed);
      return `arn:${scope.partition}:kms:${scope.region}:${scope.account}:key/${value}`;
    }
    case "stateMachineArn": {
      const scope = requiredScope(env, needed);
      return `arn:${scope.partition}:states:${scope.region}:${scope.account}:stateMachine:${value}`;
    }
    case "lambdaFunctionArn": {
      const scope = requiredScope(env, needed);
      return `arn:${scope.partition}:lambda:${scope.region}:${scope.account}:function:${value}`;
    }
    case "roleArn": {
      const scope = requiredScope(env, needed);
      return `arn:${scope.partition}:iam::${scope.account}:role${environmentRolePath(environmentName(env, needed))}${value}`;
    }
  }
}

/** The names AGENTX_NAMES may hold, by code. */
const NAME_BY_CODE: ReadonlyMap<string, BrokerNameSpec> = new Map(Object.values(BROKER_NAMES).map((spec: BrokerNameSpec) => [spec.code, spec]));
/** The settings AGENTX_SETTINGS may hold, by code. */
const SETTING_BY_CODE: ReadonlyMap<string, BrokerSettingSpec> = new Map(Object.values(BROKER_SETTINGS).map((spec: BrokerSettingSpec) => [spec.code, spec]));

/**
 * Rollout safety: during a deploy, code can briefly start with the other revision's environment, so a code this code does not know is skipped, with
 * one log line naming the codes (never their values), and not fatal. A value that is malformed is still fatal: only an unknown code is tolerated. In the other direction (newer
 * code, older environment) a missing name is never made up: its variable stays unset and its reader fails closed as it always did.
 */
function logUnknownCodes(variable: string, codes: string[]): void {
  if (codes.length === 0) return;
  console.log(JSON.stringify({ level: "warn", event: "broker_environment.unknown_codes", variable, codes: [...codes].sort(), detail: "ignored: the environment is from another revision" }));
}

function readList<S extends { code: string; variable: string }>(env: MutableEnvironment, variable: string, byCode: ReadonlyMap<string, S>, valid: RegExp, what: string): Array<{ spec: S; value: string }> {
  const raw = env[variable];
  if (!isSet(raw)) return [];
  const decoded = decodeBrokerList(raw);
  if ("error" in decoded) throw new Error(`${variable} ${decoded.error}`);
  const unknown: string[] = [];
  const known = decoded.entries.flatMap(([code, value]) => {
    const spec = byCode.get(code);
    if (spec === undefined) { unknown.push(code); return []; }
    if (!valid.test(value)) throw new Error(`${variable} has no ${what} for ${code} (${spec.variable})`);
    return [{ spec, value }];
  });
  logUnknownCodes(variable, unknown);
  return known;
}

/** AGENTX_NAMES as the names under their variables. A list that is not exactly known codes and plain names throws. */
export function brokerNamesFromEnvironment(env: MutableEnvironment): Array<{ spec: BrokerNameSpec; value: string }> {
  return readList(env, BROKER_NAMES_VARIABLE, NAME_BY_CODE, NAME, "valid name");
}

/** AGENTX_SETTINGS as the settings under their variables. A list that is not exactly known codes and plain values throws (a flag read as unset would turn a feature off without a word). */
export function brokerSettingsFromEnvironment(env: MutableEnvironment): Array<{ spec: BrokerSettingSpec; value: string }> {
  return readList(env, BROKER_SETTINGS_VARIABLE, SETTING_BY_CODE, BROKER_SETTING_VALUE, "plain value");
}

/**
 * Sets, in `env`, what the control plane did not pass whole. The settings wherever AGENTX_SETTINGS is present; the rest only where AGENTX_NAMES is present (a named environment's
 * broker): the names under their variables (the dead-letter queues as one JSON object of URLs by label), then what the environment's name decides. A variable that is already
 * set is not replaced (an empty setting, an install that leaves the Slack team out, is set as empty, as the parameter's own value was).
 */
export function hydrateBrokerSettings(env: MutableEnvironment): void {
  // The settings first: they are plain values the rest does not need, and a bad list stops the broker before anything is built from it.
  for (const { spec, value } of brokerSettingsFromEnvironment(env)) {
    // A host setting (the core's model gateway) becomes its https origin; empty stays empty, so an unset gateway reads as unset.
    if (isSet(env[spec.variable])) continue;
    if (spec.switchFlag === true) {
      // DEC 254zg (a): "1" or "0" only; anything else stops the broker rather than guess the switch.
      const flag = Object.hasOwn(BROKER_SWITCH_FLAG_VALUES, value) ? BROKER_SWITCH_FLAG_VALUES[value] : undefined;
      if (flag === undefined) throw new Error(`${BROKER_SETTINGS_VARIABLE} has no switch flag for ${spec.code} (${spec.variable})`);
      env[spec.variable] = flag;
    } else env[spec.variable] = spec.httpsOrigin === true && value !== "" ? `https://${value}` : value;
  }
}

export function hydrateBrokerEnvironment(env: MutableEnvironment): void {
  // ENV-ROOM 2: where the names are in a parameter, broker-handler.ts reads them into AGENTX_NAMES before this runs. A broker loaded any other way would start with no names
  // and with nothing derived, and fail only where each is first used: refuse here, at once.
  if (env[BROKER_NAMES_PARAMETER_VARIABLE] !== undefined && env[BROKER_NAMES_VARIABLE] === undefined) throw new Error(`${BROKER_NAMES_PARAMETER_VARIABLE} is set but the names were not read from it before the broker loaded`);
  hydrateBrokerSettings(env);
  // A named broker always has AGENTX_NAMES (with its account); an empty list still means a packed broker, so the derived variables are still built.
  if (env[BROKER_NAMES_VARIABLE] === undefined) return;
  const queues = new Map<BrokerNameSpec, string>();
  for (const { spec, value } of brokerNamesFromEnvironment(env)) {
    if (spec.kind === "deadLetterQueue") queues.set(spec, build(spec, value, env));
    else if (!isSet(env[spec.variable])) env[spec.variable] = build(spec, value, env);
  }
  // The route lists the queues in the table's order, whatever order the names came in.
  const listed = Object.values(BROKER_NAMES).flatMap((spec: BrokerNameSpec) => (queues.has(spec) ? [[spec.label ?? spec.code, queues.get(spec)!] as const] : []));
  if (listed.length > 0 && !isSet(env.HEALTH_DEAD_LETTER_QUEUES)) env.HEALTH_DEAD_LETTER_QUEUES = JSON.stringify(Object.fromEntries(listed));
  const name = environmentName(env, "the broker's derived variables");
  // #1149: the legacy install (production) derives only what is marked `legacy`, the values identical to its own; nothing else is added (contracts LEGACY_INSTALL_LAYOUT).
  const legacy = env[BROKER_SETTINGS.installLayout.variable] === LEGACY_INSTALL_LAYOUT;
  for (const entry of DERIVED_BROKER_VARIABLES) {
    if (legacy && entry.legacy !== true) continue;
    if (isSet(env[entry.variable])) continue;
    env[entry.variable] = entry.kind === "text" ? entry.value(name) : queueUrl(requiredScope(env, entry.variable), entry.queueName(name));
  }
}
