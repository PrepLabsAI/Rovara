import jsonata from "jsonata";
import { provisionerDefinition } from "../../infra/lib/session-state-machines.js";
import type { SessionStep } from "../../packages/broker/src/aws/session-steps.js";
import type { ProvisioningInput } from "../../packages/broker/src/aws/sessions.js";

export const INSTANCE_LAUNCH_STATES = ["RunInstance", "RunInstancePinned", "RunInstanceSized", "RunInstancePinnedSized", "RunInstanceX86"] as const;
type InstanceLaunchState = typeof INSTANCE_LAUNCH_STATES[number];
export interface RunInstancesResult {
  Instances: Array<{ InstanceId: string; PrivateIpAddress: string; InstanceType: string }>;
}

type Fields = Record<string, unknown>;
const definition = provisionerDefinition({
  stepsFunctionArn: "arn:aws:lambda:us-west-2:111122223333:function:steps",
  workspaceKeyArn: "arn:aws:kms:us-west-2:111122223333:key/k",
  environmentTag: "test", resourcePrefix: "agentx-test", workerAmiParameterName: "/agentx/test/worker-qualified-ami",
}) as { States: Record<string, { Assign?: Fields; Arguments?: { Payload: Fields } }> };

// Step Functions evaluates all fields of one Assign against the same incoming scope.
async function evaluateFields(fields: Fields, bindings: Fields): Promise<Fields> {
  return Object.fromEntries<unknown>(await Promise.all(Object.entries(fields).map(async ([key, value]) => {
    const expression = typeof value === "string" ? /^\{% (.*) %\}$/s.exec(value)?.[1] : undefined;
    const evaluated: unknown = expression === undefined ? value : await jsonata(expression).evaluate({}, bindings);
    return [key, evaluated] as const;
  })));
}

/** Only the real identity-binding seam, not a full state-machine emulator or an EC2 call. */
export async function provisionerRecordInstancePayload(
  input: Pick<ProvisioningInput, "workspaceId" | "generation" | "machine">,
  launch: InstanceLaunchState,
  result: RunInstancesResult,
  sizeUnavailable = false,
): Promise<Extract<SessionStep, { action: "recordInstance" }>> {
  const states = definition.States;
  let variables = await evaluateFields(states.Start!.Assign!, { states: { input } });
  if (sizeUnavailable) variables = { ...variables, ...await evaluateFields(states.SizeUnavailable!.Assign!, variables) };
  variables = { ...variables, ...await evaluateFields(states[launch]!.Assign!, { ...variables, states: { input, result } }) };
  // Read the actual Lambda payload, including literal fields: constants must not bypass evaluation.
  return await evaluateFields(states.RecordInstance!.Arguments!.Payload, variables) as Extract<SessionStep, { action: "recordInstance" }>;
}
