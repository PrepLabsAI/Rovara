import { CloudAccountRefusedError, type CloudAccount } from "@agentx/contracts";

/** No cloud account on a laptop unless the owner configures an adapter. Never consult ambient credentials. */
export function createUnavailableCloudAccount(): CloudAccount {
  const refuse = async (): Promise<never> => { throw new CloudAccountRefusedError(); };
  return { credentialsFor: refuse, testConnection: refuse, externalIdFor: refuse };
}
