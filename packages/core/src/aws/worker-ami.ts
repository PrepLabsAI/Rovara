import { GetParameterCommand, ParameterNotFound, type SSMClient } from "@aws-sdk/client-ssm";

/**
 * AUTOREQUALIFY AR-4: task workers boot from the AMI the browser and API test machine (the runner)
 * was qualified on, so a renewal causes no kernel drift between them. The requalifier writes the
 * AMI ID to this setting once a new runner is registered; the session provisioner launches workers
 * with it and the reconciler recycles workers still on another AMI. Until the first automatic
 * requalification the setting does not exist and workers launch from the public AL2023 parameter
 * as before.
 *
 * Not one of WORKER_SETTING_PARAMETERS: the worker never reads it, and the session steps Lambda
 * has no grant on it.
 */
export const WORKER_QUALIFIED_AMI_SETTING = "worker-qualified-ami";

/**
 * An EC2 AMI ID: `ami-` and 8 or 17 hex digits. The session provisioner state machine checks the
 * value with this same pattern (infra/lib/session-state-machines.ts embeds its source).
 */
export const WORKER_AMI_ID_PATTERN = /^ami-[0-9a-f]{8}([0-9a-f]{9})?$/;

/** The SSM parameter name for an environment, from its settings prefix (`/agentx/<env>/`). */
export function workerQualifiedAmiParameterName(settingsPrefix: string): string {
  return `${settingsPrefix}${WORKER_QUALIFIED_AMI_SETTING}`;
}

/**
 * The pinned AMI ID, or undefined when the parameter does not exist yet. A value that is not an AMI
 * ID throws WORKER_AMI_PARAMETER_MALFORMED (the value is not echoed), and any other SSM fault
 * propagates: neither is ever read as "no pin".
 */
export async function readQualifiedWorkerAmi(ssm: Pick<SSMClient, "send">, parameterName: string): Promise<string | undefined> {
  let value: string | undefined;
  try {
    value = (await ssm.send(new GetParameterCommand({ Name: parameterName }))).Parameter?.Value;
  } catch (error) {
    if (error instanceof ParameterNotFound) return undefined;
    throw error;
  }
  if (value === undefined || !WORKER_AMI_ID_PATTERN.test(value)) throw new Error("WORKER_AMI_PARAMETER_MALFORMED");
  return value;
}

/** Whether a worker's instance runs another AMI than the pinned one; unknown on either side is not stale. */
export function isStaleWorkerAmi(instanceImageId: string | undefined, qualifiedAmi: string | undefined): boolean {
  return instanceImageId !== undefined && qualifiedAmi !== undefined && instanceImageId !== qualifiedAmi;
}
