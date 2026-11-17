// ENV-ROOM 2 (broker 4 KB, owner decision 2026-11-17): a named environment's broker names (AGENTX_NAMES) are kept in one SSM String parameter, not in the function's
// environment (packages/contracts/src/broker-environment.ts says why only the names). The environment says which parameter (AGENTX_NAMES_PARAMETER) and which revision of it
// this function was deployed with (AGENTX_NAMES_REVISION). This reads it, once, before any module of the broker loads (broker-handler.ts), and puts the list in AGENTX_NAMES,
// where hydrateBrokerEnvironment (broker-environment.ts) has always read it.
//
// It fails closed: a broker that cannot be sure of its names does not start. Every refusal is in fixed words that never carry a value (a name, the parameter's content or an AWS
// error's message), only, where it helps, the AWS error's name.
import {
  BROKER_NAMES_PARAMETER_VARIABLE, BROKER_NAMES_REVISION, BROKER_NAMES_REVISION_VARIABLE, BROKER_NAMES_VARIABLE, EnvironmentNameSchema, brokerNamesParameterName,
  decodeBrokerNamesParameter,
} from "@agentx/contracts";
import type { MutableEnvironment } from "./broker-environment.js";

/** What GetParameter gives back that this reads: the parameter's type and value. */
export interface FetchedParameter {
  readonly type: string | undefined;
  readonly value: string | undefined;
}
export type ParameterReader = (name: string) => Promise<FetchedParameter>;

/** An AWS error's name (ParameterNotFound, AccessDeniedException, ...), when it is one: never its message. */
function errorName(error: unknown): string {
  const name = error instanceof Error ? error.name : undefined;
  return name !== undefined && /^[A-Za-z]{1,64}$/u.test(name) ? name : "an error";
}

/**
 * Sets AGENTX_NAMES from the parameter the environment points at, or leaves the environment as it is where it points at none (the legacy install, a named environment whose
 * template still passes AGENTX_NAMES itself, every test that sets the variables). Throws, and sets nothing, unless:
 *  - the pointer and the revision are both there (one without the other is a broken environment), and AGENTX_NAMES is not also given (two sources would be a guess);
 *  - the pointer is this environment's own parameter (brokerNamesParameterName of AGENTX_ENV), and the revision is a revision;
 *  - the parameter can be read, is a plain String, and is in the v1 format;
 *  - the revision it was written with is the function's: a cold start of one deploy's function with another deploy's parameter (mid-deploy, a rollback, a hand edit) refuses.
 */
export async function loadBrokerNamesParameter(env: MutableEnvironment, read: ParameterReader): Promise<void> {
  const pointer = env[BROKER_NAMES_PARAMETER_VARIABLE];
  const revision = env[BROKER_NAMES_REVISION_VARIABLE];
  if (pointer === undefined && revision === undefined) return;
  if (pointer === undefined || revision === undefined) throw new Error(`${BROKER_NAMES_PARAMETER_VARIABLE} and ${BROKER_NAMES_REVISION_VARIABLE} are given together or not at all`);
  if (env[BROKER_NAMES_VARIABLE] !== undefined) throw new Error(`${BROKER_NAMES_VARIABLE} is given as well as ${BROKER_NAMES_PARAMETER_VARIABLE}; the broker takes its names from one place`);
  if (!BROKER_NAMES_REVISION.test(revision)) throw new Error(`${BROKER_NAMES_REVISION_VARIABLE} is not a revision`);
  const environment = EnvironmentNameSchema.safeParse(env.AGENTX_ENV);
  if (!environment.success) throw new Error(`AGENTX_ENV (a valid environment name) is required to read ${BROKER_NAMES_PARAMETER_VARIABLE}`);
  if (pointer !== brokerNamesParameterName(environment.data)) throw new Error(`${BROKER_NAMES_PARAMETER_VARIABLE} is not this environment's broker names parameter`);
  let fetched: FetchedParameter;
  try {
    fetched = await read(pointer);
  } catch (error) {
    throw new Error(`the broker names parameter could not be read (${errorName(error)})`);
  }
  if (fetched.type !== "String") throw new Error("the broker names parameter is not a plain String parameter");
  if (typeof fetched.value !== "string") throw new Error("the broker names parameter has no value");
  const decoded = decodeBrokerNamesParameter(fetched.value);
  if ("error" in decoded) throw new Error(`the broker names parameter ${decoded.error}`);
  if (decoded.revision !== revision) throw new Error(`the broker names parameter was written by another revision of the control plane than this function's ${BROKER_NAMES_REVISION_VARIABLE}; refusing to start`);
  env[BROKER_NAMES_VARIABLE] = decoded.list;
}
