// The broker's Lambda entry (ENV-ROOM 2, 2026-11-17). A named environment's broker names are in an SSM parameter, not the environment (broker-names-parameter.ts), and reading
// it takes a call, while broker.ts and the modules it imports read their environment as they load. So this module imports nothing of the broker statically: on the first
// invocation it reads the names into the environment, and only then loads broker.ts (whose first import, broker-environment-init.ts, unpacks them as it always has).
// Where the environment points at no parameter (the legacy install, an older template), nothing is read and broker.ts loads as it did.
//
// Fails closed: until the names are read and checked, no request is served; a failed read is tried again on the next invocation. A failure while broker.ts loads is not
// retried in the same process (a module that failed half way is not loaded again): every later invocation gets the same refusal, as when Lambda's own init fails.
import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import { loadBrokerNamesParameter, type ParameterReader } from "./broker-names-parameter.js";

export type BrokerLambdaHandler = (event: unknown, context: unknown) => Promise<unknown>;

export interface BrokerBootDependencies {
  readonly environment: Record<string, string | undefined>;
  readonly readParameter: ParameterReader;
  readonly loadBroker: () => Promise<{ handler?: unknown }>;
}

/** A Lambda handler that reads the names, then loads the broker, then hands every invocation to the broker's own handler. */
export function createBrokerLambdaHandler(dependencies: BrokerBootDependencies): BrokerLambdaHandler {
  let names: Promise<void> | undefined;
  let broker: Promise<BrokerLambdaHandler> | undefined;
  return async (event, context) => {
    names ??= loadBrokerNamesParameter(dependencies.environment, dependencies.readParameter).catch((error: unknown) => {
      names = undefined;
      throw error;
    });
    await names;
    broker ??= dependencies.loadBroker().then((loaded) => {
      if (typeof loaded.handler !== "function") throw new Error("the broker module has no handler");
      return loaded.handler as BrokerLambdaHandler;
    });
    return (await broker)(event, context);
  };
}

/**
 * The one parameter, read with GetParameters (the action the broker's role already has for its other settings, so the grant is one more ARN, not a statement), with the SDK's
 * retries for throttling, from a client made only when a parameter is read. A name it does not return is ParameterNotFound, as GetParameter would say.
 */
export async function readOneParameter(client: Pick<SSMClient, "send">, name: string): Promise<{ type: string | undefined; value: string | undefined }> {
  const { Parameters, InvalidParameters } = await client.send(new GetParametersCommand({ Names: [name] }));
  const found = (Parameters ?? []).filter((parameter) => parameter.Name === name);
  if ((InvalidParameters ?? []).length > 0 || found.length !== 1) throw Object.assign(new Error("parameter not found"), { name: "ParameterNotFound" });
  return { type: found[0]!.Type, value: found[0]!.Value };
}

const readParameter: ParameterReader = async (name) =>
  readOneParameter(new SSMClient({ ...(process.env.AWS_REGION === undefined ? {} : { region: process.env.AWS_REGION }), maxAttempts: 3 }), name);

export const handler: BrokerLambdaHandler = createBrokerLambdaHandler({
  environment: process.env,
  readParameter,
  loadBroker: () => import("./broker.js"),
});
